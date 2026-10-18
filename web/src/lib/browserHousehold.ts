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
  /**
   * Set once den-edge, read back, held everything moved from the library kept here: how many live rows each library
   * held then. The page switches to the household, and the library kept here is dropped on the next load, once
   * `recheckHousehold` finds both libraries still there with at least as many.
   */
  readonly verified?: { readonly household: number; readonly owner: number };
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
      typeof value.started !== 'boolean' ||
      (value.verified !== undefined &&
        (!Number.isSafeInteger(value.verified?.household) ||
          !Number.isSafeInteger(value.verified?.owner)))
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
 * move into the household is unfinished, and the library is opened to finish it (null), unless the move was verified:
 * then the household opens and the library kept here waits for `recheckHousehold`. A plan whose library is already
 * gone finished all but its own removal, which happens here.
 */
export function settledHousehold(
  localKey: string | null,
  storage: Storage | undefined = globalThis.localStorage,
): string | null {
  const pointer = keptHousehold(storage);
  const plan = householdPlan(storage);
  if (!plan) return pointer;
  if (pointer !== plan.householdKey) return null;
  if (localKey !== plan.stagingKey) {
    settleHouseholdPlan(storage);
    return pointer;
  }
  return plan.verified ? pointer : null;
}

/** Record that den-edge, read back, held everything moved, and how many rows each library held. True when it stuck. */
export function verifyHouseholdPlan(
  plan: HouseholdPlan,
  verified: { household: number; owner: number },
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  return keepPlan({ ...plan, verified }, storage) !== null;
}

/**
 * The next load's check before the library kept here is dropped: den-edge still serves the household and the Owner
 * library, each with at least the rows it held when the move was verified. Reads only. Null when it passes, otherwise
 * why not (the library kept here then stays, and the check runs again on the next load).
 */
export async function recheckHousehold(
  plan: HouseholdPlan,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<string | null> {
  if (!plan.verified) return 'the move was never verified';
  const { deriveKeys } = await import('./wire');
  const count = async (key: string): Promise<number | string> => {
    const keys = await deriveKeys(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));
    let live = 0;
    let since = 0;
    for (;;) {
      const response = await fetchImpl(`/lib/${keys.id}/changes?since=${since}&limit=1000`, {
        cache: 'no-store',
        headers: { 'x-den-library-token': keys.token, 'x-den-wire': '5' },
      }).catch(() => null);
      if (!response?.ok) return `den-edge answered ${response?.status ?? 'nothing'}`;
      const page = (await response.json()) as {
        entries: { seq: number; v: string | null }[];
        more: boolean;
      };
      for (const entry of page.entries) if (entry.v) live++;
      if (!page.more || !page.entries.length) return live;
      since = page.entries.at(-1)!.seq;
    }
  };
  for (const [name, key, wanted] of [
    ['household', plan.householdKey, plan.verified.household],
    ['Owner library', plan.ownerKey, plan.verified.owner],
  ] as const) {
    const held = await count(key);
    if (typeof held === 'string') return `the ${name} could not be read: ${held}`;
    if (held < wanted)
      return `the ${name} holds ${held} rows, ${wanted} when the move was verified`;
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
  'download.want',
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

/**
 * `service` as it is, but `kept` is told after each kept action it carried out, and `pending` how many kept actions are
 * on their way: a move of the library into its household knows from the two whether something was kept while it copied.
 */
export function observeKeptActions(
  service: ObservedService,
  kept: () => void,
  pending: (change: 1 | -1) => void = () => {},
): ObservedService {
  return {
    open: (options) => service.open(options),
    retry: () => service.retry(),
    command: async (command, operationId) => {
      if (!KEPT.has(command.kind))
        return operationId === undefined
          ? service.command(command)
          : service.command(command, operationId);
      pending(1);
      try {
        const result = await (operationId === undefined
          ? service.command(command)
          : service.command(command, operationId));
        kept();
        return result;
      } finally {
        pending(-1);
      }
    },
    query: (...query) => service.query(...query),
    task: (...task) => service.task(...task),
    observe: (...observation) => service.observe(...observation),
    subscribeSnapshot: (...subscription) => service.subscribeSnapshot(...subscription),
    onStatus: (listener) => service.onStatus(listener),
    close: () => service.close(),
  };
}

/**
 * What became of bringing this browser's library or household into another: `pin-required`/`pin-wrong`, ask for the
 * Owner PIN of the household joined; `refused-kids`, it has no profiles for this browser's Kids.
 */
export type JoinAnswer = 'joined' | 'failed' | 'pin-required' | 'pin-wrong' | 'refused-kids';

/** Bring this browser's library or household into the one `libraryKey` opens (`RoutedLibrary`). */
export type JoinLibrary = (
  libraryKey: string,
  options?: { pin?: string; link?: JoinLink },
) => Promise<JoinAnswer>;

/** How the browser opens the household it joins: a TV it paired with, or (none) a library key kept as a link. */
export interface JoinLink {
  readonly inboxKey: string;
  readonly name: string;
  readonly linkKey: string;
  readonly deviceId?: string;
}

/**
 * This browser's household joining another (den#295), kept before the join starts so a reload finishes it: `source`
 * is this browser's household, `destination` the one it joins.
 */
export interface HouseholdJoinPlan {
  readonly version: 1;
  readonly source: string;
  readonly destination: string;
  readonly link?: JoinLink;
}

const JOIN_KEY = 'den.household.join';

export function householdJoinPlan(
  storage: Storage | undefined = globalThis.localStorage,
): HouseholdJoinPlan | null {
  try {
    const value = JSON.parse(
      storage?.getItem(JOIN_KEY) ?? 'null',
    ) as Partial<HouseholdJoinPlan> | null;
    const link = value?.link;
    if (
      !value ||
      value.version !== 1 ||
      typeof value.source !== 'string' ||
      !KEY.test(value.source) ||
      typeof value.destination !== 'string' ||
      !KEY.test(value.destination) ||
      value.source === value.destination ||
      (link !== undefined &&
        (typeof link?.inboxKey !== 'string' ||
          typeof link.name !== 'string' ||
          typeof link.linkKey !== 'string' ||
          (link.deviceId !== undefined && typeof link.deviceId !== 'string')))
    )
      return null;
    return value as HouseholdJoinPlan;
  } catch {
    return null;
  }
}

/** Keep the join's plan; false when it did not stick, and the join must not start. */
export function keepHouseholdJoin(
  plan: HouseholdJoinPlan,
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  try {
    const text = JSON.stringify(plan);
    storage?.setItem(JOIN_KEY, text);
    return storage?.getItem(JOIN_KEY) === text;
  } catch {
    return false;
  }
}

/**
 * The join is over. `joined`: this browser no longer points at its own household, which is retired. Otherwise it was
 * given up before anything moved, and the browser keeps its household.
 */
export function settleHouseholdJoin(
  plan: HouseholdJoinPlan,
  joined: boolean,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    if (joined && storage?.getItem(HOUSEHOLD_KEY) === plan.source)
      storage.removeItem(HOUSEHOLD_KEY);
    storage?.removeItem(JOIN_KEY);
  } catch {
    // A plan left behind is settled again on the next load.
  }
}

/** The plan is done: the household is pointed at and the library it started from has moved into it. */
export function settleHouseholdPlan(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(PLAN_KEY);
  } catch {
    // A plan left behind is finished again, harmlessly, on the next load.
  }
}
