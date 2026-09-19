import Hls from 'hls.js';
import { castIdleAction } from './lifecycle';
import { signedLinkLimit } from './link';
import './style.css';

interface Media {
  url: string;
  speed?: string;
  measure?: boolean;
  mode: 'browser' | 'cast';
  title: string;
  subtitle?: string;
  image?: string;
  currentTime?: number;
  subtitleLanguage?: string | null;
}

interface LoadMessage {
  type: 'den-load';
  id: string;
  media: Media;
}

interface CastSession {
  loadMedia(request: unknown): Promise<unknown>;
  getMediaSession(): CastMedia | null;
}

interface CastMedia {
  idleReason?: string | null;
  media?: {
    tracks?: { trackId: number; language?: string | null; type?: string | null }[];
  };
  editTracksInfo(request: unknown, success?: () => void, error?: () => void): void;
}

interface CastContext {
  setOptions(options: Record<string, unknown>): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  getCurrentSession(): CastSession | null;
  endCurrentSession(stopCasting: boolean): void;
}

interface RemotePlayer {
  currentTime: number;
  duration: number;
  isPaused: boolean;
  playerState?: string;
  isConnected: boolean;
}

interface RemotePlayerController {
  addEventListener(type: string, listener: () => void): void;
}

interface CastGlobals {
  framework: {
    CastContext: { getInstance(): CastContext };
    CastContextEventType: { SESSION_STATE_CHANGED: string };
    RemotePlayer: new () => RemotePlayer;
    RemotePlayerController: new (player: RemotePlayer) => RemotePlayerController;
    RemotePlayerEventType: { ANY_CHANGE: string };
  };
  chrome: {
    cast: {
      AutoJoinPolicy: { ORIGIN_SCOPED: unknown };
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: string;
        HlsSegmentFormat: { FMP4: unknown };
        HlsVideoSegmentFormat: { FMP4: unknown };
        MetadataType: { GENERIC: unknown };
        StreamType: { BUFFERED: unknown };
        GenericMediaMetadata: new () => {
          title?: string;
          subtitle?: string;
          images?: { url: string }[];
        };
        MediaInfo: new (
          url: string,
          contentType: string,
        ) => {
          streamType?: unknown;
          metadata?: unknown;
          hlsSegmentFormat?: unknown;
          hlsVideoSegmentFormat?: unknown;
        };
        LoadRequest: new (info: unknown) => { currentTime?: number; activeTrackIds?: number[] };
        EditTracksInfoRequest: new (activeTrackIds?: number[]) => unknown;
      };
    };
  };
}

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: CastGlobals['framework'];
    chrome?: CastGlobals['chrome'];
  }
}

const video = document.querySelector('video')!;
const title = document.querySelector('#title')!;
const status = document.querySelector('#status')!;
const profile = document.querySelector<HTMLSelectElement>('#profile')!;
const parents = new Set(
  (import.meta.env.VITE_DEN_PARENT_ORIGINS ?? 'https://d.oxy.fi')
    .split(',')
    .map((origin: string) => origin.trim())
    .filter(Boolean),
);
let parentOrigin: string | undefined;
let current: LoadMessage | undefined;
let hls: Hls | undefined;
let castContext: CastContext | undefined;
let remotePlayer: RemotePlayer | undefined;
let castStarted = false;
let replacingCast = false;
let castSubtitleAppliedId: string | undefined;
let measuredId: string | undefined;

const storedProfile = localStorage.getItem('den.cast.profile');
const keptProfile = storedProfile === 'google-tv' ? 'google-tv-4k' : storedProfile;
if (keptProfile && [...profile.options].some((option) => option.value === keptProfile))
  profile.value = keptProfile;
profile.addEventListener('change', () => {
  localStorage.setItem('den.cast.profile', profile.value);
  if (castContext?.getCurrentSession()) tell('den-cast-request', { profile: profile.value });
});

