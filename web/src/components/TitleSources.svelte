<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Loading from './Loading.svelte';
  import Button from './Button.svelte';
  import ButtonIcon from './ButtonIcon.svelte';
  import ChipSelect from './ChipSelect.svelte';
  import DownloadStatus from './DownloadStatus.svelte';
  import type { LibraryModel, LibraryModelLease } from '../lib/libraryModel.svelte';
  import type {
    DownloadSourceAnswer,
    DownloadSourceOutcome,
    DownloadSourceOption,
    DownloadTitleDescriptor,
    DownloadsView,
    DownloadViewItem,
    SourceWaitAnswer,
  } from '../lib/libraryServiceProtocol';
  import { ageOf } from '../lib/titleSources';
  import { availability } from '../lib/availability.svelte';
  import { loadDownloadSources } from '../lib/downloadSourceLoader';
  import { titleHref } from '../lib/route';
  import { activateLinkInPlace } from '../lib/linkActivation';
  import { i18n } from '../lib/i18n.svelte';
  import { reportClientFailure, replaceClientFailureGeneration } from '../lib/diagnosticsReport';
  let {
    imdb,
    season,
    episode,
    active,
    title,
    still,
    onplay,
    model,
    allowed = async () => true,
    episodes,
    onepisode,
  }: {
    imdb?: string;
    season?: number;
    episode?: number;
    /** The episodes of `season`, to switch between, with their names where they are known. */
    episodes?: { number: number; name?: string }[];
    /** Another episode of `season` chosen here: its sources are shown instead. */
    onepisode?: (episode: number) => void;
    active: boolean;
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
    /** Library-owned download commands/view. Detail supplies this during the final integration cutover. */
    model?: LibraryModel;
    /** The active profile's policy check, asked again where a download starts. */
    allowed?: () => Promise<boolean>;
  } = $props();
  let downloadLease = $state<LibraryModelLease<DownloadsView>>();
  onMount(() => {
    downloadLease = model?.downloads();
    return () => downloadLease?.release();
  });
  let sources = $state<DownloadSourceOption[] | null | undefined>();
  let sourceGeneration = 0;
  /** What scout said about the list: whether empty means none exist, and whether it is old or short. */
  let answer = $state<DownloadSourceAnswer | undefined>();
  let outcome = $state<DownloadSourceOutcome | undefined>();
  let waitPhase = $state<'loading' | 'slow' | 'deadline' | undefined>();
  let failure = $state<'not-configured' | 'unmatched' | 'unreachable' | undefined>();
  let fresh = $state<'rebuilt' | 'limited' | undefined>();
  let refreshing = $state(false);
  let open = $state(false),
    retry = $state(0);
  let message = $state('');
  let panel = $state<HTMLDivElement>();
  let disclosure = $state<HTMLDivElement>();
  const panelId = $props.id();
  const descriptor = $derived<DownloadTitleDescriptor | undefined>(
    title
      ? {
          target:
            title.type === 'movie'
              ? { type: 'movie', id: title.id }
              : { type: 'tv', id: title.id, season: season!, episode: episode! },
          name: title.title,
          ...(imdb ? { imdbId: imdb } : {}),
          ...(title.posterPath ? { posterPath: title.posterPath } : {}),
          ...(still ? { stillPath: still } : {}),
          ...(title.originalLanguage ? { originalLanguage: title.originalLanguage } : {}),
        }
      : undefined,
  );
  /** The release a Download starts with: the TV's first pick (den-core `rank_releases`). */
  const best = $derived(sources?.[0]);
  /** This title's or episode's download, from the library: whichever device started it. */
  const current = $derived(
    title
      ? (downloadLease?.snapshot.value?.items.find(
          (item) =>
            item.title.type === title.type &&
            item.title.id === title.id &&
            item.season === season &&
            item.episode === episode,
        ) as DownloadViewItem | undefined)
      : undefined,
  );
  /** The download of `source`, when the one in the library is of this release. */
  const jobOf = (source: DownloadSourceOption) =>
    current && current.release?.identity === source.identity ? current : undefined;
  const stateOf = (source: DownloadSourceOption) => jobOf(source)?.status.state;
  /** Everything this title has queued, for the line that says whether a press took (the TV's title note). */
  const summary = $derived(
    title
      ? downloadLease?.snapshot.value?.items.some(
          (item) => item.title.type === title.type && item.title.id === title.id,
        )
        ? 'This title has downloads in progress or ready.'
        : ''
      : '',
  );
  function inFlight(state?: string | null) {
    return (
      state === 'starting' || state === 'fetching' || state === 'not-started' || state === 'paused'
    );
  }
  function retrySources() {
    if (!refreshing) retry++;
  }
  async function download(source: DownloadSourceOption) {
    if (!descriptor || !model) return;
    message = '';
    if (!(await allowed())) {
      message = 'This title isn’t available on this profile.';
      return;
    }
    try {
      await model.enqueueDownload(
        descriptor,
        {
          identity: source.identity,
          label: source.label,
          ...(source.sizeBytes ? { sizeBytes: source.sizeBytes } : {}),
          ...(source.cached !== undefined ? { cached: source.cached } : {}),
        },
        sources?.length,
      );
    } catch {
      message = 'Couldn’t start that download. Try again.';
    }
  }
  $effect(() => {
    const [service, requested, visible, refresh] = [model, descriptor, active, retry];
    // A Detail first created in the retained history stack must not start its source request before it is shown.
    if (!visible) return;
    const rechecking = refresh > 0;
    if (!rechecking) {
      sources = undefined;
      answer = undefined;
      outcome = undefined;
      failure = undefined;
    }
    fresh = undefined;
    refreshing = rechecking;
    message = '';
    if (!service || !requested) return;
    const generation = ++sourceGeneration;
    replaceClientFailureGeneration('source_lookup', generation);
    let controller: AbortController | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let requestGeneration = 0;
    let attempt = 0;
    let recoverable = false;
    let started = 0;
    const current = (request: number) =>
      generation === sourceGeneration && request === requestGeneration;
    const stop = (
      request: number,
      kind: 'timeout' | 'other',
      durationBucket: 'fast' | 'deadline',
    ) => {
      if (!current(request)) return;
      requestGeneration++;
      controller?.abort();
      controller = undefined;
      refreshing = false;
      failure = 'unreachable';
      recoverable = true;
      reportClientFailure({
        operation: 'source_lookup',
        kind,
        outcome: 'terminal',
        route: 'content_service',
        durationBucket,
        priorList: Boolean(sources?.length),
        generation,
        attempt,
      });
    };
    const recovery = async (facts: { onlineRestored?: boolean; retryAfterMs?: number }) => {
      if (!recoverable || attempt > 0 || retryTimer) return;
      let decision: SourceWaitAnswer;
      try {
        decision = await service.sourceWait({
          elapsedMs: Math.max(0, Math.round(performance.now() - started)),
          attempt,
          ...facts,
        });
      } catch {
        // Authority replacement fences this local policy query. A current page keeps its visible manual Retry.
        return;
      }
      if (generation !== sourceGeneration || !recoverable || attempt > 0) return;
      if (decision.retryInMs === null) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        attempt = 1;
        void run(true);
      }, decision.retryInMs);
    };
    const advanceWait = async (request: number) => {
      let decision: SourceWaitAnswer;
      try {
        decision = await service.sourceWait({
          elapsedMs: Math.max(0, Math.round(performance.now() - started)),
          attempt,
        });
      } catch {
        stop(request, 'other', 'fast');
        return;
      }
      if (!current(request)) return;
      waitPhase = decision.phase;
      if (decision.nextMs !== null) {
        waitTimer = setTimeout(() => void advanceWait(request), decision.nextMs);
        return;
      }
      // The page owns the terminal deadline. Cancelling the query sends an exact request-id cancel to the library
      // Worker, which in turn aborts the provider fetch. Keep any admitted rows while the viewer decides to Retry.
      stop(request, 'timeout', 'deadline');
    };
    const run = async (automatic = false) => {
      if (generation !== sourceGeneration) return;
      const request = ++requestGeneration;
      controller?.abort();
      controller = new AbortController();
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = undefined;
      recoverable = false;
      waitPhase = 'loading';
      refreshing = rechecking || automatic;
      started = performance.now();
      void advanceWait(request);
      const loaded = await loadDownloadSources(
        service,
        requested,
        rechecking || automatic,
        controller.signal,
      );
      if (!current(request)) return;
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = undefined;
      controller = undefined;
      waitPhase = undefined;
      refreshing = false;
      fresh = loaded?.fresh;
      // A limited rebuild is the list already on screen. Keep its exact render state and say why the explicit check
      // produced no fresh verdict; the retry remains a native button for touch, keyboard and TV navigation.
      if (fresh === 'limited') return;
      sources = loaded?.sources ?? (sources === undefined ? null : sources);
      answer = loaded?.answer ?? answer;
      outcome = loaded?.outcome;
      failure =
        loaded?.failure ??
        (!loaded || (loaded.sources === null && !loaded.outcome) ? 'unreachable' : undefined);
      recoverable =
        loaded === null ||
        (loaded?.sources === null && !loaded.outcome) ||
        loaded?.outcome?.retryable === true ||
        loaded?.failure === 'unreachable';
      const elapsed = performance.now() - started;
      if (recoverable)
        reportClientFailure({
          operation: 'source_lookup',
          kind: 'transport',
          outcome: attempt ? 'retry_exhausted' : 'terminal',
          route: 'content_service',
          durationBucket: elapsed >= 20_000 ? 'deadline' : elapsed >= 5_000 ? 'slow' : 'fast',
          priorList: loaded?.outcome?.list === 'retained' || Boolean(sources?.length),
          generation,
          attempt,
        });
      else if (attempt)
        reportClientFailure({
          operation: 'source_lookup',
          kind: 'transport',
          outcome: 'recovered',
          route: 'content_service',
          durationBucket: elapsed >= 5_000 ? 'slow' : 'fast',
          priorList: Boolean(sources?.length),
          generation,
          attempt,
        });
      if (loaded?.retryAfterMs !== undefined) void recovery({ retryAfterMs: loaded.retryAfterMs });
      // An authoritative nonempty list heals the poster's fade. Unknown/degraded outcomes never fade it.
      const { target } = requested;
      if (loaded?.sources?.length && loaded.outcome?.list !== 'retained')
        availability.confirm(
          target,
          target.type === 'tv' ? { season: target.season, episode: target.episode } : undefined,
          true,
        );
    };
    const online = () => void recovery({ onlineRestored: true });
    window.addEventListener('online', online);
    void run();
    return () => {
      window.removeEventListener('online', online);
      if (waitTimer) clearTimeout(waitTimer);
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
      sourceGeneration++;
      replaceClientFailureGeneration('source_lookup', sourceGeneration);
      refreshing = false;
    };
  });
  export async function show() {
    open = true;
    await tick();
    panel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (__DEN_TV__)
      requestAnimationFrame(() =>
        disclosure?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }),
      );
  }
  const size = (bytes?: number) => (bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '');
