// Managed playback has one public failure boundary: Hearth may try a provider and Remux internally, but the page
// receives only a stable, redacted reason. It must explain that reason, leave the viewer a usable action, and wait
// for Retry-After rather than turning an unhealthy service into a request loop.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

async function playerPage(answer) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const context = await browser.newContext({
    userAgent: CHROME_MAC,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/route`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/den/config/subtitles/**`, (route) =>
    route.fulfill({ json: { subtitles: [] } }),
  );
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [] } }),
  );
  await page.route(`${ORIGIN}/den/config/playback`, answer);
  return { browser, page };
}

test('a final managed-source failure is redacted, actionable, and accessible', async () => {
  const requests = [];
  const consoleLines = [];
  const { browser, page } = await playerPage(async (route) => {
    requests.push(route.request());
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      // A compromised/upstream response must not reach either the page or its console.
      body: JSON.stringify({
        error: 'source_unavailable',
        cause: 'torbox_secret_account',
        detail: 'token=torbox-secret',
      }),
    });
  });
  try {
    page.on('console', (message) => consoleLines.push(message.text()));
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('available playback paths');
    await expect(alert).not.toContainText('torbox-secret');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].headers()['idempotency-key']).toBeTruthy();
    const body = requests[0].postDataJSON();
    expect(body).not.toHaveProperty('scout');
    expect(body).not.toHaveProperty('subtitles');
    expect(consoleLines.join('\n')).not.toContain('torbox-secret');
    expect(consoleLines.join('\n')).not.toContain('torbox_secret_account');
  } finally {
    await browser.close();
  }
});

test('a TorBox rate limit waits out Retry-After before a new operation', async () => {
  const askedAt = [];
  let releaseRetry;
  const retryGate = new Promise((resolve) => (releaseRetry = resolve));
  const { browser, page } = await playerPage(async (route) => {
    askedAt.push(Date.now());
    if (askedAt.length === 1) {
      await route.fulfill({
        status: 502,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
        body: JSON.stringify({ error: 'source_unavailable', cause: 'torbox_rate_limited' }),
      });
    } else {
      await retryGate;
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'source_unavailable' }),
      });
    }
  });
  try {
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);

    await expect(page.getByRole('status')).toContainText('waiting as requested');
    await expect(page.getByRole('status')).toHaveText('TorBox asked Den to wait—trying again…', {
      timeout: 5_000,
    });
    releaseRetry();
    await expect(page.getByRole('alert')).toContainText('available playback paths', {
      timeout: 5_000,
    });
    expect(askedAt).toHaveLength(2);
    expect(askedAt[1] - askedAt[0]).toBeGreaterThanOrEqual(900);
  } finally {
    await browser.close();
  }
});

