/** A detached, inert copy of the visible route, at its current viewport and rail positions. */
export interface PageSnapshot {
  show(): HTMLElement;
  refresh(): PageSnapshot;
}
export function capturePage(
  source = document.querySelector<HTMLElement>('[data-route-page][data-active="true"]'),
  rootStyle?: string,
): PageSnapshot | null {
  if (!source) return null;
  const rect = source.getBoundingClientRect();
  const savedY = window.scrollY;
  const copy = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>('*')];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
  const offsets = new Map(
    copies.map((node, i) => [node, { x: originals[i]!.scrollLeft, y: originals[i]!.scrollTop }]),
  );
  copies.forEach((node, i) => {
    node.removeAttribute('id');
    node.removeAttribute('data-route-page');
    node.removeAttribute('data-active');
    const original = originals[i];
    if (original) {
      // A paused clone starts at animation time zero. Freeze the source's painted values instead,
      // including the billboard's scroll-driven transform and any in-flight artwork fades.
      const painted = getComputedStyle(original);
      for (const property of [
        'transform',
        'translate',
        'rotate',
        'scale',
        'opacity',
        'filter',
        'backdrop-filter',
      ]) {
        node.style.setProperty(property, painted.getPropertyValue(property), 'important');
      }
    }
    node.style.setProperty('animation', 'none', 'important');
    node.style.setProperty('transition', 'none', 'important');
    node.style.setProperty('scroll-behavior', 'auto', 'important');
    node.style.setProperty('scroll-snap-type', 'none', 'important');
    if (node instanceof HTMLInputElement && original instanceof HTMLInputElement) {
      node.value = original.value;
      node.checked = original.checked;
    }
  });
  if (rootStyle !== undefined) copy.style.cssText = rootStyle;
  // cloneNode cannot copy a decoder's current frame. Paint it into an inert canvas so a swipe
  // freezes the visible trailer instead of abruptly exposing the backdrop beneath it.
  copies.forEach((node, i) => {
    const original = originals[i];
    if (!(original instanceof HTMLVideoElement)) return;
    const painted = getComputedStyle(original);
    const bounds = original.getBoundingClientRect();
    if (
      original.readyState >= 2 &&
      original.videoWidth &&
      original.videoHeight &&
      Number(painted.opacity) > 0 &&
      bounds.bottom > 0 &&
      bounds.top < innerHeight &&
      bounds.right > 0 &&
      bounds.left < innerWidth
    ) {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1920 / original.videoWidth);
      canvas.width = Math.max(1, Math.round(original.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(original.videoHeight * scale));
      // Preserve replaced-element sizing/object-fit even where the stylesheet targets `video`.
      for (const property of painted)
        canvas.style.setProperty(property, painted.getPropertyValue(property));
      canvas.style.setProperty('animation', 'none', 'important');
      canvas.style.setProperty('transition', 'none', 'important');
      try {
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(original, 0, 0, canvas.width, canvas.height);
          offsets.set(canvas, { x: 0, y: 0 });
          node.replaceWith(canvas);
          return;
        }
      } catch {
        /* A decoder without a readable frame keeps the still artwork underneath. */
      }
    }
    node.remove();
  });
  copy.querySelectorAll('iframe').forEach((node) => node.remove());
  const retained = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
  const retainedOffsets = retained.map((node) => offsets.get(node)!);
  return {
    refresh() {
      if (!source.isConnected || !source.hidden) return capturePage(source) ?? this;
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
        originals.forEach((node, i) => {
          const offset = offsets.get(copies[i]!);
          if (offset) node.scrollTo({ left: offset.x, top: offset.y, behavior: 'instant' });
        });
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
        retainedOffsets.forEach(({ x, y }, i) =>
          displayedNodes[i]?.scrollTo({ left: x, top: y, behavior: 'instant' }),
        ),
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
