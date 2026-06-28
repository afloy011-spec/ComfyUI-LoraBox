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
- Drag-to-reorder by grabbing a card's **thumbnail**; duplicate LoRAs get an
  explicit "duplicate" badge.
- **Reversible delete**: removing a row shows an *Undo* toast.
- Per-row trigger words: auto-detected from real safetensors trigger fields
  (not noisy training tags), fully editable, resettable to auto. Merged straight
  into the `prompt` output.
- **Per-LoRA preview pictures**: each row shows a thumbnail so LoRAs are easy to
  tell apart. The LoRA's own preview (`<lora>.preview.png`, as dropped by
  Civitai / model managers) loads **automatically**. **Click the thumbnail** for
  a menu: *Generate — Character* / *Generate — Style* (a quick test render; the
  *Style* option gives style LoRAs a scene instead of a portrait), *Upload an
  image…*, and *Remove picture*. Generate **matches the LoRA's architecture**
  (Z-Image / Flux / SDXL / SD1.5). You can also **drag & drop** an image straight
  onto the thumbnail, and **hover** a picture to enlarge it. A custom image is
  stored as a sidecar next to the `.safetensors`, so it *belongs to the LoRA* and
  shows in every Lora Box.
- **Architecture-grouped picker**: loras are grouped (Z-Image, Flux, Krea, SDXL,
  SD1.5, …); **right-click** one to assign a custom group — it sticks across
  every Lora Box.

## Node

**Afloy Lora Box** (`LoraBox`, category `loaders`)

| Input | Type | Notes |
|-------|------|-------|
| `model` | MODEL | required |
| `clip`  | CLIP  | required |
| `prompt` | STRING | optional input; if connected, returns it with trigger words merged in |
| `data`  | STRING | hidden; JSON kept in sync by the panel |

You can also type the positive prompt **directly in the node** (a Prompt box in
the panel); it's stored in `data`, so it serializes reliably and needs no
external prompt node. A connected `prompt` input takes precedence when it carries
text; otherwise the in-node Prompt box is used.

Outputs: `MODEL`, `CLIP`, `prompt` (STRING — the prompt with trigger words
merged in).

The ⚙ options disclosure has a **Trigger position** dropdown (`Start` / `End`)
and a **Sep** field (delimiter); both are stored in `data` and drive the merged
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
├── preview_generate.py
├── pyproject.toml
├── LICENSE
├── README.md
└── web/
    └── lora_box.js
```

Or install from the **ComfyUI Registry** / **ComfyUI-Manager** (search "Afloy
Lora Box").

## Configuration

Everything works out of the box; these are optional knobs for the two features
that reach outside the node.

### Preview generation (`✨ Generate`)

The built-in **Generate** renders a quick test image and saves it as the LoRA's
sidecar. It picks a render **engine from the LoRA's detected architecture** —
**Z-Image**, **Flux** (also used for Krea), **SDXL** or **SD1.5** — so each LoRA
renders with the right graph, with a shared seed so thumbnails stay comparable.

Each engine needs its own models installed (Z-Image: UNet + CLIP + VAE; Flux:
UNet + dual CLIP + VAE; SDXL/SD1.5: a checkpoint). If they aren't present,
Generate reports exactly what's missing for that engine instead of failing
cryptically — and **Upload / drag-and-drop** (and the automatic
`<lora>.preview.png` sidecar) work regardless, so every LoRA can still get a
picture.

To point an engine at your own models either:

- drop a `preview_config.json` next to the node — the Z-Image engine reads flat
  keys (`{ "unet_name": "...", "clip_name": "...", "vae_name": "..." }`), other
  engines read a section (`{ "flux": { "unet_name": "...", "clip2_name": "..." },
  "sdxl": { "checkpoint_name": "..." } }`), or
- set env vars: `LORABOX_PREVIEW_UNET/_CLIP/_VAE` (Z-Image) or
  `LORABOX_PREVIEW_<ENGINE>_<KEY>` (e.g. `LORABOX_PREVIEW_FLUX_UNET_NAME`).

Model names are matched leniently (exact first, then a substring of the stem),
so a differently-suffixed build is still found. Force a specific engine with
`LORABOX_PREVIEW_ENGINE=flux|sdxl|sd15|zimage`; pick the fallback for
unrecognised LoRAs with `LORABOX_PREVIEW_DEFAULT_ENGINE`.

### Picker groups / custom categories

The LoRA picker groups loras by architecture (Z-Image, Flux, Krea, SDXL, SD1.5,
LTX Video, Other), detected from the filename or safetensors metadata.
**Right-click** any lora in the picker to move it to a different group, create a
new one, or revert to auto. The choice is stored by lora name in
`user_categories.json` next to the node, so it persists and is shared by every
Lora Box.

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
