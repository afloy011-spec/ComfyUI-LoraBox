import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/*
 * Afloy Lora Box UI — DOM-widget panel (clean-minimal redesign).
 *
 * Design principles (high-rated 2026 apps — Linear / Vercel / Raycast):
 *  - clarity over cleverness: every control is labelled or has a tooltip;
 *  - calm by default: secondary settings (mute / model+clip / trigger merge)
 *    live behind a ⚙ disclosure, not in your face;
 *  - direct manipulation, reversible: delete shows an Undo toast;
 *  - one accent colour, an 8px spacing rhythm, restrained motion;
 *  - stable DOM: preview images are cached so a re-render never flickers.
 *
 * Hard-won stability rules kept intact:
 *  - height is computed DETERMINISTICALLY (no live measurement) except the
 *    trigger editor, whose grown textarea height feeds back into the total;
 *  - pointerdown + wheel are swallowed at the container, touch is swallowed
 *    globally in capture phase — a slider drag never leaks to litegraph;
 *  - we never intercept pointermove (that froze DOM repositioning);
 *  - width is the framework's to manage; we only drive height.
 */

const GAP = 8, MIN_W = 240, FIXED_W = 380;
// Heights tuned to the Figma "Design System" mockup: taller LORA STACK header
// (40), 56px thumbnail cards, model+clip adds a second weight row (SEP_EXTRA),
// trigger editor is a titled panel (TRIG_HEAD + padding). All deterministic.
const PAD_V = 18, HEAD_H = 40, OPTS_H = 208, CARD_BASE = 80, SEP_EXTRA = 26, ADD_H = 38, EMPTY_H = 86, BUFFER = 8;
// Trigger panel when open contributes: TRIG_GAP (margin above) + TRIG_HEAD
// (header 16 + gap 8 + border 2) + TRIG_PAD (panel padding 12+12) + the
// growable textarea height. These MUST all be summed in sizeNode or the panel
// clips off the bottom of the node.
const TRIG_GAP = 8, TRIG_HEAD = 26, TRIG_PAD = 24, TRIG_MIN = 28;
// Strength range 0…2 (default 1.0 = normal, sits in the middle of the slider,
// matching the Figma mockup). 0 = off, 2 = strongest.
const SMIN = 0, SMAX = 2;
const clampS = (v) => Math.max(SMIN, Math.min(SMAX, isNaN(v) ? 1 : v));

/* ---- looping video background (ported from the timur branch) -------------
 * The title bar is painted by litegraph AFTER onDrawBackground, so a single
 * background draw can't cover it. Trick: draw the SAME source with the SAME
 * dest rect [0,-titleH, W, titleH+bodyH] in BOTH callbacks but clip each to its
 * own region — body slice in onDrawBackground (behind slots/widget), title slice
 * in onDrawForeground (over the title bar). Identical dest ⇒ the y=0 seam lines
 * up invisibly. Until the video is ready we fall back to the first lora's
 * preview image. */
const BG_ALPHA = 0.4;                  // background opacity
const BG_BASE = "#141414";             // opaque base painted under the image (matches --lb-bg)
const _bgCache = {};                   // lora name -> HTMLImageElement
function _titleH() { return (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30; }
function bgImageFor(node) {
    const rows = node._lbRows || [];
    let name = null;
    for (const r of rows) { if (r && r.name && r.name !== "None") { name = r.name; break; } }
    if (!name) return null;
    let im = _bgCache[name];
    if (!im) {
        im = new Image();
        _bgCache[name] = im;
        im.onload = () => { im._ok = true; node.setDirtyCanvas(true, true); };
        im.onerror = () => { im._err = true; };
        im.src = "/lorabox/preview?file=" + encodeURIComponent(name);
        return null;
    }
    return im._ok ? im : null;
}
function drawCover(ctx, src, dx, dy, dw, dh) {
    const iw = src.videoWidth || src.naturalWidth, ih = src.videoHeight || src.naturalHeight;
    if (!iw || !ih) return;
    const s = Math.max(dw / iw, dh / ih);   // cover: fill dest, crop overflow
    const cw = dw / s, ch = dh / s;
    ctx.drawImage(src, (iw - cw) / 2, (ih - ch) / 2, cw, ch, dx, dy, dw, dh);
}
let VIDEO = null;
function ensureVideo() {
    if (VIDEO) return VIDEO;
    const v = document.createElement("video");
    v.src = new URL("./katosik_loop.mp4", import.meta.url).href;
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.play().catch(() => {});
    VIDEO = v;
    const pump = () => {
        if (app.canvas) app.canvas.setDirty(true, true);   // repaint to show next frame
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(pump);
        else requestAnimationFrame(pump);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(pump);
    else requestAnimationFrame(pump);
    return v;
}
function bgSource(node) {
    const v = ensureVideo();
    if (v && v.readyState >= 2 && v.videoWidth) return v;   // animated loop once ready
    return bgImageFor(node);                                 // static preview until then
}
function drawBgSlice(node, ctx, region) {
    if (node.flags && node.flags.collapsed) return;
    const src = bgSource(node);
    if (!src) return;
    const W = node.size[0], bodyH = node.size[1], tH = _titleH(), totalH = tH + bodyH;
    ctx.save();
    ctx.beginPath();
    if (region === "title") ctx.rect(0, -tH, W, tH);   // title-bar strip
    else ctx.rect(0, 0, W, bodyH);                      // body
    ctx.clip();
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG_BASE;
    ctx.fillRect(0, -tH, W, totalH);
    ctx.globalAlpha = BG_ALPHA;
    drawCover(ctx, src, 0, -tH, W, totalH);            // SAME dest rect in both
    ctx.restore();
    // the opaque base covers the title text in the title strip — redraw it
    if (region === "title" && node.title) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#e8e8e8";
        ctx.font = "14px Arial";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(node.title, 18, -tH / 2);
        ctx.restore();
    }
}

let LORA_LIST = null;
let LORA_LIST_PROMISE = null;
let LORA_CATEGORIES = null;
let LORA_CAT_PROMISE = null;

async function getLoraCategories() {
    if (LORA_CATEGORIES) return LORA_CATEGORIES;
    if (!LORA_CAT_PROMISE) {
        LORA_CAT_PROMISE = (async () => {
            try {
                const r = await api.fetchApi("/lorabox/categories");
                if (r.ok) {
                    const j = await r.json();
                    return j.categories || {};
                }
            } catch (e) {}
            return {};
        })().then((m) => (LORA_CATEGORIES = m || {}));
    }
    return LORA_CAT_PROMISE;
}

async function getLoraList() {
    if (LORA_LIST) return LORA_LIST;
    if (!LORA_LIST_PROMISE) {
        LORA_LIST_PROMISE = (async () => {
            const tryJson = async (url) => {
                try { const r = await api.fetchApi(url); if (r.ok) return await r.json(); } catch (e) {}
                try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
                return null;
            };
            let j = await tryJson("/rgthree/api/loras");
            if (Array.isArray(j) && j.length) return j;
            j = await tryJson("/object_info/LoraLoader");
            const list = j?.LoraLoader?.input?.required?.lora_name?.[0];
            if (Array.isArray(list)) return list.filter((x) => x !== "None");
            return [];
        })().then((l) => (LORA_LIST = l || []));
    }
    return LORA_LIST_PROMISE;
}

async function fetchAuto(name) {
    try {
        const r = await api.fetchApi("/lorabox/triggers?file=" + encodeURIComponent(name || ""));
        const j = await r.json();
        return j.words || [];
    } catch (e) { return []; }
}

/* ---- per-lora preview images -------------------------------------------- */
// Cache the resolved object URL per lora name (null = checked, none exists).
// Shared across every card/render so re-rendering the list (drag-reorder, a
// toggle, opening the trigger editor, …) reuses the already-loaded image
// instead of refetching it — refetching is what made thumbnails flicker on
// every interaction. Entries are evicted only when the picture actually
// changes (upload / delete).
const PREVIEW_CACHE = new Map();      // name -> objectURL | null
const PREVIEW_PROMISES = new Map();   // name -> in-flight Promise (de-dupe)

function evictPreview(name) {
    if (PREVIEW_CACHE.has(name)) {
        const u = PREVIEW_CACHE.get(name);
        if (u) { try { URL.revokeObjectURL(u); } catch (e) {} }
        PREVIEW_CACHE.delete(name);
    }
    PREVIEW_PROMISES.delete(name);
}

// Resolve a lora's preview as an object URL (server finds a manual sidecar OR
// the lora's own <name>.preview.png), or null if none.
async function loadPreviewURL(name) {
    if (!name || name === "None") return null;
    if (PREVIEW_CACHE.has(name)) return PREVIEW_CACHE.get(name);
    if (PREVIEW_PROMISES.has(name)) return PREVIEW_PROMISES.get(name);
    const p = (async () => {
        try {
            const r = await api.fetchApi("/lorabox/preview?file=" + encodeURIComponent(name));
            if (!r.ok) return null;
            const b = await r.blob();
            if (!b || !b.size) return null;
            return URL.createObjectURL(b);
        } catch (e) { return null; }
    })().then((u) => { PREVIEW_CACHE.set(name, u); PREVIEW_PROMISES.delete(name); return u; });
    PREVIEW_PROMISES.set(name, p);
    return p;
}

async function uploadPreview(name, file) {
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const r = await api.fetchApi(
        "/lorabox/preview?file=" + encodeURIComponent(name) + "&ext=" + encodeURIComponent(ext),
        { method: "POST", body: file });
    return r.ok;
}

async function deletePreview(name) {
    try { await api.fetchApi("/lorabox/preview?file=" + encodeURIComponent(name), { method: "DELETE" }); }
    catch (e) {}
}

// Render a quick preview on the GPU (Z-Image test) and save it as the sidecar.
async function generatePreview(name, kind = "character") {
    if (!name || name === "None") return { ok: false, error: "no lora selected" };
    const url = "/lorabox/preview/generate?file=" + encodeURIComponent(name) + "&kind=" + encodeURIComponent(kind);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 190000);
    try {
        const r = await api.fetchApi(url, { method: "POST", signal: ctrl.signal });
        return await r.json();
    } catch (e) {
        if (e && e.name === "AbortError") return { ok: false, error: "timed out (3 min)" };
        return { ok: false, error: String(e) };
    } finally {
        clearTimeout(timer);
    }
}

