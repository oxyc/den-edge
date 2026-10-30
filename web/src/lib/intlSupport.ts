import { interfaceLocale, type InterfaceLanguage } from './interfaceLanguage';

type SupportedConstructor = {
  supportedLocalesOf(locales: string | string[]): string[];
  new (locale: string): { resolvedOptions(): { locale: string } };
};

const supports = (constructor: SupportedConstructor | undefined, locale: string): boolean => {
  if (!constructor) return false;
  try {
    const supported = constructor.supportedLocalesOf([locale]);
    const resolved = new constructor(locale).resolvedOptions().locale.toLowerCase();
    return supported.length === 1 && resolved.startsWith(locale.slice(0, 2).toLowerCase());
  } catch {
    return false;
  }
};

const ready = new Map<InterfaceLanguage, Promise<void>>();

/** Probe requested-locale resolution once; native-capable engines never import a polyfill chunk. */
export function ensureIntl(language: InterfaceLanguage): Promise<void> {
  // Browser, Android WebView and webOS use their engine-native Intl. Only Samsung's older
  // installed engines need Den's pinned fallback; keeping this compile-time branch here also
  // keeps the polyfill modules out of every non-Tizen production bundle.
  if (__DEN_TV_PLATFORM__ !== 'tizen') return Promise.resolve();
  let pending = ready.get(language);
  if (pending) return pending;
  pending = (async () => {
    const locale = interfaceLocale(language);
    if (typeof Intl.Locale !== 'function') await import('./intlPolyfills/locale');
    const constructors = Intl as typeof Intl & {
      RelativeTimeFormat?: SupportedConstructor;
      DisplayNames?: SupportedConstructor;
    };
    await Promise.all([
      supports(Intl.NumberFormat as unknown as SupportedConstructor, locale)
        ? undefined
        : import('./intlPolyfills/number'),
      supports(Intl.DateTimeFormat as unknown as SupportedConstructor, locale)
        ? undefined
        : import('./intlPolyfills/date'),
      supports(Intl.PluralRules as unknown as SupportedConstructor, locale)
        ? undefined
        : import('./intlPolyfills/plural'),
      supports(constructors.RelativeTimeFormat, locale)
        ? undefined
        : import('./intlPolyfills/relative'),
      supports(constructors.DisplayNames, locale) ? undefined : import('./intlPolyfills/display'),
    ]);
  })();
  ready.set(language, pending);
  return pending;
}
