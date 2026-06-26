"""aiohttp API routes for the DOM panel (/loraboxtimur/*).

Importing this module registers the routes on ComfyUI's PromptServer. If the
server isn't importable (e.g. unit context), registration is skipped quietly.
"""
import os
import asyncio

import folder_paths

from .util import log
from .loras import category_for
from .triggers import trigger_words_for
from .previews import (
    _find_preview, _preview_base, _fetch_civitai_preview,
    PREVIEW_EXTS, PREVIEW_CT, MAX_PREVIEW_BYTES,
)

try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/loraboxtimur/triggers")
    async def _triggers(request):
        file = request.query.get("file", "")
        return web.json_response({"file": file, "words": trigger_words_for(file)})

    @PromptServer.instance.routes.get("/loraboxtimur/categories")
    async def _categories(request):
        """Map every registered lora to a picker group (name + metadata)."""
        cats = {}
        try:
            names = folder_paths.get_filename_list("loras")
        except Exception:
            names = []
        for name in names:
            if name and name != "None":
                cats[name] = category_for(name)
        return web.json_response({"categories": cats})

    @PromptServer.instance.routes.get("/loraboxtimur/preview")
    async def _preview_get(request):
        file = request.query.get("file", "")
        p = _find_preview(file)
        if not p:
            # no local sidecar: try to pull one from Civitai (hashing + network
            # are blocking, so run off the event loop) and cache it as a sidecar
            p = await asyncio.get_event_loop().run_in_executor(None, _fetch_civitai_preview, file)
        if not p:
            return web.Response(status=404)
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            return web.Response(status=404)
        ext = os.path.splitext(p)[1].lower()
        return web.Response(body=data, content_type=PREVIEW_CT.get(ext, "application/octet-stream"),
                            headers={"Cache-Control": "no-store"})

    @PromptServer.instance.routes.post("/loraboxtimur/preview")
    async def _preview_post(request):
        base = _preview_base(request.query.get("file", ""))
        if not base:
            return web.json_response({"ok": False, "error": "unknown lora"}, status=400)
        ext = ("." + request.query.get("ext", "png").lstrip(".")).lower()
        if ext not in PREVIEW_EXTS:
            ext = ".png"
        data = await request.read()
        if not data:
            return web.json_response({"ok": False, "error": "empty"}, status=400)
        if len(data) > MAX_PREVIEW_BYTES:
            return web.json_response({"ok": False, "error": "too large"}, status=413)
        # drop any existing sidecar(s) first so the new image is unambiguous
        for e in PREVIEW_EXTS:
            try:
                os.remove(base + e)
            except OSError:
                pass
        try:
            with open(base + ext, "wb") as f:
                f.write(data)
        except OSError as ex:
            return web.json_response({"ok": False, "error": str(ex)}, status=500)
        return web.json_response({"ok": True, "ext": ext})

    @PromptServer.instance.routes.delete("/loraboxtimur/preview")
    async def _preview_del(request):
        base = _preview_base(request.query.get("file", ""))
        if not base:
            return web.json_response({"ok": False}, status=400)
        removed = False
        for e in PREVIEW_EXTS:
            try:
                os.remove(base + e)
                removed = True
            except OSError:
                pass
        return web.json_response({"ok": removed})
except Exception as e:  # pragma: no cover - server may be unavailable at import
    log.warning("could not register /loraboxtimur routes: %s", e)
