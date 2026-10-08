// Feedback after "Play on TV" (den-edge#235). The issue's own spec spelled out a TV→browser reply path and a
// 120 s/45 s ladder of outcomes; the owner asked for something simpler instead: one toast, updated in place —
// "Sent to <TV>…", a hint if the TV hasn't opened Den after a bit, and "Playing on <TV>" once it clearly has.
//
// "Clearly has" is a fresh position delivered by the library service on the sent title, written after the send, that
// this browser did not write itself. The record log drops which device wrote a position once it is merged
// (`library.ts`'s `applyLog`), so
// this does not try to match the TV's exact device id the way the fuller spec did — it reads "fresh and after we
// sent it" as "the TV", which is the whole of what a Play press is waiting to see.

import { stillQueued } from './inbox';
import type { Link } from './links.svelte';
import type { LibrarySession } from './librarySession.svelte';
import { LIVE_MS } from './livePosition';

/** How often den-edge's read-only "is it still queued" peek is asked while waiting (`POST /inbox/pending`). */
export const PEEK_MS = 2_000;
/** No response from the TV by here, and the toast says so — the owner's own number. */
export const HINT_MS = 10_000;
/** Past this the TV's own `playFreshness` would ignore the message anyway, so polling on makes no further point. */
export const GIVE_UP_MS = 120_000;

export interface PlayOnTvInput {
  now: number;
  sentAt: number;
  tvName: string;
  /** Whether den-edge's queue still holds the message; null before the first peek answers, or after a failed one. */
  queued: boolean | null;
  /** A fresh position has shown up for the title since it was sent. */
  playing: boolean;
}

export interface PlayOnTvStatus {
  message: string;
  /** Final: this send's toast will not change again, and polling for it should stop. */
  done: boolean;
}

/** Pure: what the toast should say, given what is known so far. No clock, storage or network of its own. */
export function playOnTvStatus({
  now,
  sentAt,
  tvName,
  queued,
  playing,
}: PlayOnTvInput): PlayOnTvStatus {
  if (playing) return { message: `Playing on ${tvName}`, done: true };
  const elapsed = now - sentAt;
  // `queued === false` is den-edge's word that the TV took it, so the hint — which exists only to say Den might
  // not be open — would be a false alarm once that's known, even past HINT_MS.
  const needsHint = elapsed >= HINT_MS && queued !== false;
  const message = needsHint
    ? `Sent to ${tvName}… Den needs to be open on ${tvName}.`
    : `Sent to ${tvName}…`;
  return { message, done: elapsed >= GIVE_UP_MS };
}

/**
 * Tracks one "Play on TV" send end to end: peeks `stillQueued` on a timer and drives `session.notify` from
 * `playOnTvStatus`. The "is it playing" half is left to whoever can see the library — `observe()` is fed the
 * library's Continue Watching entries each time the page pulls — because this module has no view of the library
 * itself and shouldn't need one to stay testable.
 *
 * Only one send is tracked at a time: `start` replaces whatever the previous one was doing, same as the toast it
 * drives can only say one thing at once.
 */
export class PlayOnTvTracker {
  /** A send is being tracked: the library pull should run at its fast, "something's live" cadence, same as
   * actual playback does, so the toast can resolve quickly rather than at the slow poll. */
  active = $state(false);
  private sentAt = 0;
  private tvName = '';
  private link: Pick<Link, 'inboxKey'> | null = null;
  private sealed = '';
  private title: { type: string; id: number } | null = null;
  private queued: boolean | null = null;
  private isPlaying = false;
  private peekTimer?: ReturnType<typeof setInterval>;
  private giveUpTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;

  constructor(
    private readonly session: Pick<LibrarySession, 'notify'>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** A fresh send: `sealed` is what `sendToTV` appended, for the TV named `tvName`, of `title`. */
  start(
    link: Pick<Link, 'inboxKey'>,
    sealed: string,
    tvName: string,
    title: { type: string; id: number },
  ) {
    this.stop();
    this.generation++;
    this.active = true;
    this.link = link;
    this.sealed = sealed;
    this.tvName = tvName;
    this.title = title;
    this.sentAt = this.now();
    this.queued = null;
    this.isPlaying = false;
    this.render();
    const generation = this.generation;
    this.peekTimer = setInterval(() => void this.peek(generation), PEEK_MS);
    this.giveUpTimer = setTimeout(() => this.render(), GIVE_UP_MS);
  }

  /**
   * Fed the library's Continue Watching entries each time the page pulls. A fresh position (`livePosition`) for
   * the title being tracked, written after it was sent, reads as the TV having started it.
   */
  observe(entries: { title: { type: string; id: number }; seconds?: number; at?: number }[]) {
    if (!this.link || !this.title) return;
    const entry = entries.find(
      (e) => e.title.type === this.title?.type && e.title.id === this.title.id,
    );
    const fresh =
      entry?.at !== undefined &&
      entry.at > this.sentAt &&
      entry.seconds !== undefined &&
      this.now() - entry.at <= LIVE_MS;
    if (fresh === this.isPlaying) return;
    this.isPlaying = fresh;
    this.render();
  }

  /** Stop tracking this send — a new one starting, or the page giving up on it (navigation, unmount). */
  stop() {
    this.generation++;
    this.active = false;
    this.link = null;
    this.title = null;
    clearInterval(this.peekTimer);
    clearTimeout(this.giveUpTimer);
    this.peekTimer = undefined;
    this.giveUpTimer = undefined;
  }

  private async peek(generation: number) {
    if (!this.link) return;
    const queued = await stillQueued(this.link, this.sealed, this.fetchImpl);
    // A failed peek (null) is ignored outright — the next tick asks again — and a send replaced or stopped while
    // this was in flight must not resurrect a toast for it.
    if (generation !== this.generation || queued === null) return;
    this.queued = queued;
    this.render();
  }

  private render() {
    if (!this.link) return;
    const status = playOnTvStatus({
      now: this.now(),
      sentAt: this.sentAt,
      tvName: this.tvName,
      queued: this.queued,
      playing: this.isPlaying,
    });
    this.session.notify(status.message, status.done ? undefined : { holdMs: Infinity });
    if (status.done) this.stop();
  }
}
