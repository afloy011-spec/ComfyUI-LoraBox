# Changelog

All notable changes to **Afloy Lora Box** are documented here.
Versions follow [SemVer](https://semver.org); each release is a git tag (`vX.Y.Z`).

## [1.7.0] — 2026-07-02

Hardening + housekeeping release: no behaviour changes to the node itself.

### Changed
- **Preview generation now queues through the public ComfyUI HTTP API**
  (`POST /prompt` + `GET /history/{id}`) instead of the in-process
  `prompt_queue` internals, whose tuple shape has changed between ComfyUI
  versions. Also honours a TLS (`--tls-keyfile`) server.
- **`window.prompt()` is gone**: naming a preset and creating a picker group
  now use a styled inline text field inside the menu (Enter/✓ confirms,
  Esc cancels). Native blocking dialogs clashed with the panel UI and are
  disabled in some embedded webviews.
- **Picker categories come only from the server** (`/lorabox/categories`).
  The client-side filename re-detection was removed — it had already drifted
  from the Python rules and could disagree with the backend.
- **`web/lora_box.js` split into modules**: server I/O + caches moved to
  `web/lb_api.js`, the SVG icon set to `web/lb_icons.js`; `lora_box.js` now
  owns the DOM/UX only. Dropped the unused `TAG_SVG` icon.

### Fixed
- `/lorabox/triggers` no longer reads safetensors headers on the server event
  loop (cold-cache reads of a large header could stall the whole UI briefly).
- The lora-list fallback (`/rgthree/api/loras`) now validates the response
  shape (array of name strings) before trusting it.

### Added
- **CI**: GitHub Actions runs the unittest suite on Python 3.9–3.12 for every
  push and pull request.
- This changelog.

## [1.6.x] — 2026

- **1.6.5** — fix the in-node prompt placeholder getting clipped on reload.
- **1.6.4** — presets/menus dismiss on any outside click or scroll.
- **1.6.1–1.6.3** — LoRA picker polish: no orphan/parallel popups, tidy rows.
- **1.6.0** — trigger auto-merge and the in-node prompt are now optional
  (⚙ → Trigger position: Off / Prompt field toggle).

## [1.5.x] — 2026

- **1.5.1** — presets: styled one-click menu instead of a native `<select>`.
- **1.5.0** — stack presets, Solo (right-click a row's switch), missing-file
  badge, per-LoRA notes + Civitai link.

## [1.4.x] and earlier — 2026

- **1.4.x** — in-node Prompt editor (fixes prompt ignored in some workflows),
  public-readiness passes, picker polish.
- **1.3.0** — architecture-aware Generate (Z-Image / Flux / SDXL / SD1.5),
  custom picker categories.
- **1.0–1.2** — initial public release: DOM-panel multi-LoRA loader, trigger
  word auto-detection (header fields, sidecars, `ss_tag_frequency`), preview
  sidecars + Civitai lookups (opt-in), drag-reorder, undo delete, design
  tokens mirrored in Figma. Full detail: `git log v1.1.0-pre-public..v1.4.3`.
