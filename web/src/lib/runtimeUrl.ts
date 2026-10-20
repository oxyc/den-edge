/** The packaged TV keeps its router inside index.html; ordinary web/hosted TV URLs stay unchanged. */
export function currentAppPath(): string {
  if (__DEN_TV_PACKAGED__) {
    const hash = location.hash.slice(1);
    return hash.startsWith('/') ? hash.split('#')[0]! : '/';
  }
  return location.pathname + location.search;
}

export function appHistoryUrl(path: string | URL): string {
  if (!__DEN_TV_PACKAGED__) return String(path);
  const value = String(path);
  const entry = location.pathname + location.search;
  if (value.startsWith('#')) return `${entry}#${currentAppPath()}${value}`;
  const url = new URL(value, location.href);
  if (url.protocol !== location.protocol || url.origin !== location.origin)
    throw new Error('App history cannot leave its package');
  if (url.pathname === location.pathname) return url.href;
  return `${entry}#${url.pathname}${url.search}${url.hash}`;
}

/** Only Den API paths move to the configured server. Assets and arbitrary external URLs never do. */
const API_PATH =
  /^\/(?:pair|inbox|lib|recovery|config|health|routes|scout|tmdb|metadata|grant|oauth|capabilities|playback|den|ratings|warnings|skipdb|subs|subtitles|sync|mcp|link|version|atlas|reel|remux|direct|assistant)(?:\/|$)/;

export function apiOrigin(): string {
  return __DEN_TV_API_ORIGIN__ || (globalThis.location?.origin ?? '');
}

export function apiUrl(href: string): string {
  if (!__DEN_TV_API_ORIGIN__) return href;
  const here = globalThis.location;
  if (!here) return href;
  try {
    const url = new URL(href, here.href);
    if (
      url.protocol !== here.protocol ||
      url.origin !== here.origin ||
      !API_PATH.test(url.pathname)
    )
      return href;
    return `${__DEN_TV_API_ORIGIN__}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}
