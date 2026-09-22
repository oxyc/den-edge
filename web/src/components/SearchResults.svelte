<!-- Search results as the TV's grid: posters for titles, a round portrait for a person. Endless where it is given
     `onend`: Explore's feed asks for its next page as the last row nears the screen. -->
<script lang="ts">
  import { hitKey, type Hit } from '../lib/search';
  import PersonCard from './PersonCard.svelte';
  import PosterCard from './PosterCard.svelte';
  import { titleHref } from '../lib/route';

  import type { Title } from '../lib/library';

  let {
    hits,
    onend,
    onlike,
  }: {
    hits: Hit[];
    onend?: () => void;
    /** Given, each poster offers "More like <title>", which calls it instead of opening the title. */
    onlike?: (title: Title) => void;
  } = $props();
  let end = $state<HTMLElement>();

  $effect(() => {
    const marker = end;
    const reached = onend;
    // Observed afresh as the grid grows: a marker still in range after a page lands changes no intersection,
    // and would never ask for the next one.
    void hits.length;
    if (!marker || !reached) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) reached();
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  });
</script>

<div class="grid">
  {#each hits as hit (hitKey(hit))}
    {#if hit.kind === 'title'}
      <PosterCard
        title={hit.title}
        caption={hit.title.year ? String(hit.title.year) : undefined}
        href={titleHref(hit.title)}
        action={onlike && {
          label: `More like ${hit.title.title}`,
          icon: '≈',
          onclick: () => onlike(hit.title),
        }}
      />
    {:else}
      <PersonCard id={hit.person.id} name={hit.person.name} profilePath={hit.person.profilePath} />
    {/if}
  {/each}
</div>
{#if onend}<div bind:this={end} class="end" aria-hidden="true"></div>{/if}

<style>
  .end {
    height: 1px;
  }

  .grid {
    --card-w: 100%;

    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(120px, 28vw, 170px), 1fr));
    gap: 20px 14px;
    margin-bottom: 32px;
  }
</style>
