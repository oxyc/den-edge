type Direction = 'left' | 'right' | 'up' | 'down';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const isEditable = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  !!element.closest('input, textarea, select, [contenteditable="true"]');

function visible(element: HTMLElement, ancestry = new WeakMap<HTMLElement, boolean>()): boolean {
  if (element.hidden || element.matches(':disabled, [aria-disabled="true"]')) return false;
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const closedDetails = element.closest('details:not([open])');
  if (closedDetails && element !== closedDetails.querySelector(':scope > summary')) return false;
  const checked: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const known = ancestry.get(node);
    if (known === false) return false;
    if (known === true) break;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      ancestry.set(node, false);
      return false;
    }
    checked.push(node);
  }
  for (const node of checked) ancestry.set(node, true);
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

const activeDialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');
const activeModal = () => {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]'),
  ).filter((element) => visible(element));
  return modals[modals.length - 1];
};

const focusables = () => {
  // showModal() makes the rest of the document inert in modern Chromium, but LG's older engine does not
  // consistently expose that state. Scope explicitly so geometry can never escape behind a sheet.
  const root: ParentNode = activeModal() ?? document;
  const ancestry = new WeakMap<HTMLElement, boolean>();
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
    visible(element, ancestry),
  );
};

function center(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Prefer the same row/column, while still allowing a diagonal escape at an edge. */
function score(from: DOMRect, to: DOMRect, direction: Direction): number | null {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const primary =
    direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
  if (primary <= 2) return null;
  const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
  // A candidate whose near edge overlaps this control's cross axis feels like a straight move.
  const overlap =
    direction === 'left' || direction === 'right'
      ? Math.max(0, Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top))
      : Math.max(0, Math.min(from.right, to.right) - Math.max(from.left, to.left));
  return primary + secondary * (overlap > 0 ? 2.2 : 4.5);
}

function move(direction: Direction): boolean {
  const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const candidates = focusables();
  if (!candidates.length) return false;
  if (!current || !visible(current) || !candidates.includes(current)) {
    const first = candidates[0]!;
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  }
  const from = current.getBoundingClientRect();
  let winner: HTMLElement | undefined;
  let best = Infinity;
  for (const candidate of candidates) {
    // Some controls expose both a native focusable child and a tabindex-bearing wrapper (details/summary,
    // composite widgets). Moving to an ancestor/descendant is not a spatial move and focus() may be refused.
    if (candidate === current || candidate.contains(current) || current.contains(candidate))
      continue;
    const value = score(from, candidate.getBoundingClientRect(), direction);
    if (value !== null && value < best) {
      best = value;
      winner = candidate;
    }
  }
  if (!winner) return false;
  winner.focus({ preventScroll: true });
  winner.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  return true;
}

function focusIdentity(element: HTMLElement): string | undefined {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const key = element.dataset.tvFocusKey;
  if (key) return `[data-tv-focus-key="${CSS.escape(key)}"]`;
  if (element instanceof HTMLAnchorElement && element.getAttribute('href'))
    return `a[href="${CSS.escape(element.getAttribute('href')!)}"]`;
  const label = element.getAttribute('aria-label');
  if (label) return `[aria-label="${CSS.escape(label)}"]`;
  return undefined;
}

function restore(selector?: string): () => void {
  let done = false;
  let timer = 0;
  const finish = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    clearTimeout(timer);
  };
  const attempt = () => {
    const root: ParentNode = activeModal() ?? document;
    // A title can expose the same href through an inert full-slide link, its hidden title link and the visible
    // TV action. Restore the first *visible* match, not merely the first node in DOM order.
    const remembered = selector
      ? Array.from(root.querySelectorAll<HTMLElement>(selector)).find((element) => visible(element))
      : undefined;
    // With a remembered identity, wait for that control's retained route to reactivate/mount. Falling back
    // immediately would focus Home's brand while the detail page is still the active DOM.
    const target = remembered ?? (selector ? undefined : focusables()[0]);
    if (target) {
      finish();
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest', inline: 'center' });
      return;
    }
  };
  const observer = new MutationObserver(attempt);
  timer = window.setTimeout(() => {
    const fallback = focusables()[0];
    finish();
    fallback?.focus({ preventScroll: true });
    fallback?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, 1_500);
  requestAnimationFrame(() => requestAnimationFrame(attempt));
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  return finish;
}

function atAppRoot(): boolean {
  return location.pathname === '/' || location.pathname === '/library';
}

function requestExit(): void {
  const request = new CustomEvent('den:tv-exit-request', { cancelable: true });
  if (!window.dispatchEvent(request)) return;
  if (!window.confirm('Exit Den?')) return;
  if (__DEN_TV_PLATFORM__ === 'tizen') {
    const api = (
      window as typeof window & {
        tizen?: { application?: { getCurrentApplication?: () => { exit: () => void } } };
      }
    ).tizen;
    api?.application?.getCurrentApplication?.().exit();
  } else {
    window.close();
  }
}

