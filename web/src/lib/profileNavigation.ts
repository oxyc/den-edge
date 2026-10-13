/**
 * Retire the current profile's navigation scope without adding a Back destination. Router handles this event
 * synchronously, including flushing its pending address, before the keyed profile tree is destroyed.
 */
export function resetProfileNavigation(target: EventTarget = document): void {
  target.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/', replace: true } }));
}
