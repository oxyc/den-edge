import type { InterfaceLanguage } from './interfaceLanguage';

const LEGACY_KEY = 'den.interfaceLanguage.presentation.v1';
const KEY_PREFIX = 'den.interfaceLanguage.presentation.v2.';
const WRITTEN_AT_SUFFIX = '.written-at';
const REVALIDATION_GRACE_MS = 5 * 60_000;
const isInterfaceLanguage = (value: unknown): value is InterfaceLanguage =>
  value === 'en' || value === 'es' || value === 'sv';

const availableStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** The active profile is durable before its presentation session changes, so it can scope the first-frame hint. */
export function currentPresentationScope(
  source: Pick<Storage, 'getItem'> | undefined = availableStorage(),
): string {
  try {
    const value: unknown = JSON.parse(source?.getItem('den.profile.active.v1') ?? 'null');
    if (!value || typeof value !== 'object' || !('mode' in value)) return 'default';
    if (
      value.mode === 'persistent' &&
      'profileId' in value &&
      typeof value.profileId === 'string' &&
      /^[0-9a-f]{32}$/.test(value.profileId)
    )
      return `profile-${value.profileId}`;
    if (value.mode === 'visitor') {
      const id =
        'visitorNamespace' in value && typeof value.visitorNamespace === 'string'
          ? value.visitorNamespace
          : 'visitId' in value && typeof value.visitId === 'string'
            ? value.visitId
            : null;
      if (id && /^[0-9a-f]{32}$/.test(id)) return `visitor-${id}`;
    }
    if (value.mode === 'owner') return 'owner';
  } catch {
    // A damaged marker cannot safely name retained presentation state.
  }
  return 'default';
}

export const presentationLanguageKeyForScope = (scope: string): string => `${KEY_PREFIX}${scope}`;

export const presentationLanguageKey = (source: Pick<Storage, 'getItem'> | undefined): string =>
  presentationLanguageKeyForScope(currentPresentationScope(source));

export function readPresentationLanguageHint(
  source: Pick<Storage, 'getItem'> | undefined = availableStorage(),
): InterfaceLanguage | undefined {
  try {
    const value = source?.getItem(presentationLanguageKey(source)) ?? source?.getItem(LEGACY_KEY);
    return isInterfaceLanguage(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A just-selected browser value wins while its encrypted synced projection catches up after a reload. */
export function readFreshPresentationLanguageHint(
  source: Pick<Storage, 'getItem'> | undefined = availableStorage(),
  now = Date.now(),
): InterfaceLanguage | undefined {
  try {
    const key = presentationLanguageKey(source);
    const language = source?.getItem(key);
    const writtenAt = Number(source?.getItem(`${key}${WRITTEN_AT_SUFFIX}`));
    return isInterfaceLanguage(language) &&
      Number.isFinite(writtenAt) &&
      writtenAt > 0 &&
      now - writtenAt >= 0 &&
      now - writtenAt <= REVALIDATION_GRACE_MS
      ? language
      : undefined;
  } catch {
    return undefined;
  }
}

export function rememberPresentationLanguage(
  language: InterfaceLanguage,
  target: Pick<Storage, 'getItem' | 'setItem'> | undefined = availableStorage(),
): void {
  try {
    target?.setItem(presentationLanguageKey(target), language);
  } catch {
    // The synced preference remains authoritative; only this profile's next first-frame hint is unavailable.
  }
}

/** Mark a completed viewer selection as newer than a projection that may be stale during the next reload. */
export function rememberFreshPresentationLanguage(
  language: InterfaceLanguage,
  target: Pick<Storage, 'getItem' | 'setItem'> | undefined = availableStorage(),
): void {
  try {
    const key = presentationLanguageKey(target);
    target?.setItem(key, language);
    target?.setItem(`${key}${WRITTEN_AT_SUFFIX}`, String(Date.now()));
  } catch {
    // Sync still holds the choice; only its short reload bridge is unavailable.
  }
}
