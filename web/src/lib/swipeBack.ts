import type { SwipePreview } from './pageSnapshot';

interface SwipeDestination {
  canNavigate(): boolean;
  navigate(): void;
  preview(): SwipePreview | null;
}

/** One controller owns both edges, including the animation and the handoff after touchend. */
export function swipeHistory(target: Document, destinations: { back: SwipeDestination; forward: SwipeDestination }): () => void {
  let start: { x: number; y: number; id: number; direction: 1 | -1 | null; element: Element; blocked: boolean } | null = null;
  let destination: SwipeDestination | null = null;
  let visual: SwipePreview | null = null;
  let claimed = false;
  let finishing = false;
  let traversing = false;
  let releasing = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let lastEnd: { x: number; y: number; until: number } | null = null;
  const edge = (x: number) => x <= 24 || x >= innerWidth - 24;
  const reset = () => {
    clearTimeout(fallback);
    start = null;
    destination = null;
    visual?.dispose();
    visual = null;
    claimed = finishing = traversing = releasing = false;
  };
  const completed = () => {
    const held = visual;
    if (!held) return reset();
    if (releasing) return;
    releasing = true;
    void held.release().then(() => { if (visual === held) reset(); });
  };
  const begin = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (finishing) {
      // A second edge gesture must not fall through to the browser while the first is landing.
      if (touch && edge(touch.clientX) && event.cancelable) event.preventDefault();
      return;
    }
    reset();
    if (event.defaultPrevented || event.touches.length !== 1 || !touch || !event.cancelable) return;
    const atEdge = edge(touch.clientX);
    const direction = atEdge ? (touch.clientX <= 24 ? 1 : -1) : null;
    const next = direction === 1 ? destinations.back : direction === -1 ? destinations.forward : null;
    if (next ? !next.canNavigate() : !destinations.back.canNavigate() && !destinations.forward.canNavigate()) return;
    const element = event.target as Element;
    if (element.closest('input, textarea, select, [contenteditable], [role="dialog"], video, iframe')) return;
    // Interior drags belong to carousels. At the screen edge, history owns the gesture,
    // even when a full-width carousel or one of its buttons is underneath the finger.
    if (!atEdge) {
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
      }
    }
    // Cancel native edge navigation immediately. Snapshot work waits until horizontal intent
    // is known, keeping touchstart fast and leaving ordinary interior taps/vertical scroll alone.
    if (atEdge) event.preventDefault();
    destination = next;
    start = { x: touch.clientX, y: touch.clientY, id: touch.identifier, direction, element, blocked: atEdge };
  };
  const move = (event: TouchEvent) => {
    if (finishing) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (!start) return;
    if (event.touches.length !== 1) return reset();
    const touch = Array.from(event.touches).find(touch => touch.identifier === start?.id);
    if (!touch) return reset();
    const rawX = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (!claimed) {
      if (dy > 12 && dy >= Math.abs(rawX)) return reset();
      if (Math.abs(rawX) <= 16 || Math.abs(rawX) <= dy * 2) return;
      const direction = rawX > 0 ? 1 : -1;
      if (start.direction !== null && direction !== start.direction) return reset();
      const next = direction === 1 ? destinations.back : destinations.forward;
      if (!next.canNavigate() || !event.cancelable) return reset();
      event.preventDefault();
      start.direction = direction;
      destination = next;
      visual = next.preview();
      if (!visual) return reset();
      claimed = true;
    }
    if (event.cancelable) event.preventDefault();
    visual?.move(start.direction! * rawX);
  };
  const end = (event: TouchEvent) => {
    if (!start) {
      if (finishing && event.cancelable) event.preventDefault();
      return;
    }
    const touch = Array.from(event.changedTouches).find(touch => touch.identifier === start?.id);
    const go = !!touch && claimed && isBackSwipe(start.direction! * (touch.clientX - start.x), touch.clientY - start.y);
    if (!claimed) {
      const tapped = touch && Math.abs(touch.clientX - start.x) < 8 && Math.abs(touch.clientY - start.y) < 8;
      const element = start.element;
      const blocked = start.blocked;
      reset();
      // touchstart cancellation suppresses the browser click, so preserve an actual edge tap.
      if (blocked && tapped && element instanceof HTMLElement) {
        if (event.cancelable) event.preventDefault();
        element.click();
      }
      return;
    }
    const held = visual;
    const next = destination;
    if (event.cancelable) event.preventDefault();
    if (touch) lastEnd = { x: touch.clientX, y: touch.clientY, until: Date.now() + 400 };
    start = null;
    claimed = false;
    if (!held || !next) return reset();
    finishing = true;
    void held.finish(go).then(() => {
      if (visual !== held) return;
      if (go && next.canNavigate()) {
        traversing = true;
        next.navigate();
        fallback = setTimeout(() => { if (visual === held) completed(); }, 1500);
      } else completed();
    });
  };
  const clicked = (event: MouseEvent) => {
    // Some mobile browsers synthesize a click after touchend. It must not open a title underneath
    // the completed swipe and look like an extra navigation or reload. Keyboard clicks still work.
    if (event.detail && lastEnd && Date.now() < lastEnd.until &&
      Math.abs(event.clientX - lastEnd.x) < 32 && Math.abs(event.clientY - lastEnd.y) < 32) {
      event.preventDefault();
      event.stopImmediatePropagation();
      lastEnd = null;
    }
  };
  const historyChanged = () => {
    // If the browser won the gesture, never also commit an app traversal on touchend.
    if (visual && !traversing) reset();
  };
  target.addEventListener('den:swipe-restored', completed);
  target.addEventListener('den:swipe-cancel', reset);
  target.addEventListener('touchstart', begin, { passive: false, capture: true });
  target.addEventListener('touchmove', move, { passive: false, capture: true });
  target.addEventListener('touchend', end, { passive: false, capture: true });
  target.addEventListener('touchcancel', reset, { passive: true });
  target.addEventListener('click', clicked, true);
  target.defaultView?.addEventListener('popstate', historyChanged);
  return () => {
    reset();
    target.removeEventListener('den:swipe-restored', completed);
    target.removeEventListener('den:swipe-cancel', reset);
    target.removeEventListener('touchstart', begin, true);
    target.removeEventListener('touchmove', move, true);
    target.removeEventListener('touchend', end, true);
    target.removeEventListener('touchcancel', reset);
    target.removeEventListener('click', clicked, true);
    target.defaultView?.removeEventListener('popstate', historyChanged);
  };
}

export const isBackSwipe = (dx: number, dy: number) => dx >= 72 && dx > Math.abs(dy) * 2;
