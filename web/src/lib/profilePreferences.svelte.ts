import { RATING_SOURCES } from '../settings/catalogs';
import type { PreferenceChanges } from '../settings/preferences';
import type { LibraryPreferences } from './libraryServiceProtocol';
import type { ProfileIdentity } from './profileIdentity';
import type { ProfilePolicy } from './profilePolicy';
import type { VisitorActivityNamespace } from './visitorProfileSession.svelte';

const KID_PREFIX = 'den.profile.preferences.preview.v1:';
const VISITOR_DOCUMENT = 'preferences';

type Events = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type PersonalPreferences = Omit<
  LibraryPreferences,
  'watchRegion' | 'services' | 'servicesConfigured' | 'maturityCeiling'
>;

const personalDefaults = (): PersonalPreferences => ({
  excludedGenres: [],
  excludedLanguages: [],
  hideAnime: false,
  hideWatched: false,
  minReleaseYear: undefined,
  audioLanguage: undefined,
  subtitleLanguage: undefined,
  shownSubtitleLanguages: [],
  subtitlesPerLanguage: 3,
  autoSkipSegments: false,
  autoplayTrailers: true,
  ratingSources: RATING_SOURCES.map((source) => source.id) as PersonalPreferences['ratingSources'],
  shownWarnings: [],
});

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
const numbers = (value: unknown): number[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'number') ? value : undefined;

/** Damaged preview storage falls back field-by-field and can never inject household/admin settings. */
const readPersonal = (value: unknown): PersonalPreferences => {
  const defaults = personalDefaults();
  if (!value || typeof value !== 'object') return defaults;
  const stored = value as Record<string, unknown>;
  return {
    excludedGenres: numbers(stored.excludedGenres) ?? defaults.excludedGenres,
    excludedLanguages: strings(stored.excludedLanguages) ?? defaults.excludedLanguages,
    hideAnime: typeof stored.hideAnime === 'boolean' ? stored.hideAnime : defaults.hideAnime,
    hideWatched:
      typeof stored.hideWatched === 'boolean' ? stored.hideWatched : defaults.hideWatched,
    minReleaseYear:
      typeof stored.minReleaseYear === 'number' ? stored.minReleaseYear : defaults.minReleaseYear,
    audioLanguage:
      typeof stored.audioLanguage === 'string' ? stored.audioLanguage : defaults.audioLanguage,
    subtitleLanguage:
      typeof stored.subtitleLanguage === 'string'
        ? stored.subtitleLanguage
        : defaults.subtitleLanguage,
    shownSubtitleLanguages:
      strings(stored.shownSubtitleLanguages) ?? defaults.shownSubtitleLanguages,
    subtitlesPerLanguage:
      typeof stored.subtitlesPerLanguage === 'number'
        ? Math.max(0, Math.trunc(stored.subtitlesPerLanguage))
        : defaults.subtitlesPerLanguage,
    autoSkipSegments:
      typeof stored.autoSkipSegments === 'boolean'
        ? stored.autoSkipSegments
        : defaults.autoSkipSegments,
    autoplayTrailers:
      typeof stored.autoplayTrailers === 'boolean'
        ? stored.autoplayTrailers
        : defaults.autoplayTrailers,
    ratingSources:
      (strings(stored.ratingSources)?.filter((source) =>
        RATING_SOURCES.some((known) => known.id === source),
      ) as PersonalPreferences['ratingSources'] | undefined) ?? defaults.ratingSources,
    shownWarnings: strings(stored.shownWarnings) ?? defaults.shownWarnings,
  };
};

