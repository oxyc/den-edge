import { normalizeViewingName as normalize } from './viewingImport';

const PART_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
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
  const words = normalize(rest)
    .replace(/^chapter \S+ /, '')
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return part === undefined ? { words } : { words, part };
}

function likeness(a: string, b: string): number {
  const pairs = (text: string) => {
    const out = new Map<string, number>();
    for (let at = 0; at < text.length - 1; at++) {
      const pair = text.slice(at, at + 2);
      out.set(pair, (out.get(pair) ?? 0) + 1);
    }
    return out;
  };
  const [left, right] = [pairs(a), pairs(b)];
  let shared = 0;
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
  return (2 * shared) / Math.max(1, a.length - 1 + (b.length - 1));
}

function oneEditApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let edits = 0;
  for (let l = 0, r = 0; l < left.length || r < right.length;) {
    if (left[l] === right[r]) {
      l++;
      r++;
      continue;
    }
    if (++edits > 1) return false;
    if (left.length >= right.length) l++;
    if (right.length >= left.length) r++;
  }
  return edits === 1;
}

/** TMDB's placeholder for an episode it has no name for: "Episode 3", "Episode Three". */
export const unnamedViewingEpisode = (name: string) =>
  /^(?:episode|chapter|ep|episodio|capitulo)\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.test(
    normalize(name),
  );

/** Match a provider's episode name to one TMDB episode without accepting a close but ambiguous name. */
export function findViewingEpisode(
  name: string,
  episodes: readonly { number: number; name: string }[],
): number | undefined {
  const wanted = normalize(name);
  if (!wanted) {
    const raw = (text: string) => text.normalize('NFC').replace(/\s+/g, '');
    return raw(name)
      ? episodes.find((episode) => raw(episode.name) === raw(name))?.number
      : undefined;
  }
  const exact = episodes.find((episode) => normalize(episode.name) === wanted);
  if (exact) return exact.number;
  const numbered =
    /^(?:episode|chapter|ep|episodio|capitulo)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.exec(
      wanted,
    )?.[1];
  const episodeNumber =
    numbered === undefined ? undefined : (PART_WORDS[numbered] ?? Number(numbered));
  if (episodeNumber !== undefined && episodes.some((episode) => episode.number === episodeNumber))
    return episodeNumber;
  const whole = episodes.filter((episode) => {
    const other = normalize(episode.name);
    return other.length >= 5 && (other.includes(wanted) || wanted.includes(other));
  });
  if (wanted.length >= 5 && whole.length === 1) return whole[0]!.number;

  const typo = episodes.filter((episode) => {
    const other = normalize(episode.name);
    return wanted.length >= 5 && other.length >= 5 && oneEditApart(wanted, other);
  });
  if (typo.length === 1) return typo[0]!.number;

  const inflection = episodes.filter((episode) => inflectionApart(wanted, normalize(episode.name)));
  if (inflection.length === 1) return inflection[0]!.number;

  const mine = reading(name);
  const theirs = episodes.map((episode) => ({ number: episode.number, ...reading(episode.name) }));
  if (
    mine.part !== undefined &&
    theirs.every((episode) => !episode.words && episode.part !== undefined)
  )
    return theirs.find((episode) => episode.part === mine.part)?.number;
  if (!mine.words) return undefined;
  const same = theirs.filter((episode) => episode.words === mine.words);
  const part =
    same.find((episode) => episode.part === mine.part) ?? (same.length === 1 ? same[0] : undefined);
  if (part) return part.number;

  if (mine.words.length >= 8) {
    const within = theirs.filter(
      (episode) =>
        episode.words.length >= 8 &&
        (episode.part === undefined || episode.part === mine.part) &&
        (episode.words.includes(mine.words) || mine.words.includes(episode.words)),
    );
    if (within.length === 1) return within[0]!.number;
  }

  const scored = theirs
    .filter((episode) => episode.part === mine.part && !unnamedViewingEpisode(episode.words))
    .map((episode) => ({ number: episode.number, score: likeness(mine.words, episode.words) }))
    .sort((left, right) => right.score - left.score);
  const [best, next] = scored;
  if (best && best.score >= 0.8 && best.score - (next?.score ?? 0) >= 0.1) return best.number;
  const bare = name.replace(/\s*\([^()]*\)\s*$/, '');
  return bare !== name && normalize(bare) ? findViewingEpisode(bare, episodes) : undefined;
}

function inflectionApart(left: string, right: string): boolean {
  const [a, b] = [left.split(' '), right.split(' ')];
  if (a.length !== b.length) return false;
  let changed = 0;
  for (const [at, word] of a.entries()) {
    const other = b[at]!;
    if (word === other) continue;
    if (++changed > 1 || !wordForms(word).some((form) => wordForms(other).includes(form)))
      return false;
  }
  return changed === 1;
}

function wordForms(word: string): string[] {
  const forms = [word];
  if (word.endsWith('ing') && word.length > 5) {
    const stem = word.slice(0, -3);
    forms.push(stem, `${stem}e`);
  }
  return forms;
}
