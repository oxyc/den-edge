// A browser with no TV gets a household of its own on den-edge (den#295), made the first time it keeps something.
// Until then it uses the library kept only here (`localLibrary.ts`), and den-edge is asked nothing. The plan names
// every id and key the household is made with, and is kept before any request, so a run cut off anywhere finishes
// with the same household and never makes a second one. Once made, `den.household` holds its key, as
// `den.localLibrary` holds the local one's.

import type { LibraryCommand } from './libraryServiceProtocol';
import type { LibraryServiceSupervisor } from './libraryServiceSupervisor';

const HOUSEHOLD_KEY = 'den.household';
const PLAN_KEY = 'den.household.plan';

export interface HouseholdPlan {
  readonly version: 1;
  /** The library kept only here that the household starts from: its rows move into the household. */
  readonly stagingKey: string;
  readonly householdKey: string;
  readonly attempt: string;
  readonly ownerProfile: string;
  readonly ownerKey: string;
  readonly createdAt: number;
  /** Set when the first kept action asked for the household: a reload then finishes it without waiting for another. */
  readonly started: boolean;
}

const KEY = /^[A-Za-z0-9+/]{43}=$/;
const ID = /^[0-9a-f]{32}$/;

const randomKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

/**
 * Whether den-edge lets a browser with no TV start its own household (`x-den-born-households` on the profiles
 * capability, sent only where a stranger's library is visitor-tier). Anything else, failures included, is no: the
 * browser then keeps its library to itself and den-edge is asked nothing more.
 */
export async function bornHouseholds(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  try {
    const response = await fetchImpl('/capabilities/profiles', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return response.ok && response.headers.get('x-den-born-households') === '1';
  } catch {
    return false;
  }
}

/** The key of this browser's household once it is made; null before, and where nothing can be kept. */
export function keptHousehold(
  storage: Storage | undefined = globalThis.localStorage,
): string | null {
  try {
    const key = storage?.getItem(HOUSEHOLD_KEY) ?? null;
    return key && KEY.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** The plan this browser keeps for its household, or null when there is none (or it is not one this build reads). */
export function householdPlan(
  storage: Storage | undefined = globalThis.localStorage,
): HouseholdPlan | null {
  try {
    const value = JSON.parse(storage?.getItem(PLAN_KEY) ?? 'null') as Partial<HouseholdPlan> | null;
    if (
      !value ||
      value.version !== 1 ||
      typeof value.stagingKey !== 'string' ||
      !KEY.test(value.stagingKey) ||
      typeof value.householdKey !== 'string' ||
      !KEY.test(value.householdKey) ||
      typeof value.ownerKey !== 'string' ||
      !KEY.test(value.ownerKey) ||
      typeof value.attempt !== 'string' ||
      !ID.test(value.attempt) ||
      typeof value.ownerProfile !== 'string' ||
      !ID.test(value.ownerProfile) ||
      !Number.isSafeInteger(value.createdAt) ||
      typeof value.started !== 'boolean'
    )
      return null;
    return value as HouseholdPlan;
  } catch {
    return null;
  }
}

function keepPlan(plan: HouseholdPlan, storage: Storage | undefined): HouseholdPlan | null {
  try {
    const text = JSON.stringify(plan);
    storage?.setItem(PLAN_KEY, text);
    // Read back: a plan that did not stick would make a different household on the next try.
    return storage?.getItem(PLAN_KEY) === text ? plan : null;
  } catch {
    return null;
  }
}

/**
 * The plan for a browser whose own library `stagingKey` was just made: every id and key the household will have.
 * Kept in this browser only; den-edge hears of none of it until the first kept action.
 */
export function planHousehold(
  stagingKey: string,
  storage: Storage | undefined = globalThis.localStorage,
  now: () => number = Date.now,
): HouseholdPlan | null {
  return keepPlan(
    {
      version: 1,
      stagingKey,
      householdKey: randomKey(),
      attempt: randomId(),
      ownerProfile: randomId(),
      ownerKey: randomKey(),
      createdAt: now(),
      started: false,
    },
    storage,
  );
}

/**
 * Mark the plan started, before its first request, from the library kept here now (another tab's first visit may have
 * replaced the one the plan was made beside).
 */
export function startHouseholdPlan(
  plan: HouseholdPlan,
  stagingKey: string,
  storage: Storage | undefined = globalThis.localStorage,
): HouseholdPlan | null {
  return plan.started && plan.stagingKey === stagingKey
    ? plan
    : keepPlan({ ...plan, stagingKey, started: true }, storage);
}

/**
 * On load, the household to open: the one this browser finished making. A plan still kept with its library means the
 * move into the household is unfinished, and the library is opened to finish it (null); a plan whose library is
 * already gone finished all but its own removal, which happens here.
 */
export function settledHousehold(
  localKey: string | null,
  storage: Storage | undefined = globalThis.localStorage,
): string | null {
  const pointer = keptHousehold(storage);
  const plan = householdPlan(storage);
  if (!plan) return pointer;
  if (pointer === plan.householdKey && localKey !== plan.stagingKey) {
    settleHouseholdPlan(storage);
    return pointer;
  }
  return null;
}

/** Point this browser at its household, once den-edge holds it. True when the pointer stuck. */
export function commitHousehold(
  plan: HouseholdPlan,
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  try {
    storage?.setItem(HOUSEHOLD_KEY, plan.householdKey);
    return storage?.getItem(HOUSEHOLD_KEY) === plan.householdKey;
  } catch {
    return false;
  }
}

/**
 * What a person keeps: the actions that start the household. Browsing keeps nothing, and neither does what the page
 * writes by itself (a device heartbeat, a remembered remux address, retained Home state).
 */
const KEPT: ReadonlySet<LibraryCommand['kind']> = new Set<LibraryCommand['kind']>([
  'watchlist.add',
  'library.remove',
  'reaction.set',
  'episode-watched.set',
  'season-watched.set',
  'watched.set',
  'continue-dismissed.set',
  'progress.record',
  'preferences.patch',
  'api-key.set',
  'parental-pin.set',
  'remote-access.set',
  'plugin.install',
  'plugin.remove',
  'plugin-trust.set',
  'server.patch',
  'simkl.connect',
  'download.enqueue',
]);

type ObservedService = Pick<
  LibraryServiceSupervisor,
  | 'open'
  | 'retry'
  | 'command'
  | 'query'
  | 'task'
  | 'observe'
  | 'subscribeSnapshot'
  | 'onStatus'
  | 'close'
>;

/** `service` as it is, but `kept` is told after each kept action it carried out. */
export function observeKeptActions(service: ObservedService, kept: () => void): ObservedService {
  return {
    open: (options) => service.open(options),
    retry: () => service.retry(),
    command: async (command, operationId) => {
      const result = await (operationId === undefined
        ? service.command(command)
        : service.command(command, operationId));
      if (KEPT.has(command.kind)) kept();
      return result;
    },
    query: (...query) => service.query(...query),
    task: (...task) => service.task(...task),
    observe: (...observation) => service.observe(...observation),
    subscribeSnapshot: (...subscription) => service.subscribeSnapshot(...subscription),
    onStatus: (listener) => service.onStatus(listener),
    close: () => service.close(),
  };
}

/** The plan is done: the household is pointed at and the library it started from has moved into it. */
export function settleHouseholdPlan(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(PLAN_KEY);
  } catch {
    // A plan left behind is finished again, harmlessly, on the next load.
  }
}
