import type Hls from 'hls.js';
import { hlsConfig } from '../../src/lib/hlsConfig';
import { reportMediaEngineFailure } from '../../src/lib/mediaEngineDiagnostics';
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
import { castIdleAction, castingTo, PLAYING_HERE, statusShown } from './lifecycle';
import { signedLinkLimit, usableLinkLimit } from './link';
import {
  denLifecycleMedia,
  lanHttpMedia,
  managedMedia,
  signedMedia,
  type PlayingMedia,
} from './media';
import { DEFAULT_PARENT_ORIGINS, parentOrigins } from './parentOrigins';
import { keepProfile, keptProfile } from './profile';
import {
  DEN_RECEIVER_APP_ID,
  playableOf,
  RECEIVER_NAMESPACE,
  RECEIVER_REPORT_MS,
} from '../../src/lib/castReceiver';
import type { Playable } from '../../src/lib/playable';
import './style.css';

interface Media {
  url: string;
  /** The same playlist on the home network, tried first: on home Wi-Fi the public address is unreachable. */
  lanUrl?: string;
  speed?: string;
  measure?: boolean;
  mode: 'browser' | 'cast';
  interfaceLanguage?: 'en' | 'es' | 'sv';
  title: string;
  subtitle?: string;
  image?: string;
  currentTime?: number;
  subtitleLanguage?: string | null;
  /** TorBox's selected position, used when its HLS exposes several same-language renditions. */
  subtitleIndex?: number;
  /** A chosen external WebVTT staged on this page's origin for the receiver. */
  subtitleTrack?: { language: string; name: string; url: string };
  /** Externally managed media has no Den lifecycle endpoint; this URL is the only capability handed to Cast. */
  external?: boolean;
  /** Hearth's opaque terminal lifecycle capability. */
  lifecycleUrl?: string;
  /**
   * The player outside reached `lanUrl` itself. A receiver on that network fetches it as that page did; this frame's
   * own check may be refused by the browser's Local Network Access for a cross-origin frame, so it is not asked.
   */
  lanProven?: boolean;
}

interface LoadMessage {
  type: 'den-load';
  id: string;
  /** The parent player's exact session-start generation; a playlist URL alone may be reused by a replacement. */
  generation: number;
  media: Media;
}

interface CastSession {
  loadMedia(request: unknown): Promise<unknown>;
  getMediaSession(): CastMedia | null;
  getCastDevice(): { friendlyName?: string };
  addMessageListener?(
    namespace: string,
    listener: (namespace: string, message: string) => void,
  ): void;
  removeMessageListener?(
    namespace: string,
    listener: (namespace: string, message: string) => void,
  ): void;
  sendMessage?(namespace: string, message: unknown): Promise<unknown>;
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
  volumeLevel?: number;
  isMuted?: boolean;
}

interface RemotePlayerController {
  addEventListener(type: string, listener: () => void): void;
  seek(): void;
  playOrPause(): void;
  setVolumeLevel(): void;
  muteOrUnmute(): void;
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
        LoadRequest: new (info: unknown) => {
          currentTime?: number;
          activeTrackIds?: number[];
          customData?: unknown;
        };
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
    chrome?: CastGlobals['chrome'] & { cast?: { isAvailable?: boolean } };
  }
}

const video = document.querySelector('video')!;
const statusPill = document.querySelector<HTMLElement>('#status')!;
const castButton = document.querySelector<HTMLButtonElement>('#cast')!;
const localPlayButton = document.querySelector<HTMLButtonElement>('#play-local')!;
const outputs = document.querySelector<HTMLElement>('.outputs')!;
const airPlayButton = document.querySelector<HTMLButtonElement>('#airplay')!;
const fullscreenButton = document.querySelector<HTMLButtonElement>('#fullscreen')!;
/** The receiver models the player names (`castCapabilities`); the viewer's pick is kept on this origin. */
const PROFILES = ['legacy', 'gen3', 'ultra', 'google-tv-hd', 'google-tv-4k', 'streamer'];
const kept = keptProfile();
let profile = kept && PROFILES.includes(kept) ? kept : 'google-tv-4k';
/**
 * Den's own receiver, when this page launches it: the one den-edge names (`CAST_APP_ID`), else the one this browser
 * opted in to (`?receiver=den` from the player). Undefined launches Google's Default Media Receiver.
 */
const configuredApp = document.querySelector<HTMLMetaElement>('meta[name="den-cast-app"]')?.content;
const receiverApp = /^[0-9A-F]{8}$/.test(configuredApp ?? '')
  ? configuredApp
  : new URLSearchParams(location.search).get('receiver') === 'den'
    ? DEN_RECEIVER_APP_ID
    : undefined;
/** What the connected Den receiver said its TV plays; asked with in place of `profile` while it is known. */
let receiverPlayable: Playable | undefined;
/**
 * The same report's `details` (the largest picture, the Cast firmware, the device type), passed on as they came for
 * den-edge's cast report: the player keeps only the well-formed fields (`receiverInfoOf`).
 */
let receiverDevice: unknown;

/** The profile the player asks with: the receiver's own report, or the Chromecast model chosen. */
function asking(): { profile: string; playable?: Playable; receiverInfo?: unknown } {
  return receiverPlayable
    ? {
        profile: 'receiver',
        playable: receiverPlayable,
        ...(receiverDevice ? { receiverInfo: receiverDevice } : {}),
      }
    : { profile };
}

/**
 * Ask Den's receiver what its TV plays, waiting RECEIVER_REPORT_MS for the answer. With none (Google's receiver, an
 * older Den receiver, a slow one), the chosen model's profile is asked with as before.
 */
async function learnReceiver(session: CastSession | null | undefined): Promise<void> {
  receiverPlayable = undefined;
  receiverDevice = undefined;
  if (!receiverApp || !session?.addMessageListener || !session.sendMessage) return;
  const { addMessageListener, sendMessage } = session;
  receiverPlayable = await new Promise<Playable | undefined>((resolve) => {
    const done = (can?: Playable) => {
      clearTimeout(timer);
      session.removeMessageListener?.(RECEIVER_NAMESPACE, heard);
      resolve(can);
    };
    const heard = (_namespace: string, raw: string) => {
      let message: { type?: unknown; playable?: unknown; details?: unknown } | null;
      try {
        message = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return;
      }
      if (message?.type !== 'den-capabilities') return;
      const can = playableOf(message.playable) ?? undefined;
      receiverDevice = can ? message.details : undefined;
      console.info(
        `[Den cast] ${JSON.stringify({ event: 'receiver-capabilities', playable: can ?? null, details: message.details ?? null })}`,
      );
      done(can);
    };
    const timer = setTimeout(() => {
      console.info(`[Den cast] ${JSON.stringify({ event: 'receiver-capabilities-timeout' })}`);
      done();
    }, RECEIVER_REPORT_MS);
    addMessageListener.call(session, RECEIVER_NAMESPACE, heard);
    sendMessage.call(session, RECEIVER_NAMESPACE, { type: 'den-capabilities' }).catch(() => done());
  });
}

/**
 * Print what Den's receiver says its player did (`den-receiver-event`: a LOAD's format, state changes, buffering,
 * errors, blocked requests) in this console, the only one a viewer can share: the TV's own is out of reach.
 */
