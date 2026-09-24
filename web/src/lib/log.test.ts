import { describe, expect, it, vi } from 'vitest';
import { addToWatchlist, blankTitle, react } from './actions';
import type { Vault } from './localVault';
import {
  applyLog,
  continueWatching,
  untitled,
  watchlist,
  withDisplay,
  type Library,
} from './library';
import { LibraryLog } from './log';
import { forgetLibraryCredential, hasLibraryCredential, useLibraryCredential } from './relayFetch';
import { recordTrackerEvent, trackerEvent } from './trackerEvents';
import { fetchDetails } from './tmdb';
import { deriveKeys, seal, type EpisodeRow, type Row, type Stamp, type TitleRow } from './wire';

const LIBRARY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const at = (t: number, device = 'tv01'): Stamp => [t, 0, device];

function row(id: number, overrides: Partial<TitleRow> = {}): TitleRow {
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
    ...overrides,
  };
}

/**
 * den-edge's `/lib` in memory, with library.rs's rules: `changes` paged in sequence order (two a page, so paging
 * is exercised), and `batch` with compare-and-set on each row's sequence.
 */
async function edge(rows: Row[] = [], extra: { k: string; v: string }[] = []) {
  const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
  let head = 0;
  const stored = new Map<string, { k: string; seq: number; v: string }>();
  for (const entry of [...(await Promise.all(rows.map((r) => seal(keys, r)))), ...extra]) {
    stored.set(entry.k, { ...entry, seq: ++head });
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    if ((init?.headers as Record<string, string>)['x-den-library-token'] !== keys.token) {
      return new Response('{"error":"forbidden"}', { status: 403 });
    }
    if (init?.method === 'POST') {
      const { writes } = JSON.parse(String(init.body)) as {
        writes: { k: string; base: number; v: string }[];
      };
      const applied: { k: string; seq: number }[] = [];
      const conflicts: { k: string; seq: number; v: string | null }[] = [];
      for (const write of writes) {
        const current = stored.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
          continue;
        }
        stored.set(write.k, { k: write.k, seq: ++head, v: write.v });
        applied.push({ k: write.k, seq: head });
      }
      return new Response(JSON.stringify({ head, applied, conflicts }), { status: 200 });
    }
    const since = Number(new URL(String(input), 'https://den.example').searchParams.get('since'));
    const newer = [...stored.values()].filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
    return new Response(
      JSON.stringify({ entries: newer.slice(0, 2), head, more: newer.length > 2 }),
      { status: 200 },
    );
  };
  return { fetchImpl, stored };
}

function memoryVault() {
  const data = new Map<string, Uint8Array>();
  const vault: Vault = {
    get: async (key) => data.get(key),
    put: async (key, value) => void data.set(key, value),
    remove: async (prefix) => {
      for (const key of [...data.keys()]) if (key.startsWith(prefix)) data.delete(key);
    },
  };
  return { data, vault };
}

function memoryStorage() {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  } as Storage;
  return { data, storage };
}

