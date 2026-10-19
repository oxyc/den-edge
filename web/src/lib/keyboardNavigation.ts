import type { Direction, moveFocus } from './spatialNavigation';
import { noteOptionalImportFailure } from './optionalImport';

/** Native Tab, activation, editing and component-owned keys work before (and without) this enhancement. */
export function installKeyboardNavigation(): () => void {
  let move: typeof moveFocus | undefined;
  let loading: Promise<void> | undefined;
  let intent = 0;
  let disposed = false;
  const invalidate = () => intent++;
  const load = () =>
    (loading ??= import('./spatialNavigation')
      .then((module) => {
        if (!disposed) move = module.moveFocus;
      })
      .catch((error: unknown) => {
        // Failure must not disable native Tab/Enter or report an unhandled optional-import rejection.
        noteOptionalImportFailure(error);
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
    if (
      !(target instanceof HTMLElement) ||
      target !== document.activeElement ||
      !target.matches('a[href], button, summary, [tabindex]') ||
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="tablist"], [role="menu"], [role="listbox"], [role="tree"], [role="grid"], [role="slider"], .player, video',
      )
    )
      return;
    const direction = event.key.slice(5).toLowerCase() as Direction;
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
  window.addEventListener('keydown', invalidate, true);
  window.addEventListener('keydown', keydown);
  window.addEventListener('focusin', invalidate);
  window.addEventListener('pointerdown', invalidate, true);
  window.addEventListener('popstate', invalidate);
  window.addEventListener('blur', invalidate);
  document.addEventListener('den:navigate', invalidate);
  return () => {
    disposed = true;
    invalidate();
    window.removeEventListener('keydown', invalidate, true);
    window.removeEventListener('keydown', keydown);
    window.removeEventListener('focusin', invalidate);
    window.removeEventListener('pointerdown', invalidate, true);
    window.removeEventListener('popstate', invalidate);
    window.removeEventListener('blur', invalidate);
    document.removeEventListener('den:navigate', invalidate);
  };
}
