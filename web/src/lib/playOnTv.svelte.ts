// Feedback after "Play on TV" (den-edge#235, oxyc/den#476). One toast, updated in place.
//
// A TV that reports play results (den-spec wire/play-results-v1.md) says itself how the play went: "Preparing
// source on <TV>…", "Playing on <TV>", or why not. Only its `playing` result says Playing. Until it speaks, the toast
// says what this browser knows: sent, waking a TV that was not listening, or taken from the queue.
//
// A TV too old to report results gets the toast it always had: "Sent to <TV>…", a hint if the TV hasn't opened Den
// after a bit, and "Playing on <TV>" once a fresh position on the sent title, written after the send, shows up. The
// record log drops which device wrote a position once it is merged (`library.ts`'s `applyLog`), so that inference
// cannot tell the TV from another device playing the same title; a TV with results never uses it.

import { stillQueued } from './inbox';
import type { Link } from './links.svelte';
import type { ProfileSession } from './profileSession.svelte';
import { LIVE_MS } from './livePosition';
import { i18n } from './i18n.svelte';
import { watchResults, type PlayResult } from './playResults';
import { relayFetch } from './relayFetch';

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
  /** A fresh position has shown up for the title since it was sent (a TV without results only). */
  playing: boolean;
  /** The TV reports play results; `result` is the strongest it has sent so far (play-results-v1 §3). */
  results?: boolean;
  result?: PlayResult | null;
  /** The TV was not listening when this was sent: it is being woken, or Den has to be opened on it. */
  waking?: boolean;
}

export interface PlayOnTvStatus {
  message: string;
  /** Final: this send's toast will not change again, and polling for it should stop. */
  done: boolean;
  /** A new send is the way on: the play expired, failed or was never confirmed. */
  retry?: boolean;
}

/** What the TV's `failed` result says, in the toast's words. */
function failedMessage(reason: PlayResult['reason'], device: string): PlayOnTvStatus {
  switch (reason) {
    case 'not_allowed':
      return {
        message: i18n.format(
          'playback.notAllowedOn',
          '{device} didn’t play it: a content limit or profile there blocks it.',
          { device },
        ),
        done: true,
      };
    case 'no_source':
      return {
        message: i18n.format('playback.noSourceOn', 'No playable source on {device}.', { device }),
        done: true,
      };
    case 'no_trailer':
      return {
        message: i18n.format('playback.noTrailerOn', 'No trailer to play on {device}.', { device }),
        done: true,
      };
    case 'superseded':
      return {
        message: i18n.format('playback.supersededOn', '{device} is playing something newer.', {
          device,
        }),
        done: true,
      };
    case 'expired':
      return {
        message: i18n.format('playback.expiredOn', '{device} got it too late to play it.', {
          device,
        }),
        done: true,
        retry: true,
      };
    default:
      return {
        message: i18n.format('playback.failedOn', 'Couldn’t start it on {device}.', { device }),
        done: true,
        retry: true,
      };
  }
}

