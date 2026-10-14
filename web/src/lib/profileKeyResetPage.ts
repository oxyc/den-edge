import type { KeyResetOutcome, ProfileKeyResetOutcome } from './libraryServiceProtocol';
import type { PendingReset } from './links.svelte';

/*
 * The page's half of a compound key reset (profiles-v1 §9). The library worker drives den-edge and keeps the journal
 * that holds every old and provisional key; it stops at `install` once the successor household is committed and every
 * old library is retired. The page then does exactly what the legacy §12 reset does with its destination key: opens
 * the destination to prove it reads, and persists it as the link. Only after that does it tell the worker, which
 * erases the journal, and last of all it drops the old library's kept state and the pending marker.
 *
 * Every step is repeatable and every death converges, because each durable fact is written before the next step
 * relies on it:
 *
 *   marker (before anything) -> journal -> [worker] install -> link -> confirm (journal erased) -> release (marker)
 *
 * The marker names the compound reset, so a reload at any later point resumes here, not in the legacy settle.
 */

export interface ResetWorkerModel {
  prepareKeyReset(): Promise<{
    result: { kind: string; destinationLibraryKey?: string; device?: string };
  }>;
  startProfileKeyReset(
    pin: string,
    destinationLibraryKey: string,
  ): Promise<{ result: { kind: string; outcome?: string } }>;
  resumeProfileKeyReset(): Promise<{ result: { kind: string; outcome?: string } }>;
  confirmProfileKeyReset(
    destinationLibraryKey: string,
  ): Promise<{ result: { kind: string; outcome?: string } }>;
  /** The legacy standing check, for a reset whose journal is already gone. */
  settleLibraryKey(
    destinationLibraryKey: string,
  ): Promise<{ result: { kind: string; outcome?: string } }>;
}

export interface CompoundResetPageDeps<Destination> {
  readonly pending: {
    read(): PendingReset | null;
    /** False when it could not be kept, and a reset must then not start. */
    write(pending: PendingReset | null): boolean;
  };
  /** The model of the library service that holds the journal: the old household's. `close` only if opened here. */
  worker(from: string): Promise<{ model: ResetWorkerModel; close(): void }>;
  /** The destination session, once it has read the library under the new key. Rejects when it cannot. */
  openDestination(key: string): Promise<Destination & { close(): void }>;
  /** The link this browser holds for the library, if any. */
  link(): { libraryKey: string } | null;
  /** Persist `to` as the link in place of `from`, keeping the old state and the marker. */
  install(from: string, to: string): void;
  /** Drop the old library's kept state and the marker; the reset is over. */
  release(from: string): void;
  /** Make the destination the live session. */
  adopt(destination: Destination, to: string): void;
}

export type CompoundResetResult =
  /** Installed, confirmed, released: the destination is the live library. */
  | 'complete'
  /** Nothing happened, or den-edge undid it: the old library stands and the marker is gone. */
  | 'aborted'
  /** Not yet: den-edge, the destination or another device is not ready. The marker stays; run again. */
  | 'waiting'
  /** The profile gate is closed, or the household has no directory: nothing was started. */
  | 'unavailable'
  /** The worker could not be asked. The marker stays. */
  | 'blocked';

export class CompoundResetPage<Destination> {
  #running: Promise<CompoundResetResult> | undefined;

  constructor(private readonly deps: CompoundResetPageDeps<Destination>) {}

