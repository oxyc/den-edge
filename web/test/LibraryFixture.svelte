<script lang="ts">
  import Library from '../src/Library.svelte';
  import '../src/app.css';
  import { blankTitle, addToWatchlist, markWatched, updateProgress } from '../src/lib/actions';
  const populated = new URLSearchParams(location.search).has('populated');
  const rows = populated
    ? [
        updateProgress(blankTitle({ type: 'movie', id: 1001 }, 1), 0.5, 40, [1, 0, 'test']),
        addToWatchlist(blankTitle({ type: 'movie', id: 1002 }, 2), [2, 0, 'test']),
        ...[1003, 1004, 1005].map((id) =>
          markWatched(blankTitle({ type: 'movie', id }, id), [id, 0, 'test']),
        ),
      ]
    : [];
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  const log = {
    settings: (group: string) =>
      group === 'keys'
        ? { values: { tmdb: { value: { string: 'fixture-key' }, at: [1, 0, 'test'] } } }
        : undefined,
    refresh: async () => false,
    rows: () => rows,
    newestStamp: () => [1, 0, 'test'],
  };
  const session = $state({
    changed: () => {},
    revision: 0,
    settingsRevision: 0,
    displays: [],
    shapes: new Map(),
    log,
    opened: Promise.resolve(log),
  } as unknown as LibrarySession);
  const link = { inboxKey: 'fixture', libraryKey: 'fixture', linkKey: 'fixture' };
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <Library {link} {session} route={{ page: 'library' }} active={true} />
</main>
