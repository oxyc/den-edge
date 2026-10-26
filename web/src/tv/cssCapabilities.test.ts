import { describe, expect, it, vi } from 'vitest';
import { needsLegacyGapFallback } from './cssCapabilities';

describe('TV CSS capability admission', () => {
  it('does not force a flex layout measurement when Grid is available', () => {
    const flexGap = vi.fn(() => false);

    expect(needsLegacyGapFallback(true, flexGap)).toBe(false);
    expect(flexGap).not.toHaveBeenCalled();
  });

  it('uses the measured flex-gap result on grid-less engines', () => {
    expect(needsLegacyGapFallback(false, () => false)).toBe(true);
    expect(needsLegacyGapFallback(false, () => true)).toBe(false);
  });
});