function hearReceiverEvents(session: CastSession | null | undefined): void {
  if (!receiverApp || !session?.addMessageListener) return;
  session.addMessageListener(RECEIVER_NAMESPACE, (_namespace: string, raw: string) => {
    let message: { type?: unknown; id?: unknown; generation?: unknown } | null;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (message?.type !== 'den-receiver-event') return;
    // The receiver's `id` is the signed playlist capability. Keep it for the exact ownership check below, but never
    // copy it into a console a viewer may share.
    const {
      type: _type,
      id: _privateLoadId,
      ...event
    } = message as {
      type: unknown;
      id?: unknown;
    } & Record<string, unknown>;
    console.info(`[Den receiver] ${JSON.stringify(event)}`);
    const reportedLoad = exactLoad(message.id, message.generation) ? playingLoad : undefined;
    // The codes of the receiver's player error, for den-edge's cast report: numbers only.
    if (event.event === 'error' && reportedLoad) {
      const shaka = (event.error as { shakaErrorCode?: unknown } | null)?.shakaErrorCode;
      tellFor(reportedLoad, 'den-receiver-error', {
        ...(Number.isInteger(event.detailedErrorCode) ? { code: event.detailedErrorCode } : {}),
        ...(Number.isInteger(shaka) ? { shaka } : {}),
      });
    }
    // The receiver's player gave up on what it was playing. The sender's own media session can report that idle
    // with no reason (`castIdleAction` waits on it as 'pending'), which left the player at "Starting Chromecast…"
    // and the TV on Den's idle screen.
    if (
      event.event === 'state' &&
      event.state === 'IDLE' &&
      event.idleReason === 'ERROR' &&
      reportedLoad &&
      castStarted &&
      !receiverLoadAttempt?.replacing
    ) {
      castStarted = false;
      failFor(reportedLoad, 'Chromecast could not continue playback');
    }
  });
}

type InterfaceLanguage = 'en' | 'es' | 'sv';
let interfaceLanguage: InterfaceLanguage = 'en';
const COPY: Record<Exclude<InterfaceLanguage, 'en'>, Record<string, string>> = {
  es: {
    'Cast to a TV': 'Transmitir a un televisor',
    'Connecting to a Chromecast…': 'Conectando con un Chromecast…',
    'Casting to {device}': 'Transmitiendo a {device}',
    'your Chromecast': 'tu Chromecast',
    'Reconnecting…': 'Reconectando…',
    'Playing on this device': 'Reproduciendo en este dispositivo',
    'This browser cannot play HLS': 'Este navegador no puede reproducir HLS',
    'Chromecast could not load this release': 'Chromecast no pudo cargar esta versión',
    'Chromecast could not continue playback': 'Chromecast no pudo continuar la reproducción',
    'Playback failed': 'La reproducción falló',
    'Invalid media URL': 'URL multimedia no válida',
    Play: 'Reproducir',
    AirPlay: 'AirPlay',
    'Change AirPlay device': 'Cambiar dispositivo AirPlay',
    Fullscreen: 'Pantalla completa',
  },
  sv: {
    'Cast to a TV': 'Casta till en tv',
    'Connecting to a Chromecast…': 'Ansluter till en Chromecast…',
    'Casting to {device}': 'Castar till {device}',
    'your Chromecast': 'din Chromecast',
    'Reconnecting…': 'Ansluter igen…',
    'Playing on this device': 'Spelar på den här enheten',
    'This browser cannot play HLS': 'Den här webbläsaren kan inte spela HLS',
    'Chromecast could not load this release': 'Chromecast kunde inte läsa in den här versionen',
    'Chromecast could not continue playback': 'Chromecast kunde inte fortsätta uppspelningen',
    'Playback failed': 'Uppspelningen misslyckades',
    'Invalid media URL': 'Ogiltig medie-URL',
    Play: 'Spela',
    AirPlay: 'AirPlay',
    'Change AirPlay device': 'Byt AirPlay-enhet',
    Fullscreen: 'Helskärm',
  },
};
const text = (english: string): string =>
  interfaceLanguage === 'en' ? english : (COPY[interfaceLanguage][english] ?? english);
function applyInterfaceLanguage(language: unknown): void {
  if (language !== 'en' && language !== 'es' && language !== 'sv') return;
  interfaceLanguage = language;
  document.documentElement.lang = language;
  localPlayButton.textContent = text('Play');
  localPlayButton.setAttribute('aria-label', text('Play'));
  renderButton();
}

/**
 * The Cast state as the SDK names it (`CastContext.getCastState`): NO_DEVICES_AVAILABLE, NOT_CONNECTED, CONNECTING or
 * CONNECTED. Undefined until the SDK has started, and for good where it never does (Safari, Firefox).
 */
let castState: string | undefined;
/** The connected receiver's own name, as its owner set it up; absent until one is connected. */
function deviceName(): string | undefined {
  return castContext?.getCurrentSession()?.getCastDevice?.().friendlyName || undefined;
}

/**
 * The Cast state with the receiver app it applies to, for the console a viewer can share. Chrome finds devices per
 * receiver app, so a hidden Cast button with Den's receiver (NO_DEVICES_AVAILABLE) means no Chromecast on the network
 * can launch that app yet, while Google's Default Media Receiver still finds them.
 */
function logCastState(): void {
  console.info(
    `[Den cast] ${JSON.stringify({ event: 'cast-state', state: castContext?.getCastState() ?? castState ?? null, receiver: receiverApp ?? 'default' })}`,
  );
}

/**
 * The one Cast button: hidden until a receiver is on the network, then the outline glyph; its arcs pulse while a
 * session starts, and the screen fills once one has. Its name says which of those it is.
 */
function renderButton(): void {
  const state = castState ?? 'NO_DEVICES_AVAILABLE';
  document.documentElement.dataset.cast = state.toLowerCase();
  castButton.hidden = state === 'NO_DEVICES_AVAILABLE';
  const label =
    state === 'CONNECTED'
      ? text('Casting to {device}').replace('{device}', deviceName() ?? text('your Chromecast'))
      : state === 'CONNECTING'
        ? text('Connecting to a Chromecast…')
        : text('Cast to a TV');
  castButton.setAttribute('aria-label', label);
  castButton.title = label;
  // Pressed while connected, the button opens the player's Cast menu (Stop casting) rather than Chrome's list.
  if (state === 'CONNECTED' || state === 'CONNECTING')
    castButton.setAttribute('aria-haspopup', 'menu');
  else castButton.removeAttribute('aria-haspopup');
  renderOutputs();
}

type AirPlayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};
const airPlayVideo = video as AirPlayVideo;
/**
 * Whether AirPlay may be offered: wherever Safari has the picker, until it says no device is on the network — the
 * player's own button's rule. On an iPhone (2026-11-20) the button was gone once Den Remux moved into this frame;
 * waiting here for an `available` answer that never came is the inferred cause, not a measured one. Elsewhere it
 * stays false.
 */
