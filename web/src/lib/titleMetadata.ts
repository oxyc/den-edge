import type { Title } from './library';
import { credentialVersion, hasLibraryCredential, relayFetch } from './relayFetch';
import { retryAfterMs } from './retryAfter';

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

// What this browser sends back to `/metadata/title`: only what den-edge did not see itself. Every TMDB answer comes
// through den-edge's proxy (`tmdbCache.ts`) and every atlas chart relayed through it, and den-edge keeps what those say
// as it passes them on (`src/title_metadata.rs`). An atlas chart answered by atlas directly — the tailnet's `/atlas`,
// which `tailscale serve` hands straight to atlas — is the one den-edge never sees; its answer carries no
// `x-den-title-metadata`, and its ratings are sent from here.

/** How long observations gather before they go, so a page of charts is one request rather than one per chart. */
const FLUSH_MS = 250;
/** den-edge's limits on one `PUT /metadata/title`: 100 entries and 32 KB, less room for the envelope. */
const MAX_ENTRIES = 100;
const MAX_BYTES = 30 * 1024;

/** Waiting to be sent, one per title and source, newest fields over older ones. */
const queued = new Map<string, Observation>();
let sendWith: typeof fetch = relayFetch;
let timer: ReturnType<typeof setTimeout> | undefined;
/** den-edge said to come back later (`429`): nothing goes before then. */
let pausedUntil = 0;
/** The credential den-edge refused (`401`): nothing more is sent until the credential changes. */
let refused: number | undefined;

const keyOf = (o: Observation) => `${o.type}:${o.id}:${o.source}`;
const sizeOf = (o: Observation) => JSON.stringify(o).length + 1;

function sendable(): boolean {
  return hasLibraryCredential() && refused !== credentialVersion();
}

/** Queue observations: merged with what waits for the same title and source, sent together shortly. */
function publish(entries: Observation[], fetchImpl: typeof fetch): void {
  if (!entries.length || !sendable()) return;
  sendWith = fetchImpl;
  let bytes = 0;
  for (const entry of entries) {
    const waiting = queued.get(keyOf(entry));
    queued.set(
      keyOf(entry),
      waiting ? { ...entry, fields: { ...waiting.fields, ...entry.fields } } : entry,
    );
  }
  for (const entry of queued.values()) bytes += sizeOf(entry);
  if (queued.size >= MAX_ENTRIES || bytes >= MAX_BYTES) flushSoon(0);
  else flushSoon(FLUSH_MS);
}

function flushSoon(ms: number): void {
  if (timer !== undefined) {
    if (ms > 0) return;
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, ms);
}

/** Put back what a refused request carried, under anything newer that arrived meanwhile. */
function requeue(batch: Observation[]): void {
  for (const entry of batch) {
    const newer = queued.get(keyOf(entry));
    queued.set(
      keyOf(entry),
      newer ? { ...newer, fields: { ...entry.fields, ...newer.fields } } : entry,
    );
  }
}

async function flush(): Promise<void> {
  if (!sendable()) {
    queued.clear();
    return;
  }
  const wait = pausedUntil - Date.now();
  if (wait > 0) return flushSoon(wait);
  const batch: Observation[] = [];
  let bytes = 0;
  for (const [key, entry] of queued) {
    if (batch.length >= MAX_ENTRIES || bytes + sizeOf(entry) > MAX_BYTES) break;
    batch.push(entry);
    bytes += sizeOf(entry);
    queued.delete(key);
  }
  if (!batch.length) return;
  const credential = credentialVersion();
  let res: Response;
  try {
    res = await sendWith('/metadata/title', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
    });
  } catch {
    return; // Unreachable: an observation is not worth holding a page's memory for.
  }
  if (res.status === 429) {
    pausedUntil = Date.now() + retryAfterMs(res, 60_000);
    requeue(batch);
  } else if (res.status === 401) {
    // den-edge does not take this browser's proof of membership. Sending more with it would be refused the same
    // way, so nothing goes until the credential changes (`log.ts` sets it again once the library is found).
    refused = credential;
    queued.clear();
    return;
  }
  if (queued.size) flushSoon(0);
}

/** Persist JustWatch's IMDb scores from an atlas chart den-edge did not relay (see the top of this file). */
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
  publish(entries, fetchImpl);
}

/** Whether den-edge kept what this atlas answer says itself, so it need not be sent back. */
export const keptByEdge = (res: Response): boolean =>
  res.headers.get('x-den-title-metadata') === 'kept';

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
      const rating = observed
        .flatMap((entry) =>
          validObserved(
            entry.fields.rating,
            (value) => Number.isFinite(value) && value > 0 && value <= 10,
          )
            ? [{ ...entry.fields.rating, source: entry.source }]
            : [],
        )
        .sort((a, b) => b.observedAt - a.observedAt)[0];
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
            : (rating?.value ?? title.rating),
        ratingSource:
          typeof title.rating === 'number' && title.rating > 0
            ? title.ratingSource
            : (rating?.source ?? title.ratingSource),
        votes: title.votes ?? votes,
        posterPath: title.posterPath ?? posterPath,
      };
    });
  } catch {
    return titles;
  }
}
