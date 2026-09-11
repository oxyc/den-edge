<!-- A browse screen's rows, endless downward: a few rows at a time, more as you near the bottom. Each row loads its
     own posters once it's near the screen. -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import BrowseRow from './BrowseRow.svelte';

  let { rows, shown, onselect }: { rows: RowDef[]; shown: (title: Title) => boolean; onselect: (title: Title) => void } =
    $props();

  const STEP = 6;
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
      { rootMargin: '800px 0px' },
    );
    observer.observe(bottom);
    return () => observer.disconnect();
  });
</script>

{#each rows.slice(0, count) as row (row.id)}
  <BrowseRow {row} {shown} {onselect} />
{/each}
<div bind:this={bottom} class="bottom" aria-hidden="true"></div>

<style>
  .bottom {
    height: 1px;
  }
</style>
