import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Clock,
  deriveKeys,
  fromHex,
  mergeTitle,
  open,
  seal,
  type Row,
  type Stamp,
  type TitleRow,
} from './wire';

// den-spec, checked out at the repository root. The TV runs the same vectors, so passing here means both
// read and write the same rows.
const spec = (file: string) => JSON.parse(readFileSync(new URL(`../../../spec/vectors/${file}`, import.meta.url), 'utf8'));
const library = spec('library-v2.json') as {
  libraryKey: string;
  derived: { id: string; token: string };
  rows: { name: string; k: string; nonce: string; plaintext: string; v: string }[];
};
const merges = spec('merge-v2.json') as {
  base: TitleRow;
  merge: { case: string; a: Partial<TitleRow>; b: Partial<TitleRow>; merged: Partial<TitleRow> }[];
  clock: { case: string; last: Stamp; now: number; issued: Stamp; seen?: Stamp }[];
};

describe('library wire v2 matches den-spec', () => {
  it('derives the library id and write token', async () => {
    const keys = await deriveKeys(fromHex(library.libraryKey));
    expect([keys.id, keys.token]).toEqual([library.derived.id, library.derived.token]);
  });

  it.each(library.rows)('seals and opens $name', async ({ k, nonce, plaintext, v }) => {
    const keys = await deriveKeys(fromHex(library.libraryKey));
    const row = JSON.parse(plaintext) as Row;
    expect(await seal(keys, row, fromHex(nonce))).toEqual({ k, v });
    expect(await open(keys, k, v)).toEqual(row);
  });

  it('refuses a row moved to another key, or under another library key', async () => {
    const keys = await deriveKeys(fromHex(library.libraryKey));
    const [first, second] = library.rows;
    await expect(open(keys, second!.k, first!.v)).rejects.toThrow();
    await expect(open(await deriveKeys(new Uint8Array(32)), first!.k, first!.v)).rejects.toThrow();
  });

  it.each(merges.merge)('merges: $case', ({ a, b, merged }) => {
    const [left, right] = [{ ...merges.base, ...a }, { ...merges.base, ...b }];
    const expected = { ...merges.base, ...merged };
    expect(mergeTitle(left, right)).toEqual(expected);
    expect(mergeTitle(right, left)).toEqual(expected);
  });

  it.each(merges.clock)('clock: $case', ({ last, now, issued, seen }) => {
    const clock = new Clock(issued[2], last);
    if (seen) clock.see(seen);
    expect(clock.issue(now)).toEqual(issued);
  });

  it('keeps the fields it does not know from the newer version', () => {
    const older = { ...merges.base, future: 'old' };
    const newer = { ...merges.base, status: { value: 'watched' as const, at: [9000, 0, 'bbbb'] as Stamp }, future: 'new' };
    expect(mergeTitle(older, newer).future).toBe('new');
    expect(mergeTitle(newer, older).future).toBe('new');
  });
});
