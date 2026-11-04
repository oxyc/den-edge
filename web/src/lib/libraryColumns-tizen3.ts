// Tizen 3's JavaScript policy core deliberately omits den-core's Wasm-backed LibraryColumns. Keep the same narrow
// transport contract for shared library callers, but project this reduced tier through the existing per-document
// policy operations. The held Map still makes document replacement/removal incremental; only a requested list fold
// is legacy work, and modern browser, webOS and Tizen builds continue to use den-core's indexed implementation.

import { watchedHistory } from './history';
import { selectHomeLibraryView } from './homeLibraryView';
import { applyLog, emptyLibrary, type MediaType, type Title } from './library';
import { projectDocument } from './libraryV4';
import {
  compareStamps,
  isDocument,
  newestSummary,
  rowName,
  ZERO_STAMP,
  type DocumentRow,
  type Row,
  type Stamp,
} from './wire';

type Column = Float64Array | string[];

/** The generated binding's read-only answer surface, backed by ordinary ES2015 values. */
class ColumnsAnswer {
  constructor(private readonly columns: Map<string, Column>) {}

  free(): void {}

  names(): string[] {
    return Array.from(this.columns.keys());
  }

  numbers(name: string): Float64Array | undefined {
    const column = this.columns.get(name);
    return column instanceof Float64Array ? column : undefined;
  }

  strings(name: string): string[] | undefined {
    const column = this.columns.get(name);
    return Array.isArray(column) ? column : undefined;
  }
}

class Answer {
  private readonly columns = new Map<string, Column>();

  numbers(name: string, values: Iterable<number>): void {
    this.columns.set(name, Float64Array.from(values));
  }

  strings(name: string, values: Iterable<string>): void {
    this.columns.set(name, Array.from(values));
  }

  refs(name: string, values: Iterable<{ type: string; id: number }>): void {
    const held = Array.from(values);
    this.numbers(
      `${name}.media`,
      held.map(({ type }) => (type === 'tv' ? 1 : 0)),
    );
    this.numbers(
      `${name}.id`,
      held.map(({ id }) => id),
    );
  }

  answer(): ColumnsAnswer {
    return new ColumnsAnswer(this.columns);
  }
}

function ref(key: string): { type: MediaType; id: number } {
  const colon = key.indexOf(':');
  return {
    type: key.slice(0, colon) as MediaType,
    id: Number(key.slice(colon + 1)),
  };
}

const number = (value: number | undefined): number => value ?? Number.NaN;
const boolean = (value: boolean | undefined): number =>
  value === undefined ? Number.NaN : value ? 1 : 0;

/** A Tizen 3-compatible projection with the LibraryColumns methods the shared log consumes. */
export class LibraryColumns {
  private readonly held = new Map<string, DocumentRow>();

  free(): void {
    this.held.clear();
  }

  len(): number {
    return this.held.size;
  }

