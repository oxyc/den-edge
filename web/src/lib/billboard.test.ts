import { describe, expect, it } from 'vitest';
import {
  affinity,
  arrival,
  attention,
  buzz,
  freshness,
  pickBillboard,
  quality,
  tasteOf,
  type Candidate,
} from './billboard';
import type { Title } from './library';

const NOW = new Date('2026-09-12T00:00:00Z');

const film = (id: number, extra: Partial<Title> = {}): Title => ({
  type: 'movie',
  id,
  title: `T${id}`,
  posterPath: '/p.jpg',
  ...extra,
});

describe('freshness', () => {
  it('is high but not full marks for the unreleased, and decays over four months', () => {
    expect(freshness(film(1, { releaseDate: '2026-12-01' }), NOW)).toBe(0.8);
    expect(freshness(film(2, { releaseDate: '2026-09-10' }), NOW)).toBeCloseTo(0.983, 2);
    const old = freshness(film(3, { releaseDate: '2024-01-01' }), NOW);
    expect(old).toBeLessThan(0.01);
  });

  it('places a title known only by its year mid-year, and scores an undated one as old', () => {
    expect(freshness(film(4, { year: 2026 }), NOW)).toBeCloseTo(
      freshness(film(5, { releaseDate: '2026-07-01' }), NOW),
      6,
    );
    expect(freshness(film(6), NOW)).toBe(0);
  });
});

describe('buzz and quality', () => {
  it('reads a place in a ranked list, and nothing from an unranked one', () => {
    expect(buzz({ title: film(1), rank: 0, of: 10 })).toBe(1);
    expect(buzz({ title: film(1), rank: 5, of: 10 })).toBe(0.5);
    expect(buzz({ title: film(1) })).toBe(0);
  });

  it('reads attention from popularity when there is no ranking, against the busiest in the pool', () => {
    const busiest = 500;
    expect(buzz({ title: film(1, { popularity: 500 }) }, busiest)).toBeCloseTo(1, 6);
    expect(buzz({ title: film(2, { popularity: 0 }) }, busiest)).toBe(0);
    // Long-tailed, so a middling title still registers rather than rounding to nothing beside a runaway hit.
    expect(buzz({ title: film(3, { popularity: 50 }) }, busiest)).toBeGreaterThan(0.6);
  });

  it('among new titles, prefers the one people are watching', () => {
    const unknown = film(1, { releaseDate: '2026-09-05', popularity: 2 });
    const awaited = film(2, { releaseDate: '2026-09-05', popularity: 900 });
    expect(
      pickBillboard([{ title: unknown }, { title: awaited }], { now: NOW }).map((t) => t.id),
    ).toEqual([2, 1]);
  });

  it('ignores a rating too few people gave', () => {
    expect(quality(film(1, { rating: 8.5, votes: 12 }))).toBe(0);
    expect(quality(film(2, { rating: 8.5, votes: 500 }))).toBe(1);
    expect(quality(film(3, { rating: 6, votes: 500 }))).toBe(0);
  });
});

