import { describe, expect, it } from 'vitest';
import { PreviewProfilePreferences, SyncedProfilePreferences } from './profilePreferences.svelte';
import { profileId, visitorVisitId } from './profileIdentity';
import type { ProfileSession } from './profileSession.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import {
  VisitorActivityNamespace,
  type VisitorProfileSession,
} from './visitorProfileSession.svelte';
import type { LibraryPreferences } from './libraryServiceProtocol';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const ownerPreferences: LibraryPreferences = {
  excludedGenres: [27],
  excludedLanguages: ['sv'],
  hideAnime: true,
  hideWatched: true,
  minReleaseYear: 1999,
  audioLanguage: 'sv',
  subtitleLanguage: 'fi',
  hasExplicitSubtitlePreference: true,
  shownSubtitleLanguages: ['sv'],
  subtitlesPerLanguage: 1,
  autoSkipSegments: true,
  autoplayTrailers: false,
  ratingSources: [],
  shownWarnings: ['violence'],
  watchRegion: 'FI',
  services: [{ id: 8, country: 'FI' }],
  servicesConfigured: true,
  maturityCeiling: 'r',
};

const policy = {
  settings: {
    connection: 'ready' as const,
    value: {
      kind: 'settings' as const,
      preferences: ownerPreferences,
      assistant: { read: false, write: false },
    },
  },
};

const kid = (): ProfileSession =>
  ({
    identity: { kind: 'profile', id: profileId('00000000000000000000000000000002') },
    policy,
  }) as unknown as ProfileSession;

describe('preview profile preferences', () => {
  it('starts personal settings neutral and inherits only household region and services', () => {
    const session = kid();
    const store = new PreviewProfilePreferences(
      session.identity,
      session.policy!,
      new MemoryStorage(),
      null,
    );
    expect(store.value).toMatchObject({
      excludedGenres: [],
      excludedLanguages: [],
      hideAnime: false,
      audioLanguage: undefined,
      watchRegion: 'FI',
      services: [{ id: 8, country: 'FI' }],
      servicesConfigured: true,
      maturityCeiling: undefined,
    });
  });

  it('persists Kid edits only in its preview profile namespace across reload', async () => {
    const storage = new MemoryStorage();
    const session = kid();
    const first = new PreviewProfilePreferences(session.identity, session.policy!, storage, null);
    await first.patch({ audioLanguage: 'da', excludedGenres: [35] });

    const second = new PreviewProfilePreferences(session.identity, session.policy!, storage, null);
    expect(second.value?.audioLanguage).toBe('da');
    expect(second.value?.excludedGenres).toEqual([35]);
    expect(storage.values.size).toBe(1);
    expect([...storage.values.keys()][0]).toContain('00000000000000000000000000000002');
  });

  it('keeps Visitor preferences for the visit and purges them when the visit ends', async () => {
    const storage = new MemoryStorage();
    const activity = new VisitorActivityNamespace(
      visitorVisitId('10000000000000000000000000000001'),
      storage,
    );
    const session = {
      identity: { kind: 'visitor', id: '10000000000000000000000000000001' },
      policy,
      activity,
    } as unknown as VisitorProfileSession;
    const first = new PreviewProfilePreferences(
      session.identity,
      session.policy!,
      storage,
      null,
      activity,
    );
    const anotherTab = new PreviewProfilePreferences(
      session.identity,
      session.policy!,
      storage,
      null,
      activity,
    );
    await Promise.all([
      first.patch({ subtitlePreference: { mode: 'language', language: 'es' } }),
      anotherTab.patch({ autoplayTrailers: false }),
    ]);

    const reloaded = new PreviewProfilePreferences(
      session.identity,
      session.policy!,
      storage,
      null,
      activity,
    );
    expect(reloaded.value?.subtitleLanguage).toBe('es');
    expect(reloaded.value?.autoplayTrailers).toBe(false);
    expect(storage.values.size).toBe(1);

    await activity.dispose();
    expect(storage.values.size).toBe(0);
  });

  it('keeps its own region and services once chosen, leaving the household values unchanged', async () => {
    const storage = new MemoryStorage();
    const session = kid();
    const store = new PreviewProfilePreferences(session.identity, session.policy!, storage, null);
    await store.patch({
      watchRegion: 'SE',
      services: { kind: 'values', values: [{ id: 9, country: 'SE' }] },
    });
    expect(store.value).toMatchObject({
      watchRegion: 'SE',
      services: [{ id: 9, country: 'SE' }],
      servicesConfigured: true,
    });
    const reloaded = new PreviewProfilePreferences(
      session.identity,
      session.policy!,
      storage,
      null,
    );
    expect(reloaded.value).toMatchObject({
      watchRegion: 'SE',
      services: [{ id: 9, country: 'SE' }],
    });
    expect(ownerPreferences.watchRegion).toBe('FI');
    expect(ownerPreferences.services).toEqual([{ id: 8, country: 'FI' }]);
  });

  it('has no policy writer', async () => {
    const session = kid();
    const store = new PreviewProfilePreferences(
      session.identity,
      session.policy!,
      new MemoryStorage(),
      null,
    );
    await expect(store.patch({ maturityCeiling: 'pg13' })).rejects.toThrow('cannot write');
    expect(ownerPreferences.maturityCeiling).toBe('r');
  });
});

describe('synced profile preferences', () => {
  it('reads every value, region and services included, from the profile and none from the household', () => {
    const personal: LibraryPreferences = {
      ...ownerPreferences,
      excludedGenres: [35],
      audioLanguage: 'da',
      watchRegion: 'US',
      services: [],
      servicesConfigured: false,
      maturityCeiling: 'pg13',
    };
    const model = {
      settings: {
        connection: 'ready',
        value: { kind: 'settings', preferences: personal, assistant: { read: true, write: true } },
      },
      patchPreferences: async () => ({}),
    } as unknown as LibraryModel;
    const preferences = new SyncedProfilePreferences(kid().identity, model);

    expect(preferences.value).toMatchObject({
      excludedGenres: [35],
      audioLanguage: 'da',
      watchRegion: 'US',
      services: [],
      servicesConfigured: false,
      maturityCeiling: undefined,
    });
    expect(preferences.policy.settings.value).toMatchObject({
      assistant: { read: false, write: false },
      preferences: { excludedGenres: [35], watchRegion: 'US', maturityCeiling: undefined },
    });
  });

  it('writes personal changes only to the active profile model', async () => {
    const patches: unknown[] = [];
    const model = {
      settings: {
        connection: 'ready',
        value: {
          kind: 'settings',
          preferences: ownerPreferences,
          assistant: { read: false, write: false },
        },
      },
      patchPreferences: async (patch: unknown) => {
        patches.push(patch);
        return {};
      },
    } as unknown as LibraryModel;
    const preferences = new SyncedProfilePreferences(kid().identity, model);

    await preferences.patch({ audioLanguage: 'da', excludedGenres: [35] });
    await preferences.patch({ watchRegion: 'SE', services: { kind: 'values', values: [] } });
    await expect(preferences.patch({ maturityCeiling: 'r' })).rejects.toThrow(
      'A profile cannot write its content policy through preferences',
    );
    expect(patches).toEqual([
      { audioLanguage: 'da', excludedGenres: [35] },
      { watchRegion: 'SE', services: { kind: 'values', values: [] } },
    ]);
  });
});