function signedMedia(url: string): boolean {
  try {
    const parsed = new URL(url);
    const ip = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.includes(':');
    return (
      parsed.protocol === 'https:' &&
      ip &&
      /^\/remux\/s\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}\/master\.m3u8$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function signedSpeed(media: Media): boolean {
  if (!media.speed) return true;
  try {
    const playlist = new URL(media.url);
    const speed = new URL(media.speed);
    return (
      playlist.origin === speed.origin &&
      playlist.pathname.replace(/master\.m3u8$/, 'speed') === speed.pathname
    );
  } catch {
    return false;
  }
}

function tell(type: string, fields: Record<string, unknown> = {}): void {
  if (!parentOrigin || !current) return;
  window.parent.postMessage({ type, id: current.id, ...fields }, parentOrigin);
}

async function loadLocal(media: Media): Promise<void> {
  hls?.destroy();
  hls = undefined;
  video.removeAttribute('src');
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = media.url;
    video.addEventListener('loadedmetadata', () => applySubtitle(media.subtitleLanguage), {
      once: true,
    });
  } else if (Hls.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.MANIFEST_PARSED, () => applySubtitle(media.subtitleLanguage));
    hls.loadSource(media.url);
    hls.attachMedia(video);
  } else {
    status.textContent = 'This browser cannot play HLS';
    tell('den-error', { message: status.textContent });
    return;
  }
  video.currentTime = Math.max(0, media.currentTime ?? 0);
  try {
    await video.play();
  } catch {
    status.textContent = 'Press play, or choose Cast';
  }
}

function applySubtitle(language: string | null | undefined): void {
  if (hls) {
    hls.subtitleDisplay = language != null;
    hls.subtitleTrack =
      language == null ? -1 : hls.subtitleTracks.findIndex((track) => track.lang === language);
    return;
  }
  for (const track of Array.from(video.textTracks))
    track.mode = language != null && track.language === language ? 'showing' : 'disabled';
}

async function measure(media: Media, id: string): Promise<boolean> {
  if (!media.measure || !media.speed || measuredId === id) return false;
  measuredId = id;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const maxBitrate = await signedLinkLimit(media.speed);
    if (current?.id !== id) return false;
    if (maxBitrate) {
      tell('den-speed', { maxBitrate });
      return true;
    }
  }
  return false;
}

function sameLanguage(track: string | null | undefined, wanted: string): boolean {
  if (!track) return false;
  const one = track.toLowerCase();
  const two = wanted.toLowerCase();
  return one === two || one.split('-')[0] === two.split('-')[0];
}

function applyCastSubtitle(language: string | null | undefined): boolean {
  const chrome = window.chrome?.cast;
  const media = castContext?.getCurrentSession()?.getMediaSession();
  if (!chrome || !media) return false;
  const tracks = media.media?.tracks;
  if (language && !tracks?.length) return false;
  const track = language
    ? tracks?.find(
        (candidate) =>
          (!candidate.type || candidate.type === 'TEXT') &&
          sameLanguage(candidate.language, language),
      )
    : undefined;
  media.editTracksInfo(
    new chrome.media.EditTracksInfoRequest(track ? [track.trackId] : []),
    () => undefined,
    () => undefined,
  );
  return true;
}

async function loadCast(): Promise<void> {
  const id = current?.id;
  const session = castContext?.getCurrentSession();
  const media = current?.media;
  const chrome = window.chrome?.cast;
  if (!id || !session || !media || !chrome) return;
  if (media.mode !== 'cast') {
    tell('den-cast-request', { profile: profile.value });
    return;
  }
  const info = new chrome.media.MediaInfo(media.url, 'application/x-mpegURL');
  info.streamType = chrome.media.StreamType.BUFFERED;
  info.hlsSegmentFormat = chrome.media.HlsSegmentFormat.FMP4;
  info.hlsVideoSegmentFormat = chrome.media.HlsVideoSegmentFormat.FMP4;
  const metadata = new chrome.media.GenericMediaMetadata();
  metadata.title = media.title;
  metadata.subtitle = media.subtitle;
  if (media.image) metadata.images = [{ url: media.image }];
  info.metadata = metadata;
  const request = new chrome.media.LoadRequest(info);
  request.currentTime = Math.max(0, media.currentTime ?? 0);
  // Load with captions off, then apply Den's preference after the receiver has parsed the HLS renditions.
  request.activeTrackIds = [];
  try {
    replacingCast = castStarted;
    await session.loadMedia(request);
    if (current?.id !== id) {
      void loadCast();
      return;
    }
    castStarted = true;
    castSubtitleAppliedId = applyCastSubtitle(media.subtitleLanguage) ? current?.id : undefined;
    status.textContent = 'Playing on Chromecast';
    video.pause();
    tell('den-cast', { state: 'playing', profile: profile.value });
  } catch {
    replacingCast = false;
    if (current?.id !== id) {
      void loadCast();
      return;
    }
    status.textContent = 'Chromecast could not load this release';
    tell('den-error', { message: status.textContent });
  }
}

