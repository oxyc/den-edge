<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Router from '../src/Router.svelte';
  import Detail from '../src/components/Detail.svelte';
  import Person from '../src/components/Person.svelte';
  import type { EpisodeRow, TitleRow } from '../src/lib/wire';
  import type { Title } from '../src/lib/library';
  import type { TitleSeason } from '../src/lib/route';
  import '../src/app.css';
  import { testLog } from '../src/lib/downloadTestLog';
  import { fetchSourceList } from '../src/lib/titleSources';
  import { fixtureLibraryService } from './libraryService';
  import { fixtureContentServiceContext } from './contentService';
  import { installKeyboardNavigation } from '../src/lib/keyboardNavigation';

  onMount(installKeyboardNavigation);

  const scout = { install: 'http://scout.internal/config', base: '/scout/config' };
  const routes = { scout: [{ url: 'http://scout.internal' }] };
  const content = fixtureContentServiceContext({
    tmdb: 'fixture-key',
    omdb: 'fixture-omdb',
    atlas: '/atlas',
  });
  // A download is a service command over a library held in memory; the component never sees its rows.
  const library = fixtureLibraryService({
    log: testLog().log,
    // The parity spec changes Scout's answer between opening Sources and using the episode's direct Download action.
    refreshDownloadSources: true,
    effects: {
      resolve: async (title) =>
        title.imdbId
          ? fetchSourceList(
              scout,
              title.imdbId,
              routes,
              title.season,
              title.episode,
              undefined,
              fetch,
            )
          : { sources: null },
    },
  });
  // Production's library service schedules download maintenance; this in-process fixture drives the same query.
  const downloadPoll = setInterval(() => void library.model.refreshDownloads(), 300);
  onDestroy(() => clearInterval(downloadPoll));
  const noop = () => {};
  // The season the address names, as `App.svelte` hands it down.
  let address = $state.raw<TitleSeason>();
  const at = [100, 0, 'test'] as const;
  const stamped = <T,>(value: T) => ({ value, at });
  let row = $state<TitleRow>({
    kind: 'rec',
    schema: 2,
    title: { type: 'tv', id: 9 },
    status: stamped('inProgress'),
    resume: { value: 0, at, viewing: 1 },
    reaction: stamped(null),
    deleted: stamped(false),
    dismissed: stamped(false),
    episodesReset: null,
    addedAt: 1,
    watchedAt: null,
  });
  let episodes = $state(
    new Map<string, EpisodeRow>([
      [
        '1:1',
        {
          kind: 'ep',
          schema: 2,
          title: { type: 'tv', id: 9 },
          season: 1,
          episode: 1,
          progress: { value: 0.4, at, viewing: 1 },
        },
      ],
    ]),
  );
  function play(t: Title, s?: number, e?: number, filename?: string) {
    document.dispatchEvent(
      new CustomEvent('fixture:play', { detail: { id: t.id, season: s, episode: e, filename } }),
    );
  }
  function seen(t: Title, s: number, e: number, value: boolean) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Match production immutable snapshot updates through state assignment.
    episodes = new Map(episodes).set(`${s}:${e}`, {
      kind: 'ep',
      schema: 2,
      title: t,
      season: s,
      episode: e,
      progress: { value: value ? 1 : 0, at: [200, 0, 'test'], viewing: 1 },
    });
  }
  function seenSeason(t: Title, s: number, numbers: number[], value: boolean) {
    for (const number of numbers) seen(t, s, number, value);
  }
  const noDirectPlayback = new URLSearchParams(location.search).has('no-play');
</script>

<main style="padding:var(--bar-space) var(--gutter);max-width:1400px;margin:0 auto;overflow-x:clip">
  <Router
    onchange={(route) => {
      if (route.page === 'title') address = route;
    }}
  >
    {#snippet children(route, active)}
      {#if route.page === 'person'}<Person id={route.id} {content} {active} />
      {:else if route.page === 'title'}
        <Detail
          ref={{ type: route.type, id: route.id }}
          {address}
          playRequest={route.play ? route : undefined}
          trailerRequested={route.trailer === true}
          {active}
          {content}
          atlas="/atlas"
          region="FI"
          {scout}
          {routes}
          {row}
          {episodes}
          continued={{ episode: { season: 1, episode: 1 }, fraction: 0.4 }}
          busy={false}
          failure={null}
          notice={null}
          onwatchlist={noop}
          onseen={noop}
          onreact={(title, value) => (row = { ...row, reaction: stamped(value) })}
          onplay={noDirectPlayback
            ? undefined
            : (_tv: string, t: Title, s?: number, e?: number) => play(t, s, e)}
          tvs={[{ id: 'aaaa000000000001', name: 'Living room', play: 'A'.repeat(43) }]}
          onplayhere={noDirectPlayback ? undefined : play}
          onepisode={seen}
          onseason={seenSeason}
          model={library.model}
        />
      {/if}
    {/snippet}
  </Router>
</main>
