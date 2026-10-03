<!-- Settings › Import & export: a Netflix viewing history (Account › Profile › Viewing activity › Download all) marked seen,
     each film and episode at the day it was last watched. Read and matched in this browser; written as the library's
     own rows (`viewingImportJournal`), which the Apple TV's catch-up passes to Simkl in its own time, each at its date. -->
<script lang="ts" module>
  import { SvelteSet } from 'svelte/reactivity';
  import type { Plan } from '../lib/netflixImport';
  import type { ImportWrites } from '../lib/viewingImportJournal';

  type State =
    | { step: 'idle' }
    | { step: 'matching'; done: number; total: number; paused?: boolean }
    | { step: 'preview'; plan: Plan; writes: ImportWrites[] }
    | { step: 'writing'; done: number; total: number }
    | { step: 'done'; written: number }
    | { step: 'failed'; message: string };
  /** Kept with the module, not the section: matching a long history goes on while the viewer is elsewhere. */
  let state = $state<State>({ step: 'idle' });
  /** The films and series (`importKey`) the viewer unticked in the preview. */
  const excluded = new SvelteSet<string>();
</script>

<script lang="ts">
  import SettingRow from './SettingRow.svelte';
  import PrimeImportRow from './PrimeImportRow.svelte';
  import HistoryExportRow from './HistoryExportRow.svelte';
  import type { Title } from '../lib/library';
  import SettingsSection from './SettingsSection.svelte';
  import type { LibraryLog } from '../lib/log';
  import { parseCsv, plan, previewLines } from '../lib/netflixImport';
  import { importWrites, writeImportBatches } from '../lib/viewingImportJournal';
  import { viewingImportLookups } from '../lib/viewingImportLookups';
  import { ensureSyncPolicy } from '../lib/syncLoader';

  let {
    log,
    device,
    tmdbKey,
    changed,
    displays,
  }: {
    log: LibraryLog | null | undefined;
    device: string;
    tmdbKey: string;
    changed: () => void;
    /** The titles the page has named, which the history export reuses. */
    displays: readonly Title[];
  } = $props();

  async function read(file: File) {
    const opened = log;
    if (!opened) return;
    const viewings = parseCsv(await file.text());
    if (!viewings.length) {
      state = { step: 'failed', message: 'That file has no viewing history in it.' };
      return;
    }
    state = { step: 'matching', done: 0, total: 0 };
    excluded.clear();
    try {
      // What the library already has as seen is found, and left: its episodes aren't looked up at all.
      const seen = (ref: { type: string; id: number }) => {
        const row = opened.title(ref);
        return !!row && !row.deleted.value && row.status.value === 'watched';
      };
      const lookups = viewingImportLookups(tmdbKey, undefined, (ms) => {
        if (state.step === 'matching') state = { ...state, paused: ms > 0 };
      });
      const result = await plan(
        viewings,
        lookups,
        (done, total) => {
          if (state.step === 'matching') state = { ...state, done, total };
        },
        seen,
      );
      await ensureSyncPolicy();
      state = {
        step: 'preview',
        plan: result,
        writes: importWrites(result.marks, result.shows, opened, device, Date.now()),
      };
    } catch (error) {
      console.warn('den: Netflix import failed', error);
      state = { step: 'failed', message: 'Couldn’t read that history. Please try again.' };
    }
  }

  async function write(writes: ImportWrites[]) {
    const opened = log;
    if (!opened) return;
    const total = writes.reduce((count, entry) => count + entry.rows.length, 0);
    state = { step: 'writing', done: 0, total };
    const result = await writeImportBatches(writes, opened, (done, all) => {
      state = { step: 'writing', done, total: all };
    });
    changed();
    state = result.complete
      ? { step: 'done', written: result.written }
      : {
          step: 'failed',
          message:
            result.refusal === 'library_full'
              ? `Saved ${result.written.toLocaleString()} of ${result.total.toLocaleString()}: the library on den-edge is full. Nothing already saved is lost.`
              : `Saved ${result.written.toLocaleString()} of ${result.total.toLocaleString()}. The rest couldn’t be saved; importing the file again picks up where this stopped.`,
        };
  }

  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`;
</script>

<SettingsSection id="import" title="Import & export">
  <SettingRow
    id="netflix-import"
    label="Netflix viewing history"
    detail="Mark everything you watched on Netflix as seen"
  >
    <p class="foot">
      On netflix.com, open Account › your profile › Viewing activity, and choose <em
        >Download all</em
      >. Each film and episode is marked seen on the day you last watched it, and reaches Simkl
      through your Apple TV.
    </p>
    {#if state.step === 'idle' || state.step === 'failed' || state.step === 'done'}
      <div class="form">
        <label class="quiet file">
          Choose file…
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={!log}
            onchange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void read(file);
            }}
          />
        </label>
      </div>
    {/if}
    {#if state.step === 'matching'}
      <p class="status" role="status">
        Finding your titles{state.total ? ` — ${state.done} of ${state.total}` : '…'}
      </p>
      {#if state.paused}
        <p class="foot">Pausing for den-edge’s per-minute limit — carrying on shortly.</p>
      {/if}
    {:else if state.step === 'preview'}
      {@const all = previewLines(state.plan.marks)}
      {@const chosen = state.writes.filter((w) => !excluded.has(w.key))}
      {@const series = all.filter((l) => l.episodes > 0)}
      <p class="summary">
        Found {plural(all.length - series.length, 'film')} and {plural(
          series.reduce((n, l) => n + l.episodes, 0),
          'episode',
        )} from {plural(series.length, 'series', 'series')}.
        {#if state.plan.known}
          {plural(state.plan.known, 'line')} of what you’ve already marked seen were skipped.
        {/if}
        {#if state.plan.covered}
          {plural(state.plan.covered, 'line')} named an episode of a season the rest of the file already
          covers in full.
        {/if}
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
                <span>
                  {line.label}{#if line.episodes}
                    · {plural(line.episodes, 'episode')}{/if}
                  {#if line.source}<small>Netflix: {line.source}</small>{/if}
                </span>
              </label>
            </li>
          {/each}
        </ul>
      </details>
      {#if state.plan.unmatched.length || state.plan.undated}
        <details class="foot">
          <summary>
            {plural(state.plan.unmatched.length + state.plan.undated, 'line')} couldn’t be matched
          </summary>
          <ul class="unmatched">
            {#each state.plan.unmatched as title (title)}<li>{title}</li>{/each}
          </ul>
        </details>
      {/if}
      <div class="form">
        <button
          type="button"
          class="primary"
          disabled={!chosen.some((w) => w.rows.length)}
          onclick={() => void write(chosen)}
        >
          Mark {plural(
            chosen.filter((w) =>
              w.rows.some(
                (row) =>
                  row.kind === 'ep' || (row.kind === 'rec' && row.status.value === 'watched'),
              ),
            ).length,
            'film or series',
            'films and series',
          )} as seen
        </button>
        <button type="button" class="quiet" onclick={() => (state = { step: 'idle' })}
          >Cancel</button
        >
      </div>
    {:else if state.step === 'writing'}
      <p class="status" role="status">Saving — {state.done} of {state.total}</p>
    {:else if state.step === 'done'}
      <p class="status" role="status">
        Saved {plural(state.written, 'change')}. Your Apple TV sends them to Simkl next time Den is
        open on it.
      </p>
    {:else if state.step === 'failed'}
      <p class="status bad" role="alert">{state.message}</p>
    {/if}
  </SettingRow>
  <PrimeImportRow {log} {device} {tmdbKey} {changed} />
  <HistoryExportRow {log} {tmdbKey} {displays} />
</SettingsSection>

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

  .found small {
    display: block;
    color: var(--muted);
  }

  .unmatched {
    padding-left: 18px;
  }
</style>
