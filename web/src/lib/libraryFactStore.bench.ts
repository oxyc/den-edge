import { beforeAll, expect, test } from 'vitest';
import { Session } from 'node:inspector/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { WATCHED } from './actions';
import { watchedHistory } from './history';
import {
  historyItemFromDocuments,
  historyItemFromProjections,
  historySeasonProjection,
} from './historyIndex';
import {
  compactContinueLibrary,
  projectHomeLibraryView,
  selectHomeLibraryView,
} from './homeLibraryView';
import { applyLog, ContinueSummaries, emptyLibrary, type Library } from './library';
import { forEachProjectedEpisode, projectDocument } from './libraryV4';
import { ensureSyncPolicy } from './syncLoader';
import { isDocument, type DocumentRow, type Row } from './wire';

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

/** Continue's inputs for one season document, folded as its episodes are projected. */
function streamed(document: DocumentRow): Library {
  const summaries = new ContinueSummaries();
  forEachProjectedEpisode({ ...document }, (row) => summaries.addEpisode(row), NOW);
  return summaries.compact();
}

test('compact Continue fact for one 1,000-episode authority document', async ({ bench }) => {
  const rows = projectDocument({ ...season }, NOW);
  const full = applyLog(emptyLibrary(), rows);
  const compact = compactContinueLibrary(full);
  const direct = streamed(season);
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
  const streamWork = () => streamed(season);
  const smallGraphWork = () =>
    manySmallSeasons.map((document) =>
      compactContinueLibrary(applyLog(emptyLibrary(), projectDocument({ ...document }, NOW))),
    );
  const smallStreamWork = () => manySmallSeasons.map(streamed);
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

test('Continue and initial History share one season projection', async () => {
  if (process.env.DEN_ONE_PASS_HISTORY_AUDIT !== '1') return;
  const legacy = () =>
    manySmallSeasons.map((document) => {
      const summaries = new ContinueSummaries();
      forEachProjectedEpisode({ ...document }, (episode) => summaries.addEpisode(episode), NOW);
      return {
        continue: summaries.compact(),
        history: historyItemFromDocuments([{ ...document }], NOW),
      };
    });
  const onePass = () =>
    manySmallSeasons.map((document) => {
      const source = { ...document };
      const summaries = new ContinueSummaries();
      const watched: number[] = [];
      forEachProjectedEpisode(
        source,
        (episode) => {
          summaries.addEpisode(episode);
          if (episode.progress.value >= WATCHED)
            watched.push(episode.episode, episode.progress.at[0]);
        },
        NOW,
      );
      return {
        continue: summaries.compact(),
        history: historyItemFromProjections([historySeasonProjection(source, watched)]),
      };
    });
  expect(onePass()).toEqual(legacy());

  legacy();
  onePass();
  const samples = [];
  for (let repeat = 0; repeat < 3; repeat++)
    for (const [name, work] of repeat % 2
      ? ([
          ['one pass', onePass],
          ['separate passes', legacy],
        ] as const)
      : ([
          ['separate passes', legacy],
          ['one pass', onePass],
        ] as const))
      samples.push(await allocationSample(name, work));
  expect(
    samples.every(({ name, policyRequests }) =>
      name === 'one pass'
        ? policyRequests.season_state_v4 === 500
        : policyRequests.season_state_v4 === 1_000,
    ),
  ).toBe(true);
  console.log(`ONE_PASS_HISTORY ${JSON.stringify(samples)}`);
});

// A household near the budget fixture's Watchlist Worker (6,132 documents, 13,724 rows): 1,000 movie and 1,000 series
// title documents and four four-episode seasons per series, 6,000 documents projecting to 18,000 rows.
function household(): Row[] {
  const stamp = (value: number): [number, number, string] => [value, 0, 'bench'];
  const documents: Row[] = [];
  for (let index = 0; index < 1_000; index++) {
    documents.push({
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 20_000 + index },
      status: { value: index % 2 ? 'watched' : 'watchlist', at: stamp(NOW - index) },
      addedAt: NOW - 10_000 - index,
    } satisfies DocumentRow);
    documents.push({
      format: 4,
      kind: 'title',
      title: { type: 'tv', id: 30_000 + index },
      status: { value: 'watched', at: stamp(NOW - index) },
      addedAt: NOW - 10_000 - index,
    } satisfies DocumentRow);
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
      } satisfies DocumentRow);
  }
  return documents;
}

test('Home and History in one library Worker', async () => {
  if (process.env.DEN_FACT_ALLOCATION_AUDIT !== '1') return;
  // Fresh document objects per run, as a newly opened Worker holds: projectDocument's WeakMap starts empty.
  // `rows` is `LibraryLog.rows()`; History reads it as `LibraryLogAuthority.#history` does.
  const rows = (stored: Row[]) =>
    stored.flatMap((row) => (isDocument(row) ? projectDocument(row, NOW) : [row]));
  const history = (held: Row[]) => watchedHistory(held, new Map());
  // Before: History asked for Home's view, which folded the whole `rows()` projection.
  const foldedHome = (held: Row[]) => selectHomeLibraryView(applyLog(emptyLibrary(), held), held);
  const work = {
    'Home only: rows() + full fold': () => foldedHome(rows(household())),
    'Home only: rows() + one pass': () => projectHomeLibraryView(rows(household())),
    'History only: rows() + full fold': () => {
      const held = rows(household());
      foldedHome(held);
      return history(held);
    },
    'History only: rows()': () => history(rows(household())),
    'Home then History: rows() + full fold': () => {
      const held = rows(household());
      foldedHome(held);
      return history(held);
    },
    'Home then History: rows() + one pass': () => {
      const held = rows(household());
      projectHomeLibraryView(held);
      return history(held);
    },
  };
  const stored = household();
  expect(projectHomeLibraryView(rows(stored))).toEqual(foldedHome(rows(stored)));
  expect(rows(stored)).toHaveLength(18_000);

  const entries = Object.entries(work);
  for (const [, run] of entries) run();
  const samples = [];
  for (let repeat = 0; repeat < 3; repeat++)
    for (let pair = 0; pair < entries.length; pair += 2) {
      const [before, after] = [entries[pair]!, entries[pair + 1]!];
      for (const [name, run] of repeat % 2 ? [after, before] : [before, after])
        samples.push(await allocationSample(name, run));
    }
  console.log(`JOURNEY_ALLOCATION ${JSON.stringify(samples)}`);
  if (process.env.DEN_JOURNEY_ALLOCATION_OUTPUT)
    writeFileSync(process.env.DEN_JOURNEY_ALLOCATION_OUTPUT, JSON.stringify(samples, null, 2));
});
