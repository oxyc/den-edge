import { describe, expect, it } from 'vitest';
import dexter from '../../test/fixtures/airing-dexter.json';
import { newEpisodesRequest, parseAiring, type Airing, type FollowFacts } from './airing';
import { newEpisodes } from './newEpisodePolicy';

/** Dexter: Resurrection as atlas answers it: S2E1 out on Paramount+ Fri 30 Oct, S2E2 on 6 Nov, S2E3 on 13 Nov. */
const DEXTER = 259909;
const GREYS = 1416;
const airing = parseAiring(dexter)!;
const none: FollowFacts = { watchlist: [], continuing: [], caughtUp: [], seen: [], dismissed: [] };
const onRow = (series: number, season: number, episode: number, fraction = 0, watched = false) => ({
  series,
  episode: { season, episode },
  upcoming: false,
  fraction,
  watched,
});
/** Noon on a day in October or November 2026, where the viewer is. */
const day = (month: 10 | 11, date: number) => new Date(2026, month - 1, date, 12);

const decide = (facts: Partial<FollowFacts>, airings: ReadonlyMap<number, Airing>, now: Date) =>
  newEpisodes(newEpisodesRequest({ ...none, ...facts }, airings, now));

describe('new-episode policy binding (den-core new_episodes)', () => {
  it('marks the episode that plays new for a viewer caught up to it, and lists what is coming up', async () => {
    const answer = await decide(
      { continuing: [onRow(DEXTER, 2, 1)] },
      new Map([[DEXTER, airing]]),
      day(10, 31),
    );
    expect(answer.followed).toEqual([DEXTER]);
    expect(answer.new).toEqual([
      {
        series: DEXTER,
        season: 2,
        episode: 1,
        released: { season: 2, episode: 1 },
        name: 'Risky Business',
      },
    ]);
    expect(answer.comingUp).toEqual([
      { series: DEXTER, season: 2, episode: 2, date: '2026-11-06', premiere: false },
    ]);
  });

  it('counts an episode new for 7 days, as the Apple apps do', async () => {
    const once: Airing = { ...airing, next: undefined, upcoming: [] };
    const airings = new Map([[DEXTER, once]]);
    const facts = { continuing: [onRow(DEXTER, 2, 1)] };
    expect((await decide(facts, airings, day(11, 6))).new).toHaveLength(1);
    expect((await decide(facts, airings, day(11, 7))).new, 'the eighth day').toEqual([]);
    expect((await decide(facts, airings, day(11, 7))).released).toEqual([]);
  });

  it('treats an episode watched or played past the resume floor as started', async () => {
    const airings = new Map([[DEXTER, airing]]);
    const started = async (fraction: number, watched = false) =>
      (await decide({ continuing: [onRow(DEXTER, 2, 1, fraction, watched)] }, airings, day(10, 31)))
        .new.length;
    expect(await started(0.02), 'a two-second peek').toBe(1);
    expect(await started(0.03)).toBe(0);
    expect(await started(0, true)).toBe(0);
    // Its fresh release is still named, so the page keeps reading the series' progress.
    const answer = await decide({ continuing: [onRow(DEXTER, 2, 1, 0.5)] }, airings, day(10, 31));
    expect(answer.released).toEqual([{ series: DEXTER, season: 2, episode: 1 }]);
  });

  it('follows the Watchlist and the caught up, never a series seasons behind or dismissed', async () => {
    const greys: Airing = {
      ...airing,
      service: 'ABC',
      previous: { season: 22, episode: 5, date: '2026-10-30' },
      next: undefined,
      upcoming: [],
      seasonPremiere: { season: 22, date: '2026-10-02' },
    };
    const answer = await decide(
      {
        watchlist: [9, 7],
        continuing: [onRow(DEXTER, 2, 1), onRow(GREYS, 10, 3)],
        seen: [GREYS],
        dismissed: [7],
      },
      new Map([
        [DEXTER, airing],
        [GREYS, greys],
      ]),
      day(10, 31),
    );
    expect(answer.candidates).toEqual([9, DEXTER, GREYS]);
    expect(answer.followed, 'Seen, yet rewatching from S10E3: behind').toEqual([9, DEXTER]);
  });
});
