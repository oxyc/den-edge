// Library v4 (den-spec wire/library-v4.md) as the web reads and writes it. The library is stored as documents, one per
// title and per season; the rest of the web still thinks in v2 title and episode rows, so a document is shown as the
// row it stands for (`projectDocument`) and an edit to such a row becomes den-core `apply_write` ops (`opsFor`). Every
// rule — what a write does, what a document derives — is den-core's.

import { WATCHED } from './actions';
import { syncPolicy } from './syncCore';
import {
  compareStamps,
  ZERO_STAMP,
  type DocumentRow,
  type EpisodeRow,
  type Row,
  type Stamp,
  type TitleRow,
  type WatchRow,
} from './wire';

/** One `apply_write` (§8): the title it touches, and the write. */
export interface Op {
  target: { type: 'movie' | 'tv'; id: number };
  write: Record<string, unknown>;
}

/** Equal values, whatever order their keys are in: den-core answers with sorted keys, the web writes its own order. */
const same = (a: unknown, b: unknown) => sorted(a) === sorted(b);
const sorted = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );

const projected = new WeakMap<DocumentRow, Row[]>();

/**
 * A document as the row the rest of the web reads: a title document as its `rec` row (`title_state`), a season
 * document as one `wat` row holding the whole season. A delivery document has no row to show.
 */
export function projectDocument(document: DocumentRow): Row[] {
  const known = projected.get(document);
  if (known) return known;
  let rows: Row[] = [];
  if (document.kind === 'title') rows = [projectTitle(document)];
  else if (document.kind === 'season')
    rows = [
      {
        kind: 'wat',
        schema: 3,
        title: { type: 'tv', id: document.title.id },
        season: document.season ?? 0,
        block: 0,
        seasonReset: (document.seasonReset as Stamp | null | undefined) ?? null,
        entries: (document.episodes ?? {}) as WatchRow['entries'],
      },
    ];
  projected.set(document, rows);
  return rows;
}

function projectTitle(document: DocumentRow): TitleRow {
  const state = syncPolicy<{
    status: TitleRow['status'] | null;
    resume: TitleRow['resume'] | null;
    reaction: TitleRow['reaction'] | null;
    deleted: TitleRow['deleted'] | null;
    dismissed: TitleRow['dismissed'] | null;
    episodesReset: Stamp | null;
    addedAt: number | null;
    watchedAt: number | null;
  }>({
    op: 'title_state',
    title: document,
    now: Date.now(),
  });
  // An absent field is import-owned, at the zero stamp (§3), which is how a v2 row says the same.
  return {
    kind: 'rec',
    schema: 2,
    title: { type: document.title.type, id: document.title.id },
    status: state.status ?? { value: 'none', at: ZERO_STAMP },
    resume: state.resume ?? { value: 0, at: ZERO_STAMP, viewing: 0 },
    reaction: state.reaction ?? { value: null, at: ZERO_STAMP },
    deleted: state.deleted ?? { value: false, at: ZERO_STAMP },
    dismissed: state.dismissed ?? { value: false, at: ZERO_STAMP },
    episodesReset: state.episodesReset ?? null,
    addedAt: state.addedAt ?? 0,
    watchedAt: state.watchedAt ?? null,
  };
}

/**
 * The writes one edit made: `before` is the title or episode row as it was read, `after` what the action made of it
 * (`actions.ts`). Playback (a position in seconds) is `progress`; marking an episode seen or not is `mark_watched`
 * or `unwatch`; a film's resume point follows whichever of the three its action was; the title's other fields are
 * one `title` write per stamp; a series un-watched is `series_reset`.
 */