describe('taste', () => {
  const CRIME = 80;
  const HORROR = 27;
  // A library of Nordic crime, with one horror film in it.
  const watched = tasteOf([
    { title: film(1, { genreIds: [CRIME], originalLanguage: 'sv' }) },
    { title: film(2, { genreIds: [CRIME], originalLanguage: 'da' }) },
    { title: film(3, { genreIds: [CRIME], originalLanguage: 'sv' }) },
    { title: film(4, { genreIds: [HORROR], originalLanguage: 'en' }), weight: 0.6 },
  ]);

  it('marks a title up for the genres this library watches and down for the ones it does not', () => {
    const nordicCrime = affinity(
      film(9, { genreIds: [CRIME, 9648], originalLanguage: 'sv' }),
      watched,
    );
    const englishHorror = affinity(
      film(10, { genreIds: [HORROR], originalLanguage: 'en' }),
      watched,
    );
    expect(nordicCrime).toBeGreaterThan(englishHorror);
    expect(nordicCrime).toBeCloseTo(1, 6);
  });

  it('lets the language nudge the score rather than decide it', () => {
    // Nine parts English to one part Swedish, and two titles alike but for their language.
    const mostlyEnglish = tasteOf([
      { title: film(80, { genreIds: [CRIME], originalLanguage: 'en' }), weight: 9 },
      { title: film(81, { genreIds: [CRIME], originalLanguage: 'sv' }) },
    ]);
    const english = affinity(
      film(82, { genreIds: [CRIME], originalLanguage: 'en' }),
      mostlyEnglish,
    );
    const swedish = affinity(
      film(83, { genreIds: [CRIME], originalLanguage: 'sv' }),
      mostlyEnglish,
    );
    // Both match the genre outright, so both score well and the language separates them barely at all.
    expect(Math.min(english, swedish)).toBeGreaterThan(0.85);
    expect(english - swedish).toBeLessThanOrEqual(0.1);
  });

  it('is nothing at all without a profile, so a fresh library still gets a billboard', () => {
    expect(affinity(film(11, { genreIds: [CRIME] }))).toBe(0);
    expect(affinity(film(12, { genreIds: [CRIME] }), tasteOf([]))).toBe(0);
  });

  it('lets taste beat a title that tops every list, since it multiplies rather than adds', () => {
    // The Mayday case: first in trending and first in its service's arrivals, but nothing like what is watched.
    const everywhere = {
      title: film(30, {
        releaseDate: '2026-09-01',
        genreIds: [28],
        originalLanguage: 'en',
        popularity: 900,
      }),
      rank: 0,
      of: 100,
      arrival: { rank: 0, of: 100 },
    };
    // Not a title nobody is watching — one doing respectably, which taste should be able to carry past a
    // louder stranger. Taste multiplies what a title is already worth; it cannot conjure worth from nothing.
    const onTaste = {
      title: film(31, { releaseDate: '2026-09-01', genreIds: [CRIME], originalLanguage: 'sv' }),
      rank: 20,
      of: 100,
    };
    const profile = tasteOf([
      { title: film(92, { genreIds: [CRIME], originalLanguage: 'sv' }) },
      { title: film(93, { genreIds: [28], originalLanguage: 'en' }), weight: 0.2 },
    ]);
    expect(
      pickBillboard([everywhere, onTaste], { now: NOW, taste: profile }).map((t) => t.id),
    ).toEqual([31, 30]);
  });

  it('lifts the on-taste title above an equally new one that is louder', () => {
    const onTaste = film(20, {
      releaseDate: '2026-09-05',
      genreIds: [CRIME],
      originalLanguage: 'sv',
      popularity: 40,
    });
    const loudHorror = film(21, {
      releaseDate: '2026-09-05',
      genreIds: [HORROR],
      originalLanguage: 'en',
      popularity: 400,
    });
    const picked = pickBillboard([{ title: loudHorror }, { title: onTaste }], {
      now: NOW,
      taste: watched,
    });
    expect(picked.map((t) => t.id)).toEqual([20, 21]);
  });
});

