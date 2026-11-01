// Stream availability from den-scout (EPIC-den-web §F2): whether a title has anything to play, for the fade the TV
// gives a poster with nothing behind it.
//
// A movie is asked a page of posters at a time (scout's `/availability`). Scout answers from its verdicts at once and
// checks the rest behind the reply, so an unknown is asked again a little later — and never fades. Scout wants IMDb
// ids, so each title's is resolved through the content Worker first.
//
// A series is asked at one episode (`seriesAvailabilityEpisode`, the rule Apple TV and iOS take from DenKit's
// `SeriesAvailability`): one search of scout's stream list for that episode, never a play link. The web fades but
// never hides; hiding on scout's word is for a TV whose only stream addon is scout.

import { SvelteMap } from 'svelte/reactivity';
import { untrack } from 'svelte';
import type { NewEpisode } from './airing';
import { airWindow } from './detailPresentation';
import type { Title } from './library';
import type { ContentServiceClientPort } from './contentServiceClient';
import type { Addon } from './scout';
import { relayFetch } from './relayFetch';
import { retryAfterMs } from './retryAfter';
import { parseAnswer } from './sourceAnswer';

type Verdict = 'available' | 'unavailable' | 'unknown';
interface Episode {
  season: number;
  episode: number;
}
type Scout = { base: string; content: ContentServiceClientPort; fetch: typeof fetch };

/** Posters that mount together go in one request. */
const GATHER_MS = 50;
/** Scout's cap on ids per request. */
const MAX_IDS = 100;
/** Identifier lookups at once. */
const LOOKUPS = 6;
/** Series stream lists asked at once: each may take scout's whole scrape timeout. */
const EPISODE_ASKS = 4;
/** How long before asking again about a movie scout was still checking, and how many times. */
export const RETRY_MS = 10_000;
const RETRIES = 3;
/** How long a verdict from an earlier visit fades a poster before scout has been asked again. */
export const KEPT_MS = 24 * 60 * 60 * 1000;
/**
 * How long this visit trusts "nothing to play" before asking again: scout keeps that verdict for ten minutes, since a
 * just-released title gains streams within hours (`UNAVAILABLE_TTL`, den-hearth's scout/availability.rs). It keeps
 * "available" for 30 days, which outlasts any visit.
 */
export const UNAVAILABLE_MS = 10 * 60 * 1000;
const STORAGE_KEY = 'den.availability';
/** How long scout may take to answer a page of posters. */
const ANSWER_MS = 15_000;

/**
 * The one episode a series poster asks about, as DenKit's `SeriesAvailability.episode` names it for Apple TV and
 * iOS: a new episode found with sources, else the series' Continue Watching entry — not asked at all while that one is
 * still to come out — else S1E1 once the series has started airing. Undefined asks nothing, so nothing fades.
 */
export function seriesAvailabilityEpisode(
  {
    newEpisode,
    continuing,
    firstAired,
  }: { newEpisode?: Episode; continuing?: Episode & { out: boolean }; firstAired?: string },
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- A reading of the clock, never mutated.
  now = new Date(),
): Episode | undefined {
  if (newEpisode) return { season: newEpisode.season, episode: newEpisode.episode };
  if (continuing)
    return continuing.out ? { season: continuing.season, episode: continuing.episode } : undefined;
  return airWindow(firstAired, now) === 'aired' ? { season: 1, episode: 1 } : undefined;
}

/**
 * A stream list's verdict, as Apple TV reads its addons: any stream is "available"; none is "unavailable" only when
 * scout says every source answered (or is an older scout that says nothing). A list it could not complete, or held
 * through an outage, says nothing either way.
 */
export function listVerdict(body: unknown): Verdict {
  const streams = (body as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(streams)) return 'unknown';
  if (streams.length > 0) return 'available';
  const answer = parseAnswer(body);
  if (!answer) return 'unavailable';
  return (answer.kind === 'empty' || answer.kind === 'live') &&
    answer.missing === 0 &&
    !answer.outage
    ? 'unavailable'
    : 'unknown';
}

const episodeKey = (id: number, { season, episode }: Episode) => `${id}:${season}:${episode}`;