/* floating enlarged preview on hover */
let THUMB_POP = null;
function closeThumbPop() { if (THUMB_POP) { THUMB_POP.remove(); THUMB_POP = null; } }
function openThumbPop(anchorEl, url) {
    closeThumbPop();
    if (!url) return;
    const pop = document.createElement("div");
    pop.className = "lb-thumb-pop";
    const img = document.createElement("img");
    img.src = url;
    pop.appendChild(img);
    document.body.appendChild(pop);
    THUMB_POP = pop;
    const place = () => {
        const r = anchorEl.getBoundingClientRect();
        const pw = pop.offsetWidth, ph = pop.offsetHeight;
        let left = r.right + 8;
        if (left + pw > window.innerWidth - 8) left = r.left - pw - 8;
        if (left < 8) left = 8;
        let top = r.top + r.height / 2 - ph / 2;
        top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
        pop.style.left = left + "px";
        pop.style.top = top + "px";
    };
    if (img.complete) place(); else img.onload = place;
}

/* ---- undo toast (Gmail / Linear pattern) -------------------------------- */
let LB_TOAST = null, LB_TOAST_T = null;
function closeToast() {
    if (LB_TOAST_T) { clearTimeout(LB_TOAST_T); LB_TOAST_T = null; }
    if (LB_TOAST) { LB_TOAST.remove(); LB_TOAST = null; }
}
function showToast(msg, actionLabel, onAction, ms = 6000) {
    closeToast();
    const t = document.createElement("div");
    t.className = "lb-toast";
    const m = document.createElement("span");
    m.textContent = msg;
    t.appendChild(m);
    if (actionLabel) {
        const b = document.createElement("button");
        b.className = "lb-toast-act";
        b.textContent = actionLabel;
        b.onclick = () => { closeToast(); onAction && onAction(); };
        t.appendChild(b);
    }
    document.body.appendChild(t);
    LB_TOAST = t;
    requestAnimationFrame(() => t.classList.add("show"));
    LB_TOAST_T = setTimeout(closeToast, ms);
}

