// BigInt-free Ristretto255 for Chromium 47. This adapter is selected only by the Tizen 3 build; it preserves Den's
// pairing-v1 bytes and CPace security properties while representing field elements with typed arrays.
import ristretto255 from 'ristretto255';
import type { PairingPoint } from './pairCurveTypes';

const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);
const identity = (value: Uint8Array): boolean => value.every((byte) => byte === 0);
// Den samples below 2^252, which is both canonical (below the group order) and straightforward to validate without
// integer syntax that Chromium 47 cannot parse. Reject zero just as noble's point multiplication does.
const validScalar = (value: Uint8Array): boolean =>
  value.length === 32 && ((value[31] ?? 0) & 0xf0) === 0 && !identity(value);
const wrapped = (value: Uint8Array): PairingPoint => {
  const encoded = bytes(value);
  return { value: encoded, toBytes: () => bytes(encoded) };
};

export function pointFromUniformBytes(hash: Uint8Array): PairingPoint | null {
  if (hash.length !== 64) return null;
  return wrapped(ristretto255.fromHash(hash));
}

export function multiplyPoint(y: Uint8Array, point: PairingPoint): Uint8Array<ArrayBuffer> {
  if (!validScalar(y)) throw new RangeError('Invalid Ristretto255 scalar');
  return bytes(ristretto255.scalarMult(y, point.value as Uint8Array));
}

export function multiplyEncodedPoint(
  y: Uint8Array,
  encoded: Uint8Array,
): Uint8Array<ArrayBuffer> | null {
  if (!validScalar(y) || encoded.length !== 32 || identity(encoded)) return null;
  try {
    return ristretto255.isValid(encoded) ? bytes(ristretto255.scalarMult(y, encoded)) : null;
  } catch {
    return null;
  }
}
