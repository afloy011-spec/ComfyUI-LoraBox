"""
Lora Box - a compact multi-LoRA loader with a custom DOM (HTML) panel UI.

Why a DOM panel: rgthree's Power Lora Loader draws widgets on the canvas by hand,
which the ComfyUI 1.43 frontend mis-lays-out (rows shift / disappear). An HTML
panel renders as an overlay, independent of litegraph's widget layout, so it is
immune to that bug while allowing a compact one-row-per-lora design with search,
a strength slider and trigger-word lookup.

The visible editor lives in ./web/lora_box.js. All it does on the data side is
keep a hidden STRING widget ("data") in sync with a JSON list of rows:
    [{"on": true, "name": "foo.safetensors", "sm": 1.0, "sc": 1.0}, ...]
This node parses that JSON and applies each enabled LoRA.
"""

import os
import json
import math
import struct
import hashlib
import logging
import asyncio
import urllib.request
import urllib.parse
from collections import OrderedDict

import folder_paths
import comfy.sd
import comfy.utils

log = logging.getLogger("LoraBoxTimurTimur")

MAX_HEADER_BYTES = 32 * 1024 * 1024   # cap safetensors header read (anti-DoS)
LORA_CACHE_MAX = 4                    # how many loaded LoRAs to keep in RAM
META_CACHE_MAX = 64                   # how many parsed metadata headers to keep

# path -> (mtime, metadata). Module-level so every node/route shares it; keyed
# by mtime so replacing a lora file on disk transparently re-reads it.
_META_CACHE = OrderedDict()


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _safe_lora_path(name):
    """Resolve a lora name to a path, but ONLY if it is a known lora file.

    Guards against path traversal / arbitrary file reads via the public route:
    the name must be in the registered loras list, not just resolvable on disk.
    """
    if not name or name == "None":
        return None
    try:
        if name not in folder_paths.get_filename_list("loras"):
            return None
    except Exception:
        return None
    path = folder_paths.get_full_path("loras", name)
    if not path or not os.path.exists(path):
        return None
    return path


def _read_st_metadata(path):
    # cache parsed headers by (path, mtime) so trigger-word lookups don't
    # re-read the file on every graph execution.
    mt = _mtime(path)
    hit = _META_CACHE.get(path)
    if hit and hit[0] == mt:
        _META_CACHE.move_to_end(path)
        return hit[1]
    try:
        with open(path, "rb") as f:
            n = struct.unpack("<Q", f.read(8))[0]
            if n <= 0 or n > MAX_HEADER_BYTES:
                meta = {}
            else:
                header = json.loads(f.read(n).decode("utf-8"))
                meta = header.get("__metadata__", {}) or {}
    except Exception:
        meta = {}
    _META_CACHE[path] = (mt, meta)
    while len(_META_CACHE) > META_CACHE_MAX:
        _META_CACHE.popitem(last=False)
    return meta


def trigger_words_for(name):
    path = _safe_lora_path(name)
    if not path:
        return []
    meta = _read_st_metadata(path)
    words = []

    # Only real trigger fields written by trainers / civitai exports. We do
    # NOT fall back to the most frequent training tags (ss_tag_frequency): those
    # are dataset tags, not trigger words, and silently injecting them adds
    # noise to the prompt the user never asked for.
    for k in ("modelspec.trigger_phrase", "trigger_phrase", "ss_trigger_words",
              "activation text", "trainedWords"):
        v = meta.get(k)
        if isinstance(v, str) and v.strip():
            words.extend([w.strip() for w in v.split(",") if w.strip()])

    seen, out = set(), []
    for w in words:
        if w and w.lower() not in seen:
            seen.add(w.lower())
            out.append(w)
    return out[:50]


LORA_CATEGORIES = ("Z-Image", "Flux", "Krea", "LTX Video", "Other")


def _category_from_name(name):
    """Best-effort category from filename / subfolder only."""
    low = name.lower().replace("\\", "/")
    if any(x in low for x in ("zimage", "z-image", "z_image")):
        return "Z-Image"
    if "ltx" in low:
        return "LTX Video"
    if "flux" in low:
        return "Flux"
    if "krea" in low:
        return "Krea"
    return "Other"


def _category_from_meta(meta):
    """Read base model from safetensors metadata (AI Toolkit, Kohya, Civitai)."""
    if not meta:
        return "Other"
    base = str(meta.get("ss_base_model_version", "")).lower()
    arch = str(meta.get("modelspec.architecture", "")).lower()
    sd = str(meta.get("ss_sd_model_name", "")).lower()
    hints = " ".join((base, arch, sd))
    if any(x in hints for x in ("zimage", "z-image", "z_image", "zimageturbo")):
        return "Z-Image"
    if "ltx" in hints:
        return "LTX Video"
    if "flux" in hints:
        return "Flux"
    if "krea" in hints:
        return "Krea"
    return "Other"


