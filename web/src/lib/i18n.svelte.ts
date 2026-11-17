import { ENGLISH_MESSAGES, type MessageCatalog, type MessageId } from './messages/en';
import type { ParameterCatalog, ParameterMessageId } from './messages/parameters';
import type { InterfaceLanguage } from './interfaceLanguage';
import { ensureIntl } from './intlSupport';
import {
  readCachedTranslationCatalog,
  readPresentationLanguageHint,
  rememberPresentationLanguage,
  rememberTranslationCatalog,
  translationCacheSchema,
} from './translationCache';

/** Non-reactive bounded cache: insertion is an implementation detail and must never invalidate a view. */
class StableCache<Key, Value> {
  readonly #values = new Map<Key, Value>();
  constructor(entries: readonly (readonly [Key, Value])[] = []) {
    for (const [key, value] of entries) this.#values.set(key, value);
  }
  get(key: Key): Value | undefined {
    return this.#values.get(key);
  }
  set(key: Key, value: Value): void {
    this.#values.set(key, value);
  }
}

interface LoadedCatalog {
  readonly messages: MessageCatalog;
  readonly phrases: Readonly<Record<string, string>>;
  readonly parameters: Partial<ParameterCatalog>;
}

interface VersionedCatalog {
  readonly revision: string;
  readonly value: LoadedCatalog;
}

const initialLanguage = readPresentationLanguageHint() ?? 'en';
const initialCached = readCachedTranslationCatalog(initialLanguage);
const initialCatalog: LoadedCatalog = initialCached
  ? {
      messages: initialCached.messages,
      phrases: initialCached.phrases,
      parameters: initialCached.parameters,
    }
  : { messages: ENGLISH_MESSAGES, phrases: {}, parameters: {} };

let state = $state.raw<{
  language: InterfaceLanguage;
  catalog: MessageCatalog;
  phrases: Readonly<Record<string, string>>;
  parameters: Partial<ParameterCatalog>;
  generation: number;
}>({
  language: initialCached ? initialLanguage : 'en',
  catalog: initialCatalog.messages,
  phrases: initialCatalog.phrases,
  parameters: initialCatalog.parameters,
  generation: 0,
});

let requested = 0;
const pluralRules = new StableCache<InterfaceLanguage, Intl.PluralRules>();
let phraseKeys: StableCache<string, string> | undefined;

const phraseKey = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};
const loaded = new StableCache<InterfaceLanguage, VersionedCatalog>([
  [
    'en',
    {
      revision: __DEN_TRANSLATIONS_REVISION__,
      value: { messages: ENGLISH_MESSAGES, phrases: {}, parameters: {} },
    },
  ],
  ...(initialCached
    ? ([[initialLanguage, { revision: initialCached.revision, value: initialCatalog }]] as const)
    : []),
]);

function translatedPhrase(english: string): string {
  phraseKeys ??= new StableCache();
  let key = phraseKeys.get(english);
  if (!key) {
    key = phraseKey(english);
    phraseKeys.set(english, key);
  }
  const exact = state.phrases[key];
  if (exact) return exact;
  const trimmed = english.trim();
  let trimmedKey = phraseKeys.get(trimmed);
  if (!trimmedKey) {
    trimmedKey = phraseKey(trimmed);
    phraseKeys.set(trimmed, trimmedKey);
  }
  const trimmedTranslation = state.phrases[trimmedKey];
  if (trimmedTranslation) return english.replace(trimmed, trimmedTranslation);
  return english;
}

const cachedCatalog = (language: InterfaceLanguage): VersionedCatalog | undefined => {
  const existing = loaded.get(language);
  if (existing) return existing;
  const persisted = readCachedTranslationCatalog(language);
  if (!persisted) return undefined;
  const found = {
    revision: persisted.revision,
    value: {
      messages: persisted.messages,
      phrases: persisted.phrases,
      parameters: persisted.parameters,
    },
  };
  loaded.set(language, found);
  return found;
};

