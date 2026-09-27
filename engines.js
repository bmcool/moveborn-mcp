/* 下載成品之後，依專案是哪種引擎，產生可以直接用的檔案（download_results 呼叫）。
 *
 * Godot 4（往上找得到 project.godot）：
 *   <dest>/<資料夾名>.tres       SpriteFrames：資料夾裡每個動作一個 animation（循環的設 loop、fps 照 meta.json）
 *   <dest>/moveborn_sprite.gd    掛在 AnimatedSprite2D 上：每個動作的格子大小不同，換動作時自動調 offset，腳一直踩在節點原點
 * Unity（往上找得到 Assets/ 與 ProjectSettings/）：
 *   Assets/Editor/MovebornImporter.cs  匯入時自動：影格設成 Sprite、pivot 在腳底（ground_y）；每個動作做 .anim，
 *                                      資料夾做一個 Animator Controller。不用點選單，AI 助手下載完打開 Unity 就能用。
 * 每個動作一個資料夾（<dest>/<動作>/meta.json＋frames/…；只下載 12 fps 版就是 12fps/）。
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

const LOOPING = new Set(["idle", "walk", "run"]);

function findUp(start, test) {
  let d = start;
  for (let i = 0; i < 40; i++) {
    if (test(d)) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

export function detectEngine(dir) {
  const godot = findUp(dir, (d) => existsSync(join(d, "project.godot")));
  if (godot) return { engine: "godot", root: godot };
  const unity = findUp(dir, (d) => existsSync(join(d, "Assets")) && existsSync(join(d, "ProjectSettings")));
  if (unity) return { engine: "unity", root: unity };
  return { engine: null, root: null };
}

/** dest 底下每個動作：用哪一組影格（24 fps 優先，沒有就 12 fps）、meta。 */
async function actionsIn(dest) {
  const out = [];
  for (const name of (await readdir(dest, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    for (const sub of ["", "12fps"]) {
      const d = join(dest, name, sub);
      const metaPath = join(d, "meta.json");
      if (!existsSync(metaPath) || !existsSync(join(d, "frames"))) continue;
      let meta;
      try { meta = JSON.parse(await readFile(metaPath, "utf-8")); } catch { continue; }   // 讀不懂就跳過這個動作
      if (!(meta.frame_h > 0) || !Number.isFinite(meta.ground_y)) continue;
      const frames = (await readdir(join(d, "frames"))).filter((f) => /^frame_\d+\.png$/.test(f)).sort();
      if (!frames.length) continue;
      out.push({ name, dir: d, meta, frames: frames.map((f) => join(d, "frames", f)), loop: LOOPING.has(name.split("_")[0]) });
      break;
    }
  }
  return out;
}

const resPath = (root, p) => "res://" + relative(root, p).split(sep).join("/");

async function godot(root, dest) {
  const acts = await actionsIn(dest);
  if (!acts.length) return null;
  const ext = [];
  const anims = acts.map((a) => {
    const frames = a.frames.map((f) => {
      ext.push(`[ext_resource type="Texture2D" path="${resPath(root, f)}" id="${ext.length + 1}"]`);
      return `{\n"duration": 1.0,\n"texture": ExtResource("${ext.length}")\n}`;
    });
    return `{\n"frames": [${frames.join(", ")}],\n"loop": ${a.loop},\n"name": &"${a.name}",\n"speed": ${Number(a.meta.fps || 12).toFixed(1)}\n}`;
  });
  const tres = `[gd_resource type="SpriteFrames" load_steps=${ext.length + 1} format=3]\n\n${ext.join("\n")}\n\n[resource]\nanimations = [${anims.join(", ")}]\n`;
  const tresPath = join(dest, `${basename(dest)}.tres`);
  await writeFile(tresPath, tres);
  // 置中顯示時，腳在格子中心往下 (ground_y - frame_h/2)：往上推這麼多，腳就在節點原點
  const offsets = acts.map((a) => `\t"${a.name}": Vector2(0, ${Math.round(a.meta.frame_h / 2 - a.meta.ground_y)}),`).join("\n");
  const gd = `# Moveborn：每個動作的格子大小不同，換動作時調 offset，讓腳一直踩在這個節點的原點上。
# 用法：AnimatedSprite2D 的 Sprite Frames 選 ${basename(tresPath)}，再把這個腳本掛上去。
extends AnimatedSprite2D

const FEET_OFFSETS := {
${offsets}
}

func _ready() -> void:
\tcentered = true
\tanimation_changed.connect(_fit_feet)
\t_fit_feet()

func _fit_feet() -> void:
\toffset = FEET_OFFSETS.get(String(animation), Vector2.ZERO)
`;
  await writeFile(join(dest, "moveborn_sprite.gd"), gd);
  return { engine: "godot", sprite_frames: tresPath, script: join(dest, "moveborn_sprite.gd"), animations: acts.map((a) => a.name),
           how: `Add an AnimatedSprite2D, set Sprite Frames to ${resPath(root, tresPath)}, attach ${resPath(root, join(dest, "moveborn_sprite.gd"))} so the feet stay on the node origin when switching animations, then call play("walk") etc.` };
}

async function unity(root, dest) {
  const acts = await actionsIn(dest);
  if (!acts.length) return null;
  const script = join(root, "Assets", "Editor", "MovebornImporter.cs");
  const inAssets = !relative(join(root, "Assets"), dest).startsWith("..");
  let wrote = false;
  const cur = existsSync(script) ? await readFile(script, "utf-8") : "";
  if (!cur.includes(`MOVEBORN_IMPORTER_VERSION ${UNITY_VERSION}`)) {
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, UNITY_IMPORTER);
    wrote = true;
  }
  return { engine: "unity", importer: script, importer_written: wrote, animations: acts.map((a) => a.name),
           how: inAssets
             ? "Switch to (or open) Unity: the importer sets the frames to Sprites with the pivot on the feet and builds one .anim per action plus a .controller for the folder. Put the controller on a GameObject with a SpriteRenderer and Animator."
             : "The folder is outside Assets/, so Unity will not import it. Download into a folder under Assets/." };
}

export async function writeEngineFiles(dest) {
  const { engine, root } = detectEngine(dest);
  if (engine === "godot") return godot(root, dest);
  if (engine === "unity") return unity(root, dest);
  return null;
}

const UNITY_VERSION = 1;
const UNITY_IMPORTER = `// MOVEBORN_IMPORTER_VERSION ${UNITY_VERSION}
// Moveborn 成品自動匯入（moveborn-mcp 放的）：資料夾裡有 Moveborn 的 meta.json 時，
//   · frames/frame_XXX.png → Sprite（單張）、pivot 在腳底（meta.json 的 ground_y）、不產 mipmap
//   · 每個動作 → <動作>.anim（idle / walk / run 循環，其他播一次）
//   · 整個資料夾 → <資料夾>.controller（每個動作一個 state）
// 重新下載會重建。刪掉這個檔就不會再自動處理。
#if UNITY_EDITOR
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public class MovebornImporter : AssetPostprocessor
{
    [System.Serializable]
    class Meta { public string action; public int fps = 12; public int frame_w; public int frame_h; public int ground_y; public string[] frame_files; }

    static Meta MetaFor(string framePath)
    {
        // <動作>/frames/frame_000.png 或 <動作>/12fps/frames/frame_000.png → 同一層的 meta.json
        var dir = Path.GetDirectoryName(Path.GetDirectoryName(framePath));
        var p = Path.Combine(dir, "meta.json");
        if (!File.Exists(p)) return null;
        var text = File.ReadAllText(p);
        if (!text.Contains("frame_files")) return null;
        return JsonUtility.FromJson<Meta>(text);
    }

    void OnPreprocessTexture()
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(assetPath.Replace('\\\\', '/'), @"/frames/frame_\\d+\\.png$")) return;
        var meta = MetaFor(assetPath);
        if (meta == null || meta.frame_h <= 0) return;
        var ti = (TextureImporter)assetImporter;
        ti.textureType = TextureImporterType.Sprite;
        ti.spriteImportMode = SpriteImportMode.Single;
        ti.mipmapEnabled = false;
        ti.alphaIsTransparency = true;
        var s = new TextureImporterSettings();
        ti.ReadTextureSettings(s);
        s.spriteAlignment = (int)SpriteAlignment.Custom;
        s.spritePivot = new Vector2(0.5f, 1f - (float)meta.ground_y / meta.frame_h);
        s.spriteMeshType = SpriteMeshType.FullRect;
        ti.SetTextureSettings(s);
    }

    static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
    {
        var metas = imported.Where(p => p.Replace('\\\\', '/').EndsWith("/meta.json")).ToArray();
        if (metas.Length == 0) return;
        EditorApplication.delayCall += () => { foreach (var m in metas) Build(m); };
    }

    static void Build(string metaAsset)
    {
        if (!File.Exists(metaAsset)) return;
        var text = File.ReadAllText(metaAsset);
        if (!text.Contains("frame_files")) return;
        var meta = JsonUtility.FromJson<Meta>(text);
        var dir = Path.GetDirectoryName(metaAsset).Replace('\\\\', '/');
        var actionDir = dir.EndsWith("/12fps") ? Path.GetDirectoryName(dir).Replace('\\\\', '/') : dir;
        // 24 fps 跟 12 fps 都在的話用 24 fps 那組
        if (dir.EndsWith("/12fps") && File.Exists(actionDir + "/meta.json") && Directory.Exists(actionDir + "/frames")) return;
        var name = Path.GetFileName(actionDir);
        var sprites = Directory.GetFiles(dir + "/frames", "frame_*.png").OrderBy(f => f)
            .Select(f => AssetDatabase.LoadAssetAtPath<Sprite>(f.Replace('\\\\', '/'))).Where(s => s != null).ToArray();
        if (sprites.Length == 0) return;
        var clip = new AnimationClip { frameRate = meta.fps > 0 ? meta.fps : 12 };
        var binding = EditorCurveBinding.PPtrCurve("", typeof(SpriteRenderer), "m_Sprite");
        var keys = sprites.Select((s, i) => new ObjectReferenceKeyframe { time = i / clip.frameRate, value = s }).ToList();
        keys.Add(new ObjectReferenceKeyframe { time = sprites.Length / clip.frameRate, value = sprites[sprites.Length - 1] });
        AnimationUtility.SetObjectReferenceCurve(clip, binding, keys.ToArray());
        var st = AnimationUtility.GetAnimationClipSettings(clip);
        var baseName = name.Split('_')[0];
        st.loopTime = baseName == "idle" || baseName == "walk" || baseName == "run";
        AnimationUtility.SetAnimationClipSettings(clip, st);
        var clipPath = actionDir + "/" + name + ".anim";
        AssetDatabase.DeleteAsset(clipPath);
        AssetDatabase.CreateAsset(clip, clipPath);

        // 資料夾的 Animator Controller：資料夾裡所有動作的 .anim 各一個 state
        var folder = Path.GetDirectoryName(actionDir).Replace('\\\\', '/');
        var ctrlPath = folder + "/" + Path.GetFileName(folder) + ".controller";
        var ctrl = AssetDatabase.LoadAssetAtPath<AnimatorController>(ctrlPath) ?? AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        var sm = ctrl.layers[0].stateMachine;
        var state = sm.states.Select(x => x.state).FirstOrDefault(x => x.name == name) ?? sm.AddState(name);
        state.motion = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipPath);
        if (sm.defaultState == null || name.StartsWith("idle")) sm.defaultState = state;
        EditorUtility.SetDirty(ctrl);
        AssetDatabase.SaveAssets();
    }
}
#endif
`;
