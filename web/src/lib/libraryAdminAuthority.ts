import {
  blankEpisode,
  blankTitle,
  dismissFromContinueWatching,
  markEpisode,
  markWatched,
} from './actions';
import type { ClockStore } from './clockStore';
import { buildHistoryExport } from './historyExport';
import type { LibraryQueryResult, KeyResetOutcome, LibraryTask } from './libraryServiceProtocol';
import type { LibraryAuthorityTaskResult } from './libraryServiceCore';
import { LibraryLog, projectV3Documents, successorTag } from './log';
import type { Vault } from './localVault';
import { linkKeys, sealHandover } from './pair';
import { completeDurableTaskOperation } from './libraryOperationAuthority';
import {
  abandon,
  begin,
  confirm,
  makingWaits,
  reconcile,
  resumeMaking,
  seal,
  turnOff,
  type Prepared,
  type RecoveryContext,
} from './recovery';
import { fromBase64url, toBase64url } from './wire';
import type { Row, Stamp } from './wire';

const RESET_ROUNDS = 3;
const IMPORT_BATCH = 250;
const STALE_IMPORT_MS = 182 * 86_400_000;
const RECOVERY_MAKES = 'library-service-recovery-makes.v1';
const LOCAL_MERGES = 'library-service-local-merges.v1';
const HISTORY_IMPORTS = 'library-service-history-imports.v1';

interface DurableRecoveryMake {
  prepared: Prepared;
  baseLive: string[];
  operationId?: string;
  outcome?: 'confirmed' | 'lost' | 'failed';
}

const affectedLibrary = [
  { kind: 'overview' as const },
  { kind: 'continue' as const },
  { kind: 'history' as const },
  { kind: 'recovery' as const },
  { kind: 'connections' as const },
];

const standardKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const keyBytes = (key: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(key), (character) => character.charCodeAt(0));

export interface LibraryAdminAuthorityOptions {
  mode: 'online' | 'local';
  libraryKey: string;
  vault: Vault;
  fetchImpl?: typeof fetch;
  destination?: (key: string) => Promise<LibraryLog>;
}

/**
 * Stateful administrative domains for one library authority. Raw rows, log movement, the library key and recovery
 * locators remain here; callers exchange only bounded semantic tasks and presentation-safe results.
 */
export class LibraryAdminAuthority {
  readonly #recoveryMakes = new Map<
    string,
    {
      prepared: Prepared;
      baseLive: Set<string>;
      done: () => void;
      operationId?: string;
      outcome?: 'confirmed' | 'lost' | 'failed';
    }
  >();
  readonly #recoveryStorage = new MemoryStorage();

  constructor(
    private readonly log: LibraryLog,
    private readonly clock: ClockStore,
    private readonly options: LibraryAdminAuthorityOptions,
  ) {}

