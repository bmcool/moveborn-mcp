---
name: moveborn
description: Turn a character image into game-ready 2D sprite animations (idle, walk, run, attack, skill, hit, death; idle/walk/run also back and side) with the Moveborn MCP server, then wire them into Godot, Unity or any engine. Use when the user wants a character, player, enemy or NPC to move, asks for sprite sheets, sprite animations, walk cycles, attack animations, frame-by-frame PNGs, or wants to animate concept art / a character portrait for a 2D game.
---

# Moveborn: character image → sprite animations

Moveborn makes animations from ONE still image of a character. It does not draw new characters: if the user has
no image yet, make or get one first (full body, front view, plain background works best), then come back here.

Tools come from the `moveborn` MCP server (`get_account`, `create_animation`, `wait_for_job`, `get_job`,
`download_results`, `list_characters`, `list_jobs`). If they are missing, tell the user to set it up:
<https://github.com/bmcool/moveborn-mcp>.

## 1. Pick the actions

| Action | Use for | Plays |
|---|---|---|
| `idle` | standing still, breathing | loop |
| `walk` | moving | loop |
| `run` | fast moving | loop |
| `attack` | normal attack with the character's weapon (or fists) | once, returns to stance |
| `skill` | special move / spell, with effects | once, returns to stance |
| `hit` | taking damage | once |
| `death` | falling down | once, ends lying |

- `direction: "front"` (default) keeps the facing of the uploaded image — whatever way the art faces.
  `back` and `side` (side = facing right) re-draw idle/walk/run turned around; flip `side` for left.
- Platformer / side view: usually `idle`, `run` (or `walk`), `attack`, `hit`, `death` from art that already
  faces sideways, all `front`.
- Top-down RPG: `idle`/`walk` in `front`, `back` and `side`.
- Start small (one or two actions) when the user is exploring; they can add more later from the same character
  (`list_characters` → `character_id`, no re-upload).

## 2. Check the cost and ASK before spending

Every action is one job and costs one round of credits (usually 99). Call `get_account` first and tell the user
what you are about to make and what it costs, e.g. "walk + idle + attack = 3 rounds = 297 credits, you have 300".
Only call `create_animation` after they agree. Never retry a finished action on your own to "get a better one";
that spends their money — offer it instead.

If the balance is too low, say so and link <https://moveborn.com/app/> to top up.

## 3. Create and wait

```
create_animation({ image_path: "art/hero.png", actions: ["idle", "walk", "attack"] })
```

- `note` (optional): anything the image does not show — weapon, fighting style, "keeps the hood up".
- Each action takes about 3–5 minutes. Call `wait_for_job` for each job ID; if it times out, call it again.
  Meanwhile you can keep working on code (the engine side does not need the frames to exist yet).
- A failed job refunds its credits automatically; report the error and offer to try again.

## 4. Download into the project

Put all actions of one character in ONE folder so they share a SpriteFrames / Animator Controller:

```
download_results({ job_id, dest_dir: "assets/sprites/hero" })     // Godot: res://assets/sprites/hero
download_results({ job_id, dest_dir: "Assets/Sprites/Hero" })     // Unity: must be under Assets/
```

Result per action: `<action>/frames/frame_000.png…` (24 fps, transparent, same cell size), `<action>/12fps/…`
(lighter set, `only_12fps: true` to skip the full one), `sheet.webp`, `meta.json`, `preview.gif`.

Trial accounts only get a watermarked preview; the tool says so. Tell the user they can top up (or have the
account unlocked) and download again later with the same job ID — no need to regenerate.

## 5. Wire it into the engine

`download_results` detects the engine from the folder and reports what it wrote in `engine`.

**Godot 4** — writes `<folder>/<folder>.tres` (SpriteFrames with every action in the folder) and
`<folder>/moveborn_sprite.gd`. Use:

```gdscript
# AnimatedSprite2D with sprite_frames = preload("res://assets/sprites/hero/hero.tres")
# and script moveborn_sprite.gd (keeps the feet on the node origin when switching animations)
$Sprite.play("walk")
$Sprite.flip_h = velocity.x < 0          # side / front art: flip for the other direction
await $Sprite.animation_finished          # attack / hit / death play once
```

**Unity** — installs `Assets/Editor/MovebornImporter.cs`. When Unity imports the folder it makes every frame a
Sprite with the pivot on the feet and builds `<action>.anim` plus `<Folder>.controller`. Put a `SpriteRenderer`
and an `Animator` (controller = that `.controller`) on the character; states are named after the actions
(`idle`, `walk`, …; directional ones are `walk_back`, `walk_side`). Loops are already set for idle/walk/run.

**Other engines** — read `meta.json`: `fps`, `frame_w`, `frame_h`, `ground_y` (feet line, px from the top of
each frame). Put the sprite origin at `(frame_w / 2, ground_y)` so every action stands on the same line, even
though cell sizes differ between actions. `sheet.webp` is a grid (`cols`, `rows` in meta.json) if the engine
prefers one texture.

## Tips

- Different actions of the same character are drawn at the same character scale (same body height), but the
  cells differ in size because attacks need room. Always anchor on `ground_y`, not the cell's bottom edge.
- Side-facing actions face right. Flip horizontally for left instead of making a second set.
- Scale in the engine, not by re-downloading: frames are large (character roughly 450–960 px tall) so they
  stay sharp when scaled down.
- If a few frames look wrong, the user can fix them in the web studio at <https://moveborn.com/app/>
  (per-frame nudge, AI redraw of bad frames, AI in-between). That editor exports its own corrected zip;
  `download_results` still returns the original frames.
