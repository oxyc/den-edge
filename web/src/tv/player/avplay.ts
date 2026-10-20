import './avplay.css';
import { subtitleLanguagesMatch } from '../../lib/remux';
import { apiUrl } from '../../lib/runtimeUrl';

type AvplayState = 'NONE' | 'IDLE' | 'READY' | 'PLAYING' | 'PAUSED';

interface AvplayTrack {
  type: 'VIDEO' | 'AUDIO' | 'TEXT';
  index: number;
  extra_info?: string | Record<string, unknown>;
}

interface AvplayListener {
  onbufferingstart(): void;
  onbufferingprogress(percent: number): void;
  onbufferingcomplete(): void;
  oncurrentplaytime(milliseconds: number): void;
  onstreamcompleted(): void;
  onevent(event: string, data: string): void;
  onerror(error: string): void;
  onerrormsg?(error: string, message: string): void;
  onsubtitlechange?(duration: number, text: string): void;
}

interface AvplayApi {
  open(url: string): void;
  close(): void;
  prepareAsync(success?: () => void, error?: (error: unknown) => void): void;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setDisplayMethod(method: 'PLAYER_DISPLAY_MODE_LETTER_BOX'): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(milliseconds: number, success?: () => void, error?: (error: unknown) => void): void;
  getState(): AvplayState;
  getDuration(): number;
  getCurrentTime(): number;
  setListener(listener: AvplayListener): void;
  setSilentSubtitle(silent: boolean): void;
  setSelectTrack(type: 'AUDIO' | 'TEXT', index: number): void;
  getTotalTrackInfo(): AvplayTrack[];
}

interface AvplayGlobal {
  webapis?: { avplay?: AvplayApi };
}

export interface SamsungAvplayAdapter {
  start(): Promise<void>;
  selectAudioTrack(ordinal: number): void;
  selectSubtitleLanguage(language: string | null): void;
  failureKind(): 'decode' | 'format' | 'other' | undefined;
  destroy(): void;
}

export interface SamsungAvplayOptions {
  element: HTMLVideoElement;
  url: string;
  audioTrack: number;
  subtitleLanguage: string | null;
}

class Ranges implements TimeRanges {
  constructor(private readonly values: readonly (readonly [number, number])[]) {}

  get length() {
    return this.values.length;
  }

  start(index: number): number {
    const range = this.values[index];
    if (!range) throw new DOMException('Index outside the TimeRanges collection', 'IndexSizeError');
    return range[0];
  }

  end(index: number): number {
    const range = this.values[index];
    if (!range) throw new DOMException('Index outside the TimeRanges collection', 'IndexSizeError');
    return range[1];
  }
}

const emptyRanges = new Ranges([]);

