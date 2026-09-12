<!-- A poster with its title — the one card every row uses (the TV's PosterCard). Posters come straight from
     TMDB's image CDN, which needs no key. With `onselect` the whole card is a button. A movie scout found nothing
     to play for is faded, as on the TV. -->
<script lang="ts">
  import { availability } from '../lib/availability.svelte';
  import type { Title } from '../lib/library';

  let {
    title,
    caption,
    progress,
    onselect,
  }: { title: Title; caption?: string; progress?: number; onselect?: () => void } = $props();
  const poster = $derived(
    title.posterPath ? `https://image.tmdb.org/t/p/w342${title.posterPath}` : undefined,
  );
  const faded = $derived(availability.unavailable(title));
  $effect(() => availability.want(title));
</script>

{#snippet body()}
  <span class="art">
    {#if poster}
      <img src={poster} alt="" loading="lazy" decoding="async" />
    {:else}
      <span class="placeholder">{title.title}</span>
    {/if}
    {#if title.rating}
      <span class="rating" aria-label="Rated {title.rating.toFixed(1)}"
        >★ {title.rating.toFixed(1)}</span
      >
    {/if}
    {#if progress !== undefined && progress > 0}
      <span class="progress" style:--p={progress}></span>
    {/if}
  </span>
  <span class="meta">
    <span class="name">{title.title}</span>
    {#if caption}<span class="caption">{caption}</span>{/if}
  </span>
{/snippet}

{#if onselect}
  <button type="button" class="card pick" class:faded onclick={onselect}>{@render body()}</button>
{:else}
  <figure class="card" class:faded>{@render body()}</figure>
{/if}

<style>
  .card {
    margin: 0;
    width: var(--card-w);
  }

  /* The TV's fade: dim, and less so under the pointer or focus so the card stays legible. */
  .faded {
    opacity: 0.5;
  }

  .faded:hover,
  .faded:focus-visible {
    opacity: 0.8;
  }

  .pick {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .art {
    position: relative;
    display: block;
    aspect-ratio: 2 / 3;
    max-width: 100%;
    overflow: hidden;
    border-radius: 12px;
    background: var(--card);
  }

  .pick:focus-visible .art {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .placeholder {
    display: grid;
    height: 100%;
    place-items: center;
    padding: 12px;
    color: var(--muted);
    font-size: 14px;
    text-align: center;
  }

  .rating {
    position: absolute;
    top: 8px;
    left: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
    font-size: 12px;
    font-weight: 600;
  }

  .progress {
    position: absolute;
    right: 8px;
    bottom: 8px;
    left: 8px;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      var(--fg) calc(var(--p) * 100%),
      rgb(255 255 255 / 0.3) 0
    );
  }

  .meta {
    display: grid;
    margin-top: 8px;
    font-size: 14px;
  }

  .name {
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caption {
    color: var(--muted);
  }
</style>
