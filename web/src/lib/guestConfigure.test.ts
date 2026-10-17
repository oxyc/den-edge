import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearGuestConfigure,
  hasSharedMediaSettings,
  openGuestConfigure,
  openOwnerConfigure,
} from './guestConfigure';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('openGuestConfigure', () => {
  it('submits the grant in a native new-tab POST', () => {
    const submitImpl = vi.fn();
    expect(openGuestConfigure('a1b2c3d4', 'secret', { submitImpl })).toBe(true);
    expect(submitImpl).toHaveBeenCalledWith({
      action: '/grant/den-configure',
      target: '_blank',
      fields: { grant: 'a1b2c3d4:secret' },
    });
  });

  it('does not submit malformed credentials and reports a submission failure', () => {
    const submitImpl = vi.fn(() => {
      throw new Error('document unavailable');
    });
    expect(openGuestConfigure('bad', 'secret', { submitImpl })).toBe(false);
    expect(submitImpl).not.toHaveBeenCalled();
    expect(openGuestConfigure('a1b2c3d4', 'secret', { submitImpl })).toBe(false);
  });
});

describe('openOwnerConfigure', () => {
  it('submits the member proof in a native new-tab POST', () => {
    const submitImpl = vi.fn();
    expect(
      openOwnerConfigure('/den/configure', {
        claimImpl: () => 'library:member',
        submitImpl,
      }),
    ).toBe(true);
    expect(submitImpl).toHaveBeenCalledWith({
      action: '/grant/den-configure',
      target: '_blank',
      fields: { member: 'library:member' },
    });
  });

  it('refuses another route or a missing member proof', () => {
    const submitImpl = vi.fn();
    expect(
      openOwnerConfigure('/atlas/configure', { claimImpl: () => 'library:member', submitImpl }),
    ).toBe(false);
    expect(openOwnerConfigure('/den/configure', { claimImpl: () => null, submitImpl })).toBe(false);
    expect(submitImpl).not.toHaveBeenCalled();
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
