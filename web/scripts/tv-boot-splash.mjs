// What a TV shows before Den's own styles arrive: a centred spinner and one line of text on Den's background.
// Packaged TVs allow inline style attributes but no inline <style> block (see tv-csp.mjs), so every rule is an
// attribute and the spinner turns with SVG's own animation rather than CSS keyframes. Old engines (Chromium 47)
// have no `inset`, hence the four offsets.
const background = '#0b0b0f';

export const bootBodyStyle = `margin:0;background:${background}`;

export function bootSplash(text) {
  return `<div style="position:fixed;top:0;right:0;bottom:0;left:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${background};color:#f2f2f5;font:500 32px/1.3 system-ui,sans-serif">\
<svg width="64" height="64" viewBox="0 0 50 50" aria-hidden="true">\
<circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="4"/>\
<path d="M25 5a20 20 0 0 1 20 20" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">\
<animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite"/>\
</path></svg><p style="margin:24px 0 0">${text}</p></div>`;
}
