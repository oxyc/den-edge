import { RATING_SOURCES } from '../settings/catalogs';
import type { PreferenceChanges } from '../settings/preferences';
import type { LibraryPreferences, ServiceRef } from './libraryServiceProtocol';
import type { Immutable, LibraryModel } from './libraryModel.svelte';
import type { ProfileIdentity } from './profileIdentity';
import type { ProfilePolicy } from './profilePolicy';
import type { VisitorActivityNamespace } from './visitorProfileSession.svelte';
import {
  isProfileLanguage,
  isProfileRegion,
  isProfileSubtitleLimit,
  isProfileYear,
  PROFILE_GENRE_LIMIT,
  PROFILE_LANGUAGE_LIMIT,
  PROFILE_RATING_SOURCES,
  PROFILE_SERVICE_LIMIT,
  PROFILE_WARNING_CATEGORIES,
} from './profilePreferenceSchema';

const KID_PREFIX = 'den.profile.preferences.preview.v1:';
const VISITOR_DOCUMENT = 'preferences';

type Events = Pick<Window, 'addEventListener' | 'removeEventListener'>;
/**
 * A preview profile's own document. `watchRegion` and `servicesConfigured` say whether it has chosen its own region and
 * services yet: until it has, it reads the household's, so a Kid shown before its library opens still sees the list it
 * would have been seeded with.
 */
type PersonalPreferences = Omit<LibraryPreferences, 'maturityCeiling'>;

export interface ProfilePreferences {
  readonly value: LibraryPreferences | undefined;
  readonly policy: ProfilePolicy;
  patch(changes: PreferenceChanges): Promise<void>;
  close(): void;
}

const personalDefaults = (): PersonalPreferences => ({
  excludedGenres: [],
  excludedLanguages: [],
  hideAnime: false,
  hideWatched: false,
  minReleaseYear: undefined,
  audioLanguage: undefined,
  subtitleLanguage: undefined,
  hasExplicitSubtitlePreference: false,
  shownSubtitleLanguages: [],
  subtitlesPerLanguage: 3,
  autoSkipSegments: false,
  autoplayTrailers: true,
  ratingSources: RATING_SOURCES.map((source) => source.id) as PersonalPreferences['ratingSources'],
  shownWarnings: [],
  watchRegion: undefined,
  services: [],
  servicesConfigured: false,
});

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
const numbers = (value: unknown): number[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'number') ? value : undefined;
const validLanguages = (value: unknown): string[] | undefined => {
  const values = strings(value);
  return values && values.length <= PROFILE_LANGUAGE_LIMIT && values.every(isProfileLanguage)
    ? values
    : undefined;
};
const validGenres = (value: unknown): number[] | undefined => {
  const values = numbers(value);
  return values &&
    values.length <= PROFILE_GENRE_LIMIT &&
    values.every((id) => Number.isSafeInteger(id) && id > 0)
    ? values
    : undefined;
};
const validRatings = (value: unknown): PersonalPreferences['ratingSources'] | undefined => {
  const values = strings(value);
  return values &&
    values.length <= PROFILE_RATING_SOURCES.size &&
    values.every((source) => PROFILE_RATING_SOURCES.has(source))
    ? (values as PersonalPreferences['ratingSources'])
    : undefined;
};
const validWarnings = (value: unknown): string[] | undefined => {
  const values = strings(value);
  return values &&
    values.length <= PROFILE_WARNING_CATEGORIES.size &&
    values.every((warning) => PROFILE_WARNING_CATEGORIES.has(warning))
    ? values
    : undefined;
};

