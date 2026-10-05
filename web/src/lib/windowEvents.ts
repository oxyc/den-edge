const resizeListeners = new Set<() => void>();
let listening = false;

function resized() {
  for (const listener of resizeListeners) listener();
}

/** Share the one window resize listener used by every active horizontal card window. */
export function observeWindowResize(listener: () => void): () => void {
  resizeListeners.add(listener);
  if (!listening) {
    window.addEventListener('resize', resized, { passive: true });
    listening = true;
  }
  return () => {
    resizeListeners.delete(listener);
    if (resizeListeners.size || !listening) return;
    window.removeEventListener('resize', resized);
    listening = false;
  };
}
