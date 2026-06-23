# Afloy Lora Box

A compact multi-LoRA loader for ComfyUI with a custom DOM (HTML) panel UI.

It exists to sidestep the ComfyUI 1.43 frontend bug that mis-lays-out rgthree's
hand-drawn canvas widgets (rows shift / disappear). The editor is rendered as an
HTML overlay independent of litegraph's widget layout, so it stays stable while
offering a one-row-per-LoRA design.

## Features

- One row per LoRA: enable toggle, searchable picker, strength slider + number.
- Optional separate **model** / **clip** strengths (`model + clip` checkbox).
- **Mute all** that survives a workflow save without wiping per-row on/off state.
- Drag-to-reorder rows; duplicate LoRAs are highlighted.
- Per-row trigger words: auto-detected from safetensors metadata, fully editable,
  resettable to auto. Emitted on the `trigger_words` output.
- Random-LoRA button (🎲).

## Node

**Afloy Lora Box** (`LoraBox`, category `loaders`)

| Input | Type | Notes |
|-------|------|-------|
| `model` | MODEL | required |
| `clip`  | CLIP  | required |
| `data`  | STRING | hidden; JSON kept in sync by the panel |

Outputs: `MODEL`, `CLIP`, `trigger_words` (STRING).

Strengths are clamped to `0..2`; non-finite values (NaN/Inf) are rejected.

## Install

Clone into `ComfyUI/custom_nodes/` and restart ComfyUI:

```
ComfyUI/custom_nodes/afloy-lora-box/
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
- The `/lorabox/triggers` route only reads files that are in the registered
  loras list (guards against path traversal / arbitrary file reads).
