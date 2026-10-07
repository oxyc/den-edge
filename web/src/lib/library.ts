// The library as the web shows it — the record log's rows (`applyLog`), named from TMDB — and the TV's own rules
// for its Watchlist and Continue Watching rows (LibraryStore, EpisodeProgressStore and ContinueWatchingRow.list),
// so the web shows the same rows in the same order.

import { WATCHED } from './actions';
import { inPolicySlices, syncPolicy, type PolicySliceOptions } from './syncCore';
import { wellFormed, type Row, type Stamp } from './wire';

export type MediaType = 'movie' | 'tv';
/** What Explore browses and atlas's filter answers for: one type, or films and series together. */
export type ExploreType = MediaType | 'all';
export type PosterRatingSource = 'tmdb' | 'justwatch-imdb';

export interface Title {
  type: MediaType;
  id: number;
  title: string;
  posterPath?: string;
  /**
   * Art for a title TMDB has no poster path for here, as a whole URL: atlas's service catalogs carry one per title,
   * keyed by IMDb id, which reaches titles its own dataset does not hold. Only ever set from such a catalog, and only
   * ever used when `posterPath` is absent, so TMDB stays the art everywhere it can be.
   */
  posterUrl?: string;
  /** Available in discovery results, before the full detail request finishes. */
  backdropPath?: string;
  year?: number;
  /** The full release date (`YYYY-MM-DD`) where TMDB gave one: a year can't tell last month from last January. */
  releaseDate?: string;
  rating?: number;
  /** Provenance for the score on this card. Atlas carries JustWatch's IMDb score; TMDB carries its own. */
  ratingSource?: PosterRatingSource;
  /** How many votes that rating rests on — a 9.4 from eleven people is not a recommendation. */
  votes?: number;
  /** TMDB's popularity: how much attention it is getting now, which an unreleased title can have and a rating
      can't measure. The billboard uses it to tell an awaited film from an untracked micro-release. */
  popularity?: number;
  /** Where it was made (ISO-3166 alpha-2). A better reading of "Nordic" than the language is: the region's
      co-productions are routinely in two or three languages, and often in English. */
  countries?: string[];
  /** Its director and the top of its billing, by TMDB person id: the people a household follows are a taste of
      their own, and the one signal that crosses genres. */
  people?: number[];
  /** The TMDB collection a movie belongs to (from a detail fetch), so search can group a franchise. */
  collectionId?: number;
  /** What the TV's hide rules look at (`prefs.ts`): TMDB genre ids, original language, the adult flag. */
  genreIds?: number[];
  /**
   * The corpus's narrative primary genre ("Crime", "Coming-of-Age"), when the row that supplied this card
   * knew it — an atlas row or query does, TMDB does not. It answers what TMDB's `genreIds` cannot: which of
   * a title's genres it actually IS, rather than which it merely carries. Undefined is normal and means
   * "fall back to the rarity heuristic", not "no genre" — atlas describes 47,618 titles and TMDB has
   * millions, so anything outside the corpus has none.
   */
  primaryGenreName?: string;
  /** Atlas's tentative plot-facet tier: the card matches, but not through a publication-gated confident value. */
  likely?: boolean;
  originalLanguage?: string;
  adult?: boolean;
  /** Its IMDb id where whatever named it said so — scout keys availability by it, so no lookup is needed. */
  imdbId?: string;
  /**
   * When it arrives on a streaming service, or leaves one — epoch milliseconds, from atlas's chart (`denAt`, which
   * is in seconds). Only its leaving and coming charts carry one, and nothing else can: TMDB has no arrival date,
   * so without this a row of what is coming can be ordered only by the order it was sent in.
   */
  arrivesAt?: number;
  /** Which services a pooled row found it on, named for the card's caption ("Netflix", "Max"). */
  services?: string[];
}

/** A poster's short second line, including Atlas's confidence tier when the card came from a plot-facet answer. */
export function titleCaption(title: Title, caption?: string): string | undefined {
  const ordinary = caption ?? (title.year ? String(title.year) : undefined);
  return (
    [ordinary, title.likely ? 'Likely match' : undefined].filter(Boolean).join(' · ') || undefined
  );
}

