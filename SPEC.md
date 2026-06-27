# Afloy Lora Box — Functional Specification

> Product spec for the **Afloy Lora Box** ComfyUI custom node.  
> Describes intended behaviour, UX principles, and integration with workflows.

---

## 1. Purpose

**Afloy Lora Box** replaces a fragile multi-node setup (LoRA loader + trigger words + merge + switch) with **one node** that:

- loads multiple LoRAs onto `MODEL` and `CLIP`;
- manages them from a single **HTML panel** (immune to ComfyUI 1.43 canvas-widget layout bugs);
- **automatically merges trigger words into the prompt** — no separate merge node in modern workflows.

---

## 2. Node I/O

| Direction | Slot | Type | Notes |
|-----------|------|------|-------|
| Input | `model` | MODEL | required |
| Input | `clip` | CLIP | required |
| Input | `prompt` | STRING | optional; base positive prompt from upstream |
| Input | `data` | STRING | hidden; JSON synced by the panel |
| Output | `MODEL` | MODEL | model with all enabled LoRAs applied |
| Output | `CLIP` | CLIP | clip with all enabled LoRAs applied |
| Output | `prompt` | STRING | prompt with trigger words merged in |

There is **no separate `trigger_words` output** — triggers are computed internally and emitted only via the merged `prompt`.

### Workflow wiring

```
Positive Prompt  ──►  Lora Box (prompt in)
Lora Box (prompt out) ──►  CLIP Text Encode (Positive)
Lora Box (model/clip out) ──►  rest of pipeline
```

`CLIP Text Encode (Positive)` remains **required** — the node prepares text; the encoder turns it into conditioning.

---

## 3. Panel — global UI

- **HTML DOM panel** inside the node; height is computed deterministically; width follows the node.
- **Header:** title + live **active count** (e.g. `3 active`, or `muted`).
- **⚙ Settings** (disclosure — secondary controls hidden by default):
  - **Mute all** — skip LoRA application; pass `prompt` through unchanged; per-row on/off states are preserved in `data` across workflow save/load.
  - **Model + clip** — separate strength sliders for model vs clip.
  - **Trigger merge:** position (`at start` / `at end of prompt`) + delimiter (`sep`, default `, `).
- **+ Add Lora** — append a new row.
- **Undo toast** when a row is deleted (reversible delete).

---

## 4. LoRA row (card)

Each LoRA is one card with:

| Control | Behaviour |
|---------|-----------|
| **On/off toggle** | Enable or disable this LoRA for the current run; the whole card dims when off (or amber-bordered when it duplicates another row) |
| **Thumbnail** | Visual identity for the LoRA (see §7); also the **drag handle** for reorder |
| **Name field** | Click → searchable grouped picker |
| **＋ / − toggle** | Expand / collapse the inline trigger-word editor for this row |
| **✕** | Remove row (with Undo toast) |
| **Strength slider + number** | Slider covers **0 … 2** (default `1.0`); the value box accepts any number you type, clamped to **±10** (negative "anti-LoRA" weights allowed) |

Additional rules:

- **Duplicate detection** — same `.safetensors` selected in multiple rows → `duplicate` badge.
- **Apply order** = row order (top to bottom after reorder).
- Row state is stored in hidden `data` JSON and survives workflow save/load.

---

## 5. LoRA picker

Floating searchable dropdown attached to the name field.

| Feature | Detail |
|---------|--------|
| Search | Filter by substring (case-insensitive) |
| Groups | **Z-Image**, **Flux**, **Krea**, **SDXL**, **SD1.5**, **LTX Video**, **Other** (+ any custom groups) |
| Group detection | Filename heuristics first; if inconclusive, read **safetensors metadata** (`ss_base_model_version`, `modelspec.architecture`, etc.) |
| Custom groups | **Right-click** a lora → move to a built-in/existing/new group, or revert to auto. Stored by lora name in `user_categories.json` (persists, shared across every Lora Box). |
| Sort | Built-in groups in fixed order, custom groups alphabetically before **Other**; alphabetical within each group |
| Keyboard | ↑↓ navigate, Enter select, Escape close |
| UX | Exactly **one** picker open at a time; scrollable list; closes on outside click |

---

## 6. Trigger words

### Auto-detection

Read from `.safetensors` metadata, in priority order:

- `trigger_phrase`, `ss_trigger_words`, `modelspec.trigger_phrase`, Civitai-style fields (`activation text`, `trainedWords`, …)
- Training tag frequency (`ss_tag_frequency`) is **fallback only**, not primary

### Manual override

- Per-row editor (ⓘ): comma-separated text.
- **↺ Reset** — discard override and re-fetch auto-detected words.
- Row JSON field `trig` overrides auto-detection when set.

### Merge into prompt

When `prompt` input is connected:

1. Collect trigger words from all **enabled** rows (respecting mute-all).
2. Deduplicate against words already present in the prompt (case-insensitive).
3. Insert at **start** or **end** per panel setting, using the configured delimiter.
4. Emit result on `prompt` output.

When `prompt` is **not** connected, `prompt` output = trigger words only.

When **mute all** is on: no LoRAs applied; `prompt` output = input prompt unchanged.

---

## 7. Preview images

A preview **belongs to the LoRA file**, not the workflow or node instance.

### Storage

Sidecar next to the `.safetensors`:

| Priority | Path pattern |
|----------|----------------|
| 1 (manual) | `<lora-basename>.{png,jpg,jpeg,webp,gif}` |
| 2 (auto) | `<lora-basename>.preview.{ext}` — Civitai / model manager convention |

