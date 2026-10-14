const ID = '[0-9a-f]{32}';

export type ProfileResetRoute =
  | { readonly kind: 'source' | 'acquire' | 'retire' }
  | { readonly kind: 'lookup' | 'abort' | 'successor'; readonly attempt: string };

/**
 * The exact profiles-v1 §9.1 route surface. Raw strings with queries, fragments or dot segments never classify, so a
 * caller can neither smuggle another path through the worker's credential-bearing request nor reach an ordinary route.
 */
export function profileResetRoute(
  libraryId: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
): ProfileResetRoute | null {
  if (!new RegExp(`^${ID}$`).test(libraryId)) return null;
  const root = `/lib/${libraryId}`;
  if (method === 'DELETE' && path === root) return { kind: 'retire' };
  if (method === 'GET' && path === `${root}/exclusive-operation/source`) return { kind: 'source' };
  if (method === 'POST' && path === `${root}/exclusive-operation`) return { kind: 'acquire' };
  const match = new RegExp(`^${root}/exclusive-operation/(${ID})(/successor)?$`).exec(path);
  if (!match) return null;
  const attempt = match[1]!;
  if (match[2]) return method === 'POST' ? { kind: 'successor', attempt } : null;
  if (method === 'GET') return { kind: 'lookup', attempt };
  if (method === 'DELETE') return { kind: 'abort', attempt };
  return null;
}

/** The only request headers a reset caller may add to the library's own token, wire and generation headers. */
const HEADERS: Readonly<Record<ProfileResetRoute['kind'], readonly string[]>> = {
  source: [],
  acquire: ['x-den-successor-token'],
  lookup: [],
  abort: [],
  successor: [],
  retire: ['x-den-exclusive-attempt', 'x-den-successor'],
};

export function profileResetHeadersAllowed(
  route: ProfileResetRoute,
  headers: Readonly<Record<string, string>>,
): boolean {
  return Object.keys(headers).every((name) => HEADERS[route.kind].includes(name));
}