type Status = 'none' | 'watchlist' | 'inProgress' | 'watched';

interface LibraryRecord {
  title: Title;
  status: Status;
  progress: number;
  progressAt: number;
  /** The resume point in seconds, where the device that wrote it knew it. */
  seconds?: number;
  addedAt: number;
  deleted: boolean;
}

interface Mark {
  type: string;
  id: number;
  season: number;
  episode: number;
  fraction: number;
  updatedAt: number;
  seconds?: number;
  title: string;
  posterPath?: string;
  voteAverage: number;
}

/** A series' season layout, which Continue Watching needs to find the next episode. */
export interface Shape {
  /** Episode count per season. */
  counts: Map<number, number>;
  lastAired?: { season: number; episode: number };
}

export interface Library {
  records: LibraryRecord[];
  marks: Mark[];
  /**
   * Episodes known to be watched with no time behind it — a tracker import, written with the zero stamp.
   *
   * Apart from `marks` deliberately, and the TV keeps them apart for the same reason: such a bit says only
   * "this was watched". It is not a resume position and it carries no stamp to compare, so storing it as a
   * mark would put a fraction of 1 at the epoch into the history, where every later comparison reads real
   * progress as the older side. By `markKey`. Optional, so a library built before this stays valid.
   */
  flags?: Map<string, { type: string; id: number; season: number; episode: number }>;
  /** By `type:id`. */
  shapes: Map<string, Shape>;
  dismissed: Map<string, number>;
}

/**
 * What the shared policy says one episode row means for what we already hold (`episode_mark`).
 *
 * An action rather than a mark, because the TV and the web store watch state differently and neither shape
 * belongs in the policy: `clear` hold nothing, `keep` what is held still wins, `flag` watched but timeless,
 * `replace` take the row's figures.
 */
type EpisodeAction =
  | { action: 'clear' | 'keep' | 'flag' }
  | { action: 'replace'; fraction: number; at: number; seconds?: number };

/**
 * What Continue Watching should do with one series (`continue_entry`).
 *
 * `code` is what to branch on; `reason` is prose for whoever reads a log. Matching the prose is how a
 * dismissed series was once put back on the row. `episode` is null exactly when the action is `none`.
 */
type ContinueAnswer = {
  action: 'resume' | 'next' | 'start' | 'none';
  code: string;
  episode: { season: number; episode: number } | null;
  fraction: number;
  reason: string;
};

export interface ContinueEntry {
  title: Title;
  /** 0…1 into the movie or episode. */
  fraction: number;
  /** The episode to resume or start next, for a series. */
  episode?: { season: number; episode: number };
  /** Where it was last playing, in seconds, and when that was written (epoch ms): `livePosition`. */
  seconds?: number;
  at?: number;
}

/** A Continue Watching decision before the title's late TMDB display fields are laid over it. */
export interface ContinueCandidate extends Omit<ContinueEntry, 'title'> {
  ref: Pick<Title, 'type' | 'id'>;
  /** A started series takes its display from its latest mark; a bare flag and a film take it from the record. */
  display: 'mark' | 'record';
}

export function emptyLibrary(): Library {
  return { records: [], marks: [], flags: new Map(), shapes: new Map(), dismissed: new Map() };
}

export const titleKey = (t: { type: string; id: number }) => `${t.type}:${t.id}`;

/**
 * The record log's rows applied to `library`; the log's state wins. Rows carry no display, so a title arrives
 * unnamed until `untitled` and `withDisplay` fill it in from TMDB.
 *
 * **Requires an initialised sync core**, because it asks the shared policy what each row means. That holds in
 * the app by construction rather than by care: `LibraryLog.open()` awaits `ensureSyncPolicy()`, so a log
 * cannot exist before the core does, and this is only ever called with one. Anything that builds a log by
 * hand — a test fixture — must await it first, or every call here throws "Sync core is not initialized".
 * It is called from a `$derived`, which cannot await, so there is nowhere to fix this further down.
 */
