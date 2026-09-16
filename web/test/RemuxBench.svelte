<!-- What den-remux decided for a real release, and whether this browser played it.

     Not an e2e test: a measuring instrument, run by hand, whose output is numbers and a decision to paste
     into a ticket. Its sibling test/transport.html measures TRAILER transports against reel; this one is
     about den-remux and a full release, which is a different question with different failure modes.

     It exists because oxyc/den#39 and #40 both stalled on the same gap: everything we know about iOS and
     about AV1/Dolby Vision comes from codec lab's synthetic clips, which test the BROWSER's decoder. Nothing
     tested OUR output — den-remux ranking a real release, copying or converting it, and writing a master
     playlist. The two faults that cost the most time in #26 were both properties of our stream rather than of
     any codec (a slow init.mp4 that Apple's player abandons, and a PQ variant missing VIDEO-RANGE), and
     neither would have shown up in a codec test.

     Open it at http://127.0.0.1:5173/test/remux.html with `npm run dev`. The dev server proxies /remux to
     den-remux (vite.config.ts), so the session is real and so are the bytes. For Safari or an iPhone, open it
     in THAT browser — Playwright's WebKit has no AVFoundation and cannot answer the question this page exists
     for. `npm run dev -- --host` and the tailnet name reach a phone.

     Forcing a conversion: den-remux copies when it can, so the convert path needs asking for. Either cap the
     bitrate below the release's average, or tick "ask as a browser that refused" — which is the app's own
     `withoutRefused`, the thing it sends after a decode failure. -->
<script lang="ts">
  import {
    describeRelease,
    downmixLabel,
    endSession,
    linkLimit,
    listReleases,
    login,
    nativeHls,
    releaseParts,
    reportFailure,
    startSession,
    wantedLanguages,
    type Refused,
    type Release,
    type Session,
  } from '../src/lib/remux';
  import { playable, withoutRefused, type Playable } from '../src/lib/playable';

  /** `requestVideoFrameCallback`: the only honest "a frame is on screen" signal. Safari 15.4+, Chrome 83+. */
  type FrameVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: (now: number) => void) => number;
  };

  /** One variant of the master playlist, as den-remux wrote it. */
  type Variant = Record<string, string> & { uri?: string };

  /** Milliseconds from the moment the playlist was handed to a player. */
  type Timings = {
    session?: number;
    loadedmetadata?: number;
    canplay?: number;
    playing?: number;
    firstFrame?: number;
    error?: string;
  };

  const PLAYS_HLS = nativeHls(document.createElement('video'));
  /** A conversion starts on the GPU when the first segment is asked for; give it room before calling it dead. */
  const STUCK_MS = 60_000;

  // The scout install is the one thing this page cannot derive: den-remux needs it to find a release, and only
  // the library holds it. Kept here so a phone doesn't have to be handed a sealed config URL twice.
  const SCOUT_KEY = 'den.test.remux.scout';
  const SUBS_KEY = 'den.test.remux.subtitles';

  /**
   * The install as den-remux takes it, from whatever was pasted.
   *
   * The library holds an install WITH `/manifest.json` on the end, and that is what you get by copying the
   * URL out of Settings or off a configure page — but den-remux accepts an allowed origin and exactly one
   * base64url config segment, so the manifest file on the end is a second segment and the session is refused
   * with `bad_scout` before a request is made (its SSRF guard, `validate_scoped`). The app never meets this
   * because scout.ts strips the suffix on the way out of the library; this page is typed into by hand.
   */
  const MANIFEST = '/manifest.json';

  function installOf(url: string): string {
    const trimmed = url.trim();
    const bare = trimmed.endsWith(MANIFEST) ? trimmed.slice(0, -MANIFEST.length) : trimmed;
    // A trailing slash is a second segment to that guard as surely as the manifest is.
    return bare.replace(/\/+$/, '');
  }

  /**
   * Prefilled from `web/.env`, so a phone doesn't have to be handed a sealed config URL by hand — typing one
   * into iOS Safari is the single most tedious part of running this page on the device it exists for.
   *
   * Safe to keep a credential in: `.env` is gitignored, and `vite build` takes only `index.html` as its
   * input, so no test page — and no `VITE_` value one of them reads — is ever inlined into a shipped bundle.
   * The dev server is the only thing that serves this.
   *
   * localStorage wins where this browser has been used before, so editing the field still sticks.
   */
  const PREFILL_SCOUT = import.meta.env.VITE_REMUX_SCOUT ?? '';
  const PREFILL_SUBTITLES = import.meta.env.VITE_REMUX_SUBTITLES ?? '';

  let scout = $state(localStorage.getItem(SCOUT_KEY) ?? PREFILL_SCOUT);
  let subtitlesInstall = $state(localStorage.getItem(SUBS_KEY) ?? PREFILL_SUBTITLES);
  // The browser key is never persisted: den-remux trades it for a short-lived token that lives in remux.ts's
  // own memory, and a key in localStorage would outlive every reason to have typed it.
  let key = $state('');
  let signedIn = $state(false);
  let badKey = $state(false);

  let imdb = $state('tt0111161');
  let season = $state('');
  let episode = $state('');
  let subtitleLanguage = $state('');
  let startAt = $state('');
  let capBitrate = $state('');
  let refused = $state(false);

  let claimed = $state<Playable>();
  let measured = $state<number | undefined>();
  let releases = $state<Release[]>([]);
  let filename = $state('');
  let session = $state<Session>();
  let failure = $state<Refused>();
  let variants = $state<Variant[]>([]);
  let renditions = $state<Variant[]>([]);
  let playlistStart = $state<Variant>();
  let masterText = $state('');
  let timings = $state<Timings>({});
  let busy = $state('');
  let element = $state<HTMLVideoElement>();

  const title = $derived({
    imdb: imdb.trim(),
    season: season.trim() ? Number(season) : undefined,
    episode: episode.trim() ? Number(episode) : undefined,
    scout: installOf(scout),
  });

  /**
   * Ask the two questions that need no decision, the moment the page has what they need.
   *
   * Both are cheap and neither commits to anything: the capability probe is local, and `/releases` is a list
   * scout has already scraped. Making someone tap for them costs two interactions on the device where
   * interactions are most expensive, which is the device this page exists for.
   *
   * `asked` is a plain binding rather than state, so settling it cannot re-run this.
   */
  let asked = false;

  $effect(() => {
    if (asked || !title.imdb || !title.scout) return;
    asked = true;
    void probe();
    void list();
  });

  async function probe() {
    busy = 'asking this browser what it decodes';
    try {
      claimed = await playable();
    } finally {
      busy = '';
    }
  }

  async function letIn(event: SubmitEvent) {
    event.preventDefault();
    busy = 'signing in';
    try {
      const ok = await login(key.trim());
      badKey = ok === false;
      signedIn = ok === true;
      if (ok) key = '';
    } finally {
      busy = '';
    }
  }

  async function list() {
    if (!title.imdb || !title.scout) return;
    localStorage.setItem(SCOUT_KEY, installOf(scout));
    busy = 'asking den-remux what it could play';
    try {
      releases = (await listReleases(title)) ?? [];
    } finally {
      busy = '';
    }
  }

  /**
   * Start a session, asking exactly what the app's player asks (Player.svelte `begin`).
   *
   * The two knobs that differ are the point of the page: `refused` sends the reduced report the app sends
   * after a decode failure, and a bitrate cap stands in for a link too slow for the release. Either one is
   * what makes den-remux convert instead of copy.
   */
  async function begin(pick?: string) {
    if (!title.imdb || !title.scout) return;
    stop();
    localStorage.setItem(SCOUT_KEY, installOf(scout));
    localStorage.setItem(SUBS_KEY, subtitlesInstall.trim());
    failure = undefined;
    timings = {};
    busy = 'starting a session';
    const started = performance.now();
    try {
      const can = (claimed ??= await playable());
      const asks = refused ? withoutRefused(can) : can;
      const { audio, subtitleLanguages } = wantedLanguages(
        { subtitle: subtitleLanguage.trim() || undefined },
        undefined,
        navigator.languages,
      );
      // Measured once and kept by remux.ts for LINK_TTL_MS, exactly as the app does it; undefined at home,
      // where there is no upload link between den-remux and this browser to measure.
      measured = await linkLimit('/remux');
      const capped = capBitrate.trim() ? Number(capBitrate) * 1_000_000 : undefined;
      const at = startAt.trim() ? Number(startAt) : undefined;
      const result = await startSession({
        ...title,
        subtitles: subtitlesInstall.trim() ? [subtitlesInstall.trim()] : [],
        subtitleLanguages,
        audio,
        videoCodecs: asks.hevcMain || asks.hevcMain10 ? ['h264', 'hevc'] : ['h264'],
        playable: asks,
        startAt: at,
        maxBitrate: capped ?? measured,
        player: PLAYS_HLS ? 'native' : 'hls.js',
        ...(pick ? { filename: pick } : {}),
      });
      timings = { session: Math.round(performance.now() - started) };
      if ('failure' in result) {
        failure = result;
        return;
      }
      session = result;
      filename = result.release.filename;
      await readMaster(result);
      // Straight into playback: picking a release is already a statement that it should play. On iOS this
      // usually needs the Play button anyway -- the awaits above spend the tap's transient activation, so
      // WebKit refuses the start with no error worth showing -- but everywhere else it saves an interaction.
      play();
    } finally {
      busy = '';
    }
  }

  /**
   * The master playlist den-remux wrote, read as text.
   *
   * This is the half of #26 that only ever got checked by hand with curl. A PQ variant without VIDEO-RANGE, or
   * without FRAME-RATE, is dropped by Apple's player silently — the session looks fine and nothing plays — so
   * the attributes matter as much as whether a frame appeared, and both belong in the same report.
   */
  async function readMaster(current: Session) {
    try {
      const answer = await fetch(current.playlist);
      if (!answer.ok) return;
      masterText = await answer.text();
      const parsed = parseMaster(masterText);
      variants = parsed.variants;
      renditions = parsed.renditions;
      playlistStart = parsed.start;
    } catch {
      // The playlist not being readable from here is worth nothing more than an empty table.
    }
  }

  /** An HLS attribute list, respecting quoted values — CODECS and SUPPLEMENTAL-CODECS both hold commas. */
  function attributes(spec: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const match of spec.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g))
      out[match[1]!] = match[2] ?? match[3] ?? '';
    return out;
  }

  function parseMaster(text: string) {
    const lines = text.split('\n').map((line) => line.trim());
    const found: { variants: Variant[]; renditions: Variant[]; start?: Variant } = {
      variants: [],
      renditions: [],
    };
    lines.forEach((line, index) => {
      if (line.startsWith('#EXT-X-STREAM-INF:'))
        found.variants.push({
          ...attributes(line.slice('#EXT-X-STREAM-INF:'.length)),
          uri: lines[index + 1] ?? '',
        });
      else if (line.startsWith('#EXT-X-MEDIA:'))
        found.renditions.push(attributes(line.slice('#EXT-X-MEDIA:'.length)));
      else if (line.startsWith('#EXT-X-START:'))
        found.start = attributes(line.slice('#EXT-X-START:'.length));
    });
    return found;
  }

  let engine: { destroy: () => void } | undefined;
  let listeners: AbortController | undefined;

  /**
   * Play the session and time it.
   *
   * Listeners hang off an AbortController and are torn down with the run. On the transport bench the same
   * listeners once outlived their run on a reused element, and a later run's event filled an earlier run's
   * field against the earlier run's clock — silent, and it corrupted a whole iPhone sweep.
   */
  function play() {
    const video = element as FrameVideo | undefined;
    const current = session;
    if (!video || !current) return;
    stopPlayback();
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);
    listeners = new AbortController();
    const { signal } = listeners;
    const mark = (event: Event) => {
      const name = event.type as 'loadedmetadata' | 'canplay' | 'playing';
      timings = { ...timings, [name]: timings[name] ?? since() };
    };
    for (const event of ['loadedmetadata', 'canplay', 'playing'])
      video.addEventListener(event, mark, { signal });
    video.addEventListener(
      'error',
      () => {
        const code = video.error?.code ?? 0;
        const message = video.error?.message ?? 'media error';
        timings = { ...timings, error: `media ${code} ${message}` };
        // den-remux otherwise never learns the browser's verdict; it is the same beacon the app sends.
        reportFailure(current, code, message);
      },
      { signal },
    );
    video.requestVideoFrameCallback?.(() => {
      timings = { ...timings, firstFrame: since() };
    });
    // Safari doesn't always say it failed: it strikes out its play button and fires nothing at all.
    const stuck = setTimeout(() => {
      if (timings.firstFrame === undefined && timings.error === undefined)
        timings = { ...timings, error: `no picture after ${STUCK_MS / 1000} s` };
    }, STUCK_MS);
    signal.addEventListener('abort', () => clearTimeout(stuck));

    if (PLAYS_HLS) {
      video.src = current.playlist;
    } else {
      void import('hls.js').then(({ default: Hls }) => {
        if (!Hls.isSupported()) {
          timings = { ...timings, error: 'no MSE' };
          return;
        }
        // den-remux converts on the GPU as segments are asked for, so the first segment of a transcoded
        // release can take far longer than a copied one. hls.js gives up about ten seconds in and by default
        // never retries a timeout, which turns a slow conversion into a dead session — and into a bench that
        // reports a fault den-remux did not have. These are the app's own numbers (Player.svelte).
        const hls = new Hls({
          enableWorker: false,
          startPosition: startAt.trim() ? Number(startAt) : -1,
          fragLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: 30_000,
              maxLoadTimeMs: 120_000,
              timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
              errorRetry: { maxNumRetry: 2, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
            },
          },
        });
        engine = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) timings = { ...timings, error: `hls.js ${data.type} ${data.details}` };
        });
        hls.loadSource(current.playlist);
        hls.attachMedia(video);
      });
    }
    void video.play().catch(() => {
      // A refused autoplay is not a fault of the session; the events above still tell the story.
    });
  }

  function stopPlayback() {
    listeners?.abort();
    listeners = undefined;
    engine?.destroy();
    engine = undefined;
    const video = element;
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  /** End the session so it stops counting against den-remux's cap — it allows very few at once. */
  function stop() {
    stopPlayback();
    if (session) endSession(session);
    session = undefined;
    variants = [];
    renditions = [];
    playlistStart = undefined;
    masterText = '';
  }

  $effect(() => () => stop());

  const decision = $derived.by(() => {
    if (!session) return null;
    const { converted, release } = releaseParts(session);
    return {
      release,
      converted,
      copied: !converted,
      downmix: downmixLabel(session),
      described: describeRelease(session),
    };
  });

  const report = $derived(
    JSON.stringify(
      {
        ua: navigator.userAgent,
        nativeHls: PLAYS_HLS,
        at: new Date().toISOString(),
        title: { imdb: title.imdb, season: title.season, episode: title.episode },
        asked: {
          refusedReport: refused,
          capMbit: capBitrate.trim() ? Number(capBitrate) : undefined,
          measuredLimit: measured,
          startAt: startAt.trim() ? Number(startAt) : undefined,
          filename: filename || undefined,
        },
        playable: claimed,
        failure,
        session: session && {
          release: session.release,
          duration: session.duration,
          video: session.video,
          audioTrack: session.audioTrack,
          audioChannels: session.audioChannels,
          audioTracks: session.audioTracks,
          subtitles: session.subtitles,
        },
        decision,
        variants,
        renditions,
        start: playlistStart,
        timings,
      },
      null,
      1,
    ),
  );

  function reportName(): string {
    const ua = navigator.userAgent;
    const who = /iPhone|iPad/.test(ua)
      ? 'ios'
      : /Chrome/.test(ua)
        ? 'chrome'
        : /Safari/.test(ua)
          ? 'safari'
          : 'browser';
    return `remux-${who}-${new Date().toISOString().slice(0, 10)}.json`;
  }

  let saved = $state('');

  function download() {
    const href = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = reportName();
    link.click();
    saved = `Saved as ${link.download}.`;
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }

  /** The share sheet: built inside the click with nothing awaited first, or iOS refuses it. */
  function share() {
    const file = new File([report], reportName(), { type: 'application/json' });
    if (!navigator.canShare?.({ files: [file] })) {
      saved = 'This browser will not share a file — use Download.';
      return;
    }
    void navigator.share({ files: [file] }).catch(() => {
      // A dismissed sheet rejects, and that is a choice rather than a failure to report.
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      saved = 'Copied.';
    } catch {
      saved = 'Copying was refused — use Download or Share.';
    }
  }
</script>

<main>
  <h1>den-remux sessions</h1>
  <p>
    What den-remux decided for a real release — copied or converted, and what it wrote into the
    master playlist — and whether this browser put a picture on screen. The companion to
    <code>/test/transport.html</code>, which measures trailers against reel instead.
  </p>
  <p class="note">
    This browser: <b>{PLAYS_HLS ? 'plays HLS natively' : 'needs hls.js'}</b>. Real Safari and real
    iOS numbers only come from running this in those browsers.
  </p>

  <form onsubmit={letIn} class="row">
    <span>Browser key</span>
    <input type="password" bind:value={key} placeholder="only for an availability-only install" />
    <button type="submit" disabled={!key.trim()}>Sign in</button>
    {#if signedIn}<span class="ok">signed in</span>{/if}
    {#if badKey}<span class="bad">den-remux does not know that key</span>{/if}
  </form>

  <label class="row">
    <span>Scout install</span>
    <input bind:value={scout} placeholder="https://d-scout.oxy.fi/<config>" />
  </label>
  <label class="row">
    <span>Subtitles</span>
    <input bind:value={subtitlesInstall} placeholder="optional den-subtitles install" />
  </label>
  <div class="row">
    <span>Title</span>
    <input bind:value={imdb} placeholder="tt0111161" />
    <input class="small" bind:value={season} placeholder="S" />
    <input class="small" bind:value={episode} placeholder="E" />
    <button onclick={list} disabled={!!busy}>List releases</button>
  </div>
  <div class="row">
    <span>Resume at</span>
    <input class="small" bind:value={startAt} placeholder="s" />
    <span>Cap</span>
    <input class="small" bind:value={capBitrate} placeholder="Mbit" />
    <label class="check">
      <input type="checkbox" bind:checked={refused} /> ask as a browser that refused
    </label>
  </div>
  <p class="note">
    den-remux copies whenever it can, so a conversion has to be asked for: cap the bitrate below the
    release's average, or tick the box — that sends the reduced report the app sends after a decode
    failure (no HEVC, no HDR, no Dolby Vision, no E-AC-3). <b>Resume at</b> exercises
    <code>EXT-X-START</code>.
  </p>

  <div class="row">
    <button onclick={probe} disabled={!!busy}>What does this browser decode?</button>
    <button onclick={() => begin()} disabled={!!busy || !title.imdb || !title.scout}>
      {busy || 'Start a session'}
    </button>
    {#if session}<button onclick={stop}>End session</button>{/if}
  </div>

  {#if claimed}
    <table>
      <tbody>
        <tr><th>H.264</th><td>{claimed.h264} / High 10 {claimed.h264High10}</td></tr>
        <tr>
          <th>HEVC</th>
          <td>
            Main {claimed.hevcMain} · Main 10 {claimed.hevcMain10} · High tier
            {claimed.hevcHighTier}
          </td>
        </tr>
        <tr>
          <th>HDR</th>
          <td>
            PQ {claimed.hdr ? 'yes' : 'no'} · Dolby Vision p5
            {claimed.dolbyVision.p5 ? 'yes' : 'no'}, p8 {claimed.dolbyVision.p8 ? 'yes' : 'no'}
          </td>
        </tr>
        <tr>
          <th>AV1</th>
          <td>
            {claimed.av1} · 10-bit {claimed.av1Main10} · PQ {claimed.av1Hdr ? 'yes' : 'no'}
          </td>
        </tr>
        <tr>
          <th>VP9</th>
          <td>
            profile 0 {claimed.vp9 ? 'yes' : 'no'} · profile 2
            {claimed.vp9Profile2 ? 'yes' : 'no'}
          </td>
        </tr>
        <tr>
          <th>Audio</th>
          <td>
            Dolby Digital {claimed.eac3 ? 'yes' : 'no'} · FLAC {claimed.flac ? 'yes' : 'no'} · AAC 5.1
            {claimed.aacMultichannel ? 'yes' : 'no'} · AAC 7.1 {claimed.aac71 ? 'yes' : 'no'}
          </td>
        </tr>
      </tbody>
    </table>
  {/if}

  {#if releases.length}
    <fieldset>
      <legend>Releases den-remux would try, in its own order</legend>
      {#each releases as release (release.filename)}
        <div class="release">
          <button onclick={() => begin(release.filename)} disabled={!!busy}>Play this one</button>
          <!-- scout's label already ends with the size, and words it better than a round number does:
               it says 6.9 GB where rounding here said 7. The `size` field is in the report either way. -->
          <span>{release.label}</span>
        </div>
      {/each}
    </fieldset>
  {/if}

  {#if failure}
    <p class="bad">
      Refused: <b>{failure.failure}</b>
      {#if failure.retryMs}(asked for {Math.round(failure.retryMs / 1000)} s){/if}
      {#if failure.failure === 'login'}— sign in with the browser key above.{/if}
    </p>
  {/if}

  {#if session && decision}
    <h2>The decision</h2>
    <p class={decision.copied ? 'ok' : 'warn'}>
      <b>{decision.copied ? 'Copied as it is' : 'Converted here'}</b> — {decision.described}
      {#if decision.downmix}· audio folded to {decision.downmix}{/if}
    </p>
    <table>
      <tbody>
        <tr><th>File</th><td>{session.release.filename}</td></tr>
        <tr>
          <th>Video</th>
          <td>
            {session.video?.codec ?? 'not said'}
            {#if session.video?.width}· {session.video.width}×{session.video.height}{/if}
            {#if session.video?.tonemapped}· tone-mapped to SDR{/if}
          </td>
        </tr>
        <tr>
          <th>Audio</th>
          <td>
            track {session.audioTrack} of {session.audioTracks.length}
            {#if session.audioChannels}· {session.audioChannels} channels{/if}
            {#each session.audioTracks as audio, index (index)}
              {#if index === session.audioTrack}
                · {audio.language ?? '??'}
                {audio.name ?? ''}
                ({audio.channels}ch{audio.commentary ? ', commentary' : ''})
              {/if}
            {/each}
          </td>
        </tr>
        <tr><th>Duration</th><td>{Math.round(session.duration)} s</td></tr>
        <tr>
          <th>Asked</th>
          <td>
            {refused ? 'as a browser that refused' : 'as this browser'}
            {#if capBitrate.trim()}· capped at {capBitrate} Mbit{:else if measured}· link measured
              at {Math.round(measured / 1_000_000)} Mbit{:else}· no bitrate limit (at home){/if}
          </td>
        </tr>
      </tbody>
    </table>

    <h2>The master playlist</h2>
    {#if playlistStart}
      <p class="ok">
        <code>EXT-X-START</code> at {playlistStart['TIME-OFFSET']} s — the resume is in the playlist.
      </p>
    {:else if startAt.trim()}
      <p class="bad">
        A resume was asked for and the playlist carries no <code>EXT-X-START</code>.
      </p>
    {/if}
    <table>
      <thead>
        <tr>
          <th>codecs</th><th>supplemental</th><th>range</th><th>fps</th><th>resolution</th>
          <th>bandwidth</th>
        </tr>
      </thead>
      <tbody>
        {#each variants as variant, index (index)}
          <tr>
            <td>{variant.CODECS ?? ''}</td>
            <td>{variant['SUPPLEMENTAL-CODECS'] ?? ''}</td>
            <!-- A PQ variant without VIDEO-RANGE is dropped by Apple's player without a word: #26. -->
            <td class={variant['VIDEO-RANGE'] ? '' : 'bad'}
              >{variant['VIDEO-RANGE'] ?? 'missing'}</td
            >
            <td class={variant['FRAME-RATE'] ? '' : 'bad'}>{variant['FRAME-RATE'] ?? 'missing'}</td>
            <td>{variant.RESOLUTION ?? ''}</td>
            <td>
              {variant.BANDWIDTH ? Math.round(Number(variant.BANDWIDTH) / 1_000_000) + ' Mbit' : ''}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if renditions.length}
      <table>
        <thead>
          <tr><th>type</th><th>language</th><th>name</th><th>default</th></tr>
        </thead>
        <tbody>
          {#each renditions as rendition, index (index)}
            <tr>
              <td>{rendition.TYPE ?? ''}</td>
              <td>{rendition.LANGUAGE ?? ''}</td>
              <td>{rendition.NAME ?? ''}</td>
              <td>{rendition.DEFAULT ?? ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <h2>Does it play?</h2>
    <div class="row">
      <button onclick={play}>Play</button>
      <button onclick={stopPlayback}>Stop</button>
      <span class="note">{PLAYS_HLS ? 'the element itself' : 'hls.js'}</span>
    </div>
  {/if}

  <!-- In the document and visible: an offscreen or display:none video is exactly what WebKit declines to
       decode, which would measure the wrong thing. Not muted — the audio decision is half of what this
       page is about, and a muted element proves nothing about it. -->
  <video bind:this={element} controls playsinline preload="auto"></video>

  {#if timings.session !== undefined}
    <table>
      <tbody>
        <tr><th>session</th><td>{timings.session} ms</td></tr>
        <tr><th>metadata</th><td>{timings.loadedmetadata ?? ''}</td></tr>
        <tr><th>canplay</th><td>{timings.canplay ?? ''}</td></tr>
        <tr><th>playing</th><td>{timings.playing ?? ''}</td></tr>
        <tr><th>first frame</th><td>{timings.firstFrame ?? ''}</td></tr>
        {#if timings.error}<tr class="bad"><th>error</th><td>{timings.error}</td></tr>{/if}
      </tbody>
    </table>
    <p class="note">
      Playback times are milliseconds from the moment the playlist was handed to a player; the
      session time is den-remux's own, and on a converted release it includes writing
      <code>init.mp4</code> — which Apple's player abandons after about 3 s on iOS.
    </p>
    <div class="save">
      <button onclick={download}>Download</button>
      <button onclick={share}>Share</button>
      <button onclick={copy}>Copy</button>
      {#if saved}<span class="note">{saved}</span>{/if}
    </div>
    <textarea readonly rows="8">{report}</textarea>
  {/if}

  {#if masterText}
    <details>
      <summary>The master playlist as written</summary>
      <textarea readonly rows="10">{masterText}</textarea>
    </details>
  {/if}
</main>

<style>
  main {
    max-width: 900px;
    margin: auto;
    padding: 24px 16px 64px;
    font:
      14px system-ui,
      sans-serif;
    line-height: 1.5;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
  }

  .row span {
    flex: 0 0 90px;
  }

  .row input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 8px;
    font: inherit;
  }

  .row input.small {
    flex: 0 0 64px;
  }

  .check {
    display: block;
  }

  .release {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 4px 0;
  }

  .note {
    color: #555;
  }

  .bad {
    color: #b00;
  }

  .ok {
    color: #060;
  }

  .warn {
    color: #a60;
  }

  button {
    margin: 4px 0;
    padding: 8px 16px;
    font: inherit;
  }

  .save {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  video {
    display: block;
    width: 100%;
    max-width: 480px;
    margin: 12px 0;
    background: #000;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
  }

  th,
  td {
    padding: 4px 6px;
    border-bottom: 1px solid #ddd;
    text-align: left;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  textarea {
    width: 100%;
    font:
      12px ui-monospace,
      monospace;
  }
</style>
