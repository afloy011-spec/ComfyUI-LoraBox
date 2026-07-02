/* Feather-style line icons used across the Lora Box panel (match the Figma
 * mockup). Pure constants, no side effects — safe to import from anywhere.
 * (ComfyUI auto-imports every .js in the web dir; an extra import of this
 * module is a no-op.) */

export const svg = (inner, sz = 14) => `<svg viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// plus / minus glyphs for the row's "extra parameters" (trigger words) toggle —
// minus while the panel is open (a rotated × would clash with the adjacent delete ×)
export const PLUS_SVG = svg('<path d="M12 5v14M5 12h14"/>', 16);
export const MINUS_SVG = svg('<path d="M5 12h14"/>', 16);
export const X_SVG = svg('<path d="M18 6 6 18M6 6l12 12"/>', 16);
export const GEAR_SVG = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 16);
export const SEARCH_SVG = svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 16);
export const CHECK_SVG = svg('<path d="M20 6 9 17l-5-5"/>', 16);
export const IMAGE_SVG = svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>', 16);
export const UPLOAD_SVG = svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>', 16);
export const TRASH_SVG = svg('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>', 16);
export const LAYERS_SVG = svg('<path d="M12 2 2 7l10 5 10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>', 18);
export const CHEVRON_UP_SVG = svg('<path d="m18 15-6-6-6 6"/>', 16);
