// The library's documents held once in den-core (`LibraryColumns`, owned by `LibraryLog.columns()`), and its lists read
// from it in one call each, instead of a `title_state` / `season_state_v4` per document and an `episode_mark` per
// episode. The answers are den-core's whole-library fold as typed columns; this only gives them the shapes the rest of
// the web reads.

import type { ColumnsAnswer, LibraryColumns } from '../vendor/den-core/startup.js';
import type { Download } from './downloadRows';
import type { HomeLibraryView } from './homeLibraryView';
import type { Library, LibraryRecord, Mark, MediaType, Standing } from './library';
import type { HistoryItem } from './libraryServiceProtocol';
import type { Stamp } from './wire';

/** One answer's columns, read once and the answer freed. */
class Read {
  constructor(private readonly answer: ColumnsAnswer) {}
  n(name: string): Float64Array {
    const column = this.answer.numbers(name);
    if (!column) throw new Error(`den-core answered no ${name}`);
    return column;
  }
  s(name: string): string[] {
    const column = this.answer.strings(name);
    if (!column) throw new Error(`den-core answered no ${name}`);
    return column;
  }
  refs(list: string): Array<{ type: MediaType; id: number }> {
    const media = this.n(`${list}.media`);
    const id = this.n(`${list}.id`);
    return Array.from(media, (m, i) => ({ type: m ? 'tv' : 'movie', id: id[i]! }));
  }
  keys(list: string): string[] {
    return this.refs(list).map(({ type, id }) => `${type}:${id}`);
  }
}

function read<T>(answer: ColumnsAnswer, work: (read: Read) => T): T {
  try {
    return work(new Read(answer));
  } finally {
    answer.free();
  }
}

const some = (x: number) => (Number.isNaN(x) ? undefined : x);
const flag = (x: number) => (Number.isNaN(x) ? undefined : x === 1);

/** Home's library inputs (`HomeLibraryView`), from den-core's `home`. */
export function homeFromColumns(
  columns: LibraryColumns,
  now: number,
  downloads: Download[] = [],
): HomeLibraryView {
  return read(columns.home(now), (r) => {
    const [status, progress, progressAt, seconds, playing, by, addedAt] = [
      r.s('records.status'),
      r.n('records.progress'),
      r.n('records.progress_at'),
      r.n('records.seconds'),
      r.n('records.playing'),
      r.s('records.by'),
      r.n('records.added_at'),
    ];
    const [season, episode, fraction, at, markSeconds, markPlaying, markBy] = [
      r.n('marks.season'),
      r.n('marks.episode'),
      r.n('marks.fraction'),
      r.n('marks.at'),
      r.n('marks.seconds'),
      r.n('marks.playing'),
      r.s('marks.by'),
    ];
    const [flagSeason, flagEpisode, dismissedAt] = [
      r.n('flags.season'),
      r.n('flags.episode'),
      r.n('dismissed.at'),
    ];
    const continueLibrary: Library = {
      records: r.refs('records').map((ref, i): LibraryRecord => ({
        // Object spread is ES2018. Keep this title projection ES2015-compatible; the explicit fields also avoid a
        // helper allocation on every Continue record in modern clients.
        title: { type: ref.type, id: ref.id, title: '' },
        status: status[i] as LibraryRecord['status'],
        progress: progress[i]!,
        progressAt: progressAt[i]!,
        ...(some(seconds[i]!) !== undefined ? { seconds: seconds[i]! } : {}),
        ...(flag(playing[i]!) !== undefined ? { playing: flag(playing[i]!) } : {}),
        ...(by[i] ? { progressBy: by[i] } : {}),
        addedAt: addedAt[i]!,
        deleted: false,
      })),
      marks: r.refs('marks').map(({ id }, i): Mark => ({
        type: 'tv',
        id,
        season: season[i]!,
        episode: episode[i]!,
        fraction: fraction[i]!,
        updatedAt: at[i]!,
        ...(some(markSeconds[i]!) !== undefined ? { seconds: markSeconds[i]! } : {}),
        ...(flag(markPlaying[i]!) !== undefined ? { playing: flag(markPlaying[i]!) } : {}),
        ...(markBy[i] ? { updatedBy: markBy[i] } : {}),
        title: '',
        posterPath: undefined,
        voteAverage: 0,
      })),
      flags: new Map(
        r.refs('flags').map(({ id }, i) => {
          const f = { type: 'tv', id, season: flagSeason[i]!, episode: flagEpisode[i]! };
          return [`tv:${id}:${f.season}:${f.episode}`, f] as const;
        }),
      ),
      shapes: new Map(),
      dismissed: new Map(r.keys('dismissed').map((key, i) => [key, dismissedAt[i]!] as const)),
    };
    const [weight, weightAt, standing] = [
      r.n('weighted.weight'),
      r.n('weighted.at'),
      r.s('standings.standing'),
    ];
    return {
      owned: r.keys('owned'),
      watched: r.keys('watched'),
      watchlist: r.keys('watchlist'),
      standings: r.keys('standings').map((key, i) => [key, standing[i] as Standing]),
      weighted: r.keys('weighted').map((key, i) => [key, weight[i]!, weightAt[i]!]),
      seeds: { watched: r.keys('seeds.watched'), watchlisted: r.keys('seeds.watchlisted') },
      shelfRefs: r.keys('shelf'),
      requiredShapeRefs: r.keys('required'),
      continueLibrary,
      downloads,
    };
  });
}

/** Every History entry, newest first then by key, from den-core's `history`. */
export function historyItemsFromColumns(columns: LibraryColumns, now: number): HistoryItem[] {
  return read(columns.history(now), (r) => {
    const [at, season, episode, episodes] = [
      r.n('history.at'),
      r.n('history.season'),
      r.n('history.episode'),
      r.n('history.episodes'),
    ];
    return r.refs('history').map((title, i) => ({
      title,
      watchedAt: at[i]!,
      ...(!Number.isNaN(season[i]!)
        ? { episode: { season: season[i]!, episode: episode[i]! } }
        : {}),
      episodes: episodes[i]!,
    }));
  });
}

/** The newest stamp in any held document and when an answer next changes with no write, from den-core's `newest`. */
export function newestFromColumns(
  columns: LibraryColumns,
  now: number,
): { stamp: Stamp; reconsiderAt: number } {
  return read(columns.newest(now), (r) => ({
    stamp: [r.n('newest.t')[0]!, r.n('newest.c')[0]!, r.s('newest.d')[0]!],
    reconsiderAt: some(r.n('reconsider.at')[0]!) ?? Infinity,
  }));
}
