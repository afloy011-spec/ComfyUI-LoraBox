/* Shared constants + tiny DOM helpers. Leaf module — imports nothing. */
export const GAP = 8, MIN_W = 240, FIXED_W = 380;
export const ROOT_PAD = 16, INNER_GAP = 16, HEAD_H = 20, ADD_H = 36, BUFFER = 8;
export const TRIG_MIN = 28;
// Allow negative ("anti-LoRA") and >1 weights for parity with rgthree / the
// core loader. Default still sits at 1.0; clamp keeps it sane.
export const SMIN = -3, SMAX = 3;

export const clampS = (v) => Math.max(SMIN, Math.min(SMAX, isNaN(v) ? 1 : v));
export const round2 = (v) => (Math.round(v * 100) / 100).toString();
export const tintNum = (el, v) => { el.classList.toggle("neg", v < 0); el.classList.toggle("zero", v === 0); };

// Stop a pointerdown from reaching litegraph (so dragging a control never
// moves/resizes the node). We never touch pointermove (that froze DOM layout).
export const stop = (el) => el.addEventListener("pointerdown", (e) => e.stopPropagation());
export const eatWheel = (el) => el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
export const rowOff = (node, row) => node._lbMute || !row.on;
