import { beforeEach, describe, expect, it, vi } from 'vitest';

// `release.ts` keeps whether a release is waiting for the life of the page, so each test starts from a fresh module.
let release: typeof import('./release');
beforeEach(async () => {
  vi.resetModules();
  release = await import('./release');
});

function place() {
  const went: string[] = [];
  return {
    went,
    assign: (path: string | URL) => void went.push(`assign ${path}`),
    reload: () => void went.push('reload'),
  };
}

function hiddenPage({
  y = 0,
  media = [] as { paused: boolean; muted: boolean }[],
  typing = false,
} = {}) {
  const at = place();
  return {
    at,
    page: {
      scrollX: 0,
      scrollY: y,
      document: {
        activeElement: { matches: () => typing } as unknown as Element,
        querySelectorAll: () => media as unknown as NodeListOf<HTMLMediaElement>,
      } as unknown as Pick<Document, 'activeElement' | 'querySelectorAll'>,
      location: at,
    },
  };
}

describe('a waiting release', () => {
  it('leaves the page alone until a release is waiting', () => {
    const at = place();
    expect(release.swapOnNavigation('/movie/550', at)).toBe(false);
    const hidden = hiddenPage();
    expect(release.swapWhileHidden(hidden.page)).toBe(false);
    expect([...at.went, ...hidden.at.went]).toEqual([]);
  });

  it('is put on screen by the next page opened, never before', () => {
    release.releaseWaiting();
    const at = place();
    // Nothing happens on its own: only a navigation moves the page.
    expect(at.went).toEqual([]);
    expect(release.swapOnNavigation('/movie/550', at)).toBe(true);
    expect(at.went).toEqual(['assign /movie/550']);
  });

  it('is put on screen by Back or Forward, whose address is already the page’s', () => {
    release.releaseWaiting();
    const at = place();
    expect(release.swapOnNavigation(null, at)).toBe(true);
    expect(at.went).toEqual(['reload']);
  });

  it('is put on screen while hidden only when nothing on the page would be lost', () => {
    release.releaseWaiting();
    const scrolled = hiddenPage({ y: 840 });
    expect(release.swapWhileHidden(scrolled.page)).toBe(false);
    const playing = hiddenPage({ media: [{ paused: false, muted: false }] });
    expect(release.swapWhileHidden(playing.page)).toBe(false);
    const typing = hiddenPage({ typing: true });
    expect(release.swapWhileHidden(typing.page)).toBe(false);
    expect([...scrolled.at.went, ...playing.at.went, ...typing.at.went]).toEqual([]);

    // A muted trailer playing on Home is nothing anyone would miss.
    const idle = hiddenPage({ media: [{ paused: false, muted: true }] });
    expect(release.swapWhileHidden(idle.page)).toBe(true);
    expect(idle.at.went).toEqual(['reload']);
  });
});

describe('watching the shell release', () => {
  it('marks another release for the next navigation without moving the current page', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { headers: { 'x-den-release': 'new' } }));
    const watcher = release.watchRelease(
      Promise.resolve('old'),
      fetchImpl,
      () => '/tv/6066-verano-azul',
    );
    const at = place();

    await expect(watcher.check()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('/tv/6066-verano-azul', {
      method: 'HEAD',
      cache: 'no-cache',
    });
    expect(at.went).toEqual([]);
    expect(release.swapOnNavigation('/tv/6066-verano-azul', at)).toBe(true);
    expect(at.went).toEqual(['assign /tv/6066-verano-azul']);
  });

  it('coalesces probes, retries an offline check, and stops probing once a replacement is known', async () => {
    let answer!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => (answer = resolve));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { headers: { 'x-den-release': 'new' } }));
    const watcher = release.watchRelease(Promise.resolve('old'), fetchImpl, () => '/');

    const one = watcher.check();
    const two = watcher.check();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    answer(new Response(null, { headers: { 'x-den-release': 'old' } }));
    await expect(Promise.all([one, two])).resolves.toEqual([false, false]);
    await expect(watcher.check()).resolves.toBe(false);
    await expect(watcher.check()).resolves.toBe(true);
    await expect(watcher.check()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not guess when the page-loaded release could not be read', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const watcher = release.watchRelease(Promise.resolve(undefined), fetchImpl);
    await expect(watcher.check()).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a chunk failing to load', () => {
  it('reloads at once when nothing on screen would be lost — never waiting for a navigation', () => {
    const idle = hiddenPage();
    expect(release.recoverChunkFailure(idle.page)).toBe(true);
    expect(idle.at.went).toEqual(['reload']);
  });

  it('still marks a release waiting, so it reaches the page by the usual route when it must defer', () => {
    const scrolled = hiddenPage({ y: 840 });
    expect(release.recoverChunkFailure(scrolled.page)).toBe(false);
    expect(scrolled.at.went).toEqual([]);

    // The release it found is now waiting, same as any other: the next navigation picks it up.
    const at = place();
    expect(release.swapOnNavigation('/movie/550', at)).toBe(true);
    expect(at.went).toEqual(['assign /movie/550']);
  });

  it('defers the same way a hidden page does: playing media or typing hold it off too', () => {
    const playing = hiddenPage({ media: [{ paused: false, muted: false }] });
    expect(release.recoverChunkFailure(playing.page)).toBe(false);
    const typing = hiddenPage({ typing: true });
    expect(release.recoverChunkFailure(typing.page)).toBe(false);
    expect([...playing.at.went, ...typing.at.went]).toEqual([]);
  });
});