  close(): void {
    for (const make of this.#recoveryMakes.values()) make.done();
    this.#recoveryMakes.clear();
  }

  prepareReset(): Extract<LibraryQueryResult, { kind: 'key-reset.prepare' }> {
    return {
      kind: 'key-reset.prepare',
      destinationLibraryKey: standardKey(),
      device: this.clock.device,
    };
  }

  async sealRecovery(
    locator: string,
    wrapKey: string,
    createdAt: number,
  ): Promise<Extract<LibraryQueryResult, { kind: 'recovery.seal' }>> {
    const wrapping = fromBase64url(wrapKey);
    const library = keyBytes(this.options.libraryKey);
    try {
      return {
        kind: 'recovery.seal',
        sealed: await seal({ locator, wrapKey: wrapping }, library, createdAt),
      };
    } finally {
      wrapping.fill(0);
      library.fill(0);
    }
  }

  async pairingHandover(
    handoverKey: string,
    host: string,
    suppliedLinkKey?: string,
  ): Promise<Extract<LibraryQueryResult, { kind: 'pairing.handover' }>> {
    const transport = fromBase64url(handoverKey);
    const linkKey = suppliedLinkKey
      ? fromBase64url(suppliedLinkKey)
      : crypto.getRandomValues(new Uint8Array(32));
    const libraryKey = keyBytes(this.options.libraryKey);
    try {
      const sealed = await sealHandover(transport, {
        host,
        hostDeviceId: this.clock.device,
        linkKey,
        libraryKey,
      });
      return {
        kind: 'pairing.handover',
        sealed: toBase64url(sealed),
        linkKey: toBase64url(linkKey),
        inboxKey: (await linkKeys(linkKey)).inbox,
      };
    } finally {
      transport.fill(0);
      libraryKey.fill(0);
    }
  }

  historyExport(): Extract<LibraryQueryResult, { kind: 'history.export' }> {
    const heldDocuments = this.log
      .documents()
      .map(({ document }) => document)
      .filter((document) => document.kind !== 'delivery');
    const documents = heldDocuments.length
      ? heldDocuments
      : projectV3Documents(
          this.log
            .rows()
            .filter(
              (row) =>
                row.kind === 'rec' || row.kind === 'ep' || row.kind === 'wat' || row.kind === 'snt',
            ),
        ).filter((document) => document.kind !== 'delivery');
    const exported = buildHistoryExport(documents, new Map());
    return {
      kind: 'history.export',
      exportedAt: exported.exportedAt,
      titles: exported.titles.map(
        ({ type, tmdbId, status, reaction, addedAt, plays, episodes }) => ({
          type,
          tmdbId,
          status,
          reaction,
          addedAt,
          ...(plays ? { plays } : {}),
          ...(episodes ? { episodes } : {}),
        }),
      ),
    };
  }

  async recoveryView() {
    await this.#restoreRecoveryMakes();
    const status = await reconcile(this.#recoveryContext());
    return {
      kind: 'recovery' as const,
      availability: makingWaits(this.log) ? ('waits' as const) : ('ready' as const),
      live: status?.live
        ? {
            createdAt: status.live.createdAt,
            by: status.live.by,
            byName: status.live.byName,
            opens: status.live.opens,
            lastOpenedAt: status.live.lastOpenedAt,
            reposted: status.live.reposted,
          }
        : null,
      broken: status?.broken ?? false,
      notices: status?.notices ?? [],
    };
  }

  async task(task: LibraryTask, operationId?: string): Promise<LibraryAuthorityTaskResult> {
    switch (task.kind) {
      case 'recovery.begin':
        return this.#beginRecovery(task, operationId);
      case 'recovery.confirm':
        return this.#confirmRecovery(task.locator, operationId);
      case 'recovery.abandon':
        return this.#abandonRecovery(task.locator);
      case 'recovery.disable':
        return this.#disableRecovery();
      case 'history.import':
        return this.#importHistory(task.items, operationId);
      case 'local-library.merge':
        return this.#mergeLocal(task.sourceLibraryKey, operationId);
      case 'key-reset.move':
        return this.#moveKey(task, operationId);
      case 'key-reset.settle':
        return this.#settleKey(task, operationId);
      case 'key-reset.adopt':
        return this.#adoptKey(task, operationId);
    }
  }

  #recoveryContext(): RecoveryContext {
    return {
      log: this.log,
      libraryId: this.log.libraryId,
      member: this.log.memberProof,
      device: this.clock.device,
      issue: async () => {
        await this.clock.see(this.log.newestStamp());
        return this.clock.issue();
      },
      fetchImpl: this.options.fetchImpl,
      storage: this.#recoveryStorage,
    };
  }

  async #beginRecovery(
    task: Extract<LibraryTask, { kind: 'recovery.begin' }>,
    operationId?: string,
  ): Promise<LibraryAuthorityTaskResult> {
    const previous = await this.#recoveryMake(task.locator);
    if (previous && previous.operationId === operationId && !previous.outcome)
      return {
        result: { kind: 'recovery.begin', outcome: 'begun' },
        affected: [{ kind: 'recovery' }],
      };
    previous?.done();
    this.#recoveryMakes.delete(task.locator);
    await this.#keepRecoveryMakes();
    const prepared: Prepared = {
      code: '',
      lastGroup: '',
      locator: task.locator,
      sealed: task.sealed,
      createdAt: task.createdAt,
    };
    const begun = await begin(this.#recoveryContext(), prepared);
    if (!begun.ok)
      return {
        result: { kind: 'recovery.begin', outcome: begun.error },
        affected: [{ kind: 'recovery' }],
      };
    this.#recoveryMakes.set(task.locator, {
      prepared,
      baseLive: begun.baseLive,
      done: begun.done,
      ...(operationId ? { operationId } : {}),
    });
    try {
      await this.#keepRecoveryMakes();
    } catch {
      begun.done();
      this.#recoveryMakes.delete(task.locator);
      await abandon(this.#recoveryContext(), task.locator);
      return {
        result: { kind: 'recovery.begin', outcome: 'failed' },
        affected: [{ kind: 'recovery' }],
      };
    }
    return {
      result: { kind: 'recovery.begin', outcome: 'begun' },
      affected: [{ kind: 'recovery' }],
    };
  }

