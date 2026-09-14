import { beforeEach, expect, it, vi } from 'vitest';
import { discoverServices } from './discoverServices';
import { findAddon, findAtlas, findReel } from './scout';
import { findRemux } from './remux';

vi.mock('./scout', () => ({
  findAddon: vi.fn(),
  findAtlas: vi.fn(),
  findReel: vi.fn(),
  SCOUT: { name: 'scout' },
  REEL: { name: 'reel' },
}));
vi.mock('./remux', () => ({ findRemux: vi.fn() }));

beforeEach(() => {
  vi.mocked(findAddon).mockImplementation(async (_installed, _routes, kind) => ({
    base: `/${kind.name}`,
    install: `/${kind.name}`,
  }));
  vi.mocked(findAtlas).mockResolvedValue({ base: '/atlas', install: '/atlas' });
  // reel is found the same way atlas is, so that a guest — who lists no plugins — still gets trailers.
  vi.mocked(findReel).mockResolvedValue({ base: '/reel', install: '/reel' });
});

it('publishes discovery addons while the playback health request is still pending', async () => {
  let resolve!: (value: string | null) => void;
  vi.mocked(findRemux).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const publish = { scout: vi.fn(), atlas: vi.fn(), reel: vi.fn(), remux: vi.fn() };
  discoverServices([], {}, publish);
  await Promise.resolve();
  expect(publish.scout).toHaveBeenCalledWith({ base: '/scout', install: '/scout' });
  expect(publish.atlas).toHaveBeenCalledWith({ base: '/atlas', install: '/atlas' });
  expect(publish.reel).toHaveBeenCalledWith({ base: '/reel', install: '/reel' });
  expect(publish.remux).not.toHaveBeenCalled();
  resolve(null);
  await Promise.resolve();
  expect(publish.remux).toHaveBeenCalledWith(null);
});

/**
 * A guest has no library to prove holding, and on the public name den-edge now answers scout only to a
 * device that can. Nothing here should ask it anyway — what keeps that true is the missing publisher,
 * one conditional spread in Library, which a refactor could quietly undo and leave a guest looking at
 * an error for a service they were never offered.
 */
it('asks scout and den-remux nothing for a guest', async () => {
  const publish = { atlas: vi.fn(), reel: vi.fn() };
  discoverServices([], {}, publish);
  await Promise.resolve();
  expect(findAddon).not.toHaveBeenCalled();
  expect(findRemux).not.toHaveBeenCalled();
  expect(publish.atlas).toHaveBeenCalledWith({ base: '/atlas', install: '/atlas' });
  expect(publish.reel).toHaveBeenCalledWith({ base: '/reel', install: '/reel' });
});

it('does not publish late results from disposed settings', async () => {
  let resolve!: (value: string | null) => void;
  vi.mocked(findRemux).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const publish = { scout: vi.fn(), atlas: vi.fn(), reel: vi.fn(), remux: vi.fn() };
  const stop = discoverServices([], {}, publish);
  stop();
  resolve('/old-remux');
  await Promise.resolve();
  for (const receive of Object.values(publish)) expect(receive).not.toHaveBeenCalled();
});