let airPlayAvailable = typeof airPlayVideo.webkitShowPlaybackTargetPicker === 'function';
if (airPlayAvailable) {
  video.addEventListener('webkitplaybacktargetavailabilitychanged', (event) => {
    airPlayAvailable = (event as Event & { availability?: string }).availability === 'available';
    renderOutputs();
  });
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
    renderOutputs();
    // The receiver fetches the media from its own address, which the player outside lets in (`den-airplay`).
    tellFor(playingLoad, 'den-airplay', {
      wireless: !!airPlayVideo.webkitCurrentPlaybackTargetIsWireless,
    });
  });
}
airPlayButton.addEventListener('click', () => airPlayVideo.webkitShowPlaybackTargetPicker?.());

/**
 * An iPhone, where no element can be made fullscreen and the player's own fullscreen cannot reach this frame's video:
 * only `webkitEnterFullscreen`, called from a press in this document, fills the screen. Everywhere else the player
 * makes itself fullscreen, this frame included.
 */
const fullscreenVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
const videoFullscreenOnly =
  !document.fullscreenEnabled && typeof fullscreenVideo.webkitEnterFullscreen === 'function';
fullscreenButton.addEventListener('click', () => fullscreenVideo.webkitEnterFullscreen?.());

/** Whether the player has given the output buttons a place (`den-outputs-slot`). */
let outputsSlotted = false;
/** Whether the player has given the fullscreen button its place, in its dock (`den-outputs-slot`'s `fullscreen`). */
let fullscreenSlotted = false;
/** The output buttons shown, sent with every change so the player sizes the hole it leaves for them. */
let reportedOutputs = '';

/**
 * AirPlay beside Cast where this page plays the session under the player's transport (`html.driven`); the player
 * cannot open Safari's device list for a video in another document. It names the device while one is playing.
 */
function renderOutputs(): void {
  const driven = document.documentElement.classList.contains('driven');
  const wireless = !!airPlayVideo.webkitCurrentPlaybackTargetIsWireless;
  airPlayButton.hidden = !driven || !(airPlayAvailable || wireless);
  airPlayButton.classList.toggle('on', wireless);
  airPlayButton.setAttribute('aria-pressed', String(wireless));
  airPlayButton.setAttribute('aria-label', text(wireless ? 'Change AirPlay device' : 'AirPlay'));
  airPlayButton.title = airPlayButton.getAttribute('aria-label')!;
  const fullscreen = driven && videoFullscreenOnly;
  fullscreenButton.hidden = !fullscreen || !fullscreenSlotted;
  fullscreenButton.setAttribute('aria-label', text('Fullscreen'));
  fullscreenButton.title = text('Fullscreen');
  const shown = {
    cast: !castButton.hidden,
    airplay: !airPlayButton.hidden,
    fullscreen,
  };
  const report = JSON.stringify(shown);
  if (!driven || report === reportedOutputs) return;
  reportedOutputs = report;
  say('den-outputs', shown);
}

const OUTPUTS_BOX = ['left', 'top', 'width', 'height'] as const;

/** Place `element` in `box`, in this page's pixels; false where the box isn't one (the player's controls hidden). */
function placeIn(element: HTMLElement, box: unknown): boolean {
  const valid =
    !!box &&
    typeof box === 'object' &&
    OUTPUTS_BOX.every((key) => Number.isFinite((box as Record<string, unknown>)[key]));
  if (valid)
    for (const key of OUTPUTS_BOX)
      element.style[key] = `${(box as Record<(typeof OUTPUTS_BOX)[number], number>)[key]}px`;
  return valid;
}

/**
 * The holes the player leaves for this page's buttons: `box` in its top bar for Cast and AirPlay, `fullscreen` at its
 * own fullscreen button in its dock. Null while the player's controls are hidden.
 */
function placeOutputs(box: unknown, fullscreen: unknown): void {
  // As the player's Cast button (`html.button`) this page is the button and nothing else: there is no hole to fill.
  if (!document.documentElement.classList.contains('driven')) return;
  outputsSlotted = placeIn(outputs, box);
  outputs.hidden = !outputsSlotted;
  fullscreenSlotted = placeIn(fullscreenButton, fullscreen);
  fullscreenButton.hidden = !fullscreenSlotted || !videoFullscreenOnly;
}

/** Text over the video only when it says something the picture does not: casting, an error. Otherwise nothing. */
function setStatus(text: string): void {
  statusPill.textContent = text ? translateStatus(text) : '';
  statusPill.hidden = !statusShown(text);
}
function translateStatus(source: string): string {
  if (source.startsWith('Casting to '))
    return interfaceLanguage === 'es'
      ? `Transmitiendo a ${source.slice('Casting to '.length)}`
      : interfaceLanguage === 'sv'
        ? `Castar till ${source.slice('Casting to '.length)}`
        : source;
  return text(source);
}
const parents = parentOrigins(import.meta.env.VITE_DEN_PARENT_ORIGINS ?? DEFAULT_PARENT_ORIGINS);
let parentOrigin: string | undefined;
let current: LoadMessage | undefined;
/** The exact load whose media currently owns local/receiver events, even while a replacement is pending. */
let playingLoad: LoadMessage | undefined;
/** The exact local load waiting for a gesture in this document. */
let blockedLocalLoad: LoadMessage | undefined;
let hls: Hls | undefined;
let castContext: CastContext | undefined;
let remotePlayer: RemotePlayer | undefined;
let remoteController: RemotePlayerController | undefined;
let castStarted = false;
/** Whether a receiver is on the network, once the SDK has said; undefined before that. */
let castDevices: boolean | undefined;
/**
 * A LOAD sent and not yet answered. The media it replaces keeps reporting meanwhile, and one of its progress ticks
 * must not end replacement state before that media's own INTERRUPTED arrives: read as a stop, it ended the session.
 */
let receiverLoadAttempt: { load: LoadMessage; replacing: boolean; settled?: boolean } | undefined;
/** The last LOAD whose sender promise succeeded, even if a newer load had already retired its authority. */
let receiverLandedLoad: LoadMessage | undefined;
let castSubtitleAppliedLoad: LoadMessage | undefined;
let measuredLoad: LoadMessage | undefined;
interface LocalPlayback {
  load: LoadMessage;
  owner: PlayingMedia;
  watcher?: Watcher;
  hls?: Hls;
  link?: Link;
  linkWatch?: ReturnType<typeof setInterval>;
  loadedMetadata?: () => void;
  timeUpdate?: () => void;
  ended?: () => void;
  error?: () => void;
}
/** Every callback and resource belonging to the exact local LOAD generation. */
let localPlayback: LocalPlayback | undefined;
/** Said over the held picture while the connection is down and the buffer has run out. */
const RECONNECTING = 'Reconnecting…';
/**
 * The playlist of the session this page plays, or hands to a receiver: where its failures are reported and its end is
 * sent. The player outside can't do either for a session on the public address — its page may not connect there.
 */
let playing: PlayingMedia | undefined;
let lastPosition = 0;
let lastDuration = 0;
let naturallyFinished = false;
/** How long a measured load waits for the player to say play on, before it plays on regardless. */
const CONTINUE_WAIT_MS = 5_000;
/** The measured load waiting for the player's `den-continue`. */
let waiting: { load: LoadMessage; resolve: () => void } | undefined;
/** Exact loads whose home-network address answered; a reused playlist URL is not replacement authority. */
const onLan = new WeakSet<LoadMessage>();

