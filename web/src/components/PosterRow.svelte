<!-- A titled, horizontally scrolling row of cards (the TV's PosterRow). Native scroll-snap; no glass here —
     backdrop-filter over moving content costs frames on a phone. -->
<script module lang="ts">
  /** The context a row's cards read to learn whether the row has come near the screen (`PosterCard`). */
  export const ROW_NEAR = Symbol('row near');
  /** About as far ahead as a browser starts loading a lazy image on a fast connection. */
  const AHEAD = 1250;
  /** Availability can be useful just before a card is seen, but need not follow the much wider art lookahead. */
  export const AVAILABILITY_AHEAD = 250;
</script>

<script lang="ts">
  import { setContext, type Snippet } from 'svelte';
  import { observeNearViewport } from '../lib/nearViewport';
  import { pageVisibility } from '../lib/pageVisibility.svelte';

  let {
    heading,
    ariaLabel,
    headingLink,
    aside,
    active,
    children,
    track = $bindable(),
  }: {
    heading: string;
    /** The region's full name when the compact visible heading omits its context. */
    ariaLabel?: string;
    headingLink?: { before: string; label: string; after: string; href: string };
    /** A quiet link beside the heading, to where the row goes on. */
    aside?: { label: string; href: string; ariaLabel?: string };
    /** A loading row already tracks its vertical window and supplies it here to avoid observing it twice. */
    active?: boolean;
    children: Snippet;
    /** The horizontal scroller, for a loader that windows and extends its own cards. */
    track?: HTMLDivElement;
  } = $props();

  /**
   * Whether the row is within `AHEAD` of the active screen. Far and retained-hidden rows release their images;
   * one shared observer replaces a separate browser lazy-image watch for every poster.
   */
  const row = $state({ near: false, ahead: false });
  setContext(ROW_NEAR, row);
  const page = pageVisibility();
  let section: HTMLElement;
  $effect(() => {
    if (!page.active) {
      row.near = false;
      return;
    }
    if (active !== undefined) {
      row.near = active;
      return;
    }
    return observeNearViewport(section, (near) => (row.near = near), `${AHEAD}px 0px`);
  });
  // A windowing row tells each card whether it is on screen (`PosterCard`'s `onscreen`), so the cards' vertical
  // availability lookahead is this one track's rather than an observer target per card.
  $effect(() => {
    if (!page.active || !active || !track) {
      row.ahead = false;
      return;
    }
    return observeNearViewport(track, (near) => (row.ahead = near), `${AVAILABILITY_AHEAD}px 0px`);
  });
</script>

<section class="row" aria-label={ariaLabel ?? heading} bind:this={section}>
  <div class="head">
    <h2>
      <span class="heading-copy">
        {#if headingLink}
          {headingLink.before}<a class="heading-link" href={headingLink.href}>{headingLink.label}</a
          >{headingLink.after}
        {:else}
          {heading}
        {/if}
      </span>
    </h2>
    {#if aside}
      <a class="aside" href={aside.href} aria-label={aside.ariaLabel}>{aside.label} ›</a>
    {/if}
  </div>
  <div class="track" bind:this={track}>
    {@render children()}
  </div>
</section>

<style>
  .row {
    /* ~2.3 posters on a phone, so the cut-off one says "scroll"; 6–8 on a desktop. */
    --card-w: clamp(140px, 38vw, 190px);
    --page-inset: max(var(--gutter), calc((100vw - var(--page-max)) / 2 + var(--gutter)));

    width: 100vw;
    margin: 0 calc(50% - 50vw) 32px;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin: 0 0 12px;
    padding-inline: var(--page-inset);
  }

  h2 {
    min-width: 0;
    margin: 0;
    font-size: var(--section-heading-size);
    font-weight: var(--section-heading-weight);
    line-height: var(--section-heading-line-height);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .aside {
    flex: none;
    color: var(--muted);
    font-size: 14px;
    text-decoration: none;
    white-space: nowrap;
  }

  .aside:hover,
  .aside:focus-visible {
    color: var(--fg);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .heading-link {
    color: inherit;
    text-decoration: none;
  }

  .heading-link:hover,
  .heading-link:focus-visible {
    text-decoration: underline;
    text-underline-offset: 4px;
  }

  /* A recommendation subject can end exactly where the single-line heading is ellipsized. Keep its keyboard ring
     inside the link so the heading's overflow boundary cannot cut off the trailing edge. */
  .heading-link:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--ring-width));
    border-radius: 4px;
  }

  .track {
    display: flex;
    gap: 14px;
    width: 100%;
    margin: 0;

    /* The scroller reaches the viewport, but its resting first card follows the readable column. Later cards can
       still travel through the leading edge because this is content padding, not an ancestor clip. */
    padding: 0 0 8px var(--page-inset);
    overflow: auto hidden;

    /* Replacing a virtual slot with its equal-sized PosterCard must not make scroll anchoring move
       the shelf by one snap point. Chromium otherwise attributed exactly that movement to two cards. */
    overflow-anchor: none;
    scroll-snap-type: x proximity;
    scroll-padding-inline: var(--page-inset) 0;
    scrollbar-width: none;
  }

  .track > :global(*) {
    flex: 0 0 auto;
    scroll-snap-align: start;
  }
</style>