async function currentCatalog(language: InterfaceLanguage): Promise<VersionedCatalog> {
  const existing = cachedCatalog(language);
  if (existing?.revision === __DEN_TRANSLATIONS_REVISION__) return existing;
  if (language === 'en')
    return {
      revision: __DEN_TRANSLATIONS_REVISION__,
      value: { messages: ENGLISH_MESSAGES, phrases: {}, parameters: {} },
    };
  const imported =
    language === 'es' ? await import('./messages/es') : await import('./messages/sv');
  const value = {
    revision: __DEN_TRANSLATIONS_REVISION__,
    value: {
      messages: imported.messages,
      phrases: imported.phrases,
      parameters: imported.parameters,
    },
  };
  loaded.set(language, value);
  return value;
}

const persistAfterTranslatedPaint = (
  language: Exclude<InterfaceLanguage, 'en'>,
  catalog: VersionedCatalog,
): void => {
  const persist = () =>
    rememberTranslationCatalog(language, {
      schema: translationCacheSchema,
      language,
      revision: catalog.revision,
      messages: catalog.value.messages,
      phrases: catalog.value.phrases,
      parameters: catalog.value.parameters,
    });
  if (
    typeof document === 'undefined' ||
    document.hidden ||
    typeof requestAnimationFrame !== 'function'
  ) {
    setTimeout(persist, 0);
    return;
  }
  // Let the newly selected language reach a frame before serializing its bounded persistent snapshot.
  requestAnimationFrame(() => setTimeout(persist, 0));
};

const publish = (language: InterfaceLanguage, next: LoadedCatalog): void => {
  if (
    state.language === language &&
    state.catalog === next.messages &&
    state.phrases === next.phrases &&
    state.parameters === next.parameters
  )
    return;
  state = {
    language,
    catalog: next.messages,
    phrases: next.phrases,
    parameters: next.parameters,
    generation: state.generation + 1,
  };
};

/** Atomically publishes a compiled catalog. English takes no dynamic import or catalog allocation. */
export async function setInterfaceLanguage(language: InterfaceLanguage): Promise<void> {
  const request = ++requested;
  rememberPresentationLanguage(language);
  if (typeof document !== 'undefined') document.documentElement.lang = language;

  const stale = cachedCatalog(language);
  if (stale) publish(language, stale.value);

  const next =
    __DEN_TV_PLATFORM__ === 'tizen'
      ? (await Promise.all([ensureIntl(language), currentCatalog(language)]))[1]
      : await currentCatalog(language);
  if (request !== requested) return;
  publish(language, next.value);
  if (language !== 'en' && stale?.revision !== next.revision)
    persistAfterTranslatedPaint(language, next);
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('DenAndroidTV/')) {
    // The trusted top-level navigation seam lets the launcher remember only this allowlisted presentation hint.
    window.location.href = `den://language/${language}`;
  }
}

export const i18n = {
  get language(): InterfaceLanguage {
    return state.language;
  },
  get generation(): number {
    return state.generation;
  },
  text(id: MessageId): string {
    return state.catalog[id] ?? ENGLISH_MESSAGES[id];
  },
  /** Parameterized messages are compiled catalog entries; production never parses ICU or English sentences. */
  format(
    id: ParameterMessageId,
    english: string,
    values: Readonly<Record<string, string | number>>,
  ): string {
    let output = state.parameters[id] ?? english;
    for (const [name, value] of Object.entries(values))
      output = output.split(`{${name}}`).join(String(value));
    return output;
  },
  allowedCount(count: number): string {
    let rules = pluralRules.get(state.language);
    if (!rules) {
      rules = new Intl.PluralRules(state.language);
      pluralRules.set(state.language, rules);
    }
    const form =
      rules.select(count) === 'one' ? 'profile.allowedCount.one' : 'profile.allowedCount.other';
    return this.format(form, '{count} allowed', { count });
  },
  /** Static English copy is its own fallback, so the default language carries no duplicate phrase catalog. */
  phrase(english: string): string {
    return state.language === 'en' ? english : translatedPhrase(english);
  },
};
