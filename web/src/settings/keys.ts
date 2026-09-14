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
      'OMDb adds IMDb, Rotten Tomatoes, and Metacritic ratings on detail pages (free key at omdbapi.com). Without it, Den shows TMDB ratings only.',
    placeholder: 'Your OMDb API key',
    // OMDb answers a bad key with 401, and a good one for The Shawshank Redemption with `Response: "True"`.
    check: (key, fetchImpl = fetch) =>
      ask(
        `https://www.omdbapi.com/?i=tt0111161&apikey=${encodeURIComponent(key)}`,
        {},
        fetchImpl,
        async (res) => ((await res.json()) as { Response?: unknown }).Response === 'True',
      ),
  },
  {
    name: 'doesthedogdie',
    label: 'Content warnings',
    detail: 'doesthedogdie.com key',
    about:
      'doesthedogdie.com adds crowdsourced content warnings — a dog dies, flashing lights, and ~100 more — to detail pages (free key at doesthedogdie.com/api).',
    placeholder: 'Your doesthedogdie.com API key',
    // Any answer that isn't a refusal is a working key, as on the TV: a search that finds nothing still is one.
    check: (key, fetchImpl = fetch) =>
      ask(
        'https://www.doesthedogdie.com/search?q=Old%20Yeller',
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