test('a rejected TorBox key tells the guest exactly what to update', async () => {
  const { browser, page } = await playerPage((route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'source_unavailable',
        cause: 'torbox_authentication_failed',
      }),
    }),
  );
  try {
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect(page.getByRole('alert').locator('p')).toHaveText(
      'Your TorBox API key was rejected. Update the key in Den Hearth settings, then try again.',
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

// TorBox known down or slow (den-hearth's debrid health): said in the wait banner, and asked again only once the
// answer's Retry-After (Hearth's next recovery probe) has passed. That ask is a new operation with a new
// Idempotency-Key: Hearth keeps a refusal in its replay table, so the same key would only get the same refusal back
// after TorBox recovered.
for (const [name, body, degraded, message] of [
  [
    'down',
    { error: 'debrid_down', service: 'torbox', reason: 'timeout' },
    'debrid_down',
    'TorBox isn’t responding right now. Den will try again when it can…',
  ],
  [
    'slow',
    { error: 'status_unavailable', service: 'torbox' },
    'debrid_slow',
    'TorBox is slow right now, so this is taking longer to start. Trying again…',
  ],
]) {
  test(`a ${name} TorBox is said while Den waits out its Retry-After`, async () => {
    const askedAt = [];
    const keys = [];
    const { browser, page } = await playerPage((route) => {
      askedAt.push(Date.now());
      keys.push(route.request().headers()['idempotency-key']);
      return route.fulfill({
        status: 503,
        headers: {
          'content-type': 'application/json',
          'retry-after': '2',
          'x-den-degraded': degraded,
        },
        body: JSON.stringify(body),
      });
    });
    try {
      await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
      await expect(page.getByRole('status')).toHaveText(message);
      await expect.poll(() => askedAt.length, { timeout: 5_000 }).toBe(2);
      expect(askedAt[1] - askedAt[0]).toBeGreaterThanOrEqual(1_900);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBeTruthy();
      expect(keys[1]).not.toBe(keys[0]);
    } finally {
      await browser.close();
    }
  });
}

test('a no-release fallback still shows the specific managed-provider failure', async () => {
  const { browser, page } = await playerPage((route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'no_release',
        cause: 'torbox_unsafe_stream_url',
      }),
    }),
  );
  try {
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect(page.getByRole('alert').locator('p')).toHaveText(
      'TorBox returned a streaming link Den could not use, and the home player could not prepare this release either. Try again.',
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByText('No release of this that plays in a browser')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a no-release failure keeps source recovery available and can explicitly start TorBox without Den subtitles', async () => {
  const requests = [];
  const consoleLines = [];
  const routeReports = [];
  const { browser, page } = await playerPage((route) => {
    const request = route.request();
    requests.push(request);
    if (requests.length === 1)
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'no_release' }),
      });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        url: `${ORIGIN}/torbox/manual/master.m3u8`,
        release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
        subtitles: [
          {
            value: 'torbox:0',
            language: 'en',
            name: 'English',
            delivery: 'torbox',
            torboxTrack: 0,
          },
        ],
      }),
    });
  });
  try {
    page.on('console', (message) => consoleLines.push(message.text()));
    await page.route(`${ORIGIN}/playback/route`, async (route) => {
      routeReports.push(route.request().postDataJSON());
      await route.fulfill({ status: 204 });
    });
    await page.route(`${ORIGIN}/den/config/subtitles/**`, (route) =>
      route.fulfill({ json: { subtitles: [] } }),
    );
    await page.route(`${ORIGIN}/torbox/manual/**`, async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      const file = name === 'master.m3u8' ? 'media.m3u8' : name;
      await route.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    });
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);

    await expect(page.getByRole('alert')).toContainText('No release');
    const source = page.getByRole('button', { name: 'Choose playback source' });
    await expect(source).toBeVisible();
    await expect(page.getByTestId('playback-source')).toHaveText('Source');
    await source.click();
    await page.getByRole('menuitem', { name: 'Try TorBox without Den subtitles' }).click();

    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].postDataJSON()).toMatchObject({
      directOnly: true,
      subtitleLanguages: [],
    });
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');

    const subtitles = page.getByRole('button', { name: 'Subtitles: Off' });
    await expect(subtitles).toBeVisible();
    await subtitles.click();
    const menu = page.getByRole('menu', { name: 'Subtitles: Off' });
    await expect(menu).toContainText('Den subtitles were not requested for this direct stream.');
    await expect(menu.getByRole('menuitemradio', { name: 'English' })).toBeVisible();

    const logs = consoleLines.join('\n');
    expect(logs).toContain('"event":"viewer_selection"');
    expect(logs).toContain('"context":"no_session"');
    expect(logs).toContain('"event":"request"');
    expect(logs).toContain('"subtitleConstraint":"den_subtitles_disabled"');
    expect(logs).toContain('"event":"selected"');
    await expect.poll(() => routeReports.length).toBeGreaterThanOrEqual(5);
    expect(routeReports).toContainEqual(
      expect.objectContaining({
        event: 'failed',
        requestedSource: 'managed',
        failure: 'none',
      }),
    );
    expect(routeReports).toContainEqual(
      expect.objectContaining({
        event: 'selected',
        source: 'torbox',
        embeddedSubtitles: 'available',
      }),
    );
  } finally {
    await browser.close();
  }
});

