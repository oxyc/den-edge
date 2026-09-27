<!-- The rows under a title's cast: its franchise, You might also like, and what its director, creator, writer and leads
     have done. A row shows its heading as soon as it is known, and goes on loading as it is scrolled to its end
     (`BrowseRow`). -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { TitleDetail } from '../lib/detail';
  import type { IconicStudio } from '../lib/iconicStudios';
  import { titleKey, type Title } from '../lib/library';
  import {
    firstScreen,
    franchiseRow,
    languageRow,
    moreLikeThisRow,
    personRow,
    personRows,
    studioRow,
  } from '../lib/relatedRows';
  import BrowseRow from './BrowseRow.svelte';

  let {
    detail,
    tmdbKey,
    atlas = null,
    studios = [],
    active,
    shown,
  }: {
    detail: TitleDetail;
    tmdbKey: string;
    /** Where this page reaches atlas, for the titles its index finds closest; null where it can't. */
    atlas?: string | null;
    /** Curated studios credited on this title; ordinary production companies never get a row. */
    studios?: IconicStudio[];
    active: boolean;
    shown: (t: Title) => boolean;
  } = $props();

  /** Each shown row with its build: a rebuilt row keeps its id, and must still start its own loader afresh. */
  let rows = $state<{ build: number; row: RowDef }[]>([]);
  /** The title `rows` were built for, and how many builds there have been. Not reactive: the effect only reads them. */
  let rowsFor = '';
  let builds = 0;

  // The rows are built as soon as the title is, and each loads its first page when the browser is next idle
  // (`BrowseRow`), so they are usually full before they are scrolled to. For a title's first build, every row it
  // is known to have shows its heading and card-sized placeholders at once and loads itself, hiding if it turns
  // out empty; only the franchise row, which is not known to exist until it is looked up, joins once it has
  // something to show.
  // A row remembers what it has loaded, so an atlas that answers late builds them afresh — and then the rows already
  // shown stay until the rebuilt ones have their first page, rather than falling back to placeholders.
  $effect(() => {
    const options = { key: tmdbKey };
    const self = detail.title;
    const key = titleKey(self);
    const rebuild = key === rowsFor;
    rowsFor = key;
    const originalLanguage = detail.title.originalLanguage;
    const regionalLanguage =
      originalLanguage && originalLanguage !== 'en'
        ? detail.languages.find((language) => language.id === originalLanguage)
        : undefined;
    let live = true;
    const franchise = franchiseRow(detail.collection, self, atlas, options).then((row) =>
      row ? firstScreen(row, shown) : null,
    );
    const defined: RowDef[] = [
      ...(atlas ? studios.map((studio) => studioRow(studio, self, atlas)) : []),
      // Films and series together; curated primary members have their own row and atlas excludes them here.
      // Ask for atlas's whole affinity row: the loader pages this answer into screenfuls before it falls through
      // to the broader plot-neighbour and TMDB sources. Older Atlas versions fall back to More Like This.
      moreLikeThisRow(detail, atlas, {
        ...options,
        mixed: true,
        similarLimit: 200,
        affinity: true,
      }),
      ...personRows(detail).map((r) => personRow(r.person, r.department, self, options, r.before)),
      ...(atlas && regionalLanguage ? [languageRow(regionalLanguage, self, atlas)] : []),
    ];
    const build = ++builds;
    if (rebuild) {
      void Promise.all([franchise, ...defined.map((row) => firstScreen(row, shown))]).then(
        (found) => {
          if (!live) return;
          rows = found.filter((row): row is RowDef => row !== null).map((row) => ({ build, row }));
        },
      );
    } else {
      rows = defined.map((row) => ({ build, row }));
      void franchise.then((row) => {
        if (live && row) rows = [{ build, row }, ...rows];
      });
    }
    return () => {
      live = false;
    };
  });
</script>

<div aria-hidden={!active}>
  {#each rows as { build, row } (`${build}:${row.id}`)}
    <BrowseRow {row} {shown} />
  {/each}
</div>
