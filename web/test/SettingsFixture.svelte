<script lang="ts">
  import { onDestroy } from 'svelte';
  // The Settings page on a library that already holds what a TV would have written into it: the household's keys,
  // the TV's hide rules, an addon, and two devices. Everything is in memory, so the page has something to show
  // without a paired TV or a den-edge behind it, and a save lands where the page reads it back from.
  import Settings from '../src/Settings.svelte';
  import Router from '../src/Router.svelte';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import { browserClock } from '../src/lib/clock';
  import type { LibraryLog } from '../src/lib/log';
  import {
    rowName,
    type ConfigValue,
    type DocumentRow,
    type Row,
    type SettingsRow,
    type Stamp,
  } from '../src/lib/wire';
  import { fixtureLog } from './fixtureLog';
  import { fixtureLibraryService } from './libraryService';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import type { ContentServiceClientPort } from '../src/lib/contentServiceClient';
  import type {
    ContentPolicy,
    ContentRequest,
    ContentResultFor,
  } from '../src/lib/contentServiceProtocol';
  import { LibraryModel } from '../src/lib/libraryModel.svelte';
  import { links } from '../src/lib/links.svelte';
  import type { JoinLibrary } from '../src/lib/browserHousehold';
  import '../src/app.css';

  const at = [1, 0, 'test'] as unknown as Stamp;
  const fixtureClock = browserClock();
  const fixtureLibraryId = '50724b489a92805f23be6bba897393c7';
  const fixtureMemberToken = 'a17b6bb5b7e47d81e1fc40e34fe289274301987448de937c7ad2f566094fdf50';
  const fixtureQuery = new URLSearchParams(location.search);
  const heldKeyValidation = fixtureQuery.has('key-save-authority');
  if (heldKeyValidation) history.replaceState(null, '', `/settings${location.search}`);
  const joinPresentationFixture = fixtureQuery.has('join-presentation');
  const replacesAuthority =
    fixtureQuery.has('authority-replacement') ||
    fixtureQuery.has('recovery-authority-replacement') ||
    joinPresentationFixture;
  let releaseRecoveryWrite = () => {};
  const recoveryWriteGate = fixtureQuery.has('recovery-authority-replacement')
    ? new Promise<void>((resolve) => (releaseRecoveryWrite = resolve))
    : undefined;
  let recoveryWriteHeld = false;
  const row = (name: string, values: Record<string, ConfigValue>): SettingsRow => ({
    kind: 'set',
    schema: 2,
    name,
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, at }])),
  });

  // Device ids are the stamp device ids each device lists itself under, newest `seen` first on the page.
  let stored: Row[] = [
    row('keys', { tmdb: { string: 'K1' }, parentalPIN: { string: '1234' } }),
    row('prefs', {
      'den.excludedGenreIDs': { ints: [27] },
      'den.hideAnime': { bool: true },
      'den.myServicePicks': { strings: ['8@FI'] },
      'den.maturityCeiling': { string: 'pg13' },
    }),
    row('plugins', {
      [new URLSearchParams(location.search).has('legacy-addon')
        ? 'https://den.example/scout/OLD/manifest.json'
        : 'https://addon.example/manifest.json']: { bool: true },
    }),
    // An assistant allowed to change the library: den-spec's assistant-v1 vectors' `grant` key.
    row('assistant-grants', {
      d7047d7faa4c6f77e1919c132bb6bd9f: {
        string: JSON.stringify({
          cap: 100,
          client: 'Claude',
          createdAt: 1_789_000_000_000,
          expiresAt: 4_102_444_800_000,
          ops: ['rate', 'seen', 'watchlist_add', 'watchlist_remove'],
          pk: 'jftOjtUEDF6Jm8aGfb7qQZsWQBTKy8ED5zIpdrgtmk0',
          revokedAt: null,
          v: 1,
        }),
      },
    }),
    row('devices', {
      [`${fixtureClock.device}.name`]: { string: 'Test Browser' },
      [`${fixtureClock.device}.kind`]: { string: 'browser' },
      [`${fixtureClock.device}.seen`]: { int: 10000 },
      'aaaa000000000001.name': { string: 'Living Room TV' },
      'aaaa000000000001.kind': { string: 'tv' },
      'aaaa000000000001.seen': { int: 5000 },
      'bbbb000000000002.name': { string: 'Mac' },
      'bbbb000000000002.kind': { string: 'browser' },
      'bbbb000000000002.seen': { int: 9000 },
    }),
  ];
  let rowsVersion = 0;

  const put = (next: Row) => {
    stored = [...stored.filter((held) => rowName(held) !== rowName(next)), next];
    rowsVersion++;
  };
  // What the library holds now, for a spec to read back what a press wrote.
  (globalThis as { fixtureRows?: () => Row[] }).fixtureRows = () => stored;
  const log = {
    readOnly: false,
    wireMinimum: 4,
    get profileTopologyPresent() {
      return new URLSearchParams(location.search).has('profiles');
    },
    currentGeneration: undefined,
    logHead: 0,
    get rowsVersion() {
      return rowsVersion;
    },
    pendingActions: 0,
    libraryId: fixtureLibraryId,
    memberProof: fixtureMemberToken,
    settings: (name: string) =>
      stored.find((held): held is SettingsRow => held.kind === 'set' && held.name === name),
    refresh: async () => false,
    readToHead: async () => true,
    rows: () => stored,
    ...fixtureLog(() => stored, historyDocuments),
    seqOf: () => 0,
    documents: historyDocuments,
    newestStamp: () => at,
    currentSummary: () => ({ stamp: at, reconsiderAt: Infinity, at: Date.now() }),
    kept: async () => undefined,
    keep: async () => {},
    relayMembership: async () => ({
      libraryId: fixtureLibraryId,
      memberToken: fixtureMemberToken,
    }),
    title: () => undefined,
    episode: () => undefined,
    write: async (next: Row) => {
      put(next);
      return next;
    },
    writeAt: async (next: SettingsRow) => {
      if (
        recoveryWriteGate &&
        next.name === 'recovery' &&
        Object.values(next.values).some(({ value }) => {
          if (!value || !('string' in value)) return false;
          try {
            return (JSON.parse(value.string) as { state?: unknown }).state === 'live';
          } catch {
            return false;
          }
        })
      ) {
        recoveryWriteHeld = true;
        await recoveryWriteGate;
      }
      put(next);
      return true;
    },
    writeRows: async (rows: Row[]) => {
      for (const next of rows) put(next);
      return true;
    },
    profileDirectory: () => null,
    close() {},
  } as unknown as LibraryLog;

  // One film seen twice and one on the watchlist, for the history export.
  function historyDocuments(): { seq: number; document: DocumentRow }[] {
    return [
      {
        seq: 1,
        document: {
          format: 4,
          kind: 'title',
          title: { type: 'movie', id: 550 },
          status: { value: 'watched', at: [1_789_000_000_000, 0, 'a1b2c3d4e5f60718'] },
          resume: { value: 1, at: [1_789_000_000_000, 0, 'a1b2c3d4e5f60718'], viewing: 1 },
          reaction: { value: 'love', at: [1_789_000_000_000, 0, 'a1b2c3d4e5f60718'] },
          watch: { plays: { '0': 1_760_000_000_000, '1': 1_789_000_000_000 }, cleared: null },
        },
      },
      {
        seq: 2,
        document: {
          format: 4,
          kind: 'title',
          title: { type: 'movie', id: 603 },
          status: { value: 'watchlist', at: [1_789_000_000_000, 0, 'a1b2c3d4e5f60718'] },
        },
      },
    ];
  }

  const fixtureLibraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  let releaseImportReply = () => {};
  const historyImportReplyGate = fixtureQuery.has('hold-import-reply')
    ? new Promise<void>((resolve) => (releaseImportReply = resolve))
    : undefined;
  const library = fixtureLibraryService({
    log,
    device: fixtureClock.device,
    libraryKey: fixtureLibraryKey,
    loseHistoryImportReplyOnce: fixtureQuery.has('lose-import-reply'),
    historyImportReplyGate,
    loseRecoveryConfirmReplyOnce: fixtureQuery.has('recovery-authority-replacement'),
  });
  (globalThis as { fixtureHistoryImports?: typeof library.historyImports }).fixtureHistoryImports =
    library.historyImports;
  const primaryModel = library.model;
  const { session } = library;
  const replacementLibrary = replacesAuthority
    ? fixtureLibraryService({
        log,
        device: fixtureClock.device,
        libraryKey: fixtureLibraryKey,
      })
    : undefined;
  let model = $state.raw<LibraryModel>(primaryModel);
  let settingsMounted = $state(true);
  const recoveryAuthorityControls = {
    replace() {
      if (replacementLibrary) model = replacementLibrary.model;
    },
    release() {
      releaseRecoveryWrite();
    },
    held() {
      return recoveryWriteHeld;
    },
    tasks() {
      return {
        primary: [...library.recoveryTasks],
        replacement: [...(replacementLibrary?.recoveryTasks ?? [])],
      };
    },
    async reread() {
      await replacementLibrary?.publish([{ kind: 'recovery' }]);
    },
  };
  (
    globalThis as typeof globalThis & {
      fixtureRecoveryAuthority?: typeof recoveryAuthorityControls;
    }
  ).fixtureRecoveryAuthority = recoveryAuthorityControls;
  let heldConnections: ReturnType<typeof library.holdNextSelection> | undefined;
  let heldSimkl: ReturnType<typeof library.holdNextSelection> | undefined;
  let heldAuthorityPublication: Promise<void> | undefined;
  const authorityReplacementControls = {
    failConnections() {
      library.failSelection('connections');
    },
    async holdOldSelections() {
      heldConnections = library.holdNextSelection('connections');
      heldSimkl = library.holdNextSelection('simkl');
      heldAuthorityPublication = library.publish([{ kind: 'connections' }, { kind: 'simkl' }]);
      await Promise.all([heldConnections.started, heldSimkl.started]);
    },
    replace() {
      if (!replacementLibrary) return;
      put(
        row('keys', {
          tmdb: { string: 'K1' },
          parentalPIN: { string: '5678' },
          simkl: { string: 'replacement-simkl-token' },
        }),
      );
      put(
        row('plugins', {
          'https://replacement.example/manifest.json': { bool: true },
        }),
      );
      put(
        row('devices', {
          [`${fixtureClock.device}.name`]: { string: 'Test Browser' },
          [`${fixtureClock.device}.kind`]: { string: 'browser' },
          [`${fixtureClock.device}.seen`]: { int: 20000 },
          'cccc000000000003.name': { string: 'Kitchen TV' },
          'cccc000000000003.kind': { string: 'tv' },
          'cccc000000000003.seen': { int: 15000 },
        }),
      );
      model = replacementLibrary.model;
    },
    async releaseOldSelections() {
      heldConnections?.release();
      heldSimkl?.release();
      await heldAuthorityPublication;
    },
    subscriptions() {
      return {
        primary: library.activeSelections(),
        replacement: replacementLibrary?.activeSelections() ?? {},
      };
    },
    commands() {
      return {
        primary: [...library.commandKinds],
        replacement: [...(replacementLibrary?.commandKinds ?? [])],
      };
    },
    unmount() {
      settingsMounted = false;
    },
  };
  (
    globalThis as typeof globalThis & {
      fixtureSettingsAuthority?: typeof authorityReplacementControls;
    }
  ).fixtureSettingsAuthority = authorityReplacementControls;

  type JoinGate = { promise: Promise<void>; release: () => void };
  const gate = (): JoinGate => {
    let release = () => {};
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  };
  const joinCalls: Array<{
    key: string;
    link: NonNullable<NonNullable<Parameters<JoinLibrary>[1]>['link']>;
    before: JoinGate;
    after: JoinGate;
    stage: 'before' | 'after' | 'done' | 'abandoned';
  }> = [];
  const heldJoin: JoinLibrary = async (key, options = {}) => {
    if (!options.link || !options.presentation) return 'failed';
    const call: (typeof joinCalls)[number] = {
      key,
      link: options.link,
      before: gate(),
      after: gate(),
      stage: 'before',
    };
    joinCalls.push(call);
    await call.before.promise;
    if (!options.presentation.isCurrent()) {
      call.stage = 'abandoned';
      return 'failed';
    }
    call.stage = 'after';
    await call.after.promise;
    // This is RoutedLibrary's post-commit rule: reconcile only the exact captured credentials even if the initiating
    // presentation has since gone. Connections owns selection, notices and navigation and will fence all of those.
    links.reconcileCommitted(call.link, key);
    call.stage = 'done';
    return 'joined';
  };
  const joinPresentationControls = {
    calls: () =>
      joinCalls.map(({ key, link, stage }) => ({
        key,
        link: structuredClone(link),
        stage,
      })),
    release(index: number, boundary: 'before' | 'after') {
      joinCalls[index]?.[boundary].release();
    },
    replace() {
      authorityReplacementControls.replace();
    },
    unmount() {
      authorityReplacementControls.unmount();
    },
    installReplacement(inboxKey: string) {
      links.add(inboxKey, {
        name: 'Replacement',
        libraryKey: 'replacement-library',
        linkKey: 'replacement-key',
      });
      links.makeCurrent(inboxKey);
    },
    links: () => structuredClone(links.list),
    current: () => links.current?.inboxKey ?? null,
  };
  (
    globalThis as typeof globalThis & {
      fixtureJoinPresentation?: typeof joinPresentationControls;
    }
  ).fixtureJoinPresentation = joinPresentationControls;
  // A second activity identity over the same fixture authority is enough to exercise Settings' live prop handoff:
  // it has its own retained import scope while the old model's in-flight semantic reply remains real.
  const replacementActivityModel = {
    get overview() {
      return primaryModel.overview;
    },
    importHistory: primaryModel.importHistory.bind(primaryModel),
    exportHistory: primaryModel.exportHistory.bind(primaryModel),
  } as unknown as LibraryModel;
  let activityModel = $state.raw<LibraryModel>(primaryModel);
  (
    globalThis as {
      fixtureImportScope?: {
        replace(): void;
        restore(): void;
        release(): void;
      };
    }
  ).fixtureImportScope = {
    replace: () => (activityModel = replacementActivityModel),
    restore: () => (activityModel = primaryModel),
    release: () => releaseImportReply(),
  };
  const contentServices = createWorkerServiceSession();
  const contentModel = new LibraryModel(contentServices.library, {
    libraryKey: fixtureLibraryKey,
    mode: 'local',
  });
  type HeldKeyCheck = {
    service: 'tmdb' | 'omdb' | 'content-warnings';
    candidate: string;
    runtime: string;
    settled: boolean;
    settle: (outcome: 'accepted' | 'refused' | 'unavailable') => void;
  };
  const heldKeyChecks: HeldKeyCheck[] = [];
  const contentFor = (runtime: string): ContentServiceClientPort => ({
    query<Request extends ContentRequest>(
      request: Request,
      signal?: AbortSignal,
      policy?: ContentPolicy,
      onProgress?: (partial: ContentResultFor<Request>) => void,
    ): Promise<ContentResultFor<Request>> {
      if (
        heldKeyValidation &&
        request.kind === 'provider-key.check' &&
        typeof request.candidate === 'string'
      )
        return new Promise((resolve) => {
          const call: HeldKeyCheck = {
            service: request.service,
            candidate: request.candidate!,
            runtime,
            settled: false,
            settle(outcome) {
              if (call.settled) return;
              call.settled = true;
              resolve({
                kind: 'provider-key.check',
                service: request.service,
                outcome,
              } as ContentResultFor<Request>);
            },
          };
          heldKeyChecks.push(call);
        });
      return contentServices.content.query(request, signal, policy, onProgress);
    },
    onStatus: (listener) => contentServices.content.onStatus(listener),
  });
  let content = $state.raw<ContentServiceClientPort>(contentFor('owner-a'));
  let contentRuntime = 0;
  const keySaveAuthorityControls = {
    calls: () =>
      heldKeyChecks.map(({ service, candidate, runtime, settled }) => ({
        service,
        candidate,
        runtime,
        settled,
      })),
    settle(index: number, outcome: 'accepted' | 'refused' | 'unavailable') {
      heldKeyChecks[index]?.settle(outcome);
    },
    replaceOwner() {
      authorityReplacementControls.replace();
      content = contentFor(`owner-replacement-${++contentRuntime}`);
    },
    replaceRuntime() {
      content = contentFor(`owner-runtime-${++contentRuntime}`);
    },
    leave(role: 'kid' | 'visitor') {
      document.dispatchEvent(
        new CustomEvent('den:navigate', { detail: { path: `/?departed-as=${role}` } }),
      );
    },
    reopen() {
      document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/settings' } }));
    },
    reopenReplacement() {
      authorityReplacementControls.replace();
      content = contentFor(`owner-reopened-${++contentRuntime}`);
      settingsMounted = true;
    },
    rejectNextSave(replacement = false) {
      (replacement ? replacementLibrary : library)?.rejectNextApiKeyCommand();
    },
    commands: () => ({
      primary: structuredClone(library.apiKeyCommands),
      replacement: structuredClone(replacementLibrary?.apiKeyCommands ?? []),
    }),
  };
  (
    globalThis as typeof globalThis & {
      fixtureKeySaveAuthority?: typeof keySaveAuthorityControls;
    }
  ).fixtureKeySaveAuthority = keySaveAuthorityControls;
  let contentReady = $state(false);
  void contentModel.ready
    .then(() => contentModel.setApiKey('tmdb', 'K1', 'settings-fixture-key'))
    .then(() => (contentReady = true));
  onDestroy(() => contentServices.close());
  session.publishLibraryMetadata(
    [
      { type: 'movie', id: 550, title: 'Fight Club', year: 1999, imdbId: 'tt0137523' },
      { type: 'movie', id: 603, title: 'The Matrix', year: 1999, imdbId: 'tt0133093' },
    ],
    [],
  );
  // `?switched`: this browser just moved the library to v4, as the real session says after `switchLibraryToV4`.
  if (new URLSearchParams(location.search).has('switched')) session.toast = 'Library updated to v4';
  const linked = {
    inboxKey: 'deadbeefcafe1234',
    name: 'Living Room TV',
    libraryKey: fixtureLibraryKey,
    linkKey: 'fixture',
  };
  const link = joinPresentationFixture ? null : linked;
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <LibraryStatus toast={session.toast} alert={session.alert} />
  {#if heldKeyValidation}
    <Router onchange={() => {}}>
      {#snippet children(route, _active, routePresentation)}
        {#if route.page === 'settings'}
          {#if contentReady}<Settings
              {link}
              {model}
              {activityModel}
              {content}
              {routePresentation}
              onresetkey={async () => null}
            />{/if}
        {:else}
          <h1>Home</h1>
        {/if}
      {/snippet}
    </Router>
  {:else if contentReady && settingsMounted}<Settings
      {link}
      {model}
      {activityModel}
      {content}
      local={joinPresentationFixture}
      onjoin={joinPresentationFixture ? heldJoin : undefined}
      onresetkey={async () => null}
    />{/if}
</main>
