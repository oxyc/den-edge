<script lang="ts">
  import Library from '../src/Library.svelte';
  import '../src/app.css';
  import {
    blankEpisode,
    blankTitle,
    addToWatchlist,
    markEpisode,
    markWatched,
    updateProgress,
  } from '../src/lib/actions';
  import type { Route } from '../src/lib/route';
  const params = new URLSearchParams(location.search);
  const populated = params.has('populated');
  const route: Route =
    params.get('page') === 'watchlist' ? { page: 'watchlist' } : { page: 'library' };
  const rows = populated
    ? [
        updateProgress(blankTitle({ type: 'movie', id: 1001 }, 1), 0.5, 40, [1, 0, 'test']),
        addToWatchlist(blankTitle({ type: 'movie', id: 1002 }, 2), [2, 0, 'test']),
        ...[1003, 1004, 1005].map((id) =>
          markWatched(blankTitle({ type: 'movie', id }, id), [id, 0, 'test']),
        ),
        // The Watchlist page also lists series: one on the watchlist, one part-watched.
        ...(route.page === 'watchlist'
          ? [
              addToWatchlist(blankTitle({ type: 'tv', id: 2001 }, 3), [3, 0, 'test']),
              markEpisode(blankEpisode({ type: 'tv', id: 2002 }, 2, 4), true, [9000, 0, 'test']),
            ]
          : []),
      ]
    : [];
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  import { fetchRoutes } from '../src/lib/routes';
  const log = {
    settings: (group: string) =>
      group === 'keys'
        ? { values: { tmdb: { value: { string: 'fixture-key' }, at: [1, 0, 'test'] } } }
        : undefined,
    refresh: async () => false,
    rows: () => rows,
    newestStamp: () => [1, 0, 'test'],
    kept: async () => undefined,
    keep: async () => {},
  };
  const session = $state({
    changed: () => {},
    revision: 0,
    settingsRevision: 0,
    displays: [],
    shapes: new Map(),
    log,
    opened: Promise.resolve(log),
    routes: fetchRoutes,
  } as unknown as LibrarySession);
  const link = { inboxKey: 'fixture', libraryKey: 'fixture', linkKey: 'fixture' };
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <Library {link} {session} {route} active={true} />
</main>
