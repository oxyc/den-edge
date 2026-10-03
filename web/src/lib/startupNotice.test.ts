import { describe, expect, it } from 'vitest';
import { LARGE_RELEASE_BYTES, startupNotice } from './startupNotice';

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
});