describe('LibraryLog', () => {
  /**
   * The default fetch is kept on the instance and later called as `this.fetchImpl(…)` — a METHOD call,
   * and a browser's `fetch` refuses one whose `this` is anything but the window. So every write threw
   * before making a request, and the catch turned it into "Couldn't save that" with nothing in the
   * Network tab to explain it. Only `open` escaped, by calling its local binding.
   *
   * Every other test here injects a plain function, which has no such objection — which is exactly why
   * none of them noticed. This one stubs a `fetch` as strict about `this` as a browser is.
   */
  it('survives its own default fetch being called as a method', async () => {
    const server = await edge([row(1)]);
    const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return server.fetchImpl(input, init);
    };
    vi.stubGlobal('fetch', strict);
    try {
      const log = (await LibraryLog.open(LIBRARY_KEY, undefined, undefined, null))!;
      expect(await log.write(row(2))).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts a return visit from the kept copy and asks only for what changed since', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1), row(2), row(3)]);
    const asked: string[] = [];
    const counting: typeof fetch = (input, init) => {
      asked.push(String(input));
      return server.fetchImpl(input, init);
    };
    await LibraryLog.open(LIBRARY_KEY, counting, undefined, vault);
    await vi.waitFor(() => expect(data.size).toBe(1));
    const kept = new TextDecoder().decode([...data.values()][0]);
    expect(kept).not.toContain('watchlist');

    // Meanwhile the TV adds a title and changes another.
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    await tv.write(row(4));
    await tv.write(row(1, { status: { value: 'watched', at: at(2000) } }));

    asked.length = 0;
    const log = (await LibraryLog.open(LIBRARY_KEY, counting, undefined, vault))!;
    expect(asked).toEqual([]);
    expect(log.fromCache).toBe(true);
    expect(log.rows()).toHaveLength(3);
    expect(await log.refresh()).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('since=3');
    expect(log.title({ type: 'movie', id: 4 })?.status.value).toBe('watchlist');
    expect(log.title({ type: 'movie', id: 1 })?.status.value).toBe('watched');

    // The refresh is kept too: the next visit already knows both.
    await vi.waitFor(async () => {
      const next = (await LibraryLog.open(LIBRARY_KEY, counting, undefined, vault))!;
      expect(next.title({ type: 'movie', id: 1 })?.status.value).toBe('watched');
    });
  });

  it('keeps its own write for the next visit once den-edge has echoed it', async () => {
    const { vault } = memoryVault();
    const server = await edge([row(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    await log.write(row(2));
    await log.refresh();
    await vi.waitFor(async () => {
      const next = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
      expect(next.title({ type: 'movie', id: 2 })).toBeDefined();
    });
  });

  /**
   * `LibrarySession` bumps its revision on a refresh that returns true, and every page built from the library is
   * rebuilt on that. A 30-second poll that found nothing returned true, and rebuilt them all every 30 seconds.
   */
  it('says a refresh changed something only when a row arrived', async () => {
    const server = await edge([row(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    expect(await log.refresh(), 'an empty page').toBe(false);
    await log.write(row(2));
    expect(await log.refresh(), 'its own write read back').toBe(false);
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    await tv.write(row(3));
    expect(await log.refresh(), "the TV's write").toBe(true);
    expect(log.title({ type: 'movie', id: 3 })).toBeDefined();
    expect(await log.refresh()).toBe(false);
  });

  /**
   * A refresh that read one page and failed on the next keeps the rows of the first, and said nothing: the next one,
   * finding only this browser's own write, said nothing either, and the TV's rows were never drawn.
   */
  it('says a change a failed refresh read, on the next refresh that finishes', async () => {
    const server = await edge([row(1)]);
    let reads = 0;
    let failSecondRead = false;
    const connection: typeof fetch = async (url, init) => {
      if (!init?.method && failSecondRead && ++reads === 2) throw new TypeError('offline');
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    await tv.write(row(2));
    await tv.write(row(3));
    await log.write(row(4));
    failSecondRead = true;
    expect(await log.refresh(), 'failed on its second page').toBe(false);
    expect(await log.refresh(), "the TV's rows it read before").toBe(true);
    expect(log.title({ type: 'movie', id: 2 })).toBeDefined();
    expect(await log.refresh()).toBe(false);
  });

  /** Refresh and writes share one queue: a read den-edge never answered held every later save behind it. */
  it('gives up on a request den-edge never answers, and saves after it', async () => {
    const server = await edge([row(1)]);
    let stall = false;
    const connection: typeof fetch = (url, init) =>
      stall && init?.method !== 'POST'
        ? new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
          )
        : server.fetchImpl(url, init);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      stall = true;
      const refreshed = log.refresh();
      const saved = log.write(row(2));
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await refreshed).toBe(false);
      expect(await saved).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same limit covered the whole body: a large page of `/changes` on a slow link, arriving all along, was cut off
   * at 20 seconds every time. It now limits only the wait for den-edge to start answering, and each stall after.
   */
  it('reads an answer that keeps arriving for longer than a request may wait, and gives up on one that stops', async () => {
    const server = await edge([row(1)]);
    let slow = false;
    let stopAfter = Infinity;
    // Each piece of the answer 10 s after the last, and none after `stopAfter` pieces.
    const connection: typeof fetch = async (url, init) => {
      const res = await server.fetchImpl(url, init);
      if (!slow || init?.method) return res;
      const text = await res.text();
      const pieces = [text.slice(0, 10), text.slice(10, 20), text.slice(20)];
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull: (stream) =>
          new Promise<void>((resolve, reject) => {
            if (sent >= stopAfter) return;
            const next = setTimeout(() => {
              const piece = pieces[sent++];
              if (piece === undefined) stream.close();
              else stream.enqueue(new TextEncoder().encode(piece));
              resolve();
            }, 10_000);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(next);
              reject(init.signal!.reason);
            });
          }),
      });
      return new Response(body, { status: res.status });
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    await tv.write(row(2));
    // A limit on the whole request, as before, on the same clock as the answer.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      slow = true;
      const refreshed = log.refresh();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(50_000);
      expect(await refreshed, 'arrived over 40 s').toBe(true);
      expect(log.title({ type: 'movie', id: 2 })).toBeDefined();

      await tv.write(row(3));
      stopAfter = 1;
      const stalled = log.refresh();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await stalled, 'stopped after its first piece').toBe(false);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  /** A first read cut off part way started again from the first page on every visit, and on a slow link never ended. */
  it('goes on with a first read from the last page it kept', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1), row(2), row(3), row(4), row(5)]);
    const asked: string[] = [];
    let failAt = 2;
    const connection: typeof fetch = async (url, init) => {
      if (!init?.method) {
        asked.push(String(url));
        if (asked.length === failAt) throw new TypeError('offline');
      }
      return server.fetchImpl(url, init);
    };
    expect(await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault)).toBeNull();
    await vi.waitFor(() => expect(data.size).toBe(1));
    asked.length = 0;
    failAt = 0;
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault))!;
    expect(log.fromCache).toBe(false);
    expect(asked[0]).toContain('since=2');
    expect(log.rows()).toHaveLength(5);
    await vi.waitFor(async () => {
      expect(data.size, 'only the whole copy is kept').toBe(1);
      const next = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault))!;
      expect(next.fromCache).toBe(true);
      expect(next.rows()).toHaveLength(5);
    });
  });

  it('shows the kept copy without waiting on den-edge, and sends kept work on the refresh after', async () => {
    const { vault } = memoryVault();
    const data = new Map<string, string>();
    const storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    } as Storage;
    const server = await edge([row(1)]);
    await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, vault);
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const journal = recordTrackerEvent(blank, addToWatchlist(blank, at(1000)), at(1000), 'kept')!;
    data.set(`den.pendingTracker.${keys.id}.kept`, JSON.stringify(await seal(keys, journal)));
    await vi.waitFor(async () => {
      const hung: typeof fetch = () => new Promise(() => undefined);
      const log = (await LibraryLog.open(LIBRARY_KEY, hung, storage, vault))!;
      expect(log.fromCache).toBe(true);
    });
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, vault))!;
    expect(log.pendingActions).toBe(1);
    expect(await log.refresh()).toBe(true);
    expect(log.pendingActions).toBe(0);
    expect(log.title(blank.title)?.status.value).toBe('watchlist');
  });

  /**
   * A return visit opens from the kept copy without asking den-edge anything. The action this browser kept unsent
   * was not drawn until a refresh reached den-edge: reloaded while it was out of reach, the mark was gone.
   */
  it('draws kept work on a return visit while den-edge is out of reach', async () => {
    const { data: kept, vault } = memoryVault();
    const { data, storage } = memoryStorage();
    const server = await edge([row(1)]);
    await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, vault);
    await vi.waitFor(() => expect(kept.size).toBe(1));
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const journal = recordTrackerEvent(blank, addToWatchlist(blank, at(2000)), at(2000), 'kept')!;
    data.set(`den.pendingTracker.${keys.id}.kept`, JSON.stringify(await seal(keys, journal)));
    const offline: typeof fetch = async () => {
      throw new TypeError('offline');
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, offline, storage, vault))!;
    expect(log.fromCache).toBe(true);
    expect(log.title(blank.title)?.status.value).toBe('watchlist');
    expect(await log.refresh()).toBe(false);
    expect(log.pendingActions).toBe(1);
  });

  /** den-edge answers the read but fails the batch: what the kept work does is drawn, and the refresh says so. */
  it('says a refresh changed something when it drew kept work it could not send', async () => {
    const { data, storage } = memoryStorage();
    const server = await edge([row(1)]);
    let failing = false;
    const connection: typeof fetch = async (url, init) =>
      failing && init?.method === 'POST'
        ? new Response('{}', { status: 503 })
        : server.fetchImpl(url, init);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    // Kept by another tab of this browser while den-edge was out of its reach.
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const journal = recordTrackerEvent(blank, addToWatchlist(blank, at(2000)), at(2000), 'kept')!;
    data.set(`den.pendingTracker.${keys.id}.kept`, JSON.stringify(await seal(keys, journal)));
    failing = true;
    expect(await log.refresh()).toBe(true);
    expect(log.title(blank.title)?.status.value).toBe('watchlist');
    expect(await log.refresh(), 'already drawn').toBe(false);
    failing = false;
    expect(await log.refresh()).toBe(true);
    expect(log.pendingActions).toBe(0);
  });

  /** A return visit whose membership den-edge never took claimed none until the first refresh read /changes. */
  it('registers a membership not yet registered as soon as a return visit opens', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1)]);
    let members = 0;
    let refuseMember = true;
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'PUT') {
        members++;
        if (refuseMember) return new Response('{}', { status: 503 });
        return new Response('{}');
      }
      return server.fetchImpl(url, init);
    };
    forgetLibraryCredential();
    await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault);
    await vi.waitFor(() => expect(data.size).toBe(1));
    forgetLibraryCredential();
    refuseMember = false;
    members = 0;
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault))!;
    expect(log.fromCache).toBe(true);
    await vi.waitFor(() => expect(hasLibraryCredential()).toBe(true));
    expect(members).toBe(1);
    await log.refresh();
    expect(members, 'not asked again').toBe(1);
    forgetLibraryCredential();
  });

  it('a copy kept for another library key opens nothing, and the log is read whole', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1)]);
    await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault);
    await vi.waitFor(() => expect(data.size).toBe(1));
    const [key, value] = [...data][0]!;
    const tampered = value.slice();
    tampered[20] = tampered[20]! ^ 1;
    data.set(key, tampered);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    expect(log.fromCache).toBe(false);
    expect(log.title({ type: 'movie', id: 1 })).toBeDefined();
  });

  it('a second relay reset cannot overwrite unfinished recovery from the first', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
      clear: () => data.clear(),
    };
    let server = await edge();
    let writesAllowed = Infinity;
    const connection: typeof fetch = (url, init) => {
      if (init?.method === 'POST' && writesAllowed-- <= 0)
        return Promise.resolve(new Response('{}', { status: 503 }));
      if (init?.method !== 'POST' && !server.stored.size)
        return Promise.resolve(new Response('{}', { status: 404 }));
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const journals = Array.from({ length: 40 }, (_, i) => {
      const before = blankTitle({ type: 'movie', id: i + 1 }, 0);
      return recordTrackerEvent(
        before,
        addToWatchlist(before, at(1000)),
        at(1000),
        'recovery-' + i,
      )!;
    });
    await log.writeActions(journals);
    server = await edge();
    writesAllowed = 1;
    await log.refresh(); // Only the first 32 journals recover.
    server = await edge();
    writesAllowed = 0;
    await log.refresh(); // Must retain the first checkpoint, including the unfinished remainder.
    writesAllowed = Infinity;
    const reopened = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(reopened.pendingActions).toBe(0);
    expect(reopened.title({ type: 'movie', id: 40 })?.status.value).toBe('watchlist');
    expect(reopened.settings('tracker-event:recovery-39')).toBeDefined();
  });

  it('republishes acknowledged actions after the relay is restored empty', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
      clear: () => data.clear(),
    };
    let server = await edge();
    let generation = 'original';
    let memberRegistrations = 0;
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'PUT') {
        memberRegistrations += 1;
        return new Response('{}', { status: server.stored.size ? 200 : 404 });
      }
      if (init?.method !== 'POST' && server.stored.size === 0)
        return new Response(JSON.stringify({ generation }), { status: 404 });
      const res = await server.fetchImpl(url, init);
      return new Response(JSON.stringify({ ...(await res.json()), generation }), {
        status: res.status,
      });
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const before = blankTitle({ type: 'movie', id: 10 }, 0);
    await log.writeAction(
      recordTrackerEvent(before, addToWatchlist(before, at(1000)), at(1000), 'accepted')!,
    );
    expect(log.pendingActions).toBe(0);
    server = await edge();
    generation = 'restored';
    expect(await log.refresh()).toBe(true);
    expect(log.pendingActions).toBe(0);
    const reopened = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(reopened.title(before.title)?.status.value).toBe('watchlist');
    expect(reopened.settings('tracker-event:accepted')).toBeDefined();
    expect(
      memberRegistrations,
      'a restored store invalidates the persisted registration marker and registers again',
    ).toBeGreaterThanOrEqual(3);
  });

  /** README: after a restore, a device "writes back what the snapshot lacks" — it rewrote every row it held. */
  it('writes back only what a restored log lacks', async () => {
    let server = await edge([row(1), row(2), row(3), row(4)]);
    let generation = 'original';
    const sent: number[] = [];
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'POST')
        sent.push((JSON.parse(String(init.body)) as { writes: unknown[] }).writes.length);
      const res = await server.fetchImpl(url, init);
      return new Response(JSON.stringify({ ...(await res.json()), generation }), {
        status: res.status,
      });
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    server = await edge([row(1), row(2), row(3)]);
    generation = 'restored';
    expect(await log.refresh()).toBe(true);
    expect(
      sent.reduce((a, b) => a + b, 0),
      'only row 4',
    ).toBe(1);
    const reopened = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    expect(reopened.rows()).toHaveLength(4);
  });

  it('resends only the kept work den-edge has not applied, and never twice at once', async () => {
    const data = new Map<string, string>();
    const storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    } as Storage;
    const server = await edge([row(1)]);
    let allowed = Infinity;
    let rows = 0;
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'POST') {
        if (allowed-- <= 0) return new Response('{}', { status: 503 });
        rows += (JSON.parse(String(init.body)) as { writes: unknown[] }).writes.length;
      }
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const journals = Array.from({ length: 40 }, (_, i) => {
      const before = blankTitle({ type: 'movie', id: i + 10 }, 0);
      return recordTrackerEvent(before, addToWatchlist(before, at(1000)), at(1000), 'b' + i)!;
    });
    allowed = 1; // The first 32 journals, then den-edge fails.
    await log.writeActions(journals);
    expect(rows).toBe(32);
    allowed = Infinity;
    await log.refresh();
    expect(log.pendingActions).toBe(0);
    expect(rows, 'the 8 journals left, then the 40 titles').toBe(32 + 8 + 40);

    // Two refreshes at once (the timer and a tab coming back) each replay what is kept.
    let offline = false;
    const flaky: typeof fetch = (url, init) =>
      offline ? Promise.reject(new TypeError('offline')) : connection(url, init);
    const again = (await LibraryLog.open(LIBRARY_KEY, flaky, storage))!;
    offline = true;
    for (const id of [90, 91, 92]) {
      const before = blankTitle({ type: 'movie', id }, 0);
      await again.writeAction(
        recordTrackerEvent(before, addToWatchlist(before, at(2000)), at(2000), 'k' + id)!,
      );
    }
    expect(again.pendingActions).toBe(3);
    offline = false;
    rows = 0;
    await Promise.all([again.refresh(), again.refresh()]);
    expect(again.pendingActions).toBe(0);
    expect(rows, 'each journal and title once').toBe(6);
  });

  it('persists a complete bulk action before delivery and retries it in bounded batches', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
      clear: () => data.clear(),
    };
    const server = await edge();
    let offline = false;
    const sizes: number[] = [];
    const connection: typeof fetch = (url, init) => {
      if (offline) return Promise.reject(new TypeError('offline'));
      if (init?.method === 'POST') sizes.push(JSON.parse(String(init.body)).writes.length);
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const journals = Array.from({ length: 65 }, (_, i) => {
      const before = blankTitle({ type: 'movie', id: i + 1 }, 0);
      return recordTrackerEvent(before, addToWatchlist(before, at(1000)), at(1000), 'bulk-' + i)!;
    });
    offline = true;
    expect(await log.writeActions(journals)).toBe(true);
    expect(data.size).toBe(1);
    expect(log.title({ type: 'movie', id: 65 })?.status.value).toBe('watchlist');
    offline = false;
    const restored = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(restored.pendingActions).toBe(0);
    expect(restored.title({ type: 'movie', id: 65 })?.status.value).toBe('watchlist');
    expect(sizes).toEqual([32, 32, 1, 32, 32, 1]);
  });

  it('retries the first offline action when an empty relay still answers 404', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
      clear: () => data.clear(),
    };
    const server = await edge();
    let offline = false;
    const connection: typeof fetch = (url, init) => {
      if (offline) return Promise.reject(new TypeError('offline'));
      if (init?.method !== 'POST' && server.stored.size === 0)
        return Promise.resolve(new Response('{}', { status: 404 }));
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    offline = true;
    await log.writeAction(
      recordTrackerEvent(blank, addToWatchlist(blank, at(1000)), at(1000), 'first')!,
    );
    offline = false;
    expect(await log.refresh()).toBe(true);
    expect(log.pendingActions).toBe(0);
    expect((await LibraryLog.open(LIBRARY_KEY, connection))!.title(blank.title)?.status.value).toBe(
      'watchlist',
    );
  });

  /**
   * A browser holding the key of a library den-edge has no log for, where den-edge starts no library for it
   * (`NEW_LIBRARIES=members`). It used to send its recovery on every 30-second refresh, each refused, and to go
   * on claiming a membership `library::is_member` refuses — so every shared-metadata write was a 401 too.
   */
  it('stops resending to a relay that will not start the library, and claims no membership there', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
      clear: () => data.clear(),
    };
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const journal = recordTrackerEvent(blank, addToWatchlist(blank, at(1000)), at(1000), 'first')!;
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    data.set(`den.pendingTracker.${keys.id}.first`, JSON.stringify(await seal(keys, journal)));
    let server: Awaited<ReturnType<typeof edge>> | null = null;
    let batches = 0;
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'POST') batches++;
      if (server) return server.fetchImpl(url, init);
      if (init?.method === 'POST')
        return new Response('{"error":"new_libraries_closed"}', { status: 403 });
      return new Response('{"error":"not_found"}', { status: 404 });
    };
    useLibraryCredential(keys);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(log.refused).toBe(true);
    expect(hasLibraryCredential(), 'no log, so no membership to claim').toBe(false);
    const tried = batches;
    for (let i = 0; i < 3; i++) expect(await log.refresh(), 'nothing changed').toBe(false);
    expect(batches, 'refreshes read, and send nothing again').toBe(tried);
    expect(log.pendingActions).toBe(1);

    // The TV writes the library back: the next read finds it, and the kept action goes out.
    server = await edge([row(1)]);
    expect(await log.refresh()).toBe(true);
    expect(log.refused).toBe(false);
    expect(hasLibraryCredential()).toBe(true);
    expect(log.pendingActions).toBe(0);
    expect(log.title(blank.title)?.status.value).toBe('watchlist');
    forgetLibraryCredential();
  });

  /** den-edge opened to new libraries again: a refused log tries once more after a while, not only on a reload. */
  it('tries a refused library again after a while, and starts it once den-edge lets it', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
      clear: () => data.clear(),
    };
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const journal = recordTrackerEvent(blank, addToWatchlist(blank, at(1000)), at(1000), 'first')!;
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    data.set(`den.pendingTracker.${keys.id}.first`, JSON.stringify(await seal(keys, journal)));
    const server = await edge();
    let open = false;
    let batches = 0;
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'POST') {
        batches++;
        if (!open) return new Response('{"error":"new_libraries_closed"}', { status: 403 });
      } else if (init?.method !== 'PUT' && server.stored.size === 0) {
        return new Response('{"error":"not_found"}', { status: 404 });
      }
      return server.fetchImpl(url, init);
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
      expect(log.refused).toBe(true);
      const tried = batches;
      open = true; // NEW_LIBRARIES=open
      expect(await log.refresh()).toBe(false);
      expect(batches, 'not straight away').toBe(tried);

      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(await log.refresh()).toBe(true);
      expect(batches).toBeGreaterThan(tried);
      expect(log.pendingActions).toBe(0);
      expect(await log.refresh(), 'its own write read back is no change').toBe(false);
      expect(log.refused).toBe(false);
      expect(hasLibraryCredential(), 'the log is there, and so is the membership').toBe(true);
    } finally {
      vi.useRealTimers();
      forgetLibraryCredential();
    }
  });

  /**
   * `413 library_full` (or any 400/403 but `new_libraries_closed`) is den-edge refusing the write itself. Kept work it
   * refused was sent again on every 30-second refresh, forever, and a fresh action said it was saved.
   */
  it('tells a refused action apart from an unreachable den-edge, and does not resend it every refresh', async () => {
    const data = new Map<string, string>();
    const storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    } as Storage;
    const server = await edge([row(1)]);
    let full = false;
    let offline = false;
    let batches = 0;
    const connection: typeof fetch = async (url, init) => {
      if (offline) throw new TypeError('offline');
      if (init?.method === 'POST') {
        batches++;
        if (full) return new Response('{"error":"library_full"}', { status: 413 });
      }
      return server.fetchImpl(url, init);
    };
    const action = (id: number, name: string) => {
      const blank = blankTitle({ type: 'movie', id }, 0);
      return recordTrackerEvent(blank, addToWatchlist(blank, at(1000)), at(1000), name)!;
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
      full = true;
      expect(await log.writeAction(action(10, 'single')), 'refused, not saved').toBeNull();
      expect(await log.writeActions([action(11, 'bulk')])).toBe(false);
      expect(log.pendingActions, 'nothing kept to be refused again').toBe(0);
      expect(log.title({ type: 'movie', id: 10 })).toBeUndefined();
      expect(log.title({ type: 'movie', id: 11 })).toBeUndefined();

      // Kept while out of reach, then refused once den-edge is back.
      offline = true;
      expect(await log.writeAction(action(12, 'kept'))).not.toBeNull();
      offline = false;
      expect(log.pendingActions).toBe(1);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await log.refresh();
      expect(log.pendingActions, 'kept, as it was saved on this device').toBe(1);
      const tried = batches;
      for (let i = 0; i < 3; i++) await log.refresh();
      expect(batches, 'not sent again on every refresh').toBe(tried);
      full = false;
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await log.refresh();
      expect(log.pendingActions).toBe(0);
      expect(log.title({ type: 'movie', id: 12 })?.status.value).toBe('watchlist');
    } finally {
      vi.useRealTimers();
    }
  });

  /** A 400 or 403 den-edge's `/lib` never sends (a proxy's page) is not a refusal: the action stays kept. */
  it('keeps an action refused with an answer den-edge does not give, and sends it on the next refresh', async () => {
    const { storage } = memoryStorage();
    const server = await edge([row(1)]);
    let proxy = false;
    const connection: typeof fetch = async (url, init) =>
      proxy && init?.method === 'POST'
        ? new Response('<html>Bad Request</html>', { status: 400 })
        : server.fetchImpl(url, init);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    proxy = true;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const journal = recordTrackerEvent(blank, addToWatchlist(blank, at(2000)), at(2000), 'proxy')!;
    expect(await log.writeAction(journal), 'kept on this device').not.toBeNull();
    expect(log.pendingActions).toBe(1);
    proxy = false;
    await log.refresh();
    expect(log.pendingActions).toBe(0);
  });

  /** One kept action den-edge refused held every other one kept later back for ten minutes. */
  it('holds back only the kept work den-edge refused', async () => {
    const { data, storage } = memoryStorage();
    const server = await edge([row(1)]);
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const action = (id: number, name: string) => {
      const blank = blankTitle({ type: 'movie', id }, 0);
      return recordTrackerEvent(blank, addToWatchlist(blank, at(2000)), at(2000), name)!;
    };
    const refusedK = (await seal(keys, action(10, 'bad'))).k;
    let batches = 0;
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'POST') {
        batches++;
        if (String(init.body).includes(refusedK))
          return new Response('{"error":"invalid_batch"}', { status: 400 });
      }
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const keep = async (name: string, id: number) =>
      data.set(
        `den.pendingTracker.${keys.id}.${name}`,
        JSON.stringify(await seal(keys, action(id, name))),
      );
    await keep('bad', 10);
    await log.refresh();
    expect(log.pendingActions).toBe(1);
    const tried = batches;
    await log.refresh();
    expect(batches, 'the refused one is not sent again at once').toBe(tried);
    // Kept later, by another tab.
    await keep('good', 11);
    await log.refresh();
    expect(log.pendingActions, 'sent, though another was refused').toBe(1);
    expect(log.title({ type: 'movie', id: 11 })?.status.value).toBe('watchlist');
  });

  /**
   * A bulk's first chunks landed and a later one was refused: it said none of it was saved and dropped it, while
   * den-edge held part of it.
   */
  it('keeps a bulk den-edge refused part of, once some of it landed', async () => {
    const { storage } = memoryStorage();
    const server = await edge([row(1)]);
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const journal = recordTrackerEvent(blank, addToWatchlist(blank, at(2000)), at(2000), 'bulk')!;
    const afterK = (await seal(keys, trackerEvent(journal)!.after)).k;
    const connection: typeof fetch = async (url, init) =>
      init?.method === 'POST' && String(init.body).includes(afterK)
        ? new Response('{"error":"library_full"}', { status: 413 })
        : server.fetchImpl(url, init);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(await log.writeActions([journal]), 'the journal landed').toBe(true);
    expect(log.pendingActions, 'the rest is kept').toBe(1);
    expect(log.title(blank.title)?.status.value).toBe('watchlist');
  });

  it('drops kept work that is not an action, which could never be sent', async () => {
    const data = new Map<string, string>();
    const storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    } as Storage;
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    data.set(`den.pendingTracker.${keys.id}.odd`, JSON.stringify(await seal(keys, row(5))));
    data.set(
      `den.pendingTracker.${keys.id}.bulk:odd`,
      JSON.stringify({ bulk: [await seal(keys, row(6))] }),
    );
    data.set(`den.pendingTracker.${keys.id}.unreadable`, JSON.stringify({ k: 'ab', v: 'AAAA' }));
    const server = await edge([row(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage))!;
    expect(log.pendingActions, 'only the one that does not open is kept').toBe(1);
  });

  it('skips an unreadable incremental row and still reaches later changes', async () => {
    const server = await edge();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    server.stored.set('bad', { k: 'ab'.repeat(32), seq: 1, v: 'AAAA' });
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const good = await seal(keys, row(11));
    server.stored.set(good.k, { ...good, seq: 2 });
    expect(await log.refresh()).toBe(true);
    expect(log.title({ type: 'movie', id: 11 })?.status.value).toBe('watchlist');
  });

  it('a failed pending cleanup does not reject an accepted action', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: () => {
        throw new Error('storage denied');
      },
      clear: () => data.clear(),
    };
    const server = await edge();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    expect(
      await log.writeAction(
        recordTrackerEvent(blank, addToWatchlist(blank, at(1000)), at(1000), 'cleanup')!,
      ),
    ).not.toBeNull();
    expect(log.title(blank.title)?.status.value).toBe('watchlist');
    expect(log.pendingActions).toBe(1);
  });

  it('serializes concurrent same-row saves without losing either field', async () => {
    const { fetchImpl } = await edge();
    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    await Promise.all([
      log.write(addToWatchlist(blank, at(1000, 'web'))),
      log.write(react(blank, 'love', at(2000, 'web'))),
    ]);
    const restored = (await LibraryLog.open(LIBRARY_KEY, fetchImpl))!.title(blank.title)!;
    expect(restored.status.value).toBe('watchlist');
    expect(restored.reaction.value).toBe('love');
  });

  it('reconstructs state from an accepted journal if the following projection write fails', async () => {
    const server = await edge();
    let writes = 0;
    const flaky: typeof fetch = (url, init) => {
      if (init?.method === 'POST' && ++writes === 2)
        return Promise.resolve(new Response('{}', { status: 503 }));
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, flaky))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const event = recordTrackerEvent(
      blank,
      addToWatchlist(blank, at(1000, 'web')),
      at(1000, 'web'),
      'crash',
    )!;
    expect(await log.writeAction(event)).not.toBeNull();
    const restored = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    expect(restored.title(blank.title)?.status.value).toBe('watchlist');
  });

  it('persists encrypted offline actions, then retries them after reopening', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
      clear: () => data.clear(),
    };
    const server = await edge();
    let offline = false;
    const connection: typeof fetch = (url, init) =>
      offline ? Promise.reject(new TypeError('offline')) : server.fetchImpl(url, init);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const event = recordTrackerEvent(
      blank,
      addToWatchlist(blank, at(1000, 'web')),
      at(1000, 'web'),
      'offline',
    )!;
    offline = true;
    expect(await log.writeAction(event)).not.toBeNull();
    expect(log.pendingActions).toBe(1);
    expect([...data.values()].join('')).not.toContain('watchlist');
    offline = false;
    const restored = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(restored.pendingActions).toBe(0);
    expect(restored.title(blank.title)?.status.value).toBe('watchlist');
  });
  it('reads every page and opens each row, skipping one that does not open', async () => {
    const rows = [row(1), row(2), row(3)];
    const { fetchImpl } = await edge(rows, [{ k: 'ab'.repeat(32), v: 'AAAA' }]);
    expect((await LibraryLog.open(LIBRARY_KEY, fetchImpl))?.rows()).toEqual(rows);
  });

  it('is empty for a library nobody wrote, and null when den-edge is out of reach', async () => {
    expect(
      (await LibraryLog.open(LIBRARY_KEY, async () => new Response('{}', { status: 404 })))?.rows(),
    ).toEqual([]);
    expect(
      await LibraryLog.open(LIBRARY_KEY, async () => Promise.reject(new TypeError('offline'))),
    ).toBeNull();
    expect(
      await LibraryLog.open(LIBRARY_KEY, async () => new Response('{}', { status: 500 })),
    ).toBeNull();
  });

  it('says when the TV moved the library to a new key', async () => {
    const gone: typeof fetch = async () =>
      new Response('{"error":"library_moved"}', { status: 410 });
    const opened = await LibraryLog.open(LIBRARY_KEY, gone);
    expect([opened?.moved, opened?.rows()]).toEqual([true, []]);

    const { fetchImpl } = await edge();
    const log = await LibraryLog.open(LIBRARY_KEY, async (input, init) =>
      init?.method === 'POST' ? gone(input, init) : fetchImpl(input, init),
    );
    expect(log?.moved).toBe(false);
    expect(
      await log!.write(addToWatchlist(blankTitle({ type: 'tv', id: 1 }, 0), at(1))),
    ).toBeNull();
    expect(log?.moved).toBe(true);
  });

  it('knows the newest stamp it read', async () => {
    const { fetchImpl } = await edge([
      row(1),
      row(2, { reaction: { value: 'love', at: at(9000, 'web1') } }),
    ]);
    expect((await LibraryLog.open(LIBRARY_KEY, fetchImpl))?.newestStamp()).toEqual(
      at(9000, 'web1'),
    );
  });

  it('writes a title new to the library, and a stale write merges on top of the row that beat it', async () => {
    const { fetchImpl } = await edge();
    const [phone, laptop] = [
      await LibraryLog.open(LIBRARY_KEY, fetchImpl),
      await LibraryLog.open(LIBRARY_KEY, fetchImpl),
    ];
    const ref = { type: 'movie' as const, id: 438631 };

    // The phone adds it; the laptop, which read the log before that, reacts to it.
    expect(
      await phone!.write(addToWatchlist(blankTitle(ref, 5000), at(5000, 'ph01'))),
    ).not.toBeNull();
    const stored = await laptop!.write(react(blankTitle(ref, 6000), 'love', at(6000, 'lt01')));
    expect(stored?.kind === 'rec' && [stored.status.value, stored.reaction.value]).toEqual([
      'watchlist',
      'love',
    ]);

    const reread = await LibraryLog.open(LIBRARY_KEY, fetchImpl);
    expect(reread?.title(ref)?.status.value).toBe('watchlist');
    expect(reread?.title(ref)?.reaction.value).toBe('love');
    expect(reread?.title(ref)?.addedAt).toBe(5000);
  });

  it('says so when a write cannot be saved', async () => {
    const { fetchImpl } = await edge();
    const log = await LibraryLog.open(LIBRARY_KEY, fetchImpl);
    const offline = await LibraryLog.open(LIBRARY_KEY, async (input, init) =>
      init?.method === 'POST' ? Promise.reject(new TypeError('offline')) : fetchImpl(input, init),
    );
    expect(log).not.toBeNull();
    expect(
      await offline!.write(addToWatchlist(blankTitle({ type: 'tv', id: 1 }, 0), at(1))),
    ).toBeNull();
  });
});

