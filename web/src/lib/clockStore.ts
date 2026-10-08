// The durable hybrid clock owned by the library service. Its state lives in the same worker-safe vault as the
// library, rather than in a page global, and every operation is committed before its result becomes observable.

import { hex } from './crypto';
import { exclusive as browserExclusive } from './exclusive';
import type { Vault } from './localVault';
import { Clock, compareStamps, type Stamp } from './wire';

const utf8 = new TextEncoder();
const text = new TextDecoder();

export const CLOCK_STORE_KEY = 'device-clock.v1';

interface StoredClock {
  version: 1;
  device: string;
  last: Stamp;
  historicalCounter: number;
}

/** Values read from the old localStorage clock by the page and handed to the service at startup. */
export interface LegacyClockBootstrap {
  device?: unknown;
  last?: unknown;
}

export interface ClockStore {
  readonly device: string;
  issue(now?: number): Promise<Stamp>;
  /** Reserve collision-free stamps whose physical component must remain an imported event time. */
  historical(milliseconds: readonly number[]): Promise<Stamp[]>;
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
  /** Injectable Web Locks adapter. The default gracefully runs unlocked where Web Locks are unavailable. */
  exclusive?: Exclusive;
}

export type Exclusive = <T>(name: string, work: () => Promise<T>) => Promise<T>;

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
    const historicalCounter = candidate.historicalCounter ?? 0;
    if (!Number.isSafeInteger(historicalCounter) || historicalCounter < 0) return undefined;
    return {
      version: 1,
      device: candidate.device,
      last: copyStamp(candidate.last),
      historicalCounter,
    };
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
  const lockName = `den.clock.${key}`;
  const exclusively = options.exclusive ?? browserExclusive;
  const update = vault.update?.bind(vault);
  const seed = (): StoredClock => {
    const device = validDevice(options.legacy?.device)
      ? options.legacy.device
      : (options.createDevice ?? randomDevice)();
    if (!validDevice(device))
      throw new Error('clock device must be 16 lowercase hexadecimal characters');
    const last = validStamp(options.legacy?.last)
      ? copyStamp(options.legacy.last)
      : ([0, 0, ''] as Stamp);
    return { version: 1, device, last, historicalCounter: 0 };
  };
  let state: StoredClock;
  if (update) {
    const opened = decode(
      await update(key, (current) => {
        const durable = decode(current);
        return durable ? current! : encode(seed());
      }),
    );
    if (!opened) throw new Error('atomic clock update returned invalid state');
    state = opened;
  } else {
    state = await exclusively(lockName, async () => {
      const durable = decode(await vault.get(key));
      if (durable) return durable;
      const seeded = seed();
      await vault.put(key, encode(seeded));
      return seeded;
    });
  }

  let tail: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const atomically = async (change: (current: StoredClock) => StoredClock) => {
    const bytes = await update!(key, (current) => {
      const durable = decode(current) ?? state;
      const changed = change(durable);
      return current && changed === durable ? current : encode(changed);
    });
    const durable = decode(bytes);
    if (!durable) throw new Error('atomic clock update returned invalid state');
    state = durable;
    return durable;
  };
  const refresh = async () => {
    const durable = decode(await vault.get(key));
    if (durable) state = durable;
    else await vault.put(key, encode(state));
  };
  const commit = async (next: Stamp) => {
    const owned = copyStamp(next);
    const updated: StoredClock = { ...state, version: 1, device: state.device, last: owned };
    await vault.put(key, encode(updated));
    state = updated;
  };

  return {
    get device() {
      return state.device;
    },
    issue(now = Date.now()) {
      return serialized(async () => {
        if (update) {
          const updated = await atomically((current) => ({
            ...current,
            version: 1,
            device: current.device,
            last: new Clock(current.device, current.last).issue(now),
          }));
          return copyStamp(updated.last);
        }
        return exclusively(lockName, async () => {
          await refresh();
          const stamp = new Clock(state.device, state.last).issue(now);
          await commit(stamp);
          return copyStamp(stamp);
        });
      });
    },
    historical(milliseconds) {
      return serialized(async () => {
        if (
          milliseconds.some(
            (value) => !Number.isSafeInteger(value) || value < 0,
          )
        )
          throw new Error('invalid historical clock time');
        if (!milliseconds.length) return [];
        let reserved: Stamp[] = [];
        const reserve = (current: StoredClock): StoredClock => {
          if (current.historicalCounter + milliseconds.length > Number.MAX_SAFE_INTEGER)
            throw new Error('historical clock counter exhausted');
          reserved = milliseconds.map(
            (at, index): Stamp => [at, current.historicalCounter + index + 1, current.device],
          );
          const newest = reserved.reduce(
            (last, stamp) => (compareStamps(stamp, last) > 0 ? stamp : last),
            current.last,
          );
          return {
            ...current,
            historicalCounter: current.historicalCounter + reserved.length,
            last: copyStamp(newest),
          };
        };
        if (update) await atomically(reserve);
        else
          await exclusively(lockName, async () => {
            await refresh();
            const next = reserve(state);
            await vault.put(key, encode(next));
            state = next;
          });
        return reserved.map(copyStamp);
      });
    },
    see(stamp) {
      return serialized(async () => {
        if (!validStamp(stamp)) throw new Error('invalid clock stamp');
        if (update) {
          await atomically((current) =>
            compareStamps(stamp, current.last) > 0
              ? { ...current, last: copyStamp(stamp) }
              : current,
          );
          return;
        }
        return exclusively(lockName, async () => {
          await refresh();
          if (compareStamps(stamp, state.last) > 0) await commit(stamp);
        });
      });
    },
    current() {
      return serialized(async () => {
        if (update) return copyStamp((await atomically((current) => current)).last);
        return exclusively(lockName, async () => {
          await refresh();
          return copyStamp(state.last);
        });
      });
    },
  };
}
