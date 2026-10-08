import type { HistoryImportItem } from '../lib/libraryServiceProtocol';
import { isAired } from '../lib/library';
import type { ImportShow, ViewingMark } from '../lib/viewingImport';

export interface PlannedHistoryImport {
  key: string;
  item: HistoryImportItem;
}

/** Translate provider matches into the semantic import contract; storage rows and stamps stay in the service. */
export function historyImportItems(
  marks: readonly ViewingMark[],
  shows: Readonly<Record<number, ImportShow>>,
): PlannedHistoryImport[] {
  const grouped = new Map<string, ViewingMark[]>();
  for (const mark of marks) {
    const key = `${mark.type}:${mark.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), mark]);
  }
  return [...grouped].map(([key, group]) => {
    const first = group[0]!;
    if (first.type === 'movie') {
      return {
        key,
        item: {
          title: { type: 'movie', id: first.id },
          watchedAt: Math.max(...group.map((mark) => mark.at)),
        },
      };
    }
    const byEpisode = new Map<string, { season: number; episode: number; watchedAt: number }>();
    for (const mark of group) {
      const key = `${mark.season}:${mark.episode}`;
      const before = byEpisode.get(key);
      if (!before || mark.at > before.watchedAt)
        byEpisode.set(key, {
          season: mark.season!,
          episode: mark.episode!,
          watchedAt: mark.at,
        });
    }
    const episodes = [...byEpisode.values()].sort(
      (a, b) => a.season - b.season || a.episode - b.episode,
    );
    const imported = new Set(episodes.map((episode) => `${episode.season}:${episode.episode}`));
    const show = shows[first.id];
    let anyAired = false;
    let complete = !!show;
    for (const [season, count] of show?.counts ?? []) {
      if (season <= 0) continue;
      for (let episode = 1; episode <= count; episode++) {
        if (!isAired({ season, episode }, show?.lastAired)) continue;
        anyAired = true;
        if (!imported.has(`${season}:${episode}`)) complete = false;
      }
    }
    return {
      key,
      item: {
        title: { type: 'tv', id: first.id },
        episodes,
        ...(complete && anyAired ? { complete: true } : {}),
      },
    };
  });
}
