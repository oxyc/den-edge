import type { ContentServiceClientPort } from './contentServiceClient';
import type { LibraryModel } from './libraryModel.svelte';
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

  constructor(
    readonly identity: HouseholdIdentity,
    model: LibraryModel | null,
    readonly content: ContentServiceClientPort,
    private readonly closeWorkerServices: () => void = () => {},
    /** Default-off initial-split participant. No production path supplies one or starts an attempt yet. */
    readonly profileMigration: ProfileMigrationParticipant | null = null,
  ) {
    this.#model = model;
    this.policy = profilePolicy(model);
    this.services = new SessionServices(model, content);
  }

  ownsModel(model: LibraryModel | null): boolean {
    return model === this.#model;
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
