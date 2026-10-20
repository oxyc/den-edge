import Hls from 'hls.js';
import { hlsConfig } from '../../src/lib/hlsConfig';
import { nativeHls } from '../../src/lib/nativeHls';
import { Link } from '../../src/lib/resumingLoader';
import {
  reportBody,
  reportUrlOf,
  sendReport,
  watchPlayback,
  type Watcher,
} from '../../src/lib/playbackStats';
import { lanReachable } from '../../src/lib/localNetwork';
import { castErrorAction, castIdleAction, castingTo, PLAYING_HERE, statusShown } from './lifecycle';
import { signedLinkLimit, usableLinkLimit } from './link';
import {
  denLifecycleMedia,
  lanHttpMedia,
  managedMedia,
  signedMedia,
  type PlayingMedia,
} from './media';
import { keepProfile, keptProfile } from './profile';
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
  /** TorBox's selected position, used when its HLS exposes several same-language renditions. */
  subtitleIndex?: number;
  /** A chosen external WebVTT staged on this page's origin for the receiver. */
  subtitleTrack?: { language: string; name: string; url: string };
  terminal?: boolean;
  /** Externally managed media has no Den lifecycle endpoint; this URL is the only capability handed to Cast. */
  external?: boolean;
  /**
   * The player outside reached `lanUrl` itself. A receiver on that network fetches it as that page did; this frame's
   * own check may be refused by the browser's Local Network Access for a cross-origin frame, so it is not asked.
   */
  lanProven?: boolean;
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
  requestSession(): Promise<unknown>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  getCurrentSession(): CastSession | null;
  getCastState(): string;
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
    CastContextEventType: { SESSION_STATE_CHANGED: string; CAST_STATE_CHANGED: string };
    RemotePlayer: new () => RemotePlayer;
    RemotePlayerController: new (player: RemotePlayer) => RemotePlayerController;
    RemotePlayerEventType: { ANY_CHANGE: string };
  };
  chrome: {
    cast: {
      AutoJoinPolicy: { PAGE_SCOPED: unknown };
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: string;
        HlsSegmentFormat: { FMP4: unknown; TS: unknown };
        HlsVideoSegmentFormat: { FMP4: unknown; MPEG2_TS: unknown };
        MetadataType: { GENERIC: unknown };
        StreamType: { BUFFERED: unknown };
        TrackType: { TEXT: unknown };
        TextTrackType: { SUBTITLES: unknown };
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
          tracks?: unknown[];
        };
        Track: new (
          id: number,
          type: unknown,
        ) => {
          trackContentId?: string;
          trackContentType?: string;
          subtype?: unknown;
          name?: string;
          language?: string;
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
    /** Google's Cast namespace: the framework is at `cast.framework`, not on `cast` itself. */
    cast?: { framework?: CastGlobals['framework'] };
    chrome?: CastGlobals['chrome'];
  }
}

const video = document.querySelector('video')!;
const statusPill = document.querySelector<HTMLElement>('#status')!;
const profile = document.querySelector<HTMLSelectElement>('#profile')!;
const castOptions = document.querySelector<HTMLElement>('.cast-options')!;
const choose = document.querySelector<HTMLButtonElement>('#choose')!;

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
/** Whether a receiver is on the network, once the SDK has said; undefined before that. */
let castDevices: boolean | undefined;
let replacingCast = false;
let castSubtitleAppliedId: string | undefined;
let measuredId: string | undefined;
/** What this page's video reports to den-remux (`watchPlayback`); stopped before hls.js is destroyed. */
let watcher: Watcher | undefined;
/** The connection as this page's segments see it (`resumingLoader`); one per hls.js instance. */
let link: Link | undefined;
let linkWatch: ReturnType<typeof setInterval> | undefined;
/** Said over the held picture while the connection is down and the buffer has run out. */
const RECONNECTING = 'Reconnecting…';
/**
 * The playlist of the session this page plays, or hands to a receiver: where its failures are reported and its end is
 * sent. The player outside can't do either for a session on the public address — its page may not connect there.
 */
let playing: PlayingMedia | undefined;
/** How long a measured load waits for the player to say play on, before it plays on regardless. */
const CONTINUE_WAIT_MS = 5_000;
/** The measured load waiting for the player's `den-continue`. */
let waiting: { id: string; resolve: () => void } | undefined;
/** The loads whose home-network address answered: they play from it, in this browser and on a Cast receiver alike. */
const onLan = new Set<string>();

