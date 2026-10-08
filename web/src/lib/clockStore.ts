// The durable hybrid clock owned by the library service. Its state lives in the same worker-safe vault as the
// library, rather than in a page global, and every operation is committed before its result becomes observable.

import { hex } from './crypto';
import type { Vault } from './localVault';
import { Clock, compareStamps, type Stamp } from './wire';

const utf8 = new TextEncoder();
const text = new TextDecoder();

export const CLOCK_STORE_KEY = 'device-clock.v1';

interface StoredClock {
  version: 1;
  device: string;
  last: Stamp;
}

/** Values read from the old localStorage clock by the page and handed to the service at startup. */
export interface LegacyClockBootstrap {
  device?: unknown;
  last?: unknown;
}

export interface ClockStore {
  readonly device: string;
  issue(now?: number): Promise<Stamp>;
  see(stamp: Stamp): Promise<void>;
  /** Waits for earlier operations and returns a copy of the last stamp issued or seen. */
  current(): Promise<Stamp>;
}

export interface ClockStoreOptions {
  /** Override only for isolated stores and tests. The default is shared across libraries, as the old clock was. */
  key?: string;
  /** Consulted only when no valid durable state exists; a successful open persists the imported state. */
  legacy?: LegacyClockBootstrap;
  /** Injectable to make device creation deterministic in tests. */
  createDevice?: () => string;
}

const validDevice = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

const validStamp = (value: unknown): value is Stamp =>
  Array.isArray(value) &&
  value.length === 3 &&
  Number.isSafeInteger(value[0]) &&
  value[0] >= 0 &&
  Number.isSafeInteger(value[1]) &&
  value[1] >= 0 &&
  typeof value[2] === 'string';

const copyStamp = (stamp: Stamp): Stamp => [stamp[0], stamp[1], stamp[2]];

const decode = (bytes: Uint8Array | undefined): StoredClock | undefined => {
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(text.decode(bytes));
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<StoredClock>;
    if (candidate.version !== 1 || !validDevice(candidate.device) || !validStamp(candidate.last))
      return undefined;
    return { version: 1, device: candidate.device, last: copyStamp(candidate.last) };
  } catch {
    return undefined;
  }
};

const encode = (state: StoredClock): Uint8Array => utf8.encode(JSON.stringify(state));

const randomDevice = () => hex(globalThis.crypto.getRandomValues(new Uint8Array(8)));

/**
 * Opens the service's clock. Durable state always wins; `legacy` is an import seed used only if that state is absent
 * or invalid. Operations on the returned instance are serialized and the queue remains usable after a failed write.
 */
export async function openClockStore(
  vault: Vault,
  options: ClockStoreOptions = {},
): Promise<ClockStore> {
  const key = options.key ?? CLOCK_STORE_KEY;
  let state = decode(await vault.get(key));
  if (!state) {
    const device = validDevice(options.legacy?.device)
      ? options.legacy.device
      : (options.createDevice ?? randomDevice)();
    if (!validDevice(device))
      throw new Error('clock device must be 16 lowercase hexadecimal characters');
    const last = validStamp(options.legacy?.last)
      ? copyStamp(options.legacy.last)
      : ([0, 0, ''] as Stamp);
    state = { version: 1, device, last };
    await vault.put(key, encode(state));
  }

  const device = state.device;
  let last = state.last;
  let tail: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const commit = async (next: Stamp) => {
    const owned = copyStamp(next);
    await vault.put(key, encode({ version: 1, device, last: owned }));
    last = owned;
  };

  return {
    device,
    issue(now = Date.now()) {
      return serialized(async () => {
        const stamp = new Clock(device, last).issue(now);
        await commit(stamp);
        return copyStamp(stamp);
      });
    },
    see(stamp) {
      return serialized(async () => {
        if (!validStamp(stamp)) throw new Error('invalid clock stamp');
        if (compareStamps(stamp, last) > 0) await commit(stamp);
      });
    },
    current() {
      return serialized(async () => copyStamp(last));
    },
  };
}
