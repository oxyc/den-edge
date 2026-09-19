import { describe, expect, it } from 'vitest';
import { castErrorAction, castIdleAction } from '../../cast/src/lifecycle';

describe('Cast idle lifecycle', () => {
  it('completes only a genuinely finished media session', () => {
    expect(castIdleAction('FINISHED', false)).toBe('finished');
    expect(castIdleAction('CANCELLED', false)).toBe('stopped');
    expect(castIdleAction(undefined, false)).toBe('stopped');
  });

  it('retries an error and ignores the old media interrupted by our replacement load', () => {
    expect(castIdleAction('ERROR', false)).toBe('error');
    expect(castIdleAction('INTERRUPTED', true)).toBe('replaced');
    expect(castIdleAction('INTERRUPTED', false)).toBe('stopped');
  });

  it('keeps the receiver for one conservative retry, then stops after fallback fails', () => {
    expect(castErrorAction(false)).toBe('retry-receiver');
    expect(castErrorAction(true)).toBe('stop-receiver');
  });
});
