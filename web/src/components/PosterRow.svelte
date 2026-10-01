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

  let {
    heading,
    headingLink,
    aside,
    children,
  }: {
    heading: string;
    headingLink?: { before: string; label: string; after: string; href: string };
    /** A quiet link beside the heading, to where the row goes on. */
    aside?: { label: string; href: string };
    children: Snippet;
  } = $props();

  /**
   * Whether the row has come within `AHEAD` of the screen, after which it stays so. Until then its cards draw no
   * poster at all, rather than a lazy one: the browser watches every lazy image for the screen, and Home's few
   * hundred, most of them rows below, cost 40-70 ms of a phone's main thread on every row swipe.
   */
  const row = $state({ near: false });
  setContext(ROW_NEAR, row);
  let section: HTMLElement;
  $effect(() => {
    const box = section.getBoundingClientRect();
    // On screen already, or in a page that is not laid out (a hidden one), where nothing can be measured.
    if (!box.height || (box.top < innerHeight + AHEAD && box.bottom > -AHEAD)) {
      row.near = true;
      return;
    }
    const near = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        row.near = true;
        near.disconnect();
      },
      { rootMargin: `${AHEAD}px 0px` },
    );
    near.observe(section);
    return () => near.disconnect();
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
  <div class="track">
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
    margin: 0;
    font-size: 20px;
  }

  .aside {
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
