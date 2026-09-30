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
      values: { Q6581072: 4, Q6581097: 5, other: 2 },
      labels: { Q6581072: 'female', Q6581097: 'male', other: 'Other' },
    },
    born: { mode: 'single', complete: true, values: {} },
    citizenship: {
      mode: 'and',
      complete: false,
      values: { Q30: 6, Q34: 2 },
      labels: { Q30: 'United States', Q34: 'Sweden' },
      selected: ['Q189'],
    },
    occupation: {
      mode: 'and',
      complete: false,
      values: { Q33999: 8, Q3455803: 7, Q28389: 6, Q49757: 4, Q3282637: 3, Q36834: 2 },
      labels: {
        Q33999: 'actor',
        Q3455803: 'director',
        Q28389: 'screenwriter',
        Q49757: 'writer',
        Q3282637: 'film producer',
        Q36834: 'composer',
      },
    },
  },
};

describe('People’s person traits', () => {
  it('reads each pick as atlas’s trait, and leaves anything else out', () => {
    expect(
      traitItems(['role-director', 'born-1970', 'citizenship-Q34', 'genre-27', 'role-']),
    ).toEqual([
      { kind: 'role', id: 'director' },
      { kind: 'citizenship', id: 'Q34' },
    ]);
  });

  it('adds a second value of any trait beside the first, and takes a picked one out', () => {
    expect(pickTrait(['role-director'], 'role-writer')).toEqual(['role-director', 'role-writer']);
    expect(pickTrait(['gender-Q6581097', 'role-cast'], 'gender-Q6581072')).toEqual([
      'gender-Q6581097',
      'role-cast',
      'gender-Q6581072',
    ]);
    expect(pickTrait(['role-cast'], 'born-1980')).toEqual(['role-cast']);
    expect(pickTrait(['role-cast'], 'genre-27')).toEqual(['role-cast']);
  });

  it('asks a trait’s values as one either-or group, a range of birth years alone', () => {
    expect(traitItems(['citizenship-Q30', 'role-cast', 'citizenship-Q145', 'born-1970'])).toEqual([
      { kind: 'citizenship', id: 'Q30|Q145' },
      { kind: 'role', id: 'cast' },
    ]);
  });

  it('offers every value not picked, but no born value beside a range of birth years', () => {
    expect(traitOffered(['gender-Q6581097'], 'gender-Q6581072')).toBe(true);
    expect(traitOffered(['gender-Q6581097'], 'born-1970')).toBe(false);
    expect(traitOffered(['citizenship-Q30'], 'citizenship-Q34')).toBe(true);
    expect(traitOffered(['citizenship-Q30'], 'citizenship-Q30')).toBe(false);
    expect(traitOffered(['born-1970'], 'born-1980')).toBe(false);
    expect(traitOffered(['born-1976-1996'], 'born-1980')).toBe(false);
  });

  it('lists roles in atlas’s order and the other counted values by people', () => {
    const chips = traitChips(counts);
    expect(chips.map((c) => [c.id, c.label])).toEqual([
      ['role-cast', 'Actors'],
      ['role-director', 'Directors'],
      ['role-writer', 'Screenwriters'],
      ['gender-Q6581097', 'Male'],
      ['gender-Q6581072', 'Female'],
      ['gender-other', 'Other'],
      // A picked value is listed to name its pill.
      ['citizenship-Q30', 'United States'],
      ['citizenship-Q34', 'Sweden'],
      ['citizenship-Q189', 'Q189'],
      ['occupation-Q49757', 'Writer'],
      ['occupation-Q3282637', 'Film producer'],
      ['occupation-Q36834', 'Composer'],
    ]);
    expect(chips.find((c) => c.id === 'role-cast')?.group).toBe('role');
    expect(chips.some((c) => c.id === 'occupation-Q33999')).toBe(false);
    expect(chips.some((c) => c.id === 'occupation-Q3455803')).toBe(false);
    expect(chips.some((c) => c.id === 'occupation-Q28389')).toBe(false);
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
    expect(pickTrait(['born-from-1970', 'role-cast'], 'born-1976-1996')).toEqual([
      'role-cast',
      'born-1976-1996',
    ]);
    expect(pendingTraitChip('born-1976-1996')?.label).toBe('Born 1976–1996');
    expect(pendingTraitChip('born-from-1976')?.label).toBe('Born 1976 or later');
    expect(pendingTraitChip('born-to-1996')?.label).toBe('Born 1996 or earlier');
    // atlas names the range it applied as `selected`, in its own spelling.
    const picked = traitChips({
      total: 1,
      traits: {
        born: { mode: 'single', complete: true, values: {}, selected: ['1976-'] },
      },
    });
    expect(picked.map((c) => [c.id, c.label])).toEqual([['born-from-1976', 'Born 1976 or later']]);
  });

  it('hides a value only where atlas lists its trait whole', () => {
    expect(traitEmpty('role-creator', counts)).toBe(true);
    expect(traitEmpty('role-cast', counts)).toBe(false);
    expect(traitEmpty('citizenship-Q99', counts)).toBe(false);
    expect(traitEmpty('occupation-Q33999', counts)).toBe(false);
    // Another value of a trait picked joins it as either-or: it can only add people, so it is never judged.
    expect(traitEmpty('role-creator', counts, ['role-cast'])).toBe(false);
    expect(traitEmpty('role-creator', counts, ['gender-Q6581072'])).toBe(true);
  });

  it('names a pick before atlas has counted it', () => {
    expect(pendingTraitChip('role-director')?.label).toBe('Directors');
    expect(pendingTraitChip('born-1970')).toBeUndefined();
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
    expect(titleItems(['country-FR', 'genre-27', 'country-IT', 'for-you'], 'movie')).toEqual([
      { kind: 'country', id: 'FR|IT' },
      { kind: 'genre', id: '27' },
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
    expect(peopleFromExplore({ chips: ['for-you', 'rating-8', 'fans-movie-550'] })).toEqual({});
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
