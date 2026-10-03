import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIVE_UP_MS, HINT_MS, PEEK_MS, PlayOnTvTracker, playOnTvStatus } from './playOnTv.svelte';

afterEach(() => {
  vi.useRealTimers();
});

describe('playOnTvStatus (pure)', () => {
  const base = { now: 0, sentAt: 0, tvName: 'Living Room TV', queued: null as boolean | null, playing: false };

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
    vi.setSystemTime(sentAt + 20_000);
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
