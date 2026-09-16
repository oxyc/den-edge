/**
 * The parental ceiling, read the way the TV reads it.
 *
 * This is a port of DenKit's `ParentalRatings` + `ParentalControls.isBlocked` (oxyc/den,
 * `Sources/DenKit/Models/ParentalRatings.swift`, `App/Den/Shell/ParentalControls.swift`), kept
 * deliberately identical: a household sets one `den.maturityCeiling` in a synced library, and a title
 * blocked on the Apple TV must be blocked in the browser too. A second, looser table here would mean
 * the same setting meant two different things on two screens.
 *
 * Each rating maps to a level: 0 allowed under PG-13, 1 allowed under R, 2 above R. A rating missing
 * from its country's table, or a country with no table at all, is unknown rather than blocked.
 */

/** Keyed by the uppercased rating, so "Btl" and "BTL" are one. */
const LEVELS: Record<string, Record<string, number>> = {
  US: {
    G: 0,
    PG: 0,
    'PG-13': 0,
    R: 1,
    'NC-17': 2,
    'TV-Y': 0,
    'TV-Y7': 0,
    'TV-Y7-FV': 0,
    'TV-G': 0,
    'TV-PG': 0,
    'TV-14': 0,
    'TV-MA': 1,
  },
  FI: { S: 0, 'K-7': 0, 'K-12': 0, T: 0, '7': 0, '12': 0, 'K-16': 1, 'K-18': 1, '16': 1, '18': 1 },
  SE: { BTL: 0, '7': 0, '11': 0, '15': 1 },
  NO: { A: 0, '6': 0, '9': 0, '12': 0, '15': 1, '18': 1 },
  DK: { A: 0, '7': 0, '11': 0, '15': 1, F: 1 },
  DE: { '0': 0, '6': 0, '12': 0, '16': 1, '18': 1 },
  GB: { U: 0, PG: 0, '12': 0, '12A': 0, '15': 1, '18': 1, R18: 2 },
  FR: { U: 0, '10': 0, '12': 0, '16': 1, '18': 1 },
  NL: { AL: 0, '6': 0, '9': 0, '12': 0, '14': 0, '16': 1, '18': 1 },
  ES: { APTA: 0, A: 0, '7': 0, '12': 0, '16': 1, '18': 1, X: 2 },
};

/** A rating's level in its country's system; undefined when that country or rating isn't mapped. */
export function level(certification: string | undefined, country: string): number | undefined {
  const cert = certification?.trim().toUpperCase();
  if (!cert) return undefined;
  return LEVELS[country.toUpperCase()]?.[cert];
}

/**
 * A title's level: the stricter of its US rating and its rating in `region`. Undefined only when
 * neither maps. Both are consulted because TMDB's own regional entry is often missing where the US
 * one is not, and a ceiling that only reads the viewer's country would pass an unrated-here title.
 */
export function levelOf(
  certifications: Record<string, string>,
  region: string | undefined,
): number | undefined {
  const countries = [...new Set(['US', region?.toUpperCase()].filter((c): c is string => !!c))];
  const levels = countries
    .map((country) => level(certifications[country], country))
    .filter((l): l is number => l !== undefined);
  return levels.length ? Math.max(...levels) : undefined;
}

/**
 * Whether `ceiling` blocks a title with these ratings. No ceiling blocks nothing, and neither does a
 * title whose level is unknown — an unmapped rating is not evidence of anything, and hiding every
 * unrated title would empty the page rather than protect anyone.
 */
export function isBlocked(
  certifications: Record<string, string>,
  region: string | undefined,
  ceiling: 'pg13' | 'r' | undefined,
): boolean {
  const allowed = ceiling === 'pg13' ? 0 : ceiling === 'r' ? 1 : undefined;
  if (allowed === undefined) return false;
  const found = levelOf(certifications, region);
  return found !== undefined && found > allowed;
}

/**
 * Of one country's ratings — a movie lists one per release: theatrical, digital, … — the strictest that
 * maps, else the first given. An unrated release listed first can't hide a rated one.
 */
export function strictest(ratings: string[], country: string): string | undefined {
  const given = ratings.filter((r) => r.trim() !== '');
  let best: { rating: string; level: number } | undefined;
  for (const rating of given) {
    const found = level(rating, country);
    if (found !== undefined && (best === undefined || found > best.level))
      best = { rating, level: found };
  }
  return best?.rating ?? given[0];
}
