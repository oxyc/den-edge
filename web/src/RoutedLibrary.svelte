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
  import type { KeyResetOutcome, ProfileDirectoryView } from './lib/libraryServiceProtocol';
  import type { Explore, PeopleView, Route } from './lib/route';
  import { LinkScreen, SettingsScreen } from './lib/screens.svelte';
  import type { ApplyResult } from './lib/assistant';
  import { assistantLibrary } from './lib/assistantLibrary.svelte';
  import { libraryCredentialId } from './lib/relayFetch';
  import { persistentProfileIdentity, profileSessionKey } from './lib/profileIdentity';
  import { resetProfileNavigation } from './lib/profileNavigation';
  import { readProfileHint, saveProfileHint, type ProfileHint } from './lib/profileHint';
  import {
    allowsImplicitAssistant,
    householdAdministration,
    profileMarkerPresent,
    ProfileModeCoordinator,
    previewProfileDirectory,
    profileDirectoryState,
    profilesCapability,
    usesProfileDirectory,
    type ProfileActivityModelFactory,
    type ProfilesCapability,
  } from './lib/profileModeCoordinator.svelte';
  import { profileHouseholdSettingsModel, profileSettingsRoute } from './lib/profileSettingsRoute';
  import { scopeRecentSearches } from './lib/recentSearches';
  import { CompoundResetPage } from './lib/profileKeyResetPage';

  let {
    link,
    query,
    explore,
    people,
    watchedYear,
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
    onchange: (route: Route) => void;
    onprofilecontrol?: (control: ProfileModeCoordinator | null) => void;
    /** The remembered Owner the bar draws until the profile coordinator takes over; null once it has. */
    onprofilehint?: (hint: ProfileHint | null) => void;
    /** Tells the page whether household-level dialogs (invites, phone links, assistant consent) may open. */
    onhouseholdadmin?: (allowed: boolean) => void;
  } = $props();

  const ownKey = untrack(() => (link ? null : localLibraryKey()));
  let libraryIdentity = $state.raw(untrack(() => link?.libraryKey ?? ownKey));

  const realProfilesHost = async () => (await profilesCapability()) === 'enabled';

  const open = (key: string | null, local: boolean) => {
    // Public browsing uses ContentService without inventing encrypted library state. A local or paired library
    // claims the same already-running Worker, so provider caches and in-flight reads still have one owner.
    const services = createWorkerServiceSession({
      supervisor: { profileHouseholdEnabled: realProfilesHost },
    });
    if (!key)
      return legacyProfileSession(null, false, null, services.content, () => services.close());
    const clock = legacyClockBootstrap();
    const model = new LibraryModel(services.library, {
      libraryKey: key,
      mode: local ? 'local' : 'online',
      wire: 4,
      bootstrapProfileHousehold: !local,
      ...(clock ? { legacyClock: clock } : {}),
    });
    // Root snapshots carry failure state; avoid an unhandled rejection while the error surface renders it.
    void model.ready.catch(() => {});
    return legacyProfileSession(key, local, model, services.content, () => services.close());
  };

  let session = $state.raw(untrack(() => open(libraryIdentity, !link && libraryIdentity !== null)));
  let routedProfile = untrack(() => profileSessionKey(session.identity, session.policyKey));
  let profileCoordinator = $state.raw<ProfileModeCoordinator | null>(null);
  let profileDirectoryLease = $state.raw<LibraryModelLease<ProfileDirectoryView> | null>(null);
  let profileCapability = $state<ProfilesCapability | 'checking'>(
    untrack(() => (!libraryIdentity || !usesProfileDirectory(session) ? 'disabled' : 'checking')),
  );
  // The directory read answered "none": a household before its Owner split, or a browser-local library.
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
  const optimistic = $derived(
    profileHint !== null &&
      (profileCapability === 'checking' ||
        (activeCapability === 'enabled' && !profileCoordinator) ||
        (!!profileCoordinator && !profileCoordinator.session && profileCoordinator.restoring)),
  );
  $effect.pre(() => onprofilehint(optimistic ? profileHint : null));
  $effect(() => {
    if (profileCapability === 'disabled') saveProfileHint(null);
  });
  $effect(() => {
    const coordinator = profileCoordinator;
    if (!coordinator) return;
    if (coordinator.session) saveProfileHint(coordinator.activeChoice);
    else if (!coordinator.restoring) saveProfileHint(null);
  });
  let profileControlPublished = false;
  let openingCommittedProfiles = false;
  let committedProfilesOpen = 0;
  const settingsRoute = $derived(profileSettingsRoute(session, profileCoordinator?.mode ?? null));
  const householdSettingsModel = $derived(
    profileHouseholdSettingsModel(session, profileCoordinator?.mode ?? null),
  );
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
    const services = createWorkerServiceSession({
      supervisor: { profileHouseholdEnabled: realProfilesHost },
    });
    const model = new LibraryModel(services.library, {
      libraryKey,
      mode: 'online',
      wire: 4,
      bootstrapProfileHousehold: false,
    });
    void model.ready.catch(() => {});
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

  // Discovery is fail-closed and asynchronous. A library stays behind a neutral gate until discovery completes,
  // so an enabled host can restore Visitor without ever exposing the Owner UI underneath it.
  let discoverProfiles: () => void = () => {};
  onMount(() => {
    let current = true;
    let discovering = false;
    discoverProfiles = () => {
      if (discovering || !libraryIdentity || !usesProfileDirectory(session)) return;
      discovering = true;
      profileCapability = 'checking';
      void profilesCapability().then((capability) => {
        if (!current) return;
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
        else profileDirectoryLease = session.model.profiles();
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

  $effect(() => {
    if (profileCapability !== 'enabled') return;
    const state = profileDirectoryState(
      profileDirectoryLease?.snapshot.value as ProfileDirectoryView | undefined,
    );
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
      const activity = openProfileActivity(owner.libraryKey);
      openingCommittedProfiles = true;
      void activity.model.ready
        .then(
          () => {
            if (opening !== committedProfilesOpen || profileCoordinator || session !== legacy) {
              activity.close();
              return;
            }
            legacy.household.commitProfiles(libraryIdentity!);
            const ownerSession = activeProfileSession(
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
              openProfileActivity,
            );
          },
          () => {
            activity.close();
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
      if (!profileControlPublished)
        routedProfile = profileSessionKey(active.identity, active.policyKey);
      session = active;
    }
    if (!profileControlPublished) {
      profileControlPublished = true;
      onprofilecontrol(coordinator);
    }
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

  /** Merge a browser-local library into the newly paired one before either ownership pointer moves. */
  async function joinLibrary(key: string): Promise<boolean> {
    let sourceKey = libraryIdentity;
    if (!session.local || !session.model || !sourceKey) return false;
    const destination = open(key, false);
    try {
      await destination.model!.ready;
      // A first-tab winner can change again while a TV join is copying it. Follow that pointer until the exact source
      // just copied can be removed; every earlier source is already safe in the destination.
      for (let round = 0; round < 8; round++) {
        const { result } = await destination.model!.mergeLocalLibrary(sourceKey);
        if (
          result.kind !== 'local-library.merge' ||
          (result.outcome !== 'merged' && result.outcome !== 'absent') ||
          !alive
        ) {
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

  // Assistants (den-spec wire/assistant-v1.md): while a member's library is open here, the consent dialog may write
  // grants into it. A library kept only in this browser is no member's on den-edge, and has none.
  $effect(() => {
    const model = implicitAssistantModel;
    if (!model) return;
    let open = true;
    void model.ready.then(
      () => {
        if (open) assistantLibrary.model = model;
      },
      () => {},
    );
    return () => {
      open = false;
      if (assistantLibrary.model === model) assistantLibrary.model = null;
    };
  });

  // The work for connected assistants runs only while the library has one, as its settings say (most libraries never
  // do, and pay nothing for it): with a live grant to write, requests an assistant queued are drained, applied through
  // the tap path and told in a quiet toast; with a live read record, the projection is published (§15); with either,
  // grants den-edge still lists are renewed. Each starts and stops as consent or revocation, here or on another
  // device, changes the rows. The code itself is fetched only then.
  const memberModel = $derived(implicitAssistantModel);
  const drainNeeded = $derived(memberModel?.settings.value?.assistant.write ?? false);
  const publishNeeded = $derived(memberModel?.settings.value?.assistant.read ?? false);
  const renewNeeded = $derived(drainNeeded || publishNeeded);

  function whileNeeded(
    needed: boolean,
    run: (
      assistant: typeof import('./lib/assistant'),
      model: LibraryModel,
      signal: AbortSignal,
    ) => void,
  ) {
    const current = session;
    const model = memberModel;
    if (!needed || !model) return;
    const stop = new AbortController();
    void import('./lib/assistant').then(
      (assistant) => {
        if (!stop.signal.aborted && current === session) run(assistant, model, stop.signal);
      },
      (error: unknown) => console.warn('den: the assistant connection could not be loaded', error),
    );
    return () => stop.abort();
  }

  $effect(() =>
    whileNeeded(renewNeeded, ({ renewListed }, model, signal) => {
      const renew = () =>
        void renewListed((grants) => model.renewAssistant(grants)).catch((error: unknown) =>
          console.warn('den: assistant grants could not be renewed', error),
        );
      renew();
      const renewal = setInterval(renew, RENEW_EVERY_MS);
      signal.addEventListener('abort', () => clearInterval(renewal), { once: true });
    }),
  );

  $effect(() => {
    const current = session;
    return whileNeeded(drainNeeded, ({ drainWhileOpen }, model, signal) => {
      void drainWhileOpen(
        {
          libraryId: libraryCredentialId() ?? 'library',
          apply: (messages) => model.applyAssistant(messages),
          applied: (result) => void announceAssistant(current, result),
        },
        signal,
      );
    });
  });

  $effect(() =>
    whileNeeded(publishNeeded, ({ publishWhileOpen }, model, signal) => {
      void publishWhileOpen(
        {
          libraryId: libraryCredentialId() ?? 'library',
          publish: () => model.publishAssistant(),
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
        if (!current || !alive) return;
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
    void untrack(() => phoneLanding.run(link ? null : joinLibrary));
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
    void startGuestLibrary(grant, joinLibrary)
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
{:else if profileCoordinator && !profileCoordinator.session && !profileCoordinator.restoring}
  <ProfileOwnerGate profiles={profileCoordinator} />
{:else}
  <!-- Optimistic first frames are inert: nothing can be written to the bootstrap library before the Owner opens. -->
  <div class="library-frame" inert={optimistic}>
    {#if profileCapability === 'preview'}
      <p class="profile-preview" role="status">
        Profile preview · filtering and household migration remain off
      </p>
    {/if}
    {#key session.identity}
      <LibraryStatus toast={session.toast} alert={session.alert} undo={session.undo} />
      <Router
        profile={profileSessionKey(session.identity)}
        onchange={(route) => {
          if (route.page === 'settings')
            void (session.identity.kind === 'visitor'
              ? Promise.resolve()
              : link || session.local
                ? SettingsScreen.load()
                : LinkScreen.load());
          onchange(route);
        }}
      >
        {#snippet children(route, active)}
          {#if route.page === 'settings'}
            {#if profileCoordinator}<MobileProfileRow profiles={profileCoordinator} />{/if}
            {#if settingsRoute === 'personal'}
              <ProfileSettings {session} />
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
            {:else if (link || session.local) && householdSettingsModel}
              {#if SettingsScreen.current}
                <SettingsScreen.current
                  {link}
                  model={householdSettingsModel}
                  preferences={session.preferences}
                  content={session.content}
                  local={session.local}
                  onjoin={joinLibrary}
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
              link={session.identity.kind === 'visitor' ? null : link}
              {session}
              {route}
              {active}
              {query}
              {explore}
              {people}
              {watchedYear}
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
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
    border-radius: 999px;
    background: color-mix(in srgb, var(--card) 92%, var(--accent));
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
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
</style>
