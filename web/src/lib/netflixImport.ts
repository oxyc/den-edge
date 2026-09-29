// Netflix's viewing history (Account › Profile › Viewing activity › Download all): one line per viewing, `Title,Date`,
// where an episode's title is `Show: Season 4: Episode name` and a film's is its own name. Read here, matched to TMDB
// titles and episodes, and turned into what to mark seen and when. Pure except for the lookups, which are passed in.

/** One line of the file: what Netflix called it, and the day it was watched. */
export interface Viewing {
  title: string;
  date: string;
}

/** What a Netflix title says it is: an episode of a show (its season, when named), or a name on its own. */
export type Parsed =
  | { kind: 'episode'; show: string; season: number | null; episode: string }
  | { kind: 'name'; name: string };

/** What the import will mark: a film, or one episode, each with the day it was last watched (local noon, ms). */
export interface Mark {
  type: 'movie' | 'tv';
  id: number;
  name: string;
  season?: number;
  episode?: number;
  at: number;
}

export interface Plan {
  marks: Mark[];
  /** Netflix titles nothing was found for, each once. */
  unmatched: string[];
  /** Lines whose date couldn't be read. */
  undated: number;
}

/** The TMDB lookups the matcher needs; each null or [] when TMDB can't answer. */
export interface Lookups {
  searchMulti(query: string): Promise<SearchHit[]>;
  searchTv(query: string): Promise<SearchHit[]>;
  seasons(id: number): Promise<number[]>;
  episodes(id: number, season: number): Promise<{ number: number; name: string }[] | null>;
}

export interface SearchHit {
  type: 'movie' | 'tv';
  id: number;
  name: string;
  originalName?: string;
}

/** The file's lines, comma- or tab-separated (a spreadsheet copy), quotes as CSV writes them; the header dropped. */
export function parseCsv(text: string): Viewing[] {
  const lines = text.trimStart().split(/\r?\n/);
  const out: Viewing[] = [];
  for (const line of lines) {
    const fields = splitLine(line);
    if (fields.length < 2) continue;
    const date = fields[fields.length - 1]!.trim();
    const title = fields.slice(0, -1).join(',').trim();
    if (!title || (/^title$/i.test(title) && /^date$/i.test(date))) continue;
    out.push({ title, date });
  }
  return out;
}

function splitLine(line: string): string[] {
  if (!line.includes('"')) return line.includes('\t') ? line.split('\t') : line.split(',');
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') {
      fields.push(field);
      field = '';
    } else field += c;
  }
  fields.push(field);
  return fields;
}

/**
 * Whether the file's dates are day-first. Netflix writes them in the account's own order (9/20/26 in the US,
 * 20/09/2026 elsewhere); a first number over 12 settles it, and so does a second one. Month-first when nothing does.
 */
export function dayFirst(dates: readonly string[]): boolean {
  for (const date of dates) {
    const [a, b] = date.split(/[/.-]/).map(Number);
    if (a !== undefined && a > 12) return true;
    if (b !== undefined && b > 12) return false;
  }
  return false;
}

/** A date as local noon of that day (ms), or null; a two-digit year is this century's. ISO dates read as ISO. */
export function readDate(date: string, dayFirstOrder: boolean): number | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date);
  const parts = iso
    ? [Number(iso[3]), Number(iso[2]), Number(iso[1])]
    : date.split(/[/.]/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return null;
  const [day, month, written] = iso || dayFirstOrder ? parts : [parts[1]!, parts[0]!, parts[2]!];
  const year = written! < 100 ? written! + 2000 : written!;
  const at = new Date(year, month! - 1, day!, 12);
  return at.getMonth() === month! - 1 && at.getDate() === day ? at.getTime() : null;
}

const SEASON = /^(?:season|series|part|volume|vol\.|chapter|book|collection)\s+(\d+)$/i;
const LIMITED = /^(?:limited series|miniseries|mini-series)$/i;

/** A Netflix title as show, season and episode name, split at its last season label; otherwise a name. */
export function parseTitle(title: string): Parsed {
  const parts = title.split(': ');
  for (let i = parts.length - 2; i >= 1; i--) {
    const label = parts[i]!.trim();
    const season = SEASON.exec(label)?.[1];
    if (season === undefined && !LIMITED.test(label)) continue;
    return {
      kind: 'episode',
      show: parts.slice(0, i).join(': '),
      season: season === undefined ? 1 : Number(season),
      episode: parts.slice(i + 1).join(': '),
    };
  }
  return { kind: 'name', name: title };
}

