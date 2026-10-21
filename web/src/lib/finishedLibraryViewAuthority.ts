import {
  FINISHED_LIBRARY_POLICY,
  FINISHED_LIBRARY_RECOMMENDATIONS,
  readEncryptedLibraryValue,
  readFinishedLibraryViews,
  writeEncryptedLibraryValue,
  type FinishedLibraryViews,
} from './finishedLibraryViews';
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
import { deriveKeys } from './wire';
import { noteFinishedViewCache, noteFinishedViewPromotion } from './libraryStartupMetrics';
import { isRetainedServices } from './libraryServiceProtocolCodec';
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

const VISIBLE_REFRESH_MS = 30_000;
const PLAYBACK_REFRESH_MS = 5_000;

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
  #lifecycle?: Extract<LibraryObservation, { kind: 'lifecycle' }>;
  #foregroundReady = false;

  constructor(
    private readonly request: LibraryServiceHello,
    private readonly cached: FinishedLibraryViews,
    private readonly token: string,
    private readonly member: string,
    private readonly vault: Vault,
    private readonly content: Pick<ContentReader, 'title'>,
    private readonly openFull: () => Promise<LibraryServiceAuthority | null>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  get generation(): string | null {
    return this.#full?.generation ?? this.cached.identity.generation;
  }

  async select(selection: LibrarySelection): Promise<LibrarySelectionValue> {
    if (this.#full) return this.#full.select(selection);
    const pieces = this.cached.pieces;
    if (selection.kind === 'overview') {
      const recommendations = pieces.recommendations!;
      return {
        kind: 'overview',
        ...structuredClone(recommendations),
        watchlist: structuredClone(pieces.watchlist!.titles),
      };
    }
    if (selection.kind === 'continue') return structuredClone(pieces.continue!.view);
    if (selection.kind === 'settings') return structuredClone(pieces.settings!);
    if (selection.kind === 'runtime') return structuredClone(pieces.runtime!);
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
        capability: { libraryId: this.cached.identity.libraryId, memberToken: this.member },
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

  #reconcile(): Promise<void> {
    if (this.#checking) return this.#checking;
    const checking = (async () => {
      try {
        const identity = this.cached.identity;
        const response = await this.fetchImpl(
          `/lib/${identity.libraryId}/changes?since=${identity.head}&limit=1`,
          {
            headers: {
              'x-den-library-token': this.token,
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
        };
        const unchanged =
          page.generation === identity.generation &&
          page.head === identity.head &&
          Array.isArray(page.entries) &&
          page.entries.length === 0;
        if (!unchanged) await this.#promote('reconcile:changed');
      } catch {
        if (!this.#closed) this.#emit({ kind: 'status', status: { kind: 'reconnecting' } });
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

  async #metadata(
    titles: Extract<
      Parameters<LibraryServiceAuthority['query']>[0],
      { kind: 'library.metadata' }
    >['titles'],
  ): Promise<Extract<LibraryQueryResult, { kind: 'library.metadata' }>> {
    const found: Array<{
      title: NonNullable<ReturnType<typeof libraryMetadataTitle>>;
      shape?: NonNullable<ReturnType<typeof libraryMetadataShape>>;
    }> = [];
    const retryable: typeof titles = [];
    let retryAfterMs = 0;
    let next = 0;
    const lookup = async () => {
      for (let ref = titles[next++]; ref; ref = titles[next++]) {
        const result = await this.content.title(ref);
        if (result.kind === 'unavailable' || result.kind === 'not-configured') {
          retryable.push(ref);
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
    if (layoutChange) void this.#promote(`layout:${layoutChange}`).catch(() => undefined);
    return {
      kind: 'library.metadata',
      titles: found.map(({ title }) => title),
      shapes: found.flatMap(({ shape }) => (shape ? [shape] : [])),
      retryable,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  }

  #promote(reason: string): Promise<LibraryServiceAuthority> {
    if (this.#full) return Promise.resolve(this.#full);
    if (this.#opening) return this.#opening;
    noteFinishedViewPromotion(reason);
    this.#cancelTimer();
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
    const cached = await readFinishedLibraryViews(request.libraryKey, vault, [
      'watchlist',
      'continue',
      'recommendations',
      'settings',
      'runtime',
    ]);
    if (
      !cached ||
      cached.identity.policyVersion !== FINISHED_LIBRARY_POLICY ||
      cached.identity.recommendationVersion !== FINISHED_LIBRARY_RECOMMENDATIONS ||
      (cached.identity.reconsiderAt !== null && cached.identity.reconsiderAt <= Date.now())
    )
      return null;
    noteFinishedViewCache('read', 0, true);
    const membership = { libraryId: keys.id, memberToken: keys.member };
    return {
      authority: new FinishedLibraryViewAuthority(
        request,
        cached,
        keys.token,
        keys.member,
        vault,
        content,
        openFull,
        fetchImpl,
      ),
      membership,
    };
  } finally {
    raw.fill(0);
  }
}