function injectStyle() {
    const old = document.getElementById("lorabox-style");
    if (old) old.remove();
    const s = document.createElement("style");
    s.id = "lorabox-style";
    s.textContent = `
/* ── Afloy Lora Box — visual layer ported 1:1 from the Figma "Design System"
   mockup (file dV1Uq5…). Colours/radii/spacings match the mockup; the DOM
   structure & sizing machinery are unchanged. ── */

/* Design tokens — single source of truth, mirrored in web/tokens.json and the
   Figma "LoraBox" variable collection. Defined on :root so the floating
   popups / menus / toast (appended to <body>, outside .lorabox) inherit them. */
:root{
  --lb-accent:#3b82f6;        /* primary blue (switch on, MODEL slider fill, focus) */
  --lb-accent-soft:#1d3a5f;   /* active badge / selected row / menu hover bg  */
  --lb-clip:#22c55e;          /* green CLIP slider fill (ties to the CLIP socket) */
  --lb-field:#0d0d0d;         /* inset fields: value box, search, trigger box */
  --lb-border:#2e2e2e;        /* default control border                      */
}
.lorabox-root{width:100%; height:100%; overflow:hidden; box-sizing:border-box;}
.lorabox{width:100%; display:flex; flex-direction:column;
  font-family:'Inter',var(--font-sans,inherit); font-size:12px; color:var(--input-text,#f0f0f0);
  padding:8px 10px 10px; gap:${GAP}px; box-sizing:border-box;}
.lorabox *{box-sizing:border-box;}

/* header: "LORA STACK" · active badge · ⚙ — a section divider underneath */
.lorabox .lb-head{display:flex; align-items:center; gap:12px; height:${HEAD_H}px;
  border-bottom:1px solid var(--border-color,#1f1f1f);}
.lorabox .lb-title{margin-right:auto; font-size:11px; font-weight:600; letter-spacing:.08em;
  text-transform:uppercase; color:#6a6a6a; user-select:none;}
.lorabox .lb-head-actions{display:flex; align-items:center; gap:14px;}
.lorabox .lb-count{font-size:11px; font-weight:600; white-space:nowrap; padding:4px 8px;
  border-radius:5px; background:var(--lb-accent-soft,#1d3a5f); color:var(--lb-accent,#3b82f6);}
.lorabox .lb-count.muted{background:#3a2e1a; color:#e7ad5e;}
.lorabox .lb-gear{width:20px; height:20px; flex:0 0 auto; display:flex; align-items:center;
  justify-content:center; background:transparent; border:none; border-radius:6px; cursor:pointer;
  color:#777; line-height:1; transition:background .12s,color .12s; padding:0;}
.lorabox .lb-gear:hover{background:var(--comfy-menu-bg,#3a3a3a); color:#fff;}
.lorabox .lb-gear.on{color:var(--lb-accent,#3b82f6);}
.lorabox .lb-gear svg{display:block;}

/* options disclosure — full-width rows, a TRIGGERS section, a hint */
.lorabox .lb-opts{display:flex; flex-direction:column; gap:0; padding:6px 14px 12px;
  background:var(--comfy-input-bg,#161616); border:1px solid var(--border-color,#272727); border-radius:10px;}
.lorabox .lb-opts .lb-orow{display:flex; align-items:center; gap:12px; min-height:34px;}
.lorabox .lb-opts .lb-orow .lb-olbl{margin-right:auto; font-size:13px; color:#d4d4d4; user-select:none; cursor:pointer;}
.lorabox .lb-opts .lb-sec{margin-top:8px; padding-bottom:2px; font-size:10px; font-weight:600;
  letter-spacing:.07em; text-transform:uppercase; color:#6a6a6a;}
.lorabox .lb-opts select{height:28px; padding:0 8px; cursor:pointer; min-width:74px;
  background:var(--comfy-menu-bg,#1c1c1c); color:#e6e6e6; border:1px solid var(--border-color,var(--lb-border,#2e2e2e));
  border-radius:6px; font-size:12px; outline:none;}
.lorabox .lb-opts select:focus{border-color:var(--lb-accent,#3b82f6);}
.lorabox .lb-opts input.lb-delim{width:44px; height:28px; text-align:center;
  background:var(--lb-field,#0d0d0d); color:#e6e6e6; border:1px solid var(--border-color,var(--lb-border,#2e2e2e));
  border-radius:6px; font-size:12px; outline:none;}
.lorabox .lb-opts input.lb-delim:focus{border-color:var(--lb-accent,#3b82f6);}
.lorabox .lb-opts .lb-hint{margin-top:10px; font-size:11px; line-height:1.5; color:#6f6f6f;}
.lorabox .lb-opts .lb-hint b{color:#9a9a9a; font-weight:600;}

/* toggle switch (lg variant for the options panel) */
.lb-switch{position:relative; width:32px; height:18px; flex:0 0 auto; cursor:pointer; display:inline-block;}
.lb-switch input{position:absolute; inset:0; opacity:0; margin:0; cursor:pointer;}
.lb-switch .track{position:absolute; inset:0; border-radius:9px; background:var(--border-color,#3a3a3a);
  transition:background .15s;}
.lb-switch .knob{position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%;
  background:#e6e6e6; transition:transform .15s; pointer-events:none; box-shadow:0 1px 2px rgba(0,0,0,.4);}
.lb-switch input:checked + .track{background:var(--lb-accent,#3b82f6);}
.lb-switch input:checked ~ .knob{transform:translateX(14px);}
.lb-switch.lg{width:42px; height:22px;}
.lb-switch.lg .knob{width:18px; height:18px;}
.lb-switch.lg input:checked ~ .knob{transform:translateX(20px);}

/* list + cards */
.lorabox .lb-list{display:flex; flex-direction:column; gap:${GAP}px;}
.lorabox .lb-card{position:relative; display:flex; flex-direction:column; min-width:0;
  padding:10px; border-radius:8px;
  background:var(--comfy-input-bg,#1c1c1e); border:1px solid var(--border-color,#2a2a2a);
  transition:opacity .14s, border-color .14s, box-shadow .14s;}
.lorabox .lb-card:hover{border-color:#3a3a3d;}
.lorabox .lb-card.lb-off{opacity:.4;}
.lorabox .lb-card.lb-dup{border-color:#b9802f;}
/* explicit text badge so a duplicate isn't conveyed by colour alone */
.lorabox .lb-card.lb-dup::after{content:"duplicate"; position:absolute; top:-7px; right:10px;
  font-size:8px; line-height:1.4; letter-spacing:.05em; text-transform:uppercase; font-weight:700;
  color:#241a0c; background:#d8932f; padding:1px 6px; border-radius:5px; pointer-events:none;}
.lorabox .lb-card.lb-dragging{opacity:.45;}
.lorabox .lb-card.lb-drop-before{box-shadow:inset 0 2px 0 0 var(--lb-accent,#3b82f6);}
.lorabox .lb-card.lb-drop-after{box-shadow:inset 0 -2px 0 0 var(--lb-accent,#3b82f6);}

.lorabox .lb-main{display:grid; grid-template-columns:56px minmax(0,1fr); gap:12px; align-items:center; min-width:0;}
.lorabox .lb-content{min-width:0; display:flex; flex-direction:column; gap:8px;}

/* thumbnail (56×56) — the card's drag handle for reorder, too */
.lorabox .lb-thumb{flex:0 0 auto; width:56px; height:56px; align-self:center; position:relative;
  border-radius:6px; overflow:hidden; cursor:pointer; display:flex; align-items:center; justify-content:center;
  background:var(--comfy-menu-bg,#262626); border:1px solid var(--border-color,#333);
  transition:border-color .12s;}
.lorabox .lb-thumb:hover{border-color:#5273b8;}
.lorabox .lb-thumb.drag-over{border-color:#7aa2f0; border-style:dashed;}
.lorabox .lb-thumb img{width:100%; height:100%; object-fit:cover; display:none; pointer-events:none;}
.lorabox .lb-thumb.has-img img{display:block;}
.lorabox .lb-thumb .lb-ph{font-size:22px; line-height:1; color:#6f6f6f; pointer-events:none;}
.lorabox .lb-thumb.has-img .lb-ph{display:none;}
.lorabox .lb-thumb:hover .lb-ph{color:#bbb;}
.lorabox .lb-thumb.busy{opacity:.6; animation:lb-pulse 1s ease infinite;}
@keyframes lb-pulse{0%,100%{opacity:.5}50%{opacity:1}}

/* row line 1: switch · name(grows, borderless) · bookmark · delete */
.lorabox .lb-l1{display:grid; grid-template-columns:auto minmax(90px,1fr) auto auto; gap:8px;
  align-items:center; min-width:0; height:24px;}
.lorabox .lb-ico svg{display:block;}
/* the LoRA picker field — a visible, clickable combobox (min 90px so it can
   never collapse), so there's always a clear "choose a LoRA" control. */
.lorabox .lb-name{display:flex; align-items:center; gap:6px; min-width:0; height:24px; padding:0 9px;
  cursor:pointer; user-select:none; border-radius:6px; color:#f0f0f0;
  background:var(--comfy-menu-bg,#262626); border:1px solid transparent;
  transition:background .12s, border-color .12s;}
.lorabox .lb-name:hover{background:var(--comfy-menu-bg,var(--lb-border,#2e2e2e)); border-color:var(--border-color,#3a3a3a);}
.lorabox .lb-name.open{border-color:var(--lb-accent,#3b82f6);}
.lorabox .lb-name .txt{flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:12px; font-weight:500;}
.lorabox .lb-name .txt.none{color:#9a9a9a; font-weight:400;}
.lorabox .lb-name .car{flex:0 0 auto; color:#777; font-size:9px;}
.lorabox .lb-ico{width:18px; height:18px; flex:0 0 auto; padding:0; cursor:pointer; display:flex;
  align-items:center; justify-content:center; background:transparent; color:#888; border:none;
  border-radius:4px; line-height:1; transition:background .12s, color .12s;}
.lorabox .lb-ico:hover{background:var(--comfy-menu-bg,#333); color:#e6e6e6;}
.lorabox .lb-ico.on{color:var(--lb-accent,#3b82f6);}
/* the "extra params" plus rotates 45° into an × while its panel is open */
.lorabox .lb-more svg{transition:transform .15s;}
.lorabox .lb-more.on svg{transform:rotate(45deg);}
.lorabox .lb-del:hover{background:#5b2b2b; color:#fff;}

/* weight row(s): LABEL · slider(grows, blue fill) · value box */
.lorabox .lb-wrow{display:grid; grid-template-columns:auto minmax(0,1fr) 46px; gap:8px;
  align-items:center; min-width:0; height:20px;}
.lorabox .lb-card.lb-sep .lb-wlbl{min-width:58px;}
.lorabox .lb-wlbl{font-size:9px; letter-spacing:.04em; text-transform:uppercase; color:#555; white-space:nowrap;}
.lorabox .lb-slider{-webkit-appearance:none; appearance:none; width:100%; min-width:36px; height:4px;
  border-radius:2px; background:#2a2a2a; outline:none; cursor:pointer;}
.lorabox .lb-slider::-webkit-slider-thumb{-webkit-appearance:none; width:12px; height:12px; border-radius:50%;
  background:#fff; border:none; box-shadow:0 0 0 1px rgba(0,0,0,.35); cursor:pointer;}
.lorabox .lb-slider::-moz-range-thumb{width:12px; height:12px; border-radius:50%; background:#fff; border:none; cursor:pointer;}
.lorabox .lb-num{width:100%; height:20px; padding:0 6px; text-align:right;
  background:var(--lb-field,#0d0d0d); color:#f0f0f0; border:1px solid var(--border-color,var(--lb-border,#2e2e2e)); border-radius:4px; font-size:10px;
  -moz-appearance:textfield; appearance:textfield;}
.lorabox .lb-num::-webkit-outer-spin-button,
.lorabox .lb-num::-webkit-inner-spin-button{-webkit-appearance:none; margin:0;}
.lorabox .lb-num:focus{outline:none; border-color:var(--lb-accent,#3b82f6);}
/* at-a-glance read of the weight: warm for negative ("anti-LoRA"), dim for 0 */
.lorabox .lb-num.neg{color:#e8855a; border-color:#7a4a36;}
.lorabox .lb-num.zero{color:#888;}

/* trigger editor — a titled panel under the card */
.lorabox .lb-trig{margin-top:8px; display:flex; flex-direction:column; gap:8px;
  background:var(--comfy-menu-bg,#161616); border:1px solid var(--border-color,#272727);
  border-radius:8px; padding:12px;}
.lorabox .lb-trig-head{display:flex; align-items:center; gap:8px; height:16px;}
.lorabox .lb-trig-head .t{margin-right:auto; font-size:10px; font-weight:600; letter-spacing:.07em;
  text-transform:uppercase; color:#6a6a6a;}
.lorabox .lb-trig-head .lb-ico{width:16px; height:16px;}
.lorabox .lb-trig-in{width:100%; min-height:${TRIG_MIN}px; padding:8px 10px;
  background:var(--lb-field,#0d0d0d); color:#dfeef0; resize:none; overflow:hidden;
  border:1px solid var(--border-color,var(--lb-border,#2e2e2e)); border-radius:6px; font-size:11px; line-height:1.4;
  outline:none; font-family:inherit;}
.lorabox .lb-trig-in:focus{border-color:var(--lb-accent,#3b82f6);}
.lorabox .lb-trig-in::placeholder{color:#667;}

/* add button — dashed outline, calm */
.lorabox .lb-add{height:36px; width:100%; display:flex; align-items:center; justify-content:center; gap:6px;
  background:transparent; color:#777; border:1px dashed var(--border-color,var(--lb-border,#2e2e2e)); border-radius:8px;
  cursor:pointer; font-size:12px; transition:background .14s, border-color .14s, color .14s;}
.lorabox .lb-add:hover{border-color:var(--lb-accent,#3b82f6); color:#cfe0ff;
  background:color-mix(in srgb,var(--lb-accent,#3b82f6) 8%,transparent);}
.lorabox .lb-add:active{transform:translateY(1px);}

/* empty state — icon, headline, hint */
.lorabox .lb-empty{display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px;
  min-height:${EMPTY_H}px; color:#888; text-align:center;}
.lorabox .lb-empty .lb-empty-ic{width:40px; height:40px; display:flex; align-items:center; justify-content:center;
  border-radius:8px; background:var(--comfy-input-bg,#1c1c1c); border:1px solid var(--border-color,#2a2a2a);
  color:#555; margin-bottom:2px;}
.lorabox .lb-empty .lb-empty-t{font-size:13px; color:#cfcfcf;}
.lorabox .lb-empty .lb-empty-s{font-size:11px; color:#777;}

/* searchable lora picker (floating) */
.lb-pop{position:fixed; z-index:10010; display:flex; flex-direction:column; gap:6px;
  padding:6px; max-height:min(380px, calc(100vh - 24px)); overflow:hidden; border-radius:9px;
  background:var(--comfy-menu-bg,#1c1c1c); border:1px solid var(--border-color,var(--lb-border,#2e2e2e));
  box-shadow:0 12px 34px rgba(0,0,0,.55); font-family:sans-serif; font-size:12px;
  line-height:1.4; box-sizing:border-box;}
.lb-pop-search-wrap{position:relative; flex:0 0 auto;}
.lb-pop-search-wrap .ic{position:absolute; left:10px; top:50%; transform:translateY(-50%);
  color:#888; pointer-events:none; display:flex;}
.lb-pop-search{width:100%; height:32px; padding:0 10px 0 32px; font-size:12px; border-radius:7px; outline:none;
  background:var(--comfy-input-bg,var(--lb-field,#0d0d0d)); color:var(--input-text,#eee);
  border:1px solid var(--border-color,var(--lb-border,#2e2e2e)); box-sizing:border-box;}
.lb-pop-search:focus{border-color:var(--lb-accent,#3b82f6);}
.lb-pop-list{flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:auto;
  overscroll-behavior:contain; -webkit-overflow-scrolling:touch;}
.lb-pop-none{padding:7px 9px; font-size:12px; font-style:italic; color:#888; cursor:pointer; border-radius:6px;}
.lb-pop-none:hover,.lb-pop-none.hi{background:var(--lb-accent-soft,#1d3a5f); color:#fff;}
.lb-pop-group{position:sticky; top:0; z-index:2; padding:6px 9px 3px; margin:0;
  font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
  color:#6a6a6a; background:var(--comfy-menu-bg,#1c1c1c);
  border-bottom:1px solid var(--border-color,#272727); pointer-events:none; line-height:1.2;}
.lb-pop-item{display:flex; align-items:center; gap:8px; width:100%; margin:0 0 2px; padding:7px 9px;
  border-radius:6px; cursor:pointer; font-size:12px; line-height:1.35; min-height:30px; box-sizing:border-box;
  color:var(--input-text,#ddd); background:transparent; border:none; text-align:left; font-family:inherit;}
.lb-pop-item .chk{width:16px; height:16px; flex:0 0 auto; color:var(--lb-accent,#3b82f6); visibility:hidden; display:flex;}
.lb-pop-item.sel .chk{visibility:visible;}
.lb-pop-item .lbl{flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.lb-pop-item.sel{background:var(--lb-accent-soft,#1d3a5f); color:#fff;}
.lb-pop-item:hover,.lb-pop-item.hi{background:var(--lb-accent,#3b82f6); color:#fff;}
.lb-pop-item:hover .chk,.lb-pop-item.hi .chk{color:#fff;}
.lb-pop-empty{padding:8px; color:#888; font-size:11px; font-style:italic;}
/* model-aware picker: compatibility toggle bar + dimmed incompatible items */
.lb-pop-bar{display:flex; align-items:center; gap:8px; flex:0 0 auto; padding:5px 9px; cursor:pointer;
  font-size:11px; color:#aaa; user-select:none; border-bottom:1px solid var(--lb-border,#2e2e2e);}
.lb-pop-bar input{cursor:pointer; margin:0;}
.lb-pop-bar b{color:var(--lb-accent,#3b82f6); font-weight:600;}
.lb-pop-item.dim{opacity:.45;}
.lb-pop-item.dim:hover,.lb-pop-item.dim.hi{opacity:1;}
.lb-thumb-pop{position:fixed; z-index:10020; padding:4px; border-radius:10px; pointer-events:none;
  background:var(--comfy-menu-bg,#1c1c1c); border:1px solid var(--border-color,var(--lb-border,#2e2e2e));
  box-shadow:0 12px 36px rgba(0,0,0,.6);}
.lb-thumb-pop img{display:block; max-width:280px; max-height:280px; border-radius:6px;}

/* thumbnail picture menu (icons + a red destructive item) */
.lb-menu{position:fixed; z-index:10015; display:flex; flex-direction:column; gap:1px; padding:5px;
  min-width:220px; border-radius:9px; background:var(--comfy-menu-bg,#1c1c1c);
  border:1px solid var(--border-color,var(--lb-border,#2e2e2e)); box-shadow:0 12px 34px rgba(0,0,0,.55); font-family:sans-serif;}
.lb-menu-head{font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:#6a6a6a; padding:5px 9px 5px;}
.lb-menu-sep{height:1px; margin:4px 0; background:var(--border-color,#272727);}
.lb-menu-item{display:flex; flex-direction:row; align-items:center; gap:10px; padding:8px 9px;
  border:none; border-radius:6px; background:transparent; color:var(--input-text,#ddd);
  cursor:pointer; text-align:left; font-family:inherit; font-size:12px;}
.lb-menu-item .ic{width:16px; height:16px; flex:0 0 auto; color:#9a9a9a; display:flex;}
.lb-menu-item:hover{background:var(--lb-accent-soft,#1d3a5f); color:#fff;}
.lb-menu-item:hover .ic{color:#fff;}
.lb-menu-item.danger{color:#ef5350;}
.lb-menu-item.danger .ic{color:#ef5350;}
.lb-menu-item.danger:hover{background:#5b2b2b; color:#fff;}
.lb-menu-item.danger:hover .ic{color:#fff;}

/* undo toast — bordered Undo button */
.lb-toast{position:fixed; left:50%; bottom:26px; transform:translate(-50%,12px); opacity:0; z-index:10030;
  display:flex; align-items:center; gap:14px; padding:10px 15px; border-radius:10px;
  background:var(--comfy-menu-bg,#1c1c1c); color:var(--input-text,#eee);
  border:1px solid var(--border-color,var(--lb-border,#2e2e2e)); box-shadow:0 12px 36px rgba(0,0,0,.5);
  font-size:12px; transition:opacity .18s, transform .18s;}
.lb-toast.show{opacity:1; transform:translate(-50%,0);}
.lb-toast-act{background:transparent; border:1px solid #3b5a8a; border-radius:6px; padding:4px 12px;
  cursor:pointer; font-size:12px; font-weight:600; color:var(--lb-accent,#3b82f6);}
.lb-toast-act:hover{background:var(--lb-accent-soft,#1d3a5f); color:#fff;}
`;
    document.head.appendChild(s);
}