function playUrl(load: LoadMessage): string {
  return load.media.lanUrl && onLan.has(load) ? load.media.lanUrl : load.media.url;
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
  window.parent.postMessage(
    { type, id: current.id, generation: current.generation, ...fields },
    parentOrigin,
  );
}

function tellFor(
  load: LoadMessage | undefined,
  type: string,
  fields: Record<string, unknown> = {},
): void {
  if (!parentOrigin || !load) return;
  window.parent.postMessage(
    { type, id: load.id, generation: load.generation, ...fields },
    parentOrigin,
  );
}

const exactLoad = (
  id: unknown,
  generation: unknown,
  load: LoadMessage | undefined = playingLoad,
): load is LoadMessage => !!load && id === load.id && generation === load.generation;

const ownsCurrent = (load: LoadMessage | undefined): load is LoadMessage => current === load;
const ownsLocal = (owner: LocalPlayback): boolean =>
  localPlayback === owner &&
  current === owner.load &&
  playingLoad === owner.load &&
  playing === owner.owner &&
  !castStarted;

function clearLocalPlay(load?: LoadMessage): void {
  if (load && blockedLocalLoad !== load) return;
  blockedLocalLoad = undefined;
  localPlayButton.hidden = true;
}

function offerLocalPlay(load: LoadMessage): void {
  if (!ownsCurrent(load)) return;
  blockedLocalLoad = load;
  localPlayButton.hidden = false;
  localPlayButton.focus({ preventScroll: true });
}

/** A message about the Cast button itself, which the player needs before anything is loaded here. */
function say(type: string, fields: Record<string, unknown> = {}): void {
  if (!parentOrigin) return;
  window.parent.postMessage({ type, id: current?.id, ...fields }, parentOrigin);
}

// Pointer events stop at an iframe boundary. Without forwarding activity, the player's chrome could hide while the
// Cast page was under the pointer and then never return: the invisible parent controls could not receive the move
// that should reveal them. Keep this deliberately coarse; it is a presence signal, not pointer telemetry.
let lastPointerActivity = 0;
window.addEventListener(
  'pointermove',
  () => {
    const now = performance.now();
    if (now - lastPointerActivity < 250) return;
    lastPointerActivity = now;
    say('den-activity');
  },
  { passive: true },
);

function failFor(
  load: LoadMessage,
  message: string,
  code = 0,
  owner: PlayingMedia | undefined = playing,
  ownerWatcher?: Watcher,
  failure?: 'engine',
): void {
  const lifecycle = denLifecycleMedia(owner);
  if (lifecycle) {
    ownerWatcher?.spent();
    sendReport(reportUrlOf(lifecycle), reportBody(code, message));
  }
  tellFor(load, 'den-error', {
    message: translateStatus(message),
    code,
    ...(failure ? { failure } : {}),
  });
}

/** End the session this page played, so it stops holding den-remux and the media listener open. */
function endPlaying(): void {
  const ended = playing;
  playing = undefined;
  playingLoad = undefined;
  endMedia(ended);
}

/**
 * End a session this page played, at den-remux, with where it got to (`lastPosition`) when it carries a receipt.
 * `after` is the session's last report (`stopLocal`): den-remux answers a report for an ended session 410, so the end
 * goes once that was answered. Not for a page that is going away, which has no time to wait.
 */
function endMedia(media: PlayingMedia | undefined, after?: Promise<void>): void {
  const lifecycle = denLifecycleMedia(media);
  if (!lifecycle) return;
  const base = lifecycle.replace(/\/master\.m3u8$/, '');
  const receipt = /\/den\/_receipt\/[A-Za-z0-9_-]{43}$/.test(new URL(base).pathname);
  const target = receipt ? `${base}/end` : base;
  const init: RequestInit = receipt
    ? {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionSeconds: Math.max(0, Math.round(lastPosition)),
          durationSeconds: Math.max(1, Math.round(lastDuration)),
          completed: naturallyFinished,
        }),
        keepalive: true,
      }
    : { method: 'DELETE', keepalive: true };
  const send = () =>
    void fetch(target, init).catch((error: unknown) =>
      // It ends on its own once idle; this only says why it lingered.
      console.warn('ending the session failed:', error),
    );
  if (after) void after.then(send);
  else send();
}

/**
 * Tell the player where Cast stands: whether a Chromecast is discoverable, connecting or connected, and to which. Also
 * before anything is loaded here: the player shows this page's Cast button only while one is on the network, and its
 * own video plays on until a receiver is chosen.
 */
function announceDevices(): void {
  renderButton();
  if (castDevices === undefined || !parentOrigin) return;
  window.parent.postMessage(
    {
      type: 'den-cast-state',
      id: current?.id,
      available: castDevices,
      state: castState ?? 'NO_DEVICES_AVAILABLE',
      device: castState === 'CONNECTED' ? deviceName() : undefined,
    },
    parentOrigin,
  );
}

const PROGRESS_EVENTS = ['timeupdate', 'play', 'pause', 'volumechange'] as const;

/** Stop this page's hls.js and the connection it was watching. Settles when its last report was answered. */
function stopLocal(): Promise<void> {
  clearLocalPlay();
  const owner = localPlayback;
  localPlayback = undefined;
  if (owner?.loadedMetadata) video.removeEventListener('loadedmetadata', owner.loadedMetadata);
  if (owner?.timeUpdate)
    for (const type of PROGRESS_EVENTS) video.removeEventListener(type, owner.timeUpdate);
  if (owner?.ended) video.removeEventListener('ended', owner.ended);
  if (owner?.error) video.removeEventListener('error', owner.error);
  const reported = owner?.watcher?.stop() ?? Promise.resolve();
  owner?.hls?.destroy();
  if (hls === owner?.hls) hls = undefined;
  clearInterval(owner?.linkWatch);
  owner?.link?.dispose();
  if (statusPill.textContent === text(RECONNECTING)) setStatus('');
  return reported;
}

/** Fail only the local player generation that caught this engine exception. */
function failLocalEngine(owner: LocalPlayback, error: unknown): void {
  if (!ownsLocal(owner)) return;
  reportMediaEngineFailure('hls.js', 'startup', error);
  setStatus('Playback failed');
  failFor(owner.load, 'Playback failed', 0, owner.owner, owner.watcher, 'engine');
  stopLocal();
}

/**
 * A connection that went away is waited out (`resumingLoader`): "Reconnecting…" once the buffer runs out, the
 * player outside asked to let this browser's address back in (it may have changed, and only that page can say so),
 * and playback carried on from the same second when the segments come back.
 */
function watchLink(connection: Link, owner: LocalPlayback): void {
  const { load } = owner;
  const show = () => {
    if (!ownsLocal(owner)) return;
    const buffered = video.buffered;
    const ahead = buffered.length ? buffered.end(buffered.length - 1) - video.currentTime : 0;
    const shown = statusPill.textContent === text(RECONNECTING);
    if (connection.down && ahead < 0.5 && !shown) setStatus(RECONNECTING);
    else if ((!connection.down || ahead >= 0.5) && shown) setStatus('');
  };
  connection.beforeRetry = () => {
    if (ownsLocal(owner)) tellFor(load, 'den-reconnect');
    return Promise.resolve();
  };
  connection.subscribe((down) => {
    if (!ownsLocal(owner)) return;
    clearInterval(owner.linkWatch);
    show();
    if (down) owner.linkWatch = setInterval(show, 250);
  });
}

