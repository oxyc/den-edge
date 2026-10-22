import { WATCHED } from './actions';
import { episodeProgress } from './detailPresentation';
import { isAired, type Shape } from './library';
import type { Standing, TitleRef, TitleView } from './libraryServiceProtocol';
import { projectDocument, projectEpisode } from './libraryV4';
import { syncPolicy } from './syncCore';
import {
  isDocument,
  ZERO_STAMP,
  type DocumentRow,
  type EpisodeRow,
  type Row,
  type Stamp,
  type TitleRow,
} from './wire';

/** A library row by its name, in whatever form it is held: a v4 document, or a row of an earlier format. */
export type RowLookup = (name: string) => Row | undefined;

const documentOf = (get: RowLookup, name: string): DocumentRow | undefined => {
  const row = get(name);
  return row && isDocument(row) ? row : undefined;
};

/** A title's row: its v4 document projected, or its earlier `rec:` row. */
export function titleRow(get: RowLookup, ref: { type: string; id: number }): TitleRow | undefined {
  const document = documentOf(get, `title:${ref.type}:${ref.id}`);
  if (document) return projectDocument(document)[0] as TitleRow;
  const row = get(`rec:${ref.type}:${ref.id}`);
  return row?.kind === 'rec' ? row : undefined;
}

/**
 * The names `episodeRow` may read for one episode, in the order it reads them: a library's rows can be read by these
 * alone, rather than whole, to build a title's page.
 */
export function episodeRowNames(
  ref: { type: string; id: number },
  season: number,
  episode: number,
): string[] {
  return [
    `season:tv:${ref.id}:${season}`,
    `ep:${ref.type}:${ref.id}:${season}:${episode}`,
    `wat:tv:${ref.id}:${season}:${Math.floor(episode / 32)}`,
  ];
}

/**
 * An episode's row: from its season's v4 document, else its earlier `ep:` row, else its register in the season's
 * `wat:` block of watch marks.
 */
export function episodeRow(
  get: RowLookup,
  ref: { type: string; id: number },
  season: number,
  episode: number,
): EpisodeRow | undefined {
  const document = ref.type === 'tv' && documentOf(get, `season:tv:${ref.id}:${season}`);
  if (document)
    return projectEpisode(documentOf(get, `title:tv:${ref.id}`), document, ref, season, episode);
  const row = get(`ep:${ref.type}:${ref.id}:${season}:${episode}`);
  if (row?.kind === 'ep') return row;
  if (ref.type !== 'tv') return undefined;
  const block = Math.floor(episode / 32);
  const watch = get(`wat:tv:${ref.id}:${season}:${block}`);
  if (watch?.kind !== 'wat') return undefined;
  const register = watch.entries[String(episode)];
  if (!register) return undefined;
  const title = titleRow(get, ref);
  const resets = [watch.seasonReset, title?.episodesReset].filter(
    (value): value is Stamp => value !== null && value !== undefined,
  );
  const state = syncPolicy<{
    watched: boolean;
    resume: EpisodeRow['progress'] | null;
    viewing: number;
    watched_at: number | null;
  }>({ op: 'episode_state', register, resets, now: Date.now() });
  const at: Stamp = state.resume?.at ?? (state.watched_at ? [state.watched_at, 0, ''] : ZERO_STAMP);
  return {
    kind: 'ep',
    schema: 2,
    title: { type: 'tv', id: ref.id },
    season,
    episode,
    progress: state.resume ?? { value: state.watched ? 1 : 0, viewing: state.viewing, at },
  };
}

/** Every aired episode of a series' shape, in order; none for a film or a series whose shape is not known yet. */
export function titleCoordinates(
  ref: TitleRef,
  shape: Shape | undefined,
): Array<{ season: number; episode: number }> {
  if (ref.type !== 'tv' || !shape) return [];
  return [...shape.counts]
    .filter(([season]) => season > 0)
    .sort(([a], [b]) => a - b)
    .flatMap(([season, count]) =>
      Array.from({ length: count }, (_, index) => ({ season, episode: index + 1 })),
    )
    .filter((episode) => isAired(episode, shape.lastAired));
}

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
 * A title's page view from its own rows: the title's row, each episode's, and the series' shape. The full log and the
 * startup authority both build it here, the first from the whole log and the second from the title's documents alone.
 */
export function titleView(
  ref: TitleRef,
  row: TitleRow | undefined,
  episode: (season: number, episode: number) => EpisodeRow | undefined,
  shape: Shape | undefined,
): TitleView {
  const coordinates = titleCoordinates(ref, shape);
  const episodes = coordinates.map(({ season, episode: number }) => {
    const held = episode(season, number);
    const fraction = episodeProgress(held, row);
    return {
      season,
      episode: number,
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
