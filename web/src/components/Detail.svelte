<!-- A title's page, as the TV's Detail: the backdrop, what it is, the library controls, its seasons with the
     episodes you've seen, the cast, and more like it. -->
<script lang="ts">
  import { fetchDetail, fetchSeason, type Episode, type TitleDetail } from '../lib/detail';
  import type { MediaType, Title } from '../lib/library';
  import { compareStamps, type EpisodeRow, type TitleRow } from '../lib/wire';
  import PersonCard from './PersonCard.svelte';
  import PosterCard from './PosterCard.svelte';
  import PosterRow from './PosterRow.svelte';
  import TitleActions from './TitleActions.svelte';
  import Trailer from './Trailer.svelte';

  type Reaction = TitleRow['reaction']['value'];

  let {
    ref,
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
  /** Its trailer is showing. */
  let trailer = $state(false);

  $effect(() => {
    const [current, key] = [ref, tmdbKey];
    detail = undefined;
    season = null;
    trailer = false;
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
  <p class="note">Loading…</p>
{:else if detail === null}
  <p class="note">Couldn’t load this title from TMDB. Try again in a moment.</p>
{:else}
  {@const d = detail}
  <header class="hero">
    {#if d.backdropPath}
      <img class="backdrop" src="https://image.tmdb.org/t/p/w1280{d.backdropPath}" alt="" />
    {/if}
    <div class="head">
      {#if d.title.posterPath}
        <img class="poster" src="https://image.tmdb.org/t/p/w342{d.title.posterPath}" alt="" />
      {/if}
      <div>
        <h1>{d.title.title}</h1>
        <p class="facts">{facts(d)}</p>
        {#if d.tagline}<p class="tagline">{d.tagline}</p>{/if}
      </div>
    </div>
  </header>

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
    ontrailer={d.trailer ? () => (trailer = true) : undefined}
  />
  {#if trailer && d.trailer}
    <Trailer key={d.trailer} title={d.title.title} onclose={() => (trailer = false)} />
  {/if}
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
        <p class="note">Loading episodes…</p>
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
    position: relative;
    margin: -28px calc(-1 * var(--gutter)) 24px;
    padding: clamp(120px, 28vw, 320px) var(--gutter) 0;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    z-index: -1;
    width: 100%;
    height: 100%;
    object-fit: cover;
    mask-image: linear-gradient(to bottom, #000 40%, transparent);
    opacity: 0.55;
  }

  .head {
    display: flex;
    gap: 20px;
    align-items: end;
  }

  .poster {
    width: clamp(96px, 22vw, 180px);
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
