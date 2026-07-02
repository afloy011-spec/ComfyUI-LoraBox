"""Headless canonical preview generation for Lora Box.

Builds a minimal API prompt for the LoRA's architecture (Z-Image / Flux / SDXL /
SD1.5), queues it on the running ComfyUI instance, waits for the SaveImage
output, and writes a resized PNG sidecar next to the LoRA file. The engine is
chosen from the LoRA's detected category; the seed and base prompts are shared
so thumbnails stay comparable, and missing models fail with a clear message.
"""

from __future__ import annotations

import os
import json
import time
import asyncio
import logging
import shutil

import folder_paths

try:
    from .lora_box import (trigger_words_for, merge_prompt, _preview_base,
                           category_for, PREVIEW_EXTS)
except ImportError:
    from lora_box import (trigger_words_for, merge_prompt, _preview_base,
                          category_for, PREVIEW_EXTS)

log = logging.getLogger("LoraBox.preview")

# The built-in "✨ Generate" pipeline renders a quick Z-Image Turbo test image.
# These defaults target a stock Z-Image Turbo install; on any other setup either
# install those models, drop a `preview_config.json` next to this file, or set
# the LORABOX_PREVIEW_UNET / _CLIP / _VAE env vars to point at your own models.
# (Upload / drag-and-drop and the auto/Civitai sidecar work regardless.)
PREVIEW_CONFIG = {
    "unet_name": "z_image_turbo_bf16.safetensors",
    "clip_name": "qwen_3_4b.safetensors",
    "clip_type": "lumina2",
    "vae_name": "ae.safetensors",
    "aura_shift": 3,
    "seed": 42424242,
    "steps": 8,
    "cfg": 1.0,
    "sampler_name": "euler",
    "scheduler": "simple",
    "denoise": 1.0,
    "width": 1024,
    "height": 1024,
    "lora_strength_model": 0.9,
    "lora_strength_clip": 0.9,
    "negative": "blurry ugly bad, deformed, watermark, text, low quality",
}


def _load_config() -> dict:
    """PREVIEW_CONFIG, overlaid with preview_config.json (if present) and env."""
    cfg = dict(PREVIEW_CONFIG)
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview_config.json")
    try:
        if os.path.isfile(cfg_path):
            with open(cfg_path, encoding="utf-8") as f:
                user = json.load(f)
            cfg.update({k: v for k, v in user.items() if k in PREVIEW_CONFIG})
    except Exception as e:
        log.warning("preview_config.json ignored: %s", e)
    for env, key in (("LORABOX_PREVIEW_UNET", "unet_name"),
                     ("LORABOX_PREVIEW_CLIP", "clip_name"),
                     ("LORABOX_PREVIEW_VAE", "vae_name")):
        v = os.environ.get(env)
        if v:
            cfg[key] = v
    return cfg


def _resolve_model(folders, configured) -> str | None:
    """A real installed filename for `configured`, searched across `folders`.

    Exact match wins; otherwise a case-insensitive substring match on the
    configured stem (so "ae" finds "ae.safetensors", "z_image_turbo" finds a
    differently-suffixed build). Returns None when nothing plausible exists, so
    the caller can fail with a clear, actionable message instead of a KSampler
    stack trace.
    """
    names = []
    for folder in folders:
        try:
            names += list(folder_paths.get_filename_list(folder))
        except Exception:
            pass
    if configured in names:
        return configured
    stem = os.path.splitext(os.path.basename(configured))[0].lower()
    for n in names:
        if stem and stem in n.lower():
            return n
    return None

# Base prompts are shared across all loras so thumbnails are comparable.
PREVIEW_PROMPTS = {
    "character": (
        "portrait photo, soft natural daylight, simple neutral background, "
        "relaxed pose, photorealistic, candid"
    ),
    "style": (
        "a woman reading a book in a cafe, soft daylight, natural colors, everyday scene"
    ),
}

SAVE_NODE_ID = "11"
PREVIEW_TIMEOUT_S = 180
PREVIEW_THUMB_MAX = 512

