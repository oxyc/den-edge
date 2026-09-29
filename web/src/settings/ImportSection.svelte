<!-- Settings › Import: a Netflix viewing history (Account › Profile › Viewing activity › Download all) marked seen,
     each film and episode at the day it was last watched. Read and matched in this browser; written as the same
     tracker events the web's own "Seen" writes, so the Apple TV passes them to Simkl in its own time. -->
<script lang="ts">
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import type { LibraryLog } from '../lib/log';
  import { parseCsv, plan, type Plan } from '../lib/netflixImport';
  import { importJournals } from '../lib/netflixJournal';
  import { netflixLookups } from '../lib/netflixLookups';
  import { ensureSyncPolicy } from '../lib/syncLoader';
  import type { SettingsRow } from '../lib/wire';

  let {
    log,
    device,
    tmdbKey,
    changed,
  }: { log: LibraryLog | null | undefined; device: string; tmdbKey: string; changed: () => void } =
    $props();

  /** Journals are kept in this browser's storage until sent; a batch at a time stays well inside its quota. */
  const BATCH = 250;

  type State =
    | { step: 'idle' }
    | { step: 'matching'; done: number; total: number }
    | { step: 'preview'; plan: Plan; journals: SettingsRow[] }
    | { step: 'writing'; done: number; total: number }
    | { step: 'done'; written: number }
    | { step: 'failed'; message: string };
  let state = $state<State>({ step: 'idle' });

  async function read(file: File) {
    if (!log) return;
    const viewings = parseCsv(await file.text());
    if (!viewings.length) {
      state = { step: 'failed', message: 'That file has no viewing history in it.' };
      return;
    }
    state = { step: 'matching', done: 0, total: 0 };
    try {
      const result = await plan(viewings, netflixLookups(tmdbKey), (done, total) => {
        state = { step: 'matching', done, total };
      });
      await ensureSyncPolicy();
      state = {
        step: 'preview',
        plan: result,
        journals: importJournals(result.marks, log, device),
      };
    } catch (error) {
      console.warn('den: Netflix import failed', error);
      state = { step: 'failed', message: 'Couldn’t read that history. Please try again.' };
    }
  }

  async function write(journals: SettingsRow[]) {
    if (!log) return;
    state = { step: 'writing', done: 0, total: journals.length };
    for (let start = 0; start < journals.length; start += BATCH) {
      const batch = journals.slice(start, start + BATCH);
      if (!(await log.writeActions(batch))) {
        state = {
          step: 'failed',
          message: `Saved ${start} of ${journals.length}. The rest couldn’t be saved; importing the file again picks up where this stopped.`,
        };
        changed();
        return;
      }
      state = { step: 'writing', done: start + batch.length, total: journals.length };
    }
    changed();
    state = { step: 'done', written: journals.length };
  }

  const counts = (p: Plan) => {
    const films = p.marks.filter((m) => m.type === 'movie').length;
    const episodes = p.marks.length - films;
    const series = new Set(p.marks.filter((m) => m.type === 'tv').map((m) => m.id)).size;
    return { films, episodes, series };
  };
  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`;
</script>

<SettingsSection id="import" title="Import">
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
    {:else if state.step === 'preview'}
      {@const found = counts(state.plan)}
      {@const journals = state.journals}
      <p class="summary">
        Found {plural(found.films, 'film')} and {plural(found.episodes, 'episode')} from {plural(
          found.series,
          'series',
          'series',
        )}.
        {#if found.films + found.episodes > journals.length}
          {(found.films + found.episodes - journals.length).toLocaleString()} are already marked, or were
          changed later here.
        {/if}
      </p>
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
          disabled={!journals.length}
          onclick={() => void write(journals)}
        >
          Mark {journals.length.toLocaleString()} as seen
        </button>
        <button type="button" class="quiet" onclick={() => (state = { step: 'idle' })}
          >Cancel</button
        >
      </div>
    {:else if state.step === 'writing'}
      <p class="status" role="status">Saving — {state.done} of {state.total}</p>
    {:else if state.step === 'done'}
      <p class="status" role="status">
        Marked {plural(state.written, 'film and episode', 'films and episodes')} as seen. Your Apple TV
        sends them to Simkl next time it’s on.
      </p>
    {:else if state.step === 'failed'}
      <p class="status bad" role="alert">{state.message}</p>
    {/if}
  </SettingRow>
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

  .unmatched {
    max-height: 240px;
    overflow: auto;
    margin: 8px 0 0;
    padding-left: 18px;
  }
</style>
