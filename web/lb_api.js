import { api } from "../../scripts/api.js";

/*
 * Lora Box — server API layer.
 *
 * Everything that talks to the /lorabox/* routes (and the lora-list fallbacks)
 * lives here, together with the client-side caches. The UI (lora_box.js)
 * imports functions + cache accessors; it never issues a fetch itself.
 * No side effects at import time — ComfyUI auto-imports every .js in the web
 * dir, and an extra import of this module must be a no-op.
 */

/* ---- lora list + categories ---------------------------------------------- */
let LORA_LIST = null;
let LORA_LIST_PROMISE = null;
let LORA_CATEGORIES = null;
let LORA_CAT_PROMISE = null;

// Synchronous cache accessors (null until the first fetch resolves).
export const loraListCache = () => LORA_LIST;
export const loraCategoriesCache = () => LORA_CATEGORIES;

export async function getLoraCategories() {
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

// Persist a lora's custom picker group (empty = revert to auto-detect). Updates
// the local category map immediately so a redraw reflects it without a refetch.
export async function setLoraCategory(name, group) {
    try {
        const r = await api.fetchApi("/lorabox/usercats", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, group: group || "" }),
        });
        if (!r.ok) return false;
        const j = await r.json();
        if (LORA_CATEGORIES && j && j.name) LORA_CATEGORIES[j.name] = j.group;
        return true;
    } catch (e) { return false; }
}

export async function getLoraList() {
    if (LORA_LIST) return LORA_LIST;
    if (!LORA_LIST_PROMISE) {
        LORA_LIST_PROMISE = (async () => {
            const tryJson = async (url) => {
                try { const r = await api.fetchApi(url); if (r.ok) return await r.json(); } catch (e) {}
                try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
                return null;
            };
            let j = await tryJson("/rgthree/api/loras");
            // accept only the expected shape (an array of name strings) — if
            // rgthree ever returns objects here, fall through to the core API
            if (Array.isArray(j) && j.length && j.every((x) => typeof x === "string")) return j;
            j = await tryJson("/object_info/LoraLoader");
            const list = j?.LoraLoader?.input?.required?.lora_name?.[0];
            if (Array.isArray(list)) return list.filter((x) => x !== "None");
            return [];
        })().then((l) => (LORA_LIST = l || []));
    }
    return LORA_LIST_PROMISE;
}

/* ---- trigger words -------------------------------------------------------- */
export async function fetchAuto(name) {
    try {
        const r = await api.fetchApi("/lorabox/triggers?file=" + encodeURIComponent(name || ""));
        const j = await r.json();
        return j.words || [];
    } catch (e) { return []; }
}

/* ---- stack presets ------------------------------------------------------- */
let PRESETS = null;   // { name: {rows, pos, delim} }

export const presetsCache = () => PRESETS || {};

export async function getPresets(force) {
    if (PRESETS && !force) return PRESETS;
    try {
        const r = await api.fetchApi("/lorabox/presets");
        const j = await r.json();
        PRESETS = j.presets || {};
    } catch (e) { PRESETS = PRESETS || {}; }
    return PRESETS;
}

export async function savePreset(name, data) {
    try {
        const r = await api.fetchApi("/lorabox/presets", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data }),
        });
        const j = await r.json();
        if (j.ok) await getPresets(true);
        return j;
    } catch (e) { return { ok: false, error: String(e) }; }
}

export async function deletePreset(name) {
    try {
        await api.fetchApi("/lorabox/presets?name=" + encodeURIComponent(name), { method: "DELETE" });
        await getPresets(true);
        return true;
    } catch (e) { return false; }
}

/* ---- per-lora notes + Civitai link --------------------------------------- */
export async function getNote(name) {
    try {
        const r = await api.fetchApi("/lorabox/note?file=" + encodeURIComponent(name || ""));
        const j = await r.json();
        return j.note || "";
    } catch (e) { return ""; }
}

export async function saveNote(name, note) {
    try {
        await api.fetchApi("/lorabox/note", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, note }),
        });
    } catch (e) {}
}

export async function getCivitai(name) {
    try {
        const r = await api.fetchApi("/lorabox/civitai?file=" + encodeURIComponent(name || ""));
        return await r.json();   // { url?, words? } — empty when opt-in is off / not found
    } catch (e) { return {}; }
}

/* ---- per-lora preview images -------------------------------------------- */
// Cache the resolved object URL per lora name (null = checked, none exists).
// Shared across every card/render so re-rendering the list (drag-reorder, a
// toggle, opening the trigger editor, …) reuses the already-loaded image
// instead of refetching it — refetching is what made thumbnails flicker on
// every interaction. Entries are evicted only when the picture actually
// changes (upload / delete).
export const PREVIEW_CACHE = new Map();      // name -> objectURL | null
const PREVIEW_PROMISES = new Map();          // name -> in-flight Promise (de-dupe)

export function evictPreview(name) {
    if (PREVIEW_CACHE.has(name)) {
        const u = PREVIEW_CACHE.get(name);
        if (u) { try { URL.revokeObjectURL(u); } catch (e) {} }
        PREVIEW_CACHE.delete(name);
    }
    PREVIEW_PROMISES.delete(name);
}

// Resolve a lora's preview as an object URL (server finds a manual sidecar OR
// the lora's own <name>.preview.png), or null if none.
export async function loadPreviewURL(name) {
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

export async function uploadPreview(name, file) {
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const r = await api.fetchApi(
        "/lorabox/preview?file=" + encodeURIComponent(name) + "&ext=" + encodeURIComponent(ext),
        { method: "POST", body: file });
    return r.ok;
}

export async function deletePreview(name) {
    try { await api.fetchApi("/lorabox/preview?file=" + encodeURIComponent(name), { method: "DELETE" }); }
    catch (e) {}
}

// Render a quick preview on the GPU (architecture-aware) and save it as the sidecar.
export async function generatePreview(name, kind = "character") {
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