async function loadLocal(load: LoadMessage, url: string): Promise<void> {
  stopLocal();
  if (!ownsCurrent(load)) return;
  const media = load.media;
  playingLoad = load;
  video.removeAttribute('src');
  playing = {
    url,
    external: media.external === true,
    ...(!media.external && (media.lifecycleUrl || url !== media.url)
      ? { lifecycleUrl: media.lifecycleUrl ?? media.url }
      : {}),
  };
  lastPosition = Math.max(0, media.currentTime ?? 0);
  lastDuration = 0;
  naturallyFinished = false;
  const start = Math.max(0, media.currentTime ?? 0);
  // The player's own rule (`nativeHls`): Chrome claims HLS too, but hls.js plays there, and only hls.js rides out a
  // dropped connection with `resumingLoader`. hls.js is most of this page's script, and a page that is only the Cast
  // button never plays anything itself: it is fetched the first time this page does.
  const loading = playing;
  const local: LocalPlayback = (localPlayback = { load, owner: loading });
  let Hls: typeof import('hls.js').default | undefined;
  try {
    Hls = nativeHls(video) ? undefined : (await import('hls.js')).default;
  } catch (error) {
    failLocalEngine(local, error);
    return;
  }
  if (!ownsLocal(local)) return;
  local.timeUpdate = () => {
    if (!ownsLocal(local)) return;
    lastPosition = Math.max(0, video.currentTime);
    if (Number.isFinite(video.duration)) lastDuration = Math.max(0, video.duration);
    tellFor(load, 'den-progress', {
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : undefined,
      paused: video.paused,
      volume: video.volume,
      muted: video.muted,
    });
  };
  local.ended = () => {
    if (!ownsLocal(local)) return;
    naturallyFinished = true;
    tellFor(load, 'den-ended');
  };
  local.error = () => {
    if (!ownsLocal(local)) return;
    clearLocalPlay(load);
    failFor(
      load,
      video.error?.message || 'Playback failed',
      video.error?.code ?? 0,
      loading,
      local.watcher,
    );
  };
  // The player's transport shows what this video does: a pause, a play or a volume change is reported at once, not at
  // the next `timeupdate`.
  for (const type of PROGRESS_EVENTS) video.addEventListener(type, local.timeUpdate);
  video.addEventListener('ended', local.ended);
  video.addEventListener('error', local.error);
  let hlsSupported: boolean;
  try {
    hlsSupported = Hls?.isSupported() ?? false;
  } catch (error) {
    failLocalEngine(local, error);
    return;
  }
  if (!Hls) {
    video.src = url;
    local.watcher = watchPlayback({
      video,
      reportUrl: media.external ? undefined : reportUrlOf(url),
    });
    // A native player takes a start position once it knows the stream; set before that it is ignored.
    local.loadedMetadata = () => {
      if (!ownsLocal(local)) return;
      if (start > 0 && Math.abs(video.currentTime - start) > 2) video.currentTime = start;
      applySubtitle(media.subtitleLanguage, media.subtitleIndex);
    };
    video.addEventListener('loadedmetadata', local.loadedMetadata, { once: true });
  } else if (hlsSupported) {
    try {
      // The same tolerance as the player outside: a release den-remux converts answers its first segment late.
      const connection = (local.link = new Link());
      watchLink(connection, local);
      const instance = new Hls(hlsConfig(start > 0 ? start : undefined, 'receiver', connection));
      local.hls = instance;
      hls = instance;
      local.watcher = watchPlayback({
        video,
        hls: { instance, Hls },
        reportUrl: media.external ? undefined : reportUrlOf(url),
      });
      let recovered = false;
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!ownsLocal(local)) return;
        if (data.frag?.type === 'subtitle')
          console.warn(
            `[Den subtitles] ${JSON.stringify({
              event: 'cast-page-hls-error',
              details: data.details,
              fatal: data.fatal,
              httpStatus: data.response?.code ?? null,
              track: instance.subtitleTrack ?? null,
            })}`,
          );
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          // A decoder that lost its place: reset the buffer and carry on, once.
          recovered = true;
          instance.recoverMediaError();
          return;
        }
        // The session ended at den-remux (410), or the connection stayed away until the loader stopped asking: the
        // player outside offers to pick up where this was, rather than taking it for a release that won't play.
        const code = data.response?.code;
        if (
          data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR &&
          (code === 410 || (code === 0 && connection.down))
        ) {
          clearInterval(local.linkWatch);
          setStatus('');
          tellFor(load, 'den-lost', { currentTime: video.currentTime });
          return;
        }
        setStatus('Playback failed');
        failFor(load, `hls.js ${data.type} ${data.details}`, 0, loading, local.watcher);
      });
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (ownsLocal(local)) applySubtitle(media.subtitleLanguage, media.subtitleIndex);
      });
      instance.loadSource(url);
      instance.attachMedia(video);
    } catch (error) {
      failLocalEngine(local, error);
      return;
    }
  } else {
    if (!ownsLocal(local)) return;
    const message = 'This browser cannot play HLS';
    setStatus(message);
    failFor(load, message, 0, loading, local.watcher);
    return;
  }
  if (!ownsLocal(local)) return;
  describeToSystem(media);
  await playLocal(load);
}

/**
 * Start the media held by this exact parent load. A later load can replace `current` while WebKit is deciding the
 * promise, so neither its refusal nor its success may be published under the replacement's identity.
 */
