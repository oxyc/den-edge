<script lang="ts">
  // Home and the Watchlist page on a library that already holds something, with writes that land where the
  // page reads them back from. Without them, pressing Remove or Mark watched threw and the page said
  // "Couldn't save that" — so the actions a test most wants to press were the ones it could not.
  import { onMount } from 'svelte';
  import Library from '../src/Library.svelte';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import '../src/app.css';
  import {
    blankEpisode,
    blankTitle,
    addToWatchlist,
    markEpisode,
    markWatched,
    updateProgress,
  } from '../src/lib/actions';
  import { parseRoute, type Route } from '../src/lib/route';
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  import { trackerEvent } from '../src/lib/trackerEvents';
  import { browserClock } from '../src/lib/clock';
  import { startRow } from '../src/lib/downloadRows';
  import type { LibraryLog } from '../src/lib/log';
  import { fixtureLibraryService } from './libraryService';
  import {
    rowName,
    type EpisodeRow,
    type Row,
    type SettingsRow,
    type TitleRow,
  } from '../src/lib/wire';

  const params = new URLSearchParams(location.search);
  const populated = params.has('populated');
  let releaseContinueHint!: () => void;
  const continueHint = new Promise<void>((resolve) => (releaseContinueHint = resolve));
  if (params.has('continue-hint'))
    (window as unknown as { denTestReleaseContinueHint: () => void }).denTestReleaseContinueHint =
      releaseContinueHint;
  const many = Math.max(0, Math.min(500, Number(params.get('many')) || 0));
  /** Let shelf naming, rather than fixture setup, supply the large row's display fields. */
  const unnamedMany = params.has('unnamed-many');
  /** Every action refused, as a library that can't be reached refuses it. */
  const failing = params.has('failing');
  const withDownload = params.has('downloading');
  const fixtureClock = browserClock();
  const downloadRow = startRow(
    undefined,
    {
      release: {
        identity: 'fixture-download.mkv',
        label: 'Fixture download',
        url: '/scout/p/fixture-download',
      },
      title: { mediaType: 'movie', mediaId: 9001, title: 'Fixture download' },
    },
    () => fixtureClock.issue(),
    Date.now(),
  );
  let route = $state<Route>(
    params.get('page') === 'watchlist'
      ? { page: 'watchlist' }
      : params.get('page') === 'title'
        ? {
            page: 'title',
            type: params.get('type') === 'tv' ? 'tv' : 'movie',
            id: Number(params.get('id')),
          }
        : { page: 'library' },
  );
  // The app's Router answers a page's `navigate`; here the route just follows it, so a pick that lives in the address
  // (Watched's year) is drawn.
  onMount(() => {
    const follow = (event: Event) =>
      (route = parseRoute((event as CustomEvent<{ path: string }>).detail.path));
    document.addEventListener('den:navigate', follow);
    return () => document.removeEventListener('den:navigate', follow);
  });
  /** Watches in other years, and one with no time, for Watched's year picker. */
  const years = params.has('years')
    ? [
        markWatched(blankTitle({ type: 'movie', id: 1006 }, 6), [Date.UTC(2019, 5, 15), 0, 'test']),
        markEpisode(blankEpisode({ type: 'tv', id: 2003 }, 1, 1), true, [
          Date.UTC(2024, 5, 15),
          0,
          'test',
        ]),
        markWatched(blankTitle({ type: 'movie', id: 1007 }, 7), [0, 0, 'test']),
      ]
    : [];
  let stored = $state<Row[]>(
    populated
      ? [
          ...(params.has('no-movie-continue')
            ? []
            : [
                updateProgress(blankTitle({ type: 'movie', id: 1001 }, 1), 0.5, 40, [1, 0, 'test']),
              ]),
          addToWatchlist(blankTitle({ type: 'movie', id: 1002 }, 2), [2, 0, 'test']),
          ...[1003, 1004, 1005].map((id) =>
            markWatched(blankTitle({ type: 'movie', id }, id), [id, 0, 'test']),
          ),
          // The Watchlist page also lists series: one on the watchlist, one part-watched.
          ...(route.page === 'watchlist'
            ? [
                addToWatchlist(blankTitle({ type: 'tv', id: 2001 }, 3), [3, 0, 'test']),
                markEpisode(blankEpisode({ type: 'tv', id: 2002 }, 2, 4), true, [9000, 0, 'test']),
                ...years,
              ]
            : []),
          ...Array.from({ length: many }, (_, index) => {
            const id = 3000 + index;
            return updateProgress(blankTitle({ type: 'movie', id }, id), 0.5, 40, [id, 0, 'test']);
          }),
          ...(params.has('series-continue')
            ? [markEpisode(blankEpisode({ type: 'tv', id: 2002 }, 1, 1), true, [9000, 0, 'test'])]
            : []),
          ...(withDownload ? [downloadRow] : []),
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
    readOnly: false,
    wireMinimum: 4,
    currentGeneration: undefined,
    settings: (group: string) =>
      group === 'keys'
        ? { values: { tmdb: { value: { string: 'fixture-key' }, at: [1, 0, 'test'] } } }
        : undefined,
    refresh: async () => false,
    rows: () => stored,
    seqOf: () => 0,
    newestStamp: () => [1, 0, 'test'],
    kept: async (name: string) => {
      if (!params.has('continue-hint') || name !== 'home.shelves.v1') return undefined;
      await continueHint;
      return { continue: true };
    },
    keep: async () => {},
    relayMembership: async () => null,
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
      return row;
    },
    /**
     * An action's journal carries the row it produced, so the fixture applies that rather than re-deriving it.
     * A journal that isn't a tracker event is kept as the row it is, which is what the real log does with it.
     */
    writeActions: async (journals: SettingsRow[]) => {
      if (failing) return false;
      for (const journal of journals) {
        const event = trackerEvent(journal);
        put(event ? event.after : journal);
      }
      return true;
    },
    /** One action, as `act` writes it (Remove, Mark watched on a movie): its journal's row, as `writeActions` keeps them. */
    writeAction: async (journal: SettingsRow) => {
      if (failing) return null;
      const event = trackerEvent(journal);
      const row = event ? event.after : journal;
      put(row);
      return row;
    },
    close() {},
  } as unknown as LibraryLog;

  let publish = () => {};
  const library = fixtureLibraryService({ log });
  publish = () => library.publish();
  const session: LibrarySession = library.session;
  void library.model.ready.then(() => session.configureServices());
  if (!unnamedMany)
    session.publishLibraryMetadata(
      Array.from({ length: many }, (_, index) => ({
        type: 'movie' as const,
        id: 3000 + index,
        title: `Measured movie ${index + 1}`,
      })),
      [],
    );
  const link = {
    inboxKey: 'fixture',
    name: 'Living Room TV',
    libraryKey: 'fixture',
    linkKey: 'fixture',
  };

  // Test-only seam for den-edge#235's Playwright spec: stands in for "a library pull landed a fresh position",
  // since this fixture's library never actually pulls over the network. `at` defaults to now, so a test can pass
  // one in the past (den-edge#235: a position predating the send must not read as the TV having started it).
  onMount(() => {
    const denTestLivePosition = (
      ref: { type: 'movie' | 'tv'; id: number },
      seconds: number,
      at = Date.now(),
    ) => {
      const before = log.title(ref) ?? blankTitle(ref, at);
      put(updateProgress(before, 0.2, seconds, [at, 0, 'other-device']));
      publish();
    };
    (window as unknown as { denTestLivePosition: typeof denTestLivePosition }).denTestLivePosition =
      denTestLivePosition;
    return () => {
      delete (window as { denTestLivePosition?: unknown }).denTestLivePosition;
    };
  });
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <LibraryStatus toast={session.toast} alert={session.alert} />
  <Library
    {link}
    {session}
    {route}
    active={true}
    watchedYear={route.page === 'watchlist' ? route.year : undefined}
  />
</main>
