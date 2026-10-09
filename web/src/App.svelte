<script lang="ts">
  import NavigationBar from './components/NavigationBar.svelte';
  import RoutedLibrary from './RoutedLibrary.svelte';
  import ScreenLoading from './components/ScreenLoading.svelte';
  import { onMount, untrack } from 'svelte';
  import { browserClock } from './lib/clock';
  import { thisDevice } from './lib/device.svelte';
  import { guestGrants } from './lib/grants.svelte';
  import { consentRequestId } from './lib/oauth';
  import { sendToTV } from './lib/inbox';
  import { links } from './lib/links.svelte';
  import { pageTitle } from './lib/pageTitle';
  import { tabName } from './lib/tabName.svelte';
  import { parseRoute, type Explore, type PeopleView } from './lib/route';
  import { ConnectDialogScreen, InviteDialogScreen, LinkScreen } from './lib/screens.svelte';
  // The invite and consent dialogs load only for a page that asks one of their questions: an invite link, or an
  // assistant's request to connect. Latched, since the invite dialog clears the code as it shows it.
  let invited = $state(false);
  $effect(() => {
    if (guestGrants.invite) invited = true;
  });
  const consenting = consentRequestId(location.href) !== null;
  $effect(() => {
    if (invited) void InviteDialogScreen.load();
  });
  if (consenting) void ConnectDialogScreen.load();
  const identityClock = browserClock();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- In-flight work must not retrigger the effect that starts it.
  const sendingIdentity = new Set<string>();

  async function syncIdentity(link: (typeof links.list)[number], name: string) {
    const deviceId = identityClock.device;
    if (
      !links.list.includes(link) ||
      link.recovered ||
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
    // The library service Worker owns storage and den-core. Keeping its WASM out of the page avoids compiling the
    // same module twice; page-only recovery still loads its own dedicated Worker when someone opens that flow.
    // Pairing, and the curve it runs on, load only for a browser that isn't paired yet and hasn't already chosen to
    // look around without it.
    if (!links.current && !links.browsing) void LinkScreen.load();
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
    r.page === 'people'
      ? { query: r.query, type: r.type, chips: r.chips, traits: r.traits, order: r.order }
      : {};
  let people = $state<PeopleView>(untrack(() => peopleOf(route)));
  $effect(() => {
    if (route.page === 'people') people = peopleOf(route);
  });
  // And the year Watched shows.
  let watchedYear = $state(untrack(() => (route.page === 'watchlist' ? route.year : undefined)));
  $effect(() => {
    if (route.page === 'watchlist') watchedYear = route.year;
  });
  // A title's, a person's and a service's page name themselves once they know what they are showing
  // (`tabName`); until then, and on every other page, the tab says what the address can.
  $effect(() => {
    document.title = tabName() ?? pageTitle(route);
  });
</script>

<!-- On People the bar's field finds people and facets there, with its own text in People's address. -->
<NavigationBar {route} query={route.page === 'people' ? (route.query ?? '') : query} />
{#if invited && InviteDialogScreen.current}<InviteDialogScreen.current />{/if}
{#if consenting && ConnectDialogScreen.current}<ConnectDialogScreen.current />{/if}

<main>
  {#if links.current}
    {#key `${links.current.inboxKey}:${links.current.libraryKey}`}
      <RoutedLibrary
        link={links.current}
        {query}
        {explore}
        {people}
        {watchedYear}
        onchange={(next) => (route = next)}
      />
    {/key}
  {:else if links.browsing}
    <!-- The guest: the same app, with no library behind it. Not a second tree — `link: null` is the
         absent case the components already model. -->
    <RoutedLibrary
      link={null}
      {query}
      {explore}
      {people}
      {watchedYear}
      onchange={(next) => (route = next)}
    />
  {:else if LinkScreen.current}
    <LinkScreen.current />
  {:else if LinkScreen.failed}
    <ScreenLoading screen={LinkScreen} />
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
</style>