async function playLocal(load: LoadMessage | null): Promise<void> {
  const local = localPlayback;
  if (!load || !local || local.load !== load || !ownsLocal(local)) return;
  try {
    await video.play();
    if (!ownsLocal(local)) return;
    clearLocalPlay(load);
    setStatus(PLAYING_HERE);
    tellFor(load, 'den-playing');
  } catch (error) {
    if (!ownsLocal(local)) return;
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      // Only a gesture in this cross-origin document can satisfy WebKit. Keep repeat refusals recoverable.
      offerLocalPlay(load);
      tellFor(load, 'den-autoplay-blocked');
      return;
    }
    clearLocalPlay(load);
    setStatus('Playback failed');
    failFor(load, 'Playback failed', 0, local.owner, local.watcher);
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

async function measure(load: LoadMessage): Promise<boolean> {
  const { media } = load;
  if (!media.measure || !media.speed || measuredLoad === load) return false;
  measuredLoad = load;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { limit, answered } = await signedLinkLimit(media.speed);
    if (!ownsCurrent(load)) return false;
    // Nothing answered on the public address: the session's playlist is on the same listener and would stall the
    // same way. The player outside decides what to do (`den-unreached`); a second probe would only wait again.
    if (!answered) {
      tellFor(load, 'den-unreached');
      return false;
    }
    const maxBitrate = usableLinkLimit(limit);
    if (maxBitrate) {
      tellFor(load, 'den-speed', { maxBitrate });
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

async function loadCast(load: LoadMessage | undefined = current): Promise<void> {
  if (!load) return;
  const session = castContext?.getCurrentSession();
  const media = load.media;
  const chrome = window.chrome?.cast;
  if (!session || !chrome) return;
  if (media.mode !== 'cast') {
    tellFor(load, 'den-cast-request', asking());
    return;
  }
  const url = playUrl(load);
  const requested = {
    url,
    external: media.external === true,
    ...(!media.external && (media.lifecycleUrl || url !== media.url)
      ? { lifecycleUrl: media.lifecycleUrl ?? media.url }
      : {}),
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
  request.customData = {
    interfaceLanguage: media.interfaceLanguage ?? 'en',
    denLoad: { id: load.id, generation: load.generation },
  };
  // An out-of-band VTT is known now; HLS renditions are discovered by the receiver and selected after LOAD.
  request.activeTrackIds =
    media.subtitleLanguage && validSubtitleTrack(media.subtitleTrack) ? [1] : [];
  const attempt: NonNullable<typeof receiverLoadAttempt> = {
    load,
    replacing: castStarted,
  };
  receiverLoadAttempt = attempt;
  try {
    await session.loadMedia(request);
    receiverLandedLoad = load;
    // Overlapping LOAD promises may settle out of order. A stale completion has no authority to publish ownership,
    // end the accepted media, or clear a newer attempt. If it landed on the receiver last, reassert the current load.
    if (!ownsCurrent(load) || receiverLoadAttempt !== attempt) {
      if (receiverLoadAttempt === attempt) receiverLoadAttempt = undefined;
      const currentAttemptOwns = receiverLoadAttempt?.load === current;
      const acceptedCurrentOwns = castStarted && playingLoad === current;
      if (!currentAttemptOwns && !acceptedCurrentOwns) {
        // The current LOAD has already failed or been retired. This late success is now the TV's only load, but no
        // live Den authority owns it; stop it rather than retrying a rejected current load or leaving stale media up.
        castStarted = false;
        castContext?.endCurrentSession(true);
      } else if (!currentAttemptOwns || receiverLoadAttempt?.settled === true) {
        void loadCast(current);
      }
      return;
    }
    // A LOAD replaces the receiver only once it succeeds. Until then its events and lifecycle still belong to
    // the previous media, even though `current` already describes the requested replacement.
    const replaced = playing;
    playing = requested;
    playingLoad = load;
    // The receiver plays a session of its own now. A Den Remux session played before it (this page's video, or the
    // receiver's previous media) would hold its den-remux slot until it idled out: nothing else ends it, and casting
    // over, the player asks for a new session rather than resuming that one. A TorBox stream is left alone: its
    // session belongs to the player outside, and ending it can remove the torrent the receiver now plays.
    if (
      replaced &&
      !replaced.external &&
      denLifecycleMedia(replaced) !== denLifecycleMedia(requested)
    ) {
      endMedia(replaced, castStarted ? undefined : stopLocal());
    }
    castStarted = true;
    attempt.settled = true;
    castSubtitleAppliedLoad = applyCastSubtitle(media.subtitleLanguage, media.subtitleIndex)
      ? load
      : undefined;
    setStatus(castingTo(session.getCastDevice?.().friendlyName));
    video.pause();
    tellFor(load, 'den-cast', {
      state: 'playing',
      profile: asking().profile,
      device: deviceName(),
    });
  } catch {
    const ownsAttempt = receiverLoadAttempt === attempt;
    if (ownsAttempt) receiverLoadAttempt = undefined;
    if (!ownsCurrent(load) || !ownsAttempt) return;
    castStarted = false;
    // Every rejected LOAD sent while a receiver was already playing retires sender ownership, including a
    // same-id/generation reload used to attach a newly staged external subtitle. An older overlapping LOAD can also
    // succeed while this exact replacement is pending. In either case stop the TV before reporting failure instead
    // of returning playback local while the prior or stale receiver picture continues without active ownership.
    const stoppedUnownedReceiver =
      attempt.replacing || (receiverLandedLoad !== undefined && receiverLandedLoad !== playingLoad);
    if (stoppedUnownedReceiver) castContext?.endCurrentSession(true);
    // An initial LOAD failure leaves the Cast session for the player to decide what is tried next. A failed
    // replacement cannot: it demonstrably leaves retired media on the receiver, so that session is stopped.
    const message = 'Chromecast could not load this release';
    setStatus(message);
    failFor(load, message, 0, requested);
  }
}

/**
 * Wait for the player to say play on after a measure (`den-continue`), or to replace this load with a session that
 * fits the link. A player that says neither within CONTINUE_WAIT_MS is played on regardless.
 */
function continued(load: LoadMessage): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CONTINUE_WAIT_MS);
    waiting = {
      load,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    };
  });
}

function releaseWaiting(): void {
  const held = waiting;
  waiting = undefined;
  held?.resolve();
}

async function open(message: LoadMessage): Promise<void> {
  // Google permits a secure Web Sender to hand an HTTP media URL to its receiver. Do not fetch that URL from this
  // HTTPS iframe: the parent already proved the local route and holds Chrome's Local Network Access permission.
  if (
    lanHttpMedia(message.media.url) ||
    lanHttpMedia(message.media.lanUrl ?? '') ||
    (message.media.mode === 'cast' && message.media.lanProven === true && message.media.lanUrl)
  ) {
    onLan.add(message);
    if (ownsCurrent(message)) tellFor(message, 'den-lan');
  }
  // Home first: on home Wi-Fi the router never loops a request for the public address back in, so only the
  // home-network address can play. Anywhere else this fails fast and the public address is used as before.
  if (!onLan.has(message) && (await lanReachable(message.media.lanUrl))) {
    if (!ownsCurrent(message)) return;
    onLan.add(message);
    // A link limit the player remembered from away doesn't belong here.
    if (ownsCurrent(message)) tellFor(message, 'den-lan');
  }
  if (!ownsCurrent(message)) return;
  // No home upload sits between this browser and den-remux on the LAN, so there is no link to measure.
  const measured = onLan.has(message) ? false : await measure(message);
  if (measured) await continued(message);
  if (!ownsCurrent(message)) return;
  // A receiver already chosen (the player's offer, `den-choose`) takes the load; asked for in browser mode, `loadCast`
  // has the player ask again for what this receiver plays.
  if (message.media.mode === 'cast' || castContext?.getCurrentSession()) await loadCast(message);
  else await loadLocal(message, playUrl(message));
  if (ownsCurrent(message))
    applySubtitle(message.media.subtitleLanguage, message.media.subtitleIndex);
}

