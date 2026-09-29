import { describe, expect, it } from 'vitest';
import { clock, LIVE_MS, livePosition } from './livePosition';

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
});

describe('clock', () => {
  it('reads as the player does', () => {
    expect(clock(245.9)).toBe('4:05');
    expect(clock(3729)).toBe('1:02:09');
    expect(clock(0)).toBe('0:00');
  });
});
