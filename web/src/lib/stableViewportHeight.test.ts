import { afterEach, describe, expect, it, vi } from 'vitest';
import { stableViewportHeight } from './stableViewportHeight';

describe('stableViewportHeight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does no style or frame work for a fixed TV viewport', () => {
    const frame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frame);
    vi.stubGlobal('getComputedStyle', () => {
      throw new Error('a fixed viewport must not force style');
    });

    const action = stableViewportHeight({} as HTMLElement, true);
    action.destroy();
    expect(frame).not.toHaveBeenCalled();
  });
});
