/* All server calls + their caches. Depends only on ComfyUI's api. */
import { api } from "../../../scripts/api.js";

let LORA_LIST = null, LORA_LIST_PROMISE = null;
let LORA_CATEGORIES = null, LORA_CAT_PROMISE = null;

export async function getLoraCategories() {
    if (LORA_CATEGORIES) return LORA_CATEGORIES;
    if (!LORA_CAT_PROMISE) {
        LORA_CAT_PROMISE = (async () => {
            try {
                const r = await api.fetchApi("/loraboxtimur/categories");
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
            if (Array.isArray(j) && j.length) return j;
            j = await tryJson("/object_info/LoraLoader");
            const list = j?.LoraLoader?.input?.required?.lora_name?.[0];
            if (Array.isArray(list)) return list.filter((x) => x !== "None");
            return [];
        })().then((l) => (LORA_LIST = l || []));
    }
    return LORA_LIST_PROMISE;
}

export async function fetchAuto(name) {
    try {
        const r = await api.fetchApi("/loraboxtimur/triggers?file=" + encodeURIComponent(name || ""));
        const j = await r.json();
        return j.words || [];
    } catch (e) { return []; }
}

// Fetch the sidecar preview for a lora as an object URL, or null if none.
export async function loadPreviewURL(name) {
    if (!name || name === "None") return null;
    try {
        const r = await api.fetchApi("/loraboxtimur/preview?file=" + encodeURIComponent(name) + "&t=" + Date.now());
        if (!r.ok) return null;
        const b = await r.blob();
        if (!b || !b.size) return null;
        return URL.createObjectURL(b);
    } catch (e) { return null; }
}

export async function uploadPreview(name, file) {
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const r = await api.fetchApi(
        "/loraboxtimur/preview?file=" + encodeURIComponent(name) + "&ext=" + encodeURIComponent(ext),
        { method: "POST", body: file });
    return r.ok;
}

export async function deletePreview(name) {
    try { await api.fetchApi("/loraboxtimur/preview?file=" + encodeURIComponent(name), { method: "DELETE" }); }
    catch (e) {}
}
