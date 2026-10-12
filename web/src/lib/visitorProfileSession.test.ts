import { describe, expect, it, vi } from 'vitest';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import { visitorVisitId } from './profileIdentity';
import {
  NoSyncVisitorWriter,
  randomVisitorVisitId,
  visitorProfileSession,
} from './visitorProfileSession.svelte';
import type { TrackerEvent } from './trackerEvents';

const FIRST = visitorVisitId('11111111111111111111111111111111');
const SECOND = visitorVisitId('22222222222222222222222222222222');

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const content = () => ({ query: vi.fn(), onStatus: vi.fn(() => () => {}) });

describe('VisitorProfileSession', () => {
  it('projects watchlist, watched, progress, resume, and history durably without Owner writes', async () => {
    const storage = memoryStorage();
    const ownerWrite = vi.fn();
    const household = new HouseholdSession(
      { kind: 'profiles', libraryKey: 'household-key', configurationOnly: true },
      { command: ownerWrite, close: vi.fn() } as unknown as LibraryModel,
      content(),
    );
    const movie = { type: 'movie' as const, id: 550, title: 'Fight Club', year: 1999 };
    const series = { type: 'tv' as const, id: 1399, title: 'Game of Thrones' };
    const first = visitorProfileSession(household, storage, FIRST);

    await first.profileActivity!.setWatchlisted(movie, true);
    await first.profileActivity!.recordProgress(series, 0.4, 1_200, {
      season: 2,
      episode: 3,
    });
    await first.profileActivity!.setWatched(movie, true);

    expect(first.profileActivity!.watchlist).toEqual([]);
    expect(first.profileActivity!.continueWatching).toEqual([
      expect.objectContaining({
        title: series,
        fraction: 0.4,
        seconds: 1_200,
        episode: { season: 2, episode: 3 },
      }),
    ]);
    expect(first.profileActivity!.history).toEqual([
      expect.objectContaining({ title: movie, episodes: 0 }),
    ]);
    expect(first.profileActivity!.row(movie)?.status.value).toBe('watched');
    expect(first.profileActivity!.rows(series).episodes.get('2:3')?.progress.value).toBe(0.4);
    expect(ownerWrite).not.toHaveBeenCalled();

    first.close();
    const restored = visitorProfileSession(household, storage, FIRST);
    expect(restored.profileActivity!.continueWatching[0]).toMatchObject({
      title: series,
      fraction: 0.4,
      episode: { season: 2, episode: 3 },
    });
    expect(restored.displayTitle(movie)).toEqual(movie);
    expect(restored.displayTitle(series)).toEqual(series);

    restored.endVisit();
    const ended = visitorProfileSession(household, storage, FIRST);
    expect(ended.profileActivity!.titles).toEqual([]);
    expect(ownerWrite).not.toHaveBeenCalled();
  });

  it('preserves a closed visit for reconstruction and ends only that visit explicitly', () => {
    const storage = memoryStorage();
    const householdClose = vi.fn();
    const household = new HouseholdSession(
      { kind: 'profiles', libraryKey: 'household-key', configurationOnly: true },
      { close: householdClose } as unknown as LibraryModel,
      content(),
    );
    const first = visitorProfileSession(household, storage, FIRST);
    const second = visitorProfileSession(household, storage, SECOND);
    storage.setItem('den.owner.untouched', 'owner');

    first.activity.set('progress:movie:550', { fraction: 0.25 });
    second.activity.set('progress:movie:550', { fraction: 0.75 });

    expect(first.activity.get('progress:movie:550')).toEqual({ fraction: 0.25 });
    expect(second.activity.get('progress:movie:550')).toEqual({ fraction: 0.75 });
    expect(first.identity).toMatchObject({
      kind: 'visitor',
      libraryKey: null,
      retainedScope: null,
    });
    expect(first.model).toBeNull();

    first.close();
    first.close();

    const restored = visitorProfileSession(household, storage, FIRST);
    expect(restored.activity.get('progress:movie:550')).toEqual({ fraction: 0.25 });
    expect(second.activity.get('progress:movie:550')).toEqual({ fraction: 0.75 });
    expect(storage.getItem('den.owner.untouched')).toBe('owner');
    expect(householdClose).not.toHaveBeenCalled();

    restored.endVisit();
    restored.endVisit();

    expect(() => restored.activity.get('progress:movie:550')).toThrow('disposed');
    expect(second.activity.get('progress:movie:550')).toEqual({ fraction: 0.75 });
    expect(storage.getItem('den.owner.untouched')).toBe('owner');
    expect(householdClose).not.toHaveBeenCalled();
  });

  it('gives Visitor no sync or tracker delivery capability', async () => {
    const writer = new NoSyncVisitorWriter();
    const command = {
      kind: 'progress.record' as const,
      title: { type: 'movie' as const, id: 550 },
      fraction: 0.5,
      seconds: 60,
      observedAt: 1,
    };
    const event = { schema: 1 } as TrackerEvent;

    await expect(writer.write(command)).resolves.toEqual({ outcome: 'suppressed' });
    await expect(writer.track(event)).resolves.toEqual({ outcome: 'suppressed' });
    expect(writer.syncEnabled).toBe(false);
    expect(writer.trackerEnabled).toBe(false);
  });

  it('ignores a malformed durable activity projection instead of exposing partial state', () => {
    const storage = memoryStorage();
    storage.setItem(
      `den.profile.visitor.v1:${FIRST}:activity`,
      JSON.stringify({ version: 1, titles: { broken: null, wrong: { title: { type: 'book' } } } }),
    );
    const household = new HouseholdSession(
      { kind: 'profiles', libraryKey: 'household-key', configurationOnly: true },
      { close: vi.fn() } as unknown as LibraryModel,
      content(),
    );

    expect(visitorProfileSession(household, storage, FIRST).profileActivity!.titles).toEqual([]);
  });

  it('creates a lowercase random 128-bit visit id', () => {
    expect(randomVisitorVisitId(() => new Uint8Array(16).fill(0xab))).toBe('ab'.repeat(16));
  });
});
