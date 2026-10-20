import './compat';
import './packaged';
import '../app.css';
import './tv.css';
import { installTVNavigation } from './navigation';
import { registerSamsungKeys } from './platform';
import { tvRuntimePlatform } from '../lib/tvRuntimePlatform';

document.documentElement.dataset.denTv = tvRuntimePlatform();

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
    }
  });
}

async function start() {
  if (!isSecureContext || !crypto.subtle) {
    throw new Error(
      'Den needs a trusted HTTPS address for pairing and encrypted library storage. HTTP on a TV LAN address is not secure.',
    );
  }
  if (!globalThis.Worker || !globalThis.indexedDB || !globalThis.WebAssembly) {
    throw new Error('This TV is missing Worker, IndexedDB or WebAssembly support required by Den.');
  }
  // The application is a separate download. Keep hardware Back/exit available on the starting screen too;
  // waiting for that chunk left an early Back unhandled (also reproducible while holding its request).
  installRemote();
  await import('../appMain');
}

void start().catch((error) => {
  const root = document.getElementById('app')!;
  root.replaceChildren();
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
