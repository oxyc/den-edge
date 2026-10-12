import { WATCHED } from './actions';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { WatchedEntry, SeenEpisode } from './history';
import { titleKey, type ContinueEntry, type Title } from './library';
import { titleViewRows } from './libraryViewPresentation';
import type { Reaction, TitleRef, TitleView } from './libraryServiceProtocol';
import type { EpisodeRow, TitleRow } from './wire';

export interface VisitorActivityStore {
  get(key: string): unknown;
  set(key: string, value: null | boolean | number | string | unknown[] | object): void;
}

/** The intentionally small activity surface Library presentation may receive from an active profile. */
export interface ProfileActivity {
  readonly titles: readonly Title[];
  readonly watchlist: readonly Title[];
  readonly continueWatching: readonly ContinueEntry[];
  readonly history: readonly WatchedEntry[];
  readonly watchedKeys: ReadonlySet<string>;
  readonly standings: ReadonlyMap<string, 'watchlist' | 'watched' | 'inProgress'>;
  seenEpisodes(): ReadonlyMap<string, readonly SeenEpisode[]>;
  row(title: Title): TitleRow | undefined;
  rows(title: Title): { row: TitleRow | undefined; episodes: Map<string, EpisodeRow> };
  setWatchlisted(title: Title, on: boolean): Promise<{ delivery: 'local' }>;
  setReaction(title: Title, reaction: Reaction | null): Promise<{ delivery: 'local' }>;
  setWatched(title: Title, watched: boolean): Promise<{ delivery: 'local' }>;
  setEpisodeWatched(
    title: Title,
    season: number,
    episode: number,
    watched: boolean,
  ): Promise<{ delivery: 'local' }>;
  setSeasonWatched(
    title: Title,
    season: number,
    episodes: readonly number[],
    watched: boolean,
  ): Promise<{ delivery: 'local' }>;
  recordProgress(
    title: Title,
    fraction: number,
    seconds: number,
    episode?: { season: number; episode: number },
  ): Promise<{ delivery: 'local' }>;
  setContinueDismissed(title: Title, dismissed: boolean): Promise<{ delivery: 'local' }>;
}

type Progress = { fraction: number; seconds?: number; updatedAt: number };
type EpisodeActivity = Progress & { watched: boolean; season: number; episode: number };
type TitleActivity = {
  title: Title;
  watchlisted: boolean;
  watched: boolean;
  reaction: Reaction | null;
  dismissed: boolean;
  watchedAt?: number;
  progress?: Progress;
  episodes: Record<string, EpisodeActivity>;
};
type StoredActivity = { version: 1; titles: Record<string, TitleActivity> };

const STORAGE_KEY = 'activity';

const empty = (): StoredActivity => ({ version: 1, titles: {} });

/**
 * Visitor's complete activity authority. It deliberately exposes only the presentation and commands already used by
 * the web UI: there is no library key, transport, tracker, assistant, companion, or recommendation projection here.
 */
export class VisitorActivityProjection implements ProfileActivity {
  #state: StoredActivity;
  #revision = $state(0);

  constructor(private readonly store: VisitorActivityStore) {
    const stored = store.get(STORAGE_KEY);
    this.#state = this.#read(stored);
  }