function playUrl(id: string, media: Media): string {
  return media.lanUrl && onLan.has(id) ? media.lanUrl : media.url;
}

const kept = keptProfile();
if (kept && [...profile.options].some((option) => option.value === kept)) profile.value = kept;
profile.addEventListener('change', () => {
  keepProfile(profile.value);
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

/** Tell den-remux why the session couldn't play — its log sees nothing of it otherwise — and then the player. */
function fail(message: string, code = 0, owner: PlayingMedia | undefined = playing): void {
  const lifecycle = denLifecycleMedia(owner);
  if (lifecycle) {
    watcher?.spent();
    sendReport(reportUrlOf(lifecycle), reportBody(code, message));
  }
  tell('den-error', { message });
}

/** End the session this page played, so it stops holding den-remux and the media listener open. */
function endPlaying(): void {
  if (!playing) return;
  const lifecycle = denLifecycleMedia(playing);
  playing = undefined;
  if (!lifecycle) return;
  const url = lifecycle.replace(/\/master\.m3u8$/, '');
  void fetch(url, { method: 'DELETE', keepalive: true }).catch((error: unknown) =>
    // It ends on its own once idle; this only says why it lingered.
    console.warn('ending the session failed:', error),
  );
}

/**
 * Tell the player whether a Chromecast is discoverable. Also before anything is loaded here: the player asks
 * (`den-discover`) while its own video plays on, and moves playback here only once one is.
 */
function announceDevices(): void {
  if (castDevices === undefined || !parentOrigin) return;
  window.parent.postMessage(
    { type: 'den-cast-availability', id: current?.id, available: castDevices },
    parentOrigin,
  );
}

/** Stop this page's hls.js and the connection it was watching. */
function stopLocal(): void {
  watcher?.stop();
  watcher = undefined;
  hls?.destroy();
  hls = undefined;
  clearInterval(linkWatch);
  link?.dispose();
  link = undefined;
  if (statusPill.textContent === RECONNECTING) setStatus('');
}

/**
 * A connection that went away is waited out (`resumingLoader`): "Reconnecting…" once the buffer runs out, the
 * player outside asked to let this browser's address back in (it may have changed, and only that page can say so),
 * and playback carried on from the same second when the segments come back.
 */
function watchLink(connection: Link): void {
  const show = () => {
    const buffered = video.buffered;
    const ahead = buffered.length ? buffered.end(buffered.length - 1) - video.currentTime : 0;
    const shown = statusPill.textContent === RECONNECTING;
    if (connection.down && ahead < 0.5 && !shown) setStatus(RECONNECTING);
    else if ((!connection.down || ahead >= 0.5) && shown) setStatus('');
  };
  connection.beforeRetry = () => {
    tell('den-reconnect');
    return Promise.resolve();
  };
  connection.subscribe((down) => {
    clearInterval(linkWatch);
    show();
    if (down) linkWatch = setInterval(show, 250);
  });
}

async function loadLocal(media: Media, url: string): Promise<void> {
  stopLocal();
  video.removeAttribute('src');
  playing = {
    url,
    external: media.external === true,
    ...(url !== media.url && !media.external ? { lifecycleUrl: media.url } : {}),
  };
  const start = Math.max(0, media.currentTime ?? 0);
  // The player's own rule (`nativeHls`): Chrome claims HLS too, but hls.js plays there, and only hls.js rides out a
  // dropped connection with `resumingLoader`.
  if (nativeHls(video)) {
    video.src = url;
    watcher = watchPlayback({ video, reportUrl: media.external ? undefined : reportUrlOf(url) });
    // A native player takes a start position once it knows the stream; set before that it is ignored.
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (start > 0 && Math.abs(video.currentTime - start) > 2) video.currentTime = start;
        applySubtitle(media.subtitleLanguage, media.subtitleIndex);
      },
      { once: true },
    );
  } else if (Hls.isSupported()) {
    // The same tolerance as the player outside: a release den-remux converts answers its first segment late.
    const connection = (link = new Link());
    watchLink(connection);
    hls = new Hls(hlsConfig(start > 0 ? start : undefined, 'receiver', connection));
    watcher = watchPlayback({
      video,
      hls: { instance: hls, Hls },
      reportUrl: media.external ? undefined : reportUrlOf(url),
    });
    let recovered = false;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.frag?.type === 'subtitle')
        console.warn(
          `[Den subtitles] ${JSON.stringify({
            event: 'cast-page-hls-error',
            details: data.details,
            fatal: data.fatal,
            httpStatus: data.response?.code ?? null,
            track: hls?.subtitleTrack ?? null,
          })}`,
        );
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
        // A decoder that lost its place: reset the buffer and carry on, once.
        recovered = true;
        hls?.recoverMediaError();
        return;
      }
      // The session ended at den-remux (410), or the connection stayed away until the loader stopped asking: the
      // player outside offers to pick up where this was, rather than taking it for a release that won't play.
      const code = data.response?.code;
      if (
        data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR &&
        (code === 410 || (code === 0 && connection.down))
      ) {
        clearInterval(linkWatch);
        setStatus('');
        tell('den-lost', { currentTime: video.currentTime });
        return;
      }
      fail(`hls.js ${data.type} ${data.details}`);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () =>
      applySubtitle(media.subtitleLanguage, media.subtitleIndex),
    );
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    const message = 'This browser cannot play HLS';
    setStatus(message);
    fail(message);
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

