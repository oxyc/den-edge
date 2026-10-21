// The media URL is deliberately not a second backend contract: when it fails, the player asks the same Hearth
// operation again. This covers the boundaries browsers make observable — ambiguous startup HTTP, hls.js media
// delivery, and WebKit's opaque native-HLS error — and pins how many logical operations each may create.
import { test, expect, chromium, webkit } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const release = { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 };

const direct = (name) => ({
  url: `${ORIGIN}/torbox/${name}/media.m3u8`,
  release,
});

const remux = {
  url: '/managed-remux/s/r1/sig/master.m3u8',
  release,
  session: {
    id: 'r1',
    duration: 60,
    audioTrack: 0,
    audioTracks: [],
    endUrl: '/managed-remux/s/r1/sig',
    heartbeatUrl: '/managed-remux/s/r1/sig/heartbeat',
    reportUrl: '/managed-remux/s/r1/sig/report',
  },
};

async function base(page) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/den/config/subtitles/**`, (route) =>
    route.fulfill({ json: { subtitles: [] } }),
  );
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [] } }),
  );
}

async function media(route, root = hls) {
  const request = route.request();
  if (request.method() === 'DELETE' || request.method() === 'POST')
    return route.fulfill({ status: 204 });
  const path = new URL(request.url()).pathname;
  const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
  return route.fulfill({
    contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
    body: await readFile(new URL(file, root)),
  });
}

test('an ambiguous startup transport failure replays one operation, not a second session', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage();
    await base(page);
    const requests = [];
    await page.route(`${ORIGIN}/den/config/playback`, async (route) => {
      requests.push(route.request());
      if (requests.length === 1) return route.abort('connectionreset');
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'source_unavailable' }),
      });
    });

    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect(page.getByRole('alert')).toContainText('available playback paths');
    expect(requests).toHaveLength(2);
    expect(requests[0].postData()).toBe(requests[1].postData());
    expect(requests[0].headers()['idempotency-key']).toBe(requests[1].headers()['idempotency-key']);
  } finally {
    await browser.close();
  }
});

test('checking a browser key replaces the login prompt with immediate progress', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage();
    await base(page);
    await page.route(`${ORIGIN}/den/config/playback`, (route) =>
      route.fulfill({ status: 401, json: { error: 'login_required' } }),
    );
    let releaseLogin;
    const loginGate = new Promise((resolve) => (releaseLogin = resolve));
    await page.route(`${ORIGIN}/direct/login`, async (route) => {
      await loginGate;
      return route.fulfill({ status: 401, json: { error: 'bad_key' } });
    });

    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await page.getByLabel('Browser key').fill('not-the-key');
    await page.getByRole('button', { name: 'Let this browser in' }).click();
    await expect(page.getByRole('status')).toHaveText('Checking key…');
    await expect(page.getByLabel('Browser key')).toHaveCount(0);
    releaseLogin();
    await expect(page.getByRole('alert')).toHaveText(
      'That isn’t one of the homelab’s browser keys.',
    );
    await expect(page.getByLabel('Browser key')).toBeVisible();
    await expect(page.getByText('Checking key…', { exact: true })).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a direct startup failure followed by a failed fallback tells the viewer and stops', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await base(page);
    const operations = [];
    const logs = [];
    let releaseFallback;
    const fallbackGate = new Promise((resolve) => (releaseFallback = resolve));
    page.on('console', (message) => logs.push(message.text()));
    await page.route(`${ORIGIN}/den/config/playback`, async (route) => {
      const request = route.request();
      operations.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
      if (operations.length === 1)
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(direct('startup-fails')),
        });
      await fallbackGate;
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'source_unavailable' }),
      });
    });
    await page.route(`${ORIGIN}/torbox/startup-fails/**`, (route) =>
      route.fulfill({ status: 404 }),
    );

    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect.poll(() => operations.length).toBe(2);
    await expect(page.getByRole('status')).toHaveText('TorBox did not start—trying Den Remux…');
    releaseFallback();
    await expect(page.getByRole('alert')).toContainText('available playback paths', {
      timeout: 15_000,
    });
    await expect(
      page.getByText('TorBox did not start—trying Den Remux…', { exact: true }),
    ).toHaveCount(0);
    expect(operations).toHaveLength(2);
    expect(operations[0].body).not.toHaveProperty('directFailed');
    expect(operations[1].body.directFailed).toBe(true);
    expect(new Set(operations.map((operation) => operation.key)).size).toBe(2);
    expect(logs.filter((line) => line.includes('Managed direct media failed'))).toHaveLength(1);
    expect(
      logs.filter((line) => line.includes('Managed direct media recovery failed')),
    ).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('playing session carries on');
  } finally {
    await browser.close();
  }
});

test('hls.js refreshes a failed direct stream once, then asks Hearth for Remux', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await base(page);
    const operations = [];
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => (releaseRefresh = resolve));
    await page.route(`${ORIGIN}/den/config/playback`, async (route) => {
      const request = route.request();
      operations.push({
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      });
      if (operations.length === 2) await refreshGate;
      const answer =
        operations.length === 1
          ? direct('initial')
          : operations.length === 2
            ? direct('refreshed')
            : remux;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(answer),
      });
    });

    let failedFragments = 0;
    await page.route(`${ORIGIN}/torbox/initial/**`, async (route) => {
      const file = new URL(route.request().url()).pathname.split('/').pop();
      if (file?.match(/^seg(?:[3-9]|[12]\d)\.m4s$/)) {
        failedFragments += 1;
        return route.fulfill({ status: 503, headers: { 'retry-after': '1' } });
      }
      return media(route);
    });
    let refreshedRequests = 0;
    await page.route(`${ORIGIN}/torbox/refreshed/**`, (route) => {
      refreshedRequests += 1;
      return route.fulfill({ status: 503, headers: { 'retry-after': '1' } });
    });
    await page.route(`${ORIGIN}/managed-remux/s/**`, (route) => media(route));

    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect.poll(() => operations.length, { timeout: 30_000 }).toBe(2);
    await expect(page.getByRole('status')).toHaveText('TorBox stopped—refreshing…');
    releaseRefresh();
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 5,
      undefined,
      { timeout: 30_000 },
    );

    expect(operations).toHaveLength(3);
    expect(operations[0].body).not.toHaveProperty('directFailed');
    expect(operations[1].body).not.toHaveProperty('directFailed');
    expect(operations[2].body.directFailed).toBe(true);
    expect(new Set(operations.map((operation) => operation.key)).size).toBe(3);
    expect(failedFragments).toBeGreaterThan(0);
    expect(failedFragments).toBeLessThanOrEqual(6);
    expect(refreshedRequests).toBeGreaterThan(0);
    expect(refreshedRequests).toBeLessThanOrEqual(6);
  } finally {
    await browser.close();
  }
});

test('a bad playback-address hint explains its one retry instead of repeating generic startup', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await base(page);
    await page.route(`${ORIGIN}/den/config/playback`, (route) =>
      route.fulfill({ status: 404, json: { error: 'not_found' } }),
    );
    const operations = [];
    let releaseRetry;
    const retryGate = new Promise((resolve) => (releaseRetry = resolve));
    await page.route(`${ORIGIN}/direct/session`, async (route) => {
      const request = route.request();
      operations.push(request.postDataJSON());
      if (operations.length === 2) await retryGate;
      const id = operations.length === 1 ? 'hinted' : 'without-hint';
      return route.fulfill({
        status: 201,
        json: {
          sid: id,
          playlist: `/direct/s/${id}/sig/master.m3u8`,
          duration: 60,
          release,
          video: { codec: 'h264', transcoded: false },
          audioTrack: 0,
          audioTracks: [],
          ...(id === 'hinted' ? { hinted: true } : {}),
        },
      });
    });
    await page.route(`${ORIGIN}/direct/s/hinted/**`, (route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({ status: 204 })
        : route.fulfill({ status: 404 }),
    );
    await page.route(`${ORIGIN}/direct/s/without-hint/**`, (route) => media(route));

    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect.poll(() => operations.length).toBe(2);
    await expect(page.getByRole('status')).toHaveText('Address failed—retrying without it…');
    await expect(page.getByText('Finding a release this browser can play…')).toHaveCount(0);
    expect(operations[1].noHint).toBe(true);
    releaseRetry();
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
      undefined,
      { timeout: 30_000 },
    );
    await expect(
      page.getByText('Address failed—retrying without it…', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('native Safari HLS failure falls back through Hearth without duplicating the Remux session', async () => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    await base(page);
    const operations = [];
    await page.route(`${ORIGIN}/den/config/playback`, (route) => {
      const request = route.request();
      operations.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(operations.length === 1 ? direct('native-fails') : remux),
      });
    });
    await page.route(`${ORIGIN}/torbox/native-fails/**`, (route) => route.fulfill({ status: 404 }));
    await page.route(`${ORIGIN}/managed-remux/s/**`, (route) => media(route));

    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
      undefined,
      { timeout: 30_000 },
    );

    expect(operations).toHaveLength(2);
    expect(operations[0].body).not.toHaveProperty('directFailed');
    expect(operations[1].body.directFailed).toBe(true);
    expect(new Set(operations.map((operation) => operation.key)).size).toBe(2);
  } finally {
    await browser.close();
  }
});