/** Pure: what the toast should say, given what is known so far. No clock, storage or network of its own. */
export function playOnTvStatus({
  now,
  sentAt,
  tvName,
  queued,
  playing,
  results = false,
  result = null,
  waking = false,
}: PlayOnTvInput): PlayOnTvStatus {
  const elapsed = now - sentAt;
  if (results) {
    if (result?.state === 'playing')
      return {
        message: i18n.format('playback.playingOn', 'Playing on {device}', { device: tvName }),
        done: true,
      };
    if (result?.state === 'failed') return failedMessage(result.reason, tvName);
    if (elapsed >= GIVE_UP_MS)
      return {
        message: i18n.format('playback.unconfirmedOn', '{device} didn’t confirm it started.', {
          device: tvName,
        }),
        done: true,
        retry: true,
      };
    if (result?.state === 'preparing')
      return {
        message: i18n.format('playback.preparingOn', 'Preparing source on {device}…', {
          device: tvName,
        }),
        done: false,
      };
    // Not taken yet from a TV that was not listening: it is waking, or Den needs opening there.
    if (waking && queued !== false)
      return {
        message:
          elapsed >= HINT_MS
            ? i18n.format(
                'playback.sentNeedsOpen',
                'Sent to {device}… Den needs to be open on {device}.',
                { device: tvName },
              )
            : i18n.format('playback.wakingTv', 'Waking {device}…', { device: tvName }),
        done: false,
      };
    return {
      message: i18n.format('playback.sentTo', 'Sent to {device}…', { device: tvName }),
      done: false,
    };
  }
  if (playing)
    return {
      message: i18n.format('playback.playingOn', 'Playing on {device}', { device: tvName }),
      done: true,
    };
  // `queued === false` is den-edge's word that the TV took it, so the hint — which exists only to say Den might
  // not be open — would be a false alarm once that's known, even past HINT_MS.
  const needsHint = elapsed >= HINT_MS && queued !== false;
  const message = needsHint
    ? i18n.format('playback.sentNeedsOpen', 'Sent to {device}… Den needs to be open on {device}.', {
        device: tvName,
      })
    : i18n.format('playback.sentTo', 'Sent to {device}…', { device: tvName });
  return { message, done: elapsed >= GIVE_UP_MS };
}

/** The play's results, for a TV that reports them: its request id, and whether it was listening when sent. */
export interface PlayOnTvResults {
  id: string;
  listening: boolean | null;
  /** A fresh send of the same play, offered when this one expired, failed or was never confirmed. */
  retry?: () => void;
}

/**
 * Tracks one "Play on TV" send end to end: peeks `stillQueued` on a timer, follows the TV's results when it reports
 * them, and drives `session.notify` from `playOnTvStatus`. For a TV without results the "is it playing" half is left
 * to whoever can see the library — `observe()` is fed the library's Continue Watching entries each time the page
 * pulls — because this module has no view of the library itself and shouldn't need one to stay testable.
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
  private results: PlayOnTvResults | null = null;
  private result: PlayResult | null = null;
  private watching?: AbortController;
  private peekTimer?: ReturnType<typeof setInterval>;
  private giveUpTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;

  constructor(
    private readonly session: Pick<ProfileSession, 'notify'>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    /** Reads the TV's results with this browser's member proof (`play_result.rs`). */
    private readonly resultsFetch: typeof fetch = relayFetch,
  ) {}

  /**
   * A fresh send: `sealed` is what `sendToTV` appended, for the TV named `tvName`, of `title`. `results` when that TV
   * reports play results, naming the request id the envelope was sealed with.
   */
  start(
    link: Pick<Link, 'inboxKey'>,
    sealed: string,
    tvName: string,
    title: { type: string; id: number },
    results?: PlayOnTvResults,
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
    this.results = results ?? null;
    this.result = null;
    this.render();
    const generation = this.generation;
    this.peekTimer = setInterval(() => void this.peek(generation), PEEK_MS);
    this.giveUpTimer = setTimeout(() => this.render(), GIVE_UP_MS);
    if (results) {
      const watching = (this.watching = new AbortController());
      void watchResults(
        results.id,
        (result) => {
          if (generation !== this.generation) return;
          this.result = result;
          this.render();
        },
        watching.signal,
        this.resultsFetch,
      ).catch((error: unknown) => console.warn('play/results-watch', error));
    }
  }

  /**
   * Fed the library's Continue Watching entries each time the page pulls. For a TV without results, a fresh position
   * (`livePosition`) for the title being tracked, written after it was sent, reads as the TV having started it.
   */
  observe(entries: { title: { type: string; id: number }; seconds?: number; at?: number }[]) {
    if (!this.link || !this.title || this.results) return;
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
    this.results = null;
    this.watching?.abort();
    this.watching = undefined;
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
      results: !!this.results,
      result: this.result,
      waking: this.results?.listening === false,
    });
    const retry = status.retry ? this.results?.retry : undefined;
    this.session.notify(
      status.message,
      status.done
        ? retry
          ? { undo: { label: i18n.phrase('Try again'), run: retry } }
          : undefined
        : { holdMs: Infinity },
    );
    if (status.done) this.stop();
  }
}
