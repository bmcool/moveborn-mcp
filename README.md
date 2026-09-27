# moveborn-mcp

Turn **one character image** into game-ready 2D sprite animations — straight from your AI coding agent.

Walk, run, idle, attack, skill, hit, death (idle / walk / run also facing back and side). You get transparent
PNG frames with the feet on the same line in every action, a sprite sheet, and `meta.json` (fps, frame size,
ground line) ready for Unity, Godot or any engine. Chibi, anime, painted and photo-realistic characters all work.

Powered by [Moveborn](https://moveborn.com). Each action costs one round of credits on your Moveborn account
(new accounts get free trial credits).

## 1. Get an API key

Sign in at <https://moveborn.com/app/> → top right **API 金鑰** → create a key. It is shown once; copy it.

## 2. Add the server to your agent

**Claude Code**

```bash
claude mcp add moveborn --env MOVEBORN_API_KEY=mb_live_... -- npx -y github:bmcool/moveborn-mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.moveborn]
command = "npx"
args = ["-y", "github:bmcool/moveborn-mcp"]
env = { MOVEBORN_API_KEY = "mb_live_..." }
```

**Cursor / other MCP clients** (`mcp.json`)

```json
{
  "mcpServers": {
    "moveborn": {
      "command": "npx",
      "args": ["-y", "github:bmcool/moveborn-mcp"],
      "env": { "MOVEBORN_API_KEY": "mb_live_..." }
    }
  }
}
```

Requires Node.js 18+ and git. The first start takes a little longer while `npx` fetches the package.

## 3. Ask for it

> Make walk, idle and attack animations for `art/hero.png` and put them in `assets/sprites/hero`.

The agent will create the jobs, wait for them (about 3–5 minutes per action) and download the frames.

## Tools

| Tool | What it does |
|---|---|
| `get_account` | Credit balance, credits per action, whether downloads are unlocked |
| `create_animation` | Start animations from a local image (or a saved character) — one job per action |
| `wait_for_job` | Wait until a job finishes (call again if it times out) |
| `get_job` | Status and current stage of a job |
| `download_results` | Save frames, sprite sheet, `meta.json` and preview into a project folder |
| `list_characters` | Characters already in your library (reuse without re-uploading) |
| `list_jobs` | Recent jobs |

## Output layout

```
<dest_dir>/<action>/
  frames/frame_000.png …   every frame (24 fps), transparent, same cell size
  12fps/frames/…           lighter 12 fps set
  sheet.webp               all frames in one strip
  meta.json                fps, frame_w, frame_h, ground_y (feet line), frames
  preview.gif
```

Use `ground_y` as the sprite origin so every action stands on the same line. Side-facing sprites face right;
flip horizontally for left.

## Engine files (automatic)

`download_results` looks at where you download to:

- **Godot 4** (a `project.godot` above the folder): writes `<folder>/<folder>.tres` — a `SpriteFrames` with every
  action in the folder (loops and fps set) — and `moveborn_sprite.gd`, a tiny `AnimatedSprite2D` script that keeps
  the feet on the node origin when switching between actions of different cell sizes.
- **Unity** (`Assets/` + `ProjectSettings/` above the folder; the folder must be under `Assets/`): installs
  `Assets/Editor/MovebornImporter.cs`. On import it turns the frames into Sprites with the pivot on the feet and
  builds one `.anim` per action (idle/walk/run looping) plus a `<Folder>.controller`. The Unity importer is new —
  please open an issue if something is off.

Download every action of one character into the same folder so they share one SpriteFrames / controller.
Pass `engine_files: false` to skip this.

## Skill (optional)

`skills/moveborn/SKILL.md` teaches the agent when to use Moveborn, how to pick actions, to confirm the credit
cost with you before generating, and how to wire the result into Godot / Unity. Copy the folder to:

- Claude Code: `~/.claude/skills/moveborn/` (or `.claude/skills/moveborn/` in a project)
- Codex: `~/.codex/skills/moveborn/`

Trial accounts can only download the watermarked preview; top up any pack to unlock clean frames.

## Environment

| Variable | Default |
|---|---|
| `MOVEBORN_API_KEY` | (required) |
| `MOVEBORN_API` | `https://moveborn.com/api` |
