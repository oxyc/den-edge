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
  const content = fixtureContentServiceContext();
  const search = new URLSearchParams(location.search);
  const fullActions = search.has('actions');
  const noop = () => {};

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
      };
    }
  ).fixture = {
    setBusy: (v: boolean) => (busy = v),
    watchlistCalls: () => watchlistCalls,
    seenCalls: () => seenCalls,
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
    onwatchlist={() => (watchlistCalls += 1)}
    onseen={() => (seenCalls += 1)}
    onreact={() => {}}
    onplay={fullActions ? noop : undefined}
    onplayhere={fullActions ? noop : undefined}
    onepisode={() => {}}
  />
</main>
