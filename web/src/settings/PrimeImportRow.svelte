<script lang="ts" module>
  import type { PrimeImportSource } from '../lib/primeImport';
  import type { PrimeImportPlan } from '../lib/primeImportPlan';
  import type { PlannedHistoryImport } from './historyImport';
  import { scopedImportSessions } from './importSession.svelte';

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
    | {
        step: 'failed';
        message: string;
        retry?: { writes: PlannedHistoryImport[]; operationId: string };
      };
  const sessionFor = scopedImportSessions<State>({ step: 'idle' });
</script>

<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import Button from '../components/Button.svelte';
  import { parsePrimeFiles } from '../lib/primeImport';
  import { planPrimeImport } from '../lib/primeImportPlan';
  import { contentImportLookups } from '../lib/contentImportLookups';
  import type { ContentServiceClientPort } from '../lib/contentServiceClient';
  import { viewingPreviewLines } from '../lib/viewingImport';
  import SettingRow from './SettingRow.svelte';
  import { historyImportItems } from './historyImport';
  import { saveHistoryImport } from './importSession.svelte';
  import type { HistoryImportItem, TitleRef } from '../lib/libraryServiceProtocol';

  let {
    ready,
    scope,
    content,
    watched,
    importHistory,
  }: {
    ready: boolean;
    /** The active activity-library model; retained work is owned by this identity. */
    scope: object;
    content: ContentServiceClientPort;
    watched: readonly TitleRef[];
    importHistory: (
      items: readonly HistoryImportItem[],
      operationId: string,
    ) => Promise<{ written: number; total: number; complete: boolean }>;
  } = $props();

  const session = $derived(sessionFor(scope));

  async function read(files: readonly File[]) {
    if (!ready) return;
    const owned = session;
    owned.excluded.clear();
    try {
      const source = parsePrimeFiles(
        await Promise.all(
          [...files].map(async (file) => ({ name: file.name, text: await file.text() })),
        ),
      );
      owned.state = { step: 'matching', done: 0, total: source.viewings.length };
      const watchedKeys = new Set(watched.map((ref) => `${ref.type}:${ref.id}`));
      const seen = (ref: { type: string; id: number }) => watchedKeys.has(`${ref.type}:${ref.id}`);
      const lookups = contentImportLookups(content);
      const plan = await planPrimeImport(
        source.viewings,
        lookups,
        (done, total) => {
          if (owned.state.step === 'matching') owned.state = { ...owned.state, done, total };
        },
        seen,
      );
      owned.state = {
        step: 'preview',
        source,
        plan,
        writes: historyImportItems(plan.marks, plan.shows),
      };
    } catch (error) {
      console.warn('den: Prime Video import failed', error);
      owned.state = {
        step: 'failed',
        message:
          error instanceof Error ? error.message : 'Couldn’t read that history. Please try again.',
      };
    }
  }

  async function write(writes: PlannedHistoryImport[], operationId: string = crypto.randomUUID()) {
    const owned = session;
    owned.state = { step: 'writing' };
    owned.state = await saveHistoryImport(importHistory, writes, operationId, (written, total) =>
      i18n.format(
        'import.savedPrime',
        'Saved {written} of {total}. Importing both files again picks up where this stopped.',
        { written: written.toLocaleString(), total: total.toLocaleString() },
      ),
    );
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
  {#if session.state.step === 'idle' || session.state.step === 'failed' || session.state.step === 'done'}
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
  {#if session.state.step === 'matching'}
    <p class="status" role="status">
      Finding titles — {session.state.done.toLocaleString()} of {session.state.total.toLocaleString()}
    </p>
  {:else if session.state.step === 'preview'}
    {@const all = viewingPreviewLines(session.state.plan.marks)}
    {@const chosen = session.state.writes.filter((entry) => !session.excluded.has(entry.key))}
    {@const series = all.filter((line) => line.episodes > 0)}
    {@const sourceMisses =
      session.state.source.diagnostics.unmatched.length +
      session.state.source.diagnostics.ambiguous.length}
    {@const matchMisses = session.state.plan.unmatched.length + session.state.plan.ambiguous.length}
    <p class="summary">
      Found {plural(all.length - series.length, 'film')} and {plural(
        series.reduce((count, line) => count + line.episodes, 0),
        'episode',
      )} from {plural(series.length, 'series', 'series')}.
      {#if session.state.plan.known}{plural(session.state.plan.known, 'line')} already seen were skipped.{/if}
    </p>
    <details class="foot">
      <summary>Review what was found</summary>
      <ul class="found">
        {#each all as line (line.key)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={!session.excluded.has(line.key)}
                onchange={(event) => {
                  if (event.currentTarget.checked) session.excluded.delete(line.key);
                  else session.excluded.add(line.key);
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
          {#each [...session.state.source.diagnostics.unmatched, ...session.state.source.diagnostics.ambiguous, ...session.state.plan.unmatched, ...session.state.plan.ambiguous] as title, at (`${title}:${at}`)}<li
            >
              {title}
            </li>{/each}
        </ul>
      </details>
    {/if}
    <div class="form">
      <Button
        variant="primary"
        label="Import viewing history"
        disabled={!chosen.length}
        onclick={() => void write(chosen)}
      />
      <Button
        variant="secondary"
        label="Cancel"
        onclick={() => (session.state = { step: 'idle' })}
      />
    </div>
  {:else if session.state.step === 'writing'}
    <p class="status" role="status">Saving…</p>
  {:else if session.state.step === 'done'}
    <p class="status" role="status">
      Saved {plural(session.state.written, 'change')}. Your Apple TV sends them to Simkl next time
      Den is open on it.
    </p>
  {:else if session.state.step === 'failed'}
    <p class="status bad" role="alert">{i18n.phrase(session.state.message)}</p>
    {@const retry = session.state.retry}
    {#if retry}
      <Button
        variant="secondary"
        label="Try again"
        onclick={() => void write(retry.writes, retry.operationId)}
      />
    {/if}
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
    outline: var(--ring-width) solid var(--focus-ring);
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
