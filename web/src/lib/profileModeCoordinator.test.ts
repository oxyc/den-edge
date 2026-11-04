import { describe, expect, it, vi } from 'vitest';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel, LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView, ProfileDirectoryView } from './libraryServiceProtocol';
import { legacyProfileIdentity } from './profileIdentity';
import {
  allowsImplicitAssistant,
  householdAdministration,
  profileMarkerPresent,
  ProfileModeCoordinator,
  previewProfileDirectory,
  profileDirectoryChoices,
  profileDirectoryState,
  profilesCapability,
  usesProfileDirectory,
  type ProfileActivityModelFactory,
  type PreviewProfileDirectory,
} from './profileModeCoordinator.svelte';
import { ProfileSession } from './profileSession.svelte';
import { profileHouseholdSettingsModel, profileSettingsRoute } from './profileSettingsRoute';
import {
  visitorNamespaceIds,
  type VisitorActivityLock,
  type VisitorProfileSession,
} from './visitorProfileSession.svelte';

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

const switchToKid = (coordinator: ProfileModeCoordinator, pin?: string) =>
  coordinator.switchToPersistent(coordinator.choices.find(({ role }) => role === 'kid')!.id!, pin);

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
  startsKid?: (pin: string) => Promise<boolean>,
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
    const settings = {
      connection: 'ready',
      value: {
        kind: 'settings',
        preferences: { watchRegion: 'fi', services: [], servicesConfigured: false },
        assistant: { read: false, write: false },
      },
    };
    const model = { close, connections, verifyParentalPin, settings } as unknown as LibraryModel;
    return { model, close, connections, release, verifyParentalPin };
  };
  const activity = authority(pinConfigured);
  const control =
    householdPinConfigured === undefined ? activity : authority(householdPinConfigured);
  const closeWorker = vi.fn();
  const householdContent = content();
  const household = new HouseholdSession(
    { kind: 'legacy', libraryKey: 'household-key', configurationOnly: false },
    control.model,
    householdContent,
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
      startsKid,
    ),
    model: activity.model,
    householdContent,
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
    state: 'present',
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

