import { ENGLISH_MESSAGES, type MessageCatalog, type MessageId } from './messages/en';
import type { InterfaceLanguage } from './interfaceLanguage';
import { ensureIntl } from './intlSupport';

/** Non-reactive bounded-by-language cache: catalog insertion must never invalidate a view. */
class StableCache<Key, Value> {
  readonly #values: Map<Key, Value>;
  constructor(entries: readonly (readonly [Key, Value])[] = []) {
    this.#values = new Map(entries);
  }
  get(key: Key): Value | undefined {
    return this.#values.get(key);
  }
  set(key: Key, value: Value): void {
    this.#values.set(key, value);
  }
}

let state = $state.raw<{
  language: InterfaceLanguage;
  catalog: MessageCatalog;
  phrases: Readonly<Record<string, string>>;
  generation: number;
}>({ language: 'en', catalog: ENGLISH_MESSAGES, phrases: {}, generation: 0 });

let requested = 0;
let pendingLanguage: InterfaceLanguage | null = null;
interface LoadedCatalog {
  readonly messages: MessageCatalog;
  readonly phrases: Readonly<Record<string, string>>;
}

const loaded = new StableCache<InterfaceLanguage, LoadedCatalog>([
  ['en', { messages: ENGLISH_MESSAGES, phrases: {} }],
]);

function translatedPhrase(english: string): string {
  const exact = state.phrases[english];
  if (exact) return exact;
  const trimmed = english.trim();
  const trimmedTranslation = state.phrases[trimmed];
  if (trimmedTranslation) return english.replace(trimmed, trimmedTranslation);

  const rules: readonly (readonly [RegExp, string])[] =
    state.language === 'es'
      ? [
          [/^More from (.+)$/, 'Más de $1'],
          [/^More about (.+)$/, 'Más sobre $1'],
          [/^More adapted from (.+)$/, 'Más adaptaciones de $1'],
          [/^More in (.+)$/, 'Más en $1'],
          [/^More (.+) like this$/, 'Más títulos $1 como este'],
          [/^Set in (.+)$/, 'Ambientadas en $1'],
          [/^Written by (.+)$/, 'Escritas por $1'],
          [/^Starring (.+)$/, 'Con $1'],
        ]
      : [
          [/^More from (.+)$/, 'Mer från $1'],
          [/^More about (.+)$/, 'Mer om $1'],
          [/^More adapted from (.+)$/, 'Fler filmatiseringar av $1'],
          [/^More in (.+)$/, 'Mer på $1'],
          [/^More (.+) like this$/, 'Mer $1 som detta'],
          [/^Set in (.+)$/, 'Utspelar sig i $1'],
          [/^Written by (.+)$/, 'Skrivet av $1'],
          [/^Starring (.+)$/, 'Med $1'],
        ];
  for (const [pattern, replacement] of rules) {
    const match = english.match(pattern);
    if (!match?.[1]) continue;
    return replacement.replace('$1', translatedPhrase(match[1]));
  }
  return english;
}

async function catalog(language: InterfaceLanguage): Promise<LoadedCatalog> {
  const existing = loaded.get(language);
  if (existing) return existing;
  const imported =
    language === 'es' ? await import('./messages/es') : await import('./messages/sv');
  const value = { messages: imported.messages, phrases: imported.phrases };
  loaded.set(language, value);
  return value;
}

/** Atomically publishes a compiled catalog. English takes no dynamic import or catalog allocation. */
export async function setInterfaceLanguage(language: InterfaceLanguage): Promise<void> {
  if (state.language === language && pendingLanguage === null) {
    if (__DEN_TV_PLATFORM__ === 'tizen') await ensureIntl(language);
    if (typeof document !== 'undefined') document.documentElement.lang = language;
    return;
  }
  const request = ++requested;
  pendingLanguage = language;
  const next =
    __DEN_TV_PLATFORM__ === 'tizen'
      ? (await Promise.all([ensureIntl(language), catalog(language)]))[1]
      : await catalog(language);
  if (request !== requested) return;
  pendingLanguage = null;
  state = {
    language,
    catalog: next.messages,
    phrases: next.phrases,
    generation: state.generation + 1,
  };
  if (typeof document !== 'undefined') document.documentElement.lang = language;
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
  /** Static English copy is its own fallback, so the default language carries no duplicate phrase catalog. */
  phrase(english: string): string {
    return state.language === 'en' ? english : translatedPhrase(english);
  },
};
