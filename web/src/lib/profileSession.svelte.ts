import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { contentPolicyFor, failsClosed, PolicedContent, policyKey } from './contentPolicy';
import type { ContentServiceClientPort } from './contentServiceClient';
import { HouseholdSession } from './householdSession.svelte';
import { titleKey, type Shape, type Title } from './library';
import { cancelLibraryTitleNaming } from './libraryNaming';
import type { LibraryModel } from './libraryModel.svelte';
import { libraryUpdateRequired } from './libraryUpdateRequired';
import { profilePolicy, type ProfileContentPolicy, type ProfilePolicy } from './profilePolicy';
import {
  legacyProfileIdentity,
  type PersistentProfileIdentity,
  type ProfileIdentity,
} from './profileIdentity';
import type {
  LibraryMetadataShape,
  LibraryMetadataTitle,
  TitleRef,
} from './libraryServiceProtocol';
import type { ProfileActivity } from './visitorActivity.svelte';
import { SyncedProfilePreferences, type ProfilePreferences } from './profilePreferences.svelte';
import { LocalizedContent } from './localizedContent';
import { isInterfaceLanguage, type InterfaceLanguage } from './interfaceLanguage';

const TOAST_MS = 6_000;
/** How long the first content request waits for the profile settings that name the watch region. */
const REGION_WAIT_MS = 3_000;
/** The watch region this browser last read for a profile: a country code, so it needs no protection. */
const REGION_KEY = 'den.profile.watch-region.v1';

/** Every profile has its own region (profiles-v1 §6), so what a browser remembers is kept per profile. */
const regionKey = (identity: ProfileIdentity): string =>
  identity.kind === 'profile' ? `${REGION_KEY}:${identity.id}` : REGION_KEY;

function rememberedRegion(identity: ProfileIdentity): string | undefined {
  try {
    const region = globalThis.localStorage?.getItem(regionKey(identity));
    return region && /^[A-Z]{2}$/.test(region) ? region : undefined;
  } catch {
    return undefined;
  }
}

function rememberRegion(identity: ProfileIdentity, region: string | undefined): void {
  try {
    if (region && /^[A-Z]{2}$/.test(region))
      globalThis.localStorage?.setItem(regionKey(identity), region);
    else globalThis.localStorage?.removeItem(regionKey(identity));
  } catch {
    // Storage refused (a private window): the next session waits for the settings again.
  }
}

/**
 * Active-profile presentation and activity state. Every persistent profile will use this same class; this first
 * inactive slice gives the legacy Owner the current mixed model without starting a second log or changing data.
 */