describe('a library kept only in this browser', () => {
  const LOCAL_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

  it('keeps what someone does with no TV, and asks den-edge nothing', async () => {
    const { vault } = memoryVault();
    const asked: string[] = [];
    const counting: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response('{}', { status: 500 });
    };
    const log = (await LibraryLog.openLocal(LOCAL_KEY, vault, counting))!;
    expect(await log.write(row(1))).not.toBeNull();
    const before = log.title({ type: 'movie', id: 1 })!;
    const journal = recordTrackerEvent(before, react(before, 'love', at(3000)), at(3000))!;
    expect(await log.writeActions([journal])).toBe(true);
    expect(await log.refresh()).toBe(false);
    await vi.waitFor(async () => {
      const again = (await LibraryLog.openLocal(LOCAL_KEY, vault, counting))!;
      expect(again.title({ type: 'movie', id: 1 })?.reaction.value).toBe('love');
    });
    expect(asked).toEqual([]);
  });

  it("moves into a TV's library, merged with what the TV has, and is then dropped", async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(2)]);
    const local = (await LibraryLog.openLocal(LOCAL_KEY, vault, server.fetchImpl))!;
    await local.write(row(1));
    await local.write(row(2, { status: { value: 'watched', at: at(5000) } }));
    expect(await local.moveTo(LIBRARY_KEY)).not.toBeNull();
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(tv.title({ type: 'movie', id: 1 })).toBeDefined();
    expect(tv.title({ type: 'movie', id: 2 })?.status.value).toBe('watched');
    expect(await local.forget()).toBe(true);
    expect(data.size).toBe(0);
  });
});

