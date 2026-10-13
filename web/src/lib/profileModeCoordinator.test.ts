import { describe, expect, it, vi } from 'vitest';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel, LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView } from './libraryServiceProtocol';
import { legacyProfileIdentity } from './profileIdentity';
import {
  ProfileModeCoordinator,
  previewProfileDirectory,
  profilesCapability,
  type PreviewProfileDirectory,
} from './profileModeCoordinator.svelte';
import { ProfileSession } from './profileSession.svelte';
import type { VisitorActivityLock, VisitorProfileSession } from './visitorProfileSession.svelte';

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
const immediateLock: VisitorActivityLock = {
  available: () => true,
  async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
    return work();
  },
};
const capabilityResponse = (body: string, status = 200, cacheControl = 'no-store'): Response =>
  new Response(body, { status, headers: { 'cache-control': cacheControl } });

function storageEvent(key: string): Event {
  const event = new Event('storage');
  Object.defineProperties(event, {
    key: { value: key },
    storageArea: { value: null },
  });
  return event;
}

function owner(
  storage: Storage,
  pinConfigured = true,
  events: EventTarget | null = null,
  visitorLock?: VisitorActivityLock,
  directory?: PreviewProfileDirectory,
) {
  const release = vi.fn();
  const close = vi.fn();
  const verifyParentalPin = vi.fn(async (pin: string) => pin === '1234');
  const connections = vi.fn(
    () =>
      ({
        snapshot: {
          connection: 'ready',
          value: { kind: 'connections', parentalPinConfigured: pinConfigured },
        },
        release,
      }) as unknown as LibraryModelLease<ConnectionsView>,
  );
  const model = { close, connections, verifyParentalPin } as unknown as LibraryModel;
  const closeWorker = vi.fn();
  const household = new HouseholdSession(
    { kind: 'legacy', libraryKey: 'household-key', configurationOnly: false },
    model,
    content(),
    closeWorker,
  );
  const session = new ProfileSession(
    legacyProfileIdentity('household-key', false),
    household,
    model,
    false,
    true,
  );
  return {
    coordinator: new ProfileModeCoordinator(
      session,
      storage,
      events as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
      visitorLock ?? immediateLock,
      directory,
    ),
    model,
    close,
    closeWorker,
    release,
    verifyParentalPin,
  };
}

