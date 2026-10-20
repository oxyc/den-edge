<!-- All / Movies / Series over whatever a page is listing. One control, so the watchlist, the watched history and a
     service's page offer the same three in the same shape rather than three near-identical pills. -->
<script lang="ts">
  import type { MediaType } from '../lib/library';
  import { activateLinkInPlace } from '../lib/linkActivation';

  let {
    value,
    onchange,
    label,
    href,
  }: {
    /** The type shown, or null for all of them. */
    value: MediaType | null;
    onchange: (value: MediaType | null) => void;
    /** A real address for each choice, where this filter is route-backed. */
    href?: (value: MediaType | null) => string;
    /** What this filters, for a screen reader: "Show in Watchlist". */
    label: string;
  } = $props();

  const FILTERS: { value: MediaType | null; label: string }[] = [
    { value: null, label: 'All' },
    { value: 'movie', label: 'Movies' },
    { value: 'tv', label: 'Series' },
  ];
</script>

<div class="filter" role="group" aria-label={label} data-spatial-list="horizontal">
  {#each FILTERS as filter (filter.label)}
    {#if href}
      <a
        href={href(filter.value)}
        aria-current={value === filter.value ? 'page' : undefined}
        onclick={(event) => activateLinkInPlace(event, () => onchange(filter.value))}
        >{filter.label}</a
      >
    {:else}
      <button
        type="button"
        aria-pressed={value === filter.value}
        onclick={() => onchange(filter.value)}>{filter.label}</button
      >
    {/if}
  {/each}
</div>

<style>
  .filter {
    display: flex;
    gap: 4px;
    padding: 3px;
    border-radius: 999px;
    background: var(--card);
  }

  .filter button,
  .filter a {
    display: grid;
    place-items: center;
    min-height: 30px;
    padding: 0 14px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
  }

  .filter button[aria-pressed='true'],
  .filter a[aria-current='page'] {
    background: rgb(255 255 255 / 0.14);
    color: var(--fg);
  }

  /* This control often lives in a narrow scrolling rail. Keep its ring inside the pill so focusing Series cannot
     shift the entire rail sideways just to reveal pixels painted beyond its right edge. */
  .filter button:focus-visible,
  .filter a:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--ring-width));
  }
</style>
