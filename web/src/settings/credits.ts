// The statements the sources' terms ask for, as addons name them in their manifests (den-spec attribution-v1): each
// addon credits what its data comes from, so the credits follow what's installed rather than a list compiled in here.

export interface Credit {
  /** The whole statement, as the source words it. Plain text. */
  text: string;
  /** The part of `text` that links, when there is a link. */
  link?: string;
  /** Where it links: https only. */
  url?: string;
}

/** An addon manifest's `denAttribution`: every statement that is text, with its link kept only when it is https. */
export function readAttribution(manifest: unknown): Credit[] {
  const list = (manifest as { denAttribution?: unknown } | null)?.denAttribution;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): Credit[] => {
    const { text, link, url } = (entry ?? {}) as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim()) return [];
    let href: string | undefined;
    try {
      href = typeof url === 'string' && new URL(url).protocol === 'https:' ? url : undefined;
    } catch {
      href = undefined;
    }
    return [
      {
        text,
        ...(href ? { url: href } : {}),
        ...(href && typeof link === 'string' && link ? { link } : {}),
      },
    ];
  });
}

/** A statement split around its link: the whole statement links when the link text isn't found in it. */
export function linkParts(credit: Credit): { before: string; link: string; after: string } | null {
  if (!credit.url) return null;
  const at = credit.link ? credit.text.indexOf(credit.link) : -1;
  if (at < 0 || !credit.link) return { before: '', link: credit.text, after: '' };
  return {
    before: credit.text.slice(0, at),
    link: credit.link,
    after: credit.text.slice(at + credit.link.length),
  };
}

/** The credits of several addons in order, a statement two of them share shown once. */
export function mergeCredits(lists: readonly Credit[][]): Credit[] {
  const seen = new Set<string>();
  return lists.flat().filter((credit) => !seen.has(credit.text) && !!seen.add(credit.text));
}

/**
 * What den-atlas credits, for while its manifest can't be read or predates `denAttribution`: its rows and the
 * billboard still show data from these, and their terms still apply.
 */
export const ATLAS_FALLBACK: readonly Credit[] = [
  {
    text: 'Discovery data (subgenres, moods, and “more like this”) is derived from Wikipedia article text, used under CC BY-SA 4.0 and modified.',
    link: 'CC BY-SA 4.0',
    url: 'https://creativecommons.org/licenses/by-sa/4.0',
  },
  {
    text: 'Streaming availability information is provided by Streaming Availability API by Movie of the Night.',
    link: 'Streaming Availability API by Movie of the Night',
    url: 'https://www.movieofthenight.com/about/api',
  },
  {
    text: 'Streaming availability by JustWatch.',
    link: 'JustWatch',
    url: 'https://www.justwatch.com',
  },
];
