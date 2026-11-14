import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { i18n, setInterfaceLanguage } from './i18n.svelte';
import { interfaceLocale } from './interfaceLanguage';
import {
  hasSubtitleResyncNotice,
  scheduleNoticeExpiry,
  subtitleResyncNoticeText,
  type SubtitleResyncNotice,
} from './subtitleResyncNotice';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

test.each([
  ['zero-offset success', 0],
  ['failure', false],
] as const)('%s is retained as semantic state and expires', (_name, result) => {
  let notice: SubtitleResyncNotice = result;
  const cancel = scheduleNoticeExpiry(
    hasSubtitleResyncNotice(notice),
    () => (notice = null),
    4_000,
  );

  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(3_999);
  expect(notice).toBe(result);
  vi.advanceTimersByTime(1);
  expect(notice).toBeNull();
  cancel?.();
});

test('success-zero and failure relocalize live in English, Spanish and Swedish', async () => {
  const expected = {
    en: {
      success: 'Subtitles re-synced · +0.0s',
      failure: 'Subtitles could not be re-synced. Your current timing is unchanged.',
    },
    es: {
      success: 'Subtítulos resincronizados · +0,0s',
      failure:
        'No se pudieron resincronizar los subtítulos. La sincronización actual no ha cambiado.',
    },
    sv: {
      success: 'Undertexter har synkroniserats om · +0,0s',
      failure:
        'Det gick inte att synkronisera om undertexterna. Din nuvarande synkronisering är oförändrad.',
    },
  } as const;

  const text = (notice: Exclude<SubtitleResyncNotice, null>) =>
    subtitleResyncNoticeText(
      notice,
      (english) => i18n.phrase(english),
      (offset) => {
        const formatted = new Intl.NumberFormat(interfaceLocale(i18n.language), {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(offset);
        return i18n.format('player.subtitleOffsetCompact', '{sign}{offset}s', {
          sign: offset >= 0 ? '+' : '',
          offset: formatted,
        });
      },
    );

  for (const language of ['en', 'es', 'sv'] as const) {
    await setInterfaceLanguage(language);
    expect(text(0)).toBe(expected[language].success);
    expect(text(false)).toBe(expected[language].failure);
  }
});
