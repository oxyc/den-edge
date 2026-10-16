import { afterEach, describe, expect, it, vi } from 'vitest';
import { openGuestConfigure } from './guestConfigure';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('openGuestConfigure', () => {
  it('fetches HTML with the grant, opens only its blob, and revokes it after load time', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      order.push('fetch');
      return new Response('<!doctype html><script>configured()</script>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const replace = vi.fn();
    const opened = { opener: {}, location: { replace }, close: vi.fn() } as unknown as Window;
    const openImpl = vi.fn(() => {
      order.push('open');
      return opened;
    });
    const createObjectURL = vi.fn(() => 'blob:https://den.example/setup');
    const revokeObjectURL = vi.fn();
    await expect(
      openGuestConfigure('a1b2c3d4', 'secret', {
        fetchImpl,
        openImpl,
        createObjectURL,
        revokeObjectURL,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('/den/~a1b2c3d4/configure', {
      headers: { 'x-den-grant': 'a1b2c3d4:secret' },
      cache: 'no-store',
    });
    expect(openImpl).toHaveBeenCalledWith('', '_blank');
    expect(order).toEqual(['open', 'fetch']);
    expect(opened.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith('blob:https://den.example/setup');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://den.example/setup');
  });

  it('does not fetch or make a blob when the browser refuses the new tab', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      openGuestConfigure('a1b2c3d4', 'secret', {
        fetchImpl,
        openImpl: () => null,
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('closes the reserved tab when authenticated setup is unavailable', async () => {
    const close = vi.fn();
    const opened = { opener: {}, location: { replace: vi.fn() }, close } as unknown as Window;
    await expect(
      openGuestConfigure('a1b2c3d4', 'secret', {
        fetchImpl: async () => new Response('not found', { status: 404 }),
        openImpl: () => opened,
      }),
    ).resolves.toBe(false);
    expect(opened.opener).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});
