<!-- One self-loading row of a browse screen (the TV's PosterRow with its loader): the header paints at once, the
     first page loads when the row nears the screen, and the next when you scroll to its end. A row that turns out
     empty hides itself. -->
<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { RowDef } from '../lib/catalog';
  import { cardWindow, posterCardWidth } from '../lib/cardWindow';
  import { titleCaption, type Title } from '../lib/library';
  import { whenIdle } from '../lib/idle';
  import { observeNearViewport } from '../lib/nearViewport';
  import { pageVisibility } from '../lib/pageVisibility.svelte';
  import { Pager } from '../lib/pager.svelte';
  import PosterCard from './PosterCard.svelte';
  import { titleHref } from '../lib/route';
  import PosterRow from './PosterRow.svelte';

  let {
    row,
    shown,
    prefetch = true,
  }: {
    row: RowDef;
    shown: (title: Title) => boolean;
    /**
     * Whether the first page is asked for when the browser is next idle, ahead of the row nearing the screen. A
     * title page's rows are not: a dozen of them, most far below its fold, each drawing its own posters, were
     * most of the ~120 requests and ~1,000 nodes opening a title cost on a phone.
     */
    prefetch?: boolean;
  } = $props();

  let wrapper: HTMLElement;
  let end: HTMLElement;
  let track = $state<HTMLDivElement>();
  const page = pageVisibility();
  let rowNear = $state(false);
  let windowStart = $state(0);
  let windowEnd = $state(0);
  let focusedIndex = $state<number | null>(null);
  // Reading the track in an update frame can flush layout after another row mounted its cards. Scroll events are
  // already delivered with the browser's position, so remember it there and keep it across effect reactivation.
  let cachedScrollLeft = 0;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(releaseTimer));

  const visibleHere = (title: Title) => shown(title) && (row.filter?.(title) ?? true);
  const pager = new Pager((page) => row.load(page), visibleHere);
  const visible = $derived(pager.titles.filter(visibleHere));
  const done = $derived(pager.done);
  const key = (t: Title) => `${t.type}:${t.id}`;

  // Keep loaders and light title slots alive, but mount card/menu trees only for a row near the active page.
  $effect(() => {
    if (!page.active) {
      rowNear = false;
      return;
    }
    return observeNearViewport(wrapper, (near) => (rowNear = near), '800px 0px');
  });

  // The first page loads when the browser is next idle, so a row is usually filled before it is scrolled to, and
  // at the latest as it nears the screen. A row that does not prefetch also loads once it is anywhere above the
  // screen: a jump to the foot of the page passes rows without their ever crossing it, and left unloaded they would
  // fill or fold away later, above the viewer, moving the page under them — and a later row may wait on one.
  $effect(() => {
    if (!page.active || pager.page !== 0) return;
    let live = true;
    const first = () => {
      if (live && pager.page === 0) return pager.more();
    };
    let cancelIdle = () => {};
    let stop = () => {};
    if (prefetch) cancelIdle = whenIdle(first);
    else
      stop = observeNearViewport(
        wrapper,
        (near) => {
          if (near) void first();
        },
        '100000px 0px 400px 0px',
      );
    if (rowNear) void first();
    return () => {
      live = false;
      cancelIdle();
      stop();
    };
  });

  // One passive listener per active horizontal track. Work is coalesced to one animation frame and every pending
  // frame/listener is removed when the row or retained route leaves the viewport.
  $effect(() => {
    void visible.length;
    if (!page.active || !rowNear || !track) return;
    const scroller = track;
    let frame: number | undefined;
    let viewportWidth = 0;
    const update = () => {
      if (!viewportWidth) return;
      const window = cardWindow(
        visible.length,
        cachedScrollLeft,
        viewportWidth,
        // The negative-gutter track spans the viewport, so this matches PosterRow's `38vw` clamp without a read.
        posterCardWidth(viewportWidth),
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
      cachedScrollLeft = scroller.scrollLeft;
      schedule();
    };
    const press = (event: PointerEvent) => {
      const slot = (event.target as Element).closest<HTMLElement>('[data-card-index]');
      const index = Number(slot?.dataset.cardIndex);
      if (Number.isInteger(index)) focusedIndex = index;
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

  // The next page is asked for two row-widths before the end, measured against the row's own scroller: the
  // viewport's margin never reaches cards clipped by a horizontal track. Observed afresh as titles land, since an
  // end still in range after a page changes no intersection and would never ask for the one after.
  $effect(() => {
    void pager.titles.length;
    if (!page.active || !rowNear || !track) return;
    const scroller = track;
    const tail = new IntersectionObserver(
      (entries) => {
        if (pager.page > 0 && entries.some((e) => e.isIntersecting)) void pager.more();
      },
      { root: scroller, rootMargin: '0px 200%' },
    );
    tail.observe(end);
    return () => tail.disconnect();
  });

  const mounted = (index: number) =>
    (page.active && rowNear && index >= windowStart && index < windowEnd) || index === focusedIndex;

  function remember(index: number) {
    focusedIndex = index;
  }

  function releaseFocus() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (page.active && !track?.contains(document.activeElement)) focusedIndex = null;
    });
  }

  function enterProxy(event: FocusEvent, index: number) {
    const slot = (event.currentTarget as HTMLElement).parentElement;
    focusedIndex = index;
    void tick().then(() =>
      slot?.querySelector<HTMLElement>('.card')?.focus({ preventScroll: true }),
    );
  }
</script>

<div bind:this={wrapper} class:gone={done && !pager.failed && visible.length === 0}>
  <PosterRow
    heading={row.title}
    headingLink={row.headingLink}
    aside={row.aside}
    active={rowNear}
    bind:track
  >
    {#each visible as title, index (key(title))}
      <span
        class="slot"
        class:vacant={!mounted(index)}
        data-card-index={index}
        data-route-focus-key={key(title)}
        onfocusin={() => remember(index)}
        onfocusout={releaseFocus}
      >
        {#if mounted(index)}
          <PosterCard
            {title}
            caption={titleCaption(title, row.caption?.(title))}
            href={titleHref(title)}
          />
        {:else}
          <a
            class="proxy"
            href={titleHref(title)}
            aria-label={title.title}
            onfocus={(event) => enterProxy(event, index)}
          ></a>
        {/if}
      </span>
    {:else}
      {#if !done}
        {#each { length: 6 } as _, i (i)}<span class="skeleton" aria-hidden="true"></span>{/each}
      {/if}
    {/each}
    {#if pager.failed}
      <!-- A page that didn't load says so where the row stopped, rather than the row simply ending. -->
      <button class="retry" onclick={() => void pager.retry()}
        >Couldn’t load these. Try again</button
      >
    {/if}
    <span bind:this={end} class="end" aria-hidden="true"></span>
  </PosterRow>
</div>

<style>
  .gone {
    display: none;
  }

  .skeleton {
    width: var(--card-w);

    /* Match PosterCard art, gap, and two metadata lines before any title is known. */
    height: calc(var(--card-w) * 1.5 + 8px + 39.2px);
    border-radius: 12px;
    background: linear-gradient(var(--card), var(--card)) top / 100% calc(100% - 47.2px) no-repeat;
  }

  .slot {
    display: block;
    width: var(--card-w);
    min-height: calc(var(--card-w) * 1.5 + 47.2px);
    scroll-snap-align: start;
  }

  /* Empty virtual slots have fixed geometry and no popover/focus artwork to escape their bounds. */
  .slot.vacant {
    contain: strict;
    height: calc(var(--card-w) * 1.5 + 47.2px);
  }

  .proxy {
    display: block;
    width: 100%;
    height: calc(var(--card-w) * 1.5 + 47.2px);
    opacity: 0;
  }

  .end {
    width: 1px;
  }

  .retry {
    flex: 0 0 var(--card-w);
    width: var(--card-w);
    height: calc(var(--card-w) * 1.5);
    padding: 12px;
    border: 0;
    border-radius: 12px;
    background: var(--card);
    color: var(--muted);
    font: inherit;
    cursor: pointer;
  }

  .retry:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
</style>