  /**
   * Start a reset of the household `from`. The marker is kept before the worker is asked anything, so a reset that
   * dies after retiring the old library still finds its way to the new key.
   */
  async start(from: string, pin: string): Promise<CompoundResetResult> {
    if (this.#running) return 'waiting';
    const worker = await this.deps.worker(from);
    try {
      const prepared = await worker.model.prepareKeyReset();
      const { destinationLibraryKey: to, device } = prepared.result;
      if (prepared.result.kind !== 'key-reset.prepare' || !to || !device) return 'unavailable';
      const pending: PendingReset = { from, to, device, compound: true };
      if (!this.deps.pending.write(pending)) return 'unavailable';
      const started = (await worker.model.startProfileKeyReset(pin, to)).result;
      const outcome = outcomeOf(started, 'profile-key-reset.start');
      if (outcome === 'unavailable' || outcome === 'aborted') {
        this.deps.pending.write(null);
        return outcome;
      }
      return await this.#guard(() => this.#settle(pending, worker.model));
    } finally {
      worker.close();
    }
  }

  /** Continue whatever the marker says is under way. Single-flight; safe to call whenever the page loads. */
  run(pending: PendingReset): Promise<CompoundResetResult> {
    return this.#guard(async () => {
      let worker;
      try {
        worker = await this.deps.worker(pending.from);
      } catch (error) {
        console.warn('den: the profile key reset could not reach its library service', error);
        return 'blocked';
      }
      try {
        return await this.#settle(pending, worker.model);
      } finally {
        worker.close();
      }
    });
  }

  #guard(work: () => Promise<CompoundResetResult>): Promise<CompoundResetResult> {
    if (this.#running) return this.#running;
    const running = work().finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  async #settle(pending: PendingReset, model: ResetWorkerModel): Promise<CompoundResetResult> {
    const outcome = outcomeOf(
      (await model.resumeProfileKeyReset()).result,
      'profile-key-reset.resume',
    );
    switch (outcome) {
      case 'install':
        return this.#install(pending, model, true);
      case 'complete':
        return this.#install(pending, model, false);
      case 'aborted':
        this.deps.pending.write(null);
        return 'aborted';
      case 'none':
        return this.#withoutJournal(pending, model);
      case 'unavailable':
        return 'unavailable';
      default:
        return 'waiting';
    }
  }

  /**
   * No journal. Either the worker finished and a death came before the page did, or the reset never began. The
   * legacy standing check tells which: the old library still stands, or it was retired by this reset.
   */
  async #withoutJournal(
    pending: PendingReset,
    model: ResetWorkerModel,
  ): Promise<CompoundResetResult> {
    if (this.deps.link()?.libraryKey === pending.to) return this.#install(pending, model, false);
    const settled = (await model.settleLibraryKey(pending.to)).result;
    const outcome =
      settled.kind === 'key-reset.settle' ? (settled.outcome as KeyResetOutcome) : null;
    // `held` is a retirement that names no successor; with a compound marker and no journal it can only be ours.
    if (outcome === 'moved' || outcome === 'adopted' || outcome === 'held')
      return this.#install(pending, model, false);
    if (outcome === 'undone' || outcome === 'foreign') {
      this.deps.pending.write(null);
      return 'aborted';
    }
    return 'waiting';
  }

  async #install(
    pending: PendingReset,
    model: ResetWorkerModel,
    confirm: boolean,
  ): Promise<CompoundResetResult> {
    let destination;
    try {
      // The readback: the destination reads under the new key before anything points at it.
      destination = await this.deps.openDestination(pending.to);
    } catch (error) {
      console.warn('den: the successor household could not be opened yet', error);
      return 'waiting';
    }
    if (this.deps.link()?.libraryKey !== pending.to) this.deps.install(pending.from, pending.to);
    // Read the install back; the journal is erased only once the link names the new key.
    if (this.deps.link()?.libraryKey !== pending.to) {
      destination.close();
      return 'waiting';
    }
    if (confirm) {
      const confirmed = outcomeOf(
        (await model.confirmProfileKeyReset(pending.to)).result,
        'profile-key-reset.confirm',
      );
      if (confirmed !== 'complete' && confirmed !== 'none') {
        destination.close();
        return 'waiting';
      }
    }
    this.deps.release(pending.from);
    this.deps.adopt(destination, pending.to);
    return 'complete';
  }
}

function outcomeOf(
  result: { kind: string; outcome?: string },
  kind: string,
): ProfileKeyResetOutcome | null {
  return result.kind === kind && result.outcome !== undefined
    ? (result.outcome as ProfileKeyResetOutcome)
    : null;
}
