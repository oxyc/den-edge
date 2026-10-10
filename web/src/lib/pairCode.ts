// A pairing code's shape, apart from `pair.ts`: reading a phone link at startup (`phoneLink.ts`) checks its code,
// and importing `pair.ts` for that put its 45 KB chunk (pair.ts, inbox.ts, @noble/curves) in every page's startup.

export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A typed or scanned code: uppercased, spaces and dashes dropped, and refused unless it is 12 alphabet characters. */
export function parseCode(input: string): { nameplate: string; secret: string } | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== 12 || [...code].some((c) => !ALPHABET.includes(c))) return null;
  return { nameplate: code.slice(0, 4), secret: code.slice(4) };
}
