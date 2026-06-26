/* Inject the panel stylesheet once. */
import { GAP, TRIG_MIN } from "./constants.js";

export function injectStyle() {
    const old = document.getElementById("loraboxtimur-style");
    if (old) old.remove();
    const s = document.createElement("style");
    s.id = "loraboxtimur-style";
    s.textContent = `
.lorabox-root{width:100%; height:100%; overflow:hidden; box-sizing:border-box;}
.lorabox{width:100%; display:flex; flex-direction:column;
  font-family:inherit; font-size:12px; color:var(--input-text,#ddd);
  padding:6px 10px 10px; gap:8px; box-sizing:border-box;}
.lorabox *{box-sizing:border-box;}
.lorabox .lb-head{display:flex; align-items:center; gap:18px; min-height:16px;
  color:var(--descrip-text,#9a9a9a); font-size:11px;}
.lorabox .lb-head label{display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;}
.lorabox .lb-head input{accent-color:var(--p-button-primary-background,#3b82f6); cursor:pointer; margin:0;}
.lorabox .lb-list{display:flex; flex-direction:column; gap:${GAP}px;}
.lorabox .lb-empty{display:flex; align-items:center; justify-content:center; min-height:40px;
  color:var(--descrip-text,#888); font-style:italic; font-size:11px; opacity:.8;}

.lorabox .lb-thumb{flex:0 0 auto; width:54px; height:54px; align-self:center; position:relative;
  border-radius:8px; overflow:hidden; cursor:pointer; display:flex; align-items:center; justify-content:center;
  background:var(--comfy-menu-bg,#2a2a2a); border:1px solid var(--border-color,#4a4a4a);
  transition:border-color .12s;}
.lorabox .lb-thumb:hover{border-color:var(--p-button-primary-background,#5a7fd0);}
.lorabox .lb-thumb img{width:100%; height:100%; object-fit:cover; display:none;}
.lorabox .lb-thumb.has-img img{display:block;}
.lorabox .lb-thumb .lb-ph{display:flex; flex-direction:column; align-items:center; gap:2px;
  color:var(--descrip-text,#888); font-size:16px; line-height:1; pointer-events:none;}
.lorabox .lb-thumb .lb-ph .lb-ph-t{font-size:8px; letter-spacing:.02em; opacity:.85;}
.lorabox .lb-thumb.has-img .lb-ph{display:none;}
.lorabox .lb-thumb .lb-thumb-x{position:absolute; top:2px; right:2px; width:16px; height:16px;
  display:none; align-items:center; justify-content:center; font-size:10px; border-radius:4px;
  background:rgba(0,0,0,.62); color:#fff; line-height:1;}
.lorabox .lb-thumb.has-img:hover .lb-thumb-x{display:flex;}
.lorabox .lb-thumb .lb-thumb-x:hover{background:#7a2b2b;}

.lorabox .lb-num{width:100%; min-width:0; height:26px; padding:0 6px; text-align:center;
  background:var(--comfy-menu-bg,#2a2a2a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#4a4a4a); border-radius:6px; font-size:11px;
  -moz-appearance:textfield; appearance:textfield;}
.lorabox .lb-num::-webkit-outer-spin-button,
.lorabox .lb-num::-webkit-inner-spin-button{-webkit-appearance:none; margin:0;}
.lorabox .lb-num:focus{outline:none; border-color:var(--p-button-primary-background,#6a8fe0);}
.lorabox .lb-num.neg{color:#e8855a; border-color:#7a4a36;}
.lorabox .lb-num.zero{color:var(--descrip-text,#888);}
.lorabox .lb-ico{width:26px; height:26px; padding:0; cursor:pointer; display:flex;
  align-items:center; justify-content:center; background:transparent;
  color:var(--descrip-text,#9a9a9a); border:none; border-radius:6px; font-size:14px; line-height:1; flex:0 0 auto;}
.lorabox .lb-ico:hover{background:var(--comfy-menu-bg,#3a3a3a); color:var(--input-text,#fff);}

.lb-pop{position:fixed; z-index:10010; display:flex; flex-direction:column; gap:6px;
  padding:6px; max-height:min(380px, calc(100vh - 24px)); overflow:hidden;
  border-radius:8px;
  background:var(--comfy-menu-bg,#222); border:1px solid var(--border-color,#555);
  box-shadow:0 10px 30px rgba(0,0,0,.55); font-family:sans-serif; font-size:12px;
  line-height:1.4; box-sizing:border-box;}
.lb-pop-search{flex:0 0 auto; height:28px; padding:0 9px; font-size:12px; border-radius:6px; outline:none;
  background:var(--comfy-input-bg,#1a1a1a); color:var(--input-text,#eee);
  border:1px solid var(--border-color,#555); box-sizing:border-box;}
.lb-pop-search:focus{border-color:var(--p-button-primary-background,#6a8fe0);}
.lb-pop-list{flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:auto;
  overscroll-behavior:contain; -webkit-overflow-scrolling:touch;}
.lb-pop-group{position:sticky; top:0; z-index:2; padding:5px 9px 3px; margin:0;
  font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
  color:var(--descrip-text,#888); background:var(--comfy-menu-bg,#222);
  border-bottom:1px solid var(--border-color,#444); pointer-events:none; line-height:1.2;}
.lb-pop-item{display:block; width:100%; margin:0 0 2px; padding:6px 9px; border-radius:5px;
  cursor:pointer; font-size:12px; line-height:1.35; min-height:27px; box-sizing:border-box;
  color:var(--input-text,#ddd); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  background:transparent; border:none; text-align:left; font-family:inherit;}
.lb-pop-item:hover,.lb-pop-item.hi{background:var(--p-button-primary-background,#3b82f6); color:#fff;}
.lb-pop-item.sel{outline:1px solid var(--border-color,#666);}
.lb-pop-empty{padding:8px; color:var(--descrip-text,#888); font-size:11px; font-style:italic;}
.lb-pop-bar{display:flex; align-items:center; gap:7px; padding:2px 6px 5px; font-size:11px; color:var(--descrip-text,#9a9a9a); cursor:pointer; user-select:none;}
.lb-pop-bar input{cursor:pointer; margin:0; accent-color:var(--p-button-primary-background,#3b82f6);}
.lb-pop-bar b{color:var(--input-text,#ddd); font-weight:600;}
.lb-pop-item.dim{opacity:.38;}
.lb-thumb-pop{position:fixed; z-index:10020; padding:4px; border-radius:10px; pointer-events:none;
  background:var(--comfy-menu-bg,#222); border:1px solid var(--border-color,#555);
  box-shadow:0 12px 36px rgba(0,0,0,.6);}
.lb-thumb-pop img{display:block; max-width:280px; max-height:280px; border-radius:6px;}

/* ===== G row (numeric hero + box-meter + cover) ===== */
.lorabox .lbg-row{display:flex; align-items:stretch; gap:12px; padding-left:14px; position:relative; overflow:hidden;
  border:1px solid rgba(255,255,255,.12); border-radius:4px; cursor:ew-resize; transition:opacity .15s;
  background:linear-gradient(90deg, rgba(242,169,59,.30) 0, rgba(242,169,59,.22) var(--p,60%), rgba(255,255,255,.05) var(--p,60%));}
.lorabox .lbg-row.off{opacity:.45;}
.lorabox .lbg-num{display:flex; flex-direction:column; justify-content:center; padding:12px 0; cursor:ns-resize; user-select:none; flex:0 0 auto;}
.lorabox .lbg-val{display:inline-flex; align-items:baseline; font-family:ui-monospace,"JetBrains Mono",Menlo,monospace; font-weight:700; font-size:28px; letter-spacing:-.02em; color:#FBE3B0; line-height:1;}
.lorabox .lbg-sign{display:inline-block; width:1ch; text-align:center; flex:0 0 auto;}
.lorabox .lbg-digits{font-variant-numeric:tabular-nums;}
.lorabox .lbg-slab{font-family:ui-monospace,monospace; font-weight:500; font-size:8px; letter-spacing:.14em; color:#E8C98A; margin-top:3px;}
.lorabox .lbg-body{flex:1 1 auto; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:6px; padding:12px 0;}
.lorabox .lbg-l1{display:flex; align-items:center; gap:8px; min-width:0;}
.lorabox .lbg-en{width:15px; height:15px; margin:0; cursor:pointer; accent-color:#F2A93B; flex:0 0 auto;}
.lorabox .lbg-name{flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:6px; cursor:pointer;}
.lorabox .lbg-nametxt{flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:500; color:#EFEAE2;}
.lorabox .lbg-nametxt.none{color:#A89E8C;}
.lorabox .lbg-car{flex:0 0 auto; color:#8a8270; font-size:9px;}
.lorabox .lbg-ic{flex:0 0 auto; background:none; border:none; color:#A89E8C; font-size:12px; line-height:1; cursor:pointer; padding:2px;}
.lorabox .lbg-ic:hover{color:#fff;}
.lorabox .lbg-ic.on{color:#F2A93B;}
.lorabox .lbg-clip{display:flex; align-items:center; gap:6px;}
.lorabox .lbg-cliplbl{font-size:10px; color:#A89E8C; flex:0 0 auto;}
.lorabox .lbg-clip .lb-num{height:22px; width:54px; flex:0 0 auto;}
.lorabox .lbg-row .lb-thumb{width:58px; height:auto; align-self:stretch; border-radius:0; flex:0 0 auto; border:none;}
.lorabox .lbg-row .lb-thumb img{width:100%; height:100%; object-fit:cover;}
/* trigger drawer (full-width, below the row) */
.lorabox .lb-trig{display:flex; align-items:flex-start; gap:8px; padding:9px 12px 11px 14px;
  background:rgba(0,0,0,.22); border:1px solid rgba(255,255,255,.12); border-top:none; border-radius:0 0 4px 4px;}
.lorabox .lb-trig::before{content:""; width:2px; align-self:stretch; min-height:14px; background:#F2A93B; flex:0 0 auto;}
.lorabox .lb-trig .lb-trig-in{flex:1 1 auto; min-width:0; min-height:${TRIG_MIN}px; padding:0; background:none; border:none; resize:none; overflow:hidden;
  color:#EAD9B6; font-family:ui-monospace,monospace; font-size:11px; line-height:1.5; outline:none;}
/* minimalist Add */
.lorabox .lb-add{height:auto; margin-top:2px; padding:12px 0 4px; display:flex; align-items:center; justify-content:center; gap:6px;
  background:none; border:none; border-top:1px solid rgba(255,255,255,.08); border-radius:0;
  color:#A89E8C; font-weight:500; font-size:11px; letter-spacing:.04em; cursor:pointer;}
.lorabox .lb-add:hover{background:none; color:#F2A93B; border-color:rgba(255,255,255,.08);}
.lorabox .lb-add .plus{font-size:12px; font-weight:500; opacity:1;}
`;
    document.head.appendChild(s);
}
