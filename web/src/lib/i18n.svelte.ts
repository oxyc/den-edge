import { ENGLISH_MESSAGES, type MessageCatalog, type MessageId } from './messages/en';
import { interfaceLocale, type InterfaceLanguage } from './interfaceLanguage';
import { ensureIntl } from './intlSupport';

/** Non-reactive bounded-by-language cache: catalog/formatter insertion must never invalidate a view. */
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
    await ensureIntl(language);
    if (typeof document !== 'undefined') document.documentElement.lang = language;
    return;
  }
  const request = ++requested;
  pendingLanguage = language;
  const [, next] = await Promise.all([ensureIntl(language), catalog(language)]);
  if (request !== requested) return;
  pendingLanguage = null;
  state = { language, catalog: next, generation: state.generation + 1 };
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('DenAndroidTV/')) {
    // The trusted top-level navigation seam lets the launcher remember only this allowlisted presentation hint.
    window.location.href = `den://language/${language}`;
  }
}

const formatters = new StableCache<
  string,
  Intl.NumberFormat | Intl.DateTimeFormat | Intl.Collator
>();

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
  number(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
    const key = `number:${state.language}:${JSON.stringify(options)}`;
    let formatter = formatters.get(key) as Intl.NumberFormat | undefined;
    if (!formatter) {
      formatter = new Intl.NumberFormat(interfaceLocale(state.language), options);
      formatters.set(key, formatter);
    }
    return formatter;
  },
  date(options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
    const key = `date:${state.language}:${JSON.stringify(options)}`;
    let formatter = formatters.get(key) as Intl.DateTimeFormat | undefined;
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(interfaceLocale(state.language), options);
      formatters.set(key, formatter);
    }
    return formatter;
  },
  collator(options: Intl.CollatorOptions = {}): Intl.Collator {
    const key = `collator:${state.language}:${JSON.stringify(options)}`;
    let formatter = formatters.get(key) as Intl.Collator | undefined;
    if (!formatter) {
      formatter = new Intl.Collator(interfaceLocale(state.language), options);
      formatters.set(key, formatter);
    }
    return formatter;
  },
};
