import { flushSync } from 'svelte';
import { appPath, routeKey as pageRouteKey } from '../lib/navigation';
import { parseRoute } from '../lib/route';
import { currentAppPath } from '../lib/runtimeUrl';
import { SearchScreen } from '../lib/screens.svelte';
import { exitTvApp } from './platform';
import {
  activeDialog,
  activeModal,
  focusables,
  FOCUSABLE,
  isEditable,
  moveFocus,
  visible,
} from '../lib/spatialNavigation';

// A remote press is discrete, and the focused surface is the transition. Long native smooth-scroll animations make
// every intermediate frame recompute row/card observers and repaint large title pages on TV-class CPUs. Keep the
// shared browser enhancement smooth, but reveal a remote destination in the same frame as focus.
const move = (
  direction: Parameters<typeof moveFocus>[0],
  include?: Parameters<typeof moveFocus>[1],
) => moveFocus(direction, include, 'auto');

/* A title page is entered to act on the title. Its primary action is deliberately first in DOM order; when Play is
   unavailable, the first remaining pill is the honest fallback. Scope this to the active retained route so a
   previous title page cannot take focus while the new one is mounting. */
const DETAIL_ENTRY =
  '[data-route-page][data-active="true"] .hero-actions .main-action, ' +
  '[data-route-page][data-active="true"] .hero-actions .pill';

function focusIdentity(element: HTMLElement): string | undefined {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const key = element.dataset.tvFocusKey;
  if (key) {
    // The same title can legitimately appear in several shelves. Include its originating named row so Back
    // restores the card the viewer actually opened, while still waiting for that row's virtual card to remount.
    const row = element.closest<HTMLElement>('.row[aria-label]');
    const rowLabel = row?.getAttribute('aria-label');
    if (rowLabel)
      return `.row[aria-label="${CSS.escape(rowLabel)}"] [data-tv-focus-key="${CSS.escape(key)}"]`;
    return `[data-tv-focus-key="${CSS.escape(key)}"]`;
  }
  if (element instanceof HTMLAnchorElement && element.getAttribute('href'))
    return `a[href="${CSS.escape(element.getAttribute('href')!)}"]`;
  const label = element.getAttribute('aria-label');
  if (label) return `[aria-label="${CSS.escape(label)}"]`;
  return undefined;
}

/** Whether route restoration can focus this control without moving the document Router just restored. */
function restoredFocusSurfaceVisible(element: HTMLElement): boolean {
  // Dialogs and sheets can own constrained vertical scrollers. Preserve their existing reveal behavior rather
  // than treating window geometry as proof that a control is visible inside the modal's own clip.
  if (element.closest('dialog[open], [role="dialog"][aria-modal="true"]')) return false;
  // A poster card's metadata may deliberately continue just below the fold while its large focus surface is wholly
  // visible. Asking scrollIntoView about the whole anchor moved WebKit 12px after Router restored the saved offset.
  const surface = element.matches('.card')
    ? (element.querySelector<HTMLElement>('.art') ?? element)
    : element;
  const rect = surface.getBoundingClientRect();
  const track = element.closest<HTMLElement>('.track')?.getBoundingClientRect();
  const left = Math.max(0, track?.left ?? 0);
  const right = Math.min(innerWidth, track?.right ?? innerWidth);
  const barBottom = element.closest('.bar')
    ? 0
    : (document.querySelector<HTMLElement>('.bar')?.getBoundingClientRect().bottom ?? 0);
  return (
    rect.width > 1 &&
    rect.height > 1 &&
    rect.left >= left &&
    rect.right <= right &&
    rect.top >= barBottom &&
    rect.bottom <= innerHeight
  );
}

