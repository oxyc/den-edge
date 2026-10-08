import {
  RESUME_FLOOR,
  WATCHED,
  addToWatchlist,
  blankEpisode,
  blankTitle,
  dismissFromContinueWatching,
  markEpisode,
  markWatched,
  react,
  removeFromLibrary,
  restoreToContinueWatching,
  unwatch,
  unwatchSeries,
  updateEpisodeProgress,
  updateProgress,
} from './actions';
import type { ClockStore } from './clockStore';
import { episodeProgress } from './detailPresentation';
import { isAired, titleKey, type Shape } from './library';
import type {
  EpisodeRef,
  LibraryCommand,
  LibraryObservation,
  LibraryQuery,
  LibraryQueryResult,
  LibrarySelection,
  LibrarySelectionValue,
  LibraryServiceErrorCode,
  Standing,
  TitleRef,
  TitleView,
} from './libraryServiceProtocol';
import {
  LibraryServiceAuthorityError,
  type LibraryAuthorityCommandResult,
  type LibraryAuthorityObservationResult,
  type LibrarySelectionScope,
} from './libraryServiceCore';
import { LibraryLog } from './log';
import { recordTrackerEvent } from './trackerEvents';
import { compareStamps, type EpisodeRow, type SettingsRow, type TitleRow } from './wire';

type Delivery = 'synced' | 'queued' | 'local';

export type LibraryAffectedSelection = LibrarySelectionScope;

const authorityError = (
  code: LibraryServiceErrorCode,
  message: string,
  retryable = false,
): LibraryServiceAuthorityError => new LibraryServiceAuthorityError({ code, message, retryable });

interface StoredShape {
  shape: Shape;
  digest: string;
}

export interface LibraryLogAuthorityOptions {
  /** `local` is a library opened with `LibraryLog.openLocal`; every other log is `online`. */
  mode: 'online' | 'local';
}

const sameTitle = (a: TitleRef, b: TitleRef): boolean => a.type === b.type && a.id === b.id;

const effectiveStanding = (
  row: TitleRow | undefined,
  episodes: readonly TitleView['episodes'][number][],
): Standing | null => {
  if (!row || row.deleted.value || row.status.value === 'none')
    return episodes.some(({ fraction }) => fraction > 0) ? 'in-progress' : null;
  if (row.status.value === 'watchlist' && episodes.some(({ fraction }) => fraction > 0))
    return 'in-progress';
  return row.status.value === 'inProgress' ? 'in-progress' : row.status.value;
};

/**
 * The production domain boundary around one `LibraryLog`.
 *
 * Rows, stamps and tracker journals never cross it. The service observes title layouts, accepts semantic commands,
 * and publishes immutable render-facing values. `LibraryServiceCore` remains responsible for request ordering,
 * revisions and subscriptions.
 */
export class LibraryLogAuthority {
  readonly #shapes = new Map<string, StoredShape>();
  readonly #log: LibraryLog;
  readonly #clock: ClockStore;
  readonly #options: LibraryLogAuthorityOptions;

  constructor(log: LibraryLog, clock: ClockStore, options: LibraryLogAuthorityOptions) {
    this.#log = log;
    this.#clock = clock;
    this.#options = options;
  }

  get generation(): string | null {
    return this.#log.currentGeneration ?? null;
  }

  async select(selection: LibrarySelection): Promise<LibrarySelectionValue> {
    if (selection.kind !== 'title')
      throw authorityError(
        'invalid-request',
        `${selection.kind} selection is not implemented by the log authority`,
      );
    return this.#title(selection.title);
  }

