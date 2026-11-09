// Playback through the real den-edge and the real den-hearth together (`stack.mjs`), driven through the real web app:
// the title's page, Play, the player as Library mounts it, the real cast page. Each repo's own suite fakes the other
// (den-edge's relay tests answer every finalization 204; Hearth's facade tests never see Edge's receipt headers), which
// is how every member play through the relay failed from 2026-10-29 with both suites green. Here only the outside edges
// are fakes: the indexers, TorBox's API and CDN, the download host, TMDB, and Google's Cast sender and receiver.
//
// Each case is a failure a viewer met, and fails on the code before its fix:
//   1. a member's Den Remux play is committed (den-edge #1114: the commit lacked the receipt, 409, playback_commit_failed)
//   2. a direct TorBox answer carrying a receipt stays TorBox's stream (den-edge #1114: read as a Remux session)
//  2b. that stream's receipt, closed part-way, carries where it got to and reaches den-edge (den-edge #1122: ended empty)
//   3. a TorBox stream paused past a heartbeat sends nothing but GETs to TorBox's CDN (405s on every pause)
//   4. a TorBox stream cast to a receiver plays there (Hearth: 409 torbox_item_not_found once the page's session ended)
//   5. a Den Remux stream cast to a receiver is handed off once, and the page's session ends at the public listener (den-edge #1124)
//   6. every flow: no console error, no failed request, and nothing but media GETs to an origin that is not Den's
// and the flows of the playback scenario matrix: an iPhone on Den Remux, resuming, and the next episode.
import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { castSdk, tmdb } from './fixtures.mjs';
import { showsSubtitles, subtitleChoice, subtitlesButton } from '../e2e/player-options.mjs';
import { CDN_HOST, EDGE, startStack } from './stack.mjs';

const MOVIE = 1002;
const SERIES = 2002;
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
/** Answers that are the service's designed "nothing here" for a fixture title, not failures. */
const DESIGNED_MISSES = [
  /^\/atlas\//, // no atlas in this stack
  /^\/ratings\/imdb\//,
  /^\/warnings\/imdb\//,
  /^\/skipdb\//,
  /^\/capabilities\/profiles$/, // profiles are off on this name
];

let stack;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

const opened = [];
test.afterEach(async () => {
  const info = test.info();
  if (info.status !== info.expectedStatus) {
    const keep = (name, lines) => writeFileSync(info.outputPath(name), lines.join('\n'));
    keep('den-edge.log', stack.edge.lines());
    keep('den-hearth.log', stack.hearth.lines);
    keep('fakes.log', [
      ...stack.log,
      ...stack.cdn.map((r) => `cdn ${r.method} ${r.path} origin=${r.origin}`),
      ...stack.exchanges.map(
        (r) => `${r.label} ${r.method} ${r.path} ${r.status} origin=${r.origin}`,
      ),
    ]);
    for (const [n, { context, trail }] of opened.entries()) {
      keep(`page-${n + 1}-trail.log`, trail);
      for (const [m, page] of context.pages().entries())
        await page
          .screenshot({ path: info.outputPath(`page-${n + 1}-${m + 1}.png`) })
          .catch(() => {});
      await context.tracing
        .stop({ path: info.outputPath(`page-${n + 1}-trace.zip`) })
        .catch(() => {});
    }
  }
  for (const { browser } of opened.splice(0)) await browser.close();
});

/**
 * A browser of the household: desktop Chrome away from home (TorBox's CDN name resolves to its fake), or an iPhone's
 * WebKit. TMDB and the Cast sender are answered here; every other request goes to den-edge, the cast page or the public
 * media listener (this run's fronts) or TorBox's CDN, and one for anywhere else is refused. `seen` keeps what the page
 * did for the invariants (`clean`). `refuse`: the Cast receiver refuses every LOAD.
 */
