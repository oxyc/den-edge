import { describe, expect, it } from 'vitest';
import {
  bornRangeId,
  bornRangeOf,
  exploreFromPeople,
  peopleFromExplore,
  peopleSuggestions,
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

  it('keeps a birth-year range in the address as one born pick, an open end spelled out', () => {
    expect(bornRangeId(1976, 1996)).toBe('born-1976-1996');
    expect(bornRangeId(1976)).toBe('born-from-1976');
    expect(bornRangeId(undefined, 1996)).toBe('born-to-1996');
    expect(bornRangeId()).toBeUndefined();
    expect(traitItems(['born-1976-1996', 'born-from-1976', 'born-to-1996'])).toEqual([
      { kind: 'born', id: '1976-1996' },
      { kind: 'born', id: '1976-' },
      { kind: 'born', id: '-1996' },
    ]);
    expect(bornRangeOf(['role-cast', 'born-from-1976'])).toEqual({ from: 1976, to: undefined });
    expect(bornRangeOf(['born-1970'])).toBeUndefined();
    // A range and a decade are one pick: either takes the other's place.
    expect(pickTrait(['born-1970', 'role-cast'], 'born-1976-1996')).toEqual([
      'role-cast',
      'born-1976-1996',
    ]);
    expect(pickTrait(['born-to-1996'], 'born-1980')).toEqual(['born-1980']);
    expect(pendingTraitChip('born-1976-1996')?.label).toBe('Born 1976–1996');
    expect(pendingTraitChip('born-from-1976')?.label).toBe('Born 1976 or later');
    expect(pendingTraitChip('born-to-1996')?.label).toBe('Born 1996 or earlier');
    // atlas names the range it applied as `selected`, in its own spelling.
    const picked = traitChips({
      total: 1,
      traits: {
        born: { mode: 'single', complete: true, values: { '1980': 1 }, selected: ['1976-'] },
      },
    });
    expect(picked.map((c) => [c.id, c.label])).toEqual([
      ['born-1980', 'Born 1980s'],
      ['born-from-1976', 'Born 1976 or later'],
    ]);
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

describe('Carrying a view between Explore and People', () => {
  it('takes Explore’s type and the title facets People reads, and leaves the rest', () => {
    expect(
      peopleFromExplore({
        type: 'tv',
        chips: ['genre-27', 'for-you', 'rating-7', 'like-tv-1396', 'country-KR', 'person-Q25191'],
      }),
    ).toEqual({ type: 'tv', chips: ['genre-27', 'country-KR', 'person-Q25191'] });
    expect(peopleFromExplore({ chips: ['for-you', 'rating-8'] })).toEqual({});
    expect(peopleFromExplore({})).toEqual({});
  });

  it('gives Explore People’s type and title facets, without traits, order or text', () => {
    expect(
      exploreFromPeople({
        query: 'nolan',
        type: 'movie',
        chips: ['genre-27', 'decade-1990'],
        traits: ['role-director'],
        order: 'name',
      }),
    ).toEqual({ type: 'movie', chips: ['genre-27', 'decade-1990'] });
    expect(exploreFromPeople({ traits: ['gender-Q6581072'] })).toEqual({});
  });

  it('comes back to the same title facets after a round trip', () => {
    const explore = { type: 'movie' as const, chips: ['genre-27', 'country-KR'] };
    expect(exploreFromPeople(peopleFromExplore(explore))).toEqual(explore);
  });
});

describe('The search field’s suggestions on People', () => {
  const listed = [...traitChips(counts), ...titleChips('all')];
  const everything = () => true;

  it('names a role by its word', () => {
    expect(peopleSuggestions('director', listed, [], everything)[0]?.id).toBe('role-director');
    expect(peopleSuggestions('fem', listed, [], everything)[0]?.id).toBe('gender-Q6581072');
  });

  it('puts the traits first, then what atlas found, then title facets, each once', () => {
    const found = [
      { id: 'citizenship-Q34', label: 'Sweden', group: 'citizenship' as const },
      { id: 'occupation-Q1', label: 'Swedish chef', group: 'occupation' as const },
    ];
    const ids = peopleSuggestions('swed', listed, found, everything).map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual(['citizenship-Q34', 'occupation-Q1']);
    expect(ids.filter((id) => id === 'citizenship-Q34')).toHaveLength(1);
    expect(ids.slice(2).length).toBeGreaterThan(0);
    expect(ids.slice(2).every((id) => !id.startsWith('citizenship-'))).toBe(true);
  });

  it('offers only what may be picked', () => {
    const ids = peopleSuggestions('direct', listed, [], (id) => id !== 'role-director').map(
      (c) => c.id,
    );
    expect(ids).not.toContain('role-director');
  });

  it('offers nothing for text that names nothing', () => {
    expect(peopleSuggestions('zzqx', listed, [], everything)).toEqual([]);
  });
});