describe('ProfileModeCoordinator', () => {
  it('keeps a failed Owner transition intact and retries the same durable visit', async () => {
    const storage = memoryStorage();
    storage.setItem('den.profile.active.v1', JSON.stringify({ mode: 'owner' }));
    let attempts = 0;
    const lock: VisitorActivityLock = {
      available: () => true,
      run: async <T>(_name: string, work: () => Promise<T> | T): Promise<T> => {
        if (attempts++ === 1) throw new Error('lock refused');
        return work();
      },
    };
    const first = owner(storage, false, null, lock);
    await expect(first.coordinator.switchToVisitor()).resolves.toBe(true);
    const visitor = first.coordinator.session as VisitorProfileSession;
    const marker = storage.getItem('den.profile.active.v1');
    storage.setItem(`${visitor.activity.prefix}activity`, JSON.stringify({ retained: true }));

    await expect(first.coordinator.switchToOwner()).rejects.toThrow('lock refused');
    expect(first.coordinator.session).toBe(visitor);
    expect(first.coordinator.mode).toBe('visitor');
    expect(storage.getItem('den.profile.active.v1')).toBe(marker);
    expect(storage.getItem(`${visitor.activity.prefix}activity`)).not.toBeNull();
    expect(visitor.activity.get('activity')).toEqual({ retained: true });

    await expect(first.coordinator.switchToOwner()).resolves.toBe(true);
    expect(first.coordinator.mode).toBe('owner');
    expect(storage.getItem('den.profile.active.v1')).toBe(JSON.stringify({ mode: 'owner' }));
    expect(storage.getItem(`${visitor.activity.prefix}activity`)).toBeNull();
    await expect(first.coordinator.switchToOwner()).resolves.toBe(true);
    expect(attempts).toBe(3);
  });

  it('does not enter or restore Visitor when cross-tab locking is unavailable', async () => {
    const unavailable: VisitorActivityLock = {
      available: () => false,
      run: async <T>(): Promise<T> => {
        throw new Error('must not run');
      },
    };
    const storage = memoryStorage();
    const visitId = '11111111111111111111111111111111';
    const marker = JSON.stringify({ mode: 'visitor', visitId });
    storage.setItem('den.profile.active.v1', marker);
    const restored = owner(storage, true, null, unavailable);
    expect(restored.coordinator.mode).toBeNull();
    expect(restored.coordinator.session).toBeNull();
    expect(storage.getItem('den.profile.active.v1')).toBe(marker);

    const ownerStorage = memoryStorage();
    ownerStorage.setItem('den.profile.active.v1', JSON.stringify({ mode: 'owner' }));
    const activeOwner = owner(ownerStorage, false, null, unavailable);
    await expect(activeOwner.coordinator.switchToVisitor()).resolves.toBe(false);
    expect(activeOwner.coordinator.mode).toBe('owner');
    expect(ownerStorage.getItem('den.profile.active.v1')).toBe(JSON.stringify({ mode: 'owner' }));

    const enabled = vi.fn(async () => capabilityResponse(JSON.stringify({ enabled: true })));
    await expect(profilesCapability(enabled as typeof fetch, unavailable)).resolves.toBe(
      'indeterminate',
    );
    expect(enabled).toHaveBeenCalledOnce();

    const rejecting: VisitorActivityLock = {
      available: () => true,
      run: async <T>(): Promise<T> => {
        throw new Error('lock refused');
      },
    };
    await expect(profilesCapability(enabled as typeof fetch, rejecting)).resolves.toBe(
      'indeterminate',
    );
    expect(enabled).toHaveBeenCalledTimes(2);
  });

  it('serializes shared-tab activity and revokes a stale tab before it can recreate an ended visit', async () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    storage.setItem('den.profile.active.v1', JSON.stringify({ mode: 'owner' }));
    const first = owner(storage, false, events);
    await first.coordinator.switchToVisitor();
    const visitId = first.coordinator.session!.identity.id;
    const second = owner(storage, false, events);
    const a = first.coordinator.session as VisitorProfileSession;
    const b = second.coordinator.session as VisitorProfileSession;

    await Promise.all([
      a.profileActivity!.setWatchlisted({ type: 'movie', id: 1, title: 'One' }, true),
      b.profileActivity!.setWatchlisted({ type: 'movie', id: 2, title: 'Two' }, true),
    ]);
    events.dispatchEvent(storageEvent(`${a.activity.prefix}activity`));
    expect(a.profileActivity!.watchlist.map(({ title }) => title).sort()).toEqual(['One', 'Two']);
    expect(b.profileActivity!.watchlist.map(({ title }) => title).sort()).toEqual(['One', 'Two']);

    await expect(first.coordinator.switchToOwner()).resolves.toBe(true);
    expect(storage.getItem(`${a.activity.prefix}activity`)).toBeNull();
    await expect(
      b.profileActivity!.setWatchlisted({ type: 'movie', id: 3, title: 'Three' }, true),
    ).rejects.toThrow('ended');
    expect(storage.getItem(`${a.activity.prefix}activity`)).toBeNull();

    events.dispatchEvent(storageEvent('den.profile.active.v1'));
    await vi.waitFor(() => expect(second.coordinator.mode).toBe('owner'));
    expect(second.coordinator.session!.identity.id).not.toBe(visitId);
    first.coordinator.dispose();
    second.coordinator.dispose();
  });

  it('persists one Visitor across teardown and reconstructs its local namespace', async () => {
    const storage = memoryStorage();
    storage.setItem('den.profile.active.v1', JSON.stringify({ mode: 'owner' }));
    const first = owner(storage);

    await first.coordinator.switchToVisitor();
    const visitId = first.coordinator.session!.identity.id;
    expect(visitId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.coordinator.mode).toBe('visitor');
    expect(first.coordinator.session!.model).toBeNull();
    expect(first.coordinator.session!.policy).not.toBe(first.model);
    expect(Object.keys(first.coordinator.session!.policy!)).toEqual(['settings']);
    expect('commands' in first.coordinator.session!.policy!).toBe(false);
    expect('track' in first.coordinator.session!.policy!).toBe(false);
    expect('model' in first.coordinator.session!.household).toBe(false);
    expect('model' in first.coordinator.session!.services).toBe(false);
    expect(storage.getItem('den.profile.active.v1')).toBe(
      JSON.stringify({ mode: 'visitor', visitId }),
    );
    const activity = first.coordinator.session as NonNullable<typeof first.coordinator.session> & {
      activity: { set: (key: string, value: string) => Promise<void> };
    };
    await activity.activity.set('progress:movie:550', 'half');
    first.coordinator.dispose();

    const restored = owner(storage);
    expect(restored.coordinator.mode).toBe('visitor');
    expect(restored.coordinator.session!.identity.id).toBe(visitId);
    const restoredActivity = restored.coordinator.session as NonNullable<
      typeof restored.coordinator.session
    > & {
      activity: { get: (key: string) => unknown };
    };
    expect(restoredActivity.activity.get('progress:movie:550')).toBe('half');
  });

  it.each([null, '{broken', JSON.stringify({ mode: 'unknown' })])(
    'requires the configured PIN before an absent or invalid marker can establish Owner (%s)',
    async (marker) => {
      const storage = memoryStorage();
      if (marker !== null) storage.setItem('den.profile.active.v1', marker);
      const first = owner(storage);

      expect(first.coordinator.mode).toBeNull();
      expect(first.coordinator.session).toBeNull();
      expect(storage.getItem('den.profile.active.v1')).toBe(marker);
      await expect(first.coordinator.switchToOwner('0000')).resolves.toBe(false);
      expect(first.coordinator.session).toBeNull();
      await expect(first.coordinator.switchToOwner('1234')).resolves.toBe(true);
      expect(first.coordinator.mode).toBe('owner');
      expect(storage.getItem('den.profile.active.v1')).toBe(JSON.stringify({ mode: 'owner' }));
    },
  );

  it('establishes and persists Owner directly when no PIN is configured', () => {
    const storage = memoryStorage();
    const first = owner(storage, false);

    expect(first.coordinator.mode).toBeNull();
    expect(first.coordinator.establishUnprotectedOwner()).toBe(true);
    expect(first.coordinator.mode).toBe('owner');
    expect(storage.getItem('den.profile.active.v1')).toBe(JSON.stringify({ mode: 'owner' }));
  });

  it('denies a wrong configured PIN and ends only the active visit after the right PIN', async () => {
    const storage = memoryStorage();
    storage.setItem('den.owner.untouched', 'owner');
    storage.setItem('den.profile.active.v1', JSON.stringify({ mode: 'owner' }));
    const first = owner(storage);
    await first.coordinator.switchToVisitor();
    const endedId = first.coordinator.session!.identity.id;
    const activity = first.coordinator.session as NonNullable<typeof first.coordinator.session> & {
      activity: { set: (key: string, value: number) => Promise<void> };
    };
    await activity.activity.set('progress', 1);
    storage.setItem('den.profile.visitor.v1:ffffffffffffffffffffffffffffffff:progress', '2');

    await expect(first.coordinator.switchToOwner('0000')).resolves.toBe(false);
    expect(first.coordinator.mode).toBe('visitor');
    expect(storage.getItem(`den.profile.visitor.v1:${endedId}:progress`)).toBe('1');

    await expect(first.coordinator.switchToOwner('1234')).resolves.toBe(true);
    expect(first.coordinator.mode).toBe('owner');
    expect(first.verifyParentalPin).toHaveBeenNthCalledWith(1, '0000');
    expect(first.verifyParentalPin).toHaveBeenNthCalledWith(2, '1234');
    expect(storage.getItem(`den.profile.visitor.v1:${endedId}:progress`)).toBeNull();
    expect(
      storage.getItem('den.profile.visitor.v1:ffffffffffffffffffffffffffffffff:progress'),
    ).toBe('2');
    expect(storage.getItem('den.owner.untouched')).toBe('owner');
  });

  it('switches to Owner without a PIN when none is configured and closes household only on disposal', async () => {
    const storage = memoryStorage();
    storage.setItem('den.profile.active.v1', JSON.stringify({ mode: 'owner' }));
    const first = owner(storage, false);
    await first.coordinator.switchToVisitor();

    await expect(first.coordinator.switchToOwner()).resolves.toBe(true);
    expect(first.verifyParentalPin).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    first.coordinator.dispose();
    first.coordinator.dispose();
    expect(first.release).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.closeWorker).toHaveBeenCalledOnce();
  });

  it('keeps preview Kid and Visitor sticky and PIN-gates every looser transition', async () => {
    const storage = memoryStorage();
    const directory = previewProfileDirectory();
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
    );
    const first = owner(storage, true, null, undefined, directory);

    expect(first.coordinator.choices.map(({ name }) => name)).toEqual(['Owner', 'Kids', 'Visitor']);
    await expect(first.coordinator.switchToKid()).resolves.toBe(true);
    expect(first.coordinator.mode).toBe('kid');
    expect(first.coordinator.activeChoice?.name).toBe('Kids');
    expect(storage.getItem('den.profile.active.v1')).toBe(
      JSON.stringify({
        version: 1,
        mode: 'persistent',
        profileId: '00000000000000000000000000000002',
      }),
    );

    await expect(first.coordinator.switchToVisitor('0000')).resolves.toBe(false);
    expect(first.coordinator.mode).toBe('kid');
    await expect(first.coordinator.switchToVisitor('1234')).resolves.toBe(true);
    expect(first.coordinator.mode).toBe('visitor');
    expect(JSON.parse(storage.getItem('den.profile.active.v1')!)).toMatchObject({
      version: 1,
      mode: 'visitor',
    });

    first.coordinator.dispose();
    const restoredVisitor = owner(storage, true, null, undefined, directory);
    expect(restoredVisitor.coordinator.mode).toBe('visitor');
    await expect(restoredVisitor.coordinator.switchToKid()).resolves.toBe(true);
    expect(restoredVisitor.coordinator.mode).toBe('kid');
    restoredVisitor.coordinator.dispose();

    const restoredKid = owner(storage, true, null, undefined, directory);
    expect(restoredKid.coordinator.mode).toBe('kid');
    await expect(restoredKid.coordinator.switchToOwner('0000')).resolves.toBe(false);
    expect(restoredKid.coordinator.mode).toBe('kid');
    await expect(restoredKid.coordinator.switchToOwner('1234')).resolves.toBe(true);
    expect(restoredKid.coordinator.mode).toBe('owner');
  });
});