let deviceCount = 0;
async function household({ iphone = false, clock = false, refuse = false } = {}) {
  const browser = iphone
    ? await webkit.launch()
    : await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: [
          '--autoplay-policy=no-user-gesture-required',
          `--host-resolver-rules=MAP ${CDN_HOST} 127.0.0.1:${stack.cdnPort}`,
          '--ignore-certificate-errors',
          '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
        ],
      });
  const context = await browser.newContext(
    iphone
      ? { ...devices['iPhone 13'], ignoreHTTPSErrors: true }
      : { viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, userAgent: CHROME_MAC },
  );
  await context.tracing.start({ screenshots: true, snapshots: true });
  // TMDB is an outside edge, answered in the browser. A SharedWorker's requests are beyond a context's routes, so the
  // library service runs in the dedicated Worker the app falls back to where SharedWorker is missing.
  await context.addInitScript(() => {
    delete window.SharedWorker;
    // A beacon's body, kept for the receipt's evidence (a route sees no body of a Blob beacon).
    window.__beacons = [];
    const send = navigator.sendBeacon?.bind(navigator);
    if (send)
      navigator.sendBeacon = (url, data) => {
        const kept = { url: String(url), body: null };
        window.__beacons.push(kept);
        if (data instanceof Blob) data.text().then((text) => (kept.body = text));
        else if (typeof data === 'string') kept.body = data;
        return send(url, data);
      };
  });
  const trail = [];
  const seen = {
    requests: [],
    errors: [],
    failed: [],
    responses: [],
    foreign: [],
    cdnFrom: stack.cdn.length,
  };
  const t0 = Date.now();
  const note = (line) => trail.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`);
  // WebKit words a same-origin request cut off by a navigation as an access-control failure ("Fetch API cannot load
  // <den-edge URL> due to access control checks"). A request from den-edge's own page to den-edge cannot be a CORS
  // failure; one across origins (the public listener, the cast page) still counts.
  const cutOff = (text, from = EDGE) =>
    /due to access control checks/.test(text) &&
    text.includes(`${new URL(EDGE).host}/`) &&
    from.startsWith(EDGE);
  const watch = (page) => {
    page.on('console', (m) => {
      note(`console.${m.type()} ${m.text()}`);
      // A failed load is judged by its response below, where a designed 404 can be told from a fault.
      // WebKit's own native controls log their missing placard images ("Button failed to load, iconName = …").
      if (
        m.type() === 'error' &&
        !m.text().startsWith('Failed to load resource') &&
        !m.text().startsWith('Button failed to load, iconName') &&
        !cutOff(m.text(), m.location().url || page.url())
      )
        seen.errors.push(m.text());
    });
    page.on('pageerror', (e) => {
      note(`pageerror ${e.message}`);
      if (cutOff(e.message, page.url())) return;
      seen.errors.push(e.message);
    });
  };
  context.on('page', watch);
  context.on('request', (r) =>
    seen.requests.push({ method: r.method(), url: r.url(), body: r.postData(), at: Date.now() }),
  );
  context.on('response', (r) => {
    if (r.status() >= 400)
      seen.responses.push({ status: r.status(), method: r.request().method(), url: r.url() });
  });
  context.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    note(`failed ${r.method()} ${r.url()} ${why}`);
    // A request the page itself gave up on (a navigation, a long poll, a closed player) is not a failure.
    if (!/ERR_ABORTED|cancelled|Load request cancelled/i.test(why))
      seen.failed.push(`${r.method()} ${r.url()} ${why}`);
  });
  const ours = [EDGE, stack.publicBase, stack.castOrigin, `https://${CDN_HOST}`];
  const address = `198.51.100.${(deviceCount += 1)}`;
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    const { origin, pathname } = new URL(url);
    if (pathname.startsWith('/tmdb/3/') || origin === 'https://api.themoviedb.org')
      return route.fulfill({ json: tmdb(url) });
    if (origin === 'https://image.tmdb.org')
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      });
    if (origin === 'https://www.gstatic.com')
      return route.fulfill({ contentType: 'text/javascript', body: castSdk({ refuse }) });
    // Each browser is a device of its own at an address of its own (den-edge trusts this run's loopback as its proxy),
    // as a household's are: per-address budgets are then each device's, not one shared by every flow in the file.
    if (origin === EDGE)
      return route.continue({
        headers: { ...route.request().headers(), 'x-forwarded-for': address },
      });
    if (ours.includes(origin)) return route.continue();
    seen.foreign.push(`${route.request().method()} ${url}`);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  opened.push({ browser, context, trail });
  await stack.pair(page);
  return { page, seen };
}

