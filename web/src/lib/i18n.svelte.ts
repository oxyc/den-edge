import { ENGLISH_MESSAGES, type MessageCatalog, type MessageId } from './messages/en';
import type { InterfaceLanguage } from './interfaceLanguage';
import { ensureIntl } from './intlSupport';
import {
  readCachedTranslationCatalog,
  readPresentationLanguageHint,
  rememberPresentationLanguage,
  rememberTranslationCatalog,
} from './translationCache';

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

interface LoadedCatalog {
  readonly messages: MessageCatalog;
  readonly phrases: Readonly<Record<string, string>>;
}

interface VersionedCatalog {
  readonly revision: string;
  readonly value: LoadedCatalog;
}

const initialLanguage = readPresentationLanguageHint() ?? 'en';
const initialCached = readCachedTranslationCatalog(initialLanguage);
const initialCatalog: LoadedCatalog = initialCached
  ? { messages: initialCached.messages, phrases: initialCached.phrases }
  : { messages: ENGLISH_MESSAGES, phrases: {} };

let state = $state.raw<{
  language: InterfaceLanguage;
  catalog: MessageCatalog;
  phrases: Readonly<Record<string, string>>;
  generation: number;
}>({
  language: initialCached ? initialLanguage : 'en',
  catalog: initialCatalog.messages,
  phrases: initialCatalog.phrases,
  generation: 0,
});

let requested = 0;
const loaded = new StableCache<InterfaceLanguage, VersionedCatalog>([
  [
    'en',
    {
      revision: __DEN_TRANSLATIONS_REVISION__,
      value: { messages: ENGLISH_MESSAGES, phrases: {} },
    },
  ],
  ...(initialCached
    ? ([[initialLanguage, { revision: initialCached.revision, value: initialCatalog }]] as const)
    : []),
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
          [/^Actions for (.+)$/, 'Acciones para $1'],
          [/^More actions for (.+)$/, 'Más acciones para $1'],
          [/^Open details for (.+)$/, 'Abrir detalles de $1'],
          [/^Switch profile, current (.+)$/, 'Cambiar perfil, actual: $1'],
          [/^Use (.+)$/, 'Usar $1'],
          [/^Browse (.+)$/, 'Explorar $1'],
          [/^Play (.+)$/, 'Reproducir $1'],
          [/^Remove (.+) from Continue Watching$/, 'Quitar $1 de Seguir viendo'],
          [/^Added “(.+)” to your watchlist$/, '“$1” se añadió a Mi lista'],
          [/^Removed “(.+)” from your watchlist$/, '“$1” se quitó de Mi lista'],
          [/^Marked “(.+)” as seen$/, '“$1” se marcó como visto'],
          [/^Marked “(.+)” as unseen$/, '“$1” se marcó como no visto'],
          [/^(\d+) allowed$/, '$1 permitidos'],
          [/^Expand all in (.+)$/, 'Expandir todo en $1'],
          [/^Collapse all in (.+)$/, 'Contraer todo en $1'],
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
          [/^Actions for (.+)$/, 'Åtgärder för $1'],
          [/^More actions for (.+)$/, 'Fler åtgärder för $1'],
          [/^Open details for (.+)$/, 'Öppna information om $1'],
          [/^Switch profile, current (.+)$/, 'Byt profil, aktuell: $1'],
          [/^Use (.+)$/, 'Använd $1'],
          [/^Browse (.+)$/, 'Bläddra bland $1'],
          [/^Play (.+)$/, 'Spela $1'],
          [/^Remove (.+) from Continue Watching$/, 'Ta bort $1 från Fortsätt titta'],
          [/^Added “(.+)” to your watchlist$/, '“$1” lades till i Min lista'],
          [/^Removed “(.+)” from your watchlist$/, '“$1” togs bort från Min lista'],
          [/^Marked “(.+)” as seen$/, '“$1” markerades som sedd'],
          [/^Marked “(.+)” as unseen$/, '“$1” markerades som osedd'],
          [/^(\d+) allowed$/, '$1 tillåtna'],
          [/^Expand all in (.+)$/, 'Expandera alla i $1'],
          [/^Collapse all in (.+)$/, 'Fäll ihop alla i $1'],
        ];
  for (const [pattern, replacement] of rules) {
    const match = english.match(pattern);
    if (!match?.[1]) continue;
    // The captured part is usually a media title, person, studio, or device name. Keep proper names verbatim.
    return replacement.replace('$1', match[1]);
  }
  return english;
}

const cachedCatalog = (language: InterfaceLanguage): VersionedCatalog | undefined => {
  const existing = loaded.get(language);
  if (existing) return existing;
  const persisted = readCachedTranslationCatalog(language);
  if (!persisted) return undefined;
  const found = {
    revision: persisted.revision,
    value: { messages: persisted.messages, phrases: persisted.phrases },
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
      value: { messages: ENGLISH_MESSAGES, phrases: {} },
    };
  const imported =
    language === 'es' ? await import('./messages/es') : await import('./messages/sv');
  const value = {
    revision: __DEN_TRANSLATIONS_REVISION__,
    value: { messages: imported.messages, phrases: imported.phrases },
  };
  loaded.set(language, value);
  rememberTranslationCatalog(language, {
    revision: value.revision,
    messages: value.value.messages,
    phrases: value.value.phrases,
  });
  return value;
}

const publish = (language: InterfaceLanguage, next: LoadedCatalog): void => {
  if (
    state.language === language &&
    state.catalog === next.messages &&
    state.phrases === next.phrases
  )
    return;
  state = {
    language,
    catalog: next.messages,
    phrases: next.phrases,
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
