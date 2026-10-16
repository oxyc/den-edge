// Managed playback has one public failure boundary: Hearth may try a provider and Remux internally, but the page
// receives only a stable, redacted reason. It must explain that reason, leave the viewer a usable action, and wait
// for Retry-After rather than turning an unhealthy service into a request loop.
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

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
  const { browser, page } = await playerPage(async (route) => {
    askedAt.push(Date.now());
    if (askedAt.length === 1) {
      await route.fulfill({
        status: 502,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
        body: JSON.stringify({ error: 'source_unavailable', cause: 'torbox_rate_limited' }),
      });
    } else {
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
    await expect(page.getByRole('alert')).toHaveText(
      'Your TorBox API key was rejected. Update the key in Den Hearth settings, then try again.',
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  } finally {
    await browser.close();
  }
});

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
    await expect(page.getByRole('alert')).toHaveText(
      'TorBox returned a stream link from a CDN Den did not recognize. Den did not open it, and the home player could not prepare this release either. Try again.',
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByText('No release of this that plays in a browser')).toHaveCount(0);
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
    await expect(page.getByRole('alert')).toHaveText(
      'Your TorBox plan doesn’t support streaming links. Update the TorBox plan or remove TorBox from this Den Hearth install.',
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
