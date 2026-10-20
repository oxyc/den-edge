export type TvRuntimePlatform = 'browser' | 'webos' | 'tizen' | 'android';

/** The Android shell deliberately serves the hosted webOS bundle and identifies itself in its user agent. */
export function tvRuntimePlatform(
  userAgent = globalThis.navigator?.userAgent ?? '',
  builtPlatform: TvRuntimePlatform = __DEN_TV_PLATFORM__,
  tvBuild = __DEN_TV__,
): TvRuntimePlatform {
  return tvBuild && /(?:^|\s)DenAndroidTV\/[0-9]+(?:\.[0-9]+)*/.test(userAgent)
    ? 'android'
    : builtPlatform;
}
