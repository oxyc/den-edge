import { isInterfaceLanguage, type InterfaceLanguage } from './interfaceLanguage';
import type { MessageCatalog } from './messages/en';

const PRESENTATION_LANGUAGE = 'den.interfaceLanguage.presentation.v1';
const CATALOG_PREFIX = 'den.translations.v1.';

export interface CachedTranslationCatalog {
  readonly revision: string;
  readonly messages: MessageCatalog;
  readonly phrases: Readonly<Record<string, string>>;
}

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** The last effective profile language is only a first-frame hint; synced preferences remain authoritative. */
export function readPresentationLanguageHint(
  source: Pick<Storage, 'getItem'> | undefined = storage(),
): InterfaceLanguage | undefined {
  try {
    const value = source?.getItem(PRESENTATION_LANGUAGE);
    return isInterfaceLanguage(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function rememberPresentationLanguage(
  language: InterfaceLanguage,
  target: Pick<Storage, 'setItem'> | undefined = storage(),
): void {
  try {
    target?.setItem(PRESENTATION_LANGUAGE, language);
  } catch {
    // Private browsing and full TV storage still work; only the next-launch warm start is unavailable.
  }
}

export function readCachedTranslationCatalog(
  language: InterfaceLanguage,
  source: Pick<Storage, 'getItem'> | undefined = storage(),
): CachedTranslationCatalog | undefined {
  if (language === 'en') return undefined;
  try {
    const raw = source?.getItem(`${CATALOG_PREFIX}${language}`);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Partial<CachedTranslationCatalog>;
    if (
      typeof candidate.revision !== 'string' ||
      !candidate.messages ||
      typeof candidate.messages !== 'object' ||
      !candidate.phrases ||
      typeof candidate.phrases !== 'object'
    )
      return undefined;
    return candidate as CachedTranslationCatalog;
  } catch {
    return undefined;
  }
}

export function rememberTranslationCatalog(
  language: InterfaceLanguage,
  catalog: CachedTranslationCatalog,
  target: Pick<Storage, 'setItem'> | undefined = storage(),
): void {
  if (language === 'en') return;
  try {
    target?.setItem(`${CATALOG_PREFIX}${language}`, JSON.stringify(catalog));
  } catch {
    // HTTP caching remains the fallback when this browser refuses or has exhausted persistent storage.
  }
}

export const translationCacheKeys = {
  presentationLanguage: PRESENTATION_LANGUAGE,
  catalog: (language: Exclude<InterfaceLanguage, 'en'>): string => `${CATALOG_PREFIX}${language}`,
};