function applySubtitle(language: string | null | undefined, subtitleIndex?: number): void {
  if (hls) {
    const languageMatch = language
      ? hls.subtitleTracks.findIndex((track) => sameLanguage(track.lang, language))
      : -1;
    const selected =
      language == null
        ? -1
        : subtitleIndex !== undefined && subtitleIndex < hls.subtitleTracks.length
          ? subtitleIndex
          : languageMatch >= 0
            ? languageMatch
            : hls.subtitleTracks.length === 1
              ? 0
              : -1;
    hls.subtitleDisplay = language != null && selected >= 0;
    hls.subtitleTrack = selected;
    console.info(
      `[Den subtitles] ${JSON.stringify({
        event: 'cast-page-applied',
        target: 'local-hls',
        language: language ?? null,
        torboxSelected: subtitleIndex ?? null,
        hlsSelected: selected,
        hlsTracks: hls.subtitleTracks.map((track, index) => ({
          index,
          language: track.lang,
          name: track.name,
        })),
      })}`,
    );
    return;
  }
  const nativeTracks = Array.from(video.textTracks);
  const selected =
    language == null
      ? undefined
      : ((subtitleIndex !== undefined ? nativeTracks[subtitleIndex] : undefined) ??
        nativeTracks.find((track) => sameLanguage(track.language, language)));
  for (const track of nativeTracks) track.mode = track === selected ? 'showing' : 'disabled';
  console.info(
    `[Den subtitles] ${JSON.stringify({
      event: 'cast-page-applied',
      target: 'local-native',
      language: language ?? null,
      torboxSelected: subtitleIndex ?? null,
      textTracks: Array.from(video.textTracks).map((track) => ({
        kind: track.kind,
        language: track.language,
        label: track.label,
        mode: track.mode,
      })),
    })}`,
  );
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

function validSubtitleTrack(
  value: Media['subtitleTrack'],
): value is NonNullable<Media['subtitleTrack']> {
  if (!value || !/^[a-z]{2,3}$/i.test(value.language) || !value.name) return false;
  try {
    const url = new URL(value.url);
    return url.origin === location.origin && /^\/subtitle\/[0-9a-f]{64}\.vtt$/.test(url.pathname);
  } catch {
    return false;
  }
}

function applyCastSubtitle(language: string | null | undefined, subtitleIndex?: number): boolean {
  const chrome = window.chrome?.cast;
  const media = castContext?.getCurrentSession()?.getMediaSession();
  if (!chrome || !media) return false;
  const tracks = media.media?.tracks;
  if (language && !tracks?.length) return false;
  const textTracks =
    tracks?.filter((candidate) => !candidate.type || candidate.type === 'TEXT') ?? [];
  const track = language
    ? ((subtitleIndex !== undefined ? textTracks[subtitleIndex] : undefined) ??
      textTracks.find(
        (candidate) =>
          (!candidate.type || candidate.type === 'TEXT') &&
          sameLanguage(candidate.language, language),
      ))
    : undefined;
  console.info(
    `[Den subtitles] ${JSON.stringify({
      event: 'cast-receiver-applied',
      language: language ?? null,
      torboxSelected: subtitleIndex ?? null,
      receiverTrack: track?.trackId ?? null,
      receiverTracks: textTracks.map((candidate, index) => ({
        index,
        id: candidate.trackId,
        language: candidate.language ?? null,
      })),
    })}`,
  );
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
  const url = playUrl(id, media);
  const requested = {
    url,
    external: media.external === true,
    ...(url !== media.url && !media.external ? { lifecycleUrl: media.url } : {}),
  };
  const info = new chrome.media.MediaInfo(url, 'application/x-mpegURL');
  info.streamType = chrome.media.StreamType.BUFFERED;
  // den-remux serves fMP4 segments; TorBox's managed HLS serves MPEG-TS, which a receiver told FMP4 cannot parse.
  if (media.external) {
    info.hlsSegmentFormat = chrome.media.HlsSegmentFormat.TS;
    info.hlsVideoSegmentFormat = chrome.media.HlsVideoSegmentFormat.MPEG2_TS;
  } else {
    info.hlsSegmentFormat = chrome.media.HlsSegmentFormat.FMP4;
    info.hlsVideoSegmentFormat = chrome.media.HlsVideoSegmentFormat.FMP4;
  }
  const metadata = new chrome.media.GenericMediaMetadata();
  metadata.title = media.title;
  metadata.subtitle = media.subtitle;
  if (media.image) metadata.images = [{ url: media.image }];
  info.metadata = metadata;
  if (validSubtitleTrack(media.subtitleTrack)) {
    const track = new chrome.media.Track(1, chrome.media.TrackType.TEXT);
    track.trackContentId = media.subtitleTrack.url;
    track.trackContentType = 'text/vtt';
    track.subtype = chrome.media.TextTrackType.SUBTITLES;
    track.name = media.subtitleTrack.name;
    track.language = media.subtitleTrack.language;
    info.tracks = [track];
  }
  const request = new chrome.media.LoadRequest(info);
  request.currentTime = Math.max(0, media.currentTime ?? 0);
  // An out-of-band VTT is known now; HLS renditions are discovered by the receiver and selected after LOAD.
  request.activeTrackIds =
    media.subtitleLanguage && validSubtitleTrack(media.subtitleTrack) ? [1] : [];
  try {
    replacingCast = castStarted;
    await session.loadMedia(request);
    // A LOAD replaces the receiver only once it succeeds. Until then its events and lifecycle still belong to
    // the previous media, even though `current` already describes the requested replacement.
    playing = requested;
    if (current?.id !== id) {
      void loadCast();
      return;
    }
    castStarted = true;
    castSubtitleAppliedId = applyCastSubtitle(media.subtitleLanguage, media.subtitleIndex)
      ? current?.id
      : undefined;
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
    fail(message, 0, requested);
  }
}

/**
 * Wait for the player to say play on after a measure (`den-continue`), or to replace this load with a session that
 * fits the link. A player that says neither within CONTINUE_WAIT_MS is played on regardless.
 */
function continued(id: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CONTINUE_WAIT_MS);
    waiting = {
      id,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    };
  });
}