describe('applyLog', () => {
  const backup: Library = {
    records: [
      {
        title: { type: 'movie', id: 1, title: 'Dune', posterPath: '/d.jpg' },
        status: 'watchlist',
        progress: 0,
        progressAt: 0,
        addedAt: 500,
        deleted: false,
      },
    ],
    marks: [],
    shapes: new Map(),
    dismissed: new Map(),
  };

  it("takes the log's state over the backup's and keeps the backup's display", () => {
    const library = applyLog(backup, [
      row(1, {
        status: { value: 'inProgress', at: at(2000) },
        resume: { value: 0.4, at: at(2000), viewing: 0 },
      }),
    ]);
    expect(watchlist(library)).toEqual([]);
    expect(continueWatching(library)).toEqual([{ title: backup.records[0]!.title, fraction: 0.4 }]);
  });

  it('holds a title only the log knows until TMDB names it', () => {
    const library = applyLog(backup, [row(2, { addedAt: 3000 })]);
    expect(watchlist(library).map((t) => t.id)).toEqual([1]);
    expect(untitled(library)).toEqual([{ type: 'movie', id: 2 }]);
    const named = withDisplay(library, [{ type: 'movie', id: 2, title: 'Arrival' }]);
    expect(watchlist(named).map((t) => t.title)).toEqual(['Arrival', 'Dune']);
  });

  it('carries a dismissal from the log', () => {
    const dismissed = row(1, {
      status: { value: 'inProgress', at: at(2000) },
      resume: { value: 0.4, at: at(2000), viewing: 0 },
      dismissed: { value: true, at: at(2500) },
    });
    expect(continueWatching(applyLog(backup, [dismissed]))).toEqual([]);
  });

  const episode = (season: number, number: number, value: number, t: number): EpisodeRow => ({
    kind: 'ep',
    schema: 2,
    title: { type: 'tv', id: 95396 },
    season,
    episode: number,
    progress: { value, at: at(t), viewing: value === 0 ? 1 : 0 },
  });

  it('puts a series in Continue Watching from its episode rows, once it has a name', () => {
    const library = applyLog(backup, [episode(1, 2, 0.5, 4000)]);
    expect(untitled(library)).toEqual([{ type: 'tv', id: 95396 }]);
    const named = withDisplay(library, [
      { type: 'tv', id: 95396, title: 'Severance', posterPath: '/s.jpg', rating: 8.4 },
    ]);
    expect(continueWatching(named)[0]).toEqual({
      title: { type: 'tv', id: 95396, title: 'Severance', posterPath: '/s.jpg', rating: 8.4 },
      fraction: 0.5,
      episode: { season: 1, episode: 2 },
    });
  });

  it('drops an un-watched episode, and every episode from before a series reset', () => {
    const named = { ...backup, marks: [] };
    expect(applyLog(named, [episode(1, 2, 0.5, 4000), episode(1, 2, 0, 5000)]).marks).toEqual([]);
    const reset = row(95396, { title: { type: 'tv', id: 95396 }, episodesReset: at(4500) });
    const after = applyLog(named, [episode(1, 1, 1, 4000), episode(1, 2, 0.3, 5000), reset]);
    expect(after.marks.map((m) => m.episode)).toEqual([2]);
  });
});