/**
 * Case 6, for every flow: no console error, no failed request, no error answer but a designed miss, nothing asked of
 * any origin but this run's, every request to TorBox's CDN (the page's and Hearth's own probe) a GET, and nothing in
 * den-edge's log of a playback it could not finish.
 */
function clean(seen, { edgeFrom = 0 } = {}) {
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen.failed, 'failed requests').toEqual([]);
  expect(
    seen.responses.filter(
      (r) => !DESIGNED_MISSES.some((miss) => miss.test(new URL(r.url).pathname)),
    ),
    'error answers',
  ).toEqual([]);
  expect(seen.foreign, 'requests to an origin outside the stack').toEqual([]);
  expect(
    stack.cdn.slice(seen.cdnFrom).filter((r) => r.method !== 'GET'),
    'non-GET requests to TorBox’s CDN',
  ).toEqual([]);
  expect(
    stack.edge
      .lines()
      .slice(edgeFrom)
      .filter((l) =>
        /playback_(commit|abort)_failed|playback_commit_unknown|reason=addon_/.test(l),
      ),
    'den-edge playback errors',
  ).toEqual([]);
}

const video = (page) => page.locator('.player video');
const castFrame = (page) => page.frameLocator(`iframe[src^="${stack.castOrigin}"]`);
const castWindow = (page) =>
  page.frames().find((frame) => frame.url().startsWith(stack.castOrigin));

/** Past `seconds` and playing, in the page's own video or the cast frame's. */
async function playingPast(locator, seconds) {
  await expect
    .poll(() => locator.evaluate((v) => (v.paused ? -1 : v.currentTime)), { timeout: 60_000 })
    .toBeGreaterThan(seconds);
}

/**
 * The title's page, and Play (or Resume). Every flow plays a film of its own (the household is shared by the file, and
 * one played part-way offers Resume after it). Returns the title's path.
 */
let lastFilm = MOVIE;
let lastSeries = SERIES;
async function play(page, path = `/movie/${++lastFilm}`, name = 'Play') {
  await page.goto(`${EDGE}${path}`);
  const button = page.locator('[data-active="true"]').getByRole('link', { name, exact: true });
  await expect(button).toBeVisible({ timeout: 60_000 });
  await button.click();
  return path;
}

/** Over the picture, as a viewer moves before pressing the player's chrome, which auto-hides while they watch. */
async function revealControls(page) {
  const box = await page.locator('.player').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2);
}

async function closePlayer(page) {
  await revealControls(page);
  await page.getByRole('button', { name: 'Close' }).click();
}

/** The cast page's own button in the player's bar, pressed. */
async function pressCast(page) {
  const button = castFrame(page).locator('#cast');
  await expect(button).toBeVisible({ timeout: 30_000 });
  await revealControls(page);
  await button.click();
}

/** Every playback operation the page asked for (`POST /den/<config>/playback`), with its body, from `from` on. */
const playbacks = (seen, from = 0) =>
  seen.requests
    .slice(from)
    .filter((r) => r.method === 'POST' && /^\/den\/[^/]+\/playback$/.test(new URL(r.url).pathname));

