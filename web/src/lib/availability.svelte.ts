// Stream availability from den-scout (EPIC-den-web §F2): whether a title has anything to play, for the fade the TV
// gives a poster with nothing behind it.
//
// A page of movie and series posters is asked together through scout's `/availability`. Scout answers from its
// verdicts at once and checks the rest behind the reply, so an unknown is asked again a little later — and never
// fades. Scout wants IMDb ids (and `tt:S:E` for a series), so each title's is resolved through the content Worker
// first. A series asks one episode (`seriesAvailabilityEpisode`, the rule Apple TV and iOS take from DenKit's
// `SeriesAvailability`). The web fades but never hides; hiding on scout's word is for a TV whose only stream addon
// is scout.

import { SvelteMap } from 'svelte/reactivity';
import { untrack } from 'svelte';
import type { NewEpisode } from './airing';
import { airWindow } from './detailPresentation';
import type { Title } from './library';
import type { ContentServiceClientPort } from './contentServiceClient';
import type { Addon } from './scout';
import { relayFetch } from './relayFetch';
import { retryAfterMs } from './retryAfter';
import { localAuthorityKey } from './localAuthorityKey';

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

const episodeKey = (id: number, { season, episode }: Episode) => `${id}:${season}:${episode}`;
const verdictOf = (answer: Record<string, unknown>, id: string): Verdict => {
  const verdict = answer[id];
  return verdict === 'available' || verdict === 'unavailable' ? verdict : 'unknown';
};
type EpisodeProbe = Episode & { id: number };
type BatchTarget =
  { kind: 'movie'; id: number } | { kind: 'episode'; key: string; probe: EpisodeProbe };

/** Exact active viewer and household. Credential-bearing keys are admitted here but only the digest is persisted. */
export type AvailabilityAuthority = readonly [
  householdKind: string,
  householdKey: string | null,
  profile: string,
];