_GEN_LOCK = asyncio.Lock()

# ---- architecture engines -------------------------------------------------
# Generate picks an engine from the LoRA's detected category so a Flux / SDXL /
# SD1.5 lora renders with the right graph, not just Z-Image. Each engine is a
# (label, default models + sampler params, required model slots, graph builder).
# Models are configurable per engine via preview_config.json sections, e.g.
#   { "flux": {"unet_name": "...", "clip2_name": "..."} }
# or env vars LORABOX_PREVIEW_<ENGINE>_<KEY> (e.g. LORABOX_PREVIEW_FLUX_UNET_NAME).
# (The Z-Image engine also keeps the legacy flat LORABOX_PREVIEW_UNET/_CLIP/_VAE.)
_SEED = PREVIEW_CONFIG["seed"]
_NEG = PREVIEW_CONFIG["negative"]

ENGINE_LABELS = {"zimage": "Z-Image", "flux": "Flux", "sdxl": "SDXL", "sd15": "SD1.5"}

# category (from lora_box.category_for) -> engine key
_CATEGORY_ENGINE = {
    "Z-Image": "zimage",
    "Flux": "flux", "Krea": "flux",   # Krea is a Flux finetune
    "SDXL": "sdxl", "SD1.5": "sd15",
}

ENGINE_DEFAULTS = {
    "flux": {
        "unet_name": "flux1-dev.safetensors",
        "clip_name": "clip_l.safetensors",
        "clip2_name": "t5xxl_fp16.safetensors",
        "vae_name": "ae.safetensors",
        "guidance": 3.5,
        "seed": _SEED, "steps": 20, "cfg": 1.0,
        "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
        "width": 1024, "height": 1024,
        "lora_strength_model": 0.9, "lora_strength_clip": 0.9, "negative": _NEG,
    },
    "sdxl": {
        "checkpoint_name": "sd_xl_base_1.0.safetensors",
        "seed": _SEED, "steps": 25, "cfg": 7.0,
        "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
        "width": 1024, "height": 1024,
        "lora_strength_model": 0.9, "lora_strength_clip": 0.9, "negative": _NEG,
    },
    "sd15": {
        "checkpoint_name": "v1-5-pruned-emaonly.safetensors",
        "seed": _SEED, "steps": 25, "cfg": 7.0,
        "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
        "width": 512, "height": 512,
        "lora_strength_model": 0.9, "lora_strength_clip": 0.9, "negative": _NEG,
    },
}

# slot key -> (search folders, human label) for the missing-models message
ENGINE_SLOTS = {
    "zimage": [("unet_name", ("diffusion_models", "unet"), "UNet/diffusion model"),
               ("clip_name", ("text_encoders", "clip"), "CLIP/text-encoder"),
               ("vae_name", ("vae",), "VAE")],
    "flux": [("unet_name", ("diffusion_models", "unet"), "UNet/diffusion model"),
             ("clip_name", ("text_encoders", "clip"), "CLIP (clip_l)"),
             ("clip2_name", ("text_encoders", "clip"), "CLIP (t5xxl)"),
             ("vae_name", ("vae",), "VAE")],
    "sdxl": [("checkpoint_name", ("checkpoints",), "SDXL checkpoint")],
    "sd15": [("checkpoint_name", ("checkpoints",), "SD1.5 checkpoint")],
}


