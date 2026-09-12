<script lang="ts">
  import { tick } from 'svelte';
  import Loading from './Loading.svelte';
  import DetailIcon from './DetailIcon.svelte';
  import { downloads } from '../lib/downloadQueue.svelte';
  import { fetchSources, type TitleSource } from '../lib/titleSources';
  import type { Addon } from '../lib/scout';
  import type { Routes } from '../lib/routes';
  let { imdb, scout, routes, season, episode, active, onplay, onplaytv }: {
    imdb?: string; scout: Addon | null; routes: Routes; season?: number; episode?: number; active: boolean;
    onplay?: (filename: string) => void; onplaytv: () => void;
  } = $props();
  let sources = $state<TitleSource[] | null | undefined>();
  let open = $state(false), retry = $state(0);
  let panel = $state<HTMLDivElement>();
  const panelId = $props.id();
  const key = (source: TitleSource) => `${scout?.install}:${imdb}:${season}:${episode}:${source.filename}`;
  const best = $derived(sources?.find((s) => s.cached === true) ?? sources?.find((s) => s.seeders !== 0) ?? sources?.[0]);
  const jobState = (source: TitleSource) => downloads.states.get(key(source));
  $effect(() => {
    const [addon, id, table, s, e] = [scout, imdb, routes, season, episode]; void retry;
    sources = undefined;
    if (!addon || !id) return;
    const controller = new AbortController();
    void fetchSources(addon, id, table, s, e, controller.signal).then((loaded) => { if (!controller.signal.aborted) sources = loaded; });
    return () => controller.abort();
  });
  $effect(() => {
    if (!active || !sources) return;
    const pending = sources.filter((source) => ['preparing', 'unknown'].includes(jobState(source)?.state ?? ''));
    if (!pending.length) return;
    const timer = setTimeout(() => { for (const source of pending) void downloads.poll(key(source), source); }, 5000);
    return () => clearTimeout(timer);
  });
  export async function show() { open = true; await tick(); panel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  const size = (bytes?: number) => bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '';
</script>

<div class="source-controls">
  <button class="control" aria-expanded={open} aria-controls={panelId} onclick={() => open = !open}><DetailIcon name="sources" />Sources{sources ? ` (${sources.length})` : ''}</button>
  {#if best && best.cached === false && best.seeders !== 0}
    <button class="control" disabled={!!jobState(best) && !['failed', 'not-queued'].includes(jobState(best)!.state)} onclick={() => void downloads.start(key(best), best!)}>
      <DetailIcon name="download" />{jobState(best)?.state === 'ready' ? 'Ready to play' : jobState(best)?.state === 'preparing' ? 'Downloading' : jobState(best)?.state === 'unknown' ? 'Checking download' : 'Download'}
    </button>
  {/if}
</div>
{#if best?.cached === false && !jobState(best)}<p class="readiness">This {season === undefined ? 'movie' : 'episode'} needs a download before it’s ready to play here.</p>{/if}
{#if open}
  <div id={panelId} bind:this={panel} class="source-panel">
    {#if season !== undefined}<p class="note">Sources for S{season} · E{episode}</p>{/if}
    <button class="text-button" onclick={onplaytv}>Play on TV</button>
    {#if !scout}<p class="note">Add Den Scout in <a href="#settings">Settings</a> to browse sources.</p>
    {:else if !imdb}<p class="note">TMDB has no IMDb record for this title, so sources can’t be matched yet.</p>
    {:else if sources === undefined}<Loading label="Loading sources" />
    {:else if sources === null}<p class="note">Couldn’t reach the source service.</p><button class="control" onclick={() => retry++}>Try again</button>
    {:else if sources.length === 0}<p class="note">No sources found for this {season === undefined ? 'movie' : 'episode'}.</p>
    {:else}
      <ul>
        {#each sources as source (source.filename)}
          {@const job = jobState(source)}
          {@const ready = source.cached === true || job?.state === 'ready'}
          <li>
            <div class="source-copy"><strong>{source.filename}</strong>
              <p class="badges">{[...source.badges, size(source.size)].filter(Boolean).join(' · ')}</p>
              {#if source.probed && source.languages.length}<p class="languages">Audio: {source.languages.join(', ')}</p>{/if}
              <p class="status" class:ready>{ready ? 'Ready to play' : job?.state === 'preparing' ? `Downloading${job.progress !== undefined ? ` · ${Math.round(job.progress * 100)}%` : ''}`
                : job?.message ?? (source.cached === false ? source.seeders === 0 ? 'No seeders' : 'Download needed' : 'Availability unknown')}</p>
              {#if job?.state === 'preparing' && job.progress !== undefined}<progress value={job.progress} max="1" aria-label="Download progress"></progress>{/if}
            </div>
            <div class="source-actions">
              {#if ready && onplay}<button class="control" onclick={() => onplay(source.filename)}><DetailIcon name="play" />Play</button>
              {:else if !ready}<button class="control" disabled={job?.state === 'preparing' || job?.state === 'unknown'} onclick={() => void downloads.start(key(source), source)}><DetailIcon name="download" />{source.seeders === 0 ? 'Download anyway' : 'Download'}</button>{/if}

              {#if job?.state === 'unknown'}<button class="text-button" onclick={() => void downloads.poll(key(source), source)}>Check status</button>{/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .source-controls { display:flex; flex-wrap:wrap; gap:12px; min-height:48px; }
  .control { display:inline-flex; align-items:center; justify-content:center; gap:10px; min-height:44px; padding:8px 18px;
    border:1px solid #ffffff24; border-radius:12px; background:#ffffff15; color:var(--fg); cursor:pointer; }
  .control:disabled { opacity:.5; cursor:default; }
  .control:focus-visible, .text-button:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  .source-panel { max-width:1100px; margin:16px 0 24px; scroll-margin-top:var(--bar-space); }
  .readiness, .note { color:var(--muted); font-size:14px; }
  a { color:var(--accent); }
  ul { list-style:none; padding:0; margin:0; }
  li { display:flex; gap:24px; justify-content:space-between; align-items:center; padding:20px 0; border-bottom:1px solid var(--line); }
  .source-copy { min-width:0; } strong { overflow-wrap:anywhere; font-size:15px; }
  .badges, .languages { font-size:13px; color:var(--muted); margin:8px 0; }
  .status { font-size:13px; color:#ffc177; margin:8px 0 0; } .status.ready { color:#86d7a2; }
  .source-actions { display:flex; flex-direction:column; gap:8px; flex:none; }
  .text-button { min-height:36px; border:0; background:none; color:var(--muted); cursor:pointer; }
  progress { margin-top:10px; width:200px; max-width:100%; height:4px; }
  @media(max-width:759px) { li { flex-direction:column; align-items:stretch; gap:12px; } .source-actions { flex-direction:row; flex-wrap:wrap; } .control { font-size:14px; border-radius:999px; padding-inline:14px; } }
</style>
