// "Save & validate", as the TV's key screens check a key before keeping it (TMDBKeyModel, OMDbKeyModel,
// ContentWarningsKeyModel): one real request to the service, asked from this browser straight to it.

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
  check: (key: string, fetchImpl?: typeof fetch) => Promise<KeyCheck>;
}

async function ask(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  accepted: (res: Response) => Promise<boolean>,
): Promise<KeyCheck> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) return 'refused';
    if (!res.ok && res.status !== 404) return 'unreachable';
    return (await accepted(res)) ? 'accepted' : 'refused';
  } catch {
    return 'unreachable';
  }
}

export const KEY_SERVICES: readonly KeyService[] = [
  {
    name: 'tmdb',
    label: 'TMDB key',
    about:
      'Den uses your own TMDB key (free at themoviedb.org) for search, and every title’s poster and details.',
    placeholder: 'Your TMDB API key',
    // The TV asks for popular movies; the configuration answers the same way for a good key and costs less.
    check: (key, fetchImpl = fetch) =>
      ask(
        `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`,
        {},
        fetchImpl,
        async (res) => res.ok,
      ),
  },
  {
    name: 'omdb',
    label: 'OMDb key',
    about:
      'OMDb adds IMDb, Rotten Tomatoes, and Metacritic ratings on detail pages (free key at omdbapi.com). Without one, Den shows the ratings it already keeps for a title.',
    placeholder: 'Your OMDb API key',
    // Asked through den-edge's `/ratings/check`, which asks OMDb with the key for a title every working key finds,
    // and answers a refusal as 401.
    check: (key, fetchImpl = fetch) =>
      ask('/ratings/check', { headers: { 'x-api-key': key } }, fetchImpl, async () => true),
  },
  {
    name: 'doesthedogdie',
    label: 'Content warnings',
    detail: 'doesthedogdie.com key',
    about:
      'doesthedogdie.com adds crowdsourced content warnings — a dog dies, flashing lights, and ~100 more — to detail pages (free key at doesthedogdie.com/api).',
    placeholder: 'Your doesthedogdie.com API key',
    // Asked through den-edge's `/warnings/check` rather than doesthedogdie directly: the key travels in a header,
    // so the browser preflights, and they answer none — a page simply cannot reach them. den-edge asks their
    // cheapest question with it and passes a refusal on as 401.
    check: (key, fetchImpl = fetch) =>
      ask(
        '/warnings/check',
        { headers: { accept: 'application/json', 'x-api-key': key } },
        fetchImpl,
        async () => true,
      ),
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