export function applyLog(library: Library, rows: Row[]): Library {
  const fold = new LibraryFold(library);
  for (const row of rows) fold.add(row);
  return fold.finish();
}

/** The same fold as `applyLog`, staged across browser tasks and published only after it is complete. */
export async function applyLogInSlices(
  library: Library,
  rows: Row[],
  options?: PolicySliceOptions,
): Promise<Library | null> {
  if (options?.shouldContinue && !options.shouldContinue()) return null;
  const { applyRowsInWorker } = await import('./libraryWorkerClient');
  const projected = await applyRowsInWorker(library, rows);
  if (projected) return options?.shouldContinue?.() === false ? null : projected;
  const fold = new LibraryFold(library);
  function* steps() {
    for (const row of rows) {
      if (!wellFormed(row)) continue;
      if (row.kind !== 'wat') {
        yield () => fold.add(row);
        continue;
      }
      if (row.title.type !== 'tv') continue;
      for (const [number, register] of Object.entries(row.entries))
        yield () => fold.addWatch(row, number, register);
    }
  }
  const completed = await inPolicySlices(steps(), (step) => step(), options);
  return completed ? fold.finish() : null;
}

class LibraryFold {
  private readonly records: Map<string, LibraryRecord>;
  private readonly dismissed: Map<string, number>;
  private readonly marks: Map<string, Mark>;
  // A mark of each series, for the display a new episode mark borrows: scanning every mark per episode row was
  // quadratic in a long watch history.
  private readonly seriesMarks: Map<string, Mark>;
  private readonly flags: Map<
    string,
    { type: string; id: number; season: number; episode: number }
  >;
  private readonly resets = new Map<string, number>();

  constructor(private readonly library: Library) {
    this.records = new Map(library.records.map((r) => [titleKey(r.title), r]));
    this.dismissed = new Map(library.dismissed);
    this.marks = new Map(library.marks.map((m) => [markKey(m), m]));
    this.seriesMarks = new Map(library.marks.map((m) => [titleKey(m), m]));
    this.flags = new Map(library.flags ?? []);
  }

  add(row: Row): void {
    const { records, dismissed, marks, seriesMarks, flags, resets } = this;
    if (row.kind === 'set' || row.kind === 'snt' || !wellFormed(row)) return; // settings and receipts have no display projection
    if (row.kind === 'wat') {
      if (row.title.type !== 'tv') return;
      for (const [number, register] of Object.entries(row.entries)) {
        this.addWatch(row, number, register);
      }
      return;
    }
    if (row.title.type !== 'movie' && row.title.type !== 'tv') return;
    const key = titleKey(row.title);
    if (row.kind === 'ep') {
      const episode = {
        type: row.title.type,
        id: row.title.id,
        season: row.season,
        episode: row.episode,
      };
      // What a row means for what we hold is the shared policy's to decide, so the TV and the web cannot
      // drift on it — above all on the zero stamp, which says "watched, time unknown". Written here as a
      // mark it became a fraction of 1 stamped at the epoch, and every later comparison then read real
      // progress as the older side, which is the opposite of what the stamp is for (wire/library-v2.md §3).
      //
      // Authoritative: `rows()` hands us one merged row per name out of the log's own store, so a row IS the
      // record rather than a claim about it, and there is nothing for it to outrank.
      const held = marks.get(markKey(episode));
      const decided = syncPolicy<EpisodeAction>({
        op: 'episode_mark',
        row,
        mark: held ? { fraction: held.fraction, at: held.updatedAt } : null,
        authoritative: true,
      });
      if (decided.action === 'clear') {
        marks.delete(markKey(episode));
        flags.delete(markKey(episode));
      } else if (decided.action === 'flag') {
        flags.set(markKey(episode), episode);
      } else if (decided.action === 'replace') {
        // Display comes from the series' other marks, or TMDB once `untitled` asks for it.
        const series = held ?? seriesMarks.get(key);
        const mark = {
          ...episode,
          fraction: decided.fraction,
          updatedAt: decided.at,
          ...(decided.seconds !== undefined ? { seconds: decided.seconds } : {}),
          title: series?.title ?? '',
          posterPath: series?.posterPath,
          voteAverage: series?.voteAverage ?? 0,
        };
        marks.set(markKey(episode), mark);
        seriesMarks.set(key, mark);
        // Real progress supersedes a timeless bit for the same episode.
        flags.delete(markKey(episode));
      }
      return;
    }
    if (row.kind !== 'rec') return;
    if (row.episodesReset) resets.set(key, row.episodesReset[0]);
    records.set(key, {
      title: records.get(key)?.title ?? { type: row.title.type, id: row.title.id, title: '' },
      status: row.status.value,
      progress: row.resume.value,
      progressAt: row.resume.at[0],
      ...(row.resume.seconds !== undefined ? { seconds: row.resume.seconds } : {}),
      addedAt: row.addedAt,
      deleted: row.deleted.value,
    });
    if (row.dismissed.value)
      dismissed.set(key, Math.max(dismissed.get(key) ?? -Infinity, row.dismissed.at[0]));
  }

