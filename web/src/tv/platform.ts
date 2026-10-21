import { tvRuntimePlatform } from '../lib/tvRuntimePlatform';

/** Optional TV platform bridges. Every call is guarded so browser/E2E runs stay platform-neutral. */
type TizenKey = { name: string; code: number };
type TizenInput = {
  getSupportedKeys?: () => TizenKey[];
  registerKeyBatch?: (
    names: string[],
    success?: () => void,
    failure?: (error: unknown) => void,
  ) => void;
  unregisterKeyBatch?: (
    names: string[],
    success?: () => void,
    failure?: (error: unknown) => void,
  ) => void;
};
type TizenApplication = { getCurrentApplication?: () => { exit?: () => void } };

function tizenInput(): TizenInput | undefined {
  return (globalThis as typeof globalThis & { tizen?: { tvinputdevice?: TizenInput } }).tizen
    ?.tvinputdevice;
}

/** Register only Samsung keys present on this model; arrows/Enter/Back are mandatory and need no registration. */
export function registerSamsungKeys(
  names = [
    'MediaPlayPause',
    'MediaPlay',
    'MediaPause',
    'MediaStop',
    'MediaRewind',
    'MediaFastForward',
    'MediaTrackNext',
  ],
): () => void {
  const input = tizenInput();
  if (!input?.getSupportedKeys || !input.registerKeyBatch) return () => {};
  let supported: TizenKey[];
  try {
    supported = input.getSupportedKeys();
  } catch {
    return () => {};
  }
  const available = new Set(supported.map((key) => key.name));
  const registered = names.filter((name) => available.has(name));
  if (!registered.length) return () => {};
  try {
    input.registerKeyBatch(registered, undefined, () => {});
  } catch {
    return () => {};
  }
  return () => {
    if (!input.unregisterKeyBatch) return;
    try {
      input.unregisterKeyBatch(registered, undefined, () => {});
    } catch {
      /* platform teardown */
    }
  };
}

/** Request the platform-native exit flow where available. Returns whether a platform call was made. */
export function exitTvApp(): boolean {
  const g = globalThis as typeof globalThis & {
    tizen?: { application?: TizenApplication };
    webOS?: { platformBack?: () => void };
  };
  // Android accepts this private top-level navigation. Unlike addJavascriptInterface, it exposes no native object
  // to third-party trailer frames; the hosted bundle recognizes the shell by the user-agent suffix it owns.
  if (tvRuntimePlatform() === 'android') {
    location.href = 'den://exit';
    return true;
  }
  if (g.tizen?.application?.getCurrentApplication) {
    try {
      const application = g.tizen.application.getCurrentApplication();
      const exit = application?.exit;
      if (exit) {
        exit.call(application);
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  if (g.webOS?.platformBack) {
    try {
      g.webOS.platformBack();
      return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}
