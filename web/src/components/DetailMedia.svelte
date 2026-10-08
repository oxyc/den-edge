<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import DetailIcon from './DetailIcon.svelte';
  import type Hls from 'hls.js';
  import { loadHls } from '../lib/hlsLoader';
  import {
    cropStyle,
    fetchSources,
    hlsURL,
    isPlaylist,
    nativeHls,
    nextRung,
    relaysMedia,
    trailerCandidates,
    watchDirect,
  } from '../lib/reel';
  import type { Crop, Source, Sources, TrailerCandidate } from '../lib/reel';
  import { memberXhrSetup } from '../lib/relayFetch';
  import type { MediaType } from '../lib/library';
  import type { Routes } from '../lib/routes';
  let {
    type,
    tmdbId,
    imdbId,
    backdrop,
    poster,
    reel,
    routes = {},
    active = true,
    autoplay = true,
    placeholder,
  }: {
    /** A picture already loaded that stands in, blurred, until the backdrop has loaded and faded in over it. */
    placeholder?: string;
    type: MediaType;
    /** What reel would rather be asked by, and what every title has — unlike the imdb id. */
    tmdbId?: number;
    imdbId?: string;
    backdrop?: string;
    poster?: string;
    reel?: string | null;
    routes?: Routes;
    active?: boolean;
    autoplay?: boolean;
  } = $props();
  let frame: HTMLDivElement;
  let video = $state<HTMLVideoElement>();
  const artwork = $derived(backdrop ?? poster ?? '');
  /**
   * Whether media may replace the artwork.
   *
   * Trailer discovery and Reel's small control requests run before this: they do not compete for the
   * backdrop's image bytes, and having their answer ready lets playback begin as soon as the picture has
   * painted. Only the actual video/HLS mount waits here, so the backdrop remains the detail page's first paint.
   */
  let canMountTrailer = $state(false);
  /**
   * The artwork that has loaded. Until it has, it is transparent rather than blank: it fades in over the
   * placeholder (or the page's background) instead of arriving in one cut. One already in the cache is shown as
   * it mounts (`loaded`), with no fade at all.
   */
  let painted = $state('');
  function loaded(node: HTMLImageElement) {
    if (node.complete && node.naturalWidth) painted = node.src;
  }
  $effect(() => {
    void artwork;
    canMountTrailer = !artwork;
  });
  let candidates = $state<TrailerCandidate[]>([]);
  let candidate = $state(0);
  const url = $derived(candidates[candidate]?.play ?? null);
  /** YouTube's own URL for this candidate, when one exists that this browser can play. */
  let upgraded = $state<string | null>(null);
  /**
   * Whether reel is being asked what to play and has not answered yet.
   *
   * Nothing is mounted while this is true, so the poster holds for the ~12 ms an audible `/sources`
   * takes. It replaced mounting a derived master first, which looked free and was not: reel's log showed
   * the element fetching TWO masters per hero open, both waiting on the same cold resolve — 2413 ms
   * spent on the one that was then discarded, beside 2289 ms on the one that was kept.
   */
  let asking = $state(false);
  /**
   * Whether this page may play a trailer's bytes through its own `/reel` relay: not on the public web name, which
   * is served through Cloudflare (`relaysMedia`). There reel's own file and its proxied master are never mounted,
   * and a trailer neither direct listener can serve is not shown.
   */
  const relay = relaysMedia();
  const source = $derived(!canMountTrailer || asking ? null : (upgraded ?? (relay ? url : null)));
  /**
   * What reel offered for this candidate, best first, and which of them is mounted.
   *
   * For an audible surface reel answers at once and resolves behind it, so this costs the hero a round
   * trip of about 12 ms rather than the 1.2-2.4 s a resolve takes — which is why the hero can ask at all.
   */
  let rungs = $state<Source[]>([]);
  let rung = $state(0);
  const mounted = $derived(canMountTrailer ? (rungs[rung] ?? null) : null);
  /** Where the picture sits inside the frame; null until reel has measured this trailer. */
  let heroCrop = $state<Crop | null>(null);
  /** Does this browser play HLS from a bare element? Asked once: it mounts a video element to find out. */
  const playsHls = nativeHls();
  /**
   * The master this page names itself when reel named nothing. A native one's segments come from Google; the one
   * hls.js plays carries every segment through the relay, so it is not named where the relay may not carry video.
   */
  const derivedMaster = (play: string) => (playsHls || relay ? hlsURL(play, playsHls) : null);
  /**
   * The source this page has to drive itself.
   *
   * A `<video>` given a master playlist it cannot parse simply errors, so where the browser has no
   * native HLS the element is handed nothing and hls.js feeds it instead.
   *
   * The test is on the PATH, and has to be: reel signs its play links, so an HLS URL ends
   * `…m3u8?s=<tag>`, and asking whether the whole URL ended in `.m3u8` was false for every one of
   * them. hls.js was never started, the element was handed a playlist to parse by itself, and each
   * browser errored its way back to reel's `/play` download — the very path this exists to avoid.
   */
  const managed = $derived(
    mounted
      ? // reel says what a URL is, because a minted `/m/<blob>` has no extension to read. Getting this
        // from the path is what the note below is about, and an opaque URL removes the path entirely.
        mounted.kind === 'hls' && !playsHls
        ? mounted.url
        : null
      : source && !playsHls && isPlaylist(source)
        ? source
        : null,
  );
  let visible = $state(true);
  let foreground = $state(!document.hidden);
  let reduced = $state(matchMedia('(prefers-reduced-motion: reduce)').matches);
  let mobile = $state(matchMedia('(max-width: 759px)').matches);
  let playing = $state(false);
  let ended = $state(false);
  let failed = $state(false);
  /**
   * Set when the viewer asks for the trailer full-screen, and the only thing that lets it make a
   * sound. Autoplay with audio cannot be granted — every browser refuses it without a gesture, and
   * hardware volume keys never reach the page — so the click that expands is the gesture.
   */
  let sound = $state(false);
  /**
   * Whether the viewer has touched this trailer yet. The native controls are held back until they
   * have: unasked-for chrome over a hero is a play button and a scrubber sitting on the artwork, and
   * on a paused element iOS draws that play button across the middle of the picture.
   */
  let touched = $state(false);
  /**
   * Whether this source has already been asked to load explicitly, after a refused `play()`.
   *
   * Once per source, because `load()` resets the element: asking twice would be a loop of reloads, each
   * refused for the same reason as the first.
   */
  let forced = $state(false);

  /**
   * A tap brings up the controls and turns the sound on together.
   *
   * The tap is a gesture, and a gesture is the only thing that may unmute anything — so the moment a
   * viewer reaches for this trailer is the one moment we are allowed to give them its audio.
   */
  function tap(event?: MouseEvent) {
    const player = video;
    if (!player) return;
    // A real press sets `pressed` on `pointerdown`, which proves this click began on THIS page rather than
    // being inherited from the one just left (see `press`). A keyboard activation (Enter/Space on a focused
    // button) never fires `pointerdown` at all, but the browser's synthetic click for one always carries
    // `detail: 0` — unlike any click a pointer makes — so it is let through on that alone.
    if (!pressed && event?.detail !== 0) return;
    pressed = false;
    // Once, and only once. After the first tap the native controls are showing, and they sit INSIDE the
    // element — so a tap on their pause button is also a click on the video, and calling play() here
    // again fought the viewer for it: the trailer stopped for a moment and started itself back up. The
    // first tap is the gesture that earns sound; from then on the element is theirs to drive.
    if (touched) return;
    touched = true;
    sound = true;
    quieten(player);
    void player.play().catch(() => {});
  }

  /**
   * Try again once the element actually has data.
   *
   * WebKit refuses `play()` on an element it does not yet consider ready, and the effect that starts
   * playback re-runs only when `allowed` or the source changes — so a refusal was final, and the
   * trailer sat on its poster until someone tapped it. It used to get away with this by accident: the
   * source arrived a second or two late, behind a `/direct` round trip, by which time the element was
   * ready. Asking again here is what that delay was doing.
   *
   * Never against the viewer: `touched` means they have the controls, and a paused trailer they paused
   * stays paused. Never an ended one either — `play()` on an ended element starts it again from the
   * beginning, and a trailer that has finished must stay finished. That one is a race, not a rarity: a
   * `canplay` arriving as the media ends sees `paused` already true and `ended` not yet read, so the
   * retry would resurrect the trailer a moment after it stopped.
   */
  function start() {
    const player = video;
    if (!player || touched || !allowed || !player.paused || player.ended) return;
    // Silence is re-asserted rather than assumed: this is the one path that starts playback without having
    // set it, so a stray unmute from anywhere else corrects itself at the next `canplay` instead of being
    // carried into the picture.
    quieten(player);
    void player.play().catch(() => {});
  }

  /**
   * Whether the press about to become a click actually began on this page.
   *
   * Opening a title from Home left its trailer playing out loud, and only that way round — the same page
   * loaded from its own URL is silent. So the press that asks for the page arrives at the page it asked for,
   * and lands on whatever this hero has just put under the pointer: below 760px that is the video itself,
   * which is a tap, and a tap is what grants audio.
   *
   * Provenance rather than timing. A click inherited from the page before has no `pointerdown` here, because
   * the press began on the billboard; a real tap has both. A window of milliseconds would have had to be
   * long enough to cover a navigation and short enough not to swallow somebody tapping quickly, and there is
   * no such number — a 400ms one ate the tap that brings up the controls.
   */
  let pressed = false;
  function press() {
    pressed = true;
    // Explicit intent need not wait for artwork; it is stronger than speculative sequencing.
    canMountTrailer = true;
  }

  /** WebKit's handle on a master's separate audio rendition. Absent in every other browser. */
  type Renditions = { length: number; [at: number]: { enabled: boolean } };

  function renditions(player: HTMLMediaElement): Renditions | undefined {
    return (player as HTMLMediaElement & { audioTracks?: Renditions }).audioTracks;
  }

  /**
   * Silence, said three ways, because on this element none of them is reliably enough on its own.
   *
   * Both directions go through here, so granting sound and taking it back are one decision read from
   * `sound` rather than two places that can disagree.
   *
   * What this does NOT do is stop a trailer Safari has already started playing for itself. Once
   * AVFoundation owns an item, its audio runs to the end of the clip past `muted`, `volume`, the audio
   * rendition, `pause()`, and destroying the element outright — all measured.
   */
  function quieten(player: HTMLMediaElement) {
    // This helper is also called from the effect that owns playback. Reading `sound` reactively there made
    // the first phone tap tear that effect down: tap() called play(), the cleanup immediately called pause(),
    // and the new run called play() again. AVFoundation can reopen a progressively served MP4 at zero during
    // that reconfiguration. Sound changes apply themselves synchronously through this helper, so they must not
    // also become reasons to restart the playback effect.
    const audible = untrack(() => sound);
    player.muted = !audible;
    player.volume = audible ? 1 : 0;
    // reel's masters carry `EXT-X-MEDIA:TYPE=AUDIO`, and Safari hands such a master to AVFoundation,
    // which plays that rendition through a path neither `muted` nor `volume` reaches: the element
    // reports silence while the sound comes out of it. Switching the rendition itself off is what stops
    // it. It does not exist until metadata has been read, so this runs again on `loadedmetadata`.
    const tracks = renditions(player);
    if (!tracks) return;
    for (let at = 0; at < tracks.length; at += 1) {
      const track = tracks[at];
      if (track) track.enabled = audible;
    }
  }

  /** Take over the screen, with the audio on. */
  async function expand(event?: MouseEvent) {
    const player = video;
    if (!player) return;
    // See `tap`: a keyboard activation never sets `pressed`, but is let through on `detail: 0` alone.
    if (!pressed && event?.detail !== 0) return;
    pressed = false;
    sound = true;
    // iOS treats volume as read-only, so unmuting is what carries the sound there; everywhere else both go.
    quieten(player);
    // Back to a quiet page on the way out: a trailer still talking after the viewer closed it is
    // the thing they would then have to go and silence.
    const stopListening = () => {
      document.removeEventListener('fullscreenchange', leave);
      player.removeEventListener('webkitendfullscreen', leave);
    };
    const leave = () => {
      if (document.fullscreenElement) return;
      sound = false;
      quieten(player);
      stopListening();
    };
    document.addEventListener('fullscreenchange', leave);
    // iOS's native video full screen does not participate in the document Fullscreen API.
    player.addEventListener('webkitendfullscreen', leave);
    try {
      if (player.requestFullscreen) await player.requestFullscreen();
      else {
        const enter = (player as HTMLVideoElement & { webkitEnterFullscreen?: () => void })
          .webkitEnterFullscreen;
        if (!enter) throw new Error('Full screen is not supported');
        enter.call(player);
      }
    } catch {
      // Refused, or unsupported: `leave` will never fire, so take it back off rather than leave a listener
      // behind for every press — and go back to silence. Keeping the sound on here was how a trailer began
      // talking on a page nobody had pressed anything on: this control is a 44px circle at the hero's top
      // right, drawn at opacity 0, which still takes clicks, and it sits exactly where the billboard's own
      // expand button is on the page you just left. A click aimed there that lands here after the
      // navigation has already spent its gesture gets full screen refused and, before this, audio anyway.
      sound = false;
      quieten(player);
      stopListening();
    }
    void player.play().catch(() => {});
  }

  /**
   * Sound where the viewer is: the other gesture allowed to unmute, and the one that does not take
   * over the screen.
   *
   * Full screen was the only way to hear a trailer, which is a large thing to ask of someone who just
   * wants to know what it sounds like. This is the same grant without the theatre, and it goes back
   * the other way too — a second press mutes it again, which full screen has no equivalent of short
   * of closing.
   *
   * Guarded by `pressed` for the same reason `expand` is: a click inherited from the page just left
   * would otherwise land here and start a trailer talking on a page nobody pressed anything on.
   */
  function toggleSound(event?: MouseEvent) {
    const player = video;
    if (!player) return;
    // See `tap`: a keyboard activation never sets `pressed`, but is let through on `detail: 0` alone.
    if (!pressed && event?.detail !== 0) return;
    pressed = false;
    sound = !sound;
    quieten(player);
    // Only on the way up. Muting should leave a playing trailer playing, and a paused one paused.
    if (sound) void player.play().catch(() => {});
  }
  const saving = Boolean(
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData,
  );
  const allowed = $derived(
    autoplay && active && visible && foreground && !reduced && !saving && !ended && !failed,
  );

  onMount(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const small = matchMedia('(max-width: 759px)');
    const preferences = () => {
      reduced = motion.matches;
      mobile = small.matches;
    };
    const visibility = () => {
      foreground = !document.hidden;
    };
    // The LAST entry, not the first. Leaving this page and coming back queues several, and taking
    // `entries[0]` took the oldest of them — a stale `false` from while the page was hidden — after
    // which nothing fires again, because the real intersection state never changes a second time.
    // That is the trailer that comes back from a swipe and sits there paused for good.
    const observer = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1]?.isIntersecting ?? false;
    });
    observer.observe(frame);
    motion.addEventListener('change', preferences);
    small.addEventListener('change', preferences);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', preferences);
      small.removeEventListener('change', preferences);
      document.removeEventListener('visibilitychange', visibility);
    };
  });

  /** Which trailer `candidates` were found for. Kept while the page is away, so coming back resumes it. */
  let foundFor = '';
  /**
   * The title/media-type `candidates` were last resolved for, once resolved — unlike `foundFor`, never
   * including the reel address. `SessionServices.configure()` publishes a restored `services.v1` reel
   * first and can replace it from live `/routes` discovery a moment later on a cold route (a hard
   * refresh); a detail trailer must keep one media identity for the page's lifetime, so that later
   * address alone must not look like a different trailer and tear down a source already producing
   * playback. Late discovery still reaches the next `trailerCandidates` call through `reel` itself —
   * this only holds the CURRENT one steady.
   */
  let lockedFor = '';
  // One that had finished plays again from the start when its page is come back to, as a page opened afresh does.
  $effect(() => {
    if (active) untrack(() => (ended = false));
  });
  $effect(() => {
    const [ids, base, mediaType, table] = [{ tmdb: tmdbId, imdb: imdbId }, reel, type, routes];
    const identity = JSON.stringify([ids, mediaType]);
    const key = JSON.stringify([ids, base, mediaType]);
    const wanted = autoplay && !reduced && !saving && !!(ids.tmdb || ids.imdb) && !!base;
    // The page left and come back to: the same trailer, already found. Found again, it started over from
    // the backdrop; kept, it carries on from where it was left (`keepFrame`).
    if (wanted && key === foundFor) return;
    // Only the reel address changed since the last resolve — the title and media type are the same one
    // this page already locked onto. Adopt the new key so a later address matching IT is also a no-op,
    // but touch nothing a video may already be playing from.
    if (wanted && identity === lockedFor) {
      foundFor = key;
      return;
    }
    foundFor = '';
    lockedFor = '';
    candidates = [];
    candidate = 0;
    playing = ended = failed = false;
    if (!wanted || !active || !base) return;
    const controller = new AbortController();
    // Resolve only. YouTube's adaptive stream carries sound and plays in every browser now — its
    // master directly where HLS is native, reel's proxy of it everywhere else — so a download and
    // remux would only warm a fallback that is not normally reached.
    void trailerCandidates(base, mediaType, ids, table, {
      signal: controller.signal,
      prewarm: 'direct',
      sourceAsk: {
        surface: 'audible',
        player: playsHls ? 'native' : 'hls.js',
      },
    }).then((found) => {
      if (controller.signal.aborted) return;
      candidates = found;
      foundFor = key;
      lockedFor = identity;
    });
    return () => controller.abort();
  });

  // YouTube's adaptive master through reel, which skips the download, the re-mux and the bytes back
  // out through the house — the whole of the wait before a cold trailer shows anything.
  //
  // The source follows from the play URL alone, so it is known on the first render. Asking `/direct`
  // first, only to learn whether a master exists, put a round trip and a yt-dlp resolve in front of
  // every trailer with the element held empty for both; the one case it ruled out — a trailer with
  // no master — is a 404 the error path already reads as "fall back to reel's own file".
  /**
   * What the effect below last acted on, so an unchanged trailer is not started over.
   *
   * It depends on `candidates`, and the effect that fills `candidates` assigns a NEW array every time
   * it runs — including the runs that follow `active` or `saving` changing, where the trailer has not
   * changed at all. Everything below then ran a second time: another `/sources` for the same title
   * (measured from a phone, the second a 0 ms cache hit), and a reset of `sound` under a viewer who
   * had already turned the sound on. Compared by value, so an equal array asks for nothing.
   */
  let asked: {
    play: string;
    sources: string;
    prepared: Sources | null | undefined;
    combined: boolean;
  } = { play: '', sources: '', prepared: undefined, combined: false };

  $effect(() => {
    const play = url;
    const discovered = candidates[candidate];
    const offered = discovered?.sources;
    const combined = !!discovered && Object.hasOwn(discovered, 'prepared');
    const prepared = discovered?.prepared;
    // Both read before the check, so both stay tracked whichever way it goes.
    if (
      play &&
      asked.play === play &&
      asked.sources === (offered ?? '') &&
      asked.prepared === prepared &&
      asked.combined === combined
    )
      return;
    asked = { play: play ?? '', sources: offered ?? '', prepared, combined };
    // Both belong to the trailer that is going away, and `sound` especially: left standing it makes
    // the next one autoplay UNMUTED, which every browser refuses — so `play()` is rejected and the
    // trailer sits there paused for no visible reason. Nothing resets it on its own, because a
    // refused full-screen never fires `fullscreenchange` and iOS never fires it at all.
    sound = false;
    touched = false;
    forced = false;
    rungs = [];
    rung = 0;
    heroCrop = null;
    if (!play) {
      upgraded = null;
      asking = false;
      return;
    }
    if (combined) {
      const top = prepared?.sources[0];
      asking = false;
      if (!top) {
        // `/prepare` completed but its primary ladder was unavailable. Do not immediately repeat
        // that provider work through a derived route or `/sources`; try an alternate Reel retained
        // in the same discovery answer, if there is one.
        upgraded = null;
        nextTrailer();
        return;
      }
      rungs = prepared.sources;
      rung = 0;
      heroCrop = prepared.crop ?? null;
      upgraded = top.url;
      return;
    }
    if (!offered) {
      // A reel older than 0.29.0 names no `/sources`, so the master is derived exactly as every version
      // before it did. This is the only remaining reason to derive one at all.
      upgraded = derivedMaster(play);
      asking = false;
      // Nothing this page may mount for this candidate: the next one, or no trailer.
      if (!upgraded && !relay) nextTrailer();
      return;
    }
    // Ask, and mount nothing until the answer comes. Deriving one to mount in the meantime cost a whole
    // second master fetch per open for about 12 ms of apparent gain, and on a cold resolve the two
    // queued behind the same resolve — so the wait was paid twice and half of it discarded.
    upgraded = null;
    asking = true;
    let live = true;
    void fetchSources(offered, {
      surface: 'audible',
      player: playsHls ? 'native' : 'hls.js',
    }).then((answer) => {
      // `sources` is reel's ordering, which for an audible surface puts the master first — the same
      // thing the line above derived, named by reel rather than by us. Adopting it is what makes the
      // fallback list, the crop and the minted accounting reel's to change without a release here.
      const top = answer?.sources[0];
      // `live` is the whole guard. The cleanup below clears it whenever this effect re-runs, which is
      // exactly when the candidate changed — so re-reading `candidates` here to check would add
      // nothing, and would read state belonging to an effect that no longer exists. Svelte warns
      // about that (`derived_inert`) precisely because such a read can see a stale value.
      if (!live) return;
      asking = false;
      if (!top) {
        // reel could not say what to play, so fall back to the master this page can name itself — the
        // same thing an answer without a sources URL gets.
        upgraded = derivedMaster(play);
        if (!upgraded && !relay) nextTrailer();
        return;
      }
      rungs = answer.sources;
      rung = 0;
      heroCrop = answer.crop ?? null;
      upgraded = top.url;
    });
    return () => {
      live = false;
    };
  });

  /** How often one fragment may be fetched before the engine is taken for looping (see `FRAG_LOADING` below). */
  const MOST_FRAGMENT_LOADS = 4;

  // MSE, where the browser will not play a playlist itself. hls.js takes the element rather than a
  // `src`, and is torn down with the source it was given — switching candidates must never leave two
  // engines feeding one element. A master that will not play steps on exactly as the element's own
  // `error` does (`nextTrailer`): reel's next offer, the next candidate, then reel's own file. Clearing
  // `upgraded` alone did nothing once reel had named the sources, because `managed` follows the rung.
  $effect(() => {
    const player = video;
    const master = managed;
    if (!player || !master) return;
    let live = true;
    let engine: Hls | undefined;
    const starting = loadHls().then(({ default: Hls }) => {
      if (!live) return;
      if (!Hls.isSupported()) {
        nextTrailer();
        return;
      }
      // The membership claim travels on hls.js's own requests too, or a paired household counts as a
      // guest against the relay's guest budget — on its own box, from its own sofa.
      // Open near the top of the ladder instead of climbing to it. hls.js assumes 500 kbps until it has
      // measured a fragment, and `testBandwidth` makes it start lower still to take that measurement —
      // which on a ninety-second trailer spends the part anyone actually watches at the bottom of a
      // ladder that reaches 1080p. The estimate is the home connection these are served over; ABR still
      // measures every fragment and drops if the line cannot hold it.
      engine = new Hls({
        enableWorker: false,
        xhrSetup: memberXhrSetup,
        abrEwmaDefaultEstimate: 5_000_000,
        testBandwidth: false,
      });
      engine.on(Hls.Events.ERROR, (_event, data) => {
        // Once per engine: a fatal error can be followed by another, and each would step again.
        if (!data.fatal || !live) return;
        live = false;
        nextTrailer();
      });
      // Open on the rung carrying the most bits, found by MEASURE rather than by position: an index is not
      // a ranking, because hls.js orders `levels` for itself whatever order the master lists them in.
      // Naming level 0 therefore asked for the WORST rung. ABR takes over once a fragment is in.
      engine.on(Hls.Events.MANIFEST_PARSED, () => {
        const levels = engine?.levels ?? [];
        const best = levels.reduce(
          (top, level, at) => (level.bitrate > (levels[top]?.bitrate ?? 0) ? at : top),
          0,
        );
        if (engine && levels.length > 1) engine.nextLevel = best;
        // The element is mounted with no `src`, so the effect that starts playback has already run and
        // found nothing to play. Autoplay begins here, once there is something to begin.
        if (allowed) void player.play().catch(() => {});
      });
      engine.once(Hls.Events.FRAG_BUFFERED, () => {
        // The opening rung was ours; every one after it is the line's to choose. `loadLevel`, not `nextLevel`:
        // that asks for a switch, which throws away what is buffered ahead and fetches it again. Asked on every
        // buffered fragment, it never ended: one segment fetched 830 times in four seconds.
        if (engine) engine.loadLevel = -1;
      });
      // And whatever else might start one: a fragment asked for again and again is a loop, not a recovery. hls.js
      // retrying a failed fragment asks a few times; past that the trailer is given up for the next one.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- A count the handler reads, never rendered.
      const loads = new Map<string, number>();
      engine.on(Hls.Events.FRAG_LOADING, (_event, { frag }) => {
        const key = `${frag.type}:${frag.level}:${frag.sn}`;
        const count = (loads.get(key) ?? 0) + 1;
        loads.set(key, count);
        if (count <= MOST_FRAGMENT_LOADS || !live) return;
        live = false;
        console.warn('hls.js kept fetching one fragment; the trailer is given up.', key);
        engine?.stopLoad();
        nextTrailer();
      });
      engine.loadSource(master);
      engine.attachMedia(player);
    });
    // hls.js is its own chunk, fetched only now; one that never comes is a master that will not play.
    void starting.catch((error: unknown) => {
      console.warn('hls.js could not be started for the trailer.', error);
      if (live) nextTrailer();
    });
    return () => {
      live = false;
      engine?.destroy();
    };
  });

  // A direct copy has DIRECT_FIRST_FRAME_MS to show a frame, or its relay copy plays instead. The element's
  // own `error` cannot be waited for: iOS's native player sits on an unreachable origin without raising one.
  $effect(() => {
    const player = video;
    if (!player || !allowed || upgraded !== mounted?.url) return;
    return watchDirect(player, mounted, nextTrailer);
  });

  // Reads `source`, not `url`, and that is the whole point: swapping `src` to the direct stream
  // pauses the element, so an effect watching only `url` never runs again and the trailer sits there
  // loaded and still. It has to re-run for whichever source is actually mounted.
  $effect(() => {
    const player = video;
    const canPlay = allowed && !!source;
    if (!player) return;
    if (!canPlay) {
      player.pause();
      playing = false;
      // Left for another page, or behind another tab: silent as well as still, so it comes back muted. And on a
      // page left behind, let go of what it was playing. Its `src` is already gone (it is set only on the active
      // page), but removing one unloads nothing, and WebKit's own player goes on sounding past `pause()` and
      // `muted` (`quieten`): a trailer opened on a phone was heard from the page Back went to. Its frame and its
      // place are kept first, so coming back shows that frame and carries on from there.
      if (!active || !foreground) {
        sound = false;
        quieten(player);
      }
      if (!active && !managed && !player.getAttribute('src') && player.currentSrc) {
        keepFrame(player);
        player.load();
      }
      return;
    }
    let live = true;
    quieten(player);
    void player
      .play()
      .then(() => {
        if (live) firstFrame();
      })
      .catch(() => {
        if (!live) return;
        playing = false;
        // A refusal is not always final, and on iOS it was being made final by accident. `preload` is
        // commonly ignored there, so an element whose `play()` was refused may never load at all — and
        // then `canplay` never fires, `start` never runs, and the trailer waits for a tap that may
        // never come. Asking for the data outright gives that retry something to happen on. Once per
        // source, and still through `play()`, so a test can intercept every attempt.
        if (!forced) {
          forced = true;
          player.load();
        }
      });
    return () => {
      live = false;
      player.pause();
    };
  });

  /**
   * The trailer's last frame and its place, kept as its page is left (`keepFrame`). Coming back, the frame stands
   * where the trailer was until the trailer itself is playing again, from that place: the element reloads, and
   * would otherwise show the backdrop in between and start the trailer over.
   */
  let held = $state<HTMLCanvasElement | null>(null);
  let resumeAt = 0;
  function keepFrame(player: HTMLVideoElement) {
    if (player.readyState < 2 || !player.videoWidth || player.ended) return;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / player.videoWidth);
    canvas.width = Math.round(player.videoWidth * scale);
    canvas.height = Math.round(player.videoHeight * scale);
    try {
      canvas.getContext('2d')?.drawImage(player, 0, 0, canvas.width, canvas.height);
    } catch {
      return; // A frame the page may not read leaves the backdrop to stand in, as before.
    }
    resumeAt = player.currentTime;
    held = canvas;
  }
  /** Draws the kept frame into the canvas on the page, which exists only while it is held. */
  function paint(node: HTMLCanvasElement, shot: HTMLCanvasElement) {
    node.width = shot.width;
    node.height = shot.height;
    node.getContext('2d')?.drawImage(shot, 0, 0);
  }

  function metadata() {
    if (!video) return;
    // A master's audio renditions do not exist until metadata has been read, so every earlier attempt at
    // silence had nothing to switch off. This is the first point at which it can be made to stick.
    quieten(video);
    if (resumeAt) {
      video.currentTime = resumeAt;
      resumeAt = 0;
    }
    // Keep the trailer at its actual beginning. Seeking during metadata loading can defer
    // WebKit's first painted frame while the audio/video clock is already advancing.
    if (video.videoHeight > video.videoWidth) nextTrailer();
  }
  function nextTrailer() {
    if (!url || !active) return;
    playing = false;
    // An explicit media error belongs to this source, not necessarily to its listener. In particular, Reel can
    // answer `progressive_unavailable` for one trailer while the next candidate on the same LAN listener is ready.
    // Listener reachability is handled by `watchDirect`'s no-frame deadline; do not blacklist the whole origin here.
    // reel offered these in order and guarantees them distinct, so a step always changes the source.
    // A step that did not would fire no load and no error, and the hero would stop here silently.
    const at = nextRung(rungs, rung);
    const next = rungs[at];
    if (next) {
      rung = at;
      upgraded = next.url;
      return;
    }
    // The next candidate's master before this one's file. A master refused because YouTube has removed
    // the video is refused for reel's copy too — and asking costs a whole yt-dlp round trip to be told
    // the same thing: two seconds for the master, nearly two more for the file, before a trailer that
    // does exist is even started. So walk the candidates first.
    if (candidate + 1 < candidates.length) {
      candidate += 1;
      return;
    }
    // Every master refused. reel's own file is what is left, and it is worth one ask: a video with no
    // HLS master at all still plays from it. Once, not once per candidate, and only where the relay may
    // carry it: on the public web name the trailer is given up instead.
    if (upgraded && relay) {
      upgraded = null;
      rungs = [];
      rung = 0;
      return;
    }
    failed = true;
  }
  function firstFrame() {
    const player = video;
    // An opacity-zero video may not receive compositor callbacks on mobile. Decoder readiness
    // and playback events can reveal it without waiting for the hidden layer to be painted.
    if (
      player &&
      allowed &&
      player.readyState >= 2 &&
      !player.seeking &&
      !player.paused &&
      !player.ended
    ) {
      playing = true;
      held = null;
    }
  }
