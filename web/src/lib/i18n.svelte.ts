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
  generation: number;
}>({ language: 'en', catalog: ENGLISH_MESSAGES, generation: 0 });

let requested = 0;
let pendingLanguage: InterfaceLanguage | null = null;
const loaded = new StableCache<InterfaceLanguage, MessageCatalog>([['en', ENGLISH_MESSAGES]]);

async function catalog(language: InterfaceLanguage): Promise<MessageCatalog> {
  const existing = loaded.get(language);
  if (existing) return existing;
  const imported =
    language === 'es' ? await import('./messages/es') : await import('./messages/sv');
  loaded.set(language, imported.messages);
  return imported.messages;
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
  state = { language, catalog: next, generation: state.generation + 1 };
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
};
