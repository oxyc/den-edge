import { afterEach, expect, test, vi } from 'vitest';
import { forgetLibraryCredential, useLibraryCredential } from './relayFetch';
import { rememberAtlasMetadata, withSharedTitleMetadata } from './titleMetadata';

afterEach(() => forgetLibraryCredential());

const film = (id: number, rating: number) => ({
  type: 'movie' as const,
  id,
  title: `T${id}`,
  rating,
});

/** A `PUT /metadata/title` stand-in answering each call in turn, recording each body. */
function edge(...statuses: [number, Record<string, string>?][]) {
  const bodies: { entries: unknown[] }[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as { entries: unknown[] });
    const [status, headers] = statuses.shift() ?? [204];
    return new Response(null, { status, headers });
  });
  return { bodies, fetchImpl: fetchImpl as unknown as typeof fetch, calls: fetchImpl };
}

test('publishes Atlas JustWatch IMDb ratings with distinct provenance', async () => {
  useLibraryCredential({ id: 'a', member: 'b' });
  const { bodies, fetchImpl, calls } = edge();
  rememberAtlasMetadata([film(550, 7.4)], fetchImpl);
  await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce());
  expect(calls.mock.calls[0]?.[0]).toBe('/metadata/title');
  expect(bodies).toEqual([
    { entries: [{ type: 'movie', id: 550, source: 'justwatch-imdb', fields: { rating: 7.4 } }] },
  ]);
});

test('publishes observations only for a paired browser', async () => {
  const { fetchImpl, calls } = edge();
  rememberAtlasMetadata([film(550, 7.4)], fetchImpl);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(calls).not.toHaveBeenCalled();
});

/**
 * A page renders a row of charts at once. One request each tripped den-edge's per-address limit (60 a minute)
 * and lost what was refused, so they are gathered: one title once, with its newest fields.
 */
test('gathers a page of observations into one request, keeping the newest', async () => {
  useLibraryCredential({ id: 'a', member: 'b' });
  const { bodies, fetchImpl, calls } = edge();
  rememberAtlasMetadata([film(1, 6.1), film(2, 7.2)], fetchImpl);
  rememberAtlasMetadata([film(1, 6.5)], fetchImpl);
  await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce());
  expect(bodies[0]!.entries).toEqual([
    { type: 'movie', id: 1, source: 'justwatch-imdb', fields: { rating: 6.5 } },
    { type: 'movie', id: 2, source: 'justwatch-imdb', fields: { rating: 7.2 } },
  ]);
});

test('sends no more than den-edge takes in one request', async () => {
  useLibraryCredential({ id: 'a', member: 'b' });
  const { bodies, fetchImpl, calls } = edge();
  rememberAtlasMetadata(
    Array.from({ length: 150 }, (_, i) => film(i + 1, 7)),
    fetchImpl,
  );
  await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
  expect(bodies.map((b) => b.entries.length)).toEqual([100, 50]);
});

/** A refusal for now is waited out, and what it carried is sent again rather than lost. */
test('waits out a 429 as told and sends the same observations again', async () => {
  useLibraryCredential({ id: 'a', member: 'b' });
  const { bodies, fetchImpl, calls } = edge([429, { 'retry-after': '1' }]);
  const started = Date.now();
  rememberAtlasMetadata([film(550, 7.4)], fetchImpl);
  await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(2), { timeout: 3_000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  expect(bodies[1]).toEqual(bodies[0]);
});

/**
 * A proof den-edge refuses is refused every time. One browser sent 236 of them in six hours; now the first 401
 * stops it until the credential changes.
 */
test('stops after a 401 until the credential changes', async () => {
  useLibraryCredential({ id: 'a', member: 'b' });
  const { fetchImpl, calls } = edge([401]);
  rememberAtlasMetadata([film(1, 7)], fetchImpl);
  await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce());
  rememberAtlasMetadata([film(2, 7)], fetchImpl);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(calls).toHaveBeenCalledOnce();
  useLibraryCredential({ id: 'a', member: 'c' });
  rememberAtlasMetadata([film(3, 7)], fetchImpl);
  await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
});

test('hydrates missing fields without replacing fresher local card metadata', async () => {
  const observedAt = Date.now();
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        entries: [
          {
            type: 'movie',
            id: 550,
            source: 'justwatch-imdb',
            fields: { rating: { value: 7.4, observedAt: observedAt - 1 } },
          },
          {
            type: 'movie',
            id: 550,
            source: 'tmdb',
            fields: {
              rating: { value: 8.4, observedAt },
              voteCount: { value: 100, observedAt },
              posterPath: { value: '/shared.jpg', observedAt },
            },
          },
        ],
      }),
    )) as unknown as typeof fetch;
  const [hydrated, retained] = await withSharedTitleMetadata(
    [
      { type: 'movie', id: 550, title: 'Fight Club', rating: 0 },
      { type: 'movie', id: 550, title: 'Local', rating: 9, posterPath: '/local.jpg' },
    ],
    fetchImpl,
  );
  expect(hydrated).toMatchObject({
    rating: 8.4,
    ratingSource: 'tmdb',
    votes: 100,
    posterPath: '/shared.jpg',
  });
  expect(retained).toMatchObject({ rating: 9, posterPath: '/local.jpg' });
});

test('rejects expired and future field timestamps independently', async () => {
  const now = Date.now();
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        entries: [
          {
            type: 'movie',
            id: 550,
            source: 'tmdb',
            fields: {
              rating: { value: 8.4, observedAt: now + 60_000 },
              voteCount: { value: 100, observedAt: now - 181 * 86_400_000 },
              posterPath: { value: '/shared.jpg', observedAt: now },
            },
          },
        ],
      }),
    )) as unknown as typeof fetch;
  const [hydrated] = await withSharedTitleMetadata(
    [{ type: 'movie', id: 550, title: 'Fight Club' }],
    fetchImpl,
  );
  expect(hydrated).toEqual({
    type: 'movie',
    id: 550,
    title: 'Fight Club',
    rating: undefined,
    ratingSource: undefined,
    votes: undefined,
    posterPath: '/shared.jpg',
  });
});