describe('taste beyond genre', () => {
  const DRAMA = 18;
  const MYSTERY = 9648;
  const CRIME = 80;
  const ACTION = 28;
  const HORROR = 27;

  it('tells a real match from a title that merely carries the library’s commonest genre', () => {
    // The failure this replaces: affinity read a title's best genre against the profile's strongest, so in a
    // library where half of everything is tagged Drama every drama on earth scored a perfect match and taste
    // decided nothing. Measured against what this library's own titles score, they separate.
    const spread = tasteOf([
      { title: film(1, { genreIds: [DRAMA, MYSTERY] }) },
      { title: film(2, { genreIds: [DRAMA, CRIME] }) },
      { title: film(3, { genreIds: [DRAMA, MYSTERY, CRIME] }) },
      { title: film(4, { genreIds: [DRAMA] }) },
    ]);
    const close = affinity(film(10, { genreIds: [DRAMA, MYSTERY, CRIME] }), spread);
    const dramaAlone = affinity(film(11, { genreIds: [DRAMA] }), spread);
    expect(close).toBeGreaterThan(dramaAlone);
    expect(dramaAlone).toBeLessThan(0.8);
  });

  it('follows the people behind what has been watched, across genres', () => {
    const DIRECTOR = 5000;
    const auteur = tasteOf([
      { title: film(1, { genreIds: [DRAMA], people: [DIRECTOR, 1, 2] }) },
      { title: film(2, { genreIds: [DRAMA], people: [DIRECTOR, 3, 4] }) },
    ]);
    const theirs = affinity(film(10, { genreIds: [ACTION], people: [DIRECTOR, 9] }), auteur);
    const stranger = affinity(film(11, { genreIds: [ACTION], people: [8, 9] }), auteur);
    expect(theirs).toBeGreaterThan(stranger);
    // Enough on its own to survive the stranger cut: a film by someone they follow is not a stranger.
    expect(theirs).toBeGreaterThan(0.15);
  });

  it('reads where a title was made, so a co-production in English still reads as one of theirs', () => {
    const nordic = tasteOf([
      { title: film(1, { genreIds: [CRIME], countries: ['SE'], originalLanguage: 'sv' }) },
      { title: film(2, { genreIds: [CRIME], countries: ['DK'], originalLanguage: 'da' }) },
    ]);
    const coproduction = affinity(
      film(10, { genreIds: [CRIME], countries: ['SE', 'GB'], originalLanguage: 'en' }),
      nordic,
    );
    const american = affinity(
      film(11, { genreIds: [CRIME], countries: ['US'], originalLanguage: 'en' }),
      nordic,
    );
    expect(coproduction).toBeGreaterThan(american);
  });

  it('prefers the decade this library actually watches', () => {
    const modern = tasteOf([
      { title: film(1, { genreIds: [DRAMA], releaseDate: '2024-01-01' }) },
      { title: film(2, { genreIds: [DRAMA], releaseDate: '2022-06-01' }) },
    ]);
    const now = affinity(film(10, { genreIds: [DRAMA], releaseDate: '2026-03-01' }), modern);
    const old = affinity(film(11, { genreIds: [DRAMA], releaseDate: '1981-03-01' }), modern);
    expect(now).toBeGreaterThan(old);
  });

  it('carries the next of a franchise already started, whatever genre it turned into', () => {
    const started = tasteOf([{ title: film(1, { genreIds: [ACTION], collectionId: 77 }) }]);
    const sequel = affinity(film(10, { genreIds: [DRAMA], collectionId: 77 }), started);
    const unrelated = affinity(film(11, { genreIds: [DRAMA] }), started);
    expect(unrelated).toBe(0);
    expect(sequel).toBeCloseTo(0.5, 6);
  });

  it('marks down what was disliked, while a genre they otherwise watch survives one bad film', () => {
    const turnedDown = tasteOf([
      { title: film(1, { genreIds: [DRAMA, HORROR] }) },
      { title: film(2, { genreIds: [DRAMA] }) },
      { title: film(3, { genreIds: [DRAMA] }) },
      { title: film(4, { genreIds: [DRAMA, ACTION] }), weight: -1.5 },
    ]);
    const drama = affinity(film(10, { genreIds: [DRAMA] }), turnedDown);
    const alsoAction = affinity(film(12, { genreIds: [DRAMA, ACTION] }), turnedDown);
    const onlyAction = affinity(film(11, { genreIds: [ACTION] }), turnedDown);
    expect(drama).toBeGreaterThan(0.5);
    expect(alsoAction).toBeLessThan(drama);
    expect(onlyAction).toBe(0);
  });
});

describe('arrival', () => {
  it('lifts an older title that has just landed on a service over a newer one that has not', () => {
    const justLanded = {
      title: film(1, { releaseDate: '1997-06-01' }),
      arrival: { rank: 0, of: 10 },
    };
    const merelyNew = { title: film(2, { releaseDate: '2026-08-20' }) };
    expect(pickBillboard([merelyNew, justLanded], { now: NOW }).map((t) => t.id)).toEqual([1, 2]);
  });

  it('counts a service pushing its own release once, not twice', () => {
    // Top of that service's arrivals AND top of trending is one fact about one marketing campaign.
    const pushed = { title: film(1), rank: 0, of: 100, arrival: { rank: 0, of: 100 } };
    const trendingOnly = { title: film(2), rank: 0, of: 100 };
    expect(attention(pushed)).toBeCloseTo(1.3, 6);
    expect(attention(trendingOnly)).toBeCloseTo(1, 6);
  });

  it('counts for nothing when the title arrived in no list', () => {
    expect(arrival({ title: film(3) })).toBe(0);
    expect(arrival({ title: film(4), arrival: { rank: 0, of: 0 } })).toBe(0);
    expect(arrival({ title: film(5), arrival: { rank: 2, of: 10 } })).toBeCloseTo(0.8, 6);
  });
});

