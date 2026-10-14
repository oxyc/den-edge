import {
  DormantOwnerSplitCoordinator,
  type OwnerSplitHandoffRecovery,
  type OwnerSplitJournal,
  type OwnerSplitRunResult,
} from './profileOwnerSplitCoordinator';
import type { OwnerSplitSource } from './profileOwnerSplitEngine';
import type { OwnerSplitWorkerSecureAdapter } from './profileOwnerSplitWorkerSecure';
import type { OwnerSplitCapability } from './profileOwnerSplitWorkerTransport';

export type OwnerSplitWorkerPhase =
  | 'off'
  | 'available'
  | 'preparing'
  | 'ready'
  | 'reconciling'
  | 'enabled'
  | 'recovery-required'
  /** den-edge refused a write with `409 migration_in_progress`: another attempt holds the household lock. */
  | 'setup-in-progress';

export interface OwnerSplitWorkerControlPort {
  capability(): Promise<OwnerSplitCapability | null>;
  loadJournal(): Promise<OwnerSplitJournal | null>;
  loadHandoff(): Promise<OwnerSplitHandoffRecovery | null>;
  /** This browser saw den-edge refuse an ordinary household write because a migration holds the lock. */
  migrationLocked(): boolean;
}

/** Status-only service adapter. No lifecycle action is exposed until the product contract has a matching core op. */
export class OwnerSplitWorkerController {
  constructor(
    private readonly port: OwnerSplitWorkerControlPort,
    private readonly coordinator: DormantOwnerSplitCoordinator,
    /** Worker-owned composition seam for a future core-approved lifecycle caller; never serialized to the page. */
    readonly secureWorker: OwnerSplitWorkerSecureAdapter,
  ) {}

  async status(): Promise<{ readonly phase: OwnerSplitWorkerPhase; readonly attempt?: string }> {
    const capability = await this.port.capability();
    if (capability === null) return { phase: 'off' };
    let journal = await this.port.loadJournal();
    if (journal === null) {
      if ((await this.port.loadHandoff()) !== null) return this.#resumeHandoff(capability);
      return this.#idleStatus(capability);
    }
    const resumed = await this.coordinator.resume();
    journal = await this.port.loadJournal();
    if (journal !== null) return { phase: phaseOf(journal), attempt: journal.attempt };
    if (resumed.kind === 'active' || resumed.kind === 'restored') return { phase: 'enabled' };
    if (resumed.kind === 'setup-in-progress') return { phase: 'setup-in-progress' };
    return this.#idleStatus(capability);
  }

  /** No journal and no handoff on this device. A refused ordinary write is the only sign of a foreign lock. */
  #idleStatus(capability: OwnerSplitCapability): { readonly phase: OwnerSplitWorkerPhase } {
    if (capability.wireMin === capability.runtimeHouseholdWire) return { phase: 'enabled' };
    if (this.port.migrationLocked()) return { phase: 'setup-in-progress' };
    return capability.enrollment === 'prepare' && capability.wireMin < 5
      ? { phase: 'available' }
      : { phase: 'off' };
  }

  /**
   * A journal-less Restore this device already authorized resumes as exactly that attempt. An error is surfaced in the
   * device log and as a state that still offers Restore; it never reads as "unavailable" and loses the handoff.
   */
  async #resumeHandoff(
    capability: OwnerSplitCapability,
  ): Promise<{ readonly phase: OwnerSplitWorkerPhase }> {
    let resumed: OwnerSplitRunResult;
    try {
      resumed = await this.coordinator.resume();
    } catch (error) {
      console.error('den: journal-less profile recovery could not continue', error);
      return { phase: 'recovery-required' };
    }
    if (resumed.kind === 'restored') return { phase: 'enabled' };
    if (resumed.kind === 'recovery-blocked') return { phase: 'recovery-required' };
    if (resumed.kind === 'setup-in-progress') return { phase: 'setup-in-progress' };
    return this.#idleStatus(capability);
  }

  async observe(): Promise<{ readonly attempt: string; readonly source: OwnerSplitSource }> {
    await this.#requirePrepareCapability();
    if ((await this.port.loadJournal()) !== null || (await this.port.loadHandoff()) !== null)
      throw new Error('A profile migration attempt is already durable');
    return { attempt: randomAttempt(), source: await this.coordinator.observeSource() };
  }

  /**
   * `attempt` names this device's restore-required split journal. `null` is the journal-less Owner Restore: it is
   * offered only for a household this browser knows is locked, or one whose handoff is already durable.
   */
  async observeRecovery(attempt: string | null): Promise<{
    readonly attempt: string | null;
    readonly recoveryAttempt: string;
    readonly source: OwnerSplitSource;
  }> {
    const capability = await this.port.capability();
    if (capability === null) throw new Error('Profile recovery is unavailable');
    const journal = await this.port.loadJournal();
    if (attempt === null) {
      if (journal !== null) throw new Error('Profile recovery is not required');
      // A durable handoff keeps its own attempt and source: a second one would be refused by den-edge.
      const handoff = await this.port.loadHandoff();
      if (handoff !== null)
        return { attempt: null, recoveryAttempt: handoff.recoveryAttempt, source: handoff.source };
      if (!this.port.migrationLocked()) throw new Error('Profile recovery is not required');
      return {
        attempt: null,
        recoveryAttempt: randomAttempt(),
        source: await this.coordinator.observeSource(),
      };
    }
    if (journal?.attempt !== attempt || journal.state !== 'restore-required')
      throw new Error('Profile recovery is not required');
    return {
      attempt,
      recoveryAttempt: randomAttempt(),
      source: await this.coordinator.observeSource(),
    };
  }

  async enable(attempt: string, source: OwnerSplitSource): Promise<OwnerSplitRunResult> {
    await this.#requirePrepareCapability();
    return this.coordinator.prepare(attempt, source);
  }

  cancel(attempt: string): Promise<OwnerSplitRunResult> {
    return this.coordinator.cancel(attempt);
  }

  async recover(
    attempt: string | null,
    recoveryAttempt: string,
    source: OwnerSplitSource,
  ): Promise<OwnerSplitRunResult> {
    const capability = await this.port.capability();
    if (capability === null) throw new Error('Profile recovery is unavailable');
    if (attempt === null) return this.coordinator.recoverWithoutJournal(recoveryAttempt, source);
    return this.coordinator.authorizeRecovery(attempt, recoveryAttempt, source);
  }

  async #requirePrepareCapability(): Promise<void> {
    const capability = await this.port.capability();
    if (capability?.enrollment !== 'prepare' || capability.wireMin >= 5)
      throw new Error('Profile migration preparation is unavailable');
  }
}

export function workerStatusControl(
  port: OwnerSplitWorkerControlPort,
  coordinator: DormantOwnerSplitCoordinator,
  secureWorker: OwnerSplitWorkerSecureAdapter,
): OwnerSplitWorkerController {
  return new OwnerSplitWorkerController(port, coordinator, secureWorker);
}

function randomAttempt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

function phaseOf(journal: OwnerSplitJournal): OwnerSplitWorkerPhase {
  if (journal.state === 'awaiting-confirmation') return 'ready';
  if (journal.state === 'active') return 'enabled';
  if (journal.state === 'restore-required') return 'recovery-required';
  if (['ready-to-commit', 'commit-unknown', 'adopting', 'cleaning-loser'].includes(journal.state))
    return 'reconciling';
  return 'preparing';
}
