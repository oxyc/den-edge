/** Only a disposable database is touched; never inspect the user's encrypted library. */
async function storageProbe(): Promise<void> {
  const name = `den-tv-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let database: IDBDatabase | undefined;
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        expired = true;
        reject(new Error('Storage check timed out'));
      }, 5000);
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('probe');
      request.onerror = () => reject(new Error('Storage is unavailable'));
      request.onblocked = () => reject(new Error('Storage is blocked'));
      request.onsuccess = () => {
        database = request.result;
        if (expired) {
          database.close();
          indexedDB.deleteDatabase(name);
          return;
        }
        try {
          const transaction = database.transaction('probe', 'readwrite');
          const store = transaction.objectStore('probe');
          store.put('ready', 'check');
          const read = store.get('check');
          transaction.oncomplete = () =>
            read.result === 'ready' ? resolve() : reject(new Error('Storage read failed'));
          transaction.onabort = transaction.onerror = () => reject(new Error('Storage failed'));
        } catch {
          // A synchronous write refusal in this event callback otherwise escapes the probe's promise.
          reject(new Error('Storage failed'));
        }
      };
    });
  } finally {
    expired = true;
    clearTimeout(timeout);
    database?.close();
    indexedDB.deleteDatabase(name);
  }
}

async function workerProbe(): Promise<void> {
  const worker = new Worker(new URL('./diagnosticWorker.ts', import.meta.url));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Worker check timed out')), 5000);
      worker.onmessage = (event) =>
        event.data === true ? resolve() : reject(new Error('Worker capability check failed'));
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error('Worker could not start'));
      };
      worker.postMessage(true);
    });
  } finally {
    clearTimeout(timeout);
    worker.terminate();
  }
}

/** Opt-in on-device evidence, deliberately excludes pairing keys, URLs and library contents. */
export function installDiagnostics(): void {
  if (document.getElementById('den-tv-diagnostics')) return;
  const panel = document.createElement('details');
  panel.id = 'den-tv-diagnostics';
  panel.style.cssText =
    'position:fixed;right:2rem;bottom:2rem;z-index:2147483647;background:#17171f;color:white;padding:1rem;max-width:65vw;max-height:85vh;overflow:auto;font:20px monospace';
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
  const run = document.createElement('button');
  run.textContent = 'Run device checks';
  const results = document.createElement('p');
  results.setAttribute('role', 'status');
  results.style.whiteSpace = 'pre-line';
  run.onclick = async () => {
    run.disabled = true;
    results.textContent = 'Checking device…';
    const checks: [string, () => Promise<unknown>][] = [
      ['Web Crypto', () => crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]))],
      ['IndexedDB write/read', storageProbe],
      ['Worker + Crypto + WASM', workerProbe],
    ];
    const lines = await Promise.all(
      checks.map(async ([label, probe]) => {
        try {
          await probe();
          return `${label}: passed`;
        } catch {
          // Exception text can contain resource URLs. Keep device reports shareable without credentials.
          return `${label}: failed`;
        }
      }),
    );
    results.textContent = lines.join('\n');
    run.disabled = false;
  };
  panel.append(summary, values, run, results);
  document.body.append(panel);
}
