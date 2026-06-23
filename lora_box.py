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
from collections import OrderedDict

import folder_paths
import comfy.sd
import comfy.utils

log = logging.getLogger("LoraBox")

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

    # explicit trigger fields used by various trainers / civitai exports
    for k in ("modelspec.trigger_phrase", "trigger_phrase", "ss_trigger_words",
              "activation text", "trainedWords"):
        v = meta.get(k)
        if isinstance(v, str) and v.strip():
            words.extend([w.strip() for w in v.split(",") if w.strip()])

    # fall back to the most frequent training tags (kohya) — note: tags, not
    # true trigger words, so this is best-effort only.
    if not words:
        tf = meta.get("ss_tag_frequency")
        if tf:
            try:
                freq = {}
                for _ds, tags in json.loads(tf).items():
                    for tag, cnt in tags.items():
                        freq[tag.strip()] = freq.get(tag.strip(), 0) + int(cnt)
                top = sorted(freq.items(), key=lambda x: -x[1])[:10]
                words = [t for t, _c in top if t]
            except Exception:
                pass

    seen, out = set(), []
    for w in words:
        if w and w.lower() not in seen:
            seen.add(w.lower())
            out.append(w)
    return out[:50]


# Optional API route so the UI can show trigger words on demand.
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/lorabox/triggers")
    async def _lorabox_triggers(request):
        file = request.query.get("file", "")
        return web.json_response({"file": file, "words": trigger_words_for(file)})
except Exception as e:  # pragma: no cover - server may be unavailable at import
    log.warning("could not register /lorabox/triggers route: %s", e)


class LoraBox:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
            },
            "optional": {
                # Hidden in the UI; the DOM panel keeps this JSON in sync.
                "data": ("STRING", {"default": "[]", "multiline": False}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "trigger_words")
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
    def IS_CHANGED(cls, model, clip, data="[]"):
        # Re-run when the row JSON changes OR when any referenced lora file is
        # modified on disk, so cached weights / trigger words never go stale.
        h = hashlib.sha256()
        h.update((data or "").encode("utf-8"))
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

    def apply(self, model, clip, data="[]"):
        try:
            obj = json.loads(data) if data else []
        except Exception as e:
            log.warning("bad data json: %s", e)
            obj = []

        # Two on-disk shapes are accepted:
        #   - legacy: a bare list of rows
        #   - current: {"v": 1, "mute": bool, "rows": [...]}  (lets "mute all"
        #     survive a workflow save without wiping each row's real on/off state)
        muted = False
        if isinstance(obj, dict):
            muted = bool(obj.get("mute"))
            rows = obj.get("rows")
            rows = rows if isinstance(rows, list) else []
        elif isinstance(obj, list):
            rows = obj
        else:
            rows = []

        if muted:
            return (model, clip, "")

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
            sm = max(0.0, min(2.0, sm))
            sc = max(0.0, min(2.0, sc))
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
            print("[LoraBox] applied: " + "; ".join(applied))

        seen, words = set(), []
        for w in triggers:
            if w.lower() not in seen:
                seen.add(w.lower())
                words.append(w)
        return (model, clip, ", ".join(words))


NODE_CLASS_MAPPINGS = {"LoraBox": LoraBox}
NODE_DISPLAY_NAME_MAPPINGS = {"LoraBox": "Afloy Lora Box"}
