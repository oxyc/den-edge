<!-- One self-loading row of a browse screen (the TV's PosterRow with its loader): the header paints at once, the
     first page loads when the row nears the screen, and the next when you scroll to its end. A row that turns out
     empty hides itself. -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import { Pager } from '../lib/pager.svelte';
  import PosterCard from './PosterCard.svelte';
  import { titleHref } from '../lib/route';
  import PosterRow from './PosterRow.svelte';

  let { row, shown }: { row: RowDef; shown: (title: Title) => boolean } = $props();

  let wrapper: HTMLElement;
  let end: HTMLElement;

  const visibleHere = (title: Title) => shown(title) && (row.filter?.(title) ?? true);
  const pager = new Pager((page) => row.load(page), visibleHere);
  const visible = $derived(pager.titles.filter(visibleHere));
  const done = $derived(pager.done);
  const key = (t: Title) => `${t.type}:${t.id}`;

  $effect(() => {
    const near = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        near.disconnect();
        void pager.more();
      },
      { rootMargin: '400px 0px' },
    );
    const tail = new IntersectionObserver((entries) => {
      if (pager.page > 0 && entries.some((e) => e.isIntersecting)) void pager.more();
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
  <PosterRow heading={row.title} headingLink={row.headingLink} aside={row.aside}>
    {#each visible as title (key(title))}
      <PosterCard
        {title}
        caption={row.caption?.(title) ?? (title.year ? String(title.year) : undefined)}
        href={titleHref(title)}
      />
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

    /* Match PosterCard art, gap, and two metadata lines before any title is known. */
    height: calc(var(--card-w) * 1.5 + 8px + 39.2px);
    border-radius: 12px;
    background: linear-gradient(var(--card), var(--card)) top / 100% calc(100% - 47.2px) no-repeat;
  }

  .end {
    width: 1px;
  }
</style>
