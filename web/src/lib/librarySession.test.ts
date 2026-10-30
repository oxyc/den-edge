import { afterEach, describe, expect, it, vi } from 'vitest';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import { persistentProfileIdentity } from './profileIdentity';
import { activeProfileSession, legacyProfileSession } from './profileSession.svelte';

const KID_ID = '0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ProfileSession presentation state', () => {
  const content = () => ({ query: vi.fn(), onStatus: vi.fn(() => () => {}) });

  it('indexes title metadata, absences and shapes without owning library rows', () => {
    const session = legacyProfileSession(null, false, null, content());
    const title = { type: 'tv' as const, id: 1, title: 'One' };
    const gone = { type: 'movie' as const, id: 2 };
    session.publishLibraryMetadata(
      [title, { ...title, title: 'Later' }],
      [['tv:1', { counts: new Map([[1, 8]]), lastAired: { season: 1, episode: 4 } }]],
      [gone, title],
    );

    expect([...session.displayTitles().values()]).toEqual([title]);
    expect(session.displayTitle(title)).toBe(title);
    expect(session.displayMissing(gone)).toBe(true);
    expect(session.displayMissing(title)).toBe(false);
    expect(session.shapes.get('tv:1')?.counts.get(1)).toBe(8);
  });

  it('forwards each foreground and close transition once', () => {
    const foregroundReady = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const closeWorkerServices = vi.fn();
    const contentPort = {
      query: vi.fn(),
      onStatus: vi.fn(() => () => {}),
    };
    const model = { foregroundReady, close } as unknown as LibraryModel;
    const session = legacyProfileSession(
      'same-library-key',
      false,
      model,
      contentPort,
      closeWorkerServices,
    );

    session.foregroundReady();
    session.foregroundReady();
    session.close();
    session.close();

    expect(foregroundReady).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(session.identity).toMatchObject({
      kind: 'owner',
      libraryKey: 'same-library-key',
      retainedScope: 'same-library-key',
    });
    expect(session.household.ownsModel(model)).toBe(true);
    expect('model' in session.household).toBe(false);
    expect(session.household.identity).toEqual({
      kind: 'legacy',
      libraryKey: 'same-library-key',
      configurationOnly: false,
    });
    expect(session.content).toBe(contentPort);
    expect(closeWorkerServices).toHaveBeenCalledOnce();
  });

  it('keeps a profile-scoped language hint until a real synced value revalidates it', () => {
    const values = new Map<string, string>([
      [
        'den.profile.active.v1',
        JSON.stringify({ version: 1, mode: 'persistent', profileId: KID_ID }),
      ],
      [`den.interfaceLanguage.presentation.v2.profile-${KID_ID}`, 'es'],
      [`den.interfaceLanguage.presentation.v2.profile-${KID_ID}.written-at`, String(Date.now())],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const householdModel = {
      settings: {
        connection: 'ready',
        value: {
          kind: 'settings',
          preferences: { interfaceLanguage: 'en', services: [] },
        },
      },
    } as unknown as LibraryModel;
    const profileSettings: { value: unknown } = {
      value: { kind: 'settings', preferences: { services: [] } },
    };
    const profileModel = {
      get settings() {
        return profileSettings;
      },
    } as unknown as LibraryModel;
    const household = new HouseholdSession(
      { kind: 'profiles', libraryKey: 'household-key', configurationOnly: true },
      householdModel,
      content(),
    );
    const session = activeProfileSession(
      persistentProfileIdentity(KID_ID, 'profile-key'),
      household,
      profileModel,
    );

    expect(session.interfaceLanguage).toBe('es');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    profileSettings.value = {
      kind: 'settings',
      preferences: { interfaceLanguage: 'en', services: [] },
    };
    expect(session.interfaceLanguage).toBe('en');
  });

  it('promotes only the same open household into a configuration-only profiles control plane', () => {
    const household = new HouseholdSession(
      { kind: 'legacy', libraryKey: 'household-key', configurationOnly: false },
      null,
      content(),
    );

    expect(() => household.commitProfiles('different-key')).toThrow(
      'Household topology cannot be promoted from this model',
    );
    expect(household.identity).toEqual({
      kind: 'legacy',
      libraryKey: 'household-key',
      configurationOnly: false,
    });

    household.commitProfiles('household-key');
    expect(household.identity).toEqual({
      kind: 'profiles',
      libraryKey: 'household-key',
      configurationOnly: true,
    });
    expect(() => household.commitProfiles('household-key')).toThrow(
      'Household topology cannot be promoted from this model',
    );
  });

  it('owns only transient toast and undo timing', () => {
    vi.useFakeTimers();
    const session = legacyProfileSession(null, false, null, content());
    const run = vi.fn();
    session.notify('Removed', { holdMs: 10, undo: { label: 'Undo', run } });
    expect(session.toast).toBe('Removed');
    expect(session.undo?.run).toBe(run);
    vi.advanceTimersByTime(10);
    expect(session.toast).toBeNull();
    expect(session.undo).toBeNull();
  });

  it('distinguishes a wire-fenced library from generic open failures', () => {
    const updateRequired = legacyProfileSession(
      'newer-library',
      false,
      {
        status: {
          kind: 'failed',
          error: {
            code: 'update-required',
            message: 'A newer version of Den is required to open this library.',
            retryable: false,
          },
        },
      } as unknown as LibraryModel,
      content(),
    );
    expect(updateRequired.updateRequired).toBe(true);
    expect(updateRequired.alert).toBe('Library update required');

    const unavailable = legacyProfileSession(
      'offline-library',
      false,
      {
        status: {
          kind: 'failed',
          error: { code: 'unavailable', message: 'offline', retryable: true },
        },
      } as unknown as LibraryModel,
      content(),
    );
    expect(unavailable.updateRequired).toBe(false);
    expect(unavailable.alert).toBeNull();

    const retryableImposter = legacyProfileSession(
      'retryable-library',
      false,
      {
        status: {
          kind: 'failed',
          error: { code: 'update-required', message: 'temporary', retryable: true },
        },
      } as unknown as LibraryModel,
      content(),
    );
    expect(retryableImposter.updateRequired).toBe(false);

    const supportedProfileHousehold = legacyProfileSession(
      'profile-household',
      false,
      {
        status: {
          kind: 'failed',
          error: {
            code: 'update-required',
            message: 'wire 5 required',
            retryable: false,
            requiredWire: 5,
          },
        },
      } as unknown as LibraryModel,
      content(),
    );
    expect(supportedProfileHousehold.updateRequired).toBe(false);
    expect(supportedProfileHousehold.alert).toBeNull();
  });

  it('keeps a household wire fence visible through a distinct active profile model', () => {
    const householdModel = {
      status: {
        kind: 'failed',
        error: { code: 'update-required', message: 'new wire', retryable: false },
      },
    } as unknown as LibraryModel;
    const profileModel = {
      status: { kind: 'ready' },
    } as unknown as LibraryModel;
    const household = new HouseholdSession(
      { kind: 'profiles', libraryKey: 'household', configurationOnly: true },
      householdModel,
      content(),
    );
    const profile = activeProfileSession(
      persistentProfileIdentity(KID_ID, 'kid-key'),
      household,
      profileModel,
    );

    expect(household.updateRequired).toBe(true);
    expect(profile.updateRequired).toBe(true);
    expect(profile.alert).toBe('Library update required');
  });

  it('replaces a future active profile without closing the configuration-only household', () => {
    const householdClose = vi.fn();
    const profileClose = vi.fn();
    const householdForeground = vi.fn().mockResolvedValue(undefined);
    const profileForeground = vi.fn().mockResolvedValue(undefined);
    const householdModel = {
      foregroundReady: householdForeground,
      close: householdClose,
    } as unknown as LibraryModel;
    const profileModel = {
      foregroundReady: profileForeground,
      close: profileClose,
    } as unknown as LibraryModel;
    const household = new HouseholdSession(
      { kind: 'profiles', libraryKey: 'household-key', configurationOnly: true },
      householdModel,
      content(),
    );
    const session = activeProfileSession(
      persistentProfileIdentity(KID_ID, 'kid-library-key'),
      household,
      profileModel,
    );

    session.foregroundReady();
    session.close();

    expect(householdForeground).toHaveBeenCalledOnce();
    expect(profileForeground).toHaveBeenCalledOnce();
    expect(profileClose).toHaveBeenCalledOnce();
    expect(householdClose).not.toHaveBeenCalled();

    household.close();
    expect(householdClose).toHaveBeenCalledOnce();
  });
});
