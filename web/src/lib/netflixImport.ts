// Netflix's viewing history (Account › Profile › Viewing activity › Download all): one line per viewing, `Title,Date`,
// where an episode's title is `Show: Season 4: Episode name` and a film's is its own name. Read here, matched to TMDB
// titles and episodes, and turned into what to mark seen and when. Pure except for the lookups, which are passed in.

import type { Shape } from './library';

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
  /** TMDB's name, and its year, so a remake can be told from its original in the preview. */
  name: string;
  year?: number;
  /** What Netflix called it: the film's title, or the show's name. */
  source: string;
  season?: number;
  episode?: number;
  at: number;
}

/** A series' episodes per season and the last one aired (`tmdb.seriesShape`). */
export type Show = Shape;

export interface Plan {
  marks: Mark[];
  /** Each matched series' layout, by TMDB id: what says whether the history covers all of it. */
  shows: Record<number, Show>;
  /** Netflix titles nothing was found for, each once. */
  unmatched: string[];
  /** Lines whose date couldn't be read. */
  undated: number;
  /** Lines of films and series the library already has as seen, which were not looked into further. */
  known: number;
}

/** The TMDB lookups the matcher needs; each null or [] when TMDB can't answer. */
export interface Lookups {
  searchMulti(query: string): Promise<SearchHit[]>;
  searchTv(query: string): Promise<SearchHit[]>;
  show(id: number): Promise<Show | null>;
  episodes(id: number, season: number): Promise<{ number: number; name: string }[] | null>;
}

export interface SearchHit {
  type: 'movie' | 'tv';
  id: number;
  name: string;
  originalName?: string;
  year?: number;
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

// Not "Chapter": that is an episode's own number ("3%: Season 1: Chapter 01: Cubes").
const SEASON = /^(?:season|series|part|volume|vol\.|book|collection)\s+(\d+|[ivx]+)$/i;
const LIMITED = /^(?:limited series|miniseries|mini-series)$/i;

/** Roman numerals as Netflix numbers a show's parts ("The OA: Part II"). */
const ROMAN: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

/** The season a label names ("Season 4", "Series 5", "Part II", "S10"), or undefined for none. */
function seasonOf(label: string): number | undefined {
  if (LIMITED.test(label)) return 1;
  const short = /^s(\d+)$/i.exec(label)?.[1];
  if (short !== undefined) return Number(short);
  const [, number] = SEASON.exec(label) ?? [];
  if (number === undefined) return undefined;
  return /^\d+$/.test(number) ? Number(number) : ROMAN[number.toLowerCase()];
}

/**
 * Not a viewing: a trailer or preview Netflix lists among them ("Valeria: Season 1 Trailer: Valeria",
 * "Personal Shopper: Personal Shopper_hook_primary_16x9").
 */
export const isPreview = (title: string) =>
  /(?:^|: )[^:]*\btrailer(?::|$)/i.test(title) || /_hook_|_16x9\b/i.test(title);

/** A Netflix title as show, season and episode name, split at its last season label; otherwise a name. */
export function parseTitle(title: string): Parsed {
  const parts = title.split(': ');
  for (let i = parts.length - 2; i >= 1; i--) {
    const label = parts[i]!.trim();
    // "Stranger Things: Stranger Things 2: …" — the show's own name and a number is its season.
    const own = /^(.+?)\s+(\d+)$/.exec(label);
    const season =
      seasonOf(label) ??
      (own && normalize(own[1]!) === normalize(parts.slice(0, i).join(': '))
        ? Number(own[2])
        : undefined);
    if (season === undefined) continue;
    return {
      kind: 'episode',
      show: parts.slice(0, i).join(': '),
      season,
      episode: parts.slice(i + 1).join(': '),
    };
  }
  return { kind: 'name', name: title };
}

/** A name for comparing: accents, case, quote styles and punctuation left out; letters of every script kept. */
export function normalize(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const PART_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, ...ROMAN };

/**
 * An episode name as its words and the part of a two-parter it is: Netflix's "Six Days: Part 1", "Pt. 1",
 * "(Part One)" and "1/2" are TMDB's "Six Days (1)". A trailing ", The" goes back to the front, and a leading
 * "Chapter 01:" is dropped, since one side often has it and the other not.
 */
function reading(name: string): { words: string; part?: number } {
  let rest = name.trim().replace(/^(.*), (the|a|an)$/i, '$2 $1');
  let part: number | undefined;
  const found =
    /[\s:,-]*\(?\b(?:part|pt\.?)\s*(\d+|one|two|three|four|[ivx]+)\)?$/i.exec(rest) ??
    /\s*\((\d+)\)$/.exec(rest) ??
    /\s+(\d+)\s*\/\s*\d+$/.exec(rest);
  if (found) {
    part = PART_WORDS[found[1]!.toLowerCase()] ?? Number(found[1]);
    rest = rest.slice(0, found.index);
  }
  const words = normalize(rest).replace(/^chapter \S+ /, '');
  return part === undefined ? { words } : { words, part };
}

/** How alike two names read, 0 to 1: the share of letter pairs they have in common. */
function likeness(a: string, b: string): number {
  const pairs = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++)
      out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const [x, y] = [pairs(a), pairs(b)];
  let shared = 0;
  for (const [pair, n] of x) shared += Math.min(n, y.get(pair) ?? 0);
  const total = Math.max(1, a.length - 1 + (b.length - 1));
  return (2 * shared) / total;
}

