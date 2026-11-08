import { expect, it, vi } from 'vitest';
import { preparePlaybackReceiptCapability } from './playbackReceiptSupport';

it('returns permanent unsupported before lazy preparation work', async () => {
  const prepare = vi.fn<() => Promise<boolean>>();
  await expect(
    preparePlaybackReceiptCapability({
      supported: false,
      authority: {},
      signal: new AbortController().signal,
      prepare,
    }),
  ).resolves.toBe('unsupported');
  expect(prepare).not.toHaveBeenCalled();
});

it('keeps capable failures transient and preserves a successful authority result', async () => {
  const authority = {};
  await expect(
    preparePlaybackReceiptCapability({
      supported: true,
      authority,
      signal: new AbortController().signal,
      prepare: async (received) => received === authority,
    }),
  ).resolves.toBe('ready');
  await expect(
    preparePlaybackReceiptCapability({
      supported: true,
      authority,
      signal: new AbortController().signal,
      prepare: async () => false,
    }),
  ).resolves.toBe('temporarily-unavailable');
});

it('does not cross the preparation boundary for an already-cancelled authority', async () => {
  const stop = new AbortController();
  stop.abort();
  const prepare = vi.fn<() => Promise<boolean>>();
  await expect(
    preparePlaybackReceiptCapability({
      supported: true,
      authority: {},
      signal: stop.signal,
      prepare,
    }),
  ).resolves.toBe('temporarily-unavailable');
  expect(prepare).not.toHaveBeenCalled();
});

it('does not publish ready after the authority is cancelled in preparation', async () => {
  const stop = new AbortController();
  await expect(
    preparePlaybackReceiptCapability({
      supported: true,
      authority: {},
      signal: stop.signal,
      prepare: async () => {
        stop.abort();
        return true;
      },
    }),
  ).resolves.toBe('temporarily-unavailable');
});
