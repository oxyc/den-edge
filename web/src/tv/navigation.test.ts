import { describe, expect, it } from 'vitest';
import { searchKeyNeedsPreload, touchNeedsSearchPreload } from './navigation';

describe('TV Search preload admission', () => {
  it('distinguishes touch activation from a coarse Magic Remote pointer', () => {
    expect(touchNeedsSearchPreload(0)).toBe(false);
    expect(touchNeedsSearchPreload(1)).toBe(true);
    expect(touchNeedsSearchPreload(5)).toBe(true);
  });

  it('does not parse Search for a key whose intent is to leave its restored focus', () => {
    expect(searchKeyNeedsPreload('ArrowDown')).toBe(false);
    expect(searchKeyNeedsPreload('ArrowLeft')).toBe(false);
    expect(searchKeyNeedsPreload('Escape')).toBe(false);
    expect(searchKeyNeedsPreload('Enter')).toBe(true);
    expect(searchKeyNeedsPreload('a')).toBe(true);
  });
});
