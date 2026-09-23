// The streaming-service directory My Services picks from, as the TV builds it (DenKit `TMDBWire.services`,
// `ServiceCatalog.merging`): TMDB's `/watch/providers/{movie,tv}` for one country, tier and channel variants folded
// onto the service people recognise, ordered by that country's own prominence, movies and series merged.

import { reuse } from '../lib/reuse';
import { tmdbFetch } from '../lib/tmdbCache';

export interface Country {
  code: string;
  name: string;
}

export interface Service {
  id: number;
  name: string;
  logoPath?: string;
  priority: number;
  movies: boolean;
  series: boolean;
  /** The ids folded into this one, so a pick saved under a variant still matches. */
  variants: number[];
}

/** A country directory may still have one useful half when TMDB's movie or TV request fails. */
export interface ServiceDirectoryResult {
  services: Service[];
  complete: boolean;
}

export interface ServiceDirectoryLoad {
  services: Service[];
  status: 'loading' | 'ready' | 'partial' | 'failed';
  request: number;
  key: string;
}

export function beginServiceDirectoryLoad(
  previous: ServiceDirectoryLoad | undefined,
  request: number,
  key: string,
): ServiceDirectoryLoad {
  return { services: previous?.services ?? [], status: 'loading', request, key };
}

/** Complete only the request that still owns this country; an older answer cannot replace a retry. */
export function completeServiceDirectoryLoad(
  current: ServiceDirectoryLoad,
  request: number,
  result: ServiceDirectoryResult,
): ServiceDirectoryLoad {
  if (current.request !== request) return current;
  return {
    services: result.complete ? result.services : mergeServices(current.services, result.services),
    status: result.complete ? 'ready' : 'partial',
    request,
    key: current.key,
  };
}

/** A failed retry keeps the last useful list on screen and becomes retryable again. */
export function failServiceDirectoryLoad(
  current: ServiceDirectoryLoad,
  request: number,
): ServiceDirectoryLoad {
  return current.request === request ? { ...current, status: 'failed' } : current;
}

interface ProviderEntry {
  provider_id?: unknown;
  provider_name?: unknown;
  logo_path?: unknown;
  display_priority?: unknown;
  display_priorities?: unknown;
}

/** "Netflix Standard with Ads" → "netflix", "Max Amazon Channel" → "max": the key variants fold under. */
export function canonicalProviderName(name: string): string {
  let s = name.toLowerCase();
  for (const marker of [
    ' with ',
    ' amazon channel',
    ' apple tv channel',
    ' apple tv+ channel',
    ' roku premium channel',
    ' (',
  ]) {
    const at = s.indexOf(marker);
    if (at >= 0) s = s.slice(0, at);
  }
  for (const tier of [' standard', ' basic', ' premium']) {
    if (s.endsWith(tier)) s = s.slice(0, -tier.length);
  }
  return s.trim();
}

const byPriority = (a: Service, b: Service) =>
  a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** One media type's directory for `country`, variants folded onto the most prominent. */
export function servicesFrom(
  results: readonly ProviderEntry[],
  kind: 'movie' | 'tv',
  country: string,
): Service[] {
  const ids = new Map<string, Set<number>>();
  const best = new Map<string, Service>();
  for (const entry of results) {
    const id = entry.provider_id;
    const name = entry.provider_name;
    if (typeof id !== 'number' || typeof name !== 'string') continue;
    const key = canonicalProviderName(name);
    const local = (entry.display_priorities as Record<string, unknown> | undefined)?.[country];
    const priority =
      typeof local === 'number'
        ? local
        : typeof entry.display_priority === 'number'
          ? entry.display_priority
          : Number.MAX_SAFE_INTEGER;
    ids.set(key, (ids.get(key) ?? new Set()).add(id));
    const existing = best.get(key);
    if (existing && existing.priority <= priority) continue;
    best.set(key, {
      id,
      name,
      logoPath: typeof entry.logo_path === 'string' ? entry.logo_path : undefined,
      priority,
      movies: kind === 'movie',
      series: kind === 'tv',
      variants: [],
    });
  }
  return [...best]
    .map(([key, service]) => ({
      ...service,
      variants: [...(ids.get(key) ?? [])].filter((id) => id !== service.id),
    }))
    .sort(byPriority);
}

/** Movies and series in one list: a service in both carries both, at its more prominent place. */
export function mergeServices(...lists: Service[][]): Service[] {
  const byId = new Map<number, Service>();
  for (const service of lists.flat()) {
    const existing = byId.get(service.id);
    byId.set(
      service.id,
      existing
        ? {
            ...existing,
            logoPath: existing.logoPath ?? service.logoPath,
            priority: Math.min(existing.priority, service.priority),
            movies: existing.movies || service.movies,
            series: existing.series || service.series,
            variants: [...new Set([...existing.variants, ...service.variants])],
          }
        : service,
    );
  }
  return [...byId.values()].sort(byPriority);
}

/** Whether a saved pick's id is this service, or a variant folded into it. */
export const matches = (service: Service, id: number) =>
  service.id === id || service.variants.includes(id);

/** As the country screen names a service that carries only one kind. */
export function serviceLabel(service: Service): string {
  if (service.movies && !service.series) return `${service.name} (movies only)`;
  if (service.series && !service.movies) return `${service.name} (series only)`;
  return service.name;
}

async function tmdb(path: string, key: string, fetchImpl: typeof fetch): Promise<unknown> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', key);
  const res = await fetchImpl(url.href, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

const resultsOf = (body: unknown): ProviderEntry[] => {
  const results = (body as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? (results as ProviderEntry[]) : [];
};

/** Every country TMDB has a directory for, A–Z by English name. */
export async function fetchCountries(key: string, fetchImpl = tmdbFetch): Promise<Country[]> {
  return resultsOf(await tmdb('/watch/providers/regions', key, fetchImpl))
    .flatMap((entry): Country[] => {
      const e = entry as { iso_3166_1?: unknown; english_name?: unknown };
      const code = typeof e.iso_3166_1 === 'string' ? e.iso_3166_1.trim().toUpperCase() : '';
      const name = typeof e.english_name === 'string' ? e.english_name.trim() : '';
      return /^[A-Z]{2}$/.test(code) && name ? [{ code, name }] : [];
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'en') || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    );
}

/**
 * One country's services, movies and series merged, retaining either half when only the other request fails.
 * A caller that can show a retry keeps the partial list on screen; both halves failing still rejects.
 */
export async function fetchServicesResult(
  country: string,
  key: string,
  fetchImpl = tmdbFetch,
): Promise<ServiceDirectoryResult> {
  const settled = await Promise.allSettled(
    (['movie', 'tv'] as const).map(async (kind) =>
      servicesFrom(
        resultsOf(await tmdb(`/watch/providers/${kind}?watch_region=${country}`, key, fetchImpl)),
        kind,
        country,
      ),
    ),
  );
  const fulfilled = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (!fulfilled.length) {
    throw (
      settled.find((result) => result.status === 'rejected')?.reason ?? new Error('TMDB failed')
    );
  }
  return { services: mergeServices(...fulfilled), complete: fulfilled.length === settled.length };
}

/**
 * One country's services for callers that do not render a partial/retry state.
 *
 * Shared (`reuse`): Home's service row, a tile's hover and the service page all ask for the same directory, and
 * each used to ask the network for it separately.
 */
export function fetchServices(
  country: string,
  key: string,
  fetchImpl = tmdbFetch,
): Promise<Service[]> {
  return reuse(
    `services:${country}`,
    async () => (await fetchServicesResult(country, key, fetchImpl)).services,
  );
}
