import type { ClockStore } from './clockStore';
import type { ContentReader } from './contentAuthority';
import {
  DownloadCoordinator,
  downloadPollDelay,
  downloadPollable,
  raceKey,
} from './downloadCoordinator';
import { DownloadCoordinatorDriver } from './downloadCoordinatorDriver';
import type { LibraryLog } from './log';
import type { DownloadTarget } from './libraryServiceProtocol';
import { contentKeyOf, downloadName } from './downloadRows';
import { downloadStill, type SeasonLoader } from './downloadArtwork';
import { readPlugins } from './prefs';
import { relayFetch } from './relayFetch';
import { fetchRoutes, type Routes } from './routes';
import { sendWanted } from './hearthWanted';
import { DEN, DEN_IDS, findAddon, SCOUT, type Addon } from './scout';
import { cancelSource, fetchSourceList, prepareSource, scoutTicket } from './titleSources';

export type DownloadContent = Pick<ContentReader, 'identifiers' | 'season'>;

interface Providers {
  scout: Addon | null;
  den: Addon | null;
  routes: Routes;
}

export interface DownloadBackgroundWork {
  /** Runs only after foreground readiness while visible and online. */
  run(current: () => boolean): Promise<boolean>;
  nextDelay(now: number): number | undefined;
  listen?(listener: () => void): () => void;
}

/** Worker-side provider discovery and download lifecycle. No provider request starts in the constructor. */
export class DownloadServiceRuntime implements DownloadBackgroundWork {
  readonly q: DownloadCoordinator;
  private readonly d: DownloadCoordinatorDriver;
  #providers?: Promise<Providers>;
  #resolved?: Providers;
  #providerInput?: string;
  readonly #seasonLoader: SeasonLoader;
  readonly #listeners = new Set<() => void>();
  #changeQueued = false;
  #providersUnavailable = false;

  constructor(
    readonly log: LibraryLog,
    clock: ClockStore,
    changed: () => void,
    readonly content: DownloadContent,
    readonly fetchImpl: typeof fetch = relayFetch,
    seasonLoader?: SeasonLoader,
  ) {
    this.#seasonLoader =
      seasonLoader ??
      (async (seriesId, season) => {
        const result = await this.content.season(seriesId, season);
        return result.kind === 'found' ? result.value : null;
      });
    this.q = new DownloadCoordinator(
      log,
      clock,
      {
        prepare: (url, queue, prefetch) => prepareSource(url, queue, fetchImpl, prefetch),
        cancel: (url, reannounce) => cancelSource(url, reannounce, fetchImpl),
        ticket: (url) => {
          if (url.startsWith('/scout/') || url.startsWith('/den/')) return url;
          const current = this.#resolved;
          // Foreign tickets are renewed by identity. Never block a synchronous policy decision on discovery.
          return current?.scout ? scoutTicket(url, current.scout, current.routes) : null;
        },
        resolve: async (title, fresh, early, signal) => {
          const { scout, routes } = await this.#getProviders();
          if (!scout) return { sources: null, failure: 'not-configured' };
          const identifier = title.imdbId
            ? null
            : await this.content.identifiers({ type: title.mediaType, id: title.mediaId });
          const imdb =
            title.imdbId ??
            (identifier?.kind === 'found'
              ? identifier.value.imdbId
              : identifier?.kind === 'missing'
                ? null
                : undefined);
          if (imdb === null)
            return { sources: null, imdb: 'missing' as const, failure: 'unmatched' as const };
          if (imdb === undefined)
            return {
              sources: null,
              imdb: 'lookup_failed' as const,
              failure: 'unreachable' as const,
            };
          const found = await fetchSourceList(
            scout,
            imdb,
            routes,
            title.season,
            title.episode,
            signal,
            fetchImpl,
            fresh,
            early,
          );
          return found.sources === null
            ? { ...found, imdb: 'resolved' as const, failure: 'unreachable' as const }
            : { ...found, imdb: 'resolved' as const };
        },
        wanted: (items, den) => sendWanted((den as Addon).base, items, fetchImpl),
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
    this.d = new DownloadCoordinatorDriver(this.q);
  }

  async run(current: () => boolean = () => true): Promise<boolean> {
    let scout: Addon | null;
    let den: Addon | null;
    try {
      ({ scout, den } = await this.#getProviders());
    } catch (error) {
      this.#providersUnavailable = true;
      throw error;
    }
    this.#providersUnavailable = !scout;
    if (!scout || !current()) return false;
    const before = this.#digest();
    const wrote = await this.d.run({ current }, den);
    return wrote || before !== this.#digest();
  }

  nextDelay(now = Date.now()): number | undefined {
    const coordinator = this.q;
    const downloads = coordinator.list().filter((download) => {
      const state = coordinator.status(download, now).state;
      return downloadPollable(state);
    });
    // An unasked download is due immediately only when a pass can actually ask Scout. Without a configured or
    // reachable provider, returning zero makes the authority run maintenance and this no-op again without pause.
    // Fall back to its ordinary visible cadence; a plugin-row change is then observed before the next attempt.
    if (!downloads.length || this.#providersUnavailable) return undefined;
    return Math.min(
      ...downloads.map((download) => {
        const asked = coordinator.asked.get(download.name);
        return asked ? Math.max(0, downloadPollDelay(asked.quiet) - (now - asked.at)) : 0;
      }),
    );
  }

  listen(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async refresh(target?: DownloadTarget): Promise<boolean> {
    const before = this.#digest();
    const name = target
      ? downloadName(
          contentKeyOf({
            mediaType: target.type,
            mediaId: target.id,
            ...(target.type === 'tv' ? { season: target.season, episode: target.episode } : {}),
            title: '',
          }),
        )
      : undefined;
    const wrote = await this.d.run({
      force: true,
      ...(name ? { names: new Set([name]) } : {}),
    });
    return wrote || before !== this.#digest();
  }

  async artwork(target: DownloadTarget): Promise<string | null> {
    if (target.type !== 'tv') return null;
    try {
      return (
        (await downloadStill(
          {
            mediaType: 'tv',
            mediaId: target.id,
            season: target.season,
            episode: target.episode,
            title: '',
          },
          this.#seasonLoader,
        )) ?? null
      );
    } catch {
      return null;
    }
  }

  #digest(): string {
    const coordinator = this.q;
    return JSON.stringify(
      coordinator
        .list()
        .map((download) => [
          download.name,
          coordinator.status(download),
          download.race.entries.map(
            (entry) => coordinator.entryAnswers.get(raceKey(download.name, entry.identity)) ?? null,
          ),
        ]),
    );
  }

  async #getProviders(): Promise<Providers> {
    const plugins = readPlugins(this.log.settings('plugins'));
    const input = JSON.stringify(plugins);
    if (this.#providers && this.#providerInput === input) return this.#providers;
    this.#providerInput = input;
    const request = (async () => {
      const routes = await fetchRoutes(this.fetchImpl);
      const legacy = await findAddon(plugins, routes, SCOUT, this.fetchImpl);
      // Hearth, which searches on for the wanted downloads while this page is closed. Without a legacy Scout it is
      // also the source service, as playback takes it (`findScout`).
      const den = await findAddon(plugins, routes, { ...DEN, id: DEN_IDS }, this.fetchImpl);
      return { scout: legacy ?? den, den, routes };
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
