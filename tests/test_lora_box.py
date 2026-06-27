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

    def _apply(self, rows, mute=False, prompt=None, pos="end", delim=", "):
        data = json.dumps({"v": 1, "mute": mute, "pos": pos, "delim": delim, "rows": rows})
        return self.node.apply([], [], prompt=prompt, data=data)

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
        self._apply([{"on": True, "name": "a.safetensors", "sm": 15, "sc": -15}])
        # manual entry is slider-independent; clamp only to the ±10 safety range
        self.assertEqual(_APPLIED, [("a.safetensors", 10.0, -10.0)])

    def test_strength_beyond_slider_passes_through(self):
        # values outside the slider's 0…2 range but within ±10 apply verbatim
        self._apply([{"on": True, "name": "a.safetensors", "sm": 5, "sc": -2.5}])
        self.assertEqual(_APPLIED, [("a.safetensors", 5.0, -2.5)])

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
        m, c, merged = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}], mute=True)
        self.assertEqual(_APPLIED, [])
        self.assertEqual(merged, "")

    def test_mute_passes_prompt_through(self):
        m, c, merged = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}],
                                   mute=True, prompt="hello world")
        self.assertEqual(merged, "hello world")

    def test_none_name_skipped(self):
        self._apply([{"on": True, "name": "None", "sm": 1.0}])
        self.assertEqual(_APPLIED, [])

    def test_legacy_bare_list(self):
        data = json.dumps([{"on": True, "name": "a.safetensors", "sm": 0.8}])
        self.node.apply([], [], data=data)
        self.assertEqual(_APPLIED, [("a.safetensors", 0.8, 0.8)])

    def test_bad_json_is_noop(self):
        m, c, merged = self.node.apply([], [], data="{not json")
        self.assertEqual(_APPLIED, [])
        self.assertEqual(merged, "")

    # --- trigger words --------------------------------------------------------
    def test_trigger_words_autodetected(self):
        # with no prompt the merged output is just the (auto) trigger words
        m, c, merged = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}], prompt=None)
        self.assertEqual(merged, "alpha, beta")

    def test_trigger_override_wins(self):
        m, c, merged = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0, "trig": "custom"}],
                                   prompt=None)
        self.assertEqual(merged, "custom")

    def test_sidecar_txt_triggers(self):
        # a lora whose safetensors carries NO trigger metadata, but a .txt
        # sidecar lives next to it -> words come from the sidecar
        b = os.path.join(self.tmp, "b.safetensors")
        _make_safetensors(b, {})
        _LORAS["b.safetensors"] = b
        with open(os.path.join(self.tmp, "b.txt"), "w", encoding="utf-8") as f:
            f.write("sks man, wearing a hat\nphotorealistic")
        self.assertEqual(lora_box.trigger_words_for("b.safetensors"),
                         ["sks man", "wearing a hat", "photorealistic"])

    def test_sidecar_civitai_info_triggers(self):
        b = os.path.join(self.tmp, "c.safetensors")
        _make_safetensors(b, {})
        _LORAS["c.safetensors"] = b
        with open(os.path.join(self.tmp, "c.civitai.info"), "w", encoding="utf-8") as f:
            json.dump({"trainedWords": ["myloratoken", "anime style"]}, f)
        self.assertEqual(lora_box.trigger_words_for("c.safetensors"),
                         ["myloratoken", "anime style"])

    def test_tag_frequency_fallback(self):
        # no explicit trigger field, but ss_tag_frequency has activation tokens
        # present in every image (count == max) plus descriptive tail tags
        b = os.path.join(self.tmp, "d.safetensors")
        _make_safetensors(b, {"ss_tag_frequency": json.dumps(
            {"set1": {"vokiai": 29, "ami": 29, "blonde hair": 5, "smiling": 1}})})
        _LORAS["d.safetensors"] = b
        self.assertEqual(lora_box.trigger_words_for("d.safetensors"), ["ami", "vokiai"])

    def test_tag_frequency_kohya_folder_trigger(self):
        # one-shot set: the trigger is recovered from the Kohya "<n>_<trigger>"
        # folder name even though its tag count is 1
        b = os.path.join(self.tmp, "k.safetensors")
        _make_safetensors(b, {"ss_tag_frequency": json.dumps({"1_katosik": {"katosik": 1}})})
        _LORAS["k.safetensors"] = b
        self.assertEqual(lora_box.trigger_words_for("k.safetensors"), ["katosik"])

    def test_tag_frequency_single_image_ignored(self):
        # a one-shot set (everything count 1) gives no reliable trigger signal
        b = os.path.join(self.tmp, "e.safetensors")
        _make_safetensors(b, {"ss_tag_frequency": json.dumps(
            {"s": {"a": 1, "b": 1, "c": 1}})})
        _LORAS["e.safetensors"] = b
        self.assertEqual(lora_box.trigger_words_for("e.safetensors"), [])

    def test_explicit_trigger_wins_over_tag_frequency(self):
        b = os.path.join(self.tmp, "f.safetensors")
        _make_safetensors(b, {"trigger_phrase": "realtoken",
                              "ss_tag_frequency": json.dumps({"s": {"noise": 9, "more": 9}})})
        _LORAS["f.safetensors"] = b
        self.assertEqual(lora_box.trigger_words_for("f.safetensors"), ["realtoken"])

    def test_header_metadata_wins_over_sidecar(self):
        # the safetensors trigger field is authoritative; sidecar only fills gaps
        with open(os.path.join(self.tmp, "a.txt"), "w", encoding="utf-8") as f:
            f.write("ignored")
        self.assertEqual(lora_box.trigger_words_for("a.safetensors"), ["alpha", "beta"])

    # --- merged prompt output -------------------------------------------------
    def test_prompt_merge_end(self):
        m, c, merged = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}],
                                   prompt="a portrait", pos="end")
        self.assertEqual(merged, "a portrait, alpha, beta")

    def test_prompt_merge_beginning(self):
        m, c, merged = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}],
                                   prompt="a portrait", pos="beginning")
        self.assertEqual(merged, "alpha, beta, a portrait")

    def test_prompt_none_returns_triggers(self):
        m, c, merged = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}], prompt=None)
        self.assertEqual(merged, "alpha, beta")

    def test_prompt_no_lora_passthrough(self):
        m, c, merged = self._apply([{"on": True, "name": "None", "sm": 1.0}], prompt="just me")
        self.assertEqual(merged, "just me")

    def test_prompt_custom_delimiter(self):
        m, c, merged = self._apply([{"on": True, "name": "a.safetensors", "sm": 1.0}],
                                   prompt="p", pos="end", delim=" BREAK ")
        self.assertEqual(merged, "p BREAK alpha, beta")

    def test_panel_prompt_used_when_input_empty(self):
        # prompt typed into the node's panel (stored in data) is used when the
        # connected prompt input is empty/absent
        data = json.dumps({"v": 1, "pos": "end", "prompt": "a sunny beach",
                           "rows": [{"on": True, "name": "a.safetensors", "sm": 1.0}]})
        m, c, merged = self.node.apply([], [], prompt=None, data=data)
        self.assertEqual(merged, "a sunny beach, alpha, beta")

    def test_connected_prompt_overrides_panel(self):
        # a non-empty connected prompt wins over the panel value
        data = json.dumps({"v": 1, "pos": "end", "prompt": "panel text",
                           "rows": [{"on": True, "name": "a.safetensors", "sm": 1.0}]})
        m, c, merged = self.node.apply([], [], prompt="input wins", data=data)
        self.assertEqual(merged, "input wins, alpha, beta")

    def test_panel_prompt_passthrough_when_muted(self):
        data = json.dumps({"v": 1, "mute": True, "prompt": "kept verbatim",
                           "rows": [{"on": True, "name": "a.safetensors", "sm": 1.0}]})
        m, c, merged = self.node.apply([], [], prompt=None, data=data)
        self.assertEqual(merged, "kept verbatim")

    def test_metadata_cache_hit(self):
        lora_box.trigger_words_for("a.safetensors")
        self.assertIn(self.a, lora_box._META_CACHE)
        # second call served from cache (same mtime)
        self.assertEqual(lora_box.trigger_words_for("a.safetensors"), ["alpha", "beta"])

    # --- IS_CHANGED -----------------------------------------------------------
    def test_is_changed_tracks_data(self):
        d1 = json.dumps({"rows": [{"name": "a.safetensors", "sm": 1.0}]})
        d2 = json.dumps({"rows": [{"name": "a.safetensors", "sm": 0.5}]})
        self.assertNotEqual(lora_box.LoraBox.IS_CHANGED([], [], data=d1),
                            lora_box.LoraBox.IS_CHANGED([], [], data=d2))

    def test_is_changed_tracks_prompt(self):
        d = json.dumps({"rows": [{"name": "a.safetensors", "sm": 1.0}]})
        self.assertNotEqual(lora_box.LoraBox.IS_CHANGED([], [], prompt="x", data=d),
                            lora_box.LoraBox.IS_CHANGED([], [], prompt="y", data=d))

    def test_is_changed_tracks_file_mtime(self):
        d = json.dumps({"rows": [{"name": "a.safetensors", "sm": 1.0}]})
        h1 = lora_box.LoraBox.IS_CHANGED([], [], data=d)
        os.utime(self.a, (0, 0))  # change mtime
        h2 = lora_box.LoraBox.IS_CHANGED([], [], data=d)
        self.assertNotEqual(h1, h2)

    # --- category grouping ---------------------------------------------------
    def test_category_from_name(self):
        self.assertEqual(lora_box._category_from_name("foo_zimage_bar.safetensors"), "Z-Image")
        self.assertEqual(lora_box._category_from_name("krea2_x.safetensors"), "Krea")
        self.assertEqual(lora_box._category_from_name("pinterest_girl.safetensors"), "Other")

    def test_category_from_metadata(self):
        self.assertEqual(lora_box._category_from_meta({"ss_base_model_version": "zimage"}), "Z-Image")
        self.assertEqual(lora_box._category_from_meta(
            {"modelspec.architecture": "zimageturbo/lora"}), "Z-Image")

    def test_category_sdxl_and_sd15(self):
        # filename heuristics
        self.assertEqual(lora_box._category_from_name("my_sdxl_style.safetensors"), "SDXL")
        self.assertEqual(lora_box._category_from_name("char-xl-v2.safetensors"), "SDXL")
        self.assertEqual(lora_box._category_from_name("anime_sd15_v3.safetensors"), "SD1.5")
        # metadata heuristics
        self.assertEqual(lora_box._category_from_meta(
            {"ss_base_model_version": "sdxl_base_v1-0"}), "SDXL")
        self.assertEqual(lora_box._category_from_meta(
            {"modelspec.architecture": "stable-diffusion-xl-v1-base/lora"}), "SDXL")
        self.assertEqual(lora_box._category_from_meta(
            {"ss_sd_model_name": "v1-5-pruned.safetensors"}), "SD1.5")

    def test_user_category_override_wins(self):
        # a user-assigned group beats auto-detection; clearing reverts to auto
        lora_box._USERCATS = {"a.safetensors": "Favorites"}
        try:
            self.assertEqual(lora_box.category_for("a.safetensors"), "Favorites")
        finally:
            lora_box._USERCATS = {}
        self.assertEqual(lora_box.category_for("a.safetensors"), "Other")

    def test_category_for_uses_metadata_when_name_generic(self):
        p = os.path.join(self.tmp, "pinterest_girl.safetensors")
        _make_safetensors(p, {"ss_base_model_version": "zimage"})
        _LORAS["pinterest_girl.safetensors"] = p
        self.assertEqual(lora_box.category_for("pinterest_girl.safetensors"), "Z-Image")


