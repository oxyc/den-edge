<!-- A titled, horizontally scrolling row of cards (the TV's PosterRow). Native scroll-snap; no glass here —
     backdrop-filter over moving content costs frames on a phone. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    heading,
    headingLink,
    children,
  }: {
    heading: string;
    headingLink?: { before: string; label: string; after: string; href: string };
    children: Snippet;
  } = $props();
</script>

<section class="row" aria-label={heading}>
  <h2>
    {#if headingLink}
      {headingLink.before}<a class="heading-link" href={headingLink.href}>{headingLink.label}</a
      >{headingLink.after}
    {:else}
      {heading}
    {/if}
  </h2>
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

  h2 {
    margin: 0 0 12px;
    font-size: 20px;
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