// Always show 2 decimals with a DOT ("1.00") — a plain text input, so a
// non-English browser locale can't render it with a comma ("1,00").
const fmtNum = (v) => (Math.round(v * 100) / 100).toFixed(2);
const tintNum = (el, v) => { el.classList.toggle("neg", v < 0); el.classList.toggle("zero", v === 0); };

// ── Feather-style line icons used across the panel (match the Figma mockup) ──
const svg = (inner, sz = 14) => `<svg viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
// a tag glyph for the trigger-words toggle (clearer than the old ⓘ)
const TAG_SVG = svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10z"/><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none"/>');
// a plus glyph — opens the row's extra parameters (trigger words); rotates to an
// × when the panel is open (see .lb-more.on in the stylesheet)
const PLUS_SVG = svg('<path d="M12 5v14M5 12h14"/>', 16);
const X_SVG = svg('<path d="M18 6 6 18M6 6l12 12"/>');
const GEAR_SVG = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 16);
const SEARCH_SVG = svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 16);
const CHECK_SVG = svg('<path d="M20 6 9 17l-5-5"/>', 16);
const IMAGE_SVG = svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>', 16);
const UPLOAD_SVG = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>', 16);
const TRASH_SVG = svg('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>', 16);
const LAYERS_SVG = svg('<path d="M12 2 2 7l10 5 10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>', 18);
const CHEVRON_UP_SVG = svg('<path d="m18 15-6-6-6 6"/>', 16);

// Paint the blue fill on a native range input up to its current value, like the
// Figma slider (blue left of the thumb, grey track to the right).
function setSliderFill(slider, v, fill) {
    const pct = Math.max(0, Math.min(100, ((v - SMIN) / (SMAX - SMIN)) * 100));
    const c = fill || "var(--lb-accent,#3b82f6)";
    slider.style.background = `linear-gradient(to right, ${c} 0 ${pct}%, #2a2a2a ${pct}% 100%)`;
}
const STRENGTH_TIP = "Strength: 0 = off, 1 = normal, up to 2 = stronger than trained.";

/* ---- small floating text menu (thumbnail picture options) --------------- */
let MENU = null;
function onMenuDocDown(e) { if (MENU && !MENU.contains(e.target)) closeMenu(); }
function closeMenu() {
    if (!MENU) return;
    document.removeEventListener("mousedown", onMenuDocDown, true);
    MENU.remove(); MENU = null;
}
// items: [{head}] section label, or {label, desc?, onPick} action
function openMenu(anchor, items) {
    closeMenu();
    const m = document.createElement("div");
    m.className = "lb-menu";
    items.forEach((it) => {
        if (it.head) {
            const h = document.createElement("div");
            h.className = "lb-menu-head"; h.textContent = it.head;
            m.appendChild(h); return;
        }
        if (it.sep) { const d = document.createElement("div"); d.className = "lb-menu-sep"; m.appendChild(d); return; }
        const b = document.createElement("button");
        b.className = "lb-menu-item" + (it.danger ? " danger" : "");
        if (it.icon) { const ic = document.createElement("span"); ic.className = "ic"; ic.innerHTML = it.icon; b.appendChild(ic); }
        const t = document.createElement("span"); t.className = "t"; t.textContent = it.label;
        b.appendChild(t);
        b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); closeMenu(); it.onPick(); };
        m.appendChild(b);
    });
    stop(m);
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
    m.style.left = Math.max(8, left) + "px";
    m.style.top = Math.max(8, top) + "px";
    MENU = m;
    setTimeout(() => document.addEventListener("mousedown", onMenuDocDown, true), 0);
}

