<script lang="ts">
  import Router from '../src/Router.svelte';
  import Detail from '../src/components/Detail.svelte';
  import Person from '../src/components/Person.svelte';
  import { navigate } from '../src/lib/navigation';
  import type { EpisodeRow, TitleRow } from '../src/lib/wire';
  import type { Title } from '../src/lib/library';
  import '../src/app.css';
  const noop = () => {};
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
  const select = (t: Title) => navigate(`#title/${t.type}/${t.id}`);
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
  const scout = { install: 'http://scout.internal/config', base: '/scout/config' };
  const routes = { scout: [{ url: 'http://scout.internal' }] };
</script>

<main style="padding:var(--bar-space) var(--gutter);max-width:1400px;margin:0 auto;overflow-x:clip">
  <Router onchange={noop}>
    {#snippet children(route, active)}
      {#if route.page === 'person'}<Person
          id={route.id}
          tmdbKey="fixture-key"
          {active}
          onselect={select}
        />
      {:else if route.page === 'title'}
        <Detail
          ref={{ type: route.type, id: route.id }}
          {active}
          tmdbKey="fixture-key"
          omdbKey="fixture-omdb"
          region="FI"
          {scout}
          {routes}
          {row}
          {episodes}
          busy={false}
          failure={null}
          notice={null}
          onwatchlist={noop}
          onseen={noop}
          onreact={(title, value) => (row = { ...row, reaction: stamped(value) })}
          onplay={play}
          onplayhere={play}
          onepisode={seen}
          onselect={select}
        />
      {/if}
    {/snippet}
  </Router>
</main>
