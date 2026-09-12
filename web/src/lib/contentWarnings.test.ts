import { expect, it } from 'vitest';
import { parseWarnings, fetchWarnings } from './contentWarnings';
import { parseDetail } from './detail';
it('shows only opted-in, confirmed non-spoiler warnings', () => {
  const warning = (id: number, yesSum: number, noSum: number, extra = {}) => ({ yesSum, noSum, topic: { id, name: `Warning ${id}`, TopicCategory: { name: 'Animal Death' }, ...extra } });
  const body = { topicItemStats: [warning(1, 5, 1), warning(2, 1, 0, { isSpoiler: true }), warning(3, 0, 0), warning(4, 1, 2), warning(5, 3, 0, { TopicCategory: { name: 'Sex' } })] };
  expect(parseWarnings(body, ['Animal Death'])).toEqual([{ id: 1, label: 'Warning 1', votes: 5 }]);
  expect(parseWarnings(body, [])).toEqual([]);
});
it('does not fetch without opt-in and never attaches warnings from an unrelated search result', async () => {
  const detail = parseDetail({ type: 'movie', id: 1 }, { title: 'Movie', release_date: '2020-01-01', imdb_id: 'tt1' })!;
  const paths: string[] = [];
  const network = (async (input) => { paths.push(String(input)); return Response.json({ items: [{ id: 2, name: 'Unrelated', releaseYear: '2020', imdbId: 'tt2' }] }); }) as typeof fetch;
  expect(await fetchWarnings(detail, 'key', [], undefined, network)).toBeNull(); expect(paths).toHaveLength(0);
  expect(await fetchWarnings(detail, 'key', ['Sex'], undefined, network)).toBeNull(); expect(paths).toHaveLength(1);
});
