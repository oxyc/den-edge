<!-- The rows under a title's cast: its franchise, More like this, and what its director, creator, writer and leads
     have done. A row appears once it has something to show, and goes on loading as it is scrolled to its end
     (`BrowseRow`). -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { TitleDetail } from '../lib/detail';
  import { titleKey, type Title } from '../lib/library';
  import {
    collectionRow,
    firstScreen,
    moreLikeThisRow,
    personRow,
    personRows,
  } from '../lib/relatedRows';
  import BrowseRow from './BrowseRow.svelte';

  let {
    detail,
    tmdbKey,
    atlas = null,
    active,
    shown,
  }: {
    detail: TitleDetail;
    tmdbKey: string;
    /** Where this page reaches atlas, for the titles its index finds closest; null where it can't. */
    atlas?: string | null;
    active: boolean;
    shown: (t: Title) => boolean;
  } = $props();

  let reached = $state(false);
  /** Each shown row with its build: a rebuilt row keeps its id, and must still start its own loader afresh. */
  let rows = $state<{ build: number; row: RowDef }[]>([]);
  /** The title `rows` were built for, and how many builds there have been. Not reactive: the effect only reads them. */
  let rowsFor = '';
  let builds = 0;

  function approach(node: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) reached = true;
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  // Each row is read once the rows are near the screen, and shown if it has anything. A row remembers what it has
  // loaded, so a new title, or an atlas that answers late, builds them afresh. The rows already shown stay until
  // the rebuilt ones are ready: emptying them first would shorten the page under someone scrolled down it, and the
  // browser would pull them up by the rows' height. A replaced row holds its height with `BrowseRow`'s card-sized
  // placeholders until its first page shows. Only a different title clears them at once.
  $effect(() => {
    if (!reached) return;
    const options = { key: tmdbKey };
    const self = detail.title;
    const key = titleKey(self);
    if (key !== rowsFor) {
      rows = [];
      rowsFor = key;
    }
    const defined = [
      ...(detail.collection ? [collectionRow(detail.collection, self, options)] : []),
      // Films and series together: a series' closest titles include the films that share its world, and back.
      moreLikeThisRow(detail, atlas, { ...options, mixed: true }),
      ...personRows(detail).map((r) => personRow(r.person, r.department, self, options, r.before)),
    ];
    let live = true;
    void Promise.all(defined.map((row) => firstScreen(row, shown))).then((found) => {
      if (!live) return;
      const build = ++builds;
      rows = found.filter((row): row is RowDef => row !== null).map((row) => ({ build, row }));
    });
    return () => {
      live = false;
    };
  });
</script>

<div use:approach aria-hidden={!active}>
  {#each rows as { build, row } (`${build}:${row.id}`)}
    <BrowseRow {row} {shown} />
  {/each}
</div>
