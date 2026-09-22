<!-- The rows under a title's cast: its franchise, More like this, and what its director, creator, writer and leads
     have done. A row appears once it has something to show, and goes on loading as it is scrolled to its end
     (`BrowseRow`). -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { TitleDetail } from '../lib/detail';
  import type { Title } from '../lib/library';
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
  let rows = $state<RowDef[]>([]);

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
  // loaded, so a new title, or an atlas that answers late, builds them afresh.
  $effect(() => {
    if (!reached) return;
    const options = { key: tmdbKey };
    const self = detail.title;
    const defined = [
      ...(detail.collection ? [collectionRow(detail.collection, self, options)] : []),
      moreLikeThisRow(detail, atlas, options),
      ...personRows(detail).map((r) => personRow(r.person, r.department, self, options, r.before)),
    ];
    let live = true;
    void Promise.all(defined.map((row) => firstScreen(row, shown))).then((found) => {
      if (live) rows = found.filter((row): row is RowDef => row !== null);
    });
    return () => {
      live = false;
      rows = [];
    };
  });
</script>

<div use:approach aria-hidden={!active}>
  {#each rows as row (row.id)}
    <BrowseRow {row} {shown} />
  {/each}
</div>
