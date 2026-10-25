import { expect, it } from 'vitest';
import { directRecovery } from './playbackRecovery';

it('refreshes one direct URL even when the first one never starts', () => {
  expect(directRecovery(false, 'initial')).toBe('refresh');
});

it('refreshes one direct URL that failed after playing', () => {
  expect(directRecovery(true, 'initial')).toBe('refresh');
});

it('stops on TorBox if the refreshed direct result also fails', () => {
  expect(directRecovery(false, 'refreshed')).toBe('stop');
  expect(directRecovery(true, 'refreshed')).toBe('stop');
});
