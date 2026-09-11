import { describe, expect, it } from 'vitest';
import { browserClock } from './clock';
import { compareStamps } from './wire';

function memory(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  } as unknown as Storage;
}

describe('browserClock', () => {
  it('keeps its device id and its last stamp across visits', () => {
    const storage = memory();
    const first = browserClock(storage).issue(5000);
    const next = browserClock(storage).issue(1000); // a clock that went backwards
    expect(next[2]).toBe(first[2]);
    expect(compareStamps(next, first)).toBeGreaterThan(0);
  });

  it('stamps an edit after every stamp it has seen', () => {
    const clock = browserClock(memory());
    clock.see([90_000, 4, 'tv01']);
    expect(clock.issue(1000)).toEqual([90_000, 5, expect.stringMatching(/^[0-9a-f]{16}$/)]);
  });

  it('works for the visit when storage throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const clock = browserClock(blocked);
    expect(compareStamps(clock.issue(2000), clock.issue(1000))).toBeLessThan(0);
  });
});