/* Force the panel's root element to span the node's content width. The
 * frontend positions/sizes DOM widgets reactively off the widget's HEIGHT, so
 * widening the node does not re-stretch the element on its own. We set the
 * width ourselves (node width minus the widget margin on both sides — core
 * DOMWidget margin is 10) so the panel always fills the node at any width. */
function fitRootWidth(node) {
    const root = node && node._lbRoot;
    if (!root || !node.size) return;
    const m = (node._lbWidget && typeof node._lbWidget.margin === "number") ? node._lbWidget.margin : 10;
    const px = Math.max(0, Math.round(node.size[0] - 2 * m)) + "px";
    if (root.style.width !== px) root.style.width = px;
}
const stop = (el) => el.addEventListener("pointerdown", (e) => e.stopPropagation());
const eatWheel = (el) => el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
const rowOff = (node, row) => node._lbMute || !row.on;

/* Stop touch gestures that start inside any Lora Box panel from reaching
 * litegraph, which would pinch-zoom / pan the whole graph when you press or
 * drag a slider on a touchscreen / precision touchpad. litegraph binds its
 * touch listeners in the CAPTURE phase on an ANCESTOR of the DOM-widget layer,
 * so a bubble-phase stop on our own element is too late. A capture-phase
 * listener on `document` runs first; we only stopPropagation (never
 * preventDefault), so the control's native touch action still works. Once. */
let LB_TOUCH_GUARD = false;
function installTouchGuard() {
    if (LB_TOUCH_GUARD) return;
    LB_TOUCH_GUARD = true;
    const guard = (e) => {
        const t = e.target;
        if (t && t.closest && t.closest(".lorabox-root")) e.stopPropagation();
    };
    for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
        document.addEventListener(ev, guard, { capture: true, passive: true });
    }
}

/* ---- lora picker grouping ------------------------------------------------ */
const LORA_GROUP_ORDER = ["Z-Image", "Flux", "Krea", "LTX Video", "Other"];

function loraCategory(name) {
    if (!name || name === "None") return null;
    if (LORA_CATEGORIES && LORA_CATEGORIES[name]) return LORA_CATEGORIES[name];
    const low = name.toLowerCase().replace(/\\/g, "/");
    if (low.includes("zimage") || low.includes("z-image") || low.includes("z_image")) return "Z-Image";
    if (low.includes("ltx")) return "LTX Video";
    if (low.includes("flux")) return "Flux";
    if (low.includes("krea")) return "Krea";
    return "Other";
}

function groupedLoraList(names, filter) {
    const f = (filter || "").trim().toLowerCase();
    const filtered = names.filter((n) => n === "None" || !f || n.toLowerCase().includes(f));
    const groups = [];
    if (filtered.includes("None")) groups.push({ label: null, items: ["None"] });
    const buckets = Object.fromEntries(LORA_GROUP_ORDER.map((g) => [g, []]));
    for (const n of filtered) {
        if (n === "None") continue;
        buckets[loraCategory(n)].push(n);
    }
    for (const g of LORA_GROUP_ORDER) {
        buckets[g].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        if (buckets[g].length) groups.push({ label: g, items: buckets[g] });
    }
    return groups;
}

/* ---- floating searchable lora picker ------------------------------------ */
let CUR_POP = null;

function onDocDown(e) {
    if (CUR_POP && !CUR_POP.contains(e.target) && e.target !== CUR_POP._anchor && !CUR_POP._anchor.contains(e.target)) closePop();
}
function onWinWheel(e) { if (CUR_POP && !CUR_POP.contains(e.target)) closePop(); }
function closePop() {
    if (!CUR_POP) return;
    const p = CUR_POP; CUR_POP = null;
    document.removeEventListener("mousedown", onDocDown, true);
    window.removeEventListener("wheel", onWinWheel, true);
    if (p._anchor) p._anchor.classList.remove("open");
    p.remove();
}

/* ---- best-effort: which base model is wired into the MODEL input? --------
 * (ported from the timur branch) No architecture flows on a MODEL link, so we
 * trace upstream to the loader and guess from its model filename / node name.
 * Returns a label matching LORA_GROUP_ORDER, or null when unsure — in which
 * case the picker just behaves normally (we never hide on a guess). */
function archFromName(s) {
    const low = (s || "").toLowerCase().replace(/\\/g, "/");
    if (/zimage|z-image|z_image/.test(low)) return "Z-Image";
    if (/ltx/.test(low)) return "LTX Video";
    if (/flux/.test(low)) return "Flux";
    if (/krea/.test(low)) return "Krea";
    return null;
}
function archFromNode(n) {
    if (!n) return null;
    let a = archFromName(n.type) || archFromName(n.title);
    if (a) return a;
    for (const w of (n.widgets || [])) {
        if (typeof w.value === "string") { a = archFromName(w.value); if (a) return a; }
    }
    return null;
}
function getLinkById(graph, id) {
    if (id == null || !graph || !graph.links) return null;
    return graph.links.get ? graph.links.get(id) : graph.links[id];
}
function traceModelArch(n, depth) {
    if (!n || !n.graph || depth > 16) return null;
    // follow a MODEL input upstream (passthroughs: sampling, patches, lora stacks, us)
    const mi = (n.inputs || []).find((i) => i.type === "MODEL" && i.link != null);
    if (mi) {
        const link = getLinkById(n.graph, mi.link);
        const up = link && traceModelArch(n.graph.getNodeById(link.origin_id), depth + 1);
        if (up) return up;
    }
    // reroute / generic passthrough
    if (/reroute/i.test(n.type || "") && (n.inputs || [])[0] && n.inputs[0].link != null) {
        const link = getLinkById(n.graph, n.inputs[0].link);
        const up = link && traceModelArch(n.graph.getNodeById(link.origin_id), depth + 1);
        if (up) return up;
    }
    return archFromNode(n);   // treat as the source loader
}
function detectModelArch(node) {
    try { return traceModelArch(node, 0); } catch (e) { return null; }
}

async function openPicker(node, row, fieldEl) {
    if (CUR_POP && CUR_POP._anchor === fieldEl) { closePop(); return; }
    closePop();
    await Promise.all([getLoraList(), getLoraCategories()]);
    const rect = fieldEl.getBoundingClientRect();
    const pop = document.createElement("div");
    pop.className = "lb-pop";
    pop._anchor = fieldEl;
    pop.style.left = rect.left + "px";
    pop.style.width = Math.max(rect.width, 220) + "px";
    const below = window.innerHeight - rect.bottom;
    if (below < 220) pop.style.bottom = (window.innerHeight - rect.top + 4) + "px";
    else pop.style.top = (rect.bottom + 4) + "px";

    const searchWrap = document.createElement("div");
    searchWrap.className = "lb-pop-search-wrap";
    const searchIc = document.createElement("span");
    searchIc.className = "ic"; searchIc.innerHTML = SEARCH_SVG;
    const search = document.createElement("input");
    search.className = "lb-pop-search";
    search.placeholder = "Search LoRA…";
    searchWrap.append(searchIc, search);
    const listEl = document.createElement("div");
    listEl.className = "lb-pop-list";
    pop.append(searchWrap, listEl);
    document.body.appendChild(pop);
    CUR_POP = pop;
    fieldEl.classList.add("open");

    const all = LORA_LIST || [];

    // model-aware: detect the wired model's architecture (best-effort). When
    // known, surface matching loras first + an "only compatible" toggle.
    const modelArch = detectModelArch(node);
    let onlyCompat = false;
    if (modelArch) {
        const bar = document.createElement("label");
        bar.className = "lb-pop-bar";
        const cb = document.createElement("input"); cb.type = "checkbox";
        const txt = document.createElement("span");
        txt.innerHTML = "model: <b>" + modelArch + "</b> · only compatible";
        cb.onchange = () => { onlyCompat = cb.checked; draw(search.value); };
        stop(cb);
        bar.append(cb, txt);
        searchWrap.after(bar);
    }

    let hi = 0;
    const setHi = (items) => {
        items.forEach((x) => x.classList.remove("hi"));
        if (items[hi]) {
            items[hi].classList.add("hi");
            items[hi].scrollIntoView({ block: "nearest" });
        }
    };
    const draw = (flt) => {
        listEl.innerHTML = "";
        hi = 0;
        let groups = groupedLoraList(all, flt);
        if (modelArch) {
            // matching architecture first; "only compatible" hides the rest (keeps None)
            if (onlyCompat) groups = groups.filter((g) => g.label === modelArch || g.label === null);
            else groups = groups.slice().sort((a, b) => (a.label === modelArch ? 0 : 1) - (b.label === modelArch ? 0 : 1));
        }
        const flat = groups.flatMap((g) => g.items);
        if (!flat.length) {
            const e = document.createElement("div");
            e.className = "lb-pop-empty";
            e.textContent = "no matches";
            listEl.appendChild(e);
            return;
        }
        for (const grp of groups) {
            if (grp.label) {
                const hdr = document.createElement("div");
                hdr.className = "lb-pop-group";
                hdr.textContent = grp.label === modelArch ? grp.label + "  ✓ matches model" : grp.label;
                listEl.appendChild(hdr);
            }
            for (const n of grp.items) {
                const incompat = modelArch && grp.label && grp.label !== modelArch && n !== "None";
                const it = document.createElement("button");
                it.type = "button";
                it.className = "lb-pop-item" + (n === row.name ? " sel" : "") + (incompat ? " dim" : "");
                it.dataset.value = n;
                const chk = document.createElement("span"); chk.className = "chk"; chk.innerHTML = CHECK_SVG;
                const lbl = document.createElement("span"); lbl.className = "lbl";
                lbl.textContent = n === "None" ? "— None —" : n;
                it.title = incompat ? n + "  (different architecture than your model)" : n;
                it.append(chk, lbl);
                it.onmousedown = (e) => { e.preventDefault(); pick(n); };
                listEl.appendChild(it);
            }
        }
        const first = listEl.querySelector(".lb-pop-item");
        if (first) first.classList.add("hi");
    };
    const pick = (n) => {
        row.name = n;
        serialize(node);
        closePop();
        // re-render so the row's thumbnail reloads for the newly chosen lora
        renderRows(node);
        sizeNode(node);
    };
    search.oninput = () => draw(search.value);
    search.onkeydown = (e) => {
        const items = [...listEl.querySelectorAll(".lb-pop-item")];
        if (e.key === "Escape") closePop();
        else if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hi + 1, items.length - 1); setHi(items); }
        else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(hi - 1, 0); setHi(items); }
        else if (e.key === "Enter") { e.preventDefault(); if (items[hi]) pick(items[hi].dataset.value); }
    };
    stop(search);
    stop(pop);
    // Let the list scroll; only stop wheel from reaching the canvas.
    listEl.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    draw("");
    setTimeout(() => {
        search.focus();
        document.addEventListener("mousedown", onDocDown, true);
        window.addEventListener("wheel", onWinWheel, true);
    }, 0);
}

