import { describe, expect, it } from 'vitest';
import {
  legacyProfileIdentity,
  persistentProfileIdentity,
  visitorProfileIdentity,
  type ProfileIdentity,
} from './profileIdentity';
import type { ProfilePreferences } from './profilePreferences.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import { profileHouseholdSettingsModel, profileSettingsRoute } from './profileSettingsRoute';

const preferences = {} as ProfilePreferences;
const session = (identity: ProfileIdentity, value: ProfilePreferences | null) => ({
  identity,
  preferences: value,
});

describe('profile settings routing', () => {
  it('never falls through to household settings for Visitor, even without preferences', () => {
    const visitor = visitorProfileIdentity('10000000000000000000000000000001');
    expect(profileSettingsRoute(session(visitor, preferences), 'visitor')).toBe('personal');
    expect(profileSettingsRoute(session(visitor, null), 'visitor')).toBe('unavailable');
  });

  it('routes persistent Owner to household controls while Kid remains personal', () => {
    const identity = persistentProfileIdentity('00000000000000000000000000000002', 'profile-key');
    expect(profileSettingsRoute(session(identity, preferences), 'kid')).toBe('personal');
    expect(profileSettingsRoute(session(identity, preferences), 'owner')).toBe('household');
    expect(profileSettingsRoute(session(identity, null), 'kid')).toBe('unavailable');
  });

  it('routes only legacy/personal Owner sessions to household settings', () => {
    expect(
      profileSettingsRoute(session(legacyProfileIdentity('household-key', false), null), 'owner'),
    ).toBe('household');
  });

  it('selects the retained control model for Owner and never for Kid or Visitor', () => {
    const control = {} as LibraryModel;
    const household = { ownerSettingsModel: () => control };
    const owner = {
      ...session(persistentProfileIdentity('00000000000000000000000000000002', 'owner-key'), null),
      household,
    };
    const kid = {
      ...session(
        persistentProfileIdentity('00000000000000000000000000000003', 'kid-key'),
        preferences,
      ),
      household,
    };
    const visitor = {
      ...session(visitorProfileIdentity('10000000000000000000000000000001'), preferences),
      household,
    };

    expect(profileHouseholdSettingsModel(owner, 'owner')).toBe(control);
    expect(profileHouseholdSettingsModel(kid, 'kid')).toBeNull();
    expect(profileHouseholdSettingsModel(visitor, 'visitor')).toBeNull();
  });
});
