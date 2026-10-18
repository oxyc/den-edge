import './compat';
import '../app.css';
import './tv.css';
import { installTVNavigation } from './navigation';

document.documentElement.dataset.denTv = __DEN_TV_PLATFORM__;

async function start() {
  if (!isSecureContext || !crypto.subtle) {
    throw new Error(
      'Den needs a trusted HTTPS address for pairing and encrypted library storage. HTTP on a TV LAN address is not secure.',
    );
  }
  if (!globalThis.Worker || !globalThis.indexedDB || !globalThis.WebAssembly) {
    throw new Error('This TV is missing Worker, IndexedDB or WebAssembly support required by Den.');
  }
  await import('../appMain');
  const stop = installTVNavigation();
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) stop();
  });
  if (new URLSearchParams(location.search).has('tv-diagnostics')) {
    const { installDiagnostics } = await import('./diagnostics');
    installDiagnostics();
  }
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
});