  async #confirmRecovery(
    locator: string,
    operationId?: string,
  ): Promise<LibraryAuthorityTaskResult> {
    const making = await this.#recoveryMake(locator);
    if (!making)
      return {
        result: { kind: 'recovery.confirm', outcome: 'lost' },
        affected: [{ kind: 'recovery' }],
      };
    if (making.operationId === operationId && making.outcome)
      return {
        result: { kind: 'recovery.confirm', outcome: making.outcome },
        affected: [{ kind: 'recovery' }],
      };
    const result = await confirm(this.#recoveryContext(), making.prepared, making.baseLive);
    const outcome = result.ok ? 'confirmed' : 'lost' in result ? 'lost' : 'failed';
    if (result.ok || 'lost' in result) {
      making.done();
      making.done = () => {};
      making.operationId = operationId;
      making.outcome = outcome;
      await this.#keepRecoveryMakes();
    }
    return {
      result: {
        kind: 'recovery.confirm',
        outcome,
      },
      affected: [{ kind: 'recovery' }],
    };
  }

  async #abandonRecovery(locator: string): Promise<LibraryAuthorityTaskResult> {
    const making = await this.#recoveryMake(locator);
    making?.done();
    this.#recoveryMakes.delete(locator);
    await this.#keepRecoveryMakes();
    await abandon(this.#recoveryContext(), locator);
    return {
      result: { kind: 'recovery.abandon', outcome: 'abandoned' },
      affected: [{ kind: 'recovery' }],
    };
  }

  async #recoveryMake(locator: string) {
    const active = this.#recoveryMakes.get(locator);
    if (active) return active;
    await this.#restoreRecoveryMakes();
    return this.#recoveryMakes.get(locator);
  }

  async #restoreRecoveryMakes(): Promise<void> {
    const kept = await this.log.kept<unknown>(RECOVERY_MAKES);
    if (!Array.isArray(kept)) return;
    for (const value of kept) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as Partial<DurableRecoveryMake>;
      const prepared = candidate.prepared;
      if (
        !prepared ||
        typeof prepared.locator !== 'string' ||
        typeof prepared.sealed !== 'string' ||
        !Number.isSafeInteger(prepared.createdAt) ||
        !Array.isArray(candidate.baseLive) ||
        !candidate.baseLive.every((entry) => typeof entry === 'string')
      )
        continue;
      if (this.#recoveryMakes.has(prepared.locator)) continue;
      this.#recoveryMakes.set(prepared.locator, {
        prepared,
        baseLive: new Set(candidate.baseLive),
        done: candidate.outcome
          ? () => {}
          : resumeMaking(this.#recoveryContext(), prepared.locator),
        ...(typeof candidate.operationId === 'string'
          ? { operationId: candidate.operationId }
          : {}),
        ...(candidate.outcome === 'confirmed' ||
        candidate.outcome === 'lost' ||
        candidate.outcome === 'failed'
          ? { outcome: candidate.outcome }
          : {}),
      });
    }
  }

  async #keepRecoveryMakes(): Promise<void> {
    await this.log.keep(
      RECOVERY_MAKES,
      [...this.#recoveryMakes.values()].map(
        ({ prepared, baseLive, operationId, outcome }): DurableRecoveryMake => ({
          prepared,
          baseLive: [...baseLive],
          ...(operationId ? { operationId } : {}),
          ...(outcome ? { outcome } : {}),
        }),
      ),
    );
  }

  async #disableRecovery(): Promise<LibraryAuthorityTaskResult> {
    if (!(await turnOff(this.#recoveryContext())))
      throw new Error('recovery code was not disabled');
    return {
      result: { kind: 'recovery.disable', outcome: 'disabled' },
      affected: [{ kind: 'recovery' }],
    };
  }

  async #importHistory(
    items: Extract<LibraryTask, { kind: 'history.import' }>['items'],
    operationId?: string,
  ): Promise<LibraryAuthorityTaskResult> {
    const pending: Array<{ at: number; build: (stamp: Stamp) => Row }> = [];
    await this.clock.see(this.log.newestStamp());
    for (const item of items) {
      if (item.title.type === 'movie' && item.watchedAt !== undefined) {
        const before = this.log.title(item.title) ?? blankTitle(item.title, item.watchedAt);
        if (before.status.at[0] < item.watchedAt)
          pending.push({
            at: item.watchedAt,
            build: (stamp) => markWatched(before, stamp),
          });
        continue;
      }
      if (item.title.type !== 'tv' || !item.episodes?.length) continue;
      let latest = 0;
      for (const episode of item.episodes) {
        latest = Math.max(latest, episode.watchedAt);
        const before =
          this.log.episode(item.title, episode.season, episode.episode) ??
          blankEpisode(item.title, episode.season, episode.episode);
        if (before.progress.at[0] < episode.watchedAt)
          pending.push({
            at: episode.watchedAt,
            build: (stamp) => markEpisode(before, true, stamp),
          });
      }
      const title = this.log.title(item.title) ?? blankTitle(item.title, latest);
      if (item.complete && title.status.at[0] < latest)
        pending.push({ at: latest, build: (stamp) => markWatched(title, stamp) });
      else if (latest && Date.now() - latest > STALE_IMPORT_MS && title.dismissed.at[0] <= latest)
        pending.push({
          at: latest + 1,
          build: (stamp) => dismissFromContinueWatching(title, stamp),
        });
    }
    let total = pending.length;
    if (operationId) {
      const stored = await this.log.kept<unknown>(HISTORY_IMPORTS);
      const imports = Array.isArray(stored)
        ? stored.filter(
            (entry): entry is { operationId: string; total: number } =>
              !!entry &&
              typeof entry === 'object' &&
              !Array.isArray(entry) &&
              typeof (entry as { operationId?: unknown }).operationId === 'string' &&
              Number.isSafeInteger((entry as { total?: unknown }).total) &&
              ((entry as { total: number }).total ?? -1) >= 0,
          )
        : [];
      const existing = imports.find((entry) => entry.operationId === operationId);
      if (existing) total = existing.total;
      else {
        imports.push({ operationId, total });
        await this.log.keep(HISTORY_IMPORTS, imports.slice(-64));
      }
    }
    const stamps = await this.clock.historical(pending.map(({ at }) => at));
    const rows = pending.map(({ build }, index) => build(stamps[index]!));
    let written = 0;
    for (let start = 0; start < rows.length; start += IMPORT_BATCH) {
      const batch = rows.slice(start, start + IMPORT_BATCH);
      if (!(await this.log.writeRows(batch)))
        return {
          result: {
            kind: 'history.import',
            written: Math.max(0, total - rows.length) + written,
            total,
            complete: false,
          },
          affected: affectedLibrary,
        };
      written += batch.length;
    }
    return {
      result: { kind: 'history.import', written: total, total, complete: true },
      affected: affectedLibrary,
    };
  }

  async #mergeLocal(
    sourceLibraryKey: string,
    operationId?: string,
  ): Promise<LibraryAuthorityTaskResult> {
    if (sourceLibraryKey === this.options.libraryKey)
      return {
        result: { kind: 'local-library.merge', outcome: 'unavailable' },
        affected: [],
      };
    const merges = operationId ? await this.log.kept<unknown>(LOCAL_MERGES) : undefined;
    const staged = Array.isArray(merges)
      ? merges.filter(
          (entry): entry is { operationId: string; sourceLibraryKey: string } =>
            !!entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            typeof (entry as { operationId?: unknown }).operationId === 'string' &&
            typeof (entry as { sourceLibraryKey?: unknown }).sourceLibraryKey === 'string',
        )
      : [];
    const wasWritten = operationId
      ? staged.some(
          (entry) =>
            entry.operationId === operationId && entry.sourceLibraryKey === sourceLibraryKey,
        )
      : false;
    const source = await LibraryLog.openExistingLocal(sourceLibraryKey, this.options.vault);
    if (!source)
      return {
        result: {
          kind: 'local-library.merge',
          outcome: wasWritten ? 'merged' : 'absent',
        },
        affected: [],
      };
    try {
      if (!wasWritten) {
        const rows = source
          .rows()
          .filter((row) => !(row.kind === 'set' && row.name === 'recovery'));
        if (!(await this.log.writeRows(rows)))
          return {
            result: { kind: 'local-library.merge', outcome: 'unavailable' },
            affected: affectedLibrary,
          };
        if (operationId) {
          staged.push({ operationId, sourceLibraryKey });
          await this.log.keep(LOCAL_MERGES, staged.slice(-64));
        }
      }
      if (!(await source.forget()))
        return {
          result: { kind: 'local-library.merge', outcome: 'unavailable' },
          affected: affectedLibrary,
        };
      return {
        result: { kind: 'local-library.merge', outcome: 'merged' },
        affected: affectedLibrary,
      };
    } finally {
      source.close();
    }
  }

  async #moveKey(
    task: Extract<LibraryTask, { kind: 'key-reset.move' }>,
    operationId?: string,
  ): Promise<LibraryAuthorityTaskResult> {
    const destinationKey = task.destinationLibraryKey;
    if (this.options.mode !== 'online') return this.#resetResult('key-reset.move', 'unavailable');
    const next = await this.#destination(destinationKey);
    for (let round = 0; round < RESET_ROUNDS; round++) {
      const moving = await this.log.moving(this.clock.device);
      if ('refused' in moving)
        return this.#abandonReset(
          next,
          'key-reset.move',
          moving.refused === 'update_required' ? 'update-required' : 'unavailable',
        );
      if (!(await next.takeMoved(moving, this.log.memberProof)))
        return this.#abandonReset(next, 'key-reset.move', 'unavailable');
      switch (await this.log.endMoved(moving, next)) {
        case 'deleted':
          await this.log.rekeyKept(next);
          return this.#completedReset(next, task, operationId, 'moved');
        case 'changed':
          continue;
        case 'failed':
          return this.#abandonReset(next, 'key-reset.move', 'unavailable');
        case 'lost':
          return this.#abandonReset(next, 'key-reset.move', 'foreign');
        case 'lost_unnamed':
          return this.#resetResult('key-reset.move', 'held');
        case 'unknown':
          return this.#resetResult('key-reset.move', 'unknown');
      }
    }
    return this.#abandonReset(next, 'key-reset.move', 'unavailable');
  }

  async #settleKey(
    task: Extract<LibraryTask, { kind: 'key-reset.settle' }>,
    operationId?: string,
  ): Promise<LibraryAuthorityTaskResult> {
    const destinationKey = task.destinationLibraryKey;
    const next = await this.#destination(destinationKey);
    const standing = await this.log.standing();
    if (standing === null) return this.#resetResult('key-reset.settle', 'unknown');
    if ('moved' in standing) {
      if (standing.successor === (await successorTag(next.libraryId))) {
        await this.log.rekeyKept(next);
        return this.#completedReset(next, task, operationId, 'adopted');
      }
      if (standing.successor === undefined) return this.#resetResult('key-reset.settle', 'held');
      return this.#abandonReset(next, 'key-reset.settle', 'foreign');
    }
    await this.log.refresh();
    if (!(await this.log.fence(this.clock.device)))
      return this.#resetResult('key-reset.settle', 'unknown');
    return this.#abandonReset(next, 'key-reset.settle', 'undone');
  }

  async #adoptKey(
    task: Extract<LibraryTask, { kind: 'key-reset.adopt' }>,
    operationId?: string,
  ): Promise<LibraryAuthorityTaskResult> {
    const destinationKey = task.destinationLibraryKey;
    const next = await this.#destination(destinationKey);
    const standing = await this.log.standing();
    if (!standing || !('moved' in standing))
      return this.#resetResult('key-reset.adopt', standing ? 'unavailable' : 'unknown');
    if (standing.successor !== undefined) return this.#resetResult('key-reset.adopt', 'foreign');
    await this.log.rekeyKept(next);
    return this.#completedReset(next, task, operationId, 'adopted');
  }

  async #completedReset(
    destination: LibraryLog,
    task: Extract<LibraryTask, { kind: 'key-reset.move' | 'key-reset.settle' | 'key-reset.adopt' }>,
    operationId: string | undefined,
    outcome: Extract<KeyResetOutcome, 'moved' | 'adopted'>,
  ): Promise<LibraryAuthorityTaskResult> {
    const result = this.#resetResult(task.kind, outcome);
    if (operationId) await completeDurableTaskOperation(destination, operationId, task, result);
    return result;
  }

  #destination(key: string): Promise<LibraryLog> {
    return (this.options.destination ?? LibraryLog.destination)(key);
  }

  async #abandonReset(
    next: LibraryLog,
    kind: 'key-reset.move' | 'key-reset.settle',
    outcome: KeyResetOutcome,
  ): Promise<LibraryAuthorityTaskResult> {
    await next.forget();
    return this.#resetResult(kind, outcome);
  }

  #resetResult(
    kind: 'key-reset.move' | 'key-reset.settle' | 'key-reset.adopt',
    outcome: KeyResetOutcome,
  ): LibraryAuthorityTaskResult {
    return { result: { kind, outcome }, affected: [] };
  }
}

/** A worker-safe, session-local Storage used only for recovery reconciliation notices and make heartbeats. */
class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length() {
    return this.#values.size;
  }
  clear() {
    this.#values.clear();
  }
  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#values.delete(key);
  }
  setItem(key: string, value: string) {
    this.#values.set(key, value);
  }
}
