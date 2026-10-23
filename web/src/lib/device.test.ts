import { describe, expect, it, vi } from 'vitest';
import { thisDevice, tvGuess } from './device.svelte';

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

  it('names a TV only when the browser is one, whatever the build was made for', () => {
    const lg =
      'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/87.0.4280.88 Safari/537.36';
    const samsung =
      'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 SamsungBrowser/3.0';
    const iphone = navigator.userAgent;
    expect(tvGuess('webos', lg)).toBe('LG TV');
    expect(tvGuess('tizen', samsung)).toBe('Samsung TV');
    expect(tvGuess('android', iphone)).toBe('Android TV');
    // The hosted webOS page opened on an iPhone is not an LG TV.
    expect(tvGuess('webos', iphone)).toBeNull();
  });
});
