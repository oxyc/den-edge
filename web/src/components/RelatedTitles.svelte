<!-- The rows under a title's cast: its franchise, other versions of its story, More like this, You might also like
     and its strongest mood, what its director, creator, writer and leads have done, its studio and network, and its
     country or language. A row shows its heading as soon as it is known, loads as it nears the screen, and goes on
     loading as it is scrolled to its end (`BrowseRow`). -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { TitleDetail } from '../lib/detail';
  import type { IconicStudio } from '../lib/iconicStudios';
  import { titleKey, type Title } from '../lib/library';
  import {
    authorRow,
    countryRow,
    firstScreen,
    franchiseRow,
    homeCountry,
    languageRow,
    moodRow,
    moreLikeThisRow,
    personRow,
    personRows,
    producerRows,
    studioRow,
    themeRows,
    versionsRow,
    withPosters,
  } from '../lib/relatedRows';
  import { NO_FACTS, type TitleFacts } from '../lib/titleFacts';
  import { whenIdle } from '../lib/idle';
  import { observeNearViewport } from '../lib/nearViewport';
  import { SvelteSet } from 'svelte/reactivity';
  import { yieldTask } from '../lib/taskYield';
  import type { ContentServiceClientPort } from '../lib/libraryServiceFactory';

  const regions = new Intl.DisplayNames(['en'], { type: 'region' });
  import BrowseRow from './BrowseRow.svelte';

  let {
    detail,
    content,
    atlas = null,
    studios,
    facts,
    active,
    mountRows = true,
    shown,
  }: {
    detail: TitleDetail;
    content: ContentServiceClientPort;
    /** Where this page reaches atlas, for the titles its index finds closest; null where it can't. */
    atlas?: string | null;
    /**
     * Curated studios credited on this title, each with its own row, and atlas's facts about it — its moods, networks
     * and companies. Either is undefined while it is asked for, and the rows wait for both: a row
     * they name would otherwise join mid-page.
     */
    studios: IconicStudio[] | undefined;
    facts: TitleFacts | undefined;
    active: boolean;
    /** Detail promotes the live row trees only after its cast has mounted in small batches. */
    mountRows?: boolean;
    shown: (t: Title) => boolean;
  } = $props();

  /** You might also like's row id (`moreLikeThisRow`). */
  const SUGGESTED = 'you-might-also-like';
  /** Each shown row with its build: a rebuilt row keeps its id, and must still start its own loader afresh. */
  // Row definitions are replaced as complete builds and never mutated. Avoid deep proxies around every loader and
  // filter while the detail page constructs its below-fold placeholders.
  let rows = $state.raw<{ build: number; row: RowDef }[]>([]);
  /** The title `rows` were built for, and how many builds there have been. Not reactive: the effect only reads them. */
  let rowsFor = '';
  let builds = 0;
  /** Row loaders that have actually been entered for this title, retained across an atlas-late rebuild. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read and written only by loader closures.
  let startedRows = new Set<string>();
  let root: HTMLDivElement;
  let discovery = $state<{
    start: () => Promise<void>;
    cancel: () => void;
  }>();
  /** Live BrowseRows already admitted. The one-block substitutes keep the same initial skeleton height. */
  const mountedRows = new SvelteSet<string>();

  // Discover the two rows whose existence is not known up front only after this retained page is active. The
  // shared observer promotes the work immediately near Related; otherwise it waits for the browser's idle queue.
  // Deactivating the page cancels only a start that has not happened: an answer already in flight can settle and is
  // retained for Back.
  $effect(() => {
    const pending = discovery;
    if (!active || !pending || !root) return;
    let cancelIdle = () => {};
    const start = () => {
      cancelIdle();
      void pending.start();
    };
    const stopNear = observeNearViewport(root, (near) => near && start(), '800px 0px');
    cancelIdle = whenIdle(pending.start);
    return () => {
      cancelIdle();
      stopNear();
    };
  });

  // The rows are built as soon as the title is, and each loads its first page as it nears the screen
  // (`BrowseRow`'s `prefetch`), so a title asks for the rows its viewer scrolls to, not all of them. For a title's
  // first build, every row it is known to have shows its heading and card-sized placeholders at once and loads
  // itself, hiding if it turns out empty; only the franchise and other-versions rows, which are not known to exist until they are looked up,
  // join once they have something to show.
  // A row remembers what it has loaded, so an atlas that answers late builds them afresh — and then the rows already
  // shown stay until the rebuilt ones have their first page, rather than falling back to placeholders.
  $effect(() => {
    // Held for atlas's studios and facts, which name the studio, mood and network rows: a title's rows are built
    // once, all together.
    const [curated, asked] = [studios, facts];
    if (atlas && (!curated || !asked)) return;
    const known = asked ?? NO_FACTS;
    const credited = curated ?? [];
    const options = { content };
    const self = detail.title;
    const key = titleKey(self);
    const rebuild = key === rowsFor;
    if (!rebuild) {
      startedRows = new Set<string>();
      mountedRows.clear();
    }
    const started = startedRows;
    const preserve = new Set(started);
    rowsFor = key;
    const originalLanguage = detail.title.originalLanguage;
    const regionalLanguage =
      originalLanguage && originalLanguage !== 'en'
        ? detail.languages.find((language) => language.id === originalLanguage)
        : undefined;
    // "More from Spain" rather than "More in Spanish", which is Spain, Mexico and Argentina together: the first of its
    // countries where its language is at home (`homeCountry`), atlas's (Wikidata's countries of origin) before TMDB's,
    // which names Pan's Labyrinth Mexican. Where none is, its language's row.
    const countryId =
      regionalLanguage &&
      homeCountry(regionalLanguage.id, [...known.countries, ...detail.countries.map((c) => c.id)]);
    const regionalCountry = countryId
      ? (detail.countries.find((c) => c.id === countryId)?.name ??
        regions.of(countryId) ??
        countryId)
      : undefined;
    const regional =
      !atlas || !regionalLanguage
        ? null
        : countryId && regionalCountry
          ? withPosters(
              countryRow(
                { id: countryId, name: regionalCountry },
                regionalLanguage.id,
                self,
                content,
              ),
              options,
            )
          : withPosters(languageRow(regionalLanguage, self, content), options);
    let live = true;
    // Every title the rows above You might also like have shown — the franchise, other versions and More like this —
    // so it offers none of them again.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read by loaders only, never rendered.
    const onPage = new Set<string>([titleKey(self)]);
    // The same, as it grows: other versions, which load after You might also like, drop their titles from it then.
    const above = new SvelteSet<string>();
    const noted = (row: RowDef): RowDef => ({
      ...row,
      load: async (page) => {
        const titles = await row.load(page);
        for (const title of titles) {
          onPage.add(titleKey(title));
          above.add(titleKey(title));
        }
        return titles;
      },
    });
    /** Mark the first real entry into a row loader, not merely construction of its placeholder. */
    const tracked = (row: RowDef): RowDef => ({
      ...row,
      load: (page) => {
        started.add(row.id);
        return row.load(page);
      },
    });
    // Known to exist once atlas (or TMDB's collection) names its members, so it joins then with placeholders
    // rather than after every member's poster is drawn — for a franchise atlas sends no posters for, that
    // is one TMDB request per member.
    // The promise identities live for this whole build, even while its RoutePage is retained inactive. Their gate
    // stops either loader from being called by component construction alone.
    let releaseDiscovery!: (start: boolean) => void;
    let discoveryDecided = false;
    const discoveryGate = new Promise<boolean>((resolve) => (releaseDiscovery = resolve));
    const franchise = discoveryGate.then((start) =>
      start
        ? franchiseRow(detail.collection, self, atlas, options).then(
            (row) => row && tracked(noted(row)),
          )
        : null,
    );
    const versions = discoveryGate.then((start) =>
      start
        ? versionsRow(self, atlas, franchise, options).then((row) =>
            row ? firstScreen(tracked(noted(row)), shown) : null,
          )
        : null,
    );
    const decideDiscovery = (start: boolean) => {
      if (discoveryDecided) return;
      discoveryDecided = true;
      releaseDiscovery(start);
    };
    const settledDiscovery = Promise.all([franchise, versions]).then(() => undefined);
    const pendingDiscovery = {
      start: () => {
        decideDiscovery(true);
        return settledDiscovery;
      },
      cancel: () => decideDiscovery(false),
    };
    discovery = pendingDiscovery;
    const author = atlas ? authorRow(known, self, content) : null;
    // Closest first: what is like this title and what its fans also love, then what else came from its source
    // author's books, the people who made it, then the same of its strongest mood, its studio, network and country or
    // language, which say less about this title in particular. atlas's filter sends no posters, so those rows draw
    // their own (`withPosters`).
    // More like this and the mood row share what they have offered, so a title appears in only one of them.
    const suggested = new Set<string>();
    const similar = moreLikeThisRow(detail, atlas, {
      ...options,
      mixed: true,
      similarLimit: 200,
      seen: suggested,
    });
    let similarIn = () => {};
    const similarLoaded = new Promise<void>((resolve) => (similarIn = resolve));
    const mood = atlas
      ? moodRow(known.moods, self, content, { seen: suggested, after: similarLoaded })
      : null;
    // atlas's You might also like order alone: the wider sources are More like this's. It is asked once More like
    // this has its first page, and skips every title the rows above it have shown (`onPage`, `above`).
    const affinity = atlas
      ? moreLikeThisRow(detail, atlas, {
          ...options,
          mixed: true,
          similarLimit: 200,
          affinity: true,
          fallback: false,
          seen: onPage,
        })
      : null;
    const defined: RowDef[] = [
      // Films and series together; curated primary members have their own row and atlas excludes them here.
      // Ask for atlas's whole ranked row: the loader pages this answer into screenfuls before it falls through to
      // the broader plot-neighbour and TMDB sources.
      noted({ ...similar, load: (page: number) => similar.load(page).finally(similarIn) }),
      ...(affinity
        ? [
            {
              ...affinity,
              load: (page: number) => similarLoaded.then(() => affinity.load(page)),
              filter: (title: Title) => !above.has(titleKey(title)),
            },
          ]
        : []),
      // Every adaptation of the same author's work, the franchise's and other versions' included: the whole list is
      // what someone asking "what else came from their books" wants.
      ...(author ? [withPosters(author, options)] : []),
      ...personRows(detail).map((r) => personRow(r.person, r.department, self, options, r.before)),
      ...(mood ? [withPosters(mood, options)] : []),
      ...(atlas
        ? [
            ...themeRows(known, self, content, regionalCountry),
            ...credited.map((studio) => studioRow(studio, self, content)),
            ...producerRows(known, credited, self, content),
          ].map((row) => withPosters(row, options))
        : []),
      ...(regional ? [regional] : []),
    ].map(tracked);
    const build = ++builds;
    const current = () => live && builds === build && rowsFor === key;
    if (rebuild) {
      void Promise.all([
        franchise,
        versions,
        // Only replace content a viewer has already caused to load with another pre-resolved row. Untouched rows
        // remain cheap definitions and keep the same heading/skeleton geometry when this build is published.
        ...defined.map((row) => (preserve.has(row.id) ? firstScreen(row, shown) : row)),
      ]).then((found) => {
        if (!current()) return;
        const next = found
          .filter((row): row is RowDef => row !== null)
          .map((row) => ({ build, row }));
        // A rebuild with no atlas has none to suggest: the suggestions already shown for this title stay, under
        // More like this, rather than shrinking the page under the viewer.
        const kept = affinity ? undefined : rows.find(({ row }) => row.id === SUGGESTED);
        if (kept) next.splice(next.findIndex(({ row }) => row.id === similar.id) + 1, 0, kept);
        rows = next;
      });
    } else {
      rows = defined.map((row) => ({ build, row }));
      void franchise.then(async (row) => {
        if (current() && row) rows = [{ build, row }, ...rows];
        // Other versions sit straight under the franchise, which they are never part of.
        const other = await versions;
        if (!current() || !other) return;
        const at = row
          ? rows.findIndex((entry) => entry.build === build && entry.row.id === row.id) + 1
          : 0;
        rows = [...rows.slice(0, at), { build, row: other }, ...rows.slice(at)];
      });
    }
    return () => {
      live = false;
      pendingDiscovery.cancel();
    };
  });

  // BrowseRow is a substantial subtree even before its loader runs. Admit one per task, never while this retained
  // route is hidden. Build-qualified keys also make an atlas-late rebuild progressive instead of moving the same
  // ParseHTML burst to a later moment.
  $effect(() => {
    const [currentRows, visible, allowed] = [rows, active, mountRows];
    if (!visible || !allowed || !currentRows.length) return;
    const pending = currentRows.filter(({ build, row }) => !mountedRows.has(`${build}:${row.id}`));
    if (!pending.length) return;
    let live = true;
    void (async () => {
      for (const { build, row } of pending) {
        await yieldTask();
        if (!live || !active || !mountRows || rows !== currentRows) return;
        mountedRows.add(`${build}:${row.id}`);
      }
    })();
    return () => {
      live = false;
    };
  });
</script>

<div bind:this={root} aria-hidden={!active}>
  {#each rows as { build, row } (`${build}:${row.id}`)}
    {#if mountedRows.has(`${build}:${row.id}`)}
      <BrowseRow {row} {shown} prefetch={false} />
    {:else}
      <div class="row-reserve" data-related-placeholder aria-hidden="true"></div>
    {/if}
  {/each}
</div>

<style>
  .row-reserve {
    --card-w: clamp(140px, 38vw, 190px);

    /* PosterRow heading + gap + BrowseRow's initial card skeleton + track padding + row margin. */
    height: calc(var(--card-w) * 1.5 + 127.2px);
  }
</style>
