import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  currentPlayKey,
  laneId,
  laneQueue,
  playKeyFor,
  receiveTv,
  startPlay,
  startPlaysWith,
} from './householdPlays';
import { linkKeys, sealMessage, type PlayRequest } from './inbox';
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
      body: '{"name":"Living room LG"}',
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
    expect(currentPlayKey(storage)).toBe(first);

    const second = await playKeyFor('library-two', storage);
    expect(second).not.toBe(first);
    expect(currentPlayKey(storage)).toBe(second);
    expect(await playKeyFor('library-one', storage)).not.toBe(first);
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

  it('still makes a key when site data is unavailable', async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(fromBase64url(await playKeyFor('library-one', storage))).toHaveLength(32);
    expect(currentPlayKey(storage)).toBeUndefined();
  });
});

describe('receiving household plays', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts the newest fresh play of a drain and reports a stale one, until stopped', async () => {
    const storage = memoryStorage();
    const key = await playKeyFor('library-one', storage);
    const { enc } = await linkKeys(fromBase64url(key));
    const now = Date.now();
    const play = (title: string, sentAt = now) =>
      sealMessage(enc, { type: 'play', tmdbId: 550, mediaType: 'movie', title }, { sentAt });
    const queue = [
      { sealed: await play('Waited', now - 600_000) },
      { sealed: await play('First') },
      { sealed: await play('Second') },
    ];
    let drains = 0;
    vi.stubGlobal('fetch', async () => {
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
  });
});
