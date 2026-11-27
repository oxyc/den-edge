import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  laneId,
  laneQueue,
  playKeyFor,
  receiveTv,
  startPlay,
  startPlaysWith,
  whilePlayKey,
} from './householdPlays';
import { linkKeys, sealMessage, type PlayRequest } from './inbox';
import { openResults, resultAddress } from './playResults';
import { fromBase64url, fromHex, toBase64url } from './wire';

// den-spec, checked out at the repository root; the Apple TV and den-mcp derive the same lane.
const wake = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/wake-controller-v1.json', import.meta.url), 'utf8'),
) as { assistant: { householdPlayKey: string; laneId: string } };

describe("a TV's assistant lane", () => {
  it("derives from its play key as den-spec's vector says", async () => {
    const playKey = toBase64url(fromHex(wake.assistant.householdPlayKey));
    expect(await laneId(playKey)).toBe(wake.assistant.laneId);
  });

  it('is drained by that id, under the TV’s name', async () => {
    const playKey = toBase64url(fromHex(wake.assistant.householdPlayKey));
    expect(await laneQueue(playKey, 'Living room LG')).toEqual({
      query: `queue=tv&tv=${wake.assistant.laneId}`,
      body: '{"name":"Living room LG","results":1}',
      key: `.tv.${wake.assistant.laneId}`,
    });
  });

  it('starts a play through the page that registered, and through none once it has gone', async () => {
    const started: string[] = [];
    const unregister = startPlaysWith(async (play) => void started.push(play.title));
    expect(await startPlay({ tmdbId: 550, mediaType: 'movie', title: 'Fight Club' })).toBe(true);
    unregister();
    expect(await startPlay({ tmdbId: 550, mediaType: 'movie', title: 'Again' })).toBe(false);
    expect(started).toEqual(['Fight Club']);
  });
});

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("a TV's household play key", () => {
  it('is kept for its library, and made anew when the library key changes', async () => {
    const storage = memoryStorage();
    const first = await playKeyFor('library-one', storage);
    expect(fromBase64url(first)).toHaveLength(32);
    expect(await playKeyFor('library-one', storage)).toBe(first);

    const second = await playKeyFor('library-two', storage);
    expect(second).not.toBe(first);
    expect(await playKeyFor('library-one', storage)).not.toBe(first);
  });

  it('lets concurrent preparation for one household adopt the same visit key', async () => {
    const storage = memoryStorage();
    const [first, second] = await Promise.all([
      playKeyFor('concurrent-library', storage),
      playKeyFor('concurrent-library', storage),
    ]);
    expect(second).toBe(first);
  });

  it('never stores the library key itself', async () => {
    const storage = memoryStorage();
    await playKeyFor('a-library-key-that-must-stay-secret', storage);
    expect(
      JSON.stringify(
        [...Array(storage.length).keys()].map((i) => storage.getItem(storage.key(i)!)),
      ),
    ).not.toContain('a-library-key-that-must-stay-secret');
  });

  it('keeps one visit key and retries its persistence when site data becomes available', async () => {
    const storage = memoryStorage();
    const persist = storage.setItem;
    storage.setItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    const key = await playKeyFor('library-one', storage);
    expect(fromBase64url(key)).toHaveLength(32);
    expect(await playKeyFor('library-one', storage)).toBe(key);

    storage.setItem = persist;
    expect(await playKeyFor('library-one', storage)).toBe(key);
    expect(JSON.parse(storage.getItem('den.tvPlayKey.v1') ?? 'null').key).toBe(key);
  });

  it('does not expose an old stored household key when persistence refuses its replacement', async () => {
    const storage = memoryStorage();
    const old = 'A'.repeat(43);
    storage.setItem('den.tvPlayKey.v1', JSON.stringify({ library: 'old-household', key: old }));
    storage.setItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    const current = await playKeyFor('new-household', storage);
    expect(current).not.toBe(old);
  });

  it('persists the same visit key when unavailable storage itself recovers', async () => {
    const key = await playKeyFor('storage-recovery', undefined);
    const storage = memoryStorage();
    expect(await playKeyFor('storage-recovery', storage)).toBe(key);
    expect(JSON.parse(storage.getItem('den.tvPlayKey.v1') ?? 'null').key).toBe(key);
  });

  it('retires old work on household replacement but not on another check for the same household', async () => {
    const storage = memoryStorage();
    const stop = new AbortController();
    const first = await playKeyFor('library-one', storage);
    let enter!: (signal: AbortSignal) => void;
    const entered = new Promise<AbortSignal>((resolve) => (enter = resolve));
    const seen: string[] = [];
    const running = whilePlayKey(async (key, signal) => {
      seen.push(key);
      if (key === first) enter(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    }, stop.signal);
    const firstWork = await entered;
    expect(await playKeyFor('library-one', storage)).toBe(first);
    expect(firstWork.aborted).toBe(false);

    const replacing = playKeyFor('library-two', storage);
    expect(firstWork.aborted).toBe(true);
    const second = await replacing;
    await vi.waitFor(() => expect(seen).toEqual([first, second]));
    stop.abort();
    await running;
  });
});

describe('receiving household plays', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts the newest fresh play of a drain and reports a stale one, until stopped', async () => {
    const storage = memoryStorage();
    const key = await playKeyFor('library-one', storage);
    const { enc } = await linkKeys(fromBase64url(key));
    const now = Date.now();
    const ids = { Waited: 'a'.repeat(32), First: 'b'.repeat(32), Second: 'c'.repeat(32) };
    const play = (title: keyof typeof ids, sentAt = now) =>
      sealMessage(
        enc,
        { type: 'play', tmdbId: 550, mediaType: 'movie', title },
        { sentAt, id: ids[title] },
      );
    const queue = [
      { sealed: await play('Waited', now - 600_000) },
      { sealed: await play('First') },
      { sealed: await play('Second') },
    ];
    let drains = 0;
    const results: { address: string; sealed: string }[] = [];
    vi.stubGlobal('fetch', async (path: string | URL | Request, init?: RequestInit) => {
      if (String(path).endsWith('/play/result')) {
        results.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      drains += 1;
      return new Response(JSON.stringify({ queues: [drains === 1 ? queue : []] }), { status: 200 });
    });

    const stop = new AbortController();
    const started: PlayRequest[] = [];
    const stale: PlayRequest[] = [];
    await receiveTv(
      {
        play: async (request) => {
          started.push(request);
          stop.abort();
        },
        stale: (request) => stale.push(request),
        transport: () => undefined,
      },
      stop.signal,
      storage,
    );
    expect(started.map((request) => request.title)).toEqual(['Second']);
    expect(stale.map((request) => request.title)).toEqual(['Waited']);
    expect(drains).toBe(1);
    // The plays that never start tell their senders why, each under its own request's key (play-results-v1 §4).
    await vi.waitFor(() => expect(results).toHaveLength(2));
    const said = async (title: keyof typeof ids) => {
      const address = await resultAddress(ids[title]);
      const posted = results.filter((r) => r.address === address).map((r) => r.sealed);
      return (await openResults(ids[title], posted)).map(({ state, reason }) => ({
        state,
        reason,
      }));
    };
    expect(await said('Waited')).toEqual([{ state: 'failed', reason: 'expired' }]);
    expect(await said('First')).toEqual([{ state: 'failed', reason: 'superseded' }]);
    expect(await said('Second')).toEqual([]);
  });

  it('aborts a held old-household drain and takes over with the replacement key', async () => {
    const storage = memoryStorage();
    const first = await playKeyFor('library-one', storage);
    const firstInbox = (await linkKeys(fromBase64url(first))).inbox;
    const requests: string[] = [];
    let startFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => (startFirst = resolve));
    const stop = new AbortController();
    vi.stubGlobal('fetch', async (_path: string | URL | Request, init?: RequestInit) => {
      const key = (JSON.parse(String(init?.body)) as { keys: string[] }).keys[0];
      if (!key) throw new Error('drain did not name its household queue');
      requests.push(key);
      if (key === firstInbox) {
        startFirst();
        await new Promise<void>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          }),
        );
      }
      stop.abort();
      return new Response(JSON.stringify({ queues: [[]] }), { status: 200 });
    });

    const running = receiveTv(
      { play: async () => undefined, stale: () => undefined, transport: () => undefined },
      stop.signal,
      storage,
    );
    await firstStarted;
    const second = await playKeyFor('library-two', storage);
    const secondInbox = (await linkKeys(fromBase64url(second))).inbox;
    await running;
    expect(requests).toEqual([firstInbox, secondInbox]);
  });
});
