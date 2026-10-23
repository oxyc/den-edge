// The ordinary pairing implementation. Tizen 3 resolves this module to pairCurve-tizen3 at build time; web, LG and
// newer Samsung targets retain noble's audited implementation and native BigInt performance.
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import type { PairingPoint } from './pairCurveTypes';

type NoblePoint = InstanceType<typeof ristretto255.Point>;

const scalar = (littleEndian: Uint8Array): bigint =>
  littleEndian.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);

const wrapped = (value: NoblePoint): PairingPoint => ({
  value,
  toBytes: () => new Uint8Array(value.toBytes()),
});

export function pointFromUniformBytes(hash: Uint8Array): PairingPoint | null {
  const point = ristretto255_hasher.deriveToCurve?.(hash);
  return point ? wrapped(point) : null;
}

export const multiplyPoint = (y: Uint8Array, point: PairingPoint): Uint8Array<ArrayBuffer> =>
  new Uint8Array((point.value as NoblePoint).multiply(scalar(y)).toBytes());

export function multiplyEncodedPoint(
  y: Uint8Array,
  encoded: Uint8Array,
): Uint8Array<ArrayBuffer> | null {
  try {
    const point = ristretto255.Point.fromBytes(encoded);
    return point.is0() ? null : new Uint8Array(point.multiply(scalar(y)).toBytes());
  } catch {
    return null;
  }
}
