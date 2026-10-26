import './compat';
import './packaged';
import '../app.css';
import './tv.css';
import { installTVNavigation } from './navigation';
import { registerSamsungKeys } from './platform';
import { tvRuntimePlatform } from '../lib/tvRuntimePlatform';
import { installTvCssCapabilities } from './cssCapabilities';
import { startupMark } from '../lib/startupTiming';
import { openingWorkers, startLibraryWorkers } from '../lib/libraryWorkerStart';

startupMark('page boot');
document.documentElement.dataset.denTv = tvRuntimePlatform();
const stopCssCapabilities = installTvCssCapabilities();

let remoteInstalled = false;
function installRemote() {
  if (remoteInstalled) return;
  remoteInstalled = true;
  const stop = installTVNavigation();
  const stopKeys = __DEN_TV_PLATFORM__ === 'tizen' ? registerSamsungKeys() : () => {};
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) {
      stop();
      stopKeys();
      stopCssCapabilities();
    }
  });
}

async function start() {
  if (!isSecureContext || !crypto.subtle) {
    throw new Error(
      'Den needs a trusted HTTPS address for pairing and encrypted library storage. HTTP on a TV LAN address is not secure.',
    );
  }
  if (
    !globalThis.Worker ||
    !globalThis.indexedDB ||
    (!__DEN_TV_LEGACY_JS_CORE__ && !globalThis.WebAssembly)
  ) {
    throw new Error(
      `This TV is missing Worker, IndexedDB${__DEN_TV_LEGACY_JS_CORE__ ? '' : ' or WebAssembly'} support required by Den.`,
    );
  }
  // TVs retain the proven dedicated runtime; SharedWorker code is removed from their build by `__DEN_TV__`.
  startLibraryWorkers(openingWorkers());
  // The application is a separate download. Keep hardware Back/exit available on the starting screen too;
  // waiting for that chunk left an early Back unhandled (also reproducible while holding its request).
  installRemote();
  startupMark('app module requested');
  await import('../appMain');
}

void start().catch((error) => {
  const root = document.getElementById('app')!;
  // Not `replaceChildren`: Chromium 69 (Tizen 5.5) predates it, and this screen is what an engine gap shows.
  root.textContent = '';
  const heading = document.createElement('h1');
  heading.textContent = 'Den could not start';
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = error instanceof Error ? error.message : String(error);
  const retry = document.createElement('button');
  retry.textContent = 'Try again';
  retry.onclick = () => location.reload();
  root.append(heading, message, retry);
  retry.focus();
  installRemote();
});

// Diagnostics must also be reachable when bootstrap fails on the actual TV.
if (new URLSearchParams(location.search).has('tv-diagnostics')) {
  void import('./diagnostics').then(({ installDiagnostics }) => installDiagnostics());
}