def _read_user_config() -> dict:
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview_config.json")
    try:
        if os.path.isfile(cfg_path):
            with open(cfg_path, encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        log.warning("preview_config.json ignored: %s", e)
    return {}


def _engine_cfg(engine: str) -> dict:
    """Merged config for one engine: defaults < preview_config.json < env."""
    if engine == "zimage":
        return _load_config()   # back-compat path (flat keys + LORABOX_PREVIEW_*)
    cfg = dict(ENGINE_DEFAULTS[engine])
    sect = _read_user_config().get(engine)
    if isinstance(sect, dict):
        cfg.update({k: v for k, v in sect.items() if k in cfg})
    prefix = "LORABOX_PREVIEW_%s_" % engine.upper()
    for k in list(cfg.keys()):
        v = os.environ.get(prefix + k.upper())
        if v is not None:
            cfg[k] = v
    return cfg


def _default_engine() -> str:
    e = os.environ.get("LORABOX_PREVIEW_DEFAULT_ENGINE", "zimage").strip().lower()
    return e if e in ENGINE_LABELS else "zimage"


def engine_for(lora_name: str) -> str:
    """Pick the render engine for a lora: explicit override, else its category."""
    forced = os.environ.get("LORABOX_PREVIEW_ENGINE", "").strip().lower()
    if forced in ENGINE_LABELS:
        return forced
    try:
        cat = category_for(lora_name)
    except Exception:
        cat = None
    return _CATEGORY_ENGINE.get(cat, _default_engine())


def _build_zimage(cfg, r, lora_name, positive) -> dict:
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": r["unet_name"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": r["clip_name"], "type": cfg["clip_type"], "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": r["vae_name"]}},
        "4": {"class_type": "ModelSamplingAuraFlow",
              "inputs": {"model": ["1", 0], "shift": cfg["aura_shift"]}},
        "5": {"class_type": "LoraLoader",
              "inputs": {"model": ["4", 0], "clip": ["2", 0], "lora_name": lora_name,
                         "strength_model": cfg["lora_strength_model"],
                         "strength_clip": cfg["lora_strength_clip"]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 1], "text": positive}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 1], "text": cfg["negative"]}},
        "8": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": cfg["width"], "height": cfg["height"], "batch_size": 1}},
        "9": {"class_type": "KSampler",
              "inputs": {"model": ["5", 0], "positive": ["6", 0], "negative": ["7", 0],
                         "latent_image": ["8", 0], "seed": cfg["seed"], "steps": cfg["steps"],
                         "cfg": cfg["cfg"], "sampler_name": cfg["sampler_name"],
                         "scheduler": cfg["scheduler"], "denoise": cfg["denoise"]}},
        "10": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        SAVE_NODE_ID: {"class_type": "SaveImage",
                       "inputs": {"images": ["10", 0], "filename_prefix": "lorabox_preview"}},
    }


def _build_flux(cfg, r, lora_name, positive) -> dict:
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": r["unet_name"], "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader",
              "inputs": {"clip_name1": r["clip_name"], "clip_name2": r["clip2_name"], "type": "flux"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": r["vae_name"]}},
        "5": {"class_type": "LoraLoader",
              "inputs": {"model": ["1", 0], "clip": ["2", 0], "lora_name": lora_name,
                         "strength_model": cfg["lora_strength_model"],
                         "strength_clip": cfg["lora_strength_clip"]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 1], "text": positive}},
        "12": {"class_type": "FluxGuidance",
               "inputs": {"conditioning": ["6", 0], "guidance": cfg["guidance"]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 1], "text": cfg["negative"]}},
        "8": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": cfg["width"], "height": cfg["height"], "batch_size": 1}},
        "9": {"class_type": "KSampler",
              "inputs": {"model": ["5", 0], "positive": ["12", 0], "negative": ["7", 0],
                         "latent_image": ["8", 0], "seed": cfg["seed"], "steps": cfg["steps"],
                         "cfg": cfg["cfg"], "sampler_name": cfg["sampler_name"],
                         "scheduler": cfg["scheduler"], "denoise": cfg["denoise"]}},
        "10": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        SAVE_NODE_ID: {"class_type": "SaveImage",
                       "inputs": {"images": ["10", 0], "filename_prefix": "lorabox_preview"}},
    }


