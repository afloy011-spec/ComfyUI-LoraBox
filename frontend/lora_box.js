/*
 * Timur Lora Box — DOM-widget panel (entry point).
 *
 * This file is the ONLY extension entry (the single app.registerExtension); the
 * rest is split into pure modules under ./ui/:
 *   constants  — shared constants + tiny DOM helpers
 *   style      — injectStyle (CSS)
 *   api        — server calls (lora list, categories, triggers, previews)
 *   background — full-node video/image background (onDrawBackground seam trick)
 *   picker     — searchable lora picker + model-compat hint
 *   preview    — per-row cover thumbnail + hover enlarge
 * Here lives the render core (renderRows / trigger editor), the data model
 * (serialize / initFromData) and the node lifecycle.
 */
import { app } from "../../scripts/app.js";
import {
    GAP, MIN_W, FIXED_W, ROOT_PAD, INNER_GAP, HEAD_H, ADD_H, BUFFER, TRIG_MIN,
    SMIN, clampS, round2, tintNum, stop, eatWheel, rowOff,
} from "./ui/constants.js";
import { injectStyle } from "./ui/style.js";
import { getLoraList, fetchAuto } from "./ui/api.js";
import { drawBgSlice } from "./ui/background.js";
import { openPicker, closePop } from "./ui/picker.js";
import { buildThumb, closeThumbPop } from "./ui/preview.js";

/* Force the panel's root element to span the node's content width — the
 * frontend sizes DOM widgets off HEIGHT only, so widening doesn't re-stretch
 * the element on its own (core DOMWidget margin is 10). */
function fitRootWidth(node) {
    const root = node && node._lbRoot;
    if (!root || !node.size) return;
    const m = (node._lbWidget && typeof node._lbWidget.margin === "number") ? node._lbWidget.margin : 10;
    const px = Math.max(0, Math.round(node.size[0] - 2 * m)) + "px";
    if (root.style.width !== px) root.style.width = px;
}

/* Stop touch gestures starting inside any panel from reaching litegraph (which
 * would pinch-zoom / pan the graph). Capture-phase on document runs before
 * litegraph's ancestor listeners; we only stopPropagation, never preventDefault. */
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

app.registerExtension({
    name: "LoraBoxTimur.dom",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LoraBoxTimur") return;
        injectStyle();
        installTouchGuard();

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onCreated && onCreated.apply(this, arguments);
            const node = this;

            // Uniform base under the bg-image: force title + body to the same
            // neutral dark so the semi-transparent image tints evenly.
            node.bgcolor = "#1b1b1b";
            node.color = "#1b1b1b";

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
            // litegraph; we deliberately do NOT touch pointermove.
            stop(inner); eatWheel(inner);

            const head = document.createElement("div");
            head.className = "lb-head";
            node._lbMuteCb = mkCheck(head, "mute all", (v) => { node._lbMute = v; applyMute(node); serialize(node); });
            node._lbSepCb = mkCheck(head, "model + clip", (v) => { node._lbSep = v; renderRows(node); sizeNode(node); serialize(node); });
            inner.appendChild(head);

            // (trigger-position dropdown + sep delimiter removed — position stays
            // "end" in node._lbPos, delimiter ", " in node._lbDelim; the companion
            // node handles repositioning.)

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

            // Feed our content height through getMinHeight/getMaxHeight (the
            // mechanism core resizable DOM widgets use) so the node resizes
            // freely and never collapses on a value change.
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

        // Freely resizable; only stop it getting so narrow cards get crushed.
        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            if (size && size[0] < MIN_W) size[0] = MIN_W;
            onResize && onResize.apply(this, arguments);
            fitRootWidth(this);
        };

        // Keep the DOM element width matched to the node every frame; also draw
        // the title slice of the background image over the title bar.
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground && onDrawForeground.apply(this, arguments);
            fitRootWidth(this);
            drawBgSlice(this, ctx, "title");
        };

        // Body slice of the same image, drawn behind slots and the DOM panel.
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            onDrawBackground && onDrawBackground.apply(this, arguments);
            drawBgSlice(this, ctx, "body");
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () { closePop(); closeThumbPop(); onRemoved && onRemoved.apply(this, arguments); };
    },
});

/* Defer init to a macrotask so widget values restored during deserialize are in
 * place. Deduped per node so create+configure can't run it twice or race. */
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
    const els = node._lbList ? node._lbList.querySelectorAll(".lbg-row") : [];
    els.forEach((el, i) => { const row = node._lbRows[i]; if (row) el.classList.toggle("off", rowOff(node, row)); });
}

/* Single source of truth: read the saved `data` widget, default only if truly
 * empty. Used by both onNodeCreated and onConfigure so neither clobbers the other. */
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
    if (node._lbMuteCb) node._lbMuteCb.checked = node._lbMute;
    renderRows(node); sizeNode(node); serialize(node);
}

