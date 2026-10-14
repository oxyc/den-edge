import { describe, expect, it } from 'vitest';
import { profileId } from './profileIdentity';
import { readProfileHint, saveProfileHint } from './profileHint';

const owner = 'a'.repeat(32);
const storage = (marker: unknown, hint?: unknown) => {
  const values = new Map<string, string>();
  if (marker !== undefined) values.set('den.profile.active.v1', JSON.stringify(marker));
  if (hint !== undefined) values.set('den.profile.hint.v1', JSON.stringify(hint));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } as Storage;
};
const marker = { version: 1, mode: 'persistent', profileId: owner };
const hint = { version: 1, profileId: owner, name: 'Owner', avatar: 'owner', libraryKey: 'key' };
const choice = { id: profileId(owner), role: 'owner', name: 'Owner', avatar: 'owner' } as const;

describe('profile hint', () => {
  it('is read back only while the active marker names the same profile', () => {
    expect(readProfileHint(storage(marker, hint))).toEqual(hint);
    expect(readProfileHint(storage({ ...marker, profileId: 'b'.repeat(32) }, hint))).toBeNull();
    expect(readProfileHint(storage({ mode: 'owner' }, hint))).toBeNull();
    expect(readProfileHint(storage(undefined, hint))).toBeNull();
  });

  it('treats a missing, versioned-wrong or corrupt hint as absent', () => {
    expect(readProfileHint(storage(marker))).toBeNull();
    expect(readProfileHint(storage(marker, { ...hint, version: 2 }))).toBeNull();
    expect(readProfileHint(storage(marker, { ...hint, name: 'x'.repeat(65) }))).toBeNull();
    const broken = storage(marker);
    broken.setItem('den.profile.hint.v1', '{broken');
    expect(readProfileHint(broken)).toBeNull();
  });

  it('reads a hint with no usable library key without one', () => {
    const { libraryKey: _, ...keyless } = hint;
    expect(readProfileHint(storage(marker, keyless))).toEqual(keyless);
    expect(readProfileHint(storage(marker, { ...hint, libraryKey: '' }))).toEqual(keyless);
    expect(readProfileHint(storage(marker, { ...hint, libraryKey: 'k'.repeat(257) }))).toEqual(
      keyless,
    );
  });

  it('remembers an Owner, with its library key when known, and forgets anything else', () => {
    const store = storage(marker);
    saveProfileHint(choice, 'key', store);
    expect(readProfileHint(store)).toEqual(hint);
    saveProfileHint(choice, null, store);
    expect(readProfileHint(store)).toEqual({
      version: 1,
      profileId: owner,
      name: 'Owner',
      avatar: 'owner',
    });
    saveProfileHint({ ...choice, role: 'kid' }, 'key', store);
    expect(readProfileHint(store)).toBeNull();
  });
});
