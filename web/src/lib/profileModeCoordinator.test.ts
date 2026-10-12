import { describe, expect, it, vi } from 'vitest';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel, LibraryModelLease } from './libraryModel.svelte';
import type { ConnectionsView } from './libraryServiceProtocol';
import { legacyProfileIdentity } from './profileIdentity';
import { ProfileModeCoordinator, profilesCapability } from './profileModeCoordinator.svelte';
import { ProfileSession } from './profileSession.svelte';

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

function owner(storage: Storage, pinConfigured = true) {
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
    coordinator: new ProfileModeCoordinator(session, storage),
    model,
    close,
    closeWorker,
    release,
    verifyParentalPin,
  };
}

describe('ProfileModeCoordinator', () => {
  it('persists one Visitor across teardown and reconstructs its local namespace', () => {
    const storage = memoryStorage();
    const first = owner(storage);

    first.coordinator.switchToVisitor();
    const visitId = first.coordinator.session.identity.id;
    expect(visitId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.coordinator.mode).toBe('visitor');
    expect(first.coordinator.session.model).toBeNull();
    expect(first.coordinator.session.policyModel).toBe(first.model);
    expect(storage.getItem('den.profile.active.v1')).toBe(
      JSON.stringify({ mode: 'visitor', visitId }),
    );
    const activity = first.coordinator.session as typeof first.coordinator.session & {
      activity: { set: (key: string, value: string) => void };
    };
    activity.activity.set('progress:movie:550', 'half');
    first.coordinator.dispose();

    const restored = owner(storage);
    expect(restored.coordinator.mode).toBe('visitor');
    expect(restored.coordinator.session.identity.id).toBe(visitId);
    const restoredActivity = restored.coordinator.session as typeof restored.coordinator.session & {
      activity: { get: (key: string) => unknown };
    };
    expect(restoredActivity.activity.get('progress:movie:550')).toBe('half');
  });

  it('persists the default Owner only after the capability constructs the coordinator', () => {
    const storage = memoryStorage();
    const first = owner(storage);

    expect(first.coordinator.mode).toBe('owner');
    expect(storage.getItem('den.profile.active.v1')).toBe(JSON.stringify({ mode: 'owner' }));
  });

  it('denies a wrong configured PIN and ends only the active visit after the right PIN', async () => {
    const storage = memoryStorage();
    storage.setItem('den.owner.untouched', 'owner');
    const first = owner(storage);
    first.coordinator.switchToVisitor();
    const endedId = first.coordinator.session.identity.id;
    const activity = first.coordinator.session as typeof first.coordinator.session & {
      activity: { set: (key: string, value: number) => void };
    };
    activity.activity.set('progress', 1);
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
    const first = owner(storage, false);
    first.coordinator.switchToVisitor();

    await expect(first.coordinator.switchToOwner()).resolves.toBe(true);
    expect(first.verifyParentalPin).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    first.coordinator.dispose();
    first.coordinator.dispose();
    expect(first.release).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.closeWorker).toHaveBeenCalledOnce();
  });
});

describe('profilesCapability', () => {
  it('enables only the explicit uncached capability answer', async () => {
    const enabled = vi.fn(async () => new Response(JSON.stringify({ enabled: true })));
    await expect(profilesCapability(enabled as typeof fetch)).resolves.toBe(true);
    expect(enabled).toHaveBeenCalledWith('/capabilities/profiles', {
      cache: 'no-store',
      credentials: 'same-origin',
    });

    await expect(
      profilesCapability(vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch),
    ).resolves.toBe(false);
    await expect(
      profilesCapability(vi.fn(async () => new Response('{broken')) as typeof fetch),
    ).resolves.toBe(false);
  });
});