function restore(selector?: string): () => void {
  let done = false;
  let timer = 0;
  let restored = false;
  const finish = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    clearTimeout(timer);
  };
  const attempt = () => {
    if (done) return;
    const root: ParentNode = activeModal() ?? document;
    // A title can expose the same href through an inert full-slide link, its hidden title link and the visible
    // TV action. Restore the first *visible* match, not merely the first node in DOM order.
    const remembered = selector
      ? Array.from(root.querySelectorAll<HTMLElement>(selector)).find((element) => visible(element))
      : undefined;
    // With a remembered identity, wait for that control's retained route to reactivate/mount. Falling back
    // immediately would focus Home's brand while the detail page is still the active DOM.
    const initial =
      currentAppPath().split(/[?#]/, 1)[0] === '/search'
        ? root.querySelector<HTMLElement>('[data-route-page][data-active="true"] .tv-search-input')
        : focusables()[0];
    const target = remembered ?? (selector ? undefined : initial);
    if (target) {
      // Initial focus is complete once the first control exists. Keeping this observer alive made every async
      // shelf mutation pull focus back to Home while a viewer was already moving through Search or Settings.
      if (!selector) finish();
      else {
        const active = document.activeElement;
        // A viewer's deliberate move wins over restoration. Continue only while the remembered control still
        // owns focus (it may be blurred by a retained-route swap) or while focus is nowhere useful.
        if (
          restored &&
          active instanceof HTMLElement &&
          active !== document.body &&
          active !== target
        ) {
          finish();
          return;
        }
      }
      restored = true;
      target.focus({ preventScroll: true });
      if (!restoredFocusSurfaceVisible(target))
        target.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  };
  const observer = new MutationObserver(attempt);
  timer = window.setTimeout(() => {
    // Route pages are retained and swap visibility asynchronously. Keep reasserting the remembered target
    // through that transition; otherwise a later inert/active update can leave focus on body. Only use the
    // first-page fallback when the remembered control never appeared.
    attempt();
    const fallback = restored ? undefined : focusables()[0];
    finish();
    fallback?.focus({ preventScroll: true });
    if (fallback && !restoredFocusSurfaceVisible(fallback))
      fallback.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, 1_500);
  requestAnimationFrame(() => requestAnimationFrame(attempt));
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  return finish;
}

function atAppRoot(): boolean {
  const path = currentAppPath().split(/[?#]/, 1)[0];
  return path === '/' || path === '/library';
}

function routeKey(path = currentAppPath()): string {
  // location.href is a valid base for hosted and packaged file:// widgets; opaque origins can stringify to
  // "null", which is not a URL base.
  const url = new URL(path, location.href);
  return url.pathname + url.search;
}

function requestExit(): void {
  const request = new CustomEvent('den:tv-exit-request', { cancelable: true });
  if (!window.dispatchEvent(request)) return;
  if (!window.confirm('Exit Den?')) return;
  if (!exitTvApp()) window.close();
}

/** Installs remote-key spatial navigation. This module is loaded by TV entry points only. */
export function installTVNavigation(): () => void {
  const memory = new Map<string, string>();
  const pendingRestores = new Set<() => void>();
  let locationKey = routeKey();
  let editing: HTMLElement | null = null;
  let forwardingBackToEditor = false;

  // A phone used to inspect the TV build needs Search mounted before its tap ends: mobile WebKit only starts the
  // software keyboard when the destination input receives focus during that activation. On a TV, remote focus is
  // the same useful preload intent. This whole module is absent from the normal browser build.
  // Search is the first control in the TV rail and a touch preview must mount its editor inside the activating
  // tap. Preload it for every TV session: some touch-capable desktop shells report neither a coarse pointer nor
  // touch points reliably, and discovering the chunk on pointerdown is too late for mobile keyboard activation.
  void SearchScreen.load();
  const searchButton = (event: Event) =>
    event.target instanceof Element ? event.target.closest('.tv-search-button') : null;
  const prepareSearch = (event: Event) => {
    if (searchButton(event)) void SearchScreen.load();
  };
  const focusSearchDuringActivation = (event: Event) => {
    if (!searchButton(event)) return;
    flushSync();
    document
      .querySelector<HTMLInputElement>('[data-route-page][data-active="true"] .tv-search-input')
      ?.focus({ preventScroll: true });
  };

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
    const previousKey = locationKey;
    const nextKey = routeKey(requested);
    const active = document.activeElement;
    const identity = active instanceof HTMLElement ? focusIdentity(active) : undefined;
    locationKey = nextKey;
    // A link that changes only the active page's address (a series season, Search facet, or watched year) remains
    // the same control in the same retained page. Keep it focused and teach the new history entry its identity;
    // route-level restoration is for a page boundary or Back, and would otherwise jump to the page's first control.
    if (
      active instanceof HTMLAnchorElement &&
      identity &&
      routeKey(active.href) === nextKey &&
      pageRouteKey(parseRoute(previousKey)) === pageRouteKey(parseRoute(nextKey))
    ) {
      rememberAt(nextKey, identity);
      return;
    }
    // Focusing Search itself opens /search. Carry that field into the destination instead of resetting to
    // the brand between the focus event and the route mount.
    if (!memory.has(locationKey) && isEditable(active)) {
      if (identity) rememberAt(locationKey, identity);
    }
    const destination = parseRoute(nextKey);
    const detailEntry =
      destination.page === 'title' && !destination.play && !destination.trailer
        ? DETAIL_ENTRY
        : undefined;
    restoreSoon(memory.get(locationKey) ?? detailEntry);
  };
  const prepareDetailEntry = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const anchor =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null;
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self'))
      return;
    const path = appPath(anchor.href, location.href);
    if (path === null) return;
    const destination = parseRoute(path);
    if (destination.page !== 'title' || destination.play || destination.trailer) return;
    // Router owns the click and starts its retained-page swap later in this same dispatch. Begin observing after
    // every click listener has run, while the source card is still the active semantic control.
    queueMicrotask(() =>
      routeChanged(new CustomEvent<{ path: string }>('den:navigate', { detail: { path } })),
    );
  };
  const onFocus = () => {
    document.documentElement.classList.add('tv-remote-active');
    if (document.activeElement !== editing) editing = null;
    // Anchor navigation is intercepted directly by Router and does not emit den:navigate. Its first page control
    // can focus before popstate ever occurs, so associate it with the address now on screen instead of overwriting
    // the source route's remembered control.
    locationKey = routeKey();
    remember();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    // A hardware Back on an editor is translated below into Escape for its owning component. Let that one
    // synthetic event reach the component instead of treating it as a second, route-level Back in capture.
    if (forwardingBackToEditor && event.key === 'Escape') return;
    // A deliberate press supersedes Back's pending focus/scroll restoration, including its next-frame pass.
    // Emit before consuming the hardware key so retained pages can cancel without competing capture listeners.
    for (const stop of pendingRestores) stop();
    pendingRestores.clear();
    window.dispatchEvent(new Event('den:tv-input'));
    let target = event.target instanceof Element ? event.target : null;
    const direction = (
      { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const
    )[event.key];
    // A live shelf publication can replace the focused node between remote presses. The browser then targets the
    // next key at body; spatialNavigation's generic cold-start fallback is Search, so a following Select appeared
    // to open Search at random. Recover the route's remembered semantic control first and apply this same direction
    // to its replacement. This also covers any other progressively replaced control, not one shelf exception.
    if (direction && document.activeElement === document.body) {
      const selector = memory.get(locationKey);
      const root: ParentNode = activeModal() ?? document;
      let recovered: HTMLElement | undefined;
      if (selector) {
        try {
          recovered = Array.from(root.querySelectorAll<HTMLElement>(selector)).find((element) =>
            visible(element),
          );
        } catch {
          // A remembered selector is produced by focusIdentity and should be valid. If the DOM implementation
          // rejects it, retain the ordinary cold-start behavior rather than losing remote navigation entirely.
        }
      }
      if (recovered) {
        recovered.focus({ preventScroll: true });
        target = recovered;
      }
    }
    // The player has a richer remote state machine and owns every key while focus is inside it.
    if (target?.closest('[data-tv-player], .player, video')) return;
    if (
      event.key === 'Enter' &&
      target instanceof HTMLInputElement &&
      (target.type === 'checkbox' || target.type === 'radio')
    ) {
      event.preventDefault();
      target.click();
      return;
    }
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
        if (target.closest('#nav-search') && !currentAppPath().startsWith('/search')) {
          editing = null;
          target.closest('form')?.requestSubmit();
        }
        return;
      }
    }
    if (direction) {
      // Arrow keys inside a native editor belong to its caret/list selection. Up/down at a search field is
      // likewise left to that field's own results behavior.
      if (isEditable(target) && editing === target) return;
      // A radio group uses roving tabindex, so only its selected input participates in the page-wide spatial
      // scan. Keep horizontal presses inside the segmented control and commit the newly focused option just as
      // a native keyboard interaction does; vertical presses still leave the row.
      if (
        target instanceof HTMLInputElement &&
        target.type === 'radio' &&
        (direction === 'left' || direction === 'right')
      ) {
        const group = target.closest('[role="radiogroup"]');
        const radios = group
          ? Array.from(
              group.querySelectorAll<HTMLInputElement>('input[type="radio"]:not(:disabled)'),
            )
          : [];
        const here = radios.indexOf(target);
        if (here >= 0 && radios.length > 1) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const step = direction === 'left' ? -1 : 1;
          const next = radios[(here + step + radios.length) % radios.length]!;
          next.focus({ preventScroll: true });
          next.click();
          return;
        }
      }
      // Home's billboard is the first content row. Pure center-distance scoring can prefer a service tile far
      // below Search because the hero action is intentionally left-aligned; Down from the top bar must enter
      // the visible slide before it can skip to lower shelves.
      if (direction === 'down' && target instanceof HTMLElement && target.closest('.tv-bar')) {
        const activePage = document.querySelector<HTMLElement>(
          '[data-route-page][data-active="true"]',
        );
        const entry = activePage?.querySelector<HTMLElement>('[data-spatial-page-entry]');
        const destination = entry?.matches(FOCUSABLE)
          ? entry
          : Array.from(entry?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).find(
              (element) => element.tabIndex >= 0 && visible(element),
            );
        if (destination && destination.tabIndex >= 0 && visible(destination)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          destination.focus({ preventScroll: true });
          destination.scrollIntoView({ block: 'nearest', inline: 'center' });
          return;
        }
      }
      // A tablist owns horizontal selection. Its inactive tabs use the required roving tabindex=-1, so the
      // spatial scan cannot see them; let the component move focus and select the adjacent season itself.
      if (
        target instanceof HTMLElement &&
        target.matches('[role="tab"]') &&
        (direction === 'left' || direction === 'right')
      )
        return;
      if (
        (direction === 'left' || direction === 'right') &&
        target instanceof HTMLElement &&
        target.closest('[data-tv-carousel-action]')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        target
          .closest<HTMLElement>('[data-tv-carousel-action]')!
          .dispatchEvent(new CustomEvent('den:tv-page', { detail: { direction }, bubbles: false }));
        return;
      }
      // The fixed bar remains visible for the LG pointer, but a remote should not jump out of content into it
      // while the page is scrolled. At the upper content boundary the first Up scrolls home; only a subsequent
      // Up, now genuinely at the top, can enter navigation.
      const contentOnly =
        direction === 'up' && scrollY > 8
          ? (candidate: HTMLElement) => !candidate.closest('.tv-bar')
          : undefined;
      if (move(direction, contentOnly)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (direction === 'up' && scrollY > 8) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Do not leave focus stranded on the billboard while a smooth scroll is still in flight: repeated remote
        // Up presses would keep restarting that animation. Land at the content boundary now; the next Up can enter
        // the fixed navigation bar normally.
        scrollTo({ top: 0, behavior: 'auto' });
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
      forwardingBackToEditor = true;
      try {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      } finally {
        forwardingBackToEditor = false;
      }
      // An owner such as SettingRow may close itself and deliberately focus its trigger. Only provide the
      // generic blur/restore fallback when the translated Escape left focus on the editor.
      if (document.activeElement === target) {
        target.blur();
        restoreSoon(focusIdentity(target));
      }
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
    // Once Back leaves a route, do not let that same Escape continue into a retained component's local handler
    // and steal focus back after the router restores the source control.
    event.stopImmediatePropagation();
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
  document.addEventListener('click', prepareDetailEntry, true);
  document.addEventListener('focusin', onFocus);
  document.addEventListener('focusin', prepareSearch);
  document.addEventListener('pointerdown', prepareSearch);
  document.addEventListener('click', focusSearchDuringActivation);
  document.documentElement.classList.add('den-tv');
  restoreSoon(memory.get(locationKey));
  return () => {
    remember();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', routeChanged);
    document.removeEventListener('den:navigate', routeChanged);
    document.removeEventListener('click', prepareDetailEntry, true);
    document.removeEventListener('focusin', onFocus);
    document.removeEventListener('focusin', prepareSearch);
    document.removeEventListener('pointerdown', prepareSearch);
    document.removeEventListener('click', focusSearchDuringActivation);
    for (const stop of pendingRestores) stop();
    pendingRestores.clear();
    document.documentElement.classList.remove('den-tv', 'tv-remote-active');
  };
}
