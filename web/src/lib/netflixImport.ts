// Netflix's viewing history (Account › Profile › Viewing activity › Download all): one line per viewing, `Title,Date`,
// where an episode's title is `Show: Season 4: Episode name` and a film's is its own name. Read here, matched to TMDB
// titles and episodes, and turned into what to mark seen and when. Pure except for the lookups, which are passed in.

import { parseDelimitedRows } from './viewingImportCsv';
import {
  isViewingPreview,
  normalizeViewingName,
  viewingFilmKey,
  viewingPreviewLines,
  type ImportShow,
  type ViewingImportPlan,
  type ViewingLookups,
  type ViewingMark,
  type ViewingPreviewLine,
  type ViewingSearchHit,
} from './viewingImport';
import { findViewingEpisode, unnamedViewingEpisode } from './viewingImportMatch';

export type Mark = ViewingMark;
export type Show = ImportShow;
export type Plan = ViewingImportPlan;
export type Lookups = ViewingLookups;
export type SearchHit = ViewingSearchHit;

/** One line of the file: what Netflix called it, and the day it was watched. */
export interface Viewing {
  title: string;
  date: string;
}

/** What a Netflix title says it is: an episode of a show (its season, when named), or a name on its own. */
export type Parsed =
  | {
      kind: 'episode';
      show: string;
      season: number | null;
      episode: string;
      /** The label and the name together, which is the episode's own name where the label is part of it. */
      full?: string;
    }
  | { kind: 'name'; name: string };

/** The file's lines, comma- or tab-separated (a spreadsheet copy), quotes as CSV writes them; the header dropped. */
export function parseCsv(text: string): Viewing[] {
  const out: Viewing[] = [];
  for (const fields of parseDelimitedRows(text)) {
    if (fields.length < 2) continue;
    const date = fields[fields.length - 1]!.trim();
    const title = fields.slice(0, -1).join(',').trim();
    if (!title || (/^title$/i.test(title) && /^date$/i.test(date))) continue;
    out.push({ title, date });
  }
  return out;
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
  // "The Chef Show: Season 2 - Volume 1", "The World's Most Extraordinary Homes: Season 2 Part B": season 2.
  const split = /^(?:season|series)\s+(\d+)\s*[-–]?\s*(?:part|volume|vol\.)\s+\w+$/i.exec(
    label,
  )?.[1];
  if (split !== undefined) return Number(split);
  const [, number] = SEASON.exec(label) ?? [];
  if (number === undefined) return undefined;
  return /^\d+$/.test(number) ? Number(number) : ROMAN[number.toLowerCase()];
}

/**
 * Not a viewing: a trailer or preview Netflix lists among them ("Valeria: Season 1 Trailer: Valeria",
 * "Personal Shopper: Personal Shopper_hook_primary_16x9").
 */
export const isPreview = isViewingPreview;

/**
 * A line naming two episodes or more, as one line each: Netflix lists a double bill as one viewing ("The Killing:
 * Season 3: From Up Here / The Road to Hamelin"), and a children's show its short stories together.
 */
export function joined(title: string): string[] {
  if (parseTitle(title).kind !== 'episode') return [title];
  const at = title.lastIndexOf(': ');
  const [head, tail] = [title.slice(0, at + 2), title.slice(at + 2)];
  return tail.includes(' / ') ? tail.split(' / ').map((part) => head + part.trim()) : [title];
}

/** A Netflix title as show, season and episode name, split at its first season label; otherwise a name. */
export function parseTitle(title: string): Parsed {
  const parts = title.split(': ');
  // The first label: what follows it can carry one of its own ("Midnight Mass: Limited Series: Book I: Genesis").
  for (let i = 1; i <= parts.length - 2; i++) {
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
      // "Midnight Mass: Book I: Genesis" is season 1, but its episode is TMDB's "Book I: Genesis".
      full: parts.slice(i).join(': '),
    };
  }
  return { kind: 'name', name: title };
}

/** A name for comparing: accents, case, quote styles and punctuation left out; letters of every script kept. */
export const normalize = normalizeViewingName;

/**
 * A film's name for comparing, a leading article and spelt-out numbers aside: Netflix's "School of Rock",
 * "1,000 Times Good Night" and "Three Generations" are TMDB's "The School of Rock", "A Thousand Times Good Night"
 * and "3 Generations".
 */
export const filmKey = viewingFilmKey;