describe('pickBillboard', () => {
  it('leads with what is new rather than what is merely well liked', () => {
    const pool: Candidate[] = [
      { title: film(1, { releaseDate: '1994-09-23', rating: 9.3, votes: 20_000 }) },
      { title: film(2, { releaseDate: '2026-09-01', rating: 6.4, votes: 200 }) },
    ];
    expect(pickBillboard(pool, { now: NOW }).map((t) => t.id)).toEqual([2, 1]);
  });

  it('merges a title two sources both offered, so a ranking and a genre reach the same candidate', () => {
    const CRIME = 80;
    // atlas knows it is trending and nothing else; TMDB knows what it is.
    const fromAtlas = { title: film(5, { title: 'Both', year: 2026 }), rank: 0, of: 10 };
    const fromTmdb = {
      title: film(5, {
        title: 'Both',
        releaseDate: '2026-09-01',
        genreIds: [CRIME],
        originalLanguage: 'sv',
        votes: 120,
        rating: 8,
      }),
    };
    const taste = tasteOf([{ title: film(99, { genreIds: [CRIME], originalLanguage: 'sv' }) }]);
    const alone = film(6, {
      releaseDate: '2026-09-01',
      genreIds: [CRIME],
      originalLanguage: 'sv',
      votes: 120,
      rating: 8,
    });
    // Unmerged, the atlas copy would score on its ranking alone and lose to the plain TMDB title.
    const picked = pickBillboard([fromAtlas, fromTmdb, { title: alone }], { now: NOW, taste });
    expect(picked.map((t) => t.id)).toEqual([5, 6]);
  });

  it('takes the better of two placings for the same title, not the first one seen', () => {
    const CRIME = 80;
    const taste = tasteOf([{ title: film(90, { genreIds: [CRIME] }) }]);
    const inUS = { title: film(5, { genreIds: [CRIME] }), arrival: { rank: 60, of: 100 } };
    const inFI = { title: film(5, { genreIds: [CRIME] }), arrival: { rank: 0, of: 100 } };
    const rival = { title: film(6, { genreIds: [CRIME] }), arrival: { rank: 30, of: 100 } };
    expect(pickBillboard([inUS, inFI, rival], { now: NOW, taste }).map((t) => t.id)).toEqual([
      5, 6,
    ]);
  });

  it('drops a title that resembles too little of the library, but only when its genres are known', () => {
    const CRIME = 80;
    const ACTION = 28;
    // A library of Nordic crime that half-watched one action film: a tenth of the weight of its strongest.
    const taste = tasteOf([
      { title: film(90, { genreIds: [CRIME], originalLanguage: 'sv' }), weight: 3 },
      { title: film(96, { genreIds: [ACTION], originalLanguage: 'en' }), weight: 0.3 },
    ]);
    const alien = film(2, { genreIds: [16], originalLanguage: 'ja', releaseDate: '2026-09-01' });
    // A sliver of a match is still not a reason to feature it.
    const barely = film(4, {
      genreIds: [ACTION],
      originalLanguage: 'en',
      releaseDate: '2026-09-01',
    });
    const unknown = film(3, { releaseDate: '2026-09-01' });
    const picked = pickBillboard([{ title: alien }, { title: barely }, { title: unknown }], {
      now: NOW,
      taste,
    });
    expect(picked.map((t) => t.id)).toEqual([3]);
    // With no profile to judge against, nothing is a stranger.
    expect(pickBillboard([{ title: alien }], { now: NOW }).map((t) => t.id)).toEqual([2]);
  });

  it('drops what the caller hides, and dedupes what two sources both offered', () => {
    const twice = film(7, { releaseDate: '2026-09-01' });
    const pool: Candidate[] = [
      { title: twice, rank: 0, of: 2 },
      { title: twice },
      { title: film(8, { releaseDate: '2026-09-02' }) },
    ];
    const picked = pickBillboard(pool, { now: NOW, keep: (t) => t.id !== 8 });
    expect(picked.map((t) => t.id)).toEqual([7]);
  });

  it('cuts to the slide count only after filtering, so a strict library still fills the billboard', () => {
    const pool: Candidate[] = Array.from({ length: 60 }, (_, i) => ({
      title: film(i, { releaseDate: '2026-08-01' }),
    }));
    // Half the pool is hidden; the billboard should still be full rather than half empty.
    const picked = pickBillboard(pool, { now: NOW, slides: 20, keep: (t) => t.id % 2 === 0 });
    expect(picked).toHaveLength(20);
    expect(picked.every((t) => t.id % 2 === 0)).toBe(true);
  });
});
