// Browse rows from atlas (`/index/row/<type>.json`): its labels' moods and subgenres, and its plot facets — how a story
// ends, when it is set, how it is told — alone or together. They cut across genre ("slow-burn and bleak" is a
// thriller, a western and a horror film) and say what TMDB's lists can't. Rows only: atlas describes a fraction of
// what it holds, so a row lists what it knows, and nothing here is ever used to hide a title. Subgenres the TMDB
// recipe rows already show (Heist, Zombie, Spy…) aren't repeated here.

import type { RowDef } from './catalog';
import type { MediaType, Title } from './library';
import { relayFetch } from './relayFetch';

const PAGE = 24;

type Where = Record<string, string>;
interface AtlasRow {
  id: string;
  title: string;
  where: Where;
}

/** A card score from atlas. Sidecars published before ratings simply omit it. */
const ratingOf = (value: unknown): number | undefined => {
  const rating = typeof value === 'number' ? value : NaN;
  return Number.isFinite(rating) && rating > 0 ? rating : undefined;
};

const mood = (label: string): Where => ({ mood: label });
const subgenre = (label: string): Where => ({ subgenre: label });

/**
 * The film rows, strongest first: moods and subgenres from the labels, which know every film, among the plot facets,
 * which know a few thousand — endings, eras and the shape of the telling are the axes they are surest of, pacing only
 * in pairs with a tone.
 */
const FILM_ROWS: AtlasRow[] = [
  { id: 'mood-mind-bending', title: 'Mind-Bending', where: mood('Mind-bending') },
  { id: 'plot-bittersweet', title: 'Bittersweet Endings', where: { ending: 'bittersweet' } },
  { id: 'mood-feel-good', title: 'Feel-Good Movies', where: mood('Feel-good') },
  {
    id: 'plot-slow-bleak',
    title: 'Slow-Burn and Bleak',
    where: { pacing: 'slow-burn', tone: 'bleak' },
  },
  {
    id: 'subgenre-psychological-thriller',
    title: 'Psychological Thrillers',
    where: subgenre('Psychological Thriller'),
  },
  { id: 'mood-twist-ending', title: 'Twist Endings', where: mood('Twist-ending') },
  { id: 'plot-nonlinear', title: 'Told Out of Order', where: { structure: 'nonlinear' } },
  { id: 'mood-tearjerker', title: 'Tearjerkers', where: mood('Tearjerker') },
  {
    id: 'subgenre-supernatural-horror',
    title: 'Supernatural Horror',
    where: subgenre('Supernatural Horror'),
  },
  { id: 'plot-ambiguous', title: 'Endings Left for You to Decide', where: { ending: 'ambiguous' } },
  { id: 'mood-quirky', title: 'Quirky and Offbeat', where: mood('Quirky/Offbeat') },
  { id: 'subgenre-dark-comedy', title: 'Dark Comedies', where: subgenre('Dark Comedy') },
  { id: 'plot-framed', title: 'Stories Within Stories', where: { structure: 'framed' } },
  { id: 'mood-visually-stunning', title: 'Visually Stunning', where: mood('Visually-stunning') },
  { id: 'subgenre-whodunit', title: 'Whodunits', where: subgenre('Whodunit/Murder Mystery') },
  {
    id: 'plot-slow-melancholy',
    title: 'Slow-Burn and Melancholy',
    where: { pacing: 'slow-burn', tone: 'melancholy' },
  },
  { id: 'subgenre-art-house', title: 'Art House', where: subgenre('Art House') },
  { id: 'plot-single-day', title: 'Over a Single Day', where: { structure: 'single-day' } },
  { id: 'mood-thought-provoking', title: 'Thought-Provoking', where: mood('Thought-provoking') },
  { id: 'plot-person-vs-nature', title: 'Against Nature', where: { conflict: 'person-vs-nature' } },
  { id: 'plot-tragic', title: 'Tragic Endings', where: { ending: 'tragic' } },
  { id: 'subgenre-neo-noir', title: 'Neo-Noir', where: subgenre('Neo-Noir') },
  { id: 'plot-19th-century', title: 'Set in the 19th Century', where: { era: '19th-century' } },
  { id: 'subgenre-cult', title: 'Cult Classics', where: subgenre('Cult') },
  { id: 'plot-near-future', title: 'Set in the Near Future', where: { era: 'near-future' } },
  { id: 'subgenre-survival', title: 'Survival', where: subgenre('Survival') },
  { id: 'plot-single-location', title: 'All in One Place', where: { scope: 'single-location' } },
  { id: 'subgenre-political', title: 'Political Movies', where: subgenre('Political') },
  { id: 'plot-satirical', title: 'Satire', where: { tone: 'satirical' } },
  { id: 'subgenre-folk-horror', title: 'Folk Horror', where: subgenre('Folk Horror') },
  { id: 'plot-road', title: 'On the Road', where: { setting: 'road' } },
  { id: 'subgenre-found-footage', title: 'Found Footage', where: subgenre('Found Footage') },
  { id: 'plot-space', title: 'Set in Space', where: { setting: 'space' } },
  { id: 'subgenre-body-horror', title: 'Body Horror', where: subgenre('Body Horror') },
  { id: 'plot-dreamlike', title: 'Dreamlike', where: { tone: 'dreamlike' } },
  { id: 'subgenre-giallo', title: 'Giallo', where: subgenre('Giallo') },
  { id: 'plot-medieval', title: 'Medieval', where: { era: 'medieval' } },
  { id: 'mood-cozy', title: 'Cozy', where: mood('Cozy') },
];

