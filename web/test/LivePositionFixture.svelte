<!-- A title playing on another device while this page watches it. The page is the production RoutedLibrary on a
     paired library, so the lifecycle it reports (`playbackActive`) and the Worker's refresh cadence are the real
     ones. `?writer` is that other device instead: its own browser and library, writing a position on request
     (`fixturePlay`), as the Apple TV does every few seconds. -->
<script lang="ts">
  import RoutedLibrary from '../src/RoutedLibrary.svelte';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import { LibraryModel } from '../src/lib/libraryModel.svelte';
  import type { Link } from '../src/lib/links.svelte';
  import '../src/app.css';

  const params = new URLSearchParams(location.search);
  // The key WorkerHydrationFixture seeds, so `?seed` there prepares this page's library.
  const libraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)));
  const link: Link = {
    inboxKey: 'deadbeefcafe1234',
    name: 'Living Room TV',
    libraryKey,
    linkKey: 'fixture',
    deviceId: 'aaaaaaaaaaaaaaaa',
  };
  const writer = params.has('writer');
  let ready = $state(false);

  if (writer) {
    const services = createWorkerServiceSession();
    const model = new LibraryModel(services.library, { libraryKey, mode: 'online' });
    void model.ready.then(() => (ready = true));
    let written = 0;
    (
      window as unknown as {
        fixturePlay: (
          title: { type: 'movie' | 'tv'; id: number },
          seconds: number,
          episode?: { season: number; episode: number },
        ) => Promise<unknown>;
      }
    ).fixturePlay = (title, seconds, episode) =>
      model.recordProgress(
        {
          title,
          ...(episode ? { episode: { ...title, type: 'tv', ...episode } } : {}),
          // Never quite the last one: this library skips a write identical to the row, and the TV's paused
          // player writes a new stamp at one position every three seconds (den's `PlayerView` loop).
          fraction: 0.4 + written * 1e-6,
          seconds,
          observedAt: Date.now(),
        },
        `fixture-play-${++written}`,
      );
  }
</script>

{#if writer}
  {#if ready}<p role="status">Writer ready</p>{/if}
{:else}
  <main style="padding:var(--bar-space) var(--gutter)">
    <RoutedLibrary
      {link}
      query=""
      explore={{}}
      people={{}}
      watchedYear={undefined}
      onchange={() => {}}
    />
  </main>
{/if}
