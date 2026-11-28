import { localDay, newEpisodesRequest, type Airing } from './airing';
import type { AiringStore } from './airing.svelte';
import type { ContentServiceClientPort } from './contentServiceClient';
import { deriveUpdates, type UpdateEvent, type UpdateFacts } from './follows';
import type { Title } from './library';
import type { SettingsView } from './libraryServiceProtocol';

/** People's filmographies asked for at once while reconciling. */
const PEOPLE_AT_ONCE = 4;

export interface ShownUpdate extends UpdateEvent {
  card: Title;
}

/**
 * The profile's updates (den-spec follows-v1), shown on Home: its follows and marks come from the library's settings
 * view, the facts from the caches every other surface reads (atlas's airing, the content worker's titles and
 * filmographies). Reconciled when asked, which the page does on coming to the foreground, never on a timer.
 * Only events whose title the content worker returns under the profile's policy are shown (follows-v1 §4).
 */
export class UpdatesStore {
  #facts = $state.raw<UpdateFacts>({});
  #cards = $state.raw<Readonly<Record<string, Title>>>({});
  #state = $state<'idle' | 'checking' | 'ready' | 'failed'>('idle');
  #run = 0;

  constructor(
    private readonly settings: () =>
      Readonly<Pick<SettingsView, 'follows' | 'updates'>> | undefined,
    private readonly content: ContentServiceClientPort,
    private readonly airing: AiringStore,
  ) {}

  get follows(): Readonly<Record<string, number>> {
    return this.settings()?.follows ?? {};
  }

  get state() {
    return this.#state;
  }

  following(key: string): boolean {
    return this.follows[key] !== undefined;
  }

  get events(): ShownUpdate[] {
    const derived = deriveUpdates(
      localDay(),
      this.follows,
      this.#facts,
      this.settings()?.updates ?? {},
    );
    return derived.events.flatMap((event) => {
      const card = this.#cards[`${event.title.type}:${event.title.id}`];
      return card ? [{ ...event, card }] : [];
    });
  }

  /** Home's row: the unread events, newest first, one for each title (follows-v1 §3's newest for it). */
  get row(): ShownUpdate[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Built whole for one read and discarded.
    const seen = new Set<string>();
    return this.events.filter((event) => {
      const key = `${event.title.type}:${event.title.id}`;
      if (event.read || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** The ids of every unread event of one title: what opening it marks read. */
  unreadIds(type: string, id: number): string[] {
    return this.events
      .filter((event) => !event.read && event.title.type === type && event.title.id === id)
      .map((event) => event.id);
  }

  close(): void {
    this.#run++;
  }

  /** Ask for every followed title's facts again, through the shared caches, and derive the list from them. */
  async reconcile(): Promise<void> {
    const run = ++this.#run;
    const keys = Object.keys(this.follows);
    if (!keys.length) {
      this.#facts = {};
      this.#cards = {};
      this.#state = 'ready';
      return;
    }
    this.#state = 'checking';
    const ids = (kind: string) =>
      keys.filter((key) => key.startsWith(`${kind}:`)).map((key) => Number(key.split(':')[1]));
    const [series, films, people] = [ids('tv'), ids('movie'), ids('person')];
    let failures = 0;
    const facts: Required<UpdateFacts> = { airing: {}, released: {}, films: {}, credits: {} };
    await this.airing.follow(series.map((tmdb) => ({ tmdb }))).catch(() => failures++);
    const observedAt = Date.now();
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Built whole for one request and discarded.
    const airings: ReadonlyMap<number, Airing> = new Map(
      series.flatMap((id) => {
        const airing = this.airing.get(id);
        return airing ? [[id, airing] as const] : [];
      }),
    );
    for (const [id, airing] of airings) facts.airing[id] = { ...airing, observedAt };
    if (airings.size) {
      // Each followed series' newest episode out is den-core's to say, as for Home's New badge (`new_episodes`).
      const none: number[] = [];
      const request = newEpisodesRequest(
        { watchlist: airings.keys(), continuing: [], caughtUp: none, seen: none, dismissed: none },
        airings,
      );
      const answer = await this.content
        .query({ kind: 'new.episodes', ...request })
        .catch(() => null);
      if (!answer) failures++;
      for (const { series: id, season, episode } of answer?.answer.released ?? [])
        facts.released[id] = { season, episode };
    }
    if (films.length) {
      const answer = await this.content
        .query({ kind: 'titles', titles: films.map((id) => ({ type: 'movie' as const, id })) })
        .catch(() => null);
      if (!answer) failures++;
      for (const title of answer?.titles ?? [])
        facts.films[title.id] = { date: title.releaseDate, observedAt: Date.now() };
    }
    for (let at = 0; at < people.length; at += PEOPLE_AT_ONCE)
      await Promise.all(
        people.slice(at, at + PEOPLE_AT_ONCE).map(async (id) => {
          const answer = await this.content
            .query({ kind: 'person.filmography', id })
            .catch(() => null);
          if (!answer) failures++;
          if (answer?.credits.state !== 'ready') return;
          facts.credits[id] = {
            observedAt: Date.now(),
            titles: answer.credits.value.map(({ title }) => ({
              type: title.type,
              id: title.id,
              date: title.releaseDate,
            })),
          };
        }),
      );
    if (run !== this.#run) return;
    // Every event the facts hold, read or not: the cards are what the policy lets this profile see.
    const titles: Record<string, { type: 'movie' | 'tv'; id: number }> = {};
    for (const event of deriveUpdates(localDay(), this.follows, facts).events)
      titles[`${event.title.type}:${event.title.id}`] = event.title;
    const cards: Record<string, Title> = { ...this.#cards };
    if (Object.keys(titles).length) {
      const answer = await this.content
        .query({ kind: 'titles', titles: Object.values(titles).slice(0, 512) })
        .catch(() => null);
      if (!answer) failures++;
      for (const card of answer?.titles ?? []) cards[`${card.type}:${card.id}`] = card;
    }
    if (run !== this.#run) return;
    this.#facts = facts;
    this.#cards = cards;
    // A partial answer still lists what it holds; only nothing at all, and some request failing, is a failure.
    const held =
      Object.keys(facts.airing).length +
      Object.keys(facts.films).length +
      Object.keys(facts.credits).length;
    this.#state = failures && !held ? 'failed' : 'ready';
  }
}
