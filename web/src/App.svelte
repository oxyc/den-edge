<script lang="ts">
  import ConnectDialog from './components/ConnectDialog.svelte';
  import InviteDialog from './components/InviteDialog.svelte';
  import NavigationBar from './components/NavigationBar.svelte';
  import RoutedLibrary from './RoutedLibrary.svelte';
  import { onMount, untrack } from 'svelte';
  import { browserClock } from './lib/clock';
  import { thisDevice } from './lib/device.svelte';
  import { sendToTV } from './lib/inbox';
  import { links } from './lib/links.svelte';
  import { pageTitle } from './lib/pageTitle';
  import { parseRoute, type Explore, type PeopleView } from './lib/route';
  import { LinkScreen } from './lib/screens.svelte';
  import { preloadSyncPolicy } from './lib/syncLoader';
  import { onTmdbThrottle } from './lib/tmdbCache';

  let tmdbLimited = $state(false);
  const identityClock = browserClock();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- In-flight work must not retrigger the effect that starts it.
  const sendingIdentity = new Set<string>();

  async function syncIdentity(link: (typeof links.list)[number], name: string) {
    const deviceId = identityClock.device;
    if (
      !links.list.includes(link) ||
      sendingIdentity.has(link.inboxKey) ||
      (link.sentIdentityName === name && link.sentIdentityDeviceId === deviceId)
    )
      return;
    sendingIdentity.add(link.inboxKey);
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        if (!links.list.includes(link)) return;
        if (await sendToTV(link, { type: 'device', name, deviceId })) {
          links.identityDelivered(link, name, deviceId);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      sendingIdentity.delete(link.inboxKey);
      // A rename can land while the previous value is in flight. The reactive effect sees it, but the in-flight
      // guard deliberately declines that call, so start the newer value after releasing the guard.
      if (thisDevice.name !== name) void syncIdentity(link, thisDevice.name);
    }
  }

  function syncIdentities() {
    const name = thisDevice.name;
    for (const link of links.list) void syncIdentity(link, name);
  }

  $effect(() => syncIdentities());

  onMount(() => {
    let clear: ReturnType<typeof setTimeout> | undefined;
    const stop = onTmdbThrottle(({ retryMs }) => {
      tmdbLimited = true;
      if (clear) clearTimeout(clear);
      clear = setTimeout(() => (tmdbLimited = false), retryMs);
    });
    return () => {
      stop();
      if (clear) clearTimeout(clear);
    };
  });

  onMount(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') syncIdentities();
    };
    window.addEventListener('online', syncIdentities);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', syncIdentities);
      document.removeEventListener('visibilitychange', visible);
    };
  });

  $effect(() => {
    if (links.current) preloadSyncPolicy();
    // Pairing, and the curve it runs on, load only for a browser that isn't paired yet and hasn't already
    // chosen to look around without it.
    else if (!links.browsing) void LinkScreen.load();
  });

  // The links hold this browser's keys, and Safari clears a site's storage after a week unused unless it is
  // installed or the storage is persistent — which would mean pairing again.
  $effect(() => {
    if (links.list.length) void navigator.storage?.persist?.().catch(() => false);
  });

  let route = $state(parseRoute(location.pathname + location.search));
  // The address holds the search, so a result page can be linked, reloaded or shared and still be the same
  // search. It is read from there rather than derived from the current page: opening a result and coming back
  // would otherwise empty the query and fill it again, which re-runs the search and loses where it was
  // scrolled to. The field keeps what was typed until another search replaces it.
  let query = $state(untrack(() => (route.page === 'search' ? route.query : '')));
  // What Explore is browsing travels the same way, for the same reason.
  let explore = $state<Explore>(
    untrack(() => (route.page === 'search' ? { type: route.type, chips: route.chips } : {})),
  );
  $effect(() => {
    if (route.page !== 'search') return;
    query = route.query;
    explore = { type: route.type, chips: route.chips };
  });
  // And what People is browsing.
  const peopleOf = (r: typeof route): PeopleView =>
    r.page === 'people' ? { type: r.type, chips: r.chips, traits: r.traits, order: r.order } : {};
  let people = $state<PeopleView>(untrack(() => peopleOf(route)));
  $effect(() => {
    if (route.page === 'people') people = peopleOf(route);
  });
  // A title's and a person's page name themselves once they know what they are showing, so this sets what can
  // be known from the address and leaves those two to overwrite it.
  $effect(() => {
    document.title = pageTitle(route);
  });
</script>

<svelte:head>
  {#if links.current}
    <link rel="preconnect" href="https://api.themoviedb.org" crossorigin="anonymous" />
    <link rel="preconnect" href="https://image.tmdb.org" />
  {/if}
</svelte:head>

<NavigationBar {route} {query} />
<InviteDialog />
<ConnectDialog />

<main>
  {#if tmdbLimited}
    <p class="tmdb-limit" role="alert">
      TMDB is temporarily limiting requests. Some titles may be missing; try again after a short
      wait.
    </p>
  {/if}
  {#if links.current}
    {#key `${links.current.inboxKey}:${links.current.libraryKey}`}
      <RoutedLibrary
        link={links.current}
        {query}
        {explore}
        {people}
        onchange={(next) => (route = next)}
      />
    {/key}
  {:else if links.browsing}
    <!-- The guest: the same app, with no library behind it. Not a second tree — `link: null` is the
         absent case the components already model. -->
    <RoutedLibrary link={null} {query} {explore} {people} onchange={(next) => (route = next)} />
  {:else if LinkScreen.current}
    <LinkScreen.current />
  {/if}
</main>

<style>
  /* The page's column. It does NOT clip: clipping here cut the billboard and the detail trailer off at this
     column on any screen wider than it, and `overflow-clip-margin` did not save them — so the guard against
     sideways scrolling lives on `body`, where the clip box is the window itself (`app.css`). */
  main {
    max-width: var(--page-max);
    margin: 0 auto;
    padding: var(--bar-space) var(--gutter) calc(32px + env(safe-area-inset-bottom));
  }

  .tmdb-limit {
    position: relative;
    z-index: 4;
    margin: 0 0 18px;
    padding: 12px 16px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--card) 92%, var(--accent));
    color: var(--fg);
  }
</style>