test('a no-release failure can explicitly retry Den Remux', async () => {
  const requests = [];
  const { browser, page } = await playerPage((route) => {
    requests.push(route.request());
    if (requests.length === 1) return route.fulfill({ status: 404, json: { error: 'no_release' } });
    return route.fulfill({
      json: {
        url: '/manual-remux/master.m3u8',
        release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
        session: {
          id: 'manual-remux',
          duration: 60,
          audioTrack: 0,
          audioTracks: [],
          endUrl: '/manual-remux/end',
          heartbeatUrl: '/manual-remux/heartbeat',
          reportUrl: '/manual-remux/report',
        },
      },
    });
  });
  try {
    await page.route(`${ORIGIN}/manual-remux/**`, async (route) => {
      if (route.request().method() !== 'GET') return route.fulfill({ status: 204 });
      const name = new URL(route.request().url()).pathname.split('/').pop();
      const file = name === 'master.m3u8' ? 'media.m3u8' : name;
      await route.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    });
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    const source = page.getByRole('button', { name: 'Choose playback source' });
    await source.click();
    await page.getByRole('menuitem', { name: 'Try Den Remux' }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].postDataJSON()).toMatchObject({ directFailed: true });
    await expect(page.getByTestId('playback-source')).toHaveText('Den Remux');
  } finally {
    await browser.close();
  }
});

test('repeated explicit-source failures keep recovery available and restore Den subtitle constraints', async () => {
  const requests = [];
  const { browser, page } = await playerPage((route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 404, json: { error: 'no_release' } });
  });
  try {
    await page.goto(`${ORIGIN}/test/player.html?playback=managed&subtitleLanguage=en`);
    const source = page.getByRole('button', { name: 'Choose playback source' });
    await source.click();
    await page.getByRole('menuitem', { name: 'Try TorBox without Den subtitles' }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toMatchObject({ directOnly: true, subtitleLanguages: [] });
    await expect(source).toBeVisible();
    await source.click();
    await page.getByRole('menuitem', { name: 'Try Den Remux' }).click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2]).toMatchObject({ directFailed: true, subtitleLanguages: ['en'] });
    await expect(source).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('a retryable explicit TorBox attempt keeps Den subtitles disabled through the retry', async () => {
  const requests = [];
  const { browser, page } = await playerPage((route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status: 404, json: { error: 'no_release' } });
    if (requests.length === 2)
      return route.fulfill({
        status: 429,
        headers: { 'retry-after': '1' },
        json: { error: 'playback_unavailable', cause: 'torbox_rate_limited' },
      });
    return route.fulfill({
      json: {
        url: `${ORIGIN}/torbox/retried/master.m3u8`,
        release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
        subtitles: [
          {
            value: 'torbox:0',
            language: 'en',
            name: 'English',
            delivery: 'torbox',
            torboxTrack: 0,
          },
        ],
      },
    });
  });
  try {
    await page.route(`${ORIGIN}/torbox/retried/**`, async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      const file = name === 'master.m3u8' ? 'media.m3u8' : name;
      await route.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    });
    await page.goto(`${ORIGIN}/test/player.html?playback=managed&subtitleLanguage=en`);
    const source = page.getByRole('button', { name: 'Choose playback source' });
    await source.click();
    await page.getByRole('menuitem', { name: 'Try TorBox without Den subtitles' }).click();
    await expect.poll(() => requests.length).toBe(2);
    await expect.poll(() => requests.length, { timeout: 5_000 }).toBe(3);
    expect(requests[1]).toMatchObject({ directOnly: true, subtitleLanguages: [] });
    expect(requests[2]).toMatchObject({ directOnly: true, subtitleLanguages: [] });
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    await expect(page.getByRole('button', { name: 'Subtitles: Off' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('an excluded-list Den retry remains pinned to Den Remux', async () => {
  const requests = [];
  const { browser, page } = await playerPage((route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: requests.length === 1 ? 502 : 404,
      json: { error: requests.length === 1 ? 'source_unavailable' : 'no_release' },
    });
  });
  try {
    await page.addInitScript(() => {
      sessionStorage.setItem(
        'den.releases.movie:42::',
        JSON.stringify({ left: ['excluded-release.mkv'] }),
      );
    });
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    const source = page.getByRole('button', { name: 'Choose playback source' });
    await source.click();
    await page.getByRole('menuitem', { name: 'Try Den Remux' }).click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[1]).toMatchObject({
      directFailed: true,
      exclude: ['excluded-release.mkv'],
    });
    expect(requests[2].directFailed).toBe(true);
    expect(requests[2]).not.toHaveProperty('exclude');
  } finally {
    await browser.close();
  }
});

