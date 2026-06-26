"""LoRA preview images.

A picture "belongs" to the LoRA, not to a node: it is stored as a sidecar image
next to the .safetensors (same basename), so once assigned it shows in every
workflow / every Lora Box (the de-facto ComfyUI convention: <model>.png next to
the model). When there is no local sidecar we best-effort fetch one from Civitai
by the file hash and cache it as a sidecar.
"""
import os
import json
import hashlib
import urllib.request
import urllib.parse
from collections import OrderedDict

from .util import _mtime, log
from .loras import _safe_lora_path

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
# If there is no <basename>.<ext> next to the file, look the lora up on Civitai
# by its SHA256 and cache the first preview image AS a sidecar (instant forever
# after). Best-effort: any failure (offline / not on civitai / unknown hash)
# just returns None.
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
