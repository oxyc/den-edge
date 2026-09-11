<script lang="ts">
  import PosterCard from './components/PosterCard.svelte';
  import PosterRow from './components/PosterRow.svelte';
  import { loadLibrary, type LibraryResult } from './lib/backup';
  import {
    applyLog,
    continueWatching,
    untitled,
    watchlist,
    withDisplay,
    type ContinueEntry,
    type Title,
  } from './lib/library';
  import type { Link } from './lib/links.svelte';
  import { readLog } from './lib/log';
  import { fetchTitle, storedTmdbKey } from './lib/tmdb';

  let { link }: { link: Link } = $props();
  const loading = $derived(load(link.inboxKey));

  /** The backup, brought up to date from the record log when the TV has handed over its key. */
  async function load(inboxKey: string): Promise<LibraryResult> {
    const result = await loadLibrary(inboxKey);
    if (result.state !== 'ok' || !result.libraryKey) return result;
    const rows = await readLog(result.libraryKey);
    if (!rows) return result;
    let library = applyLog(result.library, rows);
    const tmdbKey = storedTmdbKey();
    if (tmdbKey) {
      const titles = await Promise.all(untitled(library).slice(0, 60).map((ref) => fetchTitle(ref, tmdbKey)));
      library = withDisplay(library, titles.filter((t): t is Title => t !== null));
    }
    return { ...result, library, live: true };
  }

  function caption(entry: ContinueEntry): string | undefined {
    if (entry.episode) return `S${entry.episode.season} · E${entry.episode.episode}`;
    return entry.title.year ? String(entry.title.year) : undefined;
  }
</script>

{#await loading}
  <p class="note">Loading your library…</p>
{:then result}
  {#if result.state === 'ok'}
    {@const resume = continueWatching(result.library)}
    {@const saved = watchlist(result.library)}
    {#if resume.length}
      <PosterRow heading="Continue Watching">
        {#each resume as entry (`${entry.title.type}:${entry.title.id}`)}
          <PosterCard title={entry.title} caption={caption(entry)} progress={entry.fraction} />
        {/each}
      </PosterRow>
    {/if}
    {#if saved.length}
      <PosterRow heading="Watchlist">
        {#each saved as title (`${title.type}:${title.id}`)}
          <PosterCard {title} caption={title.year ? String(title.year) : undefined} />
        {/each}
      </PosterRow>
    {/if}
    {#if !resume.length && !saved.length}
      <p class="note">Nothing in progress and nothing on your watchlist yet.</p>
    {/if}
    {#if result.live}
      <p class="note small">Up to date with your TV.</p>
    {:else}
      <p class="note small">From the TV’s backup of {new Date(result.backedUpAt).toLocaleString()}.</p>
    {/if}
  {:else if result.state === 'none'}
    <p class="note">No backup from your TV yet. On the TV, open <b>Settings › Sync settings</b> and back up.</p>
  {:else if result.reason === 'unreadable'}
    <p class="note">The backup here was made with another link. Back up again on the TV.</p>
  {:else}
    <p class="note">Couldn’t reach Den. Check that this device is on your network.</p>
  {/if}
{/await}

<style>
  .note {
    color: var(--muted);
  }

  .small {
    font-size: 13px;
  }
</style>