/** Installs remote-key spatial navigation. This module is loaded by TV entry points only. */
export function installTVNavigation(): () => void {
  const memory = new Map<string, string>();
  const pendingRestores = new Set<() => void>();
  let locationKey = location.pathname + location.search;
  let editing: HTMLElement | null = null;

  const restoreSoon = (selector?: string) => {
    for (const pending of pendingRestores) pending();
    pendingRestores.clear();
    const stop = restore(selector);
    pendingRestores.add(stop);
  };

  const rememberAt = (key: string, identity: string) => {
    memory.delete(key);
    memory.set(key, identity);
    if (memory.size > 64) memory.delete(memory.keys().next().value!);
  };

  const remember = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const identity = focusIdentity(active);
      if (identity) rememberAt(locationKey, identity);
    }
  };
  const routeChanged = (event?: Event) => {
    remember();
    const requested = (event as CustomEvent<{ path?: string }> | undefined)?.detail?.path;
    locationKey = requested ?? location.pathname + location.search;
    // Focusing Search itself opens /search. Carry that field into the destination instead of resetting to
    // the brand between the focus event and the route mount.
    const active = document.activeElement;
    if (!memory.has(locationKey) && isEditable(active)) {
      const identity = focusIdentity(active);
      if (identity) rememberAt(locationKey, identity);
    }
    restoreSoon(memory.get(locationKey));
  };
  const onFocus = () => {
    document.documentElement.classList.add('tv-remote-active');
    if (document.activeElement !== editing) editing = null;
    remember();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    // The player has a richer remote state machine and owns every key while focus is inside it.
    if (target?.closest('[data-tv-player], .player, video')) return;
    if (isEditable(target)) {
      const wasEditing = editing === target;
      const startsEditing =
        event.key.length === 1 ||
        event.key === 'Enter' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === 'Delete';
      if (startsEditing) editing = target;
      // First Select on a field enters editing instead of accidentally submitting its surrounding form.
      // A second Select while editing retains the field's native Enter/search behavior.
      if (event.key === 'Enter' && !wasEditing) {
        event.preventDefault();
        return;
      }
    }
    const direction = (
      { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const
    )[event.key];
    if (direction) {
      // Arrow keys inside a native editor belong to its caret/list selection. Up/down at a search field is
      // likewise left to that field's own results behavior.
      if (isEditable(target) && editing === target) return;
      if (
        (direction === 'left' || direction === 'right') &&
        target instanceof HTMLElement &&
        target.matches('[data-tv-carousel-action]')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        target.dispatchEvent(
          new CustomEvent('den:tv-page', { detail: { direction }, bubbles: false }),
        );
        return;
      }
      if (move(direction)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    const back =
      event.key === 'Escape' ||
      event.key === 'Backspace' ||
      event.keyCode === 461 ||
      event.keyCode === 10009;
    if (!back) return;
    if (isEditable(target) && event.key === 'Backspace') return;
    if (isEditable(target) && event.key === 'Escape' && editing === target) {
      // Let the native default dismiss its picker/keyboard, but do not also leave the route.
      editing = null;
      return;
    }
    // LG/Samsung back codes do not dismiss a native input/select the way Escape does. Give the control the
    // equivalent event first; search uses it to close its editing state, while a native picker consumes it.
    if (isEditable(target) && event.key !== 'Escape') {
      event.preventDefault();
      if (editing === target) {
        editing = null;
        return;
      }
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      if (document.activeElement === target) target.blur();
      restoreSoon(focusIdentity(target));
      return;
    }
    const tvBack = new CustomEvent('den:tv-back', { bubbles: true, cancelable: true });
    if (!(target ?? window).dispatchEvent(tvBack)) {
      event.preventDefault();
      return;
    }
    const dialog = activeDialog();
    if (dialog) {
      event.preventDefault();
      const cancel = new Event('cancel', { cancelable: true });
      if (dialog.dispatchEvent(cancel)) dialog.close();
      restoreSoon(memory.get(locationKey));
      return;
    }
    const modal = activeModal();
    if (modal) {
      // ARIA dialogs do not have native cancel/close behavior. Their visible Close control is the reliable
      // contract shared by Trailer and the player-loading screen; consume Back here so it can never also
      // traverse the route behind the overlay. Fall back to an Escape equivalent for custom modal owners.
      event.preventDefault();
      event.stopImmediatePropagation();
      const close = Array.from(modal.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
        (control) =>
          visible(control) &&
          (control.classList.contains('close') ||
            /^close(?:\s|$)/i.test(
              control.getAttribute('aria-label') ?? control.textContent ?? '',
            )),
      );
      if (close) close.click();
      else if (event.key !== 'Escape')
        modal.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      restoreSoon(memory.get(locationKey));
      return;
    }
    event.preventDefault();
    if (atAppRoot()) {
      requestExit();
      return;
    }
    document.dispatchEvent(new Event('den:back'));
  };

  // Capture wins over component-specific browser keyboard affordances (notably Search's ArrowDown). Once a
  // field is explicitly in editing mode we return above and its own handler receives the key normally.
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', routeChanged);
  document.addEventListener('den:navigate', routeChanged);
  document.addEventListener('focusin', onFocus);
  document.documentElement.classList.add('den-tv');
  restoreSoon(memory.get(locationKey));
  return () => {
    remember();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', routeChanged);
    document.removeEventListener('den:navigate', routeChanged);
    document.removeEventListener('focusin', onFocus);
    for (const stop of pendingRestores) stop();
    pendingRestores.clear();
    document.documentElement.classList.remove('den-tv', 'tv-remote-active');
  };
}
