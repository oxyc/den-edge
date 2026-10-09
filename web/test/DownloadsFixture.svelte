<script lang="ts">
  // The shared download queue (den-spec library-v4 §17) on a library whose rows live in a store the test holds,
  // reached at `/fixture-store/rows`: every page and every browser context reads the same rows, as every device
  // reads den-edge. `?page=title` is a title's Sources; `?page=downloads` the Downloads page. `?device=` names the
  // device, and `?device=` other than this one is how a test is "another device".
  import { onMount } from 'svelte';
  import Detail from '../src/components/Detail.svelte';
  import DownloadsPage from '../src/components/DownloadsPage.svelte';
  import '../src/app.css';
  import { downloadStill } from '../src/lib/downloadArtwork';
  import type { LibraryLog } from '../src/lib/log';
  import { syncPolicy } from '../src/lib/syncCore';
  import { rowName, type Row, type SettingsRow, type Stamp } from '../src/lib/wire';
  import { fixtureLibraryService } from './libraryService';
  import { fixtureContentServiceContext } from './contentService';

  const params = new URLSearchParams(location.search);
  const requestedPage = params.get('page');
  const page =
    requestedPage === 'downloads' || requestedPage === 'artwork' ? requestedPage : 'title';
  const device = params.get('device') ?? 'aaaaaaaaaaaaaaaa';
  const noop = () => {};
  const content = fixtureContentServiceContext();
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
  const legacyRow = (season: number, episode: number): SettingsRow => {
    const at: Stamp = [1, 0, device];
    return {
      kind: 'set',
      schema: 2,
      name: `download:tv:1399:${season}:${episode}`,
      values: {
        release: {
          value: {
            string: JSON.stringify({
              identity: 'episode.mkv',
              label: 'Episode',
              url: '/scout/p/episode',
            }),
          },
          at,
        },
        title: {
          value: {
            string: JSON.stringify({
              mediaType: 'tv',
              mediaId: 1399,
              season,
              episode,
              title: 'Legacy episode',
            }),
          },
          at,
        },
        queuedAt: { value: { int: 1 }, at },
      },
    };
  };
  let artworkRow = legacyRow(2, 4);
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
    refreshIdentity: () => {
      artworkRow = structuredClone(artworkRow);
      held.set(rowName(artworkRow), artworkRow);
      library.publish([{ kind: 'downloads' }]);
    },
    changeEpisode: () => {
      held.delete(rowName(artworkRow));
      artworkRow = legacyRow(3, 1);
      held.set(rowName(artworkRow), artworkRow);
      library.publish([{ kind: 'downloads' }]);
    },
  };

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Replaced whole on each read; the queue's `touch` redraws.
  let held = new Map<string, SettingsRow>(
    page === 'artwork' ? [[rowName(artworkRow), artworkRow]] : [],
  );
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
    pendingActions: 0,
    rows: (): Row[] => [...held.values()],
    settings: (name: string) => held.get(`set:${name}`),
    seqOf: () => 0,
    newestStamp: newest,
    kept: async () => undefined,
    keep: async () => {},
    relayMembership: async () => null,
    async write(row: SettingsRow) {
      const seen = held.get(rowName(row));
      const merged = seen ? syncPolicy<SettingsRow>({ op: 'merge', a: seen, b: row }) : row;
      await fetch('/fixture-store/rows', { method: 'POST', body: JSON.stringify(merged) });
      held.set(rowName(merged), merged);
      return merged;
    },
    async writeAt(row: SettingsRow) {
      await this.write(row);
      return true;
    },
    close() {},
  } as unknown as LibraryLog;
  const loadSeason = async (seriesId: number, season: number) => {
    const result = await content.query({
      kind: 'season',
      title: { type: 'tv', id: seriesId },
      season,
    });
    return result.episodes.state === 'ready' ? result.episodes.value : null;
  };
  const library = fixtureLibraryService({
    log,
    device,
    ...(page === 'artwork' ? { refreshDownloads: async () => false } : {}),
    effects: {
      resolve: async () => ({
        sources: [
          source('first.mkv', '/scout/p/first', 'First release'),
          source('second.mkv', '/scout/p/second', 'Second release'),
        ],
      }),
    },
    downloadArtwork: async (target) =>
      target.type === 'tv'
        ? ((await downloadStill(
            {
              mediaType: 'tv',
              mediaId: target.id,
              season: target.season,
              episode: target.episode,
              title: '',
            },
            loadSeason,
          )) ?? null)
        : null,
  });

  let ready = $state(false);
  onMount(() => {
    if (page === 'artwork') return;
    // What the library's held read does: another device's write shows here within one read.
    const timer = setInterval(
      () => void read().then(() => library.publish([{ kind: 'downloads' }])),
      300,
    );
    void read().then(() => {
      library.publish([{ kind: 'downloads' }]);
      ready = true;
    });
    return () => clearInterval(timer);
  });
</script>

<main style="padding:100px 20px">
  {#if page === 'artwork'}
    {#if artworkActive && artworkMounted}<DownloadsPage model={library.model} />{/if}
  {:else if ready && page === 'downloads'}
    <DownloadsPage model={library.model} />
  {:else if ready}
    <Detail
      {content}
      ref={{ type: 'movie', id: 42 }}
      scout={{ install: 'http://scout.invalid/cfg', base: '/scout/cfg' }}
      routes={{ scout: [{ url: 'http://scout.invalid' }] }}
      row={undefined}
      episodes={new Map()}
      busy={false}
      failure={null}
      notice={null}
      model={library.model}
      onwatchlist={noop}
      onseen={noop}
      onreact={noop}
      onplay={noop}
      onepisode={noop}
    />
  {/if}
</main>
