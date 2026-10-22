/** Tizen 3 loads a JavaScript policy inside each Worker; there is no compiled Wasm module to transfer. */
export function offerSyncPolicy(_worker: Worker): void {}