  async command(
    command: LibraryCommand,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    this.#writable();
    switch (command.kind) {
      case 'watchlist.add':
        return this.#titleAction(
          command.title,
          operationId,
          (row, at) => addToWatchlist(row, at),
          (row) =>
            !row.deleted.value &&
            (row.status.value === 'watchlist' || row.status.value === 'inProgress'),
        );
      case 'library.remove':
        return this.#titleAction(
          command.title,
          operationId,
          (row, at) => removeFromLibrary(row, at),
          (row) => row.deleted.value,
        );
      case 'reaction.set':
        return this.#titleAction(
          command.title,
          operationId,
          (row, at) => react(row, command.reaction, at),
          (row) => row.reaction.value === command.reaction,
          false,
        );
      case 'episode-watched.set':
        return this.#episodeWatched(command.episode, command.watched, operationId);
      case 'season-watched.set':
        return this.#seasonWatched(command, operationId);
      case 'watched.set':
        return this.#watched(command.title, command.watched, operationId);
      case 'continue-dismissed.set':
        return this.#dismissed(command.title, command.dismissed);
      case 'progress.record':
        return this.#progress(command);
      case 'preferences.patch':
        throw authorityError(
          'invalid-request',
          'preferences.patch is not implemented by the log authority',
        );
    }
  }

  async query(query: LibraryQuery): Promise<LibraryQueryResult> {
    if (query.kind !== 'playback.prepare')
      throw authorityError('invalid-request', 'unsupported library query');
    return this.#preparePlayback(query.title, query.episode);
  }

  async observe(observation: LibraryObservation): Promise<LibraryAuthorityObservationResult> {
    if (observation.kind === 'lifecycle') return { outcome: 'unchanged', affected: [] };
    const counts = new Map<number, number>();
    for (const { season, episodes } of observation.seasons) {
      if (season < 0 || episodes < 0)
        throw authorityError('invalid-request', 'title shape contains a negative count');
      if (counts.has(season))
        throw authorityError('invalid-request', 'title shape contains a duplicate season');
      counts.set(season, episodes);
    }
    const digest = JSON.stringify({
      seasons: [...counts].sort(([a], [b]) => a - b),
      lastAired: observation.lastAired ?? null,
    });
    const key = titleKey(observation.title);
    if (this.#shapes.get(key)?.digest === digest) return { outcome: 'unchanged', affected: [] };
    this.#shapes.set(key, {
      shape: { counts, ...(observation.lastAired ? { lastAired: observation.lastAired } : {}) },
      digest,
    });
    return {
      outcome: 'applied',
      affected: [{ kind: 'title', title: observation.title }, { kind: 'continue' }],
    };
  }

  #title(ref: TitleRef): TitleView {
    const row = this.#log.title(ref);
    const coordinates = this.#coordinates(ref);
    const episodes = coordinates.map(({ season, episode }) => {
      const held = this.#log.episode(ref, season, episode);
      const fraction = episodeProgress(held, row);
      return {
        season,
        episode,
        watched: fraction >= WATCHED,
        fraction,
        ...(held?.progress.seconds !== undefined ? { seconds: held.progress.seconds } : {}),
        ...(held?.progress.at[0] ? { updatedAt: held.progress.at[0] } : {}),
      };
    });
    const visible = !!row && !row.deleted.value;
    const shapedWatched = coordinates.length > 0 && episodes.every(({ watched }) => watched);
    return {
      kind: 'title',
      title: ref,
      listed:
        (visible && row.status.value !== 'none') || episodes.some(({ fraction }) => fraction > 0),
      watched: coordinates.length ? shapedWatched : visible && row.status.value === 'watched',
      reaction: visible ? row.reaction.value : null,
      standing: effectiveStanding(row, episodes),
      progress:
        visible && row.resume.value > 0
          ? {
              fraction: Math.max(0, Math.min(1, row.resume.value)),
              ...(row.resume.seconds !== undefined ? { seconds: row.resume.seconds } : {}),
              ...(row.resume.at[0] ? { updatedAt: row.resume.at[0] } : {}),
            }
          : null,
      episodes,
    };
  }

  #coordinates(ref: TitleRef): Array<{ season: number; episode: number }> {
    if (ref.type !== 'tv') return [];
    const shape = this.#shapes.get(titleKey(ref))?.shape;
    if (!shape) return [];
    return [...shape.counts]
      .filter(([season]) => season > 0)
      .sort(([a], [b]) => a - b)
      .flatMap(([season, count]) =>
        Array.from({ length: count }, (_, index) => ({ season, episode: index + 1 })),
      )
      .filter((episode) => isAired(episode, shape.lastAired));
  }

  async #titleAction(
    ref: TitleRef,
    operationId: string,
    change: (row: TitleRow, at: Awaited<ReturnType<ClockStore['issue']>>) => TitleRow,
    already: (row: TitleRow) => boolean,
    affectsContinue = true,
  ): Promise<LibraryAuthorityCommandResult> {
    const before = this.#log.title(ref) ?? blankTitle(ref, Date.now());
    if (already(before)) return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue();
    const event = recordTrackerEvent(before, change(before, at), at, operationId);
    if (!event) return this.#unchanged();
    return this.#writeAction(event, this.#affected(ref, affectsContinue));
  }

  async #episodeWatched(
    ref: EpisodeRef,
    watched: boolean,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    const before =
      this.#log.episode(ref, ref.season, ref.episode) ?? blankEpisode(ref, ref.season, ref.episode);
    const current = episodeProgress(before, this.#log.title(ref));
    if (current >= WATCHED === watched && (watched || current === 0)) return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue();
    const event = recordTrackerEvent(before, markEpisode(before, watched, at), at, operationId);
    if (!event) return this.#unchanged();
    return this.#writeAction(event, this.#affected(ref));
  }

  async #seasonWatched(
    command: Extract<LibraryCommand, { kind: 'season-watched.set' }>,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    const episodes = [...new Set(command.episodes)].sort((a, b) => a - b);
    if (command.season <= 0)
      throw authorityError('invalid-request', 'a season-wide change requires a regular season');
    if (episodes.some((episode) => episode <= 0))
      throw authorityError('invalid-request', 'episode numbers must be positive');
    const journals: SettingsRow[] = [];
    await this.#clock.see(this.#log.newestStamp());
    for (const episode of episodes) {
      const before =
        this.#log.episode(command.title, command.season, episode) ??
        blankEpisode(command.title, command.season, episode);
      const current = episodeProgress(before, this.#log.title(command.title));
      if (current >= WATCHED === command.watched && (command.watched || current === 0)) continue;
      const at = await this.#clock.issue();
      const event = recordTrackerEvent(
        before,
        markEpisode(before, command.watched, at),
        at,
        `${operationId}:episode:${command.season}:${episode}`,
      );
      if (event) journals.push(event);
    }
    return this.#writeActions(journals, this.#affected(command.title));
  }

  async #watched(
    ref: TitleRef,
    watched: boolean,
    operationId: string,
  ): Promise<LibraryAuthorityCommandResult> {
    if (ref.type === 'movie')
      return this.#titleAction(
        ref,
        operationId,
        (row, at) => (watched ? markWatched : unwatch)(row, at),
        (row) =>
          !row.deleted.value &&
          (watched
            ? row.status.value === 'watched'
            : row.status.value !== 'watched' && row.resume.value === 0),
      );

    const coordinates = this.#coordinates(ref);
    if (!this.#shapes.has(titleKey(ref)))
      throw authorityError(
        'not-ready',
        'a title shape must be observed before changing a whole series',
        true,
      );
    const journals: SettingsRow[] = [];
    await this.#clock.see(this.#log.newestStamp());
    for (const { season, episode } of coordinates) {
      const before = this.#log.episode(ref, season, episode) ?? blankEpisode(ref, season, episode);
      const current = episodeProgress(before, this.#log.title(ref));
      if (current >= WATCHED === watched && (watched || current === 0)) continue;
      const at = await this.#clock.issue();
      const event = recordTrackerEvent(
        before,
        markEpisode(before, watched, at),
        at,
        `${operationId}:episode:${season}:${episode}`,
      );
      if (event) journals.push(event);
    }
    const before = this.#log.title(ref) ?? blankTitle(ref, Date.now());
    const titleAlready = watched
      ? !before.deleted.value && before.status.value === 'watched'
      : before.status.value !== 'watched' &&
        before.resume.value === 0 &&
        before.episodesReset !== null;
    if (!titleAlready) {
      const at = await this.#clock.issue();
      const event = recordTrackerEvent(
        before,
        (watched ? markWatched : unwatchSeries)(before, at),
        at,
        operationId,
      );
      if (event) journals.push(event);
    }
    return this.#writeActions(journals, this.#affected(ref));
  }

  async #dismissed(ref: TitleRef, dismissed: boolean): Promise<LibraryAuthorityCommandResult> {
    const before = this.#log.title(ref) ?? blankTitle(ref, Date.now());
    if (before.dismissed.value === dismissed) return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue();
    const after = (dismissed ? dismissFromContinueWatching : restoreToContinueWatching)(before, at);
    return this.#writeRow(after, [{ kind: 'continue' }]);
  }

  async #progress(
    command: Extract<LibraryCommand, { kind: 'progress.record' }>,
  ): Promise<LibraryAuthorityCommandResult> {
    if (command.title.type === 'tv' && !command.episode)
      throw authorityError('invalid-request', 'series progress requires an episode');
    if (command.episode && !sameTitle(command.title, command.episode))
      throw authorityError('invalid-request', 'episode does not belong to the title');
    if (command.episode) {
      const before =
        this.#log.episode(command.episode, command.episode.season, command.episode.episode) ??
        blankEpisode(command.episode, command.episode.season, command.episode.episode);
      if (before.progress.value === command.fraction && before.progress.seconds === command.seconds)
        return this.#unchanged();
      await this.#clock.see(this.#log.newestStamp());
      const at = await this.#clock.issue(command.observedAt);
      return this.#writeRow(
        updateEpisodeProgress(before, command.fraction, command.seconds, at),
        this.#affected(command.title),
      );
    }
    const before = this.#log.title(command.title) ?? blankTitle(command.title, command.observedAt);
    if (before.resume.value === command.fraction && before.resume.seconds === command.seconds)
      return this.#unchanged();
    await this.#clock.see(this.#log.newestStamp());
    const at = await this.#clock.issue(command.observedAt);
    return this.#writeRow(
      updateProgress(before, command.fraction, command.seconds, at),
      this.#affected(command.title),
    );
  }

  #preparePlayback(title: TitleRef, requested?: EpisodeRef): LibraryQueryResult {
    if (requested) {
      if (!sameTitle(title, requested))
        throw authorityError('invalid-request', 'episode does not belong to the title');
      const progress = episodeProgress(
        this.#log.episode(requested, requested.season, requested.episode),
        this.#log.title(title),
      );
      const row = this.#log.episode(requested, requested.season, requested.episode);
      return {
        kind: 'playback.prepare',
        action: progress > RESUME_FLOOR && progress < WATCHED ? 'resume' : 'start',
        target: requested,
        resume:
          progress > RESUME_FLOOR && progress < WATCHED
            ? {
                fraction: progress,
                ...(row?.progress.seconds !== undefined ? { seconds: row.progress.seconds } : {}),
              }
            : null,
      };
    }
    if (title.type === 'movie') {
      const movie = { type: 'movie' as const, id: title.id };
      const row = this.#log.title(title);
      const progress = row && !row.deleted.value ? row.resume.value : 0;
      return {
        kind: 'playback.prepare',
        action: progress > RESUME_FLOOR && progress < WATCHED ? 'resume' : 'start',
        target: movie,
        resume:
          progress > RESUME_FLOOR && progress < WATCHED
            ? {
                fraction: progress,
                ...(row?.resume.seconds !== undefined ? { seconds: row.resume.seconds } : {}),
              }
            : null,
      };
    }
    const coordinates = this.#coordinates(title);
    if (!this.#shapes.has(titleKey(title)) || !coordinates.length)
      throw authorityError('not-ready', 'title shape is required to prepare series playback', true);
    const titleRow = this.#log.title(title);
    const latest = coordinates
      .map((coordinate) => ({
        ...coordinate,
        row: this.#log.episode(title, coordinate.season, coordinate.episode),
      }))
      .filter(({ row }) => row && episodeProgress(row, titleRow) > RESUME_FLOOR)
      .sort(
        (a, b) =>
          compareStamps(b.row!.progress.at, a.row!.progress.at) ||
          b.season - a.season ||
          b.episode - a.episode,
      )[0];
    if (!latest)
      return {
        kind: 'playback.prepare',
        action: 'start',
        target: { ...title, ...coordinates[0]! },
        resume: null,
      };
    const fraction = episodeProgress(latest.row, titleRow);
    if (fraction < WATCHED)
      return {
        kind: 'playback.prepare',
        action: 'resume',
        target: { ...title, season: latest.season, episode: latest.episode },
        resume: {
          fraction,
          ...(latest.row?.progress.seconds !== undefined
            ? { seconds: latest.row.progress.seconds }
            : {}),
        },
      };
    const index = coordinates.findIndex(
      ({ season, episode }) => season === latest.season && episode === latest.episode,
    );
    const next = coordinates[index + 1];
    return {
      kind: 'playback.prepare',
      action: next ? 'next' : 'start',
      target: { ...title, ...(next ?? coordinates[0]!) },
      resume: null,
    };
  }

  async #writeAction(
    journal: SettingsRow,
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    const pending = this.#log.pendingActions;
    const written = await this.#log.writeAction(journal);
    if (!written) this.#writeFailed();
    return { outcome: 'applied', delivery: this.#delivery(pending), affected };
  }

  async #writeActions(
    journals: SettingsRow[],
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    if (!journals.length) return this.#unchanged();
    const pending = this.#log.pendingActions;
    if (!(await this.#log.writeActions(journals))) this.#writeFailed();
    return { outcome: 'applied', delivery: this.#delivery(pending), affected };
  }

  async #writeRow(
    row: TitleRow | EpisodeRow,
    affected: LibraryAffectedSelection[],
  ): Promise<LibraryAuthorityCommandResult> {
    const pending = this.#log.pendingActions;
    if (!(await this.#log.write(row))) this.#writeFailed();
    return { outcome: 'applied', delivery: this.#delivery(pending), affected };
  }

  #delivery(pendingBefore: number): Delivery {
    if (this.#options.mode === 'local') return 'local';
    return this.#log.pendingActions > pendingBefore ? 'queued' : 'synced';
  }

  #idleDelivery(): Delivery {
    return this.#options.mode === 'local' ? 'local' : 'synced';
  }

  #unchanged(): LibraryAuthorityCommandResult {
    return { outcome: 'unchanged', delivery: this.#idleDelivery(), affected: [] };
  }

  #affected(title: TitleRef, affectsContinue = true): LibraryAffectedSelection[] {
    return [
      { kind: 'title', title },
      { kind: 'presence', title },
      { kind: 'overview' },
      ...(affectsContinue ? ([{ kind: 'continue' }] as const) : []),
    ];
  }

  #writable(): void {
    if (this.#log.moved) throw authorityError('moved', 'library moved to another key');
    if (this.#log.readOnly)
      throw authorityError('read-only', 'library is read-only until it can be upgraded');
  }

  #writeFailed(): never {
    if (this.#log.moved) throw authorityError('moved', 'library moved to another key');
    if (this.#log.readOnly)
      throw authorityError('read-only', 'library is read-only until it can be upgraded');
    if (this.#log.refusal)
      throw authorityError('refused', `library write was refused: ${this.#log.refusal}`);
    throw authorityError('unavailable', 'library write could not be saved', true);
  }
}
