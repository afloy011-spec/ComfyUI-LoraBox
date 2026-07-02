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
        self.assertIn("portrait", pos["inputs"]["text"])

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

    # --- cross-architecture engines ------------------------------------------
    def test_engine_for_by_category(self):
        _write_lora("flux_char.safetensors")
        _write_lora("my_sdxl.safetensors")
        _write_lora("anime_sd15.safetensors")
        _write_lora("plain_zimage.safetensors")
        self.assertEqual(preview_generate.engine_for("flux_char.safetensors"), "flux")
        self.assertEqual(preview_generate.engine_for("my_sdxl.safetensors"), "sdxl")
        self.assertEqual(preview_generate.engine_for("anime_sd15.safetensors"), "sd15")
        self.assertEqual(preview_generate.engine_for("plain_zimage.safetensors"), "zimage")

    def test_flux_graph_shape(self):
        _write_lora("flux_char.safetensors", {"trigger_phrase": "fluxtok"})
        for m in ("flux1-dev.safetensors", "clip_l.safetensors",
                  "t5xxl_fp16.safetensors", "ae.safetensors"):
            _LORAS[m] = "/fake/" + m
        p = preview_generate.build_preview_prompt("flux_char.safetensors")
        kinds = {v["class_type"] for v in p.values()}
        self.assertIn("DualCLIPLoader", kinds)
        self.assertIn("FluxGuidance", kinds)
        lora = next(v for v in p.values() if v["class_type"] == "LoraLoader")
        self.assertEqual(lora["inputs"]["lora_name"], "flux_char.safetensors")

    def test_sdxl_graph_uses_checkpoint(self):
        _write_lora("my_sdxl.safetensors", {"trigger_phrase": "xltok"})
        _LORAS["sd_xl_base_1.0.safetensors"] = "/fake/ckpt"
        p = preview_generate.build_preview_prompt("my_sdxl.safetensors")
        kinds = {v["class_type"] for v in p.values()}
        self.assertIn("CheckpointLoaderSimple", kinds)
        self.assertIn("EmptyLatentImage", kinds)
        # vae comes from the checkpoint (slot 2), not a separate VAELoader
        self.assertNotIn("VAELoader", kinds)
        dec = next(v for v in p.values() if v["class_type"] == "VAEDecode")
        self.assertEqual(dec["inputs"]["vae"], ["1", 2])

    def test_missing_flux_models_name_the_engine(self):
        _write_lora("flux_char.safetensors")  # no flux models installed
        with self.assertRaises(RuntimeError) as cm:
            preview_generate.build_preview_prompt("flux_char.safetensors")
        self.assertIn("Flux", str(cm.exception))
        self.assertIn("aren't installed", str(cm.exception))

    def test_engine_ignores_user_category(self):
        # a custom picker group ("My characters") says nothing about the
        # architecture — the engine must come from auto-detection, not the
        # user's grouping (a re-grouped flux lora used to hit the default engine)
        _write_lora("flux_char.safetensors")
        old = lora_box._USERCATS
        lora_box._USERCATS = {"flux_char.safetensors": "My characters"}
        try:
            self.assertEqual(preview_generate.engine_for("flux_char.safetensors"), "flux")
        finally:
            lora_box._USERCATS = old

    def test_ltx_video_lora_refused(self):
        _write_lora("dance_ltx.safetensors")
        with self.assertRaises(RuntimeError) as cm:
            preview_generate.build_preview_prompt("dance_ltx.safetensors")
        self.assertIn("LTX", str(cm.exception))
        self.assertIn("Upload", str(cm.exception))

    def test_row_strengths_used(self):
        # the row's weights land on the LoraLoader instead of the 0.9 default
        _write_lora("hero.safetensors")
        p = preview_generate.build_preview_prompt(
            "hero.safetensors", "character", strength_model=0.55, strength_clip=0.6)
        lora = next(v for v in p.values() if v["class_type"] == "LoraLoader")
        self.assertEqual(lora["inputs"]["strength_model"], 0.55)
        self.assertEqual(lora["inputs"]["strength_clip"], 0.6)

    def test_default_strength_when_not_passed(self):
        _write_lora("hero.safetensors")
        p = preview_generate.build_preview_prompt("hero.safetensors")
        lora = next(v for v in p.values() if v["class_type"] == "LoraLoader")
        self.assertEqual(lora["inputs"]["strength_model"],
                         preview_generate.PREVIEW_CONFIG["lora_strength_model"])

    def test_custom_prompt_override(self):
        # an explicit prompt replaces the kind base but keeps the triggers
        _write_lora("hero.safetensors", {"ss_trigger_words": "herotok"})
        p = preview_generate.build_preview_prompt(
            "hero.safetensors", "character", prompt_override="a red fox in deep snow")
        text = next(v["inputs"]["text"] for v in p.values()
                    if v["class_type"] == "CLIPTextEncode" and "herotok" in v["inputs"]["text"])
        self.assertIn("a red fox in deep snow", text)
        self.assertNotIn("portrait", text)

    def test_sidecar_preview_prompt(self):
        # a <lora>.preview.txt next to the file becomes the persistent base prompt
        path = _write_lora("hero.safetensors")
        txt = os.path.splitext(path)[0] + ".preview.txt"
        with open(txt, "w", encoding="utf-8") as f:
            f.write("standing on a mountain ridge at dawn\n")
        try:
            p = preview_generate.build_preview_prompt("hero.safetensors")
            text = next(v["inputs"]["text"] for v in p.values()
                        if v["class_type"] == "CLIPTextEncode"
                        and "mountain ridge" in v["inputs"]["text"])
            self.assertNotIn("portrait", text)
        finally:
            os.remove(txt)

    def test_object_kind_prompt(self):
        _write_lora("hero.safetensors")
        p = preview_generate.build_preview_prompt("hero.safetensors", "object")
        texts = [v["inputs"]["text"] for v in p.values() if v["class_type"] == "CLIPTextEncode"]
        self.assertTrue(any("plain surface" in t for t in texts))


if __name__ == "__main__":
    unittest.main()