type KeptVerdicts = Record<string, [Verdict, number]>;
/** The opaque namespace of the authority that gave the verdicts, then the verdicts. */
type StoredVerdicts = [namespace: string, verdicts: KeptVerdicts];

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
  private readonly episodeWanted = new Map<string, EpisodeProbe>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request bookkeeping, as `pending`.
  private readonly episodePending = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Retry bookkeeping, as `tries`.
  private readonly episodeTries = new Map<string, number>();
  /** Each series' Continue Watching entry (`out` false while it waits for the episode), and its new episode. */
  private readonly continuing = new SvelteMap<number, Episode & { out: boolean }>();
  private readonly newEpisodes = new SvelteMap<number, Episode>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Only one availability batch asks upstream at once; new mounts gather behind it. */
  private asking: number | undefined;
  private askSerial = 0;
  /** The active batch request, cancelled when another configured scout supersedes it. */
  private request: AbortController | undefined;
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
  /** The household and profile the verdicts belong to (`activate`), as JSON. */
  private activeAuthority = JSON.stringify(['test', null, 'test']);
  /** The household, profile, scout install and base the verdicts are from; only a different one starts them over. */
  private answeredBy: string | undefined;
  /** `answeredBy` as the opaque digest the kept verdicts are stored under; unset until a scout is connected. */
  private namespace: string | undefined;

  /** Kept verdicts are restored by `connect`, once the exact household, profile and scout are known. */
  constructor(
    private readonly storage: Storage | undefined = typeof localStorage === 'undefined'
      ? undefined
      : localStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /** A different household or profile drops every verdict, request and timer of the previous one. */
  activate(authority: AvailabilityAuthority): void {
    const active = JSON.stringify(authority);
    if (active !== this.activeAuthority) this.reset();
    this.activeAuthority = active;
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
    this.scout = null;
    if (!scout) return;
    const exact = JSON.stringify([this.activeAuthority, scout.install, scout.base]);
    if (exact !== this.answeredBy) {
      this.reset();
      this.answeredBy = exact;
      this.namespace = localAuthorityKey(exact);
      this.restore();
    }
    this.scout = { base: scout.base, content, fetch: fetchImpl };
    this.gather();
  }

  /** Forget everything the previous authority gave, and abort what is asked of it. */
  private reset(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    for (const id of this.pending) this.wanted.add(id);
    this.pending.clear();
    this.asking = undefined;
    this.pausedUntil = 0;
    this.scout = null;
    this.answeredBy = undefined;
    this.namespace = undefined;
    this.verdicts.clear();
    this.settled.clear();
    this.givenAt.clear();
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

  /**
   * The last day's verdicts of this exact authority fade their posters at once, and scout is still asked. Rows of
   * another authority, and the unscoped rows written before verdicts were scoped, are removed unread.
   */
  private restore(): void {
    try {
      const stored = JSON.parse(
        this.storage?.getItem(STORAGE_KEY) ?? 'null',
      ) as StoredVerdicts | null;
      if (!stored || stored[0] !== this.namespace) {
        if (stored !== null) this.storage?.removeItem(STORAGE_KEY);
        return;
      }
      for (const [id, [verdict, at]] of Object.entries(stored[1])) {
        if (verdict === 'unknown' || !(this.now() - at < KEPT_MS)) continue;
        if (id.startsWith('tv:')) {
          this.episodeVerdicts.set(id.slice(3), verdict);
          this.episodeAnswers.set(id.slice(3), { at, settled: false });
          continue;
        }
        this.verdicts.set(Number(id), verdict);
        this.givenAt.set(Number(id), at);
      }
    } catch {
      // Unreadable or refused storage: this authority starts without retained verdicts.
    }
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
    this.gather();
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
    if (
      !this.scout ||
      this.asking !== undefined ||
      this.timer ||
      (this.wanted.size === 0 && this.episodeWanted.size === 0)
    )
      return;
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
    // When both kinds have a backlog, each gets half the batch: neither can sit behind several full pages of the
    // other. Spare capacity goes to movies, so one episode beside a large shelf still yields one full request.
    const episodeCapacity = this.wanted.size > 0 ? Math.floor(MAX_IDS / 2) : MAX_IDS;
    const episodes = [...this.episodeWanted].slice(0, episodeCapacity);
    const ids = [...this.wanted].slice(0, MAX_IDS - episodes.length);
    for (const id of ids) {
      this.wanted.delete(id);
      this.pending.add(id);
    }
    for (const [key] of episodes) {
      this.episodeWanted.delete(key);
      this.episodePending.add(key);
    }

    try {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local request accumulator, published through verdicts after the response.
      const byRequest = new Map<string, BatchTarget[]>();
      const again: number[] = [];
      const episodeAgain: [string, EpisodeProbe][] = [];
      const noImdb: number[] = [];
      const noEpisodeImdb: string[] = [];
      const targets: BatchTarget[] = [
        ...ids.map((id): BatchTarget => ({ kind: 'movie', id })),
        ...episodes.map(([key, probe]): BatchTarget => ({ kind: 'episode', key, probe })),
      ];
      await each(targets, LOOKUPS, async (target) => {
        const imdb = await this.imdbId(
          target.kind === 'movie' ? 'movie' : 'tv',
          target.kind === 'movie' ? target.id : target.probe.id,
          scout.content,
        );
        if (imdb === undefined) {
          if (target.kind === 'movie') again.push(target.id);
          else episodeAgain.push([target.key, target.probe]);
        } else if (imdb === null) {
          if (target.kind === 'movie') noImdb.push(target.id);
          else noEpisodeImdb.push(target.key);
        } else {
          const requestId =
            target.kind === 'movie'
              ? imdb
              : `${imdb}:${target.probe.season}:${target.probe.episode}`;
          const held = byRequest.get(requestId);
          if (held) held.push(target);
          else byRequest.set(requestId, [target]);
        }
      });
      if (generation !== this.generation) return;
      for (const id of noImdb) this.settle(id, 'unknown');
      for (const key of noEpisodeImdb) this.settleEpisode(key, 'unknown');

      let answer: Record<string, unknown> = {};
      let refused = false;
      if (byRequest.size > 0) {
        const controller = new AbortController();
        this.request = controller;
        const timeout = setTimeout(() => controller.abort(), ANSWER_MS);
        try {
          const res = await scout.fetch(`${scout.base}/availability`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: [...byRequest.keys()] }),
            signal: controller.signal,
          });
          if (res.status === 429) {
            refused = true;
            this.pausedUntil = this.now() + retryAfterMs(res, RETRY_MS, this.now);
          } else if (res.ok)
            answer =
              ((await res.json()) as { availability?: Record<string, unknown> }).availability ?? {};
        } catch {
          // Out of reach: every title stays unknown, and is asked again.
        } finally {
          clearTimeout(timeout);
          if (this.request === controller) this.request = undefined;
        }
      }
      if (generation !== this.generation) return;
      // Not an answer about any of them, and no try spent: asked again once the wait is over.
      if (refused)
        for (const targets of byRequest.values()) {
          for (const target of targets) {
            if (target.kind === 'movie') {
              this.pending.delete(target.id);
              this.wanted.add(target.id);
            } else {
              this.episodePending.delete(target.key);
              this.episodeWanted.set(target.key, target.probe);
            }
          }
        }
      else
        for (const [requestId, targets] of byRequest) {
          const verdict = verdictOf(answer, requestId);
          for (const target of targets) {
            if (target.kind === 'movie') {
              if (verdict === 'unknown') again.push(target.id);
              else this.settle(target.id, verdict);
            } else if (verdict === 'unknown') episodeAgain.push([target.key, target.probe]);
            else this.settleEpisode(target.key, verdict);
          }
        }
      this.keep();
      this.later(again);
      for (const [key, probe] of episodeAgain) this.episodeLater(key, probe);
    } catch {
      // A lookup implementation that unexpectedly rejects must not leave the IDs permanently pending.
      if (generation === this.generation) {
        this.later(ids.filter((id) => this.pending.has(id)));
        for (const [key, probe] of episodes)
          if (this.episodePending.has(key)) this.episodeLater(key, probe);
      }
    } finally {
      if (this.asking === run) this.asking = undefined;
      this.gather();
    }
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
    if (!this.namespace) return;
    const kept: KeptVerdicts = {};
    for (const [id, verdict] of this.verdicts) {
      const at = this.givenAt.get(id);
      if (verdict !== 'unknown' && at !== undefined) kept[id] = [verdict, at];
    }
    for (const [key, verdict] of this.episodeVerdicts) {
      const at = this.episodeAnswers.get(key)?.at;
      if (verdict !== 'unknown' && at !== undefined) kept[`tv:${key}`] = [verdict, at];
    }
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify([this.namespace, kept] satisfies StoredVerdicts),
      );
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

  private episodeLater(key: string, probe: EpisodeProbe): void {
    const tries = (this.episodeTries.get(key) ?? 0) + 1;
    this.episodeTries.set(key, tries);
    if (tries > RETRIES) {
      this.settleEpisode(key, 'unknown');
      return;
    }
    this.after(() => {
      this.episodePending.delete(key);
      this.episodeWanted.set(key, probe);
      this.gather();
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
