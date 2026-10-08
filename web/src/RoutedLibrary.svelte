<script lang="ts">
  import { untrack } from 'svelte';
  import Router from './Router.svelte';
  import Library from './Library.svelte';
  import LibraryStatus from './components/LibraryStatus.svelte';
  import ScreenLoading from './components/ScreenLoading.svelte';
  import { LibrarySession } from './lib/librarySession.svelte';
  import { createLibraryService } from './lib/libraryServiceFactory';
  import { LibraryModel } from './lib/libraryModel.svelte';
  import {
    links,
    readPendingReset,
    writePendingReset,
    type Link,
    type PendingReset,
  } from './lib/links.svelte';
  import { dropLocalLibrary, followLocalLibraryKey, localLibraryKey } from './lib/localLibrary';
  import type { KeyResetOutcome } from './lib/libraryServiceProtocol';
  import type { Explore, PeopleView, Route } from './lib/route';
  import { LinkScreen, SettingsScreen } from './lib/screens.svelte';

  let {
    link,
    query,
    explore,
    people,
    watchedYear,
    onchange,
  }: {
    link: Link | null;
    query: string;
    explore: Explore;
    people: PeopleView;
    watchedYear: string | undefined;
    onchange: (route: Route) => void;
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
    if (!key) return new LibrarySession(null, false);
    const service = createLibraryService({ dedicatedWorker: typeof Worker !== 'undefined' });
    const clock = legacyClock();
    const model = new LibraryModel(service, {
      libraryKey: key,
      mode: local ? 'local' : 'online',
      ...(clock ? { legacyClock: clock } : {}),
    });
    // Root snapshots carry failure state; avoid an unhandled rejection while the error surface renders it.
    void model.ready.catch(() => {});
    return new LibrarySession(model, local);
  };

  let session = $state.raw(untrack(() => open(libraryIdentity, !link && libraryIdentity !== null)));
  let pendingReset = $state.raw<PendingReset | null>(untrack(() => readPendingReset()));
  let convergence = 0;
  let convergenceWork = Promise.resolve();

  async function replaceWith(key: string, local: boolean): Promise<LibrarySession> {
    const next = open(key, local);
    try {
      await next.model!.ready;
      libraryIdentity = key;
      session = next;
      return next;
    } catch (error) {
      next.close();
      throw error;
    }
  }

  /** Merge a browser-local library into the newly paired one before either ownership pointer moves. */
  async function joinLibrary(key: string): Promise<boolean> {
    const source = session;
    if (!source.local || !source.model || !libraryIdentity) return false;
    const destination = open(key, false);
    try {
      await destination.model!.ready;
      const { result } = await destination.model!.mergeLocalLibrary(libraryIdentity);
      if (result.kind !== 'local-library.merge' || result.outcome !== 'merged') {
        destination.close();
        return false;
      }
      await dropLocalLibrary();
      libraryIdentity = key;
      session = destination;
      return true;
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

  async function finishReset(
    pending: PendingReset,
    outcome: KeyResetOutcome,
  ): Promise<KeyResetOutcome | null> {
    if (outcome === 'moved' || outcome === 'adopted') {
      links.rekey(pending.from, pending.to);
      pendingReset = null;
      await replaceWith(pending.to, false);
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
    const model = session.model;
    const from = libraryIdentity;
    if (!model || !from || session.local) return 'unavailable';
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
    if (!pending || !model || pending.from !== libraryIdentity || pending.held) return;
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
  // winner's authority, then publish the new session in one assignment. A newer storage event cancels stale work.
  $effect(() => {
    if (!ownKey || link) return;
    return followLocalLibraryKey(ownKey, (nextKey, previousKey) => {
      const run = ++convergence;
      convergenceWork = convergenceWork.then(async () => {
        const next = open(nextKey, true);
        try {
          await next.model!.ready;
          const { result } = await next.model!.mergeLocalLibrary(previousKey);
          if (
            result.kind !== 'local-library.merge' ||
            result.outcome !== 'merged' ||
            run !== convergence
          )
            return next.close();
          libraryIdentity = nextKey;
          session = next;
        } catch {
          next.close();
        }
      });
    });
  });
</script>

{#key session}
  <LibraryStatus toast={session.toast} alert={session.alert} undo={session.undo} />
  <Router
    onchange={(route) => {
      if (route.page === 'settings')
        void (link || session.local ? SettingsScreen.load() : LinkScreen.load());
      onchange(route);
    }}
  >
    {#snippet children(route, active)}
      {#if route.page === 'settings'}
        {#if link || session.local}
          {#if SettingsScreen.current}
            <SettingsScreen.current
              {link}
              model={session.model!}
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
          {link}
          {libraryIdentity}
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