/** The cast page's own button, pressed: Chrome's device list, where the stub's one receiver is chosen. */
async function castToReceiver(page) {
  await pressCast(page);
  await expect
    .poll(async () => (await castWindow(page)?.evaluate(() => window.loads.length)) ?? 0, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  return castWindow(page).evaluate(() => window.loads[0]);
}

/** A GET of `url` as the receiver makes it: from its own address, with no cookies, TorBox's CDN at its fake. */
async function receiverGet(url) {
  const target = new URL(url);
  if (target.hostname === CDN_HOST) {
    target.hostname = '127.0.0.1';
    target.port = String(stack.cdnPort);
  }
  const { request } = await import('node:https');
  const { request: plain } = await import('node:http');
  return new Promise((done, fail) => {
    const ask = (target.protocol === 'https:' ? request : plain)(
      target,
      { rejectUnauthorized: false, headers: { host: new URL(url).host } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => done({ status: res.statusCode, body }));
      },
    );
    ask.on('error', fail);
    ask.end();
  });
}

test.describe('the regressions of 2026-10-29 to 11-08', () => {
  test('1. a member on Den Remux away from home, with receipts: the operation is committed and plays in the cast frame', async () => {
    stack.torbox.managed = false;
    const edgeFrom = stack.edge.lines().length;
    const listenerFrom = stack.listener.length;
    const { page, seen } = await household();
    const logFrom = stack.edge.lines().length;
    await play(page);

    // den-edge's answer to the operation, with its relay's own lines: a commit Hearth refused is logged before it.
    const answered = await stack.edge.waitFor(/^POST \/den\/:config\/playback \d{3} /, logFrom);
    const relayed = stack.edge
      .lines()
      .slice(logFrom)
      .filter((l) => /^event=relay|^POST \/den\/:config\/playback/.test(l));
    expect(answered, relayed.join('\n')).toMatch(/ 200 /);
    await playingPast(castFrame(page).locator('video'), 2);
    await expect(page.getByTestId('playback-source')).toHaveText('Den Remux');
    expect(playbacks(seen)).toHaveLength(1);
    // den-edge opened the public listener, and Hearth took the commit of the operation it had answered.
    expect(stack.listener.length).toBeGreaterThan(listenerFrom);
    expect(
      stack.exchanges.some(
        (r) => r.label === 'public' && r.path.endsWith('.m4s') && r.status === 200,
      ),
    ).toBe(true);
    clean(seen, { edgeFrom });
  });

  test('2. a direct TorBox answer with a receipt: TorBox’s stream, its subtitles, Cast offered, and the receipt ended on close', async () => {
    stack.torbox.managed = true;
    const edgeFrom = stack.edge.lines().length;
    const { page, seen } = await household();
    await play(page);

    await playingPast(video(page), 2);
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    expect(playbacks(seen)).toHaveLength(1);
    // The dock's Audio & subtitles button: its page lists TorBox's subtitles under Subtitles.
    await showsSubtitles(page, 'Off');
    await revealControls(page);
    await subtitlesButton(page).click();
    await expect(subtitleChoice(page, /English/)).toBeVisible();
    await expect(subtitleChoice(page, /Suomi/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(castFrame(page).locator('#cast')).toBeVisible({ timeout: 30_000 });

    // Closing the player ends the receipt at Hearth, through den-edge, which logs Hearth's answer.
    const logFrom = stack.edge.lines().length;
    await closePlayer(page);
    await stack.edge.waitFor(/^(POST|DELETE) \/den 204 .*at=playback\/receipt/, logFrom);
    clean(seen, { edgeFrom });
  });

  test('2b. a TorBox stream closed part-way: its receipt carries where it got to, and Hearth delivers it to den-edge', async () => {
    stack.torbox.managed = true;
    const edgeFrom = stack.edge.lines().length;
    const { page, seen } = await household();
    await play(page);
    await playingPast(video(page), 3);
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');

    const ended = page.waitForRequest((r) =>
      /^\/den\/_receipt\/[\w-]{43}(\/end)?$/.test(new URL(r.url()).pathname),
    );
    await closePlayer(page);
    const end = await ended;
    // A beacon's Blob body is not visible to the request; the page's own record of it is (`household`).
    const handle = await page
      .waitForFunction(
        () => {
          const sent = window.__beacons.find((b) =>
            new URL(b.url, location.href).pathname.startsWith('/den/_receipt/'),
          );
          return sent && sent.body !== null ? { body: sent.body } : null;
        },
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => null);
    const beacon = handle ? await handle.jsonValue() : { body: end.postData() };
    expect(
      JSON.parse(beacon.body || 'null'),
      `the receipt end (${end.method()}) carries where it got to`,
    ).toMatchObject({
      positionSeconds: expect.any(Number),
      durationSeconds: expect.any(Number),
    });
    await expect
      .poll(
        () =>
          stack.exchanges.find(
            (r) => r.label === 'report' && r.path === '/playback/receipts/callback',
          )?.status,
        { message: 'Hearth delivered the sealed receipt to den-edge', timeout: 30_000 },
      )
      .toBe(200);
    clean(seen, { edgeFrom });
  });

  test('3. a TorBox stream paused past a heartbeat asks TorBox’s CDN for nothing but its playlist and segments', async () => {
    stack.torbox.managed = true;
    const edgeFrom = stack.edge.lines().length;
    const { page, seen } = await household({ clock: true });
    await play(page);
    await playingPast(video(page), 2);
    // TorBox's stream, from TorBox's CDN.
    await expect
      .poll(() => stack.cdn.slice(seen.cdnFrom).some((r) => r.path.endsWith('.m4s')))
      .toBe(true);

    const cdnFrom = stack.cdn.length;
    await video(page).evaluate((v) => v.pause());
    // One heartbeat interval (Player.svelte `HEARTBEAT_MS`) and more, on the page's clock.
    await page.clock.runFor(25_000);
    // A round trip after the timers ran: the browser's events for anything they sent have reached this side first.
    await page.evaluate(() => document.readyState);
    expect(stack.cdn.slice(cdnFrom).filter((r) => r.method !== 'GET')).toEqual([]);
    expect(
      seen.requests.filter((r) => new URL(r.url).hostname === CDN_HOST && r.method !== 'GET'),
      'the page asked TorBox’s CDN for something else',
    ).toEqual([]);
    clean(seen, { edgeFrom });
  });

  test('4. a TorBox stream cast to a receiver: the receiver is given a stream Hearth and TorBox serve', async () => {
    stack.torbox.managed = true;
    const edgeFrom = stack.edge.lines().length;
    const { page, seen } = await household();
    await play(page);
    await playingPast(video(page), 2);
    // TorBox's stream, from TorBox's CDN.
    await expect
      .poll(() => stack.cdn.slice(seen.cdnFrom).some((r) => r.path.endsWith('.m4s')))
      .toBe(true);

    const loaded = await castToReceiver(page);
    const answer = await receiverGet(loaded.url);
    expect(answer.status, `the receiver's GET of ${new URL(loaded.url).pathname}`).toBe(200);
    expect(answer.body).toMatch(/^#EXTM3U/);
    // Hearth answered every operation the handoff made.
    const refused = stack.edge
      .lines()
      .slice(edgeFrom)
      .filter((l) => /^POST \/den\/:config\/playback [45]\d\d/.test(l));
    expect(refused, 'playback operations refused during the handoff').toEqual([]);
    clean(seen, { edgeFrom });
  });

  test('5. a Den Remux stream cast to a receiver: one handoff, and the page’s session ended at the public listener', async () => {
    stack.torbox.managed = false;
    const edgeFrom = stack.edge.lines().length;
    const { page, seen } = await household();
    await play(page);
    await playingPast(castFrame(page).locator('video'), 2);
    await expect(page.getByTestId('playback-source')).toHaveText('Den Remux');

    const before = playbacks(seen).length;
    const endsFrom = stack.exchanges.length;
    const loaded = await castToReceiver(page);
    expect((await receiverGet(loaded.url)).status).toBe(200);
    // The session the page played is ended where it lives, on the public listener's own origin, and answered: a
    // `DELETE` of the session, or its `POST …/end` twin (which a receipt's end uses). Not the receiver's session.
    const receiverSession = new URL(loaded.url).pathname.replace(/\/master\.m3u8$/, '');
    await expect
      .poll(
        () =>
          stack.exchanges
            .slice(endsFrom)
            .find(
              (r) =>
                r.label === 'public' &&
                !r.path.startsWith(receiverSession) &&
                ((r.method === 'POST' && /\/end$/.test(r.path)) ||
                  (r.method === 'DELETE' && /^\/remux\/s\/[^/]+\/[^/]+$/.test(r.path))),
            )?.status,
        {
          message: 'the page’s session was ended at the public listener and answered',
          timeout: 30_000,
        },
      )
      .toBeLessThan(300);
    // One playback operation for the handoff, not a request → selected → replacement → request loop.
    await receiverPlayedFor(page, 3);
    expect(playbacks(seen).length - before).toBe(1);
    expect(await castWindow(page).evaluate(() => window.loads.length)).toBe(1);
    clean(seen, { edgeFrom });
  });
});

/** The receiver's own clock (the stub's, a quarter second at a time) `seconds` past where its first LOAD started. */
async function receiverPlayedFor(page, seconds) {
  await expect
    .poll(
      () =>
        castWindow(page).evaluate(
          () =>
            window.cast.framework.RemotePlayer().currentTime - (window.loads[0]?.currentTime ?? 0),
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(seconds);
}

/** What a playback operation asked, from its request body. */
const asked = (request) => JSON.parse(request.body ?? '{}');

// den-edge #1128 and #1131: a TorBox stream is cast as TorBox only (Den Remux only when the viewer picks it), and one
// hand-off is one ask of Hearth and one LOAD on the receiver, which only Stop casting ends.
test.describe('Cast of a TorBox stream', () => {
  test('with its built-in subtitle on: exactly one ask for the receiver and one LOAD, never Remux', async () => {
    stack.torbox.managed = true;
    const edgeFrom = stack.edge.lines().length;
    const publicFrom = stack.exchanges.length;
    const { page, seen } = await household();
    await play(page);
    await playingPast(video(page), 2);
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    // TorBox's English track, which TorBox burns into a stream of its own: a second ask, by index.
    await showsSubtitles(page, 'Off');
    await revealControls(page);
    await subtitlesButton(page).click();
    await subtitleChoice(page, /English/).click();
    await expect.poll(() => playbacks(seen).some((r) => asked(r).subtitleTrack === 0)).toBe(true);
    await playingPast(video(page), 1);

    const from = seen.requests.length;
    const loaded = await castToReceiver(page);
    expect(new URL(loaded.url).hostname).toBe(CDN_HOST);
    await receiverPlayedFor(page, 3);
    const cast = playbacks(seen, from).map(asked);
    expect(cast.filter((r) => r.player === 'cast')).toHaveLength(1);
    expect(cast.find((r) => r.player === 'cast')).toMatchObject({ subtitleTrack: 0 });
    expect(cast.some((r) => r.directFailed)).toBe(false);
    expect(await castWindow(page).evaluate(() => window.loads.length)).toBe(1);
    expect(await castWindow(page).evaluate(() => window.calls)).toEqual([]);
    // Nothing went through Den Remux: no Remux session's media crossed the public listener.
    expect(stack.exchanges.slice(publicFrom).filter((r) => r.path.startsWith('/remux/s/'))).toEqual(
      [],
    );
    clean(seen, { edgeFrom });
  });

  test('that the receiver refuses: one more TorBox try, the viewer told, playing here again, the session kept', async () => {
    stack.torbox.managed = true;
    const edgeFrom = stack.edge.lines().length;
    const publicFrom = stack.exchanges.length;
    const { page, seen } = await household({ refuse: true });
    await play(page);
    await playingPast(video(page), 2);
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');

    const from = seen.requests.length;
    await pressCast(page);
    await expect(
      page.getByText(
        'The Chromecast couldn’t play this TorBox release, so it’s playing here again.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await playingPast(video(page), 0);
    const after = playbacks(seen, from).map(asked);
    expect(after.filter((r) => r.player === 'cast')).toHaveLength(2);
    expect(after.some((r) => r.directFailed)).toBe(false);
    expect(await castWindow(page).evaluate(() => window.loads.length)).toBe(2);
    expect(await castWindow(page).evaluate(() => window.calls)).toEqual([]);
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    // No Den Remux session was made for it.
    expect(stack.exchanges.slice(publicFrom).filter((r) => r.path.startsWith('/remux/s/'))).toEqual(
      [],
    );
    clean(seen, { edgeFrom });
  });
});

test.describe('the playback scenario matrix', () => {
  test('an iPhone on Den Remux plays the session from the public listener, committed', async () => {
    test.skip(!(await webkit.executablePath()), 'WebKit is not installed');
    stack.torbox.managed = false;
    const edgeFrom = stack.edge.lines().length;
    const { page, seen } = await household({ iphone: true });
    await play(page);
    // Away from home, as every flow here: the session plays in the cast frame, on the public listener's origin.
    await playingPast(castFrame(page).locator('video'), 2);
    await expect(page.getByTestId('playback-source')).toHaveText('Den Remux');
    expect(
      stack.exchanges.some(
        (r) => r.label === 'public' && r.path.endsWith('master.m3u8') && r.status === 200,
      ),
    ).toBe(true);
    clean(seen, { edgeFrom });
  });

  test('resuming: a film closed part-way starts where it was left', async () => {
    stack.torbox.managed = true;
    const edgeFrom = stack.edge.lines().length;
    const { page, seen } = await household();
    const film = await play(page);
    // Past the player's "not worth resuming" start (Player.svelte `seekToStart`, more than 5 s).
    await playingPast(video(page), 12);
    const left = await video(page).evaluate((v) => v.currentTime);
    // Where it was left is in the library on den-edge before the title is opened again.
    const savedFrom = stack.edge.lines().length;
    await closePlayer(page);
    await stack.edge.waitFor(/^POST \/lib\/:id\/batch 200 /, savedFrom);

    const from = seen.requests.length;
    await play(page, film, 'Resume');
    // The left-off second is reached by the player going there (it starts there, or seeks there), not by playing from
    // the start through it. Judged by what the video played, never by the order of its events: a seek's first
    // `timeupdate`, already at the new second, can come before its `seeked`, and read that way a resume that started
    // right there was counted as played through (https://github.com/oxyc/den-edge/issues/1123).
    const resumed = await (
      await page.waitForFunction(
        (mark) => {
          const v = document.querySelector('.player video');
          if (!v) return null;
          v.__resumed ??= new Promise((done) => {
            let before = false;
            const played = () => {
              if (v.paused) return;
              if (v.currentTime >= mark) done(before ? 'played through' : 'jumped');
              else if (v.currentTime > 1) before = true;
            };
            v.addEventListener('timeupdate', played);
            played();
          });
          return v.__resumed;
        },
        left - 2,
        { timeout: 60_000 },
      )
    ).jsonValue();
    expect(resumed, `reaching ${left.toFixed(1)}s, where it was left`).toBe('jumped');
    // One operation, asking Hearth to start where it was left.
    const resumes = playbacks(seen, from);
    expect(resumes).toHaveLength(1);
    expect(
      Math.abs(asked(resumes[0]).startAt - left),
      'the operation’s startAt',
    ).toBeLessThanOrEqual(1);
    clean(seen, { edgeFrom });
  });

  test('the next episode: the end of S1E1 plays S1E2', async () => {
    stack.torbox.managed = true;
    const edgeFrom = stack.edge.lines().length;
    const { page, seen } = await household();
    await play(page, `/tv/${(lastSeries += 1)}`);
    await playingPast(video(page), 2);
    const from = seen.requests.length;
    await video(page).evaluate((v) => (v.currentTime = v.duration - 1));
    await expect.poll(() => playbacks(seen, from).length, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(JSON.parse(playbacks(seen, from)[0].body)).toMatchObject({ season: 1, episode: 2 });
    await playingPast(video(page), 1);
    clean(seen, { edgeFrom });
  });
});
