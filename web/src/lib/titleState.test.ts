import { describe, expect, it } from 'vitest';
import { blankTitle } from './actions';
import { titleState } from './titleState';
import type { Stamp } from './wire';

const at = (t: number): Stamp => [t, 0, 'web1'];
const dune = blankTitle({ type: 'movie', id: 693134 }, 1000);

describe('titleState, the one reading of a row TitleActions and the poster menu share', () => {
  it('has nothing to say about a title the library has never held', () => {
    expect(titleState(undefined)).toEqual({ listed: false, seen: false, reaction: null });
  });

  it('reads watchlist and watched off status', () => {
    expect(titleState({ ...dune, status: { value: 'watchlist', at: at(2) } }).listed).toBe(true);
    expect(titleState({ ...dune, status: { value: 'watched', at: at(2) } }).seen).toBe(true);
    expect(titleState({ ...dune, status: { value: 'inProgress', at: at(2) } })).toMatchObject({
      listed: false,
      seen: false,
    });
  });

  it('reads the opinion, defaulting to no rating', () => {
    expect(titleState(dune).reaction).toBeNull();
    expect(titleState({ ...dune, reaction: { value: 'love', at: at(2) } }).reaction).toBe('love');
  });

  it('a deleted row means not listed, not seen, and no opinion — a tombstone a later add undoes', () => {
    const deleted = {
      ...dune,
      status: { value: 'watched' as const, at: at(2) },
      reaction: { value: 'love' as const, at: at(2) },
      deleted: { value: true, at: at(3) },
    };
    expect(titleState(deleted)).toEqual({ listed: false, seen: false, reaction: null });
  });
});