describe('tmdb', () => {
  const answer =
    (body: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status: 200 });

  it('names a movie and a series from their details', async () => {
    const movie = {
      title: 'Arrival',
      poster_path: '/a.jpg',
      release_date: '2016-11-11',
      vote_average: 7.6,
    };
    expect(await fetchDetails({ type: 'movie', id: 329865 }, 'k', answer(movie))).toEqual({
      title: {
        type: 'movie',
        id: 329865,
        title: 'Arrival',
        posterPath: '/a.jpg',
        year: 2016,
        releaseDate: '2016-11-11',
        rating: 7.6,
        ratingSource: 'tmdb',
      },
    });
    const series = await fetchDetails(
      { type: 'tv', id: 95396 },
      'k',
      answer({ name: 'Severance', first_air_date: '2022-02-17' }),
    );
    expect(series?.title).toMatchObject({ title: 'Severance', year: 2022 });
    expect(
      await fetchDetails(
        { type: 'tv', id: 1 },
        'k',
        async () => new Response('{}', { status: 401 }),
      ),
    ).toBeNull();
  });

  it("reads a series' season layout, so Continue Watching can find the next episode", async () => {
    const severance = {
      name: 'Severance',
      seasons: [
        { season_number: 0, episode_count: 2 },
        { season_number: 1, episode_count: 9 },
        { season_number: 2, episode_count: 10 },
      ],
      last_episode_to_air: { season_number: 2, episode_number: 4 },
    };
    const found = await fetchDetails({ type: 'tv', id: 95396 }, 'k', answer(severance));
    expect(found?.shape).toEqual({
      counts: new Map([
        [0, 2],
        [1, 9],
        [2, 10],
      ]),
      lastAired: { season: 2, episode: 4 },
    });
  });
});
