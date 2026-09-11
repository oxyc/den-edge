<!-- Search results as the TV's grid: posters for titles, a round portrait for a person. -->
<script lang="ts">
  import type { Title } from '../lib/library';
  import { hitKey, type Hit } from '../lib/search';
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
      <figure class="person">
        <span class="portrait">
          {#if hit.person.profilePath}
            <img src="https://image.tmdb.org/t/p/w185{hit.person.profilePath}" alt="" loading="lazy" />
          {/if}
        </span>
        <figcaption>{hit.person.name}</figcaption>
      </figure>
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

  .person {
    margin: 0;
    text-align: center;
  }

  .portrait {
    display: block;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 50%;
    background: var(--card);
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  figcaption {
    margin-top: 8px;
    font-size: 14px;
    font-weight: 600;
  }
</style>
