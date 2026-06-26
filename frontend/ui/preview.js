/* Per-row preview thumbnail (cover image), with a floating enlarge-on-hover pop.
 * The picture belongs to the LoRA (sidecar next to the .safetensors), so it
 * shows in every workflow once set; click to set/replace, ✕ to remove. */
import { stop } from "./constants.js";
import { loadPreviewURL, uploadPreview, deletePreview } from "./api.js";

let THUMB_POP = null;

export function closeThumbPop() { if (THUMB_POP) { THUMB_POP.remove(); THUMB_POP = null; } }

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

export function buildThumb(node, row) {
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
        if (thumb._url) { try { URL.revokeObjectURL(thumb._url); } catch (e) {} }
        thumb._url = url || null;
        if (url) { img.src = url; thumb.classList.add("has-img"); }
        else { img.removeAttribute("src"); thumb.classList.remove("has-img"); }
    };
    const refresh = () => {
        if (!row.name || row.name === "None") { setURL(null); return; }
        loadPreviewURL(row.name).then((u) => {
            if (document.body.contains(thumb)) setURL(u);   // guard stale async result
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
            if (ok) refresh();
        };
        inp.click();
    };
    x.onclick = async (e) => {
        e.stopPropagation();
        if (!row.name || row.name === "None") return;
        closeThumbPop();
        await deletePreview(row.name);
        refresh();
    };
    thumb.onmouseenter = () => { if (thumb._url) openThumbPop(thumb, thumb._url); };
    thumb.onmouseleave = () => closeThumbPop();
    stop(thumb);
    return thumb;
}
