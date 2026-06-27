"""Tests for canonical preview prompt building (no ComfyUI queue)."""

import os
import sys
import json
import types
import struct
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

_LORAS = {}

# comfy stubs (folder_paths is patched in-place on lora_box in setUp)
_comfy = types.ModuleType("comfy")
_comfy_sd = types.ModuleType("comfy.sd")
_comfy_utils = types.ModuleType("comfy.utils")
_comfy_sd.load_lora_for_models = lambda *a: a[:2]
_comfy_utils.load_torch_file = lambda path, safe_load=True: {}
_comfy.sd = _comfy_sd
_comfy.utils = _comfy_utils
sys.modules.setdefault("folder_paths", types.ModuleType("folder_paths"))
sys.modules["comfy"] = _comfy
sys.modules["comfy.sd"] = _comfy_sd
sys.modules["comfy.utils"] = _comfy_utils

import lora_box  # noqa: E402
import preview_generate  # noqa: E402


def _write_lora(name, meta=None):
    fd, path = tempfile.mkstemp(suffix=".safetensors")
    os.close(fd)
    meta = meta or {}
    header = json.dumps({"__metadata__": meta}).encode("utf-8")
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(header)))
        f.write(header)
    _LORAS[name] = path
    return path


class TestPreviewGenerate(unittest.TestCase):
    def setUp(self):
        _LORAS.clear()
        lora_box.folder_paths.get_filename_list = lambda kind: list(_LORAS.keys())
        lora_box.folder_paths.get_full_path = lambda kind, name: _LORAS.get(name)
        preview_generate.folder_paths.get_filename_list = lambda kind: list(_LORAS.keys())
        # the preview pipeline now resolves its UNet/CLIP/VAE against the installed
        # list; register the defaults so a normal build succeeds in tests.
        for m in (preview_generate.PREVIEW_CONFIG["unet_name"],
                  preview_generate.PREVIEW_CONFIG["clip_name"],
                  preview_generate.PREVIEW_CONFIG["vae_name"]):
            _LORAS[m] = "/fake/" + m

    def test_build_includes_lora_and_triggers(self):
        _write_lora("hero.safetensors", {"ss_trigger_words": "herotok"})
        p = preview_generate.build_preview_prompt("hero.safetensors", "character")
        lora = next(v for v in p.values() if v["class_type"] == "LoraLoader")
        self.assertEqual(lora["inputs"]["lora_name"], "hero.safetensors")
        pos = next(v for v in p.values() if v["class_type"] == "CLIPTextEncode"
                   and "herotok" in v["inputs"]["text"])
        self.assertIn("portrait photo", pos["inputs"]["text"])

    def test_triggers_go_in_front(self):
        # trigger words are placed in front of the base prompt for every kind
        # (stronger activation on the encoder).
        _write_lora("style.safetensors", {"trigger_phrase": "warmpastel"})
        p = preview_generate.build_preview_prompt("style.safetensors", "style")
        text = next(v["inputs"]["text"] for v in p.values()
                    if v["class_type"] == "CLIPTextEncode" and "warmpastel" in v["inputs"]["text"])
        self.assertTrue(text.index("warmpastel") < text.index("cafe"))

    def test_fixed_seed_in_sampler(self):
        _write_lora("x.safetensors")
        p = preview_generate.build_preview_prompt("x.safetensors")
        samp = next(v for v in p.values() if v["class_type"] == "KSampler")
        self.assertEqual(samp["inputs"]["seed"], preview_generate.PREVIEW_CONFIG["seed"])

    def test_missing_models_raise_clear_error(self):
        # nothing but the lora installed -> Generate fails with an explicit
        # "models not installed" message instead of a KSampler stack trace
        _LORAS.clear()
        _write_lora("z.safetensors")
        with self.assertRaises(RuntimeError) as cm:
            preview_generate.build_preview_prompt("z.safetensors")
        self.assertIn("aren't installed", str(cm.exception))

    def test_models_resolved_leniently(self):
        # a differently-suffixed build is still found via the stem substring
        _LORAS.clear()
        _write_lora("hero.safetensors", {"ss_trigger_words": "t"})
        _LORAS["z_image_turbo_bf16_fp8.safetensors"] = "/fake/u"
        _LORAS["qwen_3_4b.safetensors"] = "/fake/c"
        _LORAS["ae.safetensors"] = "/fake/v"
        p = preview_generate.build_preview_prompt("hero.safetensors")
        unet = next(v for v in p.values() if v["class_type"] == "UNETLoader")
        self.assertEqual(unet["inputs"]["unet_name"], "z_image_turbo_bf16_fp8.safetensors")


if __name__ == "__main__":
    unittest.main()
