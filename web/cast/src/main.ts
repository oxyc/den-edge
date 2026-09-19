import Hls from 'hls.js';
import './style.css';

interface Media {
  url: string;
  title: string;
  subtitle?: string;
  image?: string;
  currentTime?: number;
}

interface LoadMessage {
  type: 'den-load';
  id: string;
  media: Media;
}

interface CastSession {
  loadMedia(request: unknown): Promise<unknown>;
}

interface CastContext {
  setOptions(options: Record<string, unknown>): void;
  addEventListener(type: string, listener: () => void): void;
  getCurrentSession(): CastSession | null;
}

interface RemotePlayer {
  currentTime: number;
  duration: number;
  isPaused: boolean;
  playerState?: string;
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
        LoadRequest: new (info: unknown) => { currentTime?: number };
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

const keptProfile = localStorage.getItem('den.cast.profile');
if (keptProfile && [...profile.options].some((option) => option.value === keptProfile))
  profile.value = keptProfile;
profile.addEventListener('change', () => localStorage.setItem('den.cast.profile', profile.value));

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
  } else if (Hls.isSupported()) {
    hls = new Hls();
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

async function loadCast(): Promise<void> {
  const session = castContext?.getCurrentSession();
  const media = current?.media;
  const chrome = window.chrome?.cast;
  if (!session || !media || !chrome) return;
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
  try {
    await session.loadMedia(request);
    castStarted = true;
    status.textContent = 'Playing on Chromecast';
    video.pause();
    tell('den-cast', { state: 'playing', profile: profile.value });
  } catch {
    status.textContent = 'Chromecast could not load this release';
    tell('den-error', { message: status.textContent });
  }
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
    if (remotePlayer.playerState === 'IDLE' && remotePlayer.currentTime > 0) {
      castStarted = false;
      tell('den-ended');
    }
  });
  castContext.setOptions({
    receiverApplicationId: chrome.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  castContext.addEventListener(cast.CastContextEventType.SESSION_STATE_CHANGED, () => {
    void loadCast();
  });
}

window.__onGCastApiAvailable = (available) => {
  if (available) initializeCast();
};

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  const message = event.data as Partial<LoadMessage>;
  if (message.type !== 'den-load' || typeof message.id !== 'string' || !message.media) return;
  if (!signedMedia(message.media.url)) {
    event.source?.postMessage(
      { type: 'den-error', id: message.id, message: 'Invalid media URL' },
      {
        targetOrigin: event.origin,
      },
    );
    return;
  }
  parentOrigin = event.origin;
  current = message as LoadMessage;
  title.textContent = current.media.title;
  status.textContent = current.media.subtitle ?? 'Opening…';
  void loadLocal(current.media);
  void loadCast();
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