async function open(message: LoadMessage): Promise<void> {
  const measured = await measure(message.media, message.id);
  if (current?.id !== message.id || measured) return;
  if (message.media.mode === 'cast') await loadCast();
  else await loadLocal(message.media);
  if (current?.id === message.id) applySubtitle(message.media.subtitleLanguage);
}

function initializeCast(): void {
  const cast = window.cast;
  const chrome = window.chrome?.cast;
  if (!cast || !chrome) return;
  castContext = cast.CastContext.getInstance();
  remotePlayer = new cast.RemotePlayer();
  const controller = new cast.RemotePlayerController(remotePlayer);
  controller.addEventListener(cast.RemotePlayerEventType.ANY_CHANGE, () => {
    if (!castStarted || !remotePlayer) return;
    tell('den-progress', {
      currentTime: remotePlayer.currentTime,
      duration: remotePlayer.duration,
      paused: remotePlayer.isPaused,
    });
    if (remotePlayer.playerState !== 'IDLE') {
      replacingCast = false;
      if (
        current &&
        castSubtitleAppliedId !== current.id &&
        applyCastSubtitle(current.media.subtitleLanguage)
      )
        castSubtitleAppliedId = current.id;
      return;
    }
    const reason = castContext?.getCurrentSession()?.getMediaSession()?.idleReason;
    const action = castIdleAction(reason, replacingCast);
    if (action === 'replaced') return;
    replacingCast = false;
    castStarted = false;
    if (action === 'finished') tell('den-ended');
    else if (action === 'error') {
      castContext?.endCurrentSession(true);
      tell('den-error', { message: 'Chromecast could not continue playback' });
    } else {
      // CANCELLED means the media was stopped; an unrelated sender's LOAD is merely disconnected from.
      castContext?.endCurrentSession(reason !== 'INTERRUPTED');
      tell('den-cast', { state: 'stopped', reason });
    }
  });
  castContext.setOptions({
    receiverApplicationId: chrome.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  castContext.addEventListener(cast.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    const state = (event as { sessionState?: string }).sessionState;
    if (state === 'SESSION_STARTED' || state === 'SESSION_RESUMED') {
      void loadCast();
    } else if (state === 'SESSION_ENDED' && castStarted) {
      castStarted = false;
      replacingCast = false;
      tell('den-cast', { state: 'stopped', reason: 'SESSION_ENDED' });
    }
  });
}

window.__onGCastApiAvailable = (available) => {
  if (available) initializeCast();
};

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  const message = event.data as Partial<LoadMessage>;
  if (message.type !== 'den-load' || typeof message.id !== 'string' || !message.media) return;
  if (!signedMedia(message.media.url) || !signedSpeed(message.media)) {
    event.source?.postMessage(
      { type: 'den-error', id: message.id, message: 'Invalid media URL' },
      {
        targetOrigin: event.origin,
      },
    );
    return;
  }
  parentOrigin = event.origin;
  if (current?.id === message.id) {
    current = message as LoadMessage;
    applySubtitle(current.media.subtitleLanguage);
    castSubtitleAppliedId = undefined;
    if (castStarted && applyCastSubtitle(current.media.subtitleLanguage))
      castSubtitleAppliedId = current.id;
    return;
  }
  current = message as LoadMessage;
  title.textContent = current.media.title;
  status.textContent = current.media.subtitle ?? 'Opening…';
  void open(current);
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent || !current) return;
  const message = event.data as { type?: string; id?: string; language?: unknown };
  if (message.type !== 'den-subtitle' || message.id !== current.id) return;
  current.media.subtitleLanguage = typeof message.language === 'string' ? message.language : null;
  applySubtitle(current.media.subtitleLanguage);
  castSubtitleAppliedId = undefined;
  if (castStarted && applyCastSubtitle(current.media.subtitleLanguage))
    castSubtitleAppliedId = current.id;
});

video.addEventListener('timeupdate', () =>
  tell('den-progress', {
    currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : undefined,
    paused: video.paused,
  }),
);
video.addEventListener('ended', () => tell('den-ended'));
video.addEventListener('error', () =>
  tell('den-error', { message: video.error?.message ?? 'Playback failed' }),
);

window.parent.postMessage({ type: 'den-ready' }, '*');
