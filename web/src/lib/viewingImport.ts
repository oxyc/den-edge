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
  /** Runtime in minutes; used when a provider reports watch time but not the title's duration. */
  runtime?(type: 'movie' | 'tv', id: number): Promise<number | null>;
}

export interface ViewingEpisode {
  number: number;
  name: string;
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
