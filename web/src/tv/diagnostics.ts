/** Opt-in on-device evidence, deliberately excludes pairing keys, URLs and library contents. */
export function installDiagnostics(): void {
  const panel = document.createElement('details');
  panel.id = 'den-tv-diagnostics';
  panel.style.cssText =
    'position:fixed;right:2rem;bottom:2rem;z-index:2147483647;background:#17171f;color:white;padding:1rem;max-width:65vw;font:20px monospace';
  const summary = document.createElement('summary');
  summary.textContent = 'TV diagnostics';
  const values = document.createElement('pre');
  values.style.whiteSpace = 'pre-wrap';
  const video = document.createElement('video');
  values.textContent = JSON.stringify(
    {
      target: __DEN_TV_PLATFORM__,
      userAgent: navigator.userAgent,
      secureContext: isSecureContext,
      viewport: `${innerWidth}×${innerHeight}`,
      nativeHLS: video.canPlayType('application/vnd.apple.mpegurl') || false,
      mse: typeof MediaSource !== 'undefined',
      worker: typeof Worker !== 'undefined',
      indexedDB: typeof indexedDB !== 'undefined',
      wasm: typeof WebAssembly !== 'undefined',
      cssHas: CSS.supports('selector(:has(*))'),
      cssColorMix: CSS.supports('color', 'color-mix(in srgb, white, black)'),
      serviceWorkerRequired: false,
    },
    null,
    2,
  );
  panel.append(summary, values);
  document.body.append(panel);
}
