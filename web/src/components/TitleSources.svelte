<script lang="ts">
  import { tick } from 'svelte';
  import Loading from './Loading.svelte';
  import DetailIcon from './DetailIcon.svelte';
  import DownloadStatus from './DownloadStatus.svelte';
  import { downloads, inFlight, pollDelay } from '../lib/downloadQueue.svelte';
  import { titleSummary } from '../lib/downloadStatus';
  import { ensureSyncPolicy } from '../lib/syncLoader';
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
    title,
    still,
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
    /** The title these are sources of: what a download is written down as, for every device to show. */
    title?: {
      type: 'movie' | 'tv';
      id: number;
      title: string;
      posterPath?: string;
      originalLanguage?: string;
    };
    /** The episode's still, for a download of one. */
    still?: string;
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
  /** Whether den-core is up to rank the list; until it is, nothing is offered to download. */
  let ranked = $state(false);
  /** The release a Download starts with: the TV's first pick (den-core `rank_releases`). */
  const best = $derived(
    sources && ranked ? downloads.pick(sources, title?.originalLanguage) : undefined,
  );
  /** This title's or episode's download, from the library: whichever device started it. */
  const current = $derived(title ? downloads.of(title.type, title.id, season, episode) : undefined);
  /** The download of `source`, when the one in the library is of this release. */
  const jobOf = (source: TitleSource) =>
    current && current.release.identity === source.identity ? current : undefined;
  const stateOf = (source: TitleSource) => {
    const job = jobOf(source);
    return job ? downloads.status(job).state : undefined;
  };
  /** Everything this title has queued, for the line that says whether a press took (the TV's title note). */
  const summary = $derived(
    title
      ? titleSummary(
          downloads
            .forTitle(title.type, title.id)
            .map((download) => ({ download, status: downloads.status(download) })),
        )
      : '',
  );
  function download(source: TitleSource) {
    if (!title) return;
    void downloads.start({
      title: {
        mediaType: title.type,
        mediaId: title.id,
        imdbId: imdb,
        season,
        episode,
        title: title.title,
        posterPath: title.posterPath,
        stillPath: still,
        originalLanguage: title.originalLanguage,
      },
      source,
      sources: sources ?? undefined,
    });
  }
  $effect(() => {
    const [addon, id, table, s, e] = [scout, imdb, routes, season, episode];
    void retry;
    sources = undefined;
    answer = undefined;
    if (!addon || !id) return;
    const controller = new AbortController();
    void ensureSyncPolicy().then(
      () => (ranked = true),
      (error: unknown) => console.warn('den: the release ranking could not be loaded', error),
    );
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
    const job = current;
    if (!active || !job || !inFlight(downloads.status(job).state)) return;
    const said = JSON.stringify(downloads.answers.get(job.name) ?? null);
    quiet = said === lastSaid ? quiet + 1 : 0;
    lastSaid = said;
    const timer = setTimeout(() => void downloads.poll(job), pollDelay(quiet));
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
  {#if title && best && best.cached === false && best.seeders !== 0}
    {@const state = stateOf(best)}
    <button
      class="control"
      disabled={inFlight(state ?? null) || state === 'ready'}
      onclick={() => download(best!)}
    >
      <DetailIcon name="download" />{state === 'ready'
        ? 'Ready to play'
        : state === 'fetching'
          ? 'Downloading'
          : state === 'starting' || state === 'paused'
            ? 'Checking download'
            : 'Download'}
    </button>
  {/if}
</div>
{#if best?.cached === false && !jobOf(best)}<p class="readiness">
    This {season === undefined ? 'movie' : 'episode'} needs a download before it’s ready to play here.
  </p>{/if}
{#if summary}<p class="readiness" data-title-downloads>{summary}</p>{/if}
{#if open}
  <div id={panelId} bind:this={panel} class="source-panel">
    {#if season !== undefined}<p class="note">Sources for S{season} · E{episode}</p>{/if}
    {#if !scout}<p class="note">
        Add Den Scout in <a href="/settings">Settings</a> to browse sources.
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
          {@const job = jobOf(source)}
          {@const state = stateOf(source)}
          {@const ready = source.cached === true || state === 'ready'}
          <li>
            <div class="source-copy">
              <p class="chips">
                {#each source.badges as badge, i (i)}<span class="chip">{badge}</span>{/each}
                {#if size(source.size)}<span class="chip quiet"
                    >{size(source.size)}{#if source.packSize}<span class="pack">
                        · from a {size(source.packSize)} pack</span
                      >{/if}</span
                  >{:else if source.packSize}<!-- The episode's own size is unknown (scout never names a
                    pack's whole total as if it were a single file's) — show what the number actually is
                    rather than nothing at all. -->
                  <span class="chip quiet">{size(source.packSize)} pack</span>{/if}
              </p>
              <strong>{source.filename}</strong>
              {#if source.probed && source.languages.length}<p class="languages">
                  Audio: {source.languages.join(', ')}
                </p>{/if}
              {#if job && !ready}
                {@const answer = downloads.answers.get(job.name)}
                <DownloadStatus download={job} release={false} />
                {#if answer?.state === 'preparing' && answer.progress !== undefined}<progress
                    value={answer.progress}
                    max="1"
                    aria-label="Download progress"
                  ></progress>{/if}
              {:else}
                <p class="status" class:ready>
                  <span class="dot" aria-hidden="true"></span>{ready
                    ? 'Ready to play'
                    : source.cached === false
                      ? source.seeders === 0
                        ? 'No seeders'
                        : 'Download needed'
                      : 'Availability unknown'}
                </p>
              {/if}
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
              {:else if !ready && title}<button
                  class="control"
                  disabled={inFlight(state ?? null)}
                  onclick={() => download(source)}
                  ><DetailIcon name="download" />{source.seeders === 0
                    ? 'Download anyway'
                    : 'Download'}</button
                >{/if}

              {#if job && (state === 'unreachable' || state === 'not_started')}<button
                  class="text-button"
                  onclick={() => void downloads.poll(job)}>Check status</button
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

  /* Context, not the headline: the size chip already says what this release plays. Dropped first on a
     narrow layout, where the chip row is the tightest on space. */
  .pack {
    opacity: 0.8;
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

    /* Narrow: the size chip alone, not the pack it came from. */
    .pack {
      display: none;
    }
  }
</style>
