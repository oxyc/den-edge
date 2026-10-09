import { describe, expect, it } from 'vitest';
import { keyStatus } from './keys';

describe('key status', () => {
  it('names a row as the TV does', () => {
    expect(keyStatus(false, undefined)).toBe('Not set');
    expect(keyStatus(true, 'checking')).toBe('Checking…');
    expect(keyStatus(true, 'refused')).toBe('Not accepted');
    expect(keyStatus(true, 'unreachable')).toBe('Not responding');
    expect(keyStatus(true, 'accepted')).toBe('Connected');
    expect(keyStatus(true, undefined)).toBe('Connected');
  });
});
