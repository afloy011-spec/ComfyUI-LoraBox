# Afloy Lora Box

A compact multi-LoRA loader for ComfyUI with a custom DOM (HTML) panel UI.

It exists to sidestep the ComfyUI 1.43 frontend bug that mis-lays-out rgthree's
hand-drawn canvas widgets (rows shift / disappear). The editor is rendered as an
HTML overlay independent of litegraph's widget layout, so it stays stable while
offering a one-row-per-LoRA design.

## Features

- One row per LoRA: on/off switch, searchable picker, strength slider + number.
- Calm by default: secondary settings (**mute all**, separate **model/clip**
  strengths, **trigger merge position** + delimiter) live behind a ⚙ disclosure.
- A live **active count** in the header; **mute all** survives a workflow save
  without wiping per-row on/off state.
- Drag-to-reorder by grabbing the coloured left bar of a card (it doubles as
  the active/disabled indicator); duplicate LoRAs get an explicit "duplicate" badge.
- **Reversible delete**: removing a row shows an *Undo* toast.
- Per-row trigger words: auto-detected from real safetensors trigger fields
  (not noisy training tags), fully editable, resettable to auto. Merged straight
  into the `prompt` output.
- **Per-LoRA preview pictures**: each row shows a thumbnail so LoRAs are easy to
  tell apart. The LoRA's own preview (`<lora>.preview.png`, as dropped by
  Civitai / model managers) loads **automatically**; otherwise an empty
  thumbnail offers **✨ Generate** (a quick test render — pick *Character* or
  *Style* so style LoRAs get a scene, not a portrait) or **＋ Add** (your own
  image, click or drag & drop). Hover an image for the enlarge + regenerate /
  replace / remove chips. A custom image is stored as a sidecar next to the
  `.safetensors`, so it *belongs to the LoRA* and shows in every Lora Box.

## Node

**Afloy Lora Box** (`LoraBox`, category `loaders`)

| Input | Type | Notes |
|-------|------|-------|
| `model` | MODEL | required |
| `clip`  | CLIP  | required |
| `prompt` | STRING | optional input; if connected, returns it with trigger words merged in |
| `data`  | STRING | hidden; JSON kept in sync by the panel |

Outputs: `MODEL`, `CLIP`, `prompt` (STRING — the prompt with trigger words
merged in).

The panel header has a **triggers** dropdown (`at end` / `at start of prompt`)
and a **sep** field (delimiter); both are stored in `data` and drive the merged
`prompt` output. So one node loads the LoRA *and* injects its trigger word into
the prompt automatically — no separate merge node needed. (If `prompt` is not
connected, `prompt` output is just the trigger words; mute passes the prompt
through untouched.)

Strengths are clamped to `-3..3` (negative "anti-LoRA" weights allowed);
non-finite values (NaN/Inf) are rejected.

### Prompt + Triggers (Lora Box) (`LoraBoxPromptMerge`, category `loaders`)

Merges a prompt with LoRA trigger words and exposes a single **position** switch
to place the triggers at the **beginning** or the **end** of the prompt. Replaces
the fragile `JoinStrings` + `JoinStrings` + `LazySwitchKJ` combo.

| Input | Type | Notes |
|-------|------|-------|
| `prompt` | STRING (input) | the base prompt |
| `triggers` | STRING (input) | trigger words (e.g. from Afloy Lora Box) |
| `position` | combo | `end (append after prompt)` / `beginning (prepend before prompt)` |
| `delimiter` | STRING | default `", "` |

Output: `prompt` (STRING). Empty sides are handled without stray delimiters, and
trigger words already present in the prompt are not duplicated.

## Install

Clone into `ComfyUI/custom_nodes/` and restart ComfyUI:

```
ComfyUI/custom_nodes/ComfyUI-LoraBox/
├── __init__.py
├── lora_box.py
├── pyproject.toml
└── web/
    └── lora_box.js
```

## Develop / test

```
python -m unittest discover -s tests -v
```

Tests stub `folder_paths` / `comfy.*`, so they run without a full ComfyUI install.

## Implementation notes

- LoRA weights and parsed safetensors metadata are cached and keyed by file
  mtime, so replacing a `.safetensors` on disk transparently re-reads it.
- `IS_CHANGED` hashes the row JSON plus the mtime of each referenced LoRA, so
  cached outputs / trigger words never go stale.
- The `/lorabox/triggers` and `/lorabox/preview` routes only touch files whose
  name is in the registered loras list (guards against path traversal /
  arbitrary file reads or writes). Preview uploads are capped at 8 MB and limited
  to `png/jpg/jpeg/webp/gif`; the sidecar is `<lora-basename>.<ext>` next to the
  model file.
