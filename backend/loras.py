"""Resolve / cache LoRA files, read safetensors metadata, classify by base model."""
import os
import json
import struct
from collections import OrderedDict

import folder_paths

from .util import _mtime

MAX_HEADER_BYTES = 32 * 1024 * 1024   # cap safetensors header read (anti-DoS)
META_CACHE_MAX = 64                   # how many parsed metadata headers to keep

# path -> (mtime, metadata). Module-level so every node/route shares it; keyed
# by mtime so replacing a lora file on disk transparently re-reads it.
_META_CACHE = OrderedDict()


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