export class Availability {
  /** By TMDB movie id. `unknown` here is final: no IMDb id, or scout never could tell. */
  private readonly verdicts = new SvelteMap<number, Verdict>();
  /** The movies scout answered for this visit; the rest of `verdicts` came from an earlier one and is asked again. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request bookkeeping; only verdicts are UI state.
  private readonly settled = new Set<number>();
  /** When each verdict was given, so a kept one expires. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Persistence bookkeeping; only verdicts are UI state.
  private readonly givenAt = new Map<number, number>();
  /** A title's IMDb id by `type:id`, or null when its content record has none. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Lookup cache; only verdicts are UI state.
  private readonly imdbIds = new Map<string, string | null>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request scheduling must not subscribe the components that enqueue titles.
  private readonly wanted = new Set<number>();
  /** IDs in a content/scout ask, or deliberately waiting for their retry time. A virtualized card may remount many
   * times during either interval; it must not turn those mounts into duplicate requests or bypass the backoff. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request bookkeeping; only verdicts are UI state.
  private readonly pending = new Set<number>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Retry bookkeeping; only verdict changes are observable.
  private readonly tries = new Map<number, number>();
  /** A series' verdicts by `episodeKey`: the episode its poster asks about. */
  private readonly episodeVerdicts = new SvelteMap<string, Verdict>();
  /** When each episode verdict was given, and whether this visit's scout gave it. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Bookkeeping; only verdicts are UI state.
  private readonly episodeAnswers = new Map<string, { at: number; settled: boolean }>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request scheduling, as `wanted`.
  private readonly episodeWanted = new Map<string, Episode & { id: number }>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request bookkeeping, as `pending`.
  private readonly episodePending = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Retry bookkeeping, as `tries`.
  private readonly episodeTries = new Map<string, number>();
  private episodeAsks = 0;
  private episodeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Each series' Continue Watching entry (`out` false while it waits for the episode), and its new episode. */
  private readonly continuing = new SvelteMap<number, Episode & { out: boolean }>();
  private readonly newEpisodes = new SvelteMap<number, Episode>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Only one availability batch asks upstream at once; new mounts gather behind it. */
  private asking: number | undefined;
  private askSerial = 0;
  /** Invalidates old-service responses and retry timers when the configured scout changes. */
  private generation = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Timer cleanup bookkeeping, not UI state.
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Scout said "not now" (429) until then: nothing is asked before it. A refusal used to count as "still checking",
   * so each poster was asked again 10 s later, three times, and then never — whatever the wait scout gave.
   */
  private pausedUntil = 0;
  private scout: Scout | null = null;
  /** The scout the verdicts are from: only a different one starts them over, not a session that has none yet. */
  private answeredBy: string | undefined;

