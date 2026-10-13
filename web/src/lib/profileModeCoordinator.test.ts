import { describe, expect, it, vi } from 'vitest';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel, LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView, ProfileDirectoryView } from './libraryServiceProtocol';
import { legacyProfileIdentity } from './profileIdentity';
import {
  allowsImplicitAssistant,
  ProfileModeCoordinator,
  previewProfileDirectory,
  profileDirectoryChoices,
  profilesCapability,
  type ProfileActivityModelFactory,
  type PreviewProfileDirectory,
} from './profileModeCoordinator.svelte';
import { ProfileSession } from './profileSession.svelte';
import { profileHouseholdSettingsModel, profileSettingsRoute } from './profileSettingsRoute';
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
  profileModels?: ProfileActivityModelFactory,
  householdPinConfigured?: boolean,
) {
  const authority = (configured: boolean) => {
    const release = vi.fn();
    const close = vi.fn();
    const verifyParentalPin = vi.fn(async (pin: string) => pin === '1234');
    const connections = vi.fn(
      () =>
        ({
          snapshot: {
            connection: 'ready',
            value: {
              kind: 'connections',
              parentalPinConfigured: configured,
              parentalPinDelivery: 'synced',
            },
          },
          release,
        }) as unknown as LibraryModelLease<ConnectionsView>,
    );
    const model = { close, connections, verifyParentalPin } as unknown as LibraryModel;
    return { model, close, connections, release, verifyParentalPin };
  };
  const activity = authority(pinConfigured);
  const control =
    householdPinConfigured === undefined ? activity : authority(householdPinConfigured);
  const closeWorker = vi.fn();
  const household = new HouseholdSession(
    { kind: 'legacy', libraryKey: 'household-key', configurationOnly: false },
    control.model,
    content(),
    closeWorker,
  );
  const session = new ProfileSession(
    legacyProfileIdentity('household-key', false),
    household,
    activity.model,
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
      profileModels,
    ),
    model: activity.model,
    close: activity.close,
    closeWorker,
    release: control.release,
    verifyParentalPin: control.verifyParentalPin,
    activityRelease: activity.release,
    activityVerifyParentalPin: activity.verifyParentalPin,
    householdModel: control.model,
    householdClose: control.close,
  };
}

