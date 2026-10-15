/**
 * Retire the current profile's navigation scope without adding a Back destination. The address is replaced with Home
 * at once: the keyed profile tree is rebuilt from the address, so a Router that has not yet written its own (it
 * settles asynchronously) would otherwise leave the new profile on the page the last one was on — a Kid landing on
 * Settings behind the Owner PIN. Router also handles the event, flushing its pending address before it is destroyed.
 */
export function resetProfileNavigation(
  target: EventTarget = document,
  address: Pick<History, 'replaceState'> = history,
): void {
  address.replaceState(null, '', '/');
  // Not `replace: true`: that is Router's in-place address rewrite for a growing query and leaves the page drawn. The
  // address already says Home, so following it opens Home without pushing an entry.
  target.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/' } }));
}
