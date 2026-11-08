// Den's own Cast receiver (`web/cast/receiver.html`): which receiver the cast page launches, and the report of what that
// receiver's TV plays, which the player asks Hearth with in place of a Chromecast model's profile.

import type { Playable } from './playable';

/** The application id Google's Cast console issued for Den's receiver, launched where `CAST_APP_ID` names none. */
export const DEN_RECEIVER_APP_ID = '5718B443';

/** The custom message namespace the cast page and Den's receiver talk on. */
export const RECEIVER_NAMESPACE = 'urn:x-cast:fi.oxy.den';

/** How long the cast page waits for the receiver's report before it asks with the chosen model's profile instead. */
export const RECEIVER_REPORT_MS = 2_000;

/** What Den's receiver answers the cast page's `den-capabilities` with. */
export interface ReceiverReport {
  type: 'den-capabilities';
  playable: Playable;
  /** What the TV showed it takes beyond `playable`, for the console a viewer can share. Not sent to Hearth. */
  details?: Record<string, unknown>;
}

const LEVELS = [
  'h264',
  'h264High10',
  'hevcMain',
  'hevcMain10',
  'hevcHighTier',
  'av1',
  'av1Main10',
] as const;
const FLAGS = [
  'hdr',
  'eac3',
  'aacMultichannel',
  'av1Hdr',
  'flac',
  'aac71',
  'vp9',
  'vp9Profile2',
] as const;

/** A `Playable` exactly as `playable()` builds one, or null: anything else a receiver sent is not asked with. */
export function playableOf(value: unknown): Playable | null {
  if (!value || typeof value !== 'object') return null;
  const can = value as Record<string, unknown>;
  const dv = can.dolbyVision as Record<string, unknown> | undefined;
  if (
    !LEVELS.every(
      (key) =>
        Number.isInteger(can[key]) && (can[key] as number) >= 0 && (can[key] as number) <= 255,
    ) ||
    !FLAGS.every((key) => typeof can[key] === 'boolean') ||
    typeof dv?.p5 !== 'boolean' ||
    typeof dv.p8 !== 'boolean'
  )
    return null;
  const out = {} as Record<string, unknown>;
  for (const key of [...LEVELS, ...FLAGS]) out[key] = can[key];
  out.dolbyVision = { p5: dv.p5, p8: dv.p8 };
  return out as unknown as Playable;
}

const OPT_IN_KEY = 'den.castReceiver';

/**
 * This browser's opt-in to Den's receiver while the box still launches Google's: `?cast-receiver=den` turns it on and
 * `?cast-receiver=default` off, kept in this origin's storage. Den's receiver is tried on a real TV from one browser
 * before `CAST_APP_ID` turns it on for everyone.
 */
export function castReceiverOptIn(
  search = globalThis.location?.search ?? '',
  storage?: Storage,
): boolean {
  try {
    const store = storage ?? globalThis.localStorage;
    const asked = new URLSearchParams(search).get('cast-receiver');
    if (asked === 'den') store?.setItem(OPT_IN_KEY, 'den');
    else if (asked === 'default') store?.removeItem(OPT_IN_KEY);
    return store?.getItem(OPT_IN_KEY) === 'den';
  } catch {
    return false;
  }
}