test('a forced TorBox media refresh keeps Den subtitles disabled', async () => {
  const requests = [];
  const { browser, page } = await playerPage((route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status: 404, json: { error: 'no_release' } });
    return route.fulfill({
      json: {
        url: `${ORIGIN}/torbox/${requests.length === 2 ? 'forced-fails' : 'forced-refreshed'}/master.m3u8`,
        release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
      },
    });
  });
  try {
    await page.route(`${ORIGIN}/torbox/forced-fails/**`, (route) => route.fulfill({ status: 404 }));
    await page.route(`${ORIGIN}/torbox/forced-refreshed/**`, async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      const file = name === 'master.m3u8' ? 'media.m3u8' : name;
      await route.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    });
    await page.goto(`${ORIGIN}/test/player.html?playback=managed&subtitleLanguage=en`);
    const source = page.getByRole('button', { name: 'Choose playback source' });
    await source.click();
    await page.getByRole('menuitem', { name: 'Try TorBox without Den subtitles' }).click();
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(3);
    expect(requests[1]).toMatchObject({ directOnly: true, subtitleLanguages: [] });
    expect(requests[2]).toMatchObject({ directOnly: true, subtitleLanguages: [] });
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
  } finally {
    await browser.close();
  }
});

test('a normal direct session with no tracks does not expose an empty subtitle menu', async () => {
  const { browser, page } = await playerPage((route) =>
    route.fulfill({
      json: {
        url: `${ORIGIN}/torbox/no-subtitles/master.m3u8`,
        release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
        subtitles: [],
      },
    }),
  );
  try {
    await page.route(`${ORIGIN}/torbox/no-subtitles/**`, async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      const file = name === 'master.m3u8' ? 'media.m3u8' : name;
      await route.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    });
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect(page.getByTestId('playback-source')).toHaveText('TorBox');
    await expect(page.getByRole('button', { name: 'Subtitles: Off' })).toHaveCount(0);
    const source = page.getByRole('button', { name: 'Playing from TorBox' });
    await source.click();
    await expect(page.getByRole('menu')).toContainText('Playing directly from TorBox');
    await expect(page.getByRole('menu')).not.toContainText('Den subtitles were not requested');
  } finally {
    await browser.close();
  }
});

test('a title with only TS and AVI releases says those are what the browser can’t play', async () => {
  const { browser, page } = await playerPage((route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'no_release', formats: ['.ts', '.avi'] }),
    }),
  );
  try {
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect(page.getByRole('alert').locator('p')).toHaveText(
      'The releases of this that are ready are TS and AVI files, which Den can’t play in a browser yet. Try again once another release is out, or play it on your TV.',
    );
  } finally {
    await browser.close();
  }
});

test('a TorBox plan without streaming support explains the required configuration change', async () => {
  const { browser, page } = await playerPage((route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'source_unavailable',
        cause: 'torbox_managed_streaming_unavailable_for_plan',
      }),
    }),
  );
  try {
    await page.goto(`${ORIGIN}/test/player.html?playback=managed`);
    await expect(page.getByRole('alert').locator('p')).toHaveText(
      'Your TorBox plan doesn’t support streaming links. Update the TorBox plan or remove TorBox from this Den Hearth install.',
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    const source = page.getByRole('button', { name: 'Choose playback source' });
    await source.click();
    await expect(
      page.getByRole('menuitem', { name: 'Try TorBox without Den subtitles' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('menuitem', { name: 'Try Den Remux' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  } finally {
    await browser.close();
  }
});
