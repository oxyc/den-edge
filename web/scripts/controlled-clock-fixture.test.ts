import { expect, it, vi } from 'vitest';
import { waitForMaterializedPoster } from './controlled-clock-fixture';

it('waits for the real visible poster card rather than its vacant navigation proxy', async () => {
  let release!: () => void;
  const visible = new Promise<void>((resolve) => (release = resolve));
  const waitFor = vi.fn(() => visible);
  const locator = vi.fn(() => ({ waitFor }));
  let settled = false;

  const ready = waitForMaterializedPoster({ locator }, 'Movie 1002', 1234).then(
    () => (settled = true),
  );
  await Promise.resolve();

  expect(locator).toHaveBeenCalledWith('.card', { hasText: 'Movie 1002' });
  expect(waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 1234 });
  expect(settled).toBe(false);

  release();
  await ready;
  expect(settled).toBe(true);
});
