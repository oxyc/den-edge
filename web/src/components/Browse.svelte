<!-- A browse screen's rows, endless downward: a few rows at a time, more as you near the bottom. Each row loads its
     own posters once it's near the screen. -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import BrowseRow from './BrowseRow.svelte';

  let {
    rows,
    shown,
    build = 0,
  }: {
    rows: RowDef[];
    shown: (title: Title) => boolean;
    /**
     * Bumped by a caller that rebuilds its rows in place: each row then starts its own loader afresh, holding its
     * height with `BrowseRow`'s placeholders, while the screen keeps how far down it has shown.
     */
    build?: number;
  } = $props();

  // Two rows establish the page. More arrive close to the viewport instead of mounting a whole catalogue
  // while the billboard is still competing for the main thread and network.
  const STEP = 2;
  let count = $state(STEP);
  let bottom: HTMLElement;

  // A different screen starts from the top again; the same rows rebuilt (after a write, say) keep their place.
  const signature = $derived(rows.map((r) => r.id).join('\n'));
  $effect(() => {
    void signature;
    count = STEP;
  });

  $effect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) count += STEP;
      },
      { rootMargin: '300px 0px' },
    );
    observer.observe(bottom);
    return () => observer.disconnect();
  });
</script>

{#each rows.slice(0, count) as row (`${build}:${row.id}`)}
  <BrowseRow {row} {shown} />
{/each}
<div bind:this={bottom} class="bottom" aria-hidden="true"></div>

<style>
  .bottom {
    height: 1px;
  }
</style>