app.registerExtension({
    name: "LoraBox.dom",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LoraBox") return;
        injectStyle();
        installTouchGuard();

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onCreated && onCreated.apply(this, arguments);
            const node = this;

            const dataW = (node.widgets || []).find((w) => w.name === "data");
            node._lbDataW = dataW;
            if (dataW) dataW.hidden = true;

            node._lbRows = [];
            node._lbSep = false;
            node._lbMute = false;
            node._lbPos = "beginning";
            node._lbDelim = ", ";
            node._lbOptsOpen = false;
            node._lbContentH = 150;

            // Match the Figma chrome: dark title bar + body (the default node
            // colour is a teal that clashes with the panel's near-black cards).
            node.color = "#1c1c1e";
            node.bgcolor = "#141414";

            const root = document.createElement("div");
            root.className = "lorabox-root";
            const inner = document.createElement("div");
            inner.className = "lorabox";
            root.appendChild(inner);
            node._lbRoot = root;
            node._lbInner = inner;
            // Stop pointerdown at the container so a slider drag never reaches
            // litegraph (which would resize/move the node). We deliberately do
            // NOT touch pointermove — stopping that froze DOM repositioning.
            stop(inner); eatWheel(inner);

            // ---- header: title · live count · ⚙ options ----
            const head = document.createElement("div");
            head.className = "lb-head";
            const title = document.createElement("span");
            title.className = "lb-title";
            title.textContent = "Lora Stack";
            const actions = document.createElement("div");
            actions.className = "lb-head-actions";
            const count = document.createElement("span");
            count.className = "lb-count";
            node._lbCount = count;
            const gear = document.createElement("button");
            gear.className = "lb-gear"; gear.innerHTML = GEAR_SVG; gear.title = "options";
            actions.append(count, gear);
            head.append(title, actions);
            inner.appendChild(head);

            // ---- options disclosure (mute / model+clip / trigger merge) ----
            const opts = document.createElement("div");
            opts.className = "lb-opts";
            opts.style.display = "none";
            node._lbOpts = opts;

            // a full-width "label … control" row; clicking the label flips a switch
            const mkOrow = (labelText, ctrl, title) => {
                const r = document.createElement("div");
                r.className = "lb-orow"; if (title) r.title = title;
                const lbl = document.createElement("span");
                lbl.className = "lb-olbl"; lbl.textContent = labelText;
                if (ctrl._cb) lbl.onclick = () => { ctrl._cb.checked = !ctrl._cb.checked; ctrl._cb.onchange(); };
                r.append(lbl, ctrl);
                return r;
            };

            const muteSw = mkSwitch(false, "Skip every LoRA and pass the prompt through untouched (state is preserved)",
                (v) => { node._lbMute = v; applyMute(node); updateActiveCount(node); serialize(node); }, true);
            node._lbMuteCb = muteSw._cb;
            const sepSw = mkSwitch(false, "Separate model and clip strengths per LoRA",
                (v) => { node._lbSep = v; renderRows(node); sizeNode(node); serialize(node); }, true);
            node._lbSepCb = sepSw._cb;

            const sec = document.createElement("div");
            sec.className = "lb-sec"; sec.textContent = "Triggers";

            const sel = document.createElement("select");
            [["beginning", "Start"], ["end", "End"]].forEach(([v, t]) => {
                const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o);
            });
            sel.value = node._lbPos || "beginning";
            sel.onchange = () => { node._lbPos = sel.value; serialize(node); };
            stop(sel); eatWheel(sel);
            node._lbPosSel = sel;

            const delim = document.createElement("input");
            delim.className = "lb-delim"; delim.value = node._lbDelim != null ? node._lbDelim : ", ";
            delim.title = "delimiter between prompt and trigger words";
            delim.onchange = () => { node._lbDelim = delim.value; serialize(node); };
            stop(delim); eatWheel(delim);
            node._lbDelimIn = delim;

            const hint = document.createElement("div");
            hint.className = "lb-hint";
            hint.innerHTML = "Trigger words are the keywords a LoRA was trained on. If you wire a " +
                "prompt in, they're added at the <b>start</b> (stronger emphasis) or the " +
                "<b>end</b> (a softer modifier). “Sep” is what goes between them.";

            opts.append(
                mkOrow("Mute all", muteSw, "Skip every LoRA and pass the prompt through untouched"),
                mkOrow("Model + Clip", sepSw, "Separate model and clip strengths per LoRA"),
                sec,
                mkOrow("Set at start of prompt", sel, "Where LoRA trigger words merge into a connected prompt"),
                mkOrow("Sep", delim, "Delimiter between prompt and trigger words"),
                hint,
            );
            inner.appendChild(opts);

            gear.onclick = (e) => {
                e.stopPropagation();
                node._lbOptsOpen = !node._lbOptsOpen;
                opts.style.display = node._lbOptsOpen ? "" : "none";
                gear.classList.toggle("on", node._lbOptsOpen);
                sizeNode(node);
            };
            stop(gear);

            const list = document.createElement("div");
            list.className = "lb-list";
            node._lbList = list;
            inner.appendChild(list);

            const add = document.createElement("button");
            add.className = "lb-add";
            add.textContent = "+ Add LoRA";
            add.onclick = (e) => {
                e.stopPropagation();
                node._lbRows.push({ on: true, name: "None", sm: 1.0, sc: 1.0 });
                renderRows(node); sizeNode(node); serialize(node);
            };
            stop(add);
            inner.appendChild(add);

            // Use the SAME mechanism core resizable DOM widgets use: feed our
            // deterministic content height through getMinHeight/getMaxHeight.
            // The default DOMWidgetImpl then leaves WIDTH unconstrained (node
            // resizes freely, panel fills width) and never collapses on a value
            // change.
            const hgt = () => (typeof node._lbContentH === "number" && node._lbContentH > 0) ? node._lbContentH : 150;
            const widget = node.addDOMWidget("lorabox_ui", "div", root, {
                serialize: false, hideOnZoom: false,
                getMinHeight: hgt, getMaxHeight: hgt,
            });
            node._lbWidget = widget;

            if (!node.size || node.size[0] < MIN_W) node.setSize([FIXED_W, (node.size && node.size[1]) || 200]);

            getLoraList();
            scheduleInit(node);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure && onConfigure.apply(this, arguments);
            scheduleInit(this);
        };

        // Freely resizable both ways (like the core Note node). Only stop it from
        // getting so narrow the cards get crushed; never touch the width
        // otherwise, so neither resize nor value changes can make it slip.
        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            if (size && size[0] < MIN_W) size[0] = MIN_W;
            onResize && onResize.apply(this, arguments);
            fitRootWidth(this);
        };

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground && onDrawForeground.apply(this, arguments);
            fitRootWidth(this);
            // (looping video / preview background removed — it animated and hurt
            // the readability of the panel; the node now uses its flat dark chrome.)
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () { closePop(); closeThumbPop(); closeMenu(); closeToast(); onRemoved && onRemoved.apply(this, arguments); };
    },
});

/* Defer init to a macrotask so widget values restored during deserialize
 * (onConfigure runs after ComfyUI sets the saved `data` value) are in place.
 * Deduped per node so create+configure can't run it twice or race. */
function scheduleInit(node) {
    if (node._lbInitT) clearTimeout(node._lbInitT);
    node._lbInitT = setTimeout(() => { node._lbInitT = 0; initFromData(node); }, 0);
}