  addWatch(
    row: Extract<Row, { kind: 'wat' }>,
    number: string,
    register: Extract<Row, { kind: 'wat' }>['entries'][string],
  ): void {
    const { marks, seriesMarks, flags } = this;
    const key = titleKey(row.title);
    const episode = {
      type: 'tv' as const,
      id: row.title.id,
      season: row.season,
      episode: Number(number),
    };
    const state = syncPolicy<{
      watched: boolean;
      resume: { value: number; at: Stamp; seconds?: number } | null;
      watched_at: number | null;
    }>({
      op: 'episode_state',
      register,
      resets: [row.seasonReset].filter(Boolean),
      now: Date.now(),
    });
    const held = marks.get(markKey(episode));
    if (state.resume) {
      const series = held ?? seriesMarks.get(key);
      const mark = {
        ...episode,
        fraction: state.resume.value,
        updatedAt: state.resume.at[0],
        ...(state.resume.seconds !== undefined ? { seconds: state.resume.seconds } : {}),
        title: series?.title ?? '',
        posterPath: series?.posterPath,
        voteAverage: series?.voteAverage ?? 0,
      };
      marks.set(markKey(episode), mark);
      seriesMarks.set(key, mark);
      flags.delete(markKey(episode));
    } else if (state.watched) {
      if (register.progress) {
        const series = held ?? seriesMarks.get(key);
        const mark = {
          ...episode,
          fraction: 1,
          updatedAt: register.progress.at[0],
          title: series?.title ?? '',
          posterPath: series?.posterPath,
          voteAverage: series?.voteAverage ?? 0,
        };
        marks.set(markKey(episode), mark);
        seriesMarks.set(key, mark);
        flags.delete(markKey(episode));
      } else flags.set(markKey(episode), episode);
    } else {
      marks.delete(markKey(episode));
      flags.delete(markKey(episode));
    }
  }

  finish(): Library {
    // A whole series un-watched: every episode progress from before it goes.
    for (const [key, mark] of this.marks) {
      const reset = this.resets.get(titleKey(mark));
      if (reset !== undefined && mark.updatedAt <= reset) this.marks.delete(key);
    }
    // And every timeless bit for it, whenever it was learned. A flag has no stamp to compare, so it can never
    // lose the test above — and a series un-watched while fabricated "watched" bits survive would offer them
    // again on the next pull, and go on doing so forever.
    for (const [key, flag] of this.flags) {
      if (this.resets.has(titleKey(flag))) this.flags.delete(key);
    }
    return {
      ...this.library,
      records: [...this.records.values()],
      marks: [...this.marks.values()],
      flags: this.flags,
      dismissed: this.dismissed,
    };
  }
}

const markKey = (m: { type: string; id: number; season: number; episode: number }) =>
  `${m.type}:${m.id}:${m.season}:${m.episode}`;

