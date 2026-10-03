<!-- Settings › Import & export › Download watch history: the library's history as a CSV (one line per viewing) or a
     JSON (every title, its state and viewings), built in this browser from the decrypted library (`historyExport`).
     Titles are named from TMDB as the rest of the page names them; the library itself never leaves the browser. -->
<script lang="ts">
  import SettingRow from './SettingRow.svelte';
  import { buildHistoryExport, historyCsv, letterboxdCsv } from '../lib/historyExport';
  import { titleKey, type Title } from '../lib/library';
  import type { LibraryLog } from '../lib/log';
  import { ensureSyncPolicy } from '../lib/syncLoader';
  import { fetchTitle } from '../lib/tmdb';

  let {
    log,
    tmdbKey,
    displays,
  }: { log: LibraryLog | null | undefined; tmdbKey: string; displays: readonly Title[] } = $props();

  type State =
    { step: 'idle' } | { step: 'naming'; done: number; total: number } | { step: 'failed' };
  let state = $state<State>({ step: 'idle' });

  /** Every title's TMDB name and IMDb id: what the page already named, the rest asked for, six at a time. */
  async function names(refs: { type: 'movie' | 'tv'; id: number }[]): Promise<Map<string, Title>> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local to one export; nothing renders from it.
    const found = new Map(
      displays.filter((title) => title.imdbId).map((title) => [titleKey(title), title] as const),
    );
    const queue = refs.filter((ref) => !found.has(titleKey(ref)));
    const total = queue.length;
    let done = 0;
    state = { step: 'naming', done, total };
    const worker = async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        const title = await fetchTitle(ref, tmdbKey);
        if (title) found.set(titleKey(ref), title);
        state = { step: 'naming', done: ++done, total };
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return found;
  }

  function save(name: string, type: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function download(as: 'csv' | 'letterboxd' | 'json') {
    const opened = log;
    if (!opened) return;
    try {
      await ensureSyncPolicy();
      const documents = opened
        .documents()
        .map(({ document }) => document)
        .filter((document) => document.kind !== 'delivery');
      // Only what the export holds is named: not a title removed from the library, nor one holding nothing.
      const refs = buildHistoryExport(documents, new Map()).titles.map(({ type, tmdbId }) => ({
        type,
        id: tmdbId,
      }));
      const history = buildHistoryExport(documents, await names(refs));
      const day = history.exportedAt.slice(0, 10);
      if (as === 'csv') save(`den-history-${day}.csv`, 'text/csv', historyCsv(history));
      else if (as === 'letterboxd')
        save(`den-letterboxd-${day}.csv`, 'text/csv', letterboxdCsv(history));
      else
        save(
          `den-history-${day}.json`,
          'application/json',
          `${JSON.stringify(history, null, 2)}\n`,
        );
      state = { step: 'idle' };
    } catch (error) {
      console.warn('den: history export failed', error);
      state = { step: 'failed' };
    }
  }
</script>

<SettingRow
  id="history-export"
  label="Download watch history"
  detail="Everything you’ve watched, rated or saved, as CSV or JSON"
>
  <p class="foot">
    The CSV has a line for each time you watched a film or episode, then one for each title you
    saved, started or rated without watching, with its TMDB and IMDb ids. The JSON holds the same,
    title by title. <em>Letterboxd (films)</em> is your films in Letterboxd’s import format, each viewing
    a diary entry. All are made in this browser.
  </p>
  <div class="form">
    <button
      type="button"
      class="primary"
      disabled={!log || state.step === 'naming'}
      onclick={() => void download('csv')}>Download CSV</button
    >
    <button
      type="button"
      class="quiet"
      disabled={!log || state.step === 'naming'}
      onclick={() => void download('json')}>Download JSON</button
    >
    <button
      type="button"
      class="quiet"
      disabled={!log || state.step === 'naming'}
      onclick={() => void download('letterboxd')}>Letterboxd (films)</button
    >
  </div>
  {#if state.step === 'naming'}
    <p class="status" role="status">
      Naming your titles{state.total ? ` — ${state.done} of ${state.total}` : '…'}
    </p>
  {:else if state.step === 'failed'}
    <p class="status bad" role="alert">Couldn’t make the file. Please try again.</p>
  {/if}
</SettingRow>
