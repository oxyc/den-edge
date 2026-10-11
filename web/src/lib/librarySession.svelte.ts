import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { titleKey, type Shape, type Title } from './library';
import type { LibraryModel } from './libraryModel.svelte';
import type {
  LibraryMetadataShape,
  LibraryMetadataTitle,
  TitleRef,
} from './libraryServiceProtocol';
import { cancelLibraryTitleNaming } from './libraryNaming';
import { SessionServices } from './sessionServices.svelte';
import type { ContentServiceClientPort } from './contentServiceClient';

const TOAST_MS = 6_000;

/**
 * Page-only session state. LibraryModel owns storage, projection, polling and commands; this object owns only title
 * metadata learned from TMDB, live provider discovery and transient UI messages shared by retained routes.
 *
 * Metadata grows in place, one entry per title: a reader tracks the keys it read, not every later batch.
 */
export class LibrarySession {
  readonly shapes = new SvelteMap<string, Shape>();
  live = $state(false);
  toast = $state<string | null>(null);
  undo = $state<{ label: string; run: () => void } | null>(null);
  readonly services: SessionServices;
  readonly #displays = new SvelteMap<string, Title>();
  /** TMDB confirmed these records do not exist; unlike a transient refusal they must not strand a shelf prefix. */
  readonly #missing = new SvelteSet<string>();
  #toastTimer?: ReturnType<typeof setTimeout>;
  #closed = false;
  #foregroundReady = false;

  constructor(
    readonly model: LibraryModel | null,
    readonly local: boolean,
    readonly content: ContentServiceClientPort,
    private readonly closeWorkerServices: () => void = () => {},
  ) {
    this.services = new SessionServices(model, content);
  }

  get alert(): string | null {
    const status = this.model?.status;
    if (status?.kind === 'read-only') return status.reason;
    if (status?.kind === 'moved') return 'This library moved to a new key';
    return null;
  }

  configureServices(): void {
    // A library's relay membership is installed by the service hello before it publishes ready. Do not let the
    // page's first provider discovery run as an anonymous visitor while that one bootstrap is still connecting.
    // Guests have no library capability to wait for and configure immediately.
    if (this.model && this.model.connection !== 'ready') return;
    this.services.configure(this.model?.runtime.value);
  }

  publishLibraryMetadata(
    titles: Title[],
    shapes: ReadonlyArray<readonly [string, Shape]>,
    missing: readonly TitleRef[] = [],
  ): void {
    for (const title of titles) {
      const key = titleKey(title);
      if (!this.#displays.has(key)) this.#displays.set(key, title);
    }
    for (const ref of missing) {
      const key = titleKey(ref);
      if (!this.#displays.has(key)) this.#missing.add(key);
    }
    for (const [key, shape] of shapes) this.shapes.set(key, shape);
  }

  async libraryMetadata(refs: readonly TitleRef[]): Promise<{
    titles: LibraryMetadataTitle[];
    shapes: LibraryMetadataShape[];
    retryable: TitleRef[];
    retryAfterMs?: number;
  }> {
    return this.model?.libraryMetadata(refs) ?? { titles: [], shapes: [], retryable: [] };
  }

  rememberTitle(title: Title): void {
    this.publishLibraryMetadata([title], []);
  }

  displayTitle(ref: Pick<Title, 'type' | 'id'>): Title | undefined {
    return this.#displays.get(titleKey(ref));
  }

  displayMissing(ref: Pick<Title, 'type' | 'id'>): boolean {
    return this.#missing.has(titleKey(ref));
  }

  displayTitles(): ReadonlyMap<string, Title> {
    return this.#displays;
  }

  foregroundReady(): void {
    if (this.#foregroundReady || this.#closed) return;
    this.#foregroundReady = true;
    this.services.foregroundReady();
    void this.model?.foregroundReady().catch(() => {});
  }

  notify(
    message: string,
    {
      holdMs = TOAST_MS,
      undo = null,
    }: { holdMs?: number; undo?: { label: string; run: () => void } | null } = {},
  ): void {
    this.toast = message;
    this.undo = undo;
    clearTimeout(this.#toastTimer);
    if (Number.isFinite(holdMs))
      this.#toastTimer = setTimeout(() => {
        this.toast = null;
        this.undo = null;
      }, holdMs);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    cancelLibraryTitleNaming(this);
    clearTimeout(this.#toastTimer);
    this.services.stop();
    this.model?.close();
    this.closeWorkerServices();
  }
}
