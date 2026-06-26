"""Merge a prompt with LoRA trigger words."""


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

    plow = p.lower()
    kept = [w.strip() for w in t.split(",") if w.strip() and w.strip().lower() not in plow]
    t = ", ".join(kept)
    if not t:
        return p

    d = delimiter if delimiter is not None else ", "
    pos = str(position).lower()
    if pos.startswith("beg") or pos.startswith("start") or pos.startswith("нач"):
        return t + d + p
    return p + d + t
