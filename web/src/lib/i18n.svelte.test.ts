import { expect, it } from 'vitest';
import { i18n, setInterfaceLanguage } from './i18n.svelte';

it('rejects a first-load catalog superseded before its import settles', async () => {
  await setInterfaceLanguage('en');
  const spanish = setInterfaceLanguage('es');
  const english = setInterfaceLanguage('en');

  await Promise.all([spanish, english]);

  expect(i18n.language).toBe('en');
  expect(i18n.text('player.subtitleTiming')).toBe('Subtitle timing');
});
