import { describe, expect, it } from 'vitest';
import { blockedTitles } from './blockedTitles.svelte';

describe('blockedTitles', () => {
  it('forgets every hint on reset, so one profile’s ceiling is not read as the next one’s', () => {
    const title = { type: 'movie', id: 550 };
    blockedTitles.mark(title, true);
    expect(blockedTitles.of(title)).toBe(true);

    blockedTitles.reset();

    expect(blockedTitles.of(title)).toBe(false);
  });
});