/** TMDB's placeholder for an episode it has no name for: "Episode 3", "Episode Three". */
export const unnamed = (name: string) =>
  /^(?:episode|chapter|ep)\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.test(
    normalize(name),
  );

/**
 * The episode `name` is among `episodes`: the same name, "Episode 5" by number, the same part of a two-parter, one
 * name inside the other, or failing those the one name alike enough to it and clearly more alike than any other.
 */
export function findEpisode(
  name: string,
  episodes: readonly { number: number; name: string }[],
): number | undefined {
  const wanted = normalize(name);
  if (!wanted) return undefined;
  const exact = episodes.find((e) => normalize(e.name) === wanted);
  if (exact) return exact.number;
  const numbered = /^(?:episode|chapter|ep)\s*(\d+)$/.exec(wanted)?.[1];
  if (numbered !== undefined && episodes.some((e) => e.number === Number(numbered)))
    return Number(numbered);

  // One whole name inside the other ("Stranger Things 2: Chapter Five: Dig Dug" and "Chapter Five: Dig Dug").
  const whole = episodes.filter((e) => {
    const other = normalize(e.name);
    return other.length >= 8 && (other.includes(wanted) || wanted.includes(other));
  });
  if (wanted.length >= 8 && whole.length === 1) return whole[0]!.number;

  const mine = reading(name);
  const theirs = episodes.map((e) => ({ number: e.number, ...reading(e.name) }));
  // Episodes TMDB names by part alone ("Part I") are found by it: "Cora: Part I" is the first.
  if (mine.part !== undefined && theirs.every((e) => !e.words && e.part !== undefined))
    return theirs.find((e) => e.part === mine.part)?.number;
  if (!mine.words) return undefined;
  const same = theirs.filter((e) => e.words === mine.words);
  // A two-parter TMDB lists as one episode is that episode, whichever part Netflix says.
  const part = same.find((e) => e.part === mine.part) ?? (same.length === 1 ? same[0] : undefined);
  if (part) return part.number;

  // One name inside the other ("The Reunion" and "The Reunion Special"), when it is long enough to mean it.
  if (mine.words.length >= 8) {
    const within = theirs.filter(
      (e) =>
        e.words.length >= 8 &&
        (e.part === undefined || e.part === mine.part) &&
        (e.words.includes(mine.words) || mine.words.includes(e.words)),
    );
    if (within.length === 1) return within[0]!.number;
  }

  // "The One with Ross' Library Book" is TMDB's "Ross's"; "a Chick. And a Duck" is "the Chick and the Duck".
  const scored = theirs
    .filter((e) => e.part === mine.part && !unnamed(e.words))
    .map((e) => ({ number: e.number, score: likeness(mine.words, e.words) }))
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  return best && best.score >= 0.8 && best.score - (next?.score ?? 0) >= 0.1
    ? best.number
    : undefined;
}

