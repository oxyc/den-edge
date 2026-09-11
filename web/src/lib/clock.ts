// This browser's clock for the record log (den-spec wire/library-v2.md §4): a device id made once, and the last
// stamp issued or seen, kept across visits so an edit here is always stamped after everything this browser read.

import { hex } from './crypto';
import { Clock, type Stamp } from './wire';

const DEVICE_KEY = 'den.deviceID';
const LAST_KEY = 'den.clock';

export interface BrowserClock {
  issue(now?: number): Stamp;
  see(stamp: Stamp): void;
}

const isStamp = (value: unknown): value is Stamp =>
  Array.isArray(value) &&
  value.length === 3 &&
  typeof value[0] === 'number' &&
  typeof value[1] === 'number' &&
  typeof value[2] === 'string';

/** Storage can throw outright (a private window, blocked site data); the clock then lasts this visit only. */
export function browserClock(storage: Storage | undefined = globalThis.localStorage): BrowserClock {
  const read = (key: string) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string) => {
    try {
      storage?.setItem(key, value);
    } catch {
      // Kept for this visit only.
    }
  };
  let device = read(DEVICE_KEY);
  if (!device || !/^[0-9a-f]{16}$/.test(device)) {
    device = hex(crypto.getRandomValues(new Uint8Array(8)));
    write(DEVICE_KEY, device);
  }
  let last: Stamp | undefined;
  try {
    const stored: unknown = JSON.parse(read(LAST_KEY) ?? 'null');
    if (isStamp(stored)) last = stored;
  } catch {
    // Starts over; the log's newest stamp is seen before any edit.
  }
  const clock = new Clock(device, last);
  return {
    issue(now = Date.now()) {
      const stamp = clock.issue(now);
      write(LAST_KEY, JSON.stringify(stamp));
      return stamp;
    },
    see(stamp) {
      clock.see(stamp);
      write(LAST_KEY, JSON.stringify(clock.current));
    },
  };
}
