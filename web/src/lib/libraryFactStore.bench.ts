import { beforeAll, expect, test } from 'vitest';
import { Session } from 'node:inspector/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const manySmallSeasons: DocumentRow[] = Array.from({ length: 100 }, (_, index) => ({
  ...season,
  title: { type: 'tv', id: 9_000 + index },
  episodes: Object.fromEntries(Object.entries(season.episodes ?? {}).slice(0, 10)),
}));

beforeAll(async () => ensureSyncPolicy());

interface HeapNode {
  selfSize: number;
  children?: HeapNode[];
}

const allocated = (node: HeapNode): number =>
  node.selfSize + (node.children ?? []).reduce((sum, child) => sum + allocated(child), 0);
let allocationProfileNumber = 0;

async function allocationSample(name: string, work: () => unknown) {
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 16_384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const requests = (
    globalThis as typeof globalThis & { __denPolicyRequests?: Record<string, number> }
  ).__denPolicyRequests;
  const before = { ...(requests ?? {}) };
  const started = performance.now();
  for (let iteration = 0; iteration < 5; iteration++) work();
  const elapsedMs = performance.now() - started;
  const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as {
    profile: { head: HeapNode };
  };
  session.disconnect();
  if (process.env.DEN_FACT_ALLOCATION_PROFILE_DIR) {
    mkdirSync(process.env.DEN_FACT_ALLOCATION_PROFILE_DIR, { recursive: true });
    const file = `${String(++allocationProfileNumber).padStart(2, '0')}-${name.replaceAll(/[^a-z0-9]+/gi, '-')}.json`;
    writeFileSync(
      `${process.env.DEN_FACT_ALLOCATION_PROFILE_DIR}/${file}`,
      JSON.stringify(profile),
    );
  }
  return {
    name,
    iterations: 5,
    allocatedBytes: allocated(profile.head),
    elapsedMs,
    policyRequests: Object.fromEntries(
      Object.entries(requests ?? {}).map(([operation, count]) => [
        operation,
        count - (before[operation] ?? 0),
      ]),
    ),
  };
}

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

  const graphWork = () => {
    const projected = projectDocument({ ...season }, NOW);
    return compactContinueLibrary(applyLog(emptyLibrary(), projected));
  };
  const streamWork = () => {
    const accumulator = new ContinueLibraryAccumulator();
    forEachProjectedRow(
      { ...season },
      (row) => {
        if (row.kind === 'ep') accumulator.addEpisode(row);
      },
      NOW,
    );
    return accumulator.finish();
  };
  const smallGraphWork = () =>
    manySmallSeasons.map((document) =>
      compactContinueLibrary(applyLog(emptyLibrary(), projectDocument({ ...document }, NOW))),
    );
  const smallStreamWork = () =>
    manySmallSeasons.map((document) => {
      const accumulator = new ContinueLibraryAccumulator();
      forEachProjectedRow(
        { ...document },
        (row) => {
          if (row.kind === 'ep') accumulator.addEpisode(row);
        },
        NOW,
      );
      return accumulator.finish();
    });
  if (process.env.DEN_FACT_ALLOCATION_AUDIT === '1') {
    graphWork();
    streamWork();
    smallGraphWork();
    smallStreamWork();
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      const stress = repeat % 2 ? [streamWork, graphWork] : [graphWork, streamWork];
      const representative =
        repeat % 2 ? [smallStreamWork, smallGraphWork] : [smallGraphWork, smallStreamWork];
      for (const work of [...stress, ...representative])
        samples.push(
          await allocationSample(
            work === graphWork
              ? 'one 1000-episode season: episode-row + full-mark graph'
              : work === streamWork
                ? 'one 1000-episode season: streamed compact Continue'
                : work === smallGraphWork
                  ? '100 10-episode seasons: episode-row + full-mark graph'
                  : '100 10-episode seasons: streamed compact Continue',
            work,
          ),
        );
    }
    expect(
      samples.every(({ allocatedBytes }) => Number.isFinite(allocatedBytes) && allocatedBytes > 0),
    ).toBe(true);
    for (const sample of samples) {
      expect(sample.policyRequests.episode_mark).toBe(5_000);
      expect(sample.policyRequests.season_state_v4).toBe(sample.name.startsWith('100 ') ? 500 : 5);
    }
    console.log(`FACT_ALLOCATION ${JSON.stringify(samples)}`);
    if (process.env.DEN_FACT_ALLOCATION_OUTPUT)
      writeFileSync(process.env.DEN_FACT_ALLOCATION_OUTPUT, JSON.stringify(samples, null, 2));
  }

  const history = bench('full History fold control', () => applyLog(emptyLibrary(), rows));
  const graph = bench('episode-row + full-mark fact graph', () => {
    return graphWork();
  });
  const stream = bench('streamed compact Continue fact', () => {
    return streamWork();
  });
  await bench.compare(history, graph, stream);
});