/** `region`, when given, is the watch region every opened profile library holds in its own preferences. */
function profileModels(
  openings: Map<string, ReturnType<typeof deferred<unknown>>>,
  region?: string,
) {
  const handles: Array<{ key: string; model: LibraryModel; close: ReturnType<typeof vi.fn> }> = [];
  const factory: ProfileActivityModelFactory = (key) => {
    const opening = openings.get(key) ?? deferred<unknown>();
    openings.set(key, opening);
    const model = {
      ready: opening.promise,
      close: vi.fn(),
      settings: region
        ? {
            connection: 'ready',
            value: {
              kind: 'settings',
              preferences: { watchRegion: region, services: [], servicesConfigured: false },
              assistant: { read: false, write: false },
            },
          }
        : { connection: 'connecting' },
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

  it('waits on a profile directory only for a linked household', () => {
    const model = {};
    expect(usesProfileDirectory({ local: false, model })).toBe(true);
    // This browser's own library is not a household, and a session without a model has nothing to read.
    expect(usesProfileDirectory({ local: true, model })).toBe(false);
    expect(usesProfileDirectory({ local: false, model: null })).toBe(false);
    expect(usesProfileDirectory({ local: true, model: null })).toBe(false);
  });

  it('tells an unanswered directory read from an absent and an invalid directory', () => {
    const valid = realDirectoryView();
    expect(profileDirectoryState(undefined)).toEqual({ kind: 'pending' });
    const none = { kind: 'profiles' as const, owner: null, profiles: [] };
    expect(profileDirectoryState({ ...none, state: 'absent' })).toEqual({ kind: 'absent' });
    // The log's verdict wins: an empty projection of a corrupt or committed household is not "none".
    expect(profileDirectoryState({ ...none, state: 'invalid' })).toEqual({ kind: 'invalid' });
    // A kept household that predates a committed split has yet to read it: not invalid, not yet answered.
    expect(profileDirectoryState({ ...none, state: 'pending' })).toEqual({ kind: 'pending' });
    expect(profileDirectoryState(valid)).toMatchObject({ kind: 'present' });
    // A directory that exists but cannot be opened is never mistaken for none.
    expect(profileDirectoryState({ ...valid, owner: null })).toEqual({ kind: 'invalid' });
    expect(
      profileDirectoryState({
        ...valid,
        profiles: valid.profiles.filter((profile) => profile.role !== 'owner'),
      }),
    ).toEqual({ kind: 'invalid' });
    expect(
      profileDirectoryState({
        ...valid,
        profiles: valid.profiles.map((profile) => ({ ...profile, libraryKey: '' })),
      }),
    ).toEqual({ kind: 'invalid' });
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
    await expect(first.coordinator.switchToVisitor()).resolves.toMatchObject({
      outcome: 'success',
    });
    const visitor = first.coordinator.session as VisitorProfileSession;
    const marker = storage.getItem('den.profile.active.v1');
    storage.setItem(`${visitor.activity.prefix}activity`, JSON.stringify({ retained: true }));

    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({
      outcome: 'failed',
      cause: expect.objectContaining({ message: 'lock refused' }),
    });
    expect(first.coordinator.session).toBe(visitor);
    expect(first.coordinator.mode).toBe('visitor');
    expect(storage.getItem('den.profile.active.v1')).toBe(marker);
    expect(storage.getItem(`${visitor.activity.prefix}activity`)).not.toBeNull();
    expect(visitor.activity.get('activity')).toEqual({ retained: true });

    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'success' });
    expect(first.coordinator.mode).toBe('owner');
    expect(storage.getItem('den.profile.active.v1')).toBe(JSON.stringify({ mode: 'owner' }));
    expect(storage.getItem(`${visitor.activity.prefix}activity`)).toBeNull();
    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'success' });
    expect(attempts).toBe(3);
  });

  it('gives the latest profile transition ownership of an in-flight Visitor disposal', async () => {
    const storage = memoryStorage();
    const directory = previewProfileDirectory();
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    let runs = 0;
    const lock: VisitorActivityLock = {
      available: () => true,
      async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
        if (runs++ === 1) {
          entered.resolve();
          await release.promise;
        }
        return work();
      },
    };
    const first = owner(storage, true, null, lock, directory);
    await expect(first.coordinator.switchToVisitor()).resolves.toMatchObject({
      outcome: 'success',
    });
    const visitor = first.coordinator.session;
    const kid = directory.profiles.find((choice) => choice.role === 'kid')!;

    const staleOwner = first.coordinator.switchToOwner('1234');
    await entered.promise;
    const latestKid = first.coordinator.switchToPersistent(kid.id!);
    release.resolve();

    await expect(staleOwner).resolves.toMatchObject({ outcome: 'superseded' });
    await expect(latestKid).resolves.toMatchObject({ outcome: 'success' });
    expect(first.coordinator.session).not.toBe(visitor);
    expect(first.coordinator.activeChoice?.id).toBe(kid.id);
    expect(JSON.parse(storage.getItem('den.profile.active.v1')!)).toMatchObject({
      mode: 'persistent',
      profileId: kid.id,
    });
  });

  it('publishes only the latest cross-tab marker after overlapping Visitor cleanup', async () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const directory = previewProfileDirectory();
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    let runs = 0;
    const lock: VisitorActivityLock = {
      available: () => true,
      async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
        if (runs++ === 1) {
          entered.resolve();
          await release.promise;
        }
        return work();
      },
    };
    const first = owner(storage, true, events, lock, directory);
    await first.coordinator.switchToVisitor();
    const kid = directory.profiles.find((choice) => choice.role === 'kid')!;

    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
    );
    events.dispatchEvent(storageEvent('den.profile.active.v1'));
    await entered.promise;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    events.dispatchEvent(storageEvent('den.profile.active.v1'));
    release.resolve();

    await vi.waitFor(() => expect(first.coordinator.activeChoice?.id).toBe(kid.id));
    expect(first.coordinator.mode).toBe('kid');
  });

  it('retires a losing Visitor namespace before adopting another tab’s visit', async () => {
    const storage = memoryStorage();
    const firstEvents = new EventTarget();
    const directory = previewProfileDirectory();
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    let runs = 0;
    const lock: VisitorActivityLock = {
      available: () => true,
      async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
        if (runs++ === 2) {
          entered.resolve();
          await release.promise;
        }
        return work();
      },
    };
    const first = owner(storage, true, firstEvents, lock, directory);
    const second = owner(storage, true, new EventTarget(), lock, directory);
    await first.coordinator.switchToVisitor();
    const losing = first.coordinator.session as VisitorProfileSession;
    storage.setItem(`${losing.activity.prefix}activity`, JSON.stringify({ private: true }));

    await second.coordinator.switchToVisitor();
    const winningId = second.coordinator.session!.identity.id;
    const winningMarker = storage.getItem('den.profile.active.v1');
    expect(winningId).not.toBe(losing.identity.id);
    firstEvents.dispatchEvent(storageEvent('den.profile.active.v1'));
    await entered.promise;
    expect(first.coordinator.session).toBe(losing);
    expect(storage.getItem(`${losing.activity.prefix}activity`)).not.toBeNull();
    release.resolve();

    await vi.waitFor(() => expect(first.coordinator.session?.identity.id).toBe(winningId));
    expect(storage.getItem(`${losing.activity.prefix}activity`)).toBeNull();
    expect(storage.getItem('den.profile.active.v1')).toBe(winningMarker);
    expect(first.coordinator.mode).toBe('visitor');
  });

  it('finishes losing-Visitor cleanup across a directory withdrawal and restores the winner', async () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const ownerProfile = directory.profiles.find((profile) => profile.role === 'owner')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: ownerProfile.id }),
    );
    const ownerOpening = deferred<unknown>();
    const models = profileModels(new Map([[ownerProfile.libraryKey!, ownerOpening]]));
    const entered = deferred<void>();
    const release = deferred<void>();
    let runs = 0;
    const lock: VisitorActivityLock = {
      available: () => true,
      async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
        if (runs++ === 1) {
          entered.resolve();
          await release.promise;
        }
        return work();
      },
    };
    const first = owner(storage, true, events, lock, directory, models.factory);
    ownerOpening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));
    await first.coordinator.switchToVisitor();
    const losing = first.coordinator.session as VisitorProfileSession;
    storage.setItem(`${losing.activity.prefix}activity`, JSON.stringify({ private: true }));
    const winner = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const winnerMarker = JSON.stringify({
      version: 1,
      mode: 'visitor',
      visitorNamespace: winner,
    });

    storage.setItem('den.profile.active.v1', winnerMarker);
    events.dispatchEvent(storageEvent('den.profile.active.v1'));
    await entered.promise;
    first.coordinator.updateDirectory(null);
    expect(first.coordinator.session).toBeNull();
    release.resolve();
    await vi.waitFor(() => expect(storage.getItem(`${losing.activity.prefix}activity`)).toBeNull());

    first.coordinator.updateDirectory(directory);
    await vi.waitFor(() => expect(first.coordinator.session?.identity.id).toBe(winner));
    expect(storage.getItem('den.profile.active.v1')).toBe(winnerMarker);
    expect(first.coordinator.mode).toBe('visitor');
  });

  it('does not hide a latest local marker-write failure behind stale Visitor cleanup', async () => {
    const base = memoryStorage();
    const events = new EventTarget();
    const directory = previewProfileDirectory();
    const kid = directory.profiles.find((profile) => profile.role === 'kid')!;
    let refuseKidMarker = false;
    const storage: Storage = {
      get length() {
        return base.length;
      },
      clear: () => base.clear(),
      getItem: (key) => base.getItem(key),
      key: (index) => base.key(index),
      removeItem: (key) => base.removeItem(key),
      setItem(key, value) {
        if (
          refuseKidMarker &&
          key === 'den.profile.active.v1' &&
          JSON.parse(value).profileId === kid.id
        )
          throw new Error('marker write failed');
        base.setItem(key, value);
      },
    };
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: directory.owner }),
    );
    const entered = deferred<void>();
    const release = deferred<void>();
    let runs = 0;
    const lock: VisitorActivityLock = {
      available: () => true,
      async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
        if (runs++ === 1) {
          entered.resolve();
          await release.promise;
        }
        return work();
      },
    };
    const first = owner(storage, true, events, lock, directory);
    await first.coordinator.switchToVisitor();
    const losing = first.coordinator.session as VisitorProfileSession;
    storage.setItem(`${losing.activity.prefix}activity`, JSON.stringify({ private: true }));
    const winnerMarker = JSON.stringify({
      version: 1,
      mode: 'visitor',
      visitorNamespace: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    storage.setItem('den.profile.active.v1', winnerMarker);
    events.dispatchEvent(storageEvent('den.profile.active.v1'));
    await entered.promise;

    refuseKidMarker = true;
    const switching = first.coordinator.switchToPersistent(kid.id!);
    release.resolve();

    await expect(switching).resolves.toMatchObject({
      outcome: 'failed',
      cause: expect.objectContaining({ message: 'marker write failed' }),
    });
    expect(first.coordinator.session).toBe(losing);
    expect(storage.getItem('den.profile.active.v1')).toBe(winnerMarker);
    expect(storage.getItem(`${losing.activity.prefix}activity`)).not.toBeNull();
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
    await expect(activeOwner.coordinator.switchToVisitor()).resolves.toMatchObject({
      outcome: 'failed',
    });
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

  it('supersedes a Visitor waiting for its lock before a newer selection can write or replace Owner', async () => {
    const storage = memoryStorage();
    const ownerMarker = JSON.stringify({ mode: 'owner' });
    storage.setItem('den.profile.active.v1', ownerMarker);
    const entered = deferred<void>();
    const release = deferred<void>();
    const lock: VisitorActivityLock = {
      available: () => true,
      async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
        entered.resolve();
        await release.promise;
        return work();
      },
    };
    const first = owner(storage, false, null, lock);
    const ownerSession = first.coordinator.session;

    const visitor = first.coordinator.switchToVisitor();
    await entered.promise;
    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({
      outcome: 'success',
    });
    release.resolve();

    await expect(visitor).resolves.toMatchObject({ outcome: 'superseded' });
    expect(first.coordinator.session).toBe(ownerSession);
    expect(storage.getItem('den.profile.active.v1')).toBe(ownerMarker);
    expect(visitorNamespaceIds(storage)).toEqual([]);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('supersedes a Visitor lock wait and every later switch after disposal without writing a marker', async () => {
    const storage = memoryStorage();
    const ownerMarker = JSON.stringify({ mode: 'owner' });
    storage.setItem('den.profile.active.v1', ownerMarker);
    const entered = deferred<void>();
    const release = deferred<void>();
    const lock: VisitorActivityLock = {
      available: () => true,
      async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
        entered.resolve();
        await release.promise;
        return work();
      },
    };
    const first = owner(storage, true, null, lock);
    const ownerSession = first.coordinator.session;

    const visitor = first.coordinator.switchToVisitor();
    await entered.promise;
    first.coordinator.dispose();
    release.resolve();

    await expect(visitor).resolves.toMatchObject({ outcome: 'superseded' });
    await expect(
      first.coordinator.switchToPersistent(previewProfileDirectory().profiles[1]!.id!),
    ).resolves.toMatchObject({
      outcome: 'superseded',
    });
    expect(first.coordinator.session).toBe(ownerSession);
    expect(storage.getItem('den.profile.active.v1')).toBe(ownerMarker);
    expect(visitorNamespaceIds(storage)).toEqual([]);
  });

  it('prefers superseded when a held Visitor lock rejects after a newer selection', async () => {
    const storage = memoryStorage();
    const ownerMarker = JSON.stringify({ mode: 'owner' });
    storage.setItem('den.profile.active.v1', ownerMarker);
    const entered = deferred<void>();
    const rejected = deferred<void>();
    const lock: VisitorActivityLock = {
      available: () => true,
      async run<T>(): Promise<T> {
        entered.resolve();
        await rejected.promise;
        throw new Error('the obsolete lock failed');
      },
    };
    const first = owner(storage, true, null, lock);
    const ownerSession = first.coordinator.session;

    const visitor = first.coordinator.switchToVisitor();
    await entered.promise;
    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'success' });
    rejected.reject(new Error('the obsolete lock failed'));

    await expect(visitor).resolves.toMatchObject({ outcome: 'superseded' });
    expect(first.coordinator.session).toBe(ownerSession);
    expect(storage.getItem('den.profile.active.v1')).toBe(ownerMarker);
    expect(visitorNamespaceIds(storage)).toEqual([]);
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

    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'success' });
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
      await expect(first.coordinator.switchToOwner('0000')).resolves.toMatchObject({
        outcome: 'denied',
      });
      expect(first.coordinator.session).toBeNull();
      await expect(first.coordinator.switchToOwner('1234')).resolves.toMatchObject({
        outcome: 'success',
      });
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

      await expect(first.coordinator.switchToOwner('0000')).resolves.toMatchObject({
        outcome: 'denied',
      });
      expect(storage.getItem(`den.profile.visitor.v1:${orphan}:activity`)).toBe('private visit');
      expect(first.coordinator.session).toBeNull();

      await expect(first.coordinator.switchToOwner('1234')).resolves.toMatchObject({
        outcome: 'success',
      });
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
    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'success' });
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

    await expect(first.coordinator.switchToOwner('1234')).resolves.toMatchObject({
      outcome: 'failed',
      cause: expect.objectContaining({ message: 'storage refused deletion' }),
    });
    expect(first.coordinator.session).toBeNull();
    expect(storage.getItem('den.profile.active.v1')).toBe('{broken');
    expect(storage.getItem(orphanKey)).toBe('private visit');

    refuseDeletion = false;
    await expect(first.coordinator.switchToOwner('1234')).resolves.toMatchObject({
      outcome: 'success',
    });
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

    await expect(first.coordinator.switchToOwner('0000')).resolves.toMatchObject({
      outcome: 'denied',
    });
    expect(first.coordinator.mode).toBe('visitor');
    expect(storage.getItem(`den.profile.visitor.v1:${endedId}:progress`)).toBe('1');

    await expect(first.coordinator.switchToOwner('1234')).resolves.toMatchObject({
      outcome: 'success',
    });
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

    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'success' });
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
    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'denied' });
    await expect(first.coordinator.switchToOwner('0000')).resolves.toMatchObject({
      outcome: 'denied',
    });
    expect(first.activityVerifyParentalPin).not.toHaveBeenCalled();
    expect(first.verifyParentalPin).toHaveBeenCalledWith('0000');

    const switching = first.coordinator.switchToOwner('1234');
    await vi.waitFor(() => expect(models.handles).toHaveLength(1));
    opening.resolve({});
    await expect(switching).resolves.toMatchObject({ outcome: 'success' });
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

    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'denied' });
    await expect(first.coordinator.switchToOwner('0000')).resolves.toMatchObject({
      outcome: 'denied',
    });
    const fromKid = first.coordinator.switchToOwner('1234');
    ownerOpening.resolve({});
    await expect(fromKid).resolves.toMatchObject({ outcome: 'success' });
    await expect(first.coordinator.switchToVisitor()).resolves.toMatchObject({
      outcome: 'success',
    });
    await expect(first.coordinator.switchToOwner()).resolves.toMatchObject({ outcome: 'denied' });
    await expect(first.coordinator.switchToOwner('0000')).resolves.toMatchObject({
      outcome: 'denied',
    });
    await expect(first.coordinator.switchToOwner('1234')).resolves.toMatchObject({
      outcome: 'success',
    });
    expect(profileHouseholdSettingsModel(first.coordinator.session!, first.coordinator.mode)).toBe(
      first.householdModel,
    );
    await expect(first.coordinator.switchToVisitor()).resolves.toMatchObject({
      outcome: 'success',
    });
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
    await expect(switching).resolves.toMatchObject({ outcome: 'success' });
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

  it('opens a remembered Kid once, however soon the page hands over the same directory again', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    const opening = deferred<unknown>();
    const models = profileModels(new Map([[kid.libraryKey, opening]]));
    const first = owner(
      storage,
      true,
      null,
      undefined,
      profileDirectoryChoices(view)!,
      models.factory,
    );
    // The page's directory effect runs as the coordinator appears, with its own copy of the same directory.
    first.coordinator.updateDirectory(profileDirectoryChoices(view)!);
    opening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.session?.identity.id).toBe(kid.id));
    expect(models.handles.map(({ key }) => key)).toEqual([kid.libraryKey]);
    expect(models.handles[0]!.close).not.toHaveBeenCalled();
  });

  it('compares maximum approval lists with bounded work and keeps an equal active profile', async () => {
    const storage = memoryStorage();
    const approvals = Array.from({ length: 10_000 }, (_, id) => ({
      type: id % 2 ? ('movie' as const) : ('tv' as const),
      id,
    }));
    const view = realDirectoryView();
    const profiles = view.profiles.map((profile) =>
      profile.role === 'owner' ? { ...profile, approvals } : profile,
    );
    const directory = profileDirectoryChoices({ ...view, profiles })!;
    const ownerProfile = directory.profiles.find((profile) => profile.role === 'owner')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: ownerProfile.id }),
    );
    const opening = deferred<unknown>();
    const models = profileModels(new Map([[ownerProfile.libraryKey!, opening]]));
    const first = owner(storage, true, null, undefined, directory, models.factory);
    opening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));
    const active = first.coordinator.session;

    let reads = 0;
    const replacement = [...approvals].reverse().map(({ type, id }) => ({
      get type() {
        if (++reads > 30_000) throw new Error('approval comparison exceeded its linear bound');
        return type;
      },
      get id() {
        if (++reads > 30_000) throw new Error('approval comparison exceeded its linear bound');
        return id;
      },
    }));
    first.coordinator.updateDirectory(
      profileDirectoryChoices({
        ...view,
        profiles: view.profiles.map((profile) =>
          profile.role === 'owner' ? { ...profile, approvals: replacement } : profile,
        ),
      })!,
    );

    expect(reads).toBe(20_000);
    expect(first.coordinator.session).toBe(active);
    expect(models.handles).toHaveLength(1);
    expect(models.handles[0]!.close).not.toHaveBeenCalled();
  });

  it('finishes a switch to Kid when the same directory is handed over while Kid opens', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: ownerProfile.id }),
    );
    const ownerOpening = deferred<unknown>();
    const kidOpening = deferred<unknown>();
    const models = profileModels(
      new Map([
        [ownerProfile.libraryKey, ownerOpening],
        [kid.libraryKey, kidOpening],
      ]),
    );
    const directory = profileDirectoryChoices(view)!;
    const first = owner(storage, true, null, undefined, directory, models.factory);
    ownerOpening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));

    const kidChoice = directory.profiles.find((choice) => choice.role === 'kid')!;
    const switching = first.coordinator.switchToPersistent(kidChoice.id!);
    await vi.waitFor(() => expect(models.handles).toHaveLength(2));
    // The household's own write (the Owner PIN just set) republishes its directory, unchanged, mid-switch.
    first.coordinator.updateDirectory(profileDirectoryChoices(view)!);
    kidOpening.resolve({});

    await expect(switching).resolves.toMatchObject({ outcome: 'success' });
    expect(first.coordinator.mode).toBe('kid');
    expect(models.handles[1]!.close).not.toHaveBeenCalled();
  });

  it('fails a switch whose library cannot open with that cause, not as a refused PIN', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: ownerProfile.id }),
    );
    const ownerOpening = deferred<unknown>();
    const kidOpening = deferred<unknown>();
    const models = profileModels(
      new Map([
        [ownerProfile.libraryKey, ownerOpening],
        [kid.libraryKey, kidOpening],
      ]),
    );
    const directory = profileDirectoryChoices(view)!;
    const first = owner(storage, true, null, undefined, directory, models.factory);
    ownerOpening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));

    const kidChoice = directory.profiles.find((choice) => choice.role === 'kid')!;
    const switching = first.coordinator.switchToPersistent(kidChoice.id!);
    await vi.waitFor(() => expect(models.handles).toHaveLength(2));
    const unavailable = new Error('library service startup timed out');
    kidOpening.reject(unavailable);

    await expect(switching).resolves.toMatchObject({
      outcome: 'failed',
      cause: {
        message: expect.stringContaining('library could not be opened'),
        cause: unavailable,
      },
    });
    expect(first.coordinator.mode).toBe('owner');
    expect(models.handles[1]!.close).toHaveBeenCalledOnce();
  });

  it('fails a profile that names no library without opening, publishing or superseding', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const valid = profileDirectoryChoices(view)!;
    const ownerProfile = valid.profiles.find((profile) => profile.role === 'owner')!;
    const kid = valid.profiles.find((profile) => profile.role === 'kid')!;
    const directory: PreviewProfileDirectory = {
      ...valid,
      profiles: valid.profiles.map((profile) =>
        profile === kid ? { ...profile, libraryKey: undefined } : profile,
      ),
    };
    const ownerMarker = JSON.stringify({
      version: 1,
      mode: 'persistent',
      profileId: ownerProfile.id,
    });
    storage.setItem('den.profile.active.v1', ownerMarker);
    const ownerOpening = deferred<unknown>();
    const models = profileModels(new Map([[ownerProfile.libraryKey!, ownerOpening]]));
    const first = owner(storage, true, null, undefined, directory, models.factory);
    ownerOpening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));
    const ownerSession = first.coordinator.session;

    await expect(first.coordinator.switchToPersistent(kid.id!)).resolves.toMatchObject({
      outcome: 'failed',
      cause: expect.objectContaining({ message: expect.stringContaining('no activity library') }),
    });
    expect(first.coordinator.session).toBe(ownerSession);
    expect(storage.getItem('den.profile.active.v1')).toBe(ownerMarker);
    expect(models.handles).toHaveLength(1);
  });

  it('reports a key-rotated or disposed opening as superseded without publishing it', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    const ownerMarker = JSON.stringify({
      version: 1,
      mode: 'persistent',
      profileId: ownerProfile.id,
    });
    storage.setItem('den.profile.active.v1', ownerMarker);
    const ownerOpening = deferred<unknown>();
    const firstKidOpening = deferred<unknown>();
    const secondKidOpening = deferred<unknown>();
    const models = profileModels(
      new Map([
        [ownerProfile.libraryKey, ownerOpening],
        [kid.libraryKey, firstKidOpening],
        ['rotated-kid-key', secondKidOpening],
      ]),
    );
    const directory = profileDirectoryChoices(view)!;
    const first = owner(storage, true, null, undefined, directory, models.factory);
    ownerOpening.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));
    const ownerSession = first.coordinator.session;

    const kidChoice = directory.profiles.find((choice) => choice.role === 'kid')!;
    const rotatedAway = first.coordinator.switchToPersistent(kidChoice.id!);
    await vi.waitFor(() => expect(models.handles).toHaveLength(2));
    first.coordinator.updateDirectory(
      profileDirectoryChoices(realDirectoryView(ownerProfile.libraryKey, 'rotated-kid-key'))!,
    );
    firstKidOpening.resolve({});

    await expect(rotatedAway).resolves.toMatchObject({ outcome: 'superseded' });
    expect(first.coordinator.session).toBe(ownerSession);
    expect(storage.getItem('den.profile.active.v1')).toBe(ownerMarker);
    expect(models.handles[1]!.close).toHaveBeenCalledOnce();

    const rotatedChoice = first.coordinator.choices.find((choice) => choice.role === 'kid')!;
    const disposed = first.coordinator.switchToPersistent(rotatedChoice.id!);
    await vi.waitFor(() => expect(models.handles).toHaveLength(3));
    first.coordinator.dispose();
    secondKidOpening.resolve({});

    await expect(disposed).resolves.toMatchObject({ outcome: 'superseded' });
    expect(storage.getItem('den.profile.active.v1')).toBe(ownerMarker);
    expect(models.handles[2]!.close).toHaveBeenCalledOnce();
  });

  it('reports a disposed Kid selection as superseded even when no Kid exists', async () => {
    const storage = memoryStorage();
    const preview = previewProfileDirectory();
    const directory = {
      ...preview,
      profiles: preview.profiles.filter((profile) => profile.role === 'owner'),
    };
    const first = owner(storage, true, null, undefined, directory);

    first.coordinator.dispose();

    await expect(
      first.coordinator.switchToPersistent(preview.profiles[1]!.id!),
    ).resolves.toMatchObject({
      outcome: 'superseded',
    });
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
    await expect(switching).resolves.toMatchObject({ outcome: 'success' });
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
    await expect(first.coordinator.switchToVisitor()).resolves.toMatchObject({
      outcome: 'success',
    });
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
    await switchToKid(first.coordinator);
    expect(allowsImplicitAssistant(first.coordinator, first.coordinator.session!)).toBe(false);
    await first.coordinator.switchToVisitor('1234');
    expect(allowsImplicitAssistant(first.coordinator, first.coordinator.session!)).toBe(false);
  });

  it('lets only the active Owner administer the household, for preview and real profiles alike', async () => {
    const storage = memoryStorage();
    const previewDirectory = previewProfileDirectory();
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: previewDirectory.owner }),
    );
    const preview = owner(storage, true, null, undefined, previewDirectory).coordinator;
    expect(preview.session!.administersHousehold).toBe(true);
    await switchToKid(preview);
    expect(preview.session!.administersHousehold).toBe(false);
    await preview.switchToVisitor('1234');
    expect(preview.session!.administersHousehold).toBe(false);
    preview.dispose();

    const realStorage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    realStorage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    const kidOpening = deferred<unknown>();
    const ownerOpening = deferred<unknown>();
    const ownerKey = view.profiles.find((profile) => profile.role === 'owner')!.libraryKey;
    const models = profileModels(
      new Map([
        [kid.libraryKey, kidOpening],
        [ownerKey, ownerOpening],
      ]),
    );
    const real = owner(realStorage, true, null, undefined, directory, models.factory);
    kidOpening.resolve({});
    await vi.waitFor(() => expect(real.coordinator.mode).toBe('kid'));
    expect(real.coordinator.session!.model).not.toBeNull();
    expect(real.coordinator.session!.administersHousehold).toBe(false);

    ownerOpening.resolve({});
    await expect(real.coordinator.switchToOwner('1234')).resolves.toMatchObject({
      outcome: 'success',
    });
    expect(real.coordinator.session!.administersHousehold).toBe(true);
  });

  it('runs every content query under the active profile’s own policy, across a switch', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    // The Owner carries a migrated ceiling (a legacy `pg13`), the Kid the default restricted policy.
    view.profiles[0]!.policy = { maximumAge: 13, unknownRatings: 'allow' };
    const directory = profileDirectoryChoices(view)!;
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    const kid = view.profiles.find((profile) => profile.role === 'kid')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: kid.id }),
    );
    const openings = new Map([
      [ownerProfile.libraryKey, deferred<unknown>()],
      [kid.libraryKey, deferred<unknown>()],
    ]);
    const models = profileModels(openings, 'fi');
    const first = owner(storage, true, null, undefined, directory, models.factory);
    openings.get(kid.libraryKey)!.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('kid'));
    const kidSession = first.coordinator.session!;
    const ask = (session: ProfileSession) =>
      session.content.query({ kind: 'catalog.page', catalog: { kind: 'upcoming' }, page: 1 });
    await ask(kidSession);
    expect(first.householdContent.query).toHaveBeenLastCalledWith(expect.anything(), undefined, {
      maximumAge: 12,
      unknownRatings: 'block',
      kidAudience: 'child-or-teen',
      region: 'FI',
    });
    expect(kidSession.restricted).toBe(true);
    expect(kidSession.policyKey).toBe('12_block_-_child-or-teen');

    // Owner is restricted by its own ceiling, but is not a Kid catalogue.
    openings.get(ownerProfile.libraryKey)!.resolve({});
    await expect(first.coordinator.switchToOwner('1234')).resolves.toMatchObject({
      outcome: 'success',
    });
    const ownerSession = first.coordinator.session!;
    expect(ownerSession).not.toBe(kidSession);
    expect(ownerSession.content).not.toBe(kidSession.content);
    await ask(ownerSession);
    expect(first.householdContent.query).toHaveBeenLastCalledWith(expect.anything(), undefined, {
      maximumAge: 13,
      unknownRatings: 'allow',
      region: 'FI',
    });
    expect(ownerSession.policyKey).toBe('13_allow_-_-');
    // An Owner ceiling that admits unknown ratings keeps assistants and TMDB surfaces; only fail-closed loses them.
    expect(ownerSession.restricted).toBe(true);
    expect(ownerSession.failsClosed).toBe(false);
    expect(kidSession.failsClosed).toBe(true);
    expect(allowsImplicitAssistant(first.coordinator, ownerSession)).toBe(true);

    // Visitor inherits Owner's policy; it is never looser than the profile the household set.
    await expect(first.coordinator.switchToVisitor()).resolves.toMatchObject({
      outcome: 'success',
    });
    const visitor = first.coordinator.session!;
    await ask(visitor);
    expect(first.householdContent.query).toHaveBeenLastCalledWith(expect.anything(), undefined, {
      maximumAge: 13,
      unknownRatings: 'allow',
      region: 'FI',
    });
    expect(visitor.policyKey).toBe('13_allow_-_-');
  });

  it('leaves an Owner with no ceiling on the household port, as before', async () => {
    const storage = memoryStorage();
    const view = realDirectoryView();
    const directory = profileDirectoryChoices(view)!;
    const ownerProfile = view.profiles.find((profile) => profile.role === 'owner')!;
    storage.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: ownerProfile.id }),
    );
    const openings = new Map([[ownerProfile.libraryKey, deferred<unknown>()]]);
    const first = owner(storage, true, null, undefined, directory, profileModels(openings).factory);
    openings.get(ownerProfile.libraryKey)!.resolve({});
    await vi.waitFor(() => expect(first.coordinator.mode).toBe('owner'));
    const session = first.coordinator.session!;
    expect(session.restricted).toBe(false);
    expect(session.content).toBe(session.household.content);
    expect(session.policyKey).toBeUndefined();
    expect(allowsImplicitAssistant(first.coordinator, session)).toBe(true);
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
    await expect(switchToKid(first.coordinator)).resolves.toMatchObject({ outcome: 'success' });
    expect(first.coordinator.mode).toBe('kid');
    expect(first.coordinator.activeChoice?.name).toBe('Kids');
    expect(storage.getItem('den.profile.active.v1')).toBe(
      JSON.stringify({
        version: 1,
        mode: 'persistent',
        profileId: '00000000000000000000000000000002',
      }),
    );

    await expect(first.coordinator.switchToVisitor('0000')).resolves.toMatchObject({
      outcome: 'denied',
    });
    expect(first.coordinator.mode).toBe('kid');
    await expect(first.coordinator.switchToVisitor('1234')).resolves.toMatchObject({
      outcome: 'success',
    });
    expect(first.coordinator.mode).toBe('visitor');
    expect(JSON.parse(storage.getItem('den.profile.active.v1')!)).toMatchObject({
      version: 1,
      mode: 'visitor',
    });

    first.coordinator.dispose();
    const restoredVisitor = owner(storage, true, null, undefined, directory);
    expect(restoredVisitor.coordinator.mode).toBe('visitor');
    await expect(switchToKid(restoredVisitor.coordinator)).resolves.toMatchObject({
      outcome: 'success',
    });
    expect(restoredVisitor.coordinator.mode).toBe('kid');
    restoredVisitor.coordinator.dispose();

    const restoredKid = owner(storage, true, null, undefined, directory);
    expect(restoredKid.coordinator.mode).toBe('kid');
    await expect(restoredKid.coordinator.switchToOwner('0000')).resolves.toMatchObject({
      outcome: 'denied',
    });
    expect(restoredKid.coordinator.mode).toBe('kid');
    await expect(restoredKid.coordinator.switchToOwner('1234')).resolves.toMatchObject({
      outcome: 'success',
    });
    expect(restoredKid.coordinator.mode).toBe('owner');
  });
});

