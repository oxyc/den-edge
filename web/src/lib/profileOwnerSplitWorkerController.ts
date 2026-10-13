import type { OwnerSplitJournal } from './profileOwnerSplitCoordinator';
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
    /** Worker-owned composition seam for a future core-approved lifecycle caller; never serialized to the page. */
    readonly secureWorker: OwnerSplitWorkerSecureAdapter,
  ) {}

  async status(): Promise<{ readonly phase: OwnerSplitWorkerPhase; readonly attempt?: string }> {
    const capability = await this.port.capability();
    if (capability === null) return { phase: 'off' };
    const journal = await this.port.loadJournal();
    if (journal === null)
      return capability.enrollment === 'prepare' && capability.wireMin < 5
        ? { phase: 'available' }
        : { phase: 'off' };
    return { phase: phaseOf(journal), attempt: journal.attempt };
  }
}

export function workerStatusControl(
  capability: () => Promise<OwnerSplitCapability | null>,
  loadJournal: () => Promise<OwnerSplitJournal | null>,
  secureWorker: OwnerSplitWorkerSecureAdapter,
): OwnerSplitWorkerController {
  return new OwnerSplitWorkerController(
    {
      capability,
      loadJournal,
    },
    secureWorker,
  );
}

function phaseOf(journal: OwnerSplitJournal): OwnerSplitWorkerPhase {
  if (journal.state === 'awaiting-confirmation') return 'ready';
  if (journal.state === 'active') return 'enabled';
  if (journal.state === 'restore-required') return 'recovery-required';
  if (['ready-to-commit', 'commit-unknown', 'adopting', 'cleaning-loser'].includes(journal.state))
    return 'reconciling';
  return 'preparing';
}
