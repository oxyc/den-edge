import { expect, test, vi } from 'vitest';
import { nameLibraryTitles } from './libraryNaming';
import type { LibraryModel } from './libraryModel.svelte';
import { LibraryServiceClient } from './libraryServiceClient';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type ContinueView,
  type LibraryMetadataShape,
  type LibraryMetadataTitle,
  type LibraryOverviewView,
  type LibrarySelectionValue,
  type LibraryServiceClientMessage,
  type LibraryServiceServerMessage,
  type PresenceView,
  type TitleRef,
} from './libraryServiceProtocol';
import { WorkerLibraryServiceTransport } from './libraryServiceWorkerTransport';
import { legacyProfileSession } from './profileSession.svelte';

// A Home load the size of d.oxy.fi's (0.264.42): 744 series needing shapes and ~760 titles named in 64-title
// batches. Each answered batch records its shapes, so the Worker republishes Continue (one fewer batch of
// `needsShapes`) and every open presence row. The row count is chosen to give ~250 replies, as that trace did.
const SERIES = 744;
const MOVIES = 16;
const PRESENCE_ROWS = 15;
const key = (ref: TitleRef) => `${ref.type}:${ref.id}`;

const series: TitleRef[] = Array.from({ length: SERIES }, (_, index) => ({
  type: 'tv',
  id: 1_000 + index,
}));
const movies: TitleRef[] = Array.from({ length: MOVIES }, (_, index) => ({
  type: 'movie',
  id: 50_000 + index,
}));
const metadata = new Map<string, LibraryMetadataTitle>(
  [...series, ...movies].map((ref) => [
    key(ref),
    {
      ...ref,
      title: `Title ${ref.id}`,
      posterPath: `/poster-${ref.id}.jpg`,
      backdropPath: `/backdrop-${ref.id}.jpg`,
      year: 2001 + (ref.id % 20),
      releaseDate: `${2001 + (ref.id % 20)}-04-12`,
      rating: 7.4,
      ratingSource: 'tmdb',
      votes: 1_200 + ref.id,
      popularity: 31.5,
      countries: ['US', 'GB'],
      people: Array.from({ length: 12 }, (_, index) => ref.id * 100 + index + 1),
      genreIds: [18, 80, 9648],
      originalLanguage: 'en',
      imdbId: `tt${ref.id}`,
    },
  ]),
);
const shapes = new Map<string, LibraryMetadataShape>(
  series.map((ref) => [
    key(ref),
    {
      title: { type: 'tv', id: ref.id },
      seasons: Array.from({ length: 5 }, (_, index) => ({ season: index + 1, episodes: 10 })),
      lastAired: { season: 5, episode: 10 },
    },
  ]),
);
const overview: LibraryOverviewView = {
  kind: 'overview',
  owned: [],
  watched: series.slice(40),
  watchlist: [...movies, ...series.slice(0, 40)],
  standings: [...series, ...movies].map((title) => ({ title, standing: 'watchlist' as const })),
  weighted: [],
  seeds: { watched: series.slice(40, 50), watchlisted: movies.slice(0, 10) },
};
const rows = Array.from({ length: PRESENCE_ROWS }, (_, row) =>
  series.slice(row * 20, row * 20 + 20),
);
const presence = (titles: readonly TitleRef[]): PresenceView => ({
  kind: 'presence',
  items: titles.map((title) => ({ title, standing: 'watchlist', reaction: null })),
});
/** What Home's naming effect asks on every Continue replacement. */
const homeRefs = (view: ContinueView) => [
  ...view.needsShapes,
  ...view.items.map(({ title }) => title),
  ...overview.watchlist.slice(0, 40),
  ...overview.seeds.watched,
  ...overview.seeds.watchlisted,
];

