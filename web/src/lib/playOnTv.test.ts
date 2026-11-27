import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_MS } from './livePosition';
import { GIVE_UP_MS, HINT_MS, PEEK_MS, PlayOnTvTracker, playOnTvStatus } from './playOnTv.svelte';

afterEach(() => {
  vi.useRealTimers();
});

describe('playOnTvStatus (pure)', () => {
  const base = {
    now: 0,
    sentAt: 0,
    tvName: 'Living Room TV',
    queued: null as boolean | null,
    playing: false,
  };

  it('says it was sent, and nothing more, before the hint is due', () => {
    expect(playOnTvStatus({ ...base, now: HINT_MS - 1 })).toEqual({
      message: 'Sent to Living Room TV…',
      done: false,
    });
  });

  it('adds the "Den needs to be open" hint once the hint delay passes with no word it was received', () => {
    expect(playOnTvStatus({ ...base, now: HINT_MS, queued: null })).toEqual({
      message: 'Sent to Living Room TV… Den needs to be open on Living Room TV.',
      done: false,
    });
    expect(playOnTvStatus({ ...base, now: HINT_MS, queued: true })).toEqual({
      message: 'Sent to Living Room TV… Den needs to be open on Living Room TV.',
      done: false,
    });
  });

  it('skips the hint once the TV is known to have taken it, even past the hint delay', () => {
    expect(playOnTvStatus({ ...base, now: HINT_MS, queued: false })).toEqual({
      message: 'Sent to Living Room TV…',
      done: false,
    });
  });

  it('says playing, final, the moment a fresh position shows up — hint or not', () => {
    expect(playOnTvStatus({ ...base, now: HINT_MS, queued: true, playing: true })).toEqual({
      message: 'Playing on Living Room TV',
      done: true,
    });
  });

  it('is done at the give-up delay, past which the TV would ignore the message anyway', () => {
    expect(playOnTvStatus({ ...base, now: GIVE_UP_MS })).toEqual({
      message: 'Sent to Living Room TV… Den needs to be open on Living Room TV.',
      done: true,
    });
  });
});

describe('playOnTvStatus with a TV that reports results', () => {
  const base = {
    now: 0,
    sentAt: 0,
    tvName: 'Living Room TV',
    queued: null as boolean | null,
    playing: false,
    results: true,
  };

  it('says waking for a TV that was not listening, and sent for one that was', () => {
    expect(playOnTvStatus({ ...base, waking: true }).message).toBe('Waking Living Room TV…');
    expect(playOnTvStatus({ ...base, waking: true, now: HINT_MS }).message).toBe(
      'Sent to Living Room TV… Den needs to be open on Living Room TV.',
    );
    expect(playOnTvStatus(base).message).toBe('Sent to Living Room TV…');
  });

  it('follows the TV: preparing, then playing, final', () => {
    expect(playOnTvStatus({ ...base, result: { state: 'preparing', at: 1 } })).toEqual({
      message: 'Preparing source on Living Room TV…',
      done: false,
    });
    expect(playOnTvStatus({ ...base, result: { state: 'playing', at: 2 } })).toEqual({
      message: 'Playing on Living Room TV',
      done: true,
    });
  });

  it('never says playing from a same-title position: only the TV’s own result', () => {
    expect(playOnTvStatus({ ...base, playing: true }).message).toBe('Sent to Living Room TV…');
  });

  it('says why it failed, offering a new send only where one can help', () => {
    const failed = (reason: 'no_source' | 'not_allowed' | 'expired' | 'failed' | 'superseded') =>
      playOnTvStatus({ ...base, result: { state: 'failed', reason, at: 1 } });
    expect(failed('no_source')).toEqual({
      message: 'No playable source on Living Room TV.',
      done: true,
    });
    expect(failed('not_allowed')).toEqual({
      message: 'Living Room TV didn’t play it: a content limit or profile there blocks it.',
      done: true,
    });
    expect(failed('superseded').retry).toBeUndefined();
    expect(failed('expired')).toEqual({
      message: 'Living Room TV got it too late to play it.',
      done: true,
      retry: true,
    });
    expect(failed('failed').retry).toBe(true);
  });

  it('is unconfirmed — not failed — when the wait ends with no word from the TV', () => {
    expect(
      playOnTvStatus({ ...base, now: GIVE_UP_MS, result: { state: 'preparing', at: 1 } }),
    ).toEqual({
      message: 'Living Room TV didn’t confirm it started.',
      done: true,
      retry: true,
    });
  });
});

