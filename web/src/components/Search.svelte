<script lang="ts">
  import { untrack } from 'svelte';
  import Loading from './Loading.svelte';
  import SearchResults from './SearchResults.svelte';
  import { searchStream, type Hit } from '../lib/search';
  import { searchSources } from '../lib/searchSources';
  import { isHidden, type Prefs } from '../lib/prefs';
  import type { Title } from '../lib/library';

  let { query, tmdbKey, atlas, prefs, onselect }: {
    query: string; tmdbKey: string; atlas: string | null; prefs: Prefs; onselect?: (title: Title) => void;
  } = $props();
  const sources = $derived(searchSources(tmdbKey, undefined, atlas));
  const rulesKey = $derived(JSON.stringify([[...prefs.excludedGenres].sort(), [...prefs.excludedLanguages].sort(), prefs.hideAnime]));
  let hits = $state<Hit[] | null>(null);
  let failed = $state(false);
  let pending = $state(false);

  $effect(() => {
    const text = query.trim();
    const available = sources;
    void rulesKey;
    const rules = untrack(() => prefs);
    let current = true;
    hits = null;
    failed = false;
    pending = text.length >= 2;
    if (text.length < 2) return;
    const timer = setTimeout(async () => {
      try {
        for await (const batch of searchStream(text, available)) {
          if (!current) return;
          hits = batch.filter(hit => hit.kind === 'person' || !isHidden(hit.title, rules, { ignoringYearFloor: true }));
          pending = false;
        }
        if (current && hits === null) hits = [];
      } catch {
        if (current) { failed = true; hits = []; }
      } finally {
        if (current) pending = false;
      }
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  });
</script>

<section aria-label="Search results" aria-busy={pending}>
  <h1>Search</h1>
  {#if query.trim().length < 2}
    <p class="note">Search movies, series and people.</p>
  {:else if pending}
    <Loading label="Searching" />
  {:else if hits?.length}
    <SearchResults {hits} {onselect} />
  {:else}
    <p class="note" role="status">{failed ? 'Couldn’t search right now. Try again in a moment.' : 'No matches.'}</p>
  {/if}
</section>

<style>
  h1 { font-size:28px; margin:8px 0 24px; }
  .note { color:var(--muted); }
</style>