export function opsFor(before: Row, after: Row): Op[] {
  if (before.kind === 'ep' && after.kind === 'ep') {
    if (same(before.progress, after.progress)) return [];
    const target = after.title;
    const { value, seconds, at } = after.progress;
    if (seconds !== undefined)
      return [
        {
          target,
          write: { kind: 'progress', episode: [after.season, after.episode], value, seconds, at },
        },
      ];
    return [
      {
        target,
        write: {
          kind: value >= WATCHED ? 'mark_watched' : 'unwatch',
          episodes: [[after.season, after.episode]],
          at,
        },
      },
    ];
  }
  if (before.kind !== 'rec' || after.kind !== 'rec') return [];
  const target = after.title;
  const ops: Op[] = [];
  let statusWritten = false;
  if (target.type === 'movie' && !same(before.resume, after.resume)) {
    const resume = after.resume;
    const statusChanged = !same(before.status, after.status);
    if (before.status.value === 'watched' && after.status.value === 'none' && resume.value === 0) {
      ops.push({ target, write: { kind: 'unwatch', at: resume.at } });
      statusWritten = true;
    } else if (
      after.status.value === 'watched' &&
      before.status.value !== 'watched' &&
      resume.value >= 1 &&
      resume.seconds === before.resume.seconds
    ) {
      ops.push({ target, write: { kind: 'mark_watched', at: resume.at } });
      statusWritten = true;
    } else {
      ops.push({
        target,
        write: {
          kind: 'progress',
          value: resume.value,
          ...(resume.seconds !== undefined ? { seconds: resume.seconds } : {}),
          ...(statusChanged ? { status: after.status.value } : {}),
          at: resume.at,
        },
      });
      statusWritten = statusChanged;
    }
  }
  if (after.episodesReset && !same(before.episodesReset, after.episodesReset))
    ops.push({ target, write: { kind: 'series_reset', at: after.episodesReset } });
  // One write per stamp: an action stamps every field it sets with its own one stamp.
  const byStamp = new Map<string, { at: Stamp; fields: Record<string, unknown> }>();
  for (const field of ['status', 'reaction', 'deleted', 'dismissed'] as const) {
    if ((field === 'status' && statusWritten) || same(before[field], after[field])) continue;
    const { value, at } = after[field];
    const group = byStamp.get(JSON.stringify(at)) ?? { at, fields: {} };
    group.fields[field] = value;
    byStamp.set(JSON.stringify(at), group);
  }
  const watchedAt =
    after.watchedAt !== null && after.watchedAt !== before.watchedAt ? after.watchedAt : undefined;
  const groups = [...byStamp.values()];
  // A title new to the library gets its `addedAt` with its first write, even one that sets no field.
  if (!groups.length && ops.length) groups.push({ at: newestOf(after), fields: {} });
  for (const { at, fields } of groups)
    ops.push({
      target,
      write: {
        kind: 'title',
        fields,
        added_at: after.addedAt,
        ...(watchedAt !== undefined ? { watched_at: watchedAt } : {}),
        at,
      },
    });
  return ops;
}

function newestOf(row: TitleRow): Stamp {
  return [row.status.at, row.resume.at, row.reaction.at, row.deleted.at, row.dismissed.at].reduce(
    (a, b) => (compareStamps(b, a) > 0 ? b : a),
    ZERO_STAMP,
  );
}

/**
 * `ops` applied, in order, to the documents `stored` holds: the documents that changed. A `title` write sets only the
 * fields whose stamp is later than the stored one, so a write kept and sent late never sets a field back.
 */
export function applyOps(
  ops: Op[],
  stored: (name: string) => DocumentRow | undefined,
  now = Date.now(),
): DocumentRow[] {
  const changed = new Map<string, DocumentRow>();
  const read = (name: string) => changed.get(name) ?? stored(name);
  for (const { target, write } of ops) {
    const key = `${target.type}:${target.id}`;
    const title = read(`title:${key}`);
    let applied = write;
    if (write.kind === 'title' && title) {
      const fields = Object.fromEntries(
        Object.entries(write.fields as Record<string, unknown>).filter(([field]) => {
          const held = (title[field] as { at?: Stamp } | undefined)?.at ?? ZERO_STAMP;
          return compareStamps(write.at as Stamp, held) > 0;
        }),
      );
      applied = { ...write, fields };
    }
    const seasons = [...new Set(seasonsOf(write))]
      .map((season) => read(`season:${key}:${season}`))
      .filter((document): document is DocumentRow => document !== undefined);
    const { documents } = syncPolicy<{ documents: DocumentRow[] }>({
      op: 'apply_write',
      write: applied,
      target,
      ...(title ? { title } : {}),
      seasons,
      now,
    });
    for (const document of documents) {
      const name =
        document.kind === 'title' ? `title:${key}` : `season:${key}:${document.season ?? 0}`;
      changed.set(name, document);
    }
  }
  return [...changed.values()];
}

function seasonsOf(write: Record<string, unknown>): number[] {
  if (Array.isArray(write.episode)) return [write.episode[0] as number];
  if (Array.isArray(write.episodes))
    return (write.episodes as number[][]).map(([season]) => season!);
  if (typeof write.season === 'number') return [write.season];
  return [];
}

/** The names of the documents `ops` read: a write touching one this build may not write is held (§4). */
export function touched(ops: Op[]): string[] {
  return ops.flatMap(({ target, write }) => {
    const key = `${target.type}:${target.id}`;
    return [`title:${key}`, ...seasonsOf(write).map((season) => `season:${key}:${season}`)];
  });
}

/** An episode's row from its season document, as the TV's own episode reads (`episode_state`). */
export function projectEpisode(
  title: DocumentRow | undefined,
  season: DocumentRow,
  ref: { id: number },
  seasonNumber: number,
  episode: number,
): EpisodeRow | undefined {
  if (!(season.episodes as Record<string, unknown> | undefined)?.[String(episode)])
    return undefined;
  const state = syncPolicy<{
    watched: boolean;
    resume: EpisodeRow['progress'] | null;
    viewing: number;
    watched_at: number | null;
  }>({
    op: 'episode_state_v4',
    ...(title ? { title } : {}),
    season,
    episode,
    now: Date.now(),
  });
  const at: Stamp = state.resume?.at ?? (state.watched_at ? [state.watched_at, 0, ''] : ZERO_STAMP);
  return {
    kind: 'ep',
    schema: 2,
    title: { type: 'tv', id: ref.id },
    season: seasonNumber,
    episode,
    progress: state.resume ?? { value: state.watched ? 1 : 0, viewing: state.viewing, at },
  };
}