describe('PlayOnTvTracker with a TV that reports results', () => {
  const link = { inboxKey: 'abcdef0123456789' };
  const title = { type: 'movie', id: 550 };
  const vectors = JSON.parse(
    readFileSync(new URL('../../../spec/vectors/play-results-v1.json', import.meta.url), 'utf8'),
  ) as { id: string; results: { sealed: string }[] };
  const [preparing, playing, failed] = vectors.results.map((r) => r.sealed);

  /** den-edge's held read of the results: each answer once the TV has said one more thing. */
  function resultsFetch(answers: string[][]) {
    let asked = 0;
    return vi.fn(async () => Response.json({ results: answers[asked++] ?? answers.at(-1) }));
  }

  it('shows the TV’s preparing and playing, and ignores a same-title position', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const tracker = new PlayOnTvTracker(
      session,
      fakeQueued(true),
      Date.now,
      resultsFetch([[preparing!], [preparing!, playing!]]),
    );
    tracker.start(link, 'AAEC', 'Living Room TV', title, { id: vectors.id, listening: true });
    tracker.observe([{ title, seconds: 12, at: Date.now() + 1 }]);
    await vi.waitFor(() =>
      expect(session.notify).toHaveBeenLastCalledWith('Playing on Living Room TV', undefined),
    );
    // A peek re-renders what is already shown; the sequence is what the toast went through.
    const shown = session.notify.mock.calls.map((call) => call[0] as string);
    expect(shown.filter((message, i) => message !== shown[i - 1])).toEqual([
      'Sent to Living Room TV…',
      'Preparing source on Living Room TV…',
      'Playing on Living Room TV',
    ]);
    expect(tracker.active).toBe(false);
  });

  it('wakes a TV that was not listening, then says why it failed', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const retry = vi.fn();
    const tracker = new PlayOnTvTracker(
      session,
      fakeQueued(false),
      Date.now,
      resultsFetch([[preparing!, failed!]]),
    );
    tracker.start(link, 'AAEC', 'Living Room TV', title, {
      id: vectors.id,
      listening: false,
      retry,
    });
    expect(session.notify).toHaveBeenLastCalledWith('Waking Living Room TV…', {
      holdMs: Infinity,
    });
    // `no_source` has no retry: another title, or Den on the TV, is the way on.
    await vi.waitFor(() =>
      expect(session.notify).toHaveBeenLastCalledWith(
        'No playable source on Living Room TV.',
        undefined,
      ),
    );
    expect(retry).not.toHaveBeenCalled();
  });

  it('gives up unconfirmed, with Try again, when the TV says nothing', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const retry = vi.fn();
    const tracker = new PlayOnTvTracker(session, fakeQueued(false), Date.now, resultsFetch([[]]));
    tracker.start(link, 'AAEC', 'Living Room TV', title, {
      id: vectors.id,
      listening: true,
      retry,
    });
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
    const [message, options] = session.notify.mock.calls.at(-1)!;
    expect(message).toBe('Living Room TV didn’t confirm it started.');
    (options as { undo: { run: () => void } }).undo.run();
    expect(retry).toHaveBeenCalledOnce();
    expect(tracker.active).toBe(false);
  });

  function fakeQueued(queued: boolean) {
    return vi.fn(async () => Response.json({ queued }));
  }
});

