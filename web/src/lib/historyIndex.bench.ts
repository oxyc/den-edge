import { expect, test } from 'vitest';
import type { CompactHistoryCheckpoint } from './compactHistoryCheckpoint';
import {
  HISTORY_INDEX_POLICY,
  HISTORY_INDEX_SCHEMA,
  MaterializedHistoryIndex,
  type HistoryIndexSnapshot,
} from './historyIndex';
import type { HistoryItem, HistoryView } from './libraryServiceProtocol';

const TITLES = 10_000;
const FIRST_PAGE = 48;
const NOW = new Date(2026, 5, 15, 12).getTime();

const items: HistoryItem[] = Array.from({ length: TITLES }, (_, index) => ({
  title: { type: index % 2 ? ('movie' as const) : ('tv' as const), id: index + 1 },
  watchedAt: NOW - index * 86_400_000,
  ...(index % 2
    ? {}
    : { episode: { season: Math.floor(index / 10) + 1, episode: (index % 10) + 1 } }),
  episodes: index % 2 ? 0 : (index % 100) + 1,
}));

const snapshot: HistoryIndexSnapshot = {
  schema: HISTORY_INDEX_SCHEMA,
  policy: HISTORY_INDEX_POLICY,
  source: {
    generation: 'history-index-benchmark',
    version: TITLES,
    revision: 'fixed-source-revision',
    reconsiderAt: null,
  },
  builtAt: NOW,
  items,
};

const index = MaterializedHistoryIndex.restore(snapshot)!;
const checkpoint: CompactHistoryCheckpoint = {
  schema: 1,
  snapshot,
  documents: items.map((item, index) => [
    `${item.title.type}:${item.title.id}`,
    [index.toString(16).padStart(64, '0')],
  ]),
};
const page = { kind: 'history' as const, ...index.page({}, undefined, FIRST_PAGE)! };
const full: Pick<HistoryView, 'kind' | 'items'> = { kind: 'history', items };
const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('10k-title warm History page versus a whole-summary response', async ({ bench }) => {
  const fullBytes = bytes(full);
  const pageBytes = bytes(page);
  const snapshotBytes = bytes(snapshot);
  const checkpointBytes = bytes(checkpoint);
  expect(page.items).toHaveLength(FIRST_PAGE);
  expect(pageBytes).toBeLessThan(fullBytes / 100);
  console.log(
    `HISTORY_MATERIALIZED_WARM ${JSON.stringify({ titles: TITLES, firstPage: FIRST_PAGE, fullBytes, pageBytes, snapshotBytes, checkpointBytes, checkpointBytesPerTitle: checkpointBytes / TITLES, responseReduction: 1 - pageBytes / fullBytes })}`,
  );

  const wholeReply = bench('clone whole 10k-title History summary', () => structuredClone(full));
  const firstPage = bench('query and clone materialized first page', () =>
    structuredClone(index.page({}, undefined, FIRST_PAGE)),
  );
  const results = await bench.compare(wholeReply, firstPage, {
    iterations: 10,
    time: 0,
    warmup: false,
  });
  expect(results.get('query and clone materialized first page')).toBeFasterThan(
    results.get('clone whole 10k-title History summary'),
  );
});
