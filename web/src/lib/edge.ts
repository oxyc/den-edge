// What this device calls itself when it pairs with a TV.

const MAX_LABEL = 40;

/** What a device calls itself, as the other's list of linked devices shows it. The same rule as den-edge's. */
export function cleanLabel(raw: string): string {
  return [...raw.trim()]
    .filter((c) => !/\p{Cc}/u.test(c))
    .slice(0, MAX_LABEL)
    .join('');
}

/**
 * What this device is, as the TV's list of linked devices shows it: "Mac · Chrome". iPadOS asks for desktop
 * sites with a Mac's user agent, so an iPad is told apart by its touch screen. Browsers don't tell a MacBook
 * from an iMac.
 */
export function deviceLabel(
  nav: { userAgent: string; maxTouchPoints?: number } = navigator,
): string {
  const ua = nav.userAgent;
  const platform = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? 'Android phone'
          : 'Android tablet'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /CrOS/.test(ua)
            ? 'Chromebook'
            : /Windows/.test(ua)
              ? 'Windows PC'
              : /Linux/.test(ua)
                ? 'Linux PC'
                : '';
  // Edge and Chrome on iOS carry Chrome's and Safari's tokens too, so the rarer ones are checked first.
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return [platform, browser].filter(Boolean).join(' · ') || 'Browser';
}
