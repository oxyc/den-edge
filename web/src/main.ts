import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('index.html has no #app element');
mount(App, { target });

/** Reload onto the current release, at most once in a while: a missing file must not become a reload loop. */
function reloadOnce(): void {
  try {
    const last = Number(sessionStorage.getItem('den.reloadedAt'));
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('den.reloadedAt', String(Date.now()));
  } catch {
    // Without storage there is no loop guard; a reload is still better than a page that stays broken.
  }
  location.reload();
}

// A page kept from an earlier release (public/sw.js) can ask for a file den-edge no longer has. Offline, the file is
// simply out of reach, and reloading would not bring it back.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  if (navigator.onLine) reloadOnce();
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data === 'den:reload') reloadOnce();
  });
  navigator.serviceWorker
    .register('/sw.js')
    .catch((error: unknown) => console.warn('den: the app shell is not kept offline', error));
}
