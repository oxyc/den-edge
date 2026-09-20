import Hls from 'hls.js';
import { hlsConfig } from '../../src/lib/hlsConfig';
import { lanReachable } from './lan';
import { castErrorAction, castIdleAction, castingTo, PLAYING_HERE, statusShown } from './lifecycle';
import { signedLinkLimit, usableLinkLimit } from './link';
import { signedMedia } from './media';
import './style.css';

interface Media {
  url: string;
  /** The same playlist on the home network, tried first: on home Wi-Fi the public address is unreachable. */
  lanUrl?: string;
  speed?: string;
  measure?: boolean;
  mode: 'browser' | 'cast';
  title: string;
  subtitle?: string;
  image?: string;
  currentTime?: number;
  subtitleLanguage?: string | null;
  terminal?: boolean;
}

interface LoadMessage {
  type: 'den-load';
  id: string;
  media: Media;
}

interface CastSession {
  loadMedia(request: unknown): Promise<unknown>;
  getMediaSession(): CastMedia | null;
  getCastDevice(): { friendlyName?: string };
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
  seek(): void;
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
      AutoJoinPolicy: { PAGE_SCOPED: unknown };
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
const statusPill = document.querySelector<HTMLElement>('#status')!;
const profile = document.querySelector<HTMLSelectElement>('#profile')!;
const castLauncher = document.querySelector<HTMLElement>('google-cast-launcher')!;
const castOptions = document.querySelector<HTMLElement>('.cast-options')!;

/** Text over the video only when it says something the picture does not: casting, an error. Otherwise nothing. */
function setStatus(text: string): void {
  statusPill.textContent = text;
  statusPill.hidden = !statusShown(text);
}
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
let remoteController: RemotePlayerController | undefined;
let castStarted = false;
let replacingCast = false;
let castSubtitleAppliedId: string | undefined;
let measuredId: string | undefined;
/** The loads whose home-network address answered: they play from it, in this browser and on a Cast receiver alike. */
const onLan = new Set<string>();

function playUrl(id: string, media: Media): string {
  return media.lanUrl && onLan.has(id) ? media.lanUrl : media.url;
}

const storedProfile = localStorage.getItem('den.cast.profile');
const keptProfile = storedProfile === 'google-tv' ? 'google-tv-4k' : storedProfile;
if (keptProfile && [...profile.options].some((option) => option.value === keptProfile))
  profile.value = keptProfile;
profile.addEventListener('change', () => {
  localStorage.setItem('den.cast.profile', profile.value);
  if (castContext?.getCurrentSession()) tell('den-cast-request', { profile: profile.value });
});

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

async function loadLocal(media: Media, url: string): Promise<void> {
  hls?.destroy();
  hls = undefined;
  video.removeAttribute('src');
  const start = Math.max(0, media.currentTime ?? 0);
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    // A native player takes a start position once it knows the stream; set before that it is ignored.
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (start > 0 && Math.abs(video.currentTime - start) > 2) video.currentTime = start;
        applySubtitle(media.subtitleLanguage);
      },
      { once: true },
    );
  } else if (Hls.isSupported()) {
    // The same tolerance as the player outside: a release den-remux converts answers its first segment late.
    hls = new Hls(hlsConfig(start > 0 ? start : undefined));
    let recovered = false;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
        // A decoder that lost its place: reset the buffer and carry on, once.
        recovered = true;
        hls?.recoverMediaError();
        return;
      }
      tell('den-error', { message: `hls.js ${data.type} ${data.details}` });
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => applySubtitle(media.subtitleLanguage));
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    const message = 'This browser cannot play HLS';
    setStatus(message);
    tell('den-error', { message });
    return;
  }
  describeToSystem(media);
  try {
    await video.play();
    setStatus(PLAYING_HERE);
  } catch {
    // A browser that won't start playback without a tap refuses here. That is its autoplay policy, not a fault, and
    // the video's own controls already carry the play button, so nothing more is said over the picture.
  }
}