export class ProfileSession {
  readonly shapes = new SvelteMap<string, Shape>();
  live = $state(false);
  /** This browser's player is open: the library service pauses its maintenance meanwhile. */
  playerOpen = $state(false);
  toast = $state<string | null>(null);
  undo = $state<{ label: string; run: () => void } | null>(null);
  /** The page has drawn what it opened for (`foregroundReady`): optional background work may start. */
  foregrounded = $state(false);
  readonly #content: ContentServiceClientPort;
  #localizedContent?: ContentServiceClientPort;
  #region?: Promise<string | undefined>;
  readonly #displays = new SvelteMap<string, Title>();
  readonly #missing = new SvelteSet<string>();
  #toastTimer?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(
    readonly identity: ProfileIdentity,
    readonly household: HouseholdSession,
    readonly model: LibraryModel | null,
    readonly local: boolean,
    private closeHousehold: boolean,
    /** Household policy is readable without lending the profile an Owner activity/write model. */
    readonly policy: ProfilePolicy | null = profilePolicy(model),
    /** Device-local activity only for Visitor; never a synced Owner LibraryModel. */
    readonly profileActivity: ProfileActivity | null = null,
    /** Numeric directory policy stays distinct from legacy presentation preferences. */
    readonly contentPolicy: ProfileContentPolicy | null = null,
    /** Personal preference projection. Persistent profiles write only to their own encrypted activity library. */
    readonly preferences: ProfilePreferences | null = null,
    /** Owns the separate Worker session behind a directory-backed activity model. */
    private readonly closeActivityModel: (() => void) | null = null,
    /**
     * Whether this session may change household-scoped state: downloads, linking, assistant consent. Only the
     * legacy topology and a persistent Owner do; the coordinator builds every Kid and Visitor session with false.
     */
    readonly administersHousehold: boolean = true,
    /** A Kid is held to the audience-relevance gate on top of its age policy (profiles-v1 §5). */
    readonly kid: boolean = false,
    /** Validated effective approvals for this Kid; empty for Owner and Visitor. */
    readonly approvedTitles: readonly TitleRef[] = [],
  ) {
    const policed = this.restricted
      ? new PolicedContent(household.content, async () =>
          contentPolicyFor(
            this.contentPolicy,
            this.kid,
            await this.#watchRegion(),
            this.approvedTitles,
          ),
        )
      : null;
    this.#content = policed ?? household.content;
  }

  /**
   * This profile's watch region, read once for the session so every request this session makes names the same
   * region and no cache is split by it arriving late. The region this browser last read for this profile is used at
   * once, so a restricted profile's first request does not wait on its settings; without one, the first request
   * waits for them (bounded). Either way the settled value is kept for the next session, so a changed region
   * applies from the next load.
   */
  #watchRegion(): Promise<string | undefined> {
    return (this.#region ??= (async () => {
      const settled = this.#settledRegion();
      void settled.then((read) => {
        if (read.known) rememberRegion(this.identity, read.region);
      });
      return rememberedRegion(this.identity) ?? (await settled).region;
    })());
  }

  async #settledRegion(): Promise<{ known: boolean; region?: string }> {
    const model = this.model;
    if (model) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.resolve(model.ready).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, REGION_WAIT_MS))),
      ]);
      clearTimeout(timer);
    }
    // Profile-scoped (profiles-v1 §6): each profile reads its own region, so a Kid latches its own, not the Owner's.
    const settings = this.policy?.settings?.value;
    return { known: !!settings, region: settings?.preferences.watchRegion?.toUpperCase() };
  }

  /**
   * Every content query this profile makes runs under its policy: the page, the Worker and atlas all see the same
   * one. An unrestricted profile (the legacy household, an Owner with no ceiling) uses the household port as-is.
   */
  get content(): ContentServiceClientPort {
    if (this.interfaceLanguage === 'en') return this.#content;
    return (this.#localizedContent ??= new LocalizedContent(
      this.#content,
      () => this.interfaceLanguage,
    ));
  }

  /** Resolved once by the settings projection; the closure lets a saved language affect the next content request. */
  get interfaceLanguage(): InterfaceLanguage {
    const selected =
      this.preferences?.value?.interfaceLanguage ??
      this.policy?.settings?.value?.preferences.interfaceLanguage;
    return isInterfaceLanguage(selected) ? selected : 'en';
  }

  /** Whether this profile's content is limited by a ceiling, an unknown-rating block or the Kid audience gate. */
  get restricted(): boolean {
    return contentPolicyFor(this.contentPolicy, this.kid) !== undefined;
  }

  /** Whether it blocks what no store has aged (`unknownRatings: block`, every Kid): TMDB-only surfaces are hidden. */
  get failsClosed(): boolean {
    return failsClosed(contentPolicyFor(this.contentPolicy, this.kid));
  }

  /**
   * What every policy-dependent cache this profile keeps is keyed by; undefined when it has no policy, which leaves
   * the legacy household's names and stored values exactly as they were.
   */
  get policyKey(): string | undefined {
    const policy = contentPolicyFor(this.contentPolicy, this.kid);
    return policy ? policyKey(policy) : undefined;
  }

  get services() {
    return this.household.services;
  }

  get alert(): string | null {
    const status = this.model?.status;
    if (this.updateRequired) return 'Library update required';
    if (status?.kind === 'read-only') return status.reason;
    if (status?.kind === 'moved') return 'This library moved to a new key';
    return null;
  }

  /** A real den-edge wire fence, distinct from an unreachable or retryable library failure. */
  get updateRequired(): boolean {
    return this.household.updateRequired || libraryUpdateRequired(this.model);
  }

  configureServices(): void {
    this.household.configureServices();
  }

  publishLibraryMetadata(
    titles: Title[],
    shapes: ReadonlyArray<readonly [string, Shape]>,
    missing: readonly TitleRef[] = [],
  ): void {
    for (const title of titles) {
      const key = titleKey(title);
      if (!this.#displays.has(key)) this.#displays.set(key, title);
    }
    for (const ref of missing) {
      const key = titleKey(ref);
      if (!this.#displays.has(key)) this.#missing.add(key);
    }
    for (const [key, shape] of shapes) this.shapes.set(key, shape);
  }

  async libraryMetadata(refs: readonly TitleRef[]): Promise<{
    titles: LibraryMetadataTitle[];
    shapes: LibraryMetadataShape[];
    retryable: TitleRef[];
    retryAfterMs?: number;
  }> {
    const found = (await this.model?.libraryMetadata(refs)) ?? {
      titles: [],
      shapes: [],
      retryable: [],
    };
    if (!this.model || !this.restricted || !refs.length) return found;
    // The library names its own titles through its own provider reads. A title the policy does not establish is
    // answered as absent, so no shelf, history row or seed shows it; a policy that cannot be asked refuses all.
    const allowed = await this.content
      .query({ kind: 'title.eligibility', titles: refs.map(({ type, id }) => ({ type, id })) })
      .then(
        (answer) => new SvelteSet(answer.allowed.map(titleKey)),
        () => new SvelteSet<string>(),
      );
    return {
      ...found,
      titles: found.titles.filter((title) => allowed.has(titleKey(title))),
      shapes: found.shapes.filter((shape) => allowed.has(titleKey(shape.title))),
      retryable: found.retryable.filter((ref) => allowed.has(titleKey(ref))),
    };
  }

  rememberTitle(title: Title): void {
    this.publishLibraryMetadata([title], []);
  }

  displayTitle(ref: Pick<Title, 'type' | 'id'>): Title | undefined {
    return this.#displays.get(titleKey(ref));
  }

  displayMissing(ref: Pick<Title, 'type' | 'id'>): boolean {
    return this.#missing.has(titleKey(ref));
  }

  displayTitles(): ReadonlyMap<string, Title> {
    return this.#displays;
  }

  foregroundReady(): void {
    this.foregrounded = true;
    this.household.foreground();
    if (!this.household.ownsModel(this.model)) void this.model?.foregroundReady().catch(() => {});
  }

  notify(
    message: string,
    {
      holdMs = TOAST_MS,
      undo = null,
    }: { holdMs?: number; undo?: { label: string; run: () => void } | null } = {},
  ): void {
    this.toast = message;
    this.undo = undo;
    clearTimeout(this.#toastTimer);
    if (Number.isFinite(holdMs))
      this.#toastTimer = setTimeout(() => {
        this.toast = null;
        this.undo = null;
      }, holdMs);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    cancelLibraryTitleNaming(this);
    clearTimeout(this.#toastTimer);
    this.preferences?.close();
    if (this.closeHousehold) this.household.close();
    else if (!this.household.ownsModel(this.model)) {
      if (this.closeActivityModel) this.closeActivityModel();
      else this.model?.close();
    }
  }

  /** Transfer the shared household lifetime to the profiles coordinator before this session is switched away. */
  relinquishHouseholdOwnership(): void {
    this.closeHousehold = false;
  }
}

/** A directory-backed active profile sharing the household's content/provider authority. */
export function activeProfileSession(
  identity: PersistentProfileIdentity,
  household: HouseholdSession,
  model: LibraryModel,
  closeActivityModel: (() => void) | null = null,
  contentPolicy: ProfileContentPolicy | null = null,
  administersHousehold = false,
  kid = false,
  approvedTitles: readonly TitleRef[] = [],
): ProfileSession {
  const preferences = household.policy ? new SyncedProfilePreferences(identity, model) : null;
  return new ProfileSession(
    identity,
    household,
    model,
    false,
    false,
    preferences?.policy ?? undefined,
    null,
    contentPolicy,
    preferences,
    closeActivityModel,
    administersHousehold,
    kid,
    approvedTitles,
  );
}

/** Today's one-log topology expressed through the household/profile boundary. */
export function legacyProfileSession(
  libraryKey: string | null,
  local: boolean,
  model: LibraryModel | null,
  content: ContentServiceClientPort,
  closeWorkerServices: () => void = () => {},
): ProfileSession {
  const household = new HouseholdSession(
    { kind: 'legacy', libraryKey, configurationOnly: false },
    model,
    content,
    closeWorkerServices,
  );
  return new ProfileSession(
    legacyProfileIdentity(libraryKey, local),
    household,
    model,
    local,
    true,
  );
}
