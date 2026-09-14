import { expect, it } from 'vitest';
import { parseWarnings, fetchWarnings } from './contentWarnings';
import { parseDetail } from './detail';

it('shows confirmed non-spoiler warnings, only the picked categories when any are picked', () => {
  const warning = (id: number, yes: number, no: number, extra = {}) => ({
    id,
    name: `Warning ${id}`,
    category: 'Animal Death',
    spoiler: false,
    yes,
    no,
    ...extra,
  });
  const body = {
    id: 10752,
    warnings: [
      warning(1, 5, 1),
      warning(2, 1, 0, { spoiler: true }),
      warning(3, 0, 0),
      warning(4, 1, 2),
      warning(5, 3, 0, { category: 'Sex' }),
    ],
  };
  expect(parseWarnings(body, ['Animal Death'])).toEqual([{ id: 1, label: 'Warning 1', votes: 5 }]);
  expect(parseWarnings(body, [])).toEqual([
    { id: 1, label: 'Warning 1', votes: 5 },
    { id: 5, label: 'Warning 5', votes: 3 },
  ]);
});

it('asks den-edge once, by IMDb id, with this page’s key only when it has one', async () => {
  const detail = parseDetail(
    { type: 'movie', id: 1 },
    { title: 'Movie', release_date: '2020-01-01', imdb_id: 'tt1' },
  )!;
  const asked: { url: string; key: string | null }[] = [];
  const network = (async (input, init) => {
    asked.push({ url: String(input), key: new Headers(init?.headers).get('x-api-key') });
    return Response.json({ id: 7, warnings: [{ id: 1, name: 'a dog dies', yes: 2, no: 0 }] });
  }) as typeof fetch;
  expect(await fetchWarnings(detail, '', [], undefined, network)).toEqual({
    id: 7,
    warnings: [{ id: 1, label: 'a dog dies', votes: 2 }],
  });
  await fetchWarnings(detail, 'mine', [], undefined, network);
  expect(asked).toEqual([
    { url: '/warnings/imdb/tt1', key: null },
    { url: '/warnings/imdb/tt1', key: 'mine' },
  ]);

  const nothingKept = (async () =>
    Response.json({ error: 'not_cached' }, { status: 404 })) as typeof fetch;
  expect(await fetchWarnings(detail, '', [], undefined, nothingKept)).toBeNull();
});