def category_for(name):
    """Category for picker grouping: filename first, then metadata."""
    if not name or name == "None":
        return None
    cat = _category_from_name(name)
    if cat != "Other":
        return cat
    path = _safe_lora_path(name)
    if not path:
        return "Other"
    return _category_from_meta(_read_st_metadata(path))


def merge_prompt(prompt, triggers, position="end", delimiter=", "):
    """Combine a prompt with trigger words at the chosen position.

    - Empty sides are handled without leaving a stray delimiter.
    - Trigger words already present in the prompt (case-insensitive) are
      dropped, so flipping beginning/end never duplicates them.
    - `position` accepts "beginning"/"begin"/"start" (anything starting with
      "beg" or "start") for prepend; anything else appends.
    """
    p = (prompt or "").strip()
    t = (triggers or "").strip()
    if not t:
        return p
    if not p:
        return t

    plow = p.lower()
    kept = [w.strip() for w in t.split(",") if w.strip() and w.strip().lower() not in plow]
    t = ", ".join(kept)
    if not t:
        return p

    d = delimiter if delimiter is not None else ", "
    pos = str(position).lower()
    if pos.startswith("beg") or pos.startswith("start") or pos.startswith("нач"):
        return t + d + p
    return p + d + t


# ---- preview images ------------------------------------------------------
# A picture "belongs" to the LoRA, not to a node: it is stored as a sidecar
# image next to the .safetensors (same basename), so once assigned it shows in
# every workflow / every Lora Box. This also matches the de-facto ComfyUI
# convention (<model>.png next to the model).
PREVIEW_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
PREVIEW_CT = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif",
}
MAX_PREVIEW_BYTES = 8 * 1024 * 1024   # cap uploaded preview size (anti-DoS)


def _preview_base(name):
    """Directory+basename (no extension) for a registered lora, or None.

    Goes through `_safe_lora_path`, so the name must be a real registered lora
    — this is what keeps the upload/delete routes from writing arbitrary paths.
    """
    path = _safe_lora_path(name)
    if not path:
        return None
    return os.path.splitext(path)[0]


def _find_preview(name):
    base = _preview_base(name)
    if not base:
        return None
    for ext in PREVIEW_EXTS:
        p = base + ext
        if os.path.exists(p):
            return p
    return None


# ---- auto-fetch a preview from Civitai when the lora has no local sidecar ----
# So "every lora shows a picture": if there is no <basename>.<ext> next to the
# file, look the lora up on Civitai by its SHA256 and cache the first preview
# image AS a sidecar (so it's instant forever after). Best-effort: any failure
# (offline / not on civitai / unknown hash) just returns None -> 404 as before.
_HASH_CACHE = OrderedDict()   # path -> (mtime, sha256)
_CIVITAI_MISS = set()         # paths we already failed to resolve, don't retry every request


def _sha256(path):
    mt = _mtime(path)
    hit = _HASH_CACHE.get(path)
    if hit and hit[0] == mt:
        _HASH_CACHE.move_to_end(path)
        return hit[1]
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    dig = h.hexdigest()
    _HASH_CACHE[path] = (mt, dig)
    while len(_HASH_CACHE) > 64:
        _HASH_CACHE.popitem(last=False)
    return dig


