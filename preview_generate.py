"""Headless canonical preview generation for Lora Box.

Builds a minimal Z-Image Turbo API prompt, queues it on the running ComfyUI
instance, waits for SaveImage output, and writes a resized PNG sidecar next to
the LoRA file.
"""

from __future__ import annotations

import os
import json
import time
import uuid
import asyncio
import logging
import shutil

import folder_paths

try:
    from .lora_box import trigger_words_for, merge_prompt, _preview_base, PREVIEW_EXTS
except ImportError:
    from lora_box import trigger_words_for, merge_prompt, _preview_base, PREVIEW_EXTS

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


def build_preview_prompt(lora_name: str, kind: str = "character") -> dict:
    """Return a ComfyUI API prompt dict for one canonical preview image."""
    kind = (kind or "character").lower()
    if kind not in PREVIEW_PROMPTS:
        kind = "character"

    triggers = ", ".join(trigger_words_for(lora_name))
    base = PREVIEW_PROMPTS[kind]
    # trigger words go in front by default (stronger activation on the encoder)
    positive = merge_prompt(base, triggers, "beginning", ", ")

    cfg = _load_config()
    unet = _resolve_model(("diffusion_models", "unet"), cfg["unet_name"])
    clip = _resolve_model(("text_encoders", "clip"), cfg["clip_name"])
    vae = _resolve_model(("vae",), cfg["vae_name"])
    missing = []
    if not unet:
        missing.append("UNet/diffusion model '%s'" % cfg["unet_name"])
    if not clip:
        missing.append("CLIP/text-encoder '%s'" % cfg["clip_name"])
    if not vae:
        missing.append("VAE '%s'" % cfg["vae_name"])
    if missing:
        raise RuntimeError(
            "Preview generation needs Z-Image Turbo models that aren't installed: "
            + "; ".join(missing)
            + ". Install them, or point LoRA Box at your own models via a "
            "preview_config.json next to the node (or the LORABOX_PREVIEW_UNET / "
            "_CLIP / _VAE env vars). You can always set a picture with Upload or "
            "drag-and-drop instead.")

    return {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": unet, "weight_dtype": "default"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": clip,
                "type": cfg["clip_type"],
                "device": "default",
            },
        },
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "4": {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {"model": ["1", 0], "shift": cfg["aura_shift"]},
        },
        "5": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["4", 0],
                "clip": ["2", 0],
                "lora_name": lora_name,
                "strength_model": cfg["lora_strength_model"],
                "strength_clip": cfg["lora_strength_clip"],
            },
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["5", 1], "text": positive},
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["5", 1], "text": cfg["negative"]},
        },
        "8": {
            "class_type": "EmptySD3LatentImage",
            "inputs": {
                "width": cfg["width"],
                "height": cfg["height"],
                "batch_size": 1,
            },
        },
        "9": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["5", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["8", 0],
                "seed": cfg["seed"],
                "steps": cfg["steps"],
                "cfg": cfg["cfg"],
                "sampler_name": cfg["sampler_name"],
                "scheduler": cfg["scheduler"],
                "denoise": cfg["denoise"],
            },
        },
        "10": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["9", 0], "vae": ["3", 0]},
        },
        SAVE_NODE_ID: {
            "class_type": "SaveImage",
            "inputs": {
                "images": ["10", 0],
                "filename_prefix": "lorabox_preview",
            },
        },
    }


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


async def _queue_and_wait(prompt_dict: dict, timeout: int = PREVIEW_TIMEOUT_S) -> dict:
    import execution
    from server import PromptServer

    server = PromptServer.instance
    prompt_id = str(uuid.uuid4())
    valid = await execution.validate_prompt(prompt_id, prompt_dict, None)
    if not valid[0]:
        raise RuntimeError(str(valid[1]))

    number = server.number
    server.number += 1
    extra_data = {"client_id": "lorabox_preview", "create_time": int(time.time() * 1000)}
    server.prompt_queue.put(
        (number, prompt_id, prompt_dict, extra_data, valid[2], {})
    )
    log.info("[LoraBox] preview queued id=%s", prompt_id)

    deadline = time.time() + timeout
    while time.time() < deadline:
        await asyncio.sleep(0.75)
        hist = server.prompt_queue.get_history(prompt_id=prompt_id)
        if prompt_id not in hist:
            continue
        entry = hist[prompt_id]
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
