import { syncPolicy } from './syncCore';
import type { DeviceEntry } from '../settings/values';

export interface SwitchBlocker {
  device?: string;
  reason: 'format' | 'handoff' | 'waiting_commands' | 'facade';
}

export interface LibrarySwitchState {
  offered: boolean;
  performable: boolean;
  blockers: SwitchBlocker[];
  webOnly: boolean;
}

/** Build the den-core switch gate from the sealed device row. No readiness rule lives in Svelte. */
export function librarySwitchState(
  devices: readonly DeviceEntry[],
  performer: string,
  now: number,
): LibrarySwitchState {
  const connected = [...new Set(devices.flatMap((device) => device.delivers))];
  const webOnly = devices.every((device) => device.facade.length === 0);
  const result = syncPolicy<Omit<LibrarySwitchState, 'webOnly'>>({
    op: 'switch_ready',
    input: {
      now,
      performer,
      devices: devices.map((device) => ({
        id: device.id,
        kind: device.kind === 'tv' ? 'tv' : 'web',
        seen: device.seen,
        format: device.format ?? 0,
        delivers: device.delivers,
        handoff: device.delivers.every((identity) => {
          const split = identity.indexOf(':');
          if (split < 1) return false;
          const provider = identity.slice(0, split);
          const account = identity.slice(split + 1);
          try {
            return JSON.parse(device.handoff[provider] ?? '{}').account === account;
          } catch {
            return false;
          }
        }),
      })),
      // `switch_ready` needs only the presence of a connected/facade provider for this gate. A web performer has
      // no facade, so a disconnected provider another device still serves also prevents it from performing.
      connected: [...connected, ...devices.flatMap((device) => device.facade)],
      waiting: devices.some((device) => Object.values(device.waiting).some((count) => count > 0)),
      facade: webOnly,
    },
  });
  return { ...result, webOnly };
}
