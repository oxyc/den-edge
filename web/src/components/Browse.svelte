<!-- A browse screen's rows, endless downward: a few rows at a time, more as you near the bottom. Each row loads its
     own posters once it's near the screen. -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import { whenIdle } from '../lib/idle';
  import type { Title } from '../lib/library';
  import { observeNearViewport } from '../lib/nearViewport';
  import { pageVisibility } from '../lib/pageVisibility.svelte';
  import { SvelteSet } from 'svelte/reactivity';
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
  // An empty row hides itself and takes no height, so the bottom stays in view and the next rows are added at once.
  // Past this many empty rows in a row the screen stops adding them: when everything is filtered out, or every
  // catalog comes back empty, it would otherwise mount every row and ask for each one's page.
  const EMPTY_RUN = 6;
  let count = $state(STEP);
  let bottom: HTMLElement;
  const page = pageVisibility();
  const empty = new SvelteSet<string>();

  // A different screen starts from the top again; the same rows rebuilt (after a write, say) keep their place.
  const signature = $derived(rows.map((r) => r.id).join('\n'));
  $effect(() => {
    void signature;
    count = STEP;
    empty.clear();
  });

  function settled(id: string, isEmpty: boolean) {
    if (isEmpty) empty.add(id);
    else empty.delete(id);
  }

  const growable = $derived.by(() => {
    let run = 0;
    for (const row of rows.slice(0, count).reverse()) {
      if (!empty.has(row.id)) break;
      run++;
    }
    return run < EMPTY_RUN;
  });

  $effect(() => {
    if (!page.active || !growable) return;
    return observeNearViewport(
      bottom,
      (near) => {
        if (near) count = Math.min(rows.length, count + STEP);
      },
      '300px 0px',
    );
  });

  // Within three screens of the bottom, rows are added while the browser is idle, a step at a time, so a quick
  // scroll finds them already filled; the marker above still adds them at once where no idle time comes. Observed
  // afresh as rows are added, since a marker still in range after a step changes no intersection.
  $effect(() => {
    void count;
    if (!page.active || !growable) return;
    let live = true;
    let cancelIdle = () => {};
    const stop = observeNearViewport(
      bottom,
      (near) => {
        if (!near || count >= rows.length) return;
        cancelIdle();
        cancelIdle = whenIdle(() => {
          if (live) count = Math.min(rows.length, count + STEP);
        });
      },
      '300% 0px',
    );
    return () => {
      live = false;
      cancelIdle();
      stop();
    };
  });
</script>

{#each rows.slice(0, count) as row (`${build}:${row.id}`)}
  <BrowseRow {row} {shown} onsettled={(isEmpty) => settled(row.id, isEmpty)} />
{/each}
<div bind:this={bottom} class="bottom" aria-hidden="true"></div>

<style>
  .bottom {
    height: 1px;
  }
</style>
