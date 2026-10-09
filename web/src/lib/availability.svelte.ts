// Stream availability from den-scout (EPIC-den-web §F2): whether a movie has anything to play, for the fade the TV
// gives a poster with nothing behind it. Asked a page of posters at a time. Scout answers from its verdicts at once
// and checks the rest behind the reply, so an unknown is asked again a little later — and never fades.
//
// Scout wants IMDb ids, so each movie's is resolved through the content Worker first. Series aren't asked: they need
// per-episode resolution. The web fades but never hides; hiding on scout's word is for a TV whose only stream addon
// is scout.

import { SvelteMap } from 'svelte/reactivity';
import type { Title } from './library';
import type { ContentServiceClientPort } from './contentServiceClient';
import type { Addon } from './scout';
import { relayFetch } from './relayFetch';
import { retryAfterMs } from './retryAfter';

type Verdict = 'available' | 'unavailable' | 'unknown';

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
const STORAGE_KEY = 'den.availability';
/** How long scout may take to answer a page of posters. */
const ANSWER_MS = 15_000;

export class Availability {
  /** By TMDB movie id. `unknown` here is final: no IMDb id, or scout never could tell. */
  private readonly verdicts = new SvelteMap<number, Verdict>();
  /** The movies scout answered for this visit; the rest of `verdicts` came from an earlier one and is asked again. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request bookkeeping; only verdicts are UI state.
  private readonly settled = new Set<number>();
  /** When each verdict was given, so a kept one expires. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Persistence bookkeeping; only verdicts are UI state.
  private readonly givenAt = new Map<number, number>();
  /** A movie's IMDb id, or null when its content record has none. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Lookup cache; only verdicts are UI state.
  private readonly imdbIds = new Map<number, string | null>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request scheduling must not subscribe the components that enqueue titles.
  private readonly wanted = new Set<number>();
  /** IDs in a content/scout ask, or deliberately waiting for their retry time. A virtualized card may remount many
   * times during either interval; it must not turn those mounts into duplicate requests or bypass the backoff. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request bookkeeping; only verdicts are UI state.
  private readonly pending = new Set<number>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Retry bookkeeping; only verdict changes are observable.
  private readonly tries = new Map<number, number>();
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
  private scout: { base: string; content: ContentServiceClientPort; fetch: typeof fetch } | null =
    null;

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
   */
  connect(
    scout: Addon | null,
    content: ContentServiceClientPort,
    fetchImpl: typeof fetch = relayFetch,
  ): void {
    const previous = this.scout?.base;
    this.scout = scout ? { base: scout.base, content, fetch: fetchImpl } : null;
    if (previous !== undefined && this.scout?.base !== previous) {
      this.generation++;
      clearTimeout(this.timer);
      this.timer = undefined;
      for (const timer of this.retryTimers) clearTimeout(timer);
      this.retryTimers.clear();
      for (const id of this.pending) this.wanted.add(id);
      this.pending.clear();
      this.asking = undefined;
      this.pausedUntil = 0;
      this.verdicts.clear();
      this.settled.clear();
      this.tries.clear();
    }
    this.gather();
  }

  /** A poster is showing: its movie is asked about along with the others showing now. */
  want(title: Pick<Title, 'type' | 'id' | 'imdbId'>): void {
    if (
      title.type !== 'movie' ||
      this.settled.has(title.id) ||
      this.wanted.has(title.id) ||
      this.pending.has(title.id)
    )
      return;
    // A title already carrying its IMDb id does not need a content query.
    if (title.imdbId) this.imdbIds.set(title.id, title.imdbId);
    this.wanted.add(title.id);
    this.gather();
  }

  /** Whether scout said this movie has nothing to play. */
  unavailable(title: Pick<Title, 'type' | 'id'>): boolean {
    return title.type === 'movie' && this.verdicts.get(title.id) === 'unavailable';
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
        const imdb = await this.imdbId(id, scout.content);
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

  private settle(id: number, verdict: Verdict): void {
    this.pending.delete(id);
    this.verdicts.set(id, verdict);
    this.settled.add(id);
    this.givenAt.set(id, this.now());
  }

  /** Scout's verdicts, for the next visit's posters. Unknowns aren't kept: they are asked again anyway. */
  private keep(): void {
    const kept: Record<string, [Verdict, number]> = {};
    for (const [id, verdict] of this.verdicts) {
      const at = this.givenAt.get(id);
      if (verdict !== 'unknown' && at !== undefined) kept[id] = [verdict, at];
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
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (generation !== this.generation) return;
      for (const id of retry) {
        this.pending.delete(id);
        this.wanted.add(id);
      }
      this.gather();
    }, RETRY_MS);
    this.retryTimers.add(timer);
  }

  private async imdbId(
    id: number,
    content: ContentServiceClientPort,
  ): Promise<string | null | undefined> {
    if (this.imdbIds.has(id)) return this.imdbIds.get(id);
    const answer = await content
      .query({ kind: 'title.external-id', title: { type: 'movie', id } })
      .catch(() => null);
    const imdb =
      answer?.imdbId.state === 'ready'
        ? answer.imdbId.value
        : answer?.imdbId.state === 'absent'
          ? null
          : undefined;
    if (imdb !== undefined) this.imdbIds.set(id, imdb);
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
