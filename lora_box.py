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
import re
import json
import math
import struct
import hashlib
import asyncio
import logging
import urllib.parse
import urllib.request
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


def _sidecar_triggers(path):
    """Trigger words from a text / JSON sidecar next to the lora.

    Many loras carry NO trigger field in the safetensors header (AI Toolkit /
    Ostris exports are often metadata-empty), but model managers drop a sidecar:
      <base>.txt            — comma/newline-separated trigger words
      <base>.civitai.info   — Civitai model-version JSON  ("trainedWords")
      <base>.cm-info.json   — Civitai-Helper JSON  ("trainedWords"/"activation text")
    Fast local read, safe to call during graph execution.
    """
    base = os.path.splitext(path)[0]
    p = base + ".txt"
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                txt = f.read()
            return [w.strip() for w in txt.replace("\n", ",").split(",") if w.strip()]
        except OSError:
            pass
    for ext in (".civitai.info", ".cm-info.json"):
        p = base + ext
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                j = json.load(f)
        except Exception:
            continue
        tw = j.get("trainedWords") or j.get("activation text") or j.get("trigger_words")
        if isinstance(tw, str):
            tw = tw.split(",")
        if isinstance(tw, list):
            out = [str(w).strip() for w in tw if str(w).strip()]
            if out:
                return out
    return []


def _tags_from_frequency(meta):
    """Activation tokens from ss_tag_frequency, used only when no explicit
    trigger field exists.

    Kohya / AI-Toolkit record every caption tag with the number of images it
    appeared in. The words deliberately added to EVERY caption — the trigger /
    activation tokens — therefore have the highest count, while descriptive
    dataset tags trail off. We surface only the tokens present in *every* image
    (count == max), so we recover the real triggers (e.g. "vokiai", "ami") and
    NOT the long tail of dataset tags. Guarded: a one-shot set (max < 2) or a
    set where almost everything is ubiquitous gives no reliable signal.
    """
    freq = meta.get("ss_tag_frequency")
    if isinstance(freq, str):
        try:
            freq = json.loads(freq)
        except Exception:
            return []
    if not isinstance(freq, dict):
        return []
    counts = {}
    folders = []
    for subset_name, subset in freq.items():
        # Kohya dataset folders are named "<repeats>_<trigger>" (e.g. "1_katosik");
        # the part after the leading "<n>_" is a strong, common trigger signal.
        tok = re.sub(r"^\d+_", "", str(subset_name).strip()).replace("_", " ").strip()
        if len(tok) >= 3:
            folders.append(tok)
        if not isinstance(subset, dict):
            continue
        for tag, c in subset.items():
            try:
                c = int(c)
            except (TypeError, ValueError):
                continue
            t = str(tag).strip()
            if t:
                counts[t] = counts.get(t, 0) + c
    # Primary: activation tokens are the tags present in (essentially) every
    # image — i.e. count == max. Only trust the histogram for a real multi-image
    # set (max >= 2); a one-shot caption set is too noisy to rank.
    if counts:
        maxc = max(counts.values())
        if maxc >= 2:
            hits = sorted((t for t, c in counts.items() if c == maxc), key=lambda t: t.lower())
            if len(hits) <= 12:
                return hits[:10]
    # Fallback: the Kohya folder trigger (recovers "katosik" from "1_katosik"
    # even when its tag count is 1).
    out = []
    for ft in folders:
        if ft.lower() not in (o.lower() for o in out):
            out.append(ft)
    return out[:10]


def trigger_words_for(name):
    path = _safe_lora_path(name)
    if not path:
        return []
    meta = _read_st_metadata(path)
    words = []

    # 1) explicit trigger fields written by trainers / civitai exports (best).
    for k in ("modelspec.trigger_phrase", "trigger_phrase", "ss_trigger_words",
              "activation text", "trainedWords"):
        v = meta.get(k)
        if isinstance(v, str) and v.strip():
            words.extend([w.strip() for w in v.split(",") if w.strip()])

    # 2) a sidecar file next to the lora (Civitai-helper style).
    if not words:
        words.extend(_sidecar_triggers(path))

    # 3) last resort: the always-present tokens from ss_tag_frequency. Many
    # loras carry no explicit trigger field but DO have the tag histogram, and
    # the activation token is the one present in every image.
    if not words:
        words.extend(_tags_from_frequency(meta))

    seen, out = set(), []
    for w in words:
        if w and w.lower() not in seen:
            seen.add(w.lower())
            out.append(w)
    return out[:50]


