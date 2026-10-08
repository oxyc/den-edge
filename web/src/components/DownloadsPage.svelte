<!-- Everything the household has asked the debrid to fetch, from any device (den-spec library-v4 §17): the TV's
     Downloads shelf as a page. Each card is the title's poster with how far it has got; under it, what the debrid is
     doing, and Cancel (in flight: dropped at the debrid too) or Remove (only the card). -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import DownloadStatus from './DownloadStatus.svelte';
  import DownloadAlternatives from './DownloadAlternatives.svelte';
  import DownloadPosterCard from './DownloadPosterCard.svelte';
  import type { LibraryModel, LibraryModelLease } from '../lib/libraryModel.svelte';
  import type { DownloadTitleDescriptor, DownloadViewItem } from '../lib/libraryServiceProtocol';
  import { viewHeadline } from '../lib/downloadStatus';
  import type { Title } from '../lib/library';
  import { titleHref } from '../lib/route';

  let { model, active = true }: { model?: LibraryModel; active?: boolean } = $props();
  let lease = $state<LibraryModelLease<import('../lib/libraryServiceProtocol').DownloadsView>>();
  onMount(() => {
    lease = model?.downloads();
    return () => lease?.release();
  });

  /** The clock the status lines read, ticked while the page is showing so "No progress for 14 min" keeps time. */
  let now = $state(Date.now());
  $effect(() => {
    if (!active) return;
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const titleOf = (download: DownloadViewItem): Title => ({
    type: download.title.type,
    id: download.title.id,
    title: download.name,
    posterPath: download.posterPath,
  });
  const descriptorOf = (download: DownloadViewItem): DownloadTitleDescriptor => ({
    target:
      download.title.type === 'movie'
        ? { ...download.title, type: 'movie' }
        : {
            ...download.title,
            type: 'tv',
            season: download.season!,
            episode: download.episode!,
          },
    name: download.name,
    ...(download.imdbId ? { imdbId: download.imdbId } : {}),
    ...(download.posterPath ? { posterPath: download.posterPath } : {}),
    ...(download.stillPath ? { stillPath: download.stillPath } : {}),
  });

  const list = $derived((lease?.snapshot.value?.items ?? []) as DownloadViewItem[]);
  let recoveredArtwork = $state(new Map<string, string | null>());
  const artworkPending = new SvelteSet<string>();
  $effect(() => {
    const service = model;
    const missing = list.filter(
      (download) =>
        download.title.type === 'tv' &&
        !download.stillPath &&
        !recoveredArtwork.has(download.content) &&
        !artworkPending.has(download.content),
    );
    if (!service || !missing.length) return;
    for (const download of missing) artworkPending.add(download.content);
    void Promise.all(
      missing.map(async (download) => {
        const target = descriptorOf(download).target;
        try {
          const { result } = await service.downloadArtwork(target);
          return [
            download.content,
            result.kind === 'download.artwork' ? result.stillPath : null,
          ] as const;
        } catch {
          return [download.content, null] as const;
        }
      }),
    ).then((found) => {
      for (const [content] of found) artworkPending.delete(content);
      recoveredArtwork = new Map([...recoveredArtwork, ...found]);
    });
  });
  const rows = $derived(list.map((download) => ({ download, title: titleOf(download) })));
  const groups = $derived(
    [
      {
        title: 'In progress',
        items: rows.filter(
          ({ download }) => !download.announced && download.status.state !== 'ready',
        ),
      },
      {
        title: 'Recently downloaded',
        items: rows.filter(
          ({ download }) => download.announced || download.status.state === 'ready',
        ),
      },
    ].filter((group) => group.items.length),
  );
  /** Asked once as the page shows, then by the library's own refresh: it opens on fresh figures. */
  $effect(() => {
    if (!active) return;
    if (model) void model.refreshDownloads().catch(() => undefined);
  });
  let busy = $state<string | null>(null);
  let message = $state('');

  async function drop(download: DownloadViewItem) {
    busy = download.content;
    message = '';
    try {
      await model?.removeDownload(descriptorOf(download).target);
    } catch {
      message = 'Couldn’t remove that download. Try again.';
    } finally {
      busy = null;
    }
  }
</script>

<h1>Downloads</h1>
<p class="note">Your debrid fetches these — you can close Den, they keep going.</p>
{#if message}<p class="note" role="status">{message}</p>{/if}

{#if !list.length}
  <p class="note">No downloads yet. Download a title from its Sources to see it here.</p>
{:else}
  {#each groups as group (group.title)}
    <section>
      <h2>{group.title}</h2>
      <ul class="grid">
        {#each group.items as row (row.download.content)}
          {@const { download, title } = row}
          {@const state = download.status.state}
          <li data-download={download.content}>
            <DownloadPosterCard
              {download}
              {title}
              stillPath={recoveredArtwork.get(download.content) ?? undefined}
              badge={download.status.fraction
                ? `${Math.floor(download.status.fraction * 100)}%`
                : undefined}
              progress={state === 'ready' ? 1 : download.status.fraction}
              downloadBadge={{ state: download.status.phase, label: viewHeadline(download) }}
              href={titleHref(title)}
              menu={false}
              {active}
            />
            <DownloadStatus {download} {now} />
            {#if state !== 'ready'}
              {#if model}<DownloadAlternatives
                  {download}
                  title={descriptorOf(download)}
                  {model}
                />{/if}
            {/if}
            <button
              type="button"
              class="control"
              disabled={busy === download.content}
              onclick={() => void drop(download)}
              >{download.status.phase === 'queued' || download.status.phase === 'downloading'
                ? 'Cancel download'
                : 'Remove'}</button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/each}
{/if}

<style>
  h1 {
    margin: 0 0 8px;
    font-size: 28px;
  }

  .note {
    margin: 0 0 24px;
    color: var(--muted);
  }

  section + section {
    margin-top: 34px;
  }

  h2 {
    margin: 0 0 14px;
    font-size: 18px;
  }

  /* Search's and the Watchlist's grid, so a page of posters looks the same wherever it is. */
  .grid {
    /* PosterCard widens a landscape row card by 1.45× relative to the portrait rhythm. Here the grid track is
       already the final card width, so compensate instead of overflowing a phone viewport. */
    --card-w: calc(100% / 1.45);

    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(220px, 70vw, 300px), 1fr));
    gap: 24px 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    align-content: start;
    gap: 6px;
    min-width: 0;
  }

  .control {
    justify-self: start;
    min-height: 36px;
    margin-top: 4px;
    padding: 6px 14px;
    border: 1px solid #ffffff24;
    border-radius: 999px;
    background: #ffffff15;
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
  }

  .control:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .control:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
</style>