/** Damaged preview storage falls back field-by-field and can never inject household/admin settings. */
const readPersonal = (value: unknown): PersonalPreferences => {
  const defaults = personalDefaults();
  if (!value || typeof value !== 'object') return defaults;
  const stored = value as Record<string, unknown>;
  return {
    excludedGenres: validGenres(stored.excludedGenres) ?? defaults.excludedGenres,
    excludedLanguages: validLanguages(stored.excludedLanguages) ?? defaults.excludedLanguages,
    hideAnime: typeof stored.hideAnime === 'boolean' ? stored.hideAnime : defaults.hideAnime,
    hideWatched:
      typeof stored.hideWatched === 'boolean' ? stored.hideWatched : defaults.hideWatched,
    minReleaseYear: isProfileYear(stored.minReleaseYear)
      ? stored.minReleaseYear
      : defaults.minReleaseYear,
    audioLanguage: isProfileLanguage(stored.audioLanguage)
      ? stored.audioLanguage
      : defaults.audioLanguage,
    subtitleLanguage: isProfileLanguage(stored.subtitleLanguage)
      ? stored.subtitleLanguage
      : defaults.subtitleLanguage,
    hasExplicitSubtitlePreference:
      typeof stored.hasExplicitSubtitlePreference === 'boolean'
        ? stored.hasExplicitSubtitlePreference
        : typeof stored.subtitleLanguage === 'string',
    shownSubtitleLanguages:
      validLanguages(stored.shownSubtitleLanguages) ?? defaults.shownSubtitleLanguages,
    subtitlesPerLanguage: isProfileSubtitleLimit(stored.subtitlesPerLanguage)
      ? stored.subtitlesPerLanguage
      : defaults.subtitlesPerLanguage,
    autoSkipSegments:
      typeof stored.autoSkipSegments === 'boolean'
        ? stored.autoSkipSegments
        : defaults.autoSkipSegments,
    autoplayTrailers:
      typeof stored.autoplayTrailers === 'boolean'
        ? stored.autoplayTrailers
        : defaults.autoplayTrailers,
    ratingSources: validRatings(stored.ratingSources) ?? defaults.ratingSources,
    shownWarnings: validWarnings(stored.shownWarnings) ?? defaults.shownWarnings,
    watchRegion: isProfileRegion(stored.watchRegion) ? stored.watchRegion : defaults.watchRegion,
    ...readServices(stored),
  };
};

const readServices = (
  stored: Record<string, unknown>,
): Pick<PersonalPreferences, 'services' | 'servicesConfigured'> => {
  const services = stored.services;
  const valid =
    Array.isArray(services) &&
    services.length <= PROFILE_SERVICE_LIMIT &&
    services.every(
      (pick): pick is ServiceRef =>
        !!pick &&
        typeof pick === 'object' &&
        Number.isSafeInteger((pick as ServiceRef).id) &&
        (pick as ServiceRef).id > 0 &&
        isProfileRegion((pick as ServiceRef).country),
    );
  const picks = valid ? services : [];
  return stored.servicesConfigured === true && valid
    ? { services: picks.map(({ id, country }) => ({ id, country })), servicesConfigured: true }
    : { services: [], servicesConfigured: false };
};

