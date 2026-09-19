import { afterEach, expect, test, vi } from 'vitest';
import { forgetLibraryCredential, useLibraryCredential } from './relayFetch';
import { metadataIn, rememberTmdbMetadata, withSharedTmdbMetadata } from './tmdbMetadata';

afterEach(() => forgetLibraryCredential());

test('extracts only allowlisted metadata from direct TMDB answers', () => {
  expect(
    metadataIn(
      '/3/movie/550',
      '{"id":550,"vote_average":8.4,"vote_count":100,"poster_path":"/f.jpg","overview":"ignored"}',
    ),
  ).toEqual([
    { type: 'movie', id: 550, fields: { rating: 8.4, voteCount: 100, posterPath: '/f.jpg' } },
  ]);
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
    '/metadata/tmdb',
    expect.objectContaining({ method: 'PUT' }),
  );
});

test('hydrates missing fields without replacing fresher local card metadata', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        entries: [
          {
            type: 'movie',
            id: 550,
            source: 'tmdb',
            fields: {
              rating: { value: 8.4, observedAt: 1 },
              voteCount: { value: 100, observedAt: 2 },
              posterPath: { value: '/shared.jpg', observedAt: 3 },
            },
          },
        ],
      }),
    )) as unknown as typeof fetch;
  const [hydrated, retained] = await withSharedTmdbMetadata(
    [
      { type: 'movie', id: 550, title: 'Fight Club' },
      { type: 'movie', id: 550, title: 'Local', rating: 9, posterPath: '/local.jpg' },
    ],
    fetchImpl,
  );
  expect(hydrated).toMatchObject({ rating: 8.4, votes: 100, posterPath: '/shared.jpg' });
  expect(retained).toMatchObject({ rating: 9, posterPath: '/local.jpg' });
});
