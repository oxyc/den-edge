import { expect, it } from 'vitest';
import { forgetHeroLeadPointers, keepHeroLeadPointer } from './heroLeadPointer';

it('forgets only the retained hero pointers and leads owned by the retired library key', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const oldLead = `den.hero-lead.v1.${'a'.repeat(64)}.fresh.all`;
  const currentLead = `den.hero-lead.v1.${'b'.repeat(64)}.movie`;
  values.set(oldLead, 'old artwork');
  values.set(currentLead, 'current artwork');
  keepHeroLeadPointer('old-library-key', null, true, oldLead, storage);
  keepHeroLeadPointer('current-library-key', 'movie', false, currentLead, storage);

  forgetHeroLeadPointers('old-library-key', storage);

  expect(values.get(oldLead)).toBeUndefined();
  expect(values.get('den.hero-lead.current.v1.fresh.all')).toBeUndefined();
  expect(values.get(currentLead)).toBe('current artwork');
  expect(values.get('den.hero-lead.current.v1.movie')).toContain('current-library-key');
});

it('drops an unusable plaintext pointer while forgetting a library', () => {
  const values = new Map([['den.hero-lead.current.v1.all', '{broken']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };

  forgetHeroLeadPointers('retired-library-key', storage);

  expect(values.size).toBe(0);
});

it('removes the prior validated lead when another library takes the same pointer slot', () => {
  const values = new Map<string, string>();
  const operations: string[] = [];
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      operations.push(`set ${key}`);
      values.set(key, value);
    },
    removeItem: (key: string) => {
      operations.push(`remove ${key}`);
      values.delete(key);
    },
  };
  const oldLead = `den.hero-lead.v1.${'c'.repeat(64)}.fresh.tv`;
  const nextLead = `den.hero-lead.v1.${'d'.repeat(64)}.fresh.tv`;
  values.set(oldLead, 'old artwork');
  values.set(nextLead, 'next artwork');

  keepHeroLeadPointer('first-library', 'tv', true, oldLead, storage);
  operations.length = 0;
  keepHeroLeadPointer('second-library', 'tv', true, nextLead, storage);

  expect(operations).toEqual([`remove ${oldLead}`, 'set den.hero-lead.current.v1.fresh.tv']);
  expect(values.get(oldLead)).toBeUndefined();
  expect(values.get(nextLead)).toBe('next artwork');
  expect(values.get('den.hero-lead.current.v1.fresh.tv')).toBe(
    JSON.stringify({ identity: 'second-library', key: nextLead }),
  );
});

it('overwrites malformed prior pointers without removing an unvalidated lead', () => {
  const pointer = 'den.hero-lead.current.v1.fresh.all';
  const unrelatedLead = `den.hero-lead.v1.${'e'.repeat(64)}.movie`;
  const nextLead = `den.hero-lead.v1.${'f'.repeat(64)}.fresh.all`;
  const values = new Map([
    [pointer, JSON.stringify({ identity: 'other-library', key: unrelatedLead })],
    [unrelatedLead, 'unrelated artwork'],
    [nextLead, 'next artwork'],
  ]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };

  keepHeroLeadPointer('next-library', null, true, nextLead, storage);

  expect(values.get(unrelatedLead)).toBe('unrelated artwork');
  expect(values.get(pointer)).toBe(JSON.stringify({ identity: 'next-library', key: nextLead }));

  values.set(pointer, '{broken');
  expect(() => keepHeroLeadPointer('next-library', null, true, nextLead, storage)).not.toThrow();
  expect(values.get(pointer)).toBe(JSON.stringify({ identity: 'next-library', key: nextLead }));
});
