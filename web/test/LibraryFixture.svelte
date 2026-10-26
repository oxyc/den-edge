<script lang="ts">
  // Home and the Watchlist page on a library that already holds something, with writes that land where the
  // page reads them back from. Without them, pressing Remove or Mark watched threw and the page said
  // "Couldn't save that" — so the actions a test most wants to press were the ones it could not.
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
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
  import { activeProfileSession, type ProfileSession } from '../src/lib/profileSession.svelte';
  import { persistentProfileIdentity, visitorVisitId } from '../src/lib/profileIdentity';
  import {
    visitorProfileSession,
    type VisitorProfileSession,
  } from '../src/lib/visitorProfileSession.svelte';
  import { trackerEvent } from '../src/lib/trackerEvents';
  import { applyOps, opsFor } from '../src/lib/libraryV4';
  import type { LibraryLog } from '../src/lib/log';
  import { fixtureLibraryService } from './libraryService';
  import {
    rowName,
    type DocumentRow,
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
  const manyWatchlist = params.has('many-watchlist');
  /** Let shelf naming, rather than fixture setup, supply the large row's display fields. */
  const unnamedMany = params.has('unnamed-many');
  let releaseOpen = () => {};
  const openGate = params.has('hold-open')
    ? new Promise<void>((resolve) => (releaseOpen = resolve))
    : undefined;
  if (openGate)
    (window as unknown as { denTestReleaseLibraryOpen: () => void }).denTestReleaseLibraryOpen =
      releaseOpen;
  /** Every action refused, as a library that can't be reached refuses it. */
  const failing = params.has('failing');
  /** Actions wait until `denTestReleaseWrites()`: a write that takes as long as a slow library takes. */
  let releaseWrites = () => {};
  const writeGate = params.has('hold-writes')
    ? new Promise<void>((resolve) => (releaseWrites = resolve))
    : undefined;
  if (writeGate)
    (window as unknown as { denTestReleaseWrites: () => void }).denTestReleaseWrites =
      releaseWrites;
  const withDownload = params.has('downloading');
  const homeDownloads = params.has('home-downloads');
  const downloadAt = Date.now();
  // Seed persisted fixture data directly. `startRow` is a write operation and real callers invoke it only after an
  // interaction, when deferred policy is ready; running it while this component is constructed would make every
  // read-only fixture depend on the mutation module during startup.
  const downloadRow: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'download:movie:9001:-1:-1',
    values: {
      release: {
        value: {
          string:
            '{"identity":"fixture-download.mkv","label":"Fixture download","url":"/scout/p/fixture-download"}',
        },
        at: [downloadAt, 0, 'test'],
      },
      title: {
        value: {
          string: '{"mediaId":9001,"mediaType":"movie","title":"Fixture download"}',
        },
        at: [downloadAt, 0, 'test'],
      },
      queuedAt: { value: { int: downloadAt }, at: [downloadAt, 0, 'test'] },
    },
  };
  const homeDownloadRows = homeDownloads
    ? ['Active download', 'Ready download', 'Unavailable download', 'Failed download'].map(
        (title, index): SettingsRow => {
          const at = downloadAt + index;
          return {
            kind: 'set',
            schema: 2,
            name: `download:movie:${9100 + index}:-1:-1`,
            values: {
              release: {
                value: {
                  string: JSON.stringify({
                    identity: title,
                    label: title,
                    url: `/scout/p/home-${index}`,
                  }),
                },
                at: [at, 0, 'test'],
              },
              title: {
                value: {
                  string: JSON.stringify({ mediaId: 9100 + index, mediaType: 'movie', title }),
                },
                at: [at, 0, 'test'],
              },
              queuedAt: { value: { int: at }, at: [at, 0, 'test'] },
            },
          };
        },
      )
    : [];
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
    const follow = (event: Event) => {
      const { path, replace = false } = (event as CustomEvent<{ path: string; replace?: boolean }>)
        .detail;
      route = parseRoute(path);
      // Playback-address tests exercise the Router's observable contract while retaining this fixture's controlled
      // library and media services. Every other fixture keeps its historical URL, as before.
      if (params.has('address')) history[replace ? 'replaceState' : 'pushState'](null, '', path);
    };
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
          ...(params.has('bluey')
            ? [
                markWatched(blankTitle({ type: 'tv', id: 82728 }, Date.now()), [
                  Date.now(),
                  0,
                  'test',
                ]),
              ]
            : []),
          // The Watchlist page also lists series: one on the watchlist, one part-watched.
          ...(route.page === 'watchlist'
            ? [
                addToWatchlist(blankTitle({ type: 'tv', id: 2001 }, 3), [3, 0, 'test']),
                ...(params.has('history-overflow')
                  ? Array.from({ length: 15 }, (_, index) => {
                      const season = index < 8 ? 1 : 2;
                      const episode = index < 8 ? index + 1 : index - 7;
                      return markEpisode(
                        blankEpisode({ type: 'tv', id: 2002 }, season, episode),
                        true,
                        [9000 + index, 0, 'test'],
                      );
                    })
                  : [
                      markEpisode(blankEpisode({ type: 'tv', id: 2002 }, 2, 4), true, [
                        9000,
                        0,
                        'test',
                      ]),
                    ]),
                ...years,
              ]
            : []),
          ...Array.from({ length: many }, (_, index) => {
            const id = 3000 + index;
            const title = blankTitle({ type: 'movie', id }, id);
            return manyWatchlist
              ? addToWatchlist(title, [id, 0, 'test'])
              : updateProgress(title, 0.5, 40, [id, 0, 'test']);
          }),
          // Series on the watchlist whose stand-in TMDB layouts differ: one season, and four.
          ...(params.has('series-kinds')
            ? [2004, 2005].map((id) =>
                addToWatchlist(blankTitle({ type: 'tv', id }, id), [id, 0, 'test']),
              )
            : []),
          ...(params.has('series-continue')
            ? [markEpisode(blankEpisode({ type: 'tv', id: 2002 }, 1, 1), true, [9000, 0, 'test'])]
            : []),
          ...(withDownload ? [downloadRow] : []),
          ...homeDownloadRows,
        ]
      : [],
  );

  let rowsVersion = 1;

  function validFixtureDevices(value: unknown): unknown {
    if (Array.isArray(value)) {
      if (
        value.length === 3 &&
        typeof value[0] === 'number' &&
        typeof value[1] === 'number' &&
        typeof value[2] === 'string' &&
        (value[0] !== 0 || value[1] !== 0)
      )
        return [value[0], value[1], 'aaaaaaaaaaaaaaaa'];
      return value.map(validFixtureDevices);
    }
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, held]) => [key, validFixtureDevices(held)]),
      );
    return value;
  }

  /** Project this v2 fixture's mutable rows into the v4 document surface production LibraryLog exposes. */
  function documents(): { seq: number; document: DocumentRow }[] {
    const held = new SvelteMap<string, DocumentRow>();
    for (const row of stored) {
      const edits =
        row.kind === 'rec'
          ? opsFor(
              row.resume.value === 0
                ? { ...blankTitle(row.title, row.addedAt), resume: row.resume }
                : blankTitle(row.title, row.addedAt),
              row,
            )
          : row.kind === 'ep'
            ? opsFor(blankEpisode(row.title, row.season, row.episode), row)
            : [];
      const valid = edits.map((edit) => ({
        ...edit,
        write: validFixtureDevices(edit.write) as Record<string, unknown>,
      }));
      for (const document of applyOps(valid, (name) => held.get(name)))
        held.set(rowName(document), document);
    }
    return [...held.values()].map((document, index) => ({ seq: index + 1, document }));
  }

  /** The row under its own name, replacing what was there: the same identity the real log keys rows by. */
  function put(row: Row) {
    const name = rowName(row);
    stored = [...stored.filter((held) => rowName(held) !== name), row];
    rowsVersion++;
  }

  const holds = (row: Row, ref: { type: string; id: number }) =>
    row.kind !== 'set' && row.title.type === ref.type && row.title.id === ref.id;

  /**
   * `link-host=tv|browser|legacy-tv|legacy-browser`: what the library's device list holds besides this browser. A `tv`
   * publishes a household play key (den-spec inbox-v1 §5); a `legacy-tv` is one too old to, so nothing plays on it.
   * `second-tv` adds a second TV with a key, the one a play last started on.
   */
  const linkHost = params.get('link-host');
  const hostDevice = 'cccc000000000003';
  const secondTv = 'dddd000000000004';
  const at = [1, 0, 'test'];
  // Whole settings rows, as the log's own `settings` returns them: the selected views find them by `name`.
  const devices =
    linkHost === 'tv' ||
    linkHost === 'browser' ||
    linkHost === 'legacy-tv' ||
    linkHost === 'legacy-browser'
      ? {
          kind: 'set',
          schema: 2,
          name: 'devices',
          values: {
            [`${hostDevice}.name`]: {
              value: { string: linkHost.includes('browser') ? 'Mac · Chrome' : 'Living Room TV' },
              at,
            },
            [`${hostDevice}.kind`]: {
              value: { string: linkHost.includes('browser') ? 'browser' : 'tv' },
              at,
            },
            [`${hostDevice}.seen`]: { value: { int: 5000 }, at },
            ...(linkHost === 'tv'
              ? { [`${hostDevice}.play`]: { value: { string: 'A'.repeat(43) }, at } }
              : {}),
            ...(params.has('second-tv')
              ? {
                  [`${secondTv}.name`]: { value: { string: 'Bedroom' }, at },
                  [`${secondTv}.kind`]: { value: { string: 'tv' }, at },
                  [`${secondTv}.play`]: { value: { string: `${'B'.repeat(42)}A` }, at },
                  [`${secondTv}.played`]: { value: { int: 7000 }, at },
                }
              : {}),
          },
        }
      : undefined;
  /** `plugin=<manifest URL>`: the library lists that addon, as Settings › Plugins installs one. */
  const plugin = params.get('plugin');
  const log = {
    readOnly: false,
    wireMinimum: 4,
    currentGeneration: undefined,
    settings: (group: string) =>
      group === 'keys'
        ? {
            kind: 'set',
            schema: 2,
            name: 'keys',
            values: { tmdb: { value: { string: 'fixture-key' }, at } },
          }
        : group === 'devices'
          ? devices
          : group === 'plugins' && plugin
            ? {
                kind: 'set',
                schema: 2,
                name: 'plugins',
                values: { [plugin]: { value: { bool: true }, at } },
              }
            : undefined,
    refresh: async () => false,
    rows: () => stored,
    get rowsVersion() {
      return rowsVersion;
    },
    documents,
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
      await writeGate;
      if (failing) return false;
      for (const journal of journals) {
        const event = trackerEvent(journal);
        put(event ? event.after : journal);
      }
      return true;
    },
    /** One action, as `act` writes it (Remove, Mark watched on a movie): its journal's row, as `writeActions` keeps them. */
    writeAction: async (journal: SettingsRow) => {
      await writeGate;
      if (failing) return null;
      const event = trackerEvent(journal);
      const row = event ? event.after : journal;
      put(row);
      return row;
    },
    profileDirectory: () => null,
    close() {},
  } as unknown as LibraryLog;

  let publish = () => {};
  const library = fixtureLibraryService({
    log,
    failOpenOnce: params.has('open-failure'),
    openFailureMessage: params.has('storage-timeout')
      ? 'Library storage timed out while opening IndexedDB'
      : undefined,
    openGate,
    failHistoryDetails: params.has('fail-history-details'),
  });
  (
    window as unknown as { denTestHistoryDetails: typeof library.historyDetails }
  ).denTestHistoryDetails = library.historyDetails;
  publish = () => library.publish();
  if (homeDownloads) {
    library.coordinator.answers.set(homeDownloadRows[0].name, {
      state: 'preparing',
      progress: 0.25,
    });
    library.coordinator.answers.set(homeDownloadRows[1].name, { state: 'ready' });
    library.coordinator.answers.set(homeDownloadRows[2].name, { state: 'refused' });
    library.coordinator.answers.set(homeDownloadRows[3].name, {
      state: 'preparing',
      progress: 0.5,
      fetch: { state: 'failed' },
    });
    // Provider completion republishes the same DownloadsView as a real queue refresh.
    (window as unknown as { denTestFinishDownload: () => void }).denTestFinishDownload = () => {
      library.coordinator.answers.set(homeDownloadRows[0].name, { state: 'ready' });
      publish();
    };
    (window as unknown as { denTestClearReadyDownloads: () => void }).denTestClearReadyDownloads =
      () => {
        stored = stored.filter(
          (row) =>
            row.kind !== 'set' ||
            !homeDownloadRows.slice(0, 2).some((download) => download.name === row.name),
        );
        rowsVersion++;
        publish();
      };
  }
  const visitor = params.has('visitor');
  const kid = params.has('kid');
  const session: ProfileSession = visitor
    ? visitorProfileSession(
        library.session.household,
        localStorage,
        visitorVisitId('11111111111111111111111111111111'),
      )
    : kid
      ? activeProfileSession(
          persistentProfileIdentity('22222222222222222222222222222222', 'fixture-kid'),
          library.session.household,
          library.session.model!,
          null,
          { maximumAge: 12, unknownRatings: 'block' },
          false,
          true,
        )
      : library.session;
  // `services`: find atlas and the rest as the app does, so Home draws its service rows.
  if (kid || params.has('services'))
    void session.model?.ready.then(() => session.configureServices());
  let visitorReady = $state(!visitor);
  if (visitor) {
    const activity = (session as VisitorProfileSession).profileActivity!;
    void Promise.all([
      activity.setWatchlisted({ type: 'movie', id: 4001, title: 'Visitor saved' }, true),
      activity.recordProgress({ type: 'movie', id: 4002, title: 'Visitor resumed' }, 0.4, 1200),
      activity.setWatched({ type: 'movie', id: 4003, title: 'Visitor watched' }, true),
    ]).then(() => (visitorReady = true));
  }
  if (!unnamedMany) {
    const named = Array.from({ length: many }, (_, index) => ({
      type: 'movie' as const,
      id: 3000 + index,
      title: `Measured movie ${index + 1}`,
    }));
    session.publishLibraryMetadata(
      params.has('sparse-many') ? [...named.slice(-8), named[0]!] : named,
      [],
    );
  }
  const link = {
    inboxKey: 'fixture',
    name: linkHost?.includes('browser') ? 'Mac · Chrome' : 'Living Room TV',
    libraryKey: 'fixture',
    linkKey: 'fixture',
    ...(devices && !linkHost?.startsWith('legacy-') ? { deviceId: hostDevice } : {}),
  };
  const shownLink = params.has('local') || visitor ? null : link;

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
    // What the library holds now, as a spec reads back what playback wrote.
    (window as unknown as { denTestRows: () => Row[] }).denTestRows = () => $state.snapshot(stored);
    return () => {
      delete (window as { denTestLivePosition?: unknown }).denTestLivePosition;
      delete (window as { denTestRows?: unknown }).denTestRows;
    };
  });
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  {#if visitorReady}<span data-visitor-ready hidden>ready</span>{/if}
  <LibraryStatus toast={session.toast} alert={session.alert} />
  <Library
    link={shownLink}
    {session}
    {route}
    active={true}
    watchedYear={route.page === 'watchlist' ? route.year : undefined}
  />
</main>