class PromptMergeTest(unittest.TestCase):
    def setUp(self):
        self.node = lora_box.LoraBoxPromptMerge()
        self.END = lora_box.POS_END
        self.BEGIN = lora_box.POS_BEGIN

    def m(self, prompt, triggers, position, delimiter=", "):
        return self.node.merge(prompt, triggers, position, delimiter)[0]

    def test_end_appends(self):
        self.assertEqual(self.m("a portrait", "trig1, trig2", self.END),
                         "a portrait, trig1, trig2")

    def test_beginning_prepends(self):
        self.assertEqual(self.m("a portrait", "trig1, trig2", self.BEGIN),
                         "trig1, trig2, a portrait")

    def test_switch_actually_changes_output(self):
        end = self.m("p", "t", self.END)
        beg = self.m("p", "t", self.BEGIN)
        self.assertNotEqual(end, beg)
        self.assertTrue(end.endswith("t"))
        self.assertTrue(beg.startswith("t"))

    def test_custom_delimiter(self):
        self.assertEqual(self.m("p", "t", self.END, delimiter=" BREAK "),
                         "p BREAK t")

    def test_empty_triggers_returns_prompt(self):
        self.assertEqual(self.m("only prompt", "", self.BEGIN), "only prompt")
        self.assertEqual(self.m("only prompt", "   ", self.END), "only prompt")

    def test_empty_prompt_returns_triggers(self):
        self.assertEqual(self.m("", "t1, t2", self.END), "t1, t2")

    def test_no_duplicate_triggers(self):
        # trig1 already in the prompt -> not added again, regardless of side
        self.assertEqual(self.m("scene with trig1 here", "trig1, trig2", self.END),
                         "scene with trig1 here, trig2")
        self.assertEqual(self.m("scene with trig1 here", "trig1, trig2", self.BEGIN),
                         "trig2, scene with trig1 here")

    def test_all_triggers_duplicate_returns_prompt(self):
        self.assertEqual(self.m("has trig1 and trig2", "trig1, trig2", self.END),
                         "has trig1 and trig2")

    def test_whitespace_trimmed(self):
        self.assertEqual(self.m("  p  ", "  t  ", self.END), "p, t")

    def test_substring_trigger_not_dropped(self):
        # a trigger that is only a SUBSTRING of a prompt word must survive
        # ("man" must not be dropped because the prompt contains "woman")
        self.assertEqual(self.m("a woman walking", "man, hat", self.END),
                         "a woman walking, man, hat")

    def test_whole_word_trigger_dropped(self):
        # but a trigger present as a whole word IS de-duplicated
        self.assertEqual(self.m("a man walking", "man, hat", self.END),
                         "a man walking, hat")


if __name__ == "__main__":
    unittest.main()
