<!-- A person's page, as the TV's: who they are, and what they're known for, most notable first. -->
<script lang="ts">
  import { fetchPerson, type PersonDetail } from '../lib/detail';
  import type { Title } from '../lib/library';
  import { searchSources } from '../lib/searchSources';
  import SearchResults from './SearchResults.svelte';

  let {
    id,
    tmdbKey,
    onselect,
    shown = () => true,
  }: { id: number; tmdbKey: string; onselect: (title: Title) => void; shown?: (title: Title) => boolean } = $props();

  /** undefined while it loads; null when TMDB couldn't say. */
  let person = $state<PersonDetail | null | undefined>(undefined);
  let films = $state<Title[]>([]);
  let expanded = $state(false);

  $effect(() => {
    const [current, key] = [id, tmdbKey];
    person = undefined;
    films = [];
    expanded = false;
    void fetchPerson(current, key).then((loaded) => {
      if (current === id) person = loaded;
    });
    void searchSources(key)
      .notableFilms(current)
      .then((loaded) => {
        if (current === id) films = loaded;
      })
      .catch(() => {
        if (current === id) films = [];
      });
  });

  const hits = $derived(films.filter(shown).map((title) => ({ kind: 'title' as const, title })));
</script>

{#if person === undefined}
  <p class="note">Loading…</p>
{:else if person === null}
  <p class="note">Couldn’t load this person from TMDB. Try again in a moment.</p>
{:else}
  <header class="head">
    <span class="portrait">
      {#if person.profilePath}<img src="https://image.tmdb.org/t/p/w342{person.profilePath}" alt="" />{/if}
    </span>
    <div>
      <h1>{person.name}</h1>
      {#if person.knownFor}<p class="known">{person.knownFor}</p>{/if}
      {#if person.biography}
        <p class="bio" class:expanded>{person.biography}</p>
        {#if person.biography.length > 400}
          <button class="more" onclick={() => (expanded = !expanded)}>{expanded ? 'Less' : 'More'}</button>
        {/if}
      {/if}
    </div>
  </header>
  {#if hits.length}
    <h2>Known for</h2>
    <SearchResults {hits} {onselect} />
  {/if}
{/if}

<style>
  .head {
    display: flex;
    gap: 24px;
    align-items: start;
    margin-bottom: 32px;
  }

  .portrait {
    flex: 0 0 auto;
    width: clamp(96px, 24vw, 200px);
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

  h1 {
    margin: 0;
    font-size: clamp(24px, 4vw, 36px);
  }

  .known {
    margin: 6px 0 0;
    color: var(--muted);
  }

  .bio {
    display: -webkit-box;
    max-width: 70ch;
    margin: 12px 0 0;
    overflow: hidden;
    white-space: pre-line;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
  }

  .bio.expanded {
    display: block;
  }

  .more {
    margin-top: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
  }

  h2 {
    margin: 0 0 16px;
    font-size: 20px;
  }

  .note {
    color: var(--muted);
  }
</style>