/**
 * Every hit named exactly `query`, in TMDB's order, or, `loose`, TMDB's first where none is. More than one is common:
 * Marco Polo, Bordertown and The Ranch each have a namesake, and TMDB's first is often not Netflix's.
 */
function named(hits: SearchHit[], query: string, loose: boolean): SearchHit[] {
  const wanted = normalize(query);
  const exact = wanted
    ? hits.filter((h) => normalize(h.name) === wanted || normalize(h.originalName ?? '') === wanted)
    : [];
  return exact.length ? exact.slice(0, 4) : loose && hits[0] ? [hits[0]] : [];
}

/**
 * Every Netflix viewing matched to a TMDB film or episode, each marked once at its latest date. A film or series the
 * library already has as seen (`seen`) is left there once found: nothing more is looked up for it.
 */
export async function plan(
  viewings: readonly Viewing[],
  lookups: Lookups,
  progress?: (done: number, total: number) => void,
  seen: (ref: { type: 'movie' | 'tv'; id: number }) => boolean = () => false,
): Promise<Plan> {
  // A file whose every day is 12 or under reads either way; the order that puts no viewing in the future is the one.
  const inFuture = (dayFirstOrder: boolean) =>
    viewings.some((v) => (readDate(v.date, dayFirstOrder) ?? 0) > Date.now() + 86_400_000);
  const guessed = dayFirst(viewings.map((v) => v.date));
  const order = inFuture(guessed) && !inFuture(!guessed) ? !guessed : guessed;
  let undated = 0;
  // Latest date per Netflix title: a rewatch is one viewing more of the same thing.
  const latest = new Map<string, number>();
  for (const { title, date } of viewings) {
    if (isPreview(title)) continue;
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
    else {
      const lines = shows.get(parsed.show) ?? [];
      lines.push({ title, parsed });
      shows.set(parsed.show, lines);
    }
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
  // A show Netflix writes without a season label ("Stranger Things: Stranger Things 4: Chapter One: …") is searched
  // for from each of its episodes, so a search is asked once and shared.
  const searches = new Map<string, Promise<SearchHit[]>>();
  const searchTv = (query: string) => {
    const key = `tv:${query}`;
    if (!searches.has(key)) searches.set(key, lookups.searchTv(query));
    return searches.get(key)!;
  };
  const showCache = new Map<number, Promise<Show | null>>();
  const showOf = (id: number) => {
    if (!showCache.has(id)) showCache.set(id, lookups.show(id));
    return showCache.get(id)!;
  };
  const seasonsOf = async (id: number) => [...((await showOf(id))?.counts.keys() ?? [])];
  const layouts: Record<number, Show> = {};
  let known = 0;
  /** The series' layout, kept for the plan: asked for with its seasons, so it costs no lookup of its own. */
  const keep = async (id: number) => {
    const show = await showOf(id);
    if (show) layouts[id] = show;
  };
  /**
   * The episode by name: in the season Netflix named first, then in every other one — those asked for together, on
   * the first episode that needs them, rather than one season after another.
   */
  const locate = async (id: number, season: number | null, name: string) => {
    if (season !== null) {
      const number = findEpisode(name, (await episodesOf(id, season)) ?? []);
      if (number !== undefined) return { season, episode: number };
    }
    const others = (await seasonsOf(id)).filter((other) => other !== season && other > 0);
    const lists = await Promise.all(others.map((other) => episodesOf(id, other)));
    for (const [at, other] of others.entries()) {
      const number = findEpisode(name, lists[at] ?? []);
      if (number !== undefined) return { season: other, episode: number };
    }
    return undefined;
  };

  const total = shows.size + names.length;
  let done = 0;
  const tick = () => progress?.(++done, total);

  /**
   * Where each line is in the series `id`, by its episode's name; then, in a season whose episodes TMDB names only
   * "Episode 1, 2, …", the lines still unplaced take its unclaimed episodes in the order they were watched.
   */
  const place = async (
    id: number,
    lines: { title: string; season: number | null; episode: string }[],
  ) => {
    const found = await Promise.all(lines.map((line) => locate(id, line.season, line.episode)));
    const regular = (await seasonsOf(id)).filter((s) => s > 0).sort((a, b) => a - b);
    // A line with no season named, in a series of one season, is of that season.
    const only = regular.length === 1 ? regular[0]! : null;
    const claimed = new Set(found.flatMap((f) => (f ? [`${f.season}:${f.episode}`] : [])));
    const bySeason = new Map<number, number[]>();
    lines.forEach((line, at) => {
      const season = line.season ?? only;
      if (found[at] || season === null) return;
      bySeason.set(season, [...(bySeason.get(season) ?? []), at]);
    });
    for (const [season, waiting] of bySeason) {
      const list = (await episodesOf(id, season)) ?? [];
      if (!list.length || !list.every((e) => unnamed(e.name))) continue;
      const free = list
        .map((e) => e.number)
        .filter((n) => !claimed.has(`${season}:${n}`))
        .sort((a, b) => a - b);
      if (free.length < waiting.length) continue;
      waiting
        .sort((a, b) => latest.get(lines[a]!.title)! - latest.get(lines[b]!.title)!)
        .forEach((at, i) => (found[at] = { season, episode: free[i]! }));
    }
    return found;
  };

  const series = pool([...shows], 8, async ([show, lines]) => {
    const candidates = named(await searchTv(show), show, true);
    const asked = lines.map(({ title, parsed }) => ({
      title,
      season: parsed.season,
      episode: parsed.episode,
    }));
    // The namesake whose episodes the history names; TMDB's first where none of them fits better. Judged by names
    // alone: any series whose episodes TMDB leaves unnamed would take every line by the order they were watched,
    // which is how the 1994 Heartbreak High once took Netflix's.
    let best:
      { hit: SearchHit; found: Awaited<ReturnType<typeof place>>; byName: number } | undefined;
    for (const hit of candidates) {
      if (seen(hit)) {
        known += lines.length;
        return tick();
      }
      // Every season the history names, and the series' layout, asked for at once.
      const seasons = new Set(asked.flatMap((line) => (line.season === null ? [] : [line.season])));
      await Promise.all([
        keep(hit.id),
        ...[...seasons].map((season) => episodesOf(hit.id, season)),
      ]);
      const byName = (
        await Promise.all(asked.map((l) => locate(hit.id, l.season, l.episode)))
      ).filter(Boolean).length;
      const found = await place(hit.id, asked);
      const count = found.filter(Boolean).length;
      if (
        !best ||
        byName > best.byName ||
        (byName === best.byName && count > best.found.filter(Boolean).length)
      )
        best = { hit, found, byName };
      if (byName === lines.length) break;
    }
    lines.forEach(({ title }, at) => {
      const where = best?.found[at];
      if (best && where) add({ ...markOf(best.hit, show), ...where, at: latest.get(title)! });
      else unmatched.push(title);
    });
    tick();
  });

  // Films alongside the shows rather than after them; the lookups' own limit keeps the two from swamping den-edge.
  // A name whose first part several lines share ("Stranger Things: …") is a show's episodes: tried as one before
  // it is searched for as a film, which would be a lookup per episode for nothing.
  const firsts = new Map<string, number>();
  for (const title of names) {
    const first = title.split(': ')[0]!;
    if (first !== title) firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  /** `Show: Episode` lines with no season named, by the series they were found in, placed together at the end. */
  const seasonless = new Map<
    number,
    { hit: SearchHit; show: string; lines: { title: string; episode: string }[] }
  >();
  const films = pool(names, 12, async (title) => {
    const shared = (firsts.get(title.split(': ')[0]!) ?? 0) > 1;
    if (shared && (await asSeasonless(title))) return tick();
    // A film before a series of the same name: "Limitless" and "Trust" are both.
    const hits = named(await lookups.searchMulti(title), title, false);
    const film = hits.find((h) => h.type === 'movie');
    if (film) {
      if (seen(film)) known++;
      else add({ ...markOf(film, title), at: latest.get(title)! });
    } else if (shared || !(await asSeasonless(title))) unmatched.push(title);
    tick();
  });
  await Promise.all([series, films]);
  for (const { hit, show, lines } of seasonless.values()) {
    const found = await place(
      hit.id,
      lines.map((line) => ({ ...line, season: null })),
    );
    lines.forEach(({ title }, at) => {
      const where = found[at];
      if (where) add({ ...markOf(hit, show), ...where, at: latest.get(title)! });
      else unmatched.push(title);
    });
  }

  /**
   * `Show: Episode` with no season named: the longest leading part a series is named, the namesake it names an
   * episode of (or the first), kept to be placed with the rest of that series' lines. False when no series is.
   */
  async function asSeasonless(title: string): Promise<boolean> {
    const parts = title.split(': ');
    for (let i = parts.length - 1; i >= 1; i--) {
      const show = parts.slice(0, i).join(': ');
      const candidates = named(await searchTv(show), show, false);
      if (!candidates.length) continue;
      const episode = parts.slice(i).join(': ');
      let chosen = candidates[0]!;
      for (const hit of candidates) {
        if (seen(hit)) {
          known++;
          return true;
        }
        if (await locate(hit.id, null, episode)) {
          chosen = hit;
          break;
        }
      }
      await keep(chosen.id);
      const group = seasonless.get(chosen.id) ?? { hit: chosen, show, lines: [] };
      group.lines.push({ title, episode });
      seasonless.set(chosen.id, group);
      return true;
    }
    return false;
  }

  return { marks: [...marks.values()], shows: layouts, unmatched, undated, known };
}

/** A hit as a mark's identity: TMDB's name and year, and what Netflix called it. */
function markOf(hit: SearchHit, source: string): Omit<Mark, 'at'> {
  return {
    type: hit.type,
    id: hit.id,
    name: hit.name,
    ...(hit.year ? { year: hit.year } : {}),
    source,
  };
}

async function pool<T>(items: readonly T[], width: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
}

/** One film or series in the import's preview: its `type:id` (`importKey`), TMDB's name and year, and its episodes. */
export interface PreviewLine {
  key: string;
  label: string;
  /** What Netflix called it, where that isn't TMDB's name. */
  source?: string;
  episodes: number;
}

/** A line per film and series, series first, each by TMDB's name. */
export function previewLines(marks: readonly Mark[]): PreviewLine[] {
  const byKey = new Map<string, PreviewLine>();
  for (const mark of marks) {
    const key = `${mark.type}:${mark.id}`;
    const line = byKey.get(key);
    if (line) line.episodes++;
    else
      byKey.set(key, {
        key,
        label: mark.year ? `${mark.name} (${mark.year})` : mark.name,
        ...(normalize(mark.source) !== normalize(mark.name) ? { source: mark.source } : {}),
        episodes: mark.type === 'tv' ? 1 : 0,
      });
  }
  return [...byKey.values()].sort(
    (a, b) => Number(b.episodes > 0) - Number(a.episodes > 0) || a.label.localeCompare(b.label),
  );
}
