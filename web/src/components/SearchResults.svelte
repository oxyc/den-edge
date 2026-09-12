<!-- Search results as the TV's grid: posters for titles, a round portrait for a person. -->
<script lang="ts">
  import type { Title } from '../lib/library';
  import { hitKey, type Hit } from '../lib/search';
  import PersonCard from './PersonCard.svelte';
  import PosterCard from './PosterCard.svelte';

  let { hits, onselect }: { hits: Hit[]; onselect?: (title: Title) => void } = $props();
</script>

<div class="grid">
  {#each hits as hit (hitKey(hit))}
    {#if hit.kind === 'title'}
      <PosterCard
        title={hit.title}
        caption={hit.title.year ? String(hit.title.year) : undefined}
        onselect={onselect && (() => onselect(hit.title))}
      />
    {:else}
      <PersonCard id={hit.person.id} name={hit.person.name} profilePath={hit.person.profilePath} />
    {/if}
  {/each}
</div>

<style>
  .grid {
    --card-w: 100%;

    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(120px, 28vw, 170px), 1fr));
    gap: 20px 14px;
    margin-bottom: 32px;
  }
</style>
