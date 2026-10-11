import { describe, expect, it } from 'vitest';
import { clock, LIVE_MS, livePosition, sight } from './livePosition';

describe('livePosition', () => {
  const at = 1_000_000;

  it('counts on from a position written moments ago', () => {
    expect(livePosition({ seconds: 1390, at }, at + 4_000)).toBe(1394);
  });

  it('is not playing once the writes stop', () => {
    expect(livePosition({ seconds: 1390, at }, at + LIVE_MS + 1)).toBeUndefined();
  });

  it('needs a position in seconds and its time', () => {
    expect(livePosition({ seconds: 1390 }, at)).toBeUndefined();
    expect(livePosition({ at }, at)).toBeUndefined();
  });

  it('reads a write stamped slightly ahead of this clock as just now', () => {
    expect(livePosition({ seconds: 60, at: at + 2_000 }, at)).toBe(60);
  });

  // The TV's log reaches den-edge about every 30 s, so the newest write a page sees can be that old already.
  it('keeps counting through the ~30 s between pushes', () => {
    expect(livePosition({ seconds: 1390, at }, at + 38_000)).toBe(1428);
  });

  it('is not playing at a write that left the position where it was', () => {
    expect(livePosition({ seconds: 1390, at, moving: false }, at)).toBeUndefined();
  });
});

describe('sight', () => {
  const at = 1_000_000;

  it('counts the first write seen as moving', () => {
    expect(sight(undefined, { seconds: 10, at })).toEqual({ seconds: 10, at, moving: true });
  });

  it('reads a newer write at the same position as paused, and a moved one as playing', () => {
    const first = sight(undefined, { seconds: 10, at })!;
    const paused = sight(first, { seconds: 10, at: at + 30_000 })!;
    expect(paused.moving).toBe(false);
    expect(sight(paused, { seconds: 40, at: at + 60_000 })!.moving).toBe(true);
  });

  it('keeps what it saw while no newer write arrives', () => {
    const paused = { seconds: 10, at, moving: false };
    expect(sight(paused, { seconds: 10, at })).toBe(paused);
  });

  it('needs a position in seconds and its time', () => {
    expect(sight(undefined, { at })).toBeUndefined();
  });
});

describe('clock', () => {
  it('reads as the player does', () => {
    expect(clock(245.9)).toBe('4:05');
    expect(clock(3729)).toBe('1:02:09');
    expect(clock(0)).toBe('0:00');
  });
});
