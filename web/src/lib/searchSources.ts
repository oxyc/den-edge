// Where search's answers come from on the web: TMDB with the companion page's key, and atlas — the TV's on-device
// title, facet and embedding indexes, served over the tailnet at /atlas (tailscale serve strips the prefix).

import type { MediaType, Title } from './library';
import type { FacetAnswer, Hit, Ref, SearchSources } from './search';
import { fetchTitle, toTitle } from './tmdb';

const TMDB = 'https://api.themoviedb.org/3';

type Json = Record<string, unknown>;

const records = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

/** atlas names a series `series`; Den says `tv`. */
function refs(value: unknown): Ref[] {
  return records(value).flatMap((r) => {
    const type = r.type === 'series' || r.type === 'tv' ? 'tv' : r.type === 'movie' ? 'movie' : undefined;
    return type && typeof r.id === 'number' ? [{ type, id: r.id }] : [];
  });
}

function titles(body: Json, type: MediaType): Title[] {
  return records(body.results).flatMap((r) => {
    const title = typeof r.id === 'number' ? toTitle({ type, id: r.id }, r) : null;
    return title ? [title] : [];
  });
}

/** Talk-show "Self" spots and one-off TV guest roles: the title is popular, the person's part in it isn't. */
function isCameo(credit: Json): boolean {
  const role = typeof credit.character === 'string' ? credit.character.toLowerCase() : undefined;
  if (role !== undefined && (role === 'self' || role.startsWith('self ') || role.startsWith('self-') ||
    ['himself', 'herself', 'themselves'].includes(role))) {
    return true;
  }
  return credit.media_type === 'tv' && typeof credit.episode_count === 'number' && credit.episode_count < 3;
}

const notability = (credit: Json) =>
  Math.sqrt((typeof credit.popularity === 'number' ? credit.popularity : 0) *
    Math.max(1, typeof credit.vote_count === 'number' ? credit.vote_count : 0));

export function searchSources(tmdbKey: string, fetchImpl: typeof fetch = fetch, atlas = '/atlas'): SearchSources {
  const cache = new Map<string, Promise<Title | null>>();

  async function tmdb(path: string, params: Record<string, string> = {}): Promise<Json> {
    const url = new URL(TMDB + path);
    for (const [name, value] of Object.entries({ ...params, api_key: tmdbKey })) url.searchParams.set(name, value);
    const res = await fetchImpl(url.toString());
    if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
    return (await res.json()) as Json;
  }

  async function fromAtlas(path: string): Promise<Json> {
    const res = await fetchImpl(atlas + path);
    if (!res.ok) throw new Error(`atlas answered ${res.status}`);
    return (await res.json()) as Json;
  }

  return {
    // One catalog per type, each ranked; interleaved, so neither type buries the other. The exact title still
    // leads later (`promoteExact`).
    async titles(query) {
      const search = (type: 'movie' | 'series') =>
        fromAtlas(`/catalog/${type}/den-titles/search=${encodeURIComponent(query)}.json`)
          .then((body) =>
            records(body.metas).flatMap((m): Ref[] =>
              typeof m.moviedb_id === 'number' ? [{ type: type === 'series' ? 'tv' : 'movie', id: m.moviedb_id }] : [],
            ),
          )
          .catch((): Ref[] => []);
      const [movies, series] = await Promise.all([search('movie'), search('series')]);
      return Array.from({ length: Math.max(movies.length, series.length) }, (_, i) => [movies[i], series[i]])
        .flat()
        .filter((ref): ref is Ref => ref !== undefined);
    },

    async multi(query) {
      const body = await tmdb('/search/multi', { query, include_adult: 'false' });
      return records(body.results).flatMap((r): Hit[] => {
        if (typeof r.id !== 'number') return [];
        if (r.media_type === 'person' && typeof r.name === 'string') {
          const profilePath = typeof r.profile_path === 'string' ? r.profile_path : undefined;
          return [{ kind: 'person', person: { id: r.id, name: r.name, profilePath } }];
        }
        const title = r.media_type === 'movie' || r.media_type === 'tv' ? toTitle({ type: r.media_type, id: r.id }, r) : null;
        return title ? [{ kind: 'title', title }] : [];
      });
    },

    async byYear(query, year) {
      const [movies, series] = await Promise.all([
        tmdb('/search/movie', { query, year: String(year) }).catch((): Json => ({})),
        tmdb('/search/tv', { query, first_air_date_year: String(year) }).catch((): Json => ({})),
      ]);
      return [...titles(movies, 'movie'), ...titles(series, 'tv')];
    },

    // Acting roles minus cameos, plus what they directed or wrote — not producer credits, which surface titles
    // the person isn't in. The TV's `notableFilms`.
    async notableFilms(personId) {
      const body = await tmdb(`/person/${personId}/combined_credits`);
      const authored = records(body.crew).filter((c) => c.job === 'Director' || c.job === 'Writer');
      const ranked = [...records(body.cast).filter((c) => !isCameo(c)), ...authored].sort(
        (a, b) => notability(b) - notability(a),
      );
      const seen = new Set<string>();
      return ranked.flatMap((c) => {
        if ((c.media_type !== 'movie' && c.media_type !== 'tv') || typeof c.id !== 'number') return [];
        const title = toTitle({ type: c.media_type, id: c.id }, c);
        if (!title || seen.has(`${title.type}-${title.id}`)) return [];
        seen.add(`${title.type}-${title.id}`);
        return [title];
      });
    },

    async semantic(query) {
      return refs((await fromAtlas(`/index/search.json?q=${encodeURIComponent(query)}`)).titles);
    },

    async facets(query): Promise<FacetAnswer> {
      const body = await fromAtlas(`/index/facets.json?q=${encodeURIComponent(query)}`);
      const facet = body.facet && typeof body.facet === 'object' ? (body.facet as Json) : null;
      const type = facet?.mediaType;
      return {
        facet: facet && {
          mediaType: type === 'series' || type === 'tv' ? 'tv' : type === 'movie' ? 'movie' : null,
          country: typeof facet.country === 'string' ? facet.country : null,
          decade: typeof facet.decade === 'number' ? facet.decade : null,
          leftover: typeof facet.leftover === 'string' ? facet.leftover : '',
        },
        titles: refs(body.titles),
      };
    },

    async similar(ref) {
      const body = await fromAtlas(`/index/similar/${ref.type === 'tv' ? 'series' : 'movie'}/${ref.id}.json`);
      return (Array.isArray(body.ids) ? body.ids : [])
        .filter((id): id is number => typeof id === 'number')
        .map((id) => ({ type: ref.type, id }));
    },

    // One detail fetch per title per visit: popular titles recur across queries.
    title(ref) {
      const key = `${ref.type}-${ref.id}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = fetchTitle(ref, tmdbKey, fetchImpl);
        cache.set(key, pending);
      }
      return pending;
    },
  };
}