async function open(message: LoadMessage): Promise<void> {
  // Google permits a secure Web Sender to hand an HTTP media URL to its receiver. Do not fetch that URL from this
  // HTTPS iframe: the parent already proved the local route and holds Chrome's Local Network Access permission.
  if (
    lanHttpMedia(message.media.url) ||
    lanHttpMedia(message.media.lanUrl ?? '') ||
    (message.media.mode === 'cast' && message.media.lanProven === true && message.media.lanUrl)
  ) {
    onLan.add(message.id);
    if (current?.id === message.id) tell('den-lan');
  }
  // Home first: on home Wi-Fi the router never loops a request for the public address back in, so only the
  // home-network address can play. Anywhere else this fails fast and the public address is used as before.
  if (!onLan.has(message.id) && (await lanReachable(message.media.lanUrl))) {
    onLan.add(message.id);
    // A link limit the player remembered from away doesn't belong here.
    if (current?.id === message.id) tell('den-lan');
  }
  if (current?.id !== message.id) return;
  // No home upload sits between this browser and den-remux on the LAN, so there is no link to measure.
  const measured = onLan.has(message.id) ? false : await measure(message.media, message.id);
  if (measured) await continued(message.id);
  if (current?.id !== message.id) return;
  // A receiver already chosen (the player's offer, `den-choose`) takes the load; asked for in browser mode, `loadCast`
  // has the player ask again for what this receiver plays.
  if (message.media.mode === 'cast' || castContext?.getCurrentSession()) await loadCast();
  else await loadLocal(message.media, playUrl(message.id, message.media));
  if (current?.id === message.id)
    applySubtitle(message.media.subtitleLanguage, message.media.subtitleIndex);
}

