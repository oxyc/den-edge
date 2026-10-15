import { RATING_SOURCES } from '../settings/catalogs';
import type { PreferenceChanges } from '../settings/preferences';
import type { LibraryPreferences, ServiceRef } from './libraryServiceProtocol';
import type { Immutable, LibraryModel } from './libraryModel.svelte';
import type { ProfileIdentity } from './profileIdentity';
import type { ProfilePolicy } from './profilePolicy';
import type { VisitorActivityNamespace } from './visitorProfileSession.svelte';

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
    watchRegion:
      typeof stored.watchRegion === 'string' && /^[A-Z]{2}$/.test(stored.watchRegion)
        ? stored.watchRegion
        : defaults.watchRegion,
    ...readServices(stored),
  };
};

const readServices = (
  stored: Record<string, unknown>,
): Pick<PersonalPreferences, 'services' | 'servicesConfigured'> => {
  const picks = Array.isArray(stored.services)
    ? stored.services.filter(
        (pick): pick is ServiceRef =>
          !!pick &&
          typeof pick === 'object' &&
          Number.isInteger((pick as ServiceRef).id) &&
          typeof (pick as ServiceRef).country === 'string',
      )
    : [];
  return stored.servicesConfigured === true
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
};

const ownPreferences = (preferences: Immutable<LibraryPreferences>): LibraryPreferences => ({
  ...(structuredClone(preferences) as LibraryPreferences),
  maturityCeiling: undefined,
});
