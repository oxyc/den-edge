import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hex } from './crypto';
import { lvCat } from './pair';
import * as noble from './pairCurve';
import * as typedArrays from './pairCurve-tizen3';
import { fromHex } from './wire';

const c = (
  JSON.parse(
    readFileSync(new URL('../../../spec/vectors/pairing-v1.json', import.meta.url), 'utf8'),
  ) as {
    cpace: Record<'prs' | 'ci' | 'sid' | 'g' | 'ya' | 'Ya' | 'yb' | 'Yb' | 'K', string> & {
      scalarMultVfy: { s: string; X: string; result: string };
      invalidPoints: string[];
    };
  }
).cpace;

const utf8 = new TextEncoder();
const DSI = utf8.encode('CPaceRistretto255');
const prs = fromHex(c.prs);
const generatorInput = lvCat(
  DSI,
  prs,
  new Uint8Array(Math.max(0, 128 - 1 - (prs.length + 1) - (DSI.length + 1))),
  fromHex(c.ci),
  fromHex(c.sid),
);
const uniform = new Uint8Array(await crypto.subtle.digest('SHA-512', generatorInput));

describe.each([
  ['noble BigInt', noble],
  ['Tizen 3 typed arrays', typedArrays],
] as const)('%s Ristretto adapter', (_name, curve) => {
  it('matches every CPace group-operation vector and rejects invalid or identity points', () => {
    const point = curve.pointFromUniformBytes(uniform);
    expect(point && hex(point.toBytes())).toBe(c.g);
    if (!point) throw new Error('the CPace generator did not map to a point');

    expect(hex(curve.multiplyPoint(fromHex(c.ya), point))).toBe(c.Ya);
    expect(hex(curve.multiplyPoint(fromHex(c.yb), point))).toBe(c.Yb);
    expect(hex(curve.multiplyEncodedPoint(fromHex(c.ya), fromHex(c.Yb))!)).toBe(c.K);
    expect(hex(curve.multiplyEncodedPoint(fromHex(c.yb), fromHex(c.Ya))!)).toBe(c.K);
    expect(
      hex(curve.multiplyEncodedPoint(fromHex(c.scalarMultVfy.s), fromHex(c.scalarMultVfy.X))!),
    ).toBe(c.scalarMultVfy.result);
    for (const invalid of c.invalidPoints)
      expect(curve.multiplyEncodedPoint(fromHex(c.scalarMultVfy.s), fromHex(invalid))).toBeNull();
    expect(curve.multiplyEncodedPoint(new Uint8Array(32), fromHex(c.Ya))).toBeNull();
  });
});
