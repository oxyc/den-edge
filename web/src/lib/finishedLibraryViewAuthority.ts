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
import { storedClockDevice } from './clockStore';
import type { ContentReader } from './contentAuthority';
import type {
  AssistantConnection,
  HistoryCursor,
  HistoryFilter,
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
  type LibraryAuthorityCommandResult,
  type LibraryAuthorityEvent,
  type LibrarySelectionScope,
  type LibraryServiceAuthority,
} from './libraryServiceCore';
import {
  noteFinishedViewCacheHit,
  noteFinishedViewPromotion,
  noteLibraryDecrypt,
  noteLibraryFold,
  noteNarrowEdit,
} from './libraryStartupMetrics';
import type { DeferredDelivery } from './log';
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
import { startupLibraryPromoted, startupMark, type LibraryPromotion } from './startupTiming';
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
  shapeFromLayoutDigest,
} from './libraryMetadata';
import { continueAiring, ContinueProjector, titleKey, type Shape } from './library';
import { seenEpisodesFor } from './history';
import { projectDocument } from './libraryV4';
import type { HomeLibraryView } from './homeLibraryView';
import {
  factContinue,
  factOverview,
  factViewIdentity,
  FinishedLibraryViewWriter,
} from './finishedLibraryViewWriter';
import { episodeRow, episodeRowNames, titleCoordinates, titleRow, titleView } from './titleView';
import {
  believe,
  deriveKeys,
  openEntry,
  rowKey,
  wellFormed,
  type DocumentRow,
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
  /** Whether `#factHome` was selected with every Home capability, so the writer may reuse it whole. */
  #factHomeComplete = false;
  /** The `devices` row Continue's items name their device from, read with `#factHome`. */
  #factDevices?: SettingsRow;
  /** This browser's stamp device, which marks the Continue items it wrote (`here`). */
  #self?: string;
  /** Series shapes the page observed, by title: a title's view needs its episodes, and a promotion is told them. */
  readonly #titleShapes = new Map<
    string,
    {
      shape: Shape;
      digest: string;
      observation: Extract<LibraryObservation, { kind: 'title-shape' }>;
    }
  >();
  /** The followed series' release dates the page last observed: Continue weighs them, and a promotion is told them. */
  #airing?: Extract<LibraryObservation, { kind: 'airing' }>;
  /** Titles whose view was read from the fact store: told of a change another device made. */
  readonly #titlesServed = new Map<string, TitleRef>();
  #preferFacts: boolean;
  /** The import is still reading the history behind a first page (`importNewestFirst`). */
  #filling = false;
  /** The import title selections join, so they do not start a second full-history read alongside it. */
  #fillingDone?: Promise<boolean>;
  #cancelFilling?: () => void;
  #refilling?: Promise<void>;
  #refillAgain = false;
  /** A narrow edit's send, until it has come to an end: the whole log opens only after it (`#promote`). */
  #narrowSending?: Promise<void>;
  #viewWriter?: FinishedLibraryViewWriter;

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
    private readonly openNarrow?: (names: readonly string[]) => Promise<NarrowEdit | null>,
  ) {
    this.#preferFacts = preferFacts;
    this.#keepSavedLayouts();
    if (factStore && !filling) this.#startViewWriter();
    if (filling) {
      this.#filling = true;
      this.#fillingDone = filling.done;
      this.#cancelFilling = filling.cancel;
      filling.page.committed = () => this.#refill();
      void filling.done.then((complete) => this.#filled(complete));
    }
  }

  /**
   * The layouts the saved Continue piece was drawn with, as the layouts its next projection from the facts reads (a
   * refill, another device's write, the airing tick). The page names only the series it shows, so without these every
   * series offered by its next episode beyond those dropped as "no layout" on the first projection after opening.
   * A layout the page names this visit is newer and stays.
   */
  #keepSavedLayouts(): void {
    for (const [key, digest] of Object.entries(this.cached.pieces.continue?.layouts ?? {})) {
      if (this.#factShapes.has(key)) continue;
      const shape = shapeFromLayoutDigest(digest);
      if (shape) this.#factShapes.set(key, shape);
    }
  }

  #startViewWriter(): void {
    if (this.#viewWriter || !this.factStore) return;
    this.#viewWriter = new FinishedLibraryViewWriter(
      this.request.libraryKey,
      this.vault,
      this.factStore,
      () => ({
        generation: this.cached.identity.generation,
        head: this.cached.identity.head,
        authorityRevision: this.cached.identity.authorityRevision,
        rowsVersion: this.cached.identity.rowsVersion,
        ...(this.#factHomeComplete && this.#factHome
          ? { home: this.#factHome, reconsiderAt: this.cached.identity.reconsiderAt }
          : {}),
        shapes: this.#factShapes,
      }),
    );
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
      const titles = pieces.watchlist!.titles;
      const started = await this.#historyStartedSeries(
        titles.filter((title): title is TitleRef & { type: 'tv' } => title.type === 'tv'),
      );
      if (!started) return (await this.#promote('cache:watchlist')).select(selection);
      const hidden = new Set(started.map(titleKey));
      return {
        kind: 'watchlist',
        titles: structuredClone(titles.filter((title) => !hidden.has(titleKey(title)))),
      };
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
    if (selection.kind === 'history') {
      // History needs the complete materialized index. A lazy screen can be acquired from an early Home root while
      // the newest-first import is still filling; join that one read instead of promoting and reading the whole log
      // alongside it, then select from the completed index.
      const filling = this.#fillingDone;
      let page = await this.#historyPage({}, undefined, 48);
      if (!page && filling) {
        const complete = await filling;
        const full = this.#full as LibraryServiceAuthority | undefined;
        if (full) return full.select(selection);
        if (complete) page = await this.#historyPage({}, undefined, 48);
      }
      if (page) return { kind: 'history', ...page };
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
      // A first open answers after its newest page while the rest is still arriving. A title cannot be projected from
      // an incomplete store, but promoting here would read the entire history a second time alongside that import.
      // Join the import, then retry its now-complete documents; a stopped import still falls through to promotion.
      const filling = this.#fillingDone;
      const view = await this.#titleFromFacts(selection.title);
      if (view) return view;
      if (filling) {
        const complete = await filling;
        // `#filled` may have promoted while this request waited.
        const full = this.#full as LibraryServiceAuthority | undefined;
        if (full) return full.select(selection);
        if (complete) {
          const filled = await this.#titleFromFacts(selection.title);
          if (filled) return filled;
        }
      }
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
        // Nothing kept says so on a first open, or on any open after a seed that failed, but the profile's own
        // preferences are in its settings facts: when it has decided every one the household holds, there is nothing
        // to write, and no log to open for it.
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
      const narrow = await this.#narrowCommand(command, operationId);
      if (narrow) return narrow;
    }
    return (await this.#promote(`command:${command.kind}`)).command(command, operationId);
  };

  /**
   * An edit of one title or episode, made on a log of its own documents (`openNarrow`) rather than the whole library.
   * It answers as the whole log would, before its send ends; once den-edge has it, the facts and views take it in
   * through `#reconcile`. Kept on this device or refused instead, the whole log opens, which draws kept work. Null when it cannot be made
   * so, before anything was written, or when it failed: the whole log then makes it, under the same operation id,
   * whose receipt resumes it.
   */
  async #narrowCommand(
    command: LibraryCommand,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult | null> {
    const names = narrowEditNames(command);
    if (!names || !this.openNarrow || !this.factStore || this.#narrowSending) return null;
    const edit = await this.openNarrow(names).catch((error: unknown) => {
      console.warn('den: a narrow edit could not be opened', error);
      return null;
    });
    if (!edit) return null;
    // What the page is told of the send (kept here, refused) comes from the edit's own authority.
    const stopForwarding = edit.authority.listen?.((event) => {
      if (event.kind === 'status') this.#emit(event);
    });
    const finish = async () => {
      stopForwarding?.();
      await edit.authority.close?.();
    };
    let result: LibraryAuthorityCommandResult;
    try {
      result = await edit.authority.command(command, operationId);
    } catch (error) {
      console.warn('den: a narrow edit failed; the whole log makes it', error);
      await finish();
      return null;
    }
    noteNarrowEdit();
    // A hand edit answers `synced` while its send is still under way (`LibraryLogAuthority#editDelivery`), so the end
    // of the send is waited for whatever `delivery` says. With nothing kept, the send has already ended — `settled`,
    // resolved first, wins the race — or there was nothing to send.
    const outcome = edit.sending()
      ? edit.settled
      : Promise.race([edit.settled, Promise.resolve(null)]);
    const sending = outcome.then(async (ended) => {
      await finish();
      return ended;
    });
    this.#narrowSending = sending.then(() => undefined);
    void sending
      .then(async (ended) => {
        this.#narrowSending = undefined;
        if (ended === null) return;
        if (ended !== 'sent') {
          await this.#promote(`edit:${ended}`);
          return;
        }
        // A check already under way may have read den-edge before this write landed: one more follows it.
        await this.#checking?.catch(() => undefined);
        await this.#reconcile();
      })
      .catch((error: unknown) => console.warn('den: a narrow edit could not be taken in', error));
    return result;
  }
  query: LibraryServiceAuthority['query'] = async (query) => {
    if (!this.#full && query.kind === 'history.episodes') {
      const current = await this.#historyPage({}, undefined, 1);
      if (current && current.revision !== query.revision)
        return { kind: 'history.episodes', revision: current.revision, stale: true, items: [] };
      const items = current
        ? await this.#historyEpisodesFromFacts(query.titles, current.revision)
        : null;
      if (items)
        return {
          kind: 'history.episodes',
          revision: current!.revision,
          stale: false,
          items,
        };
      if (current)
        return { kind: 'history.episodes', revision: current.revision, stale: true, items: [] };
    }
    if (!this.#full && query.kind === 'history.page') {
      const current = await this.#historyPage(query.filter, query.cursor, query.limit);
      if (current && current.revision === query.revision)
        return { kind: 'history.page', restarted: false, page: current };
      const restarted = await this.#historyPage(query.filter, undefined, query.limit);
      if (restarted) return { kind: 'history.page', restarted: true, page: restarted };
    }
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

  async #historyPage(filter: HistoryFilter, cursor?: HistoryCursor, limit?: number) {
    if (!this.factStore) return null;
    try {
      const manifest = await this.factStore.manifest();
      if (
        !manifest?.complete ||
        manifest.generation !== this.cached.identity.generation ||
        manifest.head !== this.cached.identity.head ||
        (manifest.rowsVersion ?? manifest.head) !== this.cached.identity.rowsVersion
      )
        return null;
      return (await this.factStore.history(manifest))?.page(filter, cursor, limit) ?? null;
    } catch (error) {
      console.warn('den: the materialized History index could not be opened', error);
      return null;
    }
  }

  async #historyStartedSeries(titles: ReadonlyArray<TitleRef & { type: 'tv' }>) {
    if (!this.factStore) return null;
    try {
      const manifest = await this.factStore.manifest();
      if (
        !manifest?.complete ||
        manifest.generation !== this.cached.identity.generation ||
        manifest.head !== this.cached.identity.head ||
        (manifest.rowsVersion ?? manifest.head) !== this.cached.identity.rowsVersion
      )
        return null;
      const index = await this.factStore.history(manifest);
      if (!index) return null;
      return titles.filter((title) => index.episodeCount(title) > 0);
    } catch (error) {
      console.warn('den: the materialized History membership could not be opened', error);
      return null;
    }
  }

  async #historyEpisodesFromFacts(
    titles: ReadonlyArray<TitleRef & { type: 'tv' }>,
    revision: string,
  ) {
    if (!this.factStore) return null;
    const requested = new Set(titles.map(titleKey));
    const documents: DocumentRow[] = [];
    try {
      const manifest = await this.factStore.manifest();
      if (!manifest?.complete || (await this.factStore.history(manifest))?.revision !== revision)
        return null;
      for (const title of titles) {
        const held = await this.factStore.historyDocumentsFor(manifest, title);
        if (!held) return null;
        for (const stored of held) {
          if (!stored.row || !wellFormed(stored.row) || !('title' in stored.row)) return null;
          if (stored.row.kind === 'title' || stored.row.kind === 'season')
            documents.push(stored.row);
        }
      }
      const after = await this.factStore.manifest();
      if (
        !after ||
        after.generation !== manifest.generation ||
        after.head !== manifest.head ||
        (after.rowsVersion ?? after.head) !== (manifest.rowsVersion ?? manifest.head) ||
        after.revision !== manifest.revision
      )
        return null;
      if (documents.length) await ensureSyncPolicy();
      const seen = seenEpisodesFor(
        documents.flatMap((document) => projectDocument(document)),
        requested,
      );
      return titles.map((title) => ({ title, seen: seen.get(titleKey(title)) ?? [] }));
    } catch (error) {
      console.warn('den: exact History details could not be read from library facts', error);
      return null;
    }
  }
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
      if (observation.visible && observation.online && !observation.playerOpen) this.#schedule(0);
      else this.#cancelTimer();
      return { outcome: 'unchanged' as const, affected: [] };
    }
    if (observation.kind === 'foreground-ready') {
      this.#foregroundReady = true;
      return { outcome: 'unchanged' as const, affected: [] };
    }
    if (observation.kind === 'airing') {
      this.#airing = structuredClone(observation);
      if (!this.#factProjector.setAiring(continueAiring(observation)))
        return { outcome: 'unchanged' as const, affected: [] };
      // Continue decided from the facts is decided again with the dates. One read whole from the kept views is read
      // again from the facts, as a refill reads it.
      if (this.factStore && this.#factHome && this.cached.pieces.continue) {
        this.cached.pieces.continue = {
          ...this.cached.pieces.continue,
          view: factContinue(
            this.#factHome,
            this.#factShapes,
            this.#factProjector,
            this.#factDevices,
            this.#self,
          ),
        };
        return { outcome: 'applied' as const, affected: [{ kind: 'continue' as const }] };
      }
      if (this.factStore && this.#preferFacts && this.cached.pieces.continue) this.#refill();
      return { outcome: 'applied' as const, affected: [] };
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
    this.#cancelFilling?.();
    this.#cancelTimer();
    this.#cancelReconsider();
    await this.#viewWriter?.close();
    this.#stopFull?.();
    this.#listeners.clear();
    await this.#opening?.catch(() => undefined);
    await this.#fillingDone?.catch(() => undefined);
    await this.#full?.close?.();
  }

  #emit(event: LibraryAuthorityEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  /**
   * Whether seeding `household`'s preferences would write nothing (`LibraryLogAuthority`'s `#seedPreferences`). An open
   * drawn from saved views decides it too: its fact store is held only at the views' head or past it. Requiring a facts
   * open made the same no-op seed open the whole log whenever the previous page had saved its views first.
   */
  async #seedDecided(
    household: Extract<LibraryCommand, { kind: 'preferences.seed' }>['household'],
  ): Promise<boolean> {
    if (!this.factStore) return false;
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
    if (this.#closed || this.#full || this.#opening) return;
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
        this.#factHomeComplete = false;
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
    if (this.#closed || this.#full || this.#opening) return;
    if (!complete) {
      void this.#promote('import:stopped').catch(() => undefined);
      return;
    }
    this.#startViewWriter();
    await this.#refilling;
    const loaded = (
      ['watchlist', 'continue', 'recommendations', 'settings', 'runtime', 'devices'] as const
    ).filter((capability) => this.cached.pieces[capability] !== undefined);
    for (const capability of loaded) delete this.cached.pieces[capability];
    this.#factHome = undefined;
    this.#factHomeComplete = false;
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
      !this.#lifecycle.online ||
      // Under this page's own player, as the scheduled authority does.
      this.#lifecycle.playerOpen
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
    if (this.#continueFresh()) return true;
    // Kept past its reconsider time: facts complete at the same head say what Continue is now, without the log.
    if (!this.factStore) return false;
    delete this.cached.pieces.continue;
    return (await this.#loadFactCapabilities(['continue'])) && this.#continueFresh();
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
        // More than a page behind is no small delta: the whole log reads it, and keeps its views at the head it reaches.
        // A move leaves its new Owner library that far behind: the views kept here stand at the head before the moved
        // rows, and a visit that drew them read every moved row again through the facts, alongside the whole log.
        if (!unchanged && page.more === true) await this.#promote('reconcile:behind');
        else if (!unchanged && !(await this.#reconcileFacts(page)))
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

    const manifest = await this.factStore.manifest();
    if (!manifest?.complete || manifest.generation !== this.cached.identity.generation)
      return false;
    Object.assign(
      this.cached.identity,
      factViewIdentity(this.cached.identity.libraryId, manifest, this.cached.identity.reconsiderAt),
    );
    this.#preferFacts = true;
    for (const capability of loaded) delete this.cached.pieces[capability];
    this.#factHome = undefined;
    this.#factHomeComplete = false;
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
    // Every layout answered here is kept, even one that matches the kept views: a later fact projection (another
    // device's write, a refill) reads Continue from these alone, and the page never asks again for a series it has
    // already named. Kept only for a matching layout's next projection, it dropped every series offered by its next
    // episode as soon as any write arrived.
    if (this.factStore)
      for (const { shape } of found) {
        if (!shape) continue;
        this.#factShapes.set(`${shape.title.type}:${shape.title.id}`, {
          counts: new Map(shape.seasons.map(({ season, episodes }) => [season, episodes])),
          ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
        });
      }
    if (layoutChange && this.factStore && this.#factHome) {
      this.cached.pieces.continue = {
        view: factContinue(
          this.#factHome,
          this.#factShapes,
          this.#factProjector,
          this.#factDevices,
          this.#self,
        ),
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
      this.#viewWriter?.schedule(true);
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
        this.#keepSavedLayouts();
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
        this.#factHomeComplete = ['watchlist', 'continue', 'recommendations'].every((capability) =>
          capabilities.includes(capability as (typeof capabilities)[number]),
        );
        this.#factDevices = (
          await this.factStore.settings(this.cached.identity.generation, 'devices')
        ).find((row) => row.name === 'devices');
        this.#self ??= await storedClockDevice(this.vault);
        this.cached.pieces.continue = {
          view: factContinue(
            home,
            this.#factShapes,
            this.#factProjector,
            this.#factDevices,
            this.#self,
          ),
          layouts: Object.fromEntries(
            [...this.#factShapes].map(([key, shape]) => [
              key,
              libraryMetadataShapeDigest({
                seasons: [...shape.counts].map(([season, episodes]) => ({ season, episodes })),
                ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
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
      if (capabilities.includes('continue'))
        this.cached.identity.reconsiderAt = factViewIdentity(
          this.cached.identity.libraryId,
          factManifest,
          reconsiderAt,
        ).reconsiderAt;
      if (capabilities.includes('settings')) {
        const rows = await this.factStore.settings(this.cached.identity.generation, 'settings');
        // Assistant grant/read rows cannot be reduced without the assistant policy. A null view promotes to the
        // document authority, which preserves its live connection flags and background-work contract.
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
      this.#viewWriter?.schedule();
      return true;
    } catch (error) {
      console.warn('den: selected library facts could not be opened', error);
      return false;
    }
  }

  #promote(reason: `${LibraryPromotion}:${string}`): Promise<LibraryServiceAuthority> {
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
    startupLibraryPromoted(reason);
    this.#cancelTimer();
    this.#cancelReconsider();
    this.#cancelFilling?.();
    const writerStopped = this.#viewWriter?.abort() ?? Promise.resolve();
    // A narrow edit still sending owns its kept work until it has come to an end; the whole log takes it from there.
    const opening = Promise.all([
      this.#narrowSending ?? Promise.resolve(),
      writerStopped,
      this.#fillingDone ?? Promise.resolve(),
    ])
      .then(() => this.openFull())
      .then(async (authority) => {
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
        // And every layout Continue was decided with. The page names a series once a visit and never asks again, so a
        // layout the whole log is not told here is one it never learns: each series offered by its next episode left
        // Continue Watching with "no layout" a few seconds after Home opened, when an assistant publish promoted.
        for (const [key, shape] of this.#factShapes) {
          if (this.#titleShapes.has(key)) continue;
          const [type, id] = key.split(':');
          const seen = type === 'tv' && libraryMetadataShape({ type, id: Number(id) }, shape);
          if (seen) await authority.observe({ kind: 'title-shape', ...seen });
        }
        if (this.#airing) await authority.observe(this.#airing);
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
  /** Opened from the views a visit saved, or from the fact store without them. */
  views: 'saved' | 'facts';
}

/** One edit's authority on a log of its own documents, and how its send came to end (`LibraryLog.openNarrow`). */
export interface NarrowEdit {
  authority: LibraryServiceAuthority;
  /** Resolves when a send the edit started comes to an end; never, for an edit that had nothing to send. */
  settled: Promise<DeferredDelivery['outcome']>;
  /** Whether the edit left work kept: a send under way, or one waiting for den-edge. `settled` then resolves. */
  sending: () => boolean;
}

/**
 * The documents an edit of one title or episode reads and writes, by name, as `titleRow` and `episodeRow` read them:
 * null for any other edit, which the whole log makes. A whole series marked watched needs its shape and every episode.
 */
export function narrowEditNames(command: LibraryCommand): string[] | null {
  const title = (ref: TitleRef) => [`title:${ref.type}:${ref.id}`, `rec:${ref.type}:${ref.id}`];
  switch (command.kind) {
    case 'watchlist.add':
    case 'library.remove':
    case 'reaction.set':
      return title(command.title);
    case 'watched.set':
      return command.title.type === 'movie' ? title(command.title) : null;
    case 'episode-watched.set': {
      const { season, episode } = command.episode;
      return [...title(command.episode), ...episodeRowNames(command.episode, season, episode)];
    }
    default:
      return null;
  }
}

const FACT_BATCH = 64;
/**
 * Rows a new device opens before Home may draw. Keep this small: every row is decrypted, projected and committed as
 * one authority value plus its selected encrypted facts on the device's critical path. The rest of the history uses
 * full pages below, where network round trips matter more than first paint.
 */
const NEWEST_BOOTSTRAP_PAGE = 128;
const NEWEST_BACKGROUND_PAGE = 1_000;

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
  readonly #abort = new AbortController();

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
        signal: this.#abort.signal,
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

  cancel(): void {
    this.#abort.abort();
  }
}

type ImportedFacts = {
  store: LibraryFactStore;
  manifest: Awaited<ReturnType<LibraryFactStore['manifest']>>;
  /**
   * A newest-first import answered after its first page: the rest of the history, read on behind it. Settles true
   * once every row is kept, false if the read stopped; `page` is called after each page it keeps meanwhile.
   */
  filling?: { done: Promise<boolean>; page: { committed: () => void }; cancel: () => void };
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
    if (imported?.filling)
      void imported.filling.done
        .then((complete) => {
          if (!complete) imported.store.discardIncompleteHistoryDerivation();
        })
        .finally(ended);
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
  const below = (before: number, limit: number) =>
    reading.page(`before=${before}&limit=${limit}`, generation, (seq) => seq > 0 && seq < before);
  if (manifest?.floor !== undefined) {
    // Every committed newest-first batch is a durable, self-contained Home snapshot. A process killed after that
    // checkpoint used to make the next launch wait for another network page before it could show the facts it
    // already had. Resume the remaining history behind the authority instead: generation/order validation still
    // happens before another page is committed, and a changed/stopped source promotes to the full log as before.
    reading.register(generation!);
    let profileTopology = manifest.profileTopology;
    const top = manifest.head;
    const openedManifest = manifest;
    const page = { committed: () => {} };
    const reached = () => progress?.(Math.min(1, Math.max(0, 1 - (floor - 1) / Math.max(1, top))));
    const keep = async (current: ChangesPage) => {
      const opened = await reading.facts(current.entries, generation!, false);
      if (!opened) return false;
      profileTopology ||= opened.profileTopology;
      const complete = !current.more || current.entries.length === 0;
      await reading.commit(
        generation!,
        opened.facts,
        complete,
        (batch) => {
          floor = Math.min(floor, ...batch.map((fact) => fact.seq));
          return { head: top, floor };
        },
        { profileTopology },
        reached,
      );
      if (complete) {
        floor = 1;
        reached();
        reading.finished();
      }
      return true;
    };
    const done = (async () => {
      let next = below(floor, NEWEST_BACKGROUND_PAGE);
      for (;;) {
        const current = await next;
        if (!current || current.order !== 'desc' || current.generation !== generation) return false;
        if (current.more && current.entries.length)
          next = below(current.entries.at(-1)!.seq, NEWEST_BACKGROUND_PAGE);
        if (!(await keep(current))) return false;
        page.committed();
        if (!current.more || !current.entries.length) return true;
      }
    })().catch((error: unknown) => {
      console.warn('den: the rest of the library could not be read', error);
      return false;
    });
    return {
      store,
      manifest: openedManifest,
      filling: { done, page, cancel: () => reading.cancel() },
    };
  }
  const [first, settings] = await Promise.all([
    below(floor, NEWEST_BOOTSTRAP_PAGE),
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
  const second =
    first.more && first.entries.length
      ? below(first.entries.at(-1)!.seq, NEWEST_BACKGROUND_PAGE)
      : null;
  if (!(await keep(first, settingsFacts))) return null;
  const opened = await store.manifest();
  if (!opened || opened.generation !== generation) return null;
  if (opened.complete) return { store, manifest: opened };

  const page = { committed: () => {} };
  const done = (async () => {
    // The page below the one being decrypted and committed, already on its way.
    let next = second ?? below(floor, NEWEST_BACKGROUND_PAGE);
    for (;;) {
      const current = await next;
      if (!current || current.order !== 'desc' || current.generation !== generation) return false;
      if (current.more && current.entries.length)
        next = below(current.entries.at(-1)!.seq, NEWEST_BACKGROUND_PAGE);
      if (!(await keep(current))) return false;
      page.committed();
      if (!current.more || !current.entries.length) return true;
    }
  })().catch((error: unknown) => {
    console.warn('den: the rest of the library could not be read', error);
    return false;
  });
  return { store, manifest: opened, filling: { done, page, cancel: () => reading.cancel() } };
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
  openNarrow?: (names: readonly string[]) => Promise<NarrowEdit | null>,
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
    const durableFacts = !!vault.commit && !!vault.page;
    const markerMatchesCache =
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
    if ((!markerMatchesCache || (durableFacts && !factManifest)) && !factsReady) {
      const imported = await importLibraryFacts(request, keys, vault, fetchImpl, progress);
      factStore = imported?.store ?? factStore;
      factManifest = imported?.manifest ?? null;
      filling = imported?.filling;
      // A newest-first import answers with its first page, the rest of the history read on behind it.
      factsReady = !!factManifest?.complete || !!filling;
    }
    // A completed fact store may be ahead of the views when the previous page was stopped after committing a
    // remote delta but before its background writer published the corresponding projections. The views and their
    // marker are still one authenticated snapshot: draw them immediately, then let `#reconcileFacts` apply the
    // small server delta and replace only the loaded pieces. Requiring the fact manifest's exact revision here made
    // that harmless interruption turn every next launch into a facts projection of the whole Home surface.
    const factsCoverCache =
      !durableFacts ||
      (!!factManifest &&
        factManifest.complete &&
        !!cached &&
        factManifest.generation === cached.identity.generation &&
        factManifest.head >= cached.identity.head &&
        (factManifest.rowsVersion ?? factManifest.head) >= cached.identity.rowsVersion);
    const classic = markerMatchesCache && factsCoverCache;
    if (!classic && !factsReady) return null;
    const selected: FinishedLibraryViews = classic
      ? cached!
      : {
          schema: FINISHED_LIBRARY_VIEWS_SCHEMA,
          identity: factViewIdentity(keys.id, factManifest!, null),
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
          factManifest!.head >= selected.identity.head &&
          (factManifest!.rowsVersion ?? factManifest!.head) >= selected.identity.rowsVersion
          ? factStore!
          : null,
        !classic,
        filling,
        factsReady && factManifest!.generation === selected.identity.generation ? factStore! : null,
        openNarrow,
      ),
      membership,
      views: classic ? 'saved' : 'facts',
    };
  } finally {
    raw.fill(0);
  }
}