describe('profilesCapability', () => {
  it('distinguishes explicit enabled and disabled answers from every indeterminate failure', async () => {
    const enabled = vi.fn(async () => capabilityResponse(JSON.stringify({ enabled: true })));
    await expect(profilesCapability(enabled as typeof fetch, immediateLock)).resolves.toBe(
      'enabled',
    );
    expect(enabled).toHaveBeenCalledWith('/capabilities/profiles', {
      cache: 'no-store',
      credentials: 'same-origin',
    });

    const preview = vi.fn(async () =>
      capabilityResponse(JSON.stringify({ enabled: true, preview: true })),
    );
    await expect(profilesCapability(preview as typeof fetch, immediateLock)).resolves.toBe(
      'preview',
    );
    await expect(
      profilesCapability(
        vi.fn(async () =>
          capabilityResponse(JSON.stringify({ enabled: true, preview: true }), 200, '  NO-STORE  '),
        ) as typeof fetch,
        immediateLock,
      ),
    ).resolves.toBe('preview');
    for (const cacheControl of [
      'public, max-age=86400, x-no-store=1',
      'public, max-age=86400, no-store-if="preview"',
    ]) {
      await expect(
        profilesCapability(
          vi.fn(async () =>
            capabilityResponse(JSON.stringify({ enabled: true, preview: true }), 200, cacheControl),
          ) as typeof fetch,
          immediateLock,
        ),
      ).resolves.toBe('indeterminate');
    }
    await expect(
      profilesCapability(
        vi.fn(async () =>
          capabilityResponse(JSON.stringify({ enabled: true, preview: true, migration: false })),
        ) as typeof fetch,
        immediateLock,
      ),
    ).resolves.toBe('indeterminate');
    await expect(
      profilesCapability(preview as typeof fetch, {
        available: () => false,
        run: immediateLock.run,
      }),
    ).resolves.toBe('indeterminate');

    await expect(
      profilesCapability(
        vi.fn(async () =>
          capabilityResponse(JSON.stringify({ error: 'not_found' }), 404),
        ) as typeof fetch,
        { available: () => false, run: immediateLock.run },
      ),
    ).resolves.toBe('disabled');
    await expect(
      profilesCapability(
        vi.fn(async () => capabilityResponse(JSON.stringify({ enabled: false }))) as typeof fetch,
      ),
    ).resolves.toBe('indeterminate');
    await expect(
      profilesCapability(vi.fn(async () => capabilityResponse('{}', 404)) as typeof fetch),
    ).resolves.toBe('indeterminate');
    await expect(
      profilesCapability(vi.fn(async () => capabilityResponse('{broken')) as typeof fetch),
    ).resolves.toBe('indeterminate');
    await expect(
      profilesCapability(vi.fn(async () => capabilityResponse('{}')) as typeof fetch),
    ).resolves.toBe('indeterminate');
    await expect(
      profilesCapability(
        vi.fn(async () => new Response(JSON.stringify({ enabled: true }))) as typeof fetch,
      ),
    ).resolves.toBe('indeterminate');
    await expect(
      profilesCapability(
        vi.fn(async () => {
          throw new TypeError('offline');
        }) as typeof fetch,
      ),
    ).resolves.toBe('indeterminate');
  });
});