</script>

<div class="media" bind:this={frame} data-detail-media>
  {#if backdrop || poster}
    {#if placeholder && backdrop}<img class="under" src={placeholder} alt="" />{/if}
    <img
      class="backdrop"
      class:portrait={!backdrop}
      class:shown={painted === (backdrop ?? poster)}
      src={backdrop ?? poster}
      fetchpriority={active && !!backdrop ? 'high' : 'auto'}
      alt=""
      use:loaded
      onload={(event) => {
        const image = event.currentTarget as HTMLImageElement;
        painted = image.src;
        canMountTrailer = true;
        // A one-off animation rather than a standing `transition`, which kept the picture on a layer of its
        // own for good and shifted the antialiasing of what is drawn beside it.
        if (!reduced && placeholder)
          image.animate([{ opacity: 0 }, {}], { duration: 150, easing: 'ease-out' });
      }}
      onerror={() => (canMountTrailer = true)}
    />
  {/if}
  <!-- Always mounted: a late URL or first frame cannot insert space into the detail layout.

       Playback is started by `play()` alone, never by an `autoplay` attribute. The attribute looked like
       the fix for iOS — Home's billboard carries one — but it starts the element without calling
       `play()`, which walks straight past the one test that proves a blocked autoplay leaves the poster
       up and the video paused. A behaviour no test can intercept is one that breaks quietly later. -->
  <video
    bind:this={video}
    src={active && !managed ? (source ?? undefined) : undefined}
    style={cropStyle(heroCrop) ?? undefined}
    class:playing
    class:present={!!source && !failed && !ended}
    poster={backdrop ?? poster}
    muted
    playsinline
    preload={allowed ? 'auto' : 'metadata'}
    controls={mobile && touched && !!source && !failed}
    onpointerdown={press}
    onclick={tap}
    aria-label="Trailer"
    aria-hidden={!mobile}
    onloadedmetadata={metadata}
    oncanplay={start}
    onloadeddata={firstFrame}
    onseeked={firstFrame}
    ontimeupdate={firstFrame}
    onplaying={firstFrame}
    onplay={() => {
      ended = false;
    }}
    onended={() => {
      ended = true;
      playing = false;
    }}
    onerror={nextTrailer}
    onloadstart={(event) => {
      quieten(event.currentTarget);
    }}
  ></video>
  {#if held}
    <canvas
      class="frame"
      use:paint={held}
      style={cropStyle(heroCrop) ?? undefined}
      aria-hidden="true"
    ></canvas>
  {/if}
  <div class="scrim" aria-hidden="true"></div>
  <!-- Glass, because this is a control over media — the one place the look is for. Keep Den's full-screen
       action on phones too: a narrow native control bar may omit its own, and before the first tap there is no
       native bar at all. Sound stays until `touched` on a phone — until then there is no keyboard route to the
       native controls that replace it (they only show up after the same gesture this grants), so a keyboard or
       switch user otherwise has no way to hear this at all. -->
  {#if !!source && !failed && !ended}
    <button
      class="control expand glass"
      onpointerdown={press}
      onclick={expand}
      aria-label="Play trailer full screen with sound"
    >
      <DetailIcon name="expand" />
    </button>
  {/if}
  {#if (!mobile || !touched) && !!source && !failed && !ended}
    <button
      class="control sound glass"
      onpointerdown={press}
      onclick={mobile ? tap : toggleSound}
      aria-label={sound ? 'Mute trailer' : 'Play trailer with sound'}
    >
      <DetailIcon name={sound ? 'sound' : 'mute'} />
    </button>
  {/if}
</div>

<style>
  .media {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    contain: layout;
  }

  .backdrop,
  .under,
  .frame,
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .backdrop:not(.shown) {
    opacity: 0;
  }

  /* The same blur `Detail` gives the placeholder while the page loads, so nothing changes size as one
     takes over from the other. */
  .portrait,
  .under {
    filter: blur(24px);
    transform: scale(1.12);
    opacity: 0.65;
  }

  /* Let the browser replace its own poster with the first decoded frame. An opacity-zero
     video can be held off by WebKit's visibility/autoplay heuristics, creating a hidden-player loop. */
  video {
    opacity: 0;
    pointer-events: none;
  }

  /* Black, but only once there is a picture for it to letterbox.
     Below 760px the video is `object-fit: contain`, so a wide trailer really does have bars inside the
     element, and this fill is what makes them opaque rather than showing the backdrop through them.
     Before the first frame it has nothing to letterbox and covers the backdrop instead: the element is
     made visible as soon as it has a SOURCE rather than a picture (see `present`), and Safari paints no
     poster for a video whose `src` has not arrived yet, so the fill was the only thing on screen — the
     hero was black until the trailer started, on macOS and iOS both. Waiting for `playing` keeps the
     bars and drops the cover. */
  video.playing {
    background: #000;
  }

  video.present {
    opacity: 1;
  }

  /* The trailer's last frame, framed as the trailer is, standing in for it until it plays again. */
  .frame {
    pointer-events: none;
    background: #000;
  }

  .scrim {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(to top, var(--bg), rgb(0 0 0 / 0.15) 75%),
      linear-gradient(to right, rgb(0 0 0 / 0.45), transparent 80%);
  }

  .control {
    position: absolute;
    right: var(--gutter);
    z-index: 1;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border-radius: 999px;
    color: var(--fg);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .expand {
    top: calc(var(--bar-space) + 12px);
  }

  /* Directly under the one above, a circle and a gap down. Sound is the lesser ask of the two, so it
     takes the lesser position. */
  .sound {
    top: calc(var(--bar-space) + 64px);
  }

  /* Before the hover rule, which is the more specific of the two: a control reached by keyboard has
     to show itself without waiting for a pointer that may never arrive. */
  .control:focus-visible {
    opacity: 1;
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  /* Otherwise they appear with the picture they belong to. */
  .media:hover .control {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .control {
      transition: none;
    }
  }

  @media (width <= 759px) {
    video,
    .frame {
      object-fit: contain;
    }

    video.present {
      pointer-events: auto;
    }

    .scrim {
      display: none;
    }

    /* Nothing to hover on a phone. Both explicit media actions must be visible before the native controls exist;
       after the first tap the sound action gives way to those controls and Expand keeps its place. */
    .control {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    video {
      transition: none;
    }
  }
</style>
