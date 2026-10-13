import { describe, expect, it } from 'vitest';
import {
  legacyProfileIdentity,
  persistentProfileIdentity,
  visitorProfileIdentity,
  type ProfileIdentity,
} from './profileIdentity';
import type { ProfilePreferences } from './profilePreferences.svelte';
import { profileSettingsRoute } from './profileSettingsRoute';

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

  it('allows personal Kid settings but keeps a persistent Owner out of the personal-only screen', () => {
    const identity = persistentProfileIdentity('00000000000000000000000000000002', 'profile-key');
    expect(profileSettingsRoute(session(identity, preferences), 'kid')).toBe('personal');
    expect(profileSettingsRoute(session(identity, preferences), 'owner')).toBe('unavailable');
    expect(profileSettingsRoute(session(identity, null), 'kid')).toBe('unavailable');
  });

  it('routes only legacy/personal Owner sessions to household settings', () => {
    expect(
      profileSettingsRoute(session(legacyProfileIdentity('household-key', false), null), 'owner'),
    ).toBe('household');
  });
});
