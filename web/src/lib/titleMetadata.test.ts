import { afterEach, expect, test, vi } from 'vitest';
import { forgetLibraryCredential, useLibraryCredential } from './relayFetch';
import {
  metadataIn,
  rememberAtlasMetadata,
  rememberTmdbMetadata,
  withSharedTitleMetadata,
} from './titleMetadata';

afterEach(() => forgetLibraryCredential());

test('extracts only allowlisted metadata from direct TMDB answers', () => {
  expect(
    metadataIn(
      '/3/movie/550',
      '{"id":550,"vote_average":8.4,"vote_count":100,"poster_path":"/f.jpg","overview":"ignored"}',
    ),
  ).toEqual([
    {
      type: 'movie',
      id: 550,
      source: 'tmdb',
      fields: { rating: 8.4, voteCount: 100, posterPath: '/f.jpg' },
    },
  ]);
});

test('publishes Atlas JustWatch IMDb ratings with distinct provenance', async () => {
  useLibraryCredential({ id: 'a', token: 'b' });
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
  );
  rememberAtlasMetadata(
    [{ type: 'movie', id: 550, title: 'Fight Club', rating: 7.4 }],
    fetchMock as unknown as typeof fetch,
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    entries: [{ type: 'movie', id: 550, source: 'justwatch-imdb', fields: { rating: 7.4 } }],
  });
});

test('publishes observations only for a paired browser', async () => {
  const fetchImpl = vi.fn(
    async () => new Response(null, { status: 204 }),
  ) as unknown as typeof fetch;
  const body = '{"id":550,"vote_average":8.4,"vote_count":100,"poster_path":"/f.jpg"}';
  rememberTmdbMetadata('/3/movie/550', body, fetchImpl);
  expect(fetchImpl).not.toHaveBeenCalled();
  useLibraryCredential({ id: 'a', token: 'b' });
  rememberTmdbMetadata('/3/movie/550', body, fetchImpl);
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  expect(fetchImpl).toHaveBeenCalledWith(
    '/metadata/title',
    expect.objectContaining({ method: 'PUT' }),
  );
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
