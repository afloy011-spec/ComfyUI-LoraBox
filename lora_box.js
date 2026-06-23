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
const ROOT_PAD = 16, INNER_GAP = 16, HEAD_H = 20, CARD_BASE = 76, ADD_H = 36, BUFFER = 8;
const TRIG_GAP = 8, TRIG_MIN = 28;
const SMIN = 0, SMAX = 2;
const clampS = (v) => Math.max(SMIN, Math.min(SMAX, isNaN(v) ? 1 : v));

let LORA_LIST = null;
let LORA_LIST_PROMISE = null;

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
.lorabox .lb-list{display:flex; flex-direction:column; gap:${GAP}px;}
.lorabox .lb-card{display:flex; flex-direction:column; gap:6px; min-width:0;
  padding:8px 9px; border-radius:9px;
  background:var(--comfy-input-bg,#1e1e1e); border:1px solid var(--border-color,#3a3a3a);
  transition:opacity .12s,border-color .12s;}
.lorabox .lb-card:hover{border-color:var(--p-button-primary-background,#5a7fd0);}
.lorabox .lb-card.lb-off{opacity:.42;}
.lorabox .lb-card.lb-dup{border-color:#b9802f;}
.lorabox .lb-card.lb-dup .lb-name{border-color:#b9802f;}
.lorabox .lb-l1{display:grid; grid-template-columns:14px 18px 1fr 26px 26px 26px; gap:6px; align-items:center; min-width:0;}
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
  padding:6px; max-height:300px; border-radius:8px;
  background:var(--comfy-menu-bg,#222); border:1px solid var(--border-color,#555);
  box-shadow:0 10px 30px rgba(0,0,0,.55); font-family:sans-serif;}
.lb-pop-search{height:28px; padding:0 9px; font-size:12px; border-radius:6px; outline:none;
  background:var(--comfy-input-bg,#1a1a1a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#555);}
.lb-pop-search:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lb-pop-list{overflow:auto; display:flex; flex-direction:column; gap:2px; min-height:0;}
.lb-pop-item{padding:6px 9px; border-radius:5px; cursor:pointer; font-size:12px;
  color:var(--input-text,#ddd); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
.lb-pop-item:hover,.lb-pop-item.hi{background:var(--p-button-primary-background,#3b82f6); color:#fff;}
.lb-pop-item.sel{outline:1px solid var(--border-color,#666);}
.lb-pop-empty{padding:8px; color:var(--descrip-text,#888); font-size:11px; font-style:italic;}
`;
    document.head.appendChild(s);
}

const round2 = (v) => (Math.round(v * 100) / 100).toString();

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
    await getLoraList();
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

    const all = ["None", ...(LORA_LIST || [])];
    let hi = 0;
    const setHi = (items) => { items.forEach((x) => x.classList.remove("hi")); if (items[hi]) { items[hi].classList.add("hi"); items[hi].scrollIntoView({ block: "nearest" }); } };
    const draw = (flt) => {
        const f = flt.trim().toLowerCase();
        const items = all.filter((n) => n.toLowerCase().includes(f));
        listEl.innerHTML = "";
        hi = 0;
        if (!items.length) {
            const e = document.createElement("div"); e.className = "lb-pop-empty"; e.textContent = "no matches";
            listEl.appendChild(e); return;
        }
        items.forEach((n) => {
            const it = document.createElement("div");
            it.className = "lb-pop-item" + (n === row.name ? " sel" : "");
            it.dataset.value = n;
            it.textContent = n === "None" ? "— None —" : n;
            it.onmousedown = (e) => { e.preventDefault(); pick(n); };
            listEl.appendChild(it);
        });
        const first = listEl.children[0]; if (first) first.classList.add("hi");
    };
    const pick = (n) => {
        row.name = n;
        const txt = fieldEl.querySelector(".txt");
        txt.textContent = n === "None" ? "None" : n;
        txt.classList.toggle("none", n === "None");
        fieldEl.title = n;
        serialize(node);
        markDuplicates(node);
        closePop();
    };
    search.oninput = () => draw(search.value);
    search.onkeydown = (e) => {
        const items = [...listEl.querySelectorAll(".lb-pop-item")];
        if (e.key === "Escape") closePop();
        else if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hi + 1, items.length - 1); setHi(items); }
        else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(hi - 1, 0); setHi(items); }
        else if (e.key === "Enter") { e.preventDefault(); if (items[hi]) pick(items[hi].dataset.value); }
    };
    stop(search); stop(pop); eatWheel(pop);
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
            setTimeout(() => initFromData(node), 30);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure && onConfigure.apply(this, arguments);
            const node = this;
            setTimeout(() => initFromData(node), 30);
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
        nodeType.prototype.onRemoved = function () { closePop(); onRemoved && onRemoved.apply(this, arguments); };
    },
});

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

/* ---- random lora --------------------------------------------------------- */
function pickRandomLora(node, row) {
    const apply = () => {
        const l = LORA_LIST || [];
        if (!l.length) return;
        row.name = l[Math.floor(Math.random() * l.length)];
        delete row.trig;            // let auto-detect re-run for the new lora
        renderRows(node); sizeNode(node); serialize(node);
    };
    if (LORA_LIST && LORA_LIST.length) apply();
    else getLoraList().then(apply);
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
    let rows = parsed, mute = false;
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
        mute = !!parsed.mute;
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
    if (node._lbSepCb) node._lbSepCb.checked = node._lbSep;
    if (node._lbMuteCb) node._lbMuteCb.checked = false;
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
    node._lbDataW.value = JSON.stringify({ v: 1, mute: !!node._lbMute, rows });
}

function mkNum(val, title, onChange) {
    const n = document.createElement("input");
    n.className = "lb-num"; n.type = "number";
    n.min = String(SMIN); n.max = String(SMAX); n.step = "0.05"; n.value = round2(val); n.title = title;
    n.onchange = () => { const v = clampS(parseFloat(n.value)); n.value = round2(v); onChange(v); };
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
        field.onclick = (e) => { e.stopPropagation(); openPicker(node, row, field); };
        stop(field);

        const rnd = document.createElement("button");
        rnd.className = "lb-ico"; rnd.textContent = "🎲"; rnd.title = "pick a random lora";
        rnd.onclick = (e) => { e.stopPropagation(); pickRandomLora(node, row); };
        stop(rnd);

        const trig = document.createElement("button");
        trig.className = "lb-ico" + (row._open ? " on" : ""); trig.textContent = "ⓘ"; trig.title = "trigger words";
        trig.onclick = (e) => { e.stopPropagation(); row._open = !row._open; renderRows(node); sizeNode(node); };
        stop(trig);

        const del = document.createElement("button");
        del.className = "lb-ico lb-del"; del.textContent = "✕"; del.title = "remove lora";
        del.onclick = (e) => { e.stopPropagation(); node._lbRows.splice(i, 1); renderRows(node); sizeNode(node); serialize(node); };
        stop(del);

        l1.append(handle, en, field, rnd, trig, del);

        const l2 = document.createElement("div");
        l2.className = "lb-l2" + (node._lbSep ? " sep" : "");

        const slider = document.createElement("input");
        slider.className = "lb-slider"; slider.type = "range";
        slider.min = String(SMIN); slider.max = String(SMAX); slider.step = "0.05"; slider.value = String(row.sm); slider.title = "strength";
        const num = mkNum(row.sm, node._lbSep ? "model strength" : "strength",
            (v) => { row.sm = v; slider.value = String(v); serialize(node); });
        slider.oninput = () => { row.sm = clampS(parseFloat(slider.value)); num.value = round2(row.sm); serialize(node); };
        stop(slider); eatWheel(slider);

        l2.append(slider, num);
        if (node._lbSep) {
            const tag = document.createElement("span"); tag.className = "lb-tag"; tag.textContent = "clip";
            const cnum = mkNum(row.sc != null ? row.sc : row.sm, "clip strength", (v) => { row.sc = v; serialize(node); });
            l2.append(tag, cnum);
        }

        card.append(l1, l2);
        if (row._open) card.append(buildTrigEditor(node, row));

        list.appendChild(card);
    });

    markDuplicates(node);
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
    node._lbContentH = ROOT_PAD + INNER_GAP + HEAD_H + listH + ADD_H + BUFFER;
    // Only the HEIGHT is ours to manage; width is whatever the user set. We
    // preserve the current width and let computeSize derive the new height from
    // our getMinHeight/getMaxHeight. This never changes width, so value changes
    // (slider/checkbox) can't collapse the node, and the user can still resize.
    const curW = (node.size && node.size[0]) || FIXED_W;
    node.setSize([curW, node.computeSize()[1]]);
    fitRootWidth(node);
    node.setDirtyCanvas(true, true);
}