/* a styled on/off switch (label > input + track + knob); lg = bigger (options) */
function mkSwitch(checked, title, onChange, lg) {
    const l = document.createElement("label");
    l.className = "lb-switch" + (lg ? " lg" : ""); l.title = title || "";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!checked;
    const track = document.createElement("span"); track.className = "track";
    const knob = document.createElement("span"); knob.className = "knob";
    cb.onchange = () => onChange(cb.checked);
    l.append(cb, track, knob);
    stop(l);
    l._cb = cb;
    return l;
}

function updateActiveCount(node) {
    if (!node._lbCount) return;
    if (node._lbMute) {
        node._lbCount.textContent = "muted";
        node._lbCount.classList.add("muted");
        return;
    }
    node._lbCount.classList.remove("muted");
    const n = node._lbRows.filter((r) => r.on && r.name && r.name !== "None").length;
    node._lbCount.textContent = n + " active";
}

function applyMute(node) {
    const els = node._lbList ? node._lbList.querySelectorAll(".lb-card") : [];
    els.forEach((el, i) => { const row = node._lbRows[i]; if (row) el.classList.toggle("lb-off", rowOff(node, row)); });
}

function markDuplicates(node) {
    const cards = node._lbList ? [...node._lbList.querySelectorAll(".lb-card")] : [];
    const counts = {};
    node._lbRows.forEach((r) => { if (r.name && r.name !== "None") counts[r.name] = (counts[r.name] || 0) + 1; });
    cards.forEach((el, i) => {
        const r = node._lbRows[i];
        el.classList.toggle("lb-dup", !!(r && r.name && r.name !== "None" && counts[r.name] > 1));
    });
}

/* ---- drag-to-reorder (native HTML5 DnD) ---------------------------------
 * Uses the browser's drag-and-drop, not pointermove, so the node itself can't
 * be dragged (pointerdown is already stopped at the container). Only the grip
 * handle starts a reorder drag. */
let LB_DRAG_FROM = null;
function clearDropMarks(node) {
    if (!node._lbList) return;
    node._lbList.querySelectorAll(".lb-card").forEach((c) =>
        c.classList.remove("lb-drop-before", "lb-drop-after"));
}
function attachReorder(node, card, handle, index) {
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
        LB_DRAG_FROM = index;
        card.classList.add("lb-dragging");
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", String(index)); } catch (_) {} }
    });
    handle.addEventListener("dragend", () => {
        card.classList.remove("lb-dragging"); clearDropMarks(node); LB_DRAG_FROM = null;
    });
    card.addEventListener("dragover", (e) => {
        if (LB_DRAG_FROM === null || LB_DRAG_FROM === index) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = card.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        card.classList.toggle("lb-drop-after", after);
        card.classList.toggle("lb-drop-before", !after);
    });
    card.addEventListener("dragleave", () => card.classList.remove("lb-drop-before", "lb-drop-after"));
    card.addEventListener("drop", (e) => {
        if (LB_DRAG_FROM === null) return;   // external file drop (image) — not us
        e.preventDefault();
        const rect = card.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        moveRow(node, LB_DRAG_FROM, index + (after ? 1 : 0));
        LB_DRAG_FROM = null;
    });
}
function moveRow(node, from, to) {
    const rows = node._lbRows;
    if (from < 0 || from >= rows.length) return;
    const [m] = rows.splice(from, 1);
    if (from < to) to--;
    to = Math.max(0, Math.min(rows.length, to));
    if (to === from && rows[to] === m) return;
    rows.splice(to, 0, m);
    renderRows(node); sizeNode(node); serialize(node);
}

/* Single source of truth: read the saved `data` widget, default only if truly
 * empty. Used by both onNodeCreated and onConfigure so neither can clobber the
 * other. */
function initFromData(node) {
    const dataW = node._lbDataW || (node.widgets || []).find((w) => w.name === "data");
    node._lbDataW = dataW;
    let parsed = [];
    try { parsed = JSON.parse(dataW?.value || "[]"); } catch (e) { parsed = []; }
    let rows = parsed, mute = false, pos = "beginning", delim = ", ";
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
        mute = !!parsed.mute;
        if (typeof parsed.pos === "string") pos = parsed.pos;
        if (typeof parsed.delim === "string") delim = parsed.delim;
        rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    }
    if (!Array.isArray(rows)) rows = [];
    if (rows.length === 0) rows = [{ on: true, name: "None", sm: 1.0, sc: 1.0 }];
    node._lbRows = rows.map((r) => {
        const o = {
            on: r.on !== false, name: r.name || "None",
            sm: clampS(r.sm != null ? r.sm : 1.0), sc: clampS(r.sc != null ? r.sc : 1.0),
        };
        if (typeof r.trig === "string") o.trig = r.trig;
        return o;
    });
    node._lbSep = node._lbRows.some((r) => r.sc !== r.sm);
    node._lbMute = mute;
    node._lbPos = pos;
    node._lbDelim = delim;
    if (node._lbSepCb) node._lbSepCb.checked = node._lbSep;
    // Restore the saved "mute all" state so a muted-saved workflow reopens muted
    // AND shows the toggle on (was reset to false → LoRAs silently un-applied).
    if (node._lbMuteCb) node._lbMuteCb.checked = node._lbMute;
    if (node._lbPosSel) node._lbPosSel.value = node._lbPos;
    if (node._lbDelimIn) node._lbDelimIn.value = node._lbDelim;
    renderRows(node); sizeNode(node); serialize(node);
}

function serialize(node) {
    if (!node._lbDataW) return;
    const rows = node._lbRows.map((r) => {
        const o = { on: !!r.on, name: r.name, sm: r.sm, sc: node._lbSep ? r.sc : r.sm };
        if (typeof r.trig === "string") o.trig = r.trig;
        return o;
    });
    node._lbDataW.value = JSON.stringify({
        v: 1, mute: !!node._lbMute,
        pos: node._lbPos || "end",
        delim: node._lbDelim != null ? node._lbDelim : ", ",
        rows,
    });
}

function mkNum(val, title, onChange) {
    const n = document.createElement("input");
    // text (not number) so the displayed value is the literal "1.00" — a
    // type=number input localises the separator (shows "1,00" in ru/de/…).
    n.className = "lb-num"; n.type = "text"; n.inputMode = "decimal";
    n.value = fmtNum(val); n.title = title;
    tintNum(n, val);
    n.onchange = () => {
        const v = clampS(parseFloat(String(n.value).replace(",", ".")));
        n.value = fmtNum(v); tintNum(n, v); onChange(v);
    };
    stop(n); eatWheel(n);
    return n;
}

function renderRows(node) {
    const list = node._lbList;
    if (!list) return;
    list.innerHTML = "";

    if (node._lbRows.length === 0) {
        const e = document.createElement("div");
        e.className = "lb-empty";
        const ic = document.createElement("div"); ic.className = "lb-empty-ic"; ic.innerHTML = LAYERS_SVG;
        const t = document.createElement("div"); t.className = "lb-empty-t"; t.textContent = "No LoRAs yet";
        const sub = document.createElement("div"); sub.className = "lb-empty-s"; sub.textContent = "Press + Add LoRA to get started";
        e.append(ic, t, sub);
        list.appendChild(e);
        updateActiveCount(node);
        return;
    }

    node._lbRows.forEach((row, i) => {
        const card = document.createElement("div");
        card.className = "lb-card" + (rowOff(node, row) ? " lb-off" : "") + (node._lbSep ? " lb-sep" : "");

        // ── line 1: switch · name (borderless text) · bookmark · delete ──
        const l1 = document.createElement("div");
        l1.className = "lb-l1";

        const sw = mkSwitch(row.on, "enable / disable this LoRA", (v) => {
            row.on = v; card.classList.toggle("lb-off", rowOff(node, row));
            updateActiveCount(node); serialize(node);
        });

        const field = document.createElement("div");
        field.className = "lb-name"; field.title = row.name || "None"; field.tabIndex = 0;
        const txt = document.createElement("span");
        txt.className = "txt" + (!row.name || row.name === "None" ? " none" : "");
        txt.textContent = row.name && row.name !== "None" ? row.name : "Choose a LoRA…";
        const car = document.createElement("span"); car.className = "car"; car.textContent = "▼";
        field.append(txt, car);
        field.onclick = (e) => { e.stopPropagation(); openPicker(node, row, field); };
        stop(field);

        const trig = document.createElement("button");
        trig.className = "lb-ico lb-more" + (row._open ? " on" : ""); trig.innerHTML = PLUS_SVG;
        trig.title = "доп. параметры — триггер-слова этой LoRA";
        trig.onclick = (e) => { e.stopPropagation(); row._open = !row._open; renderRows(node); sizeNode(node); };
        stop(trig);

        const del = document.createElement("button");
        del.className = "lb-ico lb-del"; del.innerHTML = X_SVG; del.title = "remove this LoRA";
        del.onclick = (e) => {
            e.stopPropagation();
            const removed = node._lbRows[i], at = i;
            node._lbRows.splice(i, 1);
            renderRows(node); sizeNode(node); serialize(node);
            showToast("LoRA removed", "Undo", () => {
                node._lbRows.splice(Math.min(at, node._lbRows.length), 0, removed);
                renderRows(node); sizeNode(node); serialize(node);
            });
        };
        stop(del);

        l1.append(sw, field, trig, del);

        // ── weight row(s): LABEL · slider (blue fill) · value box ──
        const mkWeightRow = (label, value, onChange, fill) => {
            const r = document.createElement("div");
            r.className = "lb-wrow";
            const lbl = document.createElement("span"); lbl.className = "lb-wlbl"; lbl.textContent = label;
            const slider = document.createElement("input");
            slider.className = "lb-slider"; slider.type = "range";
            slider.min = String(SMIN); slider.max = String(SMAX); slider.step = "0.05"; slider.value = String(value);
            slider.title = STRENGTH_TIP;
            setSliderFill(slider, value, fill);
            const num = mkNum(value, label.replace("WEIGHT", "strength") + ". " + STRENGTH_TIP, (v) => {
                slider.value = String(v); setSliderFill(slider, v, fill); onChange(v);
            });
            slider.oninput = () => {
                const v = clampS(parseFloat(slider.value));
                num.value = fmtNum(v); tintNum(num, v); setSliderFill(slider, v, fill); onChange(v);
            };
            stop(slider); eatWheel(slider);
            r.append(lbl, slider, num);
            return r;
        };

        const content = document.createElement("div");
        content.className = "lb-content";
        content.append(l1);
        if (node._lbSep) {
            content.append(
                mkWeightRow("MODEL WEIGHT", row.sm, (v) => { row.sm = v; serialize(node); }),
                mkWeightRow("CLIP WEIGHT", row.sc != null ? row.sc : row.sm, (v) => { row.sc = v; serialize(node); }, "var(--lb-clip,#22c55e)"),
            );
        } else {
            content.append(mkWeightRow("WEIGHT", row.sm, (v) => { row.sm = v; serialize(node); }));
        }

        const thumb = buildThumb(node, row);
        attachReorder(node, card, thumb, i);   // drag the picture to reorder

        const main = document.createElement("div");
        main.className = "lb-main";
        main.append(thumb, content);

        card.append(main);
        if (row._open) card.append(buildTrigEditor(node, row));

        list.appendChild(card);
    });

    markDuplicates(node);
    updateActiveCount(node);
}

