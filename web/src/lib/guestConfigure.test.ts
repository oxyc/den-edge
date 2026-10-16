import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearGuestConfigure, hasSharedMediaSettings, openGuestConfigure } from './guestConfigure';

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

describe('shared guest settings', () => {
  it('offers the reset only when a shared media service remains', () => {
    expect(hasSharedMediaSettings({ den: '/den/~a1b2c3d4', atlas: '/atlas/~a1b2c3d4' })).toBe(
      false,
    );
    for (const addon of ['scout', 'subtitles', 'reel'])
      expect(
        hasSharedMediaSettings({ den: '/den/~a1b2c3d4', [addon]: `/${addon}/~a1b2c3d4` }),
      ).toBe(true);
  });

  it('deletes only the personal install with the guest credential and no body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await expect(clearGuestConfigure('a1b2c3d4', 'secret', fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('/grant/den-install', {
      method: 'DELETE',
      headers: { 'x-den-grant': 'a1b2c3d4:secret' },
      cache: 'no-store',
    });
    expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('does not send malformed credentials and reports refused or unreachable resets', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    await expect(clearGuestConfigure('bad', 'secret', fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(clearGuestConfigure('a1b2c3d4', 'secret', fetchImpl)).resolves.toBe(false);
    await expect(
      clearGuestConfigure('a1b2c3d4', 'secret', async () => {
        throw new TypeError('offline');
      }),
    ).resolves.toBe(false);
  });
});
