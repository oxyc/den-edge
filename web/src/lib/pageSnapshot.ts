/** Marks a copy's root: everything under it is held still by one rule (`frozenStyle`), not per node. */
const FROZEN = 'data-page-snapshot';
let frozenStyled = false;
function frozenStyle(): void {
  if (frozenStyled) return;
  frozenStyled = true;
  const style = document.createElement('style');
  style.textContent = `[${FROZEN}], [${FROZEN}] * { animation: none !important; transition: none !important; scroll-behavior: auto !important; scroll-snap-type: none !important; }`;
  document.head.append(style);
}

/** A detached, inert copy of the visible route, at its current viewport and rail positions. */
export interface PageSnapshot {
  show(): HTMLElement;
  refresh(): PageSnapshot;
}
/** What a copy freezes at the source's painted values, since a paused clone starts at animation time zero. */
const PAINTED = [
  'transform',
  'translate',
  'rotate',
  'scale',
  'opacity',
  'filter',
  'backdrop-filter',
];
/**
 * Measures the page now, and copies it only when the copy is first shown.
 *
 * What depends on the page being laid out on screen — where it sits, its rails' offsets, the painted values of
 * what is in view, a playing trailer's frame — is read here, while it still is. The copy itself, ~20 ms of
 * `cloneNode` on Home at 4x CPU, is made from the page as it is when it is first wanted: a swipe or a loading
 * cover, which most pages left are never shown as. Leaving a page by a tap no longer pays for it.
 */
