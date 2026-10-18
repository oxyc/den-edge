import { describe, expect, it } from 'vitest';
import { openingWorkers } from './libraryWorkerStart';

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