</script>

<div class="source-accordion" class:open bind:this={disclosure}>
  <Button
    variant="tertiary"
    class="sources-disclosure"
    icon="sources"
    label="Sources"
    ariaLabel={`Sources${sources ? `, ${sources.length} available` : ''}`}
    aria-expanded={open}
    aria-controls={panelId}
    onclick={() => (open = !open)}
  >
    {#if sources}<span class="source-count">{sources.length}</span>{/if}
    <span class="disclosure-chevron" class:open aria-hidden="true"
      ><ButtonIcon name="chevron" /></span
    >
  </Button>
</div>
{#if open}
  <div id={panelId} bind:this={panel} class="source-panel">
    {#if season !== undefined}
      <div class="heading">
        <p class="note">Sources for S{season} · E{episode}</p>
        {#if onepisode && episodes && episodes.length > 1}
          <ChipSelect
            label="Episode"
            text={`E${episode}`}
            value={String(episode)}
            options={episodes.map((e) => ({
              value: String(e.number),
              label: e.name ? `E${e.number} · ${e.name}` : `E${e.number}`,
            }))}
            round
            onchange={(value) => onepisode(Number(value))}
          />
        {/if}
      </div>
    {/if}
    {#if waitPhase === 'slow'}<p class="note" role="status">
        {i18n.phrase('Sources are taking longer than usual. You can keep using this page.')}
      </p>{/if}
    {#if waitPhase === 'deadline'}<p class="note" role="status">
        {i18n.phrase(
          'Source discovery didn’t answer in time. Your previous results are still here.',
        )}
      </p>
      <Button
        variant="secondary"
        icon="retry"
        label="Try again"
        disabled={refreshing}
        onclick={retrySources}
      />
    {/if}
    {#if fresh === 'limited'}<p class="note" role="status">
        {i18n.phrase(
          'Sources were checked recently, so these are the previous results. Try again shortly.',
        )}
      </p>
      <Button
        variant="secondary"
        icon="retry"
        label="Try again"
        disabled={refreshing}
        onclick={retrySources}
      />
    {/if}
    {#if outcome?.list === 'retained' && waitPhase !== 'deadline'}<p class="note" role="status">
        {i18n.phrase('The latest check failed, so these are your previous source results.')}
      </p>{/if}
    {#if outcome?.category === 'debrid'}<p class="note">
        {i18n.phrase(
          'The availability check is degraded, so some source details may be incomplete.',
        )}
      </p>{/if}
    {#if !outcome?.caveat && !answer?.outageBuiltAt && answer?.late}<p class="note" role="status">
        {i18n.format(
          answer.late === 1 ? 'sources.late.one' : 'sources.late.other',
          'Sources still answering when this early list arrived: {count}. It may be short.',
          { count: answer.late },
        )}
      </p>{/if}
    {#if !outcome?.caveat && !answer?.outageBuiltAt && answer?.kind === 'partial' && answer.missing > 0}<p
        class="note"
      >
        {answer.missing === 1 ? 'One source' : `${answer.missing} sources`} didn’t answer, so this list
        may be short.
      </p>{/if}
    {#if failure === 'not-configured'}<p class="note">
        Add Den Scout in <a href="/settings">Settings</a> to browse sources.
      </p>
    {:else if failure === 'unmatched'}<p class="note">
        TMDB has no IMDb record for this title, so sources can’t be matched yet.
      </p>
    {:else if sources === undefined}{#if waitPhase !== 'deadline'}<Loading
          label="Loading sources"
        />{/if}
    {:else if sources === null || (sources.length === 0 && (answer?.kind === 'unknown' || outcome?.retryable))}<p
        class="note"
      >
        {sources
          ? 'Your sources didn’t answer, so there may be releases this couldn’t see.'
          : 'Couldn’t reach the source service.'}
      </p>
      {#if fresh !== 'limited' && waitPhase !== 'deadline'}<Button
          variant="secondary"
          icon="retry"
          label={refreshing ? 'Trying again…' : 'Try again'}
          disabled={refreshing}
          onclick={retrySources}
        />{/if}
    {:else if sources.length === 0}
      {#if answer?.kind !== 'partial'}<p class="note">
          No sources found for this {season === undefined ? 'movie' : 'episode'}.
        </p>{/if}
    {:else}
      {#if outcome?.caveat?.late}<p class="note" role="status">
          {i18n.format(
            outcome.caveat.late === 1 ? 'sources.late.one' : 'sources.late.other',
            'Sources still answering when this early list arrived: {count}. It may be short.',
            { count: outcome.caveat.late },
          )}
        </p>{/if}
      {#if outcome?.caveat?.missing}<p class="note">
          {outcome.caveat.missing === 1 ? 'One source' : `${outcome.caveat.missing} sources`}
          didn’t answer, so this list may be short.
        </p>{/if}
      {#if outcome?.caveat?.staleSince}<p class="note">
          Your sources didn’t answer, so this is the list from {ageOf(outcome.caveat.staleSince)} ago.
        </p>{:else if !outcome && answer?.outageBuiltAt}<p class="note">
          Your sources didn’t answer, so this is the list from {ageOf(answer.outageBuiltAt)} ago.
        </p>{/if}
      <ul>
        {#each sources as source (source.identity)}
          {@const job = jobOf(source)}
          {@const state = stateOf(source)}
          {@const ready = source.cached === true || state === 'ready'}
          <li>
            <div class="source-copy">
              <p class="chips">
                {#each source.badges as badge, i (i)}<span class="chip">{badge}</span>{/each}
                {#if size(source.sizeBytes)}<span class="chip quiet"
                    >{size(source.sizeBytes)}{#if source.packSizeBytes}<span class="pack">
                        · from a {size(source.packSizeBytes)} pack</span
                      >{/if}</span
                  >{:else if source.packSizeBytes}<!-- The episode's own size is unknown (scout never names a
                    pack's whole total as if it were a single file's) — show what the number actually is
                    rather than nothing at all. -->
                  <span class="chip quiet">{size(source.packSizeBytes)} pack</span>{/if}
              </p>
              <strong>{source.filename}</strong>
              {#if source.probed && source.languages.length}<p class="languages">
                  Audio: {source.languages.join(', ')}
                </p>{/if}
              {#if job && !ready}
                <DownloadStatus download={job} release={false} />
                {#if job.status.fraction !== undefined}<progress
                    value={job.status.fraction}
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
              {#if ready && onplay}<Button
                  variant="secondary"
                  icon="play"
                  label="Play"
                  href={title
                    ? titleHref({
                        ...title,
                        season,
                        episode,
                        play: true,
                        filename: source.filename,
                      })
                    : undefined}
                  onclick={(event) => activateLinkInPlace(event, () => onplay(source.filename))}
                />
              {:else if !ready && title}<Button
                  variant="secondary"
                  icon="download"
                  label={source.seeders === 0 ? 'Download anyway' : 'Download'}
                  disabled={inFlight(state)}
                  onclick={() => void download(source)}
                />{/if}

              {#if job && (state === 'unreachable' || state === 'not-started')}<Button
                  variant="tertiary"
                  size="compact"
                  label="Check status"
                  onclick={() =>
                    void model?.refreshDownloads(descriptor?.target).catch(() => undefined)}
                />{/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    {#if model && descriptor && sources && failure !== 'not-configured' && failure !== 'unmatched' && fresh !== 'limited'}
      <Button
        class="source-refresh"
        variant="tertiary"
        icon="retry"
        label={refreshing ? 'Trying again…' : 'Check for sources again'}
        disabled={refreshing}
        onclick={retrySources}
      />
    {/if}
  </div>
{/if}
{#if title && best && best.cached === false && best.seeders !== 0}
  {@const state = stateOf(best)}
  <div class="source-controls">
    <Button
      variant="secondary"
      icon="download"
      label={state === 'ready'
        ? 'Ready to play'
        : state === 'fetching'
          ? 'Downloading'
          : state === 'starting' || state === 'paused'
            ? 'Checking download'
            : 'Download'}
      disabled={inFlight(state) || state === 'ready'}
      onclick={() => void download(best!)}
    />
  </div>
{/if}
{#if best?.cached === false && !jobOf(best)}<p class="readiness">
    This {season === undefined ? 'movie' : 'episode'} needs a download before it’s ready to play here.
  </p>{/if}
{#if summary}<p class="readiness" data-title-downloads>{summary}</p>{/if}
{#if message}<p class="readiness" role="status">{i18n.phrase(message)}</p>{/if}

<style>
  .source-accordion {
    max-width: var(--detail-content-max);
    margin-bottom: 20px;
  }

  .source-accordion.open {
    margin-bottom: 0;
  }

  :global(.den-button.source-refresh) {
    margin-top: 16px;
  }

  .source-accordion :global(.den-button.sources-disclosure) {
    --button-bg: transparent;
    --button-border: transparent;
    --button-fg: var(--fg);

    width: auto;
    max-width: 100%;
    min-height: 44px;
    justify-content: flex-start;
    padding-inline: 0;
    border: 0;
    background: transparent;
    font-size: var(--section-heading-size);
    font-weight: var(--section-heading-weight);
    line-height: var(--section-heading-line-height);
  }

  .source-accordion :global(.den-button.sources-disclosure:hover:not([aria-disabled='true'])) {
    border-color: transparent;
    background: transparent;
  }

  .source-accordion :global(.den-button.sources-disclosure:active:not([aria-disabled='true'])) {
    transform: none;
  }

  .source-count {
    color: var(--muted);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  .disclosure-chevron {
    --button-icon-size: 16px;

    display: grid;
    flex: 0 0 20px;
    width: 20px;
    height: 44px;
    place-items: center;
    opacity: 0.65;
  }

  .disclosure-chevron :global(svg) {
    transform: rotate(-90deg);
    transition: transform 110ms ease-out;
  }

  .disclosure-chevron.open :global(svg) {
    transform: rotate(0);
  }

  .source-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    min-height: 48px;
  }

  .source-panel {
    max-width: var(--detail-content-max);
    margin: 4px 0 24px;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.025);
    scroll-margin-top: var(--bar-space);
  }

  .readiness,
  .note {
    color: var(--muted);
    font-size: 14px;
  }

  .note a {
    color: var(--accent);
  }

  /* The heading on the left and its episode picker on the right, the picker going under it where a phone has no room
     for both. */
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin: 14px 0;
  }

  .heading .note {
    margin: 0;
  }

  .heading :global(.pick) {
    flex: 0 0 auto;
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

    /* Narrow: the size chip alone, not the pack it came from. */
    .pack {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .disclosure-chevron :global(svg) {
      transition: none;
    }
  }
</style>
