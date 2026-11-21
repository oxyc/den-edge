// What atlas can browse a title by beyond its people (`/index/title`): its production companies, networks,
// subjects, places and source authors, each with the id Search selects it by and how many titles carry it; and its
// moods, as atlas's labels name them.

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
  /** Its official ratings, one line each: `maturityLines`. */
  maturity: string[];
}

export const NO_FACTS: TitleFacts = {
  maturity: [],
  companies: [],
  networks: [],
  subjects: [],
  places: [],
  authors: [],
  moods: [],
  countries: [],
};

const MAX_FACT_VALUES = 128;
const MAX_FACT_NAME = 512;
const MAX_FACT_MOOD = 256;
const MAX_FACT_ID = 64;

const factName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_FACT_NAME;
const factMood = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_FACT_MOOD && value.trim().length > 0;

/** True when Atlas's optional fact fields can be represented by the bounded content-service wire shape. */
export function validTitleFacts(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const at = body as Record<string, unknown>;
  for (const field of ['companies', 'networks', 'subjects', 'places', 'authors'] as const) {
    const values = at[field];
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      values.length > MAX_FACT_VALUES ||
      !values.every((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const { id, name, titles } = value as Record<string, unknown>;
        return (
          typeof id === 'string' &&
          id.length <= MAX_FACT_ID &&
          /^Q[1-9]\d*$/.test(id) &&
          factName(name) &&
          Number.isSafeInteger(titles) &&
          (titles as number) >= 0
        );
      })
    )
      return false;
  }
  if (
    at.labels !== undefined &&
    (!at.labels || typeof at.labels !== 'object' || Array.isArray(at.labels))
  )
    return false;
  const moods = (at.labels as Record<string, unknown> | undefined)?.moods;
  if (
    moods !== undefined &&
    (!Array.isArray(moods) || moods.length > MAX_FACT_VALUES || !moods.every(factMood))
  )
    return false;
  return (
    at.countries === undefined ||
    (Array.isArray(at.countries) &&
      at.countries.length <= MAX_FACT_VALUES &&
      at.countries.every((id) => typeof id === 'string' && /^[A-Z]{2}$/.test(id)))
  );
}

function browsable(list: unknown): Browsable[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_FACT_VALUES).flatMap((value): Browsable[] => {
    const { id, name, titles } = (value ?? {}) as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      id.length > MAX_FACT_ID ||
      !/^Q[1-9]\d*$/.test(id) ||
      typeof name !== 'string'
    )
      return [];
    const clean = name.trim();
    return clean && clean.length <= MAX_FACT_NAME
      ? [
          {
            id,
            name: clean,
            titles:
              Number.isSafeInteger(titles) && (titles as number) >= 0 ? (titles as number) : 0,
          },
        ]
      : [];
  });
}

const MAX_MATURITY = 16;
const MAX_MATURITY_TEXT = 128;

interface Observation {
  authority: string;
  authorityId: string;
  rating: string;
  jurisdiction?: string;
  format?: string;
  runtimeMinutes?: number;
}

function observations(list: unknown): Observation[] {
  if (!Array.isArray(list)) return [];
  const clean = (value: unknown) =>
    typeof value === 'string' && value.trim() && value.trim().length <= MAX_MATURITY_TEXT
      ? value.trim()
      : undefined;
  return list.slice(0, MAX_MATURITY).flatMap((value): Observation[] => {
    const at = (value ?? {}) as Record<string, unknown>;
    const [authority, authorityId, rating] = [at.authority, at.authorityId, at.rating].map(clean);
    if (!authority || !authorityId || !rating) return [];
    return [
      {
        authority,
        authorityId,
        rating,
        jurisdiction: clean(at.jurisdiction),
        format: clean(at.format),
        runtimeMinutes:
          Number.isSafeInteger(at.runtimeMinutes) && (at.runtimeMinutes as number) > 0
            ? (at.runtimeMinutes as number)
            : undefined,
      },
    ];
  });
}

/**
 * Which official rating a title shows and where it came from — the rule the Apple apps apply too (DenKit's
 * `MaturityProvenance`): the published labels lead in atlas's order, then a live provider's observation unless it
 * repeats a published one; each reads `Authority label (cut, JURISDICTION)`. atlas's normalized age is filtering
 * data and never part of the line.
 */
export function maturityLines(body: Record<string, unknown>): string[] {
  const key = (o: Observation) => `${o.authorityId}\u001f${o.rating}`;
  const published = observations(body.maturityRatings);
  const seen = new Set(published.map(key));
  const live = observations(body.runtimeMaturityRatings).filter((o) => {
    if (seen.has(key(o))) return false;
    seen.add(key(o));
    return true;
  });
  return [...published, ...live].map((o) => {
    const context = [
      o.format,
      o.runtimeMinutes ? `${o.runtimeMinutes} min` : undefined,
      o.jurisdiction?.toUpperCase(),
    ].filter(Boolean);
    return `${o.authority} ${o.rating}${context.length ? ` (${context.join(', ')})` : ''}`.slice(
      0,
      256,
    );
  });
}

export function parseTitleFacts(body: unknown): TitleFacts {
  const at = (body ?? {}) as Record<string, unknown>;
  const moods = ((at.labels ?? {}) as Record<string, unknown>).moods;
  return {
    maturity: maturityLines(at),
    companies: browsable(at.companies),
    networks: browsable(at.networks),
    subjects: browsable(at.subjects),
    places: browsable(at.places),
    authors: browsable(at.authors),
    moods: Array.isArray(moods)
      ? moods
          .filter(
            (mood): mood is string =>
              typeof mood === 'string' && mood.length <= MAX_FACT_MOOD && mood.trim() !== '',
          )
          .map((mood) => mood.trim())
          .slice(0, MAX_FACT_VALUES)
      : [],
    countries: Array.isArray(at.countries)
      ? at.countries
          .filter((id): id is string => typeof id === 'string' && /^[A-Z]{2}$/.test(id))
          .slice(0, MAX_FACT_VALUES)
      : [],
  };
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
