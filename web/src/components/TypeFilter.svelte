<!-- All / Movies / Series over whatever a page is listing. One control, so the watchlist, the watched history and a
     service's page offer the same three in the same shape rather than three near-identical pills. -->
<script lang="ts">
  import type { MediaType } from '../lib/library';

  let {
    value,
    onchange,
    label,
    all = true,
  }: {
    /** The type shown, or null for all of them. */
    value: MediaType | null;
    onchange: (value: MediaType | null) => void;
    /** What this filters, for a screen reader: "Show in Watchlist". */
    label: string;
    /** Whether "All" is one of the choices: Search's Explore browses one type at a time. */
    all?: boolean;
  } = $props();

  const FILTERS: { value: MediaType | null; label: string }[] = [
    { value: null, label: 'All' },
    { value: 'movie', label: 'Movies' },
    { value: 'tv', label: 'Series' },
  ];
  const offered = $derived(all ? FILTERS : FILTERS.slice(1));
</script>

<div class="filter" role="group" aria-label={label}>
  {#each offered as filter (filter.label)}
    <button
      type="button"
      aria-pressed={value === filter.value}
      onclick={() => onchange(filter.value)}>{filter.label}</button
    >
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

  .filter button {
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
  }

  .filter button[aria-pressed='true'] {
    background: rgb(255 255 255 / 0.14);
    color: var(--fg);
  }
</style>