describe('householdAdministration', () => {
  it('leaves a household without profiles exactly as it was', () => {
    for (const capability of ['checking', 'disabled', 'indeterminate'] as const)
      expect(householdAdministration(capability, false, false)).toBe(true);
    expect(profileMarkerPresent(memoryStorage())).toBe(false);
  });

  it('opens for an active Owner only once profiles are enabled', () => {
    expect(householdAdministration('enabled', true, true)).toBe(true);
    expect(householdAdministration('preview', true, true)).toBe(true);
    expect(householdAdministration('enabled', false, true)).toBe(false);
    expect(householdAdministration('preview', false, false)).toBe(false);
  });

  it('stays closed while a profile-aware browser has no discovery answer', () => {
    const storage = memoryStorage();
    storage.setItem('den.profile.active.v1', '{broken');
    expect(profileMarkerPresent(storage)).toBe(true);
    expect(householdAdministration('checking', false, true)).toBe(false);
    expect(householdAdministration('indeterminate', false, true)).toBe(false);
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

describe('choosing Kid before the Owner PIN’s state is known (den#295)', () => {
  it('waits, then sets the PIN first once none is known to exist', () => {
    const { coordinator, householdModel } = owner(memoryStorage(), false);
    expect(coordinator.establishUnprotectedOwner()).toBe(true);
    expect(coordinator.mode).toBe('owner');
    // A page that opens as the Owner it last was, while its connections view is still on its way.
    const lease = vi.mocked(householdModel.connections).mock.results[0]!.value as {
      snapshot: { value: { parentalPinConfigured?: boolean } };
    };
    lease.snapshot.value.parentalPinConfigured = undefined;
    expect(coordinator.parentalPinConfigured).toBeUndefined();
    // Not known yet: choosing Kid would switch without the PIN that brings the Owner back.
    expect(coordinator.setsPin('kid')).toBe(false);
    expect(coordinator.waitsForPin('kid')).toBe(true);
    expect(coordinator.waitsForPin('visitor')).toBe(false);

    lease.snapshot.value.parentalPinConfigured = false;
    expect(coordinator.waitsForPin('kid')).toBe(false);
    expect(coordinator.setsPin('kid')).toBe(true);
    coordinator.dispose();
  });
});

describe('a browser whose household is not made yet (den#295)', () => {
  it('offers the Kid it will have, and choosing it hands the new Owner PIN to the household it makes', async () => {
    const storage = memoryStorage();
    const startsKid = vi.fn(async () => true);
    const { coordinator } = owner(
      storage,
      false,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      startsKid,
    );
    expect(coordinator.establishUnprotectedOwner()).toBe(true);
    expect(coordinator.choices.map((choice) => choice.name)).toEqual(['Owner', 'Kids', 'Visitor']);
    expect(coordinator.setsPin('kid')).toBe(true);
    const kid = coordinator.choices.find((choice) => choice.role === 'kid')!;
    // No PIN chosen: nothing is made.
    await expect(coordinator.switchToPersistent(kid.id!)).resolves.toMatchObject({
      outcome: 'denied',
    });
    expect(startsKid).not.toHaveBeenCalled();
    await expect(coordinator.setOwnerPin('4321')).resolves.toBe(true);
    await expect(coordinator.switchToPersistent(kid.id!)).resolves.toMatchObject({
      outcome: 'success',
    });
    expect(startsKid).toHaveBeenCalledWith('4321');
    coordinator.dispose();
  });
});