const applyPersonalPatch = (
  current: PersonalPreferences,
  patch: PreferenceChanges,
): PersonalPreferences => {
  if ('watchRegion' in patch || 'services' in patch || 'maturityCeiling' in patch)
    throw new TypeError('A profile cannot write household settings or content policy');
  const next = structuredClone(current);
  if (patch.excludedGenres) next.excludedGenres = [...patch.excludedGenres];
  if (patch.excludedLanguages) next.excludedLanguages = [...patch.excludedLanguages];
  if (patch.hideAnime !== undefined) next.hideAnime = patch.hideAnime;
  if (patch.hideWatched !== undefined) next.hideWatched = patch.hideWatched;
  if (patch.minReleaseYear !== undefined) next.minReleaseYear = patch.minReleaseYear ?? undefined;
  if (patch.audioLanguage !== undefined) next.audioLanguage = patch.audioLanguage ?? undefined;
  if (patch.subtitleLanguage !== undefined)
    next.subtitleLanguage = patch.subtitleLanguage ?? undefined;
  if (patch.shownSubtitleLanguages) next.shownSubtitleLanguages = [...patch.shownSubtitleLanguages];
  if (patch.subtitlesPerLanguage !== undefined)
    next.subtitlesPerLanguage = patch.subtitlesPerLanguage;
  if (patch.autoSkipSegments !== undefined) next.autoSkipSegments = patch.autoSkipSegments;
  if (patch.autoplayTrailers !== undefined) next.autoplayTrailers = patch.autoplayTrailers;
  if (patch.ratingSources)
    next.ratingSources =
      patch.ratingSources.kind === 'default'
        ? personalDefaults().ratingSources
        : [...patch.ratingSources.values];
  if (patch.shownWarnings) next.shownWarnings = [...patch.shownWarnings];
  return next;
};

/**
 * Preview-only preference storage. Kid is durable under its profile ID; Visitor lives inside the disposable visit
 * namespace, so the same end-visit operation that removes activity also removes preferences.
 */
export class PreviewProfilePreferences {
  #personal = $state.raw<PersonalPreferences>(personalDefaults());
  readonly #kidKey: string | null;
  readonly #visitor: VisitorActivityNamespace | null;
  readonly policy: ProfilePolicy;

  constructor(
    readonly identity: ProfileIdentity,
    readonly household: ProfilePolicy,
    private readonly storage: Storage = localStorage,
    private readonly events: Events | null = typeof window === 'undefined' ? null : window,
    visitor: VisitorActivityNamespace | null = null,
  ) {
    if (identity.kind === 'profile') {
      this.#kidKey = `${KID_PREFIX}${identity.id}`;
      this.#visitor = null;
      this.#personal = this.#readKid();
    } else if (identity.kind === 'visitor' && visitor) {
      this.#kidKey = null;
      this.#visitor = visitor;
      this.#personal = readPersonal(visitor.get(VISITOR_DOCUMENT));
    } else {
      throw new TypeError('Preview profile preferences require Kid or Visitor');
    }
    const effectiveSettings = () => {
      const source = household.settings;
      const value = source.value;
      return {
        connection: source.connection,
        version: source.version,
        error: source.error,
        value: value
          ? {
              kind: 'settings' as const,
              preferences: this.value!,
              assistant: { read: false, write: false },
            }
          : undefined,
      };
    };
    this.policy = Object.freeze({
      get settings() {
        return effectiveSettings();
      },
    });
    this.events?.addEventListener('storage', this.#storageChanged);
  }

  get value(): LibraryPreferences | undefined {
    const household = this.household.settings.value?.preferences;
    if (!household) return undefined;
    return {
      ...structuredClone(this.#personal),
      watchRegion: household.watchRegion,
      services: [...household.services],
      servicesConfigured: household.servicesConfigured,
      maturityCeiling: undefined,
    };
  }

  async patch(changes: PreferenceChanges): Promise<void> {
    const next = this.#kidKey
      ? applyPersonalPatch(this.#personal, changes)
      : await this.#visitor!.update(VISITOR_DOCUMENT, (current) =>
          applyPersonalPatch(readPersonal(current), changes),
        );
    if (this.#kidKey) this.storage.setItem(this.#kidKey, JSON.stringify(next));
    this.#personal = next;
  }

  close(): void {
    this.events?.removeEventListener('storage', this.#storageChanged);
  }

  #readKid(): PersonalPreferences {
    try {
      return readPersonal(JSON.parse(this.storage.getItem(this.#kidKey!) ?? 'null'));
    } catch {
      return personalDefaults();
    }
  }

  readonly #storageChanged = (event: StorageEvent): void => {
    if (event.storageArea && event.storageArea !== this.storage) return;
    if (this.#kidKey && event.key === this.#kidKey) this.#personal = this.#readKid();
    else if (this.#visitor?.ownsStorageKey(event.key))
      this.#personal = readPersonal(this.#visitor.get(VISITOR_DOCUMENT));
  };
}
