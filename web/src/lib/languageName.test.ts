import { afterEach, describe, expect, it, vi } from 'vitest';
import { setInterfaceLanguage } from './i18n.svelte';
import { languageName } from './languageName';

const finnishBrowser = () =>
  vi.stubGlobal('navigator', { language: 'fi-FI', languages: ['fi-FI'], userAgent: 'test' });

describe('languageName', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await setInterfaceLanguage('en');
  });

  it('names a language in the interface language, not the browser’s', async () => {
    finnishBrowser();
    await setInterfaceLanguage('en');
    expect(languageName('en')).toBe('English');
    expect(languageName('fr-FR')).toBe('French (France)');
  });

  it('follows the interface language when it changes', async () => {
    finnishBrowser();
    await setInterfaceLanguage('sv');
    expect(languageName('en')).toBe('engelska');
    await setInterfaceLanguage('en');
    expect(languageName('en')).toBe('English');
  });

  it('is null for a code it cannot name, so the caller shows the code', () => {
    expect(languageName('not a code')).toBeNull();
  });
});
