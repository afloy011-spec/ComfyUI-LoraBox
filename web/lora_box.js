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
const PAD_V = 18, HEAD_H = 24, OPTS_H = 116, CARD_BASE = 80, ADD_H = 34, EMPTY_H = 46, BUFFER = 8;
const TRIG_GAP = 8, TRIG_MIN = 28;
// Allow negative ("anti-LoRA") and >1 weights for parity with rgthree / the
// core loader. Default still sits at 1.0; clamp keeps it sane.
const SMIN = -3, SMAX = 3;
const clampS = (v) => Math.max(SMIN, Math.min(SMAX, isNaN(v) ? 1 : v));

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
.lorabox-root{width:100%; height:100%; overflow:hidden; box-sizing:border-box;}
.lorabox{width:100%; display:flex; flex-direction:column;
  font-family:inherit; font-size:12px; color:var(--input-text,#ddd);
  padding:8px 10px 10px; gap:${GAP}px; box-sizing:border-box;}
.lorabox *{box-sizing:border-box;}

/* header: title + live count + options disclosure */
.lorabox .lb-head{display:flex; align-items:center; gap:8px; height:${HEAD_H}px;}
.lorabox .lb-title{display:flex; align-items:center; gap:6px; font-size:12px; font-weight:700;
  letter-spacing:.01em; color:var(--input-text,#ececec); user-select:none;}
.lorabox .lb-title .em{font-size:13px;}
.lorabox .lb-count{margin-left:auto; font-size:10px; font-weight:600; white-space:nowrap;
  padding:2px 8px; border-radius:10px;
  background:color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 16%, transparent);
  color:color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 70%, #fff);}
.lorabox .lb-count.muted{background:color-mix(in srgb, #b9802f 22%, transparent); color:#e7ad5e;}
.lorabox .lb-gear{width:24px; height:24px; flex:0 0 auto; display:flex; align-items:center;
  justify-content:center; background:transparent; border:none; border-radius:7px; cursor:pointer;
  color:var(--descrip-text,#9a9a9a); font-size:14px; line-height:1; transition:background .12s,color .12s;}
.lorabox .lb-gear:hover{background:var(--comfy-menu-bg,#3a3a3a); color:var(--input-text,#fff);}
.lorabox .lb-gear.on{color:var(--p-button-primary-background,#7aa2f0);
  background:color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 18%, transparent);}

/* options disclosure */
.lorabox .lb-opts{display:flex; flex-direction:column; gap:9px; padding:10px 11px;
  background:var(--comfy-input-bg,#1b1b1b); border:1px solid var(--border-color,#333); border-radius:10px;}
.lorabox .lb-opts-row{display:flex; align-items:center; gap:16px; flex-wrap:wrap; min-height:18px;}
.lorabox .lb-opts .lb-swrow{display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;
  font-size:11px; color:var(--descrip-text,#bdbdbd);}
.lorabox .lb-opts .lb-lbl{font-size:11px; color:var(--descrip-text,#9a9a9a); user-select:none;}
.lorabox .lb-opts select{flex:1 1 auto; min-width:0; height:24px; padding:0 6px; cursor:pointer;
  background:var(--comfy-menu-bg,#2a2a2a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#4a4a4a); border-radius:7px; font-size:11px; outline:none;}
.lorabox .lb-opts select:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-opts input.lb-delim{width:52px; height:24px; text-align:center;
  background:var(--comfy-menu-bg,#2a2a2a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#4a4a4a); border-radius:7px; font-size:11px; outline:none;}
.lorabox .lb-opts input.lb-delim:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-opts .lb-hint{font-size:10px; line-height:1.45; color:var(--descrip-text,#888);}
.lorabox .lb-opts .lb-hint b{color:var(--descrip-text,#b5b5b5); font-weight:600;}

/* toggle switch */
.lb-switch{position:relative; width:30px; height:18px; flex:0 0 auto; cursor:pointer; display:inline-block;}
.lb-switch input{position:absolute; inset:0; opacity:0; margin:0; cursor:pointer;}
.lb-switch .track{position:absolute; inset:0; border-radius:9px; background:var(--border-color,#4a4a4a);
  transition:background .15s;}
.lb-switch .knob{position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%;
  background:#e6e6e6; transition:transform .15s; pointer-events:none;
  box-shadow:0 1px 2px rgba(0,0,0,.4);}
.lb-switch input:checked + .track{background:var(--p-button-primary-background,#3b82f6);}
.lb-switch input:checked ~ .knob{transform:translateX(12px);}

/* list + cards */
.lorabox .lb-list{display:flex; flex-direction:column; gap:${GAP}px;}
.lorabox .lb-card{position:relative; display:flex; flex-direction:column; gap:7px; min-width:0;
  padding:9px 10px 9px 14px; border-radius:11px;
  background:linear-gradient(180deg, var(--comfy-input-bg,#1e1e1e),
    color-mix(in srgb, var(--comfy-input-bg,#1e1e1e) 85%, #000));
  border:1px solid var(--border-color,#363636);
  transition:opacity .14s, border-color .14s, box-shadow .14s;}
/* left accent stripe = "this lora is active" (a non-colour cue: its presence) */
.lorabox .lb-card::before{content:""; position:absolute; left:0; top:9px; bottom:9px; width:3px;
  border-radius:0 3px 3px 0; background:var(--p-button-primary-background,#3b82f6);
  opacity:.92; transition:opacity .14s, background .14s;}
.lorabox .lb-card.lb-off::before{opacity:0;}
.lorabox .lb-card:hover{border-color:var(--p-button-primary-background,#5273b8);
  box-shadow:0 4px 14px rgba(0,0,0,.3);}
.lorabox .lb-card.lb-off{opacity:.5;}
.lorabox .lb-card.lb-dup{border-color:#b9802f;}
.lorabox .lb-card.lb-dup::before{background:#d8932f; opacity:1;}
/* explicit text badge so a duplicate isn't conveyed by colour alone */
.lorabox .lb-card.lb-dup::after{content:"duplicate"; position:absolute; top:-7px; right:10px;
  font-size:8px; line-height:1.4; letter-spacing:.05em; text-transform:uppercase; font-weight:700;
  color:#241a0c; background:#d8932f; padding:1px 6px; border-radius:5px; pointer-events:none;}
.lorabox .lb-card.lb-dragging{opacity:.45;}
.lorabox .lb-card.lb-drop-before{box-shadow:inset 0 2px 0 0 var(--p-button-primary-background,#7aa2f0);}
.lorabox .lb-card.lb-drop-after{box-shadow:inset 0 -2px 0 0 var(--p-button-primary-background,#7aa2f0);}

.lorabox .lb-main{display:flex; gap:10px; align-items:center; min-width:0;}
.lorabox .lb-content{flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:7px;}

/* thumbnail */
.lorabox .lb-thumb{flex:0 0 auto; width:48px; height:48px; align-self:center; position:relative;
  border-radius:9px; overflow:hidden; cursor:pointer; display:flex; align-items:center; justify-content:center;
  background:var(--comfy-menu-bg,#262626); border:1px solid var(--border-color,#3a3a3a);
  transition:border-color .12s;}
.lorabox .lb-thumb:hover{border-color:var(--p-button-primary-background,#5273b8);}
.lorabox .lb-thumb.drag-over{border-color:var(--p-button-primary-background,#7aa2f0); border-style:dashed;}
.lorabox .lb-thumb img{width:100%; height:100%; object-fit:cover; display:none;}
.lorabox .lb-thumb.has-img img{display:block;}
/* empty state: two labelled buttons — Generate / Add — so it is obvious how to
   give a picture-less LoRA a preview (this is the whole "how do I generate?"). */
.lorabox .lb-thumb-acts{position:absolute; inset:0; display:none; flex-direction:column;
  background:var(--comfy-menu-bg,#262626);}
.lorabox .lb-thumb:not(.has-img) .lb-thumb-acts{display:flex;}
.lorabox .lb-thumb-btn{flex:1; display:flex; align-items:center; justify-content:center; gap:4px;
  cursor:pointer; color:var(--descrip-text,#bcbcbc); font-size:8px; letter-spacing:.03em;
  text-transform:uppercase; user-select:none; transition:background .12s, color .12s;}
.lorabox .lb-thumb-btn:hover{background:var(--p-button-primary-background,#3b82f6); color:#fff;}
.lorabox .lb-thumb-btn .i{font-size:12px;}
.lorabox .lb-thumb-btn + .lb-thumb-btn{border-top:1px solid var(--border-color,#3a3a3a);}
.lorabox .lb-thumb-btn.busy{pointer-events:none; animation:lb-pulse 1s ease infinite;}
@keyframes lb-pulse{0%,100%{opacity:.55}50%{opacity:1}}
/* image state: small corner chips on hover (regenerate / replace / remove) */
.lorabox .lb-thumb-chip{position:absolute; width:16px; height:16px; display:none; align-items:center;
  justify-content:center; font-size:10px; line-height:1; border-radius:5px; cursor:pointer;
  background:rgba(0,0,0,.62); color:#fff;}
.lorabox .lb-thumb.has-img:hover .lb-thumb-chip{display:flex;}
.lorabox .lb-thumb-chip.x{top:2px; right:2px;}
.lorabox .lb-thumb-chip.x:hover{background:#7a2b2b;}
.lorabox .lb-thumb-chip.gen{bottom:2px; right:2px;}
.lorabox .lb-thumb-chip.rep{bottom:2px; left:2px;}
.lorabox .lb-thumb-chip.gen:hover,.lorabox .lb-thumb-chip.rep:hover{background:var(--p-button-primary-background,#3b82f6);}
.lorabox .lb-thumb-chip.busy{pointer-events:none; animation:lb-pulse 1s ease infinite;}

/* row line 1: grip · switch · name · actions */
.lorabox .lb-l1{display:flex; align-items:center; gap:8px; min-width:0; height:28px;}
.lorabox .lb-drag{flex:0 0 auto; width:12px; height:28px; display:flex; align-items:center;
  justify-content:center; cursor:grab; color:var(--descrip-text,#666); font-size:11px; line-height:1;
  user-select:none; opacity:.45; transition:opacity .12s, color .12s;}
.lorabox .lb-card:hover .lb-drag{opacity:1;}
.lorabox .lb-drag:hover{color:var(--input-text,#ccc);}
.lorabox .lb-drag:active{cursor:grabbing;}
.lorabox .lb-name{display:flex; align-items:center; gap:6px; flex:1 1 auto; min-width:0; height:28px;
  padding:0 10px; cursor:pointer; user-select:none; border-radius:7px;
  background:var(--comfy-menu-bg,#262626); color:var(--input-text,#eee);
  border:1px solid transparent; transition:border-color .12s, background .12s;}
.lorabox .lb-name:hover{background:var(--comfy-menu-bg,#2e2e2e); border-color:var(--border-color,#4a4a4a);}
.lorabox .lb-name.open{border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-name .txt{flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px;}
.lorabox .lb-name .txt.none{color:var(--descrip-text,#888);}
.lorabox .lb-name .car{flex:0 0 auto; color:var(--descrip-text,#888); font-size:9px;}
.lorabox .lb-ico{width:24px; height:24px; flex:0 0 auto; padding:0; cursor:pointer; display:flex;
  align-items:center; justify-content:center; background:transparent; color:var(--descrip-text,#888);
  border:none; border-radius:7px; font-size:13px; line-height:1; transition:background .12s, color .12s;}
.lorabox .lb-ico:hover{background:var(--comfy-menu-bg,#3a3a3a); color:var(--input-text,#fff);}
.lorabox .lb-ico.on{color:var(--p-button-primary-background,#7aa2f0);}
.lorabox .lb-del:hover{background:#5b2b2b; color:#fff;}

/* row line 2: slider · number (+ clip) */
.lorabox .lb-l2{display:flex; align-items:center; gap:10px; min-width:0; height:24px;}
.lorabox .lb-slider{-webkit-appearance:none; appearance:none; flex:1 1 auto; min-width:36px; height:4px;
  border-radius:3px; background:var(--border-color,#4a4a4a); outline:none; cursor:pointer;}
.lorabox .lb-slider::-webkit-slider-thumb{-webkit-appearance:none; width:14px; height:14px; border-radius:50%;
  background:var(--p-button-primary-background,#3b82f6); border:2px solid var(--comfy-input-bg,#1e1e1e); cursor:pointer;}
.lorabox .lb-slider::-moz-range-thumb{width:14px; height:14px; border-radius:50%;
  background:var(--p-button-primary-background,#3b82f6); border:2px solid var(--comfy-input-bg,#1e1e1e); cursor:pointer;}
.lorabox .lb-num{flex:0 0 52px; width:52px; height:24px; padding:0 6px; text-align:center;
  background:var(--comfy-menu-bg,#262626); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#3a3a3a); border-radius:7px; font-size:11px;
  -moz-appearance:textfield; appearance:textfield;}
.lorabox .lb-num::-webkit-outer-spin-button,
.lorabox .lb-num::-webkit-inner-spin-button{-webkit-appearance:none; margin:0;}
.lorabox .lb-num:focus{outline:none; border-color:var(--p-button-primary-background,#6a8fe0);}
/* at-a-glance read of the weight: warm for negative ("anti-LoRA"), dim for 0 */
.lorabox .lb-num.neg{color:#e8855a; border-color:#7a4a36;}
.lorabox .lb-num.zero{color:var(--descrip-text,#888);}
.lorabox .lb-clip{flex:0 0 auto; font-size:9px; letter-spacing:.04em; text-transform:uppercase;
  color:var(--descrip-text,#888); user-select:none;}

/* trigger editor */
.lorabox .lb-trig{display:flex; align-items:flex-start; gap:6px; min-width:0;}
.lorabox .lb-trig-in{flex:1 1 auto; min-width:0; min-height:${TRIG_MIN}px; padding:5px 8px;
  background:var(--comfy-menu-bg,#202a2e); color:var(--input-text,#dfeef0); resize:none; overflow:hidden;
  border:1px solid var(--border-color,#3a4a52); border-radius:7px; font-size:11px; line-height:1.4;
  outline:none; font-family:inherit;}
.lorabox .lb-trig-in:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-trig-in::placeholder{color:var(--descrip-text,#778);}

/* add button */
.lorabox .lb-add{height:${ADD_H - 4}px; width:100%; margin-top:2px; display:flex; align-items:center;
  justify-content:center; gap:7px;
  background:color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 22%, transparent);
  color:var(--input-text,#eaf2ff);
  border:1px solid color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 50%, transparent);
  border-radius:10px; cursor:pointer; font-size:12px; font-weight:600; letter-spacing:.02em;
  transition:background .14s, border-color .14s, transform .06s;}
.lorabox .lb-add:hover{background:color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 38%, transparent);
  border-color:var(--p-button-primary-background,#3b82f6);}
.lorabox .lb-add:active{transform:translateY(1px);}
.lorabox .lb-add .plus{font-size:15px; font-weight:700; line-height:1; opacity:.9;}
.lorabox .lb-empty{display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px;
  min-height:${EMPTY_H}px; color:var(--descrip-text,#888); font-size:11px; text-align:center; opacity:.85;}
.lorabox .lb-empty .lb-empty-t{font-size:10px; opacity:.75;}

/* searchable lora picker (floating) */
.lb-pop{position:fixed; z-index:10010; display:flex; flex-direction:column; gap:6px;
  padding:6px; max-height:min(380px, calc(100vh - 24px)); overflow:hidden; border-radius:9px;
  background:var(--comfy-menu-bg,#222); border:1px solid var(--border-color,#555);
  box-shadow:0 12px 34px rgba(0,0,0,.55); font-family:sans-serif; font-size:12px;
  line-height:1.4; box-sizing:border-box;}
.lb-pop-search{flex:0 0 auto; height:30px; padding:0 10px; font-size:12px; border-radius:7px; outline:none;
  background:var(--comfy-input-bg,#1a1a1a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#555); box-sizing:border-box;}
.lb-pop-search:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lb-pop-list{flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:auto;
  overscroll-behavior:contain; -webkit-overflow-scrolling:touch;}
.lb-pop-group{position:sticky; top:0; z-index:2; padding:5px 9px 3px; margin:0;
  font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
  color:var(--descrip-text,#888); background:var(--comfy-menu-bg,#222);
  border-bottom:1px solid var(--border-color,#444); pointer-events:none; line-height:1.2;}
.lb-pop-item{display:block; width:100%; margin:0 0 2px; padding:6px 9px; border-radius:6px;
  cursor:pointer; font-size:12px; line-height:1.35; min-height:27px; box-sizing:border-box;
  color:var(--input-text,#ddd); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  background:transparent; border:none; text-align:left; font-family:inherit;}
.lb-pop-item:hover,.lb-pop-item.hi{background:var(--p-button-primary-background,#3b82f6); color:#fff;}
.lb-pop-item.sel{outline:1px solid var(--border-color,#666);}
.lb-pop-empty{padding:8px; color:var(--descrip-text,#888); font-size:11px; font-style:italic;}
.lb-thumb-pop{position:fixed; z-index:10020; padding:4px; border-radius:10px; pointer-events:none;
  background:var(--comfy-menu-bg,#222); border:1px solid var(--border-color,#555);
  box-shadow:0 12px 36px rgba(0,0,0,.6);}
.lb-thumb-pop img{display:block; max-width:280px; max-height:280px; border-radius:6px;}

/* undo toast */
.lb-toast{position:fixed; left:50%; bottom:26px; transform:translate(-50%,12px); opacity:0; z-index:10030;
  display:flex; align-items:center; gap:14px; padding:10px 15px; border-radius:10px;
  background:var(--comfy-menu-bg,#232323); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#555); box-shadow:0 12px 36px rgba(0,0,0,.5);
  font-size:12px; transition:opacity .18s, transform .18s;}
.lb-toast.show{opacity:1; transform:translate(-50%,0);}
.lb-toast-act{background:transparent; border:none; cursor:pointer; font-size:12px; font-weight:700;
  color:var(--p-button-primary-background,#7aa2f0);}
.lb-toast-act:hover{text-decoration:underline;}
`;
    document.head.appendChild(s);
}

const round2 = (v) => (Math.round(v * 100) / 100).toString();
const tintNum = (el, v) => { el.classList.toggle("neg", v < 0); el.classList.toggle("zero", v === 0); };

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

    const search = document.createElement("input");
    search.className = "lb-pop-search";
    search.placeholder = "search lora…";
    const listEl = document.createElement("div");
    listEl.className = "lb-pop-list";
    pop.append(search, listEl);
    document.body.appendChild(pop);
    CUR_POP = pop;
    fieldEl.classList.add("open");

    const all = LORA_LIST || [];
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
        const groups = groupedLoraList(all, flt);
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
                hdr.textContent = grp.label;
                listEl.appendChild(hdr);
            }
            for (const n of grp.items) {
                const it = document.createElement("button");
                it.type = "button";
                it.className = "lb-pop-item" + (n === row.name ? " sel" : "");
                it.dataset.value = n;
                it.textContent = n === "None" ? "— None —" : n;
                it.title = n;
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
            node._lbPos = "end";
            node._lbDelim = ", ";
            node._lbOptsOpen = false;
            node._lbContentH = 150;

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
            title.textContent = "Lora Box";
            const count = document.createElement("span");
            count.className = "lb-count";
            node._lbCount = count;
            const gear = document.createElement("button");
            gear.className = "lb-gear"; gear.textContent = "⚙"; gear.title = "options";
            head.append(title, count, gear);
            inner.appendChild(head);

            // ---- options disclosure (mute / model+clip / trigger merge) ----
            const opts = document.createElement("div");
            opts.className = "lb-opts";
            opts.style.display = "none";
            node._lbOpts = opts;

            const row1 = document.createElement("div");
            row1.className = "lb-opts-row";
            const muteRow = mkSwitchRow(false, "mute all",
                "Skip every LoRA and pass the prompt through untouched (state is preserved)",
                (v) => { node._lbMute = v; applyMute(node); updateActiveCount(node); serialize(node); });
            node._lbMuteCb = muteRow._cb;
            const sepRow = mkSwitchRow(false, "model + clip",
                "Separate model and clip strengths per LoRA",
                (v) => { node._lbSep = v; renderRows(node); sizeNode(node); serialize(node); });
            node._lbSepCb = sepRow._cb;
            row1.append(muteRow, sepRow);

            const row2 = document.createElement("div");
            row2.className = "lb-opts-row";
            row2.title = "Where LoRA trigger words merge into a connected prompt";
            const tlbl = document.createElement("span");
            tlbl.className = "lb-lbl"; tlbl.textContent = "triggers";
            const sel = document.createElement("select");
            [["end", "at end of prompt"], ["beginning", "at start of prompt"]].forEach(([v, t]) => {
                const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o);
            });
            sel.value = node._lbPos || "end";
            sel.onchange = () => { node._lbPos = sel.value; serialize(node); };
            stop(sel); eatWheel(sel);
            node._lbPosSel = sel;
            const dlbl = document.createElement("span");
            dlbl.className = "lb-lbl"; dlbl.textContent = "sep";
            const delim = document.createElement("input");
            delim.className = "lb-delim"; delim.value = node._lbDelim != null ? node._lbDelim : ", ";
            delim.title = "delimiter between prompt and trigger words";
            delim.onchange = () => { node._lbDelim = delim.value; serialize(node); };
            stop(delim); eatWheel(delim);
            node._lbDelimIn = delim;
            row2.append(tlbl, sel, dlbl, delim);

            const hint = document.createElement("div");
            hint.className = "lb-hint";
            hint.innerHTML = "Trigger words are the keywords a LoRA was trained on. If you wire a " +
                "prompt in, they're added at the <b>start</b> (stronger emphasis) or the " +
                "<b>end</b> (a softer modifier). “sep” is what goes between them.";
            opts.append(row1, row2, hint);
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
            add.innerHTML = '<span class="plus">+</span><span>Add LoRA</span>';
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
        nodeType.prototype.onDrawForeground = function () {
            onDrawForeground && onDrawForeground.apply(this, arguments);
            fitRootWidth(this);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () { closePop(); closeThumbPop(); closeToast(); onRemoved && onRemoved.apply(this, arguments); };
    },
});

/* Defer init to a macrotask so widget values restored during deserialize
 * (onConfigure runs after ComfyUI sets the saved `data` value) are in place.
 * Deduped per node so create+configure can't run it twice or race. */
function scheduleInit(node) {
    if (node._lbInitT) clearTimeout(node._lbInitT);
    node._lbInitT = setTimeout(() => { node._lbInitT = 0; initFromData(node); }, 0);
}

/* a styled on/off switch (label > input + track + knob) */
function mkSwitch(checked, title, onChange) {
    const l = document.createElement("label");
    l.className = "lb-switch"; l.title = title || "";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!checked;
    const track = document.createElement("span"); track.className = "track";
    const knob = document.createElement("span"); knob.className = "knob";
    cb.onchange = () => onChange(cb.checked);
    l.append(cb, track, knob);
    stop(l);
    l._cb = cb;
    return l;
}

/* a switch plus a clickable text label, for the options panel */
function mkSwitchRow(checked, label, title, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "lb-swrow"; wrap.title = title || "";
    const sw = mkSwitch(checked, title, onChange);
    const txt = document.createElement("span");
    txt.textContent = label;
    txt.onclick = () => { sw._cb.checked = !sw._cb.checked; sw._cb.onchange(); };
    wrap.append(sw, txt);
    wrap._cb = sw._cb;
    return wrap;
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
    let rows = parsed, mute = false, pos = "end", delim = ", ";
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
    n.className = "lb-num"; n.type = "number";
    n.min = String(SMIN); n.max = String(SMAX); n.step = "0.05"; n.value = round2(val); n.title = title;
    tintNum(n, val);
    n.onchange = () => { const v = clampS(parseFloat(n.value)); n.value = round2(v); tintNum(n, v); onChange(v); };
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
        e.innerHTML = '<span>No LoRAs yet</span><span class="lb-empty-t">press “+ Add LoRA” below</span>';
        list.appendChild(e);
        updateActiveCount(node);
        return;
    }

    node._lbRows.forEach((row, i) => {
        const card = document.createElement("div");
        card.className = "lb-card" + (rowOff(node, row) ? " lb-off" : "");

        const l1 = document.createElement("div");
        l1.className = "lb-l1";

        const handle = document.createElement("div");
        handle.className = "lb-drag"; handle.textContent = "⠿"; handle.title = "drag to reorder";
        attachReorder(node, card, handle, i);

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
        trig.className = "lb-ico" + (row._open ? " on" : ""); trig.textContent = "ⓘ"; trig.title = "trigger words";
        trig.onclick = (e) => { e.stopPropagation(); row._open = !row._open; renderRows(node); sizeNode(node); };
        stop(trig);

        const del = document.createElement("button");
        del.className = "lb-ico lb-del"; del.textContent = "✕"; del.title = "remove this LoRA";
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

        l1.append(handle, sw, field, trig, del);

        const l2 = document.createElement("div");
        l2.className = "lb-l2";

        const slider = document.createElement("input");
        slider.className = "lb-slider"; slider.type = "range";
        slider.min = String(SMIN); slider.max = String(SMAX); slider.step = "0.05"; slider.value = String(row.sm); slider.title = "strength";
        const num = mkNum(row.sm, node._lbSep ? "model strength" : "strength",
            (v) => { row.sm = v; slider.value = String(v); serialize(node); });
        slider.oninput = () => { row.sm = clampS(parseFloat(slider.value)); num.value = round2(row.sm); tintNum(num, row.sm); serialize(node); };
        stop(slider); eatWheel(slider);

        l2.append(slider, num);
        if (node._lbSep) {
            const tag = document.createElement("span"); tag.className = "lb-clip"; tag.textContent = "clip";
            const cnum = mkNum(row.sc != null ? row.sc : row.sm, "clip strength", (v) => { row.sc = v; serialize(node); });
            l2.append(tag, cnum);
        }

        const content = document.createElement("div");
        content.className = "lb-content";
        content.append(l1, l2);

        const main = document.createElement("div");
        main.className = "lb-main";
        main.append(buildThumb(node, row), content);

        card.append(main);
        if (row._open) card.append(buildTrigEditor(node, row));

        list.appendChild(card);
    });

    markDuplicates(node);
    updateActiveCount(node);
}

/* per-row thumbnail: the lora's reference picture (shared across workflows).
 * Auto-loads the lora's own preview when one exists. When empty, two labelled
 * buttons make it obvious: ✨ Generate (a quick Z-Image render) or ＋ Add (your
 * own image, click or drag&drop). With an image, hover shows corner chips to
 * regenerate / replace / remove, and hovering enlarges it. */
function buildThumb(node, row) {
    const thumb = document.createElement("div");
    thumb.className = "lb-thumb";
    const img = document.createElement("img");

    // empty-state buttons (visible when there is no image)
    const acts = document.createElement("div");
    acts.className = "lb-thumb-acts";
    const genBtn = document.createElement("div");
    genBtn.className = "lb-thumb-btn";
    genBtn.innerHTML = '<span class="i">✨</span><span>gen</span>';
    genBtn.title = "Generate a preview now — a quick Z-Image test render of this LoRA";
    const addBtn = document.createElement("div");
    addBtn.className = "lb-thumb-btn";
    addBtn.innerHTML = '<span class="i">＋</span><span>add</span>';
    addBtn.title = "Use your own image — click to pick, or drag & drop one here";
    acts.append(genBtn, addBtn);

    // image-state corner chips (shown on hover)
    const chipGen = document.createElement("div");
    chipGen.className = "lb-thumb-chip gen"; chipGen.textContent = "✨"; chipGen.title = "Regenerate preview";
    const chipRep = document.createElement("div");
    chipRep.className = "lb-thumb-chip rep"; chipRep.textContent = "＋"; chipRep.title = "Replace with your own image";
    const chipX = document.createElement("div");
    chipX.className = "lb-thumb-chip x"; chipX.textContent = "✕"; chipX.title = "Remove picture";

    thumb.append(img, acts, chipGen, chipRep, chipX);

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
    const doGen = async (btn, busyHTML) => {
        if (btn.classList.contains("busy")) return;
        const html = btn.innerHTML;
        btn.classList.add("busy"); btn.innerHTML = busyHTML;
        const res = await generatePreview(row.name, "character");
        btn.classList.remove("busy"); btn.innerHTML = html;
        if (res && res.ok) { evictPreview(row.name); refresh(); }
        else alert("Preview generation failed: " + ((res && res.error) || "unknown error"));
    };

    genBtn.onclick = (e) => { e.stopPropagation(); if (needLora()) return; doGen(genBtn, '<span class="i">⏳</span><span>…</span>'); };
    addBtn.onclick = (e) => { e.stopPropagation(); if (needLora()) return; pickFile(); };
    chipGen.onclick = (e) => { e.stopPropagation(); if (needLora()) return; doGen(chipGen, "⏳"); };
    chipRep.onclick = (e) => { e.stopPropagation(); if (needLora()) return; pickFile(); };
    chipX.onclick = async (e) => {
        e.stopPropagation();
        if (!row.name || row.name === "None") return;
        closeThumbPop();
        await deletePreview(row.name);
        evictPreview(row.name);
        refresh();
    };

    // drag & drop an image straight onto the thumbnail
    thumb.addEventListener("dragover", (e) => {
        if (!row.name || row.name === "None") return;
        e.preventDefault(); e.stopPropagation();
        thumb.classList.add("drag-over");
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    thumb.addEventListener("dragleave", () => thumb.classList.remove("drag-over"));
    thumb.addEventListener("drop", (e) => {
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
    const ta = document.createElement("textarea");
    ta.className = "lb-trig-in";
    ta.rows = 1;
    ta.placeholder = "trigger words (comma separated)…";
    const reset = document.createElement("button");
    reset.className = "lb-ico"; reset.textContent = "↺"; reset.title = "reset to auto-detected";

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
    wrap.append(ta, reset);
    return wrap;
}

/* deterministic height; open trigger editors and the options panel contribute */
function sizeNode(node) {
    const rows = node._lbRows;
    let listH;
    if (rows.length === 0) listH = EMPTY_H;
    else listH = rows.reduce((a, r) => a + CARD_BASE + (r._open ? TRIG_GAP + (r._trigH || TRIG_MIN) : 0), 0) + (rows.length - 1) * GAP;
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
