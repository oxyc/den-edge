import type { ProfileKeyResetOutcome } from './libraryServiceProtocol';
import type { LibraryLog } from './log';
import {
  HttpProfileKeyResetBackend,
  HOUSEHOLD_WIRE,
  observeResetSource,
  ProfileResetUnavailableError,
  registerMember,
  type ProfileResetAdoption,
  type ProfileResetLibraryOpener,
} from './profileKeyResetBackend';
import {
  adoptionRequest,
  ProfileKeyResetExecutor,
  sameDirectory,
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

/**
 * Adoption is two durable steps with the page in between: the worker prepares (`adopt`), the page installs the
 * successor household key and reads it back, and only then does the worker record that it is installed (`confirm`),
 * which is what the executor reads back (`isAdopted`) before it erases the journal.
 */
export interface ProfileResetInstallation extends ProfileResetAdoption {
  /** Prepared for this exact committed successor and not yet confirmed installed. */
  awaitsInstall(request: ProfileAdoptionRequest): Promise<boolean>;
  /** Record that the page installed it. False when nothing was prepared for this request. */
  confirm(request: ProfileAdoptionRequest): Promise<boolean>;
}

export interface ProfileKeyResetServiceDeps {
  /** The household-sealed vault that holds the journal. */
  readonly vault: ProfileKidCreateVault;
  /** The household key being reset. */
  readonly householdKey: string;
  readonly device: string;
  readonly open: ProfileResetLibraryOpener;
  readonly adoption: ProfileResetInstallation;
  /** The existing profile activation gate: den-edge's profile capability, with the household already on the profile wire. */
  readonly gate: () => Promise<boolean>;
  /** A fresh check of the Owner PIN. */
  readonly ownerPin: (pin: string) => Promise<boolean>;
  readonly options?: ProfileKeyResetOptions;
}

const ROUNDS = 2_000;
const ADOPTED = 'profile-reset/v1/adopted';

interface AdoptionMarker {
  readonly attempt: string;
  readonly committedHead: string;
  readonly installed: boolean;
}

/**
 * Adoption as the worker performs it: work this browser kept for the old household is sealed again under the successor
 * key and a household-sealed marker records which committed successor is waiting to be installed. The page installs
 * the credential; `confirm` marks it so, and only a confirmed marker reads back as adopted.
 */
export class VaultResetAdoption implements ProfileResetInstallation {
  constructor(
    private readonly log: Pick<
      LibraryLog,
      'libraryId' | 'rekeyKept' | 'keepRequired' | 'keptRequired'
    >,
    private readonly destination: (key: string) => Promise<LibraryLog>,
  ) {}

  async adopt(request: ProfileAdoptionRequest): Promise<void> {
    await this.log.rekeyKept(await this.destination(request.householdKey));
    // A marker already confirmed for this very successor stays confirmed: re-preparing never un-installs.
    if (await this.#matching(request)) return;
    await this.log.keepRequired(
      ADOPTED,
      { attempt: request.attempt, committedHead: request.committedHead, installed: false },
      this.#binding(),
    );
  }

  async isAdopted(request: ProfileAdoptionRequest): Promise<boolean> {
    return (await this.#matching(request))?.installed === true;
  }

  async awaitsInstall(request: ProfileAdoptionRequest): Promise<boolean> {
    return (await this.#matching(request))?.installed === false;
  }

  async confirm(request: ProfileAdoptionRequest): Promise<boolean> {
    const found = await this.#matching(request);
    if (found === null) return false;
    if (!found.installed)
      await this.log.keepRequired(ADOPTED, { ...found, installed: true }, this.#binding());
    return true;
  }

  async #matching(request: ProfileAdoptionRequest): Promise<AdoptionMarker | null> {
    const kept = await this.log.keptRequired<AdoptionMarker>(ADOPTED, this.#binding());
    return kept.kind === 'value' &&
      kept.value.attempt === request.attempt &&
      kept.value.committedHead === request.committedHead
      ? kept.value
      : null;
  }

  #binding(): string {
    return `profile-reset-adopted:${this.log.libraryId}:1`;
  }
}

/**
 * One household's compound key reset as the library worker runs it: it checks the gate and a fresh Owner PIN, then
 * lets the journaled executor perform one durable effect per call until the attempt is over or the page has to
 * install the successor. It returns an outcome rather than throwing for anything a person can act on; an unexpected
 * failure propagates with the journal intact.
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
      // Registering the household as its own member moves its source, so it comes before the fence is taken.
      await registerMember(household);
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
    // A journal is an authorized attempt and outlives the gate: the capability is read from the household this very
    // reset retires, which answers 410 once it has. Without one, the gate decides between nothing and unavailable.
    if ((await this.#journal.load()) === null)
      return (await this.deps.gate()) ? 'none' : 'unavailable';
    return this.#drive();
  }

  /**
   * The page installed `destinationLibraryKey` and read it back. The worker reads the successor household itself,
   * records the install, and lets the executor erase the journal. Repeating it after the journal is gone is `none`.
   */
  async confirm(input: {
    readonly destinationLibraryKey: string;
  }): Promise<ProfileKeyResetOutcome> {
    const journal = await this.#journal.load();
    if (journal === null) return 'none';
    if (
      journal.phase !== 'adopting' ||
      journal.newHouseholdKey !== input.destinationLibraryKey ||
      journal.successorDirectory === null ||
      journal.locks === null
    )
      return 'waiting';
    const successor = await this.deps.open(input.destinationLibraryKey, HOUSEHOLD_WIRE);
    let snapshot;
    try {
      snapshot = await successor.resetSnapshot();
    } catch (error) {
      // An unreadable successor is not a confirmed one; the page installs again and asks again.
      console.warn('den: the successor household could not be read back', error);
      return 'waiting';
    }
    // Rows other devices or this page write after the commit are fine; the directory it was committed with is not
    // negotiable.
    if (
      snapshot === null ||
      snapshot === 'absent' ||
      snapshot === 'moved' ||
      snapshot.directory === null ||
      !sameDirectory(snapshot.directory, journal.successorDirectory)
    )
      return 'waiting';
    const request = adoptionRequest(journal, journal.locks);
    if (!(await this.deps.adoption.confirm(request))) return 'waiting';
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

  /** Whether the executor stands at adoption with the successor prepared and not yet installed by the page. */
  async #awaitsInstall(): Promise<boolean> {
    const journal = await this.#journal.load();
    if (journal === null || journal.phase !== 'adopting' || journal.locks === null) return false;
    return this.deps.adoption.awaitsInstall(adoptionRequest(journal, journal.locks));
  }

  /** Performs one durable effect per call until the attempt is over or the page has to install the successor. */
  async #drive(first?: () => Promise<ProfileResetStatus | null>): Promise<ProfileKeyResetOutcome> {
    try {
      let status = await (first ?? (() => this.#executor.resume()))();
      for (let round = 0; round < ROUNDS; round += 1) {
        if (status === null) return 'none';
        if (status.phase === 'complete') return 'complete';
        if (status.phase === 'aborted') return 'aborted';
        if (status.phase === 'adopting' && (await this.#awaitsInstall())) return 'install';
        status = await this.#executor.resume();
      }
    } catch (error) {
      if (error instanceof ProfileResetUnavailableError) return this.#waiting(error);
      throw error;
    }
    return 'waiting';
  }
}
