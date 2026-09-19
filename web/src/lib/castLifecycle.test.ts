import { describe, expect, it } from 'vitest';
import { castErrorAction, castIdleAction, castingTo, PLAYING_HERE } from '../../cast/src/lifecycle';

describe('Cast status text', () => {
  it('always says where the picture is', () => {
    expect(PLAYING_HERE).toBe('Playing on this device');
    expect(castingTo('Living Room TV')).toBe('Casting to Living Room TV');
    expect(castingTo('  Kitchen  ')).toBe('Casting to Kitchen');
  });

  it('still names a TV when the receiver has no name', () => {
    expect(castingTo(undefined)).toBe('Casting to your TV');
    expect(castingTo('')).toBe('Casting to your TV');
    expect(castingTo(null)).toBe('Casting to your TV');
  });
});

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

  it('keeps the receiver for one conservative retry, then stops on a terminal attempt', () => {
    expect(castErrorAction(false)).toBe('retry-receiver');
    expect(castErrorAction(true)).toBe('stop-receiver');
  });
});
