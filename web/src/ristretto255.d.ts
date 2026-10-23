declare module 'ristretto255' {
  interface Ristretto255 {
    fromHash(hash: Uint8Array): Uint8Array;
    isValid(point: Uint8Array): boolean;
    scalarMult(scalar: Uint8Array, point: Uint8Array): Uint8Array;
  }

  const ristretto255: Ristretto255;
  export default ristretto255;
}
