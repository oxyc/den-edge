// What atlas can browse a title by beyond its people (`/index/title`): its production companies, networks,
// subjects, places and source authors, each with the id Search selects it by and how many titles carry it; and its
// moods, as atlas's labels name them.

import type { MediaType } from './library';
import { relayFetch } from './relayFetch';

/** A value Search can select: `company-<id>`, `network-<id>`, …; `titles` is how many titles carry it. */
export interface Browsable {
  id: string;
  name: string;
  titles: number;
}

export interface TitleFacts {
  companies: Browsable[];
  networks: Browsable[];
  subjects: Browsable[];
  places: Browsable[];
  authors: Browsable[];
  /** atlas's mood labels (`Dark & Gritty`), as its filter takes them. */
  moods: string[];
  /** Its countries of origin, as ISO codes (`ES`). */
  countries: string[];
}

export const NO_FACTS: TitleFacts = {
  companies: [],
  networks: [],
  subjects: [],
  places: [],
  authors: [],
  moods: [],
  countries: [],
};

function browsable(list: unknown): Browsable[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((value): Browsable[] => {
    const { id, name, titles } = (value ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !/^Q[1-9]\d*$/.test(id) || typeof name !== 'string') return [];
    const clean = name.trim();
    return clean ? [{ id, name: clean, titles: typeof titles === 'number' ? titles : 0 }] : [];
  });
}

export function parseTitleFacts(body: unknown): TitleFacts {
  const at = (body ?? {}) as Record<string, unknown>;
  const moods = ((at.labels ?? {}) as Record<string, unknown>).moods;
  return {
    companies: browsable(at.companies),
    networks: browsable(at.networks),
    subjects: browsable(at.subjects),
    places: browsable(at.places),
    authors: browsable(at.authors),
    moods: Array.isArray(moods)
      ? moods.filter((mood): mood is string => typeof mood === 'string' && mood.trim() !== '')
      : [],
    countries: Array.isArray(at.countries)
      ? at.countries.filter((id): id is string => typeof id === 'string' && /^[A-Z]{2}$/.test(id))
      : [],
  };
}

/** An atlas without these fields, or none at all, answers `NO_FACTS`: the page shows what TMDB names, unlinked. */
export async function fetchTitleFacts(
  atlas: string | null | undefined,
  ref: { type: MediaType; id: number },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<TitleFacts> {
  if (!atlas) return NO_FACTS;
  const base = atlas.replace(/\/$/, '');
  const type = ref.type === 'tv' ? 'series' : 'movie';
  try {
    const response = await fetchImpl(`${base}/index/title/${type}/${ref.id}.json`, { signal });
    return response.ok ? parseTitleFacts(await response.json()) : NO_FACTS;
  } catch {
    return NO_FACTS;
  }
}

const folded = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * TMDB's name for a company or network as the chip Search selects it by, where atlas names the same one: `HBO`
 * among a series' networks is `network-Q23633`. Matched by name, since TMDB and Wikidata do not share ids; a
 * name atlas does not carry has no chip, and the page shows it as text.
 */
export function chipFor(name: string, facts: TitleFacts): string | undefined {
  const key = folded(name);
  const network = facts.networks.find((value) => folded(value.name) === key);
  if (network) return `network-${network.id}`;
  const company = facts.companies.find((value) => folded(value.name) === key);
  return company && `company-${company.id}`;
}
