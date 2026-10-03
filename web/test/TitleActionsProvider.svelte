<!-- Wraps its children in a `TITLE_ACTIONS` + toast context driven by fake, inspectable handlers
     (`window.fixture`), so a fixture page can have both a "library open" poster (inside this) and a guest one
     (outside it, with no context ancestor at all) on the same page. Rows are real `TitleRow`s, built with the
     same actions `Library.svelte` uses, so a menu item's checked state is read exactly as `titleState` reads it. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { setTitleActionsContext } from '../src/lib/titleActions';
  import { setToastContext } from '../src/lib/toast';
  import {
    addToWatchlist,
    blankTitle,
    markWatched,
    react,
    removeFromLibrary,
    unwatch,
  } from '../src/lib/actions';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import type { Title } from '../src/lib/library';
  import type { Stamp, TitleRow } from '../src/lib/wire';

  let { children }: { children: Snippet } = $props();

  let busy = $state(false);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- A fixture-only map, read through `rowOf`.
  let rows = new Map<string, TitleRow>();
  let version = $state(0);
  let toast = $state<string | null>(null);
  let undo = $state<{ label: string; run: () => void } | null>(null);
  const calls: Record<string, number> = {
    toggleWatchlist: 0,
    toggleSeen: 0,
    setReaction: 0,
    dismissContinueWatching: 0,
    play: 0,
    playHere: 0,
  };
  let at: Stamp = [1, 0, 'web1'];
  const key = (title: Title) => `${title.type}:${title.id}`;
  const rowOf = (title: Title) => rows.get(key(title));
  function change(title: Title, fn: (row: TitleRow, at: Stamp) => TitleRow) {
    rows.set(key(title), fn(rowOf(title) ?? blankTitle(title, 0), (at = [at[0] + 1, 0, 'web1'])));
    version += 1;
  }

  // What `Library.svelte`'s own `menuToast` does: announce the result through the toast, same as the real
  // context's handlers do, so a test of the toast/Undo is a test of the real wiring, not a fixture that skips it.
  function notify(message: string, undoAction?: { label: string; run: () => void } | null) {
    toast = message;
    undo = undoAction ?? null;
  }

  setToastContext(notify);

  setTitleActionsContext({
    get libraryOpen() {
      return true;
    },
    get busy() {
      return busy;
    },
    rowOf: (title) => {
      void version;
      return rowOf(title);
    },
    resumeOf: (title: Title) => (title.type === 'tv' ? { season: 2, episode: 4 } : undefined),
    toggleWatchlist: (title, on) => {
      calls.toggleWatchlist += 1;
      change(title, on ? addToWatchlist : removeFromLibrary);
      notify(
        on
          ? `Added “${title.title}” to your watchlist`
          : `Removed “${title.title}” from your watchlist`,
        on ? null : { label: 'Undo', run: () => change(title, addToWatchlist) },
      );
    },
    toggleSeen: (title, on) => {
      calls.toggleSeen += 1;
      change(title, on ? markWatched : unwatch);
      notify(on ? `Marked “${title.title}” as seen` : `Marked “${title.title}” as unseen`);
    },
    setReaction: (title, reaction) => {
      calls.setReaction += 1;
      change(title, (row, at) => react(row, reaction, at));
      notify(`Set “${title.title}” to ${reaction ?? 'No rating'}`);
    },
    dismissContinueWatching: (title) => {
      calls.dismissContinueWatching += 1;
      notify(`Removed “${title.title}” from Continue Watching`, {
        label: 'Undo',
        run: () => calls.dismissContinueWatching--,
      });
    },
    play: () => {
      calls.play += 1;
    },
    playHere: () => {
      calls.playHere += 1;
    },
  });

  (
    window as unknown as {
      fixture: {
        setBusy: (v: boolean) => void;
        calls: () => Record<string, number>;
      };
    }
  ).fixture = {
    setBusy: (v: boolean) => (busy = v),
    calls: () => ({ ...calls }),
  };
</script>

<LibraryStatus {toast} alert={null} {undo} />
{@render children()}
