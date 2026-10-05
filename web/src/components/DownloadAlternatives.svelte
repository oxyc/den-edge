<script lang="ts">
  import type { DownloadQueue } from '../lib/downloadQueue.svelte';
  import type { Download } from '../lib/downloadRows';
  import type { TitleSource } from '../lib/titleSources';

  let { download, queue }: { download: Download; queue: DownloadQueue } = $props();
  let open = $state(false);
  let sources = $state<TitleSource[] | null | undefined>();
  let busy = $state(false);
  let message = $state('');
  const choices = $derived(
    (sources ?? []).filter(
      (source) =>
        source.identity !== download.release.identity &&
        source.identity !== download.release.hedge?.identity,
    ),
  );

  async function show() {
    open = true;
    message = '';
    sources = undefined;
    sources = await queue.alternatives(download);
  }

  async function choose(event: Event) {
    const identity = (event.currentTarget as HTMLSelectElement).value;
    const source = choices.find((candidate) => candidate.identity === identity);
    if (!source) return;
    busy = true;
    const answer = await queue.tryAnother(download, source);
    busy = false;
    if (answer.state === 'preparing' || answer.state === 'ready' || answer.state === 'paused') {
      open = false;
      message = answer.state === 'ready' ? 'That release is ready.' : `Also trying ${source.label}`;
    } else message = answer.message ?? 'Couldn’t start that release.';
  }
</script>

{#if download.release.hedge}
  <p class="hint">Two releases are already being tried.</p>
{:else if !open}
  <button type="button" class="try" onclick={() => void show()}>Try another</button>
{:else if sources === undefined}
  <p class="hint" role="status">Finding releases…</p>
{:else if sources === null}
  <p class="hint" role="status">
    Couldn’t load releases. <button onclick={() => void show()}>Try again</button>
  </p>
{:else if !choices.length}
  <p class="hint" role="status">No other releases are available.</p>
{:else}
  <label>
    <span>Try another release</span>
    <select disabled={busy} onchange={(event) => void choose(event)}>
      <option value="">Choose a release…</option>
      {#each choices as source (source.identity)}
        <option value={source.identity}>{source.label}</option>
      {/each}
    </select>
  </label>
{/if}
{#if message}<p class="hint" role="status">{message}</p>{/if}

<style>
  .try,
  .hint button {
    min-height: 34px;
    border: 1px solid #ffffff24;
    border-radius: 999px;
    padding: 5px 12px;
    background: #ffffff0f;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .hint {
    margin: 3px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .hint button {
    min-height: 0;
    border: 0;
    padding: 0;
    background: none;
    text-decoration: underline;
  }

  label {
    display: grid;
    gap: 5px;
    margin-top: 3px;
    color: var(--muted);
    font-size: 12px;
  }

  select {
    width: 100%;
    min-height: 38px;
    border: 1px solid #ffffff24;
    border-radius: 10px;
    padding: 5px 9px;
    background: var(--panel);
    color: var(--fg);
    font: inherit;
    font-size: 13px;
  }
</style>