LORA_CATEGORIES = ("Z-Image", "Flux", "Krea", "SDXL", "SD1.5", "LTX Video", "Other")


def _category_from_name(name):
    """Best-effort category from filename / subfolder only."""
    low = name.lower().replace("\\", "/")
    if any(x in low for x in ("zimage", "z-image", "z_image")):
        return "Z-Image"
    if "ltx" in low:
        return "LTX Video"
    if "krea" in low:
        return "Krea"
    if "flux" in low:
        return "Flux"
    if any(x in low for x in ("sdxl", "sd-xl", "sd_xl", "-xl", "_xl", "xl-", "xl_")):
        return "SDXL"
    if any(x in low for x in ("sd15", "sd1.5", "sd-1.5", "sd_15", "sd_1.5", "v1-5", "v1.5")):
        return "SD1.5"
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
    if "krea" in hints:
        return "Krea"
    if "flux" in hints:
        return "Flux"
    if any(x in hints for x in ("sdxl", "sd-xl", "sd_xl", "stable-diffusion-xl",
                                "stable_diffusion_xl", "xl-base", "xl_base")):
        return "SDXL"
    if any(x in hints for x in ("sd15", "sd1.5", "sd-1.5", "sd_1.5", "v1-5", "v1.5",
                                "stable-diffusion-v1", "sd_v1", "runwayml")):
        return "SD1.5"
    return "Other"


# ---- user category overrides ---------------------------------------------
# A user can move a lora into a different (or brand-new) picker group; the
# choice is stored by lora name in a small JSON next to the node so it persists
# and is shared by every Lora Box. Auto-detection is the fallback.
_USERCATS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_categories.json")
_USERCATS = None
MAX_CAT_LEN = 40


def _load_usercats():
    global _USERCATS
    if _USERCATS is None:
        try:
            with open(_USERCATS_PATH, encoding="utf-8") as f:
                d = json.load(f)
            ov = d.get("overrides") if isinstance(d, dict) else None
            _USERCATS = {k: str(v)[:MAX_CAT_LEN] for k, v in ov.items()} if isinstance(ov, dict) else {}
        except Exception:
            _USERCATS = {}
    return _USERCATS


def _save_usercats():
    try:
        with open(_USERCATS_PATH, "w", encoding="utf-8") as f:
            json.dump({"overrides": _USERCATS}, f, indent=2, ensure_ascii=False)
    except OSError as e:
        log.warning("could not save user_categories.json: %s", e)


def _auto_category(name):
    cat = _category_from_name(name)
    if cat != "Other":
        return cat
    path = _safe_lora_path(name)
    if not path:
        return "Other"
    return _category_from_meta(_read_st_metadata(path))


def category_for(name):
    """Category for picker grouping: user override first, then auto-detection."""
    if not name or name == "None":
        return None
    ov = _load_usercats().get(name)
    if ov:
        return ov
    return _auto_category(name)


# ---- stack presets -------------------------------------------------------
# A "preset" is a saved LoRA stack (the rows + merge position/delimiter) the user
# can reuse in any workflow / any Lora Box. Stored by name in a small JSON next
# to the node so it persists and is shared. The prompt itself is NOT saved — it's
# per-workflow; a preset is the curated combination of LoRAs and their weights.
_PRESETS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets.json")
_PRESETS = None
MAX_PRESETS = 300
MAX_PRESET_NAME = 60
MAX_PRESET_ROWS = 64


