<!-- A fixed, already-loaded poster row. Every item keeps a light slot so scroll geometry and keyboard reachability
     stay exact, while only cards around the horizontal viewport own their menu, image and reactive trees. -->
<script lang="ts" generics="T">
  import { onDestroy, tick, type Snippet } from 'svelte';
  import { cardWindow, posterCardWidth } from '../lib/cardWindow';
  import { observeNearViewport } from '../lib/nearViewport';
  import { pageVisibility } from '../lib/pageVisibility.svelte';
  import PosterRow from './PosterRow.svelte';

  let {
    heading,
    aside,
    items,
    itemKey,
    itemHref,
    itemLabel,
    landscape = false,
    onintent,
    children,
  }: {
    heading: string;
    aside?: { label: string; href: string };
    items: T[];
    itemKey: (item: T) => string;
    itemHref: (item: T) => string;
    itemLabel: (item: T) => string;
    landscape?: boolean;
    /** The viewer moved into or along this shelf, so its next dormant title tranche is useful. */
    onintent?: () => void;
    children: Snippet<[T]>;
  } = $props();

  let wrapper: HTMLElement;
  let track = $state<HTMLDivElement>();
  const page = pageVisibility();
  let rowNear = $state(false);
  let windowStart = $state(0);
  let windowEnd = $state(0);
  let focusedKey = $state<string | null>(null);
  // Reading the track in an update frame can flush layout after another row mounted its cards. Scroll events are
  // already delivered with the browser's position, so remember it there and keep it across effect reactivation.
  let cachedScrollLeft = 0;
  let observed = false;
  let intentLength = -1;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(releaseTimer));

  $effect(() => {
    if (!page.active) {
      rowNear = false;
      return;
    }
    return observeNearViewport(
      wrapper,
      (near) => {
        // The observer's first delivery describes initial layout, not viewer intent. A later entry is either a
        // vertical approach to this row or a retained-route return, and may admit its next title tranche.
        const entered = observed && near && !rowNear;
        rowNear = near;
        observed = true;
        if (entered) requestMore();
      },
      '1250px 0px',
    );
  });

  $effect(() => {
    void items.length;
    if (!page.active || !rowNear || !track) return;
    const scroller = track;
    let frame: number | undefined;
    let viewportWidth = 0;
    const update = () => {
      if (!viewportWidth) return;
      const window = cardWindow(
        items.length,
        cachedScrollLeft,
        viewportWidth,
        // The negative-gutter track spans the viewport, so this matches PosterRow's `38vw` clamp without a read.
        posterCardWidth(viewportWidth) * (landscape ? 1.45 : 1),
        14,
      );
      windowStart = window.start;
      windowEnd = window.end;
    };
    const schedule = () => {
      if (frame === undefined)
        frame = requestAnimationFrame(() => {
          frame = undefined;
          update();
        });
    };
    const scroll = () => {
      const next = scroller.scrollLeft;
      const movedForward = next > cachedScrollLeft + 1;
      cachedScrollLeft = next;
      schedule();
      if (movedForward) requestMore();
    };
    const press = (event: PointerEvent) => {
      const slot = (event.target as Element).closest<HTMLElement>('[data-card-index]');
      const index = Number(slot?.dataset.cardIndex);
      if (Number.isInteger(index) && items[index]) focusedKey = itemKey(items[index]);
    };
    // Observer delivery must not read layout-sensitive element geometry or synchronously mount cards. Record only
    // the browser-supplied size, then update in the next frame after the current layout/observer cycle is complete.
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
      if (width === viewportWidth) return;
      viewportWidth = width;
      schedule();
    });
    resize.observe(scroller, { box: 'border-box' });
    scroller.addEventListener('scroll', scroll, { passive: true });
    scroller.addEventListener('pointerdown', press, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', scroll);
      scroller.removeEventListener('pointerdown', press);
      resize.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  });

  const mounted = (item: T, index: number) =>
    (page.active && rowNear && index >= windowStart && index < windowEnd) ||
    itemKey(item) === focusedKey;

  function requestMore() {
    if (!onintent || intentLength === items.length) return;
    intentLength = items.length;
    onintent();
  }

  function remember(item: T, index: number) {
    focusedKey = itemKey(item);
    // Admit the next tranche before Tab reaches the current tail, keeping every later title keyboard-reachable.
    if (index >= items.length - 2) requestMore();
  }

  function releaseFocus() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (page.active && !track?.contains(document.activeElement)) focusedKey = null;
    });
  }

  function enterProxy(event: FocusEvent, item: T) {
    const slot = (event.currentTarget as HTMLElement).parentElement;
    focusedKey = itemKey(item);
    void tick().then(() =>
      slot?.querySelector<HTMLElement>('.card')?.focus({ preventScroll: true }),
    );
  }
</script>

<div bind:this={wrapper} class="windowed" class:landscape>
  <PosterRow {heading} {aside} active={rowNear} bind:track>
    {#each items as item, index (itemKey(item))}
      <span
        class="slot"
        class:landscape
        class:vacant={!mounted(item, index)}
        data-card-index={index}
        data-route-focus-key={itemKey(item)}
        onfocusin={() => remember(item, index)}
        onfocusout={releaseFocus}
      >
        {#if mounted(item, index)}
          {@render children(item)}
        {:else}
          <a
            class="proxy"
            href={itemHref(item)}
            aria-label={itemLabel(item)}
            onfocus={(event) => enterProxy(event, item)}
          ></a>
        {/if}
      </span>
    {/each}
  </PosterRow>
</div>

<style>
  /* PosterCard has a fixed art ratio and exactly two metadata lines. Keeping this shelf's skipped size exact lets
     Chromium omit far-below-the-fold style/layout/paint without changing vertical scroll geometry. */
  .windowed {
    content-visibility: auto;
    contain-intrinsic-block-size: auto calc(clamp(140px, 38vw, 190px) * 1.5 + 127.2px);
  }

  .windowed.landscape {
    contain-intrinsic-block-size: auto calc(clamp(140px, 38vw, 190px) * 1.45 * 9 / 16 + 127.2px);
  }

  .slot {
    display: block;
    width: var(--card-w);
    min-height: calc(var(--card-w) * 1.5 + 47.2px);
    scroll-snap-align: start;
  }

  .slot.vacant {
    contain: strict;
    height: calc(var(--card-w) * 1.5 + 47.2px);
  }

  .slot.landscape {
    width: calc(var(--card-w) * 1.45);
    min-height: calc(var(--card-w) * 1.45 * 9 / 16 + 47.2px);
  }

  .slot.vacant.landscape {
    height: calc(var(--card-w) * 1.45 * 9 / 16 + 47.2px);
  }

  .proxy {
    display: block;
    width: 100%;
    height: calc(var(--card-w) * 1.5 + 47.2px);
    opacity: 0;
  }

  .landscape .proxy {
    height: calc(var(--card-w) * 1.45 * 9 / 16 + 47.2px);
  }
</style>
