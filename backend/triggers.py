"""Extract LoRA trigger words from safetensors metadata."""
from .loras import _safe_lora_path, _read_st_metadata


def trigger_words_for(name):
    path = _safe_lora_path(name)
    if not path:
        return []
    meta = _read_st_metadata(path)
    words = []

    # Only real trigger fields written by trainers / civitai exports. We do
    # NOT fall back to the most frequent training tags (ss_tag_frequency): those
    # are dataset tags, not trigger words, and silently injecting them adds
    # noise to the prompt the user never asked for.
    for k in ("modelspec.trigger_phrase", "trigger_phrase", "ss_trigger_words",
              "activation text", "trainedWords"):
        v = meta.get(k)
        if isinstance(v, str) and v.strip():
            words.extend([w.strip() for w in v.split(",") if w.strip()])

    seen, out = set(), []
    for w in words:
        if w and w.lower() not in seen:
            seen.add(w.lower())
            out.append(w)
    return out[:50]
