# Interactions — the LoRA row (G)

Behaviour the Figma mock can't convey. Implemented in `frontend/lora_box.js`
(`renderRows`) + `frontend/ui/*`.

## Strength
- **Drag horizontally on the row (the "meter")** → sets strength. The amber fill
  maps the common zone **0…1.5** across the row width, snapped to **0.05**.
  Clicks on the controls (checkbox / name / ⓘ / ✕ / clip / cover) are excluded
  from the drag.
- **The big number is a scrubby field** — drag ↕ to fine-tune (relative,
  `0.004`/px), **double-click to type** an exact value. Covers the full **−3…3**
  range (negative = "anti-LoRA").
- **Minus slot**: the value is `sign (fixed 1ch) + digits` so the digits never
  shift when the value goes negative. Mono digits use `tabular-nums`.

## Row
- **Cover preview** (right, full row height) = the LoRA's sidecar image; click to
  set/replace, hover to enlarge, ✕ to remove. Missing previews are best-effort
  fetched from Civitai by file hash (blocked on the current host — see note).
- **ⓘ** toggles a full-width trigger-word drawer below the row (auto-detected,
  editable, ↺ to reset). The cover keeps the row's height; the drawer grows the
  card downward.
- **Picker** hides loras already chosen in other rows (no accidental dupes) and,
  best-effort, surfaces ones matching the wired model's architecture
  (`Z-Image / Flux / Krea / LTX`), with an optional "only compatible" filter.

## Node
- Header: **mute all** + **model + clip** (the sep delimiter and trigger-position
  dropdown were removed — position is fixed; the companion node handles it).
- Background image/video spans the whole node incl. the title bar via the
  `onDrawBackground` / `onDrawForeground` seam trick over a uniform `#1b1b1b` base.

> Note: Civitai auto-fetch is a no-op on the Kyiv host — civitai.com is blocked
> there (TLS reset). It works wherever civitai is reachable.
