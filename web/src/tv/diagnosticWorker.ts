// A real same-origin worker probe, not a claim that the TV's media decoder is supported.
self.onmessage = async () => {
  try {
    await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]));
    if (!__DEN_TV_LEGACY_JS_CORE__)
      await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    self.postMessage(true);
  } catch {
    self.postMessage(false);
  }
};
