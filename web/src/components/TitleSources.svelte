<script lang="ts">
  import { tick } from 'svelte';
  import Loading from './Loading.svelte';
  import DetailIcon from './DetailIcon.svelte';
  import { downloads, pollDelay } from '../lib/downloadQueue.svelte';
  import { ageOf, fetchSourceList, type SourceAnswer, type TitleSource } from '../lib/titleSources';
  import { playable } from '../lib/playable';
  import { listReleases, videoCodecsOf } from '../lib/remux';
  import { unplayable } from '../lib/releaseVerdicts';
  import type { Addon } from '../lib/scout';
  import type { Routes } from '../lib/routes';
  let {
    imdb,
    scout,
    routes,
    season,
    episode,
    active,
    remux = null,
    onplay,
  }: {
    imdb?: string;
    scout: Addon | null;
    routes: Routes;
    season?: number;
    episode?: number;
    active: boolean;
    /** Where den-remux answers (`findRemux`), asked which releases play in this browser. */
    remux?: string | null;
    onplay?: (filename: string) => void;
  } = $props();
  let sources = $state<TitleSource[] | null | undefined>();
  /** What scout said about the list: whether empty means none exist, and whether it is old or short. */
  let answer = $state<SourceAnswer | undefined>();
  /** The releases this browser can't play, by filename, with den-remux's reason. Empty until (unless) it says. */
  let refused = $state(new Map<string, string>());
  let open = $state(false),
    retry = $state(0);
  let panel = $state<HTMLDivElement>();
  const panelId = $props.id();
  const key = (source: TitleSource) =>
    `${scout?.install}:${imdb}:${season}:${episode}:${source.filename}`;
  const best = $derived(
    sources?.find((s) => s.cached === true) ??
      sources?.find((s) => s.seeders !== 0) ??
      sources?.[0],
  );
  const jobState = (source: TitleSource) => downloads.states.get(key(source));
  $effect(() => {
    const [addon, id, table, s, e] = [scout, imdb, routes, season, episode];
    void retry;
    sources = undefined;
    answer = undefined;
    if (!addon || !id) return;
    const controller = new AbortController();
    void fetchSourceList(addon, id, table, s, e, controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      sources = loaded.sources;
      answer = loaded.answer;
    });
    return () => controller.abort();
  });
  // Asked once per title or episode, and only where Play is offered. A den-remux that can't say leaves every
  // release playable.
  let asked = '';
  $effect(() => {
    const [addon, id, base, s, e, shown, offered] = [
      scout,
      imdb,
      remux,
      season,
      episode,
      open,
      !!onplay,
    ];
    const which = `${base}:${addon?.install}:${id}:${s}:${e}`;
    if (which !== asked) refused = new Map();
    if (!shown || !offered || !addon || !id || base === null || which === asked) return;
    asked = which;
    void (async () => {
      const claims = await playable();
      const list = await listReleases(
        { imdb: id, season: s, episode: e, scout: addon.install },
        undefined,
        base,
        { videoCodecs: videoCodecsOf(claims), playable: claims },
      );
      if (asked === which) refused = unplayable(list);
    })().catch(() => undefined);
  });
  /** Asks in a row whose answers changed nothing, and what they last said (`pollDelay`). */
  let quiet = 0;
  let lastSaid = '';
  $effect(() => {
    if (!active || !sources) return;
    const pending = sources.filter((source) =>
      ['preparing', 'unknown'].includes(jobState(source)?.state ?? ''),
    );
    if (!pending.length) return;
    const said = JSON.stringify(pending.map((source) => [key(source), jobState(source)]));
    quiet = said === lastSaid ? quiet + 1 : 0;
    lastSaid = said;
    const timer = setTimeout(() => {
      for (const source of pending) void downloads.poll(key(source), source);
    }, pollDelay(quiet));
    return () => clearTimeout(timer);
  });
  export async function show() {
    open = true;
    await tick();
    panel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const size = (bytes?: number) => (bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '');
</script>

<div class="source-controls">
  <button
    class="control"
    aria-expanded={open}
    aria-controls={panelId}
    onclick={() => (open = !open)}
    ><DetailIcon name="sources" />Sources{sources ? ` (${sources.length})` : ''}</button
  >
  {#if best && best.cached === false && best.seeders !== 0}
    <button
      class="control"
      disabled={!!jobState(best) && !['failed', 'not-queued'].includes(jobState(best)!.state)}
      onclick={() => void downloads.start(key(best), best!)}
    >
      <DetailIcon name="download" />{jobState(best)?.state === 'ready'
        ? 'Ready to play'
        : jobState(best)?.state === 'preparing'
          ? 'Downloading'
          : jobState(best)?.state === 'unknown'
            ? 'Checking download'
            : 'Download'}
    </button>
  {/if}
</div>
{#if best?.cached === false && !jobState(best)}<p class="readiness">
    This {season === undefined ? 'movie' : 'episode'} needs a download before it’s ready to play here.
  </p>{/if}
{#if open}
  <div id={panelId} bind:this={panel} class="source-panel">
    {#if season !== undefined}<p class="note">Sources for S{season} · E{episode}</p>{/if}
    {#if !scout}<p class="note">
        Add Den Scout in <a href="#settings">Settings</a> to browse sources.
      </p>
    {:else if !imdb}<p class="note">
        TMDB has no IMDb record for this title, so sources can’t be matched yet.
      </p>
    {:else if sources === undefined}<Loading label="Loading sources" />
    {:else if sources === null}<p class="note">Couldn’t reach the source service.</p>
      <button class="control" onclick={() => retry++}>Try again</button>
    {:else if sources.length === 0 && answer?.kind === 'unknown'}<p class="note">
        Your sources didn’t answer, so there may be releases this couldn’t see.
      </p>
      <button class="control" onclick={() => retry++}>Try again</button>
    {:else if sources.length === 0}<p class="note">
        No sources found for this {season === undefined ? 'movie' : 'episode'}.
      </p>
    {:else}
      {#if answer?.outage}<p class="note">
          Your sources didn’t answer, so this is the list from {ageOf(answer.outage.builtAt)} ago.
        </p>
      {:else if answer?.kind === 'partial' && answer.missing > 0}<p class="note">
          {answer.missing === 1 ? 'One source' : `${answer.missing} sources`} didn’t answer, so this list
          may be short.
        </p>{/if}
      <ul>
        {#each sources as source (source.filename)}
          {@const job = jobState(source)}
          {@const ready = source.cached === true || job?.state === 'ready'}
          <li>
            <div class="source-copy">
              <p class="chips">
                {#each source.badges as badge, i (i)}<span class="chip">{badge}</span>{/each}
                {#if size(source.size)}<span class="chip quiet">{size(source.size)}</span>{/if}
              </p>
              <strong>{source.filename}</strong>
              {#if source.probed && source.languages.length}<p class="languages">
                  Audio: {source.languages.join(', ')}
                </p>{/if}
              <p class="status" class:ready>
                <span class="dot" aria-hidden="true"></span>{ready
                  ? 'Ready to play'
                  : job?.state === 'preparing'
                    ? `Downloading${job.progress !== undefined ? ` · ${Math.round(job.progress * 100)}%` : ''}`
                    : (job?.message ??
                      (source.cached === false
                        ? source.seeders === 0
                          ? 'No seeders'
                          : 'Download needed'
                        : 'Availability unknown'))}
              </p>
              {#if job?.state === 'preparing' && job.progress !== undefined}<progress
                  value={job.progress}
                  max="1"
                  aria-label="Download progress"
                ></progress>{/if}
            </div>
            <div class="source-actions">
              {#if ready && onplay}<button
                  class="control"
                  disabled={refused.has(source.filename)}
                  title={refused.has(source.filename)
                    ? `Can’t play in this browser${refused.get(source.filename) ? `: ${refused.get(source.filename)}` : ''}`
                    : undefined}
                  onclick={() => onplay(source.filename)}><DetailIcon name="play" />Play</button
                >
              {:else if !ready}<button
                  class="control"
                  disabled={job?.state === 'preparing' || job?.state === 'unknown'}
                  onclick={() => void downloads.start(key(source), source)}
                  ><DetailIcon name="download" />{source.seeders === 0
                    ? 'Download anyway'
                    : 'Download'}</button
                >{/if}

              {#if job?.state === 'unknown'}<button
                  class="text-button"
                  onclick={() => void downloads.poll(key(source), source)}>Check status</button
                >{/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .source-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    min-height: 48px;
  }

  .control {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 44px;
    padding: 8px 18px;
    border: 1px solid #ffffff24;
    border-radius: 12px;
    background: #ffffff15;
    color: var(--fg);
    cursor: pointer;
  }

  .control:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .source-panel {
    max-width: 1100px;
    margin: 16px 0 24px;
    scroll-margin-top: var(--bar-space);
  }

  .readiness,
  .note {
    color: var(--muted);
    font-size: 14px;
  }

  a {
    color: var(--accent);
  }

  ul {
    display: grid;
    gap: 10px;
    list-style: none;
    padding: 0;
    margin: 0;
  }

  /* A card each, rather than rows divided by hairlines: a release is a thing you choose between, and the
     filenames are long enough that a separator alone left the list reading as one paragraph. */
  li {
    display: flex;
    gap: 24px;
    justify-content: space-between;
    align-items: center;
    padding: 16px 18px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: #ffffff08;
  }

  .source-copy {
    min-width: 0;
  }

  /* What the release IS, first and scannable. The filename goes under it as the detail: eighty characters
     of dots and dashes is not a headline, however much of the truth it carries. */
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 8px;
  }

  .chip {
    padding: 3px 9px;
    border-radius: 999px;
    background: #ffffff14;
    font-size: 12px;
    font-weight: 600;
  }

  .chip.quiet {
    border: 1px solid var(--line);
    background: none;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  strong {
    overflow-wrap: anywhere;
    font-size: 14px;
    color: var(--muted);
  }

  .languages {
    font-size: 13px;
    color: var(--muted);
    margin: 8px 0 0;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    color: #ffc177;
    margin: 8px 0 0;
  }

  /* Colour alone says ready-or-not; the dot gives it a shape as well, for anyone who can't tell the two. */
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentcolor;
  }

  .status.ready {
    color: #86d7a2;
  }

  .source-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: none;
  }

  .text-button {
    min-height: 36px;
    border: 0;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .control:focus-visible,
  .text-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  progress {
    margin-top: 10px;
    width: 200px;
    max-width: 100%;
    height: 4px;
  }

  @media (width <= 759px) {
    li {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
    }

    .source-actions {
      flex-flow: row wrap;
    }

    .control {
      font-size: 14px;
      border-radius: 999px;
      padding-inline: 14px;
    }
  }
</style>
