<script lang="ts">
  import type { LibraryModel } from '../lib/libraryModel.svelte';
  import type {
    DownloadReleaseOption,
    DownloadTitleDescriptor,
    DownloadViewItem,
  } from '../lib/libraryServiceProtocol';

  let {
    download,
    title,
    model,
  }: { download: DownloadViewItem; title: DownloadTitleDescriptor; model: LibraryModel } = $props();
  let open = $state(false);
  let sources = $state<DownloadReleaseOption[] | null | undefined>();
  let busy = $state(false);
  let message = $state('');
  const choices = $derived(
    (sources ?? []).filter(
      (source) =>
        source.identity !== download.release.identity &&
        source.identity !== download.alternate?.identity,
    ),
  );

  async function show() {
    open = true;
    message = '';
    sources = undefined;
    const response = await model.downloadReleases(title);
    sources = response.result.kind === 'download.releases' ? response.result.releases : null;
  }

  async function choose(event: Event) {
    const identity = (event.currentTarget as HTMLSelectElement).value;
    const source = choices.find((candidate) => candidate.identity === identity);
    if (!source) return;
    busy = true;
    await model.tryDownloadRelease(title.target, source.identity);
    busy = false;
    open = false;
    message = `Also trying ${source.label}`;
  }
</script>

{#if download.alternate}
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
