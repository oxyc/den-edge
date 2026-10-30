import type { InterfaceLanguage } from './interfaceLanguage';
import { ENGLISH_MESSAGES, type MessageCatalog, type MessageId } from './messages/en';
import type { ParameterCatalog } from './messages/parameters';
import { presentationLanguageKeyForScope } from './presentationLanguageHint';

export {
  currentPresentationScope,
  readPresentationLanguageHint,
  rememberPresentationLanguage,
} from './presentationLanguageHint';

const CATALOG_PREFIX = 'den.translations.v3.';
const CATALOG_SCHEMA = 3 as const;
const MAX_CATALOG_BYTES = 512 * 1024;
const MESSAGE_IDS = Object.keys(ENGLISH_MESSAGES) as MessageId[];

export interface CachedTranslationCatalog {
  readonly schema: typeof CATALOG_SCHEMA;
  readonly language: Exclude<InterfaceLanguage, 'en'>;
  readonly revision: string;
  readonly messages: MessageCatalog;
  readonly phrases: Readonly<Record<string, string>>;
  readonly parameters: Partial<ParameterCatalog>;
}

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function readCachedTranslationCatalog(
  language: InterfaceLanguage,
  source: Pick<Storage, 'getItem'> | undefined = storage(),
): CachedTranslationCatalog | undefined {
  if (language === 'en') return undefined;
  try {
    const raw = source?.getItem(`${CATALOG_PREFIX}${language}`);
    if (!raw) return undefined;
    if (raw.length > MAX_CATALOG_BYTES) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Partial<CachedTranslationCatalog>;
    if (
      candidate.schema !== CATALOG_SCHEMA ||
      candidate.language !== language ||
      typeof candidate.revision !== 'string' ||
      candidate.revision.length !== 16 ||
      !candidate.messages ||
      typeof candidate.messages !== 'object' ||
      Array.isArray(candidate.messages) ||
      !candidate.phrases ||
      typeof candidate.phrases !== 'object' ||
      Array.isArray(candidate.phrases) ||
      !candidate.parameters ||
      typeof candidate.parameters !== 'object' ||
      Array.isArray(candidate.parameters) ||
      Object.keys(candidate.messages).length !== MESSAGE_IDS.length ||
      MESSAGE_IDS.some((id) => typeof candidate.messages?.[id] !== 'string') ||
      Object.values(candidate.phrases).some((entry) => typeof entry !== 'string') ||
      Object.values(candidate.parameters).some((entry) => typeof entry !== 'string')
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
    const serialized = JSON.stringify(catalog);
    if (serialized.length <= MAX_CATALOG_BYTES)
      target?.setItem(`${CATALOG_PREFIX}${language}`, serialized);
  } catch {
    // HTTP caching remains the fallback when this browser refuses or has exhausted persistent storage.
  }
}

export const translationCacheKeys = {
  presentationLanguage: (scope = 'default'): string => presentationLanguageKeyForScope(scope),
  catalog: (language: Exclude<InterfaceLanguage, 'en'>): string => `${CATALOG_PREFIX}${language}`,
};

export const translationCacheSchema = CATALOG_SCHEMA;
