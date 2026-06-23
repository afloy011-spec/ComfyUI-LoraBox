"""Afloy Lora Box — ComfyUI custom node package entry point.

Exposes the node mappings for ComfyUI and points the frontend at ./web, where
lora_box.js lives (served to the browser as the DOM-panel editor).
"""

from .lora_box import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
