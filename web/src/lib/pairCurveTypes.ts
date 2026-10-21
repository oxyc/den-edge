export interface PairingPoint {
  /** Canonical 32-byte Ristretto encoding. */
  toBytes(): Uint8Array<ArrayBuffer>;
  /** Adapter-private representation: a noble point or canonical bytes. */
  readonly value: unknown;
}
