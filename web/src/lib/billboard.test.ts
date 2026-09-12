import { describe, expect, it } from 'vitest';
import { buzz, freshness, pickBillboard, quality, type Candidate } from './billboard';
import type { Title } from './library';

const NOW = new Date('2026-09-12T00:00:00Z');

const film = (id: number, extra: Partial<Title> = {}): Title => ({
  type: 'movie',
  id,
  title: `T${id}`,
  posterPath: '/p.jpg',
  ...extra,
});

describe('freshness', () => {
  it('is full marks for the unreleased and decays over four months', () => {
    expect(freshness(film(1, { releaseDate: '2026-12-01' }), NOW)).toBe(1);
    expect(freshness(film(2, { releaseDate: '2026-09-10' }), NOW)).toBeCloseTo(0.983, 2);
    const old = freshness(film(3, { releaseDate: '2024-01-01' }), NOW);
    expect(old).toBeLessThan(0.01);
  });

  it('places a title known only by its year mid-year, and scores an undated one as old', () => {
    expect(freshness(film(4, { year: 2026 }), NOW)).toBeCloseTo(freshness(film(5, { releaseDate: '2026-07-01' }), NOW), 6);
    expect(freshness(film(6), NOW)).toBe(0);
  });
});

describe('buzz and quality', () => {
  it('reads a place in a ranked list, and nothing from an unranked one', () => {
    expect(buzz({ title: film(1), rank: 0, of: 10 })).toBe(1);
    expect(buzz({ title: film(1), rank: 5, of: 10 })).toBe(0.5);
    expect(buzz({ title: film(1) })).toBe(0);
  });

  it('reads attention from popularity when there is no ranking, against the busiest in the pool', () => {
    const busiest = 500;
    expect(buzz({ title: film(1, { popularity: 500 }) }, busiest)).toBeCloseTo(1, 6);
    expect(buzz({ title: film(2, { popularity: 0 }) }, busiest)).toBe(0);
    // Long-tailed, so a middling title still registers rather than rounding to nothing beside a runaway hit.
    expect(buzz({ title: film(3, { popularity: 50 }) }, busiest)).toBeGreaterThan(0.6);
  });

  it('among new titles, prefers the one people are watching', () => {
    const unknown = film(1, { releaseDate: '2026-09-05', popularity: 2 });
    const awaited = film(2, { releaseDate: '2026-09-05', popularity: 900 });
    expect(pickBillboard([{ title: unknown }, { title: awaited }], { now: NOW }).map((t) => t.id)).toEqual([2, 1]);
  });

  it('ignores a rating too few people gave', () => {
    expect(quality(film(1, { rating: 8.5, votes: 12 }))).toBe(0);
    expect(quality(film(2, { rating: 8.5, votes: 500 }))).toBe(1);
    expect(quality(film(3, { rating: 6, votes: 500 }))).toBe(0);
  });
});

describe('pickBillboard', () => {
  it('leads with what is new rather than what is merely well liked', () => {
    const pool: Candidate[] = [
      { title: film(1, { releaseDate: '1994-09-23', rating: 9.3, votes: 20_000 }) },
      { title: film(2, { releaseDate: '2026-09-01', rating: 6.4, votes: 200 }) },
    ];
    expect(pickBillboard(pool, { now: NOW }).map((t) => t.id)).toEqual([2, 1]);
  });

  it('drops what the caller hides, and dedupes what two sources both offered', () => {
    const twice = film(7, { releaseDate: '2026-09-01' });
    const pool: Candidate[] = [
      { title: twice, rank: 0, of: 2 },
      { title: twice },
      { title: film(8, { releaseDate: '2026-09-02' }) },
    ];
    const picked = pickBillboard(pool, { now: NOW, keep: (t) => t.id !== 8 });
    expect(picked.map((t) => t.id)).toEqual([7]);
  });

  it('cuts to the slide count only after filtering, so a strict library still fills the billboard', () => {
    const pool: Candidate[] = Array.from({ length: 60 }, (_, i) =>
      ({ title: film(i, { releaseDate: '2026-08-01' }) }),
    );
    // Half the pool is hidden; the billboard should still be full rather than half empty.
    const picked = pickBillboard(pool, { now: NOW, slides: 20, keep: (t) => t.id % 2 === 0 });
    expect(picked).toHaveLength(20);
    expect(picked.every((t) => t.id % 2 === 0)).toBe(true);
  });
});