const realDirectoryView = (
  ownerKey = 'owner-profile-key',
  kidKey = 'kid-profile-key',
): ProfileDirectoryView => {
  const preview = previewProfileDirectory();
  return {
    kind: 'profiles',
    owner: preview.owner,
    profiles: preview.profiles.map((profile, index) => ({
      id: profile.id!,
      role: profile.role as 'owner' | 'kid',
      name: profile.name,
      avatar: profile.avatar,
      libraryKey: index === 0 ? ownerKey : kidKey,
      keyVersion: 1,
      policy: profile.policy!,
      deleted: false,
    })),
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function profileModels(openings: Map<string, ReturnType<typeof deferred<unknown>>>) {
  const handles: Array<{ key: string; model: LibraryModel; close: ReturnType<typeof vi.fn> }> = [];
  const factory: ProfileActivityModelFactory = (key) => {
    const opening = openings.get(key) ?? deferred<unknown>();
    openings.set(key, opening);
    const model = {
      ready: opening.promise,
      close: vi.fn(),
      settings: { connection: 'connecting' },
    } as unknown as LibraryModel;
    const close = vi.fn(() => model.close());
    handles.push({ key, model, close });
    return { model, close };
  };
  return { factory, handles };
}

describe('ProfileModeCoordinator', () => {
  it('accepts only an active Owner and Kid with available versioned profile keys', () => {
    const valid = realDirectoryView();
    expect(profileDirectoryChoices(valid)?.profiles.map(({ role }) => role)).toEqual([
      'owner',
      'kid',
    ]);
    expect(
      profileDirectoryChoices({
        ...valid,
        profiles: valid.profiles.map((profile) =>
          profile.role === 'kid' ? { ...profile, libraryKey: '' } : profile,
        ),
      }),
    ).toBeNull();
    expect(
      profileDirectoryChoices({
        ...valid,
        profiles: valid.profiles.map((profile) =>
          profile.role === 'owner' ? { ...profile, deleted: true } : profile,
        ),
      }),
    ).toBeNull();

    const ownerOnly = {
      ...valid,
      profiles: valid.profiles.filter((profile) => profile.role === 'owner'),
    };
    expect(profileDirectoryChoices(ownerOnly)?.profiles.map(({ role }) => role)).toEqual(['owner']);

    const secondKid = {
      ...valid.profiles.find((profile) => profile.role === 'kid')!,
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'Teens',
      libraryKey: 'second-kid-key',
    };
    expect(
      profileDirectoryChoices({ ...valid, profiles: [...valid.profiles, secondKid] })?.profiles.map(
        ({ name }) => name,
      ),
    ).toEqual(['Owner', 'Kids', 'Teens']);
  });

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

  it.each([null, '{broken', JSON.stringify({ mode: 'unknown' })])(
    'purges orphan Visitor data after PIN proof and before recovered Owner becomes active (%s)',
    async (marker) => {
      const storage = memoryStorage();
      if (marker !== null) storage.setItem('den.profile.active.v1', marker);
      const orphan = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      storage.setItem(`den.profile.visitor.v1:${orphan}:activity`, 'private visit');
      storage.setItem(`den.profile.visitor.v1:${orphan}:preferences`, 'private preferences');
      storage.setItem('den.profile.personal.v1:activity', 'personal');
      const first = owner(storage);

      await expect(first.coordinator.switchToOwner('0000')).resolves.toBe(false);
      expect(storage.getItem(`den.profile.visitor.v1:${orphan}:activity`)).toBe('private visit');
      expect(first.coordinator.session).toBeNull();

      await expect(first.coordinator.switchToOwner('1234')).resolves.toBe(true);
      expect(first.coordinator.mode).toBe('owner');
      expect(storage.getItem(`den.profile.visitor.v1:${orphan}:activity`)).toBeNull();
      expect(storage.getItem(`den.profile.visitor.v1:${orphan}:preferences`)).toBeNull();
      expect(storage.getItem('den.profile.personal.v1:activity')).toBe('personal');
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

  it('keeps an unprotected Owner behind the explicit gate until orphan cleanup finishes', async () => {
    const storage = memoryStorage();
    const orphan = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    storage.setItem(`den.profile.visitor.v1:${orphan}:activity`, 'private visit');
    const first = owner(storage, false);

    expect(first.coordinator.establishUnprotectedOwner()).toBe(false);
    expect(first.coordinator.session).toBeNull();
    await expect(first.coordinator.switchToOwner()).resolves.toBe(true);
    expect(first.coordinator.mode).toBe('owner');
    expect(storage.getItem(`den.profile.visitor.v1:${orphan}:activity`)).toBeNull();
  });

  it('never publishes recovered Owner when orphan Visitor deletion fails', async () => {
    const base = memoryStorage();
    const orphan = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const orphanKey = `den.profile.visitor.v1:${orphan}:activity`;
    base.setItem('den.profile.active.v1', '{broken');
    base.setItem(orphanKey, 'private visit');
    let refuseDeletion = true;
    const storage: Storage = {
      get length() {
        return base.length;
      },
      clear: () => base.clear(),
      getItem: (key) => base.getItem(key),
      key: (index) => base.key(index),
      removeItem(key) {
        if (refuseDeletion && key === orphanKey) throw new Error('storage refused deletion');
        base.removeItem(key);
      },
      setItem: (key, value) => base.setItem(key, value),
    };
    const first = owner(storage);

    await expect(first.coordinator.switchToOwner('1234')).rejects.toThrow(
      'storage refused deletion',
    );
    expect(first.coordinator.session).toBeNull();
    expect(storage.getItem('den.profile.active.v1')).toBe('{broken');
    expect(storage.getItem(orphanKey)).toBe('private visit');

    refuseDeletion = false;
    await expect(first.coordinator.switchToOwner('1234')).resolves.toBe(true);
    expect(first.coordinator.mode).toBe('owner');
    expect(storage.getItem(orphanKey)).toBeNull();
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

  it('restores a real Kid only after its separate encrypted model is ready', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    const opening = deferred<unknown>();
    const models = profileModels(new Map([[kid.libraryKey, opening]]));

    const first = owner(storage, true, null, undefined, directory, models.factory);
    expect(first.coordinator.session).toBeNull();
    expect(models.handles.map(({ key }) => key)).toEqual([kid.libraryKey]);
    expect(first.coordinator.choices.every((choice) => !('libraryKey' in choice))).toBe(true);

    opening.resolve({ generation: 'profile-generation', head: 0 });
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('kid'));
    expect(first.coordinator.session!.identity).toMatchObject({
      kind: 'profile',
      id: kid.id,
      libraryKey: kid.libraryKey,
    });
    expect(first.coordinator.session!.model).toBe(models.handles[0]!.model);
    expect(first.coordinator.session!.household.identity.libraryKey).toBe('household-key');
    expect(first.coordinator.session!.model).not.toBe(first.model);
    expect(first.coordinator.session!.preferences).not.toBeNull();
  });

  it('uses the household PIN when a missing marker leaves Owner activity unselected', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    const opening = deferred<unknown>();
    const models = profileModels(new Map([[ownerProfile.libraryKey, opening]]));
    // The activity log deliberately disagrees: security configuration belongs to the household control log.
    const first = owner(storage, false, null, undefined, directory, models.factory, true);

    expect(first.coordinator.parentalPinConfigured).toBe(true);
    expect(first.coordinator.establishUnprotectedOwner()).toBe(false);
    await expect(first.coordinator.switchToOwner()).resolves.toBe(false);
    await expect(first.coordinator.switchToOwner('0000')).resolves.toBe(false);
    expect(first.activityVerifyParentalPin).not.toHaveBeenCalled();
    expect(first.verifyParentalPin).toHaveBeenCalledWith('0000');

    const switching = first.coordinator.switchToOwner('1234');
    await vi.waitFor(() => expect(models.handles).toHaveLength(1));
    opening.resolve({});
    await expect(switching).resolves.toBe(true);
    expect(first.coordinator.mode).toBe('owner');
    expect(profileSettingsRoute(first.coordinator.session!, first.coordinator.mode)).toBe(
      'household',
    );
    expect(profileHouseholdSettingsModel(first.coordinator.session!, first.coordinator.mode)).toBe(
      first.householdModel,
    );
    expect(first.coordinator.session!.model).not.toBe(first.householdModel);
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.householdClose).not.toHaveBeenCalled();
  });

  it('keeps household PIN authority alive across Kid and Visitor restores', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    const kidOpening = deferred<unknown>();
    const ownerOpening = deferred<unknown>();
    const models = profileModels(
      new Map([
        [kid.libraryKey, kidOpening],
        [ownerProfile.libraryKey, ownerOpening],
      ]),
    );
    const first = owner(storage, false, null, undefined, directory, models.factory, true);
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.householdClose).not.toHaveBeenCalled();
    kidOpening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('kid'));
    expect(profileSettingsRoute(first.coordinator.session!, first.coordinator.mode)).toBe(
      'personal',
    );
    expect(
      profileHouseholdSettingsModel(first.coordinator.session!, first.coordinator.mode),
    ).toBeNull();

    await expect(first.coordinator.switchToOwner()).resolves.toBe(false);
    await expect(first.coordinator.switchToOwner('0000')).resolves.toBe(false);
    const fromKid = first.coordinator.switchToOwner('1234');
    ownerOpening.resolve({});
    await expect(fromKid).resolves.toBe(true);
    await expect(first.coordinator.switchToVisitor()).resolves.toBe(true);
    await expect(first.coordinator.switchToOwner()).resolves.toBe(false);
    await expect(first.coordinator.switchToOwner('0000')).resolves.toBe(false);
    await expect(first.coordinator.switchToOwner('1234')).resolves.toBe(true);
    expect(profileHouseholdSettingsModel(first.coordinator.session!, first.coordinator.mode)).toBe(
      first.householdModel,
    );
    await expect(first.coordinator.switchToVisitor()).resolves.toBe(true);
    expect(profileSettingsRoute(first.coordinator.session!, first.coordinator.mode)).toBe(
      'personal',
    );
    expect(
      profileHouseholdSettingsModel(first.coordinator.session!, first.coordinator.mode),
    ).toBeNull();

    expect(first.activityVerifyParentalPin).not.toHaveBeenCalled();
    expect(first.verifyParentalPin.mock.calls).toEqual([['0000'], ['1234'], ['0000'], ['1234']]);
    expect(first.householdClose).not.toHaveBeenCalled();
    first.coordinator.dispose();
    expect(first.release).toHaveBeenCalledOnce();
    expect(first.householdClose).toHaveBeenCalledOnce();
  });

  it('switches between Kid profiles by id and opens the selected encrypted library', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const firstKid = view.profiles.find((profile) => profile.role === 'kid')!;
    const secondKid = {
      ...firstKid,
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'Teens',
      libraryKey: 'second-kid-key',
    };
    const directory = profileDirectoryChoices({
      ...view,
      profiles: [...view.profiles, secondKid],
    })!;
    const firstChoice = directory.profiles.find((choice) => choice.id === firstKid.id)!;
    const secondChoice = directory.profiles.find((choice) => choice.id === secondKid.id)!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: firstChoice.id }),
    );
    const firstOpening = deferred<unknown>();
    const secondOpening = deferred<unknown>();
    const models = profileModels(
      new Map([
        [firstKid.libraryKey, firstOpening],
        [secondKid.libraryKey, secondOpening],
      ]),
    );
    const first = owner(storage, true, null, undefined, directory, models.factory);
    firstOpening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.activeChoice?.id).toBe(firstChoice.id));

    const switching = first.coordinator.switchToPersistent(secondChoice.id!);
    secondOpening.resolve({});
    await expect(switching).resolves.toBe(true);
    expect(first.coordinator.activeChoice?.id).toBe(secondChoice.id);
    expect(first.coordinator.session!.identity.libraryKey).toBe(secondKid.libraryKey);
    expect(JSON.parse(storage.getItem('den.profile.active.v1')!)).toMatchObject({
      profileId: secondChoice.id,
    });
    expect(models.handles.map(({ key }) => key)).toEqual([
      firstKid.libraryKey,
      secondKid.libraryKey,
    ]);
  });

  it('converges a legacy Owner marker without ever publishing household activity', async () => {
    const storage = memoryStorage();
    storage.setItem('den.profile.active.v1', JSON.stringify({ mode: 'owner' }));
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    const opening = deferred<unknown>();
    const models = profileModels(new Map([[ownerProfile.libraryKey, opening]]));
    const first = owner(storage, false, null, undefined, directory, models.factory);

    expect(first.coordinator.session).toBeNull();
    expect(first.coordinator.establishUnprotectedOwner()).toBe(false);
    expect(models.handles).toHaveLength(1);
    expect(storage.getItem('den.profile.active.v1')).toBe(JSON.stringify({ mode: 'owner' }));

    opening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));
    expect(first.coordinator.session!.model).toBe(models.handles[0]!.model);
    expect(first.coordinator.session!.model).not.toBe(first.model);
    expect(storage.getItem('den.profile.active.v1')).toBe(
      JSON.stringify({
        version: 1,
        mode: 'persistent',
        profileId: ownerProfile.id,
      }),
    );
  });

  it('keeps the household activity hidden when a remembered profile cannot open', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    const marker = JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id });
    storage.setItem('den.profile.active.v1', marker);
    const opening = deferred<unknown>();
    const models = profileModels(new Map([[kid.libraryKey, opening]]));
    const first = owner(storage, true, null, undefined, directory, models.factory);

    opening.reject(new Error('profile unavailable'));
    await vi.waitFor(() => expect(models.handles[0]!.close).toHaveBeenCalledOnce());
    expect(models.handles[0]!.model.close).toHaveBeenCalledOnce();
    expect(first.coordinator.session).toBeNull();
    expect(storage.getItem('den.profile.active.v1')).toBe(marker);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('closes an in-flight profile model on coordinator disposal', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    const opening = deferred<unknown>();
    const models = profileModels(new Map([[kid.libraryKey, opening]]));
    const first = owner(storage, true, null, undefined, directory, models.factory);

    first.coordinator.dispose();
    expect(models.handles[0]!.close).toHaveBeenCalledOnce();
    expect(models.handles[0]!.model.close).toHaveBeenCalledOnce();
    opening.resolve({});
    await Promise.resolve();
    expect(first.coordinator.session).toBeNull();
    expect(models.handles[0]!.close).toHaveBeenCalledOnce();
    expect(models.handles[0]!.model.close).toHaveBeenCalledOnce();
  });

  it('keeps Kid active until Owner is ready, then commits the marker and closes only Kid activity', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    const kidOpening = deferred<unknown>();
    const ownerOpening = deferred<unknown>();
    const models = profileModels(
      new Map([
        [kid.libraryKey, kidOpening],
        [ownerProfile.libraryKey, ownerOpening],
      ]),
    );
    const first = owner(storage, true, null, undefined, directory, models.factory);
    kidOpening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('kid'));
    const kidSession = first.coordinator.session!;

    const switching = first.coordinator.switchToOwner('1234');
    await vi.waitFor(() => expect(models.handles).toHaveLength(2));
    expect(first.coordinator.session).toBe(kidSession);
    expect(JSON.parse(storage.getItem('den.profile.active.v1')!)).toMatchObject({
      profileId: kid.id,
    });

    ownerOpening.resolve({});
    await expect(switching).resolves.toBe(true);
    expect(first.coordinator.mode).toBe('owner');
    expect(first.coordinator.session!.identity.libraryKey).toBe(ownerProfile.libraryKey);
    expect(JSON.parse(storage.getItem('den.profile.active.v1')!)).toMatchObject({
      profileId: ownerProfile.id,
    });
    expect(models.handles[0]!.close).toHaveBeenCalledOnce();
    expect(first.close).not.toHaveBeenCalled();
  });

  it('drops a stale profile immediately and rejects an opening superseded by key rotation', async () => {
    const storage = memoryStorage();
    const firstView = realDirectoryView();
    const firstDirectory = profileDirectoryChoices(firstView)!;
    const kid = firstView.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    const oldOpening = deferred<unknown>();
    const newOpening = deferred<unknown>();
    const models = profileModels(
      new Map([
        [kid.libraryKey, oldOpening],
        ['rotated-kid-key', newOpening],
      ]),
    );
    const first = owner(storage, true, null, undefined, firstDirectory, models.factory);

    const rotated = profileDirectoryChoices(
      realDirectoryView('owner-profile-key', 'rotated-kid-key'),
    )!;
    first.coordinator.updateDirectory(rotated);
    expect(first.coordinator.session).toBeNull();
    oldOpening.resolve({});
    await vi.waitFor(() => expect(models.handles[0]!.close).toHaveBeenCalledOnce());
    expect(first.coordinator.session).toBeNull();

    newOpening.resolve({});
    await vi.waitFor(() =>
      expect(first.coordinator.session?.identity.libraryKey).toBe('rotated-kid-key'),
    );
    first.coordinator.updateDirectory(null);
    expect(first.coordinator.session).toBeNull();
    expect(models.handles[1]!.close).toHaveBeenCalledOnce();
    expect(models.handles[1]!.model.close).toHaveBeenCalledOnce();
  });

  it('keeps Owner and Visitor alive when the only Kid is deleted', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: ownerProfile.id }),
    );
    const opening = deferred<unknown>();
    const models = profileModels(new Map([[ownerProfile.libraryKey, opening]]));
    const first = owner(storage, true, null, undefined, directory, models.factory);
    opening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));
    const ownerSession = first.coordinator.session;
    const ownerOnly = profileDirectoryChoices({
      ...view,
      profiles: view.profiles.map((profile) =>
        profile.role === 'kid' ? { ...profile, deleted: true } : profile,
      ),
    })!;
    first.coordinator.updateDirectory(ownerOnly);
    expect(first.coordinator.session).toBe(ownerSession);
    await expect(first.coordinator.switchToVisitor()).resolves.toBe(true);
    const visitor = first.coordinator.session;
    expect(visitor?.preferences).not.toBeNull();
    first.coordinator.updateDirectory(ownerOnly);
    expect(first.coordinator.session).toBe(visitor);
    const withoutPolicies = {
      ...ownerOnly,
      profiles: ownerOnly.profiles.map(({ policy: _policy, ...profile }) => profile),
    };
    first.coordinator.updateDirectory(withoutPolicies);
    const policylessVisitor = first.coordinator.session;
    first.coordinator.updateDirectory(withoutPolicies);
    expect(first.coordinator.session).toBe(policylessVisitor);
  });

  it('restores the retained Visitor namespace after an invalid directory recovers', async () => {
    const storage = memoryStorage();
    const directory = profileDirectoryChoices(realDirectoryView())!;
    const first = owner(
      storage,
      false,
      null,
      undefined,
      directory,
      profileModels(new Map()).factory,
      true,
    );
    expect(first.coordinator.establishUnprotectedOwner()).toBe(false);
    expect(first.close).not.toHaveBeenCalled();
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'visitor', visitorNamespace: 'a'.repeat(32) }),
    );
    first.coordinator.updateDirectory(directory);
    expect(first.coordinator.mode).toBe('visitor');
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.householdClose).not.toHaveBeenCalled();
    first.coordinator.updateDirectory(null);
    expect(first.coordinator.session).toBeNull();
    first.coordinator.updateDirectory(directory);
    expect(first.coordinator.mode).toBe('visitor');
    expect(first.coordinator.session!.identity.id).toBe('a'.repeat(32));
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.householdClose).not.toHaveBeenCalled();
    first.coordinator.dispose();
    expect(first.householdClose).toHaveBeenCalledOnce();
  });

  it('allows implicit assistants only for the active Owner', async () => {
    const storage = memoryStorage();
    const directory = previewProfileDirectory();
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
    );
    const first = owner(storage, true, null, undefined, directory);
    expect(allowsImplicitAssistant(first.coordinator, first.coordinator.session!)).toBe(true);
    await first.coordinator.switchToKid();
    expect(allowsImplicitAssistant(first.coordinator, first.coordinator.session!)).toBe(false);
    await first.coordinator.switchToVisitor('1234');
    expect(allowsImplicitAssistant(first.coordinator, first.coordinator.session!)).toBe(false);
  });

  it.each([
    null,
    '{broken',
    JSON.stringify({ mode: 'unknown' }),
    JSON.stringify({ version: 1, mode: 'persistent', profileId: 'f'.repeat(32) }),
  ])('neutral-gates an active session after an invalid cross-tab marker (%s)', async (marker) => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const directory = previewProfileDirectory();
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
    );
    const first = owner(storage, true, events, undefined, directory);
    expect(first.coordinator.mode).toBe('owner');
    if (marker === null) storage.removeItem('den.profile.active.v1');
    else storage.setItem('den.profile.active.v1', marker);
    events.dispatchEvent(storageEvent('den.profile.active.v1'));
    expect(first.coordinator.session).toBeNull();
    expect(first.coordinator.mode).toBeNull();
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