/**
 * Titles with no display yet: the ones the rows would show, and series that only episode progress names.
 *
 * Watched titles are named too, though no row lists them. What has been watched is the only record of what this
 * viewer likes — its genres and its language are the whole taste signal — and an unnamed record carries neither.
 * Leaving them out let the billboard fill with horror and action for a household that watches Nordic crime.
 */
export function untitled(library: Library): { type: MediaType; id: number }[] {
  const refs = new Map<string, { type: MediaType; id: number }>();
  for (const r of library.records) {
    const wanted = r.status === 'watchlist' || r.status === 'inProgress' || r.status === 'watched';
    if (!r.deleted && r.title.title === '' && wanted) {
      refs.set(titleKey(r.title), { type: r.title.type, id: r.title.id });
    }
  }
  for (const m of library.marks) {
    if (m.title === '' && (m.type === 'movie' || m.type === 'tv'))
      refs.set(titleKey(m), { type: m.type, id: m.id });
  }
  return [...refs.values()];
}

export function withDisplay(library: Library, titles: Title[]): Library {
  const byKey = new Map(titles.map((t) => [titleKey(t), t]));
  return {
    ...library,
    records: library.records.map((r) => ({ ...r, title: byKey.get(titleKey(r.title)) ?? r.title })),
    marks: library.marks.map((m) => {
      const t = m.title === '' ? byKey.get(titleKey(m)) : undefined;
      return t ? { ...m, title: t.title, posterPath: t.posterPath, voteAverage: t.rating ?? 0 } : m;
    }),
  };
}

/** Newest additions first, as the TV lists them. A title with no display yet waits, as on the TV. */
export function watchlist(library: Library): Title[] {
  return library.records
    .filter((r) => !r.deleted && r.status === 'watchlist' && r.title.title !== '')
    .sort((a, b) => b.addedAt - a.addedAt)
    .map((r) => r.title);
}

/**
 * The Watchlist page's billboard: what the page lists under Watchlist, newest addition first. A series with an
 * episode seen (`seen`, by `type:id`) is under way, so it is in Continue Watching rather than here.
 */
export function watchlistSlides(
  library: Library,
  seen: ReadonlyMap<string, readonly unknown[]>,
): Title[] {
  return watchlist(library).filter((title) => !seen.get(titleKey(title))?.length);
}

/** What the library says of a title, for the mark in its poster's corner. */
export type Standing = 'watched' | 'watchlist' | 'inProgress';

/**
 * Every title the library has a standing for, by `titleKey`: its record's status, and a series with episode
 * progress as in progress unless the series is watched. The TV's PosterCard marks the same three.
 */
export function standings(library: Library): Map<string, Standing> {
  const out = new Map<string, Standing>();
  for (const mark of library.marks) out.set(titleKey(mark), 'inProgress');
  for (const record of library.records) {
    if (record.deleted || record.status === 'none') continue;
    const key = titleKey(record.title);
    // A watchlisted series already being watched reads as in progress.
    if (record.status === 'watchlist' && out.has(key)) continue;
    out.set(key, record.status);
  }
  return out;
}

/**
 * Whether this exact film or episode has been watched, by its own mark — never the series' standing
 * (`standings`), which is a whole-series record and says nothing about one episode still downloading. What
 * `download_prune`'s `watched` input (den-spec library-v4 §17) must be built from, so a series finished last
 * season doesn't prune this season's downloads before anyone has watched them.
 */
export function contentWatched(
  library: Library,
  content: { type: MediaType; id: number; season?: number; episode?: number },
): boolean {
  if (content.type === 'tv' && content.season !== undefined && content.episode !== undefined) {
    const key = markKey({
      type: content.type,
      id: content.id,
      season: content.season,
      episode: content.episode,
    });
    if (library.marks.some((m) => m.fraction >= WATCHED && markKey(m) === key)) return true;
    return [...(library.flags?.values() ?? [])].some((f) => markKey(f) === key);
  }
  const record = library.records.find((r) => !r.deleted && titleKey(r.title) === titleKey(content));
  return record?.status === 'watched';
}