/** The series rows: the labels alone, since the plot facets describe too few series yet to fill a row. */
const SERIES_ROWS: AtlasRow[] = [
  { id: 'mood-bingeable', title: 'Bingeable', where: mood('Bingeable') },
  { id: 'mood-dark-gritty', title: 'Dark and Gritty Series', where: mood('Dark & Gritty') },
  { id: 'mood-feel-good', title: 'Feel-Good Series', where: mood('Feel-good') },
  { id: 'subgenre-whodunit', title: 'Whodunits', where: subgenre('Whodunit/Murder Mystery') },
  { id: 'mood-mind-bending', title: 'Mind-Bending', where: mood('Mind-bending') },
  {
    id: 'subgenre-period-drama',
    title: 'Period Dramas',
    where: subgenre('Historical/Period Drama'),
  },
  { id: 'mood-quirky', title: 'Quirky and Offbeat', where: mood('Quirky/Offbeat') },
  {
    id: 'subgenre-psychological-thriller',
    title: 'Psychological Thrillers',
    where: subgenre('Psychological Thriller'),
  },
  { id: 'mood-tense', title: 'Edge of Your Seat', where: mood('Tense/Edge-of-seat') },
  {
    id: 'subgenre-police-procedural',
    title: 'Police Procedurals',
    where: subgenre('Police Procedural'),
  },
  { id: 'mood-comfort-watch', title: 'Comfort Watches', where: mood('Comfort-watch') },
  { id: 'subgenre-dark-comedy', title: 'Dark Comedies', where: subgenre('Dark Comedy') },
  { id: 'mood-slow-burn', title: 'Slow-Burn Series', where: mood('Slow-burn') },
  { id: 'subgenre-superhero', title: 'Superhero Series', where: subgenre('Superhero') },
  { id: 'mood-thought-provoking', title: 'Thought-Provoking', where: mood('Thought-provoking') },
  { id: 'subgenre-spy', title: 'Spy and Espionage', where: subgenre('Spy/Espionage') },
  { id: 'mood-wholesome', title: 'Wholesome', where: mood('Wholesome') },
  { id: 'subgenre-medical-drama', title: 'Medical Dramas', where: subgenre('Medical Drama') },
  { id: 'subgenre-coming-of-age', title: 'Coming-of-Age', where: subgenre('Coming-of-Age') },
  { id: 'subgenre-time-travel', title: 'Time Travel', where: subgenre('Time Travel') },
  { id: 'mood-tearjerker', title: 'Tearjerkers', where: mood('Tearjerker') },
  { id: 'subgenre-serial-killer', title: 'Serial Killers', where: subgenre('Serial Killer') },
  { id: 'subgenre-political', title: 'Political Series', where: subgenre('Political') },
  { id: 'subgenre-legal', title: 'Legal Dramas', where: subgenre('Legal/Courtroom Drama') },
  { id: 'mood-cozy', title: 'Cozy', where: mood('Cozy') },
  { id: 'subgenre-dystopian', title: 'Dystopian', where: subgenre('Dystopian/Post-Apocalyptic') },
  { id: 'mood-visually-stunning', title: 'Visually Stunning', where: mood('Visually-stunning') },
  {
    id: 'subgenre-supernatural-horror',
    title: 'Supernatural Horror',
    where: subgenre('Supernatural Horror'),
  },
  { id: 'subgenre-narco', title: 'Narco Series', where: subgenre('Narco') },
  { id: 'subgenre-mockumentary', title: 'Mockumentaries', where: subgenre('Mockumentary') },
];

/** One of atlas's rows as titles. */
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
        rating: ratingOf(t.rating),
        genreIds: Array.isArray(t.genreIds)
          ? t.genreIds.filter((g): g is number => typeof g === 'number')
          : undefined,
        originalLanguage: typeof t.originalLanguage === 'string' ? t.originalLanguage : undefined,
        imdbId: typeof t.imdbId === 'string' ? t.imdbId : undefined,
      },
    ];
  });
}

/** atlas's rows for a browse screen of `type`, from atlas at `base`. */
export function atlasRows(
  base: string,
  type: MediaType,
  fetchImpl: typeof fetch = relayFetch,
): RowDef[] {
  const path = type === 'tv' ? 'series' : 'movie';
  return (type === 'tv' ? SERIES_ROWS : FILM_ROWS).map(({ id, title, where }) => ({
    id: `atlas-${id}-${type}`,
    title,
    load: async (page) => {
      const query = new URLSearchParams({
        ...where,
        skip: String((page - 1) * PAGE),
        limit: String(PAGE),
      });
      const res = await fetchImpl(`${base}/index/row/${path}.json?${query}`);
      if (!res.ok) throw new Error(`atlas answered ${res.status}`);
      return titlesOf(await res.json());
    },
  }));
}