/** Starts the Cast framework; false when the SDK loaded without the framework or the chrome.cast API. */
function initializeCast(): boolean {
  const cast = window.cast?.framework;
  const chrome = window.chrome?.cast;
  if (!cast || !chrome) return false;
  castContext = cast.CastContext.getInstance();
  castDevices = castContext.getCastState() !== 'NO_DEVICES_AVAILABLE';
  castContext.addEventListener(cast.CastContextEventType.CAST_STATE_CHANGED, (event) => {
    castDevices = (event as { castState?: string }).castState !== 'NO_DEVICES_AVAILABLE';
    announceDevices();
  });
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
        applyCastSubtitle(current.media.subtitleLanguage, current.media.subtitleIndex)
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
      fail('Chromecast could not continue playback');
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
    if (state === 'SESSION_STARTED' && !current) {
      // Chosen from the player's offer, with nothing loaded yet: the player asks for what this receiver plays and
      // hands it here. Until then its own video plays on.
      document.documentElement.classList.remove('choosing');
      if (parentOrigin)
        window.parent.postMessage(
          { type: 'den-cast-session', state: 'started', profile: profile.value },
          parentOrigin,
        );
    } else if (state === 'SESSION_STARTED') {
      void loadCast();
    } else if (state === 'SESSION_ENDED' && castStarted) {
      castStarted = false;
      replacingCast = false;
      tell('den-cast', { state: 'stopped', reason: 'SESSION_ENDED' });
    }
  });
  return true;
}

/** How long the framework may take to arrive after the SDK says it is available. */
const FRAMEWORK_WAIT_MS = 10_000;

/**
 * Whether the Cast framework and the chrome.cast API are both loaded, waiting up to FRAMEWORK_WAIT_MS for them.
 * Desktop Chrome can call `__onGCastApiAvailable(true)` before the framework script `loadCastFramework=1` loads has
 * run, so `cast.framework` is not there yet when the callback is: taken as final, that left Cast unstarted on every
 * page load and no receiver was ever found.
 */