Manual upload overrides auto preview.

### UI actions

| Action | Result |
|--------|--------|
| **＋ Add** / drag & drop | Upload custom image (max 8 MB) |
| **✨ Generate** | Run canonical test render; save as sidecar |
| **Hover thumbnail** | Enlarged preview + regenerate / replace / remove |
| **✕** | Delete sidecar |

Once set, the thumbnail appears in **every** Lora Box and workflow that references that LoRA.

### Generate preview (canonical test)

Headless render via the ComfyUI queue, using the **engine for the LoRA's
architecture** (chosen from its detected category):

| Engine | Used for | Graph (loaders → sampler) |
|--------|----------|----------------------------|
| **Z-Image** | Z-Image (+ unrecognised, by default) | UNet + CLIP(lumina2) + VAE, AuraFlow shift, euler/simple, 8 steps, cfg 1.0 |
| **Flux** | Flux, Krea | UNet + dual CLIP + VAE, FluxGuidance, euler/simple, 20 steps, cfg 1.0 |
| **SDXL** | SDXL | Checkpoint, dpmpp_2m/karras, 25 steps, cfg 7.0, 1024² |
| **SD1.5** | SD1.5 | Checkpoint, dpmpp_2m/karras, 25 steps, cfg 7.0, 512² |

Shared across engines: a **fixed seed** (comparable thumbnails), output resized
to a ~512px PNG sidecar, and two **kinds** —

| Kind | Base prompt | Trigger position |
|------|-------------|------------------|
| **Character** | portrait, soft daylight, neutral background… | triggers at **start** |
| **Style** | woman reading in a cafe, everyday scene… | triggers at **start** |

Trigger words are auto-read from metadata before rendering.

Each engine's models are configurable — `preview_config.json` (Z-Image flat
keys; other engines under a `flux`/`sdxl`/`sd15` section) or env vars
(`LORABOX_PREVIEW_UNET/_CLIP/_VAE`, or `LORABOX_PREVIEW_<ENGINE>_<KEY>`) — and
resolved leniently against the installed list. Force an engine with
`LORABOX_PREVIEW_ENGINE`, set the unrecognised-LoRA fallback with
`LORABOX_PREVIEW_DEFAULT_ENGINE`. If models can't be found, Generate fails with
an explicit "aren't installed" message naming the engine; **Upload /
drag-and-drop still work**, so the feature degrades gracefully on any setup.

---

## 8. Backend

### Core (`lora_box.py`)

- Applies LoRAs via `comfy.sd.load_lora_for_models`.
- Caches loaded weights and parsed metadata keyed by file mtime.
- `IS_CHANGED` hashes: row JSON, connected `prompt`, and mtime of each referenced LoRA.
- Strength clamp: **−10 … 10** (manual entry is independent of the 0…2 slider); NaN/Inf rejected.

### HTTP routes

All routes validate the file name against ComfyUI's registered `loras` list (path traversal protection).

When a LoRA has no local trigger words / preview, the `triggers` and `preview`
routes can fall back to Civitai (resolve by file hash). This is **opt-in**, off
unless `LORABOX_CIVITAI` is set (`1`/`true`/`yes`/`on`), and always runs off the
event loop.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/lorabox/triggers?file=` | Trigger words for one LoRA |
| GET | `/lorabox/categories` | `{ name → group }` for all LoRAs (incl. user overrides) |
| GET | `/lorabox/usercats` | `{ overrides: { name → group } }` (custom picker groups) |
| POST | `/lorabox/usercats` | Set/clear a lora's custom group (`{name, group}`; empty group = revert to auto) |
| GET | `/lorabox/preview?file=` | Serve preview image bytes |
| POST | `/lorabox/preview?file=&ext=` | Upload sidecar (≤ 8 MB) |
| DELETE | `/lorabox/preview?file=` | Remove sidecar |
| POST | `/lorabox/preview/generate?file=&kind=` | Generate canonical preview (engine by architecture) |

---

## 9. Legacy / out of scope

| Item | Status |
|------|--------|
| `LoraBoxPromptMerge` node | Legacy; replaced by built-in merge in `LoraBox` |
| Separate `trigger_words` output | Removed |
| Preview stored in workflow JSON | Not supported — disk sidecar only |
| Replacing CLIP Text Encode | Not in scope — node outputs STRING, encoder still required |

---

## 10. UX principles

1. **One node, one screen** — load, triggers, and preview in one place.
2. **Calm by default** — rare settings behind ⚙.
3. **Reversible actions** — Undo on delete.
4. **LoRA as a first-class object** — image and category follow the file across workflows.
5. **Comparable previews** — fixed seed/prompt template for Generate.
6. **Stable DOM** — no flicker on re-render; slider drag never moves the node.

---

## 11. Future ideas (not required for v1)

- Batch **Generate preview for all** LoRAs in the list.
- Import preview from AI Toolkit training samples folder.
- **Use last workflow output** as preview with one click.
- More render engines for Generate (e.g. SD3, LTX still-frame).

> Done since v1: cross-architecture Generate (Z-Image/Flux/SDXL/SD1.5),
> user-defined picker categories, and Civitai cover fetch by hash (opt-in).

---

## 12. File layout

```
ComfyUI/custom_nodes/ComfyUI-LoraBox/
├── __init__.py
├── lora_box.py           # node + API routes
├── preview_generate.py   # canonical preview pipeline
├── web/
│   └── lora_box.js       # DOM panel UI
├── tests/
├── README.md             # install & developer notes
└── SPEC.md               # this document
```
