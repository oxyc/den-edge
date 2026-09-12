// Den Web's pages live in the URL's fragment, so Back works and a page can be linked. Not paths: a path is
// den-edge's to answer.

import type { MediaType } from './library';

export type Route =
  | { page: 'library' }
  | { page: 'movies' }
  | { page: 'series' }
  | { page: 'settings' }
  | { page: 'search' }
  | { page: 'title'; type: MediaType; id: number }
  | { page: 'person'; id: number };

const positive = (text: string | undefined) => {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export function parseRoute(hash: string): Route {
  const [page, ...rest] = hash.replace(/^#/, '').split('/');
  if (page === 'settings' || page === 'movies' || page === 'series' || page === 'search') return { page };
  const type = rest[0];
  const titleId = positive(rest[1]);
  if (page === 'title' && (type === 'movie' || type === 'tv') && titleId) return { page: 'title', type, id: titleId };
  const personId = positive(rest[0]);
  if (page === 'person' && personId) return { page: 'person', id: personId };
  return { page: 'library' };
}

export const titleHref = (title: { type: MediaType; id: number }) => `#title/${title.type}/${title.id}`;
export const personHref = (id: number) => `#person/${id}`;
