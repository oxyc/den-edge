import { WATCHED } from './actions';
import { episodeProgress } from './detailPresentation';
import { isAired, type Shape } from './library';
import type { Standing, TitleRef, TitleView } from './libraryServiceProtocol';
import type { EpisodeRow, TitleRow } from './wire';

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