class FakeWorker {
  readonly #listeners = new Set<(event: { data: unknown }) => void>();
  readonly #shaped = new Set<string>();
  /** What each subscription currently selects, and whether an answered batch changes it. */
  readonly #subscriptions = new Map<
    string,
    { value: () => LibrarySelectionValue; republish: boolean }
  >();
  #revision = 0;
  replies = 0;

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.#listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.#listeners.delete(listener);
  }
  terminate(): void {}

  postMessage(request: LibraryServiceClientMessage): void {
    for (const reply of this.#answer(request))
      queueMicrotask(() => {
        this.replies++;
        for (const listener of this.#listeners) listener({ data: [reply] });
      });
  }

  #version() {
    return { instance: 'worker-1', generation: 'generation-1', revision: ++this.#revision };
  }

  #continue(): ContinueView {
    return {
      kind: 'continue',
      items: series.slice(0, 20).map((title, index) => ({
        title,
        fraction: 0.5,
        episode: { season: 1, episode: index + 1 },
        seconds: 600,
        updatedAt: 1_700_000_000_000 + index,
      })),
      needsShapes: series.filter((ref) => !this.#shaped.has(key(ref))),
    };
  }

  #update(subscriptionId: string): LibraryServiceServerMessage {
    return {
      type: 'update',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      subscriptionId,
      version: this.#version(),
      value: this.#subscriptions.get(subscriptionId)!.value(),
    };
  }

  #answer(request: LibraryServiceClientMessage): LibraryServiceServerMessage[] {
    const protocol = LIBRARY_SERVICE_PROTOCOL;
    if (request.type === 'hello')
      return [
        {
          type: 'ready',
          protocol,
          requestId: request.requestId,
          relayMembership: null,
          version: { instance: 'worker-1', generation: 'generation-1', revision: 0 },
        },
      ];
    if (request.type === 'subscribe') {
      const { selection } = request;
      this.#subscriptions.set(request.subscriptionId, {
        value:
          selection.kind === 'overview'
            ? () => overview
            : selection.kind === 'continue'
              ? () => this.#continue()
              : () => presence(selection.kind === 'presence' ? selection.titles : []),
        republish: selection.kind !== 'overview',
      });
      return [
        {
          type: 'subscribed',
          protocol,
          requestId: request.requestId,
          subscriptionId: request.subscriptionId,
          version: this.#version(),
        },
        this.#update(request.subscriptionId),
      ];
    }
    if (request.type === 'query' && request.query.kind === 'library.metadata') {
      const refs = request.query.titles;
      for (const ref of refs) if (ref.type === 'tv') this.#shaped.add(key(ref));
      const answer: LibraryServiceServerMessage = {
        type: 'query-result',
        protocol,
        requestId: request.requestId,
        version: this.#version(),
        result: {
          kind: 'library.metadata',
          titles: refs.map((ref) => metadata.get(key(ref))!),
          shapes: refs.flatMap((ref) => shapes.get(key(ref)) ?? []),
          retryable: [],
        },
      };
      const republished = [...this.#subscriptions]
        .filter(([, { republish }]) => republish)
        .map(([id]) => this.#update(id));
      return [answer, ...republished];
    }
    throw new Error(`unexpected ${request.type}`);
  }
}

async function homeLoad(): Promise<{ replies: number; batches: number; named: number }> {
  const worker = new FakeWorker();
  const client = new LibraryServiceClient(
    new WorkerLibraryServiceTransport(worker as unknown as Worker),
    'bench',
  );
  let batches = 0;
  const model = {
    async libraryMetadata(titles: readonly TitleRef[]) {
      batches++;
      const { result } = await client.query({ kind: 'library.metadata', titles: [...titles] });
      if (result.kind !== 'library.metadata') throw new Error('expected metadata');
      return result;
    },
    close() {},
  } as unknown as LibraryModel;
  const session = legacyProfileSession('benchmark', false, model, {
    query: vi.fn(),
    onStatus: () => () => {},
  });
  const passes: Promise<void>[] = [];
  await client.open({ libraryKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', mode: 'online' });
  await client.subscribe({ kind: 'overview' }, () => {});
  await Promise.all(rows.map((titles) => client.subscribe({ kind: 'presence', titles }, () => {})));
  await client.subscribe({ kind: 'continue' }, (value) => {
    if (value.kind === 'continue') passes.push(nameLibraryTitles(session, homeRefs(value)));
  });
  for (let settled = 0; settled < passes.length; settled = passes.length)
    await Promise.all(passes.slice(settled));
  const named = session.displayTitles().size;
  session.close();
  client.close();
  return { replies: worker.replies, batches, named };
}

test('Home load through the library client, transport and session', async () => {
  const shape = await homeLoad();
  expect(shape.named).toBe(SERIES + MOVIES);
  for (let warm = 0; warm < 10; warm++) await homeLoad();
  const wall: number[] = [];
  const cpu: number[] = [];
  for (let run = 0; run < 60; run++) {
    const started = performance.now();
    const usage = process.cpuUsage();
    await homeLoad();
    const used = process.cpuUsage(usage);
    wall.push(performance.now() - started);
    cpu.push((used.user + used.system) / 1_000);
  }
  const median = (samples: number[]) => samples.sort((a, b) => a - b)[samples.length >> 1]!;
  console.log(
    `Home load: ${shape.replies} replies, ${shape.batches} metadata batches, ${shape.named} titles; ` +
      `median wall ${median(wall).toFixed(2)}ms, median CPU ${median(cpu).toFixed(2)}ms`,
  );
});
