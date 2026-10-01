// Moves a library to Library v3 on its own, the switch Settings used to offer as a button: den-core's v3 form, written
// by `LibraryLog.switchWebOnly`. Done only where the button was offered — a library kept only in this browser, or one
// whose devices den-core says this browser may switch (`switch_ready`, web-only) — and otherwise left for later.
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
