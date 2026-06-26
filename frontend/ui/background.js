/* Full-node background: a looping video (falls back to a static preview) drawn
 * across the whole node — title bar included — via the seam trick.
 *
 * The title bar is painted by litegraph AFTER onDrawBackground, so a single
 * background draw can never cover it. Trick: draw the SAME image with the SAME
 * destination rect [0, -titleH, W, titleH+bodyH] in BOTH callbacks but clip each
 * to its own region — body slice in onDrawBackground (behind slots/widget),
 * title slice in onDrawForeground (on top of the title bar). Identical dest rect
 * ⇒ the seam at y=0 lines up invisibly. */
import { app } from "../../../scripts/app.js";

const BG_ALPHA = 0.4;                 // image opacity (tweak here)
const BG_BASE = "#1b1b1b";            // uniform base painted under the image
const _bgCache = {};                  // lora name -> HTMLImageElement
let VIDEO = null;

function _titleH() { return (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30; }

function bgImageFor(node) {
    const rows = node._lbRows || [];
    let name = null;
    for (const r of rows) { if (r && r.name && r.name !== "None") { name = r.name; break; } }
    if (!name) return null;
    let im = _bgCache[name];
    if (!im) {
        im = new Image();
        _bgCache[name] = im;
        im.onload = () => { im._ok = true; node.setDirtyCanvas(true, true); };
        im.onerror = () => { im._err = true; };
        im.src = "/loraboxtimur/preview?file=" + encodeURIComponent(name) + "&bg=1";
        return null;
    }
    return im._ok ? im : null;
}

function drawCover(ctx, src, dx, dy, dw, dh) {
    const iw = src.videoWidth || src.naturalWidth, ih = src.videoHeight || src.naturalHeight;
    if (!iw || !ih) return;
    const s = Math.max(dw / iw, dh / ih);   // cover: fill dest, crop overflow
    const cw = dw / s, ch = dh / s;
    ctx.drawImage(src, (iw - cw) / 2, (ih - ch) / 2, cw, ch, dx, dy, dw, dh);
}

// One shared, muted, looping <video>; a per-frame pump marks the canvas dirty so
// litegraph redraws it. requestVideoFrameCallback fires once per decoded frame.
function ensureVideo() {
    if (VIDEO) return VIDEO;
    const v = document.createElement("video");
    v.src = new URL("../assets/katosik_loop.mp4", import.meta.url).href;
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.play().catch(() => {});
    VIDEO = v;
    const pump = () => {
        if (app.canvas) app.canvas.setDirty(true, true);
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(pump);
        else requestAnimationFrame(pump);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(pump);
    else requestAnimationFrame(pump);
    return v;
}

function bgSource(node) {
    const v = ensureVideo();
    if (v && v.readyState >= 2 && v.videoWidth) return v;   // animated loop once ready
    return bgImageFor(node);                                 // static preview until then
}

export function drawBgSlice(node, ctx, region) {
    if (node.flags && node.flags.collapsed) return;
    const src = bgSource(node);
    if (!src) return;
    const W = node.size[0], bodyH = node.size[1], tH = _titleH(), totalH = tH + bodyH;
    ctx.save();
    ctx.beginPath();
    if (region === "title") ctx.rect(0, -tH, W, tH);   // title-bar strip
    else ctx.rect(0, 0, W, bodyH);                      // body
    ctx.clip();
    // Paint our own opaque neutral base FIRST so the node's default body/title
    // colours can't bleed through the semi-transparent image — even tone.
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG_BASE;
    ctx.fillRect(0, -tH, W, totalH);
    ctx.globalAlpha = BG_ALPHA;
    drawCover(ctx, src, 0, -tH, W, totalH);            // SAME dest rect in both
    ctx.restore();
    // The opaque base covers the title text in the title strip — redraw it.
    if (region === "title" && node.title) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#e8e8e8";
        ctx.font = "14px Arial";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(node.title, 18, -tH / 2);
        ctx.restore();
    }
}