async function castFrameworkLoaded(): Promise<boolean> {
  const deadline = performance.now() + FRAMEWORK_WAIT_MS;
  while (!window.cast?.framework || !window.chrome?.cast) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * Google's launcher, created only once Cast has started. The SDK reads the element's display when it takes it over and
 * shows it with that value later, so one that was `hidden` then (as a launcher written into the page was, until Cast
 * started) is "shown" as `display: none` forever: with a receiver found there was still no button to press.
 */
function addCastLauncher(): void {
  const launcher = document.createElement('google-cast-launcher');
  launcher.setAttribute('aria-label', 'Cast to a TV');
  launcher.title = 'Cast to a TV';
  castOptions.before(launcher);
}

window.__onGCastApiAvailable = (available) => {
  if (!available) {
    castDevices = false;
    announceDevices();
    return;
  }
  // Only a browser with the Cast SDK has anything to cast from; elsewhere (Safari has AirPlay in its own
  // controls) the launcher would draw as an empty circle over the video. Google's launcher also hides itself
  // while no receiver is on the network, so adding it is not the same as showing it.
  void castFrameworkLoaded().then((loaded) => {
    try {
      if (!loaded || !initializeCast())
        throw new Error('the Cast SDK loaded without its framework');
      addCastLauncher();
    } catch (error) {
      // A button that was never initialised does nothing, so it stays hidden; the console says why.
      console.error('Cast could not start:', error);
      castDevices = false;
    }
    announceDevices();
  });
};

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  const message = event.data as Partial<LoadMessage>;
  if (message.type !== 'den-load' || typeof message.id !== 'string' || !message.media) return;
  if (
    (message.media.external ? !managedMedia(message.media.url) : !signedMedia(message.media.url)) ||
    (message.media.subtitleIndex !== undefined &&
      (!message.media.external ||
        !Number.isSafeInteger(message.media.subtitleIndex) ||
        message.media.subtitleIndex < 0)) ||
    (message.media.external &&
      (message.media.lanUrl !== undefined ||
        message.media.speed !== undefined ||
        message.media.measure === true)) ||
    (message.media.lanUrl !== undefined && !signedMedia(message.media.lanUrl)) ||
    !signedSpeed(message.media) ||
    (message.media.subtitleTrack !== undefined &&
      (!message.media.external || !validSubtitleTrack(message.media.subtitleTrack)))
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
    const previousSubtitle = current.media.subtitleTrack?.url;
    current = message as LoadMessage;
    if (
      castStarted &&
      current.media.subtitleLanguage &&
      current.media.subtitleTrack?.url !== previousSubtitle
    ) {
      current.media.currentTime = remotePlayer?.currentTime;
      void loadCast();
      return;
    }
    applySubtitle(current.media.subtitleLanguage, current.media.subtitleIndex);
    castSubtitleAppliedId = undefined;
    if (
      castStarted &&
      applyCastSubtitle(current.media.subtitleLanguage, current.media.subtitleIndex)
    )
      castSubtitleAppliedId = current.id;
    return;
  }
  current = message as LoadMessage;
  document.title = current.media.title;
  setStatus('');
  void open(current);
  // The SDK may have answered before this load arrived: say what it found now that there is a player to tell.
  announceDevices();
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent || !current) return;
  const message = event.data as {
    type?: string;
    id?: string;
    language?: unknown;
    track?: Media['subtitleTrack'];
  };
  if (message.type !== 'den-subtitle' || message.id !== current.id) return;
  const previousSubtitle = current.media.subtitleTrack?.url;
  current.media.subtitleLanguage = typeof message.language === 'string' ? message.language : null;
  current.media.subtitleTrack = validSubtitleTrack(message.track) ? message.track : undefined;
  if (
    castStarted &&
    current.media.subtitleLanguage &&
    current.media.subtitleTrack?.url !== previousSubtitle
  ) {
    current.media.currentTime = remotePlayer?.currentTime;
    void loadCast();
    return;
  }
  applySubtitle(current.media.subtitleLanguage, current.media.subtitleIndex);
  castSubtitleAppliedId = undefined;
  if (castStarted && applyCastSubtitle(current.media.subtitleLanguage, current.media.subtitleIndex))
    castSubtitleAppliedId = current.id;
});

/** The player asks whether a receiver is on the network, with nothing to load yet. */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  if ((event.data as { type?: string }).type !== 'den-discover') return;
  parentOrigin = event.origin;
  announceDevices();
});

/** The player offers casting: this page shows the one button that can open Chrome's device list. */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  if ((event.data as { type?: string }).type !== 'den-choose' || !castContext) return;
  parentOrigin = event.origin;
  document.documentElement.classList.add('choosing');
  choose.hidden = false;
  choose.focus();
});

choose.addEventListener('click', () => {
  // Rejected when the viewer closes the list without choosing: the offer stays, for another press.
  castContext?.requestSession().catch((error: unknown) => {
    console.info('No Chromecast chosen:', error);
  });
});

/** The player kept the measured session: play it. */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  const message = event.data as { type?: string; id?: string };
  const held = waiting;
  if (message.type !== 'den-continue' || !held || message.id !== held.id) return;
  waiting = undefined;
  held.resolve();
});

// The player outside removes this frame when its session ends — closed, restarted, or replaced — and that is this
// page's hide. The last report goes first, then the end; a receiver still fetches on its own, so its session is left.
window.addEventListener('pagehide', () => {
  watcher?.stop();
  watcher = undefined;
  link?.dispose();
  if (!castStarted) endPlaying();
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
  fail(video.error?.message || 'Playback failed', video.error?.code ?? 0),
);

window.parent.postMessage({ type: 'den-ready' }, '*');
