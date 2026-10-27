export type ClientPlatform = 'web' | 'ios' | 'ipados' | 'webos' | 'tizen' | 'android_tv';

/** Build identity wins for TV builds; user-agent detection covers the ordinary browser build. */
export function clientPlatformOf(
  userAgent: string,
  touchPoints = 0,
  builtPlatform: 'browser' | 'webos' | 'tizen' = __DEN_TV_PLATFORM__,
): ClientPlatform {
  if (builtPlatform === 'webos' || builtPlatform === 'tizen') return builtPlatform;
  if (/DenAndroidTV\//.test(userAgent)) return 'android_tv';
  if (/Web0S|webOS/.test(userAgent)) return 'webos';
  if (/Tizen/.test(userAgent)) return 'tizen';
  if (/iPhone|iPod/.test(userAgent)) return 'ios';
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)) return 'ipados';
  return 'web';
}

export function currentClientPlatform(): ClientPlatform {
  if (typeof navigator === 'undefined') return 'web';
  return clientPlatformOf(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}