  get titles(): readonly Title[] {
    this.#observe();
    return Object.values(this.#state.titles).map(({ title }) => structuredClone(title));
  }

  get watchlist(): readonly Title[] {
    this.#observe();
    return this.#ordered((activity) => activity.watchlisted).map(({ title }) => title);
  }

  get continueWatching(): readonly ContinueEntry[] {
    this.#observe();
    const entries: ContinueEntry[] = [];
    for (const activity of Object.values(this.#state.titles)) {
      if (activity.dismissed || activity.watched) continue;
      if (activity.title.type === 'movie') {
        const progress = activity.progress;
        if (progress && progress.fraction > 0 && progress.fraction < WATCHED)
          entries.push({
            title: activity.title,
            fraction: progress.fraction,
            seconds: progress.seconds,
            at: progress.updatedAt,
          });
        continue;
      }
      const episode = Object.values(activity.episodes)
        .filter(({ watched, fraction }) => !watched && fraction > 0 && fraction < WATCHED)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (episode)
        entries.push({
          title: activity.title,
          fraction: episode.fraction,
          episode: { season: episode.season, episode: episode.episode },
          seconds: episode.seconds,
          at: episode.updatedAt,
        });
    }
    return entries.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
  }

  get history(): readonly WatchedEntry[] {
    this.#observe();
    const entries: WatchedEntry[] = [];
    for (const activity of Object.values(this.#state.titles)) {
      const seen = Object.values(activity.episodes).filter(({ watched }) => watched);
      const latest = seen.sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!activity.watched && !latest) continue;
      entries.push({
        title: activity.title,
        at: Math.max(activity.watchedAt ?? 0, latest?.updatedAt ?? 0),
        ...(latest ? { episode: { season: latest.season, episode: latest.episode } } : {}),
        episodes: seen.length,
      });
    }
    return entries.sort(
      (left, right) =>
        right.at - left.at || titleKey(left.title).localeCompare(titleKey(right.title)),
    );
  }

  get watchedKeys(): ReadonlySet<string> {
    this.#observe();
    return new SvelteSet(
      Object.entries(this.#state.titles)
        .filter(([, activity]) => activity.watched)
        .map(([key]) => key),
    );
  }

  get standings(): ReadonlyMap<string, 'watchlist' | 'watched' | 'inProgress'> {
    this.#observe();
    const standings = new SvelteMap<string, 'watchlist' | 'watched' | 'inProgress'>();
    for (const [key, activity] of Object.entries(this.#state.titles)) {
      if (activity.watched) standings.set(key, 'watched');
      else if (this.#inProgress(activity)) standings.set(key, 'inProgress');
      else if (activity.watchlisted) standings.set(key, 'watchlist');
    }
    return standings;
  }

  seenEpisodes(): ReadonlyMap<string, readonly SeenEpisode[]> {
    this.#observe();
    return new SvelteMap(
      Object.entries(this.#state.titles).flatMap(([key, activity]) => {
        const seen = Object.values(activity.episodes)
          .filter(({ watched }) => watched)
          .map(({ season, episode }) => ({ season, episode }));
        return seen.length ? [[key, seen] as const] : [];
      }),
    );
  }

  row(title: Title): TitleRow | undefined {
    const activity = this.#activity(title);
    return activity ? titleViewRows(activity.title, this.#view(activity)).row : undefined;
  }

  rows(title: Title): { row: TitleRow | undefined; episodes: Map<string, EpisodeRow> } {
    const activity = this.#activity(title);
    return activity
      ? titleViewRows(activity.title, this.#view(activity))
      : { row: undefined, episodes: new SvelteMap() };
  }

  async setWatchlisted(title: Title, on: boolean): Promise<{ delivery: 'local' }> {
    const activity = this.#ensure(title);
    activity.watchlisted = on;
    this.#save();
    return { delivery: 'local' };
  }

  async setReaction(title: Title, reaction: Reaction | null): Promise<{ delivery: 'local' }> {
    this.#ensure(title).reaction = reaction;
    this.#save();
    return { delivery: 'local' };
  }

  async setWatched(title: Title, watched: boolean): Promise<{ delivery: 'local' }> {
    const activity = this.#ensure(title);
    activity.watched = watched;
    activity.watchedAt = watched ? Date.now() : undefined;
    activity.watchlisted = watched ? false : activity.watchlisted;
    activity.progress = watched ? { fraction: 1, updatedAt: activity.watchedAt! } : undefined;
    if (!watched && title.type === 'tv') activity.episodes = {};
    this.#save();
    return { delivery: 'local' };
  }

  async setEpisodeWatched(
    title: Title,
    season: number,
    episode: number,
    watched: boolean,
  ): Promise<{ delivery: 'local' }> {
    const activity = this.#ensure(title);
    const key = `${season}:${episode}`;
    if (watched) {
      activity.episodes[key] = {
        season,
        episode,
        watched: true,
        fraction: 1,
        updatedAt: Date.now(),
      };
      activity.watchlisted = false;
    } else delete activity.episodes[key];
    activity.watched = false;
    activity.dismissed = false;
    this.#save();
    return { delivery: 'local' };
  }

  async setSeasonWatched(
    title: Title,
    season: number,
    episodes: readonly number[],
    watched: boolean,
  ): Promise<{ delivery: 'local' }> {
    for (const episode of episodes) await this.setEpisodeWatched(title, season, episode, watched);
    return { delivery: 'local' };
  }

  async recordProgress(
    title: Title,
    fraction: number,
    seconds: number,
    episode?: { season: number; episode: number },
  ): Promise<{ delivery: 'local' }> {
    const activity = this.#ensure(title);
    const updatedAt = Date.now();
    activity.dismissed = false;
    activity.watchlisted = false;
    if (episode) {
      activity.watched = false;
      activity.episodes[`${episode.season}:${episode.episode}`] = {
        ...episode,
        fraction,
        seconds,
        updatedAt,
        watched: fraction >= WATCHED,
      };
    } else {
      activity.progress = { fraction, seconds, updatedAt };
      activity.watched = fraction >= WATCHED;
      activity.watchedAt = activity.watched ? updatedAt : undefined;
    }
    this.#save();
    return { delivery: 'local' };
  }

  async setContinueDismissed(title: Title, dismissed: boolean): Promise<{ delivery: 'local' }> {
    this.#ensure(title).dismissed = dismissed;
    this.#save();
    return { delivery: 'local' };
  }

  #view(activity: TitleActivity): TitleView {
    const progress = activity.progress;
    return {
      kind: 'title',
      title: { type: activity.title.type, id: activity.title.id },
      listed:
        activity.watchlisted ||
        activity.watched ||
        this.#inProgress(activity) ||
        activity.reaction !== null,
      watched: activity.watched,
      reaction: activity.reaction,
      standing: activity.watched
        ? 'watched'
        : this.#inProgress(activity)
          ? 'in-progress'
          : activity.watchlisted
            ? 'watchlist'
            : null,
      progress: progress
        ? { fraction: progress.fraction, seconds: progress.seconds, updatedAt: progress.updatedAt }
        : null,
      episodes: Object.values(activity.episodes).map((item) => ({
        season: item.season,
        episode: item.episode,
        watched: item.watched,
        fraction: item.fraction,
        seconds: item.seconds,
        updatedAt: item.updatedAt,
      })),
    };
  }

  #activity(ref: TitleRef): TitleActivity | undefined {
    this.#observe();
    return this.#state.titles[titleKey(ref)];
  }

  #ensure(title: Title): TitleActivity {
    const key = titleKey(title);
    const existing = this.#state.titles[key];
    if (existing) {
      existing.title = structuredClone(title);
      return existing;
    }
    const created: TitleActivity = {
      title: structuredClone(title),
      watchlisted: false,
      watched: false,
      reaction: null,
      dismissed: false,
      episodes: {},
    };
    this.#state.titles[key] = created;
    return created;
  }

  #ordered(predicate: (activity: TitleActivity) => boolean): TitleActivity[] {
    return Object.values(this.#state.titles)
      .filter(predicate)
      .sort((left, right) => this.#updatedAt(right) - this.#updatedAt(left));
  }

  #updatedAt(activity: TitleActivity): number {
    return Math.max(
      activity.watchedAt ?? 0,
      activity.progress?.updatedAt ?? 0,
      ...Object.values(activity.episodes).map(({ updatedAt }) => updatedAt),
    );
  }

  #inProgress(activity: TitleActivity): boolean {
    return (
      (!!activity.progress &&
        activity.progress.fraction > 0 &&
        activity.progress.fraction < WATCHED) ||
      Object.values(activity.episodes).some(
        ({ fraction, watched }) => !watched && fraction > 0 && fraction < WATCHED,
      )
    );
  }

  #save(): void {
    this.store.set(STORAGE_KEY, this.#state);
    this.#revision++;
  }

  #observe(): void {
    void this.#revision;
  }

  #read(value: unknown): StoredActivity {
    if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1)
      return empty();
    const stored = (value as { titles?: unknown }).titles;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return empty();
    const restored = empty();
    for (const candidate of Object.values(stored)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const raw = candidate as Record<string, unknown>;
      const title = raw.title;
      if (!title || typeof title !== 'object' || Array.isArray(title)) continue;
      const ref = title as Record<string, unknown>;
      if (
        (ref.type !== 'movie' && ref.type !== 'tv') ||
        typeof ref.id !== 'number' ||
        !Number.isInteger(ref.id) ||
        typeof ref.title !== 'string'
      )
        continue;
      const episodes: Record<string, EpisodeActivity> = {};
      if (raw.episodes && typeof raw.episodes === 'object' && !Array.isArray(raw.episodes)) {
        for (const episode of Object.values(raw.episodes)) {
          const parsed = this.#episode(episode);
          if (parsed) episodes[`${parsed.season}:${parsed.episode}`] = parsed;
        }
      }
      const reaction = raw.reaction;
      const activity: TitleActivity = {
        title: structuredClone(title) as Title,
        watchlisted: raw.watchlisted === true,
        watched: raw.watched === true,
        reaction:
          reaction === 'seen' ||
          reaction === 'dislike' ||
          reaction === 'like' ||
          reaction === 'love'
            ? reaction
            : null,
        dismissed: raw.dismissed === true,
        episodes,
      };
      const progress = this.#progress(raw.progress);
      if (progress) activity.progress = progress;
      if (typeof raw.watchedAt === 'number' && Number.isFinite(raw.watchedAt))
        activity.watchedAt = raw.watchedAt;
      restored.titles[titleKey(activity.title)] = activity;
    }
    return restored;
  }

  #progress(value: unknown): Progress | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.fraction !== 'number' ||
      !Number.isFinite(raw.fraction) ||
      raw.fraction < 0 ||
      raw.fraction > 1 ||
      typeof raw.updatedAt !== 'number' ||
      !Number.isFinite(raw.updatedAt) ||
      (raw.seconds !== undefined &&
        (typeof raw.seconds !== 'number' || !Number.isFinite(raw.seconds)))
    )
      return undefined;
    return {
      fraction: raw.fraction,
      updatedAt: raw.updatedAt,
      ...(typeof raw.seconds === 'number' ? { seconds: raw.seconds } : {}),
    };
  }

  #episode(value: unknown): EpisodeActivity | undefined {
    const progress = this.#progress(value);
    if (!progress || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.season !== 'number' ||
      !Number.isInteger(raw.season) ||
      typeof raw.episode !== 'number' ||
      !Number.isInteger(raw.episode)
    )
      return undefined;
    return {
      ...progress,
      season: raw.season,
      episode: raw.episode,
      watched: raw.watched === true,
    };
  }
}