/** What the lock screen and the system's media controls show for this page's video: the title and its poster. */
function describeToSystem(media: Media): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: media.subtitle ?? media.title,
    artist: media.subtitle ? media.title : undefined,
    album: media.title,
    artwork: media.image ? [{ src: media.image, sizes: '500x750', type: 'image/jpeg' }] : [],
  });
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
    const maxBitrate = usableLinkLimit(await signedLinkLimit(media.speed));
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
  const info = new chrome.media.MediaInfo(playUrl(id, media), 'application/x-mpegURL');
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
    setStatus(castingTo(session.getCastDevice?.().friendlyName));
    video.pause();
    tell('den-cast', { state: 'playing', profile: profile.value });
  } catch {
    replacingCast = false;
    if (current?.id !== id) {
      void loadCast();
      return;
    }
    castStarted = false;
    if (castErrorAction(media.terminal === true) === 'stop-receiver')
      castContext?.endCurrentSession(true);
    const message = 'Chromecast could not load this release';
    setStatus(message);
    tell('den-error', { message });
  }
}

async function open(message: LoadMessage): Promise<void> {
  // Home first: on home Wi-Fi the router never loops a request for the public address back in, so only the
  // home-network address can play. Anywhere else this fails fast and the public address is used as before.
  if (await lanReachable(message.media.lanUrl)) onLan.add(message.id);
  if (current?.id !== message.id) return;
  // No home upload sits between this browser and den-remux on the LAN, so there is no link to measure.
  const measured = onLan.has(message.id) ? false : await measure(message.media, message.id);
  if (current?.id !== message.id || measured) return;
  if (message.media.mode === 'cast') await loadCast();
  else await loadLocal(message.media, playUrl(message.id, message.media));
  if (current?.id === message.id) applySubtitle(message.media.subtitleLanguage);
}

function initializeCast(): void {
  const cast = window.cast;
  const chrome = window.chrome?.cast;
  if (!cast || !chrome) return;
  castContext = cast.CastContext.getInstance();
  remotePlayer = new cast.RemotePlayer();
  const controller = new cast.RemotePlayerController(remotePlayer);
  remoteController = controller;
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
      if (castErrorAction(current?.media.terminal === true) === 'stop-receiver')
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
    // Not ORIGIN_SCOPED: that re-joined any earlier Cast session for this origin on load, so opening a title on
    // the phone silently started streaming it to a TV. Casting begins only when the Cast button is pressed.
    autoJoinPolicy: chrome.AutoJoinPolicy.PAGE_SCOPED,
  });
  castContext.addEventListener(cast.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    const state = (event as { sessionState?: string }).sessionState;
    // The receiver menu is for choosing what the connected Chromecast is, so it is there only while one is.
    castOptions.hidden = !(state === 'SESSION_STARTED' || state === 'SESSION_RESUMED');
    if (state === 'SESSION_STARTED') {
      void loadCast();
    } else if (state === 'SESSION_ENDED' && castStarted) {
      castStarted = false;
      replacingCast = false;
      tell('den-cast', { state: 'stopped', reason: 'SESSION_ENDED' });
    }
  });
}

window.__onGCastApiAvailable = (available) => {
  if (!available) return;
  initializeCast();
  // Only a browser with the Cast SDK has anything to cast from; elsewhere (Safari has AirPlay in its own
  // controls) the launcher would draw as an empty circle over the video.
  castLauncher.hidden = false;
};

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  const message = event.data as Partial<LoadMessage>;
  if (message.type !== 'den-load' || typeof message.id !== 'string' || !message.media) return;
  if (
    !signedMedia(message.media.url) ||
    (message.media.lanUrl !== undefined && !signedMedia(message.media.lanUrl)) ||
    !signedSpeed(message.media)
  ) {
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
  document.title = current.media.title;
  setStatus('');
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

/** The outside player's Skip button: move this page's video, or the receiver it is casting to, to `time`. */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent || !current) return;
  const message = event.data as { type?: string; id?: string; time?: unknown };
  if (message.type !== 'den-seek' || message.id !== current.id) return;
  if (typeof message.time !== 'number' || !Number.isFinite(message.time) || message.time < 0)
    return;
  if (castStarted && remotePlayer && remoteController) {
    remotePlayer.currentTime = message.time;
    remoteController.seek();
  } else {
    video.currentTime = message.time;
  }
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