/** The next episode in season order (Specials last), or none past the end — SeriesProgress.episode(after:). */
export function episodeAfter(at: { season: number; episode: number }, shape: Shape) {
  const seasons = [...shape.counts.entries()].sort(
    ([a], [b]) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b),
  );
  const index = seasons.findIndex(([season]) => season === at.season);
  if (index < 0) return undefined;
  if (at.episode < (seasons[index]?.[1] ?? 0))
    return { season: at.season, episode: at.episode + 1 };
  const next = seasons.slice(index + 1).find(([, count]) => count > 0);
  return next ? { season: next[0], episode: 1 } : undefined;
}

export function isAired(
  at: { season: number; episode: number },
  lastAired: Shape['lastAired'],
): boolean {
  if (!lastAired || lastAired.season <= 0) return true;
  return (
    at.season < lastAired.season ||
    (at.season === lastAired.season && at.episode <= lastAired.episode)
  );
}

type ContinueDecision = (request: Record<string, unknown>) => ContinueAnswer;

/**
 * The policy half of Continue Watching. Title names arrive in small TMDB batches, but they cannot change which
 * episode den-core chooses. Keeping these decisions by series means one late name or shape does not replay the
 * policy for every series in the library during Svelte's next flush.
 */
export class ContinueProjector {
  private decisions = new Map<string, { input: string; answer: ContinueAnswer }>();
  private library?: Library;
  private series = new Map<string, Omit<Library, 'shapes' | 'dismissed'>>();
  private seriesOrder: string[] = [];
  private seriesCandidates = new Map<string, ContinueCandidate>();
  private movies: ContinueCandidate[] = [];
  private candidates: ContinueCandidate[] = [];

  constructor(
    private readonly decide: ContinueDecision = (request) => syncPolicy<ContinueAnswer>(request),
  ) {}

  project(library: Library): ContinueCandidate[] {
    const live = new Set<string>();
    const decision = (key: string, request: Record<string, unknown>): ContinueAnswer => {
      live.add(key);
      const input = JSON.stringify(request);
      const known = this.decisions.get(key);
      if (known?.input === input) return known.answer;
      const answer = this.decide(request);
      this.decisions.set(key, { input, answer });
      return answer;
    };
    const candidates = continueCandidates(library, decision);
    for (const key of this.decisions.keys()) if (!live.has(key)) this.decisions.delete(key);
    this.rememberProjection(library, candidates);
    return candidates;
  }

  /**
   * Re-project only series whose episode layout arrived. Records and watch state are immutable between ordinary
   * naming batches, so rebuilding their summaries (and every unrelated den-core request) would be pure overhead.
   */
  projectShapeChanges(library: Library, changed: ReadonlySet<string>): ContinueCandidate[] {
    const previous = this.library;
    if (
      !previous ||
      previous.records !== library.records ||
      previous.marks !== library.marks ||
      previous.flags !== library.flags ||
      previous.dismissed !== library.dismissed
    )
      return this.project(library);
    if (!changed.size) {
      this.library = library;
      return this.candidates;
    }
    for (const key of changed) {
      const held = this.series.get(key);
      if (!held) continue;
      const shape = library.shapes.get(key);
      const dismissed = library.dismissed.get(key);
      const one: Library = {
        ...held,
        shapes: shape ? new Map([[key, shape]]) : new Map(),
        dismissed: dismissed === undefined ? new Map() : new Map([[key, dismissed]]),
      };
      const candidate = continueCandidates(one, (candidateKey, request) => {
        const input = JSON.stringify(request);
        const known = this.decisions.get(candidateKey);
        if (known?.input === input) return known.answer;
        const answer = this.decide(request);
        this.decisions.set(candidateKey, { input, answer });
        return answer;
      })[0];
      if (candidate) this.seriesCandidates.set(key, candidate);
      else this.seriesCandidates.delete(key);
    }
    this.library = library;
    this.candidates = [
      ...this.seriesOrder.flatMap((key) => this.seriesCandidates.get(key) ?? []),
      ...this.movies,
    ];
    return this.candidates;
  }

