import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/*
 * Afloy Lora Box UI — DOM-widget panel.
 *  - Height computed deterministically (no live measurement) except the trigger
 *    editor, whose textarea auto-grows; its measured height feeds back into the
 *    deterministic total so the card expands downward to show all words.
 *  - All pointer/wheel events are swallowed at the container so dragging a
 *    slider never leaks to the canvas (which used to "break" the container).
 *  - Strength range 0..2. Trigger words auto-detected + fully editable.
 */

const GAP = 8, MIN_W = 240, FIXED_W = 380;
const ROOT_PAD = 16, INNER_GAP = 16, HEAD_H = 20, HEAD2_H = 28, CARD_BASE = 76, ADD_H = 36, BUFFER = 8;
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

// Resolve a lora's sidecar preview as an object URL, or null if none.
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

function injectStyle() {
    const old = document.getElementById("lorabox-style");
    if (old) old.remove();
    const s = document.createElement("style");
    s.id = "lorabox-style";
    s.textContent = `
.lorabox-root{width:100%; height:100%; overflow:hidden; box-sizing:border-box;}
.lorabox{width:100%; display:flex; flex-direction:column;
  font-family:inherit; font-size:12px; color:var(--input-text,#ddd);
  padding:6px 10px 10px; gap:8px; box-sizing:border-box;}
.lorabox *{box-sizing:border-box;}
.lorabox .lb-head{display:flex; align-items:center; gap:18px; min-height:16px;
  color:var(--descrip-text,#9a9a9a); font-size:11px;}
.lorabox .lb-head label{display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;}
.lorabox .lb-head input{accent-color:var(--p-button-primary-background,#3b82f6); cursor:pointer; margin:0;}
.lorabox .lb-head2{display:flex; align-items:center; gap:8px; min-height:24px;
  color:var(--descrip-text,#9a9a9a); font-size:11px;}
.lorabox .lb-head2 .lb-h2lbl{opacity:.85; user-select:none;}
.lorabox .lb-head2 select{flex:1 1 auto; min-width:0; height:24px; padding:0 6px; cursor:pointer;
  background:var(--comfy-menu-bg,#2a2a2a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#4a4a4a); border-radius:6px; font-size:11px; outline:none;}
.lorabox .lb-head2 select:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-head2 input.lb-delim{width:48px; height:24px; text-align:center;
  background:var(--comfy-menu-bg,#2a2a2a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#4a4a4a); border-radius:6px; font-size:11px; outline:none;}
.lorabox .lb-head2 input.lb-delim:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-list{display:flex; flex-direction:column; gap:${GAP}px;}
.lorabox .lb-card{position:relative; display:flex; flex-direction:column; gap:6px; min-width:0;
  padding:8px 9px 8px 13px; border-radius:10px;
  background:linear-gradient(180deg, var(--comfy-input-bg,#1e1e1e),
    color-mix(in srgb, var(--comfy-input-bg,#1e1e1e) 84%, #000));
  border:1px solid var(--border-color,#3a3a3a);
  transition:opacity .14s, border-color .14s, box-shadow .14s;}
/* left accent stripe = "this lora is active"; non-color cue is its presence */
.lorabox .lb-card::before{content:""; position:absolute; left:0; top:8px; bottom:8px; width:3px;
  border-radius:0 3px 3px 0; background:var(--p-button-primary-background,#3b82f6);
  opacity:.9; transition:opacity .14s, background .14s;}
.lorabox .lb-card.lb-off::before{opacity:0;}
.lorabox .lb-card:hover{border-color:var(--p-button-primary-background,#5a7fd0);
  box-shadow:0 3px 12px rgba(0,0,0,.28);}
.lorabox .lb-card.lb-off{opacity:.5;}
.lorabox .lb-card.lb-dup{border-color:#b9802f;}
.lorabox .lb-card.lb-dup::before{background:#d8932f; opacity:1;}
.lorabox .lb-card.lb-dup .lb-name{border-color:#b9802f;}
/* explicit text badge so the duplicate state isn't conveyed by colour alone */
.lorabox .lb-card.lb-dup::after{content:"duplicate"; position:absolute; top:-7px; right:9px;
  font-size:8px; line-height:1.4; letter-spacing:.05em; text-transform:uppercase; font-weight:700;
  color:#241a0c; background:#d8932f; padding:1px 6px; border-radius:5px; pointer-events:none;}
.lorabox .lb-main{display:flex; gap:9px; align-items:stretch; min-width:0;}
.lorabox .lb-content{flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:6px;}
.lorabox .lb-thumb{flex:0 0 auto; width:54px; height:54px; align-self:center; position:relative;
  border-radius:8px; overflow:hidden; cursor:pointer; display:flex; align-items:center; justify-content:center;
  background:var(--comfy-menu-bg,#2a2a2a); border:1px solid var(--border-color,#4a4a4a);
  transition:border-color .12s;}
.lorabox .lb-thumb:hover{border-color:var(--p-button-primary-background,#5a7fd0);}
.lorabox .lb-thumb img{width:100%; height:100%; object-fit:cover; display:none;}
.lorabox .lb-thumb.has-img img{display:block;}
.lorabox .lb-thumb .lb-ph{display:flex; flex-direction:column; align-items:center; gap:2px;
  color:var(--descrip-text,#888); font-size:16px; line-height:1; pointer-events:none;}
.lorabox .lb-thumb .lb-ph .lb-ph-t{font-size:8px; letter-spacing:.02em; opacity:.85;}
.lorabox .lb-thumb.has-img .lb-ph{display:none;}
.lorabox .lb-thumb .lb-thumb-x{position:absolute; top:2px; right:2px; width:16px; height:16px;
  display:none; align-items:center; justify-content:center; font-size:10px; border-radius:4px;
  background:rgba(0,0,0,.62); color:#fff; line-height:1;}
.lorabox .lb-thumb.has-img:hover .lb-thumb-x{display:flex;}
.lorabox .lb-thumb .lb-thumb-x:hover{background:#7a2b2b;}
.lorabox .lb-l1{display:grid; grid-template-columns:14px 18px 1fr 26px 26px; gap:6px; align-items:center; min-width:0;}
.lorabox .lb-drag{width:14px; height:26px; display:flex; align-items:center; justify-content:center;
  cursor:grab; color:var(--descrip-text,#777); font-size:12px; line-height:1; user-select:none; flex:0 0 auto;}
.lorabox .lb-drag:hover{color:var(--input-text,#ccc);}
.lorabox .lb-drag:active{cursor:grabbing;}
.lorabox .lb-card.lb-dragging{opacity:.5;}
.lorabox .lb-card.lb-drop-before{box-shadow:inset 0 2px 0 0 var(--p-button-primary-background,#5a7fd0);}
.lorabox .lb-card.lb-drop-after{box-shadow:inset 0 -2px 0 0 var(--p-button-primary-background,#5a7fd0);}
.lorabox .lb-l2{display:grid; grid-template-columns:1fr 56px; gap:8px; align-items:center; min-width:0;}
.lorabox .lb-l2.sep{grid-template-columns:minmax(40px,1fr) 54px 26px 54px;}
.lorabox .lb-en{width:18px; height:18px; margin:0; cursor:pointer; justify-self:center;
  accent-color:var(--p-button-primary-background,#3b82f6);}
.lorabox .lb-name{display:flex; align-items:center; gap:6px; width:100%; min-width:0; height:26px;
  padding:0 8px; cursor:pointer; user-select:none;
  background:var(--comfy-menu-bg,#2a2a2a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#4a4a4a); border-radius:6px;}
.lorabox .lb-name:hover{border-color:var(--p-button-primary-background,#5a7fd0);}
.lorabox .lb-name.open{border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-name .txt{flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px;}
.lorabox .lb-name .txt.none{color:var(--descrip-text,#888);}
.lorabox .lb-name .car{flex:0 0 auto; color:var(--descrip-text,#888); font-size:10px;}
.lorabox .lb-slider{width:100%; min-width:0; height:18px; cursor:pointer;
  accent-color:var(--p-button-primary-background,#3b82f6);}
.lorabox .lb-num{width:100%; min-width:0; height:26px; padding:0 6px; text-align:center;
  background:var(--comfy-menu-bg,#2a2a2a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#4a4a4a); border-radius:6px; font-size:11px;
  -moz-appearance:textfield; appearance:textfield;}
.lorabox .lb-num::-webkit-outer-spin-button,
.lorabox .lb-num::-webkit-inner-spin-button{-webkit-appearance:none; margin:0;}
.lorabox .lb-num:focus{outline:none; border-color:var(--p-button-primary-background,#6a8fe0);}
/* at-a-glance read of the weight: warm for negative ("anti-LoRA"), dim for 0 */
.lorabox .lb-num.neg{color:#e8855a; border-color:#7a4a36;}
.lorabox .lb-num.zero{color:var(--descrip-text,#888);}
.lorabox .lb-tag{font-size:9px; color:var(--descrip-text,#888); text-align:center; justify-self:center; overflow:hidden; white-space:nowrap;}
.lorabox .lb-ico{width:26px; height:26px; padding:0; cursor:pointer; display:flex;
  align-items:center; justify-content:center; background:transparent;
  color:var(--descrip-text,#9a9a9a); border:none; border-radius:6px; font-size:14px; line-height:1; flex:0 0 auto;}
.lorabox .lb-ico:hover{background:var(--comfy-menu-bg,#3a3a3a); color:var(--input-text,#fff);}
.lorabox .lb-ico.on{color:var(--p-button-primary-background,#7aa2f0);}
.lorabox .lb-del:hover{background:#5b2b2b; color:#fff;}
.lorabox .lb-trig{display:flex; align-items:flex-start; gap:6px; min-width:0;}
.lorabox .lb-trig-in{flex:1 1 auto; min-width:0; min-height:${TRIG_MIN}px; padding:5px 8px;
  background:var(--comfy-menu-bg,#202a2e); color:var(--input-text,#dfeef0); resize:none; overflow:hidden;
  border:1px solid var(--border-color,#3a4a52); border-radius:6px; font-size:11px; line-height:1.4;
  outline:none; font-family:inherit;}
.lorabox .lb-trig-in:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-trig-in::placeholder{color:var(--descrip-text,#778);}
.lorabox .lb-add{height:30px; width:100%; margin-top:4px; display:flex; align-items:center;
  justify-content:center; gap:7px;
  background:color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 26%, transparent);
  color:var(--input-text,#eaf2ff);
  border:1px solid color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 55%, transparent);
  border-radius:9px; cursor:pointer; font-size:12px; font-weight:600; letter-spacing:.03em;
  backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px);
  transition:background .14s, border-color .14s, transform .06s;}
.lorabox .lb-add:hover{background:color-mix(in srgb, var(--p-button-primary-background,#3b82f6) 42%, transparent);
  border-color:var(--p-button-primary-background,#3b82f6);}
.lorabox .lb-add:active{transform:translateY(1px);}
.lorabox .lb-add .plus{font-size:15px; font-weight:700; line-height:1; opacity:.9;}
.lorabox .lb-empty{display:flex; align-items:center; justify-content:center; min-height:40px;
  color:var(--descrip-text,#888); font-style:italic; font-size:11px; opacity:.8;}

.lb-pop{position:fixed; z-index:10010; display:flex; flex-direction:column; gap:6px;
  padding:6px; max-height:min(380px, calc(100vh - 24px)); overflow:hidden;
  border-radius:8px;
  background:var(--comfy-menu-bg,#222); border:1px solid var(--border-color,#555);
  box-shadow:0 10px 30px rgba(0,0,0,.55); font-family:sans-serif; font-size:12px;
  line-height:1.4; box-sizing:border-box;}
.lb-pop-search{flex:0 0 auto; height:28px; padding:0 9px; font-size:12px; border-radius:6px; outline:none;
  background:var(--comfy-input-bg,#1a1a1a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#555); box-sizing:border-box;}
.lb-pop-search:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lb-pop-list{flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:auto;
  overscroll-behavior:contain; -webkit-overflow-scrolling:touch;}
.lb-pop-group{position:sticky; top:0; z-index:2; padding:5px 9px 3px; margin:0;
  font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
  color:var(--descrip-text,#888); background:var(--comfy-menu-bg,#222);
  border-bottom:1px solid var(--border-color,#444); pointer-events:none; line-height:1.2;}
.lb-pop-item{display:block; width:100%; margin:0 0 2px; padding:6px 9px; border-radius:5px;
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
 * drag a slider on a touchscreen / precision touchpad (the long-standing
 * "press slider → everything gets bigger" bug). litegraph binds its touch
 * listeners in the CAPTURE phase on an ANCESTOR of the DOM-widget layer
 * (canvasEl.parentElement), so a bubble-phase stop on our own element is too
 * late. A capture-phase listener on `document` runs first and stops the event
 * before litegraph sees it; we only stopPropagation (never preventDefault), so
 * the browser still performs the control's native touch action (slider drag,
 * list scroll). Installed once, globally. */
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

            const head = document.createElement("div");
            head.className = "lb-head";
            node._lbMuteCb = mkCheck(head, "mute all", (v) => { node._lbMute = v; applyMute(node); serialize(node); });
            node._lbSepCb = mkCheck(head, "model + clip", (v) => { node._lbSep = v; renderRows(node); sizeNode(node); serialize(node); });
            inner.appendChild(head);

            // Second header line: where to inject the LoRA trigger words into a
            // connected prompt, and the separator used. Stored in `data` (pos /
            // delim) so it round-trips with the workflow like everything else.
            const head2 = document.createElement("div");
            head2.className = "lb-head2";
            head2.title = "How LoRA trigger words merge into a connected prompt";
            const h2lbl = document.createElement("span");
            h2lbl.className = "lb-h2lbl"; h2lbl.textContent = "triggers:";
            const sel = document.createElement("select");
            [["end", "at end of prompt"], ["beginning", "at start of prompt"]].forEach(([v, t]) => {
                const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o);
            });
            sel.value = node._lbPos || "end";
            sel.onchange = () => { node._lbPos = sel.value; serialize(node); };
            stop(sel); eatWheel(sel);
            node._lbPosSel = sel;
            const dlbl = document.createElement("span");
            dlbl.className = "lb-h2lbl"; dlbl.textContent = "sep";
            const delim = document.createElement("input");
            delim.className = "lb-delim"; delim.value = node._lbDelim != null ? node._lbDelim : ", ";
            delim.title = "delimiter between prompt and trigger words";
            delim.onchange = () => { node._lbDelim = delim.value; serialize(node); };
            stop(delim); eatWheel(delim);
            node._lbDelimIn = delim;
            head2.append(h2lbl, sel, dlbl, delim);
            inner.appendChild(head2);

            const list = document.createElement("div");
            list.className = "lb-list";
            node._lbList = list;
            inner.appendChild(list);

            const add = document.createElement("button");
            add.className = "lb-add";
            add.innerHTML = '<span class="plus">+</span><span>Add Lora</span>';
            add.onclick = (e) => {
                e.stopPropagation();
                node._lbRows.push({ on: true, name: "None", sm: 1.0, sc: 1.0 });
                renderRows(node); sizeNode(node); serialize(node);
            };
            stop(add);
            inner.appendChild(add);

            // Use the SAME mechanism core resizable DOM widgets (Note / markdown
            // / multiline string) use: do NOT override computeLayoutSize. Instead
            // feed our deterministic content height through the supported
            // getMinHeight/getMaxHeight options. The default DOMWidgetImpl then
            // (a) leaves node WIDTH unconstrained → the node resizes freely both
            // ways and the panel fills the width, and (b) never collapses the
            // node when a value changes.
            const hgt = () => (typeof node._lbContentH === "number" && node._lbContentH > 0) ? node._lbContentH : 150;
            const widget = node.addDOMWidget("lorabox_ui", "div", root, {
                serialize: false, hideOnZoom: false,
                getMinHeight: hgt, getMaxHeight: hgt,
            });
            node._lbWidget = widget;

            // Pleasant default width for a freshly-created node. Loaded nodes get
            // their saved width restored by onConfigure afterwards.
            if (!node.size || node.size[0] < MIN_W) node.setSize([FIXED_W, (node.size && node.size[1]) || 200]);

            getLoraList();
            scheduleInit(node);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure && onConfigure.apply(this, arguments);
            scheduleInit(this);
        };

        // The node is freely resizable both ways (like the core Note node). We
        // only stop it from getting so narrow the cards get crushed; otherwise
        // we never touch the width, so neither resizing nor value changes can
        // make it "slip" or collapse.
        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            if (size && size[0] < MIN_W) size[0] = MIN_W;
            onResize && onResize.apply(this, arguments);
            fitRootWidth(this);
        };

        // The DOM panel's element width is not re-stretched by the framework on
        // a width change, so we keep it matched to the node every drawn frame
        // (cheap; only assigns when the value actually changes).
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            onDrawForeground && onDrawForeground.apply(this, arguments);
            fitRootWidth(this);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () { closePop(); closeThumbPop(); onRemoved && onRemoved.apply(this, arguments); };
    },
});

/* Defer init to a macrotask so widget values restored during deserialize
 * (onConfigure runs after ComfyUI sets the saved `data` value) are in place.
 * Deduped per node so create+configure can't run it twice or race — replaces
 * the old fixed 30ms timeout. */
function scheduleInit(node) {
    if (node._lbInitT) clearTimeout(node._lbInitT);
    node._lbInitT = setTimeout(() => { node._lbInitT = 0; initFromData(node); }, 0);
}

function mkCheck(parent, label, onChange) {
    const l = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.onchange = () => onChange(cb.checked);
    stop(cb);
    l.appendChild(cb);
    l.appendChild(document.createTextNode(label));
    parent.appendChild(l);
    return cb;
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
 * Uses the browser's drag-and-drop, not pointermove, so it doesn't violate
 * §6: we never intercept pointermove (which froze DOM repositioning) and the
 * node itself can't be dragged because pointerdown is already stopped at the
 * container. Only the small grip handle starts a drag. */
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
        if (LB_DRAG_FROM === null) return;
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
 * other (the old code rendered empty + serialized "[]" during a load race). */
function initFromData(node) {
    const dataW = node._lbDataW || (node.widgets || []).find((w) => w.name === "data");
    node._lbDataW = dataW;
    // Accept both the legacy bare-list shape and the current
    // {v, mute, rows} object (see serialize / the Python apply()).
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
    // Restore the saved "mute all" state so a workflow saved while muted reopens
    // muted *and* shows the checkbox ticked (was always reset to false, which
    // left LoRAs silently un-applied with an empty checkbox — nothing to undo).
    if (node._lbMuteCb) node._lbMuteCb.checked = node._lbMute;
    if (node._lbPosSel) node._lbPosSel.value = node._lbPos;
    if (node._lbDelimIn) node._lbDelimIn.value = node._lbDelim;
    renderRows(node); sizeNode(node); serialize(node);
}

function serialize(node) {
    if (!node._lbDataW) return;
    // Persist each row's REAL on/off state plus a separate `mute` flag, so
    // muting-all and then saving the workflow no longer wipes per-row states
    // (the backend skips everything when mute is true).
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
        e.textContent = "no loras yet — press “+ Add Lora”";
        list.appendChild(e);
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

        const en = document.createElement("input");
        en.type = "checkbox"; en.className = "lb-en"; en.checked = !!row.on; en.title = "enable / disable";
        en.onchange = () => { row.on = en.checked; card.classList.toggle("lb-off", rowOff(node, row)); serialize(node); };
        stop(en);

        const field = document.createElement("div");
        field.className = "lb-name"; field.title = row.name || "None"; field.tabIndex = 0;
        const txt = document.createElement("span");
        txt.className = "txt" + (!row.name || row.name === "None" ? " none" : "");
        txt.textContent = row.name && row.name !== "None" ? row.name : "None";
        const car = document.createElement("span"); car.className = "car"; car.textContent = "▼";
        field.append(txt, car);
        field.onclick = (e) => {
            e.stopPropagation();
            openPicker(node, row, field);
        };
        stop(field);

        const trig = document.createElement("button");
        trig.className = "lb-ico" + (row._open ? " on" : ""); trig.textContent = "ⓘ"; trig.title = "trigger words";
        trig.onclick = (e) => { e.stopPropagation(); row._open = !row._open; renderRows(node); sizeNode(node); };
        stop(trig);

        const del = document.createElement("button");
        del.className = "lb-ico lb-del"; del.textContent = "✕"; del.title = "remove lora";
        del.onclick = (e) => { e.stopPropagation(); node._lbRows.splice(i, 1); renderRows(node); sizeNode(node); serialize(node); };
        stop(del);

        l1.append(handle, en, field, trig, del);

        const l2 = document.createElement("div");
        l2.className = "lb-l2" + (node._lbSep ? " sep" : "");

        const slider = document.createElement("input");
        slider.className = "lb-slider"; slider.type = "range";
        slider.min = String(SMIN); slider.max = String(SMAX); slider.step = "0.05"; slider.value = String(row.sm); slider.title = "strength";
        const num = mkNum(row.sm, node._lbSep ? "model strength" : "strength",
            (v) => { row.sm = v; slider.value = String(v); serialize(node); });
        slider.oninput = () => { row.sm = clampS(parseFloat(slider.value)); num.value = round2(row.sm); tintNum(num, row.sm); serialize(node); };
        stop(slider); eatWheel(slider);

        l2.append(slider, num);
        if (node._lbSep) {
            const tag = document.createElement("span"); tag.className = "lb-tag"; tag.textContent = "clip";
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
}

/* per-row thumbnail: shows the lora's sidecar image (shared across workflows),
 * click to set/change, hover to enlarge, ✕ to remove. */
function buildThumb(node, row) {
    const thumb = document.createElement("div");
    thumb.className = "lb-thumb";
    thumb.title = "click to set a picture for this lora";
    const img = document.createElement("img");
    const ph = document.createElement("div");
    ph.className = "lb-ph";
    ph.innerHTML = '<span>🖼</span><span class="lb-ph-t">add</span>';
    const x = document.createElement("div");
    x.className = "lb-thumb-x"; x.textContent = "✕"; x.title = "remove picture";
    thumb.append(img, ph, x);

    const setURL = (url) => {
        // URLs are owned by PREVIEW_CACHE (shared across renders) — do NOT revoke
        // here or a sibling card showing the same lora would lose its image.
        thumb._url = url || null;
        if (url) { if (img.src !== url) img.src = url; thumb.classList.add("has-img"); }
        else { img.removeAttribute("src"); thumb.classList.remove("has-img"); }
    };
    const refresh = () => {
        if (!row.name || row.name === "None") { setURL(null); return; }
        // synchronous when cached → the image is there on the first frame, so a
        // re-render (e.g. drag-reorder) never flashes empty.
        if (PREVIEW_CACHE.has(row.name)) { setURL(PREVIEW_CACHE.get(row.name)); return; }
        loadPreviewURL(row.name).then((u) => {
            if (document.body.contains(thumb) && row.name && row.name !== "None") setURL(u);
        });
    };
    thumb._lbRefresh = refresh;
    refresh();

    thumb.onclick = (e) => {
        e.stopPropagation();
        if (!row.name || row.name === "None") { return; }   // pick a lora first
        const inp = document.createElement("input");
        inp.type = "file"; inp.accept = "image/*";
        inp.onchange = async () => {
            const f = inp.files && inp.files[0];
            if (!f) return;
            if (f.size > 8 * 1024 * 1024) { alert("Image too large (max 8 MB)."); return; }
            const ok = await uploadPreview(row.name, f);
            if (ok) { evictPreview(row.name); refresh(); }
        };
        inp.click();
    };
    x.onclick = async (e) => {
        e.stopPropagation();
        if (!row.name || row.name === "None") return;
        closeThumbPop();
        await deletePreview(row.name);
        evictPreview(row.name);
        refresh();
    };
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

/* deterministic height; open trigger editors contribute their grown height */
function sizeNode(node) {
    const rows = node._lbRows;
    let listH;
    if (rows.length === 0) listH = 40;
    else listH = rows.reduce((a, r) => a + CARD_BASE + (r._open ? TRIG_GAP + (r._trigH || TRIG_MIN) : 0), 0) + (rows.length - 1) * GAP;
    node._lbContentH = ROOT_PAD + INNER_GAP + HEAD_H + HEAD2_H + listH + ADD_H + BUFFER;
    // Only the HEIGHT is ours to manage; width is whatever the user set. We
    // preserve the current width and let computeSize derive the new height from
    // our getMinHeight/getMaxHeight. This never changes width, so value changes
    // (slider/checkbox) can't collapse the node, and the user can still resize.
    const curW = (node.size && node.size[0]) || FIXED_W;
    node.setSize([curW, node.computeSize()[1]]);
    fitRootWidth(node);
    node.setDirtyCanvas(true, true);
}
