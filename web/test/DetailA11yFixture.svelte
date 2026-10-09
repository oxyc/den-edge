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
    onepisode={() => {}}
  />
</main>
