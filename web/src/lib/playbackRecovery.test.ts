import { expect, it } from 'vitest';
import { directRecovery } from './playbackRecovery';

it('falls back when direct never starts', () => {
  expect(directRecovery(false, 'initial')).toBe('fallback');
});

it('refreshes one direct URL that failed after playing', () => {
  expect(directRecovery(true, 'initial')).toBe('refresh');
});

it('falls back if the refreshed direct result also fails', () => {
  expect(directRecovery(false, 'refreshed')).toBe('fallback');
  expect(directRecovery(true, 'refreshed')).toBe('fallback');
});