export function capturePage(
  source = document.querySelector<HTMLElement>('[data-route-page][data-active="true"]'),
  rootStyle?: string,
): PageSnapshot | null {
  if (!source) return null;
  const rect = source.getBoundingClientRect();
  const savedY = window.scrollY;
  const viewport = `${innerWidth}x${innerHeight}`;
  // Reading every node's computed style is what this cost on the tap path: 1,500 nodes took ~55 ms
  // at 4x CPU throttling in headless Chromium, against 3-14 ms reading only these. A node that paints
  // nowhere in the viewport can't be seen in the copy, and one that isn't animated computes the same
  // values there as here — except for state the copy lacks (`:hover`, focus), which is on screen.
  const animated = new Set(
    source.getAnimations({ subtree: true }).map((animation) => {
      const effect = animation.effect;
      return effect instanceof KeyframeEffect ? effect.target : null;
    }),
  );
  const seen = (node: HTMLElement) => {
    if (animated.has(node)) return true;
    const box = node.getBoundingClientRect();
    // An empty box can still hold what paints (a wrapper, a zero-height positioning parent).
    if (box.width === 0 || box.height === 0) return true;
    return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
  };
  /** Each node scrolled away from its origin, by node: a copy made later finds its own by the same walk. */
  const offsets = new Map<Element, { x: number; y: number }>();
  const painted = new Map<Element, string[]>();
  for (const node of [source, ...source.querySelectorAll<HTMLElement>('*')]) {
    if (node.scrollLeft || node.scrollTop)
      offsets.set(node, { x: node.scrollLeft, y: node.scrollTop });
    if (!seen(node)) continue;
    const style = getComputedStyle(node);
    painted.set(
      node,
      PAINTED.map((property) => style.getPropertyValue(property)),
    );
  }
  // cloneNode cannot copy a decoder's current frame. Paint it into an inert canvas so a swipe
  // freezes the visible trailer instead of abruptly exposing the backdrop beneath it. Now, while the
  // element is still decoding on screen.
  const frames = new Map<HTMLVideoElement, HTMLCanvasElement>();
  for (const original of source.querySelectorAll('video')) {
    const style = getComputedStyle(original);
    const bounds = original.getBoundingClientRect();
    if (
      original.readyState < 2 ||
      !original.videoWidth ||
      !original.videoHeight ||
      Number(style.opacity) <= 0 ||
      bounds.bottom <= 0 ||
      bounds.top >= innerHeight ||
      bounds.right <= 0 ||
      bounds.left >= innerWidth
    )
      continue;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1920 / original.videoWidth);
    canvas.width = Math.max(1, Math.round(original.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(original.videoHeight * scale));
    // Preserve replaced-element sizing/object-fit even where the stylesheet targets `video`.
    for (const property of style)
      canvas.style.setProperty(property, style.getPropertyValue(property));
    canvas.style.setProperty('animation', 'none', 'important');
    canvas.style.setProperty('transition', 'none', 'important');
    try {
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.drawImage(original, 0, 0, canvas.width, canvas.height);
      frames.set(original, canvas);
    } catch {
      /* A decoder without a readable frame keeps the still artwork underneath. */
    }
  }
  let made:
    | {
        copy: HTMLElement;
        retained: HTMLElement[];
        offsets: ({ x: number; y: number } | undefined)[];
      }
    | undefined;
  /**
   * The copy, made from the page as it is now if it has not been made since the page last changed. A page left
   * hidden still receives its data, so one that has changed since its copy was made is copied again.
   */
  const make = () => {
    if (made) return made;
    const copy = source.cloneNode(true) as HTMLElement;
    const originals = [source, ...source.querySelectorAll<HTMLElement>('*')];
    const copies = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
    const copyOffsets = new Map<Element, { x: number; y: number }>();
    copy.setAttribute(FROZEN, '');
    frozenStyle();
    copies.forEach((node, i) => {
      const original = originals[i]!;
      node.removeAttribute('id');
      node.removeAttribute('data-route-page');
      node.removeAttribute('data-active');
      const values = painted.get(original);
      if (values)
        PAINTED.forEach((property, k) => node.style.setProperty(property, values[k]!, 'important'));
      const offset = offsets.get(original);
      if (offset) copyOffsets.set(node, offset);
      if (node instanceof HTMLInputElement && original instanceof HTMLInputElement) {
        node.value = original.value;
        node.checked = original.checked;
      }
      if (!(original instanceof HTMLVideoElement)) return;
      // A media element starts loading the moment it is given a `src`, cloned or not, in a document or not; with
      // `autoplay` it plays, unseen. Taken off before the load can begin, in this same task.
      if (node instanceof HTMLVideoElement) {
        node.removeAttribute('src');
        node.removeAttribute('autoplay');
      }
      const frame = frames.get(original);
      if (!frame) return node.remove();
      const canvas = frame.cloneNode() as HTMLCanvasElement;
      canvas.getContext('2d')?.drawImage(frame, 0, 0);
      node.replaceWith(canvas);
    });
    // A retained hidden page deliberately does not observe or fetch deferred poster art. A swipe is the first
    // moment that page is actually about to paint again: materialize its marked artwork in the inert copy only,
    // without waking the hidden page's components, listeners, or image network work.
    for (const art of copy.querySelectorAll<HTMLElement>('[data-snapshot-poster]')) {
      const src = art.dataset.snapshotPoster;
      if (!src || art.querySelector(':scope > img')) continue;
      const image = document.createElement('img');
      image.src = src;
      image.alt = '';
      image.decoding = 'async';
      image.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover';
      art.prepend(image);
      art.removeAttribute('data-snapshot-poster');
    }
    // A page copied once it was left is hidden; its copy is not.
    copy.hidden = false;
    copy.querySelectorAll('iframe').forEach((node) => node.remove());
    if (rootStyle !== undefined) copy.style.cssText = rootStyle;
    const retained = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
    made = { copy, retained, offsets: retained.map((node) => copyOffsets.get(node)) };
    // Watched only once copied, until the first change: its own `hidden` and `inert` flipping as it is
    // left are not one. A page back on screen is captured afresh before it is shown again (`refresh`).
    const changed = new MutationObserver((records) => {
      if (source.hidden && records.every((record) => record.target === source)) return;
      made = undefined;
      changed.disconnect();
    });
    changed.observe(source, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    return made;
  };
  return {
    refresh() {
      if (!source.isConnected || !source.hidden) return capturePage(source) ?? this;
      // A page that only received data while hidden needs nothing here: its copy is made, or made again, from
      // the page as it is when shown. Measuring it afresh lays the whole page out offscreen — on Home at 4x CPU
      // a frame of over 200 ms on the first move of a swipe — and is worth that only once the window it was measured in
      // has changed shape, as a phone turned on its side does.
      if (`${innerWidth}x${innerHeight}` === viewport) return this;
      const active = document.querySelector<HTMLElement>('[data-route-page][data-active="true"]');
      if (!active) return this;
      const activeRect = active.getBoundingClientRect();
      const documentTop = activeRect.top + window.scrollY;
      const style = source.style.cssText;
      const hidden = source.hidden;
      try {
        // Measure offscreen state in the same viewport width and formatting context as the live
        // route. This happens synchronously under the outgoing page, without changing its scroll.
        source.style.cssText += `;position:fixed;visibility:hidden;left:${activeRect.left}px;top:${documentTop - savedY}px;width:${activeRect.width}px;margin:0;`;
        source.hidden = false;
        for (const [node, { x, y }] of offsets)
          node.scrollTo({ left: x, top: y, behavior: 'instant' });
        let bottomSpace = 0;
        for (let ancestor = source.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const css = getComputedStyle(ancestor);
          bottomSpace +=
            (parseFloat(css.paddingBottom) || 0) +
            (parseFloat(css.borderBottomWidth) || 0) +
            (parseFloat(css.marginBottom) || 0);
        }
        const maxY = Math.max(
          0,
          Math.round(documentTop + source.getBoundingClientRect().height + bottomSpace) -
            innerHeight,
        );
        source.style.top = `${documentTop - Math.min(savedY, maxY)}px`;
        return capturePage(source, style) ?? this;
      } finally {
        source.hidden = hidden;
        source.style.cssText = style;
      }
    },
    show() {
      const frame = document.createElement('div');
      frame.inert = true;
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:absolute;inset:0;overflow:hidden;background:var(--bg,#0b0b0f);';
      // Each display owns its DOM. Loading and gesture overlays can overlap without stealing
      // the saved frame from one another or mutating the cached snapshot.
      const { copy, retained, offsets: retainedOffsets } = make();
      const displayed = copy.cloneNode(true) as HTMLElement;
      const displayedNodes = [displayed, ...displayed.querySelectorAll<HTMLElement>('*')];
      retained.forEach((node, i) => {
        const target = displayedNodes[i];
        if (node instanceof HTMLCanvasElement && target instanceof HTMLCanvasElement) {
          target.getContext('2d')?.drawImage(node, 0, 0);
        }
      });
      displayed.style.cssText += `;position:absolute;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;margin:0;`;
      frame.append(displayed);
      // Restore once attached, since detached elements have no scrollable layout.
      requestAnimationFrame(() =>
        retainedOffsets.forEach((offset, i) => {
          if (offset)
            displayedNodes[i]?.scrollTo({ left: offset.x, top: offset.y, behavior: 'instant' });
        }),
      );
      return frame;
    },
  };
}

export interface SwipePreview {
  move(distance: number): void;
  finish(commit: boolean): Promise<void>;
  release(): Promise<void>;
  dispose(): void;
}
export function previewHistory(previous: PageSnapshot, direction: 1 | -1 = 1): SwipePreview | null {
  const current = capturePage();
  if (!current) return null;
  const overlay = document.createElement('div');
  overlay.dataset.swipePreview = '';
  overlay.style.cssText =
    'position:fixed;inset:0;overflow:hidden;z-index:9;pointer-events:none;background:var(--bg,#0b0b0f);';
  const underneath = previous.show();
  const front = current.show();
  front.style.boxShadow = `${-12 * direction}px 0 32px rgb(0 0 0 / .25)`;
  overlay.append(underneath, front);
  document.body.append(overlay);
  let distance = 0;
  const width = innerWidth;
  const move = (dx: number) => {
    distance = Math.max(0, Math.min(width, dx));
    front.style.transform = `translateX(${direction * distance}px)`;
    underneath.style.transform = `translateX(${direction * -0.18 * (width - distance)}px)`;
  };
  move(0);
  return {
    move,
    async finish(commit) {
      const target = commit ? width : 0;
      const options = {
        duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
        easing: 'cubic-bezier(.2,.7,.2,1)',
        fill: 'forwards' as const,
      };
      await Promise.all([
        front
          .animate(
            [
              {
                transform: `translateX(${direction * distance}px)`,
                boxShadow: front.style.boxShadow,
              },
              {
                transform: `translateX(${direction * target}px)`,
                boxShadow: commit ? 'none' : front.style.boxShadow,
              },
            ],
            options,
          )
          .finished.catch(() => {}),
        underneath
          .animate(
            [
              { transform: `translateX(${direction * -0.18 * (width - distance)}px)` },
              { transform: `translateX(${direction * -0.18 * (width - target)}px)` },
            ],
            options,
          )
          .finished.catch(() => {}),
      ]);
    },
    async release() {
      // Shared library data can legitimately change while away. Blend that last small difference
      // only after the restored page has painted, rather than exposing it in a one-frame cut.
      await overlay
        .animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 90,
          easing: 'ease-out',
          fill: 'forwards',
        })
        .finished.catch(() => {});
    },
    dispose: () => overlay.remove(),
  };
}

/** Let restored rails, scroll timelines and decoded visible artwork paint underneath the swipe overlay. */
export async function prepareSwipeLanding(): Promise<void> {
  const page = document.querySelector<HTMLElement>('[data-route-page][data-active="true"]');
  const images = Array.from(page?.querySelectorAll('img') ?? []).filter((image) => {
    const box = image.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.bottom > 0 &&
      box.top < innerHeight &&
      box.right > 0 &&
      box.left < innerWidth
    );
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(images.map((image) => image.decode().catch(() => {}))),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 200);
    }),
  ]);
  clearTimeout(timeout);
  // This runs only for interactive gestures, never inside a View Transition's paused rendering callback.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
