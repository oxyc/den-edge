<script lang="ts">
  // The shared download queue (den-spec library-v4 §17) on a library whose rows live in a store the test holds,
  // reached at `/fixture-store/rows`: every page and every browser context reads the same rows, as every device
  // reads den-edge. `?page=title` is a title's Sources; `?page=downloads` the Downloads page. `?device=` names the
  // device, and `?device=` other than this one is how a test is "another device".
  import { onMount } from 'svelte';
  import Detail from '../src/components/Detail.svelte';
  import DownloadsPage from '../src/components/DownloadsPage.svelte';
  import '../src/app.css';
  import { downloads } from '../src/lib/downloadQueue.svelte';
  import type { LibraryLog } from '../src/lib/log';
  import { syncPolicy } from '../src/lib/syncCore';
  import { rowName, type Row, type SettingsRow, type Stamp } from '../src/lib/wire';

  const params = new URLSearchParams(location.search);
  const page = params.get('page') === 'downloads' ? 'downloads' : 'title';
  const device = params.get('device') ?? 'aaaaaaaaaaaaaaaa';
  const noop = () => {};

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
    // What the library's held read does: another device's write shows here within one read.
    const timer = setInterval(() => void read().then(() => downloads.touch()), 300);
    void read().then(() => {
      downloads.attach(log, clock, (url) => (url.startsWith('/scout/') ? url : null));
      ready = true;
    });
    return () => clearInterval(timer);
  });
</script>

<main style="padding:100px 20px">
  {#if ready && page === 'downloads'}
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