const applyPersonalPatch = (
  current: PersonalPreferences,
  patch: PreferenceChanges,
): PersonalPreferences => {
  assertPersonalPatch(patch);
  const next = structuredClone(current);
  if (patch.watchRegion !== undefined) next.watchRegion = patch.watchRegion ?? undefined;
  if (patch.services)
    Object.assign(
      next,
      patch.services.kind === 'default'
        ? { services: [], servicesConfigured: false }
        : { services: patch.services.values.map((s) => ({ ...s })), servicesConfigured: true },
    );
  if (patch.excludedGenres) next.excludedGenres = [...patch.excludedGenres];
  if (patch.excludedLanguages) next.excludedLanguages = [...patch.excludedLanguages];
  if (patch.hideAnime !== undefined) next.hideAnime = patch.hideAnime;
  if (patch.hideWatched !== undefined) next.hideWatched = patch.hideWatched;
  if (patch.minReleaseYear !== undefined) next.minReleaseYear = patch.minReleaseYear ?? undefined;
  if (patch.audioLanguage !== undefined) next.audioLanguage = patch.audioLanguage ?? undefined;
  if (patch.subtitlePreference !== undefined) {
    next.hasExplicitSubtitlePreference = patch.subtitlePreference.mode !== 'automatic';
    next.subtitleLanguage =
      patch.subtitlePreference.mode === 'language' ? patch.subtitlePreference.language : undefined;
  }
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
export class PreviewProfilePreferences implements ProfilePreferences {
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
    const own = structuredClone(this.#personal);
    return {
      ...own,
      watchRegion: own.watchRegion ?? household.watchRegion,
      services: own.servicesConfigured ? own.services : [...household.services],
      servicesConfigured: own.servicesConfigured || household.servicesConfigured,
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

/**
 * A persistent profile's preference document: every preference, region and services included, is read from and
 * written to the profile's own encrypted library, never the household (profiles-v1 §6). Only the content policy is not
 * here: it lives in the directory.
 */
export class SyncedProfilePreferences implements ProfilePreferences {
  readonly policy: ProfilePolicy;

  constructor(
    readonly identity: ProfileIdentity,
    private readonly model: LibraryModel,
  ) {
    if (identity.kind !== 'profile')
      throw new TypeError('Synced profile preferences require a persistent profile');
    const effectiveSettings = () => {
      const personal = model.settings;
      const preferences = personal.value?.preferences;
      return {
        connection: personal.connection,
        version: personal.version,
        error: personal.error,
        value: preferences
          ? {
              kind: 'settings' as const,
              preferences: ownPreferences(preferences),
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
  }

  get value(): LibraryPreferences | undefined {
    const preferences = this.model.settings.value?.preferences;
    return preferences ? ownPreferences(preferences) : undefined;
  }

  async patch(changes: PreferenceChanges): Promise<void> {
    assertPersonalPatch(changes);
    await this.model.patchPreferences(changes);
  }

  close(): void {}
}

const assertPersonalPatch = (patch: PreferenceChanges): void => {
  if ('maturityCeiling' in patch)
    throw new TypeError('A profile cannot write its content policy through preferences');
  const valid =
    (patch.minReleaseYear === undefined ||
      patch.minReleaseYear === null ||
      isProfileYear(patch.minReleaseYear)) &&
    (patch.audioLanguage === undefined ||
      patch.audioLanguage === null ||
      isProfileLanguage(patch.audioLanguage)) &&
    (patch.subtitlePreference === undefined ||
      patch.subtitlePreference.mode !== 'language' ||
      isProfileLanguage(patch.subtitlePreference.language)) &&
    (patch.excludedGenres === undefined || validGenres(patch.excludedGenres) !== undefined) &&
    (patch.excludedLanguages === undefined ||
      validLanguages(patch.excludedLanguages) !== undefined) &&
    (patch.shownSubtitleLanguages === undefined ||
      validLanguages(patch.shownSubtitleLanguages) !== undefined) &&
    (patch.subtitlesPerLanguage === undefined ||
      isProfileSubtitleLimit(patch.subtitlesPerLanguage)) &&
    (patch.ratingSources === undefined ||
      patch.ratingSources.kind === 'default' ||
      validRatings(patch.ratingSources.values) !== undefined) &&
    (patch.shownWarnings === undefined || validWarnings(patch.shownWarnings) !== undefined) &&
    (patch.watchRegion === undefined ||
      patch.watchRegion === null ||
      isProfileRegion(patch.watchRegion)) &&
    (patch.services === undefined ||
      patch.services.kind === 'default' ||
      (patch.services.values.length <= PROFILE_SERVICE_LIMIT &&
        patch.services.values.every(
          ({ id, country }) => Number.isSafeInteger(id) && id > 0 && isProfileRegion(country),
        )));
  if (!valid) throw new TypeError('Profile preference patch is outside the shared schema');
};

const ownPreferences = (preferences: Immutable<LibraryPreferences>): LibraryPreferences => ({
  ...(structuredClone(preferences) as LibraryPreferences),
  maturityCeiling: undefined,
});
