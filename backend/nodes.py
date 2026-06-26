"""The ComfyUI nodes: Timur Lora Box (multi-LoRA loader) + Prompt+Triggers merge."""
import json
import math
import hashlib
from collections import OrderedDict

import comfy.sd
import comfy.utils

from .util import _mtime, log
from .loras import _safe_lora_path
from .triggers import trigger_words_for
from .prompt import merge_prompt

LORA_CACHE_MAX = 4   # how many loaded LoRAs to keep in RAM


class LoraBoxTimur:
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
        pos, delim = "end", ", "
        if isinstance(obj, dict):
            muted = bool(obj.get("mute"))
            pos = obj.get("pos", "end") or "end"
            delim = obj.get("delim", ", ")
            if delim is None:
                delim = ", "
            rows = obj.get("rows")
            rows = rows if isinstance(rows, list) else []
        elif isinstance(obj, list):
            rows = obj
        else:
            rows = []

        if muted:
            # Muted: no LoRA applied, no triggers — pass the prompt through
            # untouched so a connected prompt still reaches the encoder.
            return (model, clip, (prompt or ""))

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
            # allow negative ("anti-LoRA") and >1 weights, matching the UI range
            sm = max(-3.0, min(3.0, sm))
            sc = max(-3.0, min(3.0, sc))
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
            log.info("applied: %s", "; ".join(applied))

        seen, words = set(), []
        for w in triggers:
            if w.lower() not in seen:
                seen.add(w.lower())
                words.append(w)
        tw = ", ".join(words)
        merged = merge_prompt(prompt, tw, pos, delim)
        return (model, clip, merged)


POS_END = "end (append after prompt)"
POS_BEGIN = "beginning (prepend before prompt)"


class LoraBoxTimurPromptMerge:
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
    "LoraBoxTimur": LoraBoxTimur,
    "LoraBoxTimurPromptMerge": LoraBoxTimurPromptMerge,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraBoxTimur": "Timur Lora Box",
    "LoraBoxTimurPromptMerge": "Prompt + Triggers (Timur Lora Box)",
}
