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
  AssistantConnection,
  LibraryCommand,
  LibraryObservation,
  LibraryQueryResult,
  LibrarySelection,
  LibrarySelectionValue,
  LibraryServiceHello,
  TitleRef,
  TitleView,
} from './libraryServiceProtocol';
import {
  LibraryServiceAuthorityError,
  type LibraryAuthorityEvent,
  type LibrarySelectionScope,
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
  ASSISTANT_RECORDS,
  DROPBOX_ROW,
  dropboxKey,
  publicationDueAt,
  type AssistantRecords,
} from './libraryAssistantAuthority';
import { ensureAssistantPolicy } from './assistantCore';
import { syncPolicy } from './syncCore';
import { startupMark } from './startupTiming';
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
import { ContinueProjector, titleKey, type Shape } from './library';
import type { HomeLibraryView } from './homeLibraryView';
import { episodeRow, episodeRowNames, titleCoordinates, titleRow, titleView } from './titleView';
import {
  believe,
  deriveKeys,
  openEntry,
  rowKey,
  wellFormed,
  type LibraryKeys,
  type Row,
  type SettingsRow,
} from './wire';
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
  /** Series shapes the page observed, by title: a title's view needs its episodes, and a promotion is told them. */
  readonly #titleShapes = new Map<
    string,
    {
      shape: Shape;
      digest: string;
      observation: Extract<LibraryObservation, { kind: 'title-shape' }>;
    }
  >();
  /** Titles whose view was read from the fact store: told of a change another device made. */
  readonly #titlesServed = new Map<string, TitleRef>();
  #preferFacts: boolean;
  /** The import is still reading the history behind a first page (`importNewestFirst`). */
  #filling = false;
  #refilling?: Promise<void>;
  #refillAgain = false;

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
    filling?: ImportedFacts['filling'],
    /**
     * The fact store whenever it holds this generation whole, at the views' head or past it: a title's view reads only
     * its own documents (`#titleFromFacts`), so a store that moved on since the views were saved is only more current.
     */
    private readonly documents: LibraryFactStore | null = factStore,
  ) {
    this.#preferFacts = preferFacts;
    if (filling) {
      this.#filling = true;
      filling.page.committed = () => this.#refill();
      void filling.done.then((complete) => this.#filled(complete));
    }
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
    if (selection.kind === 'title') {
      const view = await this.#titleFromFacts(selection.title);
      if (view) return view;
    }
    return (await this.#promote(`selection:${selection.kind}`)).select(selection);
  }

  /**
   * A title's view from its own rows in the fact store, as the full log builds it (`titleView`, `titleRow`,
   * `episodeRow`): the rows those may read for the title and each episode of the shape the page observed, read by key —
   * a few dozen, not the whole library. Null when the store is not this library's whole copy, or holds one of them
   * only as den-edge's sealed value, which the full log opens.
   */
  async #titleFromFacts(ref: TitleRef): Promise<TitleView | null> {
    const documents = this.documents;
    if (!documents) return null;
    try {
      const generation = this.cached.identity.generation;
      const manifest = await documents.manifest();
      if (!manifest?.complete || manifest.generation !== generation) return null;
      const shape = this.#titleShapes.get(titleKey(ref))?.shape;
      const names = new Set([
        `title:${ref.type}:${ref.id}`,
        `rec:${ref.type}:${ref.id}`,
        ...titleCoordinates(ref, shape).flatMap(({ season, episode }) =>
          episodeRowNames(ref, season, episode),
        ),
      ]);
      const rows = new Map<string, Row>();
      for (const name of names) {
        const stored = await documents.document(generation, await rowKey(this.keys, name));
        if (!stored) continue;
        if (!stored.row || !wellFormed(stored.row)) return null;
        rows.set(name, stored.row);
      }
      // Projecting a document, and an episode's watch register, is den-core's.
      if (rows.size) await ensureSyncPolicy();
      const get = (name: string) => rows.get(name);
      const view = titleView(
        ref,
        titleRow(get, ref),
        (season, episode) => episodeRow(get, ref, season, episode),
        shape,
      );
      this.#titlesServed.set(titleKey(ref), { type: ref.type, id: ref.id });
      return view;
    } catch (error) {
      console.warn('den: a title could not be read from library facts', error);
      return null;
    }
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
        // Nothing kept says so on a first open, but the profile's own preferences are in its settings facts: when it
        // has decided every one the household holds, there is nothing to write, and no log to open for it.
        if (await this.#seedDecided(command.household)) {
          await writeEncryptedLibraryValue(
            this.request.libraryKey,
            this.vault,
            RETAINED_PREFERENCE_SEED,
            command.household,
          );
          return { outcome: 'unchanged', delivery: 'synced', affected: [] };
        }
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
  task: LibraryServiceAuthority['task'] = async (task, operationId) => {
    // Deciding what to publish reads the whole library; until this device's publication is due, nothing is.
    if (task.kind === 'assistant.publish' && !this.#full && (await this.#publicationCurrent()))
      return { result: { kind: 'assistant.publish', published: 0 }, affected: [] };
    // A drain that found nothing has nothing to apply: the drop-box key is all it needs, from its one row.
    if (task.kind === 'assistant.apply' && !task.messages.length && !this.#full) {
      const row = await this.#dropboxRow(task.connection ?? null);
      if (row !== undefined) {
        await ensureAssistantPolicy();
        return {
          result: { kind: 'assistant.apply', results: [], ack: null, dropbox: dropboxKey(row) },
          affected: [],
        };
      }
    }
    return (await this.#promote(`task:${task.kind}`)).task(task, operationId);
  };

  /**
   * The assistant's drop-box row (`DROPBOX_ROW`) as the library log reads it: a split household's from its connection,
   * else this library's, by key from the fact store. Undefined when the store cannot say.
   */
  async #dropboxRow(lent: AssistantConnection | null): Promise<SettingsRow | null | undefined> {
    if (lent)
      return (lent.rows.find((row) => row.name === DROPBOX_ROW) as SettingsRow | undefined) ?? null;
    const documents = this.documents;
    if (!documents) return undefined;
    try {
      const generation = this.cached.identity.generation;
      const manifest = await documents.manifest();
      if (!manifest?.complete || manifest.generation !== generation) return undefined;
      const stored = await documents.document(
        generation,
        await rowKey(this.keys, `set:${DROPBOX_ROW}`),
      );
      if (!stored) return null;
      return stored.row?.kind === 'set' ? stored.row : undefined;
    } catch (error) {
      console.warn('den: the assistant drop-box row could not be read from library facts', error);
      return undefined;
    }
  }

  /** Whether this device's last assistant publication still stands (`publicationDueAt`). */
  async #publicationCurrent(): Promise<boolean> {
    const dueAt = publicationDueAt(
      await readEncryptedLibraryValue<AssistantRecords>(
        this.request.libraryKey,
        this.vault,
        ASSISTANT_RECORDS,
      ),
    );
    if (dueAt === null || Date.now() >= dueAt) return false;
    // Said once a page, as the library log says it (`LibraryAssistantAuthority.publish`).
    if (!this.#saidCurrent) console.info('den: assistant projection up to date');
    this.#saidCurrent = true;
    return true;
  }

  #saidCurrent = false;

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
    if (observation.kind === 'title-shape' && this.documents) {
      const counts = new Map<number, number>();
      for (const { season, episodes } of observation.seasons) {
        if (season < 0 || episodes < 0 || counts.has(season))
          return (await this.#promote(`observation:${observation.kind}`)).observe(observation);
        counts.set(season, episodes);
      }
      const digest = libraryMetadataShapeDigest(observation);
      const key = titleKey(observation.title);
      if (this.#titleShapes.get(key)?.digest === digest)
        return { outcome: 'unchanged' as const, affected: [] };
      this.#titleShapes.set(key, {
        shape: { counts, ...(observation.lastAired ? { lastAired: observation.lastAired } : {}) },
        digest,
        observation: structuredClone(observation),
      });
      return {
        outcome: 'applied' as const,
        affected: [{ kind: 'title' as const, title: observation.title }],
      };
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

  /** Whether seeding `household`'s preferences would write nothing (`LibraryLogAuthority`'s `#seedPreferences`). */
  async #seedDecided(
    household: Extract<LibraryCommand, { kind: 'preferences.seed' }>['household'],
  ): Promise<boolean> {
    if (!this.factStore || !this.#preferFacts) return false;
    try {
      const manifest = await this.factStore.manifest();
      if (
        !manifest ||
        (!manifest.complete && !this.#filling) ||
        manifest.generation !== this.cached.identity.generation
      )
        return false;
      const rows = await this.factStore.settings(this.cached.identity.generation, 'settings');
      await ensureSyncPolicy();
      const { values } = syncPolicy<{ values: SettingsRow['values'] }>({
        op: 'profiles_seed_preferences',
        input: { household, profile: rows.find((row) => row.name === 'prefs')?.values ?? {} },
      });
      return !Object.keys(values).length;
    } catch (error) {
      console.warn('den: the preference seed could not be decided from facts', error);
      return false;
    }
  }

  /**
   * Another page of the history is kept: Continue Watching and the Watchlist are read again with it. The
   * recommendations stay as the first page made them until the history is complete (`#filled`), so Home's billboard
   * and shelves change once rather than with every page.
   */
  #refill(): void {
    if (this.#closed || this.#full) return;
    if (this.#refilling) {
      this.#refillAgain = true;
      return;
    }
    const refilling = (async () => {
      do {
        this.#refillAgain = false;
        const loaded = (['watchlist', 'continue'] as const).filter(
          (capability) => this.cached.pieces[capability] !== undefined,
        );
        if (!loaded.length) continue;
        for (const capability of loaded) delete this.cached.pieces[capability];
        this.#factHome = undefined;
        if (!(await this.#loadFactCapabilities([...loaded]))) return;
        if (this.#closed || this.#full) return;
        this.#emit({
          kind: 'changed',
          affected: loaded.map((capability) =>
            capability === 'continue'
              ? { kind: 'continue' as const }
              : { kind: 'overview' as const },
          ),
        });
      } while (this.#refillAgain);
    })().catch((error: unknown) => console.warn('den: library facts could not be refilled', error));
    this.#refilling = refilling;
    void refilling.finally(() => {
      if (this.#refilling === refilling) this.#refilling = undefined;
    });
  }

  /** The import has read the whole history, or stopped: every loaded view is read again, or the log takes over. */
  async #filled(complete: boolean): Promise<void> {
    this.#filling = false;
    if (this.#closed || this.#full) return;
    if (!complete) {
      void this.#promote('import:stopped').catch(() => undefined);
      return;
    }
    await this.#refilling;
    const loaded = (
      ['watchlist', 'continue', 'recommendations', 'settings', 'runtime', 'devices'] as const
    ).filter((capability) => this.cached.pieces[capability] !== undefined);
    for (const capability of loaded) delete this.cached.pieces[capability];
    this.#factHome = undefined;
    this.#cancelReconsider();
    if (loaded.length && !(await this.#loadFactCapabilities([...loaded]))) {
      void this.#promote('import:complete').catch(() => undefined);
      return;
    }
    if (this.#closed || this.#full) return;
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
    // What was written while the history was read sits above the head it was read to.
    this.#schedule(0);
  }

  #schedule(delay: number): void {
    this.#cancelTimer();
    if (
      this.#closed ||
      this.#full ||
      this.#filling ||
      !this.#lifecycle?.visible ||
      !this.#lifecycle.online
    )
      return;
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
      affected: [
        ...loaded.map((capability) =>
          capability === 'continue'
            ? { kind: 'continue' as const }
            : capability === 'settings' || capability === 'runtime' || capability === 'devices'
              ? { kind: capability }
              : { kind: 'overview' as const },
        ),
        ...(changed
          ? [...this.#titlesServed.values()].map((title) => ({ kind: 'title' as const, title }))
          : []),
      ],
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
    // The shape of a series whose page this authority serves (`#titleFromFacts`) is observed, as the full log observes
    // it, so the page counts its episodes. Only those: every title Home names would otherwise reach the log with it.
    if (this.documents) {
      const affected: LibrarySelectionScope[] = [];
      for (const { shape } of found)
        if (shape && this.#titlesServed.has(titleKey(shape.title)))
          affected.push(...(await this.observe({ kind: 'title-shape', ...shape })).affected);
      if (affected.length) this.#emit({ kind: 'changed', affected });
    }

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
      // While the history is still read (`#filling`), its settings are kept already: they were read first, by key.
      if (
        !factManifest ||
        (!factManifest.complete && !this.#filling) ||
        factManifest.generation !== this.cached.identity.generation
      )
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
    // A promotion reads the whole log again: worth seeing in a startup's milestones when it happens.
    startupMark('library promoted', reason);
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
      for (const { observation } of this.#titleShapes.values())
        await authority.observe(observation);
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

const FACT_BATCH = 64;

/**
 * The rows a Settings, runtime or devices view is read from (`librarySelectedSettings.ts`), and the profile directory
 * that says whether the library belongs to a profile household: read by key before anything else, so a first open
 * that draws Home after one page draws it with this library's own settings.
 */
const SETTINGS_ROWS = [
  'set:prefs',
  'set:assistant-grants',
  'set:assistant-read',
  'set:plugins',
  'set:addresses',
  'set:devices',
  'profiles',
];

interface ChangesPage {
  generation: string;
  head: number;
  more: boolean;
  entries: Array<{ k: string; seq: number; v: string }>;
  order?: unknown;
  selected?: unknown;
  /** The library's live rows, which a newer den-edge reports with a newest-first page. */
  rows?: unknown;
}

type FactEntry = Parameters<LibraryFactStore['commitBatch']>[2][number];

/** One import's reads and writes; every request and check both orders of import share. */
class FactImport {
  #registered = false;
  #decrypted = 0;
  readonly #started = performance.now();

  constructor(
    readonly request: LibraryServiceHello,
    readonly keys: LibraryKeys,
    readonly store: LibraryFactStore,
    readonly fetchImpl: typeof fetch,
  ) {}

  /** A changes page whose every entry `accept`s its sequence, or null for any answer that is not one. */
  async page(query: string, generation: string | undefined, accept: (seq: number) => boolean) {
    let body: Partial<Record<keyof ChangesPage, unknown>> | null;
    try {
      const response = await this.fetchImpl(`/lib/${this.keys.id}/changes?${query}`, {
        headers: {
          'x-den-library-token': this.keys.token,
          'x-den-wire': String(this.request.wire),
          'x-den-generation': generation ?? '0',
        },
      });
      if (!response.ok) return null;
      body = await response.json().catch(() => null);
    } catch {
      return null;
    }
    if (
      !body ||
      typeof body.generation !== 'string' ||
      !body.generation.length ||
      !Number.isSafeInteger(body.head) ||
      typeof body.more !== 'boolean' ||
      !Array.isArray(body.entries)
    )
      return null;
    const entries: ChangesPage['entries'] = [];
    for (const candidate of body.entries as unknown[]) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const { k, seq, v } = candidate as { k?: unknown; seq?: unknown; v?: unknown };
      if (
        typeof k !== 'string' ||
        !/^[0-9a-f]{64}$/.test(k) ||
        !Number.isSafeInteger(seq) ||
        !accept(seq as number) ||
        typeof v !== 'string'
      )
        return null;
      entries.push({ k, seq: seq as number, v });
    }
    return { ...(body as ChangesPage), entries };
  }

  /** Registered once a page names the generation: before it, den-edge refuses it for any library that exists. */
  register(generation: string): void {
    if (this.#registered) return;
    this.#registered = true;
    void this.fetchImpl(`/lib/${this.keys.id}/member`, {
      method: 'PUT',
      headers: {
        'x-den-library-token': this.keys.token,
        'x-den-library-member': `${this.keys.id}:${this.keys.member}`,
        'x-den-wire': String(this.request.wire),
        'x-den-generation': generation,
      },
    }).catch(() => undefined);
  }

  /**
   * The page's rows as facts, merged with any kept copy unless `fresh` (nothing of this generation is kept yet), and
   * whether one of them is the profile directory. Null for a row framed by a newer build.
   */
  async facts(
    entries: ChangesPage['entries'],
    generation: string,
    fresh: boolean,
  ): Promise<{ facts: FactEntry[]; profileTopology: boolean } | null> {
    if (entries.length) await ensureSyncPolicy();
    // WebCrypto works off the thread: a page's rows are decrypted at once, as many at a time as the browser runs.
    const opened = await Promise.all(entries.map(({ k, v }) => openEntry(this.keys, k, v)));
    const facts: FactEntry[] = [];
    let profileTopology = false;
    for (const [index, { k, seq, v }] of entries.entries()) {
      const entry = opened[index]!;
      let row: Row | null = null;
      if ('row' in entry) {
        const previous = fresh ? null : await this.store.document(generation, k);
        row = mergeFactRows(previous?.row ?? null, believe(entry.row));
      } else if ('profileDirectory' in entry || 'invalidProfileDirectory' in entry)
        profileTopology = true;
      else if ('newerFraming' in entry) return null;
      facts.push({ k, seq, value: v, row });
      this.#decrypted++;
    }
    return { facts, profileTopology };
  }

  /** `facts` kept in bounded atomic batches, each a resumable checkpoint; `cursor` names each batch's manifest. */
  async commit(
    generation: string,
    facts: readonly FactEntry[],
    complete: boolean,
    cursor: (batch: readonly FactEntry[], last: boolean) => { head: number; floor?: number },
    options: { profileTopology: boolean },
    committed?: (batch: readonly FactEntry[]) => void,
  ): Promise<void> {
    for (let offset = 0; offset === 0 || offset < facts.length; offset += FACT_BATCH) {
      const batch = facts.slice(offset, offset + FACT_BATCH);
      const last = offset + FACT_BATCH >= facts.length;
      const { head, floor } = cursor(batch, last);
      await this.store.commitBatch(generation, head, batch, complete && last, {
        ...options,
        ...(floor !== undefined ? { floor } : {}),
      });
      committed?.(batch);
    }
  }

  finished(): void {
    const elapsed = performance.now() - this.#started;
    noteLibraryDecrypt(this.#decrypted, elapsed);
    noteLibraryFold(this.#decrypted, elapsed);
  }
}

type ImportedFacts = {
  store: LibraryFactStore;
  manifest: Awaited<ReturnType<LibraryFactStore['manifest']>>;
  /**
   * A newest-first import answered after its first page: the rest of the history, read on behind it. Settles true
   * once every row is kept, false if the read stopped; `page` is called after each page it keeps meanwhile.
   */
  filling?: { done: Promise<boolean>; page: { committed: () => void } };
};

/** A first selected open: scan encrypted authority in bounded pages and retain no full-history plaintext graph. */
async function importLibraryFacts(
  request: LibraryServiceHello,
  keys: LibraryKeys,
  vault: Vault,
  fetchImpl: typeof fetch,
  progress?: (progress: number) => void,
): Promise<ImportedFacts | null> {
  const store = await LibraryFactStore.open(request.libraryKey, vault);
  if (!store) return null;
  const manifest = await store.manifest();
  if (manifest?.complete) return { store, manifest };
  // A read of the history begins: said before its first request, so the page shows it is under way at once. It always
  // ends with 1 too, kept, given up (the document log takes over) or failed, so its line never outlives it.
  let reported: number | undefined;
  const report = (value: number) => {
    reported = value;
    progress?.(value);
  };
  const ended = () => reported !== 1 && report(1);
  report(0);
  const reading = new FactImport(request, keys, store, fetchImpl);
  const read = async () => {
    // An oldest-first import under way resumes as one; anything else reads the newest rows first, where den-edge can.
    if (!manifest || manifest.floor !== undefined) {
      const newest = await importNewestFirst(reading, manifest, report);
      if (newest !== 'unsupported') return newest;
    }
    return importOldestFirst(reading, manifest?.floor === undefined ? manifest : null, report);
  };
  try {
    const imported = await read();
    if (imported?.filling) void imported.filling.done.finally(ended);
    else ended();
    return imported;
  } catch (error) {
    ended();
    throw error;
  }
}

/**
 * The newest rows first, and this library's settings by key beside them: Continue Watching and the Watchlist are
 * mostly what changed last, so after one page Home can draw them, with the settings it filters the rest by. The rest
 * of the history follows in `filling`. `'unsupported'`: den-edge did not read as asked (an older one), so nothing was
 * kept and the caller reads oldest first.
 */
async function importNewestFirst(
  reading: FactImport,
  manifest: Awaited<ReturnType<LibraryFactStore['manifest']>>,
  progress?: (progress: number) => void,
): Promise<ImportedFacts | 'unsupported' | null> {
  const { store, keys } = reading;
  let generation = manifest?.generation;
  let floor = manifest?.floor ?? Number.MAX_SAFE_INTEGER;
  // On a resumed import the settings are kept already, read in its first page.
  const settingsKeys = manifest
    ? null
    : await Promise.all(SETTINGS_ROWS.map((name) => rowKey(keys, name)));
  const below = (before: number) =>
    reading.page(`before=${before}&limit=1000`, generation, (seq) => seq > 0 && seq < before);
  const [first, settings] = await Promise.all([
    below(floor),
    settingsKeys && reading.page(`keys=${settingsKeys.join(',')}`, generation, (seq) => seq > 0),
  ]);
  if (!first) return null;
  if (first.order !== 'desc') return 'unsupported';
  if (settingsKeys && !settings) return null;
  if (settings && (settings.selected !== true || settings.generation !== first.generation))
    return null;
  if (generation && first.generation !== generation) {
    // The store started over since the import began: begin again, as a first open of the new generation.
    if (manifest) return importNewestFirst(reading, null, progress);
  }
  generation = first.generation;
  reading.register(generation);
  const fresh = !manifest;
  // Every row at or below `top` is read by this import; anything written since is what later reads catch up with.
  const top = manifest?.head ?? first.head;
  let profileTopology = manifest?.profileTopology ?? false;
  // Progress is rows kept of the library's rows, where den-edge says how many it holds and this import read them all.
  // Otherwise (an older den-edge, or a resumed import whose earlier rows were not counted) it is how far below `top`
  // the reading has come, which runs ahead over the newest rows: older ones are sparse once rows have been replaced.
  const rows = fresh && typeof first.rows === 'number' && first.rows > 0 ? first.rows : null;
  let kept = 0;
  const reached = () =>
    progress?.(Math.min(1, Math.max(0, rows ? kept / rows : 1 - (floor - 1) / Math.max(1, top))));

  /** Keep one page of the history, and lower `floor` to its oldest row. */
  const keep = async (page: ChangesPage, extra: FactEntry[] = []) => {
    const opened = await reading.facts(page.entries, generation!, fresh);
    if (!opened) return false;
    profileTopology ||= opened.profileTopology;
    const facts = [...extra, ...opened.facts];
    const complete = !page.more || page.entries.length === 0;
    await reading.commit(
      generation!,
      facts,
      complete,
      (batch) => {
        // A batch's floor is the oldest history row it keeps; the settings rows ahead of the first are not history.
        const history = batch.filter((fact) => !extra.includes(fact));
        kept += history.length;
        floor = Math.min(floor, ...history.map((fact) => fact.seq));
        return { head: top, floor };
      },
      { profileTopology },
      reached,
    );
    if (complete) {
      floor = 1;
      kept = rows ?? kept;
      reached();
      reading.finished();
    }
    return true;
  };

  let settingsFacts: FactEntry[] = [];
  if (settings) {
    const opened = await reading.facts(settings.entries, generation, fresh);
    if (!opened) return null;
    profileTopology ||= opened.profileTopology;
    settingsFacts = opened.facts;
  }
  // The page below the first, asked for as it arrives: on its way while the first is decrypted and kept, rather than
  // after (a round trip and more on a phone, while the line stood still). Unread if this import stops early.
  const second = first.more && first.entries.length ? below(first.entries.at(-1)!.seq) : null;
  if (!(await keep(first, settingsFacts))) return null;
  const opened = await store.manifest();
  if (!opened || opened.generation !== generation) return null;
  if (opened.complete) return { store, manifest: opened };

  const page = { committed: () => {} };
  const done = (async () => {
    // The page below the one being decrypted and committed, already on its way.
    let next = second ?? below(floor);
    for (;;) {
      const current = await next;
      if (!current || current.order !== 'desc' || current.generation !== generation) return false;
      if (current.more && current.entries.length) next = below(current.entries.at(-1)!.seq);
      if (!(await keep(current))) return false;
      page.committed();
      if (!current.more || !current.entries.length) return true;
    }
  })().catch((error: unknown) => {
    console.warn('den: the rest of the library could not be read', error);
    return false;
  });
  return { store, manifest: opened, filling: { done, page } };
}

/** Every row after the import's `head`, oldest first: the whole history before Home is drawn. */
async function importOldestFirst(
  reading: FactImport,
  resumed: Awaited<ReturnType<LibraryFactStore['manifest']>>,
  progress?: (progress: number) => void,
): Promise<ImportedFacts | null> {
  const { store } = reading;
  let manifest = resumed;
  let generation = manifest?.generation;
  let since = manifest?.head ?? 0;
  // Nothing of this generation is kept yet, so no row has a previous local copy to merge with.
  let fresh = !manifest;
  const after = (from: number) =>
    reading.page(`since=${from}&limit=1000`, generation, (seq) => seq > from);
  // The page after the one being decrypted and committed, already on its way.
  let next: ReturnType<typeof after> | undefined;
  for (;;) {
    const page = await (next ?? after(since));
    next = undefined;
    if (!page) return null;
    if (generation && page.generation !== generation) {
      generation = page.generation;
      since = 0;
      manifest = null;
      fresh = true;
      continue;
    }
    generation = page.generation;
    if (page.more && page.entries.length) next = after(page.entries.at(-1)!.seq);
    reading.register(generation);
    const opened = await reading.facts(page.entries, generation, fresh);
    if (!opened) return null;
    const profileTopology = (manifest?.profileTopology ?? false) || opened.profileTopology;
    const head = page.entries.at(-1)?.seq ?? page.head;
    const complete = !page.more || page.entries.length === 0;
    await reading.commit(
      generation,
      opened.facts,
      complete,
      (batch, last) => ({ head: last ? head : batch.at(-1)!.seq }),
      { profileTopology },
      (batch) => {
        // The last batch of the history says 1, below, once.
        if (batch.length && !(complete && batch.at(-1)!.seq === head))
          progress?.(Math.min(1, batch.at(-1)!.seq / Math.max(1, page.head)));
      },
    );
    if (complete) progress?.(1);
    since = head;
    manifest = await store.manifest();
    if (complete) {
      reading.finished();
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
  progress?: (progress: number) => void,
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
    let filling: ImportedFacts['filling'];
    if (!classic && !factsReady) {
      const imported = await importLibraryFacts(request, keys, vault, fetchImpl, progress);
      factStore = imported?.store ?? factStore;
      factManifest = imported?.manifest ?? null;
      filling = imported?.filling;
      // A newest-first import answers with its first page, the rest of the history read on behind it.
      factsReady = !!factManifest?.complete || !!filling;
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
        filling,
        factsReady && factManifest!.generation === selected.identity.generation ? factStore! : null,
      ),
      membership,
    };
  } finally {
    raw.fill(0);
  }
}