  private rememberProjection(library: Library, candidates: ContinueCandidate[]): void {
    const buckets = new Map<string, Omit<Library, 'shapes' | 'dismissed'>>();
    const bucket = (key: string) => {
      let found = buckets.get(key);
      if (!found) {
        found = { records: [], marks: [], flags: new Map() };
        buckets.set(key, found);
      }
      return found;
    };
    for (const record of library.records) bucket(titleKey(record.title)).records.push(record);
    const latest = new Map<string, number>();
    for (const mark of library.marks) {
      const key = titleKey(mark);
      bucket(key).marks.push(mark);
      if (mark.type !== 'tv') continue;
      latest.set(key, Math.max(latest.get(key) ?? -Infinity, mark.updatedAt));
    }
    const flagged = new Set<string>();
    for (const [mark, flag] of library.flags ?? []) {
      const key = titleKey(flag);
      bucket(key).flags!.set(mark, flag);
      if (flag.type === 'tv') flagged.add(key);
    }
    this.seriesOrder = [...new Set([...latest.keys(), ...flagged])].sort(
      (a, b) => (latest.get(b) ?? -Infinity) - (latest.get(a) ?? -Infinity),
    );
    this.series = new Map(this.seriesOrder.map((key) => [key, bucket(key)]));
    const seriesKeys = new Set(this.seriesOrder);
    this.seriesCandidates = new Map(
      candidates.flatMap((candidate) => {
        const key = titleKey(candidate.ref);
        return seriesKeys.has(key) ? [[key, candidate] as const] : [];
      }),
    );
    this.movies = candidates.filter((candidate) => !seriesKeys.has(titleKey(candidate.ref)));
    this.library = library;
    this.candidates = candidates;
  }
}