describe('PlayOnTvTracker', () => {
  const link = { inboxKey: 'abcdef0123456789' };
  const title = { type: 'movie', id: 550 };

  function fakeFetch(queued: boolean | null) {
    return vi.fn(async () => {
      if (queued === null) throw new TypeError('offline');
      return new Response(JSON.stringify({ queued }), { status: 200 });
    });
  }

  it('notifies "Sent to…" at once, held open, and is active while tracked', () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const tracker = new PlayOnTvTracker(session, fakeFetch(null));
    tracker.start(link, 'AAEC', 'Living Room TV', title);
    expect(session.notify).toHaveBeenCalledWith('Sent to Living Room TV…', { holdMs: Infinity });
    expect(tracker.active).toBe(true);
  });

  it('adds the hint once a peek says it is still queued past the hint delay', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const tracker = new PlayOnTvTracker(session, fakeFetch(true));
    tracker.start(link, 'AAEC', 'Living Room TV', title);
    session.notify.mockClear();
    await vi.advanceTimersByTimeAsync(HINT_MS);
    expect(session.notify).toHaveBeenCalledWith(
      'Sent to Living Room TV… Den needs to be open on Living Room TV.',
      { holdMs: Infinity },
    );
    tracker.stop();
  });

  it('never shows the hint when the peek says the TV already took it', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const tracker = new PlayOnTvTracker(session, fakeFetch(false));
    tracker.start(link, 'AAEC', 'Living Room TV', title);
    session.notify.mockClear();
    await vi.advanceTimersByTimeAsync(HINT_MS + PEEK_MS);
    for (const call of session.notify.mock.calls) expect(call[0]).toBe('Sent to Living Room TV…');
    tracker.stop();
  });

  it('a failed peek is ignored outright — no notify, and the next tick asks again', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const fetchImpl = fakeFetch(null);
    const tracker = new PlayOnTvTracker(session, fetchImpl);
    tracker.start(link, 'AAEC', 'Living Room TV', title);
    session.notify.mockClear();
    await vi.advanceTimersByTimeAsync(PEEK_MS * 3);
    expect(session.notify).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
    tracker.stop();
  });

  it('observe() says Playing, final, the moment a fresh position appears after the send — and stops polling', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const fetchImpl = fakeFetch(true);
    const tracker = new PlayOnTvTracker(session, fetchImpl);
    tracker.start(link, 'AAEC', 'Living Room TV', title);
    const sentAt = Date.now();
    session.notify.mockClear();

    // A position that predates the send (e.g. a stale Continue Watching row) is not "the TV just started it".
    tracker.observe([{ title, seconds: 10, at: sentAt - 1 }]);
    expect(session.notify).not.toHaveBeenCalled();

    vi.setSystemTime(sentAt + 1000);
    tracker.observe([{ title, seconds: 12, at: sentAt + 500 }]);
    expect(session.notify).toHaveBeenCalledWith('Playing on Living Room TV', undefined);
    expect(tracker.active).toBe(false);

    const calls = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PEEK_MS * 3);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it('a stale position (older than LIVE_MS) does not count as playing', () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const tracker = new PlayOnTvTracker(session, fakeFetch(true));
    tracker.start(link, 'AAEC', 'Living Room TV', title);
    const sentAt = Date.now();
    session.notify.mockClear();
    vi.setSystemTime(sentAt + 1000 + LIVE_MS + 1);
    tracker.observe([{ title, seconds: 12, at: sentAt + 1000 }]);
    expect(session.notify).not.toHaveBeenCalled();
    tracker.stop();
  });

  it('gives up at GIVE_UP_MS, leaving the hint up but ending as a normal, auto-clearing toast', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const tracker = new PlayOnTvTracker(session, fakeFetch(true));
    tracker.start(link, 'AAEC', 'Living Room TV', title);
    session.notify.mockClear();
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
    expect(session.notify).toHaveBeenCalledWith(
      'Sent to Living Room TV… Den needs to be open on Living Room TV.',
      undefined,
    );
    expect(tracker.active).toBe(false);
  });

  it('a second send replaces the first: a fresh notify, and only one peek loop ever runs', async () => {
    vi.useFakeTimers();
    const session = { notify: vi.fn() };
    const fetchImpl = fakeFetch(true);
    const tracker = new PlayOnTvTracker(session, fetchImpl);
    tracker.start(link, 'AAEC', 'Living Room TV', title);
    await vi.advanceTimersByTimeAsync(PEEK_MS);
    const callsBeforeReplace = fetchImpl.mock.calls.length;

    const otherTitle = { type: 'tv', id: 1 };
    session.notify.mockClear();
    tracker.start(link, 'BBBB', 'Bedroom TV', otherTitle);
    expect(session.notify).toHaveBeenCalledWith('Sent to Bedroom TV…', { holdMs: Infinity });

    // If the first send's interval had leaked, this tick would peek twice (once per loop) instead of once.
    await vi.advanceTimersByTimeAsync(PEEK_MS);
    expect(fetchImpl.mock.calls.length).toBe(callsBeforeReplace + 1);
    tracker.stop();
  });
});