def _load_presets():
    global _PRESETS
    if _PRESETS is None:
        try:
            with open(_PRESETS_PATH, encoding="utf-8") as f:
                d = json.load(f)
            p = d.get("presets") if isinstance(d, dict) else None
            _PRESETS = p if isinstance(p, dict) else {}
        except Exception:
            _PRESETS = {}
    return _PRESETS


def _save_presets():
    try:
        with open(_PRESETS_PATH, "w", encoding="utf-8") as f:
            json.dump({"presets": _PRESETS}, f, indent=2, ensure_ascii=False)
    except OSError as e:
        log.warning("could not save presets.json: %s", e)


def _sanitize_preset(payload):
    """Keep only the fields a preset owns, bounded, from arbitrary client JSON."""
    if not isinstance(payload, dict):
        return None
    rows_in = payload.get("rows")
    if not isinstance(rows_in, list):
        return None
    rows = []
    for r in rows_in[:MAX_PRESET_ROWS]:
        if not isinstance(r, dict):
            continue
        row = {
            "on": bool(r.get("on", True)),
            "name": str(r.get("name", "None"))[:300],
        }
        for k in ("sm", "sc"):
            try:
                v = float(r.get(k, 1.0))
                row[k] = v if math.isfinite(v) else 1.0
            except (TypeError, ValueError):
                row[k] = 1.0
        if isinstance(r.get("trig"), str):
            row["trig"] = r["trig"][:2000]
        rows.append(row)
    out = {"rows": rows}
    if isinstance(payload.get("pos"), str):
        out["pos"] = payload["pos"][:20]
    if isinstance(payload.get("delim"), str):
        out["delim"] = payload["delim"][:20]
    return out


# ---- per-lora notes ------------------------------------------------------
# A free-text note that belongs to the LoRA (not a node), stored by name so it
# shows in every Lora Box. Useful for "what is this / recommended weight / where
# from". Lives in notes.json next to the node.
_NOTES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "notes.json")
_NOTES = None
MAX_NOTE_LEN = 2000


def _load_notes():
    global _NOTES
    if _NOTES is None:
        try:
            with open(_NOTES_PATH, encoding="utf-8") as f:
                d = json.load(f)
            n = d.get("notes") if isinstance(d, dict) else None
            _NOTES = n if isinstance(n, dict) else {}
        except Exception:
            _NOTES = {}
    return _NOTES


def _save_notes():
    try:
        with open(_NOTES_PATH, "w", encoding="utf-8") as f:
            json.dump({"notes": _NOTES}, f, indent=2, ensure_ascii=False)
    except OSError as e:
        log.warning("could not save notes.json: %s", e)


def _word_in_text(word, text):
    """True if `word` appears in `text` on word boundaries (case-insensitive).

    Used for de-duplicating trigger words against the prompt. A plain substring
    test ("man" in "woman") wrongly dropped valid triggers; we anchor on
    non-word boundaries instead, and fall back to a substring test for tokens
    that contain no word characters (so an odd token can't raise re.error).
    """
    try:
        return re.search(r"(?<!\w)" + re.escape(word) + r"(?!\w)", text, re.IGNORECASE) is not None
    except re.error:
        return word.lower() in text.lower()


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

    kept = [w.strip() for w in t.split(",") if w.strip() and not _word_in_text(w.strip(), p)]
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
    # A manually-set sidecar (<lora>.png) wins; otherwise fall back to the
    # LoRA's own preview that Civitai / model managers drop next to the file
    # (<lora>.preview.png). So a picture appears automatically when one exists,
    # and a user upload (plain suffix, checked first) overrides it.
    for suffix in ("", ".preview"):
        for ext in PREVIEW_EXTS:
            p = base + suffix + ext
            if os.path.exists(p):
                return p
    return None


# ---- auto-fetch a preview from Civitai when the lora has no local sidecar ----
# So "every lora shows a picture": if there is no <basename>.<ext> next to the
# file, look the lora up on Civitai by its SHA256 and cache the first preview
# image AS a sidecar (instant forever after). Best-effort — any failure
# (offline / not on Civitai / unknown hash) just returns None -> 404 as before.
# (ported from the timur branch)
_HASH_CACHE = OrderedDict()   # path -> (mtime, sha256)
_CIVITAI_MISS = set()         # paths we already failed to resolve; don't retry every request


