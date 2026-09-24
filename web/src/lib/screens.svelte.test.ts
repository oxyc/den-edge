import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import { lazy } from './screens.svelte';

const Screen = (() => undefined) as unknown as Component;

describe('lazy', () => {
  it('says a chunk that failed to load failed, and loads it on the next try', async () => {
    let attempts = 0;
    const screen = lazy(async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
      return { default: Screen };
    });
    await screen.load();
    expect(screen.current).toBeNull();
    expect(screen.failed).toBe(true);
    await screen.load();
    expect(attempts).toBe(2);
    expect(screen.current).toBe(Screen);
    expect(screen.failed).toBe(false);
  });

  it('asks for a chunk once, however many pages want it', async () => {
    let attempts = 0;
    const screen = lazy(async () => (attempts++, { default: Screen }));
    await Promise.all([screen.load(), screen.load()]);
    await screen.load();
    expect(attempts).toBe(1);
  });
});
