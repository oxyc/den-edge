// Browse rows from atlas's plot facets (`/index/plot/<type>.json`): how a story ends, when it is set, how it is told —
// axes read from Wikipedia plots that cut across genre ("slow-burn and bleak" is a thriller, a western and a horror
// film). Rows only: atlas describes a fraction of what it holds, so a row lists what it knows, and nothing here is ever
// used to hide a title.

import type { RowDef } from './catalog';
import type { MediaType, Title } from './library';

const PAGE = 24;

/**
 * The film rows, strongest axes first. Series aren't here: the facets describe too few of them yet to fill a row.
 * Endings, eras and the shape of the telling are the axes the facets are surest of; pacing only in pairs with a tone.
 */
const FILM_ROWS: { id: string; title: string; where: Record<string, string> }[] = [
  { id: 'plot-bittersweet', title: 'Bittersweet Endings', where: { ending: 'bittersweet' } },
  {
    id: 'plot-slow-bleak',
    title: 'Slow-Burn and Bleak',
    where: { pacing: 'slow-burn', tone: 'bleak' },
  },
  { id: 'plot-nonlinear', title: 'Told Out of Order', where: { structure: 'nonlinear' } },
  { id: 'plot-ambiguous', title: 'Endings Left for You to Decide', where: { ending: 'ambiguous' } },
  { id: 'plot-framed', title: 'Stories Within Stories', where: { structure: 'framed' } },
  {
    id: 'plot-slow-melancholy',
    title: 'Slow-Burn and Melancholy',
    where: { pacing: 'slow-burn', tone: 'melancholy' },
  },
  { id: 'plot-single-day', title: 'Over a Single Day', where: { structure: 'single-day' } },
  { id: 'plot-tragic', title: 'Tragic Endings', where: { ending: 'tragic' } },
  { id: 'plot-19th-century', title: 'Set in the 19th Century', where: { era: '19th-century' } },
  { id: 'plot-near-future', title: 'Set in the Near Future', where: { era: 'near-future' } },
  { id: 'plot-satirical', title: 'Satire', where: { tone: 'satirical' } },
];

/** One of atlas's plot rows as titles. */
function titlesOf(body: unknown): Title[] {
  const titles = (body as { titles?: unknown } | null)?.titles;
  if (!Array.isArray(titles)) return [];
  return (titles as Record<string, unknown>[]).flatMap((t): Title[] => {
    const type = t.type === 'series' ? 'tv' : t.type === 'movie' ? 'movie' : null;
    if (!type || typeof t.id !== 'number' || typeof t.title !== 'string') return [];
    return [
      {
        type,
        id: t.id,
        title: t.title,
        posterPath: typeof t.posterPath === 'string' ? t.posterPath : undefined,
        year: typeof t.year === 'number' ? t.year : undefined,
        genreIds: Array.isArray(t.genreIds)
          ? t.genreIds.filter((g): g is number => typeof g === 'number')
          : undefined,
        originalLanguage: typeof t.originalLanguage === 'string' ? t.originalLanguage : undefined,
      },
    ];
  });
}

/** The plot rows for a browse screen of `type`, from atlas at `base`. */
export function plotRows(base: string, type: MediaType, fetchImpl: typeof fetch = fetch): RowDef[] {
  if (type !== 'movie') return [];
  return FILM_ROWS.map(({ id, title, where }) => ({
    id,
    title,
    load: async (page) => {
      const query = new URLSearchParams({
        ...where,
        skip: String((page - 1) * PAGE),
        limit: String(PAGE),
      });
      const res = await fetchImpl(`${base}/index/plot/movie.json?${query}`);
      if (!res.ok) throw new Error(`atlas answered ${res.status}`);
      return titlesOf(await res.json());
    },
  }));
}
