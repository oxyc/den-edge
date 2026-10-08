import type { ClockStore } from './clockStore';
import { DownloadCoordinator } from './downloadCoordinator';
import { DownloadCoordinatorDriver } from './downloadCoordinatorDriver';
import type { LibraryLog } from './log';
import { readPlugins } from './prefs';
import { relayFetch } from './relayFetch';
import { fetchRoutes, type Routes } from './routes';
import { findAddon, SCOUT, type Addon } from './scout';
import { fetchImdbId } from './tmdb';
import {
  cancelSource,
  fetchSourceList,
  prepareSource,
  scoutTicket,
  type Preparation,
} from './titleSources';
import { tmdbKeyOf } from './tmdb';

export interface DownloadBackgroundWork {
  /** Runs only after foreground readiness while visible and online. */
  run(current: () => boolean): Promise<boolean>;
  listen?(listener: () => void): () => void;
}

/** Worker-side provider discovery and download lifecycle. No provider request starts in the constructor. */
export class DownloadServiceRuntime implements DownloadBackgroundWork {
  readonly coordinator: DownloadCoordinator;
  readonly driver: DownloadCoordinatorDriver;
  #providers?: Promise<{ scout: Addon | null; routes: Routes; input: string }>;
  #resolved?: { scout: Addon | null; routes: Routes; input: string };
  #providerInput?: string;
  readonly #listeners = new Set<() => void>();
  #changeQueued = false;

  constructor(
    readonly log: LibraryLog,
    clock: ClockStore,
    changed: () => void,
    readonly fetchImpl: typeof fetch = relayFetch,
  ) {
    const providers = () => this.#getProviders();
    this.coordinator = new DownloadCoordinator(
      log,
      clock,
      {
        prepare: (url, queue, prefetch) => prepareSource(url, queue, this.fetchImpl, prefetch),
        cancel: (url, reannounce) => cancelSource(url, reannounce, this.fetchImpl),
        ticket: (url) => {
          if (url.startsWith('/scout/')) return url;
          const current = this.#resolved;
          // Foreign tickets are renewed by identity. Never block a synchronous policy decision on discovery.
          return current?.scout ? scoutTicket(url, current.scout, current.routes) : null;
        },
        resolve: async (title) => {
          const { scout, routes } = await providers();
          if (!scout) return { sources: null };
          const imdb =
            title.imdbId ??
            (await fetchImdbId(
              { type: title.mediaType, id: title.mediaId },
              tmdbKeyOf(this.log.settings('keys')),
            ));
          if (!imdb) return { sources: null };
          return fetchSourceList(
            scout,
            imdb,
            routes,
            title.season,
            title.episode,
            undefined,
            this.fetchImpl,
          );
        },
      },
      {
        changed: () => {
          changed();
          if (this.#changeQueued) return;
          this.#changeQueued = true;
          queueMicrotask(() => {
            this.#changeQueued = false;
            for (const listener of this.#listeners) listener();
          });
        },
      },
    );
    this.driver = new DownloadCoordinatorDriver(this.coordinator);
  }

  async run(current: () => boolean = () => true): Promise<boolean> {
    const { scout } = await this.#getProviders();
    if (!scout || !current()) return false;
    const before = this.#digest();
    const wrote = await this.driver.run({ current });
    return wrote || before !== this.#digest();
  }

  listen(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prepare(url: string, queue: boolean, prefetch: boolean): Promise<Preparation> {
    return this.coordinator.effects.prepare(url, queue, prefetch);
  }

  #digest(): string {
    return JSON.stringify(
      this.coordinator
        .list()
        .map((download) => [
          download.name,
          this.coordinator.status(download),
          this.coordinator.hedgeAnswers.get(download.name) ?? null,
        ]),
    );
  }

  async #getProviders(): Promise<{ scout: Addon | null; routes: Routes; input: string }> {
    const plugins = readPlugins(this.log.settings('plugins'));
    const input = JSON.stringify(plugins);
    if (this.#providers && this.#providerInput === input) return this.#providers;
    this.#providerInput = input;
    const request = (async () => {
      const routes = await fetchRoutes(this.fetchImpl);
      const scout = await findAddon(plugins, routes, SCOUT, this.fetchImpl);
      return { scout, routes, input };
    })();
    this.#providers = request;
    try {
      const found = await request;
      if (this.#providers === request) this.#resolved = found;
      return found;
    } catch (error) {
      if (this.#providers === request) this.#providers = undefined;
      throw error;
    }
  }
}
