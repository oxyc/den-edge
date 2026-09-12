// Den's own addons among the library's plugins (`set:plugins`), and where this page asks them. An install URL is
// Den's when it is on one of the routes table's entries for that service (den-spec routes-v1): the LAN address, the
// tailnet path or the public name. This page asks it under its own origin — `/scout`, `/atlas` — which den-edge relays
// on the public name and tailscale serve serves on the tailnet, with the install's config segment after it. An addon
// that is not Den's is never sent anything.

import type { MediaType, Title } from './library';
import { within, type Routes } from './routes';

export interface Addon {
  /** The install URL as the library holds it, without `/manifest.json`: what den-remux takes. */
  install: string;
  /** Where this page asks it. */
  base: string;
}

export const SCOUT = { name: 'scout', id: 'com.den.scout', path: '/scout' };
export const ATLAS = { name: 'atlas', id: 'com.den.atlas', path: '/atlas' };
export const REEL = { name: 'reel', id: 'com.den.reel', path: '/reel' };

const MANIFEST = '/manifest.json';

/** Where this page would ask the plugin at `url`, when it is the service `want` names; null otherwise. */
function place(url: string, routes: Routes, want: { name: string; path: string }): Addon | null {
  if (!url.endsWith(MANIFEST)) return null;
  const install = url.slice(0, -MANIFEST.length);
  const config = within(install, routes[want.name]);
  return config !== null && /^(\/[\w.~%-]+)?$/.test(config) ? { install, base: want.path + config } : null;
}

async function manifestIs(manifest: string, id: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(manifest);
    return res.ok && ((await res.json()) as { id?: unknown }).id === id;
  } catch {
    return false; // out of reach, or not an addon at all
  }
}

