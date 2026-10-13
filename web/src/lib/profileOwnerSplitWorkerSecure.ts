import { validateStoredProfileDirectory } from './profileDirectory';
import { planOwnerSplitWithCore } from './profileOwnerSplitCoreWorker';
import type {
  OwnerSplitAuthenticatedCopy,
  OwnerSplitBackup,
  OwnerSplitCandidateHandle,
  OwnerSplitFence,
  OwnerSplitPlannerEvidence,
  OwnerSplitSecureWorker,
  VerifiedOwnerSplitBackup,
} from './profileOwnerSplitEngine';
import {
  OwnerSplitWorkerStore,
  type ResolvedOwnerSplitCandidate,
} from './profileOwnerSplitWorkerStore';
import { deriveKeys } from './wire';

const ID = /^[0-9a-f]{32}$/;

/** Crypto/storage operations implemented by LibraryLog in the DedicatedWorker. */
export interface OwnerSplitWorkerCryptoIO {
  readonly libraryId: string;
  verifyMigrationBackup(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly created: Pick<OwnerSplitBackup, 'id' | 'digest'>;
    readonly reread: OwnerSplitBackup;
  }): Promise<void>;
  copyAndAuthenticateMigrationOwner(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: ResolvedOwnerSplitCandidate;
  }): Promise<OwnerSplitAuthenticatedCopy>;
  verifyMigrationOwner(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: ResolvedOwnerSplitCandidate;
    readonly expectedHead: string;
  }): Promise<void>;
  adoptMigrationWinner(directory: unknown): Promise<void>;
}

export class OwnerSplitWorkerSecureAdapter implements OwnerSplitSecureWorker {
  readonly #io: OwnerSplitWorkerCryptoIO;
  readonly #store: OwnerSplitWorkerStore;

  constructor(io: OwnerSplitWorkerCryptoIO, store: OwnerSplitWorkerStore) {
    if (!ID.test(io.libraryId)) throw new TypeError('Household identity is not canonical');
    this.#io = io;
    this.#store = store;
  }

  allocateCandidate(attempt: string): Promise<OwnerSplitCandidateHandle> {
    return this.#store.allocateCandidate(attempt);
  }

  verifyBackup(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly created: Pick<OwnerSplitBackup, 'id' | 'digest'>;
    readonly reread: OwnerSplitBackup;
  }): Promise<void> {
    return this.#io.verifyMigrationBackup(input);
  }

  async copyAndAuthenticateOwner(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: OwnerSplitCandidateHandle;
  }): Promise<OwnerSplitAuthenticatedCopy> {
    const candidate = await this.#resolved(input.candidate, input.attempt);
    return this.#io.copyAndAuthenticateMigrationOwner({ ...input, candidate });
  }

  async verifyOwnerLibrary(input: {
    readonly attempt: string;
    readonly fence: OwnerSplitFence;
    readonly backup: VerifiedOwnerSplitBackup;
    readonly candidate: OwnerSplitCandidateHandle;
    readonly expectedHead: string;
  }): Promise<void> {
    const candidate = await this.#resolved(input.candidate, input.attempt);
    await this.#io.verifyMigrationOwner({ ...input, candidate });
  }

  async planNext(input: OwnerSplitPlannerEvidence) {
    const candidateKey = input.candidate
      ? (await this.#resolved(input.candidate, input.candidateAttempt ?? '')).libraryKey
      : undefined;
    return planOwnerSplitWithCore(input, candidateKey);
  }

  async verifyCommittedWinner(input: {
    readonly directory: unknown;
    readonly attempt: string;
    readonly candidate: OwnerSplitCandidateHandle;
    readonly ownerHead: string;
  }): Promise<{
    readonly ownerLibraryId: string;
    readonly protectedLibraryIds: readonly string[];
  }> {
    const directory = validateStoredProfileDirectory(input.directory);
    const owner = directory.profiles[directory.owner];
    const candidate = await this.#resolved(input.candidate, input.attempt);
    if (
      directory.migration.attempt !== input.attempt ||
      directory.migration.ownerHead !== input.ownerHead ||
      owner?.library.value.key !== candidate.libraryKey ||
      owner.id !== input.candidate.profileId
    )
      throw new Error('Committed directory does not name this verified Owner candidate');
    const facts = await this.inspectCommittedDirectory(directory);
    if (facts.ownerLibraryId !== input.candidate.libraryId)
      throw new Error('Committed Owner library identity does not match its key');
    return {
      ownerLibraryId: facts.ownerLibraryId,
      protectedLibraryIds: facts.protectedLibraryIds,
    };
  }

  async inspectCommittedDirectory(directory: unknown): Promise<{
    readonly winnerAttempt: string;
    readonly ownerHead: string;
    readonly ownerLibraryId: string;
    readonly protectedLibraryIds: readonly string[];
  }> {
    const checked = validateStoredProfileDirectory(directory);
    const owner = checked.profiles[checked.owner];
    if (!owner || owner.deleted.value) throw new Error('Committed directory has no live Owner');
    const ids = await Promise.all(
      Object.values(checked.profiles)
        .filter((profile) => !profile.deleted.value)
        .map(async (profile) => (await deriveKeys(fromBase64Key(profile.library.value.key))).id),
    );
    return {
      winnerAttempt: checked.migration.attempt,
      ownerHead: checked.migration.ownerHead,
      ownerLibraryId: (await deriveKeys(fromBase64Key(owner.library.value.key))).id,
      protectedLibraryIds: [this.#io.libraryId, ...new Set(ids)],
    };
  }

  async verifyDirectoryWinner(directory: unknown): Promise<{
    readonly winnerAttempt: string;
    readonly ownerHead: string;
    readonly ownerLibraryId: string;
    readonly protectedLibraryIds: readonly string[];
  }> {
    return this.inspectCommittedDirectory(directory);
  }

  adoptWinner(directory: unknown): Promise<void> {
    validateStoredProfileDirectory(directory);
    return this.#io.adoptMigrationWinner(directory);
  }

  forgetCandidate(keyRef: string): Promise<void> {
    return this.#store.forgetCandidate(keyRef);
  }

  async #resolved(
    handle: OwnerSplitCandidateHandle,
    attempt: string,
  ): Promise<ResolvedOwnerSplitCandidate> {
    const resolved = await this.#store.resolveCandidate(handle.keyRef, attempt);
    if (
      resolved.handle.profileId !== handle.profileId ||
      resolved.handle.libraryId !== handle.libraryId ||
      resolved.handle.keyFingerprint !== handle.keyFingerprint
    )
      throw new Error('Candidate public handle does not match its sealed credential');
    return resolved;
  }
}

function fromBase64Key(value: string): Uint8Array<ArrayBuffer> {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error('Profile library key is not canonical');
  }
  const raw = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) raw[index] = decoded.charCodeAt(index);
  if (raw.length !== 32 || btoa(String.fromCharCode(...raw)) !== value)
    throw new Error('Profile library key is not canonical');
  return raw;
}
