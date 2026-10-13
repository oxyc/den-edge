import type { ContentServiceClientPort } from './contentServiceClient';
import type { LibraryModel, LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView } from './libraryServiceProtocol';
import { libraryUpdateRequired } from './libraryUpdateRequired';
import { profilePolicy, type ProfilePolicy } from './profilePolicy';
import type { ProfileMigrationParticipant } from './profileMigration';
import { SessionServices } from './sessionServices.svelte';

export type HouseholdIdentity =
  | {
      readonly kind: 'legacy';
      readonly libraryKey: string | null;
      /** False until the explicit, backed-up split has committed. This slice never changes it. */
      readonly configurationOnly: false;
    }
  | {
      readonly kind: 'profiles';
      readonly libraryKey: string;
      readonly configurationOnly: true;
    };

/**
 * Household-owned authority and provider lifetime. In today's compatibility topology the one mixed library model
 * is shared with Owner; the boundary lets a future directory keep this session while replacing ProfileSession.
 */
export class HouseholdSession {
  readonly services: SessionServices;
  readonly policy: ProfilePolicy | null;
  readonly #model: LibraryModel | null;
  #closed = false;
  #foregroundReady = false;
  #identity: HouseholdIdentity;

  constructor(
    identity: HouseholdIdentity,
    model: LibraryModel | null,
    readonly content: ContentServiceClientPort,
    private readonly closeWorkerServices: () => void = () => {},
    /** Default-off initial-split participant. No production path supplies one or starts an attempt yet. */
    readonly profileMigration: ProfileMigrationParticipant | null = null,
  ) {
    this.#identity = identity;
    this.#model = model;
    this.policy = profilePolicy(model);
    this.services = new SessionServices(model, content);
  }

  get identity(): HouseholdIdentity {
    return this.#identity;
  }

  /** Promote the already-open control log only after wire 5 yielded a validated committed directory. */
  commitProfiles(libraryKey: string): void {
    if (
      this.#identity.kind !== 'legacy' ||
      this.#identity.libraryKey !== libraryKey ||
      this.#identity.configurationOnly
    )
      throw new Error('Household topology cannot be promoted from this model');
    this.#identity = { kind: 'profiles', libraryKey, configurationOnly: true };
  }

  ownsModel(model: LibraryModel | null): boolean {
    return model === this.#model;
  }

  /** Household security settings stay on the control log after Owner activity moves to its own library. */
  controlConnections(): LibraryModelLease<ConnectionsView> {
    if (!this.#model) throw new Error('Profiles require an open household control library');
    return this.#model.connections();
  }

  /** Verify the household-owned Owner PIN without exposing the control model to profile activity code. */
  async verifyParentalPin(pin: string): Promise<boolean> {
    return (await this.#model?.verifyParentalPin(pin)) ?? false;
  }

  get updateRequired(): boolean {
    return libraryUpdateRequired(this.#model);
  }

  configureServices(): void {
    if (this.#model && this.#model.connection !== 'ready') return;
    this.services.configure(this.#model?.runtime.value);
  }

  foreground(): void {
    if (this.#foregroundReady || this.#closed) return;
    this.#foregroundReady = true;
    this.services.foregroundReady();
    void this.#model?.foregroundReady().catch(() => {});
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.services.stop();
    this.#model?.close();
    this.closeWorkerServices();
  }
}
