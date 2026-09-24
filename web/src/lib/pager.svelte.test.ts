import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import { Pager } from './pager.svelte';

const film = (id: number): Title => ({ type: 'movie', id, title: `Film ${id}` });
const pageOf = (start: number, size = 20) =>
  Array.from({ length: size }, (_, i) => film(start + i));

describe('Pager', () => {
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
    expect(pager.failed).toBe(true);
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
    expect(pager.failed).toBe(true);
    expect(pager.done).toBe(true);
    expect(pager.titles).toHaveLength(20);
    down = false;
    await pager.retry();
    expect(asked).toEqual([1, 2, 2]);
    expect(pager.failed).toBe(false);
    expect(pager.done).toBe(false);
    expect(pager.titles).toHaveLength(40);
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
