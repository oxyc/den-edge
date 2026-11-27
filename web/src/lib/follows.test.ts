import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  activeFollows,
  deriveUpdates,
  prunedMarks,
  updateMarks,
  type UpdateFacts,
} from './follows';
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

  it.each(vectors.deriveCases)('$name', ({ today, now, follows, facts, marks, expected }) => {
    expect(
      deriveUpdates(today, activeFollows(follows), facts, updateMarks(marks, now ?? 0)),
    ).toEqual(expected);
  });
});
