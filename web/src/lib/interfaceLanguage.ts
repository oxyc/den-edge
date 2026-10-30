import { syncPolicy } from './syncCore';
import type { ConfigValue, SettingsRow } from './wire';

export const INTERFACE_LANGUAGES = ['en', 'es', 'sv'] as const;
export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];

export const isInterfaceLanguage = (value: unknown): value is InterfaceLanguage =>
  value === 'en' || value === 'es' || value === 'sv';

export const interfaceLocale = (language: InterfaceLanguage): string =>
  language === 'es' ? 'es-ES' : language === 'sv' ? 'sv-SE' : 'en-US';

/** English deliberately omits TMDB's language parameter to retain the established warm cache namespace. */
export const tmdbLanguage = (language: InterfaceLanguage): string | undefined =>
  language === 'en' ? undefined : interfaceLocale(language);

const LOCAL_INTERFACE_LANGUAGE = 'den.interfaceLanguage.local.v1';

/** An unpaired Look Around library has no synced identity; keep its presentation choice on this browser. */
export function readLocalInterfaceLanguage(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): InterfaceLanguage | undefined {
  try {
    const value = storage?.getItem(LOCAL_INTERFACE_LANGUAGE);
    return isInterfaceLanguage(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function rememberLocalInterfaceLanguage(
  language: InterfaceLanguage,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(LOCAL_INTERFACE_LANGUAGE, language);
  } catch {
    // A storage-refusing browser keeps the choice for this visit through the reactive settings projection.
  }
}

interface ReadAnswer {
  readonly version: 1;
  readonly selection: {
    readonly language: InterfaceLanguage;
    readonly explicit: boolean;
    readonly supported: boolean;
    readonly storedLanguage?: string;
  };
}

interface WriteAnswer {
  readonly version: 1;
  readonly changes: Record<string, ConfigValue | null>;
}

/** Read the shared presence-sensitive value. Absence stays cheap and inheritance-eligible. */
export function readInterfaceLanguage(row: SettingsRow | undefined): ReadAnswer['selection'] {
  if (!row || !Object.hasOwn(row.values, 'den.interfaceLanguage'))
    return { language: 'en', explicit: false, supported: true };
  const value = row.values['den.interfaceLanguage']?.value ?? null;
  try {
    return syncPolicy<ReadAnswer>({
      op: 'preferences_interface_language_v1',
      operation: 'read',
      values: { 'den.interfaceLanguage': value },
    }).selection;
  } catch {
    // Malformed or newer state is never rewritten by this reader. English is the safe presentation fallback.
    return { language: 'en', explicit: true, supported: false };
  }
}

export function writeInterfaceLanguage(
  language: InterfaceLanguage,
): Record<string, ConfigValue | null> {
  return syncPolicy<WriteAnswer>({
    op: 'preferences_interface_language_v1',
    operation: 'write',
    language,
  }).changes;
}
