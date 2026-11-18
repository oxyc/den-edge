import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentServiceError } from './contentServiceClient';
import type { Title } from './library';
import { Pager } from './pager.svelte';

const film = (id: number): Title => ({ type: 'movie', id, title: `Film ${id}` });
const pageOf = (start: number, size = 20) =>
  Array.from({ length: size }, (_, i) => film(start + i));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Pager', () => {
  it.each([
    ['success', false],
    ['failure', true],
  ])('releases superseded A while B remains current after A’s late %s', async (_name, fails) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let aSignal: AbortSignal | undefined;
    const a = new Pager(
      async (_page, signal) => {
        aSignal = signal;
        await held;
        if (fails) throw new Error('late A failure');
        return pageOf(100);
      },
      () => true,
    );
    const aLoad = a.more();
    await Promise.resolve();

    const b = new Pager(
      async () => pageOf(200),
      () => true,
    );
    await b.more();
    a.dispose();
    expect(aSignal?.aborted).toBe(true);
    release();
    await aLoad;

    expect(a.titles).toEqual([]);
    expect(a.page).toBe(0);
    expect(a.failed).toBe(false);
    expect(b.titles[0]).toEqual(film(200));
    expect(b.page).toBe(1);
  });

  it('loads one page when it fills a screenful, and the next only when asked', async () => {
    const asked: number[] = [];
    const pager = new Pager(
      async (page) => (asked.push(page), pageOf(page * 100)),
      () => true,
    );
    await pager.more();
    expect(asked).toEqual([1]);
    expect(pager.titles).toHaveLength(20);
    await pager.more();
    expect(asked).toEqual([1, 2]);
    expect(pager.titles).toHaveLength(40);
    expect(pager.done).toBe(false);
  });

  it('keeps asking, three pages at most, while the hide rules leave too little', async () => {
    const asked: number[] = [];
    // Only one title in each page of twenty survives.
    const pager = new Pager(
      async (page) => (asked.push(page), pageOf(page * 100)),
      (title) => title.id % 100 === 0,
    );
    await pager.more();
    expect(asked).toEqual([1, 2, 3]);
    expect(pager.done).toBe(false);
  });

  it('ends at an empty page, and gives up when nothing at all survives', async () => {
    const ends = new Pager(
      async (page) => (page === 1 ? pageOf(0) : []),
      () => true,
    );
    await ends.more();
    await ends.more();
    expect(ends.done).toBe(true);
    expect(ends.exhausted).toBe(true);
    expect(ends.titles).toHaveLength(20);

    // Given up on is done, but not everything there is: more pages remain.
    const hidden = new Pager(
      async (page) => pageOf(page * 100),
      () => false,
    );
    await hidden.more();
    expect(hidden.done).toBe(true);
    expect(hidden.exhausted).toBe(false);
  });

  it('stops at a failed page rather than asking again', async () => {
    let calls = 0;
    const pager = new Pager(
      async () => {
        calls++;
        throw new Error('TMDB answered 500');
      },
      () => true,
    );
    await pager.more();
    await pager.more();
    expect(calls).toBe(1);
    expect(pager.done).toBe(true);
    expect(pager.failed).toBe('Load failed');
    expect(pager.page + 1).toBe(1);
  });

  it.each([
    ['rate-limited', true, 'TMDB rate limit'],
    ['unavailable', true, 'Services unavailable'],
    ['internal', true, 'Services unavailable'],
    ['not-ready', false, 'Services unavailable'],
    ['refused', false, 'Load failed'],
  ] as const)('keeps only a safe %s service reason', async (code, retryable, reason) => {
    const pager = new Pager(
      async () => {
        throw new ContentServiceError({
          code,
          message: 'secret provider URL and response body',
          retryable,
        });
      },
      () => true,
    );
    await pager.more();
    expect(pager.failed).toBe(reason);
    expect(JSON.stringify(pager.failed)).not.toContain('secret');
  });

  it('reports an offline device without inspecting an arbitrary exception', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pager = new Pager(
      async () => {
        throw new Error('credential-bearing provider detail');
      },
      () => true,
    );
    await pager.more();
    expect(pager.failed).toBe('Offline');
    expect(pager.page + 1).toBe(1);
    expect(warning).not.toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain('credential');
  });

  it('says a page failed, and carries on from it when asked to try again', async () => {
    const asked: number[] = [];
    let down = true;
    const pager = new Pager(
      async (page) => {
        asked.push(page);
        if (page === 2 && down) throw new Error('TMDB answered 500');
        return pageOf(page * 100);
      },
      () => true,
    );
    await pager.more();
    await pager.more();
    expect(pager.failed).toBe('Load failed');
    expect(pager.page + 1).toBe(2);
    expect(pager.done).toBe(true);
    expect(pager.titles).toHaveLength(20);
    down = false;
    await pager.retry();
    expect(asked).toEqual([1, 2, 2]);
    expect(pager.failed).toBe(false);
    expect(pager.done).toBe(false);
    expect(pager.titles).toHaveLength(40);
    expect(pager.page).toBe(2);
  });

  it('replaces a repeated failure reason for the same page in the current Pager generation', async () => {
    const reasons: Array<'rate-limited' | 'unavailable'> = ['rate-limited', 'unavailable'];
    const pager = new Pager(
      async () => {
        const code = reasons.shift()!;
        throw new ContentServiceError({ code, message: 'private detail', retryable: true });
      },
      () => true,
    );
    await pager.more();
    expect(pager.failed).toBe('TMDB rate limit');
    await pager.retry();
    expect(pager.failed).toBe('Services unavailable');
    expect(pager.page).toBe(0);
  });

  it('never loads the same title twice across pages', async () => {
    const pager = new Pager(
      async () => pageOf(0, 5),
      () => true,
    );
    await pager.more();
    expect(pager.titles).toHaveLength(5);
  });
});
