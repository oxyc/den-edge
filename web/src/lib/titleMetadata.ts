import type { Title } from './library';
import { hasLibraryCredential, relayFetch } from './relayFetch';

type Kind = 'movie' | 'tv';
type Source = 'tmdb' | 'justwatch-imdb';
interface Fields {
  rating?: number;
  voteCount?: number;
  posterPath?: string;
}
interface Observation {
  type: Kind;
  id: number;
  source: Source;
  fields: Fields;
}
interface Observed<T> {
  value: T;
  observedAt: number;
}
interface Stored {
  type: Kind;
  id: number;
  source: Source;
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
    if (Object.keys(fields).length)
      found.set(`${type}:${id}`, { type, id: id as number, source: 'tmdb', fields });
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
  void publishTitleMetadata(entries, fetchImpl);
}

function publishTitleMetadata(
  entries: Observation[],
  fetchImpl: typeof fetch = relayFetch,
): Promise<Response | undefined> {
  if (!hasLibraryCredential() || !entries.length) return Promise.resolve(undefined);
  return fetchImpl('/metadata/title', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  }).catch(() => undefined);
}

/** Persist JustWatch's IMDb scores exactly where an Atlas response gave them to this client. */
export function rememberAtlasMetadata(titles: Title[], fetchImpl: typeof fetch = relayFetch): void {
  const entries: Observation[] = titles.flatMap((title) =>
    typeof title.rating === 'number' &&
    Number.isFinite(title.rating) &&
    title.rating > 0 &&
    title.rating <= 10
      ? [
          {
            type: title.type,
            id: title.id,
            source: 'justwatch-imdb',
            fields: { rating: title.rating },
          },
        ]
      : [],
  );
  void publishTitleMetadata(entries.slice(0, 100), fetchImpl);
}

/** Fill missing poster fields from observations made by another paired client, in one bounded request. */
export async function withSharedTitleMetadata(
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
    const response = await fetchImpl('/metadata/title/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ titles: wanted.map(({ type, id }) => ({ type, id })) }),
    });
    if (!response.ok) return titles;
    const answer = (await response.json()) as { entries?: Stored[] };
    const entries = new Map<string, Stored[]>();
    for (const entry of Array.isArray(answer.entries) ? answer.entries : []) {
      if (
        (entry.source === 'tmdb' || entry.source === 'justwatch-imdb') &&
        validKind(entry.type) &&
        Number.isInteger(entry.id) &&
        entry.id > 0
      )
        entries.set(`${entry.type}:${entry.id}`, [
          ...(entries.get(`${entry.type}:${entry.id}`) ?? []),
          entry,
        ]);
    }
    return titles.map((title) => {
      const observed = entries.get(`${title.type}:${title.id}`) ?? [];
      if (!observed.length) return title;
      const newest = <T>(fields: (Observed<T> | undefined)[], valid: (value: T) => boolean) =>
        fields
          .filter((field): field is Observed<T> => validObserved(field, valid))
          .sort((a, b) => b.observedAt - a.observedAt)[0]?.value;
      const rating = newest(
        observed.map((entry) => entry.fields.rating),
        (value) => Number.isFinite(value) && value > 0 && value <= 10,
      );
      const votes = newest(
        observed.filter((entry) => entry.source === 'tmdb').map((entry) => entry.fields.voteCount),
        (value) => Number.isInteger(value) && value >= 0,
      );
      const posterPath = newest(
        observed.filter((entry) => entry.source === 'tmdb').map((entry) => entry.fields.posterPath),
        validPoster,
      );
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
