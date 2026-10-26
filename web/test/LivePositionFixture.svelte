<!-- A title playing on another device while this page watches it. The page is the production RoutedLibrary on a
     paired library, so the lifecycle it reports (`playbackActive`) and the Worker's refresh cadence are the real
     ones. `?writer` is that other device instead: its own browser and library, writing a position on request
     (`fixturePlay`), as the Apple TV does every few seconds. -->
<script lang="ts">
  import RoutedLibrary from '../src/RoutedLibrary.svelte';
  import NavigationBar from '../src/components/NavigationBar.svelte';
  import { parseRoute } from '../src/lib/route';
  import type { ProfileModeCoordinator } from '../src/lib/profileModeCoordinator.svelte';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import { LibraryModel } from '../src/lib/libraryModel.svelte';
  import type { Link } from '../src/lib/links.svelte';
  import { toBase64url } from '../src/lib/wire';
  import '../src/app.css';

  const params = new URLSearchParams(location.search);
  // The key WorkerHydrationFixture seeds, so `?seed` there prepares this page's library. `?household=<byte>` pairs a
  // different one instead.
  const libraryKey = btoa(
    String.fromCharCode(...new Uint8Array(32).fill(Number(params.get('household') ?? 29))),
  );
  const link: Link = {
    inboxKey: 'deadbeefcafe1234',
    name: 'Living Room TV',
    libraryKey,
    linkKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    // This browser received the library from another browser, not from the TV. Playback controls must use the
    // household TV command key rather than this legacy link's identity or inbox.
    deviceId: 'bbbbbbbbbbbbbbbb',
  };
  let route = $state(parseRoute(location.pathname + location.search));
  let profiles = $state.raw<ProfileModeCoordinator | null>(null);
  const writer = params.has('writer');
  let ready = $state(false);

  if (writer) {
    const services = createWorkerServiceSession();
    const model = new LibraryModel(services.library, {
      libraryKey,
      mode: 'online',
      legacyClock: { device: 'aaaaaaaaaaaaaaaa', last: [0, 0, 'aaaaaaaaaaaaaaaa'] },
    });
    // Listed in `set:devices` under the name the page shows it by ("Playing on Apple TV").
    void model.ready
      .then(() =>
        model.heartbeatDevice(
          'Apple TV',
          'fixture-device',
          'tv',
          toBase64url(new Uint8Array(32).fill(9)),
          1,
        ),
      )
      .then(() => (ready = true));
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
  <!-- `?nav`: the app's own bar, fed the profile control the way App does, for the profile switcher. -->
  {#if params.has('nav')}<NavigationBar {route} query="" {profiles} />{/if}
  <main style="padding:var(--bar-space) var(--gutter)">
    <RoutedLibrary
      link={params.has('local') ? null : link}
      query=""
      explore={{}}
      people={{}}
      watchedYear={undefined}
      onchange={(next) => (route = next)}
      onprofilecontrol={(control) => (profiles = control)}
    />
  </main>
{/if}
