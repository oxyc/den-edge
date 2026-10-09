// Display metadata for provider keys. Validation is a typed content-Worker operation; provider URLs and saved
// credentials never enter this page module.

/** A key the service took, one it refused, or no answer to tell either way. */
export type KeyCheck = 'accepted' | 'refused' | 'unreachable';

export interface KeyService {
  name: 'tmdb' | 'omdb' | 'doesthedogdie';
  label: string;
  /** The row's second line: which of the TV's "Content warnings" rows this is, say. */
  detail?: string;
  /** What the key adds, as the TV's key screens describe it. */
  about: string;
  placeholder: string;
}

export const KEY_SERVICES: readonly KeyService[] = [
  {
    name: 'tmdb',
    label: 'TMDB key',
    about:
      'Den uses your own TMDB key (free at themoviedb.org) for search, and every title’s poster and details.',
    placeholder: 'Your TMDB API key',
  },
  {
    name: 'omdb',
    label: 'OMDb key',
    about:
      'OMDb adds IMDb, Rotten Tomatoes, and Metacritic ratings on detail pages (free key at omdbapi.com). Without one, Den shows the ratings it already keeps for a title.',
    placeholder: 'Your OMDb API key',
  },
  {
    name: 'doesthedogdie',
    label: 'Content warnings',
    detail: 'doesthedogdie.com key',
    about:
      'doesthedogdie.com adds crowdsourced content warnings — a dog dies, flashing lights, and ~100 more — to detail pages (free key at doesthedogdie.com/api).',
    placeholder: 'Your doesthedogdie.com API key',
  },
];

/** What a key row says, as the TV's Connections rows do. */
export function keyStatus(saved: boolean, check: KeyCheck | 'checking' | undefined): string {
  if (!saved) return 'Not set';
  if (check === 'checking') return 'Checking…';
  if (check === 'refused') return 'Not accepted';
  if (check === 'unreachable') return 'Not responding';
  return 'Connected';
}
