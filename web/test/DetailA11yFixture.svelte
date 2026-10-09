<!-- A detail page whose busy state and watchlist/seen calls the test can drive and observe directly
     (`window.fixture`), so den-edge#237's keyboard-and-focus fixes can be checked without wiring a whole
     library session. -->
<script lang="ts">
  import Detail from '../src/components/Detail.svelte';
  import { fixtureContentServiceContext } from './contentService';
  import '../src/app.css';
  import type { TitleRow } from '../src/lib/wire';

  let busy = $state(false);
  let row = $state<TitleRow | undefined>(undefined);
  let watchlistCalls = $state(0);
  let seenCalls = $state(0);
  let reactionCalls = $state(0);
  let finishWatchlist: (() => void) | undefined;
  const content = fixtureContentServiceContext();
  const search = new URLSearchParams(location.search);
  const fullActions = search.has('actions');
  const noop = () => {};

  const fixtureRow = (
    status: TitleRow['status']['value'] = 'none',
    reaction: TitleRow['reaction']['value'] = null,
  ): TitleRow => ({
    kind: 'rec',
    schema: 2,
    title: { type: 'movie', id: 42 },
    status: { value: status, at: [1, 0, 'fixture'] },
    resume: { value: status === 'watched' ? 1 : 0, at: [1, 0, 'fixture'], viewing: 1 },
    reaction: { value: reaction, at: [1, 0, 'fixture'] },
    deleted: { value: false, at: [1, 0, 'fixture'] },
    dismissed: { value: false, at: [1, 0, 'fixture'] },
    episodesReset: null,
    addedAt: 1,
    watchedAt: status === 'watched' ? 1 : null,
  });

  if (search.has('seen')) row = fixtureRow('watched');

  function setReaction(reaction: TitleRow['reaction']['value']) {
    const current = row ?? fixtureRow();
    row = { ...current, reaction: { value: reaction, at: [Date.now(), 0, 'fixture'] } };
  }

  function setSeen(seen: boolean) {
    const current = row ?? fixtureRow();
    const at: TitleRow['status']['at'] = [Date.now(), 0, 'fixture'];
    row = {
      ...current,
      status: { value: seen ? 'watched' : 'none', at },
      resume: { ...current.resume, value: seen ? 1 : 0, at },
      watchedAt: seen ? Date.now() : null,
    };
  }

  function setWatchlist(listed: boolean) {
    const current = row ?? fixtureRow();
    const at: TitleRow['status']['at'] = [Date.now(), 0, 'fixture'];
    row = {
      ...current,
      status: { value: listed ? 'watchlist' : 'none', at },
      deleted: { value: false, at },
    };
  }

  async function saveWatchlist(listed: boolean) {
    busy = true;
    setWatchlist(listed);
    if (search.has('hold-save')) await new Promise<void>((resolve) => (finishWatchlist = resolve));
    else await new Promise((resolve) => setTimeout(resolve, 24));
    finishWatchlist = undefined;
    busy = false;
  }

  /* A direct-browser design preview cannot use Playwright's route fixture. Keep this entirely in the test page:
     production still has one metadata path, while a designer can open the real Detail component and its action
     hierarchy without credentials or external requests. */
  if (search.has('preview')) {
    const browserFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/tmdb\/3\/movie\/42(?:\?|$)/.test(url))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 42,
              title: 'The Movie With a Longer Name',
              release_date: '2024-01-01',
              overview:
                'A feature film with enough copy to make the actual mobile detail hierarchy visible.',
              genres: [{ id: 18, name: 'Drama' }],
              videos: {
                results: [{ site: 'YouTube', type: 'Trailer', key: 'preview', official: true }],
              },
              credits: { cast: [], crew: [] },
              release_dates: { results: [] },
              recommendations: { results: [] },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      return browserFetch(input, init);
    };
  }

  (
    window as unknown as {
      fixture: {
        setBusy: (v: boolean) => void;
        watchlistCalls: () => number;
        seenCalls: () => number;
        reactionCalls: () => number;
        finishWatchlist: () => void;
      };
    }
  ).fixture = {
    setBusy: (v: boolean) => (busy = v),
    watchlistCalls: () => watchlistCalls,
    seenCalls: () => seenCalls,
    reactionCalls: () => reactionCalls,
    finishWatchlist: () => finishWatchlist?.(),
  };
</script>

<main style="padding:var(--bar-space) var(--gutter) 32px;max-width:1400px;margin:auto">
  <Detail
    active={true}
    {content}
    ref={{ type: 'movie', id: 42 }}
    reel={null}
    {row}
    episodes={new Map()}
    {busy}
    failure={null}
    notice={null}
    onwatchlist={(_title, listed) => {
      watchlistCalls += 1;
      return saveWatchlist(listed);
    }}
    onseen={(_title, seen) => {
      seenCalls += 1;
      setSeen(seen);
    }}
    onreact={(_title, reaction) => {
      reactionCalls += 1;
      setReaction(reaction);
    }}
    onplay={fullActions ? noop : undefined}
    onplayhere={fullActions ? noop : undefined}
    onepisode={() => {}}
  />
</main>
