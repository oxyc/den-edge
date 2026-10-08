import type { Shape, Title } from './library';
import type { LibraryModel } from './libraryModel.svelte';
import { SessionServices } from './sessionServices.svelte';

const TOAST_MS = 6_000;

/* eslint-disable svelte/prefer-svelte-reactivity -- Metadata indexes are non-reactive; published replacements are state. */
/**
 * Page-only session state. LibraryModel owns storage, projection, polling and commands; this object owns only title
 * metadata learned from TMDB, live provider discovery and transient UI messages shared by retained routes.
 */
export class LibrarySession {
  displays = $state<Title[]>([]);
  shapes = $state(new Map<string, Shape>());
  displayRevision = $state(0);
  shapeRevision = $state(0);
  live = $state(false);
  toast = $state<string | null>(null);
  undo = $state<{ label: string; run: () => void } | null>(null);
  readonly services: SessionServices;
  #displayIndex = new Map<string, Title>();
  #toastTimer?: ReturnType<typeof setTimeout>;
  #closed = false;
  #foregroundReady = false;

  constructor(
    readonly model: LibraryModel | null,
    readonly local = false,
  ) {
    this.services = new SessionServices(model);
  }

  get alert(): string | null {
    const status = this.model?.status;
    if (status?.kind === 'read-only') return status.reason;
    if (status?.kind === 'moved') return 'This library moved to a new key';
    return null;
  }

  configureServices(): void {
    this.services.configure(this.model?.runtime.value);
  }

  publishLibraryMetadata(titles: Title[], shapes: ReadonlyArray<readonly [string, Shape]>): void {
    const added: Title[] = [];
    for (const title of titles) {
      const key = `${title.type}:${title.id}`;
      if (this.#displayIndex.has(key)) continue;
      this.#displayIndex.set(key, title);
      added.push(title);
    }
    if (added.length) {
      this.displays = [...this.displays, ...added];
      this.displayRevision++;
    }
    if (!shapes.length) return;
    const next = new Map(this.shapes);
    for (const [key, shape] of shapes) {
      next.set(key, shape);
      const match = /^(movie|tv):(\d+)$/.exec(key);
      if (match?.[1] !== 'tv') continue;
      const id = Number(match[2]);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      void this.model
        ?.observeTitleShape({
          title: { type: 'tv', id },
          seasons: [...shape.counts].map(([season, episodes]) => ({ season, episodes })),
          ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
        })
        .catch(() => {});
    }
    this.shapes = next;
    this.shapeRevision++;
  }

  rememberTitle(title: Title): void {
    this.publishLibraryMetadata([title], []);
  }

  displayTitle(ref: Pick<Title, 'type' | 'id'>): Title | undefined {
    void this.displayRevision;
    return this.#displayIndex.get(`${ref.type}:${ref.id}`);
  }

  displayTitles(): ReadonlyMap<string, Title> {
    void this.displayRevision;
    return this.#displayIndex;
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
    clearTimeout(this.#toastTimer);
    this.services.stop();
    this.model?.close();
  }
}
/* eslint-enable svelte/prefer-svelte-reactivity */
