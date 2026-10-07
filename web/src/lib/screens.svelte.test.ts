import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import {
  HOME_SCREEN_PRELOADS,
  lazy,
  permitsScreenPreload,
  PlayerScreen,
  preloadInIdle,
  ServiceScreen,
  SettingsScreen,
  WatchlistScreen,
} from './screens.svelte';

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

describe('screen preloading', () => {
  it('leaves metered and constrained connections to intent-driven loading', () => {
    expect(permitsScreenPreload({ saveData: true, effectiveType: '4g' })).toBe(false);
    expect(permitsScreenPreload({ effectiveType: 'slow-2g' })).toBe(false);
    expect(permitsScreenPreload({ effectiveType: '2g' })).toBe(false);
    expect(permitsScreenPreload({ effectiveType: '3g' })).toBe(false);
  });

  it('permits idle loading on fast and unclassified connections', () => {
    expect(permitsScreenPreload({ effectiveType: '4g' })).toBe(true);
    expect(permitsScreenPreload()).toBe(true);
  });

  it('leaves heavy and uncommon routes to explicit intent', () => {
    const preloaded = HOME_SCREEN_PRELOADS.flat();
    expect(preloaded).not.toContain(SettingsScreen);
    expect(preloaded).not.toContain(PlayerScreen);
    expect(preloaded).not.toContain(ServiceScreen);
    expect(preloaded).not.toContain(WatchlistScreen);
  });

  it('admits preload batches in separate idle turns after the earlier imports settle', async () => {
    const idle: (() => void)[] = [];
    const loaded: string[] = [];
    let finishFirst!: () => void;
    const first = {
      load: () =>
        new Promise<void>((resolve) => {
          loaded.push('detail');
          finishFirst = resolve;
        }),
    };
    const search = { load: async () => void loaded.push('search') };
    const person = { load: async () => void loaded.push('person') };

    preloadInIdle([[first, search], [person]], (task) => idle.push(task));
    expect(idle).toHaveLength(1);
    idle.shift()?.();
    expect(loaded).toEqual(['detail', 'search']);
    expect(idle, 'the second slice waits for both imports in the first').toHaveLength(0);

    finishFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(idle).toHaveLength(1);
    idle.shift()?.();
    await Promise.resolve();
    expect(loaded).toEqual(['detail', 'search', 'person']);
  });
});
