import { describe, expect, it } from 'vitest';
import { LatestMutation } from './latestMutation';

describe('latest settings mutation', () => {
  it('lets only the newest intent publish', () => {
    const authority = {};
    const owner = new LatestMutation<object, { language: string }>();
    const first = owner.begin(authority, { language: 'es' });
    const second = owner.begin(authority, { language: 'sv' });

    expect(owner.isCurrent(first, authority)).toBe(false);
    expect(owner.isCurrent(second, authority)).toBe(true);
    expect(second.intent).toEqual({ language: 'sv' });
  });

  it('rejects a completion from a replaced authority, including ABA replacement', () => {
    const firstAuthority = {};
    const replacement = {};
    const owner = new LatestMutation<object, string>();
    const first = owner.begin(firstAuthority, 'first');
    owner.begin(replacement, 'replacement');
    const returned = owner.begin(firstAuthority, 'returned');

    expect(owner.isCurrent(first, firstAuthority)).toBe(false);
    expect(owner.isCurrent(returned, firstAuthority)).toBe(true);
  });

  it('retires an in-flight intent when its presentation leaves', () => {
    const authority = {};
    const owner = new LatestMutation<object, string>();
    const claim = owner.begin(authority, 'disconnect');
    owner.retire();

    expect(owner.isCurrent(claim, authority)).toBe(false);
  });
});
