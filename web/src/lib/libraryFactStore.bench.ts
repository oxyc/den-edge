import { beforeAll, expect, test } from 'vitest';
import {
  applyLog,
  compactContinueLibrary,
  ContinueLibraryAccumulator,
  emptyLibrary,
} from './library';
import { forEachProjectedRow, projectDocument } from './libraryV4';
import { ensureSyncPolicy } from './syncLoader';
import type { DocumentRow } from './wire';

const EPISODES = 1_000;
const NOW = 1_800_000_000_000;
const at = (episode: number): [number, number, string] => [NOW - EPISODES + episode, 0, 'bench'];
const season: DocumentRow = {
  format: 4,
  kind: 'season',
  title: { type: 'tv', id: 8_090 },
  season: 1,
  seasonReset: null,
  episodes: Object.fromEntries(
    Array.from({ length: EPISODES }, (_, index) => {
      const episode = index + 1;
      return [
        episode,
        {
          progress: {
            value: episode === EPISODES ? 0.4 : 1,
            at: at(episode),
            viewing: 0,
            ...(episode === EPISODES ? { seconds: 809 } : {}),
          },
          imported: false,
          plays: { 0: at(episode)[0] },
          cleared: null,
        },
      ];
    }),
  ),
};

beforeAll(async () => ensureSyncPolicy());

test('compact Continue fact for one 1,000-episode authority document', async ({ bench }) => {
  const rows = projectDocument({ ...season }, NOW);
  const full = applyLog(emptyLibrary(), rows);
  const compact = compactContinueLibrary(full);
  const streamed = new ContinueLibraryAccumulator();
  forEachProjectedRow(
    { ...season },
    (row) => {
      if (row.kind === 'ep') streamed.addEpisode(row);
    },
    NOW,
  );
  const direct = streamed.finish();
  // The old fact path held both 1,000-node graphs at once before selecting the same two policy inputs.
  expect({
    episodeRows: rows.length,
    foldedMarks: full.marks.length,
    compactMarks: compact.marks.length,
  }).toEqual({ episodeRows: EPISODES, foldedMarks: EPISODES, compactMarks: 2 });
  expect(direct).toEqual(compact);

  const history = bench('full History fold control', () => applyLog(emptyLibrary(), rows));
  const graph = bench('episode-row + full-mark fact graph', () => {
    const projected = projectDocument({ ...season }, NOW);
    return compactContinueLibrary(applyLog(emptyLibrary(), projected));
  });
  const stream = bench('streamed compact Continue fact', () => {
    const accumulator = new ContinueLibraryAccumulator();
    forEachProjectedRow(
      { ...season },
      (row) => {
        if (row.kind === 'ep') accumulator.addEpisode(row);
      },
      NOW,
    );
    return accumulator.finish();
  });
  const results = await bench.compare(history, graph, stream);
  expect(results.get('streamed compact Continue fact')).toBeFasterThan(
    results.get('episode-row + full-mark fact graph'),
  );
});
