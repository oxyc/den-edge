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
    children,
  }: {
    heading: string;
    aside?: { label: string; href: string };
    items: T[];
    itemKey: (item: T) => string;
    itemHref: (item: T) => string;
    itemLabel: (item: T) => string;
    landscape?: boolean;
    children: Snippet<[T]>;
  } = $props();

  let wrapper: HTMLElement;
  let track = $state<HTMLDivElement>();
  const page = pageVisibility();
  let rowNear = $state(false);
  let windowStart = $state(0);
  let windowEnd = $state(0);
  let focusedKey = $state<string | null>(null);
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(releaseTimer));

  $effect(() => {
    if (!page.active) {
      rowNear = false;
      return;
    }
    return observeNearViewport(wrapper, (near) => (rowNear = near), '1250px 0px');
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
        scroller.scrollLeft,
        viewportWidth,
        posterCardWidth(innerWidth) * (landscape ? 1.45 : 1),
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
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('pointerdown', press, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('pointerdown', press);
      resize.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  });

  const mounted = (item: T, index: number) =>
    (page.active && rowNear && index >= windowStart && index < windowEnd) ||
    itemKey(item) === focusedKey;

  function remember(item: T) {
    focusedKey = itemKey(item);
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

<div bind:this={wrapper}>
  <PosterRow {heading} {aside} active={rowNear} bind:track>
    {#each items as item, index (itemKey(item))}
      <span
        class="slot"
        class:landscape
        class:vacant={!mounted(item, index)}
        data-card-index={index}
        data-route-focus-key={itemKey(item)}
        onfocusin={() => remember(item)}
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
