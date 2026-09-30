import type { Shape } from './library';

/** A film or episode resolved to Den's TMDB identity, at the provider's last completed-viewing time. */
export interface ViewingMark {
  type: 'movie' | 'tv';
  id: number;
  name: string;
  year?: number;
  /** What the provider called the film or series. */
  source: string;
  season?: number;
  episode?: number;
  at: number;
}

export type ImportShow = Shape & { seasonNames?: Map<number, string> };

export interface ViewingImportPlan {
  marks: ViewingMark[];
  shows: Record<number, ImportShow>;
  unmatched: string[];
  undated: number;
  known: number;
  covered: number;
}

export interface ViewingLookups {
  searchMulti(query: string): Promise<ViewingSearchHit[]>;
  searchTv(query: string): Promise<ViewingSearchHit[]>;
  searchMovie?(query: string, page: number): Promise<ViewingSearchHit[]>;
  show(id: number): Promise<ImportShow | null>;
  episodes(id: number, season: number): Promise<ViewingEpisode[] | null>;
  /** Localized titles TMDB knows for a title; used to validate provider translations. */
  translatedTitles?(type: 'movie' | 'tv', id: number): Promise<string[]>;
  /** Localized summaries TMDB knows for a title; used only to break otherwise ambiguous film matches. */
  translatedOverviews?(type: 'movie' | 'tv', id: number): Promise<string[]>;
  /** Runtime in minutes; used when a provider reports watch time but not the title's duration. */
  runtime?(type: 'movie' | 'tv', id: number): Promise<number | null>;
}

export interface ViewingEpisode {
  number: number;
  name: string;
  overview?: string;
  runtime?: number;
  airDate?: string;
}

export interface ViewingSearchHit {
  type: 'movie' | 'tv';
  id: number;
  name: string;
  originalName?: string;
  year?: number;
}

const LIGATURES: Record<string, string> = {
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ß: 'ss',
  ð: 'd',
  þ: 'th',
  ł: 'l',
};

/** Provider title text normalized for matching: letters and numbers remain; accents and punctuation do not. */
export function normalizeViewingName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[æœøßðþł]/g, (letter) => LIGATURES[letter]!)
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const VIEWING_NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  hundred: '100',
  thousand: '1000',
};

const VIEWING_ROMAN: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

/** A provider film title for comparison with TMDB, ignoring articles and equivalent number spelling. */
export const viewingFilmKey = (name: string) =>
  normalizeViewingName(name)
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\bvol\b/g, 'volume')
    .replace(/\b(volume|part|chapter) ([ivx]+)\b/g, (whole, word: string, numeral: string) =>
      VIEWING_ROMAN[numeral] ? `${word} ${VIEWING_ROMAN[numeral]}` : whole,
    )
    .trim()
    .split(/\s+/)
    .map((word) => VIEWING_NUMBER_WORDS[word] ?? word)
    .join(' ');

/** Provider history rows that advertise content rather than record a film or episode. */
export const isViewingPreview = (title: string) =>
  /(?:^|: )[^:]*\b(?:(?:official|main)\s+)?(?:trailer|teaser)(?:\s+(?:official|oficial|\d+))?(?::|$)/i.test(
    title,
  ) ||
  /\bbande[- ]annonce\b/i.test(title) ||
  /_hook_|_16x9\b/i.test(title);

export interface ViewingPreviewLine {
  key: string;
  label: string;
  source?: string;
  episodes: number;
}

/** One preview line per resolved film or series, series first and then by TMDB name. */
export function viewingPreviewLines(marks: readonly ViewingMark[]): ViewingPreviewLine[] {
  const byKey = new Map<string, ViewingPreviewLine>();
  for (const mark of marks) {
    const key = `${mark.type}:${mark.id}`;
    const line = byKey.get(key);
    if (line) line.episodes++;
    else
      byKey.set(key, {
        key,
        label: mark.year ? `${mark.name} (${mark.year})` : mark.name,
        ...(normalizeViewingName(mark.source) !== normalizeViewingName(mark.name)
          ? { source: mark.source }
          : {}),
        episodes: mark.type === 'tv' ? 1 : 0,
      });
  }
  return [...byKey.values()].sort(
    (a, b) => Number(b.episodes > 0) - Number(a.episodes > 0) || a.label.localeCompare(b.label),
  );
}