def _build_checkpoint(cfg, r, lora_name, positive) -> dict:
    """SDXL / SD1.5: one CheckpointLoaderSimple feeds model, clip and vae."""
    return {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": r["checkpoint_name"]}},
        "5": {"class_type": "LoraLoader",
              "inputs": {"model": ["1", 0], "clip": ["1", 1], "lora_name": lora_name,
                         "strength_model": cfg["lora_strength_model"],
                         "strength_clip": cfg["lora_strength_clip"]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 1], "text": positive}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 1], "text": cfg["negative"]}},
        "8": {"class_type": "EmptyLatentImage",
              "inputs": {"width": cfg["width"], "height": cfg["height"], "batch_size": 1}},
        "9": {"class_type": "KSampler",
              "inputs": {"model": ["5", 0], "positive": ["6", 0], "negative": ["7", 0],
                         "latent_image": ["8", 0], "seed": cfg["seed"], "steps": cfg["steps"],
                         "cfg": cfg["cfg"], "sampler_name": cfg["sampler_name"],
                         "scheduler": cfg["scheduler"], "denoise": cfg["denoise"]}},
        "10": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["1", 2]}},
        SAVE_NODE_ID: {"class_type": "SaveImage",
                       "inputs": {"images": ["10", 0], "filename_prefix": "lorabox_preview"}},
    }


ENGINE_BUILD = {"zimage": _build_zimage, "flux": _build_flux,
                "sdxl": _build_checkpoint, "sd15": _build_checkpoint}


def build_preview_prompt(lora_name: str, kind: str = "character") -> dict:
    """Return a ComfyUI API prompt dict for one canonical preview image.

    The graph matches the LoRA's architecture (Z-Image / Flux / SDXL / SD1.5).
    Raises RuntimeError naming the missing models if that engine isn't installed.
    """
    kind = (kind or "character").lower()
    if kind not in PREVIEW_PROMPTS:
        kind = "character"

    triggers = ", ".join(trigger_words_for(lora_name))
    base = PREVIEW_PROMPTS[kind]
    # trigger words go in front by default (stronger activation on the encoder)
    positive = merge_prompt(base, triggers, "beginning", ", ")

    engine = engine_for(lora_name)
    cfg = _engine_cfg(engine)
    resolved, missing = {}, []
    for key, folders, label in ENGINE_SLOTS[engine]:
        got = _resolve_model(folders, cfg[key])
        if got:
            resolved[key] = got
        else:
            missing.append("%s '%s'" % (label, cfg[key]))
    if missing:
        raise RuntimeError(
            "Preview generation for this %s LoRA needs models that aren't installed: "
            % ENGINE_LABELS[engine]
            + "; ".join(missing)
            + ". Install them, or configure LoRA Box (a preview_config.json next to "
            "the node, or LORABOX_PREVIEW_* env vars). You can always set a picture "
            "with Upload or drag-and-drop instead.")

    return ENGINE_BUILD[engine](cfg, resolved, lora_name, positive)


def _comfy_image_path(img_info: dict) -> str:
    filename = img_info["filename"]
    subfolder = img_info.get("subfolder") or ""
    folder_type = img_info.get("type", "output")
    if folder_type == "output":
        base = folder_paths.get_output_directory()
    elif folder_type == "input":
        base = folder_paths.get_input_directory()
    else:
        base = folder_paths.get_temp_directory()
    return os.path.join(base, subfolder, filename) if subfolder else os.path.join(base, filename)


def _write_sidecar_png(lora_name: str, src_path: str) -> str:
    """Resize (if Pillow available) and save as <lora>.png sidecar."""
    base = _preview_base(lora_name)
    if not base:
        raise ValueError("unknown lora")
    dest = base + ".png"
    for ext in PREVIEW_EXTS:
        try:
            os.remove(base + ext)
        except OSError:
            pass
    try:
        from PIL import Image

        with Image.open(src_path) as im:
            im = im.convert("RGB")
            im.thumbnail((PREVIEW_THUMB_MAX, PREVIEW_THUMB_MAX), Image.Resampling.LANCZOS)
            im.save(dest, "PNG", optimize=True)
    except Exception as ex:
        log.warning("Pillow resize failed (%s), copying raw image", ex)
        shutil.copy2(src_path, dest)
    return dest


