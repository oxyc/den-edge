import { describe, expect, it } from 'vitest';
import { retryAfterMs } from './retryAfter';

const answered = (retryAfter?: string) => ({
  headers: { get: (name: string) => (name === 'retry-after' && retryAfter ? retryAfter : null) },
});

describe('retryAfterMs', () => {
  it('takes the seconds the server named', () => {
    expect(retryAfterMs(answered('30'), 5_000)).toBe(30_000);
    expect(retryAfterMs(answered(' 45 '), 5_000)).toBe(45_000);
  });

  it('reads the date form a cache or proxy is as likely to send', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    const later = 'Mon, 14 Sep 2026 12:02:00 GMT';
    expect(retryAfterMs(answered(later), 5_000, () => now)).toBe(120_000);
  });

  it('falls back when the header is absent or nonsense', () => {
    expect(retryAfterMs(answered(), 5_000)).toBe(5_000);
    expect(retryAfterMs(answered('soon'), 5_000)).toBe(5_000);
    expect(retryAfterMs(answered(''), 5_000)).toBe(5_000);
  });

  /** Zero means "now", which against something already refusing is a hot loop rather than a retry. */
  it('never comes straight back', () => {
    expect(retryAfterMs(answered('0'), 5_000)).toBe(1_000);
    const past = 'Mon, 14 Sep 2026 11:00:00 GMT';
    expect(retryAfterMs(answered(past), 5_000, () => Date.parse('2026-09-14T12:00:00Z'))).toBe(
      1_000,
    );
  });

  /** An hour is a real answer from scout; a day is not one this app would ever wake up from. */
  it('waits at most an hour, whatever it is told', () => {
    expect(retryAfterMs(answered('3600'), 5_000)).toBe(3_600_000);
    expect(retryAfterMs(answered('86400'), 5_000)).toBe(3_600_000);
  });
});