  /** The last day's verdicts from `storage` fade their posters at once, and scout is still asked. */
  constructor(
    private readonly storage: Storage | undefined = typeof localStorage === 'undefined'
      ? undefined
      : localStorage,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const kept = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') as Record<
        string,
        [Verdict, number]
      >;
      for (const [id, [verdict, at]] of Object.entries(kept)) {
        if (verdict === 'unknown' || !(now() - at < KEPT_MS)) continue;
        if (id.startsWith('tv:')) {
          this.episodeVerdicts.set(id.slice(3), verdict);
          this.episodeAnswers.set(id.slice(3), { at, settled: false });
          continue;
        }
        this.verdicts.set(Number(id), verdict);
        this.givenAt.set(Number(id), at);
      }
    } catch {
      // Unreadable or refused storage: this visit starts without them.
    }
  }

  /**
   * Ask this scout from now on — the library's (`findAddon`), or nobody when it has none.
   *
   * Through `relayFetch`: scout is asked under this origin, where den-edge relays it. The membership claim matters.
   * Without it a paired
   * household is a visitor to the relay, and on the public name the `/scout/` gate answers 404 — which
   * is what it did, silently, to every availability request a browser made there.
   *
   * `null` only pauses asking. Every new session's first configure says it (before its discovery has found scout
   * again), and a profile page opens several: wiping the verdicts and the answer in flight there sent the same
   * movies again as soon as the next session reconnected the same scout.
   */
  connect(
    scout: Addon | null,
    content: ContentServiceClientPort,
    fetchImpl: typeof fetch = relayFetch,
  ): void {
    this.scout = scout ? { base: scout.base, content, fetch: fetchImpl } : null;
    if (!scout) return;
    const previous = this.answeredBy;
    this.answeredBy = scout.base;
    if (previous !== undefined && scout.base !== previous) {
      this.generation++;
      clearTimeout(this.timer);
      this.timer = undefined;
      clearTimeout(this.episodeTimer);
      this.episodeTimer = undefined;
      for (const timer of this.retryTimers) clearTimeout(timer);
      this.retryTimers.clear();
      for (const id of this.pending) this.wanted.add(id);
      this.pending.clear();
      this.asking = undefined;
      this.pausedUntil = 0;
      this.verdicts.clear();
      this.settled.clear();
      this.tries.clear();
      for (const key of this.episodePending) {
        const [id, season, episode] = key.split(':').map(Number);
        this.episodeWanted.set(key, { id: id!, season: season!, episode: episode! });
      }
      this.episodePending.clear();
      this.episodeVerdicts.clear();
      this.episodeAnswers.clear();
      this.episodeTries.clear();
    }
    this.gather();
    this.pumpEpisodes();
  }

  /**
   * The library's Continue Watching entries and the new episodes found with sources (`NewEpisodes`): what each
   * series' poster asks about. Each series' entry is replaced only when it moved, so a poster re-derives for its
   * own series alone.
   */
  follow(
    entries: readonly {
      title: { type: string; id: number };
      episode?: Episode;
      upcoming?: string;
    }[],
    news: readonly NewEpisode[],
  ): void {
    untrack(() => {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Built whole for one comparison and discarded.
      const next = new Map<number, Episode & { out: boolean }>();
      for (const { title, episode, upcoming } of entries)
        if (title.type === 'tv' && episode && !next.has(title.id))
          next.set(title.id, { season: episode.season, episode: episode.episode, out: !upcoming });
      for (const id of this.continuing.keys()) if (!next.has(id)) this.continuing.delete(id);
      for (const [id, entry] of next) {
        const held = this.continuing.get(id);
        if (
          held?.season !== entry.season ||
          held.episode !== entry.episode ||
          held.out !== entry.out
        )
          this.continuing.set(id, entry);
      }
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Built whole for one comparison and discarded.
      const found = new Map(
        news.map(({ series, season, episode }) => [series, { season, episode }]),
      );
      for (const id of this.newEpisodes.keys()) if (!found.has(id)) this.newEpisodes.delete(id);
      for (const [id, episode] of found) {
        const held = this.newEpisodes.get(id);
        if (held?.season !== episode.season || held.episode !== episode.episode)
          this.newEpisodes.set(id, episode);
      }
    });
  }

  /** The episode this series' poster asks about now (`seriesAvailabilityEpisode`). */
  private episodeOf(title: Pick<Title, 'id' | 'releaseDate'>): Episode | undefined {
    return seriesAvailabilityEpisode(
      {
        newEpisode: this.newEpisodes.get(title.id),
        continuing: this.continuing.get(title.id),
        firstAired: title.releaseDate,
      },
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- A reading of the clock, never mutated.
      new Date(this.now()),
    );
  }

  /** A poster is showing: its title is asked about along with the others showing now. */
  want(title: Pick<Title, 'type' | 'id' | 'imdbId' | 'releaseDate'>): void {
    if (title.type === 'tv') {
      this.wantEpisode(title);
      return;
    }
    if (
      title.type !== 'movie' ||
      this.answered(title.id) ||
      this.wanted.has(title.id) ||
      this.pending.has(title.id)
    )
      return;
    // A title already carrying its IMDb id does not need a content query.
    if (title.imdbId) this.imdbIds.set(`movie:${title.id}`, title.imdbId);
    this.wanted.add(title.id);
    this.gather();
  }

  private wantEpisode(title: Pick<Title, 'id' | 'imdbId' | 'releaseDate'>): void {
    // Tracked: a poster's effect asks again when its series' episode moves on.
    const episode = this.episodeOf(title);
    if (!episode) return;
    const key = episodeKey(title.id, episode);
    if (this.episodeAnswered(key) || this.episodeWanted.has(key) || this.episodePending.has(key))
      return;
    if (title.imdbId) this.imdbIds.set(`tv:${title.id}`, title.imdbId);
    this.episodeWanted.set(key, { id: title.id, ...episode });
    this.pumpEpisodes();
  }

  /** Scout answered this visit, and the answer still stands (`UNAVAILABLE_MS`). */
  private answered(id: number): boolean {
    if (!this.settled.has(id)) return false;
    if (this.verdicts.get(id) !== 'unavailable') return true;
    return this.now() - (this.givenAt.get(id) ?? 0) < UNAVAILABLE_MS;
  }

  private episodeAnswered(key: string): boolean {
    const answer = this.episodeAnswers.get(key);
    if (!answer?.settled) return false;
    if (this.episodeVerdicts.get(key) !== 'unavailable') return true;
    return this.now() - answer.at < UNAVAILABLE_MS;
  }

  /** Whether scout said this title — a series at the episode its poster asks about — has nothing to play. */
  unavailable(title: Pick<Title, 'type' | 'id' | 'releaseDate'>): boolean {
    if (title.type === 'movie') return this.verdicts.get(title.id) === 'unavailable';
    if (title.type !== 'tv') return false;
    const episode = this.episodeOf(title);
    return !!episode && this.episodeVerdicts.get(episodeKey(title.id, episode)) === 'unavailable';
  }

  /**
   * An authoritative stream list — the title's Sources, or a new episode's search — heals the fade: one with
   * sources clears a stale "nothing to play" at once, without waiting for scout to be asked again.
   */
  confirm(
    title: Pick<Title, 'type' | 'id'>,
    episode: Episode | undefined,
    available: boolean,
  ): void {
    const verdict = available ? 'available' : 'unavailable';
    if (title.type === 'movie') this.settle(title.id, verdict);
    else if (title.type === 'tv' && episode) {
      const key = episodeKey(title.id, episode);
      this.episodeWanted.delete(key);
      this.settleEpisode(key, verdict);
    } else return;
    this.keep();
  }

  private gather(): void {
    if (!this.scout || this.asking !== undefined || this.timer || this.wanted.size === 0) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.ask();
      },
      Math.max(GATHER_MS, this.pausedUntil - this.now()),
    );
  }

  private async ask(): Promise<void> {
    const scout = this.scout;
    if (!scout || this.asking !== undefined) return;
    const run = ++this.askSerial;
    const generation = this.generation;
    this.asking = run;
    const ids = [...this.wanted].slice(0, MAX_IDS);
    for (const id of ids) {
      this.wanted.delete(id);
      this.pending.add(id);
    }

    try {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local request accumulator, published through verdicts after the response.
      const byImdb = new Map<string, number>();
      const again: number[] = [];
      const noImdb: number[] = [];
      await each(ids, LOOKUPS, async (id) => {
        const imdb = await this.imdbId('movie', id, scout.content);
        if (imdb === undefined) again.push(id);
        else if (imdb === null) noImdb.push(id);
        else byImdb.set(imdb, id);
      });
      if (generation !== this.generation) return;
      for (const id of noImdb) this.settle(id, 'unknown');

      let answer: Record<string, Verdict> = {};
      let refused = false;
      if (byImdb.size > 0) {
        try {
          const res = await scout.fetch(`${scout.base}/availability`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: [...byImdb.keys()] }),
            signal: AbortSignal.timeout(ANSWER_MS),
          });
          if (res.status === 429) {
            refused = true;
            this.pausedUntil = this.now() + retryAfterMs(res, RETRY_MS, this.now);
          } else if (res.ok)
            answer =
              ((await res.json()) as { availability?: Record<string, Verdict> }).availability ?? {};
        } catch {
          // Out of reach: every movie stays unknown, and is asked again.
        }
      }
      if (generation !== this.generation) return;
      // Not an answer about any of them, and no try spent: asked again once the wait is over.
      if (refused)
        for (const id of byImdb.values()) {
          this.pending.delete(id);
          this.wanted.add(id);
        }
      else
        for (const [imdb, id] of byImdb) {
          const verdict = answer[imdb] ?? 'unknown';
          if (verdict === 'unknown') again.push(id);
          else this.settle(id, verdict);
        }
      this.keep();
      this.later(again);
    } catch {
      // A lookup implementation that unexpectedly rejects must not leave the IDs permanently pending.
      if (generation === this.generation) this.later(ids.filter((id) => this.pending.has(id)));
    } finally {
      if (this.asking === run) this.asking = undefined;
      this.gather();
    }
  }

  /** Start the series asks waiting, a few at a time, once scout's last "not now" is over. */
  private pumpEpisodes(): void {
    const scout = this.scout;
    if (!scout || this.episodeTimer) return;
    const wait = this.pausedUntil - this.now();
    if (wait > 0) {
      if (this.episodeWanted.size)
        this.episodeTimer = setTimeout(() => {
          this.episodeTimer = undefined;
          this.pumpEpisodes();
        }, wait);
      return;
    }
    for (const [key, probe] of this.episodeWanted) {
      if (this.episodeAsks >= EPISODE_ASKS) return;
      this.episodeWanted.delete(key);
      this.episodePending.add(key);
      this.episodeAsks++;
      void this.askEpisode(key, probe, scout).finally(() => {
        this.episodeAsks--;
        this.pumpEpisodes();
      });
    }
  }

  /** One search of scout's stream list for the episode — the list only: no release is fetched or played. */
  private async askEpisode(
    key: string,
    probe: Episode & { id: number },
    scout: Scout,
  ): Promise<void> {
    const generation = this.generation;
    let verdict: Verdict = 'unknown';
    try {
      const imdb = await this.imdbId('tv', probe.id, scout.content);
      if (generation !== this.generation) return;
      if (imdb === null) {
        this.settleEpisode(key, 'unknown');
        return;
      }
      if (imdb !== undefined) {
        const id = encodeURIComponent(`${imdb}:${probe.season}:${probe.episode}`);
        const res = await scout.fetch(`${scout.base}/stream/series/${id}.json`, {
          signal: AbortSignal.timeout(ANSWER_MS),
        });
        if (generation !== this.generation) return;
        if (res.status === 429) {
          this.pausedUntil = this.now() + retryAfterMs(res, RETRY_MS, this.now);
          this.episodePending.delete(key);
          this.episodeWanted.set(key, probe);
          return;
        }
        if (res.ok) verdict = listVerdict(await res.json());
      }
    } catch {
      // Out of reach: unknown, and asked again.
    }
    if (generation !== this.generation) return;
    if (verdict === 'unknown') this.episodeLater(key, probe);
    else this.settleEpisode(key, verdict);
    this.keep();
  }

  private settle(id: number, verdict: Verdict): void {
    this.pending.delete(id);
    this.verdicts.set(id, verdict);
    this.settled.add(id);
    this.givenAt.set(id, this.now());
  }

  private settleEpisode(key: string, verdict: Verdict): void {
    this.episodePending.delete(key);
    this.episodeVerdicts.set(key, verdict);
    this.episodeAnswers.set(key, { at: this.now(), settled: true });
  }

  /** Scout's verdicts, for the next visit's posters. Unknowns aren't kept: they are asked again anyway. */
  private keep(): void {
    const kept: Record<string, [Verdict, number]> = {};
    for (const [id, verdict] of this.verdicts) {
      const at = this.givenAt.get(id);
      if (verdict !== 'unknown' && at !== undefined) kept[id] = [verdict, at];
    }
    for (const [key, verdict] of this.episodeVerdicts) {
      const at = this.episodeAnswers.get(key)?.at;
      if (verdict !== 'unknown' && at !== undefined) kept[`tv:${key}`] = [verdict, at];
    }
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(kept));
    } catch {
      // Refused storage: the verdicts are this visit's.
    }
  }

  /** Ask again after scout has had time to check — until the tries run out, when unknown is the answer. */
  private later(ids: number[]): void {
    const retry = ids.filter((id) => {
      const tries = (this.tries.get(id) ?? 0) + 1;
      this.tries.set(id, tries);
      if (tries > RETRIES) this.settle(id, 'unknown');
      return tries <= RETRIES;
    });
    if (retry.length === 0) return;
    this.after(() => {
      for (const id of retry) {
        this.pending.delete(id);
        this.wanted.add(id);
      }
      this.gather();
    });
  }

  private episodeLater(key: string, probe: Episode & { id: number }): void {
    const tries = (this.episodeTries.get(key) ?? 0) + 1;
    this.episodeTries.set(key, tries);
    if (tries > RETRIES) {
      this.settleEpisode(key, 'unknown');
      return;
    }
    this.after(() => {
      this.episodePending.delete(key);
      this.episodeWanted.set(key, probe);
      this.pumpEpisodes();
    });
  }

  /** `run` after `RETRY_MS`, unless the scout changes first. */
  private after(run: () => void): void {
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (generation === this.generation) run();
    }, RETRY_MS);
    this.retryTimers.add(timer);
  }

  private async imdbId(
    type: 'movie' | 'tv',
    id: number,
    content: ContentServiceClientPort,
  ): Promise<string | null | undefined> {
    const key = `${type}:${id}`;
    if (this.imdbIds.has(key)) return this.imdbIds.get(key);
    const answer = await content
      .query({ kind: 'title.external-id', title: { type, id } })
      .catch(() => null);
    const imdb =
      answer?.imdbId.state === 'ready'
        ? answer.imdbId.value
        : answer?.imdbId.state === 'absent'
          ? null
          : undefined;
    if (imdb !== undefined) this.imdbIds.set(key, imdb);
    return imdb;
  }
}

async function each<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

export const availability = new Availability();
