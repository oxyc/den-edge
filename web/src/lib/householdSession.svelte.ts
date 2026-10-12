import type { ContentServiceClientPort } from './contentServiceClient';
import type { LibraryModel } from './libraryModel.svelte';
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
  #closed = false;
  #foregroundReady = false;

  constructor(
    readonly identity: HouseholdIdentity,
    readonly model: LibraryModel | null,
    readonly content: ContentServiceClientPort,
    private readonly closeWorkerServices: () => void = () => {},
  ) {
    this.services = new SessionServices(model, content);
  }

  configureServices(): void {
    if (this.model && this.model.connection !== 'ready') return;
    this.services.configure(this.model?.runtime.value);
  }

  foreground(): void {
    if (this.#foregroundReady || this.#closed) return;
    this.#foregroundReady = true;
    this.services.foregroundReady();
    void this.model?.foregroundReady().catch(() => {});
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.services.stop();
    this.model?.close();
    this.closeWorkerServices();
  }
}
