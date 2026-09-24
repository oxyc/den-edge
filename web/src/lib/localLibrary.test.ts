import { expect, it, vi } from 'vitest';
import { followLocalLibrary } from './localLibrary';
import type { Vault } from './localVault';
import { LibraryLog } from './log';
import type { Stamp, TitleRow } from './wire';

const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const at = (t: number): Stamp => [t, 0, 'web1'];

function row(id: number): TitleRow {
  return {
    kind: 'rec',
    schema: 2,
    title: { type: 'movie', id },
    status: { value: 'watchlist', at: at(1000) },
    resume: { value: 0, at: at(1000), viewing: 0 },
    reaction: { value: null, at: at(1000) },
    deleted: { value: false, at: at(1000) },
    dismissed: { value: false, at: at(1000) },
    episodesReset: null,
    addedAt: 1000,
    watchedAt: null,
  };
}

function memoryVault() {
  const data = new Map<string, Uint8Array>();
  const vault: Vault = {
    get: async (k) => data.get(k),
    put: async (k, value) => void data.set(k, value),
    remove: async (prefix) => {
      for (const k of [...data.keys()]) if (k.startsWith(prefix)) data.delete(k);
    },
  };
  return { data, vault };
}

/**
 * Two tabs opened together on a first visit each made a key for this browser's own library, and the one written last
 * is kept. The other tab went on writing to a library no later visit opens.
 */
it("moves this tab's rows into the library another tab's key keeps, and goes on with that key", async () => {
  const { vault } = memoryVault();
  const [lost, kept] = [key(1), key(2)];
  const ours = (await LibraryLog.openLocal(lost, vault))!;
  await ours.write(row(1));
  const theirs = (await LibraryLog.openLocal(kept, vault))!;
  await theirs.write(row(2));
  await vi.waitFor(async () =>
    expect((await LibraryLog.openLocal(kept, vault))!.rows()).toHaveLength(1),
  );

  const tab = new EventTarget();
  const rekeyed: string[] = [];
  const stop = followLocalLibrary(lost, (next) => rekeyed.push(next), tab, vault);
  const storage = (k: string, newValue: string | null) =>
    tab.dispatchEvent(Object.assign(new Event('storage'), { key: k, newValue }));
  storage('den.links', kept);
  storage('den.localLibrary', null);
  storage('den.localLibrary', kept);
  await vi.waitFor(() => expect(rekeyed).toEqual([kept]));

  const merged = (await LibraryLog.openLocal(kept, vault))!;
  expect(merged.title({ type: 'movie', id: 1 }), "this tab's row").toBeDefined();
  expect(merged.title({ type: 'movie', id: 2 })).toBeDefined();
  expect((await LibraryLog.openLocal(lost, vault))!.rows(), 'the lost library is dropped').toEqual(
    [],
  );
  stop();
  storage('den.localLibrary', key(3));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(rekeyed).toEqual([kept]);
});

/**
 * Two tabs open this browser's own library, each with its own copy of it, and each saves its copy whole. The tab that
 * saved last kept only its own rows, and a row the other tab had saved was gone on the next visit.
 */
it("keeps both tabs' rows when two tabs save one library", async () => {
  const { vault } = memoryVault();
  const [one, two] = [
    (await LibraryLog.openLocal(key(1), vault))!,
    (await LibraryLog.openLocal(key(1), vault))!,
  ];
  expect(await one.writeRows([row(1)])).toBe(true);
  expect(await two.writeRows([row(2)])).toBe(true);

  const next = (await LibraryLog.openLocal(key(1), vault))!;
  expect(next.title({ type: 'movie', id: 1 }), "the first tab's row").toBeDefined();
  expect(next.title({ type: 'movie', id: 2 })).toBeDefined();
  expect(
    two.title({ type: 'movie', id: 1 }),
    "the second tab took up the first tab's row",
  ).toBeDefined();
});

/** The same, with both saves under way at once: `navigator.locks` takes them one at a time. */
it("keeps both tabs' rows when two tabs save one library at once", async () => {
  const { vault } = memoryVault();
  let held = Promise.resolve();
  const names: string[] = [];
  vi.stubGlobal('navigator', {
    locks: {
      request: (name: string, work: () => Promise<unknown>) => {
        names.push(name);
        const run = held.then(work);
        held = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    },
  });
  try {
    const [one, two] = [
      (await LibraryLog.openLocal(key(1), vault))!,
      (await LibraryLog.openLocal(key(1), vault))!,
    ];
    await Promise.all([one.writeRows([row(1)]), two.writeRows([row(2)])]);

    const next = (await LibraryLog.openLocal(key(1), vault))!;
    expect(next.title({ type: 'movie', id: 1 })).toBeDefined();
    expect(next.title({ type: 'movie', id: 2 })).toBeDefined();
    expect(new Set(names).size, 'one lock for the library').toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
