// What the in-app player was showing, kept in its own address so a reload, a bookmark or a shared link opens it the
// same way: `/tv/90282-the-morning-show?season=2&episode=1&play=1&source=…&via=remux&audio=1&subs=sv&t=1312`.
//
// Only the viewer's own choices are written, and only stable, public identities: the release by its filename (the
// identity Scout and Hearth already select by, and `source=` already carries from Sources), the delivery path, an
// audio track's index in that release, a subtitle's language and picker identity, its timing offset and a whole
// second to resume at. Never a playlist, a ticket, a signed or expiring URL, or anything a provider hands back as a
// capability: those are refused here even when asked to be written.
//
// Everything read back is validated and only a hint. The title's own Play still runs the profile's content policy
// first, and the release is asked for through the session's own Hearth (a guest's grant scopes that), so an address
// can name a stream but never open one the profile or grant would not.

import { parseRoute } from './route';
import { currentAppPath } from './runtimeUrl';

export interface PlayerAddress {
  /** The release the viewer chose, by filename. */
  source?: string;
  /** The delivery path the viewer chose. */
  via?: 'torbox' | 'remux';
  /** The audio track the viewer chose, by index in `source`. */
  audio?: number;
  /** The subtitle the viewer chose: a language and, where it has a safe one, the picker's own identity; or Off. */
  subtitles?: { language: string; track?: string } | 'off';
  /** The viewer's subtitle timing offset, in seconds. */
  subtitleDelay?: number;
  /** Where playback was, in whole seconds. */
  at?: number;
}

/** The player's own query keys, in the order they are written after the route's own. */
const KEYS = ['source', 'via', 'audio', 'subs', 'subtrack', 'subdelay', 't'] as const;

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
/** A picker identity: provider ids and `remux:built-in:0:sv`. Nothing with `/`, `?` or `=` — no URL fits. */
const TRACK = /^[A-Za-z0-9:._-]{1,96}$/;
const MAX_SOURCE = 512;
/** Whether `value` reads as a URL or a credential rather than a release name. */
const capability = (value: string) => /:\/\/|[?#]|^\/|\b(?:sig|token|ticket)=/i.test(value);

/** The player's state in `search` (`?…`), each value validated; anything unrecognised is left out. */
export function parsePlayerAddress(search: string): PlayerAddress {
  const params = new URLSearchParams(search);
  const source = params.get('source') ?? '';
  const via = params.get('via');
  const audio = params.get('audio') ?? '';
  const subs = params.get('subs') ?? '';
  const track = params.get('subtrack') ?? '';
  const delay = params.get('subdelay') ?? '';
  const at = params.get('t') ?? '';
  const delaySeconds = Number(delay);
  return {
    ...(source && source.length <= MAX_SOURCE && !capability(source) ? { source } : {}),
    ...(via === 'torbox' || via === 'remux' ? { via } : {}),
    ...(/^(?:0|[1-9]\d?)$/.test(audio) ? { audio: Number(audio) } : {}),
    ...(subs === 'off'
      ? { subtitles: 'off' as const }
      : LANGUAGE.test(subs)
        ? { subtitles: { language: subs, ...(TRACK.test(track) ? { track } : {}) } }
        : {}),
    ...(/^-?\d{1,2}(?:\.5)?$/.test(delay) && delaySeconds !== 0 && Math.abs(delaySeconds) <= 30
      ? { subtitleDelay: delaySeconds }
      : {}),
    ...(/^\d{1,6}$/.test(at) && Number(at) > 0 ? { at: Number(at) } : {}),
  };
}

/** `path` with the player's keys replaced by `state`'s, and every other part of it left as it was. */
export function withPlayerAddress(path: string, state: PlayerAddress): string {
  const url = new URL(path, 'https://den.invalid');
  for (const key of KEYS) url.searchParams.delete(key);
  const set = (key: (typeof KEYS)[number], value: string | number | undefined) => {
    if (value !== undefined) url.searchParams.set(key, String(value));
  };
  const { source, via, audio, subtitles, subtitleDelay, at } = state;
  set('source', source && source.length <= MAX_SOURCE && !capability(source) ? source : undefined);
  set('via', via);
  set('audio', audio !== undefined && Number.isInteger(audio) && audio >= 0 ? audio : undefined);
  if (subtitles === 'off') set('subs', 'off');
  else if (subtitles && LANGUAGE.test(subtitles.language)) {
    set('subs', subtitles.language);
    set('subtrack', subtitles.track && TRACK.test(subtitles.track) ? subtitles.track : undefined);
  }
  set('subdelay', subtitleDelay ? Math.round(subtitleDelay * 2) / 2 : undefined);
  set('t', at !== undefined && at >= 1 ? Math.floor(at) : undefined);
  return url.pathname + url.search;
}

/** The title, and its episode, a player is playing: what its address must name for the state in it to be its. */
export interface PlayerTarget {
  type: 'movie' | 'tv';
  id: number;
  season?: number;
  episode?: number;
}

/** Whether `path` is `target`'s player address: its title page, that episode, with `play=1`. */
function addresses(path: string, target: PlayerTarget): boolean {
  const route = parseRoute(path);
  return (
    route.page === 'title' &&
    route.play === true &&
    route.type === target.type &&
    route.id === target.id &&
    route.season === target.season &&
    route.episode === target.episode
  );
}

/** The app path on screen, as the Router reads it: a packaged TV's is in its fragment. */
const appPath = () =>
  __DEN_TV_PACKAGED__ ? currentAppPath() : location.pathname + location.search;

/** The state this document's address holds for `target`'s player; nothing where it addresses another. */
export function readPlayerAddress(target: PlayerTarget): PlayerAddress {
  const path = appPath();
  return addresses(path, target)
    ? parsePlayerAddress(new URL(path, 'https://den.invalid').search)
    : {};
}

/**
 * Rewrite this entry's address to hold `state`, in place: no history entry, and the Router's own state kept. Only
 * while the address is still `target`'s player — after a close or an advance it belongs to someone else.
 */
export function writePlayerAddress(target: PlayerTarget, state: PlayerAddress): void {
  const path = appPath();
  if (!addresses(path, target)) return;
  const next = withPlayerAddress(path, state);
  if (next === path) return;
  try {
    history.replaceState(history.state, '', next);
  } catch (error) {
    // Safari refuses a page more than 100 history writes in ten seconds; the next write carries the same state.
    console.warn('den: could not keep the player’s state in the address', error);
  }
}