/* per-row thumbnail: the lora's reference picture (shared across workflows).
 * Auto-loads the lora's own preview when one exists. A picture-less thumb shows
 * a faint +; clicking it (or an image) opens a small TEXT menu with the options
 * — Generate (Character/Style), Upload, Remove — so the row stays icon-free.
 * Hover an image to enlarge it; you can also drag & drop an image onto it. */
function buildThumb(node, row) {
    const thumb = document.createElement("div");
    thumb.className = "lb-thumb";
    thumb.title = "Picture for this LoRA — click for options, drag to reorder";
    const img = document.createElement("img");
    const ph = document.createElement("div");
    ph.className = "lb-ph"; ph.textContent = "＋";
    thumb.append(img, ph);

    const setURL = (url) => {
        // URLs are owned by PREVIEW_CACHE (shared across renders) — do NOT revoke
        // here or a sibling card showing the same lora would lose its image.
        thumb._url = url || null;
        if (url) { if (img.src !== url) img.src = url; thumb.classList.add("has-img"); }
        else { img.removeAttribute("src"); thumb.classList.remove("has-img"); }
    };
    const refresh = () => {
        if (!row.name || row.name === "None") { setURL(null); return; }
        // synchronous when cached → image is there on the first frame, so a
        // re-render (e.g. drag-reorder) never flashes empty.
        if (PREVIEW_CACHE.has(row.name)) { setURL(PREVIEW_CACHE.get(row.name)); return; }
        loadPreviewURL(row.name).then((u) => {
            if (document.body.contains(thumb) && row.name && row.name !== "None") setURL(u);
        });
    };
    thumb._lbRefresh = refresh;
    refresh();

    const needLora = () => {
        if (!row.name || row.name === "None") { showToast("Pick a LoRA first", null, null, 2200); return true; }
        return false;
    };
    const applyFile = async (f) => {
        if (!f || !f.type || !f.type.startsWith("image/")) return;
        if (f.size > 8 * 1024 * 1024) { alert("Image too large (max 8 MB)."); return; }
        const ok = await uploadPreview(row.name, f);
        if (ok) { evictPreview(row.name); refresh(); }
    };
    const pickFile = () => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.accept = "image/*";
        inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) applyFile(f); };
        inp.click();
    };
    const doGen = async (kind) => {
        if (thumb.classList.contains("busy")) return;
        closeThumbPop();
        thumb.classList.add("busy");
        const res = await generatePreview(row.name, kind);
        thumb.classList.remove("busy");
        if (res && res.ok) { evictPreview(row.name); refresh(); }
        else alert("Preview generation failed: " + ((res && res.error) || "unknown error"));
    };

    thumb.onclick = (e) => {
        e.stopPropagation();
        if (needLora()) return;
        const items = [
            { head: "Picture for this LoRA" },
            { label: "Generate — Character", icon: IMAGE_SVG, onPick: () => doGen("character") },
            { label: "Generate — Style", icon: IMAGE_SVG, onPick: () => doGen("style") },
            { sep: true },
            { label: "Upload an image…", icon: UPLOAD_SVG, onPick: pickFile },
        ];
        if (thumb.classList.contains("has-img")) {
            items.push({
                label: "Remove picture", icon: TRASH_SVG, danger: true, onPick: async () => {
                    closeThumbPop(); await deletePreview(row.name); evictPreview(row.name); refresh();
                }
            });
        }
        openMenu(thumb, items);
    };
    // drag & drop an image straight onto the thumbnail (skip while an internal
    // reorder drag is in flight — that's handled by the card, not the picture)
    thumb.addEventListener("dragover", (e) => {
        if (LB_DRAG_FROM !== null) return;
        if (!row.name || row.name === "None") return;
        e.preventDefault(); e.stopPropagation();
        thumb.classList.add("drag-over");
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    thumb.addEventListener("dragleave", () => thumb.classList.remove("drag-over"));
    thumb.addEventListener("drop", (e) => {
        if (LB_DRAG_FROM !== null) return;
        if (!row.name || row.name === "None") return;
        e.preventDefault(); e.stopPropagation();
        thumb.classList.remove("drag-over");
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) applyFile(f);
    });
    thumb.onmouseenter = () => { if (thumb._url) openThumbPop(thumb, thumb._url); };
    thumb.onmouseleave = () => closeThumbPop();
    stop(thumb);
    return thumb;
}

function buildTrigEditor(node, row) {
    const wrap = document.createElement("div");
    wrap.className = "lb-trig";

    const header = document.createElement("div");
    header.className = "lb-trig-head";
    const htxt = document.createElement("span"); htxt.className = "t"; htxt.textContent = "Triggers";
    const reset = document.createElement("button");
    reset.className = "lb-ico"; reset.textContent = "↺"; reset.title = "reset to auto-detected";
    const chev = document.createElement("button");
    chev.className = "lb-ico"; chev.innerHTML = CHEVRON_UP_SVG; chev.title = "collapse";
    chev.onclick = (e) => { e.stopPropagation(); row._open = false; renderRows(node); sizeNode(node); };
    stop(chev);
    header.append(htxt, reset, chev);

    const ta = document.createElement("textarea");
    ta.className = "lb-trig-in";
    ta.rows = 1;
    ta.placeholder = "trigger words (comma separated)…";

    const grow = () => {
        ta.style.height = "auto";
        const h = Math.max(TRIG_MIN, ta.scrollHeight);
        ta.style.height = h + "px";
        row._trigH = h;
        sizeNode(node);
    };

    if (typeof row.trig === "string") {
        ta.value = row.trig;
        requestAnimationFrame(grow);
    } else {
        ta.placeholder = "detecting…";
        fetchAuto(row.name).then((w) => {
            if (typeof row.trig !== "string" && document.body.contains(ta)) {
                ta.value = w.join(", ");
                ta.placeholder = w.length ? "" : "no auto words — type your own…";
                grow();
            }
        });
    }
    ta.oninput = () => { row.trig = ta.value; serialize(node); grow(); };
    reset.onclick = (e) => {
        e.stopPropagation();
        delete row.trig; serialize(node);
        ta.value = ""; ta.placeholder = "detecting…";
        fetchAuto(row.name).then((w) => { ta.value = w.join(", "); ta.placeholder = w.length ? "" : "no auto words — type your own…"; grow(); });
        grow();
    };
    stop(ta); eatWheel(ta); stop(reset);
    wrap.append(header, ta);
    return wrap;
}

/* deterministic height; open trigger editors and the options panel contribute */
function sizeNode(node) {
    const rows = node._lbRows;
    let listH;
    if (rows.length === 0) listH = EMPTY_H;
    else listH = rows.reduce((a, r) => a + CARD_BASE + (r._open ? TRIG_GAP + TRIG_HEAD + TRIG_PAD + (r._trigH || TRIG_MIN) : 0), 0) + (rows.length - 1) * GAP;
    const optsH = node._lbOptsOpen ? OPTS_H + GAP : 0;
    node._lbContentH = PAD_V + HEAD_H + GAP + optsH + listH + GAP + ADD_H + BUFFER;
    // Only HEIGHT is ours; width is whatever the user set. Preserve width and
    // let computeSize derive height from getMinHeight/getMaxHeight — so value
    // changes can't collapse the node and the user can still resize it.
    const curW = (node.size && node.size[0]) || FIXED_W;
    node.setSize([curW, node.computeSize()[1]]);
    fitRootWidth(node);
    node.setDirtyCanvas(true, true);
}
