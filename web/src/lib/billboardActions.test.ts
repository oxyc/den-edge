import { describe, expect, it } from 'vitest';
import { leavesBillboard, nextSlide } from './billboardActions';

describe('leavesBillboard', () => {
  it('moves Home on from a title saved or seen, and not from one taken back', () => {
    expect(leavesBillboard('watchlist', true, false)).toBe(true);
    expect(leavesBillboard('seen', true, false)).toBe(true);
    expect(leavesBillboard('watchlist', false, false)).toBe(false);
    expect(leavesBillboard('seen', false, false)).toBe(false);
  });

  it('moves the Watchlist page on from a title taken off the watchlist or seen', () => {
    expect(leavesBillboard('watchlist', false, true)).toBe(true);
    expect(leavesBillboard('seen', true, true)).toBe(true);
    expect(leavesBillboard('watchlist', true, true)).toBe(false);
    expect(leavesBillboard('seen', false, true)).toBe(false);
  });
});

describe('nextSlide', () => {
  it('takes the next slide, and the first after the last', () => {
    expect(nextSlide(0, 3)).toBe(1);
    expect(nextSlide(1, 3)).toBe(2);
    expect(nextSlide(2, 3)).toBe(0);
    expect(nextSlide(0, 1)).toBe(0);
  });
});
