import {
  FINISHED_LIBRARY_POLICY,
  FINISHED_LIBRARY_RECOMMENDATIONS,
  FINISHED_LIBRARY_VIEWS_SCHEMA,
  readFinishedLibraryViews,
  type FinishedLibraryViews,
} from './finishedLibraryViews';
import {
  LIBRARY_FACT_SCHEMA,
  LibraryFactStore,
  mergeFactRows,
  type LibraryFactCapability,
} from './libraryFactStore';
import {
  LIBRARY_LOCAL_AUTHORITY,
  validLibraryLocalAuthorityIdentity,
} from './libraryLocalAuthority';
import { readEncryptedLibraryValue, writeEncryptedLibraryValue } from './libraryLocalValue';
import type { Vault } from './localVault';
import type { ContentReader } from './contentAuthority';
import type {
  LibraryObservation,
  LibraryQueryResult,
  LibrarySelection,
  LibrarySelectionValue,
  LibraryServiceHello,
} from './libraryServiceProtocol';
import {
  LibraryServiceAuthorityError,
  type LibraryAuthorityEvent,
  type LibraryServiceAuthority,
} from './libraryServiceCore';
import {
  noteFinishedViewCacheHit,
  noteFinishedViewPromotion,
  noteLibraryDecrypt,
  noteLibraryFold,
} from './libraryStartupMetrics';
import { isRetainedServices } from './libraryServiceProtocolCodec';
import { ensureSyncPolicy } from './syncLoader';
import {
  RETAINED_HOME_SHELVES,
  RETAINED_PREFERENCE_SEED,
  RETAINED_SERVICES,
  retainedBillboardName,
  retainedBillboardValue,
  storedBillboardValue,
} from './libraryRetainedViews';
import {
  libraryMetadataShape,
  libraryMetadataShapeDigest,
  libraryMetadataTitle,
} from './libraryMetadata';
import { ContinueProjector, type Shape } from './library';
import type { HomeLibraryView } from './homeLibraryView';
import { believe, deriveKeys, openEntry, type LibraryKeys, type Row } from './wire';
import {
  selectedDevicesView,
  selectedRuntimeView,
  selectedSettingsView,
} from './librarySelectedSettings';

const VISIBLE_REFRESH_MS = 30_000;
const PLAYBACK_REFRESH_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

const sameIdentity = (
  left: FinishedLibraryViews['identity'],
  right: FinishedLibraryViews['identity'],
): boolean =>
  left.libraryId === right.libraryId &&
  left.generation === right.generation &&
  left.head === right.head &&
  left.authorityRevision === right.authorityRevision &&
  left.policyVersion === right.policyVersion &&
  left.rowsVersion === right.rowsVersion &&
  left.layoutVersion === right.layoutVersion &&
  left.recommendationVersion === right.recommendationVersion &&
  left.reconsiderAt === right.reconsiderAt;

const rawLibraryKey = (encoded: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const raw = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    return raw.length === 32 && btoa(String.fromCharCode(...raw)) === encoded ? raw : null;
  } catch {
    return null;
  }
};

const factRef = (key: string) => {
  const [type, raw] = key.split(':');
  const id = Number(raw);
  if ((type !== 'movie' && type !== 'tv') || !Number.isSafeInteger(id) || id <= 0)
    throw new Error('Library fact contains an invalid title reference');
  return { type, id } as const;
};

const factOverview = (
  home: HomeLibraryView,
): Extract<LibrarySelectionValue, { kind: 'overview' }> => ({
  kind: 'overview',
  owned: home.owned.map(factRef),
  watched: home.watched.map(factRef),
  watchlist: home.watchlist.map(factRef),
  standings: home.standings.map(([key, standing]) => ({
    title: factRef(key),
    standing: standing === 'inProgress' ? 'in-progress' : standing,
  })),
  weighted: home.weighted.map(([key, weight, updatedAt]) => ({
    title: factRef(key),
    weight,
    updatedAt,
  })),
  seeds: {
    watched: home.seeds.watched.map(factRef),
    watchlisted: home.seeds.watchlisted.map(factRef),
  },
});