/** Started series (the episode to resume or start next), then in-progress movies, before display fields arrive. */
function continueCandidates(
  library: Library,
  decide: (key: string, request: Record<string, unknown>) => ContinueAnswer,
): ContinueCandidate[] {
  const dismissedSince = (key: string, activity: number) =>
    (library.dismissed.get(key) ?? -Infinity) >= activity;
  const records = new Map(
    library.records
      .filter((record) => !record.deleted)
      .map((record) => [titleKey(record.title), record]),
  );
  const watchedTitles = new Set(
    [...records].flatMap(([key, record]) => (record.status === 'watched' ? [key] : [])),
  );
  const seen = new Set<string>();
  const entries: ContinueCandidate[] = [];

  // Three summaries per series, because the policy asks three different questions of them and conflating any
  // two is a defect one of the clients actually shipped: where a resume would go (the mark touched last), how
  // far the series is actually finished (the furthest FINISHED mark, which is not the same episode), and how
  // far a timeless bit says it was watched. Watching E1–E4 and then opening E5 for two seconds leaves the
  // newest mark on E5 below the floor, and reading that alone drops a series being actively watched.
  const ahead = (a: { season: number; episode: number }, b: { season: number; episode: number }) =>
    a.season > b.season || (a.season === b.season && a.episode > b.episode);
  const latest = new Map<string, Mark>();
  const finished = new Map<string, { season: number; episode: number }>();
  const flagged = new Map<string, { season: number; episode: number }>();
  for (const mark of library.marks) {
    if (mark.type !== 'tv') continue;
    const key = titleKey(mark);
    const current = latest.get(key);
    if (!current || mark.updatedAt > current.updatedAt) latest.set(key, mark);
    if (mark.fraction >= WATCHED) {
      const front = finished.get(key);
      if (!front || ahead(mark, front))
        finished.set(key, { season: mark.season, episode: mark.episode });
    }
  }
  for (const flag of library.flags?.values() ?? []) {
    if (flag.type !== 'tv') continue;
    const key = titleKey(flag);
    const front = flagged.get(key);
    if (!front || ahead(flag, front))
      flagged.set(key, { season: flag.season, episode: flag.episode });
  }

  // A series known only through a flag has no time behind it, so it has no place in an order built on when
  // things were watched: it sorts last among the series rather than claiming the top.
  const series = [...new Set([...latest.keys(), ...flagged.keys()])].sort(
    (a, b) => (latest.get(b)?.updatedAt ?? -Infinity) - (latest.get(a)?.updatedAt ?? -Infinity),
  );
  for (const key of series) {
    const mark = latest.get(key);
    // A series known only through a bare watched flag has no mark to identify it, so its record does. Display
    // fields are deliberately not inspected here: a late name changes presentation, not this policy decision.
    const ref = mark ? { type: mark.type as MediaType, id: mark.id } : records.get(key)?.title;
    if (!ref || (ref.type !== 'movie' && ref.type !== 'tv')) continue;
    const shape = library.shapes.get(key);
    // Branch on `code`, never on `reason`: matching the prose swallowed "dismissed" once and put a dismissed
    // series back on the row.
    const answer = decide(key, {
      op: 'continue_entry',
      mark: mark
        ? {
            season: mark.season,
            episode: mark.episode,
            fraction: mark.fraction,
            at: mark.updatedAt,
          }
        : null,
      finished: finished.get(key) ?? null,
      flag: flagged.get(key) ?? null,
      seasons: [...(shape?.counts ?? new Map())].map(([season, episodes]) => ({
        season,
        episodes,
      })),
      last_aired: shape?.lastAired ?? null,
      dismissed_at: library.dismissed.get(key) ?? null,
      title_watched: watchedTitles.has(key),
    });
    if (answer.action === 'none' || !answer.episode || seen.has(key)) continue;
    seen.add(key);
    // The position is the mark's only when the entry resumes the episode that mark is of.
    const resumes =
      answer.action === 'resume' &&
      mark?.seconds !== undefined &&
      mark.season === answer.episode.season &&
      mark.episode === answer.episode.episode;
    entries.push({
      ref,
      display: mark ? 'mark' : 'record',
      fraction: answer.fraction,
      episode: answer.episode,
      ...(resumes ? { seconds: mark.seconds, at: mark.updatedAt } : {}),
    });
  }

  const movies = library.records
    .filter((r) => !r.deleted && r.status === 'inProgress' && r.title.type === 'movie')
    .sort((a, b) => b.progressAt - a.progressAt);
  for (const record of movies) {
    const key = titleKey(record.title);
    if (dismissedSince(key, record.progressAt) || seen.has(key)) continue;
    seen.add(key);
    entries.push({
      ref: record.title,
      display: 'record',
      fraction: record.progress,
      ...(record.seconds !== undefined ? { seconds: record.seconds, at: record.progressAt } : {}),
    });
  }
  return entries;
}

/** Lay late title names and artwork over policy decisions, dropping entries that are not named yet. */
export function nameContinueCandidates(
  candidates: readonly ContinueCandidate[],
  library: Library,
): ContinueEntry[] {
  const records = new Map(library.records.map((record) => [titleKey(record.title), record.title]));
  const marks = new Map<string, { title: Title; updatedAt: number }>();
  for (const mark of library.marks) {
    const key = titleKey(mark);
    const current = marks.get(key);
    if (!current || mark.updatedAt > current.updatedAt)
      marks.set(key, {
        title: {
          type: mark.type as MediaType,
          id: mark.id,
          title: mark.title,
          posterPath: mark.posterPath,
          rating: mark.voteAverage,
        },
        updatedAt: mark.updatedAt,
      });
  }
  return candidates.flatMap(({ ref, display, ...entry }) => {
    const title = display === 'mark' ? marks.get(titleKey(ref))?.title : records.get(titleKey(ref));
    return title?.title ? [{ ...entry, title }] : [];
  });
}

/** Started series (the episode to resume or start next), then in-progress movies, newest first. */
export function continueWatching(library: Library): ContinueEntry[] {
  return nameContinueCandidates(new ContinueProjector().project(library), library);
}