def _http_get(url, timeout):
    req = urllib.request.Request(url, headers={"User-Agent": "ComfyUI-LoraBox"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _fetch_civitai_preview(name):
    """No local sidecar -> resolve on Civitai by file hash, save <base>.png. Blocking."""
    path = _safe_lora_path(name)
    if not path or path in _CIVITAI_MISS:
        return None
    base = os.path.splitext(path)[0]
    try:
        sha = _sha256(path)
        meta = json.loads(_http_get(
            "https://civitai.com/api/v1/model-versions/by-hash/" + sha, 12).decode("utf-8"))
        img_url = next((im["url"] for im in (meta.get("images") or []) if im.get("url")), None)
        if not img_url:
            _CIVITAI_MISS.add(path)
            return None
        blob = _http_get(img_url, 25)
        if not blob or len(blob) > MAX_PREVIEW_BYTES * 4:
            _CIVITAI_MISS.add(path)
            return None
        ext = os.path.splitext(urllib.parse.urlparse(img_url).path)[1].lower()
        if ext not in PREVIEW_EXTS:
            ext = ".png"
        out = base + ext
        with open(out, "wb") as f:
            f.write(blob)
        log.info("fetched Civitai preview for %s", name)
        return out
    except Exception as e:
        _CIVITAI_MISS.add(path)
        log.info("Civitai preview fetch failed for %s: %s", name, e)
        return None


# Optional API routes so the UI can show trigger words / preview images.
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/loraboxtimur/triggers")
    async def _lorabox_triggers(request):
        file = request.query.get("file", "")
        return web.json_response({"file": file, "words": trigger_words_for(file)})

    @PromptServer.instance.routes.get("/loraboxtimur/categories")
    async def _lorabox_categories(request):
        """Map every registered lora to a picker group (name + metadata)."""
        cats = {}
        try:
            names = folder_paths.get_filename_list("loras")
        except Exception:
            names = []
        for name in names:
            if name and name != "None":
                cats[name] = category_for(name)
        return web.json_response({"categories": cats})

    @PromptServer.instance.routes.get("/loraboxtimur/preview")
    async def _lorabox_preview_get(request):
        file = request.query.get("file", "")
        p = _find_preview(file)
        if not p:
            # no local sidecar: try to pull one from Civitai (hashing + network
            # are blocking, so run off the event loop) and cache it as a sidecar
            p = await asyncio.get_event_loop().run_in_executor(None, _fetch_civitai_preview, file)
        if not p:
            return web.Response(status=404)
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            return web.Response(status=404)
        ext = os.path.splitext(p)[1].lower()
        return web.Response(body=data, content_type=PREVIEW_CT.get(ext, "application/octet-stream"),
                            headers={"Cache-Control": "no-store"})

    @PromptServer.instance.routes.post("/loraboxtimur/preview")
    async def _lorabox_preview_post(request):
        base = _preview_base(request.query.get("file", ""))
        if not base:
            return web.json_response({"ok": False, "error": "unknown lora"}, status=400)
        ext = ("." + request.query.get("ext", "png").lstrip(".")).lower()
        if ext not in PREVIEW_EXTS:
            ext = ".png"
        data = await request.read()
        if not data:
            return web.json_response({"ok": False, "error": "empty"}, status=400)
        if len(data) > MAX_PREVIEW_BYTES:
            return web.json_response({"ok": False, "error": "too large"}, status=413)
        # drop any existing sidecar(s) first so the new image is unambiguous
        for e in PREVIEW_EXTS:
            try:
                os.remove(base + e)
            except OSError:
                pass
        try:
            with open(base + ext, "wb") as f:
                f.write(data)
        except OSError as ex:
            return web.json_response({"ok": False, "error": str(ex)}, status=500)
        return web.json_response({"ok": True, "ext": ext})

    @PromptServer.instance.routes.delete("/loraboxtimur/preview")
    async def _lorabox_preview_del(request):
        base = _preview_base(request.query.get("file", ""))
        if not base:
            return web.json_response({"ok": False}, status=400)
        removed = False
        for e in PREVIEW_EXTS:
            try:
                os.remove(base + e)
                removed = True
            except OSError:
                pass
        return web.json_response({"ok": removed})
except Exception as e:  # pragma: no cover - server may be unavailable at import
    log.warning("could not register /loraboxtimur routes: %s", e)


class LoraBoxTimur:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
            },
            "optional": {
                # Optional: connect a prompt and the node returns it with the
                # LoRA trigger words merged in (position set inside the panel).
                "prompt": ("STRING", {"forceInput": True}),
                # Hidden in the UI; the DOM panel keeps this JSON in sync.
                "data": ("STRING", {"default": "[]", "multiline": False}),
            },
        }

    # The node loads the LoRA(s) and emits the prompt with their trigger words
    # already merged in. (Trigger words are computed internally; there is no
    # separate trigger_words output — the merged prompt is what you wire on.)
    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "prompt")
    FUNCTION = "apply"
    CATEGORY = "loaders"

    def __init__(self):
        self._cache = OrderedDict()  # name -> (mtime, loaded tensor dict)

    def _get_lora(self, name):
        path = _safe_lora_path(name)
        if path is None:
            log.warning("LoRA not found / not allowed: %s", name)
            return None
        mt = _mtime(path)
        hit = self._cache.get(name)
        if hit and hit[0] == mt:          # same file, unchanged on disk
            self._cache.move_to_end(name)
            return hit[1]
        lora = comfy.utils.load_torch_file(path, safe_load=True)
        self._cache[name] = (mt, lora)
        while len(self._cache) > LORA_CACHE_MAX:
            self._cache.popitem(last=False)
        return lora

    @classmethod
    def IS_CHANGED(cls, model, clip, prompt=None, data="[]"):
        # Re-run when the row JSON / prompt changes OR when any referenced lora
        # file is modified on disk, so cached weights / merged prompt / trigger
        # words never go stale.
        h = hashlib.sha256()
        h.update((data or "").encode("utf-8"))
        h.update(b"\x00")
        h.update((prompt or "").encode("utf-8"))
        try:
            obj = json.loads(data) if data else []
        except Exception:
            obj = []
        rows = obj.get("rows") if isinstance(obj, dict) else obj
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                path = _safe_lora_path(row.get("name"))
                if path:
                    h.update(("%s:%s" % (row.get("name"), _mtime(path))).encode("utf-8"))
        return h.hexdigest()

    def apply(self, model, clip, prompt=None, data="[]"):
        try:
            obj = json.loads(data) if data else []
        except Exception as e:
            log.warning("bad data json: %s", e)
            obj = []

        # Two on-disk shapes are accepted:
        #   - legacy: a bare list of rows
        #   - current: {"v": 1, "mute": bool, "pos": str, "delim": str,
        #     "rows": [...]}  (lets "mute all" survive a workflow save without
        #     wiping each row's real on/off state; pos/delim drive prompt merge)
        muted = False
        pos, delim = "end", ", "
        if isinstance(obj, dict):
            muted = bool(obj.get("mute"))
            pos = obj.get("pos", "end") or "end"
            delim = obj.get("delim", ", ")
            if delim is None:
                delim = ", "
            rows = obj.get("rows")
            rows = rows if isinstance(rows, list) else []
        elif isinstance(obj, list):
            rows = obj
        else:
            rows = []

        if muted:
            # Muted: no LoRA applied, no triggers — pass the prompt through
            # untouched so a connected prompt still reaches the encoder.
            return (model, clip, (prompt or ""))

        applied, triggers = [], []
        for row in rows:
            if not isinstance(row, dict):
                continue
            if not row.get("on", True):
                continue
            name = row.get("name", "None")
            if name in (None, "None", ""):
                continue
            try:
                sm = float(row.get("sm", 1.0))
                sc = float(row.get("sc", sm))
            except (TypeError, ValueError):
                continue
            # reject NaN / +-Inf: json.loads accepts them and the bare
            # max/min clamp would silently turn NaN into 2.0 (full strength).
            if not (math.isfinite(sm) and math.isfinite(sc)):
                continue
            # allow negative ("anti-LoRA") and >1 weights, matching the UI range
            sm = max(-3.0, min(3.0, sm))
            sc = max(-3.0, min(3.0, sc))
            if sm == 0.0 and sc == 0.0:
                continue
            lora = self._get_lora(name)
            if lora is None:
                continue
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora, sm, sc)
            applied.append(f"{name} (m={sm}, c={sc})")
            # manual trigger override (row.trig) wins over auto-detection
            tw = row.get("trig")
            if isinstance(tw, str):
                triggers.extend([w.strip() for w in tw.split(",") if w.strip()])
            else:
                triggers.extend(trigger_words_for(name))

        if applied:
            log.info("applied: %s", "; ".join(applied))

        seen, words = set(), []
        for w in triggers:
            if w.lower() not in seen:
                seen.add(w.lower())
                words.append(w)
        tw = ", ".join(words)
        merged = merge_prompt(prompt, tw, pos, delim)
        return (model, clip, merged)