/** A name for comparing: accents, case, quote styles and punctuation left out. */
export function normalize(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The episode `name` is among `episodes`: the same name, or "Episode 5"/"Chapter 5" by number. */
export function findEpisode(
  name: string,
  episodes: readonly { number: number; name: string }[],
): number | undefined {
  const wanted = normalize(name);
  const exact = episodes.find((e) => normalize(e.name) === wanted);
  if (exact) return exact.number;
  const numbered = /^(?:episode|chapter|ep)\s*(\d+)$/.exec(wanted)?.[1];
  if (numbered !== undefined && episodes.some((e) => e.number === Number(numbered)))
    return Number(numbered);
  // One name inside the other ("The Reunion" and "The Reunion Special"), when it is long enough to mean it.
  if (wanted.length < 8) return undefined;
  const within = episodes.filter((e) => {
    const other = normalize(e.name);
    return other.length >= 8 && (other.includes(wanted) || wanted.includes(other));
  });
  return within.length === 1 ? within[0]!.number : undefined;
}

/** The hit named exactly `query`, or, for a show, TMDB's first. */
function pick(hits: SearchHit[], query: string, loose: boolean): SearchHit | undefined {
  const wanted = normalize(query);
  return (
    hits.find((h) => normalize(h.name) === wanted || normalize(h.originalName ?? '') === wanted) ??
    (loose ? hits[0] : undefined)
  );
}

/** Every Netflix viewing matched to a TMDB film or episode, each marked once at its latest date. */
export async function plan(
  viewings: readonly Viewing[],
  lookups: Lookups,
  progress?: (done: number, total: number) => void,
): Promise<Plan> {
  const order = dayFirst(viewings.map((v) => v.date));
  let undated = 0;
  // Latest date per Netflix title: a rewatch is one viewing more of the same thing.
  const latest = new Map<string, number>();
  for (const { title, date } of viewings) {
    const at = readDate(date, order);
    if (at === null) {
      undated++;
      continue;
    }
    latest.set(title, Math.max(latest.get(title) ?? 0, at));
  }

  const shows = new Map<
    string,
    { title: string; parsed: Extract<Parsed, { kind: 'episode' }> }[]
  >();
  const names: string[] = [];
  for (const title of latest.keys()) {
    const parsed = parseTitle(title);
    if (parsed.kind === 'name') names.push(title);
    else shows.set(parsed.show, [...(shows.get(parsed.show) ?? []), { title, parsed }]);
  }

  const marks = new Map<string, Mark>();
  const unmatched: string[] = [];
  const add = (mark: Mark) => {
    const key = `${mark.type}:${mark.id}:${mark.season ?? ''}:${mark.episode ?? ''}`;
    const had = marks.get(key);
    if (!had || had.at < mark.at) marks.set(key, mark);
  };

  const seasonCache = new Map<string, Promise<{ number: number; name: string }[] | null>>();
  const episodesOf = (id: number, season: number) => {
    const key = `${id}:${season}`;
    if (!seasonCache.has(key)) seasonCache.set(key, lookups.episodes(id, season));
    return seasonCache.get(key)!;
  };
  /** The episode by name: in the season Netflix named first, then in every other one. */
  const locate = async (id: number, season: number | null, name: string) => {
    if (season !== null) {
      const number = findEpisode(name, (await episodesOf(id, season)) ?? []);
      if (number !== undefined) return { season, episode: number };
    }
    for (const other of await lookups.seasons(id)) {
      if (other === season || other <= 0) continue;
      const number = findEpisode(name, (await episodesOf(id, other)) ?? []);
      if (number !== undefined) return { season: other, episode: number };
    }
    return undefined;
  };

  const total = shows.size + names.length;
  let done = 0;
  const tick = () => progress?.(++done, total);

  await pool([...shows], 4, async ([show, lines]) => {
    const hit = pick(await lookups.searchTv(show), show, true);
    for (const { title, parsed } of lines) {
      const found = hit && (await locate(hit.id, parsed.season, parsed.episode));
      if (hit && found)
        add({ type: 'tv', id: hit.id, name: hit.name, ...found, at: latest.get(title)! });
      else unmatched.push(title);
    }
    tick();
  });

  await pool(names, 4, async (title) => {
    const hit = pick(await lookups.searchMulti(title), title, false);
    if (hit?.type === 'movie')
      add({ type: 'movie', id: hit.id, name: hit.name, at: latest.get(title)! });
    else if (!(await asSeasonless(title))) unmatched.push(title);
    tick();
  });

  /** `Show: Episode` with no season named (a series of one), looked for in every season. */
  async function asSeasonless(title: string): Promise<boolean> {
    const parts = title.split(': ');
    for (let i = parts.length - 1; i >= 1; i--) {
      const show = parts.slice(0, i).join(': ');
      const hit = pick(await lookups.searchTv(show), show, false);
      if (!hit) continue;
      const found = await locate(hit.id, null, parts.slice(i).join(': '));
      if (!found) return false;
      add({ type: 'tv', id: hit.id, name: hit.name, ...found, at: latest.get(title)! });
      return true;
    }
    return false;
  }

  return { marks: [...marks.values()], unmatched, undated };
}

async function pool<T>(items: readonly T[], width: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
}
