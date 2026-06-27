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

The strength slider covers the common `0..2` range, but the value box accepts
any number you type: strengths are clamped to `-10..10` (negative "anti-LoRA"
weights allowed); non-finite values (NaN/Inf) are rejected.

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

## Configuration

Everything works out of the box; these are optional knobs for the two features
that reach outside the node.

### Preview generation (`✨ Generate`)

The built-in **Generate** renders a quick **Z-Image Turbo** test image and saves
it as the LoRA's sidecar. It needs three models installed: a UNet/diffusion
model, a CLIP/text-encoder and a VAE (defaults: `z_image_turbo_bf16.safetensors`,
`qwen_3_4b.safetensors`, `ae.safetensors`).

If those aren't present, Generate reports exactly what's missing instead of
failing cryptically — and **Upload / drag-and-drop** (and the automatic
`<lora>.preview.png` sidecar) work regardless, so every LoRA can still get a
picture. To point Generate at your own models either:

- drop a `preview_config.json` next to the node (any of the keys in
  `PREVIEW_CONFIG` — e.g. `{ "unet_name": "...", "clip_name": "...", "vae_name": "..." }`), or
- set the env vars `LORABOX_PREVIEW_UNET`, `LORABOX_PREVIEW_CLIP`, `LORABOX_PREVIEW_VAE`.

Model names are matched leniently (exact first, then a substring of the stem),
so a differently-suffixed build is still found.

### Civitai lookups (opt-in)

When a LoRA has no local trigger words / preview, the node can resolve them from
Civitai by file hash. This is **off by default** (it hashes the whole file and
sends that hash to a third party). Enable it with the env var
`LORABOX_CIVITAI=1` (also accepts `true` / `yes` / `on`).

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
