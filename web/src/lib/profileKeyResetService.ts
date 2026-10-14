import type { ProfileKeyResetOutcome } from './libraryServiceProtocol';
import type { LibraryLog } from './log';
import {
  HttpProfileKeyResetBackend,
  HOUSEHOLD_WIRE,
  observeResetSource,
  ProfileResetUnavailableError,
  type ProfileResetAdoption,
  type ProfileResetLibraryOpener,
} from './profileKeyResetBackend';
import {
  ProfileKeyResetExecutor,
  VaultProfileResetJournal,
  type ProfileAdoptionRequest,
  type ProfileKeyResetOptions,
  type ProfileResetStatus,
} from './profileKeyResetExecutor';
import { ProfileKeyResetRecovery } from './profileKeyResetRecovery';
import type { ProfileKidCreateVault } from './profileKidCreateWorker';

/** The Owner PIN did not match; nothing was read or sent. */
export class ProfileResetUnauthorizedError extends Error {
  constructor() {
    super('The Owner PIN is required to reset a profile household');
    this.name = 'ProfileResetUnauthorizedError';
  }
}

export interface ProfileKeyResetServiceDeps {
  /** The household-sealed vault that holds the journal. */
  readonly vault: ProfileKidCreateVault;
  /** The household key being reset. */
  readonly householdKey: string;
  readonly device: string;
  readonly open: ProfileResetLibraryOpener;
  readonly adoption: ProfileResetAdoption;
  /** The existing profile activation gate: den-edge's profile capability, with the household already on the profile wire. */
  readonly gate: () => Promise<boolean>;
  /** A fresh check of the Owner PIN. */
  readonly ownerPin: (pin: string) => Promise<boolean>;
  readonly options?: ProfileKeyResetOptions;
}

const ROUNDS = 2_000;
const ADOPTED = 'profile-reset/v1/adopted';

/**
 * Adoption as the worker performs it: work this browser kept for the old household is sealed again under the successor
 * key, then a household-sealed marker records which committed successor was installed. The page installs the successor
 * credential itself when the attempt reports `complete`; the marker is what the executor reads back before it erases
 * the journal, which holds the last copy of every old and provisional key.
 */
export class VaultResetAdoption implements ProfileResetAdoption {
  constructor(
    private readonly log: Pick<
      LibraryLog,
      'libraryId' | 'rekeyKept' | 'keepRequired' | 'keptRequired'
    >,
    private readonly destination: (key: string) => Promise<LibraryLog>,
  ) {}

  async adopt(request: ProfileAdoptionRequest): Promise<void> {
    await this.log.rekeyKept(await this.destination(request.householdKey));
    await this.log.keepRequired(ADOPTED, marker(request), this.#binding());
  }

  async isAdopted(request: ProfileAdoptionRequest): Promise<boolean> {
    const kept = await this.log.keptRequired<ReturnType<typeof marker>>(ADOPTED, this.#binding());
    return (
      kept.kind === 'value' &&
      kept.value.attempt === request.attempt &&
      kept.value.committedHead === request.committedHead
    );
  }

  #binding(): string {
    return `profile-reset-adopted:${this.log.libraryId}:1`;
  }
}

const marker = (request: ProfileAdoptionRequest) => ({
  attempt: request.attempt,
  committedHead: request.committedHead,
});

/**
 * One household's compound key reset as the library worker runs it: it checks the gate and a fresh Owner PIN, then
 * lets the journaled executor perform one durable effect per call until the attempt is over. It returns an outcome
 * rather than throwing for anything a person can act on; an unexpected failure propagates with the journal intact.
 */
export class ProfileKeyResetService {
  readonly #journal: VaultProfileResetJournal;
  readonly #executor: ProfileKeyResetExecutor;

  constructor(private readonly deps: ProfileKeyResetServiceDeps) {
    this.#journal = new VaultProfileResetJournal(deps.vault);
    this.#executor = new ProfileKeyResetExecutor(
      new HttpProfileKeyResetBackend({
        journal: this.#journal,
        open: deps.open,
        adoption: deps.adoption,
        householdKey: deps.householdKey,
        device: deps.device,
      }),
      deps.options,
    );
  }

  async start(input: {
    readonly pin: string;
    readonly destinationLibraryKey: string;
  }): Promise<ProfileKeyResetOutcome> {
    if (!(await this.deps.gate())) return 'unavailable';
    await this.#requirePin(input.pin);
    // A journal already holds an authorized attempt; a second start continues it rather than minting new keys.
    if ((await this.#journal.load()) !== null) return this.#drive();
    const household = await this.deps.open(this.deps.householdKey, HOUSEHOLD_WIRE);
    let observed;
    try {
      observed = await observeResetSource(household, HOUSEHOLD_WIRE);
    } catch (error) {
      if (error instanceof ProfileResetUnavailableError) return this.#waiting(error);
      throw error;
    }
    if (observed === null) return 'waiting';
    const directory = observed.snapshot.directory;
    if (directory === null) return 'unavailable';
    return this.#drive(() =>
      this.#executor.start(
        directory,
        this.deps.householdKey,
        observed.source,
        input.destinationLibraryKey,
      ),
    );
  }

  async resume(): Promise<ProfileKeyResetOutcome> {
    if (!(await this.deps.gate())) return 'unavailable';
    if ((await this.#journal.load()) === null) return 'none';
    return this.#drive();
  }

  async recover(input: {
    readonly pin: string;
    readonly recoveryAttempt: string;
    readonly successorKey: string | null;
  }): Promise<ProfileKeyResetOutcome> {
    if (!(await this.deps.gate())) return 'unavailable';
    await this.#requirePin(input.pin);
    const recovery = new ProfileKeyResetRecovery({
      journal: this.#journal,
      open: this.deps.open,
      householdKey: this.deps.householdKey,
    });
    try {
      const result = await recovery.recover({
        attempt: input.recoveryAttempt,
        successorKey: input.successorKey,
      });
      return result.kind;
    } catch (error) {
      if (error instanceof ProfileResetUnavailableError) return this.#waiting(error);
      throw error;
    }
  }

  async #requirePin(pin: string): Promise<void> {
    if (!(await this.deps.ownerPin(pin))) throw new ProfileResetUnauthorizedError();
  }

  #waiting(error: Error): 'waiting' {
    console.warn('den: the profile key reset is waiting', error);
    return 'waiting';
  }

  /** Performs one durable effect per call until den-edge and the journal say the attempt is over. */
  async #drive(first?: () => Promise<ProfileResetStatus | null>): Promise<ProfileKeyResetOutcome> {
    try {
      let status = await (first ?? (() => this.#executor.resume()))();
      for (let round = 0; round < ROUNDS; round += 1) {
        if (status === null) return 'none';
        if (status.phase === 'complete') return 'complete';
        if (status.phase === 'aborted') return 'aborted';
        status = await this.#executor.resume();
      }
    } catch (error) {
      if (error instanceof ProfileResetUnavailableError) return this.#waiting(error);
      throw error;
    }
    return 'waiting';
  }
}
