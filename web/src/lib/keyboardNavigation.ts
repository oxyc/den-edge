import type { Direction, moveFocus } from './spatialNavigation';

// Keep error identity rather than matching filenames/messages: WebKit's module-load error can omit the failed URL.
const failedImports = new WeakSet<object>();
export const isOptionalImportFailure = (error: unknown) =>
  error !== null &&
  (typeof error === 'object' || typeof error === 'function') &&
  failedImports.has(error);
export const markOptionalImportFailure = (error: unknown) => {
  if (error !== null && (typeof error === 'object' || typeof error === 'function'))
    failedImports.add(error);
};
export const optionalImport = <T>(loading: Promise<T>): Promise<T> =>
  loading.catch((error: unknown) => {
    markOptionalImportFailure(error);
    throw error;
  });

/** Native Tab, activation, editing and component-owned keys work before (and without) this enhancement. */
export function installKeyboardNavigation(): () => void {
  let move: typeof moveFocus | undefined;
  let loading: Promise<void> | undefined;
  let intent = 0;
  let disposed = false;
  const invalidate = () => intent++;
  const load = () =>
    (loading ??= optionalImport(import('./spatialNavigation'))
      .then((module) => {
        if (!disposed) move = module.moveFocus;
      })
      .catch(() => {
        // Failure must not disable native Tab/Enter or report an unhandled optional-import rejection.
        loading = undefined;
      }));

  const keydown = (event: KeyboardEvent) => {
    const ticket = intent;
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    if (event.key === 'Tab') {
      void load();
      return;
    }
    if (event.shiftKey || !/^Arrow(?:Left|Right|Up|Down)$/.test(event.key)) return;
    const target = event.target;
    const direction = event.key.slice(5).toLowerCase() as Direction;
    const settingControl = Boolean(
      target instanceof HTMLElement &&
      target.matches('select, input[type="checkbox"], input[type="radio"]') &&
      target.closest('[data-spatial-anchor]'),
    );
    const regularControl =
      target instanceof HTMLElement &&
      target.matches('a[href],button,summary,[tabindex]') &&
      !target.matches('input, textarea, select');
    const nativeHorizontalControl =
      (direction === 'left' || direction === 'right') &&
      target instanceof HTMLElement &&
      target.matches('select, input[type="radio"]');
    if (
      !(target instanceof HTMLElement) ||
      target !== document.activeElement ||
      (!regularControl && (!settingControl || nativeHorizontalControl)) ||
      target.closest(
        '[contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"], [role="tree"], [role="grid"], [role="slider"], .player, video',
      )
    )
      return;
    if (move) {
      if (move(direction)) event.preventDefault();
      return;
    }
    const address = location.href;
    event.preventDefault();
    void load().then(() => {
      // Loading is asynchronous; a later key, pointer, route or focus change must win over this press.
      if (
        !disposed &&
        ticket === intent &&
        location.href === address &&
        document.activeElement === target &&
        target.isConnected
      )
        move?.(direction);
    });
  };
  // Bubble after controls' own handlers, so search results, menus and native editors keep their key contracts.
  const invalidatingEvents = ['keydown', 'focusin', 'pointerdown', 'popstate', 'blur'] as const;
  for (const type of invalidatingEvents) window.addEventListener(type, invalidate, true);
  window.addEventListener('keydown', keydown);
  document.addEventListener('den:navigate', invalidate);
  return () => {
    disposed = true;
    invalidate();
    for (const type of invalidatingEvents) window.removeEventListener(type, invalidate, true);
    window.removeEventListener('keydown', keydown);
    document.removeEventListener('den:navigate', invalidate);
  };
}