const factContinue = (
  home: HomeLibraryView,
  shapes: ReadonlyMap<string, Shape>,
  projector: ContinueProjector,
): Extract<LibrarySelectionValue, { kind: 'continue' }> => ({
  kind: 'continue',
  items: projector
    .project({ ...home.continueLibrary, shapes: new Map(shapes) })
    .map(({ ref, fraction, episode, seconds, at, liveEpisode, liveFraction }) => ({
      title: { type: ref.type, id: ref.id },
      fraction,
      ...(episode ? { episode } : {}),
      ...(seconds !== undefined ? { seconds } : {}),
      ...(at !== undefined ? { updatedAt: at } : {}),
      ...(liveEpisode ? { liveEpisode } : {}),
      ...(liveFraction !== undefined ? { liveFraction } : {}),
    })),
  needsShapes: home.requiredShapeRefs.filter((key) => !shapes.has(key)).map(factRef),
});

/**
 * A cache hit is a read-only startup authority. Writes and unsupported views promote it to the ordinary authority;
 * an unchanged remote head lets it remain small and keeps den-core unloaded.
 */
class FinishedLibraryViewAuthority implements LibraryServiceAuthority {
  readonly #listeners = new Set<(event: LibraryAuthorityEvent) => void>();
  #full?: LibraryServiceAuthority;
  #opening?: Promise<LibraryServiceAuthority>;
  #stopFull?: () => void;
  #closed = false;
  #checking?: Promise<void>;
  #timer?: ReturnType<typeof setTimeout>;
  #reconsiderTimer?: ReturnType<typeof setTimeout>;
  #lifecycle?: Extract<LibraryObservation, { kind: 'lifecycle' }>;
  #foregroundReady = false;
  #reconnecting = false;
  readonly #pieceFlights = new Map<string, Promise<boolean>>();
  readonly #factProjector = new ContinueProjector();
  readonly #factShapes = new Map<string, Shape>();
  #factHome?: HomeLibraryView;
  #preferFacts: boolean;

  constructor(
    private readonly request: LibraryServiceHello,
    private readonly cached: FinishedLibraryViews,
    private readonly keys: LibraryKeys,
    private readonly vault: Vault,
    private readonly content: Pick<ContentReader, 'title'>,
    private readonly openFull: () => Promise<LibraryServiceAuthority | null>,
    private readonly fetchImpl: typeof fetch,
    private readonly factStore: LibraryFactStore | null = null,
    preferFacts = false,
  ) {
    this.#preferFacts = preferFacts;
  }

  get generation(): string | null {
    return this.#full?.generation ?? this.cached.identity.generation;
  }

