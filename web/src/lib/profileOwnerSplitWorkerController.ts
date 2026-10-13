import {
  DormantOwnerSplitCoordinator,
  type OwnerSplitJournal,
  type OwnerSplitRunResult,
} from './profileOwnerSplitCoordinator';
import type { OwnerSplitSource } from './profileOwnerSplitEngine';
import type { OwnerSplitWorkerSecureAdapter } from './profileOwnerSplitWorkerSecure';
import type { OwnerSplitCapability } from './profileOwnerSplitWorkerTransport';

export type OwnerSplitWorkerPhase =
  'off' | 'available' | 'preparing' | 'ready' | 'reconciling' | 'enabled' | 'recovery-required';

export interface OwnerSplitWorkerControlPort {
  capability(): Promise<OwnerSplitCapability | null>;
  loadJournal(): Promise<OwnerSplitJournal | null>;
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
      if (capability.wireMin === capability.runtimeHouseholdWire) return { phase: 'enabled' };
      return capability.enrollment === 'prepare' && capability.wireMin < 5
        ? { phase: 'available' }
        : { phase: 'off' };
    }
    const resumed = await this.coordinator.resume();
    journal = await this.port.loadJournal();
    if (journal !== null) return { phase: phaseOf(journal), attempt: journal.attempt };
    if (resumed.kind === 'active' || resumed.kind === 'restored') return { phase: 'enabled' };
    return capability.enrollment === 'prepare' && capability.wireMin < 5
      ? { phase: 'available' }
      : { phase: 'off' };
  }

  async observe(): Promise<{ readonly attempt: string; readonly source: OwnerSplitSource }> {
    await this.#requirePrepareCapability();
    if ((await this.port.loadJournal()) !== null)
      throw new Error('A profile migration attempt is already durable');
    return { attempt: randomAttempt(), source: await this.coordinator.observeSource() };
  }

  async observeRecovery(
    attempt: string,
  ): Promise<{ readonly recoveryAttempt: string; readonly source: OwnerSplitSource }> {
    const capability = await this.port.capability();
    if (capability === null) throw new Error('Profile recovery is unavailable');
    const journal = await this.port.loadJournal();
    if (journal?.attempt !== attempt || journal.state !== 'restore-required')
      throw new Error('Profile recovery is not required');
    return { recoveryAttempt: randomAttempt(), source: await this.coordinator.observeSource() };
  }

  async enable(attempt: string, source: OwnerSplitSource): Promise<OwnerSplitRunResult> {
    await this.#requirePrepareCapability();
    return this.coordinator.prepare(attempt, source);
  }

  cancel(attempt: string): Promise<OwnerSplitRunResult> {
    return this.coordinator.cancel(attempt);
  }

  async recover(
    attempt: string,
    recoveryAttempt: string,
    source: OwnerSplitSource,
  ): Promise<OwnerSplitRunResult> {
    const capability = await this.port.capability();
    if (capability === null) throw new Error('Profile recovery is unavailable');
    return this.coordinator.authorizeRecovery(attempt, recoveryAttempt, source);
  }

  async #requirePrepareCapability(): Promise<void> {
    const capability = await this.port.capability();
    if (capability?.enrollment !== 'prepare' || capability.wireMin >= 5)
      throw new Error('Profile migration preparation is unavailable');
  }
}

export function workerStatusControl(
  capability: () => Promise<OwnerSplitCapability | null>,
  loadJournal: () => Promise<OwnerSplitJournal | null>,
  coordinator: DormantOwnerSplitCoordinator,
  secureWorker: OwnerSplitWorkerSecureAdapter,
): OwnerSplitWorkerController {
  return new OwnerSplitWorkerController(
    {
      capability,
      loadJournal,
    },
    coordinator,
    secureWorker,
  );
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
