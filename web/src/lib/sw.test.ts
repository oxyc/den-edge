import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `public/sw.js` is a classic worker script, not a module, so it is run here as one, with `self`, `caches` and
// `clients` standing in for the browser's. It no longer keeps anything: it exists only to retire a browser's
// registration from before den stopped keeping the shell in a service worker at all (`main.ts`).

const SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

function worker({ caches = [] as string[] } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const kept = new Set(caches);
  const deleted: string[] = [];
  const navigated: string[] = [];
  let skipped = false;
  let unregistered = false;
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: () => void (skipped = true),
    registration: { unregister: async () => void (unregistered = true) },
    clients: {
      matchAll: async () => [
        { url: 'https://den.test/movies', navigate: (url: string) => void navigated.push(url) },
        { url: 'https://den.test/tv/1399', navigate: (url: string) => void navigated.push(url) },
      ],
    },
  };
  const fakeCaches = {
    keys: async () => [...kept],
    delete: async (name: string) => void (kept.delete(name) && deleted.push(name)),
  };
  new Function('self', 'caches', SOURCE)(self, fakeCaches);
  async function run(type: 'install' | 'activate') {
    const behind: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (work: Promise<unknown>) => void behind.push(work) });
    await Promise.all(behind);
  }
  return {
    run,
    deleted,
    navigated,
    isSkipped: () => skipped,
    isUnregistered: () => unregistered,
    remaining: () => [...kept],
  };
}

describe('the self-destructing worker', () => {
  it('skips waiting on install, so it takes over without every tab closing first', async () => {
    const w = worker();
    await w.run('install');
    expect(w.isSkipped()).toBe(true);
  });

  it('clears every cache it finds on activation, whatever it is named', async () => {
    const w = worker({ caches: ['den-page-v1', 'den-files-abc123', 'anything-else'] });
    await w.run('activate');
    expect(w.remaining()).toEqual([]);
    expect(w.deleted.sort()).toEqual(['anything-else', 'den-files-abc123', 'den-page-v1']);
  });

  it('unregisters itself and reloads every open tab, cache or not', async () => {
    const w = worker();
    await w.run('activate');
    expect(w.isUnregistered()).toBe(true);
    expect(w.navigated.sort()).toEqual(['https://den.test/movies', 'https://den.test/tv/1399']);
  });
});