/** Starts the Cast framework; false when the SDK loaded without the framework or the chrome.cast API. */
function initializeCast(): boolean {
  const cast = window.cast?.framework;
  const chrome = window.chrome?.cast;
  if (!cast || !chrome) return false;
  castContext = cast.CastContext.getInstance();
  castState = castContext.getCastState();
  castDevices = castState !== 'NO_DEVICES_AVAILABLE';
  castContext.addEventListener(cast.CastContextEventType.CAST_STATE_CHANGED, (event) => {
    castState = (event as { castState?: string }).castState ?? castState;
    castDevices = castState !== 'NO_DEVICES_AVAILABLE';
    logCastState();
    announceDevices();
  });
  remotePlayer = new cast.RemotePlayer();
  const controller = new cast.RemotePlayerController(remotePlayer);
  remoteController = controller;
  controller.addEventListener(cast.RemotePlayerEventType.ANY_CHANGE, () => {
    if (!castStarted || !remotePlayer) return;
    lastPosition = Math.max(0, remotePlayer.currentTime);
    lastDuration = Math.max(0, remotePlayer.duration);
    tellFor(playingLoad, 'den-progress', {
      currentTime: remotePlayer.currentTime,
      duration: remotePlayer.duration,
      paused: remotePlayer.isPaused,
      volume: remotePlayer.volumeLevel,
      muted: remotePlayer.isMuted,
    });
    if (remotePlayer.playerState !== 'IDLE') {
      if (receiverLoadAttempt?.settled) receiverLoadAttempt = undefined;
      if (
        playingLoad &&
        castSubtitleAppliedLoad !== playingLoad &&
        applyCastSubtitle(playingLoad.media.subtitleLanguage, playingLoad.media.subtitleIndex)
      )
        castSubtitleAppliedLoad = playingLoad;
      return;
    }
    const reason = castContext?.getCurrentSession()?.getMediaSession()?.idleReason;
    const action = castIdleAction(reason, receiverLoadAttempt?.replacing === true);
    // The receiver's own words, for the console a viewer can share: what it said is what decides the session's end.
    console.info(
      `[Den cast] ${JSON.stringify({ event: 'receiver-idle', reason: reason ?? null, action })}`,
    );
    if (action === 'replaced' || action === 'pending') return;
    receiverLoadAttempt = undefined;
    castStarted = false;
    if (action === 'finished') {
      naturallyFinished = true;
      tellFor(playingLoad, 'den-ended');
    } else if (action === 'error') {
      if (playingLoad) failFor(playingLoad, 'Chromecast could not continue playback');
    } else {
      // CANCELLED means the media was stopped; an unrelated sender's LOAD is merely disconnected from.
      castContext?.endCurrentSession(reason !== 'INTERRUPTED');
      tellFor(playingLoad, 'den-cast', { state: 'stopped', reason });
    }
  });
  castContext.setOptions({
    receiverApplicationId: receiverApp ?? chrome.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    // Not ORIGIN_SCOPED: that re-joined any earlier Cast session for this origin on load, so opening a title on
    // the phone silently started streaming it to a TV. Casting begins only when the Cast button is pressed.
    autoJoinPolicy: chrome.AutoJoinPolicy.PAGE_SCOPED,
  });
  logCastState();
  castContext.addEventListener(cast.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    const state = (event as { sessionState?: string }).sessionState;
    if (state === 'SESSION_STARTED') {
      hearReceiverEvents(castContext?.getCurrentSession());
      // Den's receiver says what its TV plays before the player asks Hearth for anything: one ask, one LOAD.
      void learnReceiver(castContext?.getCurrentSession()).then(() => {
        if (!castContext?.getCurrentSession()) return;
        // Chosen from this page's button with nothing loaded yet: the player asks for what this receiver plays and
        // hands it here. Until then its own video plays on.
        if (!current)
          say('den-cast-session', { state: 'started', ...asking(), device: deviceName() });
        else void loadCast();
      });
    } else if (state === 'SESSION_ENDED') {
      receiverPlayable = undefined;
      receiverLandedLoad = undefined;
    }
    if (state === 'SESSION_ENDED' && castStarted) {
      console.info(`[Den cast] ${JSON.stringify({ event: 'receiver-session-ended' })}`);
      castStarted = false;
      receiverLoadAttempt = undefined;
      tellFor(playingLoad, 'den-cast', { state: 'stopped', reason: 'SESSION_ENDED' });
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

let castApiAnswered = false;
window.__onGCastApiAvailable = (available) => {
  if (castApiAnswered) return;
  castApiAnswered = true;
  if (!available) {
    castDevices = false;
    announceDevices();
    return;
  }
  // Only a browser with the Cast SDK has anything to cast from; elsewhere (Safari has AirPlay instead) the button stays
  // hidden. It also stays hidden while no receiver is on the network (`renderButton`).
  void castFrameworkLoaded().then((loaded) => {
    try {
      if (!loaded || !initializeCast())
        throw new Error('the Cast SDK loaded without its framework');
    } catch (error) {
      // A button that was never initialised does nothing, so it stays hidden; the console says why.
      console.error('Cast could not start:', error);
      castState = undefined;
      castDevices = false;
    }
    announceDevices();
  });
};
// The SDK calls the hook once, when it is ready. This module runs after the document is parsed, so a SDK that was
// already ready by then (from the cache) has called nothing: it is asked here instead.
if (window.chrome?.cast?.isAvailable) window.__onGCastApiAvailable(true);

/**
 * The button is the only press that can open Chrome's device list: user activation does not pass from the player into
 * this cross-origin page. Pressed while connected, the player shows its Cast menu instead (Stop casting).
 */
castButton.addEventListener('click', () => {
  if (castState === 'CONNECTED' || castState === 'CONNECTING') {
    say('den-cast-menu');
    return;
  }
  say('den-cast-press');
  castContext?.requestSession().catch((error: unknown) => {
    // Closing the list without choosing is no failure: the button stays, for another press.
    if (error === 'cancel') return;
    console.info('Cast session did not start:', error);
    say('den-cast-failed', { code: typeof error === 'string' ? error : 'session_error' });
  });
});
castButton.addEventListener('focus', () =>
  say('den-cast-focus', { focused: true, visible: castButton.matches(':focus-visible') }),
);
castButton.addEventListener('blur', () => say('den-cast-focus', { focused: false }));
castButton.addEventListener('pointerenter', () => say('den-cast-hover', { hover: true }));
castButton.addEventListener('pointerleave', () => say('den-cast-hover', { hover: false }));

localPlayButton.addEventListener('click', (event) => {
  const load = blockedLocalLoad;
  // A script-generated click is not the missing activation. `playLocal` reaches video.play() synchronously from this
  // trusted handler, before its first await, and retains the exact load across the resulting promise.
  if (!event.isTrusted || !load || !ownsCurrent(load)) return;
  void playLocal(load);
});
// As the player's control bar this page is one button: Tab moves on to the player's next control, not to the end of
// the player, where the frame sits in its document.
castButton.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !document.documentElement.classList.contains('button')) return;
  event.preventDefault();
  say('den-tab', { back: event.shiftKey });
});

let parentDocumentOrigin: string | undefined;
const authorizedParent = (event: MessageEvent<unknown>): boolean =>
  parentDocumentOrigin === event.origin &&
  parents.has(event.origin) &&
  event.source === window.parent;