  async select(selection: LibrarySelection): Promise<LibrarySelectionValue> {
    if (this.#full) return this.#full.select(selection);
    const pieces = this.cached.pieces;
    if (selection.kind === 'overview') {
      if (!(await this.#loadCapabilities(['watchlist', 'recommendations'])))
        return (await this.#promote('cache:overview')).select(selection);
      const recommendations = pieces.recommendations!;
      return {
        kind: 'overview',
        ...structuredClone(recommendations),
        watchlist: structuredClone(pieces.watchlist!.titles),
      };
    }
    if (selection.kind === 'watchlist') {
      if (!(await this.#loadCapabilities(['watchlist'])))
        return (await this.#promote('cache:watchlist')).select(selection);
      return { kind: 'watchlist', titles: structuredClone(pieces.watchlist!.titles) };
    }
    if (selection.kind === 'recommendations') {
      if (!(await this.#loadCapabilities(['recommendations'])))
        return (await this.#promote('cache:recommendations')).select(selection);
      return { kind: 'recommendations', ...structuredClone(pieces.recommendations!) };
    }
    if (selection.kind === 'continue') {
      if (!(await this.#loadContinue()))
        return (await this.#promote('cache:continue')).select(selection);
      return structuredClone(pieces.continue!.view);
    }
    if (selection.kind === 'settings') {
      if (!(await this.#loadCapabilities(['settings'])))
        return (await this.#promote('cache:settings')).select(selection);
      return structuredClone(pieces.settings!);
    }
    if (selection.kind === 'runtime') {
      if (!(await this.#loadCapabilities(['runtime'])))
        return (await this.#promote('cache:runtime')).select(selection);
      return structuredClone(pieces.runtime!);
    }
    if (selection.kind === 'devices') {
      if (!(await this.#loadCapabilities(['devices'])))
        return (await this.#promote('cache:devices')).select(selection);
      return structuredClone(pieces.devices!);
    }
    return (await this.#promote(`selection:${selection.kind}`)).select(selection);
  }

  command: LibraryServiceAuthority['command'] = async (command, operationId) => {
    if (!this.#full) {
      let retained: { name: string; value: unknown } | undefined;
      if (command.kind === 'retained.services.set')
        retained = { name: RETAINED_SERVICES, value: command.value };
      else if (command.kind === 'retained.home-continue.set')
        retained = { name: RETAINED_HOME_SHELVES, value: { continue: command.present } };
      else if (command.kind === 'retained.billboard.set')
        retained = {
          name: retainedBillboardName(command.scope),
          value: storedBillboardValue(command.value),
        };
      if (retained) {
        const kept = await writeEncryptedLibraryValue(
          this.request.libraryKey,
          this.vault,
          retained.name,
          retained.value,
        );
        if (kept) return { outcome: 'applied', delivery: 'local', affected: [] };
      }
      if (command.kind === 'preferences.seed') {
        const seeded = await readEncryptedLibraryValue<unknown>(
          this.request.libraryKey,
          this.vault,
          RETAINED_PREFERENCE_SEED,
        );
        if (JSON.stringify(seeded) === JSON.stringify(command.household))
          return { outcome: 'unchanged', delivery: 'synced', affected: [] };
      }
    }
    return (await this.#promote(`command:${command.kind}`)).command(command, operationId);
  };
  query: LibraryServiceAuthority['query'] = async (query) => {
    if (!this.#full && query.kind === 'relay.membership')
      return {
        kind: 'relay.membership',
        capability: { libraryId: this.cached.identity.libraryId, memberToken: this.keys.member },
      };
    if (!this.#full && query.kind === 'retained.services.get') {
      const value = await readEncryptedLibraryValue<unknown>(
        this.request.libraryKey,
        this.vault,
        RETAINED_SERVICES,
      );
      return { kind: 'retained.services', value: isRetainedServices(value) ? value : null };
    }
    if (!this.#full && query.kind === 'retained.home-continue.get') {
      const value = await readEncryptedLibraryValue<unknown>(
        this.request.libraryKey,
        this.vault,
        RETAINED_HOME_SHELVES,
      );
      return {
        kind: 'retained.home-continue',
        present:
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          typeof (value as { continue?: unknown }).continue === 'boolean'
            ? (value as { continue: boolean }).continue
            : null,
      };
    }
    if (!this.#full && query.kind === 'retained.billboard.get') {
      const value = await readEncryptedLibraryValue<unknown>(
        this.request.libraryKey,
        this.vault,
        retainedBillboardName(query.scope),
      );
      return {
        kind: 'retained.billboard',
        scope: query.scope,
        value: retainedBillboardValue(query.scope, value),
      };
    }
    if (!this.#full && query.kind === 'library.metadata') return this.#metadata(query.titles);
    return (await this.#promote(`query:${query.kind}`)).query(query);
  };
  task: LibraryServiceAuthority['task'] = async (task, operationId) =>
    (await this.#promote(`task:${task.kind}`)).task(task, operationId);

  async observe(observation: LibraryObservation) {
    if (this.#full) return this.#full.observe(observation);
    if (observation.kind === 'lifecycle') {
      this.#lifecycle = structuredClone(observation);
      if (observation.visible && observation.online) this.#schedule(0);
      else this.#cancelTimer();
      return { outcome: 'unchanged' as const, affected: [] };
    }
    if (observation.kind === 'foreground-ready') {
      this.#foregroundReady = true;
      return { outcome: 'unchanged' as const, affected: [] };
    }
    return (await this.#promote(`observation:${observation.kind}`)).observe(observation);
  }

  listen(listener: (event: LibraryAuthorityEvent) => void): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer();
    this.#cancelReconsider();
    this.#stopFull?.();
    this.#listeners.clear();
    await this.#opening?.catch(() => undefined);
    await this.#full?.close?.();
  }

  #emit(event: LibraryAuthorityEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #schedule(delay: number): void {
    this.#cancelTimer();
    if (this.#closed || this.#full || !this.#lifecycle?.visible || !this.#lifecycle.online) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#reconcile();
    }, delay);
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #cancelReconsider(): void {
    if (this.#reconsiderTimer !== undefined) clearTimeout(this.#reconsiderTimer);
    this.#reconsiderTimer = undefined;
  }

  #continueFresh(): boolean {
    const reconsiderAt = this.cached.identity.reconsiderAt;
    if (reconsiderAt === null) return true;
    const remaining = reconsiderAt - Date.now();
    if (remaining <= 0) return false;
    if (this.#reconsiderTimer === undefined) {
      this.#reconsiderTimer = setTimeout(
        () => {
          this.#reconsiderTimer = undefined;
          if (this.#closed || this.#full) return;
          if (this.#continueFresh()) return;
          void this.#promote('continue:reconsider').catch(() => undefined);
        },
        Math.min(remaining, MAX_TIMER_MS),
      );
    }
    return true;
  }

  async #loadContinue(): Promise<boolean> {
    if (!(await this.#loadCapabilities(['continue']))) return false;
    return this.#continueFresh();
  }

  #reconcile(): Promise<void> {
    if (this.#checking) return this.#checking;
    const checking = (async () => {
      try {
        const identity = this.cached.identity;
        const response = await this.fetchImpl(
          `/lib/${identity.libraryId}/changes?since=${identity.head}&limit=1000`,
          {
            headers: {
              'x-den-library-token': this.keys.token,
              'x-den-wire': String(this.request.wire),
              'x-den-generation': identity.generation,
            },
          },
        );
        if (!response.ok) {
          await this.#promote(`reconcile:${response.status}`);
          return;
        }
        const page = (await response.json()) as {
          generation?: unknown;
          head?: unknown;
          entries?: unknown;
          more?: unknown;
        };
        const unchanged =
          page.generation === identity.generation &&
          page.head === identity.head &&
          Array.isArray(page.entries) &&
          page.entries.length === 0;
        if (!unchanged && !(await this.#reconcileFacts(page)))
          await this.#promote('reconcile:changed');
        else if (this.#reconnecting && !this.#closed) {
          this.#reconnecting = false;
          this.#emit({ kind: 'status', status: { kind: 'ready' } });
        }
      } catch {
        if (!this.#closed && !this.#reconnecting) {
          this.#reconnecting = true;
          this.#emit({ kind: 'status', status: { kind: 'reconnecting' } });
        }
      } finally {
        if (!this.#closed && !this.#full) {
          const interval = this.#lifecycle?.playbackActive
            ? PLAYBACK_REFRESH_MS
            : VISIBLE_REFRESH_MS;
          this.#schedule(interval);
        }
      }
    })();
    this.#checking = checking;
    void checking.finally(() => {
      if (this.#checking === checking) this.#checking = undefined;
    });
    return checking;
  }

  async #reconcileFacts(first: {
    generation?: unknown;
    head?: unknown;
    entries?: unknown;
    more?: unknown;
  }): Promise<boolean> {
    if (!this.factStore || first.generation !== this.cached.identity.generation) return false;
    const loaded = (
      ['watchlist', 'continue', 'recommendations', 'settings', 'runtime', 'devices'] as const
    ).filter((capability) => this.cached.pieces[capability] !== undefined);
    let page = first;
    let since = this.cached.identity.head;
    let changed = 0;
    for (;;) {
      if (
        page.generation !== this.cached.identity.generation ||
        !Number.isSafeInteger(page.head) ||
        !Array.isArray(page.entries) ||
        (page.more !== undefined && typeof page.more !== 'boolean')
      )
        return false;
      const entries: Array<{ k: string; seq: number; v: string }> = [];
      for (const candidate of page.entries) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
        const { k, seq, v } = candidate as { k?: unknown; seq?: unknown; v?: unknown };
        if (
          typeof k !== 'string' ||
          !/^[0-9a-f]{64}$/.test(k) ||
          !Number.isSafeInteger(seq) ||
          (seq as number) <= since ||
          typeof v !== 'string'
        )
          return false;
        entries.push({ k, seq: seq as number, v });
      }
      changed += entries.length;
      const facts = [];
      if (entries.length) await ensureSyncPolicy();
      for (const entry of entries) {
        const opened = await openEntry(this.keys, entry.k, entry.v);
        if (!('row' in opened)) return false;
        const previous = await this.factStore.document(this.cached.identity.generation, entry.k);
        const row = mergeFactRows(previous?.row ?? null, believe(opened.row));
        facts.push({ k: entry.k, seq: entry.seq, value: entry.v, row });
      }
      const head = entries.at(-1)?.seq ?? (page.head as number);
      const complete = page.more !== true || entries.length === 0;
      await this.factStore.commitBatch(this.cached.identity.generation, head, facts, complete);
      since = head;
      if (complete) break;
      const response = await this.fetchImpl(
        `/lib/${this.cached.identity.libraryId}/changes?since=${since}&limit=1000`,
        {
          headers: {
            'x-den-library-token': this.keys.token,
            'x-den-wire': String(this.request.wire),
            'x-den-generation': this.cached.identity.generation,
          },
        },
      );
      if (!response.ok) return false;
      page = (await response.json()) as typeof page;
    }

    this.cached.identity.head = since;
    this.cached.identity.rowsVersion += changed;
    this.#preferFacts = true;
    for (const capability of loaded) delete this.cached.pieces[capability];
    this.#factHome = undefined;
    this.#cancelReconsider();
    if (loaded.length && !(await this.#loadFactCapabilities([...loaded]))) return false;
    this.#emit({
      kind: 'changed',
      affected: loaded.map((capability) =>
        capability === 'continue'
          ? { kind: 'continue' as const }
          : capability === 'settings' || capability === 'runtime' || capability === 'devices'
            ? { kind: capability }
            : { kind: 'overview' as const },
      ),
    });
    return true;
  }

  async #metadata(
    titles: Extract<
      Parameters<LibraryServiceAuthority['query']>[0],
      { kind: 'library.metadata' }
    >['titles'],
  ): Promise<Extract<LibraryQueryResult, { kind: 'library.metadata' }>> {
    if (!(await this.#loadContinue()))
      return (await (
        await this.#promote('cache:continue-layouts')
      ).query({
        kind: 'library.metadata',
        titles,
      })) as Extract<LibraryQueryResult, { kind: 'library.metadata' }>;
    const found: Array<{
      title: NonNullable<ReturnType<typeof libraryMetadataTitle>>;
      shape?: NonNullable<ReturnType<typeof libraryMetadataShape>>;
    }> = [];
    const retryable: typeof titles = [];
    let retryAfterMs = 0;
    let contentNotConfigured = false;
    let next = 0;
    const lookup = async () => {
      for (let ref = titles[next++]; ref; ref = titles[next++]) {
        const result = await this.content.title(ref);
        if (result.kind === 'unavailable' || result.kind === 'not-configured') {
          retryable.push(ref);
          if (result.kind === 'not-configured') contentNotConfigured = true;
          if (result.kind === 'unavailable')
            retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs ?? 0);
          continue;
        }
        if (result.kind === 'missing') continue;
        const title = libraryMetadataTitle(result.value.title);
        if (!title) continue;
        const shape = result.value.shape && libraryMetadataShape(ref, result.value.shape);
        found.push({ title, ...(shape ? { shape } : {}) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, titles.length) }, lookup));
    const order = (title: { type: string; id: number }) =>
      titles.findIndex((ref) => ref.type === title.type && ref.id === title.id);
    found.sort((left, right) => order(left.title) - order(right.title));
    retryable.sort((left, right) => order(left) - order(right));
    // Cached metadata normally comes from ContentAuthority's own local values. If it needs a provider credential,
    // promote once so the ordinary authority can bind the encrypted keys held in the library log.
    if (contentNotConfigured) void this.#promote('content:not-configured').catch(() => undefined);

    const cached = this.cached.pieces.continue!;
    const needs = new Set(cached.view.needsShapes.map((ref) => `${ref.type}:${ref.id}`));
    let layoutChange: 'needed' | 'mismatch' | undefined;
    for (const { title, shape } of found) {
      const key = `${title.type}:${title.id}`;
      const previous = cached.layouts[key];
      if (needs.has(key) && shape) layoutChange = 'needed';
      else if (previous !== undefined && (!shape || libraryMetadataShapeDigest(shape) !== previous))
        layoutChange = 'mismatch';
    }
    if (layoutChange && this.factStore && this.#factHome) {
      for (const { shape } of found) {
        if (!shape) continue;
        this.#factShapes.set(`${shape.title.type}:${shape.title.id}`, {
          counts: new Map(shape.seasons.map(({ season, episodes }) => [season, episodes])),
          ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
        });
      }
      this.cached.pieces.continue = {
        view: factContinue(this.#factHome, this.#factShapes, this.#factProjector),
        layouts: {
          ...cached.layouts,
          ...Object.fromEntries(
            found.flatMap(({ shape }) =>
              shape
                ? [[`${shape.title.type}:${shape.title.id}`, libraryMetadataShapeDigest(shape)]]
                : [],
            ),
          ),
        },
      };
      this.#emit({ kind: 'changed', affected: [{ kind: 'continue' }] });
    } else if (layoutChange) void this.#promote(`layout:${layoutChange}`).catch(() => undefined);
    return {
      kind: 'library.metadata',
      titles: found.map(({ title }) => title),
      shapes: found.flatMap(({ shape }) => (shape ? [shape] : [])),
      retryable,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  }

  #loadCapabilities(capabilities: Array<keyof FinishedLibraryViews['pieces']>): Promise<boolean> {
    const missing = capabilities.filter(
      (capability) => this.cached.pieces[capability] === undefined,
    );
    if (!missing.length) return Promise.resolve(true);
    if (
      this.factStore &&
      this.#preferFacts &&
      missing.every((capability) =>
        ['watchlist', 'continue', 'recommendations', 'settings', 'runtime', 'devices'].includes(
          capability,
        ),
      )
    )
      return this.#loadFactCapabilities(
        missing as Array<
          'watchlist' | 'continue' | 'recommendations' | 'settings' | 'runtime' | 'devices'
        >,
      );
    const flightKey = [...missing].sort().join(',');
    const held = this.#pieceFlights.get(flightKey);
    if (held) return held;
    const flight = readFinishedLibraryViews(this.request.libraryKey, this.vault, missing).then(
      (opened) => {
        if (!opened || !sameIdentity(opened.identity, this.cached.identity)) return false;
        Object.assign(this.cached.pieces, opened.pieces);
        return true;
      },
      () => false,
    );
    this.#pieceFlights.set(flightKey, flight);
    void flight.finally(() => {
      if (this.#pieceFlights.get(flightKey) === flight) this.#pieceFlights.delete(flightKey);
    });
    return flight;
  }

  async #loadFactCapabilities(
    capabilities: Array<
      'watchlist' | 'continue' | 'recommendations' | 'settings' | 'runtime' | 'devices'
    >,
  ): Promise<boolean> {
    if (!this.factStore) return false;
    try {
      // ContinueProjector owns policy decisions in den-core. The document graph remains lazy, but a client that asks
      // for Continue explicitly opts into that policy module; Watchlist/settings/runtime/devices do not load it.
      if (capabilities.includes('continue')) await ensureSyncPolicy();
      const homeCapabilities = capabilities.filter((capability) =>
        ['watchlist', 'continue', 'recommendations'].includes(capability),
      ) as LibraryFactCapability[];
      const { view: home, reconsiderAt } = await this.factStore.home(
        this.cached.identity.generation,
        homeCapabilities,
      );
      const overview = factOverview(home);
      if (capabilities.includes('watchlist'))
        this.cached.pieces.watchlist = { titles: overview.watchlist };
      if (capabilities.includes('recommendations')) {
        const { kind: _kind, watchlist: _watchlist, ...recommendations } = overview;
        this.cached.pieces.recommendations = recommendations;
      }
      if (capabilities.includes('continue')) {
        this.#factHome = home;
        this.cached.identity.reconsiderAt = reconsiderAt;
        this.cached.pieces.continue = {
          view: factContinue(home, this.#factShapes, this.#factProjector),
          layouts: Object.fromEntries(
            [...this.#factShapes].map(([key, shape]) => [
              key,
              JSON.stringify({
                seasons: [...shape.counts]
                  .map(([season, episodes]) => ({ season, episodes }))
                  .sort((left, right) => left.season - right.season),
                lastAired: shape.lastAired ?? null,
              }),
            ]),
          ),
        };
      }
      const factManifest = await this.factStore.manifest();
      if (!factManifest?.complete || factManifest.generation !== this.cached.identity.generation)
        return false;
      if (capabilities.includes('settings')) {
        const rows = await this.factStore.settings(this.cached.identity.generation, 'settings');
        const view = selectedSettingsView(rows, factManifest.profileTopology);
        if (!view) return false;
        this.cached.pieces.settings = view;
      }
      if (capabilities.includes('runtime'))
        this.cached.pieces.runtime = selectedRuntimeView(
          await this.factStore.settings(this.cached.identity.generation, 'runtime'),
        );
      if (capabilities.includes('devices'))
        this.cached.pieces.devices = selectedDevicesView(
          await this.factStore.settings(this.cached.identity.generation, 'devices'),
        );
      return true;
    } catch (error) {
      console.warn('den: selected library facts could not be opened', error);
      return false;
    }
  }

  #promote(reason: string): Promise<LibraryServiceAuthority> {
    if (this.#full) return Promise.resolve(this.#full);
    if (this.#opening) return this.#opening;
    if (this.#closed)
      return Promise.reject(
        new LibraryServiceAuthorityError({
          code: 'not-ready',
          message: 'library service is closed',
          retryable: true,
        }),
      );
    noteFinishedViewPromotion(reason);
    this.#cancelTimer();
    this.#cancelReconsider();
    const opening = this.openFull().then(async (authority) => {
      if (!authority)
        throw new LibraryServiceAuthorityError({
          code: 'not-found',
          message: 'library could not be opened',
          retryable: true,
        });
      if (this.#closed) {
        await authority.close?.();
        throw new LibraryServiceAuthorityError({
          code: 'not-ready',
          message: 'library service closed while opening',
          retryable: true,
        });
      }
      this.#full = authority;
      this.#stopFull = authority.listen?.((event) => this.#emit(event));
      if (this.#lifecycle) await authority.observe(this.#lifecycle);
      if (this.#foregroundReady) await authority.observe({ kind: 'foreground-ready' });
      this.#emit({ kind: 'changed', affected: [{ kind: 'all' }] });
      return authority;
    });
    this.#opening = opening;
    void opening
      .catch(() => undefined)
      .finally(() => {
        if (this.#opening === opening) this.#opening = undefined;
      });
    return opening;
  }
}

export interface FinishedLibraryViewAuthorityOpen {
  authority: LibraryServiceAuthority;
  membership: { libraryId: string; memberToken: string };
}

/** A first selected open: scan encrypted authority in bounded pages and retain no full-history plaintext graph. */
async function importLibraryFacts(
  request: LibraryServiceHello,
  keys: LibraryKeys,
  vault: Vault,
  fetchImpl: typeof fetch,
): Promise<{
  store: LibraryFactStore;
  manifest: Awaited<ReturnType<LibraryFactStore['manifest']>>;
} | null> {
  const store = await LibraryFactStore.open(request.libraryKey, vault);
  if (!store) return null;
  let manifest = await store.manifest();
  if (manifest?.complete) return { store, manifest };
  let generation = manifest?.generation;
  let since = manifest?.head ?? 0;
  let registered = false;
  let decrypted = 0;
  const started = performance.now();
  for (;;) {
    let response: Response;
    try {
      response = await fetchImpl(`/lib/${keys.id}/changes?since=${since}&limit=64`, {
        headers: {
          'x-den-library-token': keys.token,
          'x-den-wire': String(request.wire),
          'x-den-generation': generation ?? '0',
        },
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const page = (await response.json().catch(() => null)) as {
      generation?: unknown;
      head?: unknown;
      more?: unknown;
      entries?: unknown;
    } | null;
    if (
      !page ||
      typeof page.generation !== 'string' ||
      !page.generation.length ||
      !Number.isSafeInteger(page.head) ||
      typeof page.more !== 'boolean' ||
      !Array.isArray(page.entries)
    )
      return null;
    if (generation && page.generation !== generation) {
      generation = page.generation;
      since = 0;
      manifest = null;
      continue;
    }
    generation = page.generation;
    if (!registered) {
      registered = true;
      void fetchImpl(`/lib/${keys.id}/member`, {
        method: 'PUT',
        headers: {
          'x-den-library-token': keys.token,
          'x-den-library-member': `${keys.id}:${keys.member}`,
          'x-den-wire': String(request.wire),
          'x-den-generation': generation,
        },
      }).catch(() => undefined);
    }
    const facts = [];
    if (page.entries.length) await ensureSyncPolicy();
    let profileTopology = manifest?.profileTopology ?? false;
    for (const candidate of page.entries) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const { k, seq, v } = candidate as { k?: unknown; seq?: unknown; v?: unknown };
      if (
        typeof k !== 'string' ||
        !/^[0-9a-f]{64}$/.test(k) ||
        !Number.isSafeInteger(seq) ||
        (seq as number) <= since ||
        typeof v !== 'string'
      )
        return null;
      const opened = await openEntry(keys, k, v);
      let row: Row | null = null;
      if ('row' in opened) {
        const previous = await store.document(generation, k);
        row = mergeFactRows(previous?.row ?? null, believe(opened.row));
      } else if ('profileDirectory' in opened || 'invalidProfileDirectory' in opened)
        profileTopology = true;
      else if ('newerFraming' in opened) return null;
      facts.push({ k, seq: seq as number, value: v, row });
      decrypted++;
    }
    const head = facts.at(-1)?.seq ?? (page.head as number);
    const complete = !page.more || facts.length === 0;
    await store.commitBatch(generation, head, facts, complete, { profileTopology });
    since = head;
    manifest = await store.manifest();
    if (complete) {
      const elapsed = performance.now() - started;
      noteLibraryDecrypt(decrypted, elapsed);
      noteLibraryFold(decrypted, elapsed);
      return manifest?.complete ? { store, manifest } : null;
    }
  }
}

/** Null is a conservative miss: local/pending work, expiry, schema/policy change, or any absent startup piece. */
export async function openFinishedLibraryViewAuthority(
  request: LibraryServiceHello,
  vault: Vault,
  openFull: () => Promise<LibraryServiceAuthority | null>,
  content: Pick<ContentReader, 'title'>,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<FinishedLibraryViewAuthorityOpen | null> {
  if (request.mode !== 'online') return null;
  const raw = rawLibraryKey(request.libraryKey);
  if (!raw) return null;
  try {
    const keys = await deriveKeys(raw);
    if ((await vault.entries(`${keys.id}:runtime:pending:`)).length) return null;
    const localIdentity = await readEncryptedLibraryValue<unknown>(
      request.libraryKey,
      vault,
      LIBRARY_LOCAL_AUTHORITY,
    );
    const cached = await readFinishedLibraryViews(request.libraryKey, vault, []);
    let factStore = await LibraryFactStore.open(request.libraryKey, vault);
    let factManifest = await factStore?.manifest();
    const classic =
      !!cached &&
      validLibraryLocalAuthorityIdentity(localIdentity) &&
      localIdentity.generation === cached.identity.generation &&
      localIdentity.head === cached.identity.head &&
      localIdentity.authorityRevision === cached.identity.authorityRevision &&
      localIdentity.rowsVersion === cached.identity.rowsVersion &&
      cached.identity.policyVersion === FINISHED_LIBRARY_POLICY &&
      cached.identity.recommendationVersion === FINISHED_LIBRARY_RECOMMENDATIONS;
    let factsReady =
      !!factManifest &&
      factManifest.complete &&
      factManifest.schema === LIBRARY_FACT_SCHEMA &&
      factManifest.generation.length > 0;
    if (!classic && !factsReady) {
      const imported = await importLibraryFacts(request, keys, vault, fetchImpl);
      factStore = imported?.store ?? factStore;
      factManifest = imported?.manifest ?? null;
      factsReady = !!factManifest?.complete;
    }
    if (!classic && !factsReady) return null;
    const selected: FinishedLibraryViews = classic
      ? cached!
      : {
          schema: FINISHED_LIBRARY_VIEWS_SCHEMA,
          identity: {
            libraryId: keys.id,
            generation: factManifest!.generation,
            head: factManifest!.head,
            authorityRevision: `facts:${factManifest!.head}`,
            policyVersion: FINISHED_LIBRARY_POLICY,
            rowsVersion: factManifest!.head,
            layoutVersion: 'facts',
            recommendationVersion: FINISHED_LIBRARY_RECOMMENDATIONS,
            reconsiderAt: null,
          },
          pieces: {},
        };
    noteFinishedViewCacheHit();
    const membership = { libraryId: keys.id, memberToken: keys.member };
    return {
      authority: new FinishedLibraryViewAuthority(
        request,
        selected,
        keys,
        vault,
        content,
        openFull,
        fetchImpl,
        factsReady &&
          factManifest!.generation === selected.identity.generation &&
          factManifest!.head === selected.identity.head
          ? factStore!
          : null,
        !classic,
      ),
      membership,
    };
  } finally {
    raw.fill(0);
  }
}
