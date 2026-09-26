#!/usr/bin/env node
/* Moveborn MCP server：讓 AI 開發助手（Claude Code、Codex、Cursor…）直接呼叫 Moveborn。
 * 一張角色圖 → 遊戲用的 sprite 動畫（逐格 PNG、sprite sheet、meta.json）。
 *
 *   MOVEBORN_API_KEY=mb_live_…  （工作室右上角「API 金鑰」建立）
 *   MOVEBORN_API=https://moveborn.com/api （預設）
 *
 * 走 stdio。只打 Moveborn 的公開 API（api/src/index.js），扣的是金鑰那個帳號的 credit。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

const API = (process.env.MOVEBORN_API || "https://moveborn.com/api").replace(/\/$/, "");
const KEY = process.env.MOVEBORN_API_KEY || "";
const SITE = API.replace(/\/api$/, "");
const UA = "moveborn-mcp/0.1";

const BASE = ["idle", "walk", "run", "attack", "skill", "hit", "death"];
const DIRECTIONAL = ["idle", "walk", "run"];          // 只有這三個有背面、側面（與 api/src/index.js 一致）
const LOOPING = new Set(["idle", "walk", "run"]);
const ACTIVE = new Set(["queued", "starting", "running"]);
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".bmp": "image/bmp" };

class ApiError extends Error {
  constructor(status, body) { super(body && body.error || `HTTP ${status}`); this.status = status; this.body = body; }
}

async function call(method, path, { body, form, raw = false } = {}) {
  if (!KEY) throw new ApiError(0, { error: "MOVEBORN_API_KEY is not set. Create a key at https://moveborn.com/app/ (top right: API 金鑰) and put it in the MCP server env." });
  const headers = { authorization: `Bearer ${KEY}`, "user-agent": UA };
  const init = { method, headers };
  if (form) init.body = form;
  else if (body !== undefined) { init.body = JSON.stringify(body); headers["content-type"] = "application/json"; }
  const res = await fetch(API + path, init);
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    return res;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e instanceof ApiError ? `Moveborn: ${e.message}` : String(e && e.message || e) }] });
const wrap = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail(e); } };
const actionName = (action, direction) => (direction && direction !== "front" ? `${action}_${direction}` : action);

async function jobSummary(id) {
  const [j, ev] = await Promise.all([call("GET", `/jobs/${id}`), call("GET", `/jobs/${id}/events`).catch(() => ({ events: [] }))]);
  const stages = ev.events.map((e) => e.stage).filter(Boolean);
  const outputs = {};
  for (const f of j.files || []) {
    const m = f.path.match(/^out\/([a-z_]+)\/(sheet\.webp|meta\.json|preview\.gif)$/);
    if (m) (outputs[m[1]] ||= []).push(m[2]);
  }
  return {
    job_id: j.id, status: j.status, actions: j.actions, stage: stages[stages.length - 1] || null,
    queue_ahead: j.queue_ahead || 0, credits_used: j.credits_used, error: j.error || null,
    downloadable: !j.locked,
    outputs,
    web: `${SITE}/app/#job=${j.id}`,
    note: ACTIVE.has(j.status) ? "Still working. One action usually takes 3-5 minutes; call wait_for_job to wait."
      : j.status === "done" ? (j.locked ? "Done, but this is a trial account: only watermarked previews. Top up credits (or get the account unlocked) to download clean frames."
        : "Done. Call download_results to save the frames into the project.") : null,
  };
}

const server = new McpServer({ name: "moveborn", version: "0.1.0" });

server.registerTool("get_account", {
  title: "Moveborn account",
  description: "Show the Moveborn account behind the API key: credit balance, credits per action (one action = one round), whether downloads are unlocked, and the public user ID.",
  inputSchema: {},
}, wrap(async () => {
  const me = await call("GET", "/me");
  return ok({ balance: me.balance, credits_per_action: me.round_credits, downloads_unlocked: me.paid, user_id: me.code,
              top_up: `${SITE}/app/`, actions_affordable: Math.floor(me.balance / (me.round_credits || 99)) });
}));

server.registerTool("list_characters", {
  title: "List saved characters",
  description: "List character images already saved in the user's Moveborn library (reuse them with create_animation's character_id instead of uploading again), with the animations made from each.",
  inputSchema: {},
}, wrap(async () => {
  const lib = await call("GET", "/library");
  return ok(lib.assets.map((a) => ({ character_id: a.id, name: a.name,
    animations: a.jobs.map((j) => ({ job_id: j.id, status: j.status, actions: j.actions })) })));
}));

server.registerTool("create_animation", {
  title: "Create sprite animations",
  description: [
    "Turn ONE character image into game-ready 2D sprite animations. Each action is a separate job and costs one round of credits (check get_account first).",
    "Actions: idle, walk, run (looping); attack, skill (play once and return to stance); hit, death (play once).",
    "idle/walk/run can also be made facing back or side (side = facing right; flip in engine for left).",
    "Best input: one full-body character, front view, plain background. Output: transparent PNG frames with feet aligned, a sprite sheet and meta.json (fps, frame size, ground line).",
    "Takes about 3-5 minutes per action. Returns job IDs; then use wait_for_job and download_results.",
  ].join(" "),
  inputSchema: {
    image_path: z.string().optional().describe("Local path to the character image (png/jpg/webp, up to 20 MB). Either this or character_id."),
    character_id: z.string().optional().describe("A character already in the library (from list_characters)."),
    actions: z.array(z.enum(BASE)).min(1).max(7).describe("Which actions to make, e.g. [\"idle\",\"walk\",\"attack\"]."),
    direction: z.enum(["front", "back", "side"]).default("front").describe("Facing. back/side only apply to idle, walk, run."),
    note: z.string().max(1000).optional().describe("Optional description of the character or motion (e.g. weapon, style), in any language."),
  },
}, wrap(async ({ image_path, character_id, actions, direction, note }) => {
  if (!image_path && !character_id) throw new Error("Give image_path or character_id.");
  if (direction !== "front") {
    const bad = actions.filter((a) => !DIRECTIONAL.includes(a));
    if (bad.length) throw new Error(`${bad.join(", ")} can only be made facing front. back/side work for: ${DIRECTIONAL.join(", ")}.`);
  }
  let buf = null, fname = null, type = null;
  if (image_path) {
    const p = resolve(image_path);
    type = MIME[extname(p).toLowerCase()];
    if (!type) throw new Error("Image must be .png, .jpg, .webp or .bmp");
    buf = await readFile(p);
    fname = basename(p);
  }
  const created = [];
  let asset = character_id || null;
  for (const a of actions) {
    const form = new FormData();
    const name = actionName(a, direction);
    form.append("actions", name);
    if (note) form.append("note", note);
    if (asset) form.append("asset", asset);
    else form.append("image", new Blob([buf], { type }), fname);
    try {
      const r = await call("POST", "/jobs", { form });
      created.push({ action: name, job_id: r.id, max_credits: r.max_credits });
      // 第一張上傳後原圖已收進素材庫：後面幾張直接用，不重傳
      if (!asset) asset = (await call("GET", `/jobs/${r.id}`)).asset || null;
    } catch (e) {
      created.push({ action: name, error: e.message });
      if (e instanceof ApiError && e.status === 402) break;     // credit 不夠，後面的也不會過
    }
  }
  return ok({ jobs: created, character_id: asset,
              next: "Each action takes about 3-5 minutes (they run in parallel when the queue is free). Call wait_for_job with each job_id, then download_results." });
}));

server.registerTool("get_job", {
  title: "Job status",
  description: "Check a Moveborn job: status (queued/starting/running/done/error), current stage, and which outputs are ready.",
  inputSchema: { job_id: z.string().regex(/^[0-9a-f]{32}$/) },
}, wrap(async ({ job_id }) => ok(await jobSummary(job_id))));

server.registerTool("wait_for_job", {
  title: "Wait for a job",
  description: "Wait until a Moveborn job finishes (or the timeout passes) and return its status. If it is still running when the timeout passes, just call this again.",
  inputSchema: {
    job_id: z.string().regex(/^[0-9a-f]{32}$/),
    timeout_seconds: z.number().int().min(10).max(600).default(300),
  },
}, wrap(async ({ job_id, timeout_seconds }) => {
  const end = Date.now() + timeout_seconds * 1000;
  for (;;) {
    const s = await jobSummary(job_id);
    if (!ACTIVE.has(s.status) || Date.now() > end) return ok(s);
    await new Promise((r) => setTimeout(r, 10000));
  }
}));

server.registerTool("download_results", {
  title: "Download sprite frames",
  description: [
    "Save a finished job's outputs into a folder in the project: <dest_dir>/<action>/frames/frame_000.png…, sheet.webp (all frames in one strip), meta.json (fps, frame size, ground line), preview.gif,",
    "plus a lighter 12 fps set under <action>/12fps/. Use only_12fps to skip the full-rate frames.",
    "Trial accounts can only get the watermarked preview.",
  ].join(" "),
  inputSchema: {
    job_id: z.string().regex(/^[0-9a-f]{32}$/),
    dest_dir: z.string().describe("Folder to write into, e.g. assets/sprites/hero"),
    only_12fps: z.boolean().default(false),
  },
}, wrap(async ({ job_id, dest_dir, only_12fps }) => {
  const j = await call("GET", `/jobs/${job_id}`);
  if (ACTIVE.has(j.status)) throw new Error(`Job is still ${j.status}; call wait_for_job first.`);
  const root = resolve(dest_dir);
  const want = (j.files || []).filter((f) => {
    const m = f.path.match(/^out\/([a-z_]+)\/(.+)$/);
    if (!m || /(^|\/)(preview_wm|thumb|thumb_wm)\./.test(m[2])) return false;
    if (only_12fps && m[2].startsWith("frames/")) return false;
    return true;
  });
  if (j.locked) {
    const previews = want.filter((f) => /\/preview\.(gif|webp)$/.test(f.path));
    for (const f of previews) {
      const res = await call("GET", `/files/${job_id}/${f.path}`, { raw: true });
      const out = join(root, f.path.replace(/^out\//, "").replace(/preview\./, "preview_watermarked."));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
    }
    return ok({ saved: previews.length, dir: root,
                note: "Trial account: only watermarked previews can be downloaded. Top up credits (or get the account unlocked) at " + SITE + "/app/ to download clean frames and sprite sheets." });
  }
  let n = 0;
  const actions = new Set();
  for (const f of want) {
    const res = await call("GET", `/files/${job_id}/${f.path}`, { raw: true });
    const rel = f.path.replace(/^out\//, "");
    const out = join(root, rel);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
    actions.add(rel.split("/")[0]);
    n++;
  }
  const hint = [...actions].map((a) => {
    const base = a.split("_")[0];
    return { action: a, folder: join(root, a), loop: LOOPING.has(base),
             sheet: join(root, a, "sheet.webp"), meta: join(root, a, "meta.json") };
  });
  return ok({ saved: n, dir: root, actions: hint,
              engine_tip: "meta.json has fps, frame_w/frame_h and ground_y (feet line in px from the top of each frame). Use ground_y as the sprite origin so every action stands on the same line. Side-facing sprites face right; flip horizontally for left." });
}));

server.registerTool("list_jobs", {
  title: "Recent jobs",
  description: "List the most recent Moveborn jobs with status and actions.",
  inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
}, wrap(async ({ limit }) => {
  const r = await call("GET", `/jobs?limit=${limit}`);
  return ok(r.jobs.map((j) => ({ job_id: j.id, status: j.status, actions: j.actions, created_at: new Date(j.created_at).toISOString() })));
}));

await server.connect(new StdioServerTransport());
