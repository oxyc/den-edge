<script lang="ts">
  import DetailIcon from './DetailIcon.svelte';
  import { airDate, cleanedOverview, futureDate } from '../lib/detailPresentation';
  import type { Episode } from '../lib/detail';
  let { episode, progress, busy, fallback, onplay, onseen, onsources }: {
    episode: Episode; progress: number; busy: boolean; fallback?: string;
    onplay: () => void; onseen: (seen: boolean) => void; onsources?: () => void;
  } = $props();
  const seen = $derived(progress >= .95);
  const upcoming = $derived(futureDate(episode.airDate));
  const date = $derived(airDate(episode.airDate));
  let menu: HTMLDetailsElement;
  function act(action: () => void) { menu.open = false; action(); }
  function dismiss(event: PointerEvent) { if (menu?.open && !menu.contains(event.target as Node)) menu.open = false; }
  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape' && menu?.open) { menu.open = false; menu.querySelector('summary')?.focus(); }
  }
</script>
<svelte:window onpointerdown={dismiss} onkeydown={escape} />

<li class="episode" class:seen class:upcoming>
  <button type="button" class="episode-play" disabled={upcoming || busy} onclick={onplay}
    aria-label={upcoming ? `Episode ${episode.number}: ${episode.name}. Airs ${date}` : `Play episode ${episode.number}: ${episode.name}`}>
    <span class="still">
      {#if episode.stillPath || fallback}
        <img src={`https://image.tmdb.org/t/p/w500${episode.stillPath ?? fallback}`} alt="" width="500" height="281" loading="lazy" decoding="async" />
      {:else}<span class="missing-art"><DetailIcon name="play" /></span>{/if}
      <span class="number">{episode.number}</span>
      {#if seen}<span class="watched"><DetailIcon name="check" /></span>{/if}
      {#if !upcoming}<span class="play-glyph"><DetailIcon name="play" filled /></span>{/if}
      {#if progress > .02}<span class="progress" style:--progress={`${seen ? 100 : progress * 100}%`}></span>{/if}
    </span>
    <span class="about">
      <span class="episode-heading"><strong>{episode.name}</strong><span class="facts">{[episode.runtime ? `${episode.runtime} min` : '', !upcoming ? date : ''].filter(Boolean).join(' · ')}</span></span>
      {#if upcoming}<span class="air-date">Airs <time datetime={episode.airDate}>{date}</time></span>
      {:else if episode.overview}<span class="overview">{cleanedOverview(episode)}</span>{/if}
    </span>
  </button>
  <details class="episode-menu" bind:this={menu}>
    <summary aria-label={`Options for episode ${episode.number}`}><DetailIcon name="more" /></summary>
    <div class="menu">
      {#if onsources && !upcoming}<button onclick={() => act(onsources)}><DetailIcon name="sources" />Sources</button>{/if}
      <button disabled={busy} onclick={() => act(() => onseen(!seen))}><DetailIcon name={seen ? 'eye' : 'check'} />{seen ? 'Mark unwatched' : 'Mark watched'}</button>
    </div>
  </details>
</li>

<style>
  .episode { position:relative; display:grid; grid-template-columns:minmax(0,1fr) 44px; gap:8px; align-items:center; padding:12px; border-radius:16px; }
  .episode:has(.episode-play:hover), .episode:has(.episode-play:focus-visible) { background:rgb(255 255 255 / .06); }
  .episode-play { display:grid; grid-template-columns:clamp(190px,24vw,280px) minmax(0,1fr); gap:36px; align-items:start;
    width:100%; border:0; padding:0; background:none; color:inherit; text-align:left; cursor:pointer; border-radius:10px; }
  .episode-play:disabled { cursor:default; }
  .episode-play:focus-visible { outline:2px solid var(--accent); outline-offset:6px; }
  .still { position:relative; display:block; width:100%; aspect-ratio:16/9; overflow:hidden; border-radius:10px; background:var(--card); }
  img { display:block; width:100%; height:100%; object-fit:cover; }
  .seen img { opacity:.65; }
  .number { position:absolute; top:8px; left:8px; min-width:24px; padding:2px 7px; border-radius:6px; background:#000b; text-align:center; font-size:13px; font-weight:600; }
  .progress { position:absolute; bottom:8px; left:8px; right:8px; height:4px; border-radius:4px; background:#fff4; }
  .progress::after { content:''; display:block; width:var(--progress); height:100%; border-radius:inherit; background:white; }
  .watched { position:absolute; right:8px; top:8px; color:white; filter:drop-shadow(0 1px 2px black); }
  .play-glyph, .missing-art { position:absolute; inset:0; display:grid; place-items:center; }
  .play-glyph { opacity:0; background:#0003; }
  .episode-play:hover .play-glyph, .episode-play:focus-visible .play-glyph { opacity:1; }
  .episode-heading { display:flex; flex-wrap:wrap; justify-content:space-between; gap:6px 16px; align-items:baseline; }
  strong { font-size:20px; line-height:1.3; }
  .facts { color:var(--muted); font-size:14px; }
  .overview { display:-webkit-box; margin-top:10px; color:var(--muted); line-height:1.5; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:3; line-clamp:3; }
  .air-date { display:block; margin-top:10px; color:#ffb55c; }
  .episode-menu { position:relative; align-self:center; }
  summary { display:grid; place-items:center; width:44px; height:44px; border-radius:50%; cursor:pointer; list-style:none; color:var(--muted); }
  summary::-webkit-details-marker { display:none; }
  summary:hover, details[open] summary { background:#fff2; color:var(--fg); }
  summary:focus-visible { outline:2px solid var(--accent); }
  .menu { position:absolute; z-index:5; top:48px; right:0; width:max-content; min-width:200px; padding:6px; border:1px solid var(--line); border-radius:12px; background:#222228; box-shadow:0 12px 40px #0008; }
  .menu button { display:flex; align-items:center; gap:12px; width:100%; min-height:44px; border:0; border-radius:8px; padding:8px 12px; background:none; color:var(--fg); text-align:left; cursor:pointer; }
  .menu button:hover, .menu button:focus-visible { background:#fff2; }
  @media(max-width:759px) {
    .episode { padding:8px 0; gap:4px; border-radius:10px; }
    .episode-play { grid-template-columns:clamp(96px,29vw,180px) minmax(0,1fr); gap:12px; }
    strong { font-size:16px; }
    .facts { font-size:12px; }
    .overview { margin-top:5px; font-size:13px; -webkit-line-clamp:2; line-clamp:2; }
    .air-date { margin-top:6px; font-size:13px; }
    .number { top:4px; left:4px; font-size:11px; padding:1px 5px; min-width:20px; }
    .episode-menu { align-self:start; }
    .progress { bottom:5px; left:5px; right:5px; height:3px; }
  }
</style>
