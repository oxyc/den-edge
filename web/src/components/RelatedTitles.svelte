<script lang="ts">
  import { fetchCollection, fetchFilmography, groupFilmography, type TitleDetail } from '../lib/detail';
  import type { Title } from '../lib/library';
  import PosterRow from './PosterRow.svelte';
  import PosterCard from './PosterCard.svelte';
  let { detail, tmdbKey, active, shown, onselect }: {
    detail: TitleDetail; tmdbKey: string; active: boolean; shown: (t: Title) => boolean; onselect: (t: Title) => void;
  } = $props();
  let reached = $state(false);
  let rows = $state<{ heading: string; titles: Title[] }[]>([]);
  function approach(node: HTMLElement) {
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) reached = true; }, { rootMargin: '600px' });
    observer.observe(node); return { destroy: () => observer.disconnect() };
  }
  $effect(() => {
    if (!reached) return;
    const d = detail, key = tmdbKey;
    let live = true;
    const people = [...d.directors.slice(0, 1).map((p) => ({ ...p, department: 'Directing', heading: `More from ${p.name}` })),
      ...d.cast.slice(0, 3).map((p) => ({ ...p, department: 'Acting', heading: `Starring ${p.name}` }))];
    void Promise.all([
      d.collection ? fetchCollection(d.collection.id, key).then((titles) => ({ heading: d.collection!.name, titles })) : null,
      ...people.map(async (p) => ({ heading: p.heading, titles: groupFilmography(await fetchFilmography(p.id, key) ?? [])
        .find((g) => g.department === p.department)?.films.map((c) => c.title).slice(0, 20) ?? [] })),
    ]).then((loaded) => { if (live) rows = loaded.filter((r): r is NonNullable<typeof r> => r !== null); });
    return () => { live = false; };
  });
  const visible = (titles: Title[]) => titles.filter((t) => shown(t) && !(t.type === detail.title.type && t.id === detail.title.id));
  const related = $derived([
    ...rows.filter((r) => r.heading === detail.collection?.name),
    { heading: 'More like this', titles: detail.more },
    ...rows.filter((r) => r.heading !== detail.collection?.name),
  ].map((r) => ({ ...r, titles: visible(r.titles) })).filter((r) => r.titles.length));
</script>
<div use:approach aria-hidden={!active}>
  {#each related as group (group.heading)}
    <PosterRow heading={group.heading}>
      {#each group.titles as title (`${title.type}:${title.id}`)}<PosterCard {title} caption={title.year ? String(title.year) : undefined} onselect={() => onselect(title)} />{/each}
    </PosterRow>
  {/each}
</div>
