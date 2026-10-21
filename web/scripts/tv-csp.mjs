export const DEFAULT_TIZEN_VERSION = '8.0';
export const SUPPORTED_TIZEN_VERSIONS = ['5.5', '6.5', DEFAULT_TIZEN_VERSION];

export function getTizenVersion(value = DEFAULT_TIZEN_VERSION) {
  if (!SUPPORTED_TIZEN_VERSIONS.includes(value))
    throw new Error(`DEN_TIZEN_VERSION must be one of: ${SUPPORTED_TIZEN_VERSIONS.join(', ')}`);
  return value;
}

export function tvCsp(tizenVersion = DEFAULT_TIZEN_VERSION) {
  const version = getTizenVersion(tizenVersion);
  // Tizen 8's Chromium 108 understands `wasm-unsafe-eval`, which permits Den's packaged WebAssembly
  // without permitting JavaScript eval. Tizen 5.5/6.5's older engines conflate the two permissions, so their
  // separately labelled widgets need `unsafe-eval` for Wasm while executable sources remain self-only.
  const wasmSource = version === '8.0' ? "'wasm-unsafe-eval'" : "'unsafe-eval'";
  return [
    "default-src 'self'",
    `script-src 'self' ${wasmSource}`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "worker-src 'self' blob:",
    // Samsung AVPlay creates a platform-owned <object> without a data URL; keep it
    // local while continuing to reject remote object/plugin content.
    "object-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https: wss:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    'frame-src https://www.youtube-nocookie.com',
  ].join('; ');
}

export const TV_CSP = tvCsp();
