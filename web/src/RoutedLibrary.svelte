<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import Router from './Router.svelte';
  import Library from './Library.svelte';
  import LibraryStatus from './components/LibraryStatus.svelte';
  import MobileProfileRow from './components/MobileProfileRow.svelte';
  import ProfileOwnerGate from './components/ProfileOwnerGate.svelte';
  import ProfileSettings from './ProfileSettings.svelte';
  import ScreenLoading from './components/ScreenLoading.svelte';
  import { legacyProfileSession, type ProfileSession } from './lib/profileSession.svelte';
  import { createWorkerServiceSession } from './lib/libraryServiceFactory';
  import { LibraryModel } from './lib/libraryModel.svelte';
  import { startGuestLibrary, startingGrant } from './lib/guestLibrary';
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
  import type { KeyResetOutcome } from './lib/libraryServiceProtocol';
  import type { Explore, PeopleView, Route } from './lib/route';
  import { LinkScreen, SettingsScreen } from './lib/screens.svelte';
  import type { ApplyResult } from './lib/assistant';
  import { assistantLibrary } from './lib/assistantLibrary.svelte';
  import { libraryCredentialId } from './lib/relayFetch';
  import {
    ProfileModeCoordinator,
    previewProfileDirectory,
    profilesCapability,
    type ProfilesCapability,
  } from './lib/profileModeCoordinator.svelte';

  let {
    link,
    query,
    explore,
    people,
    watchedYear,
    onchange,
    onprofilecontrol = () => {},
  }: {
    link: Link | null;
    query: string;
    explore: Explore;
    people: PeopleView;
    watchedYear: string | undefined;
    onchange: (route: Route) => void;
    onprofilecontrol?: (control: ProfileModeCoordinator | null) => void;
  } = $props();

  const ownKey = untrack(() => (link ? null : localLibraryKey()));
  let libraryIdentity = $state.raw(untrack(() => link?.libraryKey ?? ownKey));

  function legacyClock() {
    try {
      const device = localStorage.getItem('den.deviceID') ?? undefined;
      const parsed: unknown = JSON.parse(localStorage.getItem('den.clock') ?? 'null');
      const last =
        Array.isArray(parsed) &&
        parsed.length === 3 &&
        typeof parsed[0] === 'number' &&
        typeof parsed[1] === 'number' &&
        typeof parsed[2] === 'string'
          ? ([parsed[0], parsed[1], parsed[2]] as [number, number, string])
          : undefined;
      return device || last
        ? { ...(device ? { device } : {}), ...(last ? { last } : {}) }
        : undefined;
    } catch {
      return undefined;
    }
  }

  const open = (key: string | null, local: boolean) => {
    // Public browsing uses ContentService without inventing encrypted library state. A local or paired library
    // claims the same already-running Worker, so provider caches and in-flight reads still have one owner.
    const services = createWorkerServiceSession();
    if (!key)
      return legacyProfileSession(null, false, null, services.content, () => services.close());
    const clock = legacyClock();
    const model = new LibraryModel(services.library, {
      libraryKey: key,
      mode: local ? 'local' : 'online',
      ...(clock ? { legacyClock: clock } : {}),
    });
    // Root snapshots carry failure state; avoid an unhandled rejection while the error surface renders it.
    void model.ready.catch(() => {});
    return legacyProfileSession(key, local, model, services.content, () => services.close());
  };

  let session = $state.raw(untrack(() => open(libraryIdentity, !link && libraryIdentity !== null)));
  let profileCoordinator = $state.raw<ProfileModeCoordinator | null>(null);
  let profileCapability = $state<ProfilesCapability | 'checking'>(
    untrack(() => (!libraryIdentity || !session.model ? 'disabled' : 'checking')),
  );
  let profileControlPublished = false;

  // Discovery is fail-closed and asynchronous. A library stays behind a neutral gate until discovery completes,
  // so an enabled host can restore Visitor without ever exposing the Owner UI underneath it.
  onMount(() => {
    if (!libraryIdentity || !session.model) return;
    let current = true;
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
      const coordinator = new ProfileModeCoordinator(
        session,
        localStorage,
        window,
        undefined,
        capability === 'preview' ? previewProfileDirectory() : null,
      );
      profileCoordinator = coordinator;
      profileCapability = capability;
    });
    return () => {
      current = false;
      const coordinator = profileCoordinator;
      profileCoordinator = null;
      profileControlPublished = false;
      onprofilecontrol(null);
      coordinator?.dispose();
    };
  });

  $effect(() => {
    const coordinator = profileCoordinator;
    if (!coordinator) return;
    if (!coordinator.session) coordinator.establishUnprotectedOwner();
    const active = coordinator.session;
    if (!active) return;
    if (session !== active) session = active;
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
    if (!pending || !model || pending.from !== libraryIdentity || pending.held || resetInFlight)
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
    const current = session;
    const model = current.model;
    if (!model || current.local || !link) return;
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
  const memberModel = $derived(!session.local && link ? session.model : null);
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
{:else if profileCapability === 'checking'}
  <p class="profile-loading" role="status">Opening profiles…</p>
{:else if profileCapability === 'indeterminate'}
  <section class="profile-unavailable" aria-labelledby="profile-unavailable-title">
    <h1 id="profile-unavailable-title">Profiles couldn’t be opened</h1>
    <p>The Owner library remains hidden. Reload Den to try again.</p>
  </section>
{:else if profileCoordinator && !profileCoordinator.session}
  <ProfileOwnerGate profiles={profileCoordinator} />
{:else}
  {#if profileCapability === 'preview'}
    <p class="profile-preview" role="status">
      Profile preview · filtering and household migration remain off
    </p>
  {/if}
  {#key session.identity}
    <LibraryStatus toast={session.toast} alert={session.alert} undo={session.undo} />
    <Router
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
          {#if profileCapability === 'preview' && (session.identity.kind === 'visitor' || session.identity.kind === 'profile')}
            <ProfileSettings {session} />
          {:else if session.identity.kind === 'visitor' || session.identity.kind === 'profile'}
            <section class="profile-settings-unavailable" aria-labelledby="profile-settings-title">
              <h1 id="profile-settings-title">Profile settings unavailable</h1>
              <p>Switch to Owner to manage settings on this version of Den.</p>
            </section>
          {:else if link || session.local}
            {#if SettingsScreen.current}
              <SettingsScreen.current
                {link}
                model={session.model!}
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
{/if}

<style>
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
