import { Session } from 'node:inspector/promises';
import { expect, test } from 'vitest';
import { seenEpisodes, seenEpisodesFor, watchedHistory } from './history';
import type { Title } from './library';
import type { HistoryView, LibraryQueryResult } from './libraryServiceProtocol';
import type { Row, Stamp } from './wire';

const TITLES = 2_000;
const EPISODES = 50;
const FIRST_WINDOW = 48;
const NOW = 1_800_000_000_000;
const stamp = (at: number): Stamp => [at, 0, 'bench'];
const key = (title: { type: string; id: number }) => `${title.type}:${title.id}`;

const names = new Map<string, Title>();
const rows: Row[] = [];
for (let index = 0; index < TITLES; index++) {
  const title = { type: 'tv' as const, id: index + 1 };
  names.set(key(title), { ...title, title: `Series ${title.id}` });
  rows.push({
    kind: 'rec',
    schema: 2,
    title,
    status: { value: 'watchlist', at: stamp(NOW - index) },
    resume: { value: 0, at: stamp(0), viewing: 0 },
    reaction: { value: null, at: stamp(0) },
    deleted: { value: false, at: stamp(0) },
    dismissed: { value: false, at: stamp(0) },
    episodesReset: null,
    addedAt: NOW - index,
    watchedAt: null,
  });
  for (let episode = 0; episode < EPISODES; episode++)
    rows.push({
      kind: 'ep',
      schema: 2,
      title,
      season: Math.floor(episode / 10) + 1,
      episode: (episode % 10) + 1,
      progress: { value: 1, at: stamp(NOW - index * EPISODES - episode), viewing: 0 },
    });
}

const firstTitles = Array.from({ length: FIRST_WINDOW }, (_, index) => ({
  type: 'tv' as const,
  id: index + 1,
}));
const firstKeys = new Set(firstTitles.map(key));
// The authority's one-pass document index gives a detail query only these titles' projected rows. It never folds or
// allocates exact coordinates for the other 1,952 series.
const firstRows = rows.filter((row) => row.kind !== 'set' && firstKeys.has(key(row.title)));

const summaryReply = (): HistoryView => ({
  kind: 'history',
  revision: 'history-benchmark',
  filter: {},
  total: TITLES,
  facets: { all: TITLES, movie: 0, tv: TITLES, years: [] },
  items: watchedHistory(rows, names).map(({ title, at, episode, episodes }) => ({
    title: { type: title.type, id: title.id },
    watchedAt: at,
    ...(episode ? { episode } : {}),
    episodes,
  })),
});

const legacyReply = () => {
  const summary = summaryReply();
  const exact = seenEpisodes(rows);
  return {
    kind: 'history' as const,
    items: summary.items.map((item) => ({ ...item, seen: exact.get(key(item.title)) ?? [] })),
  };
};

const splitReply = (): [HistoryView, Extract<LibraryQueryResult, { kind: 'history.episodes' }>] => {
  const summary = summaryReply();
  const exact = seenEpisodesFor(firstRows, firstKeys);
  return [
    summary,
    {
      kind: 'history.episodes',
      revision: summary.revision,
      stale: false,
      items: firstTitles.map((title) => ({ title, seen: exact.get(key(title)) ?? [] })),
    },
  ];
};

interface HeapNode {
  selfSize: number;
  children?: HeapNode[];
}

const allocated = (node: HeapNode): number =>
  node.selfSize + (node.children ?? []).reduce((sum, child) => sum + allocated(child), 0);

async function allocationSample(name: string, work: () => unknown) {
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 4_096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const started = performance.now();
  for (let iteration = 0; iteration < 5; iteration++) work();
  const elapsedMs = performance.now() - started;
  const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as {
    profile: { head: HeapNode };
  };
  session.disconnect();
  return { name, iterations: 5, allocatedBytes: allocated(profile.head), elapsedMs };
}

test('History derivation + reply clone from pre-projected rows', async ({ bench }) => {
  // Scope: reducers over already-projected Rows plus structured cloning. This deliberately excludes LibraryLog.rows(),
  // document projection/index construction, Worker startup, and decrypt; it is not a whole-Worker latency benchmark.
  const legacy = legacyReply();
  const split = splitReply();
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const legacyBytes = bytes(legacy);
  const splitBytes = bytes(split);
  expect(split[0].items).toHaveLength(TITLES);
  expect(split[1].items).toHaveLength(FIRST_WINDOW);
  expect(splitBytes).toBeLessThan(legacyBytes / 5);
  console.log(
    `HISTORY_PAYLOAD ${JSON.stringify({ titles: TITLES, episodesPerTitle: EPISODES, firstWindow: FIRST_WINDOW, legacyBytes, splitBytes, reduction: 1 - splitBytes / legacyBytes })}`,
  );

  const oldWork = () => structuredClone(legacyReply());
  const splitWork = () => structuredClone(splitReply());
  if (process.env.DEN_HISTORY_RESPONSE_ALLOCATION_AUDIT === '1') {
    const samples = [];
    for (let repeat = 0; repeat < 3; repeat++)
      for (const [name, work] of repeat % 2
        ? [
            ['summary plus first detail query', splitWork] as const,
            ['legacy full History reply', oldWork] as const,
          ]
        : [
            ['legacy full History reply', oldWork] as const,
            ['summary plus first detail query', splitWork] as const,
          ])
        samples.push(await allocationSample(name, work));
    console.log(`HISTORY_DERIVATION_CLONE_ALLOCATION ${JSON.stringify(samples)}`);
    const old = samples.filter((sample) => sample.name.startsWith('legacy'));
    const splitSamples = samples.filter((sample) => sample.name.startsWith('summary'));
    expect(Math.max(...splitSamples.map((sample) => sample.allocatedBytes))).toBeLessThan(
      Math.min(...old.map((sample) => sample.allocatedBytes)) / 2,
    );
  }

  const full = bench('legacy History derivation and full reply clone', oldWork);
  const first = bench('split History derivation and first-detail reply clone', splitWork);
  // These are deliberately large reducer/clone operations. Tinybench's 64-sample default turns the evidence run
  // into minutes of duplicate work and can hit CI's timeout; five measured calls already sit above timer noise.
  const results = await bench.compare(full, first, { iterations: 5, time: 0, warmup: false });
  const legacyResult = results.get('legacy History derivation and full reply clone');
  const splitResult = results.get('split History derivation and first-detail reply clone');
  expect(splitResult.latency.mean).toBeLessThan(legacyResult.latency.mean / 2);
  expect(splitResult).toBeFasterThan(legacyResult);
});
