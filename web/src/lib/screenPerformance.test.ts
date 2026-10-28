import { describe, expect, it } from 'vitest';
import { FrameMeter, screenOf, StallLedger } from './screenPerformance';

describe('FrameMeter', () => {
  it('counts a frame three budgets late as two missed, and its time past one budget as hitch', () => {
    const meter = new FrameMeter();
    const budget = 1000 / 60;
    for (let n = 0; n <= 60; n++) meter.frame(n * budget, budget);
    expect(meter.drain()).toEqual({
      delivered: 60,
      missed: 0,
      hitchMs: 0,
      longestMs: 17,
      visibleMs: 1000,
    });
    meter.frame(1000 + 3 * budget, budget);
    expect(meter.drain()).toMatchObject({ delivered: 1, missed: 2, hitchMs: 33, longestMs: 50 });
    expect(meter.drain(), 'nothing drawn since').toBeUndefined();
  });

  it('does not count the gap while paused as a frame', () => {
    const meter = new FrameMeter();
    meter.frame(0, 16);
    meter.pause();
    meter.frame(10_000, 16);
    meter.frame(10_016, 16);
    expect(meter.drain()).toMatchObject({ delivered: 1, missed: 0, visibleMs: 16 });
  });
});

describe('StallLedger', () => {
  it('reports a troubled screen once, as it is left, and a smooth one never', () => {
    const ledger = new StallLedger();
    expect(ledger.enter('home')).toBeUndefined();
    ledger.stall(120);
    ledger.stall(300);
    ledger.drew({ delivered: 600, missed: 3, hitchMs: 50, longestMs: 67, visibleMs: 10_000 });
    expect(ledger.enter('home'), 'the same screen again is not a new one').toBeUndefined();
    expect(ledger.enter('title')).toEqual({
      route: 'home',
      stalls: [2, 420, 300],
      frames: { delivered: 600, missed: 3, hitchMs: 50, longestMs: 67, visibleMs: 10_000 },
    });
    ledger.drew({ delivered: 60, missed: 0, hitchMs: 0, longestMs: 17, visibleMs: 1000 });
    expect(ledger.enter('home'), 'a smooth screen sends nothing').toBeUndefined();
    ledger.stall(80);
    expect(ledger.flush()).toEqual({ route: 'home', stalls: [1, 80, 80] });
    expect(ledger.flush(), 'flushed once').toBeUndefined();
  });

  it('names screens, never what is on them', () => {
    expect(screenOf({ page: 'library' })).toBe('home');
    expect(screenOf({ page: 'title', type: 'movie', id: 7 })).toBe('title');
    expect(screenOf({ page: 'title', type: 'movie', id: 7, play: true })).toBe('player');
    expect(screenOf({ page: 'search', query: 'heist' })).toBe('search');
    expect(screenOf({ page: 'person', id: 3 })).toBe('other');
  });
});