def _civitai_enabled():
    """Whether to reach out to civitai.com for previews / trigger words.

    Off by default: resolving a lora means hashing the whole file and sending
    that hash to a third party, which a public node must not do silently. Opt in
    with the env var LORABOX_CIVITAI=1 (any of 1/true/yes/on).
    """
    return str(os.environ.get("LORABOX_CIVITAI", "")).strip().lower() in ("1", "true", "yes", "on")


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
    """No local sidecar -> resolve on Civitai by file hash, save <base>.<ext>. Blocking."""
    if not _civitai_enabled():
        return None
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


_CIVITAI_TRIG = {}           # path -> [words]   (resolved Civitai trainedWords)
_CIVITAI_TRIG_MISS = set()   # paths with no Civitai match / no trainedWords


def _fetch_civitai_triggers(name):
    """No local trigger source -> resolve trainedWords on Civitai by file hash.

    Blocking (hash + network); call it OFF the event loop. Best-effort and
    cached, so a hit is instant afterwards and a miss is never retried. This is
    only wired into the /lorabox/triggers route, never into graph execution.
    """
    if not _civitai_enabled():
        return []
    path = _safe_lora_path(name)
    if not path or path in _CIVITAI_TRIG_MISS:
        return []
    if path in _CIVITAI_TRIG:
        return _CIVITAI_TRIG[path]
    try:
        sha = _sha256(path)
        meta = json.loads(_http_get(
            "https://civitai.com/api/v1/model-versions/by-hash/" + sha, 12).decode("utf-8"))
        out = [str(w).strip() for w in (meta.get("trainedWords") or []) if str(w).strip()][:50]
        if out:
            _CIVITAI_TRIG[path] = out
            return out
        _CIVITAI_TRIG_MISS.add(path)
    except Exception as e:
        _CIVITAI_TRIG_MISS.add(path)
        log.info("Civitai trigger fetch failed for %s: %s", name, e)
    return []


_CIVITAI_INFO = {}           # path -> {"url":..., "words":[...]}
_CIVITAI_INFO_MISS = set()


def _fetch_civitai_info(name):
    """Resolve a lora's Civitai model page URL + trained words by file hash.

    Blocking (hash + network); call OFF the event loop. Opt-in (same gate as the
    other Civitai lookups) and cached. Returns {} when disabled / not found.
    """
    if not _civitai_enabled():
        return {}
    path = _safe_lora_path(name)
    if not path or path in _CIVITAI_INFO_MISS:
        return {}
    if path in _CIVITAI_INFO:
        return _CIVITAI_INFO[path]
    try:
        sha = _sha256(path)
        meta = json.loads(_http_get(
            "https://civitai.com/api/v1/model-versions/by-hash/" + sha, 12).decode("utf-8"))
        model_id = meta.get("modelId")
        ver_id = meta.get("id")
        if not model_id:
            _CIVITAI_INFO_MISS.add(path)
            return {}
        url = "https://civitai.com/models/%s" % model_id
        if ver_id:
            url += "?modelVersionId=%s" % ver_id
        words = [str(w).strip() for w in (meta.get("trainedWords") or []) if str(w).strip()][:50]
        info = {"url": url, "words": words}
        _CIVITAI_INFO[path] = info
        return info
    except Exception as e:
        _CIVITAI_INFO_MISS.add(path)
        log.info("Civitai info fetch failed for %s: %s", name, e)
        return {}


