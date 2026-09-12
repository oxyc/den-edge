<!-- A title's page, as the TV's Detail: the backdrop, what it is, the library controls, its seasons with the
     episodes you've seen, the cast, and more like it. -->
<script lang="ts">
  import DetailMedia from './DetailMedia.svelte';
  import { stableViewportHeight } from '../lib/stableViewportHeight';
  import type { Routes } from '../lib/routes';
  import Loading from './Loading.svelte';
  import { fetchDetail, fetchSeason, type Episode, type TitleDetail } from '../lib/detail';
  import type { MediaType, Title } from '../lib/library';
  import { compareStamps, type EpisodeRow, type TitleRow } from '../lib/wire';
  import PersonCard from './PersonCard.svelte';
  import PosterCard from './PosterCard.svelte';
  import PosterRow from './PosterRow.svelte';
  import TitleActions from './TitleActions.svelte';

  type Reaction = TitleRow['reaction']['value'];

  let {
    ref,
    active = true,
    reel = null,
    routes = {},
    tmdbKey,
    row,
    episodes,
    busy,
    failure,
    notice,
    onwatchlist,
    onseen,
    onreact,
    onplay,
    onplayhere,
    onepisode,
    onselect,
    shown = () => true,
  }: {
    ref: { type: MediaType; id: number };
    active?: boolean;
    reel?: string | null;
    routes?: Routes;
    tmdbKey: string;
    /** The title's row as last read; undefined for a title the library has never held. */
    row: TitleRow | undefined;
    /** This series' episode rows, by `season:episode`. */
    episodes: Map<string, EpisodeRow>;
    busy: boolean;
    failure: string | null;
    notice: string | null;
    onwatchlist: (title: Title, on: boolean) => void;
    onseen: (title: Title, on: boolean) => void;
    onreact: (title: Title, reaction: Reaction) => void;
    onplay: (title: Title) => void;
    /** Play in this browser: a movie, a series where it picks up, or one episode. None when this browser can't. */
    onplayhere?: (title: Title, season?: number, episode?: number) => void;
    onepisode: (title: Title, season: number, episode: number, seen: boolean) => void;
    onselect: (title: Title) => void;
    /** The TV's hide rules, for the recommendations. */
    shown?: (title: Title) => boolean;
  } = $props();

  /** undefined while it loads; null when TMDB couldn't say. */
  let detail = $state<TitleDetail | null | undefined>(undefined);
  let season = $state<number | null>(null);
  let seasonEpisodes = $state<Episode[] | null | undefined>(undefined);

  $effect(() => {
    const [current, key] = [ref, tmdbKey];
    detail = undefined;
    season = null;
    void fetchDetail(current, key).then((loaded) => {
      if (current !== ref) return;
      detail = loaded;
      season = loaded?.seasons[0]?.number ?? null;
    });
  });

  $effect(() => {
    const [picked, current, key] = [season, ref, tmdbKey];
    seasonEpisodes = undefined;
    if (picked === null || current.type !== 'tv') return;
    void fetchSeason(current.id, picked, key).then((loaded) => {
      if (picked === season) seasonEpisodes = loaded;
    });
  });

  const more = $derived(detail?.more.filter(shown) ?? []);

  /** Seen: all but the credits (the TV's 95%), and after "Seen" was last turned off for the whole series. */
  function watched(number: number): boolean {
    const episode = episodes.get(`${season}:${number}`);
    const reset = row?.episodesReset ?? null;
    return !!episode && episode.progress.value >= 0.95 && (reset === null || compareStamps(episode.progress.at, reset) > 0);
  }

  function facts(d: TitleDetail): string {
    const hours = d.runtime ? Math.floor(d.runtime / 60) : 0;
    const length = d.runtime ? (hours ? `${hours}h ${d.runtime % 60}m` : `${d.runtime}m`) : undefined;
    return [d.title.type === 'tv' ? 'Series' : 'Movie', d.title.year, length, d.genres.slice(0, 3).join(', ')]
      .filter(Boolean)
      .join(' · ');
  }
</script>

