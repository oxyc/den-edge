<!-- Playback in this browser through den-remux: the title's release as HLS, played natively where the browser can
     (Safari, and so AirPlay) and through hls.js elsewhere. Den's own transport drives it in every browser, with the
     bar beside it carrying what Den adds — the audio language, the next episode, and waiting for a free slot. Starts
     where the library says, and reports where it got to every 30 seconds, on pause, when the page is hidden and on
     close.
     The lock screen and the system's media controls name the title and move it too. -->
<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import { withAiring } from '../lib/airing';
  import { airingStore } from '../lib/airing.svelte';
  import type Hls from 'hls.js';
  import { tick as renderTick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { WATCHED } from '../lib/actions';
  import {
    canOfferCast,
    CAST_PLAY_MS,
    castFailureNotice,
    castStateOf,
    fetchCastOrigin,
    returnsFromCast,
    type CastState,
  } from '../lib/castOffer';
  import { castReceiverOptIn, playableOf } from '../lib/castReceiver';
  import { guestGrants } from '../lib/grants.svelte';
  import { hlsConfig } from '../lib/hlsConfig';
  import { retryWithoutHint } from '../lib/ipv4';
  import type { Title } from '../lib/library';
  import { interfaceLocale, type InterfaceLanguage } from '../lib/interfaceLanguage';
  import type { Episode as EpisodeDetail } from '../lib/detail';
  import { PLAYBACK_PROGRESS_SAVE_MS, PlaybackProgressReporter } from '../lib/playbackProgress';
  import { playable, withoutRefused, type Playable } from '../lib/playable';
  import {
    autoSubtitleLanguage,
    preferredSubtitleTrack,
    subtitleLanguagesMatch,
    visibleSubtitleTracks,
    downmixLabel,
    nativeHls,
    endSession,
    guestLimits,
    estimateToLink,
    linkLimit,
    listReleases,
    playedSession,
    login,
    reassertGrant,
    relayLimit,
    releaseParts,
    rememberLink,
    reportFailure,
    routeKind,
    segmentAnswer,
    sendHeartbeat,
    startSession,
    wantedLanguages,
    type AudioTrack,
    type Failure,
    type Release,
    type Session,
    type Want,
    videoCodecsOf,
  } from '../lib/remux';
  import {
    knownCodec,
    parseServerTiming,
    sendStartupReport,
    sizeBucket,
  } from '../lib/startupReport';
  import {
    autoSwitchedNotice,
    autoSwitchNotice,
    deliveryUnchangedNotice,
    nothingFits,
    optionLabel,
    pickLabel,
    releaseAfterMeasure,
    restartAfterMeasure,
    swapNotice,
    unchangedNotice,
  } from '../lib/releaseVerdicts';
  import {
    aheadIn,
    playedSecondsOf,
    reportUrlOf,
    watchPlayback,
    type Watcher,
  } from '../lib/playbackStats';
  import { Link, wasInterrupted } from '../lib/resumingLoader';
  import { stuckWatch } from '../lib/stuckWatch';
  import { countdownLabel, PrebufferHold } from '../lib/prebufferHold';
  import type { PlaybackReceiptPreparation } from '../lib/playbackReceiptSupport';
  import {
    bufferingWhilePlaying,
    startupNotice,
    type Progress as StartupProgress,
  } from '../lib/startupNotice';
  import {
    averageBitrate,
    bytesBetween,
    DeliveryMeter,
    scaleDemand,
    shouldSwitch,
    switchAsk,
    tooSlow,
    waitAt,
    type Delivery,
  } from '../lib/switchPolicy';
  import { recallReleases, rememberReleases } from '../lib/releaseMemory';
  import type { Addon } from '../lib/scout';
  import type { ContentServiceClientPort } from '../lib/contentServiceClient';
  import type { SamsungAvplayAdapter } from '../tv/player/avplay';
  import { setTvPlaybackActive } from '../tv/platform';
  import { startPlayback, type PlaybackCause, type PlaybackWant } from '../lib/playback';
  import { directRecovery } from '../lib/playbackRecovery';
  import { checkSubtitleResync, resyncSubtitle } from '../lib/subtitleResync';
  import type { MenuItem } from '../lib/titleActions';
  import {
    activeAt,
    canAutoSkip,
    fetchSkipSegments,
    SKIP_LABEL,
    type SkipKind,
    type SkipSegment,
  } from '../lib/skipdb';
  import { continuationPrefetch, shouldWarmNext } from '../lib/binge';
  import { fetchSourceList, prepareSource } from '../lib/titleSources';
  import type { Routes } from '../lib/routes';
  import { titleAllowed } from '../lib/playGuard';
  import { lanReachable, privateLanRemuxPlaylist } from '../lib/localNetwork';
  import { named } from '../lib/pageTitle';
  import { nameTab } from '../lib/tabName.svelte';
  import {
    hlsFatalFromMessage,
    identityOf,
    reportClientFailure,
    reportableLanguage,
    replaceClientFailureGeneration,
    sendCastReport,
    sendPlaybackOutcome,
    sendPlaybackRoute,
    subtitleSourceOf,
    type CastFailReason,
    type CastStage,
    type Engine,
    type FailSource,
    type PlaybackRouteFailure,
    type PlaybackRouteReport,
    type SwitchReason,
  } from '../lib/diagnosticsReport';
  import ActionMenu from './ActionMenu.svelte';
  import Button from './Button.svelte';
  import ButtonIcon from './ButtonIcon.svelte';
  import { titleHref } from '../lib/route';
  import { activateLinkInPlace } from '../lib/linkActivation';

  let {
    title,
    season,
    episode,
    filename,
    content,
    scout,
    routes = {},
    remux,
    playback,
    subtitles,
    audioLanguage,
    interfaceLanguage = 'en',
    subtitleLanguage,
    shownSubtitleLanguages,
    maxSubtitlesPerLanguage = 3,
    autoSkip = false,
    resume,
    next,
    nextEpisode,
    castPlayMs = CAST_PLAY_MS,
    onprogress,
    onfinalprogress,
    onmanagedplayback,
    playbackReceiptHandoffAsOwner,
    onplaybackreceipthandoff,
    onnext,
    onclose,
    oncontrols,
  }: {
    title: Title;
    season?: number;
    episode?: number;
    filename?: string;
    content: ContentServiceClientPort;
    scout: Addon;
    /** Live service routes, used to validate the next episode's same-origin Scout play ticket. */
    routes?: Routes;
    /** Where den-remux answers (`findRemux`): '' for this origin, else the tailnet's address. */
    remux: string;
    /** Hearth's unified operation; absent unless its configured route passed live capability discovery. */
    playback?: string;
    /** The library's other LAN addons: den-subtitles is among them. */
    subtitles: string[];
    /** Settings › Playback's audio language (ISO 639-1); undefined is each title's original language. */
    audioLanguage?: string;
    /** Active profile presentation language, used by Automatic subtitles and forwarded to Cast. */
    interfaceLanguage?: InterfaceLanguage;
    /** Its subtitle language; undefined is Automatic, null is explicit Off. */
    subtitleLanguage?: string | null;
    /** Settings › Content's visible subtitle languages, offered in the picker beside the chosen one. */
    shownSubtitleLanguages?: readonly string[];
    /** Settings › Content's OpenSubtitles rows per language. Zero means all; built-in tracks are never capped. */
    maxSubtitlesPerLanguage?: number;
    /** Settings › Playback's "Auto-skip intros & credits". A Skip button shows either way. */
    autoSkip?: boolean;
    /** Where the library says this was left. */
    resume: { fraction: number; seconds?: number };
    /** The episode after this one, as `S2 · E4`, when there is one. */
    next?: string;
    /** That episode's own numbers, so it can be warmed before the advance (`shouldWarmNext`). */
    nextEpisode?: { season?: number; episode?: number };
    /** Timer seam for the browser fixture; the app always uses the production default. */
    castPlayMs?: number;
    /** Where playback got to, and the episode that is about: one advanced to in place reports as itself. */
    onprogress: (fraction: number, seconds: number, at: Episode, playing: boolean) => void;
    /** The visit's terminal position, retained by the library until its exact command is durable. */
    onfinalprogress: (fraction: number, seconds: number, at: Episode, playing: false) => void;
    /** Establish the household completion-receipt authority before the first managed playback intent crosses Edge. */
    onmanagedplayback?: (signal: AbortSignal) => Promise<PlaybackReceiptPreparation>;
    /** Whether the authorized recovery opens Connections directly or first switches to Owner. */
    playbackReceiptHandoffAsOwner: boolean;
    /** Leaves playback only after handing terminal progress to the host's durable recovery surface. */
    onplaybackreceipthandoff: () => void;
    onnext?: () => void;
    onclose: () => void;
    /** The TV shell's paired-inbox receiver installs these while this exact player is mounted. */
    oncontrols?: (
      controls: { play: () => void; pause: () => void; seekBy: (seconds: number) => void } | null,
    ) => void;
  } = $props();
  const nextHref = $derived(
    onnext && nextEpisode?.season !== undefined && nextEpisode.episode !== undefined
      ? titleHref({ ...title, ...nextEpisode, play: true })
      : undefined,
  );

  function advanceLink(event: MouseEvent) {
    if (!onnext) return;
    // Every explicit Next surface can coexist with the countdown. Retire it before changing episodes so a tick at
    // the same boundary cannot invoke `onnext` a second time.
    activateLinkInPlace(event, () => (stay(), onnext()));
  }

  type Episode = { season?: number; episode?: number };

  const REPORT_MS = PLAYBACK_PROGRESS_SAVE_MS;
  /** How often a paused viewer's "still here" goes out — comfortably under den-remux's own UNATTENDED_IDLE
   * (60s), with room for a missed beat, so a deliberate pause is told apart from a closed tab. */
  const HEARTBEAT_MS = 20_000;
  /** How long a video may go without a picture before it counts as one the browser can't play. */
  const STUCK_MS = 30_000;
  /**
   * How quickly den-remux answers for a segment it already has (`segmentAnswer`): slower, and it is still making it.
   * And how long that answer is waited for before the start is taken for a slow one.
   */
  const SEGMENT_READY_MS = 3_000;
  const SEGMENT_ASK_MS = 10_000;
  /**
   * How long a play head that nothing paused may stand still before it counts as a stall, and how far it has to move
   * to count as moving: WebKit nudges a stalled one back and forth by a millisecond.
   */
  const HEAD_STILL_MS = 1_000;
  const HEAD_MOVED_SECS = 0.1;
  /** How far from the asked-for second a native player may start and still count as there: it starts on a segment. */
  const START_SLACK_SECS = 10;
  /** How long before asking again while every slot, or the GPU, is taken — unless den-remux names its own. */
  const RETRY_MS = 20_000;
  /** How often, at most, den-edge is asked to let this browser's address back in while segments aren't arriving. */
  const REGRANT_MS = 15_000;
  /** Seconds of picture left ahead below which a connection that is down shows as "Reconnecting…". */
  const RECONNECT_AHEAD_SECS = 0.5;
  /** Seconds the next episode waits once this one has ended. */
  const UP_NEXT_SECS = 10;
  /** The step of the lock screen's and a headset's skip buttons, where they don't name one. */
  const SKIP_SECS = 10;
  const tv = __DEN_TV__;
  // The hosted webOS and Samsung shells share one ten-foot transport. Their decoders differ underneath (HTMLMedia
  // on LG, AVPlay on Samsung), but exposing that implementation detail in the controls made Samsung needlessly
  // second-class. Android retains its launcher-era strip until its native playback surface adopts this contract.
  const fullTvTransport = __DEN_TV_PLATFORM__ === 'webos' || __DEN_TV_PLATFORM__ === 'tizen';
  // Every browser gets Den's complete transport, and the video never carries native controls beside it: on a phone
  // as on a desktop, so its stream, audio, subtitle timing, play-from-beginning and skip are there too. Den draws the
  // routes the native controls used to own on a phone: PiP, AirPlay and, on an iPhone, Apple's fullscreen player.
  const webTransport = !tv;
  const customTransport = fullTvTransport || webTransport;
  // What the pointer is decides how the transport behaves, not whether it is drawn. A precise, hovering pointer
  // (mouse, trackpad) clicks the picture to pause and reveals the controls by moving; a touch screen alone taps the
  // picture to show or hide the controls and gets larger targets. It asks whether ANY pointer is fine rather than the
  // primary one: a touchscreen laptop (or an iPad with a trackpad) may report its touch screen as primary while a
  // trackpad or mouse is right there. It follows the device as it changes (a mouse plugged in, tablet mode).
  const desktopQuery = tv ? undefined : matchMedia('(any-hover: hover) and (any-pointer: fine)');
  let desktopTransport = $state(desktopQuery?.matches ?? false);
  $effect(() => {
    if (!desktopQuery) return;
    const follow = () => (desktopTransport = desktopQuery.matches);
    desktopQuery.addEventListener('change', follow);
    return () => desktopQuery.removeEventListener('change', follow);
  });
  /**
   * Where the player's menus open as a bottom sheet: a phone, upright or on its side. A tablet and every pointer window
   * get a popover beside the button that opened it. The layout itself follows the same widths in CSS.
   */
  const PHONE_SHEET = '(width < 33rem), (height < 32rem) and (pointer: coarse)';
  /** The kind of the last pointer pressed on the player: a tap on the picture shows or hides the controls. */
  let lastPointer = '';
  /** Whether the controls were showing when that press began. */
  let shownAtPress = true;
  /** A finger is dragging the timeline: the picture is left where it is until it lets go. */
  let scrubbing = false;
  // The production app's platform flag is also used by desktop preview builds. Only an actual LG user agent should
  // override an incomplete canPlayType answer; preview Chromium must retain the fully testable hls.js fallback.
  const webOsNative =
    __DEN_TV_PLATFORM__ === 'webos' && /(?:webOS|Web0S)/i.test(navigator.userAgent);
  // The packaged Samsung shell supplies this bridge. Hosted previews and ordinary browsers do not, and retain the
  // existing native-HLS/hls.js path even when they use the Tizen-targeted bundle.
  const samsungAvplay =
    __DEN_TV_PLATFORM__ === 'tizen' &&
    !!(globalThis as typeof globalThis & { webapis?: { avplay?: unknown } }).webapis?.avplay;
  const messages: Record<
    | 'none'
    | 'unreachable'
    | 'imdb'
    | 'unsupported'
    | 'playback'
    | 'source'
    | 'public'
    | 'ipv6'
    | 'cast'
    | 'noCopy'
    | 'noFit'
    | 'request'
    | 'sourceUnavailable'
    | 'protocol'
    | 'engine',
    string
  > = {
    public: 'Playback isn’t available from this network yet.',
    ...guestLimits,
    none: 'No release of this that plays in a browser is ready right now. Try again later, or play it on your TV.',
    unreachable:
      'Couldn’t reach Den’s player. Check this device’s connection, then try again. If it continues, ask your host to check Den Hearth.',
    request:
      'Den’s player couldn’t use this playback request. Refresh the page. If it continues, ask your host to update Den Hearth.',
    sourceUnavailable:
      'Den couldn’t prepare this release through its available playback paths. Try again. If it continues, check Den Hearth and the home player.',
    protocol:
      'Den’s player returned an answer this page can’t use. Refresh the page. If it continues, ask your host to update Den Hearth.',
    imdb: 'TMDB has no IMDb id for this, which Den’s sources need.',
    unsupported: 'This browser can’t play video streams.',
    playback: 'This browser couldn’t play this release. Try it on your TV.',
    // Deliberately not "couldn't play": the release stopped arriving, and playing it again usually works.
    source: 'This release stopped responding. Try it again, or pick another one.',
    noCopy: 'This can’t be played on this device right now. Try it on your TV.',
    noFit:
      'No release of this fits this connection as it is. Try it again on a faster one, or on your TV.',
    engine: 'Couldn’t load the player. Check the connection, then reload the page.',
  };
  /** Waiting on the playback coordinator, which is asked again after its Retry-After or RETRY_MS. */
  const waits: Record<
    'busy' | 'starting' | 'transcode' | 'timedOut' | 'temporarilyUnavailable',
    string
  > = {
    busy: 'Den is already playing as much as it can right now. Waiting for one to stop…',
    // Distinct from `busy`: this browser or install's own last attempt is still opening — nobody else's
    // slot to wait out, so this says so rather than naming an imaginary "two things".
    starting: 'Den is still finishing your last attempt at this. One moment…',
    transcode:
      'This needs converting for this browser, and the homelab is converting another. Waiting for it to finish…',
    timedOut:
      'Den’s player took too long to prepare this. Waiting before trying the provider and home player again…',
    temporarilyUnavailable:
      'Den’s player is temporarily unavailable. Waiting as requested before trying again…',
  };
  const managedCauseMessages: Record<PlaybackCause, string> = {
    torbox_authentication_failed:
      'Your TorBox API key was rejected. Update the key in Den Hearth settings, then try again.',
    torbox_managed_streaming_unavailable_for_plan:
      'Your TorBox plan doesn’t support streaming links. Update the TorBox plan or remove TorBox from this Den Hearth install.',
    torbox_rate_limited:
      'TorBox asked Den to wait before trying again. The home player could not prepare this release either, so Den is waiting as requested…',
    torbox_item_not_found:
      'TorBox no longer has this release, and the home player could not prepare it either. Try again.',
    torbox_dolby_vision_unsupported:
      'TorBox can’t stream this Dolby Vision release correctly, and the home player could not prepare it either. Try again or pick another release.',
    torbox_receiver_unsupported:
      'The Chromecast can’t play this release as TorBox streams it, and the home player could not prepare it either. Try another release.',
    torbox_refused:
      'TorBox refused to prepare this stream, and the home player could not prepare it either. Check your TorBox account, then try again.',
    torbox_playlist_unavailable:
      'TorBox’s playlist is temporarily unavailable, and the home player could not prepare this release either. Try again.',
    torbox_unavailable:
      'TorBox is temporarily unavailable, and the home player could not prepare this release either. Try again.',
    torbox_unreachable:
      'Den could not reach TorBox, and the home player could not prepare this release either. Try again.',
    torbox_malformed_response:
      'TorBox returned an answer Den could not use, and the home player could not prepare this release either. Try again.',
    torbox_unsafe_stream_url:
      'TorBox returned a streaming link Den could not use, and the home player could not prepare this release either. Try again.',
    managed_prepare_timeout:
      'TorBox took too long to prepare a stream, and the home player could not prepare this release either. Try again.',
    debrid_down: 'TorBox isn’t responding right now. Den will try again when it can…',
    debrid_slow: 'TorBox is slow right now, so this is taking longer to start. Trying again…',
  };

  let playerRoot = $state<HTMLDivElement>();
  let video = $state<HTMLVideoElement>();
  let tvPaused = $state(true);
  let tvPosition = $state(0);
  let tvDuration = $state(0);
  let playerVolume = $state(1);
  let playerMuted = $state(false);
  let playerFullscreen = $state(false);
  let airPlayCapable = $state(false);
  let airPlayActive = $state(false);
  let airPlayAvailability = $state<'unknown' | 'available' | 'unavailable'>('unknown');
  let webControlsVisible = $state(true);
  let webControlsTimer: ReturnType<typeof setTimeout> | undefined;
  /** The top bar, and the timeline with its dock: the pointer over either holds the controls up. */
  let webTop = $state<HTMLElement>();
  let webBar = $state<HTMLElement>();
  /** A pointer holds the timeline: the controls stay while it drags. */
  let timelineHeld = false;
  /** Where the pointer is over the timeline, for the time bubble above it (`x` as a fraction of its width). */
  let timelineHover = $state<{ x: number; at: number } | null>(null);
  /** Seeks by ten that follow one another closely add up, shown as one ripple on their side (`stackSeek`). */
  let seekStreak = $state<{ side: -1 | 1; count: number; at: number } | null>(null);
  let seekStreakTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last tap on the picture: a second one soon after on either side seeks instead (`pictureTap`). */
  let lastTap: { at: number; side: -1 | 0 | 1; shown: boolean } | null = null;
  /** A mouse click on the picture waits this long for a second one, which makes it a double-click (fullscreen). */
  let clickHold: ReturnType<typeof setTimeout> | undefined;
  /** The pause glyph shown for a moment as a click on the picture starts playback again. */
  let pictureFlash = $state(false);
  /** The subtitle last shown, which C turns back on. */
  let lastSubtitle: string | null = null;
  /** Said once as a visit opens mid-title, with the way back to the start. */
  let resumedAt = $state<string | null>(null);
  let resumeOffered = false;
  /** Said as the keyboard changes the volume. */
  let volumeNotice = $state<string | null>(null);
  let tvDetailsOpen = $state(false);
  let tvSubtitleTimingOpen = $state(false);
  let subtitleTimingPanel = $state<HTMLElement>();
  let tvEpisode = $state.raw<EpisodeDetail | null>();
  let castFrame = $state<HTMLIFrameElement>();
  let remoteTime = 0;
  let remoteDuration = 0;
  let remotePaused = true;
  let casting = $state(false);
  let castMode = false;
  /**
   * The receiver model asked for, until the cast page names the one its viewer picked. The Cast SDK names no model
   * or codec of a connected device, so this is a choice: Chromecast with Google TV (4K), the common receiver now, so
   * an HEVC or HDR release casts as it is. An older Chromecast that can't take it fails the load, and the receiver's
   * error path retries once with the conservative `legacy` profile.
   */
  let castProfile = 'google-tv-4k';
  /**
   * What Den's own receiver said its TV plays (castProfile `receiver`), asked with in place of a model's profile. The
   * model list goes while it is known: the receiver has said what the viewer would otherwise be asked to pick.
   */
  let castReport = $state.raw<Playable | undefined>();
  /** This browser opted in to Den's receiver before the box launches it for everyone (`castReceiverOptIn`). */
  const castFrameQuery = castReceiverOptIn() ? '/?receiver=den' : '';
  /** The same-origin control relay: the only route whose sessions carry a public address and the cast page. */
  const RELAY = '/remux';
  /**
   * Where den-remux is asked, which starts as the page's own route and moves to the relay when the viewer asks to
   * cast from a direct (tailnet or home-network) one: those play in a plain video element that has no Cast button.
   */
  let route = $state.raw(untrack(() => remux));
  let routeBeforeCast = untrack(() => remux);
  /**
   * The cast page, loaded beside the playing video once it plays, for good: it watches for a receiver in the background
   * and is the Cast button itself (`castSlot`). The same document throughout, so the Cast session started in it — which
   * belongs to that page — is never lost.
   */
  let lookOrigin = $state<string>();
  /** Asked once per player: whether this title may be cast, and where the cast page is (`/config`). */
  let castPageAsked = false;
  /** Where Cast stands, as the cast page's SDK says (`den-cast-state`). */
  let castState = $state<CastState>('none');
  /** The connected receiver's own name, once one is connected. */
  let castDevice = $state<string>();
  /** A Cast failure in plain words, with a way back when this page can offer one. */
  let castNotice = $state<{ text: string; retry?: () => void } | null>(null);
  /** This move to Cast has spent its one retry of a TorBox stream the receiver couldn't play. */
  let castRetried = false;
  /** Where the Cast button is drawn: Den's own button surface, which the cast page's frame lies exactly over. */
  let castSlot = $state<HTMLElement>();
  /** The frame's button has focus — from the keyboard, so Den's focus ring shows — or the pointer is over it. */
  let castFocus = $state<'keyboard' | 'pointer' | null>(null);
  let castHover = $state(false);
  let castMenu = $state<ReturnType<typeof ActionMenu>>();
  /** The trusted Cast-page origin that discovered the receiver now receiving an external managed stream. */
  let directCastOrigin: string | undefined;
  /** Set while playback was moved to the relay to cast: a failure there goes back to the player it left. */
  let castOffered = false;
  /** Whether this page reaches den-remux's home-network address (`lanBase`): asked once per address (`homeHere`). */
  let lanProbe: { base: string; reachable: Promise<boolean>; answer?: boolean } | undefined;
  let publicMaxBitrate: number | undefined;
  /** The `maxBitrate` the playing session was asked with. */
  let askedMaxBitrate: number | undefined;
  /** What this page's own video reports to den-remux (`watchPlayback`); stopped before hls.js is destroyed. */
  let watcher: Watcher | undefined;
  /** This title's (or episode's) releases as this tab remembers them across a reload (`releaseMemory`). */
  let memoryKey = untrack(() => `${title.type}:${title.id}:${season ?? ''}:${episode ?? ''}`);
  const recalled = recallReleases(memoryKey);
  /**
   * The release the viewer chose — from the title's sources, or the picker here — rather than den-remux's own pick.
   * Nothing moves playback off it on its own: where it can't keep up, the viewer is told and offered another.
   */
  let chosenRelease: string | undefined = untrack(() => filename) ?? recalled.chosen;
  let session = $state<Session | null>(null);
  /** Holds a direct Cast handoff until its selected external subtitle has its receiver URL. */
  let castSubtitlePreparing = $state(false);
  /**
   * Set across an advance in place (`playEpisode`): the outgoing episode's `<video>` — or the cast page's frame, at
   * `heldFrame` — stays in the document until the next episode's session is in, so the fullscreen it is in survives.
   */
  let holding = $state(false);
  let heldFrame = $state<string>();
  /** One cast page frame at a time — the Cast button, then playing or casting — so a Cast session is never lost. */
  const frameOrigin = $derived(lookOrigin ?? session?.castOrigin ?? heldFrame);
  /** A receiver has, or is taking, what the cast page was given: this page is its remote. */
  const castActive = $derived(casting || castState === 'connecting' || castState === 'connected');
  /** The picture is on the receiver: the stage shows its poster and where it plays, under Den's transport. */
  const castView = $derived(castActive && (!!session?.castOrigin || !!heldFrame));
  /** The exact iframe document generation that announced readiness; origin alone cannot distinguish a reload. */
  let castFrameGeneration = 0;
  let castFrameChallenge = '';
  let castFrameReady = $state<{ origin: string; challenge: string }>();
  let directAttempt: 'initial' | 'refreshed' | null = null;
  /** The route `session` was started on: the same one's credentials, so the same owner at den-remux. */
  let sessionRoute: string | undefined;
  /** The last session's `subtitleSource`, kept past a `letGo`/`session = null` the same way `sessionRoute` is. */
  let lastSubtitleSource: 'den_subtitles' | undefined;
  let failure = $state<
    Failure | 'imdb' | 'unsupported' | 'playback' | 'source' | 'lost' | 'engine' | null
  >(null);
  /** The cast page plays the session itself (away from home): its frame is the picture, its button in the corner. */
  const castStage = $derived(
    (!!session?.castOrigin || !!heldFrame) && !failure && !castView && !castActive,
  );
  /** Den's Cast button, drawn where the player's other output buttons are; it shows once a receiver is found. */
  const castSlotShown = $derived(
    !castStage &&
      castState !== 'none' &&
      !!session &&
      (castView || (!!lookOrigin && !session.castOrigin && canOfferCurrentCast(session))),
  );
  /** A closed, non-secret Hearth reason. Never arbitrary provider text. */
  let managedCause = $state<PlaybackCause>();
  /** Hearth's code and reason for the last refused mid-film change, for the notice that names it (`restart`). */
  let replacementRefusal: { code?: string; cause?: PlaybackCause } | undefined;
  const sourceRecovery = $derived(
    !session &&
      !!playback &&
      (failure === 'sourceUnavailable' ||
        failure === 'source' ||
        failure === 'none' ||
        failure === 'noCopy'),
  );
  /** Whether the active direct session was explicitly opened without Den's sidecar subtitles. */
  let directWithoutDenSubtitles = $state(false);
  /** On `none`: the containers of the releases that were ready but that the browser player can't open (`.ts`, …). */
  let skippedFormats = $state.raw<string[]>([]);
  /**
   * The playing session's connection as its segments see it (`resumingLoader`): down while they fail for want of one,
   * which is waited out rather than acted on. One per hls.js instance.
   */
  let link: Link | undefined;
  /** Shown over the held picture while the connection is down and the buffer has run out. */
  let reconnecting = $state(false);
  /** Where playback was when its session was lost (`lose`): where the viewer's Resume picks up. */
  let lostAt = $state(0);
  /** When den-edge was last asked to let this browser's address in again (`regrant`). */
  let regrantedAt = -Infinity;
  let key = $state('');
  let badKey = $state(false);
  /** Seconds until the next episode starts, once this one has ended. */
  let upNext = $state<number | null>(null);
  let imdb: string | undefined;
  let hls: Hls | undefined;
  let avplay: SamsungAvplayAdapter | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const RECEIPT_PREPARE_MS = 3_000;

  function beforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      void work.then(
        (value) => {
          signal.removeEventListener('abort', aborted);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        },
      );
    });
  }
  /** The one session POST this player still wants. A newer attempt or close aborts all of its recursive retries. */
  let startingSession: AbortController | undefined;
  let clientFailureGeneration = 0;
  let ended = false;
  /** The episode playing, which the props name ahead of it once an advance asks for the next (`playEpisode`). */
  let playingEpisode: Episode = untrack(() => ({ season, episode }));
  /** Each episode's positions are written against that episode, whatever the props name by the time they go. */
  const reporterFor = (at: Episode) =>
    new PlaybackProgressReporter(
      (fraction, seconds, playing) => onprogress(fraction, seconds, at, playing),
      at.season !== undefined && at.episode !== undefined ? 'episode' : 'movie',
      (fraction, seconds) => onfinalprogress(fraction, seconds, at, false),
    );
  let progress = reporterFor(playingEpisode);
  /** Where the next session starts: a language switch picks up where the last one was. */
  let startAt: { fraction: number; seconds?: number } | null = null;
  /** The second den-remux was asked to start the playing session at; undefined when it was asked for none. */
  let started: number | undefined;
  /** What this browser decodes, found once: den-remux converts only what won't play here. */
  let decodes: Playable | undefined;
  /** The title's releases den-remux could play, to pick another from. */
  let releases = $state.raw<Release[]>([]);
  /**
   * Discovery is separate from session creation. The session itself is a valid first choice, but presenting that
   * one row as a finished list while Scout is still collecting releases makes a slow answer look like "one stream".
   */
  let releaseListing = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  /**
   * The playing release is already a valid stream choice before (or even when) the background listing answers.
   * The player always exposes the stream control. That makes a slow or failed guest listing visible instead of
   * silently looking like the host withheld the picker, and still gives a one-stream session an honest explanation.
   * Filename is also the identity sent back when switching: providers can return the same file independently, so
   * one filename must render as one choice (and therefore one stable menu key).
   */
  function releaseChoices(): Release[] {
    if (!session) return releases;
    const seen = new SvelteSet<string>();
    const playing: Release = {
      ...session.release,
      plays: session.video?.transcoded ? 'convert' : 'yes',
    };
    return [playing, ...releases].filter((release) => {
      if (seen.has(release.filename)) return false;
      seen.add(release.filename);
      return true;
    });
  }

  /** Start the independent release listing as soon as this browser's claims are known, alongside session startup. */
  function discoverReleases(can: Playable) {
    if (!imdb || releaseListing === 'loading' || releaseListing === 'ready') return;
    releaseListing = 'loading';
    const listing = memoryKey;
    void listReleases({ imdb, season, episode, scout: scout.install }, undefined, route, {
      videoCodecs: videoCodecsOf(can),
      playable: can,
    }).then((list) => {
      // An episode advanced from meanwhile lists its own.
      if (memoryKey !== listing) return;
      releases = list ?? [];
      releaseListing = list === null ? 'failed' : 'ready';
    });
  }
  /** Said when den-remux opened another release than the one picked; dismissed by the viewer. */
  let swapped = $state<string | null>(null);
  /**
   * Said while a playing session moves to another release on its own (`switchAway`) and once it has: decode or
   * delivery only, never the viewer's own pick from the list, which the picker itself already shows picking.
   * Dismissed by the viewer, same as `swapped`.
   */
  let autoSwitch = $state<string | null>(null);
  /**
   * How many times this visit has moved to another release, and why the last one did — a closed
   * `SwitchReason`, for den-edge's own outcome report (den-edge#275): never free text, so a visit that hopped
   * releases like this is answerable from the log without guessing what the player did.
   */
  let switchCount = 0;
  let lastSwitchReason: SwitchReason | undefined;
  /**
   * Whether this release has already been asked for again with the browser's claims cut back.
   *
   * A browser can claim a codec, take the playlist, and then refuse the very first segment — an iPhone
   * does exactly that with a 4K HDR Main-tier HEVC remux it says it decodes, and did it again with the
   * 1080p H.264 conversion of that same file while its E-AC-3 track was still being copied through. So a
   * refusal is taken to disprove the whole session, sound and picture: den-remux keeps a release the
   * player can't take as the fallback it converts on the GPU, and asking again as a player that takes
   * none of it is what gets that conversion. Once only: what is left is H.264 with AAC, and nothing here
   * makes that smaller.
   */
  let degraded = false;
  /**
   * Set once a session den-edge opened for this browser's reported IPv4 address (`ipv4Hint`) failed before anything
   * of it arrived: that address was not the one the media is fetched from, so no later session reports it either.
   */
  let noHint = false;
  /** Whether anything of the playing session has arrived: its first frame here, or the cast page's metadata. */
  // $state (den-edge#234): the startup notice's own derived reads this to clear itself once the first frame
  // arrives, which needs it reactive — every other read here is a plain check inside a function body.
  let played = $state(false);
  /**
   * Whether the playing session is ready but waiting for a press: the browser refused to start it by itself (iOS
   * Safari does, after a long wait for a large release), so its own play button is up. The startup notice is then
   * done — it would otherwise sit over that button until the press.
   */
  let awaitingPress = $state(false);
  /** How long after `canplay` a video the browser lets start by itself has started. */
  const AUTOPLAY_GRACE_MS = 1_000;
  /**
   * Releases of this title playback left — a switch moved away from it (`switchAway`), or a decoder refused it — which
   * no automatic pick lands on again this visit, a reload included. The viewer may still pick one from the list.
   */
  let excluded: string[] = recalled.left;
  // $state: a notice of a switch under way stays up until it lands, and only then starts to fade.
  let switching = $state(false);
  /**
   * A change the viewer explicitly asked for. Unlike an automatic recovery, the picker closes as soon as its choice
   * is made; keep one visible acknowledgement from that press until the replacement paints its first frame. Its id
   * separates a superseded request from the newer one it must not clear.
   */
  let transitionNoticeId = 0;
  let transitionNotice = $state<string | null>(null);
  /**
   * Later sessions reuse the same `<video>`. Its one-shot `autoplay` starts the first, but browsers need not run it
   * again after hls.js swaps the MediaSource. Explicitly start a next episode; for an in-place replacement, remember
   * whether the outgoing stream was actually playing so a viewer who switched while paused stays paused.
   */
  let playWhenMounted: Session | null = null;

  function showTransition(label: string): number {
    transitionNotice = label;
    return ++transitionNoticeId;
  }

  function continueManualSwitch(pending: number | undefined, label: string): number {
    if (!pending || transitionNoticeId !== pending) return showTransition(label);
    transitionNotice = label;
    return pending;
  }

  function clearTransition(pending?: number) {
    if (!pending || transitionNoticeId === pending) transitionNotice = null;
  }
  /**
   * What the stamp says of TorBox while Den Remux plays. `offered`: a TorBox stream played here this visit, or Hearth
   * tried TorBox first and fell back for a reason that may pass (`directFailure`). `untried`: nothing says either way
   * — this page itself asked for Den Remux (a subtitle the system player shows only from a playlist, a track, a
   * release left out), so Hearth never tried TorBox, and the switch is how to find out. Otherwise, why TorBox can't
   * play here: the stamp shows its switch disabled, with that reason.
   */
  let torbox = $state<'offered' | 'untried' | { unavailable: string }>('untried');

  /** Why TorBox can't play here, for a cause Hearth gave that will not pass by trying again; else undefined. */
  function torboxRuledOut(cause: string | undefined): string | undefined {
    if (cause === 'torbox_authentication_failed') return 'TorBox refused this Hearth’s TorBox key';
    if (cause === 'torbox_managed_streaming_unavailable_for_plan')
      return 'This TorBox plan doesn’t include streaming';
    return undefined;
  }
  const NO_TORBOX = 'This Hearth has no TorBox to play from';
  /** Set while the stamp's switch to the other path is under way (`switchDelivery`). */
  let deliverySwitching = $state(false);

  function playbackRouteLog(report: PlaybackRouteReport) {
    console.info(`[Den playback] ${JSON.stringify(report)}`);
    sendPlaybackRoute(report);
  }

  function routeFailure(failure: Failure): PlaybackRouteFailure {
    switch (failure) {
      case 'sourceUnavailable':
        return 'source_unavailable';
      case 'timedOut':
        return 'timed_out';
      case 'temporarilyUnavailable':
        return 'temporarily_unavailable';
      case 'noCopy':
        return 'no_copy';
      case 'noFit':
        return 'no_fit';
      default:
        return failure;
    }
  }

  /** Keep `chosenRelease` and `excluded` for a reload of this same visit. */
  function keepReleases() {
    rememberReleases(memoryKey, { chosen: chosenRelease, left: excluded });
  }

  /** Leave `filename` for good this visit: no automatic pick lands on it again. */
  function leave(filename: string) {
    if (!excluded.includes(filename)) excluded = [...excluded, filename];
    keepReleases();
  }
  /**
   * The session `broke` is already judging, and whether a decoder refused it. A video's `error` and a fatal hls.js
   * error, the stuck watch, or the cast page's `den-error` twice, can arrive for one failure; the second would find the
   * first's switch under way and call it unplayable. A decoder's refusal among them still counts: it is what moves the
   * session to another copy.
   */
  let breaking: { session: Session; decode: boolean; refused: boolean } | null = null;
  /**
   * Seconds played on an earlier src this same `<video>` held, before the one playing now: a mid-film switch
   * (`element.src = …`, or hls.js's `loadSource`/`attachMedia`) resets the element's own `played` ranges, so
   * `begin()`'s `replacing` branch folds what they held into this before that happens. `totalPlayedSecs` adds
   * the current src's own `played` on top — never a step counter driven by `timeupdate`, which iOS Safari's
   * native HLS fires too coarsely to trust (see `playedSecondsOf`).
   */
  let playedSecs = 0;
  let lastPosition: number | undefined;

  /** `playedSecs` plus however much of the current src is played so far — the one number both `weighDelivery`
   * and `finish()` report. */
  function totalPlayedSecs(): number {
    return playedSecs + (video ? playedSecondsOf(video.played) : 0);
  }

  /** The last fatal error's code and, for an hls.js one, its type and detail — for den-edge's own outcome
   * report; parsed back from `broke()`'s own message rather than threaded through every path that calls it. */
  let lastFatal: { code?: number; hls?: ReturnType<typeof hlsFatalFromMessage> } | undefined;
  /** What noticed the last failure (the video element, hls.js, the stuck watch, the cast page), for the same report. */
  let lastFailSource: FailSource | undefined;
  /** The engine the last session was actually mounted in, for the same report: hls.js is gone by the time it is sent. */
  let playedEngine: Engine | undefined;
  /** Whether the viewer changed or turned off the subtitle after playback had already shown a frame: a signal
   * the file first chosen was wrong, for den-edge's own outcome report. */
  let subtitleSwitchedMidPlay = false;
  let subtitleTurnedOffMidPlay = false;
  /** An hls.js subtitle fragment failed to load, for the same report. */
  let subtitleLoadFailedFlag = false;
  /** Set by `finished()`: whether this visit's playback reached a natural end, for `endReason`. */
  let reachedNaturalEnd = false;
  /** The furthest stage a Chromecast attempt reached this visit, and how it went; undefined until the Cast
   * control is first offered. Reported once, alongside the playback outcome, at `finish()`. */
  let castFunnel: CastStage | undefined;
  let castFailed = false;
  let castFailReason: CastFailReason | undefined;
  let castSessionStartedAt: number | undefined;
  let castSessionSecs = 0;
  /** What the playing session's media is really arriving at. */
  let meter = new DeliveryMeter();
  /** Set once no other copy fitted the link: this one plays on, and delivery is not weighed again. */
  let deliveryGaveUp = false;
  /** Shown while the link is slower than the playing release needs, and no lighter one fits it: that release's label. */
  let struggling = $state<string | null>(null);
  /**
   * The viewer's own pick can't keep up with the link (`tooSlow`): its label, shown with an offer of another, which
   * playback never takes on its own. Said once per session.
   */
  let slowPick = $state<string | null>(null);
  /** The playing session's stalls since its first frame, and their length: a native player's whole evidence. */
  let stallCount = 0;
  let stalledMs = 0;
  let stallSince: number | undefined;
  /**
   * The bytes of the playing session's fragments against what den-remux said it sends for the same stretches
   * (`segments`): the share of its demand that really comes, which `waitAt` is weighed with.
   */
  let delivered = { bytes: 0, demand: 0 };
  /**
   * Whether the element is waiting on data once a frame has already shown (den-edge#275): never a bare
   * spinner here either, same as the startup line. Driven by the `<video>`'s own `waiting`/`playing` events in
   * the session effect below, not by `weighDelivery`'s early-window switching, which this plays alongside.
   */
  let stalling = $state(false);
  /** What `meter` and the buffer say while `stalling`, refreshed on a timer since a stall fires no `progress`
   * or `timeupdate` of its own to read it from. */
  let stallProgress = $state<{ bufferedSecs?: number; bitsPerSecond?: number } | undefined>(
    undefined,
  );
  /** The playing session's start, held until it can play through (`prebuffer`); null once it plays. */
  let hold: PrebufferHold | null = null;
  /** What the countdown over a held start says; null when there is none to show. */
  let startsIn = $state<string | null>(null);
  /** Said when a change asked for mid-film (another track, another release, casting) couldn't be made as a copy. */
  let unchanged = $state<string | null>(null);
  let receiptUnsupported = $state(false);
  /**
   * The startup notice's own clock (den-edge#234): when the session now starting was asked for (`Date.now()`,
   * reset at the top of every `begin()`), and the running time since, ticked while there is still nothing to
   * show for the wait. `Date.now()` rather than `performance.now()` — a second's precision is all a human-facing
   * clock needs, and it is what a test's fake clock (`page.clock`) can drive deterministically. Both reactive,
   * and both read unconditionally by `elapsedMs`: a derived that only reads one of its signals down a branch —
   * `now` behind an `if (askedAt !== undefined)`, say — never sees that branch taken on its first, pre-`begin()`
   * run and so never tracks it, and then sits stuck at its first value however often the signal it missed ticks.
   */
  let startupAskedAt = $state(Date.now());
  let now = $state(Date.now());
  /** Why an automatic startup attempt after the first one is under way, so it never looks like time reset. */
  let startupRetryNotice = $state<string | null>(null);
  function automaticRetryNotice(failure: Failure, cause?: PlaybackCause): string {
    if (cause === 'torbox_rate_limited') return 'TorBox asked Den to wait—trying again…';
    if (cause === 'debrid_down' || cause === 'debrid_slow') return managedCauseMessages[cause];
    if (failure === 'busy') return 'The player is busy—trying again…';
    if (failure === 'starting') return 'The release is still being prepared—trying again…';
    if (failure === 'transcode') return 'The release is still being converted—trying again…';
    if (failure === 'timedOut') return 'The playback server took too long to answer—trying again…';
    return 'The playback service was temporarily unavailable—trying again…';
  }
  let noticeTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * When each session was asked for and when it answered, by the session object — never confused with a later
   * `begin()` by being keyed to the attempt's own session rather than to a shared mutable field — plus when its
   * first segment arrived, filled in as it does (`updateBufferProgress`). Read once to send den-edge#234's
   * step-0 report on the first frame.
   */
  const startupTimings = new WeakMap<
    Session,
    { askedAt: number; answeredAt: number; firstSegmentAt?: number }
  >();
  /** How long this browser has waited for the session now starting, for the startup notice. */
  const elapsedMs = $derived(now - startupAskedAt);
  /**
   * What has arrived toward the first frame (den-edge#234: no bare spinner) — bytes and a rate from hls.js's
   * `FRAG_LOADED`, or buffered seconds on native HLS, which has no byte loader to read. Updated on every
   * `arriving()` (`updateBufferProgress`); cleared per attempt in `begin()`.
   */
  let bufferProgress = $state<StartupProgress | undefined>(undefined);
  /**
   * The line over the stage while there is still nothing to show for the wait (den-edge#234): den-remux's own
   * `prebuffer` countdown (`startsIn`) and a dropped connection (`reconnecting`) already say their own piece, so
   * this only covers finding a release and, once one is open, waiting on its first frame.
   */
  const notice = $derived(
    transitionNotice
      ? null
      : !session
        ? startupRetryNotice
          ? { text: startupRetryNotice }
          : startupNotice(elapsedMs, 'session')
        : !played && !awaitingPress && !startsIn && !reconnecting
          ? startupNotice(elapsedMs, 'starting', session.release, undefined, bufferProgress)
          : null,
  );
  /**
   * The live line over a mid-play stall (den-edge#275): `autoSwitch` already says its own piece once a switch
   * is actually under way or has landed, so this only shows where a stall is just a stall — still buffering,
   * or given up on a link nothing else fits either.
   */
  const bufferLine = $derived(
    stalling && !autoSwitch ? bufferingWhilePlaying(stallProgress, deliveryGaveUp) : null,
  );
  /** A normal session often crosses these states between two painted frames. Do not flash UI for work that finished
   * before a viewer could read it; once a wait is perceptible, keep its truthful live detail and activity indicator. */
  const STATUS_REVEAL_MS = 500;
  const visibleStartupNotice = $derived(elapsedMs >= STATUS_REVEAL_MS ? notice : null);
  let stallNoticeVisible = $state(false);
  $effect(() => {
    const waiting = stalling && !autoSwitch;
    if (!waiting) {
      stallNoticeVisible = false;
      return;
    }
    // A browser's play button turns to a ring at once; a stall says so in words only once it is a long one.
    const timer = setTimeout(
      () => {
        if (stalling && !autoSwitch) stallNoticeVisible = true;
      },
      webTransport ? STALL_NOTICE_MS : STATUS_REVEAL_MS,
    );
    return () => clearTimeout(timer);
  });
  const visibleBufferLine = $derived(stallNoticeVisible ? bufferLine : null);
  /** How long a browser's stall shows only as the ring on Play before the buffering line says it. */
  const STALL_NOTICE_MS = 3_000;

  /** How long a notice that asks nothing of the viewer stays up: a browser's toast lane is one at a time. */
  const NOTICE_MS = webTransport ? 4_000 : 6_000;
  /** The resume notice stays longer: it carries Start over. */
  const RESUME_NOTICE_MS = 6_000;
  /** Clear a notice NOTICE_MS after `shown` says it is up; a new text starts the time over. */
  function fades(shown: () => unknown, clear: () => void, ms = NOTICE_MS) {
    $effect(() => {
      if (!shown()) return;
      const timer = setTimeout(clear, ms);
      return () => clearTimeout(timer);
    });
  }
  fades(
    () => volumeNotice,
    () => (volumeNotice = null),
  );
  fades(
    () => resumedAt,
    () => (resumedAt = null),
    RESUME_NOTICE_MS,
  );
  fades(
    () => swapped,
    () => (swapped = null),
  );
  // Only once the switch has landed: "trying another release…" stays until it says where it went.
  fades(
    () => !switching && autoSwitch,
    () => (autoSwitch = null),
  );
  fades(
    () => struggling,
    () => (struggling = null),
  );
  fades(
    () => unchanged,
    () => (unchanged = null),
  );
  // A terminal result replaces progress feedback. In particular, a direct URL can be accepted and then fail before
  // its first frame; no stale "Switching…" line should survive beside the error that ended that attempt.
  $effect(() => {
    if (!failure) return;
    clearTransition();
  });

  const episodeHeading = $derived(
    season !== undefined ? `${title.title} · S${season} · E${episode}` : title.title,
  );
  const heading = $derived(fullTvTransport && tvEpisode?.name ? tvEpisode.name : episodeHeading);
  const tvInfoLine = $derived(
    [
      tvEpisode ? title.title : undefined,
      tvEpisode?.airDate
        ? new Intl.DateTimeFormat(navigator.language, { dateStyle: 'medium' }).format(
            new Date(`${tvEpisode.airDate}T00:00:00`),
          )
        : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  // tvOS resolves episode metadata after playback has begun. Do the same through the already-open content service:
  // it enriches the transport and Down panel without joining the source/session critical path.
  $effect(() => {
    const [pickedSeason, pickedEpisode] = [season, episode];
    tvEpisode = undefined;
    if (
      !fullTvTransport ||
      title.type !== 'tv' ||
      pickedSeason === undefined ||
      pickedEpisode === undefined
    )
      return;
    const controller = new AbortController();
    void content
      .query(
        { kind: 'season', title: { type: 'tv', id: title.id }, season: pickedSeason },
        controller.signal,
      )
      .then(({ episodes }) => {
        if (controller.signal.aborted) return;
        // Dated as the episode list dates it: atlas's release day where atlas has one.
        tvEpisode =
          episodes.state === 'ready'
            ? (withAiring(
                episodes.value,
                pickedSeason,
                untrack(() => airingStore(content).get(title.id)),
              ).find((item) => item.number === pickedEpisode) ?? null)
            : null;
      })
      .catch(() => {
        if (!controller.signal.aborted) tvEpisode = null;
      });
    return () => controller.abort();
  });
  // The page under the player is not on screen while it plays (its `active` is off), so it names the tab no more:
  // the player does, as the title's page would.
  nameTab(() => named(heading, season === undefined ? title.year : undefined));
  const names = (() => {
    try {
      return new Intl.DisplayNames([navigator.language], { type: 'language' });
    } catch {
      return null;
    }
  })();

  /**
   * Start a session: the release den-remux picks, or the one `pick` names — in another audio track, perhaps. `extra`
   * is what a switch adds to the request. With `replacing`, the session playing now is kept until the new one has
   * started, and kept for good when none does: true when one did, den-remux's refusal when it refused one, else false.
   * `delivery` 'fallback' asks Hearth for Remux; 'direct' for TorBox or nothing, so a Remux session Hearth would
   * otherwise start in its place never takes the playing one's slot.
   */
  async function begin(
    pick:
      { audioTrack?: number; subtitleTrack?: number; filename: string } | undefined = chosenRelease
      ? { filename: chosenRelease }
      : undefined,
    extra: Pick<Want, 'exclude' | 'transcode' | 'fitsOnly' | 'maxBitrate'> = {},
    replacing?: Session,
    delivery: 'ordinary' | 'refresh' | 'fallback' | 'direct' = 'ordinary',
    retryNotice: string | null = null,
    compatibleSubtitles = true,
  ): Promise<boolean | Failure> {
    const replacingSubtitleLanguage = replacing
      ? selectedSubtitle(replacing, subtitleChoice)?.language
      : undefined;
    clearTimeout(retry);
    retry = undefined;
    // The startup notice's own clock, for this attempt (den-edge#234): reset here rather than on a notice first
    // shown, so a slow identifier query or `playable()` below counts as part of the wait too. Stopped once this
    // attempt's first frame arrives (the `requestVideoFrameCallback`/`loadeddata` listener below) or the player
    // closes (`finish`), never by polling `played`, which a mid-film switch leaves true from the session this
    // one is replacing.
    now = Date.now();
    startupAskedAt = now;
    startupRetryNotice = retryNotice;
    bufferProgress = undefined;
    clearInterval(noticeTimer);
    noticeTimer = setInterval(() => (now = Date.now()), 250);
    if (!replacing) {
      // A session a failure left standing (a browser key asked for mid-film, say) goes first: kept, its video would
      // come back and load it again, and den-remux would hold its slot until the player closed.
      letGo();
      failure = null;
      managedCause = undefined;
    }
    swapped = null;
    unchanged = null;
    receiptUnsupported = false;
    // Each wait below may outlast the player: once it is closed, nothing more is asked for, and no session started.
    if (!imdb) {
      const answer = await content
        .query({ kind: 'title.external-id', title: { type: title.type, id: title.id } })
        .catch(() => null);
      const found =
        answer?.imdbId.state === 'ready'
          ? answer.imdbId.value
          : answer?.imdbId.state === 'absent'
            ? null
            : undefined;
      if (ended) return false;
      if (!found) {
        failure = found === null ? 'imdb' : 'unreachable';
        return false;
      }
      imdb = found;
    }
    const { audio, subtitleLanguages } = wantedLanguages(
      {
        audio: audioLanguage,
        subtitle: subtitleLanguage ?? undefined,
        shownSubtitles: shownSubtitleLanguages,
      },
      title.originalLanguage,
      [interfaceLanguage],
    );
    // Whether a subtitle will show: the one chosen, or the one `autoSubtitleLanguage` picks below on the title's first
    // session, for audio — in the title's original language, the most that can be told before a session says — that
    // this browser doesn't name. A title whose language is unknown is not taken for foreign.
    const subtitleWanted =
      compatibleSubtitles &&
      (subtitleChoice !== null ||
        (!replacing &&
          subtitleLanguage === undefined &&
          title.originalLanguage !== undefined &&
          autoSubtitleLanguage(
            title.originalLanguage,
            [interfaceLanguage],
            subtitleLanguages.map((language) => ({ language })),
          ) !== null));
    const claimed = (decodes ??= await playable());
    if (ended) return false;
    // What this browser hasn't disproved. After a refusal it asks as something that takes no HEVC, no HDR and no
    // E-AC-3, so den-remux copies another release this browser does decode — never converting one mid-film.
    const can = castMode
      ? !degraded && castProfile === 'receiver' && castReport
        ? castReport
        : castCapabilities(degraded ? 'legacy' : castProfile)
      : degraded
        ? withoutRefused(claimed)
        : claimed;
    // Away from home every byte crosses the home upload: den-remux is told what the link carries, measured once.
    // A direct remote origin can be measured before creation. Through the public control relay the link is what this
    // browser remembers (timed on the title's page, or at an earlier play); with nothing remembered, the first session
    // is measured inside and replaced only when what it chose needs more than the link carries (`castMessage`).
    const maxBitrate =
      extra.maxBitrate ??
      (/^https?:/.test(route)
        ? await linkLimit(route)
        : (publicMaxBitrate = relayLimit(route, publicMaxBitrate)));
    if (ended) return false;
    // Not the very start, nor the credits. A resume the library holds as a fraction alone can't be named before the
    // video's length is known: it is sought to once the video has loaded, as before.
    const from = startAt ?? resume;
    const at =
      from.seconds !== undefined && from.seconds > 5 && from.fraction < WATCHED
        ? from.seconds
        : undefined;
    const request: Want = {
      imdb,
      title: { type: title.type, id: title.id },
      season,
      episode,
      scout: scout.install,
      subtitles,
      subtitleLanguages,
      ...(title.originalLanguage ? { originalLanguage: title.originalLanguage } : {}),
      audio,
      videoCodecs: videoCodecsOf(can),
      playable: can,
      startAt: at,
      maxBitrate,
      // For den-remux's log only, so a session can be told apart by the player that played it.
      player: castMode
        ? 'cast'
        : samsungAvplay || webOsNative || nativeHls(document.createElement('video'))
          ? 'native'
          : 'hls.js',
      ...(__DEN_TV_PLATFORM__ === 'webos' || __DEN_TV_PLATFORM__ === 'tizen'
        ? { platform: __DEN_TV_PLATFORM__ }
        : {}),
      // No address is looked up here: `startSession` does that only when den-edge asks for it.
      ...(noHint ? { noHint } : {}),
      // Hearth sends a request that leaves releases out, or replaces a Remux session, to Remux: a TorBox one has neither.
      ...(excluded.length && delivery !== 'direct' ? { exclude: [...excluded] } : {}),
      ...extra,
      ...pick,
      // den-remux keeps the session being replaced playing until this one serves media, rather than ending it as
      // soon as this is asked for. Only a session of the same route: another route's (a move to cast) may belong to
      // another owner there, and is not ended by this one anyway.
      ...(replacing?.sid && sessionRoute === route && delivery !== 'direct'
        ? { replaces: replacing.sid }
        : {}),
    };
    const on = route;
    startingSession?.abort(new DOMException('superseded session start', 'AbortError'));
    const attempt = new AbortController();
    startingSession = attempt;
    const diagnosticGeneration = ++clientFailureGeneration;
    replaceClientFailureGeneration('session', diagnosticGeneration);
    const {
      scout: _scout,
      subtitles: _subtitles,
      ipv4Hint: _ipv4Hint,
      noHint: _noHint,
      ...fields
    } = request;
    const asked: PlaybackWant = {
      ...fields,
      ...(!compatibleSubtitles ? { subtitleLanguages: [] } : {}),
      // WebKit's system player needs captions in the HLS playlist itself. Cast does not: a selected external VTT
      // is staged as a short-lived receiver capability, so choosing captions must never disqualify TorBox.
      ...(delivery === 'fallback' ||
      (replacing !== undefined && !replacing.external && delivery !== 'direct') ||
      (delivery !== 'direct' && delivery !== 'refresh' && subtitleWanted && subtitlesNeedPlaylist())
        ? { directFailed: true }
        : {}),
      ...(delivery === 'direct' || delivery === 'refresh' ? { directOnly: true } : {}),
    };
    const requestedSource = asked.directOnly
      ? ('torbox' as const)
      : asked.directFailed
        ? ('den_remux' as const)
        : ('managed' as const);
    playbackRouteLog({
      event: 'request',
      requestedSource,
      reason: delivery,
      replacement: replacing !== undefined,
      subtitleConstraint: asked.directFailed
        ? 'playlist_required'
        : compatibleSubtitles
          ? 'allowed'
          : 'den_subtitles_disabled',
    });
    // This used to wait until the playback session had completely opened, so the stream menu could show one
    // apparently-final choice for several seconds. Source discovery does not depend on that answer and belongs in
    // parallel with it.
    discoverReleases(can);
    // Whether Hearth tries TorBox first for this request: one that rules it out goes straight to Remux (den-hearth
    // `managed_request`), and its Remux answer says nothing of whether TorBox is there. A selected audio track no
    // longer rules it out: Scout asks TorBox to create that exact track's stream.
    const torboxTried =
      !!playback && !asked.directFailed && asked.replaces === undefined && !asked.exclude?.length;
    if (playback && onmanagedplayback) {
      let receiptPreparation: PlaybackReceiptPreparation = 'temporarily-unavailable';
      try {
        const receiptSignal = AbortSignal.any([
          attempt.signal,
          AbortSignal.timeout(RECEIPT_PREPARE_MS),
        ]);
        // The deadline owns the whole callback, including the first lazy module load and any transport reconnect.
        // Passing it down still cancels work that observes the signal; racing it here prevents an uncooperative
        // boundary from holding playback indefinitely.
        receiptPreparation = await beforeAbort(onmanagedplayback(receiptSignal), receiptSignal);
      } catch (error) {
        if (!attempt.signal.aborted)
          console.warn('den: managed playback receipt authority could not be prepared', error);
      }
      if (attempt.signal.aborted) return false;
      if (receiptPreparation === 'unsupported') receiptUnsupported = true;
      else if (receiptPreparation !== 'ready')
        unchanged = i18n.phrase(
          'Playback can start, but background progress recovery is unavailable. Keep this page open to save where you stop.',
        );
    }
    let result = playback
      ? await startPlayback(playback, asked, undefined, attempt.signal)
      : await startSession(request, undefined, on, undefined, attempt.signal);
    // Hearth and Edge have independent default-off gates. Preserve legacy playback until both are enabled. Legacy
    // playback is Remux, which a request for TorBox alone never takes.
    if ('failure' in result && result.failure === 'legacy')
      result =
        delivery === 'direct' || delivery === 'refresh'
          ? { failure: 'sourceUnavailable' }
          : await startSession(request, undefined, on, undefined, attempt.signal);
    // TorBox was asked for and anything else is a refusal: a Remux answer is ended unplayed.
    if (
      (delivery === 'direct' || delivery === 'refresh') &&
      !('failure' in result) &&
      !result.external
    ) {
      endSession(result);
      result = { failure: 'sourceUnavailable' };
    }
    // Headed for a receiver: whether this page reaches the session's home-network address says whether the receiver,
    // on that network, can be handed it (`sendToCastFrame`'s `lanProven`). The cast page can't be the judge: a
    // cross-origin frame may be kept off the local network when this page is not.
    if (!('failure' in result) && castMode && castOffered && !result.external && result.castOrigin)
      await homeHere(result);
    const lanHere = !('failure' in result) && !castOffered && !castMode && (await homeHere(result));
    if (lanHere && !('failure' in result)) {
      // At home this page plays the home-network address itself rather than handing the session to the cast page:
      // a browser may keep that cross-origin frame off the local network (Brave does), which then plays from the
      // public address through the router. The session's controls are Remux's own there, as the cast page's are on
      // the public address; the relay passes none of them. The cast page stays for casting, and for a page that
      // can't reach the home network.
      const {
        castOrigin: _castOrigin,
        publicBase: _publicBase,
        speed: _speed,
        control: _control,
        ...here
      } = result;
      result = { ...here, playlist: result.lanPlaylist! };
      // No home upload sits between this page and den-remux here: a limit remembered from away doesn't apply.
      rememberLink(route, undefined);
      publicMaxBitrate = undefined;
    }
    if (startingSession === attempt) startingSession = undefined;
    // Another start (a retry and the key form, say) may have got there first.
    if (attempt.signal.aborted || ended || session !== (replacing ?? null)) {
      if (!('failure' in result)) endSession(result);
      return false;
    }
    if ('failure' in result) {
      // Only `startPlayback` adds this field, after its closed allow-list parser. Legacy Remux refusals do not.
      const cause = 'cause' in result ? (result.cause as PlaybackCause | undefined) : undefined;
      const retries =
        result.failure === 'busy' ||
        result.failure === 'starting' ||
        result.failure === 'transcode' ||
        result.failure === 'timedOut' ||
        result.failure === 'temporarilyUnavailable' ||
        cause === 'torbox_rate_limited';
      if (!retries) {
        const status = 'httpStatus' in result ? result.httpStatus : undefined;
        reportClientFailure({
          operation: 'session',
          kind:
            typeof status === 'number'
              ? 'http'
              : result.failure === 'timedOut'
                ? 'timeout'
                : result.failure === 'unreachable'
                  ? 'transport'
                  : result.failure === 'protocol' || result.failure === 'request'
                    ? 'protocol'
                    : 'other',
          outcome: replacing ? 'recovered' : 'terminal',
          route: playback ? 'content_service' : 'remux_session',
          status,
          generation: diagnosticGeneration,
          attempt: 1,
        });
      }
      playbackRouteLog({
        event: 'failed',
        requestedSource,
        reason: delivery,
        failure: routeFailure(result.failure),
        ...(cause ? { cause } : {}),
      });
      if (playback) {
        console.warn('Managed playback could not start.', {
          failure: result.failure,
          code: 'code' in result ? result.code : undefined,
          cause,
          httpStatus: 'httpStatus' in result ? result.httpStatus : undefined,
          retryMs: result.retryMs,
        });
      }
      if (replacing) {
        replacementRefusal = {
          code: 'code' in result && typeof result.code === 'string' ? result.code : undefined,
          cause,
        };
        // A failed external session is kept only long enough for `broke` to judge recovery; unlike an ordinary
        // Remux track/release change, it does not carry on. Keep the two log messages truthful and URL-free.
        if (delivery === 'direct') {
          console.warn(`TorBox could not start (${result.failure}); Den Remux carries on.`);
          // Refused with no TorBox failure behind it: Hearth had no TorBox to try (den-hearth answers
          // `direct_unavailable` bare then). A cause that won't pass rules it out as well; any other may.
          const why =
            torboxRuledOut(cause) ??
            ('code' in result && result.code === 'direct_unavailable' && !cause
              ? NO_TORBOX
              : undefined);
          if (why) torbox = { unavailable: why };
        } else if (replacing.external)
          console.warn(`Managed direct media recovery failed (${result.failure}).`);
        else
          console.warn(
            `den-remux refused a mid-film change (${result.failure}); the playing session carries on.`,
          );
        if (
          result.failure === 'busy' ||
          result.failure === 'starting' ||
          result.failure === 'transcode' ||
          result.failure === 'timedOut' ||
          result.failure === 'temporarilyUnavailable' ||
          cause === 'torbox_rate_limited'
        ) {
          const retryMessage = automaticRetryNotice(result.failure, cause);
          retry = setTimeout(
            () => void begin(pick, extra, replacing, delivery, retryMessage, compatibleSubtitles),
            result.retryMs ?? RETRY_MS,
          );
        }
        return result.failure;
      }
      managedCause = cause;
      skippedFormats = 'formats' in result ? ((result.formats as string[] | undefined) ?? []) : [];
      // Everything left earlier in the visit leaves nothing to start on: those are only kept off an automatic
      // pick while there is another to make, so the start is asked for again with none left out.
      if ((result.failure === 'none' || result.failure === 'noCopy') && excluded.length) {
        excluded = [];
        keepReleases();
        return begin(
          pick,
          extra,
          undefined,
          delivery,
          'The remaining releases did not work—trying the full list…',
          compatibleSubtitles,
        );
      }
      failure = result.failure;
      if (
        result.failure === 'busy' ||
        result.failure === 'starting' ||
        result.failure === 'transcode' ||
        result.failure === 'timedOut' ||
        result.failure === 'temporarilyUnavailable' ||
        cause === 'torbox_rate_limited'
      ) {
        // What the server asked for, when it said: a converting GPU can mean minutes, and knocking every
        // twenty seconds until then is work for a box that is already the reason we are waiting.
        const retryMessage = automaticRetryNotice(result.failure, cause);
        retry = setTimeout(
          () => void begin(pick, extra, undefined, delivery, retryMessage, compatibleSubtitles),
          result.retryMs ?? RETRY_MS,
        );
      }
      if (
        !compatibleSubtitles &&
        retry === undefined &&
        pendingDirectSubtitleRestore !== undefined
      ) {
        subtitleChoice = pendingDirectSubtitleRestore;
        pendingDirectSubtitleRestore = undefined;
      }
      return false;
    }
    result = {
      ...result,
      subtitles: displayedSubtitleTracks(result.subtitles ?? []),
    };
    // A managed direct result is already a signed media capability. Keep Hearth as the delivery selector, then hand
    // only that URL to the trusted Cast page that found the receiver; no Den grant, cookie, or API credential follows.
    // A Remux session's own cast page is that same trusted page; naming the one the receiver was chosen in keeps its
    // frame, and the Cast session in it.
    if (
      castOffered &&
      directCastOrigin &&
      (result.external || privateLanRemuxPlaylist(result.playlist) || result.castOrigin)
    )
      result = { ...result, castOrigin: directCastOrigin };
    const replacingWasPlaying = replacing ? !!video && !video.paused : false;
    // After the first play `playing()` retires the one-shot autoplay flag. A new episode can reuse this component
    // and element without being a `replacing` session, so it too needs an explicit start. A true replacement follows
    // the outgoing element's actual state, preserving a deliberate pause.
    const shouldPlayWhenMounted = replacing ? replacingWasPlaying : video?.autoplay === false;
    if (replacing) {
      // The new session is in hand: only now is the one playing let go.
      watcher?.stop();
      watcher = undefined;
      hls?.destroy();
      hls = undefined;
      endSession(replacing);
      // The one it replaces may have failed (another release picked after "couldn't play"): the video comes back.
      failure = null;
    }
    started = at;
    askedMaxBitrate = maxBitrate;
    played = false;
    awaitingPress = false;
    // A switch keeps the early window it was made in: the time already played counts, or every switch would open
    // another thirty seconds for the next. Folded in now, while `video` is still showing the session being
    // replaced — the session effect below is about to reassign `element.src` (or hls.js's `loadSource` /
    // `attachMedia`), which resets this same `<video>`'s own `played` ranges to nothing.
    if (replacing) playedSecs += video ? playedSecondsOf(video.played) : 0;
    else playedSecs = 0;
    lastPosition = undefined;
    // Each session is judged on its own delivery: nothing measured of the one it replaces says anything of this one.
    meter = new DeliveryMeter();
    delivered = { bytes: 0, demand: 0 };
    deliveryGaveUp = false;
    struggling = null;
    slowPick = null;
    stallCount = 0;
    stalledMs = 0;
    stallSince = undefined;
    hold = result.prebuffer ? new PrebufferHold(result.prebuffer, performance.now()) : null;
    startsIn = null;
    // For the startup timing line (den-edge#234's "Findings"), logged once this session's first frame arrives.
    // `Date.now()` throughout (`startupAskedAt`'s own clock), never mixed with `performance.now()`'s epoch.
    startupTimings.set(result, { askedAt: startupAskedAt, answeredAt: Date.now() });
    castSubtitlePreparing = result.external === true && subtitleChoice !== null;
    subtitleSelectionGeneration += 1;
    subtitleLoadFailure = null;
    session = result;
    directWithoutDenSubtitles = result.external === true && !compatibleSubtitles;
    if (!compatibleSubtitles) pendingDirectSubtitleRestore = undefined;
    playbackRouteLog({
      event: 'selected',
      source: result.external ? 'torbox' : 'den_remux',
      requestedSource,
      subtitleConstraint: compatibleSubtitles ? 'allowed' : 'den_subtitles_disabled',
      ...(result.external
        ? {
            embeddedSubtitles: result.subtitles?.some((track) => track.torboxTrack !== undefined)
              ? ('available' as const)
              : ('none' as const),
          }
        : {}),
    });
    playWhenMounted = shouldPlayWhenMounted ? session : null;
    directAttempt = result.external
      ? delivery === 'ordinary' || delivery === 'direct'
        ? 'initial'
        : 'refreshed'
      : null;
    if (result.external) torbox = 'offered';
    else if (result.directFailure) {
      const why = torboxRuledOut(result.directFailure);
      torbox = why ? { unavailable: why } : 'offered';
    }
    // Hearth would have tried TorBox first, and answered Remux without a word of one that failed: it has none.
    else if (torboxTried && torbox !== 'offered') torbox = { unavailable: NO_TORBOX };
    sessionRoute = on;
    // Played from the home network but asked under a limit remembered from away: asked again without it, as the cast
    // page's `den-lan` has it.
    if (lanHere && maxBitrate !== undefined && extra.maxBitrate === undefined) {
      castSubtitlePreparing = false;
      restartForRecovery('Home network found—reopening…', releaseAfterMeasure(chosenRelease));
      return true;
    }
    // A viewer who never set Settings' subtitle language still gets one where it earns its place: their own
    // first, or English, never overriding a choice already made. Only on the title's first session — a later
    // switch (`replacing`) keeps whatever is already showing, auto-picked or turned off by hand. Not on a TorBox
    // stream whose subtitles the system player could not show (`subtitlesNeedPlaylist`): the menu says Off rather
    // than name one that never appears, and choosing one there moves to Den Remux.
    if (
      !replacing &&
      compatibleSubtitles &&
      subtitleLanguage === undefined &&
      subtitleChoice === null &&
      !(result.external && subtitlesNeedPlaylist())
    ) {
      // A TorBox stream names no audio track: what it plays is the release's default, the title's original language
      // as far as can be told. Without it, a title in the viewer's own language came up with subtitles on.
      subtitleChoice = autoSubtitleLanguage(
        result.audioTracks[result.audioTrack]?.language ?? title.originalLanguage,
        [interfaceLanguage],
        result.subtitles ?? [],
      );
    }
    // Settings and auto-pick name a language; the picker names a concrete candidate. Prefer the first offered
    // full candidate (TorBox embeds precede OpenSubtitles), never a forced-only track merely because it came first,
    // and keep an exact manual identity across same-language alternatives.
    if (subtitleChoice) {
      const picked =
        preferredSubtitleTrack(result.subtitles ?? [], subtitleChoice) ??
        (replacingSubtitleLanguage
          ? preferredSubtitleTrack(result.subtitles ?? [], replacingSubtitleLanguage)
          : undefined);
      subtitleChoice = picked ? subtitleValue(picked) : null;
    }
    const selectedTorBoxTrack = selectedSubtitle(result)?.torboxTrack;
    if (
      result.external &&
      selectedTorBoxTrack !== undefined &&
      result.torboxSubtitle !== selectedTorBoxTrack
    ) {
      // The first managed request discovers TorBox's embedded tracks; a language preference can only be resolved
      // after that answer. TorBox burns one chosen track into a newly created stream, so create that stream now
      // instead of merely naming a track the first, subtitle-free URL does not carry.
      // Read the assigned state back: Svelte proxies objects stored in `$state`, and replacement identity checks
      // must compare that proxy with itself rather than with the raw response object assigned above.
      const discovered = session;
      const preparing = showTransition('Preparing subtitles…');
      const moved = await begin(
        { filename: result.release.filename, subtitleTrack: selectedTorBoxTrack },
        extra,
        discovered,
        'direct',
      );
      if (moved !== true && session === discovered) {
        clearTransition(preparing);
        subtitleChoice = null;
        castSubtitlePreparing = false;
      }
      return moved;
    }
    // `session`, the player's own reactive copy of `result`: what `loadExternalSubtitle` checks it is still playing,
    // and whose `<track>` list renders. Handed `result` itself, it never matched, and the auto-picked subtitle the menu
    // named was never loaded.
    if (session && subtitleChoice) {
      const loadingSession = session;
      const loadingValue = subtitleChoice;
      const loadingTrack = selectedSubtitle(loadingSession, loadingValue);
      if (
        (loadingTrack?.delivery === 'sidecar' || loadingTrack?.source === 'opensubtitles') &&
        loadingSession.loadExternalSubtitle &&
        !loadingSession.externalSubtitles?.some((track) => track.value === loadingValue)
      ) {
        const selectionGeneration = ++subtitleSelectionGeneration;
        const ownsLoad = () =>
          session === loadingSession &&
          subtitleChoice === loadingValue &&
          selectionGeneration === subtitleSelectionGeneration;
        const loaded = await loadExternalSubtitle(loadingSession, loadingValue, ownsLoad);
        const fallback = loadingTrack.fallbackTorboxTrack;
        if (!loaded && ownsLoad() && fallback !== undefined) {
          const preparing = showTransition('Subtitles failed—trying built-in…');
          const moved = await begin(
            { filename: loadingSession.release.filename, subtitleTrack: fallback },
            extra,
            loadingSession,
            'direct',
          );
          if (moved !== true) clearTransition(preparing);
          return moved;
        }
        if (!loaded && ownsLoad()) {
          subtitleChoice = null;
          subtitleLoadFailedFlag = true;
          subtitleLoadFailure = loadingTrack;
          applySubtitles();
          sendSubtitleChoice();
        }
      }
    }
    castSubtitlePreparing = false;
    // Kept past a `letGo`/`session = null` the same way `sessionRoute` already is: den-edge's own outcome report
    // (`finish()`) names the last session's subtitle source even when the player closes between sessions.
    lastSubtitleSource = result.subtitleSource;
    // Another release is another encode, whose intro and credits sit at other times: its own are asked for.
    if (result.release.filename !== segmentsOf) {
      segments = [];
      active = null;
      askedFor = 0;
    }
    // Moved to cast, but the relay's session has no public address or cast page: nothing can be cast from it, and
    // it would not play here either. Back to the player that was playing.
    if (castOffered && !result.castOrigin) {
      leaveCast();
      castNotice = { text: 'This can’t be cast from here right now. It’s playing here again.' };
      return true;
    }
    // A mid-film replacement names itself through `switchAway`'s own `autoSwitch`, not through this: `swapNotice`
    // is for a pick that didn't open what was asked for, which `replacing` is not.
    if (!replacing)
      swapped = swapNotice(
        pick?.filename,
        result,
        (name) => releases.find((r) => r.filename === name)?.label ?? name,
      );
    return true;
  }

  /**
   * Move the playing session to another release that plays copied, from the second it is at (`switchPolicy`): for a
   * decoder that can't go on, narrowing what this browser claims; for a link that can't carry this one, one that fits
   * the rate it is really getting. Never a transcode, and the release playing now keeps playing until the other has
   * started — or for good, where none will do. True when it moved, and den-remux's refusal when it refused.
   *
   * Named as it happens (`autoSwitch`, den-edge#275): the viewer sees why, and — once `releases` has loaded
   * enough to say — where this attempt stands among the releases on offer, rather than the picture just
   * pausing with nothing said about it.
   */
  async function switchAway(
    reason: 'decode' | 'delivery',
    rate?: number,
  ): Promise<boolean | Failure> {
    const current = session;
    if (!current || switching) return false;
    // For delivery, only a copy lighter than this one by its real bitrate — never by a label, which can name a whole
    // season pack — and none at all where this one's bitrate isn't known.
    const ask = switchAsk(reason, current.release.filename, excluded, {
      rate,
      bitrate: averageBitrate(current.segments, current.duration, current.release.size),
    });
    if (!ask) return 'noFit';
    switching = true;
    const fromLabel = current.release.label;
    autoSwitch = autoSwitchNotice(
      reason,
      fromLabel,
      excluded.length + 1,
      releases.length || undefined,
    );
    try {
      if (reason === 'decode') degraded = true;
      const at = video?.currentTime ?? remoteTime;
      const total = length();
      if (total && at >= 1) startAt = { seconds: at, fraction: at / total };
      let moved: boolean | Failure;
      try {
        const delivery = current.external ? 'direct' : 'fallback';
        const compatibleSubtitles = !current.external || !directWithoutDenSubtitles;
        moved = await begin(undefined, ask, current, delivery, null, compatibleSubtitles);
      } catch (error) {
        // A request a suspended page never got the answer to (an iPhone's tab put in the background): the session
        // playing carries on, as for any refusal.
        console.warn('A switch to another release got no answer; this one carries on.', error);
        moved = false;
      }
      if (moved === true) {
        leave(current.release.filename);
        switchCount += 1;
        lastSwitchReason = reason;
        autoSwitch = autoSwitchedNotice(
          reason,
          fromLabel,
          session?.release.label ?? 'another release',
        );
      } else {
        startAt = null;
        autoSwitch = null;
      }
      return moved;
    } finally {
      switching = false;
    }
  }

  /**
   * What the playing session's delivery says (`Delivery`). hls.js gives every fragment's bytes and timing, weighed
   * against what den-remux said the copy asks (`waitAt`). A native player gives neither — only how far its buffer
   * reaches, which stands still between its bursts of fetching while it is ahead, so a rate read from it is its own
   * pacing — and is judged on the stalls it sat through instead.
   */
  function deliveryOf(current: Session, element: HTMLVideoElement): Delivery | null {
    if (!hls) {
      const open = stallSince === undefined ? 0 : performance.now() - stallSince;
      return { kind: 'stalls', stalls: stallCount, stalledSecs: (stalledMs + open) / 1000 };
    }
    if (!current.segments) return null;
    const total = length();
    const buffered = element.buffered;
    const reach = buffered.length ? buffered.end(buffered.length - 1) : element.currentTime;
    const live = meter.rate();
    if (!live) return null;
    // What den-remux said it sends, scaled by the share of it that came for the fragments loaded so far.
    const demand = scaleDemand(current.segments, delivered);
    return {
      kind: 'delivery',
      wait: waitAt(demand, total, element.currentTime, reach, live.bitsPerSecond),
      measuredMs: live.spanMs,
      aheadSecs: aheadIn(buffered, element.currentTime),
    };
  }

  /**
   * Weigh the link as it is delivering against what the playing copy asks of it (`shouldSwitch`), and move early to a
   * lighter one it carries when even a viewer's wait wouldn't do. Past the early window, or with nothing lighter that
   * fits, it plays on. The viewer's own pick is never moved: they are told it can't keep up, and offered another.
   */
  function weighDelivery() {
    const current = session;
    const element = video;
    if (!current || !element || switching || deliveryGaveUp || castMode) return;
    // A connection that is down delivers nothing, and a hidden page's player fetches nothing: neither is a verdict on
    // what this release asks of the link.
    if (link?.down || document.visibilityState === 'hidden') return;
    const delivery = deliveryOf(current, element);
    if (!delivery) return;
    if (current.release.filename === chosenRelease) {
      if (!slowPick && tooSlow(delivery, played)) slowPick = current.release.label;
      return;
    }
    if (!shouldSwitch(delivery, { playedSecs: totalPlayedSecs(), shownFrame: played })) return;
    const rate = delivery.kind === 'delivery' ? meter.rate()?.bitsPerSecond : undefined;
    void switchAway('delivery', rate).then((moved) => gaveUp(current, moved));
  }

  /**
   * After a delivery switch that didn't move: this release plays on, and delivery is not weighed again. Only where no
   * lighter copy fits is the viewer told that is why it pauses; a den-remux out of reach or busy said nothing about
   * the link.
   */
  function gaveUp(current: Session, moved: boolean | Failure) {
    if (moved === true || session !== current) return;
    deliveryGaveUp = true;
    struggling = typeof moved !== 'string' || nothingFits(moved) ? current.release.label : null;
  }

  /** The viewer's "Try another release" on their own pick that can't keep up: a lighter one, as any delivery switch. */
  function tryAnother() {
    const current = session;
    if (!current) return;
    slowPick = null;
    chosenRelease = undefined;
    keepReleases();
    const rate = hls ? meter.rate()?.bitsPerSecond : undefined;
    void switchAway('delivery', rate).then((moved) => gaveUp(current, moved));
  }

  /**
   * Let this browser's address in to the public media listener again, for the session it plays (`reassertGrant`): its
   * address may have changed while the connection was down. Asked at most every REGRANT_MS, however many segments are
   * waiting on it.
   */
  function regrant(current: Session): Promise<void> {
    const now = performance.now();
    if (!current.publicBase || session !== current || now - regrantedAt < REGRANT_MS)
      return Promise.resolve();
    regrantedAt = now;
    return reassertGrant(current, scout.install, undefined, sessionRoute ?? route).then(
      () => undefined,
    );
  }

  /** The session is gone — ended by den-remux, or out of reach for too long: say so, and offer to pick up at `at`. */
  function lose(at: number) {
    if (!session || failure) return;
    lostAt = at;
    reconnecting = false;
    report();
    failure = 'lost';
  }

  /** `1:02:03`, or `2:03` under an hour. */
  function clockTime(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    const [h, m, sec] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
    const two = (n: number) => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
  }

  /** The viewer's Resume after `lose`: a new session of the same release, from the second it had got to. */
  function resumeLost() {
    const current = session;
    if (!current) return;
    const total = length() || current.duration;
    // Zero is a deliberate resume position too. `null` means fall back to the library's original resume, which
    // would make a "Resume from 0:00" action jump forward again after the viewer had sought back to the start.
    startAt = { seconds: lostAt, fraction: total ? lostAt / total : 0 };
    watcher?.stop();
    watcher = undefined;
    hls?.destroy();
    hls = undefined;
    endSession(current);
    session = null;
    showTransition('Resuming…');
    void begin({ filename: current.release.filename });
  }

  async function letIn(event: SubmitEvent) {
    event.preventDefault();
    const pending = showTransition('Checking key…');
    failure = null;
    const ok = await login(key.trim(), undefined, route);
    badKey = ok === false;
    if (!ok) {
      clearTransition(pending);
      failure = ok === null ? 'unreachable' : 'login';
      return;
    }
    key = '';
    continueManualSwitch(pending, 'Opening playback…');
    void begin();
  }

  function tryAgain() {
    showTransition('Retrying playback…');
    void begin();
  }

  $effect(() => {
    const [current, element] = [session, video];
    if (!current || current.castOrigin || !element) return;
    const resumeIfReplaced = () => {
      if (playWhenMounted !== current) return;
      playWhenMounted = null;
      // A held start has its own readiness boundary and resumes there.
      if (hold || !element.paused) return;
      void element
        .play()
        .catch((error: unknown) =>
          console.warn(
            'The replacement stream could not resume on its own; its controls can.',
            error,
          ),
        );
    };
    // LG's webOS media pipeline accepts HLS even when its WebKit canPlayType answer is incomplete.
    // Keeping it on this element path preserves Den's existing progress, recovery and session ownership.
    const playsNatively = samsungAvplay || webOsNative || nativeHls(element);
    // A browser that can't decode what it was sent doesn't always say so: Safari strikes out its play button and
    // fires nothing. Given no source it can use, or trying to play with no picture yet, after a while is that — a
    // while with nothing arriving, since a slow link shows no picture either but keeps delivering (`stuckWatch`).
    // The bytes hls.js has had: its finished fragments', and the one loading as far as it has come.
    let finished = 0;
    let loading: { loaded: number } | undefined;
    const arrived = () => finished + (loading?.loaded ?? 0);
    /**
     * The live "Buffering…" line's own data (den-edge#234: never a bare spinner) — hls.js gives real bytes and,
     * once `meter` has a sample, a rate; native HLS has no loader to read bytes from, only `buffered` seconds.
     * Also where this attempt's first-segment time is caught, the first time either says something arrived.
     */
    const updateProgress = () => {
      if (played) return;
      const timing = startupTimings.get(current);
      if (hls) {
        const bytesLoaded = arrived();
        if (bytesLoaded <= 0) return;
        if (timing && timing.firstSegmentAt === undefined) timing.firstSegmentAt = Date.now();
        bufferProgress = {
          bytesLoaded,
          bytesTarget: current.segments?.[0]?.[1],
          bitsPerSecond: meter.rate()?.bitsPerSecond,
        };
      } else {
        const bufferedSecs = aheadIn(element.buffered, 0);
        if (bufferedSecs <= 0) return;
        if (timing && timing.firstSegmentAt === undefined) timing.firstSegmentAt = Date.now();
        bufferProgress = { bufferedSecs };
      }
    };
    // A connection that went away is waited out, not taken for a browser that can't play: the watchdog, the
    // switching policy and hls.js's fatal path all leave it alone, and the viewer sees "Reconnecting…" over the held
    // frame once the buffer runs out. Playback carries on from the same second, on the same session, when it is back.
    const connection = (link = new Link());
    if (current.publicBase) connection.beforeRetry = () => regrant(current);
    let watching: ReturnType<typeof setInterval> | undefined;
    const showReconnecting = () => {
      reconnecting =
        connection.down && aheadIn(element.buffered, element.currentTime) < RECONNECT_AHEAD_SECS;
    };
    const unsubscribe = connection.subscribe((down) => {
      clearInterval(watching);
      showReconnecting();
      if (down) watching = setInterval(showReconnecting, 250);
      // What arrived before the connection went is no measure of the link it came back on.
      else meter = new DeliveryMeter();
    });
    const stuck = stuckWatch(
      STUCK_MS,
      () => {
        if (connection.down) {
          stuck.progress();
          return;
        }
        const noSource = element.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
        const why = `no picture after ${STUCK_MS / 1000} s with nothing arriving (readyState ${element.readyState}, networkState ${element.networkState})`;
        if (noSource) {
          void broke(element.error?.code ?? 0, why, 'format', 'stuck');
          return;
        }
        // No picture: no frame presented yet (`played`), whatever `readyState` claims — some WebViews lose the frame
        // callback and show nothing over data they have.
        if (element.paused || (played && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA))
          return;
        // Nothing arriving and no picture is a refusal only where den-remux has the segment ready to send: one it is
        // still making — a slow source behind it — is a slow start, waited out with the startup line showing.
        void segmentAnswer(current, stalledAt(), fetch, SEGMENT_ASK_MS).then((answer) => {
          if (session !== current || failure || played) return;
          const ready = answer && answer.status < 300 && answer.ms < SEGMENT_READY_MS;
          if (ready || answer?.status === 502)
            void broke(element.error?.code ?? 0, why, 'format', 'stuck');
          else stuck.progress();
        });
      },
      arrived,
    );
    // Bytes arriving: the element's own fetches (a native player's `progress`), and hls.js's fragments (below). Each
    // is also a moment to weigh the link as it is delivering against what this release asks of it.
    const arriving = () => {
      stuck.progress();
      weighDelivery();
      updateProgress();
    };
    element.addEventListener('progress', arriving);
    const loaded = () => element.removeEventListener('progress', arriving);
    element.addEventListener('loadeddata', loaded, { once: true });
    const cleanup = () => {
      stuck.stop();
      loaded();
      element.removeEventListener('loadeddata', loaded);
    };
    /**
     * A stall once a frame has already shown (den-edge#275): `weighDelivery`'s early switch covers the first
     * EARLY_WINDOW_SECS on its own `progress` events; this is what the viewer sees meanwhile, and what is left
     * once that window has passed or nothing else fits. `stallTimer` refreshes `stallProgress` on its own
     * clock since a stall, by definition, fires neither `progress` nor `timeupdate`.
     */
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const updateStallProgress = () => {
      stallProgress = {
        bufferedSecs: aheadIn(element.buffered, element.currentTime),
        // hls.js's fragments say what the link gives; a native player's buffer says only how far it reaches.
        bitsPerSecond: hls ? meter.rate()?.bitsPerSecond : undefined,
      };
      // A stall fires nothing else to weigh delivery on, and the stalls are a native player's whole evidence.
      weighDelivery();
    };
    // Counted for `deliveryOf` while the page is seen: one hidden fetches nothing, and is waited on by no one.
    const endStall = () => {
      if (session === current && stallSince !== undefined)
        stalledMs += performance.now() - stallSince;
      if (session === current) stallSince = undefined;
    };
    let nativeExpiryProbe: AbortController | undefined;
    const probeNativeExpiry = async () => {
      if (nativeExpiryProbe || current.publicBase) return;
      const probe = new AbortController();
      nativeExpiryProbe = probe;
      const answer = await segmentAnswer(current, stalledAt(), (input, init) => {
        const deadline = init?.signal;
        return fetch(input, {
          ...init,
          signal: deadline ? AbortSignal.any([deadline, probe.signal]) : probe.signal,
        });
      });
      if (
        nativeExpiryProbe !== probe ||
        session !== current ||
        failure ||
        !stalling ||
        document.visibilityState === 'hidden'
      )
        return;
      if (answer?.status === 410) lose(element.currentTime || lastPosition || 0);
      else nativeExpiryProbe = undefined;
    };
    const onStallWaiting = () => {
      // A background tab and a deliberately paused player are waited on by nobody. In particular, do not leave the
      // 500 ms progress clock running after WebKit reports `waiting` while it suspends hidden media.
      if (!played || element.paused || element.seeking || document.visibilityState === 'hidden')
        return;
      stalling = true;
      if (stallSince === undefined) {
        stallCount += 1;
        stallSince = performance.now();
      }
      updateStallProgress();
      clearInterval(stallTimer);
      stallTimer = setInterval(updateStallProgress, 500);
      if (__DEN_TV__ && playsNatively) void probeNativeExpiry();
    };
    const onStallResume = () => {
      if (__DEN_TV__) {
        nativeExpiryProbe?.abort();
        nativeExpiryProbe = undefined;
      }
      endStall();
      stalling = false;
      clearInterval(stallTimer);
      stallTimer = undefined;
      stallProgress = undefined;
    };
    // WebKit can suspend without a matching media event. Clear both stall clocks on the way out; on the way back,
    // restart from what the element says now rather than retaining a hidden-page `stalling` bit that prevents the
    // native head watch from observing the stall again.
    let headAt = element.currentTime;
    let headMovedAt = performance.now();
    let headWatch: ReturnType<typeof setInterval> | undefined;
    const stopHeadWatch = () => {
      clearInterval(headWatch);
      headWatch = undefined;
    };
    const startHeadWatch = () => {
      if (
        !playsNatively ||
        headWatch !== undefined ||
        element.paused ||
        element.seeking ||
        element.ended ||
        document.visibilityState === 'hidden'
      )
        return;
      headAt = element.currentTime;
      headMovedAt = performance.now();
      headWatch = setInterval(() => {
        const now = performance.now();
        const moved = Math.abs(element.currentTime - headAt) > HEAD_MOVED_SECS;
        if (moved) {
          headAt = element.currentTime;
          headMovedAt = now;
          if (stalling) onStallResume();
          return;
        }
        if (!stalling && now - headMovedAt >= HEAD_STILL_MS) onStallWaiting();
      }, 250);
    };
    const stopCounting = () => {
      if (
        element.paused ||
        element.seeking ||
        element.ended ||
        document.visibilityState === 'hidden'
      ) {
        onStallResume();
        stopHeadWatch();
        return;
      }
      headAt = element.currentTime;
      headMovedAt = performance.now();
      startHeadWatch();
      if (played && element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) onStallWaiting();
    };
    const onPlaying = () => {
      onStallResume();
      startHeadWatch();
    };
    element.addEventListener('waiting', onStallWaiting);
    element.addEventListener('playing', onPlaying);
    element.addEventListener('pause', stopCounting);
    element.addEventListener('seeking', stopCounting);
    element.addEventListener('seeked', stopCounting);
    element.addEventListener('ended', stopCounting);
    document.addEventListener('visibilitychange', stopCounting);
    // WebKit's own player can stop with nothing to show and fire no `waiting`, and resume without `playing`: the play
    // head standing still while nothing paused, sought or ended it is a stall all the same, and moving again ends one.
    // hls.js already supplies `waiting`/`playing` and fragment progress; polling it four times a second adds no
    // evidence. Keep the fallback strictly on the native path while it is actually playing and visible.
    // The real first frame (den-edge#234's step 0 and the owner's own correction: not `canplay`, which iOS
    // native HLS can fire tens of seconds late). `requestVideoFrameCallback` fires once a frame has actually
    // been presented; a browser without it (older Safari) falls back to `loadeddata`, as this did before.
    let cancelVideoFrame: (() => void) | undefined;
    let cancelLoadedFrame: (() => void) | undefined;
    const initialQuality = element.getVideoPlaybackQuality?.();
    const totalAtStart = initialQuality?.totalVideoFrames ?? 0;
    const droppedAtStart = initialQuality?.droppedVideoFrames ?? 0;
    const cancelFirstFrame = () => {
      cancelVideoFrame?.();
      cancelVideoFrame = undefined;
      cancelLoadedFrame?.();
      cancelLoadedFrame = undefined;
      element.removeEventListener('timeupdate', firstFrameFromProgress);
    };
    const firstFrame = () => {
      cancelFirstFrame();
      if (session !== current || played) return;
      played = true;
      clearTransition();
      cleanup();
      bufferProgress = undefined;
      clearInterval(noticeTimer);
      // den-edge#234's step 0: how long this session took to open, hold and reach its first frame, reported to
      // den-edge's own request log (`startupReport.ts`) — never to the console, and never a title or a URL.
      const timing = startupTimings.get(current);
      if (timing) {
        const firstFrameAt = Date.now();
        const engine = playsNatively ? 'native' : 'hls.js';
        const subtitleIndex = current.subtitles?.findIndex(
          (track) => subtitleValue(track) === subtitleChoice,
        );
        sendStartupReport({
          sessionMs: Math.round(timing.answeredAt - timing.askedAt),
          ...parseServerTiming(current.startupTiming),
          firstSegmentMs: Math.round((timing.firstSegmentAt ?? firstFrameAt) - timing.askedAt),
          firstFrameMs: Math.round(firstFrameAt - timing.askedAt),
          bytesLoaded: engine === 'hls.js' ? Math.round(arrived()) : undefined,
          size: sizeBucket(current.release.size),
          codec: knownCodec(current.video?.codec),
          transcoded: current.video?.transcoded === true,
          player: engine,
          route: routeKind(sessionRoute ?? route),
          ...identityOf(
            title,
            season,
            episode,
            {
              release: current.release,
              audioTrack: current.audioTrack,
              audioLanguage: current.audioTracks[current.audioTrack]?.language,
            },
            {
              index: subtitleIndex,
              language: selectedSubtitleLanguage(current) ?? undefined,
              source: subtitleSourceOf(
                current.subtitleSource === 'den_subtitles',
                subtitleChoice !== null,
              ),
            },
          ),
        });
      }
    };
    // Some WebViews expose rVFC but lose its callback. A moving clock and loaded data are not enough (audio can move
    // under a broken picture), so this fallback requires the browser's count of non-dropped video frames. With no
    // such presentation proof the startup watchdog above stays armed and fails over instead of hiding a blank image.
    const firstFrameFromProgress = () => {
      const quality = element.getVideoPlaybackQuality?.();
      if (!quality) return;
      // Implementations differ on whether changing `src` resets these element counters. Compare with this source's
      // baseline when they remain cumulative, and with zero once either counter proves it reset.
      const reset =
        quality.totalVideoFrames < totalAtStart || quality.droppedVideoFrames < droppedAtStart;
      const presentedAtStart = reset ? 0 : totalAtStart - droppedAtStart;
      if (quality.totalVideoFrames - quality.droppedVideoFrames > presentedAtStart) firstFrame();
    };
    element.addEventListener('timeupdate', firstFrameFromProgress);
    // The type is unconditional (every modern lib.dom.d.ts has it); the browser isn't — an older Safari lacks
    // the method at runtime, hence the `typeof` check rather than `'requestVideoFrameCallback' in element`. webOS's
    // Chromium advertises it too, but its native media pipeline never calls it (nor updates playback-quality frame
    // counters): `loadeddata` is the platform's usable picture-ready boundary, as AVPlay's synthetic element uses.
    if (!samsungAvplay && !webOsNative && typeof element.requestVideoFrameCallback === 'function') {
      const id = element.requestVideoFrameCallback(firstFrame);
      cancelVideoFrame = () => element.cancelVideoFrameCallback(id);
    } else {
      element.addEventListener('loadeddata', firstFrame, { once: true });
      cancelLoadedFrame = () => element.removeEventListener('loadeddata', firstFrame);
    }
    const reportUrl = current.external
      ? undefined
      : (current.control?.report ?? reportUrlOf(current.playlist));
    const stopWatching = () => {
      if (__DEN_TV__) {
        nativeExpiryProbe?.abort();
        nativeExpiryProbe = undefined;
      }
      cleanup();
      cancelFirstFrame();
      watcher?.stop();
      watcher = undefined;
      unsubscribe();
      clearInterval(watching);
      endStall();
      stopHeadWatch();
      clearInterval(stallTimer);
      stallTimer = undefined;
      stalling = false;
      stallProgress = undefined;
      element.removeEventListener('waiting', onStallWaiting);
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('pause', stopCounting);
      element.removeEventListener('seeking', stopCounting);
      element.removeEventListener('seeked', stopCounting);
      element.removeEventListener('ended', stopCounting);
      document.removeEventListener('visibilitychange', stopCounting);
      connection.dispose();
      if (link === connection) link = undefined;
      reconnecting = false;
    };
    playedEngine = playsNatively ? 'native' : 'hls.js';
    if (samsungAvplay) {
      let gone = false;
      let mounted: SamsungAvplayAdapter | undefined;
      const starting = import('../tv/player/avplay').then(({ mountSamsungAvplay }) => {
        if (gone || ended || session !== current) return;
        mounted = mountSamsungAvplay({
          element,
          url: current.playlist,
          audioTrack: current.audioTrack,
          subtitleLanguage: subtitleChoice,
        });
        avplay = mounted;
        watcher = watchPlayback({ video: element, reportUrl });
        return mounted.start();
      });
      void starting.catch((error: unknown) => {
        console.warn('Samsung AVPlay could not be started.', error);
        if (gone || ended || session !== current || failure || breaking) return;
        failure = 'engine';
        letGo();
      });
      return () => {
        gone = true;
        stopWatching();
        mounted?.destroy();
        if (avplay === mounted) avplay = undefined;
      };
    }
    if (playsNatively) {
      element.src = current.playlist;
      resumeIfReplaced();
      const mounted = element.src;
      watcher = watchPlayback({ video: element, reportUrl });
      return () => {
        stopWatching();
        // Removing a native HLS element does not empty it in WebKit: retained after unmount it remains LOADING with
        // its playlist selected. Release that decoder/network resource, but never clear a newer session which has
        // already reused the same element.
        if (element.src !== mounted) return;
        element.textTracks.onaddtrack = null;
        element.pause();
        element.removeAttribute('src');
        element.load();
      };
    }
    // The engine this run made. A failure unmounts the element with the session unchanged, and nothing else would
    // stop it loading into a video that is no longer there.
    let gone = false;
    let engine: Hls | undefined;
    const starting = import('hls.js').then(({ default: Hls }) => {
      if (gone || ended || session !== current) return;
      if (!Hls.isSupported()) {
        // Nothing this browser is offered will play, so the session den-remux holds for it goes now, not at close.
        failure = 'unsupported';
        letGo();
        return;
      }
      hls = engine = new Hls(hlsConfig(started, 'page', current.external ? undefined : connection));
      // A request starting is no progress; its bytes, counted as they come in (`arrived`), are.
      hls.on(Hls.Events.FRAG_LOADING, (_event, data) => {
        if (data.frag.type !== 'subtitle') loading = data.frag.stats;
      });
      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        if (data.frag.type === 'subtitle') return;
        const stats = (data.part ?? data.frag).stats;
        const bytes = stats.loaded || stats.total;
        finished += bytes;
        loading = undefined;
        // The link's time is from the first byte to the last: before it, den-remux was making the segment. A transfer
        // that broke and was resumed spans the outage too, which says nothing about the link's rate.
        if (!wasInterrupted(stats)) meter.add(stats.loading.end, bytes, stats.loading.first);
        // What came against what den-remux said it would send for the same stretch (`deliveredShare`).
        delivered.bytes += bytes;
        if (session?.segments)
          delivered.demand += bytesBetween(
            session.segments,
            length(),
            data.frag.start,
            data.frag.start + data.frag.duration,
          );
        arriving();
      });
      // What hls.js got from den-remux is a better account of the link than the probe was: the next session asks
      // for no more than that.
      watcher = watchPlayback({
        video: element,
        hls: { instance: hls, Hls },
        reportUrl,
        // Bound to this route and session now: both can change before the watcher stops.
        onEstimate: current.external ? undefined : estimateToLink(route, playedSession(current)),
      });
      // A fatal media error is sometimes just a decoder that lost its place, which hls.js can reset the buffer and
      // carry on from. Try that once per session; a second one is a real refusal, and the session moves to a copy
      // this browser does decode (`switchAway`).
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.frag?.type === 'subtitle') {
          subtitleLoadFailedFlag = true;
          console.warn(
            `[Den subtitles] ${JSON.stringify({
              event: 'hls-error',
              details: data.details,
              fatal: data.fatal,
              httpStatus: data.response?.code ?? null,
              track: hls?.subtitleTrack ?? null,
            })}`,
          );
        }
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          hls?.recoverMediaError();
          return;
        }
        // The session den-remux ended (410) — idle past its limit — or a connection that stayed away until the
        // loader stopped asking: not a verdict on the release, and never a restart from zero.
        const code = data.response?.code;
        if (
          data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR &&
          (code === 410 || (code === 0 && connection.down))
        ) {
          // hls.js can clear the media clock before reporting that an expired session returned 410. Keep the
          // last position this element reported instead of offering to resume the film from zero.
          lose(element.currentTime || lastPosition || 0);
          return;
        }
        void broke(
          0,
          `hls.js ${data.type} ${data.details}`,
          data.type === Hls.ErrorTypes.MEDIA_ERROR ? 'decode' : 'other',
          'hls_fatal',
        );
      });
      // hls.js has its subtitle tracks once the master is parsed, and would otherwise show the DEFAULT one.
      hls.on(Hls.Events.MANIFEST_PARSED, applySubtitles);
      hls.on(Hls.Events.MEDIA_ATTACHED, resumeIfReplaced);
      hls.loadSource(current.playlist);
      hls.attachMedia(element);
    });
    // hls.js is its own chunk, fetched only now: offline, or after a release replaced it, it never comes — and the
    // video sat black with nothing said. The same for an engine that throws as it is set up.
    void starting.catch((error: unknown) => {
      console.warn('hls.js could not be started.', error);
      if (gone || ended || session !== current) return;
      failure = 'engine';
      letGo();
    });
    return () => {
      gone = true;
      stopWatching();
      // Unless a replacement or the close already did.
      if (engine && hls === engine) {
        engine.destroy();
        hls = undefined;
      }
    };
  });

  // A start that needs a head start (`prebuffer`) waits for it, paused, rather than starting and then stalling — with a
  // countdown where that is more than a moment (`PrebufferHold`), gone the moment it plays.
  $effect(() => {
    const [current, element, held] = [session, video, hold];
    if (!current || current.castOrigin || !element || !held) return;
    if (samsungAvplay) {
      // AVPlay reports percent toward a platform-selected startup buffer, not seconds on the media timeline. Its
      // buffering-complete/canplay signal is the only faithful readiness boundary available to this page.
      const ready = () => {
        if (hold !== held) return;
        hold = null;
        startsIn = null;
        void element
          .play()
          .catch((error: unknown) =>
            console.warn(
              'The held Samsung start could not play on its own; its controls can.',
              error,
            ),
          );
      };
      element.addEventListener('canplay', ready, { once: true });
      return () => element.removeEventListener('canplay', ready);
    }
    const tick = setInterval(() => {
      if (hold !== held) return clearInterval(tick);
      const { ready, seconds } = held.update(
        aheadIn(element.buffered, element.currentTime),
        performance.now(),
      );
      if (ready) {
        clearInterval(tick);
        hold = null;
        startsIn = null;
        element
          .play()
          .catch((error: unknown) =>
            console.warn('The held start could not play on its own; its controls can.', error),
          );
        return;
      }
      startsIn = seconds === null ? null : countdownLabel(seconds);
      if (!element.paused) element.pause();
    }, 250);
    return () => clearInterval(tick);
  });

  function readyCastFrame(origin: string): Window | null {
    const frame = castFrame?.contentWindow;
    return frame &&
      castFrameReady?.origin === origin &&
      castFrameReady.challenge === castFrameChallenge
      ? frame
      : null;
  }

  function castDocumentReady(origin: string, generation: unknown): boolean {
    if (generation !== castFrameChallenge) return false;
    castFrameReady = { origin, challenge: castFrameChallenge };
    return true;
  }

  function castFrameLoaded(): void {
    castFrameGeneration += 1;
    castFrameChallenge = `${castFrameGeneration}:${crypto.randomUUID?.() ?? performance.now()}`;
    castFrameReady = undefined;
    const origin = frameOrigin;
    const frame = castFrame?.contentWindow;
    if (origin && frame)
      frame.postMessage({ type: 'den-handshake', generation: castFrameChallenge }, origin);
  }

  function sendToCastFrame(): void {
    const current = session;
    if (!current?.castOrigin) return;
    const frame = readyCastFrame(current.castOrigin);
    if (!frame) return;
    playedEngine = 'cast_page';
    // Played here only because this page could not reach the home network: the cast page, in the same browser,
    // can't either, so it is not sent there to fail. A receiver is on that network, so a cast still offers it.
    const lanUrl =
      !castMode && !castOffered && lanProbe?.answer === false && lanProbe.base === current.lanBase
        ? undefined
        : current.lanPlaylist;
    const poster = title.posterPath
      ? `https://image.tmdb.org/t/p/w500${title.posterPath}`
      : undefined;
    frame.postMessage(
      {
        type: 'den-load',
        id: current.playlist,
        media: {
          url: current.playlist,
          ...(current.external
            ? {}
            : {
                lanUrl,
                speed: current.speed,
                measure: publicMaxBitrate === undefined,
                lanProven:
                  castMode && lanProbe?.base === current.lanBase && lanProbe?.answer === true,
                lifecycleUrl: current.control?.end,
              }),
          mode: castMode ? 'cast' : 'browser',
          interfaceLanguage,
          title: title.title,
          subtitle: season !== undefined ? `S${season} · E${episode}` : undefined,
          image: poster,
          currentTime: started ?? resume.seconds ?? 0,
          subtitleLanguage: selectedSubtitleLanguage(current),
          subtitleIndex:
            current.external && current.torboxSubtitle !== null
              ? current.torboxSubtitle
              : undefined,
          subtitleTrack: current.externalSubtitles
            ?.filter((track) => track.value === subtitleChoice && track.castUrl)
            .map((track) => ({
              language: track.language,
              name: track.name,
              url: track.castUrl!,
            }))[0],
          external: current.external === true,
        },
      },
      current.castOrigin,
    );
  }

  // The iframe origin stays the same when Hearth replaces a failed managed URL with Remux, so it does not reload.
  // Send each replacement explicitly; the frame's den-ready message remains the retry for its initial page load.
  $effect(() => {
    const [current, frame, preparing] = [session, castFrame, castSubtitlePreparing];
    if (
      !current?.castOrigin ||
      !frame ||
      preparing ||
      castFrameReady?.origin !== current.castOrigin ||
      castFrameReady.challenge !== castFrameChallenge
    )
      return;
    untrack(sendToCastFrame);
  });

  /** What the frame's Cast button needs from this page: its layout, and the player's own glyph colour and size. */
  function sendCastLayout(): void {
    const origin = frameOrigin;
    const frame = origin ? readyCastFrame(origin) : null;
    if (!origin || !frame) return;
    const style = castSlot ? getComputedStyle(castSlot) : undefined;
    frame.postMessage(
      {
        type: 'den-layout',
        layout: castStage ? 'stage' : 'button',
        color: style?.color,
        iconSize: Number.parseFloat(style?.getPropertyValue('--button-icon-size') ?? '') || 22,
      },
      origin,
    );
  }

  $effect(() => {
    // Again whenever the layout, the slot (desktop bar or phone header) or the frame's document changes.
    void [castStage, castSlot, castFrameReady];
    untrack(sendCastLayout);
  });

  /** Messages about the Cast button itself, which come before, and apart from, any session loaded in the frame. */
  function castButtonMessage(message: {
    type?: string;
    state?: unknown;
    device?: unknown;
    profile?: unknown;
    playable?: unknown;
    code?: unknown;
    focused?: unknown;
    visible?: unknown;
    hover?: unknown;
    back?: unknown;
  }): boolean {
    switch (message.type) {
      case 'den-cast-state':
        castState = castStateOf(message.state);
        castDevice =
          castState === 'connected' && typeof message.device === 'string'
            ? message.device.slice(0, 80)
            : castState === 'connected'
              ? castDevice
              : undefined;
        if (castState === 'none') castFocus = null;
        return true;
      case 'den-cast-press':
        reachCast('attempted');
        castNotice = null;
        return true;
      case 'den-cast-failed':
        castFailed = true;
        castFailReason = 'session_error';
        castNotice = { text: castFailureNotice(message.code) };
        reportClientFailure({
          operation: 'cast',
          kind: 'protocol',
          outcome: 'terminal',
          route: 'cast_receiver',
          generation: clientFailureGeneration,
          errorClass: 'unknown',
        });
        return true;
      case 'den-cast-session':
        if (typeof message.device === 'string') castDevice = message.device.slice(0, 80);
        // What Den's receiver said its TV plays, else the receiver model the viewer keeps, else its default.
        castReport =
          message.profile === 'receiver' ? (playableOf(message.playable) ?? undefined) : undefined;
        if (castReport) castProfile = 'receiver';
        else if (typeof message.profile === 'string' && CAST_PROFILES.includes(message.profile))
          castProfile = message.profile;
        // Chosen while this page plays: playback moves to the receiver from the second the video is at.
        if (session && !session.castOrigin) moveToCast();
        return true;
      case 'den-cast-menu':
        openCastMenu();
        return true;
      case 'den-cast-focus':
        castFocus = message.focused === true ? (message.visible ? 'keyboard' : 'pointer') : null;
        if (castFocus) revealWebControls(false);
        else scheduleWebControls();
        return true;
      case 'den-cast-hover':
        castHover = message.hover === true;
        return true;
      case 'den-tab':
        castTab(message.back === true);
        return true;
      case 'den-activity':
        // The pointer is over the frame, where this page's own pointer events do not reach.
        revealWebControls();
        return true;
    }
    return false;
  }

  function castMessage(event: MessageEvent<unknown>): void {
    const frame = castFrame?.contentWindow;
    if (!frame || event.source !== frame || !frameOrigin || event.origin !== frameOrigin) return;
    const button = event.data as Parameters<typeof castButtonMessage>[0] & { generation?: unknown };
    if (button.type === 'den-ready' && castDocumentReady(event.origin, button.generation)) {
      frame.postMessage({ type: 'den-discover', interfaceLanguage }, event.origin);
      sendCastLayout();
    }
    if (castButtonMessage(button)) return;
    const current = session;
    if (!current?.castOrigin || event.origin !== current.castOrigin) return;
    const message = event.data as {
      type?: string;
      id?: string;
      currentTime?: number;
      duration?: number;
      paused?: boolean;
      message?: string;
      state?: string;
      profile?: string;
      playable?: unknown;
      device?: string;
      maxBitrate?: number;
      volume?: number;
      muted?: boolean;
    };
    if (message.type === 'den-ready' || message.id !== current.playlist) return;
    if (message.type === 'den-progress') {
      if (Number.isFinite(message.currentTime)) remoteTime = Math.max(0, message.currentTime ?? 0);
      if (Number.isFinite(message.duration)) remoteDuration = Math.max(0, message.duration ?? 0);
      // The receiver's own volume, which Den's volume control now sets.
      if (castView && Number.isFinite(message.volume))
        playerVolume = Math.min(1, Math.max(0, message.volume ?? 1));
      if (castView && typeof message.muted === 'boolean') playerMuted = message.muted;
      // A length is known only once the playlist came through the media listener.
      if (remoteDuration > 0) {
        played = true;
        clearTransition();
        clearInterval(noticeTimer);
      }
      // The iframe has no `video` here to fire loadedmetadata and timeupdate, so its progress is what starts the
      // skip segments and drives the skip button, auto-skip and the next-episode warm-up.
      if (remoteDuration > 0) void loadSegments();
      tick();
      if (typeof message.paused === 'boolean' && message.paused !== remotePaused) {
        remotePaused = message.paused;
        if (remotePaused) paused();
        else playing();
      }
    } else if (message.type === 'den-speed') {
      const measured = message.maxBitrate;
      if (
        publicMaxBitrate === undefined &&
        typeof measured === 'number' &&
        Number.isFinite(measured) &&
        measured >= 64_000 &&
        measured <= 1_000_000_000
      ) {
        publicMaxBitrate = Math.round(measured);
        rememberLink(route, publicMaxBitrate);
        // The cast page holds playback until told: started again only when what den-remux chose needs more than
        // the link carries, so a release it can't open is not probed a second time for nothing.
        if (restartAfterMeasure(current, publicMaxBitrate)) {
          restartForRecovery('Preparing Chromecast…', releaseAfterMeasure(chosenRelease));
        } else
          readyCastFrame(current.castOrigin)?.postMessage(
            { type: 'den-continue', id: current.playlist },
            current.castOrigin,
          );
      }
    } else if (message.type === 'den-reconnect') {
      // The cast page's segments stopped arriving: its address may have changed, and only this page can say so.
      void regrant(current);
    } else if (message.type === 'den-lost') {
      lose(Number.isFinite(message.currentTime) ? (message.currentTime ?? 0) : remoteTime);
    } else if (message.type === 'den-lan') {
      // den-remux answered on the home network, where there is no upload link to fit: a limit remembered from away
      // does not apply here, and a session asked under one is asked again without it.
      rememberLink(route, undefined);
      publicMaxBitrate = undefined;
      if (askedMaxBitrate !== undefined) {
        restartForRecovery('Home network found—reopening…', releaseAfterMeasure(chosenRelease));
      }
    } else if (message.type === 'den-cast-request') {
      const report =
        message.profile === 'receiver' ? (playableOf(message.playable) ?? undefined) : undefined;
      const profile = report
        ? 'receiver'
        : message.profile === 'receiver'
          ? 'legacy'
          : (message.profile ?? 'legacy');
      if (!castMode || castProfile !== profile) {
        const was = { castMode, castProfile, castReport };
        castProfile = profile;
        castReport = report;
        castMode = true;
        restartForRecovery(
          'Preparing Chromecast…',
          { filename: current.release.filename },
          () => ({ castMode, castProfile, castReport } = was),
        );
      }
    } else if (message.type === 'den-cast' && message.state === 'playing') {
      casting = true;
      castNotice = null;
      if (typeof message.device === 'string') castDevice = message.device.slice(0, 80);
      reachCast('started');
      castSessionStartedAt = performance.now();
    } else if (message.type === 'den-cast' && message.state === 'stopped') {
      casting = false;
      castMode = false;
      endCastSession();
      // Moved here to cast: casting over, the viewer is back in the player they left, where it had got to.
      if (castOffered) leaveCast();
      else {
        restartForRecovery('Chromecast stopped—returning…', {
          filename: current.release.filename,
        });
      }
    } else if (message.type === 'den-ended') {
      casting = false;
      endCastSession();
      finished();
    } else if (message.type === 'den-error') {
      casting = false;
      endCastSession();
      castFailed = true;
      castFailReason = castFailReasonOf(message.message ?? '');
      reportClientFailure({
        operation: 'cast',
        kind: 'protocol',
        outcome: returnsFromCast(castOffered, castMode) ? 'recovered' : 'terminal',
        route: 'cast_receiver',
        generation: clientFailureGeneration,
        errorClass: 'media_error',
      });
      // The cast page refused the load this page handed it before fetching anything: a fault in that hand-off, not
      // in the release, so no release is left out for it and no other is tried.
      if (message.message === 'Invalid media URL') {
        console.warn('The cast page refused the media URLs it was handed.');
        reportFailure(current, 0, message.message);
        lastFailSource = 'cast_page_error';
        failure = 'protocol';
        return;
      }
      // A TorBox stream the receiver couldn't play stays TorBox: Den Remux is used only when the viewer picks it. A
      // fresh TorBox stream of the same release is tried once on the receiver, then the viewer is told and playback
      // carries on here. The Cast session is kept either way; only Stop casting ends it.
      if (current.external) {
        if (!castRetried) {
          castRetried = true;
          restart(
            sameStream(current),
            undefined,
            'direct',
            showTransition('Trying the Chromecast again…'),
          );
          return;
        }
        leaveCast();
        castNotice = {
          text: 'The Chromecast couldn’t play this TorBox release, so it’s playing here again.',
          retry: moveToCast,
        };
        return;
      }
      // Keep the receiver only when one conservative H.264 retry remains; terminal attempts return local.
      if (degraded || current.video?.transcoded || castProfile === 'legacy') castMode = false;
      if (returnsFromCast(castOffered, castMode)) {
        // The cast page could not play what was moved to it — at home it may reach neither address. Not a verdict on
        // the release: the player that was playing it goes on from the same second.
        reportFailure(current, 0, message.message ?? 'cast player failed');
        leaveCast();
        castNotice = {
          text: 'The Chromecast couldn’t play this, so it’s playing here again.',
          retry: moveToCast,
        };
        return;
      }
      // A receiver that can't play what it was sent: a copy its conservative profile takes, as a decoder's refusal.
      void broke(0, message.message ?? 'cast player failed', 'decode', 'cast_page_error');
    }
  }

  /**
   * Whether this browser could cast at all; Google's SDK exists only in desktop and Android Chromium. Not a TV shell:
   * their web views have no Cast sender, so the cast page would be loaded beside every playback for nothing.
   */
  const castable = !tv && !__DEN_TV_LEGACY_JS_CORE__ && canOfferCast();

  type AirPlayVideo = HTMLVideoElement & {
    webkitCurrentPlaybackTargetIsWireless?: boolean;
    webkitShowPlaybackTargetPicker?: () => void;
  };
  type AirPlayAvailabilityEvent = Event & { availability?: string };

  /**
   * WebKit's non-standard opt-in keeps native HLS available to AirPlay. Desktop Safari loses the native media
   * control when Den draws its own transport, so capability and availability are retained for Den's equivalent
   * output button. The picker itself still has to be opened synchronously from that button's user gesture.
   */
  function allowAirPlay(element: HTMLVideoElement) {
    element.setAttribute('x-webkit-airplay', 'allow');
    const airplay = element as AirPlayVideo;
    airPlayCapable = typeof airplay.webkitShowPlaybackTargetPicker === 'function';
    airPlayActive = !!airplay.webkitCurrentPlaybackTargetIsWireless;
    const availability = (event: Event) => {
      const answer = (event as AirPlayAvailabilityEvent).availability;
      airPlayAvailability = answer === 'available' ? 'available' : 'unavailable';
    };
    const targetChanged = () => {
      airPlayActive = !!airplay.webkitCurrentPlaybackTargetIsWireless;
    };
    element.addEventListener('webkitplaybacktargetavailabilitychanged', availability);
    element.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', targetChanged);
    return {
      destroy() {
        element.removeEventListener('webkitplaybacktargetavailabilitychanged', availability);
        element.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', targetChanged);
        airPlayCapable = false;
        airPlayActive = false;
        airPlayAvailability = 'unknown';
      },
    };
  }

  function offerAirPlay() {
    (video as AirPlayVideo | undefined)?.webkitShowPlaybackTargetPicker?.();
  }

  const CAST_RANK: Record<CastStage, number> = { offered: 0, attempted: 1, started: 2 };
  /** Moves `castFunnel` to `stage`, never back: den-edge's own cast report (`finish()`) names the furthest
   * this visit's Chromecast attempt reached, not its last. */
  function reachCast(stage: CastStage) {
    if (!castFunnel || CAST_RANK[stage] > CAST_RANK[castFunnel]) castFunnel = stage;
  }

  /** `message`, folded into one of den-edge's allowlisted cast-failure classes — never the message itself. */
  function castFailReasonOf(message: string): CastFailReason {
    if (message === 'Invalid media URL') return 'invalid_media';
    if (message.includes('nothing played')) return 'lan_unreachable';
    if (message.includes('could not load') || message.includes('could not continue'))
      return 'media_error';
    if (message.includes('Cast SDK') || message.includes('no-cast-page'))
      return 'receiver_not_loaded';
    return 'other';
  }

  /** `castSessionStartedAt`, folded into `castSessionSecs` and cleared: a session just ended or failed. */
  function endCastSession() {
    if (castSessionStartedAt === undefined) return;
    castSessionSecs += (performance.now() - castSessionStartedAt) / 1000;
    castSessionStartedAt = undefined;
  }

  // The Cast control was there to press — a receiver on the network, the button showing — whether or not the viewer
  // ever did; den-edge's own cast report (`finish()`) is sent only once this has happened. A direct CDN result is
  // offered too: once a receiver is chosen, `moveToCast` asks Hearth again with player=cast. Hearth still chooses
  // delivery; a managed URL goes straight to the receiver, while a later direct failure asks for Remux.
  $effect(() => {
    if (castSlotShown && !castView) reachCast('offered');
  });

  /**
   * The cast page is loaded beside the video once it plays (not before: nothing about Cast may slow a start), and kept.
   * Its Cast SDK watches for a receiver in the background, and its button shows in the control bar only once one is
   * found. Handing the film to another screen is a boundary of its own, so the active profile's policy is asked first:
   * a title that may not be cast never shows the button.
   */
  $effect(() => {
    if (castPageAsked || !castable || !played || !session || session.castOrigin) return;
    if (!canOfferCurrentCast(session)) return;
    castPageAsked = true;
    void (async () => {
      if (!(await titleAllowed(title, { content, restricted: true }))) return;
      const origin = await fetchCastOrigin();
      if (origin && !ended) lookOrigin = origin;
    })();
  });

  /**
   * The stream playing, to ask for again on another player: its release and, for TorBox, the built-in subtitle burned
   * into it. Asked for by release alone, Hearth hands over TorBox's stream without that subtitle, and `begin` then asks
   * again for the one with it: a second hand-off, and a second LOAD on a receiver, seconds after the first.
   */
  function sameStream(current: Session): { filename: string; subtitleTrack?: number } {
    return {
      filename: current.release.filename,
      ...(current.external &&
      current.torboxSubtitle !== null &&
      current.torboxSubtitle !== undefined
        ? { subtitleTrack: current.torboxSubtitle }
        : {}),
    };
  }

  /** A receiver chosen in the cast page: playback moves to it at the second the video is at. */
  function moveToCast() {
    if (!session || !lookOrigin) return;
    castNotice = null;
    castRetried = false;
    castOffered = true;
    directCastOrigin = lookOrigin;
    routeBeforeCast = route;
    // A receiver can fetch a signed Hearth playlist over private-LAN HTTP. Keep that already-proven route instead
    // of replacing it with Edge's public relay; the HTTPS Cast sender only hands the URL to the receiver.
    const directLanCast = privateLanRemuxPlaylist(session.playlist);
    if (!directLanCast) route = RELAY;
    // Managed playback states receiver capability to Hearth up front. Legacy Remux keeps its existing two-step
    // profile negotiation with the Cast page, except for private HTTP: the sender must never try to play that URL.
    castMode = playback !== undefined || directLanCast;
    // Whatever the cast page reports is about this session alone: an earlier cast's position must not stand in for it.
    remoteTime = 0;
    const pending = showTransition('Starting Chromecast…');
    // A TorBox stream is cast as TorBox only: Remux is not a usable path to a Chromecast for remote households, so a
    // receiver Hearth says can't take this release (`torbox_receiver_unsupported`) is refused and named, not remuxed.
    restart(
      sameStream(session),
      () => {
        castOffered = false;
        directCastOrigin = undefined;
        route = routeBeforeCast;
        castMode = false;
      },
      undefined,
      pending,
    );
  }

  /** Pressed while a receiver is connected: Den's Cast menu, under the button the press was on. */
  function openCastMenu() {
    const box = castSlot?.getBoundingClientRect();
    if (box) castMenu?.openAt(box.left, box.top);
  }

  function stopCasting() {
    const origin = frameOrigin;
    if (origin) readyCastFrame(origin)?.postMessage({ type: 'den-stop' }, origin);
  }

  /** The cast page keeps the model and asks for what it plays (`den-cast-request`), which sets `castProfile`. */
  function chooseCastProfile(profile: string) {
    const origin = frameOrigin;
    if (origin) readyCastFrame(origin)?.postMessage({ type: 'den-profile', profile }, origin);
  }

  /** Focus into the frame's button, from Tab on Den's side of it or from a menu closing. */
  function focusCastButton() {
    const origin = frameOrigin;
    const frame = origin ? readyCastFrame(origin) : null;
    if (!origin || !frame) return;
    castFrame?.focus();
    frame.postMessage({ type: 'den-focus' }, origin);
  }

  /**
   * Tab from the frame's button. The frame sits at the end of the player in its document, apart from the bar it is
   * drawn in, so the next control is found from the slot's place in the bar instead.
   */
  function castTab(back: boolean) {
    const slot = castSlot;
    if (!slot) return;
    const focusable = playerTabStops();
    const at = focusable.indexOf(slot);
    const next = focusable[back ? at - 1 : at + 1];
    if (next) next.focus();
    else (back ? focusable.at(-1) : focusable[0])?.focus();
  }

  // The cast page's frame is the Cast button (`castSlot`) or, away from home, the picture: it lies exactly over the one
  // it is now, measured here, since it cannot move in the document without being reloaded and losing its session.
  let castFrameBox = $state<{ left: number; top: number; width: number; height: number }>();
  let stageElement = $state<HTMLElement>();
  $effect(() => {
    const target = castStage ? stageElement : castSlotShown ? castSlot : undefined;
    const root = playerRoot;
    if (!target || !root) {
      castFrameBox = undefined;
      return;
    }
    const place = () => {
      const box = target.getBoundingClientRect();
      const origin = root.getBoundingClientRect();
      const next = {
        left: box.left - origin.left,
        top: box.top - origin.top,
        width: box.width,
        height: box.height,
      };
      const last = castFrameBox;
      if (
        !last ||
        last.left !== next.left ||
        last.top !== next.top ||
        last.width !== next.width ||
        last.height !== next.height
      )
        castFrameBox = next;
    };
    place();
    // A button beside it appearing (an audio track, AirPlay) moves it without resizing it: its row is watched too.
    const observer = new ResizeObserver(place);
    observer.observe(target);
    if (target.parentElement) observer.observe(target.parentElement);
    observer.observe(root);
    return () => observer.disconnect();
  });

  // Back to playing in this page, the frame stays for its button: what it had loaded is let go there.
  let castFrameLoad: string | undefined;
  $effect(() => {
    const current = session;
    if (current?.castOrigin) castFrameLoad = current.playlist;
    else if (castFrameLoad && current && !heldFrame && frameOrigin) {
      castFrameLoad = undefined;
      untrack(() => readyCastFrame(frameOrigin)?.postMessage({ type: 'den-reset' }, frameOrigin));
    }
  });

  /** Back to the route this page started on, at the second the cast page got to — or the one Cast was pressed at. */
  function leaveCast() {
    castOffered = false;
    directCastOrigin = undefined;
    casting = false;
    route = routeBeforeCast;
    castMode = false;
    if (session) {
      const pending = showTransition('Returning here…');
      restart(sameStream(session), undefined, undefined, pending);
    }
  }

  /**
   * Whether this page plays `current` from its home-network address itself (`begin`): a Remux session meant for the
   * cast page, whose home-network address answers this page. Asked once per address, as the cast page asks once.
   */
  function homeHere(current: Session): Promise<boolean> {
    const base = current.lanBase;
    if (current.external || !current.castOrigin || !base || !current.lanPlaylist)
      return Promise.resolve(false);
    if (lanProbe?.base !== base) {
      const probe: NonNullable<typeof lanProbe> = { base, reachable: lanReachable(base) };
      void probe.reachable.then((answer) => (probe.answer = answer));
      lanProbe = probe;
    }
    return lanProbe.reachable;
  }

  /** A session this page plays from the home-network address, though it came for the cast page (`begin`). */
  const playsHome = (current: Session) =>
    current.lanPlaylist !== undefined && current.playlist === current.lanPlaylist;

  /**
   * A relay-owned Remux session without a Cast page cannot be moved to a receiver. Managed direct media is different:
   * its signed CDN capability is deliberately handed to the Cast page only after a receiver is chosen, even though
   * the browser reached Hearth through the ordinary `/remux` facade.
   */
  function canOfferCurrentCast(current: Session): boolean {
    return current.external === true || route !== RELAY || playsHome(current);
  }

  // A session moved to the cast page that shows nothing — no error either, as when neither of its addresses answers
  // and hls.js is still retrying — goes back to the player it left, rather than sitting at 00:00. One that plays in
  // the cast page because this browser is away from home has no other player to go back to: it fails, and says so,
  // rather than leaving the frame blank.
  $effect(() => {
    const current = session;
    if (!current?.castOrigin || casting) return;
    const wait = setTimeout(() => {
      if (session !== current || played || casting) return;
      const why = `nothing played in the cast page after ${castPlayMs / 1000} s`;
      castFailed = true;
      // Handed to a receiver, it is the receiver that fetches the media, not this browser or its frame: a receiver
      // that never starts is a Cast session's failure, not a sign the home network was out of reach.
      castFailReason = castMode ? 'session_error' : castFailReasonOf(why);
      reportClientFailure({
        operation: 'cast',
        kind: 'timeout',
        outcome: returnsFromCast(castOffered, castMode) ? 'recovered' : 'terminal',
        route: 'cast_receiver',
        generation: clientFailureGeneration,
        errorClass: 'media_error',
      });
      if (returnsFromCast(castOffered, castMode)) {
        reportFailure(current, 0, why);
        leaveCast();
        castNotice = {
          text: 'The Chromecast didn’t start playing, so it’s playing here again.',
          retry: moveToCast,
        };
      } else if (!castOffered && !castMode) void broke(0, why, 'other', 'cast_page_silent');
    }, castPlayMs);
    return () => clearTimeout(wait);
  });

  /** The receiver models Den's Cast menu names (`castCapabilities`). */
  const CAST_PROFILES = ['legacy', 'gen3', 'ultra', 'google-tv-hd', 'google-tv-4k', 'streamer'];
  const CAST_PROFILE_NAMES: Record<string, string> = {
    legacy: 'Chromecast 1–2',
    gen3: 'Chromecast 3',
    ultra: 'Chromecast Ultra',
    'google-tv-hd': 'Chromecast with Google TV (HD)',
    'google-tv-4k': 'Chromecast with Google TV (4K)',
    streamer: 'Google TV Streamer',
  };

  /** Receiver model profiles from Google's published codec matrix. `castProfile` says which one is asked for;
   * `legacy` (H.264 High@4.1, stereo AAC) is the conservative retry after a receiver refused a load. */
  function castCapabilities(profile: string): Playable {
    const h264 =
      profile === 'legacy'
        ? 0x29
        : profile === 'gen3' || profile === 'ultra' || profile === 'google-tv-hd'
          ? 0x2a
          : profile === 'streamer'
            ? 0x34
            : 0x33;
    const hevc =
      profile === 'google-tv-hd'
        ? 123
        : ['ultra', 'google-tv', 'google-tv-4k', 'streamer'].includes(profile)
          ? 153
          : 0;
    // Device AV1 capability does not establish that the Default Receiver accepts AV1 in HLS/fMP4. Keep it off
    // until that exact delivery path is verified on hardware; HEVC remains the Streamer's best known profile.
    const av1 = 0;
    return {
      h264,
      h264High10: 0,
      hevcMain: hevc,
      hevcMain10: hevc,
      hevcHighTier: 0,
      hdr: hevc > 0,
      eac3: false,
      aacMultichannel: false,
      dolbyVision: { p5: false, p8: false },
      av1,
      av1Main10: av1,
      av1Hdr: av1 > 0,
      flac: false,
      aac71: false,
      vp9: false,
      vp9Profile2: false,
    };
  }

  /**
   * The browser gave up on the video: say so here, and tell den-remux why — no server log sees it otherwise. `kind` is
   * whether the decoder refused it (`MediaError` 3 or 4, a media error hls.js couldn't recover), which moves the
   * session to another copy; a format it won't take at all (`format`: no source it can use, or a ready segment it
   * shows nothing of), which stops here as "couldn't play"; or anything else (`other`: the network, an aborted
   * load), which is no verdict on the release and never reads as one.
   */
  async function broke(
    code = video?.error?.code ?? 0,
    message = video?.error?.message ?? '',
    kind: 'decode' | 'format' | 'other' = code === 3 || code === 4 ? 'decode' : 'other',
    source: FailSource = 'media_element',
  ) {
    if (!session || failure) return;
    // den-edge's own outcome report (`finish()`) names the last fatal error this visit saw, whichever session it
    // belonged to: a switch away from a bad copy is still something that went wrong once.
    lastFatal = { code: code || undefined, hls: hlsFatalFromMessage(message) };
    lastFailSource = source;
    if (breaking?.session === session) {
      if (kind === 'decode') breaking.decode = true;
      if (kind !== 'other') breaking.refused = true;
      return;
    }
    const current = session;
    const judging = (breaking = {
      session: current,
      decode: kind === 'decode',
      refused: kind !== 'other',
    });
    watcher?.spent();
    reportFailure(current, code, message);
    if (current.external) {
      const recovery = directRecovery(played, directAttempt ?? 'initial');
      // The browser's native error may contain a signed media URL, so log only this closed recovery state. The
      // eventual Hearth refusal, if any, is logged separately with its allow-listed status/code/cause.
      console.warn('Managed direct media failed.', {
        stage: played ? 'mid-playback' : 'startup',
        attempt: directAttempt ?? 'initial',
        action: recovery,
      });
      playbackRouteLog({
        event: 'recovery',
        from: 'torbox',
        to: 'torbox',
        stage: played ? 'mid_playback' : 'startup',
        attempt: directAttempt ?? 'initial',
      });
      carryPosition();
      if (recovery === 'stop') {
        letGo();
        failure = 'source';
        return;
      }
      const recovering = showTransition(
        `TorBox ${played ? 'stopped' : 'did not start'}—refreshing…`,
      );
      const moved = await begin(
        undefined,
        {},
        current,
        'refresh',
        null,
        !directWithoutDenSubtitles,
      );
      if (moved !== true) clearTransition(recovering);
      if (session === current && moved !== true) {
        const stopped = typeof moved === 'string' && moved !== 'busy' ? moved : 'source';
        letGo();
        failure = stopped;
      }
      return;
    }
    // Opened for the address this page reported, and nothing ever arrived: most likely that address was wrong (a
    // carrier NAT with an address per destination, or a middlebox answering the lookup). Asked again once without it.
    if (retryWithoutHint(current, played, noHint)) {
      noHint = true;
      restartForRecovery('Address failed—retrying without it…', {
        filename: current.release.filename,
      });
      return;
    }
    // A dead release looks exactly like this too — `MediaError 3`, and on the native path this page never
    // sees the segment responses that would say otherwise. Ask den-remux for the segment playback stalled
    // on before blaming the picture: converting a release whose bytes have stopped arriving cannot help,
    // and it spends the one GPU slot the box has (oxyc/den#43).
    // The signed public origin intentionally cannot be connected to by the d.<domain> page; asking it here
    // would be a CSP violation. The receiver's media error is enough to select the conservative Cast profile.
    if (!current.publicBase) {
      const answer = await segmentAnswer(current, stalledAt());
      if (session !== current || failure) return;
      // Native HLS does not expose a failed fragment's HTTP status. Ask den-remux once: 410 means this session
      // expired and can resume at the last position; 502 means the release itself stopped producing bytes.
      if (answer?.status === 410) {
        lose(video?.currentTime || lastPosition || 0);
        return;
      }
      if (answer?.status === 502) {
        failure = 'source';
        return;
      }
    }
    // The session may have been replaced while that was asked.
    if (session !== current || failure) return;
    // Not a refusal: the load was cut off, or the network failed it. Playing, it picks up from where it got to at
    // the viewer's word; not yet playing, the release stopped answering. Neither is "couldn't play" — a cast page's
    // is, as before: it has no other way of saying it couldn't.
    if (!judging.refused && !current.castOrigin) {
      if (played) lose(video?.currentTime || lastPosition || 0);
      else failure = 'source';
      return;
    }
    const picked = current.release.filename === chosenRelease;
    // It was copied because this browser said it could take it, and it couldn't: another release, copied, that it
    // does take, from the same second (`switchPolicy`). Never this one converted — a transcode is chosen before
    // playback or not at all — and with no such copy, playback stops here and says so. Never from the viewer's own
    // pick: they are told, and offered another (`tryAfterRefusal`).
    const moved = judging.decode && !picked ? await switchAway('decode') : false;
    if (judging.decode) {
      // No automatic pick lands on it again this visit; and a pick of the viewer's it disproved is theirs no more.
      if (picked) chosenRelease = undefined;
      leave(current.release.filename);
    }
    if (moved === true) return;
    // A refusal that says nothing about this browser — den-remux out of reach, a login gone, access ended — is said as
    // itself. A busy den-remux is not: its note promises a wait that nothing here would then retry.
    if (session === current && !failure)
      failure =
        typeof moved === 'string' && !nothingFits(moved) && moved !== 'busy' ? moved : 'playback';
  }

  /** "Try another release" under "couldn't play": another copy, as a decoder's refusal moves to one. */
  function tryAfterRefusal() {
    const current = session;
    if (!current) return;
    void switchAway('decode').then((moved) => {
      if (session !== current || moved === true) return;
      failure =
        typeof moved === 'string' && !nothingFits(moved) && moved !== 'busy' ? moved : 'playback';
    });
  }

  /** Where playback stopped: the end of what was buffered, else the play head. */
  function stalledAt(): number {
    const buffered = video?.buffered;
    const end = buffered?.length ? buffered.end(buffered.length - 1) : 0;
    return Math.max(end, video?.currentTime ?? remoteTime);
  }

  function length(): number {
    if (video && Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    if (remoteDuration > 0) return remoteDuration;
    return session?.duration ?? 0;
  }

  /** Pick up where it was left — or where the last session was — unless that was the very start or the credits. */
  function seekToStart() {
    const total = length();
    if (!video || !total) return;
    const from = startAt ?? resume;
    // Opening mid-title says where, once a visit, with the way back to the start (`resumedAt`).
    if (webTransport && startAt === null && !resumeOffered) {
      resumeOffered = true;
      const at = started ?? resume.seconds ?? resume.fraction * total;
      if (at > 5 && at / total < WATCHED) resumedAt = clockTime(at);
    }
    startAt = null;
    if (started !== undefined) {
      // den-remux was asked to start there: hls.js was given it as its start position, and Safari's own player reads
      // the playlist's EXT-X-START. A seek is only for a native player that didn't start near it — a den-remux that
      // names no start — so the picture never jumps twice.
      if (!hls && Math.abs(video.currentTime - started) > START_SLACK_SECS)
        video.currentTime = started;
      return;
    }
    const at = from.seconds ?? from.fraction * total;
    if (at > 5 && at / total < WATCHED) video.currentTime = at;
  }

  /** Write where playback got to, unless it is within `slack` seconds of what was last written. */
  function report(slack = 0) {
    // Between an advance's two sessions the held video still has the outgoing episode's clock, until it is emptied.
    if (!session) return;
    const at = video?.currentTime ?? remoteTime;
    if (at > 0) progress.report(at, length(), slack, { creditsReached: reachedCredits(at) });
  }

  /** SkipDB calls an outro "credits"; crossing its aligned start is the same completion evidence tvOS uses. */
  function reachedCredits(at: number): boolean {
    return segments.some((segment) => segment.kind === 'outro' && at >= segment.start);
  }

  function playing() {
    // Playing after `ended` is a deliberate replay, so the old episode's pending advance no longer owns the viewer.
    // This also covers the cast page: its first unpaused progress after a receiver resumes calls this same handler.
    stay();
    // Autoplay is only the initial-start request. Some TV engines reconsider a persistent autoplay flag after a
    // later readiness/buffering transition and can undo a deliberate pause. Once playback has begun, every future
    // start is either a viewer action or an explicitly state-preserving source replacement.
    if (video?.autoplay) {
      video.autoplay = false;
      video.removeAttribute('autoplay');
    }
    if (customTransport) tvPaused = false;
    if (tv) setTvPlaybackActive(true);
    scheduleWebControls();
    progress.playing();
    clearInterval(timer);
    timer = setInterval(() => report(), REPORT_MS);
    // The segment requests playback itself makes already say this viewer is here.
    clearInterval(heartbeat);
  }

  function paused() {
    if (customTransport) tvPaused = true;
    if (tv) setTvPlaybackActive(false);
    revealWebControls(false);
    clearInterval(timer);
    progress.paused();
    report();
    if (session) {
      sendHeartbeat(session);
      clearInterval(heartbeat);
      heartbeat = setInterval(() => session && sendHeartbeat(session), HEARTBEAT_MS);
    }
  }

  /** The end: count down to the next episode, when there is one. */
  function finished() {
    if (tv) setTvPlaybackActive(false);
    if (customTransport) {
      tvPaused = true;
      // Desktop controls may have hidden while the episode played. The countdown and its Stay action must be
      // reachable without first guessing that moving over the finished picture reveals them.
      revealWebControls(false);
    }
    progress.complete(video?.currentTime ?? remoteTime);
    // For den-edge's own outcome report (`finish()`): this visit reached a natural end, whether or not there is
    // a next episode to count down to.
    reachedNaturalEnd = true;
    if (!onnext || ended) return;
    // A second end (the last seconds replayed, or the cast page's `den-ended` again) starts the count over; left
    // running, the first would advance again every second after it.
    clearInterval(countdown);
    upNext = UP_NEXT_SECS;
    countdown = setInterval(() => {
      upNext = (upNext ?? 1) - 1;
      if (upNext > 0) return;
      stay();
      onnext?.();
    }, 1000);
  }

  function stay() {
    clearInterval(countdown);
    upNext = null;
  }

  /**
   * The subtitle language showing, or null for Off.
   *
   * Begin with Settings' preference; undefined means Off. den-remux's renditions are non-default so every playback
   * path starts consistently, then this player applies the explicit choice on its local or away-browser path.
   */
  let subtitleChoice = $state<string | null>(untrack(() => subtitleLanguage ?? null));
  /** The viewer's prior choice while an explicit no-session TorBox attempt, including its retries, omits Den subs. */
  let pendingDirectSubtitleRestore: string | null | undefined;
  let subtitleOffset = $state(0);
  let subtitleResyncOffset = $state(0);
  const subtitleTimingOffset = $derived(subtitleOffset + subtitleResyncOffset);
  let subtitleResyncReady = $state(false);
  let subtitleResyncBusy = $state(false);
  let subtitleResyncNotice = $state<string | null>(null);
  let subtitleResyncRequest: AbortController | undefined;
  let subtitleSelectionGeneration = 0;
  let subtitleLoadFailure = $state.raw<NonNullable<Session['subtitles']>[number] | null>(null);
  const alignedUrls = new SvelteSet<string>();
  fades(
    () => subtitleResyncNotice,
    () => (subtitleResyncNotice = null),
  );

  // System fullscreen and receivers own their playlist captions. These custom players can replace a sidecar.
  function canRenderAlignedSubtitle() {
    return !castMode && !casting && !airPlayActive && customTransport;
  }

  $effect(() => {
    const current = session;
    const choice = subtitleChoice;
    const eligible = canRenderAlignedSubtitle();
    subtitleResyncReady = false;
    const controller = new AbortController();
    const track = current && preferredSubtitleTrack(current.subtitles ?? [], choice);
    if (
      current?.subtitleResync?.supported &&
      track?.resyncSupported &&
      !track.hashMatch &&
      eligible
    ) {
      void checkSubtitleResync(current, track, controller.signal)
        .then((ready) => {
          if (!controller.signal.aborted) subtitleResyncReady = ready;
        })
        .catch(() => {
          /* An unavailable capability leaves manual timing and the current subtitle intact. */
        });
    }
    return () => controller.abort();
  });

  $effect(() => {
    const current = session;
    subtitleResyncOffset = 0;
    subtitleResyncNotice = null;
    return () => {
      if (current) {
        subtitleResyncRequest?.abort();
        for (const url of alignedUrls) URL.revokeObjectURL(url);
        alignedUrls.clear();
      }
    };
  });

  async function resyncSelectedSubtitle() {
    const current = session;
    const choice = subtitleChoice;
    const track = current && selectedSubtitle(current);
    if (
      !current ||
      !choice ||
      !track ||
      !subtitleResyncReady ||
      subtitleResyncBusy ||
      !canRenderAlignedSubtitle()
    )
      return;
    const generation = subtitleSelectionGeneration;
    const controller = new AbortController();
    subtitleResyncRequest = controller;
    subtitleResyncBusy = true;
    subtitleResyncNotice = null;
    const pending = showTransition('Re-syncing subtitles with audio…');
    try {
      const result = await resyncSubtitle(current, track, controller.signal);
      if (
        controller.signal.aborted ||
        !canRenderAlignedSubtitle() ||
        ended ||
        session !== current ||
        subtitleChoice !== choice ||
        generation !== subtitleSelectionGeneration
      )
        return;
      const url = URL.createObjectURL(result.blob);
      alignedUrls.add(url);
      const previous = current.externalSubtitles?.find((one) => one.value === choice);
      current.externalSubtitles = [
        ...(current.externalSubtitles ?? []).filter((one) => one.value !== choice),
        {
          value: choice,
          language: track.language,
          name: track.name,
          url,
          alignedOffset: result.offset,
        },
      ];
      subtitleOffset = 0;
      subtitleResyncOffset = result.offset;
      await renderTick();
      applySubtitles();
      if (previous && alignedUrls.delete(previous.url)) URL.revokeObjectURL(previous.url);
      subtitleResyncNotice = `Subtitles re-synced · ${result.offset >= 0 ? '+' : ''}${result.offset.toFixed(1)}s`;
    } catch {
      if (
        !controller.signal.aborted &&
        session === current &&
        subtitleChoice === choice &&
        generation === subtitleSelectionGeneration
      )
        subtitleResyncNotice =
          'Subtitles could not be re-synced. Your current timing is unchanged.';
    } finally {
      clearTransition(pending);
      if (subtitleResyncRequest === controller) {
        subtitleResyncRequest = undefined;
        subtitleResyncBusy = false;
      }
    }
  }

  function subtitleResyncItems(): MenuItem[] {
    const track = selectedSubtitle();
    if (!track || track.hashMatch || track.source === 'built-in') return [];
    if (
      session?.subtitleResync?.supported === false &&
      session.subtitleResync.reason === 'managed_delivery'
    )
      return [
        {
          kind: 'item',
          label: 'Re-sync with audio',
          description: 'Available when playing with Den Remux',
          disabled: true,
          onselect: () => {},
        },
      ];
    return subtitleResyncReady && canRenderAlignedSubtitle()
      ? [
          {
            kind: 'item',
            label: 'Re-sync with audio',
            disabled: subtitleResyncBusy,
            onselect: () => void resyncSelectedSubtitle(),
          },
        ]
      : [];
  }
  const originalCueTimes = new WeakMap<TextTrackCue, { start: number; end: number }>();
  const timedTracks = new WeakSet<TextTrack>();
  let retiming = false;

  function retimeSubtitles() {
    if (avplay || retiming) return;
    retiming = true;
    try {
      for (const track of Array.from(video?.textTracks ?? [])) {
        if (!timedTracks.has(track)) {
          timedTracks.add(track);
          track.addEventListener('cuechange', retimeSubtitles);
        }
        for (const cue of Array.from(track.cues ?? [])) {
          const original = originalCueTimes.get(cue) ?? { start: cue.startTime, end: cue.endTime };
          originalCueTimes.set(cue, original);
          cue.startTime = Math.max(0, original.start + subtitleOffset);
          cue.endTime = Math.max(cue.startTime, original.end + subtitleOffset);
        }
      }
    } finally {
      retiming = false;
    }
  }

  /**
   * Show the chosen rendition and hide the rest.
   *
   * Called rather than reactive. `hls` is a plain variable, not `$state`, so an effect reading it would not
   * re-run when the engine is created and the hls.js path would silently apply nothing at all.
   *
   * Two branches because the paths expose renditions differently: hls.js parses the master and owns the
   * tracks, while WebKit loads the master itself and surfaces them as the element's own `textTracks`. Matched
   * by language rather than by index — the native order is not promised to follow the playlist's.
   */
  function applySubtitles() {
    const choice = subtitleChoice;
    if (__DEN_TV_PLATFORM__ === 'tizen' && avplay) {
      avplay.selectSubtitleLanguage(selectedSubtitleLanguage(), choice);
      avplay.setSubtitleOffset(subtitleOffset);
      return;
    }
    const language = selectedSubtitleLanguage();
    const sidecars = session?.externalSubtitles ?? [];
    const sidecar = sidecars.some((track) => track.value === choice);
    if (hls) {
      const languageMatch =
        language === null
          ? -1
          : hls.subtitleTracks.findIndex((track) => subtitleLanguagesMatch(track.lang, language));
      const torboxTrack = session?.external ? session.torboxSubtitle : null;
      const selected = sidecar
        ? -1
        : torboxTrack !== null &&
            torboxTrack !== undefined &&
            torboxTrack >= 0 &&
            torboxTrack < hls.subtitleTracks.length
          ? torboxTrack
          : languageMatch >= 0
            ? languageMatch
            : session?.external && hls.subtitleTracks.length === 1
              ? 0
              : -1;
      hls.subtitleDisplay = choice !== null && !sidecar && selected >= 0;
      hls.subtitleTrack = selected;
    }
    const sidecarValues = new Set(sidecars.map((track) => track.value));
    const textTracks = Array.from(video?.textTracks ?? []);
    retimeSubtitles();
    const nativeTracks = textTracks.filter((track) => !sidecarValues.has(track.label));
    const nativeTorboxTrack = session?.external ? session.torboxSubtitle : null;
    const nativeSelected =
      !hls && !sidecar && choice !== null
        ? nativeTorboxTrack !== null &&
          nativeTorboxTrack !== undefined &&
          nativeTorboxTrack >= 0 &&
          nativeTorboxTrack < nativeTracks.length
          ? nativeTracks[nativeTorboxTrack]
          : nativeTracks.find((track) => subtitleLanguagesMatch(track.language, language))
        : undefined;
    for (const track of textTracks) {
      if (hls && !sidecarValues.has(track.label)) continue;
      track.mode =
        choice !== null && (sidecar ? track.label === choice : track === nativeSelected)
          ? 'showing'
          : 'disabled';
    }
  }

  function adjustSubtitleOffset(change: number) {
    subtitleOffset = Math.max(-30, Math.min(30, Math.round((subtitleOffset + change) * 2) / 2));
    avplay?.setSubtitleOffset(subtitleOffset);
    retimeSubtitles();
  }

  let subtitleOffsetFormatterLanguage: InterfaceLanguage | undefined;
  let subtitleOffsetFormatter: Intl.NumberFormat | undefined;

  /** Profile-locale output for both the compact HUD and its spoken live value. */
  function formattedSubtitleOffset(
    offset = subtitleTimingOffset,
    unitDisplay: 'compact' | 'spoken' = 'compact',
  ): string {
    const language = i18n.language;
    let formatter = subtitleOffsetFormatter;
    if (!formatter || subtitleOffsetFormatterLanguage !== language) {
      formatter = new Intl.NumberFormat(interfaceLocale(language), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
      subtitleOffsetFormatter = formatter;
      subtitleOffsetFormatterLanguage = language;
    }
    const id =
      unitDisplay === 'spoken' ? 'player.subtitleOffsetSpoken' : 'player.subtitleOffsetCompact';
    const english = unitDisplay === 'spoken' ? '{sign}{offset} seconds' : '{sign}{offset}s';
    return i18n.format(id, english, {
      sign: offset >= 0 ? '+' : '',
      offset: formatter.format(offset),
    });
  }

  async function openSubtitleTiming() {
    tvSubtitleTimingOpen = true;
    if (!webTransport) return;
    await renderTick();
    // ActionMenu restores its trigger as its native popover closes. Move into the newly opened editor after that
    // lifecycle, so keyboard users do not have to reverse-tab past every player action to find it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        subtitleTimingPanel?.querySelector<HTMLElement>('button')?.focus(),
      ),
    );
  }

  async function closeSubtitleTiming(focusTrigger = webTransport) {
    tvSubtitleTimingOpen = false;
    scheduleWebControls();
    if (!focusTrigger) return;
    await renderTick();
    // Back to the ⋯ button whose Subtitle timing page opened it.
    playerRoot?.querySelector<HTMLElement>('button.web-more')?.focus();
  }

  function displayedSubtitleTracks(tracks: NonNullable<Session['subtitles']>) {
    const visible = visibleSubtitleTracks(tracks, shownSubtitleLanguages);
    if (maxSubtitlesPerLanguage <= 0) return visible;
    const counts: Record<string, number> = {};
    return visible.filter((track) => {
      if (track.source !== 'opensubtitles') return true;
      const language = track.language.toLowerCase().split('-')[0] ?? track.language;
      const count = counts[language] ?? 0;
      if (count >= maxSubtitlesPerLanguage) return false;
      counts[language] = count + 1;
      return true;
    });
  }

  /**
   * Whether a subtitle here has to come in the HLS playlist itself. Where WebKit plays HLS itself (an iPhone, Safari)
   * it hands the stream to the system player, which shows and lists only the subtitle renditions the playlist names:
   * a page's own `<track>` reaches neither an iPhone's fullscreen player nor its captions menu. TorBox's playlist
   * names none, so a subtitle there is Den Remux's, whose master carries every one it offers.
   */
  function subtitlesNeedPlaylist(): boolean {
    return !castMode && nativeHls(document.createElement('video'));
  }

  async function loadExternalSubtitle(
    current: Session,
    value: string,
    ownsResult: () => boolean,
  ): Promise<boolean> {
    const track = await current.loadExternalSubtitle?.(value);
    if (!track || !ownsResult()) return false;
    // The loader owns and deduplicates blobs; this array is render state for the `<track>` children.
    current.externalSubtitles = [
      ...(current.externalSubtitles ?? []).filter((one) => one.value !== track.value),
      track,
    ];
    await renderTick();
    return true;
  }

  function sendSubtitleChoice() {
    const current = session;
    if (!current?.castOrigin) return;
    const frame = readyCastFrame(current.castOrigin);
    if (!frame) return;
    frame.postMessage(
      {
        type: 'den-subtitle',
        id: current.playlist,
        language: selectedSubtitleLanguage(current),
        track: current.externalSubtitles
          ?.filter((track) => track.value === subtitleChoice && track.castUrl)
          .map((track) => ({
            language: track.language,
            name: track.name,
            url: track.castUrl!,
          }))[0],
      },
      current.castOrigin,
    );
  }

  /** Apple TV deliberately leaves an untagged embedded track as Unknown; a filename is not language evidence. */
  function subtitleValue(track: NonNullable<Session['subtitles']>[number]): string {
    return track.value ?? track.language;
  }

  function selectedSubtitle(
    current: Session | null = session,
    choice: string | null = subtitleChoice,
  ): NonNullable<Session['subtitles']>[number] | undefined {
    return preferredSubtitleTrack(current?.subtitles ?? [], choice);
  }

  function selectedSubtitleLanguage(current: Session | null = session): string | null {
    if (subtitleChoice === null) return null;
    return selectedSubtitle(current)?.language ?? subtitleChoice;
  }

  function subtitleLabel(track: NonNullable<Session['subtitles']>[number]): string {
    const code = track.language.trim().toLowerCase();
    return [
      'und',
      'unknown',
      'srt',
      'sub',
      'subrip',
      'ass',
      'ssa',
      'vtt',
      'pgs',
      'sup',
      'idx',
    ].includes(code)
      ? 'Unknown'
      : track.name;
  }

  function subtitleDescription(
    current: Session,
    track: NonNullable<Session['subtitles']>[number],
  ): string {
    // A Remux rendition can choose its own track or OpenSubtitles lazily when opened. Older Hearths do not expose
    // that final source per row, so call the mixed case what it is rather than falsely branding it Built-in.
    return (
      track.description ??
      (track.source === 'built-in'
        ? 'Built-in'
        : track.source === 'opensubtitles'
          ? 'OpenSubtitles'
          : undefined) ??
      (current.external
        ? 'OpenSubtitles'
        : current.subtitleSource === 'den_subtitles'
          ? 'Built-in / OpenSubtitles'
          : 'Built-in')
    );
  }

  async function chooseSubtitle(next: string | null): Promise<void> {
    const selectionGeneration = ++subtitleSelectionGeneration;
    subtitleLoadFailure = null;
    subtitleResyncRequest?.abort();
    if (next !== subtitleChoice) {
      subtitleResyncNotice = null;
      subtitleResyncOffset =
        session?.externalSubtitles?.find((track) => track.value === next)?.alignedOffset ?? 0;
    }
    // A change once playback has already shown a frame is a signal the file first chosen was wrong,
    // for den-edge's own outcome report (`finish()`) — the very first pick, before anything played, is
    // just Settings' preference taking effect and says nothing about it.
    if (played && next !== subtitleChoice) {
      if (next === null) subtitleTurnedOffMidPlay = true;
      else subtitleSwitchedMidPlay = true;
    }
    if (
      next &&
      session?.external &&
      selectedSubtitle(session, next)?.torboxTrack === undefined &&
      subtitlesNeedPlaylist()
    ) {
      // The same second on Den Remux, whose renditions the system player shows; put back if it refuses.
      const previous = subtitleChoice;
      // Candidate identities are local to the direct sidecar list. Remux names its rendition by language, so
      // carry that portable identity across the delivery switch instead of an OpenSubtitles provider id it cannot
      // expose in its own playlist.
      subtitleChoice = selectedSubtitle(session, next)?.language ?? next;
      switchDelivery(() => (subtitleChoice = previous), 'Switching subtitles…');
      return;
    }
    const current = session;
    const previous = subtitleChoice;
    const requested = selectedSubtitle(current, next);
    const ownsLoad = () =>
      session === current && selectionGeneration === subtitleSelectionGeneration;
    if (current?.external) {
      const nextTrack = selectedSubtitle(current, next);
      const nextTorBox = nextTrack?.torboxTrack;
      if ((current.torboxSubtitle ?? undefined) !== nextTorBox) {
        subtitleChoice = next;
        const pending = showTransition('Switching subtitles…');
        restart(
          {
            filename: current.release.filename,
            ...(nextTorBox === undefined ? {} : { subtitleTrack: nextTorBox }),
          },
          () => (subtitleChoice = previous),
          'direct',
          pending,
        );
        return;
      }
    }
    if (
      next &&
      current &&
      (requested?.delivery === 'sidecar' || requested?.source === 'opensubtitles') &&
      current.loadExternalSubtitle &&
      !current.externalSubtitles?.some((track) => track.value === next)
    ) {
      const pending =
        requested.torboxTrack === undefined ? showTransition('Loading subtitles…') : undefined;
      let loaded = false;
      try {
        loaded = await loadExternalSubtitle(current, next, ownsLoad);
      } catch {
        /* The retry notice below owns this failure. */
      }
      if (!ownsLoad()) {
        clearTransition(pending);
        return;
      }
      const fallback = requested?.fallbackTorboxTrack;
      if (!loaded && fallback !== undefined) {
        subtitleChoice = next;
        restart(
          { filename: current.release.filename, subtitleTrack: fallback },
          () => (subtitleChoice = previous),
          'direct',
          continueManualSwitch(pending, 'Switching subtitles…'),
        );
        return;
      }
      clearTransition(pending);
      if (!loaded) {
        subtitleLoadFailedFlag = true;
        subtitleLoadFailure = requested;
        return;
      }
    }
    subtitleChoice = next;
    applySubtitles();
    sendSubtitleChoice();
  }

  /** SkipDB's segments for what is playing, and the one under the playhead right now. */
  let segments = $state.raw<SkipSegment[]>([]);
  let active = $state<SkipSegment | null>(null);
  /**
   * Kinds already skipped in this session, so a viewer who scrubs back into the credits is not yanked out of
   * them again. Deliberately not `$state`: nothing renders it, and a write must not re-run the tick.
   */
  // A plain record rather than a Set: `svelte/prefer-svelte-reactivity` would have any Set here be a
  // SvelteSet, and reactivity is the one thing this must not have — nothing renders it, and a write must not
  // re-run the tick that made it. Four kinds do not need a Set anyway.
  const skipped: Partial<Record<SkipKind, true>> = {};
  /** The length SkipDB was last asked about; 0 before it was asked. */
  let askedFor = 0;
  /** The release SkipDB was last asked about, by filename. */
  let segmentsOf: string | undefined;
  /** Monotonic request identity: an older release's late answer cannot reset a newer request's dedupe. */
  let segmentRequest = 0;

  /**
   * Asked once the video knows its own length, because SkipDB aligns its times to the encode it is told about
   * — see `fetchSkipSegments`. `imdb` is resolved by then: `begin` resolves it before starting a session.
   */
  async function loadSegments() {
    if (!imdb || segments.length || ended) return;
    // Asked again only for a different length: another release is another encode, but the same one is not asked
    // for at every progress tick of a player that has no `loadedmetadata` to say it once.
    const asked = length();
    if (askedFor > 0 && Math.abs(asked - askedFor) < 2) return;
    askedFor = asked;
    const request = ++segmentRequest;
    const release = session?.release.filename;
    segmentsOf = release;
    const found = await fetchSkipSegments(imdb, {
      season,
      episode,
      durationSeconds: length(),
    });
    if (ended || request !== segmentRequest) return;
    if (session?.release.filename === release) segments = found;
    // Another release started meanwhile: these are the old encode's times. Its own are asked for once it has a length.
    else askedFor = 0;
  }

  /**
   * Four times a second, which is what `timeupdate` gives: enough to offer a button the moment a segment starts
   * and to leave one within a second of it, and far finer than the progress report's minute.
   */
  function tick() {
    const at = video?.currentTime ?? remoteTime;
    if (customTransport) {
      if (!scrubbing) tvPosition = at;
      tvDuration = length();
    }
    // Where it last was, for `carryPosition`'s fallback once the element is gone. How much actually played is
    // `totalPlayedSecs`, from the element's own `played` ranges — never summed here.
    lastPosition = at;
    if (webTransport) {
      tvBuffered = bufferedEnd();
      describeNext(at);
    }
    // The first part-way position once playback starts or resumes goes out now, not a minute later.
    if (session && !(video ? video.paused : remotePaused))
      progress.reportStart(at, length(), { creditsReached: reachedCredits(at) });
    weighDelivery();
    warmNext(at);
    if (!segments.length) return;
    active = activeAt(segments, at);
    if (!autoSkip || !active || !canAutoSkip(active) || skipped[active.kind]) return;
    skipActive();
  }

  /** Whether the next episode has already been warmed. Not `$state`: nothing renders it. */
  let warmedNext = false;

  /** How far the media is buffered past the play head (the range holding it), for the timeline's lighter fill. */
  let tvBuffered = $state(0);
  function bufferedEnd(): number {
    const ranges = video?.buffered;
    const at = video?.currentTime ?? 0;
    if (!ranges) return 0;
    for (let n = 0; n < ranges.length; n++)
      if (ranges.start(n) <= at + 0.5 && at <= ranges.end(n)) return ranges.end(n);
    return 0;
  }
  // `timeupdate` stops while paused, but buffering goes on: `progress` says so.
  $effect(() => {
    const element = video;
    if (!webTransport || !element) return;
    const update = () => (tvBuffered = bufferedEnd());
    element.addEventListener('progress', update);
    return () => element.removeEventListener('progress', update);
  });

  /**
   * The next episode as its season lists it (still, name, runtime), for the up-next card. Asked once, as this one
   * nears its end (`NEXT_DETAIL_LEAD_SECS`), never at open, through the content service that Detail and the TV player read
   * seasons through, with its caching and TMDB rules. Absent, the card shows the episode's numbers alone.
   */
  let nextDetail = $state.raw<EpisodeDetail | null>(null);
  /** How long before the end the next episode is described: well ahead of the card, which shows at the end. */
  const NEXT_DETAIL_LEAD_SECS = 30;
  let nextDetailRequest: AbortController | undefined;
  function describeNext(at: number) {
    const to = nextEpisode;
    if (nextDetailRequest || title.type !== 'tv' || !onnext) return;
    if (to?.season === undefined || to.episode === undefined) return;
    if (!shouldWarmNext(at, length(), NEXT_DETAIL_LEAD_SECS)) return;
    const request = new AbortController();
    nextDetailRequest = request;
    const asked = { season: to.season, episode: to.episode };
    content
      .query(
        { kind: 'season', title: { type: 'tv', id: title.id }, season: asked.season },
        request.signal,
      )
      .then(({ episodes }) => {
        if (request.signal.aborted || episodes.state !== 'ready') return;
        nextDetail = episodes.value.find((item) => item.number === asked.episode) ?? null;
      })
      .catch((error: unknown) => {
        if (!request.signal.aborted) console.warn('The next episode’s details didn’t load.', error);
      });
  }

  /**
   * Resolve the next episode shortly before this one ends, and keep its current season pack ready when possible.
   *
   * Resolving still warms Scout's short-lived list cache. Preparing is narrower: only the exact season-pack group
   * already playing, within the same season, is allowed to queue. `prefetch=1` leaves Scout's TorBox add reserve in
   * charge, so this convenience cannot spend the adds kept for a viewer pressing Play.
   */
  function warmNext(at: number) {
    const activelyWatching = video
      ? !video.paused && !video.ended
      : customTransport && !remotePaused;
    if (warmedNext || !imdb || !onnext || !session || !activelyWatching) return;
    const to = nextEpisode;
    if (!to || !shouldWarmNext(at, length())) return;
    warmedNext = true;
    const playingFilename = session.release.filename;
    const from = { ...playingEpisode };
    void Promise.all([
      fetchSourceList(scout, imdb, routes, from.season, from.episode),
      fetchSourceList(scout, imdb, routes, to.season, to.episode),
    ]).then(async ([current, upcoming]) => {
      const playingBingeGroup = current.sources?.find(
        (source) => source.filename === playingFilename,
      )?.bingeGroup;
      const continuity = continuationPrefetch(
        upcoming.sources ?? [],
        playingBingeGroup,
        from.season,
        to.season,
      );
      if (!continuity) {
        console.info(
          `[Den binge] ${JSON.stringify({ event: 'next-prefetch', outcome: upcoming.sources ? 'no_continuity' : 'list_unavailable', season: to.season, episode: to.episode, answer: upcoming.answer?.kind })}`,
        );
        return;
      }
      const prepared = await prepareSource(continuity.url, true, undefined, true);
      console.info(
        `[Den binge] ${JSON.stringify({ event: 'next-prefetch', outcome: prepared.state, season: to.season, episode: to.episode, continuity: 'binge_group', listedCached: continuity.cached })}`,
      );
    });
  }

  /** Jump just past the active segment — the Skip button's action, and auto-skip's. */
  function skipActive() {
    const segment = active;
    if (!segment) return;
    const total = length();
    const to = total > 0 ? Math.min(total, segment.end) : segment.end;
    if (video) video.currentTime = to;
    else if (!seekCastFrame(to)) return;
    skipped[segment.kind] = true;
    active = null;
  }

  /** The native Den Apple TV exposes this beside its track/stream actions. TV browsers can seek the active decoder
   * directly: the Samsung facade turns this assignment into a serialized AVPlay seek. */
  function playFromBeginning() {
    if (castView) {
      seekTo(0);
      tellReceiver({ type: 'den-play' });
      return;
    }
    if (!video) return;
    video.currentTime = 0;
    tvPosition = 0;
    void video.play();
  }

  function seekBy(seconds: number) {
    const total = length();
    const from = video ? video.currentTime : remoteTime;
    seekTo(Math.max(0, total ? Math.min(from + seconds, total) : from + seconds));
  }

  /** Den's transport moves the picture here, or the receiver's while casting. */
  function seekTo(time: number) {
    if (castView) {
      if (!seekCastFrame(time)) return;
      remoteTime = time;
      tvPosition = time;
      return;
    }
    if (!video) return;
    video.currentTime = time;
    tvPosition = video.currentTime;
  }

  /** While casting, Den's transport is the receiver's remote: what it asks goes to the cast page's Cast session. */
  function tellReceiver(message: { type: string; [field: string]: unknown }): boolean {
    const current = session;
    if (!castView || !current?.castOrigin) return false;
    const frame = readyCastFrame(current.castOrigin);
    if (!frame) return false;
    frame.postMessage({ ...message, id: current.playlist }, current.castOrigin);
    return true;
  }

  function togglePlaying() {
    if (castView) {
      // Shown at once; the receiver's next progress says whether it did.
      if (tellReceiver({ type: tvPaused ? 'den-play' : 'den-pause' })) tvPaused = !tvPaused;
      return;
    }
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }

  $effect(() => {
    if (!oncontrols) return;
    oncontrols({
      play: () => void video?.play(),
      pause: () => video?.pause(),
      seekBy,
    });
    return () => oncontrols(null);
  });

  function setVolume(event: Event) {
    applyVolume(Number((event.currentTarget as HTMLInputElement).value));
  }

  function toggleMuted() {
    if (castView) {
      if (tellReceiver({ type: 'den-volume', muted: !playerMuted })) playerMuted = !playerMuted;
      return;
    }
    if (!video) return;
    video.muted = !video.muted;
    playerMuted = video.muted;
  }

  type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

  /**
   * The player, Den's bar and all, fills the screen where the browser can make an element fullscreen (desktop, iPad,
   * Android). An iPhone cannot: there fullscreen is Apple's own player for the video, and Den's bar is back as it
   * closes (`webkitendfullscreen`).
   */
  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.fullscreenEnabled && playerRoot?.requestFullscreen)
      await playerRoot.requestFullscreen();
    else (video as FullscreenVideo | undefined)?.webkitEnterFullscreen?.();
  }

  $effect(() => {
    const element = video;
    if (!element) return;
    const back = () => {
      tvPaused = element.paused;
      tvPosition = element.currentTime;
      revealWebControls();
    };
    element.addEventListener('webkitendfullscreen', back);
    return () => element.removeEventListener('webkitendfullscreen', back);
  });

  type PictureInPictureVideo = HTMLVideoElement & {
    webkitPresentationMode?: string;
    webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture') => void;
  };

  function canPictureInPicture(): boolean {
    const element = video as PictureInPictureVideo | undefined;
    return !!(
      element &&
      (('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) ||
        element.webkitSetPresentationMode)
    );
  }

  async function togglePictureInPicture() {
    const element = video as PictureInPictureVideo | undefined;
    if (!element) return;
    if ('pictureInPictureElement' in document && document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (element.requestPictureInPicture) {
      await element.requestPictureInPicture();
    } else if (element.webkitSetPresentationMode) {
      element.webkitSetPresentationMode(
        element.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture',
      );
    }
  }

  /**
   * Hide the controls once left alone while playing: 2.5 s after a mouse last moved, 3 s after a touch. Casting, this
   * page is the remote and there is no picture here to uncover, so they stay (`webControlsMayHide`).
   */
  function scheduleWebControls() {
    if (!webTransport) return;
    clearTimeout(webControlsTimer);
    if (webControlsMayHide())
      webControlsTimer = setTimeout(
        () => {
          if (webControlsMayHide()) webControlsVisible = false;
        },
        desktopTransport ? 2_500 : 3_000,
      );
  }

  function revealWebControls(schedule = true) {
    if (!webTransport) return;
    webControlsVisible = true;
    clearTimeout(webControlsTimer);
    if (schedule) scheduleWebControls();
  }

  /**
   * A press on the player. A touch anywhere but the picture is the viewer using the controls, which stay while they
   * do; on the picture, its click decides (`pictureClick`). A mouse reveals them by moving (`onpointermove`).
   */
  function playerPointerDown(event: PointerEvent) {
    lastPointer = event.pointerType;
    shownAtPress = webControlsVisible;
    if (event.pointerType !== 'mouse' && event.target !== video) revealWebControls();
  }

  /**
   * A mouse click on the picture plays or pauses; a tap shows the controls, or hides them, and never pauses. Whether
   * they were showing is read at the press: the focus a tap gives the player (Firefox) reveals them before the click.
   */
  function pictureClick(event: MouseEvent) {
    if (!webTransport) return;
    if (lastPointer === 'touch' || lastPointer === 'pen') pictureTap(event);
    else if (!shownAtPress) revealWebControls();
    else pictureClickMouse(event);
  }

  /** The mouse leaving the window hides the controls at once, when nothing holds them. */
  function playerPointerLeave(event: PointerEvent) {
    if (event.pointerType === 'mouse' && webControlsMayHide()) hideWebControls();
    else scheduleWebControls();
  }

  // Becoming the receiver's remote, the transport starts from where the receiver said it was, and stays shown.
  $effect(() => {
    if (!castView) return;
    untrack(() => {
      tvPaused = remotePaused;
      tvPosition = remoteTime;
      tvDuration = length();
      clearTimeout(webControlsTimer);
      webControlsVisible = true;
    });
  });

  // Den's transport only learns the element's state from events while it is shown: taking over mid-playback, it
  // starts from where the element is.
  $effect(() => {
    if (!webTransport || !video) return;
    const element = video;
    untrack(() => {
      tvPaused = element.paused;
      tvPosition = element.currentTime;
      tvDuration = length();
      revealWebControls();
    });
  });

  /** Ask the cast page's own player, or the receiver it is casting to, to move to `time`. */
  function seekCastFrame(time: number): boolean {
    const current = session;
    if (!current?.castOrigin) return false;
    const frame = readyCastFrame(current.castOrigin);
    if (!frame) return false;
    frame.postMessage({ type: 'den-seek', id: current.playlist, time }, current.castOrigin);
    return true;
  }

  /** Another audio track is another session of the same release (den-remux encodes one), from the same second. */
  function switchAudio(event: Event) {
    switchAudioIndex(Number((event.currentTarget as HTMLSelectElement).value));
  }

  function switchAudioIndex(n: number) {
    if (!session || n === session.audioTrack) return;
    const pending = showTransition('Switching audio…');
    restart({ audioTrack: n, filename: session.release.filename }, undefined, undefined, pending);
  }

  function resyncAudioVideo() {
    if (!session) return;
    const pending = showTransition('Re-syncing audio & video…');
    restart(
      { audioTrack: session.audioTrack, filename: session.release.filename },
      undefined,
      undefined,
      pending,
    );
  }

  /** Another release of the title, from the same second — also after this one wouldn't play. */
  function switchRelease(filename: string) {
    if (!session || filename === session.release.filename) return;
    // Another file gets this browser's full claims: what one release couldn't decode says nothing about
    // whether the next needs converting. The viewer's pick is theirs to make, switched-away-from or not; the
    // others playback left stay left for any automatic pick after it.
    degraded = false;
    excluded = excluded.filter((one) => one !== filename);
    chosenRelease = filename;
    keepReleases();
    switchCount += 1;
    lastSwitchReason = 'user';
    const pending = showTransition('Switching stream…');
    restart({ filename }, undefined, undefined, pending);
  }

  /**
   * Another session for a change asked for: another track, another release, casting. `pick` undefined starts as the
   * player first did: the release it was opened with, else den-remux's choice.
   *
   * Before the first frame it is the start over, chosen as any start is. Once playing it is a replacement: the session
   * playing now plays on until the new one has started, and a conversion is never what replaces it
   * (`transcode: 'never'`) — where only one would do, the change isn't made, `undo` puts back what was set for it, and
   * the viewer is told.
   */
  function restart(
    pick: { audioTrack?: number; subtitleTrack?: number; filename: string } | undefined,
    undo?: () => void,
    asked?: 'direct' | 'ordinary',
    pending?: number,
  ) {
    const current = session;
    if (!current) {
      clearTransition(pending);
      return;
    }
    const delivery = asked ?? (current.external ? 'direct' : 'fallback');
    const compatibleSubtitles = !current.external || !directWithoutDenSubtitles;
    report();
    carryPosition();
    if (played) {
      void begin(pick, { transcode: 'never' }, current, delivery, null, compatibleSubtitles)
        .catch((error: unknown): Failure => {
          console.warn('A requested player change got no answer; this stream carries on.', error);
          return 'unreachable';
        })
        .then((moved) => {
          if (moved !== true) clearTransition(pending);
          // False is a player closed, or a session replaced, meanwhile: nothing to say.
          if (typeof moved !== 'string' || session !== current) return;
          startAt = null;
          undo?.();
          unchanged = unchangedNotice(moved, guestGrants.endedText(), replacementRefusal);
        });
      return;
    }
    void begin(pick, {}, undefined, delivery, null, compatibleSubtitles)
      .catch((error: unknown): Failure => {
        console.warn('A requested player change got no answer.', error);
        return 'unreachable';
      })
      .then((moved) => {
        if (moved !== true) clearTransition(pending);
      });
  }

  function restartForRecovery(
    label: string,
    pick: { audioTrack?: number; subtitleTrack?: number; filename: string } | undefined,
    undo?: () => void,
  ) {
    const pending = showTransition(label);
    restart(pick, undo, undefined, pending);
  }

  /**
   * The stamp's switch: the same release from the second it is at, from the other path — TorBox to Den Remux, or Den
   * Remux to TorBox. Always a replacement, so what plays now plays on until the other has started, and for good
   * where the other path refuses, which the viewer is told and `undo` puts back what was set for it.
   */
  function switchDelivery(undo?: () => void, label?: string) {
    const current = session;
    if (!current || switching || deliverySwitching) return;
    const to = current.external ? 'Den Remux' : 'TorBox';
    playbackRouteLog({
      event: 'viewer_selection',
      from: current.external ? 'torbox' : 'den_remux',
      to: current.external ? 'den_remux' : 'torbox',
      context: 'active_session',
    });
    const pending = showTransition(label ?? `Switching to ${to}…`);
    report();
    carryPosition();
    deliverySwitching = true;
    begin(
      { filename: current.release.filename },
      { transcode: 'never' },
      current,
      current.external ? 'fallback' : 'direct',
    )
      .catch((error: unknown): Failure => {
        console.warn(`A switch to ${to} got no answer; this one carries on.`, error);
        return 'unreachable';
      })
      .then((moved) => {
        if (moved === true) {
          switchCount += 1;
          lastSwitchReason = 'user';
          return;
        }
        clearTransition(pending);
        if (session !== current) return;
        startAt = null;
        if (typeof moved === 'string') {
          undo?.();
          unchanged = deliveryUnchangedNotice(to, moved, guestGrants.endedText());
        }
      })
      .finally(() => (deliverySwitching = false));
  }

  /** A final managed failure has no session to replace, but it must not remove the viewer's route choice. */
  function trySourceWithoutSession(source: 'torbox' | 'den-remux') {
    if (session || !playback || deliverySwitching || switching) return;
    const previousSubtitle = subtitleChoice;
    const compatibleSubtitles = source !== 'torbox';
    if (!compatibleSubtitles) {
      pendingDirectSubtitleRestore = previousSubtitle;
      subtitleChoice = null;
    }
    const pending = showTransition(
      source === 'torbox' ? 'Trying TorBox without Den subtitles…' : 'Trying Den Remux…',
    );
    playbackRouteLog({
      event: 'viewer_selection',
      from: 'unavailable',
      to: source === 'torbox' ? 'torbox' : 'den_remux',
      context: 'no_session',
      subtitleConstraint: compatibleSubtitles ? 'allowed' : 'den_subtitles_disabled',
    });
    deliverySwitching = true;
    void begin(
      chosenRelease ? { filename: chosenRelease } : undefined,
      {},
      undefined,
      source === 'torbox' ? 'direct' : 'fallback',
      null,
      compatibleSubtitles,
    )
      .catch((error: unknown) => {
        console.warn(`The requested ${source} source got no answer.`, error);
        return false;
      })
      .then((moved) => {
        if (moved === true) return;
        clearTransition(pending);
        if (!compatibleSubtitles && !session && retry === undefined) {
          subtitleChoice = previousSubtitle;
          pendingDirectSubtitleRestore = undefined;
        }
      })
      .finally(() => (deliverySwitching = false));
  }

  /**
   * Where the next session starts: where this one is, or — once a failure took its video away — where it last was
   * (`lastPosition`), or was started at. Only a position worth carrying: a release refused before it drew a frame sits
   * at zero, and taking that forward would throw away where the library says this was left.
   */
  function carryPosition() {
    const total = length();
    const at = video?.currentTime ?? lastPosition ?? started ?? remoteTime;
    if (total && at >= 1) startAt = { seconds: at, fraction: at / total };
  }

  function terminalEvidence() {
    const total = length();
    const at = video?.currentTime ?? lastPosition ?? started ?? remoteTime;
    if (!Number.isFinite(at) || !Number.isFinite(total) || total <= 0) return undefined;
    const durationSeconds = Math.max(1, Math.floor(total));
    const positionSeconds = Math.min(durationSeconds, Math.max(0, Math.floor(at)));
    return {
      positionSeconds,
      durationSeconds,
      completed: reachedNaturalEnd || reachedCredits(at) || (total > 0 && at / total >= WATCHED),
    };
  }

  /** End the session held now, carrying where it got to (`carryPosition`), with nothing left playing it. */
  function letGo() {
    const current = session;
    if (!current) return;
    subtitleSelectionGeneration += 1;
    subtitleLoadFailure = null;
    carryPosition();
    // Read while the media is attached: once hls.js or AVPlay lets go, the element's duration is gone, and a direct
    // stream's session names none (`duration: 0`), so the receipt would end with no evidence.
    const evidence = terminalEvidence();
    watcher?.stop();
    watcher = undefined;
    hls?.destroy();
    hls = undefined;
    if (__DEN_TV_PLATFORM__ === 'tizen') {
      avplay?.destroy();
      avplay = undefined;
    }
    endSession(current, undefined, evidence);
    session = null;
  }

  function trackLabel(track: AudioTrack, n: number): string {
    let language: string | undefined;
    try {
      language = track.language ? (names?.of(track.language) ?? track.language) : undefined;
    } catch {
      language = track.language ?? undefined;
    }
    const channels = track.channels === 6 ? ' 5.1' : track.channels === 8 ? ' 7.1' : '';
    return `${language ?? track.name ?? `Track ${n + 1}`}${channels}${track.commentary ? ' · commentary' : ''}`;
  }

  function finish() {
    if (ended) return;
    subtitleResyncRequest?.abort();
    nextDetailRequest?.abort();
    subtitleSelectionGeneration += 1;
    subtitleLoadFailure = null;
    ended = true;
    if (tv) setTvPlaybackActive(false);
    clearInterval(timer);
    clearInterval(heartbeat);
    clearInterval(countdown);
    clearInterval(noticeTimer);
    clearTimeout(retry);
    startingSession?.abort(new DOMException('player closed', 'AbortError'));
    startingSession = undefined;
    // The durable retry receipt is handed off without awaiting it. Decoder and playback-session retirement below
    // stay on the close path even when the library service is offline or a write is deliberately held.
    if (session) {
      const at = video?.currentTime ?? remoteTime;
      if (at > 0)
        progress.final(at, length(), {
          creditsReached: reachedCredits(at),
          naturallyFinished: reachedNaturalEnd,
        });
    }
    // Before hls.js lets go of the media (`letGo` says why).
    const evidence = terminalEvidence();
    const stats = watcher?.stats();
    watcher?.stop();
    watcher = undefined;
    sendReports(stats);
    hls?.destroy();
    hls = undefined;
    // A receiver fetches independently. Closing the sender page must not turn its signed URL into a 410.
    if (session && !casting) endSession(session, undefined, evidence);
  }

  /**
   * den-edge's own outcome and cast reports (den-edge#262 and its identity fields, #246): once per visit — a player's,
   * or one episode's of an advance in place — and only when a session was actually asked for: a player opened and
   * closed before `begin()` got anywhere has nothing to say. Sent before `hls` is destroyed and nulled, while it still
   * names the engine that was playing. `identity` is shared between the two reports: both describe the same episode
   * and, when one was open, the same session.
   */
  function sendReports(stats: ReturnType<Watcher['stats']> | undefined) {
    const chosenSubtitleLanguage = selectedSubtitleLanguage();
    const subtitleLanguage = reportableLanguage(chosenSubtitleLanguage);
    const subtitleIndex = session?.subtitles?.findIndex(
      (track) => subtitleValue(track) === subtitleChoice,
    );
    const identity = identityOf(
      title,
      playingEpisode.season,
      playingEpisode.episode,
      session
        ? {
            release: session.release,
            audioTrack: session.audioTrack,
            audioLanguage: session.audioTracks[session.audioTrack]?.language,
          }
        : undefined,
      {
        index: subtitleIndex,
        language: chosenSubtitleLanguage ?? undefined,
        source: subtitleSourceOf(
          lastSubtitleSource === 'den_subtitles',
          subtitleLanguage !== undefined,
        ),
      },
    );
    if (sessionRoute !== undefined) {
      sendPlaybackOutcome({
        engine: playedEngine ?? (hls ? 'hls.js' : 'native'),
        route: routeKind(sessionRoute),
        stallCount: stats?.stallCount ?? 0,
        stalledMs: Math.round(stats?.stalledMs ?? 0),
        endReason: failure ? 'error' : reachedNaturalEnd ? 'finished' : 'user_exit',
        errorCode: lastFatal?.code,
        hlsFatalType: lastFatal?.hls?.type,
        hlsFatalDetail: lastFatal?.hls?.detail,
        secondsPlayed: Math.round(totalPlayedSecs()),
        ...identity,
        subtitleSwitched: subtitleSwitchedMidPlay,
        subtitleTurnedOff: subtitleTurnedOffMidPlay,
        subtitleLoadFailed: subtitleLoadFailedFlag,
        switchCount: switchCount || undefined,
        lastSwitchReason,
        failSource: failure ? lastFailSource : undefined,
        castFailReason: castFailed ? castFailReason : undefined,
        delivery: session ? (session.external ? 'direct' : 'remux') : undefined,
        lanOffered: session?.lanPlaylist !== undefined || undefined,
        seeks: stats?.seeks,
        droppedFrames: stats?.droppedFrames,
      });
    }
    if (castFunnel) {
      sendCastReport({
        kind: 'chromecast',
        reached: castFunnel,
        failed: castFailed,
        failReason: castFailReason,
        sessionSecs: castSessionSecs > 0 ? Math.round(castSessionSecs) : undefined,
        ...identity,
      });
    }
  }

  /**
   * The next episode of the same series, started in this player rather than a new one (`Library` keys the player by
   * title alone). The `<video>` element stays, and with it fullscreen and Chrome's remoting of a fullscreen video to a
   * Chromecast; a Den Cast receiver keeps its Cast session and is handed the next episode. Everything about the episode
   * itself starts over as a new player's would: its own progress, reports, release, skip segments and up-next.
   */
  function playEpisode(at: Episode) {
    // The outgoing episode's own last word, while its session and position are still here.
    report();
    stay();
    clearInterval(timer);
    clearInterval(heartbeat);
    endCastSession();
    sendReports(watcher?.stats());
    playingEpisode = at;
    progress = reporterFor(at);
    memoryKey = `${title.type}:${title.id}:${at.season ?? ''}:${at.episode ?? ''}`;
    const remembered = recallReleases(memoryKey);
    chosenRelease = filename ?? remembered.chosen;
    excluded = remembered.left;
    releases = [];
    releaseListing = 'idle';
    swapped = autoSwitch = struggling = slowPick = unchanged = null;
    clearTransition();
    showTransition('Starting next…');
    switchCount = 0;
    lastSwitchReason = undefined;
    degraded = false;
    noHint = false;
    breaking = null;
    torbox = 'untried';
    sessionRoute = undefined;
    lastSubtitleSource = undefined;
    playedEngine = undefined;
    lastFatal = undefined;
    lastFailSource = undefined;
    subtitleSwitchedMidPlay = subtitleTurnedOffMidPlay = subtitleLoadFailedFlag = false;
    reachedNaturalEnd = false;
    castFunnel = undefined;
    castFailed = false;
    castFailReason = undefined;
    castSessionSecs = 0;
    casting = false;
    segments = [];
    active = null;
    askedFor = 0;
    segmentsOf = undefined;
    segmentRequest += 1;
    for (const kind of Object.keys(skipped) as SkipKind[]) delete skipped[kind];
    warmedNext = false;
    nextDetailRequest?.abort();
    nextDetailRequest = undefined;
    nextDetail = null;
    hold = null;
    startsIn = null;
    // Only what is on screen is held: after a failure there is no video to keep.
    holding = !!video;
    heldFrame = session?.castOrigin && !failure ? session.castOrigin : undefined;
    letGo();
    // `letGo` carried the outgoing episode's position: the next starts where the library has it.
    startAt = null;
    lastPosition = undefined;
    remoteTime = remoteDuration = 0;
    remotePaused = true;
    void begin();
  }

  // An advance names the next episode; anything else about the title is the same.
  $effect(() => {
    const at = { season, episode };
    if (at.season === playingEpisode.season && at.episode === playingEpisode.episode) return;
    untrack(() => playEpisode(at));
  });

  // Held only until the next session is in, or until it fails, which shows instead.
  $effect(() => {
    if (!session && !failure) return;
    holding = false;
    heldFrame = undefined;
  });

  function close() {
    if (ended) return;
    finish();
    onclose();
  }

  function openPlaybackReceiptHandoff() {
    // Use the player's terminal path first: final progress, decoder/session retirement and an in-flight startup
    // abort must all happen before the parent leaves for the authorized linking flow.
    close();
    onplaybackreceipthandoff();
  }

  /** ActionMenu is a popover in browsers and a modal dialog on TV engines that do not implement popovers. */
  type Notice = {
    text: string;
    dismiss?: () => void;
    action?: { label: string; run: () => void };
    quiet?: boolean;
    busy?: boolean;
    /** An error or an offer: it stays until answered, and the toast lane shows it before any other. */
    urgent?: boolean;
  };
  /** What playback says as it goes, in the order the TV's stack shows it. */
  const notices = $derived.by(() => {
    const list: Notice[] = [];
    if (transitionNotice) list.push({ text: transitionNotice, quiet: true, busy: true });
    if (subtitleResyncNotice) list.push({ text: subtitleResyncNotice, quiet: true });
    const failed = subtitleLoadFailure;
    if (failed)
      list.push({
        text: i18n.format(
          'player.subtitleLoadFailed',
          'Couldn’t load {subtitle} subtitles. Current subtitles unchanged.',
          { subtitle: subtitleLabel(failed) },
        ),
        action: {
          label: i18n.phrase('Try again'),
          run: () => void chooseSubtitle(subtitleValue(failed)),
        },
        urgent: true,
      });
    if (session) {
      if (swapped) list.push({ text: swapped, dismiss: () => (swapped = null) });
      if (autoSwitch)
        list.push({ text: autoSwitch, dismiss: () => (autoSwitch = null), busy: switching });
      else if (visibleBufferLine) list.push({ text: visibleBufferLine, quiet: true, busy: true });
      if (slowPick)
        list.push({
          text: `${slowPick} needs more than this connection is giving: it may pause now and then to catch up.`,
          dismiss: () => (slowPick = null),
          action: { label: 'Try another release', run: tryAnother },
          urgent: true,
        });
      if (struggling)
        list.push({
          text: `This connection is slower than ${struggling} needs, and no lighter release fits it: it may pause now and then to catch up.`,
          dismiss: () => (struggling = null),
        });
      if (unchanged) list.push({ text: unchanged, dismiss: () => (unchanged = null) });
    }
    if (receiptUnsupported)
      list.push({
        text: i18n.phrase(
          'This TV cannot recover managed-playback progress after the page closes. Keep Den open, or link a phone or computer in Settings › Connections.',
        ),
        dismiss: () => (receiptUnsupported = false),
        action: {
          label: playbackReceiptHandoffAsOwner
            ? i18n.text('settings.section.connections')
            : i18n.phrase('Switch to Owner'),
          run: openPlaybackReceiptHandoff,
        },
        urgent: true,
      });
    return list;
  });
  /**
   * The browser's one toast: an error or offer first, which waits to be answered; otherwise the newest kind of quiet
   * notice — the volume as it changes, then the rest in the stack's order. Cast failures and the resume notice live
   * here too rather than over the picture.
   */
  const webToast = $derived.by((): Notice | undefined => {
    if (!webTransport) return undefined;
    const list: Notice[] = [];
    if (volumeNotice) list.push({ text: volumeNotice, quiet: true });
    list.push(...notices);
    const cast = castNotice;
    if (cast)
      list.push({
        text: i18n.phrase(cast.text),
        dismiss: () => (castNotice = null),
        action:
          cast.retry && castState === 'connected' ? { label: 'Retry', run: cast.retry } : undefined,
        urgent: true,
      });
    if (resumedAt)
      list.push({
        text: i18n.format('player.resumedAt', 'Resumed at {time}', { time: resumedAt }),
        action: {
          label: 'Start over',
          run: () => {
            resumedAt = null;
            playFromBeginning();
          },
        },
        dismiss: () => (resumedAt = null),
      });
    return list.find((notice) => notice.urgent) ?? list[0];
  });

  /** The path playing: TorBox's own player (Hearth's direct path) or a Den Remux session. */
  const playbackSource = $derived(session ? (session.external ? 'TorBox' : 'Den Remux') : 'Source');
  /** Why the switch to TorBox is off while Den Remux plays, for a cause that will not pass by trying again. */
  const sourceRuledOut = $derived(
    session?.external === true
      ? undefined
      : (torboxRuledOut(managedCause) ??
          (typeof torbox === 'object' ? torbox.unavailable : undefined)),
  );

  function sourceLabel(): string {
    return session
      ? i18n.format('player.playingFrom', 'Playing from {source}', { source: playbackSource })
      : i18n.phrase('Choose playback source');
  }

  /** Which path plays and why, said above the switch to the other one. */
  function sourceNote(): string {
    if (!session) return i18n.phrase('Playback has no active source. Try either path explicitly.');
    if (session.external)
      return directWithoutDenSubtitles
        ? session.subtitles?.some((track) => track.torboxTrack !== undefined)
          ? i18n.phrase(
              'Playing directly from TorBox. Den subtitles were not requested; embedded TorBox subtitles remain available.',
            )
          : i18n.phrase(
              'Playing directly from TorBox. Den subtitles were not requested, and this release has no embedded TorBox subtitles.',
            )
        : i18n.phrase('Playing directly from TorBox');
    return sourceRuledOut
      ? i18n.format('player.playingThroughReason', 'Playing through Den Remux. {reason}.', {
          reason: i18n.phrase(sourceRuledOut),
        })
      : i18n.phrase('Playing through Den Remux');
  }

  /**
   * The switch to the other path — disabled, with the note saying why, where TorBox can't play here: a stream restarts
   * only on that choice. With no session, either path may be tried.
   */
  function sourceItems(): MenuItem[] {
    const ruledOut = sourceRuledOut;
    if (!session)
      return [
        {
          kind: 'item',
          label: i18n.phrase('Try TorBox without Den subtitles'),
          description: i18n.phrase(ruledOut ?? 'Play the release directly, without Den subtitles'),
          disabled: !!ruledOut || deliverySwitching || switching,
          onselect: () => trySourceWithoutSession('torbox'),
        },
        {
          kind: 'item',
          label: 'Try Den Remux',
          description: 'Use the home player for compatible audio and subtitles',
          disabled: deliverySwitching || switching,
          onselect: () => trySourceWithoutSession('den-remux'),
        },
      ];
    const external = session.external === true;
    // The system player shows only a playlist's subtitles, and TorBox's names none: the switch turns one off.
    const dropsSubtitle = !external && subtitleChoice !== null && subtitlesNeedPlaylist();
    return [
      {
        kind: 'item',
        label: i18n.format('player.switchTo', 'Switch to {source}', {
          source: external ? 'Den Remux' : 'TorBox',
        }),
        description: external
          ? i18n.phrase('For audio or subtitles this browser can’t play, or a stream that stalls')
          : ruledOut
            ? undefined
            : dropsSubtitle
              ? i18n.phrase('Turns subtitles off: this player shows only Den Remux’s')
              : i18n.phrase('Straight from the source, no conversion'),
        disabled: !!ruledOut || deliverySwitching || switching,
        onselect: () => {
          if (!dropsSubtitle) return switchDelivery();
          const previous = subtitleChoice;
          subtitleChoice = null;
          switchDelivery(() => (subtitleChoice = previous));
        },
      },
    ];
  }

  function releaseNote(): string | undefined {
    return releaseListing === 'loading'
      ? 'Finding the other available streams…'
      : releaseListing === 'failed'
        ? 'Couldn’t refresh the stream list. The stream already playing is still available.'
        : releaseListing === 'ready' && releaseChoices().length === 1
          ? 'One stream is available.'
          : undefined;
  }

  /** Each stream with what tells them apart — quality and size over the release's file name — the playing one ticked. */
  function releaseItems(): MenuItem[] {
    const playingFile = session?.release.filename;
    return releaseChoices().map((release) => ({
      kind: 'radio',
      key: release.filename,
      group: 'release',
      label: optionLabel(release),
      description: release.filename,
      checked: release.filename === playingFile,
      disabled: release.plays === 'no',
      onselect: () => switchRelease(release.filename),
    }));
  }

  /**
   * A row of the browser's options (`optionRows`): what it is set to now (`value`), the section it is listed under, or a
   * page of rows it opens in place (`page`).
   */
  type OptionItem = MenuItem & {
    value?: string;
    section?: string;
    page?: { heading?: string; note?: string; items: () => OptionItem[] };
  };
  const NO_ACTION = () => {};

  function audioTrackItems(section?: string): OptionItem[] {
    const current = session;
    if (!current) return [];
    return [
      ...current.audioTracks.map((track, n) => ({
        kind: 'radio' as const,
        group: 'audio',
        label: trackLabel(track, n),
        checked: n === current.audioTrack,
        onselect: () => switchAudioIndex(n),
        section,
      })),
      { kind: 'item', label: 'Re-sync audio & video', onselect: resyncAudioVideo, section },
    ];
  }

  /** Den owns the subtitle choice so it can tell built-in tracks from OpenSubtitles candidates, with their match. */
  function subtitleTrackItems(section?: string): OptionItem[] {
    const current = session;
    if (!current) return [];
    return [
      {
        kind: 'radio',
        group: 'subtitle',
        label: 'Off',
        checked: subtitleChoice === null,
        onselect: () => void chooseSubtitle(null),
        section,
      },
      ...(current.subtitles ?? []).map((track) => ({
        kind: 'radio' as const,
        group: 'subtitle',
        label: subtitleLabel(track),
        description: subtitleDescription(current, track),
        checked: subtitleValue(track) === subtitleChoice,
        onselect: () => void chooseSubtitle(subtitleValue(track)),
        section,
      })),
      ...subtitleResyncItems().map((item) => ({ ...item, section })),
    ];
  }

  function subtitleTimingItems(): MenuItem[] {
    const offset = formattedSubtitleOffset();
    return [
      {
        kind: 'item',
        label: i18n.format('player.adjustSubtitleTiming', 'Adjust subtitle timing ({offset})', {
          offset,
        }),
        onselect: openSubtitleTiming,
      },
      {
        kind: 'item',
        label: i18n.format('player.resetSubtitleTiming', 'Reset subtitle timing ({offset})', {
          offset,
        }),
        disabled: subtitleOffset === 0,
        onselect: () => {
          subtitleOffset = 0;
          avplay?.setSubtitleOffset(0);
          retimeSubtitles();
        },
      },
    ];
  }

  /** What plays now, audio then subtitles, for the dock's button and the options' first row. */
  function audioSubtitleSummary(): { audio: string; subtitles: string } {
    const current = session;
    const track = current?.audioTracks[current.audioTrack] ?? current?.audioTracks[0];
    const subtitle = preferredSubtitleTrack(current?.subtitles ?? [], subtitleChoice);
    return {
      audio: track && current ? trackLabel(track, current.audioTrack) : '',
      subtitles: subtitle ? subtitleLabel(subtitle) : i18n.phrase('Off'),
    };
  }

  /** Audio and subtitles on one page, the way Apple's player lists them. */
  function audioSubtitleItems(): OptionItem[] {
    const current = session;
    if (!current) return [];
    return [
      ...(current.audioTracks.length ? audioTrackItems(i18n.phrase('Audio')) : []),
      ...(current.subtitles?.length ? subtitleTrackItems(i18n.phrase('Subtitles')) : []),
    ];
  }

  /** Keys the player answers, listed on the desktop's options so they can be found. */
  const SHORTCUTS: [string, string][] = [
    ['Play or pause', 'Space · K'],
    ['Back or forward 10 seconds', '← → · J L'],
    ['Volume', '↑ ↓'],
    ['Mute', 'M'],
    ['Fullscreen', 'F'],
    ['Subtitles on or off', 'C'],
    ['Next episode', 'Shift N'],
    ['Close', 'Esc'],
  ];

  /**
   * The ⋯ menu: every setting used once a title rather than mid-scene, each row with its current value. Without a
   * session (a source to choose after a failure) only the Source row.
   */
  function optionItems(): OptionItem[] {
    const current = session;
    const items: OptionItem[] = [];
    const page = (label: string, value: string | undefined, opens: OptionItem['page']) =>
      items.push({ kind: 'item', label, value, onselect: NO_ACTION, page: opens });
    if (current) {
      if (audioSubtitleItems().length) {
        const now = audioSubtitleSummary();
        page('Audio & subtitles', [now.audio, now.subtitles].filter(Boolean).join(' · '), {
          items: audioSubtitleItems,
        });
      }
      page('Stream', pickLabel(current.release), {
        heading: 'Streams',
        note: releaseNote(),
        items: releaseItems,
      });
    }
    if (!casting && playback && (current || sourceRecovery))
      page('Source', playbackSource, {
        heading: sourceLabel(),
        note: sourceNote(),
        items: sourceItems,
      });
    if (current && subtitleChoice !== null)
      page(i18n.text('player.subtitleTiming'), formattedSubtitleOffset(), {
        items: subtitleTimingItems,
      });
    if (current)
      items.push({ kind: 'item', label: 'Play from beginning', onselect: playFromBeginning });
    if (desktopTransport)
      page('Keyboard shortcuts', undefined, {
        items: () =>
          SHORTCUTS.map(([label, keys]) => ({
            kind: 'item',
            label,
            value: keys,
            disabled: true,
            onselect: NO_ACTION,
          })),
      });
    return items;
  }

  /** The options' open page, by its row's label; null on their first page. */
  let optionsPage = $state<string | null>(null);
  /** That page as the rows describe it now, so its note follows what is happening (a stream list still loading). */
  function openOptionsPage() {
    return optionsPage === null
      ? undefined
      : optionItems().find((item) => item.label === optionsPage)?.page;
  }

  /**
   * Into a row's page, or back out of it (`label` null): the options stay open — a popover keeps its bottom edge where
   * it was, above its button, as it grows or shrinks — and focus goes to the page's first row or, coming back, to the
   * row that opened it.
   */
  async function showOptionsPage(label: string | null) {
    const from = optionsPage;
    const menu = document.querySelector<HTMLElement>('.menu:popover-open:has(.options-rows)');
    const bottom = menu?.getBoundingClientRect().bottom;
    optionsPage = label;
    await renderTick();
    if (menu && bottom !== undefined && !menu.classList.contains('sheet'))
      menu.style.top = `${Math.max(8, bottom - menu.offsetHeight)}px`;
    const rows = Array.from(
      menu?.querySelectorAll<HTMLElement>(
        '.options-rows [role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
    const target = label
      ? rows.find((row) => !row.classList.contains('back'))
      : rows.find((row) => from && row.getAttribute('aria-label')?.startsWith(i18n.phrase(from)));
    (target ?? rows[0])?.focus();
  }

  /** Consecutive rows of one section under its name; rows without one stand alone. */
  function optionSections(items: OptionItem[]) {
    const out: { section?: string; rows: { item: OptionItem; i: number }[] }[] = [];
    items.forEach((item, i) => {
      const last = out.at(-1);
      if (last && last.section === item.section) last.rows.push({ item, i });
      else out.push({ section: item.section, rows: [{ item, i }] });
    });
    return out;
  }

  /**
   * Ten seconds back or forward. Within `SEEK_STACK_MS` of the last on the same side it adds up, shown as one ripple
   * ("−20 s"), as a double-tap followed by more taps does, and as J or L pressed again does.
   */
  function stackSeek(side: -1 | 1) {
    const now = performance.now();
    const streak = seekStreak;
    seekStreak = {
      side,
      count:
        streak && streak.side === side && now - streak.at < SEEK_STACK_MS ? streak.count + 1 : 1,
      at: now,
    };
    seekBy(side * SKIP_SECS);
    clearTimeout(seekStreakTimer);
    seekStreakTimer = setTimeout(() => (seekStreak = null), SEEK_STACK_MS);
  }
  const SEEK_STACK_MS = 600;
  /** How soon a second tap on the picture makes the first a double-tap. */
  const DOUBLE_TAP_MS = 300;
  /** How long a click on the picture is held for a second one (a double-click is fullscreen). */
  const CLICK_HOLD_MS = 250;
  const FLASH_MS = 400;

  /**
   * A tap on the picture shows or hides the controls and never pauses. A second within `DOUBLE_TAP_MS` on the left or
   * right 40% seeks ten seconds that way instead, leaving the controls up, and each tap after it adds ten more; in the
   * middle a double-tap undoes the first tap's toggle and does nothing else.
   */
  function pictureTap(event: MouseEvent) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = box.width ? (event.clientX - box.left) / box.width : 0.5;
    const side = x < 0.4 ? -1 : x > 0.6 ? 1 : 0;
    const now = performance.now();
    const streak = seekStreak;
    if (side && streak?.side === side && now - streak.at < SEEK_STACK_MS) {
      stackSeek(side);
      revealWebControls();
      return;
    }
    const first = lastTap;
    if (first && now - first.at < DOUBLE_TAP_MS) {
      lastTap = null;
      if (side && first.side === side) {
        stackSeek(side);
        revealWebControls();
      } else if (first.shown) revealWebControls();
      else hideWebControls();
      return;
    }
    lastTap = { at: now, side, shown: shownAtPress };
    if (!shownAtPress) revealWebControls();
    else hideWebControls();
  }

  /**
   * A mouse click on the picture plays or pauses, a moment late: a second click within `CLICK_HOLD_MS` makes it a
   * double-click, which is fullscreen and leaves playback as it was.
   */
  function pictureClickMouse(event: MouseEvent) {
    clearTimeout(clickHold);
    if (event.detail > 1) return;
    clickHold = setTimeout(() => {
      const resuming = tvPaused;
      togglePlaying();
      revealWebControls();
      if (!resuming) return;
      pictureFlash = true;
      setTimeout(() => (pictureFlash = false), FLASH_MS);
    }, CLICK_HOLD_MS);
  }

  function pictureDoubleClick() {
    if (!webTransport || lastPointer === 'touch' || lastPointer === 'pen') return;
    clearTimeout(clickHold);
    void toggleFullscreen();
  }

  /** C: subtitles off, or back on — the last one shown, else the preferred language's. */
  function toggleSubtitles() {
    const tracks = session?.subtitles ?? [];
    if (!tracks.length) return;
    if (subtitleChoice !== null) {
      lastSubtitle = subtitleChoice;
      void chooseSubtitle(null);
      return;
    }
    const track =
      preferredSubtitleTrack(tracks, lastSubtitle ?? subtitleLanguage ?? interfaceLanguage) ??
      tracks[0];
    if (track) void chooseSubtitle(subtitleValue(track));
  }

  /** The volume set here, or the receiver's while casting. */
  function applyVolume(volume: number) {
    if (castView) {
      if (tellReceiver({ type: 'den-volume', level: volume, muted: volume === 0 })) {
        playerVolume = volume;
        playerMuted = volume === 0;
      }
      return;
    }
    if (!video) return;
    video.volume = volume;
    video.muted = volume === 0;
    playerVolume = volume;
    playerMuted = video.muted;
  }

  /** Up and Down, or the wheel over the slider: five per cent a step, said in the toast lane. */
  function nudgeVolume(change: number) {
    const from = playerMuted ? 0 : playerVolume;
    const to = Math.round(Math.max(0, Math.min(1, from + change)) * 100) / 100;
    applyVolume(to);
    volumeNotice = i18n.format('player.volume', 'Volume {percent}%', {
      percent: Math.round(to * 100),
    });
  }

  /** A focused timeline: ten seconds a step either way, a minute for Page Up and Page Down. */
  function timelineKey(event: KeyboardEvent) {
    const step =
      event.key === 'ArrowLeft'
        ? -SKIP_SECS
        : event.key === 'ArrowRight'
          ? SKIP_SECS
          : event.key === 'PageDown'
            ? -60
            : event.key === 'PageUp'
              ? 60
              : 0;
    if (!step) return;
    event.preventDefault();
    seekBy(step);
  }

  /** Whether the controls may hide now: never while there is something to read, hold or press in them. */
  function webControlsMayHide(): boolean {
    // A failure's message and the options to recover from it stay up, as does a paused or casting player.
    if (!webTransport || castView || failure || video?.paused) return false;
    if (playerMenuOpen() || tvSubtitleTimingOpen || castFocus || timelineHeld || upNext !== null)
      return false;
    // A mouse over the top bar or the dock, or keyboard focus among the controls, holds them up. A touch screen leaves
    // `:hover` on whatever was tapped last, so there a tap on a control must not hold them up for good.
    if (desktopTransport && (webTop?.matches(':hover') || webBar?.matches(':hover'))) return false;
    const focused = document.activeElement;
    return !(
      focused instanceof HTMLElement &&
      focused !== playerRoot &&
      playerRoot?.contains(focused) &&
      focused.matches(':focus-visible')
    );
  }

  function hideWebControls() {
    clearTimeout(webControlsTimer);
    webControlsVisible = false;
  }

  function playerMenuOpen(): boolean {
    return __DEN_TV__
      ? document.querySelector('.player dialog[role="menu"][open]') !== null
      : document.querySelector('.player [popover]:popover-open') !== null;
  }

  /** Tabbable controls in the modal player, in DOM order. Hidden and unavailable controls do not hold the loop. */
  function playerTabStops(): HTMLElement[] {
    if (!playerRoot) return [];
    return Array.from(
      playerRoot.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        element.getAttribute('aria-disabled') !== 'true' &&
        element.getAttribute('aria-hidden') !== 'true' &&
        element.getClientRects().length > 0,
    );
  }

  function playerKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && tvSubtitleTimingOpen) {
      event.preventDefault();
      void closeSubtitleTiming();
      return;
    }
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !document.fullscreenElement &&
      !playerMenuOpen()
    ) {
      close();
      return;
    }
    // This is a modal surface rather than an overlay people can tab through. ActionMenu owns Tab while it is open;
    // otherwise loop at the two boundaries and leave every intermediate browser-native movement alone.
    if (event.key === 'Tab' && !tv && !playerMenuOpen()) {
      const stops = playerTabStops();
      const first = stops[0];
      const last = stops.at(-1);
      if (
        first &&
        last &&
        ((event.shiftKey &&
          (document.activeElement === first || document.activeElement === playerRoot)) ||
          (!event.shiftKey && document.activeElement === last))
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (!webTransport || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const target = event.target as HTMLElement | null;
    if (target?.matches('button, a, input, select, textarea, [role="menuitem"], [contenteditable]'))
      return;
    const key = event.key.toLowerCase();
    // Shift is held only for Shift+N: any other key with it is left to the browser.
    if (event.shiftKey) {
      if (key !== 'n' || !onnext || !next) return;
      stay();
      onnext();
    } else if (key === ' ' || key === 'k') togglePlaying();
    else if (event.key === 'ArrowLeft' || key === 'j') stackSeek(-1);
    else if (event.key === 'ArrowRight' || key === 'l') stackSeek(1);
    else if (event.key === 'ArrowUp') nudgeVolume(0.05);
    else if (event.key === 'ArrowDown') nudgeVolume(-0.05);
    else if (key === 'm') toggleMuted();
    else if (key === 'f') void toggleFullscreen();
    else if (key === 'c') toggleSubtitles();
    else return;
    revealWebControls();
    event.preventDefault();
  }

  // What the lock screen, the system's media controls and a headset's buttons show and do: the title and its poster —
  // the size the poster cards already loaded, and the detail page's — and the video's own transport.
  $effect(() => {
    const element = video;
    if (!element || !('mediaSession' in navigator)) return;
    const media = navigator.mediaSession;
    const poster = title.posterPath;
    media.metadata = new MediaMetadata({
      ...(season !== undefined
        ? { title: `S${season} · E${episode}`, artist: title.title, album: title.title }
        : { title: title.title }),
      artwork: poster
        ? [342, 500].map((width) => ({
            src: `https://image.tmdb.org/t/p/w${width}${poster}`,
            sizes: `${width}x${width * 1.5}`,
            type: 'image/jpeg',
          }))
        : [],
    });
    const seek = (to: number) => {
      const total = length();
      element.currentTime = Math.max(0, total ? Math.min(to, total) : to);
    };
    const handlers: Parameters<typeof media.setActionHandler>[] = [
      [
        'play',
        () =>
          void element
            .play()
            .catch((error: unknown) => console.warn('The system’s Play was refused.', error)),
      ],
      ['pause', () => element.pause()],
      ['seekbackward', (d) => seek(element.currentTime - (d.seekOffset ?? SKIP_SECS))],
      ['seekforward', (d) => seek(element.currentTime + (d.seekOffset ?? SKIP_SECS))],
      ['seekto', (d) => d.seekTime !== undefined && seek(d.seekTime)],
    ];
    // A browser without a control for an action throws on it rather than ignoring it.
    const set = (...args: Parameters<typeof media.setActionHandler>) => {
      try {
        media.setActionHandler(...args);
      } catch {
        // no such control here
      }
    };
    for (const [action, handler] of handlers) set(action, handler);
    return () => {
      for (const [action] of handlers) set(action, null);
      media.metadata = null;
    };
  });

  $effect(() => {
    untrack(() => void begin());
    const focusBeforePlayer = document.activeElement as HTMLElement | null;
    const root = untrack(() => playerRoot);
    let initialFocusFrame: number | undefined;
    if (!tv)
      initialFocusFrame = requestAnimationFrame(() => {
        if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
      });
    // The page behind stays put: it would otherwise scroll under a player that covers it.
    const scrolls = [document.documentElement, document.body].map(
      (el) => [el, el.style.overflow] as const,
    );
    for (const [el] of scrolls) el.style.overflow = 'hidden';
    addEventListener('pagehide', finish);
    addEventListener('message', castMessage);
    return () => {
      if (initialFocusFrame !== undefined) cancelAnimationFrame(initialFocusFrame);
      clearTimeout(webControlsTimer);
      for (const [el, overflow] of scrolls) el.style.overflow = overflow;
      removeEventListener('pagehide', finish);
      removeEventListener('message', castMessage);
      finish();
      if (focusBeforePlayer?.isConnected) focusBeforePlayer.focus({ preventScroll: true });
    };
  });

  $effect(() => {
    if (!__DEN_TV__) return;
    let uninstall: (() => void) | undefined;
    void import('../tv/player/remote').then(({ installTvRemote }) => {
      if (ended) return;
      uninstall = installTvRemote({
        close,
        next: onnext,
        pause: () => video?.pause(),
        play: () => video?.play(),
        paused: () => video?.paused ?? true,
        adjustSubtitleTiming: (seconds) => {
          if (!tvSubtitleTimingOpen) return false;
          adjustSubtitleOffset(seconds);
          return true;
        },
        closeSubtitleTiming: () => {
          if (!tvSubtitleTimingOpen) return false;
          tvSubtitleTimingOpen = false;
          return true;
        },
        seekBy: (seconds) => {
          if (!video) return;
          const total = length();
          video.currentTime = Math.max(
            0,
            total ? Math.min(video.currentTime + seconds, total) : video.currentTime + seconds,
          );
        },
        showDetails: () => {
          if (!fullTvTransport) return;
          tvDetailsOpen = true;
          void renderTick().then(() =>
            document.querySelector<HTMLElement>('.tv-details a')?.focus({ preventScroll: true }),
          );
        },
        closeDetails: () => {
          if (!tvDetailsOpen) return false;
          tvDetailsOpen = false;
          return true;
        },
      });
    });
    return () => uninstall?.();
  });
</script>

<!-- Escape with one of the player's menus open closes that menu, not the player: the menu has taken the key
     (`defaultPrevented`), or — focus still on its trigger — it is open as the key arrives. -->
<svelte:window onkeydown={playerKey} />
<!-- A phone locked or a tab switched away may never come back: where it got to is written as it goes. -->
<svelte:document
  onfullscreenchange={() => (playerFullscreen = !!document.fullscreenElement)}
  onvisibilitychange={() => {
    if (document.visibilityState !== 'hidden') return;
    if (tv) close();
    else report();
  }}
/>

<div
  bind:this={playerRoot}
  class="player"
  class:full-tv-player={fullTvTransport}
  class:web-custom-player={webTransport}
  class:web-touch-player={webTransport && !desktopTransport}
  class:web-controls-hidden={webTransport && !webControlsVisible}
  class:web-casting={webTransport && castView}
  class:web-counting={webTransport && upNext !== null}
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-label={heading}
  onpointerdown={playerPointerDown}
  onpointermove={(event) => {
    // A finger that wobbles during a tap on the picture must not reveal what that tap is about to hide.
    if (event.pointerType === 'mouse') revealWebControls();
  }}
  onpointerleave={playerPointerLeave}
  onfocusin={() => revealWebControls(false)}
  onfocusout={scheduleWebControls}
>
  {#if webTransport}
    <!-- Close and what is playing at the top, and the one output slot at its right end: Cast or AirPlay, the same place
         on every size. The slot's box depends only on this bar, so the cast page's frame drawn over it moves only as
         the window does, never as the dock below gains or loses a button. -->
    <header class="web-top" bind:this={webTop}>
      <button
        class="web-glyph web-close"
        type="button"
        aria-label="Close player"
        data-tip={i18n.phrase('Close')}
        data-key="Esc"
        onclick={close}
      >
        <ButtonIcon name="close" />
      </button>
      <div class="web-heading">
        <b>{title.title}</b>
        {#if season !== undefined}<span>S{season} · E{episode}</span>{/if}
      </div>
      <span class="web-output">
        {#if session && airPlayCapable}
          <button
            class="web-glyph output-action"
            class:web-on={airPlayActive}
            type="button"
            aria-label={airPlayAvailability === 'unavailable'
              ? 'AirPlay, no devices available'
              : airPlayActive
                ? 'Change AirPlay device'
                : 'AirPlay'}
            aria-pressed={airPlayActive}
            data-tip={i18n.phrase('AirPlay')}
            disabled={airPlayAvailability === 'unavailable'}
            onclick={offerAirPlay}
          >
            <ButtonIcon name="airplay" />
          </button>
        {/if}
        {#if castSlotShown}
          {@render castButtonSlot('web-glyph output-action')}
        {/if}
      </span>
    </header>
    <!-- One toast at a time, under the top bar: in the black band above an upright phone's picture, never over it. An
         actionable one or an error stays until it is answered and holds back the rest; quiet ones fade (`fades`). -->
    <div class="notices web-toasts">
      {#if webToast}
        {@render banner(webToast.text, webToast)}
      {/if}
    </div>
  {:else}
    <header>
      <b>{heading}</b>
      {#if session || sourceRecovery}
        <!-- Which path is playing, so anyone can tell at a glance: TorBox's own player (Hearth's direct path) or a Den
             Remux session. Wherever Hearth chooses the path it opens a menu saying so, with the switch to the other
             in it (`sourceItems`): a stream restarts only on that choice, never on a press of the stamp itself. -->
        {#if !casting && playback}
          <ActionMenu
            label={sourceLabel()}
            note={sourceNote()}
            triggerClass="den-button den-button-player den-button-compact player-source-switch"
            onclose={scheduleWebControls}
            items={sourceItems}
          >
            {#snippet glyph()}<span data-testid="playback-source">{playbackSource}</span>{/snippet}
          </ActionMenu>
        {:else}
          <span class="source-stamp" data-testid="playback-source">{playbackSource}</span>
        {/if}
      {/if}
      {#if !customTransport && castSlotShown}
        {@render castButtonSlot(
          'den-button den-button-player den-button-icon player-header-action cast',
        )}
      {/if}
      <Button
        variant="player"
        size="icon"
        class="player-header-action"
        icon="close"
        ariaLabel="Close"
        onclick={close}
      />
    </header>
    <!-- What playback says as it goes, above the video and apart from what is playing below it: banners that fade
         on their own (`fades`) unless they offer something to do, and the buffering line, which clears itself the
         moment playback resumes. -->
    <div class="notices">
      {#each notices as notice, n (n)}
        {@render banner(notice.text, notice)}
      {/each}
    </div>
  {/if}
  <div class="stage" bind:this={stageElement}>
    {#if castNotice && !webTransport}
      <!-- A Cast failure belongs to the Cast control, not the playback layout: one stable surface over the picture,
           which neither moves nor resizes what is playing. A browser says it in its toast lane. -->
      {@const notice = castNotice}
      <div class="cast-status">
        {@render banner(i18n.phrase(notice.text), {
          dismiss: () => (castNotice = null),
          action:
            notice.retry && castState === 'connected'
              ? { label: 'Retry', run: notice.retry }
              : undefined,
        })}
      </div>
    {/if}
    {#if failure === 'login'}
      <form class="terminal-message" onsubmit={letIn}>
        <p>
          Your library’s scout install can only check what’s available, so playing it here needs a
          browser key from the homelab (<code>remux-browser-key.txt</code>) — once; the browser
          keeps it for a month.
        </p>
        <input
          type="password"
          bind:value={key}
          autocomplete="current-password"
          aria-label="Browser key"
        />
        <Button
          type="submit"
          variant="primary"
          label="Let this browser in"
          disabled={!key.trim()}
        />
        {#if badKey}<p class="error" role="alert">
            That isn’t one of the homelab’s browser keys.
          </p>{/if}
      </form>
    {:else if failure === 'sourceUnavailable' && managedCause === 'torbox_rate_limited'}
      {@render banner(managedCauseMessages[managedCause], { busy: true, startup: true })}
    {:else if failure === 'sourceUnavailable' && managedCause}
      <div class="terminal-message error" role="alert">
        <p>{managedCauseMessages[managedCause]}</p>
        {#if managedCause !== 'torbox_managed_streaming_unavailable_for_plan'}
          <Button variant="primary" label="Try again" onclick={tryAgain} />
        {/if}
      </div>
    {:else if failure === 'none' && skippedFormats.length}
      <div class="terminal-message error" role="alert">
        <p>
          The releases of this that are ready are {skippedFormats
            .map((ext) => ext.slice(1).toUpperCase())
            .join(' and ')} files, which Den can’t play in a browser yet. Try again once another release
          is out, or play it on your TV.
        </p>
      </div>
    {:else if failure === 'busy' || failure === 'starting' || failure === 'transcode' || failure === 'timedOut' || failure === 'temporarilyUnavailable'}
      {@render banner(
        managedCause === 'debrid_down' || managedCause === 'debrid_slow'
          ? managedCauseMessages[managedCause]
          : waits[failure],
        { busy: true, startup: true },
      )}
    {:else if failure === 'lost'}
      <div class="terminal-message" role="alert">
        <p>The connection was gone too long for this to carry on.</p>
        <Button
          variant="primary"
          label={i18n.format('player.resumeFrom', 'Resume from {time}', {
            time: clockTime(lostAt),
          })}
          onclick={resumeLost}
        />
      </div>
    {:else if failure === 'ended'}
      <div class="terminal-message error" role="alert">
        <p>
          {guestGrants.endedText() ?? 'Your access ended'}. Ask whoever shared their library with
          you.
        </p>
      </div>
    {:else if failure}
      <div class="terminal-message error" role="alert">
        <p>{messages[failure]}</p>
        {#if failure === 'playback' && session}
          <Button
            variant="primary"
            label="Try another release"
            disabled={switching}
            onclick={tryAfterRefusal}
          />
        {/if}
        {#if failure === 'engine'}
          <!-- Not another `import()`: on the dev server Chromium answered a second one of the chunk whose fetch failed
               with the same failure, fetching nothing (e2e/player-engine.spec.mjs). A reload fetches it again. -->
          <Button variant="primary" label="Reload" onclick={() => location.reload()} />
        {/if}
        {#if failure === 'request' || failure === 'protocol'}
          <Button variant="primary" label="Reload" onclick={() => location.reload()} />
        {:else if failure === 'unreachable' || failure === 'sourceUnavailable'}
          <Button variant="primary" label="Try again" onclick={tryAgain} />
        {/if}
      </div>
    {:else if !session && !holding}
      {#if visibleStartupNotice}
        {@render banner(visibleStartupNotice.text, {
          busy: true,
          quiet: true,
          startup: true,
          clock: visibleStartupNotice.clock,
        })}
      {/if}
    {:else}
      {#if !session?.castOrigin}
        <!-- den-remux supplies subtitle renditions through the HLS playlist. -->
        <video
          bind:this={video}
          controls={!customTransport}
          autoplay
          playsinline
          use:allowAirPlay
          onclick={pictureClick}
          ondblclick={pictureDoubleClick}
          onvolumechange={() => {
            playerVolume = video?.volume ?? playerVolume;
            playerMuted = video?.muted ?? playerMuted;
          }}
          onloadedmetadata={() => {
            seekToStart();
            if (customTransport) {
              tvPosition = video?.currentTime ?? 0;
              tvDuration = length();
            }
            void loadSegments();
            // Every rendition is DEFAULT=NO, so showing one — `subtitleChoice`, explicit or
            // `autoSubtitleLanguage`'s own pick — is this call's doing, never the engine auto-selecting by
            // itself. But the native path's own `textTracks` are not always populated by `loadedmetadata`
            // yet — WebKit can still be parsing the subtitle group — so this alone is not enough on it:
            // `textTracks.onaddtrack` below is what actually catches a track that arrives late.
            applySubtitles();
            if (video) video.textTracks.onaddtrack = applySubtitles;
          }}
          oncanplay={() => {
            // Autoplay starts a moment after `canplay`: still paused by then, the browser refused to start it
            // itself and its play button is up.
            const element = video;
            setTimeout(() => {
              if (element === video && element?.paused && !played) awaitingPress = true;
            }, AUTOPLAY_GRACE_MS);
          }}
          onplay={playing}
          onpause={paused}
          onseeking={stay}
          ontimeupdate={tick}
          onended={finished}
          onerror={() => {
            // An `error` with no MediaError behind it — what iOS fired as a page came back from the background,
            // while its video went on loading — is no failure of the element.
            if (video?.error) {
              if (__DEN_TV_PLATFORM__ === 'tizen')
                void broke(video.error.code, video.error.message, avplay?.failureKind());
              else void broke();
            } else console.warn('The video fired an error with no MediaError; it plays on.');
          }}
        >
          <!-- WebKit does not reliably reload cues when only an existing track element's src changes. Re-key on
               the URL so an aligned replacement gets a new element; textTracks.onaddtrack applies its mode. -->
          {#each session?.externalSubtitles ?? [] as track (track.url)}
            <track
              kind="subtitles"
              src={track.url}
              srclang={track.language}
              label={track.value}
              default={track.value === subtitleChoice}
              onload={applySubtitles}
            />
          {/each}
        </video>
      {:else if castView}
        <!-- The picture is on the TV: what plays there, and where, with Den's transport as its remote below. -->
        <div class="cast-view">
          {#if title.posterPath}
            {#if webTransport}
              <!-- The poster again, blurred and dimmed, where the picture would be. -->
              <img
                class="cast-backdrop"
                src={`https://image.tmdb.org/t/p/w500${title.posterPath}`}
                alt=""
              />
            {/if}
            <img src={`https://image.tmdb.org/t/p/w500${title.posterPath}`} alt="" />
          {/if}
          <p role="status">
            {casting
              ? i18n.format('player.castingTo', 'Casting to {device}', {
                  device: castDevice ?? 'Chromecast',
                })
              : i18n.phrase('Connecting to the Chromecast…')}
          </p>
        </div>
      {/if}
      {#if !session?.castOrigin || castView}
        <!-- A browser's transport is drawn over the whole player instead (`webControls`). -->
        {#if fullTvTransport}
          <nav class="tv-transport full-tv-transport" aria-label="Playback controls">
            <div class="tv-timeline">
              <span aria-hidden="true">{clockTime(tvPosition)}</span>
              <input
                type="range"
                aria-label="Playback position"
                aria-valuetext={`${clockTime(tvPosition)} of ${clockTime(tvDuration)}`}
                min="0"
                max={Math.max(tvDuration, 1)}
                step={webTransport && !desktopTransport ? 'any' : '10'}
                value={Math.min(tvPosition, Math.max(tvDuration, 1))}
                disabled={!tvDuration}
                style={`--tv-progress: ${tvDuration ? Math.min(100, (tvPosition / tvDuration) * 100) : 0}%`}
                onpointerdown={(event) => (scrubbing = event.pointerType !== 'mouse')}
                onpointercancel={() => (scrubbing = false)}
                oninput={(event) => {
                  const to = Number(event.currentTarget.value);
                  tvPosition = to;
                  // A finger drag follows the finger to the second, and a receiver is asked once the thumb is let
                  // go: both are sought at `change`, not at every step.
                  if (!scrubbing && !castView) seekTo(to);
                }}
                onchange={(event) => {
                  if (!scrubbing && !castView) return;
                  scrubbing = false;
                  seekTo(Number(event.currentTarget.value));
                }}
              />
              <span aria-hidden="true">−{clockTime(Math.max(0, tvDuration - tvPosition))}</span>
            </div>
            <div class="tv-transport-actions" data-tv-horizontal-group="transport">
              <button
                class="tv-skip"
                type="button"
                aria-label="Rewind 10 seconds"
                onclick={() => seekBy(-SKIP_SECS)}
              >
                {@render skipIcon('back')}
              </button>
              <button
                class="tv-play-pause"
                type="button"
                aria-label={tvPaused ? 'Play' : 'Pause'}
                onclick={togglePlaying}
              >
                <ButtonIcon name={tvPaused ? 'play' : 'pause'} filled={tvPaused} />
              </button>
              <button
                class="tv-skip"
                type="button"
                aria-label="Forward 10 seconds"
                onclick={() => seekBy(SKIP_SECS)}
              >
                {@render skipIcon('forward')}
              </button>
            </div>
          </nav>
        {:else if tv}
          <nav class="tv-transport legacy-transport" aria-label="Playback controls">
            <button
              type="button"
              onclick={() =>
                video && (video.currentTime = Math.max(0, video.currentTime - SKIP_SECS))}
              >−10s</button
            >
            <button
              type="button"
              onclick={() => (video?.paused ? void video.play() : video?.pause())}
              >{tvPaused ? 'Play' : 'Pause'}</button
            >
            <button
              type="button"
              onclick={() =>
                video &&
                (video.currentTime = Math.min(length() || Infinity, video.currentTime + SKIP_SECS))}
              >+10s</button
            >
            {#if onnext && nextHref}<a href={nextHref} onclick={advanceLink}>Next</a>{/if}
            <button type="button" onclick={close}>Close</button>
          </nav>
        {/if}
        {#if fullTvTransport && active}
          <Button
            variant="primary"
            class="tv-skip-overlay"
            label={SKIP_LABEL[active.kind]}
            onclick={skipActive}
          />
        {/if}
        {#if customTransport && tvSubtitleTimingOpen}
          <section
            bind:this={subtitleTimingPanel}
            class="tv-subtitle-timing"
            aria-label={i18n.text('player.subtitleTiming')}
            role="group"
          >
            {#if webTransport}<button type="button" onclick={() => adjustSubtitleOffset(-0.5)}
                >{i18n.text('player.subtitleEarlier')}</button
              >{:else}<span>‹ {i18n.text('player.subtitleEarlier')}</span>{/if}
            <strong aria-live="polite" aria-label={formattedSubtitleOffset(undefined, 'spoken')}
              >{formattedSubtitleOffset()}</strong
            >
            {#if webTransport}<button type="button" onclick={() => adjustSubtitleOffset(0.5)}
                >{i18n.text('player.subtitleLater')}</button
              >{:else}<span>{i18n.text('player.subtitleLater')} ›</span>{/if}
            {#if webTransport}
              <div class="web-timing-actions">
                <button
                  type="button"
                  disabled={subtitleOffset === 0}
                  onclick={() => adjustSubtitleOffset(-subtitleOffset)}
                  >{i18n.text('player.subtitleReset')}</button
                >
                <button type="button" onclick={() => void closeSubtitleTiming()}
                  >{i18n.text('player.subtitleDone')}</button
                >
              </div>
            {:else}
              <small>{i18n.text('player.subtitleTimingInstructions')}</small>
            {/if}
          </section>
        {/if}
        {#if reconnecting}
          {@render banner('Reconnecting…', { busy: true, quiet: true, countdown: true })}
        {:else if startsIn}
          {@render banner(startsIn, { busy: true, quiet: true, countdown: true })}
        {:else if visibleStartupNotice}
          {@render banner(visibleStartupNotice.text, {
            busy: true,
            quiet: true,
            startup: true,
            clock: visibleStartupNotice.clock,
          })}
        {/if}
      {/if}
    {/if}
  </div>
  {#if fullTvTransport && tvDetailsOpen && session}
    <section class="tv-details" aria-label="Playback details">
      <h2>{heading}</h2>
      {#if tvInfoLine}<p class="tv-details-meta">{tvInfoLine}</p>{/if}
      <p class="tv-details-release">{releaseParts(session).release}</p>
      <a href={titleHref(title)}>{title.type === 'tv' ? 'Series details' : 'Movie details'}</a>
    </section>
  {/if}
  {#if webTransport}
    {#if session || sourceRecovery}{@render webControls()}{/if}
  {:else if session}
    {@const parts = releaseParts(session)}
    {@const short = pickLabel(session.release)}
    {@const playingTrack = session.audioTracks[session.audioTrack] ?? session.audioTracks[0]}
    {@const downmix = downmixLabel(session)}
    <footer class:counting-down={upNext !== null}>
      <!-- What plays, then where it came from: two parts of one sentence, so the source moves down whole rather
           than breaking mid-label when there is no room beside it. -->
      <p class="release" aria-live="polite">
        {#if parts.converted}
          <span class="playing">Converted here to {parts.converted}</span>
          <span class="source">from {parts.release}</span>
        {:else}
          <span class="playing">{parts.release}</span>
        {/if}
      </p>
      <div class="controls" data-tv-horizontal-group={fullTvTransport ? 'actions' : undefined}>
        <!-- The pill names the stream playing in short; its menu lists each with what tells them apart —
             quality and size over the release's file name — and ticks the one playing. -->
        <div class="pick-menu stream-pick">
          <ActionMenu
            label={i18n.format('player.stream', 'Stream: {stream}', { stream: short })}
            heading="Streams"
            note={releaseNote()}
            triggerClass="pick"
            onclose={scheduleWebControls}
            items={releaseItems}
          >
            {#snippet glyph()}
              {@render plates()}
              {#if !customTransport}
                <span class="value" aria-hidden="true">{short}</span>
                {@render chevron()}
              {/if}
            {/snippet}
          </ActionMenu>
        </div>
        {#if (customTransport ? session.audioTracks.length > 0 : session.audioTracks.length > 1) && playingTrack}
          {#if customTransport}
            <div class="pick-menu audio-pick">
              <ActionMenu
                label={i18n.format('player.audioTrack', 'Audio track: {track}', {
                  track: trackLabel(playingTrack, session.audioTrack),
                })}
                heading="Audio Track"
                triggerClass="pick"
                onclose={scheduleWebControls}
                items={() => audioTrackItems()}
              >
                {#snippet glyph()}{@render globe()}{/snippet}
              </ActionMenu>
            </div>
          {:else}
            <div class="pick audio-pick">
              {@render globe()}
              <!-- A track this browser gets with fewer channels says what it gets beside its name, quietly: a known
                   limit of the conversion, not a fault. -->
              <span class="value" aria-hidden="true"
                >{trackLabel(playingTrack, session.audioTrack)}{#if downmix}<span class="downmix"
                    >{downmix}</span
                  >{/if}</span
              >
              {@render chevron()}
              <select aria-label="Audio track" value={session.audioTrack} onchange={switchAudio}>
                {#each session.audioTracks as track, n (n)}
                  <option value={n}
                    >{trackLabel(track, n)}{downmix && n === session.audioTrack
                      ? ` · ${downmix}`
                      : ''}</option
                  >
                {/each}
              </select>
            </div>
          {/if}
        {/if}
        <!-- Den owns this picker so it can distinguish built-in tracks from OpenSubtitles candidates and show
             match metadata the native video control cannot carry. The same choice is forwarded to Cast. -->
        {#if session.subtitles?.length}
          {@const chosenSubtitle = preferredSubtitleTrack(session.subtitles ?? [], subtitleChoice)}
          {@const chosenSubtitleLabel = chosenSubtitle ? subtitleLabel(chosenSubtitle) : 'Off'}
          <div class="pick-menu subtitle-pick">
            <ActionMenu
              label={i18n.format('player.subtitles', 'Subtitles: {subtitles}', {
                subtitles: chosenSubtitleLabel,
              })}
              heading="Subtitles"
              note={session.external && directWithoutDenSubtitles
                ? 'Den subtitles were not requested for this direct stream. This release’s embedded TorBox subtitles remain available.'
                : undefined}
              triggerClass="pick"
              onclose={scheduleWebControls}
              items={() => [
                ...subtitleTrackItems(),
                ...(customTransport && subtitleChoice !== null ? subtitleTimingItems() : []),
              ]}
            >
              {#snippet glyph()}
                {#if customTransport}
                  {@render subtitlesIcon()}
                {:else}
                  {@render globe()}
                  <span class="value" aria-hidden="true">{chosenSubtitleLabel}</span>
                  {@render chevron()}
                {/if}
              {/snippet}
            </ActionMenu>
          </div>
        {/if}
        {#if customTransport}
          <button
            class="player-tv-action beginning-action"
            type="button"
            aria-label="Play from beginning"
            onclick={playFromBeginning}>{@render beginningIcon()}</button
          >
          {#if onnext && nextHref}<a
              class="player-tv-action next-action"
              href={nextHref}
              aria-label={next ? `Next: ${next}` : 'Next episode'}
              onclick={advanceLink}>{@render nextIcon()}</a
            >{/if}
        {/if}
        <!-- Shown whatever the auto-skip setting says, and whatever SkipDB's confidence is: offering a skip
             costs a press to refuse, while acting on uncertain times costs the end of the episode. In
             fullscreen the browser's own controls cover this footer, so the button is a windowed affordance —
             auto-skip, being a seek, still works there. -->
        {#if !customTransport && active}
          <Button variant="primary" label={SKIP_LABEL[active.kind]} onclick={skipActive} />
        {/if}
        {#if onnext && next}
          {#if upNext !== null}
            <!-- The seconds are kept out of the name: one that changes every second is announced every second. -->
            <Button
              variant="primary"
              aria-label="Next: {next}"
              href={nextHref}
              onclick={advanceLink}>Next: {next} <span aria-hidden="true">({upNext})</span></Button
            >
            <Button label="Stay" onclick={stay} />
          {:else if !customTransport}
            <Button
              label={i18n.format('player.next', 'Next: {title}', { title: next })}
              href={nextHref}
              onclick={advanceLink}
            />
          {/if}
        {/if}
      </div>
    </footer>
  {/if}
  {#if frameOrigin && (lookOrigin || heldFrame || (session?.castOrigin && !failure))}
    <!-- The cast page, one frame throughout so the Cast session started in it is kept. It is the Cast button, lying
         exactly over Den's button surface (`castSlot`): only a press inside it can open Chrome's device list, since
         user activation does not pass into a cross-origin frame. Away from home it is also the picture, playing the
         session itself. Its place here is fixed and it is moved by measurement (`castFrameBox`): moved in the
         document, it would reload and drop the Cast session. `local-network-access`: at home the cast page plays from
         den-remux's home-network address (`lanBase`), and Chrome lets a cross-origin frame reach a private address
         only when the page delegates it. As the button it is out of the Tab order: Tab reaches it through its slot. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <iframe
      bind:this={castFrame}
      class="cast-frame"
      class:cast-frame-stage={castStage}
      class:cast-frame-unplaced={!castFrameBox}
      class:cast-focused={castFocus === 'keyboard'}
      style:left={castFrameBox ? `${castFrameBox.left}px` : undefined}
      style:top={castFrameBox ? `${castFrameBox.top}px` : undefined}
      style:width={castFrameBox ? `${castFrameBox.width}px` : undefined}
      style:height={castFrameBox ? `${castFrameBox.height}px` : undefined}
      title={castStage ? 'Den Cast player' : 'Cast'}
      tabindex={castStage ? undefined : -1}
      inert={!castFrameBox}
      src={frameOrigin + castFrameQuery}
      allow="autoplay; encrypted-media; fullscreen; presentation; local-network-access"
      sandbox="allow-scripts allow-same-origin allow-presentation"
      onload={castFrameLoaded}
    ></iframe>
    <!-- Pressing the Cast button while a receiver is connected opens this, beside it: the frame is a button, with no
         room for a menu of its own. -->
    <ActionMenu
      bind:this={castMenu}
      label="Cast options"
      heading={castDevice
        ? i18n.format('player.castingTo', 'Casting to {device}', { device: castDevice })
        : 'Chromecast'}
      note={castReport ? undefined : 'Which Chromecast is it? Den sends what that model can play.'}
      triggerClass="cast-menu-trigger"
      onclose={focusCastButton}
      items={() => [
        { kind: 'item', label: 'Stop casting', onselect: stopCasting },
        ...(castReport ? [] : CAST_PROFILES).map((profile) => ({
          kind: 'radio' as const,
          group: 'cast-profile',
          label: CAST_PROFILE_NAMES[profile]!,
          checked: profile === castProfile,
          onselect: () => chooseCastProfile(profile),
        })),
      ]}
    >
      {#snippet glyph()}<ButtonIcon name="cast" />{/snippet}
    </ActionMenu>
  {/if}
</div>

{#snippet castButtonSlot(classes: string)}
  <!-- Den's own button surface for Cast: its look, hover and focus ring, under the cast page's frame, which draws the
       glyph and takes the press. Tab lands here and is handed into the frame's button. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <span
    bind:this={castSlot}
    class="{classes} cast-slot"
    class:cast-hover={castHover}
    class:cast-focused={castFocus === 'keyboard'}
    tabindex="0"
    onfocus={focusCastButton}
  ></span>
{/snippet}

<!-- A browser's controls, as Apple's own player has them: −10 · play · +10 over the middle of the picture on a touch
     screen, the timeline, then one dock row — Audio & subtitles and Next at its left; Mute, PiP, Fullscreen and ⋯ at its
     right. With a mouse the transport moves into the dock's left end beside the volume and the time. Skip and the
     up-next card float above the timeline and stay while the rest hides. On an upright phone the transport is a row
     under the timeline instead, off the picture. Every transport is drawn and CSS shows the one for the window's size
     (`.web-centre`, `.web-remote`, `.web-dock-transport`); which pointer it is decides behaviour alone. -->
{#snippet webControls()}
  {@const transport = !!session && (!session.castOrigin || castView)}
  <nav class="web-transport" aria-label="Playback controls">
    {#if session && (active || (onnext && next && upNext !== null))}
      <div class="web-floating">
        {#if active}
          <Button
            variant="primary"
            class="web-skip"
            label={SKIP_LABEL[active.kind]}
            onclick={skipActive}
          />
        {/if}
        {#if onnext && next && upNext !== null}
          <div
            class="web-up-next"
            style:--up-next-progress={`${((UP_NEXT_SECS - upNext) / UP_NEXT_SECS) * 100}%`}
          >
            <!-- Said once: the seconds stay out of what is announced and out of the button's name. -->
            <p class="web-sr" role="status">
              {i18n.format('player.nextIn', 'Next episode in {seconds} seconds', {
                seconds: UP_NEXT_SECS,
              })}
            </p>
            <div class="web-up-next-top" aria-hidden="true">
              {#if nextDetail?.stillPath}
                <span class="web-up-next-thumb">
                  <img src={`https://image.tmdb.org/t/p/w300${nextDetail.stillPath}`} alt="" />
                  {#if nextDetail.runtime}<span class="web-up-next-runtime"
                      >{nextDetail.runtime} min</span
                    >{/if}
                </span>
              {/if}
              <p class="web-up-next-text">
                <small>{i18n.format('player.upNext', 'Up next · {title}', { title: next })}</small>
                {#if nextDetail?.name}<b>{nextDetail.name}</b>{/if}
                <span
                  >{i18n.format('player.playsIn', 'Plays in {seconds} s', {
                    seconds: upNext,
                  })}{#if nextDetail?.runtime && !nextDetail.stillPath}
                    · {nextDetail.runtime} min{/if}</span
                >
              </p>
            </div>
            <div class="web-up-next-actions">
              <Button
                variant="primary"
                class="web-play-now"
                ariaLabel={i18n.format('player.playNow', 'Play now: {title}', { title: next })}
                href={nextHref}
                onclick={advanceLink}><span>Play now</span></Button
              >
              <Button label="Stay" onclick={stay} />
            </div>
          </div>
        {/if}
      </div>
    {/if}
    {#if transport && !castView}
      <div class="web-centre">{@render webTransportButtons()}</div>
      <!-- A mouse plays and pauses on the picture itself: while paused, and for a moment as a click resumes, the
           middle says which. -->
      {#if tvPaused && (played || awaitingPress)}
        <span class="web-centre-glyph" aria-hidden="true"><ButtonIcon name="play" filled /></span>
      {:else if pictureFlash}
        <span class="web-centre-glyph web-flash" aria-hidden="true"
          ><ButtonIcon name="pause" filled /></span
        >
      {/if}
    {/if}
    {#if seekStreak}
      <span class="web-ripple" class:web-ripple-forward={seekStreak.side > 0} aria-hidden="true"
        >{seekStreak.side < 0 ? '−' : '+'}{seekStreak.count * SKIP_SECS} s</span
      >
    {/if}
    <div class="web-bar" bind:this={webBar}>
      {#if transport}
        <div class="web-timeline">
          <input
            class="web-track"
            type="range"
            aria-label="Playback position"
            aria-valuetext={`${clockTime(tvPosition)} of ${clockTime(tvDuration)}`}
            min="0"
            max={Math.max(tvDuration, 1)}
            step={desktopTransport ? '10' : 'any'}
            value={Math.min(tvPosition, Math.max(tvDuration, 1))}
            disabled={!tvDuration}
            style:--tv-progress={`${tvDuration ? Math.min(100, (tvPosition / tvDuration) * 100) : 0}%`}
            style:--tv-hover={timelineHover ? `${timelineHover.x * 100}%` : undefined}
            style:--tv-buffered={`${tvDuration ? Math.min(100, (tvBuffered / tvDuration) * 100) : 0}%`}
            onpointerdown={(event) => {
              timelineHeld = true;
              scrubbing = event.pointerType !== 'mouse';
            }}
            onpointerup={() => {
              timelineHeld = false;
              scheduleWebControls();
            }}
            onpointercancel={() => {
              timelineHeld = false;
              scrubbing = false;
            }}
            onpointermove={(event) => {
              if (event.pointerType !== 'mouse') return;
              const box = event.currentTarget.getBoundingClientRect();
              const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
              timelineHover = { x, at: x * tvDuration };
            }}
            onpointerleave={() => (timelineHover = null)}
            onkeydown={timelineKey}
            oninput={(event) => {
              const to = Number(event.currentTarget.value);
              tvPosition = to;
              // A finger drag follows the finger to the second, and a receiver is asked once the thumb is let go:
              // both are sought at `change`, not at every step.
              if (!scrubbing && !castView) seekTo(to);
            }}
            onchange={(event) => {
              timelineHeld = false;
              if (!scrubbing && !castView) return;
              scrubbing = false;
              seekTo(Number(event.currentTarget.value));
            }}
          />
          <span class="web-elapsed" aria-hidden="true">{clockTime(tvPosition)}</span>
          <span class="web-remaining" aria-hidden="true"
            >−{clockTime(Math.max(0, tvDuration - tvPosition))}</span
          >
          {#if timelineHover}
            <span class="web-bubble" style:left={`${timelineHover.x * 100}%`} aria-hidden="true"
              >{clockTime(timelineHover.at)}</span
            >
          {/if}
        </div>
        <!-- Under the timeline, not on a picture: casting, where this page is the receiver's remote, and on an upright
             phone, where the black band below the picture has the room. -->
        <div class="web-remote">{@render webTransportButtons()}</div>
      {/if}
      <div class="web-dock">
        <div class="web-dock-group">
          {#if transport}
            <div class="web-dock-transport">
              {@render webTransportButtons(true)}
              {@render muteButton()}
              <input
                class="web-volume"
                type="range"
                aria-label="Volume"
                min="0"
                max="1"
                step="0.05"
                value={playerMuted ? 0 : playerVolume}
                oninput={setVolume}
                onwheel={(event) => {
                  event.preventDefault();
                  nudgeVolume(event.deltaY < 0 ? 0.05 : -0.05);
                }}
              />
              <span class="web-time">{clockTime(tvPosition)} / {clockTime(tvDuration)}</span>
            </div>
          {/if}
          {#if session && (session.audioTracks.length || session.subtitles?.length)}
            {@const now = audioSubtitleSummary()}
            <span class="web-tip" data-tip={i18n.phrase('Audio & subtitles')}>
              <ActionMenu
                label={i18n.format(
                  'player.audioAndSubtitles',
                  'Audio and subtitles: {audio}, subtitles {subtitles}',
                  { audio: now.audio, subtitles: now.subtitles },
                )}
                heading="Audio & subtitles"
                note={session.external && directWithoutDenSubtitles
                  ? 'Den subtitles were not requested for this direct stream. This release’s embedded TorBox subtitles remain available.'
                  : undefined}
                rows={optionRows}
                triggerClass="web-glyph web-labelled web-audio-subtitles"
                sheetQuery={PHONE_SHEET}
                onclose={scheduleWebControls}
                items={audioSubtitleItems}
              >
                {#snippet glyph()}{@render subtitlesIcon()}<span class="web-label"
                    >Audio & subtitles</span
                  >{/snippet}
              </ActionMenu>
            </span>
          {/if}
          {#if session && onnext && nextHref}
            <a
              class="web-glyph web-labelled"
              href={nextHref}
              aria-label={i18n.format('player.nextEpisode', 'Next episode: {title}', {
                title: next ?? '',
              })}
              data-tip={i18n.phrase('Next episode')}
              data-key="Shift N"
              onclick={advanceLink}
              >{@render nextIcon()}<span class="web-label">Next episode</span></a
            >
          {/if}
        </div>
        <div class="web-dock-group">
          {#if transport && !castView}
            <span class="web-touch-mute">{@render muteButton()}</span>
            {#if canPictureInPicture()}
              <button
                class="web-glyph"
                type="button"
                aria-label="Picture in picture"
                data-tip={i18n.phrase('Picture in picture')}
                onclick={() => void togglePictureInPicture()}>{@render pipIcon()}</button
              >
            {/if}
            <button
              class="web-glyph"
              type="button"
              aria-label={playerFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              data-tip={i18n.phrase('Fullscreen')}
              data-key="F"
              onclick={() => void toggleFullscreen()}
            >
              <ButtonIcon name="fullscreen" />
            </button>
          {/if}
          <span class="web-tip" data-tip={i18n.phrase('More')}>
            <ActionMenu
              label="More playback options"
              heading={openOptionsPage()?.heading ?? optionsPage ?? 'Playback options'}
              note={openOptionsPage()?.note}
              rows={moreRows}
              triggerClass="web-glyph web-more"
              sheetQuery={PHONE_SHEET}
              onclose={() => {
                optionsPage = null;
                scheduleWebControls();
              }}
              items={() => openOptionsPage()?.items() ?? optionItems()}
            >
              {#snippet glyph()}<ButtonIcon name="more" /><span
                  class="web-source"
                  data-testid="playback-source">{playbackSource}</span
                >{/snippet}
            </ActionMenu>
          </span>
        </div>
      </div>
    </div>
  </nav>
{/snippet}

<!-- −10 · Play · +10 over the picture; in a mouse window's dock, Play first, as a desktop player has it. -->
{#snippet webTransportButtons(playFirst = false)}
  {#snippet play()}
    <button
      class="web-glyph web-play"
      type="button"
      aria-label={tvPaused ? 'Play' : 'Pause'}
      aria-busy={stalling || (!!session && !played && !awaitingPress) || undefined}
      data-tip={tvPaused ? i18n.phrase('Play') : i18n.phrase('Pause')}
      data-key="K"
      onclick={togglePlaying}
    >
      <ButtonIcon name={tvPaused ? 'play' : 'pause'} filled />
    </button>
  {/snippet}
  {#if playFirst}{@render play()}{/if}
  <button
    class="web-glyph web-skip-back"
    type="button"
    aria-label="Rewind 10 seconds"
    data-tip={i18n.phrase('Back 10 seconds')}
    data-key="J"
    onclick={() => seekBy(-SKIP_SECS)}
  >
    {@render skipIcon('back')}
  </button>
  {#if !playFirst}{@render play()}{/if}
  <button
    class="web-glyph web-skip-forward"
    type="button"
    aria-label="Forward 10 seconds"
    data-tip={i18n.phrase('Forward 10 seconds')}
    data-key="L"
    onclick={() => seekBy(SKIP_SECS)}
  >
    {@render skipIcon('forward')}
  </button>
{/snippet}

{#snippet muteButton()}
  <button
    class="web-glyph"
    type="button"
    aria-label={playerMuted ? 'Unmute' : 'Mute'}
    data-tip={playerMuted ? i18n.phrase('Unmute') : i18n.phrase('Mute')}
    data-key="M"
    onclick={toggleMuted}
  >
    <ButtonIcon name={playerMuted || playerVolume === 0 ? 'mute' : 'volume'} />
  </button>
{/snippet}

<!-- The options' rows, drawn into ActionMenu's own list and keyboard model: a page's way back, rows grouped under their
     section (audio, then subtitles), each with its current value, and a page's row opening it in place. -->
{#snippet optionRows(items: MenuItem[], run: (item: MenuItem, event: MouseEvent) => void)}
  <div class="options-rows" role="none">
    {#each optionSections(items) as group, g (group.section ?? `#${g}`)}
      {#if group.section}
        <div class="options-section" role="group" aria-label={group.section}>
          <p class="options-section-heading" aria-hidden="true">{group.section}</p>
          {#each group.rows as { item, i } (item.key ?? `${item.kind}:${item.label}:${i}`)}
            {@render optionRow(item, i, run)}
          {/each}
        </div>
      {:else}
        {#each group.rows as { item, i } (item.key ?? `${item.kind}:${item.label}:${i}`)}
          {@render optionRow(item, i, run)}
        {/each}
      {/if}
    {/each}
  </div>
{/snippet}

<!-- The ⋯ options: on their first page what is playing heads them, below a sheet's grab area so its text can be
     selected; on a row's page, its name and the way back. -->
{#snippet moreRows(items: MenuItem[], run: (item: MenuItem, event: MouseEvent) => void)}
  {#if optionsPage === null}
    {@render optionsHeader()}
  {:else}
    <!-- A sheet's head names the page already. -->
    {#if !matchMedia(PHONE_SHEET).matches}
      <p class="options-page-heading">{openOptionsPage()?.heading ?? optionsPage}</p>
    {/if}
    <Button
      variant="menu"
      role="menuitem"
      class="item back"
      label="Back"
      onclick={() => void showOptionsPage(null)}
    />
  {/if}
  {@render optionRows(items, run)}
{/snippet}

{#snippet optionRow(item: OptionItem, i: number, run: (item: MenuItem, event: MouseEvent) => void)}
  <Button
    variant="menu"
    size="regular"
    label={item.label}
    ariaLabel={item.value ? `${i18n.phrase(item.label)}, ${item.value}` : undefined}
    role={item.kind === 'radio' ? 'menuitemradio' : 'menuitem'}
    aria-checked={item.kind === 'radio' ? item.checked : undefined}
    aria-haspopup={item.page ? 'menu' : undefined}
    aria-disabled={item.disabled || undefined}
    aria-describedby={item.description ? `option-${i}` : undefined}
    class={item.description ? 'item described' : item.value || item.page ? 'item valued' : 'item'}
    onclick={(event) => (item.page ? void showOptionsPage(item.label) : run(item, event))}
  >
    {#if item.description}<span class="item-description" id={`option-${i}`}
        >{i18n.phrase(item.description)}</span
      >{/if}
    {#if item.value}<span class="item-value" aria-hidden="true">{item.value}</span>{/if}
    {#if item.page}<span class="item-chevron" aria-hidden="true">›</span>{/if}
  </Button>
{/snippet}

<!-- What the options open with: what is playing, the release in full (selectable, to look up or report), and the path. -->
{#snippet optionsHeader()}
  <div class="options-head">
    <b>{title.title}{season !== undefined ? ` · S${season} · E${episode}` : ''}</b>
    {#if session}
      {@const parts = releaseParts(session)}
      <p class="options-release">
        {#if parts.converted}
          <span>Converted here to {parts.converted}</span>
          <span>from {parts.release}</span>
        {:else}
          <span>{parts.release}</span>
        {/if}
      </p>
    {/if}
    <span class="options-chip">{playbackSource}</span>
  </div>
{/snippet}

{#snippet pipIcon()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <rect class="filled" x="12" y="11.3" width="7" height="5.7" rx="1.2" />
  </svg>
{/snippet}

{#snippet skipIcon(direction: 'back' | 'forward')}
  <svg class="skip-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path
      d={direction === 'back'
        ? 'M17 13H9v-8M10 13a17 17 0 1 1-2 17'
        : 'M31 13h8v-8M38 13a17 17 0 1 0 2 17'}
    />
    <text x="24" y="29">10</text>
  </svg>
{/snippet}

{#snippet beginningIcon()}
  <svg class="transport-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path d="M17 14H9V6M10 14a17 17 0 1 1-2 17" />
  </svg>
{/snippet}

{#snippet nextIcon()}
  <svg class="transport-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path class="filled" d="m12 12 20 13-20 13Z" />
    <path d="M36 12v26" />
  </svg>
{/snippet}

<!-- The Apple TV's own menus mark these with rectangle.stack and globe; the same two, drawn as lines. -->
{#snippet plates()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="7" y="4" width="13" height="9" rx="2" />
    <rect x="4" y="8" width="13" height="9" rx="2" />
    <path d="M4 12H3a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1" />
  </svg>
{/snippet}

{#snippet globe()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path
      d="M12 3.5c2.4 2.4 3.7 5.3 3.7 8.5s-1.3 6.1-3.7 8.5c-2.4-2.4-3.7-5.3-3.7-8.5s1.3-6.1 3.7-8.5Z"
    />
  </svg>
{/snippet}

{#snippet subtitlesIcon()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M6 5h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-5l-4 3v-3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z" />
    <path d="M6.5 10h4M13.5 10h4M6.5 14h6M15.5 14h2" />
  </svg>
{/snippet}

{#snippet banner(
  text: string,
  options: {
    dismiss?: () => void;
    action?: { label: string; run: () => void };
    quiet?: boolean;
    busy?: boolean;
    startup?: boolean;
    countdown?: boolean;
    clock?: string;
  } = {},
)}
  <p
    class="notice"
    class:quiet={options.quiet}
    class:busy={options.busy}
    class:startup={options.startup}
    class:countdown={options.countdown}
    role="status"
  >
    {#if options.busy}<span class="status-spinner" aria-hidden="true"></span>{/if}
    <span class="notice-copy"
      >{text}{#if options.clock}<span class="clock" aria-hidden="true">&nbsp;· {options.clock}</span
        >{/if}</span
    >
    {#if options.action}<Button
        variant="tertiary"
        size="compact"
        class="notice-action"
        label={options.action.label}
        onclick={options.action.run}
      />{/if}
    {#if options.dismiss}
      <Button
        variant="tertiary"
        size="icon"
        class="notice-dismiss"
        icon="close"
        ariaLabel="Dismiss"
        onclick={options.dismiss}
      />
    {/if}
  </p>
{/snippet}

{#snippet chevron()}
  <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="m6 9.5 6 6 6-6" />
  </svg>
{/snippet}

<style>
  /* The visible viewport (dvh: a phone's toolbars excluded), and a middle row that may shrink below the video's own
     height — so the video fits and its controls stay on screen. Every side keeps clear of a phone's camera cutout,
     which sits on the left or right edge in landscape. */
  .player {
    position: fixed;
    inset: 0 0 auto;
    z-index: 50;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    height: 100vh;
    height: 100dvh;
    padding: max(12px, env(safe-area-inset-top)) max(var(--gutter), env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom)) max(var(--gutter), env(safe-area-inset-left));
    background: #000;
    color: #fff;

    /* A tap near the video's own controls acts on them: no text selected under the finger, no grey flash, and no
       double-tap zoom, which a phone otherwise waits for before passing the tap on. */
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  header {
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 12px;
  }

  header b {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Beside the title, quiet: it says what is playing, it is not something to press. */
  .source-stamp {
    flex: none;
    margin-right: auto;
    margin-left: -8px;
    padding: 2px 8px;
    border: 1px solid rgb(255 255 255 / 0.25);
    border-radius: 999px;
    color: rgb(255 255 255 / 0.75);
    font-size: 12px;
    line-height: 1.4;
    white-space: nowrap;
  }

  /* The stamp as a menu button sits where the plain stamp does. */
  :global(.player-source-switch) {
    flex: none;
    margin-right: auto;
    margin-left: -8px;
  }

  /* It is ActionMenu's trigger, which starts bare: given back the player button's own box. */
  header :global(.trigger.player-source-switch) {
    display: inline-flex;
    padding: 0 12px;
    border: 1px solid var(--button-border);
    background: var(--button-bg);
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
  }

  @media (hover: hover) and (pointer: fine) {
    header :global(.trigger.player-source-switch:hover) {
      border-color: var(--button-hover-border, var(--button-border));
      background-color: var(--button-hover-bg, var(--button-bg));
    }
  }

  /* The title takes the width; closing is one glyph, as it is on the pickers. No ring around it: it sits beside
     the title rather than among the controls, and a bordered circle reads heavier than what it does. */
  :global(.player-header-action) {
    --button-icon-size: 22px;

    border-color: transparent;
    box-shadow: none;
  }

  /* Beside Close, at the right: the two are one group, so the title keeps the width. */
  :global(.player-header-action.cast) {
    margin-left: auto;
  }

  /* Where the browser draws the open menu itself, on its own ground. */
  select option {
    color: initial;
  }

  .stage {
    position: relative;
    display: grid;
    min-height: 0;
    place-items: center;
  }

  /* Cast discovery floats with the player control instead of becoming a new grid row. Its two-line footprint is
     stable while the wording changes; only the card itself accepts a tap, so playback controls remain usable. */
  .cast-status {
    position: absolute;
    top: 12px;
    left: 50%;

    /* Above the custom player's header gradient: its Dismiss action must remain pressable while controls show. */
    z-index: 7;
    width: min(36rem, calc(100% - 24px));
    pointer-events: none;
    transform: translateX(-50%);
  }

  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    border: 0;
  }

  /* The cast page's frame, placed over whichever it is now (`castFrameBox`): the Cast button, above the bars it sits
     in, with nothing of its own but the glyph (`color-scheme` matches the page's, or Chromium paints the frame an
     opaque ground). */
  .cast-frame {
    position: absolute;
    z-index: 6;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color-scheme: dark;
    transition:
      opacity 180ms ease,
      transform 120ms ease;
  }

  /* Away from home it is the picture, under the player's own bars. */
  .cast-frame-stage {
    z-index: auto;
    border-radius: 0;
    background: #000;
  }

  /* Before it has a place, rendered but unseen, so the Cast SDK in it runs as usual. */
  .cast-frame-unplaced {
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .web-controls-hidden > .cast-frame:not(.cast-frame-stage) {
    opacity: 0;
    pointer-events: none;
  }

  .web-custom-player > .cast-frame.cast-focused {
    transform: scale(1.06);
  }

  /* A 44px target wherever it is drawn, whatever classes it borrows its look from. */
  .cast-slot {
    display: inline-block;
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 50%;
  }

  /* The frame's button has the keyboard: Den's ring, on Den's surface under it. */
  .cast-slot.cast-focused {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: var(--ring-offset);
  }

  :global(.den-button.cast-slot.cast-hover) {
    border-color: var(--button-hover-border, var(--button-border));
    background-color: var(--button-hover-bg, var(--button-bg));
  }

  /* Den's Cast menu opens from the frame's button, never from a trigger of its own. */
  :global(button.trigger.cast-menu-trigger) {
    display: none;
  }

  /* Casting: the poster and where it plays, clear of the transport below. */
  .cast-view {
    position: absolute;
    inset: 0;
    display: grid;
    gap: 16px;
    place-content: center;
    justify-items: center;
    padding: 24px;
    color: rgb(255 255 255 / 0.86);
    text-align: center;
  }

  .cast-view img {
    width: auto;
    max-width: 40vw;
    height: min(320px, 38vh);
    aspect-ratio: 2 / 3;
    border-radius: 12px;
    object-fit: cover;
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
  }

  .cast-view p {
    margin: 0;
    font-weight: 600;
  }

  /* Chromium can ring both the video host and the focused native control inside its shadow tree. The native
     play/timeline control remains visibly focused; remove only the redundant rectangle around the whole picture. */
  video:focus {
    outline: none;
  }

  form {
    display: grid;
    gap: 12px;
    width: min(420px, 100%);
  }

  input {
    padding: 12px 16px;
    border: 1px solid rgb(255 255 255 / 0.3);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.08);
    color: #fff;
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 16px;
    align-items: center;
    justify-content: space-between;
    padding-top: 12px;
  }

  .controls {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    justify-content: flex-end;
  }

  /* Over the held picture, clear of the video's own controls along the bottom. The same surface and activity glyph
     serve startup, prebuffer, reconnecting, Cast discovery and a mid-play stall; only the copy changes. */
  .countdown {
    width: auto;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  /* The startup status stays centred over an empty/held stage and never intercepts the player. */
  .notice.startup {
    width: min(calc(100% - 24px), 42rem);
    pointer-events: none;
  }

  /* `aria-hidden`: a screen reader is told the line, not a number ticking under it every quarter second. */
  .startup .clock {
    color: rgb(255 255 255 / 0.5);
    font-variant-numeric: tabular-nums;
  }

  /* The line takes a phone's width to itself and shares a laptop's with the pickers. Its two parts are flex items,
     so the source drops whole to the next line before either of them breaks in the middle. */
  .release {
    display: flex;
    flex: 1 1 16rem;
    flex-wrap: wrap;
    gap: 2px 0.5ch;
    align-items: baseline;
    min-width: 0;
    max-width: 70ch;
    margin: 0;

    /* The release's name is there to be copied — to look it up, or to report it — so it selects as text, unlike
       the rest of the player. It sits in the footer, apart from the video, so selecting it plays or pauses nothing. */
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
  }

  /* What playback says as it goes: banners in a row of their own between the title and the video, so they cover
     neither the picture nor the video's own controls, nor read as part of what is playing below it. */
  .notices {
    display: grid;
    gap: 8px;
    justify-items: center;
  }

  /* One quiet media toast for every non-terminal player message. A shadow separates it from the picture without
     adding the bordered alert-box look that made buffering and Cast messages feel unrelated to the player. */
  .notice {
    display: flex;
    gap: 4px 12px;
    align-items: center;
    box-sizing: border-box;
    width: fit-content;
    max-width: min(100%, 36rem);
    margin: 0;
    padding: 8px 8px 8px 14px;
    border: 0;
    border-radius: 14px;
    background: rgb(18 18 20 / 0.88);
    color: rgb(255 255 255 / 0.9);
    font-size: 14px;
    line-height: 1.35;
    box-shadow: 0 10px 32px rgb(0 0 0 / 0.34);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
  }

  .notice.quiet {
    color: rgb(255 255 255 / 0.78);
  }

  .notice:last-of-type {
    margin-bottom: 10px;
  }

  .cast-status .notice {
    box-sizing: border-box;
    width: 100%;
    min-height: 76px;
    pointer-events: auto;
  }

  .cast-status .notice:last-of-type {
    margin-bottom: 0;
  }

  /* A notice with nothing to dismiss still sits the same height as one with. A release name has no spaces to break
     at, so it may break anywhere rather than run past the notice and off a phone's screen. */
  .notice-copy {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 0;
    overflow-wrap: anywhere;
  }

  .status-spinner {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border: 2px solid rgb(255 255 255 / 0.22);
    border-top-color: rgb(255 255 255 / 0.88);
    border-radius: 50%;
    animation: status-spin 800ms linear infinite;
  }

  @keyframes status-spin {
    to {
      transform: rotate(1turn);
    }
  }

  /* The offer a notice makes: the accent's text, as LibraryStatus's Undo. */
  :global(.notice-action) {
    min-height: 36px;
    padding: 4px 8px;
    color: var(--accent);
  }

  /* A glyph, not a pill: closing a note is the least it asks. */
  :global(.notice-dismiss) {
    --button-icon-size: 18px;

    width: 36px;
    min-height: 36px;
    border-color: transparent;
  }

  .playing {
    color: rgb(255 255 255 / 0.85);
    font-size: 15px;
  }

  /* Where it came from, not what is playing. */
  .source {
    min-width: 0;
    color: rgb(255 255 255 / 0.5);
    font-size: 13px;
  }

  .pick,
  .pick-menu :global(.trigger.pick) {
    position: relative;
    display: flex;
    flex: 1 1 9rem;
    gap: 8px;
    align-items: center;
    min-width: 0;
    max-width: 18rem;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid rgb(255 255 255 / 0.4);
    border-radius: 999px;
    background: none;
    color: #fff;
    font: inherit;
  }

  /* The stream picker is ActionMenu's trigger, the pill itself, in a box that sizes as a `.pick` does. */
  .pick-menu {
    display: flex;
    flex: 1 1 9rem;
    min-width: 0;
    max-width: 18rem;
  }

  .pick-menu :global(.trigger.pick) {
    width: 100%;
    max-width: none;
    text-align: left;
  }

  /* One picker on a phone gets the row to itself, filling it: at 18rem it sat just short of the width, pushed
     against the right edge. Wider, the row is shared with the release line and 18rem is the right size again. */
  @media (width <= 40rem) {
    .controls > .pick:only-child,
    .controls > .pick-menu:only-child {
      max-width: none;
    }
  }

  .pick .value,
  .pick-menu .value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* What the track plays as, beside what it is: as quiet as the release's source. */
  .downmix {
    margin-left: 0.75ch;
    color: rgb(255 255 255 / 0.5);
    font-size: 13px;
  }

  .icon {
    width: 20px;
    height: 20px;
    opacity: 0.75;
  }

  .chevron {
    width: 14px;
    height: 14px;
    opacity: 0.5;
  }

  .icon,
  .chevron {
    flex: 0 0 auto;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The control itself fills the pill — never hidden, which would stop a phone opening it. */
  .pick select {
    position: absolute;
    inset: 0;
    width: 100%;
    padding: 0;
    border: 0;
    opacity: 0;
    appearance: none;
    cursor: pointer;
  }

  /* The focused element is the select inside, so the pill lights up with it. */
  .pick:focus-within,
  .pick-menu :global(.trigger.pick:focus-visible) {
    border-color: var(--accent);
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }

  /* A browser's player, laid out as Apple's own: close and what plays at the top; −10 · play · +10 over the middle of the
     picture on a touch screen; the timeline, then one dock row at the bottom. In an upright phone's black bands the bars
     cover nothing; on a picture, scrims keep their glyphs readable. Which pointer it is decides behaviour (the
     `web-touch-player` class); the window's size decides geometry, here. Bars stay clear of a phone's notch, rounded
     corners and home indicator. */
  .web-custom-player {
    --player-safe-top: env(safe-area-inset-top, 0px);
    --player-safe-bottom: env(safe-area-inset-bottom, 0px);
    --player-side: max(
      clamp(16px, 3vw, 48px),
      calc(env(safe-area-inset-left, 0px) + 16px),
      calc(env(safe-area-inset-right, 0px) + 16px)
    );
    --player-top: max(12px, var(--player-safe-top));
    --player-bottom: max(8px, var(--player-safe-bottom));

    /* The timeline and the dock together: what floats above them (Skip, up next) sits this far up. */
    --web-bar: 68px;
    --web-remote: 0px;
    --web-glass: var(--glass-bg, rgb(28 28 34 / 0.62));
    --web-glass-edge: var(--glass-edge, rgb(255 255 255 / 0.13));
    --web-glass-blur: var(--glass-blur, blur(24px) saturate(160%));

    grid-template-rows: minmax(0, 1fr);
    padding: 0;
  }

  .web-touch-player {
    --web-bar: 88px;
  }

  .web-custom-player > .stage {
    position: absolute;
    inset: 0;
  }

  .web-custom-player video {
    cursor: pointer;
  }

  /* Left alone, the mouse goes with the controls. */
  .web-custom-player.web-controls-hidden:not(.web-touch-player),
  .web-custom-player.web-controls-hidden:not(.web-touch-player) video {
    cursor: none;
  }

  .web-custom-player > header.web-top {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    z-index: 5;
    gap: 4px;
    justify-content: flex-start;
    padding: var(--player-top) calc(var(--player-side) - 10px) 64px;
    background: linear-gradient(rgb(0 0 0 / 0.62), transparent);
    pointer-events: none;
  }

  .web-top > * {
    pointer-events: auto;
  }

  .web-heading {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    padding: 0 4px;
    line-height: 1.25;
  }

  .web-heading b {
    font-size: 15px;
    font-weight: 600;
  }

  .web-heading span {
    overflow: hidden;
    color: rgb(255 255 255 / 0.66);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The output slot: one fixed 44px box at the bar's right end, whichever of Cast and AirPlay is in it. */
  .web-output {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: flex-end;
    min-width: 44px;
    min-height: 44px;
  }

  /* Every control is a bare glyph on a 44px target; only Play is filled. Pressed, a faint circle behind it. */
  .web-custom-player :global(.web-glyph) {
    --button-icon-size: 24px;

    position: relative;
    display: inline-flex;
    flex: none;
    gap: 8px;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 22px;
    background: none;
    color: rgb(255 255 255 / 0.94);
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
  }

  .web-custom-player :global(.web-glyph)::before {
    position: absolute;
    inset: 2px;
    content: '';
    border-radius: 22px;
    background: rgb(255 255 255 / 0.14);
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }

  .web-centre :global(.web-glyph)::before,
  .web-remote :global(.web-glyph)::before {
    border-radius: 50%;
  }

  /* Buffering: a ring on Play's edge instead of a line of text. */
  .web-custom-player :global(.web-play[aria-busy='true'])::before {
    inset: -2px;
    border: 2px solid transparent;
    border-top-color: #fff;
    border-radius: 50%;
    background: none;
    opacity: 1;
    animation: status-spin 800ms linear infinite;
  }

  .web-custom-player :global(.web-glyph:active)::before {
    opacity: 1;
  }

  /* A tap would leave a hover state stuck: only a mouse draws one. */
  .web-custom-player:not(.web-touch-player) :global(.web-glyph:hover)::before {
    opacity: 1;
  }

  .web-custom-player :global(.web-glyph:disabled) {
    opacity: 0.38;
    cursor: default;
  }

  .web-custom-player :global(.web-glyph:focus-visible),
  .web-custom-player .cast-slot.cast-focused {
    outline: var(--ring-width, 3px) solid #fff;
    outline-offset: -3px;
  }

  .web-custom-player :global(.web-glyph.web-on) {
    color: #8fb0ff;
  }

  .web-custom-player .cast-slot.cast-hover {
    background: rgb(255 255 255 / 0.14);
  }

  .web-transport .icon {
    width: 24px;
    height: 24px;
    opacity: 1;
  }

  .web-custom-player .icon .filled {
    fill: currentcolor;
    stroke: none;
  }

  .web-custom-player .skip-icon,
  .web-custom-player .transport-icon {
    width: 30px;
    height: 30px;
    overflow: visible;
    fill: none;
    stroke: currentcolor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2.5;
  }

  .web-custom-player .transport-icon {
    width: 24px;
    height: 24px;
  }

  .web-custom-player .skip-icon text {
    fill: currentcolor;
    stroke: none;
    font-family: inherit;
    font-size: 15px;
    font-weight: 750;
    text-anchor: middle;
  }

  .web-custom-player .transport-icon .filled {
    fill: currentcolor;
    stroke: none;
  }

  /* A label beside the glyph where there is room for one: on its side, a tablet, a wide window. */
  .web-custom-player :global(.web-labelled) {
    padding: 0 12px 0 10px;
  }

  .web-tip {
    position: relative;
    display: inline-flex;
  }

  .web-source {
    display: none;
  }

  .web-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Tooltips name the control and its key, half a second after the mouse settles on it. */
  .web-custom-player:not(.web-touch-player) [data-tip]::after {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    z-index: 8;
    content: attr(data-tip) '   ' attr(data-key);
    padding: 5px 9px;
    border: 1px solid rgb(255 255 255 / 0.14);
    border-radius: 7px;
    background: rgb(20 20 24 / 0.94);
    color: #fff;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.2;
    white-space: pre;
    opacity: 0;
    pointer-events: none;
    transform: translateX(-50%);
    transition: opacity 120ms ease;
  }

  .web-custom-player:not(.web-touch-player) [data-tip]:hover::after {
    opacity: 1;
    transition-delay: 500ms;
  }

  .web-custom-player:not(.web-touch-player) .web-top [data-tip]::after {
    top: calc(100% + 6px);
    bottom: auto;
    left: 0;
    transform: none;
  }

  .web-custom-player:not(.web-touch-player) .web-output [data-tip]::after,
  .web-custom-player:not(.web-touch-player) .web-dock-group:last-child [data-tip]::after {
    right: 0;
    left: auto;
    transform: none;
  }

  /* One toast at a time under the top bar, centred: never more than 480px, nor two lines. It stays while the controls
     hide, and a mouse shows over one that offers something. */
  .web-custom-player > .web-toasts {
    position: absolute;
    top: calc(var(--player-top) + 52px);
    right: var(--player-side);
    left: var(--player-side);
    z-index: 7;
    gap: 0;
    pointer-events: none;
  }

  .web-custom-player .web-toasts .notice {
    min-height: 36px;
    max-width: min(100%, 480px);
    margin: 0;
    padding: 4px 4px 4px 14px;
    border: 1px solid var(--web-glass-edge);
    border-radius: 18px;
    pointer-events: auto;
    cursor: auto;
  }

  .web-toasts .notice:last-of-type {
    margin-bottom: 0;
  }

  .web-toasts .notice-copy {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    padding: 4px 0;
  }

  /* A toast's offer is a quiet chip, white on 12% white; dismissing it is a bare glyph. */
  .web-toasts :global(.notice-action) {
    padding: 3px 12px;
    border: 0;
    border-radius: 12px;
    background: rgb(255 255 255 / 0.12);
    color: #fff;
    font: inherit;
    font-weight: 600;
  }

  .web-toasts :global(.notice-dismiss) {
    border: 0;
    border-radius: 18px;
    background: none;
    color: rgb(255 255 255 / 0.8);
  }

  .web-transport {
    position: absolute;
    inset: 0;
    z-index: 4;
    pointer-events: none;
  }

  /* −10 · play · +10 over the middle of the picture: the stage's middle is the picture's, which it fills and centres. */
  .web-centre {
    position: absolute;
    top: 50%;
    left: 50%;
    display: none;
    gap: 40px;
    align-items: center;
    transform: translate(-50%, -50%);
  }

  .web-touch-player .web-centre {
    display: flex;
  }

  .web-centre > *,
  .web-bar > *,
  .web-floating > * {
    pointer-events: auto;
  }

  .web-centre :global(.web-play),
  .web-remote :global(.web-play) {
    --button-icon-size: 28px;

    width: 64px;
    height: 64px;
    border: 1px solid var(--web-glass-edge);
    border-radius: 50%;
    background: var(--web-glass);
    backdrop-filter: var(--web-glass-blur);
    -webkit-backdrop-filter: var(--web-glass-blur);
  }

  .web-centre .web-skip-back,
  .web-centre .web-skip-forward,
  .web-remote .web-skip-back,
  .web-remote .web-skip-forward {
    width: 52px;
    height: 52px;
  }

  .web-centre .skip-icon,
  .web-remote .skip-icon {
    width: 34px;
    height: 34px;
  }

  /* A mouse pauses on the picture: while paused the middle shows Play, and a resume flashes Pause there. */
  .web-centre-glyph {
    --button-icon-size: 32px;

    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--web-glass);
    transform: translate(-50%, -50%);
  }

  .web-flash {
    animation: web-flash 400ms ease-out forwards;
  }

  @keyframes web-flash {
    to {
      opacity: 0;
      transform: translate(-50%, -50%) scale(1.3);
    }
  }

  .web-touch-player .web-centre-glyph {
    display: none;
  }

  /* Double-tap seeks add up on their side: "−20 s". */
  .web-ripple {
    position: absolute;
    top: 50%;
    left: 15%;
    display: grid;
    place-items: center;
    width: 128px;
    height: 128px;
    border-radius: 50%;
    background: radial-gradient(closest-side, rgb(255 255 255 / 0.22), transparent);
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    transform: translate(-50%, -50%);
  }

  .web-ripple-forward {
    left: 85%;
  }

  .web-floating {
    position: absolute;
    right: var(--player-side);
    bottom: calc(var(--web-bar) + var(--web-remote) + var(--player-bottom) + 12px);
    left: var(--player-side);
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-end;
  }

  .web-floating :global(.web-skip) {
    min-height: 44px;
    padding: 0 18px;
    border: 1px solid rgb(255 255 255 / 0.22);
    border-radius: 22px;
    background: var(--web-glass);
    color: #fff;
    font-weight: 600;
    backdrop-filter: var(--web-glass-blur);
    -webkit-backdrop-filter: var(--web-glass-blur);
  }

  .web-up-next {
    display: grid;
    gap: 10px;
    box-sizing: border-box;
    width: min(420px, 100%);
    padding: 12px;
    border: 1px solid var(--web-glass-edge);
    border-radius: 16px;
    background: var(--web-glass);
    backdrop-filter: var(--web-glass-blur);
    -webkit-backdrop-filter: var(--web-glass-blur);
  }

  .web-up-next-top {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  /* The episode's still, with its length on it. */
  .web-up-next-thumb {
    position: relative;
    flex: none;
    overflow: hidden;
    width: 112px;
    height: 63px;
    border-radius: 8px;
    background: #111;
  }

  .web-up-next-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .web-up-next-runtime {
    position: absolute;
    right: 5px;
    bottom: 4px;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgb(0 0 0 / 0.6);
    font-size: 11px;
    font-weight: 600;
  }

  .web-up-next-text {
    display: grid;
    gap: 2px;
    min-width: 0;
    margin: 0;
  }

  .web-up-next-text b {
    overflow: hidden;
    font-size: 16px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .web-up-next-text small {
    color: rgb(255 255 255 / 0.66);
    font-size: 12px;
    font-weight: 500;
  }

  .web-up-next-text span {
    color: rgb(255 255 255 / 0.66);
    font-size: 13px;
  }

  .web-up-next-actions {
    display: flex;
    gap: 8px;
  }

  .web-up-next-actions :global(.den-button) {
    min-height: 44px;
    padding: 0 16px;
    border: 0;
    border-radius: 22px;
    background: rgb(255 255 255 / 0.1);
    color: #fff;
    font-weight: 600;
  }

  /* Play now fills as the countdown runs. */
  .web-up-next-actions :global(.web-play-now) {
    flex: 1;
    background: linear-gradient(
      to right,
      #fff var(--up-next-progress),
      rgb(255 255 255 / 0.58) var(--up-next-progress)
    );
    color: #0b0b0f;
  }

  .web-bar {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 5;
    display: grid;
    padding: 72px var(--player-side) var(--player-bottom);
    background: linear-gradient(transparent, rgb(0 0 0 / 0.74));
    pointer-events: none;
  }

  .web-timeline {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'track';
    column-gap: 12px;
    align-items: center;
    color: rgb(255 255 255 / 0.8);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    line-height: 16px;
  }

  .web-elapsed,
  .web-remaining {
    display: none;
  }

  .web-elapsed {
    grid-area: elapsed;
  }

  .web-remaining {
    grid-area: remaining;
    text-align: right;
  }

  .web-track {
    --web-track: 4px;
    --web-thumb: 14px;

    grid-area: track;
    width: 100%;
    height: 24px;
    margin: 0;
    padding: 0;
    border: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }

  .web-track::-webkit-slider-runnable-track {
    height: var(--web-track);
    border-radius: 999px;

    /* Played, then where a mouse hovers, then what is buffered past both, then the rest. A stop before the one ahead
       of it is drawn at that one, so each fill shows only past the fills above it. */
    background: linear-gradient(
      to right,
      #fff 0 var(--tv-progress),
      rgb(255 255 255 / 0.6) var(--tv-progress) var(--tv-hover, var(--tv-progress)),
      rgb(255 255 255 / 0.42) var(--tv-hover, var(--tv-progress)) var(--tv-buffered, 0%),
      rgb(255 255 255 / 0.26) var(--tv-buffered, 0%) 100%
    );
  }

  .web-track::-webkit-slider-thumb {
    width: var(--web-thumb);
    height: var(--web-thumb);
    margin-top: calc((var(--web-track) - var(--web-thumb)) / 2);
    border: 0;
    border-radius: 50%;
    appearance: none;
    background: #fff;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
  }

  .web-track::-moz-range-track {
    height: var(--web-track);
    border-radius: 999px;
    background: linear-gradient(
      to right,
      rgb(255 255 255 / 0.42) 0 var(--tv-buffered, 0%),
      rgb(255 255 255 / 0.26) var(--tv-buffered, 0%) 100%
    );
  }

  .web-track::-moz-range-progress {
    height: var(--web-track);
    border-radius: 999px;
    background: #fff;
  }

  .web-track::-moz-range-thumb {
    width: var(--web-thumb);
    height: var(--web-thumb);
    border: 0;
    border-radius: 50%;
    background: #fff;
  }

  /* A finger's timeline: a 44px target, the times at its two ends. */
  .web-touch-player .web-track {
    height: 44px;
  }

  /* Held, the track thickens and the thumb grows; a mouse hovering thickens it too (below). */
  .web-track:active {
    --web-track: 6px;
    --web-thumb: 20px;
  }

  .web-track:focus-visible {
    outline: 0;
  }

  .web-track:focus-visible::-webkit-slider-thumb {
    box-shadow:
      0 0 0 3px #000,
      0 0 0 6px #fff;
  }

  .web-track:focus-visible::-moz-range-thumb {
    box-shadow:
      0 0 0 3px #000,
      0 0 0 6px #fff;
  }

  .web-track:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .web-custom-player:not(.web-touch-player) .web-track:hover {
    --web-track: 6px;
  }

  /* Where the pointer is on the timeline, in time. */
  .web-bubble {
    position: absolute;
    bottom: calc(100% - 2px);
    padding: 4px 9px;
    border: 1px solid rgb(255 255 255 / 0.14);
    border-radius: 7px;
    background: rgb(20 20 24 / 0.94);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    pointer-events: none;
    transform: translateX(-50%);
  }

  .web-touch-player .web-timeline {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: 'elapsed track remaining';
  }

  .web-touch-player .web-elapsed,
  .web-touch-player .web-remaining {
    display: block;
  }

  .web-dock {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    min-height: 44px;

    /* The targets reach into the gutter, so their glyphs line up with the timeline's ends. */
    margin: 0 -10px;
  }

  .web-dock-group,
  .web-dock-transport {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .web-touch-player .web-dock-transport {
    display: none;
  }

  .web-touch-mute {
    display: none;
  }

  .web-touch-player .web-touch-mute {
    display: contents;
  }

  .web-dock-transport :global(.web-play) {
    --button-icon-size: 28px;
  }

  .web-volume {
    width: 96px;
    margin: 0 8px 0 2px;
    accent-color: #fff;
  }

  .web-time {
    padding: 0 8px;
    color: rgb(255 255 255 / 0.85);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Casting, this page is the receiver's remote: its transport under the timeline, and the controls never hide. */
  .web-remote {
    display: none;
    gap: 40px;
    align-items: center;
    justify-content: center;
    padding: 4px 0;
  }

  .web-touch-player.web-casting {
    --web-remote: 72px;
  }

  .web-touch-player.web-casting .web-remote {
    display: flex;
  }

  .web-custom-player .cast-view {
    overflow: hidden;
    padding-block: calc(var(--player-top) + 56px)
      calc(var(--web-bar) + var(--web-remote) + var(--player-bottom) + 24px);
  }

  .web-custom-player .cast-view > * {
    position: relative;
  }

  .web-custom-player .cast-view .cast-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    max-width: none;
    height: 100%;
    border-radius: 0;
    object-fit: cover;
    box-shadow: none;
    filter: blur(28px) brightness(0.38) saturate(1.2);
    transform: scale(1.35);
    aspect-ratio: auto;
  }

  .web-custom-player .cast-view img:not(.cast-backdrop) {
    width: 168px;
    max-width: none;
    height: 252px;
  }

  .web-custom-player > header,
  .web-custom-player .web-centre,
  .web-bar {
    transition: opacity 250ms ease;
  }

  .web-custom-player:not(.web-controls-hidden) > header,
  .web-custom-player:not(.web-controls-hidden) .web-centre,
  .web-custom-player:not(.web-controls-hidden) .web-bar {
    transition-duration: 150ms;
  }

  .web-custom-player.web-controls-hidden > header,
  .web-custom-player.web-controls-hidden .web-centre,
  .web-custom-player.web-controls-hidden .web-centre-glyph,
  .web-custom-player.web-controls-hidden .web-bar {
    opacity: 0;
  }

  /* Invisible controls cannot intercept a pointer meant for the picture. Keyboard focus reveals them before it acts. */
  .web-custom-player.web-controls-hidden .web-top > *,
  .web-custom-player.web-controls-hidden .web-centre > *,
  .web-custom-player.web-controls-hidden .web-bar > * {
    pointer-events: none;
  }

  .web-custom-player .tv-subtitle-timing {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 8;
    display: grid;
    grid-template-columns: auto minmax(90px, auto) auto;
    gap: 18px;
    align-items: center;
    padding: 22px;
    border: 1px solid rgb(255 255 255 / 0.15);
    border-radius: 20px;
    background: rgb(25 25 25 / 0.9);
    box-shadow: 0 18px 70px rgb(0 0 0 / 0.55);
    transform: translate(-50%, -50%);
    backdrop-filter: blur(20px);
  }

  .web-custom-player .tv-subtitle-timing button {
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid rgb(255 255 255 / 0.18);
    border-radius: 999px;
    background: rgb(255 255 255 / 0.12);
    color: #fff;
    font: inherit;
  }

  .web-custom-player .tv-subtitle-timing strong {
    font-size: 30px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .web-custom-player .web-timing-actions {
    display: flex;
    grid-column: 1 / -1;
    gap: 8px;
    justify-content: center;
  }

  /* The options: a 380px popover beside its button; on a phone, a sheet from the bottom, or the right edge on its side.
     They open with what is playing (`optionsHeader`). */
  :global(div.menu:not(.sheet):has(.options-rows)) {
    width: 380px;
    max-width: calc(100vw - 16px);
  }

  :global(div.menu.sheet:has(.options-rows)) {
    max-height: 62dvh;
  }

  /* A row with its current value at its end, quieter than its name; a page's row adds a chevron. */
  :global(div.menu:has(.options-rows) .item.valued) {
    gap: 12px;
    min-height: 50px;
  }

  :global(div.menu:has(.options-rows) .item.valued .den-button-label) {
    flex: 1 0 auto;
  }

  :global(div.menu:has(.options-rows) .item.back)::before {
    content: '‹';
    margin-right: 8px;
    color: var(--muted, rgb(255 255 255 / 0.6));
  }

  .item-value {
    min-width: 0;
    overflow: hidden;
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-value,
  .item-chevron,
  .options-section-heading,
  .item-description {
    color: var(--muted, rgb(255 255 255 / 0.6));
  }

  .item-description {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    font-size: 12px;
    font-weight: 400;
    overflow-wrap: anywhere;
  }

  .options-page-heading {
    margin: 6px 10px 8px;
    color: var(--muted, rgb(255 255 255 / 0.6));
    font-size: 13px;
    font-weight: 600;
  }

  .options-section + .options-section {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--line, rgb(255 255 255 / 0.1));
  }

  .options-section-heading {
    margin: 0;
    padding: 8px 12px 4px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .options-head {
    display: grid;
    gap: 2px;
    justify-items: start;
    margin-bottom: 4px;
    padding: 4px 12px 10px;
    border-bottom: 1px solid rgb(255 255 255 / 0.08);
    color: #fff;
  }

  .options-head b {
    font-size: 17px;
    font-weight: 600;
  }

  .options-release {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5ch;
    margin: 0;
    color: rgb(255 255 255 / 0.62);
    font-size: 13px;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }

  .options-chip {
    margin-top: 6px;
    padding: 2px 7px;
    border-radius: 6px;
    background: rgb(255 255 255 / 0.1);
    color: rgb(255 255 255 / 0.85);
    font-size: 12px;
    font-weight: 600;
  }

  /* A mouse window: the transport in the dock beside the volume and the time; the volume slider folds into Mute below
     48rem and the time below 40rem, where the dock's labels drop to glyphs with tooltips too. */
  @media (width < 48rem) {
    .web-volume {
      display: none;
    }
  }

  @media (width < 40rem) {
    .web-custom-player:not(.web-touch-player) .web-label,
    .web-time {
      display: none;
    }

    .web-custom-player:not(.web-touch-player) :global(.web-labelled) {
      padding: 0;
    }
  }

  /* A phone held upright, or a window as narrow: the transport in the black band under the picture, between the
     timeline and the dock, so nothing to press covers the picture; glyphs only, the times under the timeline. Its
     scrim stays in that band too. */
  @media (width < 33rem) {
    .web-custom-player {
      --web-bar: 104px;
      --web-remote: 72px;
    }

    .web-custom-player .web-centre {
      display: none;
    }

    .web-bar {
      padding-top: 24px;
    }

    .web-centre-glyph,
    .web-label {
      display: none;
    }

    .web-custom-player .web-dock-transport {
      display: none;
    }

    .web-touch-mute {
      display: contents;
    }

    .web-remote {
      display: flex;
    }

    .web-custom-player :global(.web-labelled) {
      padding: 0;
    }

    .web-custom-player .web-track {
      height: 44px;
    }

    .web-custom-player .web-elapsed,
    .web-custom-player .web-remaining {
      display: block;
    }
  }

  @media (width < 33rem), (orientation: portrait) {
    .web-touch-player {
      --web-bar: 104px;
    }

    .web-touch-player .web-timeline {
      grid-template:
        'track track' 44px
        'elapsed remaining' 16px / 1fr 1fr;
    }
  }

  @media (width < 33rem) {
    .web-custom-player .web-timeline {
      grid-template:
        'track track' 44px
        'elapsed remaining' 16px / 1fr 1fr;
    }

    .web-up-next {
      width: 100%;
    }
  }

  @media (orientation: portrait) {
    .web-touch-player .web-up-next {
      width: 100%;
    }
  }

  /* A phone on its side: the up-next card is then the one thing to press, and the transport would meet it. */
  @media (height < 32rem) {
    .web-custom-player.web-counting .web-centre {
      display: none;
    }

    .web-up-next-thumb {
      width: 120px;
      height: 68px;
    }

    .web-custom-player .web-toasts .notice {
      max-width: min(100%, 420px);
    }

    .web-custom-player .cast-view img:not(.cast-backdrop) {
      width: 112px;
      height: 168px;
    }

    :global(div.menu.sheet:has(.options-rows)) {
      inset: 0 0 0 auto;
      left: auto;
      width: calc(380px + env(safe-area-inset-right, 0px));
      max-width: 100%;
      height: 100%;
      max-height: none;
      padding-right: max(8px, env(safe-area-inset-right, 0px));
      border-radius: 0;
    }
  }

  /* A tablet: the same layout as a phone, at a larger size. */
  @media (width >= 33rem) and (height >= 32rem) {
    .web-touch-player .web-centre :global(.web-play),
    .web-touch-player .web-remote :global(.web-play) {
      --button-icon-size: 40px;

      width: 80px;
      height: 80px;
    }

    .web-custom-player .cast-view img:not(.cast-backdrop) {
      width: 200px;
      height: 300px;
    }
  }

  @media (width >= 48rem) {
    .web-heading b {
      font-size: 17px;
    }

    .web-heading span {
      font-size: 14px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .web-custom-player > header,
    .web-custom-player .web-centre,
    .web-bar,
    .web-custom-player :global(.web-glyph)::before {
      transition: none;
    }

    .status-spinner,
    .web-flash,
    .web-custom-player :global(.web-play[aria-busy='true'])::before {
      animation: none;
    }
  }

  /* A wait remains a toast over the media; a state that cannot continue becomes one calm, centred decision card.
     Keeping its action inside the same surface avoids the former mix of loose text and apparently unrelated buttons. */
  .terminal-message {
    display: grid;
    gap: 16px;
    justify-items: center;
    width: min(calc(100% - 24px), 32rem);
    max-width: none;
    margin: 0;
    padding: 24px;
    border-radius: 18px;
    background: rgb(18 18 20 / 0.9);
    color: rgb(255 255 255 / 0.86);
    text-align: center;
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.4);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
  }

  .terminal-message p {
    margin: 0;
  }

  /* A terminal decision needs calm hierarchy, not a danger-red sentence competing with a solid white action. The
     role still announces the failure; red remains for a concrete field error such as a rejected browser key. */
  .terminal-message :global(.den-button-primary) {
    --button-bg: rgb(255 255 255 / 0.12);
    --button-border: rgb(255 255 255 / 0.18);
    --button-fg: rgb(255 255 255 / 0.92);
  }

  .terminal-message .error {
    color: var(--danger);
  }
</style>
