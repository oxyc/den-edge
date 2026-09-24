import { describe, expect, it } from 'vitest';
import { POLL_MAX_MS, POLL_MS, pollDelay } from './downloadQueue.svelte';

describe('pollDelay', () => {
  it('asks every five seconds while a download moves', () => {
    expect(pollDelay(0)).toBe(POLL_MS);
  });

  it('backs off while nothing changes, to a minute at most', () => {
    expect(pollDelay(1)).toBe(10_000);
    expect(pollDelay(2)).toBe(20_000);
    expect(pollDelay(3)).toBe(40_000);
    expect(pollDelay(4)).toBe(POLL_MAX_MS);
    expect(pollDelay(40)).toBe(POLL_MAX_MS);
  });
});
