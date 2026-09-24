<!-- Playback in this browser through den-remux: the title's release as HLS, played natively where the browser can
     (Safari, and so AirPlay) and through hls.js elsewhere. The browser's own controls do the transport; the bars
     around the video carry what Den adds — the audio language, the next episode, and waiting for a free slot. Starts
     where the library says, and reports where it got to every minute, on pause, when the page is hidden and on close.
     The lock screen and the system's media controls name the title and move it too. -->
<script lang="ts">
  import type Hls from 'hls.js';
  import { untrack } from 'svelte';
  import { WATCHED } from '../lib/actions';
  import {
    canOfferCast,
    CAST_DISCOVERY_MS,
    CAST_PLAY_MS,
    castLook,
    fetchCastOrigin,
    returnsFromCast,
    type CastLook,
    type CastOffer,
  } from '../lib/castOffer';
  import { guestGrants } from '../lib/grants.svelte';
  import { hlsConfig } from '../lib/hlsConfig';
  import { retryWithoutHint } from '../lib/ipv4';
  import type { Title } from '../lib/library';
  import { PlaybackProgressReporter } from '../lib/playbackProgress';
  import { playable, withoutRefused, type Playable } from '../lib/playable';
  import {
    downmixLabel,
    nativeHls,
    endSession,
    guestLimits,
    linkLimit,
    listReleases,
    login,
    reassertGrant,
    relayLimit,
    releaseParts,
    rememberLink,
    reportFailure,
    sourceFailed,
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
    optionLabel,
    releaseAfterMeasure,
    restartAfterMeasure,
    swapNotice,
  } from '../lib/releaseVerdicts';
  import { aheadIn, reportUrlOf, watchPlayback, type Watcher } from '../lib/playbackStats';
  import { Link, wasInterrupted } from '../lib/resumingLoader';
  import { stuckWatch } from '../lib/stuckWatch';
  import { countdownLabel, PrebufferHold } from '../lib/prebufferHold';
  import {
    bytesBetween,
    DeliveryMeter,
    scaleDemand,
    shouldSwitch,
    switchAsk,
    waitAt,
  } from '../lib/switchPolicy';
  import type { Addon } from '../lib/scout';
  import { fetchImdbId } from '../lib/tmdb';
  import {
    activeAt,
    canAutoSkip,
    fetchSkipSegments,
    SKIP_LABEL,
    type SkipKind,
    type SkipSegment,
  } from '../lib/skipdb';
  import { shouldWarmNext } from '../lib/binge';

  let {
    title,
    season,
    episode,
    filename,
    tmdbKey,
    scout,
    remux,
    subtitles,
    audioLanguage,
    subtitleLanguage,
    shownSubtitleLanguages,
    autoSkip = false,
    resume,
    next,
    nextEpisode,
    onprogress,
    onnext,
    onclose,
  }: {
    title: Title;
    season?: number;
    episode?: number;
    filename?: string;
    tmdbKey: string;
    scout: Addon;
    /** Where den-remux answers (`findRemux`): '' for this origin, else the tailnet's address. */
    remux: string;
    /** The library's other LAN addons: den-subtitles is among them. */
    subtitles: string[];
    /** Settings › Playback's audio language (ISO 639-1); undefined is each title's original language. */
    audioLanguage?: string;
    /** Its subtitle language; undefined is off. */
    subtitleLanguage?: string;
    /** Settings › Content's visible subtitle languages, offered in the picker beside the chosen one. */
    shownSubtitleLanguages?: readonly string[];
    /** Settings › Playback's "Auto-skip intros & credits". A Skip button shows either way. */
    autoSkip?: boolean;
    /** Where the library says this was left. */
    resume: { fraction: number; seconds?: number };
    /** The episode after this one, as `S2 · E4`, when there is one. */
    next?: string;
    /** That episode's own numbers, so it can be warmed before the advance (`shouldWarmNext`). */
    nextEpisode?: { season?: number; episode?: number };
    onprogress: (fraction: number, seconds: number) => void;
    onnext?: () => void;
    onclose: () => void;
  } = $props();

  const REPORT_MS = 60_000;
  /** How long a video may go without a picture before it counts as one the browser can't play. */
  const STUCK_MS = 30_000;
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
  /**
   * How close to the last report a hidden page's close may be and write nothing: hiding the page already wrote it, and
   * closing a tab hides it just before `pagehide`.
   */
  const HIDDEN_SLACK_SECS = 5;
  /** The step of the lock screen's and a headset's skip buttons, where they don't name one. */
  const SKIP_SECS = 10;
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
    | 'noFit',
    string
  > = {
    public: 'Playback isn’t available from this network yet.',
    ...guestLimits,
    none: 'No release of this that plays in a browser is ready right now. Try again later, or play it on your TV.',
    unreachable: 'Couldn’t reach Den’s player. Check that this device is on your network.',
    imdb: 'TMDB has no IMDb id for this, which Den’s sources need.',
    unsupported: 'This browser can’t play video streams.',
    playback: 'This browser couldn’t play this release. Try it on your TV.',
    // Deliberately not "couldn't play": the release stopped arriving, and playing it again usually works.
    source: 'This release stopped responding. Try it again, or pick another one.',
    noCopy: 'This can’t be played on this device right now. Try it on your TV.',
    noFit:
      'No release of this fits this connection as it is. Try it again on a faster one, or on your TV.',
  };
  /** Waiting on den-remux, which is asked again every RETRY_MS. */
  const waits: Record<'busy' | 'transcode', string> = {
    busy: 'Den is already playing two things. Waiting for one to stop…',
    transcode:
      'This needs converting for this browser, and the homelab is converting another. Waiting for it to finish…',
  };

  let video = $state<HTMLVideoElement>();
  let castFrame = $state<HTMLIFrameElement>();
  let remoteTime = 0;
  let remoteDuration = 0;
  let remotePaused = true;
  let casting = $state(false);
  let castMode = false;
  let castProfile = 'legacy';
  /** The same-origin control relay: the only route whose sessions carry a public address and the cast page. */
  const RELAY = '/remux';
  /**
   * Where den-remux is asked, which starts as the page's own route and moves to the relay when the viewer asks to
   * cast from a direct (tailnet or home-network) one: those play in a plain video element that has no Cast button.
   */
  let route = $state(untrack(() => remux));
  let routeBeforeCast = untrack(() => remux);
  /** Where a press of Cast stands (`castLook`): playback moves to the relay only once a receiver was seen. */
  let castOffer = $state<CastOffer>('idle');
  /** The cast page, loaded unseen beside the playing video to look for a receiver; unset while not looking. */
  let lookOrigin = $state<string>();
  let lookFrame = $state<HTMLIFrameElement>();
  /** Set while playback was moved to the relay to cast: a failure there goes back to the player it left. */
  let castOffered = false;
  let publicMaxBitrate: number | undefined;
  /** The `maxBitrate` the playing session was asked with. */
  let askedMaxBitrate: number | undefined;
  /** What this page's own video reports to den-remux (`watchPlayback`); stopped before hls.js is destroyed. */
  let watcher: Watcher | undefined;
  /** The release the viewer chose — from the title's sources, or the picker here — rather than den-remux's own pick. */
  let chosenRelease: string | undefined = untrack(() => filename);
  let session = $state<Session | null>(null);
  /** The route `session` was started on: the same one's credentials, so the same owner at den-remux. */
  let sessionRoute: string | undefined;
  let failure = $state<Failure | 'imdb' | 'unsupported' | 'playback' | 'source' | 'lost' | null>(
    null,
  );
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
  let timer: ReturnType<typeof setInterval> | undefined;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const progress = new PlaybackProgressReporter((fraction, seconds) =>
    onprogress(fraction, seconds),
  );
  /** Where the next session starts: a language switch picks up where the last one was. */
  let startAt: { fraction: number; seconds?: number } | null = null;
  /** The second den-remux was asked to start the playing session at; undefined when it was asked for none. */
  let started: number | undefined;
  /** What this browser decodes, found once: den-remux converts only what won't play here. */
  let decodes: Playable | undefined;
  /** The title's releases den-remux could play, to pick another from. */
  let releases = $state<Release[]>([]);
  /** Said when den-remux opened another release than the one picked; dismissed by the viewer. */
  let swapped = $state<string | null>(null);
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
  let played = false;
  /** Releases of this title a switch moved away from (`switchAway`), not asked for again; the viewer's pick clears it. */
  let excluded: string[] = [];
  let switching = false;
  /** Seconds of the playing session actually played, for `switchPolicy`'s early window, and where it last was. */
  let playedSecs = 0;
  let lastPosition: number | undefined;
  /** What the playing session's media is really arriving at. */
  let meter = new DeliveryMeter();
  /** Set once no other copy fitted the link: this one plays on, and delivery is not weighed again. */
  let deliveryGaveUp = false;
  /** Shown while the link is slower than the playing release needs, and nothing else fits it. */
  let struggling = $state(false);
  /**
   * The bytes of the playing session's fragments against what den-remux said it sends for the same stretches
   * (`segments`): the share of its demand that really comes, which `waitAt` is weighed with.
   */
  let delivered = { bytes: 0, demand: 0 };
  /** The playing session's start, held until it can play through (`prebuffer`); null once it plays. */
  let hold: PrebufferHold | null = null;
  /** What the countdown over a held start says; null when there is none to show. */
  let startsIn = $state<string | null>(null);
  /** Said when a change asked for mid-film (another track, another release, casting) couldn't be made as a copy. */
  let unchanged = $state<string | null>(null);

  const heading = $derived(
    season !== undefined ? `${title.title} · S${season} · E${episode}` : title.title,
  );
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
   * started, and kept for good when none does: true when one did.
   */
  async function begin(
    pick: { audioTrack?: number; filename: string } | undefined = filename
      ? { filename }
      : undefined,
    extra: Pick<Want, 'exclude' | 'transcode' | 'fitsOnly' | 'maxBitrate'> = {},
    replacing?: Session,
  ): Promise<boolean> {
    clearTimeout(retry);
    if (!replacing) failure = null;
    swapped = null;
    unchanged = null;
    if (!imdb) {
      const found = await fetchImdbId({ type: title.type, id: title.id }, tmdbKey);
      if (!found) {
        failure = found === null ? 'imdb' : 'unreachable';
        return false;
      }
      imdb = found;
    }
    const { audio, subtitleLanguages } = wantedLanguages(
      { audio: audioLanguage, subtitle: subtitleLanguage, shownSubtitles: shownSubtitleLanguages },
      title.originalLanguage,
      navigator.languages,
    );
    const claimed = (decodes ??= await playable());
    // What this browser hasn't disproved. After a refusal it asks as something that takes no HEVC, no HDR and no
    // E-AC-3, so den-remux copies another release this browser does decode — never converting one mid-film.
    const can = castMode
      ? castCapabilities(degraded ? 'legacy' : castProfile)
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
    // Not the very start, nor the credits. A resume the library holds as a fraction alone can't be named before the
    // video's length is known: it is sought to once the video has loaded, as before.
    const from = startAt ?? resume;
    const at =
      from.seconds !== undefined && from.seconds > 5 && from.fraction < WATCHED
        ? from.seconds
        : undefined;
    const request: Want = {
      imdb,
      season,
      episode,
      scout: scout.install,
      subtitles,
      subtitleLanguages,
      audio,
      videoCodecs: videoCodecsOf(can),
      playable: can,
      startAt: at,
      maxBitrate,
      // For den-remux's log only, so a session can be told apart by the player that played it.
      player: castMode ? 'cast' : nativeHls(document.createElement('video')) ? 'native' : 'hls.js',
      // No address is looked up here: `startSession` does that only when den-edge asks for it.
      ...(noHint ? { noHint } : {}),
      ...(excluded.length ? { exclude: [...excluded] } : {}),
      ...extra,
      ...pick,
      // den-remux keeps the session being replaced playing until this one serves media, rather than ending it as
      // soon as this is asked for. Only a session of the same route: another route's (a move to cast) may belong to
      // another owner there, and is not ended by this one anyway.
      ...(replacing?.sid && sessionRoute === route ? { replaces: replacing.sid } : {}),
    };
    const on = route;
    const result = await startSession(request, undefined, on);
    if (ended || (replacing && session !== replacing)) {
      if (!('failure' in result)) endSession(result);
      return false;
    }
    if ('failure' in result) {
      if (replacing) return false;
      failure = result.failure;
      if (result.failure === 'busy' || result.failure === 'transcode')
        // What it asked for, where it said: a converting GPU can mean minutes, and knocking every
        // twenty seconds until then is work for a box that is already the reason we are waiting.
        retry = setTimeout(() => void begin(pick, extra), result.retryMs ?? RETRY_MS);
      return false;
    }
    if (replacing) {
      // The new session is in hand: only now is the one playing let go.
      watcher?.stop();
      watcher = undefined;
      hls?.destroy();
      hls = undefined;
      endSession(replacing);
    }
    started = at;
    askedMaxBitrate = maxBitrate;
    played = false;
    // A switch keeps the early window it was made in: the time already played counts, or every switch would open
    // another thirty seconds for the next.
    if (!replacing) playedSecs = 0;
    lastPosition = undefined;
    meter = new DeliveryMeter();
    delivered = { bytes: 0, demand: 0 };
    deliveryGaveUp = false;
    struggling = false;
    hold = result.prebuffer ? new PrebufferHold(result.prebuffer, performance.now()) : null;
    startsIn = null;
    session = result;
    sessionRoute = on;
    // Moved to cast, but the relay's session has no public address or cast page: nothing can be cast from it, and
    // it would not play here either. Back to the player that was playing.
    if (castOffered && !(result.castOrigin && result.publicBase)) {
      castOffer = 'none';
      leaveCast();
      return true;
    }
    // A switch is silent: the viewer sees the picture pause, not a notice about which file plays now.
    if (!replacing)
      swapped = swapNotice(
        pick?.filename,
        result,
        (name) => releases.find((r) => r.filename === name)?.label ?? name,
      );
    if (!releases.length) {
      void listReleases({ imdb, season, episode, scout: scout.install }, undefined, route, {
        videoCodecs: request.videoCodecs,
        playable: can,
      }).then((list) => {
        releases = list ?? [];
      });
    }
    return true;
  }

  /**
   * Move the playing session to another release that plays copied, from the second it is at (`switchPolicy`): for a
   * decoder that can't go on, narrowing what this browser claims; for a link that can't carry this one, one that fits
   * the rate it is really getting. Never a transcode, and the release playing now keeps playing until the other has
   * started — or for good, where none will do. True when it moved.
   */
  async function switchAway(reason: 'decode' | 'delivery', rate?: number): Promise<boolean> {
    const current = session;
    if (!current || switching) return false;
    switching = true;
    try {
      if (reason === 'decode') degraded = true;
      const at = video?.currentTime ?? remoteTime;
      const total = length();
      if (total && at >= 1) startAt = { seconds: at, fraction: at / total };
      const moved = await begin(
        undefined,
        switchAsk(reason, current.release.filename, excluded, rate),
        current,
      );
      if (moved) excluded = [...excluded, current.release.filename];
      else startAt = null;
      return moved;
    } finally {
      switching = false;
    }
  }

  /**
   * Weigh the link as it is delivering against what the playing copy asks of it (`shouldSwitch`), and move early to
   * one it carries when even a viewer's wait wouldn't do. Past the early window, or with nothing that fits, it plays on.
   */
  function weighDelivery() {
    const current = session;
    const element = video;
    if (!current?.segments || !element || switching || deliveryGaveUp || castMode) return;
    // A connection that is down delivers nothing, and that is no verdict on what this release asks of it.
    if (link?.down) return;
    const total = length();
    const buffered = element.buffered;
    const reach = buffered.length ? buffered.end(buffered.length - 1) : element.currentTime;
    if (!hls)
      meter.reached(performance.now(), bytesBetween(current.segments, total, started ?? 0, reach));
    const live = meter.rate();
    if (!live) return;
    // What den-remux said it sends, scaled by the share of it that came for the fragments loaded so far.
    const demand = scaleDemand(current.segments, delivered);
    const wait = waitAt(demand, total, element.currentTime, reach, live.bitsPerSecond);
    const signal = { kind: 'delivery' as const, wait, measuredMs: live.spanMs };
    if (!shouldSwitch(signal, { playedSecs, shownFrame: played })) return;
    void switchAway('delivery', live.bitsPerSecond).then((moved) => {
      // Nothing fits the link as it is: this release plays on, and the viewer is told why it pauses.
      if (!moved && session === current) {
        deliveryGaveUp = true;
        struggling = true;
      }
    });
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
    startAt = total && lostAt >= 1 ? { seconds: lostAt, fraction: lostAt / total } : null;
    watcher?.stop();
    watcher = undefined;
    hls?.destroy();
    hls = undefined;
    endSession(current);
    session = null;
    void begin({ filename: current.release.filename });
  }

  async function letIn(event: SubmitEvent) {
    event.preventDefault();
    const ok = await login(key.trim(), undefined, route);
    badKey = ok === false;
    if (ok === null) failure = 'unreachable';
    if (!ok) return;
    key = '';
    void begin();
  }

  $effect(() => {
    const [current, element] = [session, video];
    if (!current || current.castOrigin || !element) return;
    // A browser that can't decode what it was sent doesn't always say so: Safari strikes out its play button and
    // fires nothing. Given no source it can use, or trying to play with no picture yet, after a while is that — a
    // while with nothing arriving, since a slow link shows no picture either but keeps delivering (`stuckWatch`).
    // The bytes hls.js has had: its finished fragments', and the one loading as far as it has come.
    let finished = 0;
    let loading: { loaded: number } | undefined;
    const arrived = () => finished + (loading?.loaded ?? 0);
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
        if (
          noSource ||
          (!element.paused && element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
        ) {
          void broke(
            element.error?.code ?? 0,
            `no picture after ${STUCK_MS / 1000} s with nothing arriving (readyState ${element.readyState}, networkState ${element.networkState})`,
            'other',
          );
        }
      },
      arrived,
    );
    // Bytes arriving: the element's own fetches (a native player's `progress`), and hls.js's fragments (below). Each
    // is also a moment to weigh the link as it is delivering against what this release asks of it.
    const arriving = () => {
      stuck.progress();
      weighDelivery();
    };
    element.addEventListener('progress', arriving);
    const cleanup = () => {
      stuck.stop();
      element.removeEventListener('progress', arriving);
    };
    element.addEventListener('loadeddata', cleanup, { once: true });
    element.addEventListener(
      'loadeddata',
      () => {
        if (session === current) played = true;
      },
      { once: true },
    );
    const reportUrl = reportUrlOf(current.playlist);
    const stopWatching = () => {
      cleanup();
      watcher?.stop();
      watcher = undefined;
      unsubscribe();
      clearInterval(watching);
      connection.dispose();
      if (link === connection) link = undefined;
      reconnecting = false;
    };
    if (nativeHls(element)) {
      element.src = current.playlist;
      watcher = watchPlayback({ video: element, reportUrl });
      return stopWatching;
    }
    void import('hls.js').then(({ default: Hls }) => {
      if (ended || session !== current) return;
      if (!Hls.isSupported()) {
        failure = 'unsupported';
        return;
      }
      hls = new Hls(hlsConfig(started, 'page', connection));
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
      watcher = watchPlayback({ video: element, hls: { instance: hls, Hls }, reportUrl });
      // A fatal media error is sometimes just a decoder that lost its place, which hls.js can reset the buffer and
      // carry on from. Try that once per session; a second one is a real refusal, and the session moves to a copy
      // this browser does decode (`switchAway`).
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_event, data) => {
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
          lose(element.currentTime);
          return;
        }
        void broke(
          0,
          `hls.js ${data.type} ${data.details}`,
          data.type === Hls.ErrorTypes.MEDIA_ERROR ? 'decode' : 'other',
        );
      });
      // hls.js has its subtitle tracks once the master is parsed, and would otherwise show the DEFAULT one.
      hls.on(Hls.Events.MANIFEST_PARSED, applySubtitles);
      hls.loadSource(current.playlist);
      hls.attachMedia(element);
    });
    return stopWatching;
  });

  // A start that needs a head start (`prebuffer`) waits for it, paused, rather than starting and then stalling — with a
  // countdown where that is more than a moment (`PrebufferHold`), gone the moment it plays.
  $effect(() => {
    const [current, element, held] = [session, video, hold];
    if (!current || current.castOrigin || !element || !held) return;
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

  function sendToCastFrame(): void {
    const current = session;
    const frame = castFrame?.contentWindow;
    if (!current?.castOrigin || !frame) return;
    const poster = title.posterPath
      ? `https://image.tmdb.org/t/p/w500${title.posterPath}`
      : undefined;
    frame.postMessage(
      {
        type: 'den-load',
        id: current.playlist,
        media: {
          url: current.playlist,
          lanUrl: current.lanPlaylist,
          speed: current.speed,
          measure: publicMaxBitrate === undefined,
          mode: castMode ? 'cast' : 'browser',
          title: title.title,
          subtitle: season !== undefined ? `S${season} · E${episode}` : undefined,
          image: poster,
          currentTime: started ?? resume.seconds ?? 0,
          subtitleLanguage: subtitleChoice,
          terminal: degraded || current.video?.transcoded === true || castProfile === 'legacy',
        },
      },
      current.castOrigin,
    );
  }

  function castMessage(event: MessageEvent<unknown>): void {
    const looking = lookFrame?.contentWindow;
    if (lookOrigin && looking && event.origin === lookOrigin && event.source === looking) {
      const message = event.data as { type?: string; available?: unknown };
      if (message.type === 'den-ready') looking.postMessage({ type: 'den-discover' }, lookOrigin);
      else if (message.type === 'den-cast-availability' && typeof message.available === 'boolean')
        look({ kind: 'availability', available: message.available });
      return;
    }
    const current = session;
    const frame = castFrame?.contentWindow;
    if (!current?.castOrigin || event.origin !== current.castOrigin || event.source !== frame)
      return;
    const message = event.data as {
      type?: string;
      id?: string;
      currentTime?: number;
      duration?: number;
      paused?: boolean;
      message?: string;
      state?: string;
      profile?: string;
      maxBitrate?: number;
      available?: boolean;
    };
    if (message.type === 'den-ready') {
      sendToCastFrame();
      return;
    }
    if (message.id !== current.playlist) return;
    if (message.type === 'den-progress') {
      if (Number.isFinite(message.currentTime)) remoteTime = Math.max(0, message.currentTime ?? 0);
      if (Number.isFinite(message.duration)) remoteDuration = Math.max(0, message.duration ?? 0);
      // A length is known only once the playlist came through the media listener.
      if (remoteDuration > 0) played = true;
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
        if (restartAfterMeasure(current, publicMaxBitrate))
          restart(releaseAfterMeasure(chosenRelease));
        else frame?.postMessage({ type: 'den-continue', id: current.playlist }, current.castOrigin);
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
      if (askedMaxBitrate !== undefined) restart(releaseAfterMeasure(chosenRelease));
    } else if (message.type === 'den-cast-request') {
      const profile = message.profile ?? 'legacy';
      if (!castMode || castProfile !== profile) {
        const was = { castMode, castProfile };
        castProfile = profile;
        castMode = true;
        restart({ filename: current.release.filename }, () => ({ castMode, castProfile } = was));
      }
    } else if (message.type === 'den-cast' && message.state === 'playing') {
      casting = true;
    } else if (message.type === 'den-cast' && message.state === 'stopped') {
      casting = false;
      castMode = false;
      // Moved here to cast: casting over, the viewer is back in the player they left, where it had got to.
      if (castOffered) leaveCast();
      else restart({ filename: current.release.filename });
    } else if (message.type === 'den-ended') {
      casting = false;
      finished();
    } else if (message.type === 'den-error') {
      casting = false;
      // Keep the receiver only when one conservative H.264 retry remains; terminal attempts return local.
      if (degraded || current.video?.transcoded || castProfile === 'legacy') castMode = false;
      if (returnsFromCast(castOffered, castMode)) {
        // The cast page could not play what was moved to it — at home it may reach neither address. Not a verdict on
        // the release: the player that was playing it goes on from the same second.
        reportFailure(current, 0, message.message ?? 'cast player failed');
        leaveCast();
        return;
      }
      // A receiver that can't play what it was sent: a copy its conservative profile takes, as a decoder's refusal.
      void broke(0, message.message ?? 'cast player failed', 'decode');
    }
  }

  /** Whether this browser could cast at all; Google's SDK exists only in desktop and Android Chromium. */
  const castable = canOfferCast();

  /**
   * The Cast button for a plain in-page player. The cast page is loaded unseen beside the video, which plays on, to
   * look for a receiver (`look`); only once it sees one does playback move to the relay, whose sessions carry the
   * public address and the cast page, and Google's own button shows there.
   */
  async function offerCast() {
    if (!session || castOffer === 'looking') return;
    castOffer = 'looking';
    const origin = await fetchCastOrigin();
    if (castOffer !== 'looking' || ended) return;
    if (origin) lookOrigin = origin;
    else look({ kind: 'no-cast-page' });
  }

  /** A step of the look for a receiver; one seen moves playback to the relay at the second the video is at. */
  function look(event: CastLook) {
    const next = castLook(castOffer, event);
    castOffer = next.offer;
    if (next.offer !== 'looking') lookOrigin = undefined;
    if (!next.move || !session) return;
    castOffered = true;
    routeBeforeCast = route;
    route = RELAY;
    // Whatever the cast page reports is about this session alone: an earlier cast's position must not stand in for it.
    remoteTime = 0;
    restart({ filename: session.release.filename }, () => {
      castOffered = false;
      route = routeBeforeCast;
    });
  }

  /** Back to the route this page started on, at the second the cast page got to — or the one Cast was pressed at. */
  function leaveCast() {
    castOffered = false;
    casting = false;
    route = routeBeforeCast;
    castMode = false;
    if (session) restart({ filename: session.release.filename });
  }

  // The cast page reports what it finds once it has looked; silence past the discovery window is taken as none.
  $effect(() => {
    if (castOffer !== 'looking') return;
    const wait = setTimeout(() => look({ kind: 'deadline' }), CAST_DISCOVERY_MS);
    return () => clearTimeout(wait);
  });

  // A session moved to the cast page that shows nothing — no error either, as when neither of its addresses answers
  // and hls.js is still retrying — goes back to the player it left, rather than sitting at 00:00.
  $effect(() => {
    const current = session;
    if (!current?.castOrigin || casting) return;
    const wait = setTimeout(() => {
      if (session !== current || played || casting || !returnsFromCast(castOffered, castMode))
        return;
      reportFailure(current, 0, `nothing played in the cast page after ${CAST_PLAY_MS / 1000} s`);
      leaveCast();
    }, CAST_PLAY_MS);
    return () => clearTimeout(wait);
  });

  /** Receiver model profiles from Google's published codec matrix. The oldest profile is the default so a
   * first-generation stick gets H.264 High@4.1 and stereo AAC; newer models opt into the formats they add. */
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
   * session to another copy; anything else stops here.
   */
  async function broke(
    code = video?.error?.code ?? 0,
    message = video?.error?.message ?? '',
    kind: 'decode' | 'other' = code === 3 || code === 4 ? 'decode' : 'other',
  ) {
    if (!session || failure) return;
    const current = session;
    watcher?.spent();
    reportFailure(current, code, message);
    // Opened for the address this page reported, and nothing ever arrived: most likely that address was wrong (a
    // carrier NAT with an address per destination, or a middlebox answering the lookup). Asked again once without it.
    if (retryWithoutHint(current, played, noHint)) {
      noHint = true;
      restart({ filename: current.release.filename });
      return;
    }
    // A dead release looks exactly like this too — `MediaError 3`, and on the native path this page never
    // sees the segment responses that would say otherwise. Ask den-remux for the segment playback stalled
    // on before blaming the picture: converting a release whose bytes have stopped arriving cannot help,
    // and it spends the one GPU slot the box has (oxyc/den#43).
    // The signed public origin intentionally cannot be connected to by the d.<domain> page; asking it here
    // would be a CSP violation. The receiver's media error is enough to select the conservative Cast profile.
    if (!current.publicBase && (await sourceFailed(current, stalledAt()))) {
      if (session === current && !failure) failure = 'source';
      return;
    }
    // The session may have been replaced while that was asked.
    if (session !== current || failure) return;
    // It was copied because this browser said it could take it, and it couldn't: another release, copied, that it
    // does take, from the same second (`switchPolicy`). Never this one converted — a transcode is chosen before
    // playback or not at all — and with no such copy, playback stops here and says so.
    if (kind === 'decode' && (await switchAway('decode'))) return;
    if (session === current && !failure) failure = 'playback';
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
    const at = video?.currentTime ?? remoteTime;
    if (at > 0) progress.report(at, length(), slack);
  }

  function playing() {
    progress.playing();
    clearInterval(timer);
    timer = setInterval(() => report(), REPORT_MS);
  }

  function paused() {
    clearInterval(timer);
    report();
  }

  /** The end: count down to the next episode, when there is one. */
  function finished() {
    progress.complete(video?.currentTime ?? remoteTime);
    if (!onnext) return;
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
    if (hls) {
      hls.subtitleDisplay = choice !== null;
      hls.subtitleTrack =
        choice === null ? -1 : hls.subtitleTracks.findIndex((track) => track.lang === choice);
      return;
    }
    for (const track of Array.from(video?.textTracks ?? []))
      track.mode = choice !== null && track.language === choice ? 'showing' : 'disabled';
  }

  function sendSubtitleChoice() {
    const current = session;
    const frame = castFrame?.contentWindow;
    if (!current?.castOrigin || !frame) return;
    frame.postMessage(
      { type: 'den-subtitle', id: current.playlist, language: subtitleChoice },
      current.castOrigin,
    );
  }

  /** SkipDB's segments for what is playing, and the one under the playhead right now. */
  let segments = $state<SkipSegment[]>([]);
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
    const found = await fetchSkipSegments(imdb, {
      season,
      episode,
      durationSeconds: length(),
    });
    if (!ended) segments = found;
  }

  /**
   * Four times a second, which is what `timeupdate` gives: enough to offer a button the moment a segment starts
   * and to leave one within a second of it, and far finer than the progress report's minute.
   */
  function tick() {
    const at = video?.currentTime ?? remoteTime;
    // Playing time, for the early window a switch is judged in: a playing player's forward steps, not its seeks.
    if (video && !video.paused && !video.seeking && lastPosition !== undefined) {
      const step = at - lastPosition;
      if (step > 0 && step < 1) playedSecs += step;
    }
    lastPosition = at;
    weighDelivery();
    warmNext(at);
    if (!segments.length) return;
    active = activeAt(segments, at);
    if (!autoSkip || !active || !canAutoSkip(active) || skipped[active.kind]) return;
    skipActive();
  }

  /** Whether the next episode has already been warmed. Not `$state`: nothing renders it. */
  let warmedNext = false;

  /**
   * Ask den-remux what the next episode could play, shortly before this one ends.
   *
   * Nothing is kept from the answer. The point is that den-scout has scraped the indexers and cached the list
   * by the time the advance asks for it in earnest — the slow part of starting an episode — rather than the
   * viewer waiting through it after the countdown. Choosing a release is left to that session, deliberately.
   */
  function warmNext(at: number) {
    if (warmedNext || !imdb || !onnext) return;
    const to = nextEpisode;
    if (!to || !shouldWarmNext(at, length())) return;
    warmedNext = true;
    void listReleases(
      { imdb, season: to.season, episode: to.episode, scout: scout.install },
      undefined,
      route,
    );
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

  /** Ask the cast page's own player, or the receiver it is casting to, to move to `time`. */
  function seekCastFrame(time: number): boolean {
    const current = session;
    const frame = castFrame?.contentWindow;
    if (!current?.castOrigin || !frame) return false;
    frame.postMessage({ type: 'den-seek', id: current.playlist, time }, current.castOrigin);
    return true;
  }

  /** Another audio track is another session of the same release (den-remux encodes one), from the same second. */
  function switchAudio(event: Event) {
    const n = Number((event.currentTarget as HTMLSelectElement).value);
    if (!session || n === session.audioTrack) return;
    restart({ audioTrack: n, filename: session.release.filename });
  }

  /** Another release of the title, from the same second — also after this one wouldn't play. */
  function switchRelease(event: Event) {
    const filename = (event.currentTarget as HTMLSelectElement).value;
    if (!session || filename === session.release.filename) return;
    // Another file gets this browser's full claims: what one release couldn't decode says nothing about
    // whether the next needs converting. The viewer's pick is theirs to make, switched-away-from or not.
    degraded = false;
    excluded = [];
    chosenRelease = filename;
    restart({ filename });
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
  function restart(pick: { audioTrack?: number; filename: string } | undefined, undo?: () => void) {
    const current = session;
    if (!current) return;
    report();
    const total = length();
    // Only a position worth carrying. A release refused before it drew a frame sits at zero, and taking that
    // forward would throw away where the library says this was left.
    const at = video?.currentTime ?? remoteTime;
    if (total && at >= 1) startAt = { seconds: at, fraction: at / total };
    if (played) {
      void begin(pick, { transcode: 'never' }, current).then((moved) => {
        if (moved || session !== current) return;
        startAt = null;
        undo?.();
        unchanged = 'That can’t be played here as it is, so this carries on as it was.';
      });
      return;
    }
    watcher?.stop();
    watcher = undefined;
    hls?.destroy();
    hls = undefined;
    endSession(current);
    session = null;
    void begin(pick);
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
    ended = true;
    clearInterval(timer);
    clearInterval(countdown);
    clearTimeout(retry);
    report(document.visibilityState === 'hidden' ? HIDDEN_SLACK_SECS : 0);
    watcher?.stop();
    watcher = undefined;
    hls?.destroy();
    // A receiver fetches independently. Closing the sender page must not turn its signed URL into a 410.
    if (session && !casting) endSession(session);
  }

  function close() {
    finish();
    onclose();
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
      ['play', () => void element.play()],
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
    // The page behind stays put: it would otherwise scroll under a player that covers it.
    const scrolls = [document.documentElement, document.body].map(
      (el) => [el, el.style.overflow] as const,
    );
    for (const [el] of scrolls) el.style.overflow = 'hidden';
    addEventListener('pagehide', finish);
    addEventListener('message', castMessage);
    return () => {
      for (const [el, overflow] of scrolls) el.style.overflow = overflow;
      removeEventListener('pagehide', finish);
      removeEventListener('message', castMessage);
      finish();
    };
  });
</script>

<svelte:window
  onkeydown={(event) => event.key === 'Escape' && !document.fullscreenElement && close()}
/>
<!-- A phone locked or a tab switched away may never come back: where it got to is written as it goes. -->
<svelte:document onvisibilitychange={() => document.visibilityState === 'hidden' && report()} />

<div class="player" role="dialog" aria-modal="true" aria-label={heading}>
  <header>
    <b>{heading}</b>
    {#if castable && session && !session.castOrigin && route !== RELAY}
      <button
        class="close cast"
        aria-label="Cast to a TV"
        title="Cast to a TV"
        disabled={castOffer === 'looking'}
        onclick={offerCast}
      >
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
          <path d="M2 12a9 9 0 0 1 8 8" />
          <path d="M2 16a5 5 0 0 1 4 4" />
          <path d="M2 20h.01" />
        </svg>
      </button>
    {/if}
    <button class="close" aria-label="Close" onclick={close}>
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m6 6 12 12M18 6 6 18" />
      </svg>
    </button>
  </header>
  <div class="stage">
    {#if failure === 'login'}
      <form onsubmit={letIn}>
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
        <button class="primary" disabled={!key.trim()}>Let this browser in</button>
        {#if badKey}<p class="error" role="alert">
            That isn’t one of the homelab’s browser keys.
          </p>{/if}
      </form>
    {:else if failure === 'busy' || failure === 'transcode'}
      <p class="note" role="status">{waits[failure]}</p>
    {:else if failure === 'lost'}
      <div class="lost" role="alert">
        <p>The connection was gone too long for this to carry on.</p>
        <button class="primary" onclick={resumeLost}>Resume from {clockTime(lostAt)}</button>
      </div>
    {:else if failure === 'ended'}
      <p class="error" role="alert">
        {guestGrants.endedText() ?? 'Your access ended'}. Ask whoever shared their library with you.
      </p>
    {:else if failure}
      <p class="error" role="alert">{messages[failure]}</p>
    {:else if !session}
      <p class="note">Finding a release this browser can play…</p>
    {:else}
      {#if session.castOrigin && session.publicBase}
        <!-- `local-network-access`: at home the cast page plays from den-remux's home-network address (`lanBase`),
             and Chrome lets a cross-origin frame reach a private address only when the page delegates it. -->
        <iframe
          bind:this={castFrame}
          title="Den Cast player"
          src={session.castOrigin}
          allow="autoplay; encrypted-media; fullscreen; presentation; local-network-access"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          onload={sendToCastFrame}
        ></iframe>
      {:else}
        <!-- den-remux supplies subtitle renditions through the HLS playlist. -->
        <video
          bind:this={video}
          controls
          autoplay
          playsinline
          onloadedmetadata={() => {
            seekToStart();
            void loadSegments();
            // The native path has its text tracks by now, and one of them is DEFAULT=YES.
            applySubtitles();
          }}
          onplay={playing}
          onpause={paused}
          ontimeupdate={tick}
          onended={finished}
          onerror={() => broke()}
        ></video>
        {#if reconnecting}
          <p class="countdown" role="status">Reconnecting…</p>
        {:else if startsIn}
          <p class="countdown" role="status">{startsIn}</p>
        {/if}
      {/if}
    {/if}
    {#if lookOrigin}
      <!-- The cast page, unseen, asked only whether a receiver is on the network: nothing is loaded into it. -->
      <iframe
        class="cast-look"
        bind:this={lookFrame}
        title="Looking for a Chromecast"
        aria-hidden="true"
        tabindex="-1"
        src={lookOrigin}
        sandbox="allow-scripts allow-same-origin allow-presentation"
      ></iframe>
    {/if}
  </div>
  {#if session}
    {@const parts = releaseParts(session)}
    {@const playingTrack = session.audioTracks[session.audioTrack] ?? session.audioTracks[0]}
    {@const downmix = downmixLabel(session)}
    <footer>
      {#if castOffer === 'looking'}
        <p class="swap" role="status"><span>Looking for a Chromecast…</span></p>
      {:else if castOffer === 'none'}
        <p class="swap" role="status">
          <span
            >No Chromecast found. Check that it is awake and on the same network as this device.</span
          >
          <button onclick={() => (castOffer = 'idle')}>Dismiss</button>
        </p>
      {/if}
      {#if swapped}
        <p class="swap" role="status">
          <span>{swapped}</span>
          <button onclick={() => (swapped = null)}>Dismiss</button>
        </p>
      {/if}
      {#if struggling}
        <p class="swap" role="status">
          <span
            >This connection is slower than this release needs, and no other fits it: it may pause
            now and then to catch up.</span
          >
          <button onclick={() => (struggling = false)}>Dismiss</button>
        </p>
      {/if}
      {#if unchanged}
        <p class="swap" role="status">
          <span>{unchanged}</span>
          <button onclick={() => (unchanged = null)}>Dismiss</button>
        </p>
      {/if}
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
      <div class="controls">
        {#if releases.length > 1}
          <!-- The select is the control, invisible over the whole pill: the browser opens its own menu — a sheet
               on a phone — and a screen reader reads a pop-up button, while the pill draws the icon and the short
               form of what is chosen. -->
          <div class="pick">
            {@render plates()}
            <span class="value" aria-hidden="true"
              >{session.release.label.split('•')[0]?.trim()}</span
            >
            {@render chevron()}
            <select aria-label="Release" value={session.release.filename} onchange={switchRelease}>
              <!-- Keyed by place: two releases can share a file name (the same encode under two infohashes). -->
              {#each releases as release, n (n)}
                <option value={release.filename} disabled={release.plays === 'no'}
                  >{optionLabel(release)}</option
                >
              {/each}
            </select>
          </div>
        {/if}
        {#if session.audioTracks.length > 1 && playingTrack}
          <div class="pick">
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
        <!-- den-remux sends opt-in renditions. Its own names are used verbatim: it knows what it found, and
             translating them here would invent detail. The same choice is forwarded to Cast. -->
        {#if session.subtitles?.length}
          <div class="pick">
            {@render globe()}
            <span class="value" aria-hidden="true"
              >{session.subtitles.find((one) => one.language === subtitleChoice)?.name ??
                'Off'}</span
            >
            {@render chevron()}
            <select
              aria-label="Subtitles"
              value={subtitleChoice ?? ''}
              onchange={(event) => {
                subtitleChoice = event.currentTarget.value || null;
                applySubtitles();
                sendSubtitleChoice();
              }}
            >
              <option value="">Off</option>
              {#each session.subtitles as track (track.language)}
                <option value={track.language}>{track.name}</option>
              {/each}
            </select>
          </div>
        {/if}
        <!-- Shown whatever the auto-skip setting says, and whatever SkipDB's confidence is: offering a skip
             costs a press to refuse, while acting on uncertain times costs the end of the episode. In
             fullscreen the browser's own controls cover this footer, so the button is a windowed affordance —
             auto-skip, being a seek, still works there. -->
        {#if active}
          <button class="primary" onclick={skipActive}>{SKIP_LABEL[active.kind]}</button>
        {/if}
        {#if onnext && next}
          {#if upNext !== null}
            <!-- The seconds are kept out of the name: one that changes every second is announced every second. -->
            <button
              class="primary"
              aria-label="Next: {next}"
              onclick={() => {
                stay();
                onnext();
              }}>Next: {next} <span aria-hidden="true">({upNext})</span></button
            >
            <button onclick={stay}>Stay</button>
          {:else}
            <button onclick={onnext}>Next: {next}</button>
          {/if}
        {/if}
      </div>
    </footer>
  {/if}
</div>

<!-- The Apple TV's own menus mark these with rectangle.stack and globe; the same two, drawn as lines. -->
{#snippet plates()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M8 4.5h8" />
    <path d="M6 7.5h12" />
    <rect x="4" y="10.5" width="16" height="9.5" rx="2.5" />
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
    grid-template-rows: auto minmax(0, 1fr) auto;
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

  button,
  .pick {
    flex: 0 0 auto;
    border: 1px solid rgb(255 255 255 / 0.4);
    border-radius: 999px;
    background: none;
    color: #fff;
    font: inherit;
  }

  /* A finger's worth, as every control here is. */
  button {
    min-height: 44px;
    padding: 8px 18px;
    cursor: pointer;
  }

  /* The title takes the width; closing is one glyph, as it is on the pickers. No ring around it: it sits beside
     the title rather than among the controls, and a bordered circle reads heavier than what it does. */
  .close {
    display: grid;
    place-items: center;
    width: 44px;
    padding: 0;
    border-color: transparent;
  }

  /* Beside Close, at the right: the two are one group, so the title keeps the width. */
  .cast {
    margin-left: auto;
  }

  /* Where the browser draws the open menu itself, on its own ground. */
  select option {
    color: initial;
  }

  .primary {
    border-color: var(--accent);
    background: var(--accent);
    font-weight: 600;
  }

  .primary:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .stage {
    position: relative;
    display: grid;
    min-height: 0;
    place-items: center;
  }

  video,
  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    border: 0;
  }

  /* Out of sight and out of the way of the video's controls, but rendered, so the Cast SDK in it runs as usual. */
  iframe.cast-look {
    inset: auto;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
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

  .note {
    max-width: 50ch;
    color: rgb(255 255 255 / 0.6);
    text-align: center;
  }

  /* Over the held picture, clear of the video's own controls along the bottom. */
  .countdown {
    position: relative;
    padding: 8px 16px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.6);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
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
  }

  /* Another release opened than the one picked: a line of its own above the footer's rows. */
  .swap {
    display: flex;
    flex: 1 1 100%;
    flex-wrap: wrap;
    gap: 6px 16px;
    align-items: center;
    justify-content: space-between;
    margin: 0;
    color: rgb(255 255 255 / 0.85);
    font-size: 14px;
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

  .pick {
    position: relative;
    display: flex;
    flex: 1 1 9rem;
    gap: 8px;
    align-items: center;
    min-width: 0;
    max-width: 18rem;
    min-height: 44px;
    padding: 0 14px;
  }

  /* One picker on a phone gets the row to itself, filling it: at 18rem it sat just short of the width, pushed
     against the right edge. Wider, the row is shared with the release line and 18rem is the right size again. */
  @media (width <= 40rem) {
    .controls > .pick:only-child {
      max-width: none;
    }
  }

  .pick .value {
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

  .close .icon {
    width: 22px;
    height: 22px;
    opacity: 0.85;
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
  button:focus-visible {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .error {
    max-width: 50ch;
    color: var(--danger);
    text-align: center;
  }

  .lost {
    display: grid;
    gap: 12px;
    justify-items: center;
    max-width: 50ch;
    text-align: center;
  }
</style>
