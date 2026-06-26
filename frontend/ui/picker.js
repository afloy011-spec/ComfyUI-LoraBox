/* Searchable LoRA picker: grouped by base-model category, hides loras already
 * used in other rows, and (best-effort) surfaces ones compatible with the wired
 * model. openPicker calls `afterPick(node)` once a lora is chosen. */
import { stop } from "./constants.js";
import { getLoraList, getLoraCategories } from "./api.js";

const LORA_GROUP_ORDER = ["Z-Image", "Flux", "Krea", "LTX Video", "Other"];

function loraCategory(name, cats) {
    if (!name || name === "None") return null;
    if (cats && cats[name]) return cats[name];
    const low = name.toLowerCase().replace(/\\/g, "/");
    if (low.includes("zimage") || low.includes("z-image") || low.includes("z_image")) return "Z-Image";
    if (low.includes("ltx")) return "LTX Video";
    if (low.includes("flux")) return "Flux";
    if (low.includes("krea")) return "Krea";
    return "Other";
}

function groupedLoraList(names, filter, cats) {
    const f = (filter || "").trim().toLowerCase();
    const filtered = names.filter((n) => n === "None" || !f || n.toLowerCase().includes(f));
    const groups = [];
    if (filtered.includes("None")) groups.push({ label: null, items: ["None"] });
    const buckets = Object.fromEntries(LORA_GROUP_ORDER.map((g) => [g, []]));
    for (const n of filtered) {
        if (n === "None") continue;
        buckets[loraCategory(n, cats)].push(n);
    }
    for (const g of LORA_GROUP_ORDER) {
        buckets[g].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        if (buckets[g].length) groups.push({ label: g, items: buckets[g] });
    }
    return groups;
}

/* ---- best-effort: which base model is wired into the MODEL input? --------
 * No architecture flows on a MODEL link, so we trace upstream to the loader and
 * guess from its model filename / node name. Returns a label matching
 * LORA_GROUP_ORDER or null when unsure (then the picker behaves normally). */
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
    const mi = (n.inputs || []).find((i) => i.type === "MODEL" && i.link != null);
    if (mi) {
        const link = getLinkById(n.graph, mi.link);
        const up = link && traceModelArch(n.graph.getNodeById(link.origin_id), depth + 1);
        if (up) return up;
    }
    if (/reroute/i.test(n.type || "") && (n.inputs || [])[0] && n.inputs[0].link != null) {
        const link = getLinkById(n.graph, n.inputs[0].link);
        const up = link && traceModelArch(n.graph.getNodeById(link.origin_id), depth + 1);
        if (up) return up;
    }
    return archFromNode(n);
}
function detectModelArch(node) {
    try { return traceModelArch(node, 0); } catch (e) { return null; }
}

/* ---- floating searchable picker ---- */
let CUR_POP = null;

function onDocDown(e) {
    if (CUR_POP && !CUR_POP.contains(e.target) && e.target !== CUR_POP._anchor && !CUR_POP._anchor.contains(e.target)) closePop();
}
function onWinWheel(e) { if (CUR_POP && !CUR_POP.contains(e.target)) closePop(); }

export function closePop() {
    if (!CUR_POP) return;
    const p = CUR_POP; CUR_POP = null;
    document.removeEventListener("mousedown", onDocDown, true);
    window.removeEventListener("wheel", onWinWheel, true);
    if (p._anchor) p._anchor.classList.remove("open");
    p.remove();
}

export async function openPicker(node, row, fieldEl, afterPick) {
    if (CUR_POP && CUR_POP._anchor === fieldEl) { closePop(); return; }
    closePop();
    const [list, cats] = await Promise.all([getLoraList(), getLoraCategories()]);
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

    // Foolproofing: hide loras already chosen in OTHER rows (keep own + None).
    const used = new Set((node._lbRows || [])
        .filter((r) => r !== row && r.name && r.name !== "None")
        .map((r) => r.name));
    const all = (list || []).filter((n) => n === "None" || n === row.name || !used.has(n));

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
        listEl.before(bar);
    }
    let hi = 0;
    const setHi = (items) => {
        items.forEach((x) => x.classList.remove("hi"));
        if (items[hi]) { items[hi].classList.add("hi"); items[hi].scrollIntoView({ block: "nearest" }); }
    };
    const draw = (flt) => {
        listEl.innerHTML = "";
        hi = 0;
        let groups = groupedLoraList(all, flt, cats);
        if (modelArch) {
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
                it.textContent = n === "None" ? "— None —" : n;
                it.title = incompat ? n + "  (different architecture than your model)" : n;
                it.onmousedown = (e) => { e.preventDefault(); pick(n); };
                listEl.appendChild(it);
            }
        }
        const first = listEl.querySelector(".lb-pop-item");
        if (first) first.classList.add("hi");
    };
    const pick = (n) => {
        row.name = n;
        closePop();
        if (afterPick) afterPick(node);
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
    listEl.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    draw("");
    setTimeout(() => {
        search.focus();
        document.addEventListener("mousedown", onDocDown, true);
        window.addEventListener("wheel", onWinWheel, true);
    }, 0);
}