POS_END = "end (append after prompt)"
POS_BEGIN = "beginning (prepend before prompt)"


class LoraBoxTimurPromptMerge:
    """Merge a prompt with LoRA trigger words, with a working position switch.

    Replaces the fragile JoinStrings + JoinStrings + LazySwitchKJ trio: one node
    with a single `position` dropdown decides whether the trigger words go at the
    beginning or the end of the prompt. Empty sides are handled gracefully (no
    stray delimiters) and trigger words already present in the prompt are skipped
    so flipping the switch never duplicates them.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"forceInput": True, "multiline": True, "default": ""}),
                "triggers": ("STRING", {"forceInput": True, "multiline": True, "default": ""}),
                "position": ([POS_END, POS_BEGIN], {"default": POS_END}),
                "delimiter": ("STRING", {"default": ", ", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "merge"
    CATEGORY = "loaders"

    @staticmethod
    def _merge(prompt, triggers, position, delimiter):
        return merge_prompt(prompt, triggers, position, delimiter)

    def merge(self, prompt, triggers, position, delimiter):
        out = merge_prompt(prompt, triggers, position, delimiter)
        side = "BEGINNING" if str(position).startswith("beginning") else "END"
        log.debug("PromptMerge triggers at %s -> %s", side, out[:160])
        return (out,)


NODE_CLASS_MAPPINGS = {
    "LoraBoxTimur": LoraBoxTimur,
    "LoraBoxTimurPromptMerge": LoraBoxTimurPromptMerge,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraBoxTimur": "Timur Lora Box",
    "LoraBoxTimurPromptMerge": "Prompt + Triggers (Timur Lora Box)",
}
