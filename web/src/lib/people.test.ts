import { describe, expect, it } from 'vitest';
import {
  pendingTraitChip,
  pickTrait,
  titleChips,
  titleItems,
  traitChips,
  traitEmpty,
  traitItems,
  traitOffered,
} from './people';
import type { PeopleCounts } from './filterRoutes';

const counts: PeopleCounts = {
  total: 9,
  traits: {
    role: { mode: 'and', complete: true, values: { writer: 2, cast: 9, director: 3 } },
    gender: {
      mode: 'single',
      complete: true,
      values: { Q6581072: 4, Q6581097: 5 },
      labels: { Q6581072: 'female', Q6581097: 'male' },
    },
    born: { mode: 'single', complete: true, values: { '1960': 2, '1980': 3, '-480': 1 } },
    citizenship: {
      mode: 'and',
      complete: false,
      values: { Q30: 6, Q34: 2 },
      labels: { Q30: 'United States', Q34: 'Sweden' },
      selected: ['Q189'],
    },
  },
};

describe('People’s person traits', () => {
  it('reads each pick as atlas’s trait, and leaves anything else out', () => {
    expect(
      traitItems(['role-director', 'born-1970', 'citizenship-Q34', 'genre-27', 'role-']),
    ).toEqual([
      { kind: 'role', id: 'director' },
      { kind: 'born', id: '1970' },
      { kind: 'citizenship', id: 'Q34' },
    ]);
  });

  it('stacks roles and nationalities, and lets a new gender or decade take the old one’s place', () => {
    expect(pickTrait(['role-director'], 'role-writer')).toEqual(['role-director', 'role-writer']);
    expect(pickTrait(['gender-Q6581097', 'role-cast'], 'gender-Q6581072')).toEqual([
      'role-cast',
      'gender-Q6581072',
    ]);
    expect(pickTrait(['born-1970', 'role-cast'], 'born-1970')).toEqual(['role-cast']);
    expect(pickTrait(['role-cast'], 'genre-27')).toEqual(['role-cast']);
  });

  it('offers no second value of a one-value trait, and any number of a stacking one', () => {
    expect(traitOffered(['gender-Q6581097'], 'gender-Q6581072')).toBe(false);
    expect(traitOffered(['gender-Q6581097'], 'born-1970')).toBe(true);
    expect(traitOffered(['citizenship-Q30'], 'citizenship-Q34')).toBe(true);
    expect(traitOffered(['citizenship-Q30'], 'citizenship-Q30')).toBe(false);
  });

  it('lists the counted values as chips: roles in atlas’s order, decades latest first, the rest by people', () => {
    const chips = traitChips(counts);
    expect(chips.map((c) => [c.id, c.label])).toEqual([
      ['role-cast', 'Actors'],
      ['role-director', 'Directors'],
      ['role-writer', 'Writers'],
      ['gender-Q6581097', 'Male'],
      ['gender-Q6581072', 'Female'],
      ['born-1980', 'Born 1980s'],
      ['born-1960', 'Born 1960s'],
      // A decade before the common era has no address, and a picked value is listed to name its pill.
      ['citizenship-Q30', 'United States'],
      ['citizenship-Q34', 'Sweden'],
      ['citizenship-Q189', 'Q189'],
    ]);
    expect(chips.find((c) => c.id === 'role-cast')?.group).toBe('role');
  });

  it('hides a value only where atlas lists its trait whole', () => {
    expect(traitEmpty('role-creator', counts)).toBe(true);
    expect(traitEmpty('role-cast', counts)).toBe(false);
    expect(traitEmpty('citizenship-Q99', counts)).toBe(false);
    expect(traitEmpty('occupation-Q33999', counts)).toBe(false);
  });

  it('names a pick before atlas has counted it', () => {
    expect(pendingTraitChip('role-director')?.label).toBe('Directors');
    expect(pendingTraitChip('born-1970')?.label).toBe('Born 1970s');
    expect(pendingTraitChip('citizenship-Q34')?.label).toBe('Nationality…');
    expect(pendingTraitChip('genre-27')).toBeUndefined();
  });
});

describe('People’s title facets', () => {
  it('offers Explore’s facets atlas can take, but not For You or TMDB’s rating floors', () => {
    const chips = titleChips('movie');
    expect(chips.some((c) => c.id === 'genre-27')).toBe(true);
    expect(chips.some((c) => c.id === 'decade-1990')).toBe(true);
    expect(chips.some((c) => c.group === 'for-you' || c.group === 'rating')).toBe(false);
  });

  it('asks atlas only what it can read', () => {
    expect(titleItems(['genre-27', 'for-you', 'decade-1995'], 'movie')).toEqual([
      { kind: 'genre', id: '27' },
      { kind: 'decade', id: '1990' },
    ]);
  });
});
