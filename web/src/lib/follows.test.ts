import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newEpisodesRequest, type Airing } from './airing';
import {
  activeFollows,
  deriveUpdates,
  prunedMarks,
  updateMarks,
  type UpdateFacts,
} from './follows';
import { newEpisodes } from './newEpisodePolicy';
import type { SettingsRow } from './wire';

type Values = SettingsRow['values'];
const vectors = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/follows-v1.json', import.meta.url), 'utf8'),
) as {
  followCases: { name: string; values: Values; active: Record<string, number> }[];
  updateCases: { name: string; now: number; values: Values; marks: object; kept: Values }[];
  deriveCases: {
    name: string;
    today: string;
    now?: number;
    follows: Values;
    facts: UpdateFacts;
    marks?: Values;
    expected: object;
  }[];
};

describe('follows-v1 (den-spec)', () => {
  it.each(vectors.followCases)('$name', ({ values, active }) => {
    expect(activeFollows(values)).toEqual(active);
  });

  it.each(vectors.updateCases)('$name', ({ values, now, marks, kept }) => {
    expect(updateMarks(values, now)).toEqual(marks);
    expect(prunedMarks(values, now)).toEqual(kept);
  });

  // §3.1's episode window is den-core's `new_episodes` answer, asked as the Updates store asks it.
  it.each(vectors.deriveCases)('$name', async ({ today, now, follows, facts, marks, expected }) => {
    const airings = new Map(
      Object.entries(facts.airing ?? {}).map(([id, airing]) => [Number(id), airing as Airing]),
    );
    const answer = await newEpisodes(
      newEpisodesRequest(
        { watchlist: airings.keys(), continuing: [], caughtUp: [], seen: [], dismissed: [] },
        airings,
        new Date(`${today}T12:00`),
      ),
    );
    const released = Object.fromEntries(
      answer.released.map(({ series, season, episode }) => [series, { season, episode }]),
    );
    expect(
      deriveUpdates(
        today,
        activeFollows(follows),
        { ...facts, released },
        updateMarks(marks, now ?? 0),
      ),
    ).toEqual(expected);
  });
});
