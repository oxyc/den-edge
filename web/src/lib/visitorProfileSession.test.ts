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

  it('creates a lowercase random 128-bit visit id', () => {
    expect(randomVisitorVisitId(() => new Uint8Array(16).fill(0xab))).toBe('ab'.repeat(16));
  });
});