{#if detail === undefined}
  <div aria-busy="true" aria-label="Loading title">
    <Loading label="Loading title" page />
    <header class="hero" aria-hidden="true" use:stableViewportHeight>
      <div class="visual"></div>
      <div class="hero-content">
        <div class="head">
          <span class="poster placeholder"></span>
          <div class="loading-copy">
            <span class="placeholder loading-title"></span>
            <span class="placeholder loading-facts"></span>
          </div>
        </div>
        <div class="hero-actions"><div class="loading-actions placeholder" aria-hidden="true"></div></div>
      </div>
    </header>
    <div class="loading-overview placeholder" aria-hidden="true"></div>
  </div>
{:else if detail === null}
  <p class="note">Couldn’t load this title from TMDB. Try again in a moment.</p>
{:else}
  {@const d = detail}
  <header class="hero" use:stableViewportHeight>
    <div class="visual">
      <DetailMedia type={ref.type} imdbId={d.imdbId} {active} {reel} {routes}
        backdrop={d.backdropPath ? `https://image.tmdb.org/t/p/w1280${d.backdropPath}` : undefined}
        poster={d.title.posterPath ? `https://image.tmdb.org/t/p/w780${d.title.posterPath}` : undefined} />
    </div>
    <div class="hero-content">
      <div class="head">
        {#if d.title.posterPath}
          <img class="poster" src="https://image.tmdb.org/t/p/w342{d.title.posterPath}" alt="" width="342" height="513" />
        {:else}
          <span class="poster placeholder" aria-hidden="true"></span>
        {/if}
        <div>
          <h1>{d.title.title}</h1>
          <p class="facts">{facts(d)}</p>
          {#if d.tagline}<p class="tagline">{d.tagline}</p>{/if}
        </div>
      </div>
      <div class="hero-actions">
        <TitleActions
          {row}
          {busy}
          {failure}
          {notice}
          onwatchlist={(on) => onwatchlist(d.title, on)}
          onseen={(on) => onseen(d.title, on)}
          onreact={(reaction) => onreact(d.title, reaction)}
          onplay={() => onplay(d.title)}
          onplayhere={onplayhere ? () => onplayhere(d.title) : undefined}
          trailerHref={d.trailer
            ? `https://www.youtube.com/watch?v=${encodeURIComponent(d.trailer)}`
            : `https://www.youtube.com/results?search_query=${encodeURIComponent([d.title.title, d.title.year, 'official trailer'].filter(Boolean).join(' '))}`}
        />
      </div>
    </div>
  </header>
  {#if d.overview}<p class="overview">{d.overview}</p>{/if}

  {#if d.seasons.length}
    <section class="seasons" aria-label="Episodes">
      <div class="tabs" role="tablist">
        {#each d.seasons as s (s.number)}
          <button role="tab" aria-selected={season === s.number} class:on={season === s.number} onclick={() => (season = s.number)}>
            {s.name}
          </button>
        {/each}
      </div>
      {#if seasonEpisodes === undefined}
        <Loading label="Loading episodes" />
      {:else if seasonEpisodes === null}
        <p class="note">Couldn’t load this season from TMDB.</p>
      {:else}
        <ol class="episodes">
          {#each seasonEpisodes as e (e.number)}
            {@const seen = watched(e.number)}
            <li class="episode">
              {#if e.stillPath}
                <img class="still" src="https://image.tmdb.org/t/p/w300{e.stillPath}" alt="" loading="lazy" decoding="async" />
              {:else}
                <span class="still"></span>
              {/if}
              <div class="about">
                <b>{e.number}. {e.name}</b>
                {#if e.overview}<p>{e.overview}</p>{/if}
              </div>
              <div class="buttons">
                {#if onplayhere}
                  <button
                    class="mark"
                    aria-label={`Play episode ${e.number}`}
                    onclick={() => season !== null && onplayhere(d.title, season, e.number)}>Play</button
                  >
                {/if}
                <button
                  class="mark"
                  class:on={seen}
                  aria-pressed={seen}
                  aria-label={`Episode ${e.number}: ${seen ? 'seen' : 'mark as seen'}`}
                  disabled={busy}
                  onclick={() => season !== null && onepisode(d.title, season, e.number, !seen)}>{seen ? 'Seen' : 'Mark seen'}</button
                >
              </div>
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  {/if}

  {#if d.cast.length}
    <PosterRow heading="Cast">
      {#each d.cast as c (c.id)}
        <PersonCard id={c.id} name={c.name} role={c.role} profilePath={c.profilePath} />
      {/each}
    </PosterRow>
  {/if}
  {#if more.length}
    <PosterRow heading="More like this">
      {#each more as t (`${t.type}:${t.id}`)}
        <PosterCard title={t} caption={t.year ? String(t.year) : undefined} onselect={() => onselect(t)} />
      {/each}
    </PosterRow>
  {/if}
{/if}

<style>
  .hero {
    position:relative;
    isolation:isolate;
    display:grid;
    align-items:end;
    width:100vw;
    min-height:var(--stable-hero-height,clamp(520px,84lvh,900px));
    margin-inline:calc(50% - 50vw);
    margin-top:calc(-1 * var(--bar-space));
    margin-bottom:24px;
  }
  .visual { position:absolute; inset:0; background:var(--bg); }
  .hero-content { position:relative; width:100%; max-width:1400px; margin:0 auto; padding:calc(var(--bar-space) + 32px) var(--gutter) 24px; }
  .hero-actions { min-height:80px; margin-top:24px; }
  @media(max-width:759px) {
    .hero { display:block; min-height:0; margin-top:0; }
    .visual { position:relative; inset:auto; width:100%; aspect-ratio:16/9; }
    .hero-content { padding:24px var(--gutter) 0; }
    .hero-actions { min-height:122px; }
  }

  .head {
    display: flex;
    gap: 20px;
    align-items: end;
    min-height: clamp(144px, 33vw, 270px);
  }

  .head > div { min-width: 0; }
  .placeholder { background: var(--card, #1c1c22); border-radius: 8px; }
  .loading-copy { flex: 1; padding-bottom: 8px; }
  .loading-title { display: block; width: min(100%, 360px); height: 2.2em; margin-bottom: 12px; }
  .loading-facts { display: block; width: min(85%, 240px); height: 2.8em; }
  .loading-actions { height:48px; max-width:680px; }
  .loading-overview { height: 100px; max-width: 70ch; }

  .poster {
    display: block;
    flex: 0 0 clamp(96px, 22vw, 180px);
    width: clamp(96px, 22vw, 180px);
    height: auto;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    background: var(--card);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.5);
  }

  h1 {
    margin: 0;
    font-size: clamp(24px, 4vw, 40px);
    line-height: 1.1;
  }

  .facts,
  .tagline {
    margin: 8px 0 0;
    color: var(--muted);
  }

  .tagline {
    font-style: italic;
  }

  .overview {
    max-width: 70ch;
    margin: 12px 0 28px;
  }

  .seasons {
    margin-bottom: 32px;
  }

  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tabs button,
  .mark {
    flex: 0 0 auto;
    padding: 8px 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--fg);
    cursor: pointer;
  }

  /* A finger's worth, as every control in the player and the actions row is. */
  .mark {
    min-height: 44px;
  }

  .tabs button.on,
  .mark.on {
    border-color: var(--fg);
    background: var(--fg);
    color: var(--bg);
    font-weight: 600;
  }

  .mark:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .episodes {
    display: grid;
    gap: 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .episode {
    display: grid;
    grid-template-columns: clamp(120px, 24vw, 220px) 1fr auto;
    gap: 14px;
    align-items: start;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: end;
  }

  .still {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 10px;
    background: var(--card);
    object-fit: cover;
  }

  .about p {
    display: -webkit-box;
    margin: 4px 0 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 14px;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  @media (max-width: 560px) {
    .episode {
      grid-template-columns: 1fr auto;
    }

    .still {
      display: none;
    }
  }

  .note {
    color: var(--muted);
  }
</style>
