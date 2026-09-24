<script lang="ts">
  // Home and the Watchlist page on a library that already holds something, with writes that land where the
  // page reads them back from. Without them, pressing Remove or Mark watched threw and the page said
  // "Couldn't save that" — so the actions a test most wants to press were the ones it could not.
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
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  import { fetchRoutes } from '../src/lib/routes';
  import { SessionServices } from '../src/lib/sessionServices.svelte';
  import { trackerEvent } from '../src/lib/trackerEvents';
  import {
    rowName,
    type EpisodeRow,
    type Row,
    type SettingsRow,
    type TitleRow,
  } from '../src/lib/wire';

  const params = new URLSearchParams(location.search);
  const populated = params.has('populated');
  const route: Route =
    params.get('page') === 'watchlist' ? { page: 'watchlist' } : { page: 'library' };
  let stored = $state<Row[]>(
    populated
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
      : [],
  );

  /** The row under its own name, replacing what was there: the same identity the real log keys rows by. */
  function put(row: Row) {
    const name = rowName(row);
    stored = [...stored.filter((held) => rowName(held) !== name), row];
  }

  const holds = (row: Row, ref: { type: string; id: number }) =>
    row.kind !== 'set' && row.title.type === ref.type && row.title.id === ref.id;

  const log = {
    settings: (group: string) =>
      group === 'keys'
        ? { values: { tmdb: { value: { string: 'fixture-key' }, at: [1, 0, 'test'] } } }
        : undefined,
    refresh: async () => false,
    rows: () => stored,
    newestStamp: () => [1, 0, 'test'],
    kept: async () => undefined,
    keep: async () => {},
    /** Nothing is ever waiting to be sent: a write here is done the moment it is made. */
    pendingActions: 0,
    title: (ref: { type: string; id: number }) =>
      stored.find((row): row is TitleRow => row.kind === 'rec' && holds(row, ref)),
    episode: (ref: { type: string; id: number }, season: number, number: number) =>
      stored.find(
        (row): row is EpisodeRow =>
          row.kind === 'ep' && holds(row, ref) && row.season === season && row.episode === number,
      ),
    write: async (row: Row) => {
      put(row);
      session.changed();
      return row;
    },
    /**
     * An action's journal carries the row it produced, so the fixture applies that rather than re-deriving it.
     * A journal that isn't a tracker event is kept as the row it is, which is what the real log does with it.
     */
    writeActions: async (journals: SettingsRow[]) => {
      for (const journal of journals) {
        const event = trackerEvent(journal);
        put(event ? event.after : journal);
      }
      session.changed();
      return true;
    },
    /** One action, as `act` writes it (Remove, Mark watched on a movie): its journal's row, as `writeActions` keeps them. */
    writeAction: async (journal: SettingsRow) => {
      const event = trackerEvent(journal);
      const row = event ? event.after : journal;
      put(row);
      session.changed();
      return row;
    },
  };

  const session = $state({
    // Bumped as the real session does, so a write is drawn rather than silently kept.
    changed(settings = false) {
      this.revision++;
      if (settings) this.settingsRevision++;
    },
    revision: 0,
    settingsRevision: 0,
    displays: [],
    shapes: new Map(),
    log,
    opened: Promise.resolve(log),
    routes: fetchRoutes,
    services: new SessionServices(fetchRoutes, () => session.changed(true)),
  }) as unknown as LibrarySession;
  const link = { inboxKey: 'fixture', libraryKey: 'fixture', linkKey: 'fixture' };
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <Library {link} {session} {route} active={true} />
</main>
