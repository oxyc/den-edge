<!-- The rows under a title's cast: its franchise, other versions of its story, More like this, what its director,
     creator, writer and leads have done, its studio and its language, and You might also like. A row shows its
     heading as soon as it is known, and goes on loading as it is scrolled to its end (`BrowseRow`). -->
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
    versionsRow,
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

  /** You might also like's row id (`moreLikeThisRow`). */
  const SUGGESTED = 'you-might-also-like';
  /** Each shown row with its build: a rebuilt row keeps its id, and must still start its own loader afresh. */
  let rows = $state<{ build: number; row: RowDef }[]>([]);
  /** The title `rows` were built for, and how many builds there have been. Not reactive: the effect only reads them. */
  let rowsFor = '';
  let builds = 0;

  // The rows are built as soon as the title is, and each loads its first page when the browser is next idle
  // (`BrowseRow`), so they are usually full before they are scrolled to. For a title's first build, every row it
  // is known to have shows its heading and card-sized placeholders at once and loads itself, hiding if it turns
  // out empty; only the franchise, other-versions and You might also like rows, which are not known to exist until
  // they are looked up, join once they have something to show.
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
    // Known to exist once atlas (or TMDB's collection) names its members, so it joins then with placeholders
    // rather than after every member's poster is drawn — for a franchise atlas sends no posters for, that
    // is one TMDB request per member.
    const franchise = franchiseRow(detail.collection, self, atlas, options);
    const versions = versionsRow(self, atlas, franchise, options).then((row) =>
      row ? firstScreen(row, shown) : null,
    );
    // Closest first: what is like this title, then the people who made it, then the studio and the language, which
    // say less about this title in particular, and last the looser suggestions.
    // The two suggestion rows share what they have offered, so a title appears in only one of them.
    const suggested = new Set<string>();
    const similar = moreLikeThisRow(detail, atlas, {
      ...options,
      mixed: true,
      similarLimit: 200,
      seen: suggested,
    });
    let similarIn = () => {};
    const similarLoaded = new Promise<void>((resolve) => (similarIn = resolve));
    const defined: RowDef[] = [
      // Films and series together; curated primary members have their own row and atlas excludes them here.
      // Ask for atlas's whole ranked row: the loader pages this answer into screenfuls before it falls through to
      // the broader plot-neighbour and TMDB sources.
      { ...similar, load: (page) => similar.load(page).finally(similarIn) },
      ...personRows(detail).map((r) => personRow(r.person, r.department, self, options, r.before)),
      ...(atlas ? studios.map((studio) => studioRow(studio, self, atlas)) : []),
      ...(atlas && regionalLanguage ? [languageRow(regionalLanguage, self, atlas)] : []),
    ];
    // atlas's structural-affinity order alone: the wider sources are More like this's. It is asked once More like
    // this has its first page, so the closer row keeps the titles both would name, and atlas often has none left —
    // so like the franchise it joins only with something to show, and last, where arriving late grows the page
    // below the viewer rather than moving it.
    const affinity = atlas
      ? similarLoaded.then(() =>
          firstScreen(
            moreLikeThisRow(detail, atlas, {
              ...options,
              mixed: true,
              similarLimit: 200,
              affinity: true,
              fallback: false,
              seen: suggested,
            }),
            shown,
          ),
        )
      : Promise.resolve(null);
    const build = ++builds;
    if (rebuild) {
      void Promise.all([
        franchise,
        versions,
        ...defined.map((row) => firstScreen(row, shown)),
        affinity,
      ]).then((found) => {
        if (!live) return;
        const next = found
          .filter((row): row is RowDef => row !== null)
          .map((row) => ({ build, row }));
        // A rebuild with no atlas has none to suggest: the suggestions already shown for this title stay, rather
        // than shrinking the page under a viewer at its end.
        const kept = found.at(-1) ? undefined : rows.find(({ row }) => row.id === SUGGESTED);
        rows = kept ? [...next, kept] : next;
      });
    } else {
      rows = defined.map((row) => ({ build, row }));
      void franchise.then(async (row) => {
        if (live && row) rows = [{ build, row }, ...rows];
        // Other versions sit straight under the franchise, which they are never part of.
        const other = await versions;
        if (!live || !other) return;
        const at = row
          ? rows.findIndex((entry) => entry.build === build && entry.row.id === row.id) + 1
          : 0;
        rows = [...rows.slice(0, at), { build, row: other }, ...rows.slice(at)];
      });
      void affinity.then((row) => {
        if (live && row) rows = [...rows, { build, row }];
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
