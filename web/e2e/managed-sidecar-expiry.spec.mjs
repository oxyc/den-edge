// A managed sidecar is a short-lived Hearth capability. The player must own a VTT it fetched while that
// capability was live, and must ask Hearth for the advertised provider-track fallback when a later selection
// reaches the same capability after expiry. This exercises the real Player selection/restart path rather than
// only the plan parser or sidecar loader.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const token = 'e'.repeat(43);
const release = { label: 'Managed 1080p', filename: 'managed-sidecars.mkv', size: 1 };

async function media(route) {
  const name = new URL(route.request().url()).pathname.split('/').pop();
  const file = name === 'master.m3u8' ? 'media.m3u8' : name;
  await route.fulfill({
    headers: {
      'access-control-allow-origin': ORIGIN,
      'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
    },
    body: await readFile(new URL(file, hls)),
  });
}

test('managed sidecars survive cached re-selection and visibly replan to the fallback after expiry', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await guardNetwork(page);
    await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
    await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
    await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
    await page.route(`${ORIGIN}/playback/route`, (route) => route.fulfill({ status: 204 }));
    await page.route(`${ORIGIN}/playback/outcome`, (route) => route.fulfill({ status: 204 }));
    await page.route(`${ORIGIN}/den/config/subtitles/**`, (route) =>
      route.fulfill({ json: { subtitles: [] } }),
    );
    await page.route(`${ORIGIN}/direct/releases`, (route) =>
      route.fulfill({ json: { releases: [] } }),
    );
    await page.route(`${ORIGIN}/den/config/cast-subtitle`, (route) =>
      route.fulfill({ status: 503 }),
    );
    await page.route(`${ORIGIN}/torbox/**`, media);

    let expired = false;
    const sidecarRequests = [];
    await page.route(`${ORIGIN}/den/_sidecar/${token}/**`, (route) => {
      sidecarRequests.push(new URL(route.request().url()).pathname);
      return expired
        ? route.fulfill({ status: 404 })
        : route.fulfill({
            contentType: 'text/vtt; charset=utf-8',
            body: 'WEBVTT\n\n00:00:01.000 --> 00:00:08.000\nManaged caption\n',
          });
    });

    let releaseFallback;
    const fallbackGate = new Promise((resolve) => (releaseFallback = resolve));
    const operations = [];
    await page.route(`${ORIGIN}/den/config/playback`, async (route) => {
      const body = route.request().postDataJSON();
      operations.push(body);
      if (operations.length > 1) await fallbackGate;
      const fallback = body.subtitleTrack;
      return route.fulfill({
        headers: { 'cache-control': 'no-store' },
        json: {
          url: `${ORIGIN}/torbox/${fallback === undefined ? 'clean' : 'fallback'}/master.m3u8`,
          release,
          torboxSubtitle: fallback ?? null,
          subtitles:
            fallback === undefined
              ? [
                  {
                    value: 'torbox-sidecar:1',
                    language: 'en',
                    name: 'English',
                    source: 'built-in',
                    delivery: 'sidecar',
                    url: `/den/_sidecar/${token}/1.vtt`,
                    fallbackTorboxTrack: 1,
                  },
                  {
                    value: 'torbox-sidecar:2',
                    language: 'sv',
                    name: 'Swedish',
                    source: 'built-in',
                    delivery: 'sidecar',
                    url: `/den/_sidecar/${token}/2.vtt`,
                    fallbackTorboxTrack: 2,
                  },
                ]
              : [
                  {
                    value: `torbox:${fallback}`,
                    language: fallback === 2 ? 'sv' : 'en',
                    name: fallback === 2 ? 'Swedish' : 'English',
                    source: 'built-in',
                    delivery: 'torbox',
                    torboxTrack: fallback,
                  },
                ],
        },
      });
    });

    await page.goto(
      `${ORIGIN}/test/player.html?playback=${encodeURIComponent('/den/config/playback')}`,
    );
    // The fixture's English preference exercises the production auto-pick before expiry.
    await expect.poll(() => sidecarRequests).toEqual([`/den/_sidecar/${token}/1.vtt`]);
    await expect(page.getByRole('button', { name: 'Subtitles: English' })).toBeVisible();
    await expect(page.locator('video track')).toHaveAttribute('src', /^blob:/);

    await page.getByRole('button', { name: 'Subtitles: English' }).click();
    await page.getByRole('menuitemradio', { name: 'Off' }).click();
    expired = true;
    await page.getByRole('button', { name: 'Subtitles: Off' }).click();
    await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Subtitles: English' })).toBeVisible();
    expect(sidecarRequests).toEqual([`/den/_sidecar/${token}/1.vtt`]);

    await page.getByRole('button', { name: 'Subtitles: English' }).click();
    await page.getByRole('menuitemradio', { name: 'Off' }).click();
    await page.getByRole('button', { name: 'Subtitles: Off' }).click();
    await page.getByRole('menuitemradio', { name: 'Swedish', exact: true }).click();
    await expect.poll(() => operations.length).toBe(2);
    await expect(page.getByRole('status')).toHaveText('Switching subtitles…');
    expect(sidecarRequests).toEqual([
      `/den/_sidecar/${token}/1.vtt`,
      `/den/_sidecar/${token}/2.vtt`,
    ]);
    expect(operations[1]).toMatchObject({ directOnly: true, subtitleTrack: 2 });

    releaseFallback();
    await expect(page.getByRole('button', { name: 'Subtitles: Swedish' })).toBeVisible();
    await expect(page.getByText('Switching subtitles…', { exact: true })).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
