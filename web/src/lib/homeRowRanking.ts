import type { MediaType, Title } from './library';

export interface HomeRowAffinity {
  /** Rows with the same group are gently spread near the top; no group is ever removed. */
  group: string;
  refs?: Array<{ type: MediaType; id: number }>;
  genres?: number[];
  decades?: number[];
  languages?: string[];
  countries?: string[];
}

export interface HomeTasteTitle {
  title: Title;
  weight: number;
  updatedAt: number;
}

type RankableRow = { affinity?: HomeRowAffinity };

const key = ({ type, id }: { type: MediaType; id: number }) => `${type}:${id}`;

function score(affinity: HomeRowAffinity, taste: readonly HomeTasteTitle[], now: number): number {
  const refs = new Set((affinity.refs ?? []).map(key));
  const genres = new Set(affinity.genres ?? []);
  const decades = new Set(affinity.decades ?? []);
  const languages = new Set(affinity.languages ?? []);
  const countries = new Set(affinity.countries ?? []);
  let total = 0;
  for (const entry of taste) {
    if (!Number.isFinite(entry.weight) || entry.weight === 0) continue;
    const ageDays = Math.max(0, now - entry.updatedAt) / 86_400_000;
    const recency = 2 ** (-ageDays / 120);
    const title = entry.title;
    let match = refs.has(key(title)) ? 12 : 0;
    if (title.genreIds?.some((id) => genres.has(id))) match += 2.5;
    if (title.year !== undefined && decades.has(Math.floor(title.year / 10) * 10)) match += 1.75;
    if (title.originalLanguage && languages.has(title.originalLanguage)) match += 1.25;
    if (title.countries?.some((country) => countries.has(country))) match += 1;
    total += match * entry.weight * recency;
  }
  return total;
}

/**
 * Reorder only the rows which opt into affinity ranking, leaving fixed shelves in their exact slots. Every row is
 * returned exactly once. With no useful profile signal this returns the original array unchanged.
 */
export function rankHomeRows<T extends RankableRow>(
  rows: readonly T[],
  taste: readonly HomeTasteTitle[],
  now = Date.now(),
): T[] {
  if (!taste.length) return [...rows];
  const candidates = rows.flatMap((row, index) =>
    row.affinity
      ? [{ row, index, affinity: row.affinity, score: score(row.affinity, taste, now) }]
      : [],
  );
  if (!candidates.some((candidate) => candidate.score !== 0)) return [...rows];

  const remaining = [...candidates];
  const ranked: T[] = [];
  const groups = new Map<string, number>();
  const scale = Math.max(1, ...remaining.map((candidate) => Math.abs(candidate.score)));
  while (remaining.length) {
    let best = 0;
    for (let at = 1; at < remaining.length; at++) {
      const utility = (candidate: (typeof remaining)[number]) =>
        candidate.score - (groups.get(candidate.affinity.group) ?? 0) * scale * 0.08;
      const left = remaining[at]!;
      const right = remaining[best]!;
      if (
        utility(left) > utility(right) ||
        (utility(left) === utility(right) && left.index < right.index)
      )
        best = at;
    }
    const [picked] = remaining.splice(best, 1);
    ranked.push(picked!.row);
    groups.set(picked!.affinity.group, (groups.get(picked!.affinity.group) ?? 0) + 1);
  }

  let next = 0;
  return rows.map((row) => (row.affinity ? ranked[next++]! : row));
}
