import { describe, expect, it, vi } from 'vitest';
import { thisDevice } from './device.svelte';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});
vi.stubGlobal('navigator', {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1',
  maxTouchPoints: 5,
});

describe('this device’s name', () => {
  it('guesses from the browser until it is named, then keeps the name', () => {
    expect(thisDevice.name).toBe('iPhone · Safari');

    thisDevice.rename('  Kitchen iPhone  ');
    expect(thisDevice.name).toBe('Kitchen iPhone');
    expect(store.get('den.deviceName')).toBe('Kitchen iPhone');

    // Cleared, it goes back to the guess rather than pairing as nothing.
    thisDevice.rename('');
    expect(thisDevice.name).toBe('iPhone · Safari');
    expect(store.has('den.deviceName')).toBe(false);
  });
});