/** The first of the library's plugins that is the service `want` names, confirmed by its manifest. */
export async function findAddon(
  plugins: string[],
  routes: Routes,
  want: { name: string; id: string; path: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Addon | null> {
  for (const url of plugins) {
    const addon = place(url, routes, want);
    if (addon && (await manifestIs(`${addon.base}${MANIFEST}`, want.id, fetchImpl))) return addon;
  }
  return null;
}

/** atlas: a plugin, or — where this origin serves one — the box's own, which the library need not list. */
export async function findAtlas(plugins: string[], routes: Routes, fetchImpl: typeof fetch = fetch): Promise<Addon | null> {
  const plugin = await findAddon(plugins, routes, ATLAS, fetchImpl);
  if (plugin) return plugin;
  const here = await manifestIs(`${ATLAS.path}${MANIFEST}`, ATLAS.id, fetchImpl);
  return here ? { install: ATLAS.path, base: ATLAS.path } : null;
}

/** Den's own addons, as Settings names them. */
const DEN_ADDONS = [
  { name: 'scout', label: 'Den Scout', role: 'Streams' },
  { name: 'subs', label: 'Den Subtitles', role: 'Subtitles' },
  { name: 'atlas', label: 'Den Atlas', role: 'Discovery' },
  { name: 'reel', label: 'Den Reel', role: 'Trailers' },
];

/** Which of Den's addons the plugin at `url` is, by the routes table's entries; null for anyone else's. */
export function denAddonOf(url: string, routes: Routes): { label: string; role: string } | null {
  const install = url.endsWith(MANIFEST) ? url.slice(0, -MANIFEST.length) : url;
  return DEN_ADDONS.find((addon) => within(install, routes[addon.name]) !== null) ?? null;
}

/** The titles in one of atlas's catalogs, by TMDB id — the rest (backdrop, plot, genres) comes from TMDB. */
function catalogTitles(body: unknown, type: MediaType): Title[] {
  const metas = (body as { metas?: unknown } | null)?.metas;
  if (!Array.isArray(metas)) return [];
  return (metas as Record<string, unknown>[]).flatMap((meta) => {
    const year = Number.parseInt(String(meta.releaseInfo ?? ''), 10);
    if (typeof meta.moviedb_id !== 'number' || typeof meta.name !== 'string') return [];
    return [{ type, id: meta.moviedb_id, title: meta.name, year: Number.isFinite(year) ? year : undefined }];
  });
}

/**
 * atlas's "Trending Everywhere" (`jw-trending`) — the catalog the TV's Movies and Series billboards lead with.
 * Both types, interleaved so neither buries the other. Empty when atlas is out of reach, which leaves the caller
 * to fall back rather than showing nothing.
 */
export async function trendingEverywhere(
  base: string,
  fetchImpl: typeof fetch = fetch,
  only?: MediaType,
): Promise<Title[]> {
  const load = async (type: 'movie' | 'series'): Promise<Title[]> => {
    if (only && only !== (type === 'series' ? 'tv' : 'movie')) return [];
    try {
      const res = await fetchImpl(`${base}/catalog/${type}/jw-trending.json`);
      return res.ok ? catalogTitles(await res.json(), type === 'series' ? 'tv' : 'movie') : [];
    } catch {
      return [];
    }
  };
  const [movies, series] = await Promise.all([load('movie'), load('series')]);
  return Array.from({ length: Math.max(movies.length, series.length) }, (_, i) => [movies[i], series[i]])
    .flat()
    .filter((title): title is Title => title !== undefined);
}

/** One of atlas's catalogs, as its manifest lists them. */
interface CatalogEntry {
  type: string;
  id: string;
  denProviderId?: number;
  denProviderIds?: number[];
}

/**
 * The catalogs of newly-added titles worth asking for.
 *
 * An install's own manifest already lists only the services that install was configured with — this household's
 * atlas offers Netflix, Disney+ and Apple TV+ where the bare addon offers fourteen — so with no picks to go on,
 * every "new on" catalog it advertises is one of theirs, and the install's own region answers for the country.
 * Picks, when the TV has synced some, narrow it further and name the country outright, since the same provider
 * in two countries is two different catalogs.
 */
function arrivalCatalogs(manifest: unknown, picks: { id: number; country: string }[]): { path: string; type: MediaType }[] {
  const catalogs = (manifest as { catalogs?: unknown } | null)?.catalogs;
  if (!Array.isArray(catalogs)) return [];
  const wanted: { path: string; type: MediaType }[] = [];
  for (const raw of catalogs as CatalogEntry[]) {
    // "New on <service>", not "Popular on <service>": what changed is the point, not what is always there.
    if (typeof raw?.id !== 'string' || !raw.id.endsWith('-new')) continue;
    const type: MediaType = raw.type === 'series' ? 'tv' : 'movie';
    if (picks.length === 0) {
      wanted.push({ path: `/catalog/${raw.type}/${raw.id}.json`, type });
      continue;
    }
    const providers = raw.denProviderIds ?? (raw.denProviderId === undefined ? [] : [raw.denProviderId]);
    for (const pick of picks.filter((p) => providers.includes(p.id))) {
      wanted.push({ path: `/catalog/${raw.type}/${raw.id}/country=${encodeURIComponent(pick.country)}.json`, type });
    }
  }
  return wanted;
}

/**
 * What has newly arrived on the services this library has, from atlas's JustWatch catalogs — a 1997 film that
 * landed on Netflix yesterday is new to watch however old it is, which is a different thing from a new release
 * and the one a billboard most wants to say. Empty when no service is picked, or atlas can't be reached.
 */
export async function arrivals(
  base: string,
  picks: { id: number; country: string }[] = [],
  fetchImpl: typeof fetch = fetch,
  most = 8,
): Promise<Title[][]> {
  try {
    const res = await fetchImpl(`${base}${MANIFEST}`);
    if (!res.ok) return [];
    const lists = arrivalCatalogs(await res.json(), picks).slice(0, most);
    return await Promise.all(
      lists.map(async ({ path, type }) => {
        try {
          const answer = await fetchImpl(`${base}${path}`);
          return answer.ok ? catalogTitles(await answer.json(), type) : [];
        } catch {
          return [];
        }
      }),
    );
  } catch {
    return [];
  }
}

/** The library's installs of the service `name` (den-subtitles, for den-remux), without their manifest file. */
export function installsOf(plugins: string[], routes: Routes, name: string): string[] {
  return plugins.flatMap((url) => {
    if (!url.endsWith(MANIFEST)) return [];
    const install = url.slice(0, -MANIFEST.length);
    return within(install, routes[name]) === null ? [] : [install];
  });
}