# Optional API routes so the UI can show trigger words / preview images.
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/lorabox/triggers")
    async def _lorabox_triggers(request):
        file = request.query.get("file", "")
        # both paths block: the local one reads the safetensors header from disk
        # (real I/O on a cold cache), the Civitai one hashes the file + hits the
        # network — keep the event loop free for both.
        loop = asyncio.get_event_loop()
        words = await loop.run_in_executor(None, trigger_words_for, file)
        if not words:
            words = await loop.run_in_executor(None, _fetch_civitai_triggers, file)
        return web.json_response({"file": file, "words": words})

    def _all_categories():
        """Map every registered lora to a picker group (name + metadata).

        Blocking: filename-unmatched loras have their safetensors header read
        from disk, so on a large collection (cold cache) this is real I/O — run
        it off the event loop so the first picker open doesn't stall the UI.
        """
        cats = {}
        try:
            names = folder_paths.get_filename_list("loras")
        except Exception:
            names = []
        for name in names:
            if name and name != "None":
                cats[name] = category_for(name)
        return cats

    @PromptServer.instance.routes.get("/lorabox/categories")
    async def _lorabox_categories(request):
        cats = await asyncio.get_event_loop().run_in_executor(None, _all_categories)
        return web.json_response({"categories": cats})

    @PromptServer.instance.routes.get("/lorabox/usercats")
    async def _lorabox_usercats_get(request):
        return web.json_response({"overrides": dict(_load_usercats())})

    @PromptServer.instance.routes.post("/lorabox/usercats")
    async def _lorabox_usercats_post(request):
        """Set (or clear, when group is empty) a lora's custom picker group."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        name = body.get("name", "")
        if not _safe_lora_path(name):           # only real registered loras
            return web.json_response({"ok": False, "error": "unknown lora"}, status=400)
        group = str(body.get("group", "") or "").strip()[:MAX_CAT_LEN]
        cats = _load_usercats()
        if group:
            cats[name] = group
        else:
            cats.pop(name, None)                # empty -> revert to auto-detect
        _save_usercats()
        return web.json_response({"ok": True, "name": name, "group": group or category_for(name)})

    @PromptServer.instance.routes.get("/lorabox/presets")
    async def _lorabox_presets_get(request):
        return web.json_response({"presets": dict(_load_presets())})

    @PromptServer.instance.routes.post("/lorabox/presets")
    async def _lorabox_presets_post(request):
        """Save (overwrite) a named stack preset."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        name = str(body.get("name", "") or "").strip()[:MAX_PRESET_NAME]
        if not name:
            return web.json_response({"ok": False, "error": "empty name"}, status=400)
        data = _sanitize_preset(body.get("data"))
        if data is None:
            return web.json_response({"ok": False, "error": "bad preset"}, status=400)
        presets = _load_presets()
        if name not in presets and len(presets) >= MAX_PRESETS:
            return web.json_response({"ok": False, "error": "too many presets"}, status=400)
        presets[name] = data
        _save_presets()
        return web.json_response({"ok": True, "name": name})

    @PromptServer.instance.routes.delete("/lorabox/presets")
    async def _lorabox_presets_del(request):
        name = str(request.query.get("name", "") or "").strip()
        presets = _load_presets()
        existed = presets.pop(name, None) is not None
        if existed:
            _save_presets()
        return web.json_response({"ok": existed})

    @PromptServer.instance.routes.get("/lorabox/note")
    async def _lorabox_note_get(request):
        name = request.query.get("file", "")
        return web.json_response({"file": name, "note": _load_notes().get(name, "")})

    @PromptServer.instance.routes.post("/lorabox/note")
    async def _lorabox_note_post(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        name = body.get("name", "")
        if not _safe_lora_path(name):           # only real registered loras
            return web.json_response({"ok": False, "error": "unknown lora"}, status=400)
        note = str(body.get("note", "") or "")[:MAX_NOTE_LEN]
        notes = _load_notes()
        if note.strip():
            notes[name] = note
        else:
            notes.pop(name, None)               # empty clears it
        _save_notes()
        return web.json_response({"ok": True, "note": note})

    @PromptServer.instance.routes.get("/lorabox/civitai")
    async def _lorabox_civitai_get(request):
        """Civitai model-page URL + trained words for a lora (opt-in; off → {})."""
        file = request.query.get("file", "")
        info = await asyncio.get_event_loop().run_in_executor(None, _fetch_civitai_info, file)
        return web.json_response({"file": file, **(info or {})})

    @PromptServer.instance.routes.get("/lorabox/preview")
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

    @PromptServer.instance.routes.post("/lorabox/preview")
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

    @PromptServer.instance.routes.delete("/lorabox/preview")
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

    @PromptServer.instance.routes.post("/lorabox/preview/generate")
    async def _lorabox_preview_generate(request):
        """Render a quick Z-Image test image and save it as the lora sidecar."""
        lora = request.query.get("file", "")
        kind = request.query.get("kind", "character")
        if not _preview_base(lora):
            return web.json_response({"ok": False, "error": "unknown lora"}, status=400)
        try:
            try:
                from .preview_generate import generate_lora_preview
            except ImportError:
                from preview_generate import generate_lora_preview
            path = await generate_lora_preview(lora, kind)
            return web.json_response({"ok": True, "path": os.path.basename(path)})
        except TimeoutError as ex:
            return web.json_response({"ok": False, "error": str(ex)}, status=504)
        except Exception as ex:
            log.exception("preview generate failed for %s", lora)
            return web.json_response({"ok": False, "error": str(ex)}, status=500)
except Exception as e:  # pragma: no cover - server may be unavailable at import
    log.warning("could not register /lorabox routes: %s", e)


class LoraBox:
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
        pos, delim = "beginning", ", "
        if isinstance(obj, dict):
            muted = bool(obj.get("mute"))
            pos = obj.get("pos", "beginning") or "beginning"
            delim = obj.get("delim", ", ")
            if delim is None:
                delim = ", "
            rows = obj.get("rows")
            rows = rows if isinstance(rows, list) else []
        elif isinstance(obj, list):
            rows = obj
        else:
            rows = []

        # Trigger-word auto-merge can be turned off entirely (pos == "off"): the
        # prompt then passes through untouched (the LoRAs still load).
        triggers_off = str(pos).lower() == "off"

        # The positive prompt can arrive on the connected `prompt` input OR be
        # typed into the node's own panel (stored in data as "prompt"). The
        # connected input wins when it carries text; otherwise we fall back to the
        # panel value — so the node still works when the UI's graph→prompt
        # conversion drops a primitive feeding the prompt socket. When the user
        # hides the in-node Prompt editor (promptShow == False) the panel value is
        # not used — only a connected prompt is.
        prompt_show = obj.get("promptShow", True) if isinstance(obj, dict) else True
        panel_prompt = obj.get("prompt") if (isinstance(obj, dict) and prompt_show) else None
        eff_prompt = prompt if (isinstance(prompt, str) and prompt.strip()) else (panel_prompt or "")

        if muted:
            # Muted: no LoRA applied, no triggers — pass the prompt through
            # untouched so a connected prompt still reaches the encoder.
            return (model, clip, eff_prompt)

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
            # allow negative ("anti-LoRA") and >1 weights; the UI lets you type any
            # value, so clamp only to a generous safety range (matches clampV in
            # web/lora_box.js) instead of the slider's 0…2 visual range.
            sm = max(-10.0, min(10.0, sm))
            sc = max(-10.0, min(10.0, sc))
            if sm == 0.0 and sc == 0.0:
                continue
            lora = self._get_lora(name)
            if lora is None:
                continue
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora, sm, sc)
            applied.append(f"{name} (m={sm}, c={sc})")
            # manual trigger override (row.trig) wins over auto-detection
            if not triggers_off:
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
        merged = eff_prompt if triggers_off else merge_prompt(eff_prompt, tw, pos, delim)
        return (model, clip, merged)


POS_END = "end (append after prompt)"
POS_BEGIN = "beginning (prepend before prompt)"


class LoraBoxPromptMerge:
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
    "LoraBox": LoraBox,
    "LoraBoxPromptMerge": LoraBoxPromptMerge,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraBox": "Afloy LoRA Box",
    "LoraBoxPromptMerge": "Prompt + Triggers (Lora Box)",
}
