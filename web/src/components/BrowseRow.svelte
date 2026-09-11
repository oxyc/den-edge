<!-- One self-loading row of a browse screen (the TV's PosterRow with its loader): the header paints at once, the
     first page loads when the row nears the screen, and the next when you scroll to its end. A row that turns out
     empty hides itself. -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import PosterCard from './PosterCard.svelte';
  import PosterRow from './PosterRow.svelte';

  let { row, shown, onselect }: { row: RowDef; shown: (title: Title) => boolean; onselect: (title: Title) => void } =
    $props();

  /** Keep loading while a screenful hasn't survived the hide rules — a few pages at most per go. */
  const FILL = 8;
  const MAX_BURST = 3;

  let titles = $state<Title[]>([]);
  let done = $state(false);
  let page = 0;
  let loading = false;
  let wrapper: HTMLElement;
  let end: HTMLElement;

  const visible = $derived(titles.filter(shown));
  const key = (t: Title) => `${t.type}:${t.id}`;

  async function more() {
    if (loading || done) return;
    loading = true;
    for (let burst = 0; burst < MAX_BURST && !done; burst++) {
      try {
        const next = await row.load(page + 1);
        page++;
        const seen = new Set(titles.map(key));
        titles = [...titles, ...next.filter((t) => !seen.has(key(t)))];
        if (next.length === 0) done = true;
      } catch {
        done = true;
      }
      if (titles.filter(shown).length >= FILL * page) break;
    }
    loading = false;
  }

  $effect(() => {
    const near = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        near.disconnect();
        void more();
      },
      { rootMargin: '400px 0px' },
    );
    const tail = new IntersectionObserver((entries) => {
      if (page > 0 && entries.some((e) => e.isIntersecting)) void more();
    });
    near.observe(wrapper);
    tail.observe(end);
    return () => {
      near.disconnect();
      tail.disconnect();
    };
  });
</script>

<div bind:this={wrapper} class:gone={done && visible.length === 0}>
  <PosterRow heading={row.title}>
    {#each visible as title (key(title))}
      <PosterCard {title} caption={title.year ? String(title.year) : undefined} onselect={() => onselect(title)} />
    {:else}
      {#if !done}
        {#each { length: 6 } as _, i (i)}<span class="skeleton" aria-hidden="true"></span>{/each}
      {/if}
    {/each}
    <span bind:this={end} class="end" aria-hidden="true"></span>
  </PosterRow>
</div>

<style>
  .gone {
    display: none;
  }

  .skeleton {
    width: var(--card-w);
    aspect-ratio: 2 / 3;
    border-radius: 12px;
    background: var(--card);
  }

  .end {
    width: 1px;
  }
</style>
