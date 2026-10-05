import { describe, expect, it } from 'vitest';
import { bufferingWhilePlaying, LARGE_RELEASE_BYTES, startupNotice } from './startupNotice';

const SMALL = { label: '1080p • WEB-DL • 6 GB', size: 6 * 1024 ** 3 };
const LARGE = { label: '4K • REMUX • 58 GB', size: 58 * 1024 ** 3 };

describe('startupNotice', () => {
  it('shows the generic line before 4s with no clock', () => {
    const notice = startupNotice(0, 'session');
    expect(notice.text).toBe('Finding a release this browser can play…');
    expect(notice.clock).toBeUndefined();
  });

  it('still shows the generic line just under 4s', () => {
    expect(startupNotice(3_999, 'session').text).toBe('Finding a release this browser can play…');
  });

  it('switches to the opening line with a clock at 4s', () => {
    const notice = startupNotice(4_000, 'session');
    expect(notice.text).toBe('Opening the release… Large files can take up to half a minute.');
    expect(notice.clock).toBe('0:04');
  });

  it('keeps ticking the clock past 4s', () => {
    expect(startupNotice(20_000, 'session').clock).toBe('0:20');
  });

  it('names a small release once the session exists, no size mentioned', () => {
    const notice = startupNotice(5_000, 'starting', SMALL);
    expect(notice.text).toBe(`Starting ${SMALL.label}…`);
  });

  it('calls out a large release by its size', () => {
    const notice = startupNotice(5_000, 'starting', LARGE);
    expect(notice.text).toBe(
      `Starting ${LARGE.label}… This is a large release (58.0 GB) — it can take up to half a minute.`,
    );
  });

  it('treats exactly the large-release threshold as large', () => {
    const edge = { label: 'edge', size: LARGE_RELEASE_BYTES };
    expect(startupNotice(5_000, 'starting', edge).text).toContain('large release');
  });

  it('omits the clock for "starting" before 4s', () => {
    expect(startupNotice(1_000, 'starting', SMALL).clock).toBeUndefined();
  });

  it('shows a countdown with the release underneath past the 3s threshold', () => {
    const notice = startupNotice(1_000, 'buffering', LARGE, 24);
    expect(notice.text).toBe('Starts in 0:24');
    expect(notice.sub).toBe(LARGE.label);
  });

  it('falls back to the starting line when the hold is 3s or under', () => {
    const notice = startupNotice(5_000, 'buffering', SMALL, 2);
    expect(notice.text).toBe(`Starting ${SMALL.label}…`);
  });

  it('falls back to the starting line when there is no countdown at all', () => {
    const notice = startupNotice(5_000, 'buffering', SMALL, undefined);
    expect(notice.text).toBe(`Starting ${SMALL.label}…`);
  });

  it('never mentions size for a release den-remux reported none for', () => {
    const notice = startupNotice(5_000, 'starting', { label: 'unknown size' });
    expect(notice.text).toBe('Starting unknown size…');
  });

  it('shows bytes and a rate once hls.js has loaded something, with no target yet', () => {
    const notice = startupNotice(5_000, 'starting', SMALL, undefined, {
      bytesLoaded: 2 * 1024 ** 2,
      bitsPerSecond: 4 * 1024 ** 2 * 8,
    });
    expect(notice.text).toBe(`Buffering ${SMALL.label} — 2.0 MB (4.0 MB/s)`);
  });

  it('shows "of <target>" and an estimate labelled as one, once there is a byte target', () => {
    const notice = startupNotice(5_000, 'starting', LARGE, undefined, {
      bytesLoaded: 18 * 1024 ** 2,
      bytesTarget: 40 * 1024 ** 2,
      bitsPerSecond: 4 * 1024 ** 2 * 8,
    });
    expect(notice.text).toBe(
      `Buffering ${LARGE.label} — 18.0 of 40.0 MB (4.0 MB/s) — ~6s left (estimate)`,
    );
  });

  it('never shows an ETA without a target to measure against', () => {
    const notice = startupNotice(5_000, 'starting', LARGE, undefined, {
      bytesLoaded: 18 * 1024 ** 2,
      bitsPerSecond: 4 * 1024 ** 2 * 8,
    });
    expect(notice.text).not.toContain('estimate');
  });

  it('never shows an ETA without a measured rate', () => {
    const notice = startupNotice(5_000, 'starting', LARGE, undefined, {
      bytesLoaded: 18 * 1024 ** 2,
      bytesTarget: 40 * 1024 ** 2,
    });
    expect(notice.text).toBe(`Buffering ${LARGE.label} — 18.0 of 40.0 MB`);
  });

  it('falls back to buffered seconds on native HLS, which has no byte loader', () => {
    const notice = startupNotice(5_000, 'starting', SMALL, undefined, { bufferedSecs: 3.2 });
    expect(notice.text).toBe(`Buffering ${SMALL.label} — 3.2s buffered`);
  });

  it('keeps ticking the elapsed clock once buffering, same as before anything arrived', () => {
    const notice = startupNotice(5_000, 'starting', SMALL, undefined, { bufferedSecs: 3.2 });
    expect(notice.clock).toBe('0:05');
  });

  it('prefers the large-release line over an empty progress object with nothing in it yet', () => {
    const notice = startupNotice(5_000, 'starting', LARGE, undefined, {});
    expect(notice.text).toContain('large release');
  });
});

describe('bufferingWhilePlaying', () => {
  it('names both numbers once there are any, in the owner’s own wording', () => {
    expect(
      bufferingWhilePlaying({ bufferedSecs: 6, bitsPerSecond: 3.1 * 8 * 1024 ** 2 }, false),
    ).toBe('Buffering — 6 s ahead, downloading at 3.1 MB/s');
  });

  it('says just "Buffering…" with nothing to measure yet', () => {
    expect(bufferingWhilePlaying(undefined, false)).toBe('Buffering');
  });

  it('shows only the rate on native HLS before the first buffered sample lands, and vice versa', () => {
    expect(bufferingWhilePlaying({ bitsPerSecond: 8 * 1024 ** 2 }, false)).toBe(
      'Buffering — downloading at 1.0 MB/s',
    );
    expect(bufferingWhilePlaying({ bufferedSecs: 2 }, false)).toBe('Buffering — 2 s ahead');
  });

  it('says the source is slow once nothing else fits, rather than implying a switch is still coming', () => {
    expect(bufferingWhilePlaying({ bufferedSecs: 0 }, true)).toBe(
      'Buffering — 0 s ahead. The source is slow right now.',
    );
  });
});
