"""Unit tests for LoraBox backend.

ComfyUI is not importable in CI, so we stub `folder_paths` and `comfy.*` in
sys.modules before importing the node. The stubs record what gets applied so we
can assert on it.
"""

import os
import sys
import json
import types
import struct
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# --- stub registered loras: name -> on-disk path -------------------------------
_LORAS = {}

_fp = types.ModuleType("folder_paths")
_fp.get_filename_list = lambda kind: list(_LORAS.keys())
_fp.get_full_path = lambda kind, name: _LORAS.get(name)
sys.modules["folder_paths"] = _fp

# --- stub comfy.sd / comfy.utils ----------------------------------------------
_APPLIED = []  # list of (lora_name, sm, sc)

_comfy = types.ModuleType("comfy")
_comfy_sd = types.ModuleType("comfy.sd")
_comfy_utils = types.ModuleType("comfy.utils")


def _load_lora_for_models(model, clip, lora, sm, sc):
    _APPLIED.append((lora["_name"], sm, sc))
    return (list(model) + [("m", sm)], list(clip) + [("c", sc)])


_comfy_sd.load_lora_for_models = _load_lora_for_models
_comfy_utils.load_torch_file = lambda path, safe_load=True: {"_name": os.path.basename(path)}
_comfy.sd = _comfy_sd
_comfy.utils = _comfy_utils
sys.modules["comfy"] = _comfy
sys.modules["comfy.sd"] = _comfy_sd
sys.modules["comfy.utils"] = _comfy_utils

import lora_box  # noqa: E402


def _make_safetensors(path, metadata):
    """Write a minimal valid safetensors file carrying __metadata__."""
    header = {"__metadata__": metadata,
              "w": {"dtype": "F16", "shape": [1], "data_offsets": [0, 2]}}
    hb = json.dumps(header).encode("utf-8")
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(hb)))
        f.write(hb)
        f.write(b"\x00\x00")


class LoraBoxTest(unittest.TestCase):
    def setUp(self):
        _APPLIED.clear()
        _LORAS.clear()
        lora_box._META_CACHE.clear()
        self.tmp = tempfile.mkdtemp()
        self.a = os.path.join(self.tmp, "a.safetensors")
        _make_safetensors(self.a, {"trigger_phrase": "alpha, beta"})
        _LORAS["a.safetensors"] = self.a
        self.node = lora_box.LoraBox()

    def _apply(self, rows, mute=False):
        data = json.dumps({"v": 1, "mute": mute, "rows": rows})
        return self.node.apply([], [], data)

    # --- security -------------------------------------------------------------
    def test_safe_path_rejects_unknown(self):
        self.assertIsNone(lora_box._safe_lora_path("../../secret.safetensors"))
        self.assertIsNone(lora_box._safe_lora_path("not_registered.safetensors"))

    def test_safe_path_accepts_registered(self):
        self.assertEqual(lora_box._safe_lora_path("a.safetensors"), self.a)

    # --- strength validation --------------------------------------------------
    def test_nan_strength_rejected(self):
        self._apply([{"on": True, "name": "a.safetensors", "sm": float("nan")}])
        self.assertEqual(_APPLIED, [])

    def test_inf_strength_rejected(self):
        self._apply([{"on": True, "name": "a.safetensors", "sm": float("inf")}])
        self.assertEqual(_APPLIED, [])

    def test_strength_clamped(self):
        self._apply([{"on": True, "name": "a.safetensors", "sm": 5, "sc": -3}])
        # sm clamps to 2.0; sc clamps to 0.0 (not both zero, so still applied)
        self.assertEqual(_APPLIED, [("a.safetensors", 2.0, 0.0)])

    def test_both_zero_skipped(self):
        self._apply([{"on": True, "name": "a.safetensors", "sm": 0, "sc": 0}])
        self.assertEqual(_APPLIED, [])

    def test_bad_type_skipped(self):
        self._apply([{"on": True, "name": "a.safetensors", "sm": "abc"}])
        self.assertEqual(_APPLIED, [])

    # --- row semantics --------------------------------------------------------
    def test_disabled_row_skipped(self):
        self._apply([{"on": False, "name": "a.safetensors", "sm": 1.0}])
        self.assertEqual(_APPLIED, [])

    def test_mute_skips_everything(self):
        m, c, tw = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}], mute=True)
        self.assertEqual(_APPLIED, [])
        self.assertEqual(tw, "")

    def test_none_name_skipped(self):
        self._apply([{"on": True, "name": "None", "sm": 1.0}])
        self.assertEqual(_APPLIED, [])

    def test_legacy_bare_list(self):
        data = json.dumps([{"on": True, "name": "a.safetensors", "sm": 0.8}])
        self.node.apply([], [], data)
        self.assertEqual(_APPLIED, [("a.safetensors", 0.8, 0.8)])

    def test_bad_json_is_noop(self):
        m, c, tw = self.node.apply([], [], "{not json")
        self.assertEqual(_APPLIED, [])
        self.assertEqual(tw, "")

    # --- trigger words --------------------------------------------------------
    def test_trigger_words_autodetected(self):
        m, c, tw = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}])
        self.assertEqual(tw, "alpha, beta")

    def test_trigger_override_wins(self):
        m, c, tw = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0, "trig": "custom"}])
        self.assertEqual(tw, "custom")

    def test_metadata_cache_hit(self):
        lora_box.trigger_words_for("a.safetensors")
        self.assertIn(self.a, lora_box._META_CACHE)
        # second call served from cache (same mtime)
        self.assertEqual(lora_box.trigger_words_for("a.safetensors"), ["alpha", "beta"])

    # --- IS_CHANGED -----------------------------------------------------------
    def test_is_changed_tracks_data(self):
        d1 = json.dumps({"rows": [{"name": "a.safetensors", "sm": 1.0}]})
        d2 = json.dumps({"rows": [{"name": "a.safetensors", "sm": 0.5}]})
        self.assertNotEqual(lora_box.LoraBox.IS_CHANGED([], [], d1),
                            lora_box.LoraBox.IS_CHANGED([], [], d2))

    def test_is_changed_tracks_file_mtime(self):
        d = json.dumps({"rows": [{"name": "a.safetensors", "sm": 1.0}]})
        h1 = lora_box.LoraBox.IS_CHANGED([], [], d)
        os.utime(self.a, (0, 0))  # change mtime
        h2 = lora_box.LoraBox.IS_CHANGED([], [], d)
        self.assertNotEqual(h1, h2)


if __name__ == "__main__":
    unittest.main()
