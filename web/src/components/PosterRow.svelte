<!-- A titled, horizontally scrolling row of cards (the TV's PosterRow). Native scroll-snap; no glass here —
     backdrop-filter over moving content costs frames on a phone. -->
<script module lang="ts">
  /** The context a row's cards read to learn whether the row has come near the screen (`PosterCard`). */
  export const ROW_NEAR = Symbol('row near');
  /** About as far ahead as a browser starts loading a lazy image on a fast connection. */
  const AHEAD = 1250;
</script>

<script lang="ts">
  import { setContext, type Snippet } from 'svelte';
  import { observeNearViewport } from '../lib/nearViewport';
  import { pageVisibility } from '../lib/pageVisibility.svelte';

  let {
    heading,
    headingLink,
    aside,
    active,
    children,
    track = $bindable(),
  }: {
    heading: string;
    headingLink?: { before: string; label: string; after: string; href: string };
    /** A quiet link beside the heading, to where the row goes on. */
    aside?: { label: string; href: string };
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
  const row = $state({ near: false });
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
</script>

<section class="row" aria-label={heading} bind:this={section}>
  <div class="head">
    <h2>
      {#if headingLink}
        {headingLink.before}<a class="heading-link" href={headingLink.href}>{headingLink.label}</a
        >{headingLink.after}
      {:else}
        {heading}
      {/if}
    </h2>
    {#if aside}<a class="aside" href={aside.href}>{aside.label} ›</a>{/if}
  </div>
  <div class="track" bind:this={track}>
    {@render children()}
  </div>
</section>

<style>
  .row {
    /* ~2.3 posters on a phone, so the cut-off one says "scroll"; 6–8 on a desktop. */
    --card-w: clamp(140px, 38vw, 190px);

    margin-bottom: 32px;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin: 0 0 12px;
  }

  h2 {
    min-width: 0;
    margin: 0;
    font-size: 20px;
    line-height: 1.4;
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

  .track {
    display: flex;
    gap: 14px;
    margin: 0 calc(-1 * var(--gutter));
    padding: 0 var(--gutter) 8px;
    overflow: auto hidden;
    scroll-snap-type: x proximity;
    scroll-padding-inline: var(--gutter);
    scrollbar-width: none;
  }

  .track > :global(*) {
    flex: 0 0 auto;
    scroll-snap-align: start;
  }
</style>