def _server_base_url() -> str:
    """Loopback URL of the running ComfyUI HTTP server.

    The listen address may be a wildcard (0.0.0.0 / ::) or IPv6 — plain IPv4
    loopback reaches all of those from inside the same process.
    """
    from server import PromptServer

    server = PromptServer.instance
    port = getattr(server, "port", None) or 8188
    addr = str(getattr(server, "address", "") or "")
    # newer ComfyUI accepts a comma-separated listen list — take the first entry
    addr = addr.split(",")[0].strip()
    if not addr or addr in ("0.0.0.0", "::") or ":" in addr:
        addr = "127.0.0.1"
    scheme = "http"
    try:
        from comfy.cli_args import args as _args
        if getattr(_args, "tls_keyfile", None):
            scheme = "https"
    except Exception:
        pass
    return "%s://%s:%s" % (scheme, addr, port)


async def _queue_and_wait(prompt_dict: dict, timeout: int = PREVIEW_TIMEOUT_S) -> dict:
    """Queue the graph and wait for its image via the PUBLIC HTTP API.

    POST /prompt + GET /history/{id} are the endpoints external clients use and
    are stable across ComfyUI versions — unlike the in-process prompt_queue
    internals (whose tuple shape has changed before), which this deliberately
    avoids. Validation errors come back in the /prompt 400 response.
    """
    import aiohttp

    base = _server_base_url()
    # self-signed TLS (--tls-keyfile) would fail loopback cert verification
    connector = aiohttp.TCPConnector(ssl=False) if base.startswith("https") else None
    async with aiohttp.ClientSession(connector=connector) as sess:
        payload = {"prompt": prompt_dict, "client_id": "lorabox_preview"}
        async with sess.post(base + "/prompt", json=payload) as r:
            try:
                body = await r.json(content_type=None)
            except Exception:
                body = None    # non-JSON reply (proxy error page etc.)
            if r.status != 200:
                err = (body or {}).get("error") or body or ("HTTP %s from /prompt" % r.status)
                if isinstance(err, dict):
                    err = err.get("message") or err
                raise RuntimeError(str(err))
            prompt_id = (body or {}).get("prompt_id")
            if not prompt_id:
                raise RuntimeError("queueing returned no prompt_id: %s" % (body,))
        log.info("[LoraBox] preview queued id=%s", prompt_id)

        deadline = time.time() + timeout
        while time.time() < deadline:
            await asyncio.sleep(0.75)
            async with sess.get(base + "/history/" + prompt_id) as r:
                if r.status != 200:
                    continue
                try:
                    hist = await r.json(content_type=None)
                except Exception:
                    continue
            entry = (hist or {}).get(prompt_id)
            if not entry:
                continue
            status = entry.get("status") or {}
            for msg in status.get("messages") or []:
                if isinstance(msg, (list, tuple)) and msg and msg[0] == "execution_error":
                    raise RuntimeError(str(msg[1]))
            if not status.get("completed"):
                continue
            outputs = entry.get("outputs") or {}
            if SAVE_NODE_ID in outputs and outputs[SAVE_NODE_ID].get("images"):
                return outputs[SAVE_NODE_ID]["images"][0]
            for out in outputs.values():
                if out.get("images"):
                    return out["images"][0]
            raise RuntimeError("generation finished but produced no image")
    raise TimeoutError(f"preview timed out after {timeout}s")


async def generate_lora_preview(lora_name: str, kind: str = "character") -> str:
    """Queue a canonical preview, save sidecar PNG; returns sidecar path."""
    if not _preview_base(lora_name):
        raise ValueError("unknown lora")

    async with _GEN_LOCK:
        prompt = build_preview_prompt(lora_name, kind)
        img_info = await _queue_and_wait(prompt)
        src = _comfy_image_path(img_info)
        if not os.path.isfile(src):
            raise FileNotFoundError(f"output missing: {src}")
        sidecar = _write_sidecar_png(lora_name, src)
        log.info("[LoraBox] preview saved -> %s", sidecar)
        return sidecar
