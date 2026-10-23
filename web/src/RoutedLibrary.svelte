<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import Router from './Router.svelte';
  import Library from './Library.svelte';
  import LibraryStatus from './components/LibraryStatus.svelte';
  import MobileProfileRow from './components/MobileProfileRow.svelte';
  import ProfileOwnerGate from './components/ProfileOwnerGate.svelte';
  import ProfileSettings from './ProfileSettings.svelte';
  import ScreenLoading from './components/ScreenLoading.svelte';
  import {
    activeProfileSession,
    legacyProfileSession,
    type ProfileSession,
  } from './lib/profileSession.svelte';
  import { createWorkerServiceSession } from './lib/libraryServiceFactory';
  import { releaseEarlyLibraryWorkers } from './lib/libraryWorkerStart';
  import { LibraryServiceError } from './lib/libraryServiceClient';
  import { untilServiceSettles } from './lib/serviceSettles';
  import { LibraryModel, type LibraryModelLease } from './lib/libraryModel.svelte';
  import { startGuestLibrary, startingGrant } from './lib/guestLibrary';
  import { legacyClockBootstrap } from './lib/legacyClockBootstrap';
  import { phoneLanding } from './lib/phoneLanding.svelte';
  import {
    links,
    readPendingReset,
    writePendingReset,
    type Link,
    type PendingReset,
  } from './lib/links.svelte';
  import {
    dropLocalLibrary,
    followLocalLibraryKey,
    keptLocalLibraryKey,
    localLibraryKey,
    pendingLocalLibraryMerges,
    rememberLocalLibraryMerge,
    settleLocalLibraryMerge,
  } from './lib/localLibrary';
  import type {
    AssistantConnection,
    KeyResetOutcome,
    ProfileDirectoryView,
  } from './lib/libraryServiceProtocol';
  import type { Explore, PeopleView, Route, TitleSeason } from './lib/route';
  import { LinkScreen, SettingsScreen } from './lib/screens.svelte';
  import type { ApplyResult } from './lib/assistant';
  import { assistantLibrary } from './lib/assistantLibrary.svelte';
  import { householdAssistantFetch, libraryCredentialId } from './lib/relayFetch';
  import { persistentProfileIdentity, profileSessionKey } from './lib/profileIdentity';
  import { resetProfileNavigation } from './lib/profileNavigation';
  import { thisDevice } from './lib/device.svelte';
  import { readProfileHint, saveProfileHint, type ProfileHint } from './lib/profileHint';
  import { knownProfileHousehold, rememberProfileHousehold } from './lib/profileHouseholdHint';
  import {
    allowsImplicitAssistant,
    carryActiveProfile,
    householdAdministration,
    profileMarkerPresent,
    ProfileModeCoordinator,
    previewProfileDirectory,
    profileDirectoryState,
    profilesCapability,
    readActiveProfile,
    usesProfileDirectory,
    type ProfileActivityModelFactory,
    type ProfilesCapability,
  } from './lib/profileModeCoordinator.svelte';
  import { profileHouseholdSettingsModel, profileSettingsRoute } from './lib/profileSettingsRoute';
  import { scopeRecentSearches } from './lib/recentSearches';
  import { PRE_V4_BACKUP_ERROR } from './lib/libraryErrors';
  import {
    startupFailure,
    startupHandedOver,
    startupMark,
    watchStartupHandover,
  } from './lib/startupTiming';
  import { CompoundResetPage } from './lib/profileKeyResetPage';
  import {
    bornHouseholds,
    commitHousehold,
    householdJoinPlan,
    householdPlan,
    keepHouseholdJoin,
    observeKeptActions,
    planHousehold,
    recheckHousehold,
    settledHousehold,
    settleHouseholdJoin,
    settleHouseholdPlan,
    startHouseholdPlan,
    verifyHouseholdPlan,
    type HouseholdJoinPlan,
    type HouseholdPlan,
    type JoinAnswer,
    type JoinLink,
  } from './lib/browserHousehold';

  let {
    link,
    query,
    explore,
    people,
    watchedYear,
    titleSeason,
    onchange,
    onprofilecontrol = () => {},
    onprofilehint = () => {},
    onhouseholdadmin = () => {},
  }: {
    link: Link | null;
    query: string;
    explore: Explore;
    people: PeopleView;
    watchedYear: string | undefined;
    titleSeason: TitleSeason | undefined;
    onchange: (route: Route) => void;
    onprofilecontrol?: (control: ProfileModeCoordinator | null) => void;
    /** The remembered Owner the bar draws until the profile coordinator takes over; null once it has. */
    onprofilehint?: (hint: ProfileHint | null) => void;
    /** Tells the page whether household-level dialogs (invites, phone links, assistant consent) may open. */
    onhouseholdadmin?: (allowed: boolean) => void;
  } = $props();

  // A browser with no TV opens its own household once it has one (den#295); until then, the library kept only here.
  const keptLocal = untrack(() => (link ? null : keptLocalLibraryKey()));
  let ownHousehold = $state<string | null>(
    untrack(() => (link ? null : settledHousehold(keptLocal))),
  );
  const ownKey = untrack(() => (link || ownHousehold ? null : localLibraryKey()));
  // A browser with a library kept only here plans its household beside it: one made just now starts it with its first
  // kept action, one kept here before moves into it as the page opens (`startHousehold`).
  let plannedHousehold = $state.raw(
    untrack(() =>
      link || ownHousehold || !ownKey ? null : (householdPlan() ?? planHousehold(ownKey)),
    ),
  );
  // Kept actions done, and on their way, in the library kept here: a move that copied it goes again if either changed.
  let keptActions = 0;
  let keptPending = 0;
  let keptSettlers: Array<() => void> = [];
  const changeKeptPending = (change: 1 | -1) => {
    keptPending += change;
    if (keptPending !== 0) return;
    const settlers = keptSettlers;
    keptSettlers = [];
    for (const settle of settlers) settle();
  };
  const waitForKeptActions = async () => {
    while (keptPending > 0) await new Promise<void>((resolve) => keptSettlers.push(resolve));
  };
  let libraryIdentity = $state.raw(untrack(() => link?.libraryKey ?? ownHousehold ?? ownKey));

  async function discardLocalLegacyBackup(): Promise<void> {
    const key = libraryIdentity;
    if (!key || !shown.local || shown.alert !== PRE_V4_BACKUP_ERROR) return;
    if (await dropLocalLibrary(key)) location.reload();
    else shown.notify('Couldn’t discard this browser’s old library.');
  }

  let confirmedProfileHousehold = $state<string | null>(
    untrack(() =>
      libraryIdentity && knownProfileHousehold(libraryIdentity) ? libraryIdentity : null,
    ),
  );
  let discoverProfiles: () => void = () => {};

  const confirmProfileHousehold = (libraryKey: string) => {
    rememberProfileHousehold(libraryKey);
    confirmedProfileHousehold = libraryKey;
    // Capability discovery controls creating a profile household. This authenticated household has already made the
    // one-way transition, so its own wire-5 requirement is the authority for reading its profile directory.
    discoverProfiles();
  };
  const realProfilesHost = async () => (await profilesCapability()) === 'enabled';

  /** Startup breadcrumbs for a library that is opening: when it was asked for, and when (or how) it answered. */
  const timeOpening = (what: string, ready: Promise<unknown>) => {
    const requestedAt = performance.now();
    startupMark(`${what} open requested`);
    void ready.then(
      () => startupMark(`${what} opened`, `in ${Math.round(performance.now() - requestedAt)}ms`),
      (error: unknown) =>
        startupMark(
          `${what} open failed`,
          `after ${Math.round(performance.now() - requestedAt)}ms: ${startupFailure(error)}`,
        ),
    );
  };

  // `wire` 5 opens a library known to be a profile household (one this browser made) without the 426 round trip. One
  // this browser saw bootstrapped before skips it too, from the supervisor's remembered hint.
  const open = (key: string | null, local: boolean, wire: 4 | 5 = 4) => {
    // Public browsing uses ContentService without inventing encrypted library state. A local or paired library
    // claims the same already-running Worker, so provider caches and in-flight reads still have one owner.
    const services = createWorkerServiceSession({
      supervisor: {
        knownProfileHousehold,
        onProfileHouseholdConfirmed: confirmProfileHousehold,
      },
    });
    if (!key)
      return legacyProfileSession(null, false, null, services.content, () => services.close());
    const clock = legacyClockBootstrap();
    // The library a household is planned beside starts the household with the first thing kept in it.
    const library =
      local && plannedHousehold
        ? observeKeptActions(
            services.library,
            () => {
              keptActions++;
              void startHousehold();
            },
            changeKeptPending,
          )
        : services.library;
    const model = new LibraryModel(library, {
      libraryKey: key,
      mode: local ? 'local' : 'online',
      wire,
      bootstrapProfileHousehold: !local && wire === 4,
      ...(clock ? { legacyClock: clock } : {}),
    });
    // Root snapshots carry failure state; avoid an unhandled rejection while the error surface renders it.
    void model.ready.catch(() => {});
    timeOpening(local ? 'local session' : 'household session', model.ready);
    return legacyProfileSession(key, local, model, services.content, () => services.close());
  };

  let session = $state.raw(
    untrack(() => open(libraryIdentity, !link && !ownHousehold && libraryIdentity !== null)),
  );
  let routedProfile = untrack(() => profileSessionKey(session.identity, session.policyKey));
  let profileCoordinator = $state.raw<ProfileModeCoordinator | null>(null);
  let profileDirectoryLease = $state.raw<LibraryModelLease<ProfileDirectoryView> | null>(null);
  let profileCapability = $state<ProfilesCapability | 'checking'>(
    untrack(() => (!libraryIdentity || !usesProfileDirectory(session) ? 'disabled' : 'checking')),
  );
  // The directory read answered "none": a non-profile household or a browser-local library.
  let profileDirectoryAbsent = $state(false);
  // Until a directory exists there is nothing to gate behind, so an absent one behaves as disabled.
  const activeCapability = $derived(
    profileCapability === 'enabled' && profileDirectoryAbsent && !profileCoordinator
      ? 'disabled'
      : profileCapability,
  );
  // A remembered Owner is drawn from localStorage on the first frame, before the capability, directory or activity
  // model answer. The coordinator corrects it afterwards; a PIN gate appears only once it decides one is needed.
  const profileHint = untrack(() => (usesProfileDirectory(session) ? readProfileHint() : null));
  $effect(() => {
    if (profileCapability === 'disabled') saveProfileHint(null, null);
  });
  $effect(() => {
    const coordinator = profileCoordinator;
    if (!coordinator) return;
    if (coordinator.session)
      saveProfileHint(coordinator.activeChoice, coordinator.session.identity.libraryKey);
    else if (!coordinator.restoring) saveProfileHint(null, null);
  });
  let profileControlPublished = false;
  let openingCommittedProfiles = false;
  let committedProfilesOpen = 0;
  const settingsRoute = $derived(profileSettingsRoute(session, profileCoordinator?.mode ?? null));
  const householdSettingsModel = $derived(
    profileHouseholdSettingsModel(session, profileCoordinator?.mode ?? null),
  );
  // Every device belongs in the household's device list as soon as it opens the library, not only after somebody
  // visits Settings on that device. This also makes a TV paired from localhost visible later on d.oxy.fi, where the
  // browser-local pairing record does not exist. A rename retriggers this; otherwise selfEntry writes at most daily.
  $effect(() => {
    const model = householdSettingsModel;
    if (!model) return;
    const name = thisDevice.name;
    const timer = setTimeout(
      () =>
        void model
          .heartbeatDevice(name, undefined, __DEN_TV__ ? 'tv' : 'browser')
          .catch((error: unknown) => console.warn('den: this device could not check in', error)),
      1_000,
    );
    return () => clearTimeout(timer);
  });
  // Linking, invites, assistant consent and the saved search list are the household's. A household without profiles
  // keeps them as ever; once profiles are active they open only for the active Owner session.
  const householdAdmin = $derived(
    householdAdministration(
      activeCapability,
      profileCoordinator?.session === session && session.administersHousehold,
      profileMarkerPresent(),
    ),
  );
  $effect.pre(() => scopeRecentSearches(householdAdmin));
  $effect.pre(() => onhouseholdadmin(householdAdmin));
  onDestroy(() => onhouseholdadmin(true));

  // Every retained route owns profile-specific presentation and in-flight work. Before Svelte replaces the keyed
  // route tree, move the old Router to Home with a replace (not a history entry). This also flushes a debounced
  // search address before teardown, so a Kid/Visitor never inherits the previous viewer's detail, Settings route,
  // scroll snapshot or request graph. The pre-effect runs for local and cross-tab switches alike.
  $effect.pre(() => {
    const next = profileSessionKey(session.identity, session.policyKey);
    if (next === routedProfile) return;
    resetProfileNavigation();
    routedProfile = next;
  });
  const profileActivityReady = $derived(
    activeCapability === 'disabled' ||
      activeCapability === 'preview' ||
      (activeCapability === 'enabled' && profileCoordinator?.session === session),
  );
  const implicitAssistantModel = $derived.by(() => {
    const current = session;
    if (!link || current.local || !current.model) return null;
    // A legacy host becomes eligible reactively once discovery explicitly says profiles are disabled, even when
    // the global consent dialog opened first. Enabled hosts remain fail-closed and expose only an active Owner.
    if (activeCapability === 'disabled') return current.model;
    return profileActivityReady && allowsImplicitAssistant(profileCoordinator, current)
      ? current.model
      : null;
  });

  const openProfileActivity: ProfileActivityModelFactory = (libraryKey) => {
    const services = createWorkerServiceSession();
    const model = new LibraryModel(services.library, {
      libraryKey,
      mode: 'online',
      wire: 4,
      bootstrapProfileHousehold: false,
    });
    void model.ready.catch(() => {});
    timeOpening('profile session', model.ready);
    let closed = false;
    return {
      model,
      close: () => {
        if (closed) return;
        closed = true;
        model.close();
        services.close();
      },
    };
  };

  // The remembered Owner's own library, opened from its local cache while the profile pipeline answers. The household
  // bootstrap session holds no activity after the split, so drawing it would pop Continue Watching and the Watchlist in
  // later. When the directory confirms the same Owner library, the coordinator takes this very session over, so the
  // library never has two sessions (two senders of its kept work); otherwise it is closed before another is opened.
  // A hint saved before the library key was recorded has none, and draws the bootstrap session until the next load.
  let optimisticAdopted = false;
  let optimisticOwner = $state.raw<ProfileSession | null>(
    untrack(() => {
      if (!profileHint?.libraryKey) return null;
      const activity = openProfileActivity(profileHint.libraryKey);
      return activeProfileSession(
        persistentProfileIdentity(profileHint.profileId, profileHint.libraryKey),
        session.household,
        activity.model,
        activity.close,
        null,
        true,
      );
    }),
  );
  // Every Worker this page opens with is open by now: one the entry started for nothing (a hint the marker no longer
  // matches) is ended.
  releaseEarlyLibraryWorkers();
  const optimistic = $derived(
    profileHint !== null &&
      (profileCapability === 'checking' ||
        (activeCapability === 'enabled' && !profileCoordinator) ||
        (!!profileCoordinator &&
          (profileCoordinator.session
            ? // The Owner library stays drawn until the coordinator's session has replaced the bootstrap one, so
              // the swap is never seen.
              optimisticOwner !== null && session !== profileCoordinator.session
            : profileCoordinator.restoring))),
  );
  const shown = $derived(optimistic && optimisticOwner ? optimisticOwner : session);
  $effect.pre(() => onprofilehint(optimistic ? profileHint : null));
  // The optimistic Owner frame is the startup this page is timed on: say when it is replaced, and if it is not.
  let optimisticShown = false;
  onMount(() => {
    if (profileHint) watchStartupHandover();
  });
  $effect(() => {
    if (optimistic) {
      optimisticShown = true;
      return;
    }
    if (!optimisticShown) return;
    optimisticShown = false;
    const coordinator = untrack(() => profileCoordinator);
    startupHandedOver(
      coordinator?.session
        ? `${coordinator.mode ?? 'unknown'} session`
        : `no session, capability ${untrack(() => profileCapability)}`,
    );
  });
  $effect(() => {
    if (optimistic || !optimisticOwner) return;
    if (!optimisticAdopted) optimisticOwner.close();
    optimisticOwner = null;
  });
  onDestroy(() => optimisticOwner?.close());

  // Discovery is fail-closed and asynchronous. A library stays behind a neutral gate until discovery completes,
  // so an enabled host can restore Visitor without ever exposing the Owner UI underneath it.
  onMount(() => {
    let current = true;
    let discovering = false;
    discoverProfiles = () => {
      if (discovering || !libraryIdentity || !usesProfileDirectory(session)) return;
      discovering = true;
      profileCapability = 'checking';
      void profilesCapability().then((hostCapability) => {
        discovering = false;
        if (!current) return;
        const capability =
          confirmedProfileHousehold === libraryIdentity ? 'enabled' : hostCapability;
        if (
          (capability !== 'enabled' && capability !== 'preview') ||
          profileCoordinator ||
          !session.model
        ) {
          profileCapability = capability;
          return;
        }
        if (capability === 'preview')
          profileCoordinator = new ProfileModeCoordinator(
            session,
            localStorage,
            window,
            undefined,
            previewProfileDirectory(),
          );
        else {
          startupMark('profile directory lease requested');
          profileDirectoryLease = session.model.profiles();
        }
        profileCapability = capability;
      });
    };
    discoverProfiles();
    return () => {
      current = false;
      committedProfilesOpen++;
      const coordinator = profileCoordinator;
      profileCoordinator = null;
      profileDirectoryLease?.release();
      profileDirectoryLease = null;
      profileControlPublished = false;
      onprofilecontrol(null);
      coordinator?.dispose();
    };
  });

  // A local library that joins a household becomes one: it is discovered then, never left on the legacy Owner path.
  $effect(() => {
    if (session.local) return;
    untrack(discoverProfiles);
  });

  // The directory read must answer. A failed or closed read, or one that stays silent, is fail-closed rather than a
  // spinner that never ends.
  const PROFILE_DIRECTORY_WAIT_MS = 20_000;
  $effect(() => {
    if (profileCapability !== 'enabled' || profileCoordinator) return;
    const snapshot = profileDirectoryLease?.snapshot;
    if (
      !snapshot ||
      (snapshot.value &&
        profileDirectoryState(snapshot.value as ProfileDirectoryView).kind !== 'pending')
    )
      return;
    if (snapshot.connection === 'failed' || snapshot.connection === 'closed') {
      profileCapability = 'indeterminate';
      return;
    }
    const timer = setTimeout(
      () => (profileCapability = 'indeterminate'),
      PROFILE_DIRECTORY_WAIT_MS,
    );
    return () => clearTimeout(timer);
  });

  let directoryMarked = '';
  $effect(() => {
    if (profileCapability !== 'enabled') return;
    const state = profileDirectoryState(
      profileDirectoryLease?.snapshot.value as ProfileDirectoryView | undefined,
    );
    // One line per change of state, with the lease's connection beside it; the connection is read untracked so the
    // log adds no dependency to this effect.
    const connection = untrack(() => profileDirectoryLease?.snapshot.connection ?? 'no lease');
    if (directoryMarked !== `${state.kind}/${connection}`) {
      directoryMarked = `${state.kind}/${connection}`;
      startupMark('profile directory lease value', `${state.kind}, ${connection}`);
    }
    if (state.kind === 'pending') return;
    const directory = state.kind === 'present' ? state.directory : null;
    if (!profileCoordinator) {
      // Answered with no directory: the library runs as it does with profiles disabled until one appears.
      profileDirectoryAbsent = state.kind === 'absent';
      if (state.kind === 'invalid') {
        profileCapability = 'indeterminate';
        return;
      }
      if (!directory || openingCommittedProfiles || !libraryIdentity) return;
      const owner = directory.profiles.find(
        (choice) => choice.id === directory.owner && choice.role === 'owner',
      );
      if (!owner?.id || !owner.libraryKey) {
        profileCapability = 'indeterminate';
        return;
      }
      const legacy = session;
      const opening = ++committedProfilesOpen;
      const first = untrack(() => optimisticOwner);
      const adopt =
        first !== null &&
        first.identity.kind === 'profile' &&
        first.identity.id === owner.id &&
        first.identity.libraryKey === owner.libraryKey &&
        first.household === legacy.household &&
        // The optimistic session is unrestricted, as an Owner with no policy, or an open one, is.
        (!owner.policy ||
          (owner.policy.maximumAge === null && owner.policy.unknownRatings === 'allow'))
          ? first
          : null;
      // Never a second session on a library that already has one: its kept work would be sent by both.
      if (first && !adopt) {
        first.close();
        optimisticOwner = null;
      }
      const activity = adopt
        ? { model: adopt.model!, close: () => adopt.close() }
        : openProfileActivity(owner.libraryKey);
      // A remembered Kid's library opens beside the Owner's rather than after it: the coordinator below needs the Owner
      // open, then restores the Kid, which took two library opens end to end. It takes this handle instead of opening
      // the same library again, and a handle nothing took is closed.
      const saved = readActiveProfile(localStorage);
      const remembered =
        saved?.mode === 'persistent' && saved.profileId !== owner.id
          ? directory.profiles.find((choice) => choice.id === saved.profileId)
          : undefined;
      let early = remembered?.libraryKey
        ? { key: remembered.libraryKey, handle: openProfileActivity(remembered.libraryKey) }
        : null;
      const profileModels: ProfileActivityModelFactory = (key) => {
        if (early?.key !== key) return openProfileActivity(key);
        const { handle } = early;
        early = null;
        return handle;
      };
      const closeEarly = () => {
        early?.handle.close();
        early = null;
      };
      openingCommittedProfiles = true;
      // The coordinator closes the Owner session at once when it restores a remembered Kid, so that profile's load
      // does not wait for the Owner library to open first.
      void (early ? Promise.resolve() : activity.model.ready)
        .then(
          () => {
            if (opening !== committedProfilesOpen || profileCoordinator || session !== legacy) {
              activity.close();
              closeEarly();
              return;
            }
            legacy.household.commitProfiles(libraryIdentity!);
            if (adopt) optimisticAdopted = true;
            const ownerSession =
              adopt ??
              activeProfileSession(
                persistentProfileIdentity(owner.id!, owner.libraryKey!),
                legacy.household,
                activity.model,
                activity.close,
                owner.policy ?? null,
                true,
              );
            legacy.relinquishHouseholdOwnership();
            legacy.close();
            profileCoordinator = new ProfileModeCoordinator(
              ownerSession,
              localStorage,
              window,
              undefined,
              directory,
              profileModels,
            );
            closeEarly();
          },
          () => {
            activity.close();
            closeEarly();
            if (opening === committedProfilesOpen) profileCapability = 'indeterminate';
          },
        )
        .finally(() => {
          if (opening === committedProfilesOpen) openingCommittedProfiles = false;
        });
    } else {
      // Applying a directory closes and opens activity models. Closing a `LibraryModel` reads and rewrites its own
      // snapshot state, so run tracked here this effect would invalidate itself on every pass and never settle.
      // The directory snapshot above is the effect's only input; the coordinator's bookkeeping is not.
      const coordinator = profileCoordinator;
      untrack(() => coordinator.updateDirectory(directory));
    }
  });

  $effect(() => {
    const coordinator = profileCoordinator;
    if (!coordinator) return;
    if (!coordinator.session) coordinator.establishUnprotectedOwner();
    const active = coordinator.session;
    if (!active) return;
    if (session !== active) {
      // The first authenticated session replaces a hidden bootstrap model, not another viewer. Preserve a direct
      // launch URL for that initial Owner/Kid/Visitor; only later changes retire an already-visible route scope.
      const next = profileSessionKey(active.identity, active.policyKey);
      // The new session's Router is built from the address as it is when `session` changes, so a later switch
      // retires the address here, first, not in the pre-effect below (which runs after that Router is built).
      if (profileControlPublished && next !== routedProfile) resetProfileNavigation();
      routedProfile = next;
      session = active;
    }
    if (!profileControlPublished) {
      profileControlPublished = true;
      onprofilecontrol(coordinator);
    }
  });

  // Every profile household has a Kid out of the box (den#295): one born here, and one split before Kids were automatic.
  // The Owner's visit makes it, once; the switcher shows it as soon as the directory has it. The service may be between
  // connections then (the household reconnecting at wire 5, or a session replaced as the page navigates): the request
  // waits that out and is asked again of the household open by then.
  let defaultKidAsked = false;
  $effect(() => {
    const coordinator = profileCoordinator;
    if (!coordinator || coordinator.preview || defaultKidAsked || coordinator.mode !== 'owner')
      return;
    if (stagingProfiles || coordinator.choices.some((choice) => choice.role === 'kid')) return;
    if (!untrack(() => session.household.ownerSettingsModel())) return;
    defaultKidAsked = true;
    void untilServiceSettles(
      async () => {
        const household = untrack(() => session.household.ownerSettingsModel());
        if (!household)
          throw new LibraryServiceError({
            code: 'not-ready',
            message: 'the household is not open',
            retryable: true,
          });
        await household.ready;
        return household.ensureDefaultKidProfile();
      },
      { live: () => alive },
    ).catch((error: unknown) =>
      console.error('den: the household’s Kid profile could not be made', error),
    );
  });

  // Kid chosen before the household existed: once it does and its Kid is there, the PIN chosen then becomes the
  // household's Owner PIN and the Kid opens.
  let kidAfterHousehold: string | null = null;
  $effect(() => {
    const coordinator = profileCoordinator;
    if (!coordinator || stagingProfiles || coordinator.mode !== 'owner') return;
    const kid = coordinator.choices.find((choice) => choice.role === 'kid' && choice.id);
    const pin = kidAfterHousehold;
    if (!kid?.id || pin === null) return;
    kidAfterHousehold = null;
    void coordinator
      .setOwnerPin(pin)
      .then((saved) => {
        if (!saved) throw new Error('the Owner PIN was not saved');
        return coordinator.switchToPersistent(kid.id!);
      })
      .catch((error: unknown) =>
        console.warn('den: the Kid chosen before the household could not be opened', error),
      );
  });

  /** How often an open tab asks to renew assistant grants; the library service renews at most once a day. */
  const RENEW_EVERY_MS = 6 * 60 * 60 * 1000;

  /** "Assistant added “Fauda” to your watchlist": quiet, and never an alert. */
  async function announceAssistant(
    owner: ProfileSession,
    result: Extract<ApplyResult, { outcome: 'accepted' }>,
  ) {
    let name = owner.displayTitle(result.title)?.title;
    if (!name)
      name = await owner
        .libraryMetadata([result.title])
        .then(({ titles }) => titles[0]?.title)
        .catch(() => undefined);
    if (owner !== session) return;
    owner.notify(`Assistant ${result.detail.replace('%s', name ? `“${name}”` : 'a title')}`);
  }
  let pendingReset = $state.raw<PendingReset | null>(untrack(() => readPendingReset()));
  let resetInFlight = $state(false);
  let convergence = 0;
  let convergenceWork = Promise.resolve();
  let convergenceRetry: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  onDestroy(() => {
    alive = false;
    clearTimeout(convergenceRetry);
  });

  /**
   * Bring what this browser keeps into the household `key` opens, before the browser switches to it: the library kept
   * only here, or this browser's own household (`joinOwnHousehold`). `link` is the TV paired with, opened from then on.
   */
  async function joinLibrary(
    key: string,
    options: { pin?: string; link?: JoinLink } = {},
  ): Promise<JoinAnswer> {
    if (!session.local && ownHousehold) return joinOwnHousehold(ownHousehold, key, options);
    return (await joinLocalLibrary(key)) ? 'joined' : 'failed';
  }
  const joinsAsBoolean = async (key: string) => (await joinLibrary(key)) === 'joined';

  /**
   * This browser's own household joins the household `destination` (den#295): the household joined wins, and what was
   * kept here (Owner and Kid activity) moves into its profiles before this browser's household is retired. The plan
   * is kept first, so a reload finishes a join cut off anywhere (`resumeHouseholdJoin`).
   */
  async function joinOwnHousehold(
    source: string,
    destination: string,
    options: { pin?: string; link?: JoinLink },
  ): Promise<JoinAnswer> {
    if (source === destination) return 'failed';
    const kept = householdJoinPlan();
    const link = options.link ?? (kept?.destination === destination ? kept.link : undefined);
    const plan: HouseholdJoinPlan = { version: 1, source, destination, ...(link ? { link } : {}) };
    if (!keepHouseholdJoin(plan)) return 'failed';
    let opened = open(destination, false);
    try {
      await opened.model!.ready;
      const ask = () => opened.model!.joinHousehold(source, options.pin);
      const answer = await ask().catch(async (error: unknown) => {
        // Opened again from this browser's copy, a profile household is known to need wire 5 before den-edge is
        // asked, and the copy opened at 4 is read-only: it is opened at 5 instead.
        if (!(error instanceof LibraryServiceError) || error.failure.code !== 'read-only')
          throw error;
        opened.close();
        opened = open(destination, false, 5);
        await opened.model!.ready;
        return ask();
      });
      // Refused before anything moved: this browser keeps its household.
      if (answer.outcome === 'refused-kids') settleHouseholdJoin(plan, false);
      if (answer.outcome !== 'joined')
        return answer.outcome === 'unavailable' ? 'failed' : answer.outcome;
      carryActiveProfile(localStorage, answer.owner ?? null, answer.kids ?? {});
      // The link first: should the page stop here, the next load opens the household joined and settles the plan.
      if (plan.link) {
        links.add(plan.link.inboxKey, {
          name: plan.link.name,
          libraryKey: destination,
          linkKey: plan.link.linkKey,
          ...(plan.link.deviceId ? { deviceId: plan.link.deviceId } : {}),
        });
        links.makeCurrent(plan.link.inboxKey);
      } else links.addRecovered(destination);
      settleHouseholdJoin(plan, true);
      await retireMovedLibrary(source);
      return 'joined';
    } catch (error) {
      console.warn('den: this browser’s household could not join that household yet', error);
      return 'failed';
    } finally {
      opened.close();
    }
  }

  /**
   * The library kept here that moved into `household`, still waiting for its re-check, once `household` has joined
   * another and is retired: there is nothing left to re-check it against, and what it held went with the join.
   */
  async function retireMovedLibrary(household: string): Promise<void> {
    const moved = householdPlan();
    if (!moved?.verified || moved.householdKey !== household) return;
    await dropLocalLibrary(moved.stagingKey);
    settleHouseholdPlan();
  }

  // A join of this browser's household that a reload cut off is finished now; one still waiting for the Owner PIN
  // when it stopped had moved nothing, and is given up. A join that opened its household already only settles.
  onMount(() => {
    const plan = householdJoinPlan();
    if (!plan) return;
    if (link) {
      if (link.libraryKey === plan.destination) {
        settleHouseholdJoin(plan, true);
        void retireMovedLibrary(plan.source);
      }
      return;
    }
    void joinOwnHousehold(plan.source, plan.destination, {}).then((answer) => {
      if (answer === 'pin-required' || answer === 'pin-wrong') settleHouseholdJoin(plan, false);
    });
  });

  /** Merge a browser-local library into the newly paired one before either ownership pointer moves. */
  async function joinLocalLibrary(key: string): Promise<boolean> {
    let sourceKey = libraryIdentity;
    const source = session.model;
    if (!session.local || !source || !sourceKey) return false;
    const destination = open(key, false);
    try {
      await destination.model!.ready;
      // A title edit made from finished views answers while its narrow document send is still settling. A query that
      // needs the full authority waits for that send and folds it into the source log before anything can copy it.
      await source.rawPreferences();
      // A first-tab winner can change again while a TV join is copying it. Follow that pointer until the exact source
      // just copied can be removed; every earlier source is already safe in the destination.
      for (let round = 0; round < 8; round++) {
        let settled = false;
        // Keep the source until no action that started before or during a pass remains. A Watchlist click is drawn
        // optimistically before its local command has finished; forgetting the source on the first pass could
        // otherwise publish an empty linked library while that command was still being kept.
        for (let pass = 0; pass < 3 && !settled; pass++) {
          await waitForKeptActions();
          const seen = keptActions;
          const { result } = await destination.model!.mergeLocalLibrary(sourceKey, undefined, {
            keep: true,
            verify: true,
          });
          if (
            result.kind !== 'local-library.merge' ||
            (result.outcome !== 'merged' && result.outcome !== 'absent') ||
            !alive
          ) {
            destination.close();
            return false;
          }
          settled = keptActions === seen && keptPending === 0;
        }
        if (!settled) {
          destination.close();
          return false;
        }
        settleLocalLibraryMerge(sourceKey);
        if (await dropLocalLibrary(sourceKey)) {
          // Cancel a queued convergence open before publishing the linked destination.
          convergence++;
          clearTimeout(convergenceRetry);
          libraryIdentity = key;
          session = destination;
          return true;
        }
        const winner = keptLocalLibraryKey();
        if (!winner || winner === sourceKey) break;
        sourceKey = winner;
      }
      destination.close();
      return false;
    } catch {
      destination.close();
      return false;
    }
  }

  // den#295: the first thing kept here makes this browser's household on den-edge, and what was kept moves into it.
  // A library kept here before the household was planned moves as the page opens (`ifKept`: only when it holds
  // something kept, so a browser that only looked around still writes nothing). Asked again on a later kept action, or
  // by itself after `Retry-After`; a host that starts no library for this browser (`refused`) is not asked again this
  // visit. Until the move is done the page goes on with the library kept here.
  const HOUSEHOLD_RETRY_MS = 30_000;
  const HOUSEHOLD_TRIES = 5;
  let householdTries = 0;
  let householdStarting = false;
  let householdRefused = false;
  async function startHousehold(ifKept = false, reserved = false): Promise<boolean> {
    const plan = plannedHousehold;
    // The library kept here, even while the switcher has a Visitor open over it.
    const staging = stagingOwner ?? session;
    const stagingKey = libraryIdentity;
    if (!plan || householdStarting || householdRefused || !alive) return false;
    if (!staging.local || !staging.model || !stagingKey) return false;
    householdStarting = true;
    let retryMs: number | null = null;
    try {
      // Only where den-edge says it starts a household for a browser like this one; otherwise nothing is sent.
      // A guest grant reserves exactly this planned household before it gets here. That reservation is the server's
      // permission for the first write even where arbitrary browser households are closed (`NEW_LIBRARIES=members`).
      if (!reserved && !(await bornHouseholds())) return false;
      // `ifKept` marks the plan started only once something was found to move: a reload of an empty library stays idle.
      const started =
        ifKept && !plan.started && plan.stagingKey === stagingKey
          ? plan
          : startHouseholdPlan(plan, stagingKey);
      if (!started) return false;
      plannedHousehold = started;
      // A reload resumes this as the page opens, before the library kept here is ready to be asked.
      await staging.model.ready;
      const { outcome, retryAfterMs } = await staging.model.createHousehold({
        householdKey: started.householdKey,
        attempt: started.attempt,
        ownerProfile: started.ownerProfile,
        ownerKey: started.ownerKey,
        createdAt: started.createdAt,
        ...(started.started ? {} : { ifKept: true as const }),
      });
      if (outcome === 'created') {
        if (!started.started) plannedHousehold = startHouseholdPlan(started, stagingKey) ?? started;
        const adopted = await adoptHousehold(started);
        if (adopted === 'adopted') return true;
        retryMs = adopted;
      } else if (outcome === 'refused') householdRefused = true;
      else if (outcome !== 'empty') retryMs = retryAfterMs ?? HOUSEHOLD_RETRY_MS;
    } catch (error) {
      console.warn('den: this browser’s household could not be made yet', error);
      retryMs = HOUSEHOLD_RETRY_MS;
    } finally {
      householdStarting = false;
    }
    if (retryMs !== null && alive && ++householdTries < HOUSEHOLD_TRIES)
      setTimeout(() => void startHousehold(), retryMs);
    return false;
  }

  /**
   * Open the household just made and move the library kept here into it, its household half into the household and the
   * rest into the Owner library, before switching to it (as `joinLibrary` does for a TV). Each half is read back from
   * den-edge and checked against the library kept here (`verify`), and the copy is made again if something was kept
   * meanwhile; only then is the library kept here retired. The Owner opens from there through the directory, as in any
   * profile household. `adopted`, or how long to wait before trying again.
   */
  async function adoptHousehold(plan: HouseholdPlan): Promise<'adopted' | number> {
    if (!commitHousehold(plan)) return HOUSEHOLD_RETRY_MS;
    // At wire 5 from the start: a second try in this page would otherwise open it from this browser's copy at 4,
    // read-only until den-edge's 426 has been answered, and refuse the move meanwhile.
    const destination = open(plan.householdKey, false, 5);
    const owner = openProfileActivity(plan.ownerKey);
    let waitMs = HOUSEHOLD_RETRY_MS;
    const moved = (result: { kind: string; outcome?: string; retryAfterMs?: number }) => {
      if (
        result.kind === 'local-library.merge' &&
        (result.outcome === 'merged' || result.outcome === 'absent')
      )
        return true;
      if (result.retryAfterMs) waitMs = result.retryAfterMs;
      return false;
    };
    try {
      await Promise.all([destination.model!.ready, owner.model.ready]);
      let settled = false;
      // How many live rows each library held when it was read back: the next load checks against them.
      let held: { household?: number; owner?: number } = {};
      for (let pass = 0; pass < 3 && !settled; pass++) {
        const seen = keptActions;
        const household = await destination.model!.mergeLocalLibrary(plan.stagingKey, undefined, {
          scope: 'household',
          keep: true,
          verify: true,
        });
        if (!moved(household.result)) throw new Error('the household did not take its settings');
        const profile = await owner.model.mergeLocalLibrary(plan.stagingKey, undefined, {
          scope: 'profile',
          keep: true,
          verify: true,
        });
        if (!moved(profile.result)) throw new Error('the Owner library did not take its activity');
        held = {
          ...('held' in household.result ? { household: household.result.held } : {}),
          ...('held' in profile.result ? { owner: profile.result.held } : {}),
        };
        settled = keptActions === seen && keptPending === 0;
      }
      if (!settled) throw new Error('the library kept here kept changing while it moved');
      owner.close();
      if (!alive || libraryIdentity !== plan.stagingKey) {
        destination.close();
        return HOUSEHOLD_RETRY_MS;
      }
      if (held.household !== undefined && held.owner !== undefined) {
        // Verified: the library kept here stays until the next load's `recheckHousehold` passes.
        if (!verifyHouseholdPlan(plan, { household: held.household, owner: held.owner }))
          throw new Error('the verified move could not be recorded');
      } else {
        // Another tab finished the move and the library kept here is gone already.
        await dropLocalLibrary(plan.stagingKey);
        settleHouseholdPlan();
      }
      plannedHousehold = null;
      // Cancel a queued convergence open before publishing the household.
      convergence++;
      clearTimeout(convergenceRetry);
      ownHousehold = plan.householdKey;
      // The switcher offered before the household gives way to the household's own.
      const staged = stagingProfiles ? profileCoordinator : null;
      if (staged) {
        stagingProfiles = false;
        stagingOwner = null;
        profileCoordinator = null;
        profileControlPublished = false;
        onprofilecontrol(null);
      }
      // The same route goes on under the household: this is not a profile switch.
      routedProfile = profileSessionKey(destination.identity, destination.policyKey);
      libraryIdentity = plan.householdKey;
      session = destination;
      staged?.dispose();
      return 'adopted';
    } catch (error) {
      console.warn('den: this browser’s library could not move into its household yet', error);
      owner.close();
      destination.close();
      return waitMs;
    }
  }
  // Where den-edge starts households for browsers like this one, the switcher offers Owner, Kid and Visitor from the
  // first visit; choosing Kid makes the household. A household asked for before a reload is finished now, and a library
  // kept here from an earlier visit moves into one.
  let stagingProfiles = $state(false);
  let stagingOwner: ProfileSession | null = null;
  onMount(() => {
    // A move verified on an earlier load: the library kept here is dropped once den-edge still holds what it held then.
    const verified = ownHousehold ? householdPlan() : null;
    if (verified?.verified && verified.householdKey === ownHousehold)
      void recheckHousehold(verified).then(async (failed) => {
        if (failed) {
          console.warn(`den: the library kept in this browser stays for now: ${failed}`);
          return;
        }
        await dropLocalLibrary(verified.stagingKey);
        settleHouseholdPlan();
      });
    if (!plannedHousehold || !session.local) return;
    void bornHouseholds().then((offered) => {
      const staging = session;
      if (!offered || !alive || !plannedHousehold || !staging.local || !staging.model) return;
      if (!profileCoordinator) {
        stagingOwner = staging;
        stagingProfiles = true;
        profileCoordinator = new ProfileModeCoordinator(
          staging,
          localStorage,
          window,
          undefined,
          null,
          null,
          async (pin) => {
            kidAfterHousehold = pin;
            await startHousehold();
            return ownHousehold !== null;
          },
        );
      }
      if (plannedHousehold.started) void startHousehold();
      else if (keptLocal) void startHousehold(true);
    });
  });

  function publishReset(pending: PendingReset | null): boolean {
    if (!writePendingReset(pending)) return false;
    pendingReset = pending;
    return true;
  }

  let resetCompletion: Promise<KeyResetOutcome | null> | undefined;
  function finishReset(
    pending: PendingReset,
    outcome: KeyResetOutcome,
  ): Promise<KeyResetOutcome | null> {
    if (resetCompletion) return resetCompletion;
    const completing = finishResetOnce(pending, outcome).finally(() => {
      if (resetCompletion === completing) resetCompletion = undefined;
    });
    resetCompletion = completing;
    return completing;
  }

  async function finishResetOnce(
    pending: PendingReset,
    outcome: KeyResetOutcome,
  ): Promise<KeyResetOutcome | null> {
    if (outcome === 'moved' || outcome === 'adopted') {
      const destination = open(pending.to, false);
      try {
        await destination.model!.ready;
      } catch {
        destination.close();
        // The reset did move remotely, but the durable marker must survive until this browser proves it can reopen
        // the destination. Retrying settlement is safe and avoids stranding the link on a key it cannot open.
        return 'unknown';
      }
      if (
        !alive ||
        pendingReset?.from !== pending.from ||
        pendingReset.to !== pending.to ||
        libraryIdentity !== pending.from
      ) {
        destination.close();
        return 'unknown';
      }
      links.rekey(pending.from, pending.to);
      pendingReset = null;
      libraryIdentity = pending.to;
      session = destination;
      return null;
    }
    if (outcome === 'held' || outcome === 'unknown') {
      publishReset(outcome === 'held' ? { ...pending, held: true } : pending);
      return outcome;
    }
    publishReset(null);
    if (outcome === 'foreign' && link) links.forgetMoved(link);
    return outcome;
  }

  async function resetLibraryKey(): Promise<KeyResetOutcome | null> {
    if (resetInFlight) return 'unavailable';
    const model = session.model;
    const from = libraryIdentity;
    if (!model || !from || session.local) return 'unavailable';
    resetInFlight = true;
    try {
      const existing = pendingReset;
      if (existing) {
        if (existing.from !== from) return 'unavailable';
        const { result } = await model.settleLibraryKey(existing.to);
        return result.kind === 'key-reset.settle'
          ? finishReset(existing, result.outcome)
          : 'unavailable';
      }
      const prepared = await model.prepareKeyReset();
      if (prepared.result.kind !== 'key-reset.prepare') return 'unavailable';
      const pending: PendingReset = {
        from,
        to: prepared.result.destinationLibraryKey,
        device: prepared.result.device,
      };
      if (!publishReset(pending)) return 'unavailable';
      const { result } = await model.moveLibraryKey(pending.to);
      return result.kind === 'key-reset.move'
        ? finishReset(pending, result.outcome)
        : 'unavailable';
    } catch {
      return 'unknown';
    } finally {
      resetInFlight = false;
    }
  }

  // The page's half of a compound key reset of a profile household. Nothing starts one yet (`start` has no caller);
  // this only carries a reset whose marker is already kept through its install, so a reload or a crash converges.
  const compoundReset = new CompoundResetPage<{ session: ProfileSession }>({
    pending: { read: () => pendingReset, write: publishReset },
    worker: async (from) => {
      if (from === libraryIdentity && session.model)
        return { model: session.model, close: () => {} };
      const old = open(from, false);
      if (!old.model) {
        old.close();
        throw new Error('The library service of the old household is not available');
      }
      await old.model.ready;
      return { model: old.model, close: () => old.close() };
    },
    openDestination: async (key) => {
      if (key === libraryIdentity) return { session, close: () => {} };
      const destination = open(key, false);
      try {
        await destination.model!.ready;
      } catch (error) {
        destination.close();
        throw error;
      }
      return { session: destination, close: () => destination.close() };
    },
    link: () => links.list.find((l) => l.libraryKey === pendingReset?.to) ?? null,
    install: (from, to) => links.rekey(from, to, true),
    release: (from) => {
      links.releaseRekeyed(from);
      pendingReset = null;
    },
    adopt: (destination, to) => {
      if (libraryIdentity === to || !alive) return;
      libraryIdentity = to;
      session = destination.session;
    },
  });
  let compoundRetry: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(compoundRetry));

  async function adoptHeldReset(): Promise<void> {
    const pending = pendingReset;
    const model = session.model;
    if (!pending?.held || !model || pending.from !== libraryIdentity) return;
    const { result } = await model.adoptLibraryKey(pending.to);
    if (result.kind === 'key-reset.adopt') await finishReset(pending, result.outcome);
  }

  // Runtime discovery is a root replacement. It can update independently without restarting the route tree.
  $effect(() => session.configureServices());

  // Visibility/connectivity/playback are facts observed by the authority scheduler, not page-owned poll loops.
  $effect(() => {
    const current = session;
    const model = current.model;
    if (!model) return;
    let stopped = false;
    const observe = () => {
      if (stopped) return;
      void model
        .observeLifecycle({
          visible: !document.hidden,
          online: navigator.onLine,
          playbackActive: current.live,
        })
        .catch(() => {});
    };
    void model.ready.then(observe, () => {});
    window.addEventListener('online', observe);
    window.addEventListener('offline', observe);
    document.addEventListener('visibilitychange', observe);
    return () => {
      stopped = true;
      window.removeEventListener('online', observe);
      window.removeEventListener('offline', observe);
      document.removeEventListener('visibilitychange', observe);
    };
  });

  // Resume an interrupted reset through the same authority before a moved response is allowed to forget its link.
  $effect(() => {
    const pending = pendingReset;
    const model = session.model;
    if (
      !pending ||
      pending.compound ||
      !model ||
      pending.from !== libraryIdentity ||
      pending.held ||
      resetInFlight
    )
      return;
    let current = true;
    void model.ready
      .then(() => model.settleLibraryKey(pending.to))
      .then(({ result }) => {
        if (current && result.kind === 'key-reset.settle')
          return finishReset(pending, result.outcome);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });
  // A compound reset is settled by the library service that holds its journal, not by the legacy standing check.
  $effect(() => {
    const pending = pendingReset;
    if (!pending?.compound || resetInFlight) return;
    const run = () =>
      void compoundReset
        .run(pending)
        .then((result) => {
          if (alive && (result === 'waiting' || result === 'blocked'))
            compoundRetry = setTimeout(() => (pendingReset = readPendingReset()), 15_000);
        })
        .catch((error: unknown) =>
          console.warn('den: the profile key reset could not continue', error),
        );
    run();
    return () => clearTimeout(compoundRetry);
  });
  $effect(() => {
    const current = session;
    void current.live;
    const model = current.model;
    if (!model) return;
    void model.ready
      .then(() =>
        model.observeLifecycle({
          visible: !document.hidden,
          online: navigator.onLine,
          playbackActive: current.live,
        }),
      )
      .catch(() => {});
  });

  // On a household split into profiles an assistant connection is the household's (profiles-v1 §6.1): its rows are
  // written to the household's library and approved as its member, so den-mcp queues to and reads from the household.
  // Owner's library, which assistant activity targets (§4), publishes its lists and applies the requests with the
  // connection the household lends it (assistant-v1 §15). Null for a household that was never split.
  const assistantHousehold = $derived.by(() => {
    const model = implicitAssistantModel;
    const control = model ? session.household.ownerSettingsModel() : null;
    return control && control !== model ? control : null;
  });

  // Assistants (den-spec wire/assistant-v1.md): while a member's library is open here, the consent dialog may write
  // grants into it. A library kept only in this browser is no member's on den-edge, and has none.
  $effect(() => {
    const model = implicitAssistantModel;
    if (!model) return;
    const household = assistantHousehold;
    const consent = household ?? model;
    let open = true;
    void Promise.all([model.ready, consent.ready])
      .then(() => household?.relayMembership() ?? null)
      .then(
        (membership) => {
          if (!open) return;
          // A household den-edge does not know as a member yet could not be approved for: no consent is offered.
          if (household && !membership) return;
          assistantLibrary.model = consent;
          assistantLibrary.fetch = membership ? householdAssistantFetch(membership) : null;
        },
        () => {},
      );
    return () => {
      open = false;
      if (assistantLibrary.model === consent) {
        assistantLibrary.model = null;
        assistantLibrary.fetch = null;
      }
    };
  });

  // The work for connected assistants runs only while the library has one, as its settings say (most libraries never
  // do, and pay nothing for it): with a live grant to write, requests an assistant queued are drained, applied through
  // the tap path and told in a quiet toast; with a live read record, the projection is published (§15); with either,
  // grants den-edge still lists are renewed. Each starts and stops as consent or revocation, here or on another
  // device, changes the rows. The code itself is fetched only then. On a split household the rows that say so are
  // the household's, and so are the queue, the projection's library and the grants renewed.
  // None of it starts before the page has drawn what it opened for (`foregroundReady`): each runs in the library
  // Worker that answers the page's rows, and a projection build reads the whole library and holds that Worker for
  // seconds on a phone.
  const memberModel = $derived(implicitAssistantModel);
  const connectionModel = $derived(assistantHousehold ?? memberModel);
  const drainNeeded = $derived(
    session.foregrounded && (connectionModel?.settings.value?.assistant.write ?? false),
  );
  const publishNeeded = $derived(
    session.foregrounded && (connectionModel?.settings.value?.assistant.read ?? false),
  );
  const renewNeeded = $derived(drainNeeded || publishNeeded);

  interface AssistantWork {
    /** The library assistant activity targets: the household's own, or Owner's on a split household. */
    model: LibraryModel;
    /** The split household whose connection it is, or null. */
    household: LibraryModel | null;
    /** The library the connection is for, which names its Web Locks. */
    libraryId: string;
    /** Proves the household's membership on the assistant routes; undefined for the page's own credential. */
    fetchImpl?: typeof fetch;
    /** What `model` publishes and applies with: the household's connection, read again each time it is asked. */
    lend(): Promise<AssistantConnection | undefined>;
  }

  function whileNeeded(
    needed: boolean,
    run: (
      assistant: typeof import('./lib/assistant'),
      work: AssistantWork,
      signal: AbortSignal,
    ) => void,
  ) {
    const current = session;
    const model = memberModel;
    const household = assistantHousehold;
    if (!needed || !model) return;
    const stop = new AbortController();
    void Promise.all([import('./lib/assistant'), household?.relayMembership() ?? null]).then(
      ([assistant, membership]) => {
        if (stop.signal.aborted || current !== session) return;
        if (household && !membership) {
          console.warn('den: the household is not a member on den-edge yet; its assistants wait');
          return;
        }
        run(
          assistant,
          {
            model,
            household,
            libraryId: membership?.libraryId ?? libraryCredentialId() ?? 'library',
            ...(membership ? { fetchImpl: householdAssistantFetch(membership) } : {}),
            lend: async () => {
              if (!household) return undefined;
              const connection = await household.assistantConnection();
              if (!connection) throw new Error('the household is not a member on den-edge');
              return connection;
            },
          },
          stop.signal,
        );
      },
      (error: unknown) => console.warn('den: the assistant connection could not be loaded', error),
    );
    return () => stop.abort();
  }

  $effect(() =>
    whileNeeded(renewNeeded, ({ renewListed }, work, signal) => {
      const renew = () =>
        void renewListed(
          (grants) => (work.household ?? work.model).renewAssistant(grants),
          work.fetchImpl,
        ).catch((error: unknown) =>
          console.warn('den: assistant grants could not be renewed', error),
        );
      renew();
      const renewal = setInterval(renew, RENEW_EVERY_MS);
      signal.addEventListener('abort', () => clearInterval(renewal), { once: true });
    }),
  );

  $effect(() => {
    const current = session;
    return whileNeeded(drainNeeded, ({ drainWhileOpen }, work, signal) => {
      void drainWhileOpen(
        {
          libraryId: work.libraryId,
          apply: async (messages) => work.model.applyAssistant(messages, await work.lend()),
          applied: (result) => void announceAssistant(current, result),
          ...(work.fetchImpl ? { fetchImpl: work.fetchImpl } : {}),
        },
        signal,
      );
    });
  });

  $effect(() =>
    whileNeeded(publishNeeded, ({ publishWhileOpen }, work, signal) => {
      void publishWhileOpen(
        {
          libraryId: work.libraryId,
          publish: async () => work.model.publishAssistant(await work.lend()),
        },
        signal,
      );
    }),
  );

  // A direct detail route may never paint Home's hero. Optional provider work still starts after a hard ceiling.
  $effect(() => {
    const current = session;
    const timer = setTimeout(() => current.foregroundReady(), 10_000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const current = session;
    return () => current.close();
  });
  $effect(() => {
    const status = session.model?.status;
    if (status?.kind === 'moved' && link) links.forgetMoved(link);
  });

  // Concurrent first tabs can create different local keys. Open the winner, merge the losing library through the
  // winner's authority, then publish the new session in one assignment. Losing keys are recorded before any await:
  // after a crash or transient merge refusal, the next winner session retries them instead of silently orphaning rows.
  $effect(() => {
    if (!ownKey || link) return;
    let current = true;
    const retry = () => {
      clearTimeout(convergenceRetry);
      convergenceRetry = setTimeout(() => {
        // Once the household is open, the library kept here (kept until it is re-checked) is never opened again.
        if (!current || !alive || ownHousehold) return;
        const winner = localLibraryKey();
        if (!winner) return;
        if (session.local && libraryIdentity === winner) void drain(session, winner);
        else converge(winner);
      }, 2_000);
    };
    const drain = async (owner: ProfileSession, winner: string) => {
      const model = owner.model;
      if (!model) return;
      let complete = true;
      for (const sourceKey of pendingLocalLibraryMerges(winner)) {
        try {
          const { result } = await model.mergeLocalLibrary(sourceKey);
          if (
            result.kind === 'local-library.merge' &&
            (result.outcome === 'merged' || result.outcome === 'absent')
          )
            settleLocalLibraryMerge(sourceKey);
          else complete = false;
        } catch {
          complete = false;
        }
      }
      if (!complete && current && alive && session === owner) retry();
    };
    const converge = (nextKey: string) => {
      if (ownHousehold) return;
      const run = ++convergence;
      convergenceWork = convergenceWork.then(async () => {
        const next = open(nextKey, true);
        try {
          await next.model!.ready;
          if (!current || !alive || run !== convergence) return next.close();
          libraryIdentity = nextKey;
          session = next;
          await drain(next, nextKey);
        } catch {
          next.close();
          if (current && alive && run === convergence) retry();
        }
      });
    };
    const stop = followLocalLibraryKey(ownKey, (nextKey, previousKey) => {
      rememberLocalLibraryMerge(previousKey);
      converge(nextKey);
    });
    const initial = untrack(() => session);
    const initialKey = untrack(() => libraryIdentity);
    if (initialKey) void initial.model?.ready.then(() => drain(initial, initialKey), retry);
    return () => {
      current = false;
      stop();
      clearTimeout(convergenceRetry);
    };
  });

  // A "Use Den on your phone" link this page opened: the guest's library comes in (a browser that holds a synced
  // library keeps it), then a slot in their grant. The answer is the dialog's (`PhoneDialog`).
  $effect(() => {
    if (!phoneLanding.request || phoneLanding.phase !== 'idle') return;
    if (!link && !session.local) return;
    if (!householdAdmin) return;
    void untrack(() => phoneLanding.run(link ? null : joinsAsBoolean));
  });

  // Anyone invited gets a synced library: a browser with a live grant and no synced library starts the one the grant
  // allows, with what it saved here moved in, as when a TV is linked. A device that already holds one keeps it.
  // A start that could not finish (offline) is tried again, with the same key.
  const GUEST_RETRY_MS = 30_000;
  const GUEST_RETRIES = 5;
  let guestTries = $state(0);
  let guestStarting = false;
  $effect(() => {
    void guestTries;
    const grant = startingGrant();
    if (!grant || !session.local || phoneLanding.request || guestStarting) return;
    guestStarting = true;
    // On a real-profile host the grant's one reservation is the planned household itself. Starting the older
    // single-library shape here would leave a brand-new guest permanently on the legacy Owner path, with no profile
    // directory to discover. Hosts with profiles off retain that exact legacy flow.
    void realProfilesHost()
      .then((profiles) => {
        const plan = profiles ? plannedHousehold : null;
        return startGuestLibrary(
          grant,
          plan
            ? async (key) => key === plan.householdKey && startHousehold(false, true)
            : joinsAsBoolean,
          fetch,
          plan?.householdKey,
        );
      })
      .then((outcome) => {
        if (outcome === 'failed' && alive && guestTries < GUEST_RETRIES)
          setTimeout(() => alive && guestTries++, GUEST_RETRY_MS);
      })
      .catch((error: unknown) => console.warn('den: a guest library could not be started', error))
      .finally(() => (guestStarting = false));
  });
</script>

{#if session.updateRequired}
  <section class="library-update-required" aria-labelledby="library-update-required-title">
    <h1 id="library-update-required-title">Library update required</h1>
    <p>
      This library was opened by a newer version of Den. Update Den on this device, then reload to
      continue.
    </p>
    <button type="button" onclick={() => location.reload()}>Reload Den</button>
  </section>
{:else if !optimistic && profileCapability === 'checking'}
  <p class="profile-loading" role="status">Opening profiles…</p>
{:else if profileCapability === 'indeterminate'}
  <section class="profile-unavailable" aria-labelledby="profile-unavailable-title">
    <h1 id="profile-unavailable-title">Profiles couldn’t be opened</h1>
    <p>The Owner library remains hidden. Reload Den to try again.</p>
  </section>
{:else if !optimistic && activeCapability === 'enabled' && !profileCoordinator}
  <p class="profile-loading" role="status">Opening profile directory…</p>
{:else if !optimistic && profileCoordinator && !profileCoordinator.session && profileCoordinator.restoring}
  <p class="profile-loading" role="status">Opening profiles…</p>
{:else if profileCoordinator && !profileCoordinator.session && !profileCoordinator.restoring && !stagingProfiles}
  <ProfileOwnerGate profiles={profileCoordinator} />
{:else}
  <!-- Optimistic first frames are inert: nothing can be written to the bootstrap library before the Owner opens. -->
  <div class="library-frame" inert={optimistic}>
    {#if profileCapability === 'preview'}
      <p class="profile-preview" role="status">
        Profile preview · filtering and household migration remain off
      </p>
    {/if}
    <!-- Keyed by the session object: Library holds its session's model, services and trackers for its whole life, so
         a new session always mounts a new tree, even one with the same identity (a reopened Owner, whose old model is
         closed). The adopted first-frame session is the coordinator's own object, so that handover keeps the tree. -->
    {#key shown}
      <LibraryStatus
        toast={shown.toast}
        alert={shown.alert}
        undo={shown.undo}
        recovery={shown.local && shown.alert === PRE_V4_BACKUP_ERROR
          ? {
              label: 'Start with an empty library…',
              question: 'Discard this old backup?',
              detail:
                'This removes the old library kept only in this browser. Use it only when there is no watchlist, watched history, progress, or settings you want to keep.',
              confirmLabel: 'Start empty',
              run: () => void discardLocalLegacyBackup(),
            }
          : null}
      />
      <Router
        profile={profileSessionKey(shown.identity)}
        onchange={(route) => {
          if (route.page === 'settings')
            void (session.identity.kind === 'visitor'
              ? Promise.resolve()
              : link || session.local || ownHousehold
                ? SettingsScreen.load()
                : LinkScreen.load());
          onchange(route);
        }}
      >
        {#snippet children(route, active)}
          {#if route.page === 'settings'}
            {#if profileCoordinator}<MobileProfileRow profiles={profileCoordinator} />{/if}
            {#if settingsRoute === 'personal'}
              <ProfileSettings {session} profiles={profileCoordinator} />
            {:else if settingsRoute === 'unavailable'}
              <section
                class="profile-settings-unavailable"
                aria-labelledby="profile-settings-title"
              >
                <h1 id="profile-settings-title">
                  {session.identity.kind === 'visitor'
                    ? 'Profile settings unavailable'
                    : 'Household settings unavailable'}
                </h1>
                <p>
                  {session.identity.kind === 'visitor'
                    ? 'Visitor settings couldn’t be opened. Switch profiles and try again.'
                    : 'Owner profile settings will appear here after the household split is activated.'}
                </p>
              </section>
            {:else if (link || session.local || ownHousehold) && householdSettingsModel}
              {#if SettingsScreen.current}
                <SettingsScreen.current
                  {link}
                  model={householdSettingsModel}
                  preferences={session.preferences}
                  content={session.content}
                  local={session.local}
                  onjoin={!link && (session.local || ownHousehold) ? joinLibrary : undefined}
                  onresetkey={resetLibraryKey}
                  heldReset={pendingReset?.held === true}
                  onadoptheld={adoptHeldReset}
                />
              {:else}
                <ScreenLoading screen={SettingsScreen} />
              {/if}
            {:else if LinkScreen.current}
              <LinkScreen.current />
            {:else}
              <ScreenLoading screen={LinkScreen} />
            {/if}
          {:else}
            <Library
              link={shown.identity.kind === 'visitor' ? null : link}
              session={shown}
              {route}
              {active}
              {query}
              {explore}
              {people}
              {watchedYear}
              {titleSeason}
              profiles={profileCoordinator}
            />
          {/if}
        {/snippet}
      </Router>
    {/key}
  </div>
{/if}

<style>
  .library-frame {
    display: contents;
  }

  .profile-settings-unavailable {
    max-width: 680px;
    margin: 24px auto;
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--card);
  }

  .profile-settings-unavailable h1 {
    margin-top: 0;
  }

  .profile-settings-unavailable p {
    margin-bottom: 0;
    color: var(--muted);
  }

  .profile-loading,
  .profile-unavailable,
  .library-update-required {
    margin: 48px auto;
  }

  .profile-preview {
    width: fit-content;
    margin: 0 auto 16px;
    padding: 6px 11px;
    border: 1px solid var(--accent-line-45);
    border-radius: 999px;
    background: var(--accent-surface);
    color: var(--muted);
    font-size: 12px;
  }

  .profile-loading {
    text-align: center;
    color: var(--muted);
  }

  .profile-unavailable,
  .library-update-required {
    display: grid;
    gap: 12px;
    max-width: 520px;
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--card);
  }

  .profile-unavailable h1,
  .profile-unavailable p,
  .library-update-required h1,
  .library-update-required p {
    margin: 0;
  }

  .profile-unavailable p,
  .library-update-required p {
    color: var(--muted);
  }

  .library-update-required button {
    justify-self: start;
    min-height: 40px;
    padding: 0 16px;
    border: 0;
    border-radius: 10px;
    background: var(--accent);
    color: var(--accent-contrast, #fff);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .library-update-required button:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: 3px;
  }
</style>
