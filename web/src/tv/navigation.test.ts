import { describe, expect, it } from 'vitest';
import { searchKeyNeedsPreload, touchNeedsSearchPreload } from './navigation';

describe('TV Search preload admission', () => {
  it('distinguishes touch activation from a coarse Magic Remote pointer', () => {
    expect(touchNeedsSearchPreload(0, false)).toBe(false);
    expect(touchNeedsSearchPreload(1, false)).toBe(true);
    expect(touchNeedsSearchPreload(5, false)).toBe(true);
    expect(touchNeedsSearchPreload(0, true), 'WebKit touch contexts can report zero points').toBe(
      true,
    );
  });

  it('does not parse Search for a key whose intent is to leave its restored focus', () => {
    expect(searchKeyNeedsPreload('ArrowDown')).toBe(false);
    expect(searchKeyNeedsPreload('ArrowLeft')).toBe(false);
    expect(searchKeyNeedsPreload('Escape')).toBe(false);
    expect(searchKeyNeedsPreload('Enter')).toBe(true);
    expect(searchKeyNeedsPreload('a')).toBe(true);
  });
});
