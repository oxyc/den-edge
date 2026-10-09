// Page adapter from the import planners' semantic lookup interface to the typed content Worker. Provider URLs,
// credentials, retry pacing and concurrency stay inside ContentImportAuthority.

import type { ContentServiceClientPort } from './contentServiceClient';
import type { ContentImportLookup, ContentImportLookupResult } from './contentServiceProtocol';
import type { ImportShow, ViewingLookups } from './viewingImport';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type ContentImportLookupWithoutId = WithoutId<ContentImportLookup>;

export function contentImportLookups(content: ContentServiceClientPort): ViewingLookups {
  let serial = 0;
  const resolve = async (
    lookup: ContentImportLookupWithoutId,
  ): Promise<ContentImportLookupResult['value']> => {
    const id = `import-${++serial}`;
    const answer = await content.query({
      kind: 'import.resolve',
      lookups: [{ ...lookup, id } as ContentImportLookup],
    });
    return answer.results.find((result) => result.id === id)?.value ?? { kind: 'missing' };
  };

  const search = async (query: string, media?: 'movie' | 'tv', page?: number) => {
    const value = await resolve({ kind: 'search', query, media, page });
    return value.kind === 'search' ? value.hits : [];
  };

  const translations = async (type: 'movie' | 'tv', id: number, field: 'title' | 'overview') => {
    const value = await resolve({ kind: 'translations', title: { type, id }, field });
    return value.kind === 'translations' ? value.values : [];
  };

  return {
    searchMulti: (query) => search(query),
    searchTv: (query) => search(query, 'tv'),
    searchMovie: (query, page) => search(query, 'movie', page),
    show: async (id) => {
      const value = await resolve({ kind: 'series-shape', title: { type: 'tv', id } });
      if (value.kind !== 'series-shape') return null;
      return {
        counts: new Map(value.seasons.map(({ season, episodes }) => [season, episodes])),
        seasonNames: new Map(
          value.seasons.flatMap(({ season, name }): [number, string][] =>
            name ? [[season, name]] : [],
          ),
        ),
        ...(value.lastAired ? { lastAired: value.lastAired } : {}),
      } satisfies ImportShow;
    },
    episodes: async (id, season) => {
      const value = await resolve({
        kind: 'episodes',
        title: { type: 'tv', id },
        season,
      });
      return value.kind === 'episodes' ? value.episodes : null;
    },
    translatedTitles: (type, id) => translations(type, id, 'title'),
    translatedOverviews: (type, id) => translations(type, id, 'overview'),
    runtime: async (type, id) => {
      const value = await resolve({ kind: 'runtime', title: { type, id } });
      return value.kind === 'runtime' ? value.minutes : null;
    },
  };
}
