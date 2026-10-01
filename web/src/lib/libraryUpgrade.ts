// Moves a library to Library v3 on its own, the switch Settings used to offer as a button: den-core's v3 form, written
// by `LibraryLog.switchWebOnly`. Done only where the button was offered — a library kept only in this browser, or one
// whose devices den-core says this browser may switch (`switch_ready`, web-only) — and otherwise left for later.
// And on from v3 to v4, which any v4 build does by itself (`switchLibraryToV4`).
import { browserClock } from './clock';
import { librarySwitchState } from './librarySwitch';
import type { LibraryLog } from './log';
import { readApiKey } from './prefs';
import { readDevices } from '../settings/values';
import { fetchSimklClientId, simklAccountID } from '../settings/simkl';
import type { Stamp } from './wire';

/** How long after a switch that didn't happen before it is tried again, so a library that can't switch isn't asked
 * to on every 30-second refresh. */
const RETRY_MS = 10 * 60_000;

const tried = new WeakMap<LibraryLog, number>();

/**
 * Switch `log` to v3 when it may be, at most once per `RETRY_MS`. True when it switched. `local` is a library kept only
 * in this browser: no other device can hold it, so nothing has to be ready first.
 */
export async function upgradeLibrary(
  log: LibraryLog,
  local: boolean,
  now = Date.now(),
): Promise<boolean> {
  if (log.wireMinimum >= 3 || log.moved || log.upgradeRequired) return false;
  const last = tried.get(log);
  if (last !== undefined && now - last < RETRY_MS) return false;
  tried.set(log, now);
  const clock = browserClock();
  clock.see(log.newestStamp());
  if (!local) {
    const state = librarySwitchState(readDevices(log.settings('devices')), clock.device, now);
    if (!state.performable || !state.webOnly) return false;
  }
  // A connected SIMKL account goes into the v3 library as a connection, which needs its account id: unreachable now,
  // the switch waits for the next try rather than dropping the connection.
  const keys = log.settings('keys');
  const token = readApiKey(keys, 'simkl');
  let simkl: { account: string; credential: string; connectedAt: Stamp } | undefined;
  if (token) {
    const clientId = await fetchSimklClientId();
    const account = clientId && (await simklAccountID(clientId, token));
    const connectedAt = keys?.values.simkl?.at;
    if (!account || !connectedAt) {
      console.info('den: Library v3 waits for SIMKL to be reachable');
      return false;
    }
    simkl = { account, credential: token, connectedAt };
  }
  const switched = await log.switchWebOnly({
    performer: clock.device,
    stamp: clock.issue(),
    simkl,
  });
  if (switched) console.info('den: the library switched to Library v3');
  else console.warn('den: the library could not switch to Library v3; trying again later');
  return switched;
}

/** How long after a switch to v4 that didn't happen it is tried again while the page stays open (§10 step 3). */
const V4_RETRY_MS = 60 * 60_000;

/** The den-edge release from which a library can be at minimum 4: it takes v4's larger values (§13). */
const V4_EDGE = [0, 242, 1];

const triedV4 = new WeakMap<LibraryLog, number>();

/**
 * Library v4 §10: the first v4 build to open a v3 library converts it, with no prompt — once the den-edge it lives
 * on takes minimum 4. Tried at once, and after a try that didn't switch, again an hour later (and on the next
 * launch). True when this browser switched it, which is the one that says so.
 */
export async function switchLibraryToV4(
  log: LibraryLog,
  now = Date.now(),
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  if (!log.needsV4) return false;
  const last = triedV4.get(log);
  if (last !== undefined && now - last < V4_RETRY_MS) return false;
  triedV4.set(log, now);
  if (!(await edgeTakesV4(fetchImpl))) {
    console.info('den: Library v4 waits for den-edge to take it');
    return false;
  }
  const clock = browserClock();
  return log.switchToV4(clock.device);
}

async function edgeTakesV4(fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('/version');
    const { version } = (await res.json()) as { version?: unknown };
    if (typeof version !== 'string') return false;
    const parts = version.split(/[.-]/).slice(0, 3).map(Number);
    for (let i = 0; i < 3; i++) {
      const [have, need] = [parts[i] ?? 0, V4_EDGE[i]!];
      if (have !== need) return have > need;
    }
    return true;
  } catch {
    return false;
  }
}