export const unnamed = unnamedViewingEpisode;
export const findEpisode = findViewingEpisode;

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
    for (const one of joined(title)) latest.set(one, Math.max(latest.get(one) ?? 0, at));
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
  /**
   * The series named `show`, in TMDB's order. Netflix tells namesakes apart by a year in the name ("Tales of the City
   * (1993)", "Further Tales of the City (2001)"), which TMDB's search finds nothing for: it is searched without the
   * year, and only a series first aired that year is kept.
   */
  const namesakes = async (show: string) => {
    const dated = /^(.*\S)\s*\((\d{4})\)$/.exec(show);
    const name = dated?.[1] ?? show;
    const found = named(await searchTv(name), name, false);
    return dated ? found.filter((hit) => hit.year === Number(dated[2])) : found;
  };
  /**
   * A show's candidates: its namesakes; or, where TMDB names none so, what the search finds under another name (TMDB's
   * alternative titles take "The Defeated" to Shadowplay, "Entrapped" to Trapped) or under a shorter one ("Itxaso and
   * the Sea" is TMDB's "Itxaso"). Only a namesake is taken on trust: any other has to be borne out by its episodes.
   */
  const candidatesFor = async (
    show: string,
  ): Promise<{ hit: SearchHit; exact: boolean; first?: boolean }[]> => {
    const exact = await namesakes(show);
    if (exact.length) return exact.map((hit) => ({ hit, exact: true }));
    const hits = await searchTv(show);
    if (hits.length)
      return hits.slice(0, 4).map((hit, at) => ({ hit, exact: false, first: at === 0 }));
    const words = show.split(' ');
    for (let n = words.length - 1; n >= 1 && n >= words.length - 3; n--) {
      const shorter = words.slice(0, n).join(' ');
      if (normalize(shorter).length < 4) break;
      const found = await searchTv(shorter);
      if (found.length) return found.slice(0, 4).map((hit) => ({ hit, exact: false }));
    }
    return [];
  };
  const seasonsOf = async (id: number) => [...((await showOf(id))?.counts.keys() ?? [])];
  const layouts: Record<number, Show> = {};
  let known = 0;
  let covered = 0;
  /** The series' layout, kept for the plan: asked for with its seasons, so it costs no lookup of its own. */
  const keep = async (id: number) => {
    const show = await showOf(id);
    if (show) layouts[id] = show;
  };
  /**
   * The episode by name: in the season Netflix named first, then in every other one — those asked for together, on
   * the first episode that needs them, rather than one season after another.
   */
  const locate = async (
    id: number,
    season: number | null,
    name: string,
    full?: string,
  ): Promise<{ season: number; episode: number } | undefined> => {
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
    const whole = full && full !== name ? await locate(id, season, full) : undefined;
    if (whole) return whole;
    // A label ahead of the name: "Love Is Blind: S10: Ohio: Um, Redo!", "Manhunt: Unabomber: Ted".
    const after = name.indexOf(': ');
    return after > 0 ? locate(id, season, name.slice(after + 2)) : undefined;
  };

  const total = shows.size + names.length;
  let done = 0;
  const tick = () => progress?.(++done, total);

  /**
   * Where each line is in the series `id`, by its episode's name. The lines still unplaced then take the aired
   * episodes still unclaimed, in the order they were watched, wherever that is beyond doubt: a season TMDB names
   * only "Episode 1, 2, …", or one where as many lines are left as episodes, so every episode was watched whatever
   * each is called. Lines with no season named are judged against the whole series the same way.
   */
  const place = async (
    id: number,
    lines: { title: string; season: number | null; episode: string; full?: string }[],
    netflixName?: string,
  ) => {
    const found = await Promise.all(
      lines.map((line) => locate(id, line.season, line.episode, line.full)),
    );
    const show = await showOf(id);
    const regular = [...(show?.counts.keys() ?? [])].filter((s) => s > 0).sort((a, b) => a - b);
    const last = show?.lastAired;
    const aired = (season: number, episode: number) =>
      !last ||
      last.season <= 0 ||
      season < last.season ||
      (season === last.season && episode <= last.episode);
    const claimed = new Set(found.flatMap((f) => (f ? [`${f.season}:${f.episode}`] : [])));
    /** The aired, unclaimed episodes of `seasons`, in order; null when a season's list can't be had. */
    const free = async (seasons: number[]) => {
      const out: { season: number; episode: number; named: boolean }[] = [];
      for (const season of seasons) {
        const list = await episodesOf(id, season);
        if (!list) return null;
        for (const e of [...list].sort((a, b) => a.number - b.number))
          if (aired(season, e.number) && !claimed.has(`${season}:${e.number}`))
            out.push({ season, episode: e.number, named: !unnamed(e.name) });
      }
      return out;
    };
    const assign = (waiting: number[], slots: { season: number; episode: number }[]) =>
      waiting
        .sort((a, b) => latest.get(lines[a]!.title)! - latest.get(lines[b]!.title)!)
        .forEach((at, i) => {
          const slot = slots[i]!;
          found[at] = { season: slot.season, episode: slot.episode };
          claimed.add(`${slot.season}:${slot.episode}`);
        });

    // Netflix calls a first episode "Pilot", or by the show's own name ("Community: Season 1: Community"), where TMDB
    // has its story's name (Travelers, Blindspot, The O.C.). Placed here rather than found by name, so it never tells
    // two namesakes apart ("WHAT / IF" and "What If...?").
    const pilot = (episode: string) =>
      normalize(episode) === 'pilot' ||
      (!!netflixName && normalize(episode) === normalize(netflixName));
    for (const [at, line] of lines.entries()) {
      const season = line.season ?? 1;
      if (found[at] || !pilot(line.episode) || claimed.has(`${season}:1`)) continue;
      if (!(await episodesOf(id, season))?.some((e) => e.number === 1)) continue;
      found[at] = { season, episode: 1 };
      claimed.add(`${season}:1`);
    }

    const bySeason = new Map<number | null, number[]>();
    lines.forEach((line, at) => {
      if (found[at]) return;
      const season = line.season ?? (regular.length === 1 ? regular[0]! : null);
      bySeason.set(season, [...(bySeason.get(season) ?? []), at]);
    });
    for (const [season, waiting] of bySeason) {
      const slots = await free(season === null ? regular : [season]);
      if (!slots?.length) continue;
      const placeholders = slots.every((s) => !s.named);
      if (slots.length === waiting.length || (placeholders && slots.length > waiting.length))
        assign(waiting, slots);
    }
    return found;
  };

  /**
   * Whether a series found only under another name is the one `lines` are of: two lines found by their own episode
   * names — "Episode 3" is not one, it names an episode of any series — or, three lines or more, one line for each
   * episode it has aired, every one placed. Measured on a real history: "Episode N" alone took "Zero" to Hawaii Five-0
   * and "Case" to Cold Case, and one coincidental name took "Through My Window 2" to an unrelated series.
   */
  const borneOut = async (
    id: number,
    lines: { season: number | null; episode: string; full?: string }[],
    found: Awaited<ReturnType<typeof place>>,
  ) => {
    const byName = await Promise.all(
      lines.map((l) => (unnamed(l.episode) ? undefined : locate(id, l.season, l.episode, l.full))),
    );
    if (byName.filter(Boolean).length >= 2) return true;
    const show = await showOf(id);
    if (!show || lines.length < 3 || !found.every(Boolean)) return false;
    const last = show.lastAired;
    let aired = 0;
    for (const [season, count] of show.counts) {
      if (season <= 0) continue;
      if (!last || last.season <= 0 || season < last.season) aired += count;
      else if (season === last.season) aired += Math.min(count, last.episode);
    }
    return lines.length === aired;
  };

  const series = pool([...shows], 8, async ([show, lines]) => {
    const candidates = await candidatesFor(show);
    const asked = lines.map(({ title, parsed }) => ({
      title,
      season: parsed.season,
      episode: parsed.episode,
      ...(parsed.full ? { full: parsed.full } : {}),
    }));
    // The namesake whose episodes the history names; TMDB's first where none of them fits better. Judged by names
    // alone: any series whose episodes TMDB leaves unnamed would take every line by the order they were watched,
    // which is how the 1994 Heartbreak High once took Netflix's. With no namesake, TMDB's first hit is taken as
    // before (Netflix's "Love on the Spectrum: Australia" is TMDB's "Love on the Spectrum"); any other series found
    // under another name counts only where its episodes bear it out (`borneOut`).
    let best:
      | {
          hit: SearchHit;
          exact: boolean;
          found: Awaited<ReturnType<typeof place>>;
          byName: number;
        }
      | undefined;
    for (const { hit, exact, first } of candidates) {
      if (exact && seen(hit)) {
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
        await Promise.all(asked.map((l) => locate(hit.id, l.season, l.episode, l.full)))
      ).filter(Boolean).length;
      const found = await place(hit.id, asked, show);
      const count = found.filter(Boolean).length;
      if (!exact && !first && !(await borneOut(hit.id, asked, found))) continue;
      if (
        !best ||
        byName > best.byName ||
        (byName === best.byName && count > best.found.filter(Boolean).length)
      )
        best = { hit, exact, found, byName };
      if (byName === lines.length) break;
    }
    if (best && !best.exact && seen(best.hit)) {
      known += lines.length;
      return tick();
    }
    const taken = new Set(best?.found.flatMap((f) => (f ? [`${f.season}:${f.episode}`] : [])));
    /** As many of this show's other lines are of `season` as TMDB counts episodes in it. */
    const whole = async (season: number | null) => {
      const count = best && season !== null ? (await showOf(best.hit.id))?.counts.get(season) : 0;
      return !!count && [...taken].filter((key) => key.startsWith(`${season}:`)).length >= count;
    };
    for (const [at, { title, parsed }] of lines.entries()) {
      const where = best?.found[at];
      if (best && where) add({ ...markOf(best.hit, show), ...where, at: latest.get(title)! });
      else if (await whole(parsed.season)) covered++;
      else unmatched.push(title);
    }
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
  /**
   * The same, for a show TMDB names nothing so: its lines by Netflix's name, with what the search found under
   * another name. Which of those it is — if any — is judged once every line is in (`borneOut`), and never shares
   * trust with a series' own lines ("Entrapped" is TMDB's Trapped, but not the season its own lines are of).
   */
  const unnamedShows = new Map<
    string,
    { candidates: SearchHit[]; lines: { title: string; episode: string }[] }
  >();
  /**
   * The film a name is: TMDB's first of that name (`filmKey`) that was out by the year it was watched — a film before
   * a series of the same name, since "Limitless" and "Trust" are both. Where the combined search has none, TMDB's
   * films alone, three pages deep: the 2018 "Girl" is not among the first twenty things called something with "girl".
   */
  const findFilm = async (title: string, shorter = false): Promise<SearchHit | undefined> => {
    // A line with no show's name (": Episode 7") is an episode of something unnamed, never the film "Episode 7".
    if (title.startsWith(': ')) return undefined;
    const key = filmKey(title);
    const watched = new Date(latest.get(title)!).getFullYear();
    const first = (hits: SearchHit[], wanted = key) =>
      hits.find(
        (h) =>
          h.type === 'movie' &&
          (filmKey(h.name) === wanted || filmKey(h.originalName ?? '') === wanted) &&
          (!h.year || h.year <= watched),
      );
    const hits = await lookups.searchMulti(title);
    if (shorter) {
      // What TMDB's search puts first for the whole name, named as Netflix's without what it added: a subtitle
      // ("JOY - The Birth of IVF" is "JOY", "Hippocrates: Diary of a French Doctor" the film "Hippocrates") or a
      // sequel's number ("Through My Window 2: Across the Sea"). Asked last, once the line is no series' episode.
      const bare = title.split(/ [-–] |: /)[0]!;
      const unnumbered = title.replace(/ \d+(?=: )/, '');
      for (const wanted of [bare, unnumbered])
        if (wanted !== title) {
          const found = first(hits.slice(0, 3), filmKey(wanted));
          if (found) return found;
        }
      return undefined;
    }
    const found = first(hits);
    if (found || !lookups.searchMovie || !key) return found;
    for (let page = 1; page <= 3; page++) {
      const hits = await lookups.searchMovie(title, page);
      const more = first(hits);
      if (more || hits.length < 20) return more;
    }
    return undefined;
  };
  const films = pool(names, 12, async (title) => {
    const shared = (firsts.get(title.split(': ')[0]!) ?? 0) > 1;
    if (shared && (await asSeasonless(title))) return tick();
    const film = await findFilm(title);
    if (film) {
      if (seen(film)) known++;
      else add({ ...markOf(film, title), at: latest.get(title)! });
    } else if (shared || !((await asSeasonless(title)) || (await asWhole(title)))) {
      if (shared || !(await lastFilm(title, true))) unmatched.push(title);
    }
    tick();
  });
  /** A line no series had as an episode, as a film after all (`findFilm`); false, and nothing marked, for none. */
  async function lastFilm(title: string, shorter: boolean): Promise<boolean> {
    const film = (await findFilm(title)) ?? (shorter ? await findFilm(title, true) : undefined);
    if (!film) return false;
    if (seen(film)) known++;
    else add({ ...markOf(film, title), at: latest.get(title)! });
    return true;
  }
  /**
   * A name with no episode that TMDB has as a series of that name, of three episodes or fewer, out by the year it
   * was watched: a TV film or two-parter ("Love in Lapland"), marked whole.
   */
  async function asWhole(title: string): Promise<boolean> {
    const watched = new Date(latest.get(title)!).getFullYear();
    for (const hit of await namesakes(title)) {
      if (hit.year && hit.year > watched) continue;
      const seasons = [...((await showOf(hit.id))?.counts ?? [])].filter(([season]) => season > 0);
      const total = seasons.reduce((sum, [, count]) => sum + count, 0);
      if (total < 1 || total > 3) continue;
      if (seen(hit)) known++;
      else {
        await keep(hit.id);
        for (const [season, count] of seasons)
          for (let episode = 1; episode <= count; episode++)
            add({ ...markOf(hit, title), season, episode, at: latest.get(title)! });
      }
      return true;
    }
    return false;
  }
  await Promise.all([series, films]);
  for (const { hit, show, lines } of seasonless.values()) {
    const found = await place(
      hit.id,
      lines.map((line) => ({ ...line, season: null })),
      show,
    );
    for (const [at, { title }] of lines.entries()) {
      const where = found[at];
      if (where) {
        add({ ...markOf(hit, show), ...where, at: latest.get(title)! });
        continue;
      }
      // Not an episode of the series its name starts with, but maybe a film of it ("Bordertown: Mural Murders"), or a
      // film a series merely shares a name with ("Hippocrates: Diary of a French Doctor"), when it is the one line.
      if (!(await lastFilm(title, lines.length === 1))) unmatched.push(title);
    }
  }
  for (const [show, { candidates, lines }] of unnamedShows) {
    let taken = false;
    for (const hit of candidates) {
      await keep(hit.id);
      // A season TMDB gives Netflix's name for the show is the one the lines are of, which bears the series out
      // on its own: "Entrapped: Episode 3" is Trapped's third season's third episode.
      const own = [...((await showOf(hit.id))?.seasonNames ?? [])].find(
        ([season, name]) => season > 0 && normalize(name) === normalize(show),
      )?.[0];
      const asked = lines.map((line) => ({ ...line, season: own ?? null }));
      const found = await place(hit.id, asked, show);
      if (own === undefined && !(await borneOut(hit.id, asked, found))) continue;
      taken = true;
      if (seen(hit)) known += lines.length;
      else
        lines.forEach(({ title }, at) => {
          const where = found[at];
          if (where) add({ ...markOf(hit, show), ...where, at: latest.get(title)! });
          else unmatched.push(title);
        });
      break;
    }
    if (!taken)
      for (const { title } of lines)
        if (!(await lastFilm(title, lines.length === 1))) unmatched.push(title);
  }

  /**
   * `Show: Episode` with no season named: the longest leading part a series is named, the namesake it names an
   * episode of (or the first), kept to be placed with the rest of that series' lines. False when no series is.
   */
  async function asSeasonless(title: string): Promise<boolean> {
    const parts = title.split(': ');
    for (let i = parts.length - 1; i >= 1; i--) {
      const show = parts.slice(0, i).join(': ');
      const candidates = await namesakes(show);
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
    // No series of that name at any split: one found under another name, judged once all its lines are in.
    for (let i = parts.length - 1; i >= 1; i--) {
      const show = parts.slice(0, i).join(': ');
      const candidates = (await candidatesFor(show)).map((c) => c.hit);
      if (!candidates.length) continue;
      const group = unnamedShows.get(show) ?? { candidates, lines: [] };
      group.lines.push({ title, episode: parts.slice(i).join(': ') });
      unnamedShows.set(show, group);
      return true;
    }
    return false;
  }

  return { marks: [...marks.values()], shows: layouts, unmatched, undated, known, covered };
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
export type PreviewLine = ViewingPreviewLine;

/** A line per film and series, series first, each by TMDB's name. */
export function previewLines(marks: readonly Mark[]): PreviewLine[] {
  return viewingPreviewLines(marks);
}
