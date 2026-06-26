"""Timur Lora Box — ComfyUI custom node package entry point.

Backend lives in ./backend (nodes, loras, triggers, previews, prompt, routes);
the DOM-panel frontend in ./frontend. This file only wires ComfyUI's load
contract: the node mappings and where the browser-served JS lives.
"""
from .backend import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .backend import routes  # noqa: F401 — importing registers the /loraboxtimur API routes

WEB_DIRECTORY = "./frontend"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
