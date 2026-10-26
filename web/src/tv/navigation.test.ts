import { describe, expect, it } from 'vitest';
import { touchNeedsSearchPreload } from './navigation';

describe('TV Search preload admission', () => {
  it('distinguishes touch activation from a coarse Magic Remote pointer', () => {
    expect(touchNeedsSearchPreload(0)).toBe(false);
    expect(touchNeedsSearchPreload(1)).toBe(true);
    expect(touchNeedsSearchPreload(5)).toBe(true);
  });
});
