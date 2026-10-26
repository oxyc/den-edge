import { describe, expect, it } from 'vitest';
import { openingWorkers } from './libraryWorkerStart';
import { openingLibraryIdentity } from './openingLibraryIdentity';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

function storage(values: Record<string, string>): Storage {
  return {
    getItem: (key: string) => values[key] ?? null,
  } as Storage;
}

describe('openingWorkers', () => {
  it('starts none for a browser that shows only the pairing screen', () => {
    expect(openingWorkers(storage({}))).toBe(0);
    expect(openingWorkers(storage({ 'den.links': '[]' }))).toBe(0);
  });

  it('starts one for a browser holding a library, linked or its own', () => {
    expect(openingWorkers(storage({ 'den.links': JSON.stringify([{ inboxKey: 'a' }]) }))).toBe(1);
    expect(openingWorkers(storage({ 'den.browsing': '1' }))).toBe(1);
  });

  it('starts a second for a remembered Owner whose library opens beside the household', () => {
    const hint = JSON.stringify({ version: 1, profileId: 'p', libraryKey: 'k' });
    expect(openingWorkers(storage({ 'den.browsing': '1', 'den.profile.hint.v1': hint }))).toBe(2);
    expect(
      openingWorkers(storage({ 'den.browsing': '1', 'den.profile.hint.v1': '{"version":1}' })),
    ).toBe(1);
  });

  it('starts none where storage is refused', () => {
    const refused = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(openingWorkers(refused)).toBe(0);
  });
});

describe('openingLibraryIdentity', () => {
  it('identifies the first linked online library', () => {
    const link = { inboxKey: '0123456789abcdef', linkKey: 'link', libraryKey: KEY };
    expect(openingLibraryIdentity(storage({ 'den.links': JSON.stringify([link]) }))).toEqual({
      libraryKey: KEY,
      mode: 'online',
      wire: 4,
    });
  });

  it('identifies an existing browser-local library', () => {
    expect(openingLibraryIdentity(storage({ 'den.localLibrary': KEY }))).toEqual({
      libraryKey: KEY,
      mode: 'local',
      wire: 4,
    });
  });

  it('follows a settled household plan instead of its staging library', () => {
    const plan = {
      version: 1,
      householdKey: OTHER_KEY,
      stagingKey: KEY,
      ownerKey: KEY,
      attempt: 'a'.repeat(32),
      ownerProfile: 'b'.repeat(32),
      createdAt: 1,
      started: true,
      verified: { household: 1, owner: 1 },
    };
    expect(
      openingLibraryIdentity(
        storage({
          'den.localLibrary': KEY,
          'den.household': OTHER_KEY,
          'den.household.plan': JSON.stringify(plan),
        }),
      ),
    ).toMatchObject({ libraryKey: OTHER_KEY, mode: 'online' });
  });

  it('ignores malformed plans and keeps an unfinished plan on its staging library', () => {
    expect(
      openingLibraryIdentity(
        storage({
          'den.localLibrary': KEY,
          'den.household': OTHER_KEY,
          'den.household.plan': JSON.stringify({ householdKey: OTHER_KEY, verified: {} }),
        }),
      ),
    ).toMatchObject({ libraryKey: OTHER_KEY, mode: 'online' });
    const unfinished = {
      version: 1,
      householdKey: OTHER_KEY,
      stagingKey: KEY,
      ownerKey: KEY,
      attempt: 'a'.repeat(32),
      ownerProfile: 'b'.repeat(32),
      createdAt: 1,
      started: true,
    };
    expect(
      openingLibraryIdentity(
        storage({
          'den.localLibrary': KEY,
          'den.household': OTHER_KEY,
          'den.household.plan': JSON.stringify(unfinished),
        }),
      ),
    ).toMatchObject({ libraryKey: KEY, mode: 'local' });
  });

  it('returns no speculative identity for public or refused storage', () => {
    expect(openingLibraryIdentity(storage({ 'den.browsing': '1' }))).toBeNull();
    const refused = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(openingLibraryIdentity(refused)).toBeNull();
  });
});
