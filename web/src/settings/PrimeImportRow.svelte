<script lang="ts" module>
  import { SvelteSet } from 'svelte/reactivity';
  import type { PrimeImportSource } from '../lib/primeImport';
  import type { PrimeImportPlan } from '../lib/primeImportPlan';
  import type { PlannedHistoryImport } from './historyImport';

  type State =
    | { step: 'idle' }
    | { step: 'matching'; done: number; total: number }
    | {
        step: 'preview';
        source: PrimeImportSource;
        plan: PrimeImportPlan;
        writes: PlannedHistoryImport[];
      }
    | { step: 'writing' }
    | { step: 'done'; written: number }
    | { step: 'failed'; message: string };

  let state = $state<State>({ step: 'idle' });
  const excluded = new SvelteSet<string>();
</script>

<script lang="ts">
  import { parsePrimeFiles } from '../lib/primeImport';
  import { planPrimeImport } from '../lib/primeImportPlan';
  import { contentImportLookups } from '../lib/contentImportLookups';
  import type { ContentServiceClientPort } from '../lib/libraryServiceFactory';
  import { viewingPreviewLines } from '../lib/viewingImport';
  import SettingRow from './SettingRow.svelte';
  import { historyImportItems } from './historyImport';
  import type { HistoryImportItem, TitleRef } from '../lib/libraryServiceProtocol';

  let {
    ready,
    content,
    watched,
    importHistory,
  }: {
    ready: boolean;
    content: ContentServiceClientPort;
    watched: readonly TitleRef[];
    importHistory: (
      items: readonly HistoryImportItem[],
    ) => Promise<{ written: number; total: number; complete: boolean }>;
  } = $props();

  async function read(files: readonly File[]) {
    if (!ready) return;
    excluded.clear();
    try {
      const source = parsePrimeFiles(
        await Promise.all(
          [...files].map(async (file) => ({ name: file.name, text: await file.text() })),
        ),
      );
      state = { step: 'matching', done: 0, total: source.viewings.length };
      const watchedKeys = new Set(watched.map((ref) => `${ref.type}:${ref.id}`));
      const seen = (ref: { type: string; id: number }) => watchedKeys.has(`${ref.type}:${ref.id}`);
      const lookups = contentImportLookups(content);
      const plan = await planPrimeImport(
        source.viewings,
        lookups,
        (done, total) => {
          if (state.step === 'matching') state = { ...state, done, total };
        },
        seen,
      );
      state = {
        step: 'preview',
        source,
        plan,
        writes: historyImportItems(plan.marks, plan.shows),
      };
    } catch (error) {
      console.warn('den: Prime Video import failed', error);
      state = {
        step: 'failed',
        message:
          error instanceof Error ? error.message : 'Couldn’t read that history. Please try again.',
      };
    }
  }

  async function write(writes: PlannedHistoryImport[]) {
    state = { step: 'writing' };
    const result = await importHistory(writes.map((entry) => entry.item));
    state = result.complete
      ? { step: 'done', written: result.written }
      : {
          step: 'failed',
          message: `Saved ${result.written.toLocaleString()} of ${result.total.toLocaleString()}. Importing both files again picks up where this stopped.`,
        };
  }

  const plural = (count: number, one: string, many = `${one}s`) =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;
</script>

<SettingRow
  id="prime-video-import"
  label="Prime Video viewing history"
  detail="Mark played films and episodes as seen"
>
  <p class="foot">
    From your Amazon privacy-data download, choose <em>Watch Events.csv</em> and
    <em>Viewing History.csv</em> together. The files are matched in this browser; location and device
    details are discarded. Amazon does not identify named profiles in this export, so it imports the account’s
    combined history.
  </p>
  {#if state.step === 'idle' || state.step === 'failed' || state.step === 'done'}
    <div class="form">
      <label class="quiet file">
        Choose both files…
        <input
          type="file"
          accept=".csv,text/csv"
          multiple
          disabled={!ready}
          onchange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            if (files.length) void read(files);
          }}
        />
      </label>
    </div>
  {/if}
  {#if state.step === 'matching'}
    <p class="status" role="status">
      Finding titles — {state.done.toLocaleString()} of {state.total.toLocaleString()}
    </p>
  {:else if state.step === 'preview'}
    {@const all = viewingPreviewLines(state.plan.marks)}
    {@const chosen = state.writes.filter((entry) => !excluded.has(entry.key))}
    {@const series = all.filter((line) => line.episodes > 0)}
    {@const sourceMisses =
      state.source.diagnostics.unmatched.length + state.source.diagnostics.ambiguous.length}
    {@const matchMisses = state.plan.unmatched.length + state.plan.ambiguous.length}
    <p class="summary">
      Found {plural(all.length - series.length, 'film')} and {plural(
        series.reduce((count, line) => count + line.episodes, 0),
        'episode',
      )} from {plural(series.length, 'series', 'series')}.
      {#if state.plan.known}{plural(state.plan.known, 'line')} already seen were skipped.{/if}
    </p>
    <details class="foot">
      <summary>Review what was found</summary>
      <ul class="found">
        {#each all as line (line.key)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={!excluded.has(line.key)}
                onchange={(event) => {
                  if (event.currentTarget.checked) excluded.delete(line.key);
                  else excluded.add(line.key);
                }}
              />
              <span
                >{line.label}{#if line.episodes}
                  · {plural(line.episodes, 'episode')}{/if}</span
              >
            </label>
          </li>
        {/each}
      </ul>
    </details>
    {#if sourceMisses || matchMisses}
      <details class="foot">
        <summary>{plural(sourceMisses + matchMisses, 'line')} couldn’t be matched safely</summary>
        <ul class="unmatched">
          {#each [...state.source.diagnostics.unmatched, ...state.source.diagnostics.ambiguous, ...state.plan.unmatched, ...state.plan.ambiguous] as title, at (`${title}:${at}`)}<li
            >
              {title}
            </li>{/each}
        </ul>
      </details>
    {/if}
    <div class="form">
      <button
        type="button"
        class="primary"
        disabled={!chosen.length}
        onclick={() => void write(chosen)}
      >
        Import viewing history
      </button>
      <button type="button" class="quiet" onclick={() => (state = { step: 'idle' })}>Cancel</button>
    </div>
  {:else if state.step === 'writing'}
    <p class="status" role="status">Saving…</p>
  {:else if state.step === 'done'}
    <p class="status" role="status">
      Saved {plural(state.written, 'change')}. Your Apple TV sends them to Simkl next time Den is
      open on it.
    </p>
  {:else if state.step === 'failed'}
    <p class="status bad" role="alert">{state.message}</p>
  {/if}
</SettingRow>

<style>
  .file {
    display: inline-flex;
    align-items: center;
  }

  .file input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }

  .file:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .found,
  .unmatched {
    max-height: 320px;
    overflow: auto;
    margin: 8px 0 0;
  }

  .found {
    padding: 0;
    list-style: none;
  }

  .found label {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 4px 0;
    color: var(--fg);
    cursor: pointer;
  }

  .unmatched {
    padding-left: 18px;
  }
</style>
