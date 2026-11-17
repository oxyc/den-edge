import { i18n } from './i18n.svelte';
import { interfaceLocale } from './interfaceLanguage';

const formatters = new Map<string, Intl.DisplayNames | null>();

/**
 * A language code (`fr`, `fr-FR`) named in Den's interface language, never the browser's: a Finnish browser running
 * Den in English still reads "French". `null` when the engine cannot name it, so the caller shows the code itself.
 */
export function languageName(code: string): string | null {
  const locale = interfaceLocale(i18n.language);
  let names = formatters.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'language' });
    } catch {
      names = null;
    }
    formatters.set(locale, names);
  }
  try {
    return names?.of(code) ?? null;
  } catch {
    // A malformed code makes `of` throw.
    return null;
  }
}
