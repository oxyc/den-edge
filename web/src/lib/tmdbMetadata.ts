import type { Title } from './library';
import { hasLibraryCredential, relayFetch } from './relayFetch';

type Kind = 'movie' | 'tv';
interface Fields {
  rating?: number;
  voteCount?: number;
  posterPath?: string;
}
interface Observation {
  type: Kind;
  id: number;
  fields: Fields;
}
interface Observed<T> {
  value: T;
  observedAt: number;
}
interface Stored {
  type: Kind;
  id: number;
  source: 'tmdb';
  fields: {
    rating?: Observed<number>;
    voteCount?: Observed<number>;
    posterPath?: Observed<string>;
  };
}

const RETENTION_MS = 180 * 86_400_000;

const validKind = (value: unknown): value is Kind => value === 'movie' || value === 'tv';
const validPoster = (value: unknown): value is string =>
  typeof value === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..');
const validObserved = <T>(
  field: Observed<T> | undefined,
  value: (v: T) => boolean,
): field is Observed<T> =>
  field !== undefined &&
  Number.isFinite(field.observedAt) &&
  field.observedAt >= 0 &&
  field.observedAt <= Date.now() &&
  Date.now() - field.observedAt < RETENTION_MS &&
  value(field.value);

/** Allowlisted poster metadata contained in a TMDB answer the caller just received. */
export function metadataIn(path: string, body: string): Observation[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return [];
  }
  const fixed = path.split('/').find(validKind);
  const candidates: Record<string, unknown>[] = [];
  if (fixed && typeof parsed.id === 'number') candidates.push(parsed);
  if (Array.isArray(parsed.results))
    candidates.push(...(parsed.results as Record<string, unknown>[]));
  const found = new Map<string, Observation>();
  for (const item of candidates) {
    const type = fixed ?? (validKind(item.media_type) ? item.media_type : undefined);
    const id = item.id;
    if (!type || !Number.isInteger(id) || (id as number) <= 0) continue;
    const fields: Fields = {};
    if (
      typeof item.vote_average === 'number' &&
      Number.isFinite(item.vote_average) &&
      item.vote_average > 0 &&
      item.vote_average <= 10
    )
      fields.rating = item.vote_average;
    if (
      typeof item.vote_count === 'number' &&
      Number.isInteger(item.vote_count) &&
      item.vote_count >= 0
    )
      fields.voteCount = item.vote_count;
    if (validPoster(item.poster_path)) fields.posterPath = item.poster_path;
    if (Object.keys(fields).length) found.set(`${type}:${id}`, { type, id: id as number, fields });
  }
  return [...found.values()];
}

export function rememberTmdbMetadata(
  path: string,
  body: string,
  fetchImpl: typeof fetch = relayFetch,
): void {
  if (!hasLibraryCredential()) return;
  const entries = metadataIn(path, body);
  if (!entries.length) return;
  void fetchImpl('/metadata/tmdb', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  }).catch(() => undefined);
}

/** Fill missing poster fields from observations made by another paired client, in one bounded request. */
export async function withSharedTmdbMetadata(
  titles: Title[],
  fetchImpl: typeof fetch = relayFetch,
): Promise<Title[]> {
  const wanted = titles
    .filter(
      (title) =>
        !(typeof title.rating === 'number' && title.rating > 0) ||
        !(typeof title.votes === 'number' && title.votes >= 0) ||
        !title.posterPath,
    )
    .slice(0, 100);
  if (!wanted.length) return titles;
  try {
    const response = await fetchImpl('/metadata/tmdb/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ titles: wanted.map(({ type, id }) => ({ type, id })) }),
    });
    if (!response.ok) return titles;
    const answer = (await response.json()) as { entries?: Stored[] };
    const entries = new Map<string, Stored>();
    for (const entry of Array.isArray(answer.entries) ? answer.entries : []) {
      if (
        entry.source === 'tmdb' &&
        validKind(entry.type) &&
        Number.isInteger(entry.id) &&
        entry.id > 0
      )
        entries.set(`${entry.type}:${entry.id}`, entry);
    }
    return titles.map((title) => {
      const fields = entries.get(`${title.type}:${title.id}`)?.fields;
      if (!fields) return title;
      const rating = validObserved(fields.rating, (v) => Number.isFinite(v) && v > 0 && v <= 10)
        ? fields.rating.value
        : undefined;
      const votes = validObserved(fields.voteCount, (v) => Number.isInteger(v) && v >= 0)
        ? fields.voteCount.value
        : undefined;
      const posterPath = validObserved(fields.posterPath, validPoster)
        ? fields.posterPath.value
        : undefined;
      return {
        ...title,
        rating:
          typeof title.rating === 'number' && title.rating > 0
            ? title.rating
            : (rating ?? title.rating),
        votes: title.votes ?? votes,
        posterPath: title.posterPath ?? posterPath,
      };
    });
  } catch {
    return titles;
  }
}
