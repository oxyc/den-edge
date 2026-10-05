<script lang="ts">
  // The shared download queue (den-spec library-v4 §17) on a library whose rows live in a store the test holds,
  // reached at `/fixture-store/rows`: every page and every browser context reads the same rows, as every device
  // reads den-edge. `?page=title` is a title's Sources; `?page=downloads` the Downloads page. `?device=` names the
  // device, and `?device=` other than this one is how a test is "another device".
  import { onMount } from 'svelte';
  import Detail from '../src/components/Detail.svelte';
  import DownloadPosterCard from '../src/components/DownloadPosterCard.svelte';
  import DownloadsPage from '../src/components/DownloadsPage.svelte';
  import RoutePage from '../src/components/RoutePage.svelte';
  import '../src/app.css';
  import { downloads } from '../src/lib/downloadQueue.svelte';
  import type { Download } from '../src/lib/downloadRows';
  import type { Title } from '../src/lib/library';
  import type { LibraryLog } from '../src/lib/log';
  import { syncPolicy } from '../src/lib/syncCore';
  import { rowName, type Row, type SettingsRow, type Stamp } from '../src/lib/wire';

  const params = new URLSearchParams(location.search);
  const requestedPage = params.get('page');
  const page =
    requestedPage === 'downloads' || requestedPage === 'artwork' ? requestedPage : 'title';
  const device = params.get('device') ?? 'aaaaaaaaaaaaaaaa';
  const noop = () => {};
  const source = (filename: string, url: string, label: string) => ({
    filename,
    url,
    label,
    cached: false,
    seeders: 10,
    badges: ['1080p'],
    languages: [],
    probed: true,
    identity: filename.toLowerCase(),
    attributes: { resolution: '1080p', cached: false, seeders: 10 },
  });
  let artworkActive = $state(!params.has('hidden'));
  let artworkMounted = $state(true);
  let legacyEpisode = $state<Download>({
    name: 'download:tv:1399:2:4',
    content: 'tv:1399:2:4',
    release: { identity: 'episode.mkv', label: 'Episode', url: '/scout/p/episode' },
    title: {
      mediaType: 'tv',
      mediaId: 1399,
      season: 2,
      episode: 4,
      title: 'Legacy episode',
      posterPath: '/portrait.jpg',
    },
    queuedAt: 1,
    queuedBy: device,
    tried: [],
    exhausted: false,
    announced: false,
    reported: false,
    reannounced: false,
    row: { kind: 'set', schema: 2, name: 'download:tv:1399:2:4', values: {} },
    seq: 0,
  });
  const legacyTitle: Title = {
    type: 'tv',
    id: 1399,
    title: 'Legacy episode',
    posterPath: '/portrait.jpg',
  };
  (
    window as unknown as {
      downloadsFixture: {
        setActive: (active: boolean) => void;
        setMounted: (mounted: boolean) => void;
        refreshIdentity: () => void;
        changeEpisode: () => void;
      };
    }
  ).downloadsFixture = {
    setActive: (active) => (artworkActive = active),
    setMounted: (mounted) => (artworkMounted = mounted),
    refreshIdentity: () =>
      (legacyEpisode = {
        ...legacyEpisode,
        title: { ...legacyEpisode.title },
        row: { ...legacyEpisode.row },
      }),
    changeEpisode: () =>
      (legacyEpisode = {
        ...legacyEpisode,
        content: 'tv:1399:3:1',
        name: 'download:tv:1399:3:1',
        title: { ...legacyEpisode.title, season: 3, episode: 1 },
      }),
  };

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Replaced whole on each read; the queue's `touch` redraws.
  let held = new Map<string, SettingsRow>();
  const read = async () => {
    const rows = (await (await fetch('/fixture-store/rows')).json()) as SettingsRow[];
    held = new Map(rows.map((row) => [rowName(row), row]));
  };
  const newest = (): Stamp => {
    let latest: Stamp = [0, 0, ''];
    for (const row of held.values())
      for (const value of Object.values(row.values))
        if (value.at[0] > latest[0] || (value.at[0] === latest[0] && value.at[1] > latest[1]))
          latest = value.at;
    return latest;
  };
  const log = {
    readOnly: false,
    wireMinimum: 4,
    rows: (): Row[] => [...held.values()],
    settings: (name: string) => held.get(`set:${name}`),
    seqOf: () => 0,
    newestStamp: newest,
    async write(row: SettingsRow) {
      const seen = held.get(rowName(row));
      const merged = seen ? syncPolicy<SettingsRow>({ op: 'merge', a: seen, b: row }) : row;
      await fetch('/fixture-store/rows', { method: 'POST', body: JSON.stringify(merged) });
      held.set(rowName(merged), merged);
      return merged;
    },
    async writeAt() {
      return false;
    },
  } as unknown as LibraryLog;
  let last: Stamp = [0, 0, device];
  const clock = {
    device,
    issue(at = Date.now()) {
      last = at > last[0] ? [at, 0, device] : [last[0], last[1] + 1, device];
      return last;
    },
    see(stamp: Stamp) {
      if (stamp[0] > last[0]) last = [stamp[0], stamp[1], device];
    },
  };

  let ready = $state(false);
  onMount(() => {
    if (page === 'artwork') return;
    // What the library's held read does: another device's write shows here within one read.
    const timer = setInterval(() => void read().then(() => downloads.touch()), 300);
    void read().then(() => {
      downloads.attach(
        log,
        clock,
        (url) => (url.startsWith('/scout/') ? url : null),
        async () => ({
          sources: [
            source('first.mkv', '/scout/p/first', 'First release'),
            source('second.mkv', '/scout/p/second', 'Second release'),
          ],
        }),
      );
      ready = true;
    });
    return () => clearInterval(timer);
  });
</script>

<main style="padding:100px 20px">
  {#if page === 'artwork'}
    <RoutePage active={artworkActive}>
      {#if artworkMounted}
        <DownloadPosterCard
          download={legacyEpisode}
          title={legacyTitle}
          active={artworkActive}
          menu={false}
        />
      {/if}
    </RoutePage>
  {:else if ready && page === 'downloads'}
    <DownloadsPage />
  {:else if ready}
    <Detail
      ref={{ type: 'movie', id: 42 }}
      tmdbKey="fixture-key"
      scout={{ install: 'http://scout.invalid/cfg', base: '/scout/cfg' }}
      routes={{ scout: [{ url: 'http://scout.invalid' }] }}
      row={undefined}
      episodes={new Map()}
      busy={false}
      failure={null}
      notice={null}
      onwatchlist={noop}
      onseen={noop}
      onreact={noop}
      onplay={noop}
      onepisode={noop}
    />
  {/if}
</main>
