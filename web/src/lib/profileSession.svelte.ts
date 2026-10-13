import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { ContentServiceClientPort } from './contentServiceClient';
import { HouseholdSession } from './householdSession.svelte';
import { titleKey, type Shape, type Title } from './library';
import { cancelLibraryTitleNaming } from './libraryNaming';
import type { LibraryModel } from './libraryModel.svelte';
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

const TOAST_MS = 6_000;

/**
 * Active-profile presentation and activity state. Every persistent profile will use this same class; this first
 * inactive slice gives the legacy Owner the current mixed model without starting a second log or changing data.
 */
export class ProfileSession {
  readonly shapes = new SvelteMap<string, Shape>();
  live = $state(false);
  toast = $state<string | null>(null);
  undo = $state<{ label: string; run: () => void } | null>(null);
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
  ) {}

  get content(): ContentServiceClientPort {
    return this.household.content;
  }

  get services() {
    return this.household.services;
  }

  get alert(): string | null {
    const status = this.model?.status;
    if (status?.kind === 'read-only') return status.reason;
    if (status?.kind === 'moved') return 'This library moved to a new key';
    return null;
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
    return this.model?.libraryMetadata(refs) ?? { titles: [], shapes: [], retryable: [] };
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
    if (this.closeHousehold) this.household.close();
    else if (!this.household.ownsModel(this.model)) this.model?.close();
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
): ProfileSession {
  return new ProfileSession(identity, household, model, false, false);
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
