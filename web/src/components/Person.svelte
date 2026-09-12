<script lang="ts">
  import Loading from './Loading.svelte';
  import DetailTabs from './DetailTabs.svelte';
  import PosterCard from './PosterCard.svelte';
  import { fetchPerson, fetchFilmography, groupFilmography, type FilmCredit, type PersonDetail } from '../lib/detail';
  import type { Title } from '../lib/library';

  let { id, tmdbKey, active = true, onselect }: {
    id: number; tmdbKey: string; active?: boolean; onselect: (title: Title) => void;
    shown?: (title: Title) => boolean;
  } = $props();
  const panel = $props.id();
  let person = $state<PersonDetail | null | undefined>();
  let films = $state<FilmCredit[] | null | undefined>();
  let expanded = $state(false);
  let department = $state<string | null>(null);
  let counts = $state<Record<string, number>>({});
  let personRetry = $state(0), filmsRetry = $state(0);
  $effect(() => { void id; void tmdbKey; expanded = false; department = null; counts = {}; });
  $effect(() => {
    const [current, key] = [id, tmdbKey]; void personRetry;
    let live = true; person = undefined;
    void fetchPerson(current, key).then((loaded) => { if (live) person = loaded; });
    return () => { live = false; };
  });
  $effect(() => {
    const [current, key] = [id, tmdbKey]; void filmsRetry;
    let live = true; films = undefined;
    void fetchFilmography(current, key).then((loaded) => { if (live) films = loaded; });
    return () => { live = false; };
  });

  // Explicit person pages include their full career, just as on TV; discovery hide rules must not erase credits.
  const groups = $derived(groupFilmography((films ?? []).filter((c) => !c.title.adult)));
  const selected = $derived(department ?? (groups.some((g) => g.department === person?.knownFor) ? person!.knownFor! : groups[0]?.department ?? 'Acting'));
  const credits = $derived(groups.find((g) => g.department === selected)?.films ?? []);
  const visibleCount = $derived(counts[selected] ?? 20);
  function more() { counts = { ...counts, [selected]: visibleCount + 20 }; }
  function reachEnd(node: HTMLElement) {
    $effect(() => {
      if (!active || visibleCount >= credits.length) return;
      const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: '200px' });
      observer.observe(node);
      return () => observer.disconnect();
    });
  }
</script>

{#if person === undefined}
  <Loading label="Loading person" page />
{:else if person === null}
  <p class="note">Couldn’t load this person from TMDB.</p><button class="more" onclick={() => personRetry++}>Try again</button>
{:else}
  <header class="head">
    <span class="portrait">
      {#if person.profilePath}<img src="https://image.tmdb.org/t/p/h632{person.profilePath}" alt="" width="260" height="390" />{/if}
    </span>
    <div class="identity">
      <h1>{person.name}</h1>
      {#if person.knownFor}<p class="known">{person.knownFor}</p>{/if}
      {#if person.biography}
        <p class="bio" class:expanded>{person.biography}</p>
        {#if person.biography.length > 400}
          <button class="more" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>{expanded ? 'Less' : 'More'}</button>
        {/if}
      {/if}
    </div>
  </header>
  <section aria-label="Filmography">
    <h2>Filmography</h2>
    {#if groups.length > 1}
      <DetailTabs tabs={groups.map((g) => ({ value: g.department, label: g.department }))} value={selected}
        label="Credits" {panel} onchange={(value) => department = value} />
    {/if}
    <div id={panel} role={groups.length > 1 ? 'tabpanel' : undefined}
      aria-labelledby={groups.length > 1 ? `${panel}-tab-${groups.findIndex((g) => g.department === selected)}` : undefined}>
      {#if films === undefined}<Loading label="Loading filmography" />
      {:else if films === null}<p class="note">Couldn’t load the filmography.</p><button class="more" onclick={() => filmsRetry++}>Try again</button>
      {:else if !credits.length}<p class="note">No credits available yet.</p>
      {:else}
        <div class="films">
          {#each credits.slice(0, visibleCount) as c (`${c.title.type}:${c.title.id}`)}
            <PosterCard title={c.title} caption={c.title.year ? String(c.title.year) : undefined} onselect={() => onselect(c.title)} />
          {/each}
        </div>
        {#if visibleCount < credits.length}
          <button class="more load-more" use:reachEnd onclick={more}>Show more ({credits.length - visibleCount})</button>
        {/if}
      {/if}
    </div>
  </section>
{/if}

<style>
  .head { display:flex; gap:40px; align-items:start; margin:24px 0 40px; }
  .portrait { display:block; flex:0 0 auto; width:clamp(180px,22vw,260px); aspect-ratio:2/3; overflow:hidden;
    border-radius:16px; background:var(--card); box-shadow:0 12px 32px #0005; }
  img { display:block; width:100%; height:100%; object-fit:cover; }
  .identity { min-width:0; }
  h1 { margin:0; font-size:clamp(28px,3.4vw,44px); line-height:1.12; }
  .known { margin:16px 0 0; color:var(--muted); font-weight:600; }
  .bio { display:-webkit-box; max-width:900px; margin:20px 0 0; overflow:hidden; white-space:pre-line;
    -webkit-box-orient:vertical; -webkit-line-clamp:6; line-clamp:6; line-height:1.55; }
  .bio.expanded { display:block; }
  .more { min-height:44px; padding:8px 0; border:0; background:none; color:var(--accent); cursor:pointer; }
  .more:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  h2 { margin:0 0 20px; font-size:24px; }
  .films { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:28px 24px; --card-w:100%; }
  .load-more { display:block; margin:24px auto; }
  .note { color:var(--muted); }
  @media(max-width:759px) {
    .head { gap:20px; margin:12px 0 32px; }
    .portrait { width:clamp(96px,26vw,160px); border-radius:12px; }
    .known { margin-top:8px; }
    .bio { margin-top:12px; }
    .films { grid-template-columns:repeat(auto-fill,minmax(125px,1fr)); gap:24px 16px; }
  }
</style>