  upsert(json: string): number {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) throw new Error('LibraryColumns expected a document array');
    const documents = parsed.map((value) => {
      if (!isDocument(value as Row)) throw new Error('LibraryColumns expected a document');
      const document = value as DocumentRow;
      return { name: rowName(document), document };
    });
    for (const { name, document } of documents) this.held.set(name, document);
    return this.held.size;
  }

  remove(name: string): boolean {
    return this.held.delete(name);
  }

  document(name: string): string | undefined {
    const document = this.held.get(name);
    return document === undefined ? undefined : JSON.stringify(document);
  }

  documents(): string {
    return JSON.stringify(Array.from(this.held.values()));
  }

  home(now: number): ColumnsAnswer {
    const rows = this.rows(now);
    const home = selectHomeLibraryView(applyLog(emptyLibrary(), rows), rows);
    const answer = new Answer();
    for (const name of [
      'owned',
      'watched',
      'watchlist',
      'shelfRefs',
      'requiredShapeRefs',
    ] as const) {
      const column =
        name === 'shelfRefs' ? 'shelf' : name === 'requiredShapeRefs' ? 'required' : name;
      answer.refs(column, home[name].map(ref));
    }
    answer.refs(
      'standings',
      home.standings.map(([key]) => ref(key)),
    );
    answer.strings(
      'standings.standing',
      home.standings.map(([, standing]) => standing),
    );
    answer.refs(
      'weighted',
      home.weighted.map(([key]) => ref(key)),
    );
    answer.numbers(
      'weighted.weight',
      home.weighted.map(([, weight]) => weight),
    );
    answer.numbers(
      'weighted.at',
      home.weighted.map(([, , at]) => at),
    );
    answer.refs('seeds.watched', home.seeds.watched.map(ref));
    answer.refs('seeds.watchlisted', home.seeds.watchlisted.map(ref));

    const { records, marks, flags, dismissed } = home.continueLibrary;
    answer.refs(
      'records',
      records.map(({ title }) => title),
    );
    answer.strings(
      'records.status',
      records.map(({ status }) => status),
    );
    answer.numbers(
      'records.progress',
      records.map(({ progress }) => progress),
    );
    answer.numbers(
      'records.progress_at',
      records.map(({ progressAt }) => progressAt),
    );
    answer.numbers(
      'records.seconds',
      records.map(({ seconds }) => number(seconds)),
    );
    answer.numbers(
      'records.playing',
      records.map(({ playing }) => boolean(playing)),
    );
    answer.strings(
      'records.by',
      records.map(({ progressBy }) => progressBy ?? ''),
    );
    answer.numbers(
      'records.added_at',
      records.map(({ addedAt }) => addedAt),
    );

    answer.refs('marks', marks);
    for (const name of ['season', 'episode', 'fraction', 'updatedAt'] as const)
      answer.numbers(
        name === 'updatedAt' ? 'marks.at' : `marks.${name}`,
        marks.map((mark) => mark[name]),
      );
    answer.numbers(
      'marks.seconds',
      marks.map(({ seconds }) => number(seconds)),
    );
    answer.numbers(
      'marks.playing',
      marks.map(({ playing }) => boolean(playing)),
    );
    answer.strings(
      'marks.by',
      marks.map(({ updatedBy }) => updatedBy ?? ''),
    );

    const flagValues = Array.from(flags?.values() ?? []);
    answer.refs('flags', flagValues);
    answer.numbers(
      'flags.season',
      flagValues.map(({ season }) => season),
    );
    answer.numbers(
      'flags.episode',
      flagValues.map(({ episode }) => episode),
    );
    const dismissedValues = Array.from(dismissed.entries());
    answer.refs(
      'dismissed',
      dismissedValues.map(([key]) => ref(key)),
    );
    answer.numbers(
      'dismissed.at',
      dismissedValues.map(([, at]) => at),
    );
    return answer.answer();
  }

  history(now: number): ColumnsAnswer {
    const rows = this.rows(now);
    const names = new Map<string, Title>();
    for (const { title } of this.held.values()) {
      const key = `${title.type}:${title.id}`;
      names.set(key, { type: title.type, id: title.id, title: key });
    }
    const history = watchedHistory(rows, names);
    const answer = new Answer();
    answer.refs(
      'history',
      history.map(({ title }) => title),
    );
    answer.numbers(
      'history.at',
      history.map(({ at }) => at),
    );
    answer.numbers(
      'history.season',
      history.map(({ episode }) => number(episode?.season)),
    );
    answer.numbers(
      'history.episode',
      history.map(({ episode }) => number(episode?.episode)),
    );
    answer.numbers(
      'history.episodes',
      history.map(({ episodes }) => episodes),
    );
    return answer.answer();
  }

  newest(now: number): ColumnsAnswer {
    let stamp: Stamp = ZERO_STAMP;
    let reconsiderAt = Infinity;
    for (const document of this.held.values()) {
      const summary = newestSummary(document, now);
      if (compareStamps(summary.stamp, stamp) > 0) stamp = summary.stamp;
      reconsiderAt = Math.min(reconsiderAt, summary.reconsiderAt ?? Infinity);
      if (document.kind !== 'season') continue;
      const episodes = document.episodes as Record<string, { plays?: Record<string, number> }>;
      for (const episode of Object.values(episodes ?? {}))
        for (const played of Object.values(episode.plays ?? {}))
          if (played > now + 86_400_000) reconsiderAt = Math.min(reconsiderAt, played - 86_400_000);
    }
    const answer = new Answer();
    answer.numbers('newest.t', [stamp[0]]);
    answer.numbers('newest.c', [stamp[1]]);
    answer.strings('newest.d', [stamp[2]]);
    answer.numbers('reconsider.at', [Number.isFinite(reconsiderAt) ? reconsiderAt : Number.NaN]);
    return answer.answer();
  }

  private rows(now: number): Row[] {
    const rows: Row[] = [];
    for (const document of this.held.values()) rows.push(...projectDocument(document, now));
    return rows;
  }
}
