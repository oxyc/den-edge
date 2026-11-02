import type { DocumentRow } from './wire';

export const HOUSEHOLD_NOW = 1_800_000_000_000;

/**
 * `libraryFactStore.bench.ts`'s household: 1,000 films and 1,000 series with four four-episode seasons each, 6,000
 * documents projecting to 18,000 rows.
 */
export function household(): DocumentRow[] {
  const NOW = HOUSEHOLD_NOW;
  const stamp = (value: number): [number, number, string] => [value, 0, 'bench'];
  const documents: DocumentRow[] = [];
  for (let index = 0; index < 1_000; index++) {
    documents.push({
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 20_000 + index },
      status: { value: index % 2 ? 'watched' : 'watchlist', at: stamp(NOW - index) },
      addedAt: NOW - 10_000 - index,
    });
    documents.push({
      format: 4,
      kind: 'title',
      title: { type: 'tv', id: 30_000 + index },
      status: { value: 'watched', at: stamp(NOW - index) },
      addedAt: NOW - 10_000 - index,
    });
    for (let number = 1; number <= 4; number++)
      documents.push({
        format: 4,
        kind: 'season',
        title: { type: 'tv', id: 30_000 + index },
        season: number,
        seasonReset: null,
        episodes: Object.fromEntries(
          Array.from({ length: 4 }, (_, episode) => {
            const when = NOW - 100_000 + index * 20 + number * 4 + episode;
            return [
              episode + 1,
              {
                progress: { value: 1, at: stamp(when), viewing: 0 },
                imported: false,
                plays: { 0: when },
                cleared: null,
              },
            ];
          }),
        ),
      });
  }
  return documents;
}