function languageOf(track: AvplayTrack): string | undefined {
  let info = track.extra_info;
  if (typeof info === 'string') {
    try {
      info = JSON.parse(info) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (!info) return undefined;
  // Samsung documents `track_lang` for AVPlay stream metadata. A few firmware/stream combinations expose one of
  // the other spellings, so retain them as fallbacks rather than teaching the player one device's shape.
  for (const key of ['track_lang', 'language', 'lang', 'Language']) {
    const value = info[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function event(element: HTMLVideoElement, name: string) {
  element.dispatchEvent(new Event(name));
}

function errorName(reason: unknown): string {
  const text =
    typeof reason === 'string'
      ? reason
      : reason instanceof Error
        ? `${reason.name} ${reason.message}`
        : reason && typeof reason === 'object' && 'name' in reason
          ? String(reason.name)
          : '';
  return (
    text.match(
      /\bPLAYER_ERROR_(?:NONE|INVALID_PARAMETER|NO_SUCH_FILE|INVALID_OPERATION|SEEK_FAILED|INVALID_STATE|NOT_SUPPORTED_FILE|NOT_SUPPORTED_FORMAT|INVALID_URI|CONNECTION_FAILED|GENEREIC)\b/,
    )?.[0] ?? ''
  );
}

/**
 * Put Samsung's singleton AVPlay pipeline behind the media-element contract already consumed by Player.svelte.
 * The bridge is deliberately mounted only from the Tizen lazy branch; ordinary browser and webOS builds never
 * import this module. Samsung callbacks can outlive stop/close, so every callback is fenced by this mount's
 * `active` flag before it is allowed to change player state or dispatch a DOM event.
 */
export function mountSamsungAvplay(options: SamsungAvplayOptions): SamsungAvplayAdapter {
  const { element, url } = options;
  const api = (globalThis as typeof globalThis & AvplayGlobal).webapis?.avplay;
  if (!api) throw new Error('Samsung AVPlay is unavailable');

  let active = true;
  let ready = false;
  let firstFrame = false;
  let paused = true;
  let ended = false;
  let seeking = false;
  let currentTime = 0;
  let duration = 0;
  let mediaError: MediaError | null = null;
  let failureKind: 'decode' | 'format' | 'other' | undefined;
  let audioTrack = options.audioTrack;
  let subtitleLanguage = options.subtitleLanguage;
  const played: [number, number][] = [];
  let lastPlayingTime: number | undefined;
  let pendingSeek = Promise.resolve();
  let queuedSeek: number | undefined;
  let requestedTime: number | undefined;
  let finishPendingSeek: (() => void) | undefined;

  const plane = document.createElement('object');
  plane.type = 'application/avplayer';
  plane.className = 'den-avplay-plane';
  plane.setAttribute('aria-hidden', 'true');
  element.before(plane);
  element.classList.add('den-avplay-placeholder');
  element.closest('.player')?.classList.add('den-avplay-active');
  const captions = document.createElement('div');
  captions.className = 'den-avplay-captions';
  captions.hidden = true;
  element.after(captions);
  let captionTrack: TextTrack | undefined;
  let shownCues: TextTrackCue[] = [];
  const renderCaptions = () => {
    const cues = Array.from(captionTrack?.cues ?? []).filter(
      (cue) => cue.startTime <= currentTime && currentTime < cue.endTime,
    );
    if (cues.length === shownCues.length && cues.every((cue, index) => cue === shownCues[index]))
      return;
    shownCues = cues;
    captions.replaceChildren();
    for (const cue of cues) {
      const line = document.createElement('div');
      // Browser WebVTT parsing owns cue markup; never interpolate downloaded caption text as HTML.
      line.append((cue as VTTCue).getCueAsHTML());
      captions.append(line);
    }
    captions.hidden = cues.length === 0;
  };

  const updateRect = () => {
    if (!active) return;
    const rect = element.getBoundingClientRect();
    const scaleX = 1920 / Math.max(1, document.documentElement.clientWidth);
    const scaleY = 1080 / Math.max(1, document.documentElement.clientHeight);
    try {
      api.setDisplayRect(
        Math.max(0, Math.round(rect.left * scaleX)),
        Math.max(0, Math.round(rect.top * scaleY)),
        Math.max(1, Math.round(rect.width * scaleX)),
        Math.max(1, Math.round(rect.height * scaleY)),
      );
    } catch {
      console.warn('Samsung AVPlay display rectangle could not be updated.');
    }
  };
  addEventListener('resize', updateRect);

  const ownDescriptors = Object.getOwnPropertyDescriptors(element);
  const overridden = [
    'currentTime',
    'duration',
    'paused',
    'ended',
    'seeking',
    'readyState',
    'networkState',
    'buffered',
    'played',
    'error',
    'play',
    'pause',
    'load',
    'getVideoPlaybackQuality',
  ] as const;

  const restoreFacade = () => {
    for (const name of overridden) {
      const descriptor = ownDescriptors[name];
      if (descriptor) Object.defineProperty(element, name, descriptor);
      else delete (element as unknown as Record<string, unknown>)[name];
    }
  };

  const mergePlayed = (from: number, to: number) => {
    if (!(to > from) || to - from > 5) return;
    const last = played.at(-1);
    if (last && from <= last[1] + 0.25) last[1] = Math.max(last[1], to);
    else played.push([from, to]);
  };

  const classify = (reason: unknown) => {
    const name = errorName(reason);
    if (/PLAYER_ERROR_(?:NOT_SUPPORTED_FILE|NOT_SUPPORTED_FORMAT|INVALID_URI)/.test(name))
      return {
        code: MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED,
        kind: 'format' as const,
      };
    if (/PLAYER_ERROR_(?:CONNECTION_FAILED|NO_SUCH_FILE)/.test(name))
      return { code: MediaError.MEDIA_ERR_NETWORK, kind: 'other' as const };
    // Invalid calls, failed seeks and display-window failures do not establish that the decoder refused the media.
    return { code: MediaError.MEDIA_ERR_ABORTED, kind: 'other' as const };
  };

  const fail = (reason: unknown) => {
    if (!active || mediaError || errorName(reason) === 'PLAYER_ERROR_NONE') return;
    paused = true;
    const classified = classify(reason);
    failureKind = classified.kind;
    mediaError = {
      code: classified.code,
      // Samsung's detailed error callback can contain the signed media URL and request headers. Only its closed
      // error enum is allowed into the shared report path.
      message: errorName(reason) || 'Samsung AVPlay failed',
    } as MediaError;
    event(element, 'error');
  };

  const tracks = (type: AvplayTrack['type']) => {
    try {
      return api.getTotalTrackInfo().filter((track) => track.type === type);
    } catch {
      console.warn(`Samsung AVPlay ${type.toLowerCase()} tracks could not be read.`);
      return [];
    }
  };

  const applyAudioTrack = () => {
    if (!ready) return;
    const track = tracks('AUDIO')[audioTrack];
    if (!track) return;
    try {
      api.setSelectTrack('AUDIO', track.index);
    } catch {
      console.warn('Samsung AVPlay audio track could not be selected.');
    }
  };

  const applySubtitle = () => {
    if (!ready) return;
    captionTrack = undefined;
    for (const track of element.querySelectorAll('track')) {
      const selected = subtitleLanguage !== null && track.srclang === subtitleLanguage;
      track.track.mode = selected ? 'hidden' : 'disabled';
      if (selected) captionTrack = track.track;
    }
    renderCaptions();
    try {
      api.setSilentSubtitle(subtitleLanguage === null || !!captionTrack);
      if (subtitleLanguage === null || captionTrack) return;
      const text = tracks('TEXT');
      const track = text.find((candidate) =>
        subtitleLanguagesMatch(languageOf(candidate), subtitleLanguage),
      );
      if (track) api.setSelectTrack('TEXT', track.index);
    } catch {
      console.warn('Samsung AVPlay subtitle track could not be selected.');
    }
  };
  // Managed direct sources can add a lazy-loaded external track after playback has started.
  const trackChanges = new MutationObserver(applySubtitle);
  trackChanges.observe(element, { childList: true });
  element.addEventListener('load', renderCaptions, true);

  let preparedResolve: (() => void) | undefined;
  let preparedReject: ((error: unknown) => void) | undefined;
  const prepared = new Promise<void>((resolve, reject) => {
    preparedResolve = resolve;
    preparedReject = reject;
  });
  // open() can throw before start() reaches its await; retain the rejection for awaiters without a global error.
  void prepared.catch(() => undefined);

  const play = async () => {
    try {
      await prepared;
      // `loadedmetadata` applies Den's resume point through the facade's setter. Wait for that asynchronous seek.
      await pendingSeek;
      if (!active || ended || !paused || mediaError) return;
      api.play();
      paused = false;
      event(element, 'play');
      applyAudioTrack();
      applySubtitle();
    } catch (error) {
      // The media error event owns recovery. Rejecting too left an unhandled promise from automatic playback
      // in the production fixture and exposed Samsung's free-form diagnostic text.
      fail(error);
    }
  };

  const pause = () => {
    if (!active || !ready || paused || ended) return;
    try {
      api.pause();
      paused = true;
      lastPlayingTime = undefined;
      event(element, 'pause');
    } catch (error) {
      fail(error);
    }
  };

  const finishSeek = (successful: boolean) => {
    if (!seeking) return;
    seeking = false;
    requestedTime = undefined;
    if (active) {
      if (successful) event(element, 'timeupdate');
      event(element, 'seeked');
    }
    const finish = finishPendingSeek;
    finishPendingSeek = undefined;
    finish?.();
  };

  const runQueuedSeek = () => {
    if (!active) {
      finishSeek(false);
      return;
    }
    const to = queuedSeek;
    if (to === undefined) {
      finishSeek(true);
      return;
    }
    queuedSeek = undefined;
    try {
      // Samsung rejects any other AVPlay operation while an asynchronous seek is outstanding. Keep at most one
      // follow-up target: rapid remote presses accumulate through the facade's optimistic currentTime getter, then
      // coalesce into the latest requested position once this operation completes.
      api.seekTo(
        Math.round(to * 1000),
        () => {
          if (!active) {
            finishSeek(false);
            return;
          }
          currentTime = to;
          renderCaptions();
          lastPlayingTime = undefined;
          if (queuedSeek !== undefined) runQueuedSeek();
          else finishSeek(true);
        },
        (error) => {
          queuedSeek = undefined;
          if (active) fail(error);
          finishSeek(false);
        },
      );
    } catch (error) {
      queuedSeek = undefined;
      if (active) fail(error);
      finishSeek(false);
    }
  };

  const seek = (seconds: number) => {
    if (!active || !ready || !Number.isFinite(seconds)) return;
    const to = Math.max(0, duration ? Math.min(seconds, duration - 0.001) : seconds);
    requestedTime = to;
    queuedSeek = to;
    if (seeking) return;
    seeking = true;
    event(element, 'seeking');
    pendingSeek = new Promise<void>((resolve) => {
      finishPendingSeek = resolve;
    });
    runQueuedSeek();
  };

  Object.defineProperties(element, {
    currentTime: { configurable: true, get: () => requestedTime ?? currentTime, set: seek },
    duration: { configurable: true, get: () => duration || Number.NaN },
    paused: { configurable: true, get: () => paused },
    ended: { configurable: true, get: () => ended },
    seeking: { configurable: true, get: () => seeking },
    readyState: {
      configurable: true,
      get: () =>
        firstFrame ? HTMLMediaElement.HAVE_FUTURE_DATA : ready ? HTMLMediaElement.HAVE_METADATA : 0,
    },
    networkState: {
      configurable: true,
      get: () =>
        mediaError ? HTMLMediaElement.NETWORK_NO_SOURCE : HTMLMediaElement.NETWORK_LOADING,
    },
    // AVPlay's buffering callback is progress toward its startup target, not a media-time range. Unknown is more
    // truthful than inventing buffered seconds and keeps delivery diagnostics from treating it as whole-file data.
    buffered: { configurable: true, get: () => emptyRanges },
    played: { configurable: true, get: () => new Ranges(played) },
    error: { configurable: true, get: () => mediaError },
    play: { configurable: true, value: play },
    pause: { configurable: true, value: pause },
    load: { configurable: true, value: () => undefined },
    getVideoPlaybackQuality: {
      configurable: true,
      value: undefined,
    },
  });

  const listener: AvplayListener = {
    onbufferingstart() {
      if (!active) return;
      event(element, 'waiting');
    },
    onbufferingprogress(percent) {
      if (!active) return;
      void percent;
      event(element, 'progress');
    },
    onbufferingcomplete() {
      if (!active) return;
      event(element, 'canplay');
      if (!paused) event(element, 'playing');
    },
    oncurrentplaytime(milliseconds) {
      if (!active) return;
      const next = Math.max(0, milliseconds / 1000);
      if (lastPlayingTime !== undefined) mergePlayed(lastPlayingTime, next);
      lastPlayingTime = next;
      currentTime = next;
      renderCaptions();
      if (!firstFrame) {
        firstFrame = true;
        event(element, 'loadeddata');
        event(element, 'playing');
      }
      event(element, 'timeupdate');
    },
    onstreamcompleted() {
      if (!active || ended) return;
      currentTime = duration || currentTime;
      renderCaptions();
      ended = true;
      paused = true;
      lastPlayingTime = undefined;
      event(element, 'timeupdate');
      try {
        api.stop();
      } catch {
        console.warn('Samsung AVPlay could not stop after completion.');
      }
      event(element, 'ended');
    },
    onevent() {},
    onerror: fail,
    onerrormsg(error) {
      // The second argument is free-form diagnostic text, not a safe error identifier.
      fail(error);
    },
    onsubtitlechange() {},
  };

  const start = async () => {
    if (!active) return;
    try {
      event(element, 'loadstart');
      api.open(apiUrl(url));
      api.setListener(listener);
      api.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
      updateRect();
      api.prepareAsync(
        () => {
          if (!active) return;
          ready = true;
          duration = Math.max(0, api.getDuration() / 1000);
          preparedResolve?.();
          event(element, 'durationchange');
          event(element, 'loadedmetadata');
          event(element, 'canplay');
          void play();
        },
        (error) => {
          if (!active) return;
          preparedReject?.(new Error(errorName(error) || 'Samsung AVPlay preparation failed'));
          fail(error);
        },
      );
      await prepared;
    } catch (error) {
      const safeError = new Error(errorName(error) || 'Samsung AVPlay could not start');
      preparedReject?.(safeError);
      fail(error);
      throw safeError;
    }
  };

  return {
    start,
    selectAudioTrack(ordinal) {
      audioTrack = ordinal;
      applyAudioTrack();
    },
    selectSubtitleLanguage(language) {
      subtitleLanguage = language;
      applySubtitle();
    },
    failureKind: () => failureKind,
    destroy() {
      if (!active) return;
      active = false;
      queuedSeek = undefined;
      finishSeek(false);
      trackChanges.disconnect();
      element.removeEventListener('load', renderCaptions, true);
      captions.remove();
      removeEventListener('resize', updateRect);
      try {
        const state = api.getState();
        if (state !== 'NONE' && state !== 'IDLE') api.stop();
        if (api.getState() !== 'NONE') api.close();
      } catch {
        console.warn('Samsung AVPlay cleanup failed.');
      }
      preparedReject?.(new DOMException('Samsung AVPlay was closed', 'AbortError'));
      restoreFacade();
      element.classList.remove('den-avplay-placeholder');
      element.closest('.player')?.classList.remove('den-avplay-active');
      plane.remove();
    },
  };
}
