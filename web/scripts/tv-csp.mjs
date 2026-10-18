// Tizen 8's Chromium 108 understands `wasm-unsafe-eval`, which permits Den's packaged WebAssembly
// without permitting JavaScript eval. Older Samsung Chromium engines conflate the two permissions.
export const TV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "connect-src 'self' https: wss:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  'frame-src https://www.youtube-nocookie.com',
].join('; ');