function serialize(node) {
    if (!node._lbDataW) return;
    // Persist each row's REAL on/off state plus a separate `mute` flag so muting
    // and saving never wipes per-row states (backend skips all when mute).
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
    n.min = String(SMIN); n.max = "3"; n.step = "0.05"; n.value = round2(val); n.title = title;
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

    const fillPct = (v) => (Math.max(0, Math.min(1, v / 1.5)) * 100) + "%";

    node._lbRows.forEach((row, i) => {
        const card = document.createElement("div");
        card.className = "lbg-row" + (rowOff(node, row) ? " off" : "");
        card.style.setProperty("--p", fillPct(row.sm));

        // big strength number (scrubby) with a reserved left slot for the minus
        const num = document.createElement("div");
        num.className = "lbg-num"; num.title = "drag ↕ to fine-tune · double-click to type";
        const sign = document.createElement("span"); sign.className = "lbg-sign";
        const digits = document.createElement("span"); digits.className = "lbg-digits";
        const valWrap = document.createElement("span"); valWrap.className = "lbg-val"; valWrap.append(sign, digits);
        const slab = document.createElement("span"); slab.className = "lbg-slab"; slab.textContent = "STRENGTH";
        num.append(valWrap, slab);
        const renderVal = (v) => { sign.textContent = v < 0 ? "−" : ""; digits.textContent = Math.abs(v).toFixed(2); };
        const setV = (v) => {
            row.sm = clampS(Math.round(v / 0.05) * 0.05);
            if (!node._lbSep) row.sc = row.sm;
            renderVal(row.sm); card.style.setProperty("--p", fillPct(row.sm)); serialize(node);
        };
        renderVal(row.sm);

        const body = document.createElement("div"); body.className = "lbg-body";
        const l1 = document.createElement("div"); l1.className = "lbg-l1";
        const en = document.createElement("input");
        en.type = "checkbox"; en.className = "lbg-en"; en.checked = !!row.on; en.title = "enable / disable";
        en.onchange = () => { row.on = en.checked; card.classList.toggle("off", rowOff(node, row)); serialize(node); };
        stop(en);
        const field = document.createElement("div"); field.className = "lbg-name"; field.title = row.name || "None"; field.tabIndex = 0;
        const txt = document.createElement("span");
        txt.className = "lbg-nametxt" + (!row.name || row.name === "None" ? " none" : "");
        txt.textContent = row.name && row.name !== "None" ? row.name : "None";
        const car = document.createElement("span"); car.className = "lbg-car"; car.textContent = "▼";
        field.append(txt, car);
        field.onclick = (e) => { e.stopPropagation(); openPicker(node, row, field, (n) => { serialize(n); renderRows(n); sizeNode(n); }); };
        stop(field);
        const info = document.createElement("button");
        info.className = "lbg-ic" + (row._open ? " on" : ""); info.textContent = "ⓘ"; info.title = "trigger words";
        info.onclick = (e) => { e.stopPropagation(); row._open = !row._open; renderRows(node); sizeNode(node); };
        stop(info);
        const del = document.createElement("button");
        del.className = "lbg-ic"; del.textContent = "✕"; del.title = "remove lora";
        del.onclick = (e) => { e.stopPropagation(); node._lbRows.splice(i, 1); renderRows(node); sizeNode(node); serialize(node); };
        stop(del);
        l1.append(en, field, info, del);
        body.append(l1);
        if (node._lbSep) {
            const cl = document.createElement("div"); cl.className = "lbg-clip";
            const lbl = document.createElement("span"); lbl.className = "lbg-cliplbl"; lbl.textContent = "clip";
            const cnum = mkNum(row.sc != null ? row.sc : row.sm, "clip strength", (v) => { row.sc = v; serialize(node); });
            cl.append(lbl, cnum); body.append(cl);
        }

        const cover = buildThumb(node, row);   // CSS makes it a full-height cover

        card.append(num, body, cover);

        // drag horizontally on the box (meter) -> strength; controls are excluded
        card.addEventListener("pointerdown", (e) => {
            if (e.target.closest(".lbg-en,.lbg-name,.lbg-ic,.lbg-num,.lb-thumb,.lbg-clip")) return;
            const rect = card.getBoundingClientRect();
            const mv = (ev) => setV(((ev.clientX - rect.left) / rect.width) * 1.5);
            mv(e); try { card.setPointerCapture(e.pointerId); } catch (_) {}
            const up = () => { card.removeEventListener("pointermove", mv); card.removeEventListener("pointerup", up); };
            card.addEventListener("pointermove", mv); card.addEventListener("pointerup", up);
        });
        // scrubby number -> fine tune (relative drag); double-click -> type
        num.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            const lastX = e.clientX, base = row.sm;
            try { num.setPointerCapture(e.pointerId); } catch (_) {}
            const mv = (ev) => setV(base + (ev.clientX - lastX) * 0.004);
            const up = () => { num.removeEventListener("pointermove", mv); num.removeEventListener("pointerup", up); };
            num.addEventListener("pointermove", mv); num.addEventListener("pointerup", up);
        });
        num.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            const t = prompt("LoRA strength (-3…3):", row.sm.toFixed(2));
            if (t != null && !isNaN(parseFloat(t))) setV(parseFloat(t));
        });

        list.appendChild(card);
        if (row._open) list.appendChild(buildTrigEditor(node, row));   // full-width drawer below
    });
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

/* Measure the ACTUAL rendered height (robust — matches the browser). Fall back
 * to a pixel estimate only before first layout. */
function sizeNode(node) {
    const rows = node._lbRows;
    let h = 0;
    if (node._lbInner) h = Math.ceil(node._lbInner.scrollHeight);
    if (!h || h < 60) {
        const ROW = 62, CLIP = 26, DRAWER_PAD = 22;
        const openCount = rows.filter((r) => r._open).length;
        const listH = rows.length === 0 ? 40
            : rows.reduce((a, r) => a + ROW + (node._lbSep ? CLIP : 0) + (r._open ? DRAWER_PAD + (r._trigH || TRIG_MIN) : 0), 0)
              + (rows.length + openCount - 1) * GAP;
        h = ROOT_PAD + INNER_GAP + HEAD_H + listH + ADD_H + BUFFER;
    } else {
        h += BUFFER;
    }
    node._lbContentH = h;
    const curW = (node.size && node.size[0]) || FIXED_W;
    node.setSize([curW, node.computeSize()[1]]);
    fitRootWidth(node);
    node.setDirtyCanvas(true, true);
}