// Readiness is a challenge for one loaded iframe document, not an origin-level announcement. The parent creates a
// new generation only from that iframe's `load` event; echoing it makes a delayed or queued message from an older
// same-origin document harmless without guessing event-loop order.
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  const message = event.data as { type?: string; generation?: unknown };
  if (
    message.type !== 'den-handshake' ||
    typeof message.generation !== 'string' ||
    message.generation.length < 1 ||
    message.generation.length > 96
  )
    return;
  parentDocumentOrigin = event.origin;
  event.source.postMessage(
    { type: 'den-ready', generation: message.generation },
    { targetOrigin: event.origin },
  );
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!authorizedParent(event)) return;
  const message = event.data as Partial<LoadMessage>;
  if (
    message.type !== 'den-load' ||
    typeof message.id !== 'string' ||
    !Number.isSafeInteger(message.generation) ||
    Number(message.generation) < 0 ||
    !message.media
  )
    return;
  applyInterfaceLanguage(message.media.interfaceLanguage);
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
    (message.media.subtitleTrack !== undefined && !validSubtitleTrack(message.media.subtitleTrack))
  ) {
    event.source?.postMessage(
      {
        type: 'den-error',
        id: message.id,
        generation: message.generation,
        message: text('Invalid media URL'),
      },
      {
        targetOrigin: event.origin,
      },
    );
    return;
  }
  parentOrigin = event.origin;
  if (current?.id === message.id && current.generation === message.generation) {
    const previousSubtitle = current.media.subtitleTrack?.url;
    current.media = message.media;
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
    castSubtitleAppliedLoad = undefined;
    if (
      castStarted &&
      applyCastSubtitle(current.media.subtitleLanguage, current.media.subtitleIndex)
    )
      castSubtitleAppliedLoad = current;
    return;
  }
  clearLocalPlay();
  current = message as LoadMessage;
  releaseWaiting();
  document.title = current.media.title;
  setStatus('');
  void open(current);
  // The SDK may have answered before this load arrived: say what it found now that there is a player to tell.
  announceDevices();
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!authorizedParent(event) || !current) return;
  const message = event.data as {
    type?: string;
    id?: string;
    generation?: number;
    language?: unknown;
    track?: Media['subtitleTrack'];
  };
  if (
    message.type !== 'den-subtitle' ||
    message.id !== current.id ||
    message.generation !== current.generation
  )
    return;
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
  castSubtitleAppliedLoad = undefined;
  if (castStarted && applyCastSubtitle(current.media.subtitleLanguage, current.media.subtitleIndex))
    castSubtitleAppliedLoad = current;
});

/** The player asks whether a receiver is on the network, with nothing to load yet. */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!authorizedParent(event)) return;
  const message = event.data as { type?: string; interfaceLanguage?: unknown };
  if (message.type !== 'den-discover') return;
  applyInterfaceLanguage(message.interfaceLanguage);
  parentOrigin = event.origin;
  announceDevices();
});

/**
 * The player's side of Cast: how this page is laid out (only the Cast button, in the player's control bar, or the
 * whole picture where this page plays the session itself), and what Den's transport asks of the receiver.
 */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!authorizedParent(event)) return;
  const message = event.data as {
    type?: string;
    id?: unknown;
    generation?: unknown;
    layout?: unknown;
    transport?: unknown;
    box?: unknown;
    fullscreen?: unknown;
    color?: unknown;
    iconSize?: unknown;
    profile?: unknown;
    level?: unknown;
    muted?: unknown;
  };
  const root = document.documentElement;
  if (message.type === 'den-layout') {
    parentOrigin = event.origin;
    root.classList.toggle('button', message.layout === 'button');
    // Playing here, the video has native controls only for a player that draws no transport of its own over it (one
    // from before `transport`). With the player's, they would be a second set of controls under it.
    const driven = message.layout === 'stage' && message.transport === true;
    root.classList.toggle('driven', driven);
    video.controls = message.layout === 'stage' && !driven;
    outputs.hidden = driven && !outputsSlotted;
    // As the player's Cast button there is no hole: the place it was given away from home goes with it.
    if (!driven) {
      outputsSlotted = fullscreenSlotted = false;
      outputs.removeAttribute('style');
      fullscreenButton.removeAttribute('style');
    }
    renderOutputs();
    // The player's own button colour and glyph size, so the glyph drawn here is the one beside it.
    if (typeof message.color === 'string' && CSS.supports('color', message.color))
      root.style.setProperty('--cast-fg', message.color);
    if (typeof message.iconSize === 'number' && message.iconSize >= 12 && message.iconSize <= 48)
      root.style.setProperty('--cast-icon', `${message.iconSize}px`);
  } else if (message.type === 'den-outputs-slot') {
    placeOutputs(message.box, message.fullscreen);
  } else if (message.type === 'den-focus') {
    castButton.focus();
  } else if (message.type === 'den-stop') {
    castContext?.endCurrentSession(true);
  } else if (message.type === 'den-play' || message.type === 'den-pause') {
    const pause = message.type === 'den-pause';
    if (!current || message.id !== current.id || message.generation !== current.generation) return;
    if (castStarted && remotePlayer && remoteController && remotePlayer.isPaused !== pause)
      remoteController.playOrPause();
    else if (!castStarted && pause) video.pause();
    else if (!castStarted && !blockedLocalLoad && video.paused) void playLocal(current);
  } else if (message.type === 'den-volume') {
    if (!current || message.id !== current.id || message.generation !== current.generation) return;
    const level =
      typeof message.level === 'number' && message.level >= 0 && message.level <= 1
        ? message.level
        : undefined;
    const muted = typeof message.muted === 'boolean' ? message.muted : undefined;
    if (castStarted && remotePlayer && remoteController) {
      if (level !== undefined) {
        remotePlayer.volumeLevel = level;
        remoteController.setVolumeLevel();
      }
      if (muted !== undefined && muted !== remotePlayer.isMuted) remoteController.muteOrUnmute();
    } else if (!castStarted) {
      // This page's own video, which the player's transport drives away from home.
      if (level !== undefined) video.volume = level;
      if (muted !== undefined) video.muted = muted;
    }
  } else if (message.type === 'den-profile') {
    if (typeof message.profile !== 'string' || !PROFILES.includes(message.profile)) return;
    profile = message.profile;
    keepProfile(profile);
    if (castContext?.getCurrentSession()) tell('den-cast-request', asking());
  } else if (message.type === 'den-reset') {
    if (!current || message.id !== current.id || message.generation !== current.generation) return;
    // The player has gone back to playing in its own page and keeps this one for its Cast button: what was loaded
    // here is let go as a hidden page would let it go (`pagehide`).
    stopLocal();
    video.removeAttribute('src');
    if (!castStarted) endPlaying();
    current = undefined;
    releaseWaiting();
    setStatus('');
  }
});

/** The player kept the measured session: play it. */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!authorizedParent(event)) return;
  const message = event.data as { type?: string; id?: string; generation?: number };
  const held = waiting;
  if (
    message.type !== 'den-continue' ||
    !held ||
    message.id !== held.load.id ||
    message.generation !== held.load.generation
  )
    return;
  waiting = undefined;
  held.resolve();
});

// The player outside removes this frame when its session ends — closed, restarted, or replaced — and that is this
// page's hide. The last report goes first, then the end; a receiver still fetches on its own, so its session is left.
window.addEventListener('pagehide', () => {
  current = undefined;
  releaseWaiting();
  stopLocal();
  if (!castStarted) endPlaying();
});

/** The outside player's Skip button: move this page's video, or the receiver it is casting to, to `time`. */
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!authorizedParent(event) || !current) return;
  const message = event.data as {
    type?: string;
    id?: string;
    generation?: number;
    time?: unknown;
  };
  if (
    message.type !== 'den-seek' ||
    message.id !== current.id ||
    message.generation !== current.generation
  )
    return;
  if (typeof message.time !== 'number' || !Number.isFinite(message.time) || message.time < 0)
    return;
  if (castStarted && remotePlayer && remoteController) {
    remotePlayer.currentTime = message.time;
    remoteController.seek();
  } else {
    video.currentTime = message.time;
  }
});
