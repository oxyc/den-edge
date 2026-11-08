import { test, expect, chromium, webkit } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const session = {
  sid: 'bar1',
  playlist: '/direct/s/bar1/sig/master.m3u8',
  duration: 60,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  video: { codec: 'h264', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
};

async function mockPlayer(page) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${ORIGIN}/direct/session`, (route) =>
    route.fulfill({ status: 201, json: session }),
  );
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [] } }),
  );
  await page.route(`${ORIGIN}/direct/s/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE' || request.method() === 'POST')
      return route.fulfill({ status: 204 });
    const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
    return route.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
}

// A release found while the page is open is offered as the same status line the page's own release recovery shows.
const waiting = (page) =>
  page.evaluate(async () => (await import('/src/lib/release.ts')).releaseWaiting());

const launchers = {
  chromium: () =>
    chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--autoplay-policy=no-user-gesture-required'],
    }),
  webkit: () => webkit.launch(),
};

for (const [name, launch] of Object.entries(launchers)) {
  test.describe(name, () => {
    test('the update bar is slim, across the top edge, and dismissing it keeps it away', async () => {
      const browser = await launch();
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
        await guardNetwork(page);
        await page.goto(`${ORIGIN}/test/navigation-bar.html`);
        const nav = page.locator('.bar');
        await expect(nav).toBeVisible();
        const navTop = (await nav.boundingBox()).y;
        await waiting(page);

        const bar = page.getByRole('status').filter({ hasText: 'A new version of Den is ready.' });
        await expect(bar).toBeVisible();
        // The navigation bar moves down to sit below the update bar instead of being covered by it.
        await expect
          .poll(async () => (await nav.boundingBox()).y)
          .toBeGreaterThanOrEqual((await bar.boundingBox()).y + (await bar.boundingBox()).height);
        await expect(bar).not.toContainText('—');
        const box = await bar.boundingBox();
        expect(box.y).toBe(0);
        expect(box.x).toBe(0);
        expect(box.width).toBe(390);
        expect(box.height).toBeLessThan(72);
        // Both actions are real buttons a keyboard reaches.
        await page.keyboard.press('Tab');
        await expect(bar.getByRole('button', { name: 'Reload' })).toBeVisible();
        await bar.getByRole('button', { name: 'Reload' }).focus();
        await expect(bar.getByRole('button', { name: 'Reload' })).toBeFocused();

        await bar.getByRole('button', { name: 'Dismiss' }).click();
        await expect(bar).toHaveCount(0);
        await expect.poll(async () => (await nav.boundingBox()).y).toBe(navTop);
        // The page learning of the same release again does not bring it back.
        await waiting(page);
        await page.waitForTimeout(200);
        await expect(bar).toHaveCount(0);
      } finally {
        await browser.close();
      }
    });

    test('the update bar never sits over the player and appears once it closes', async () => {
      const browser = await launch();
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
        await mockPlayer(page);
        await page.goto(`${ORIGIN}/test/player.html`);
        await expect(page.locator('.player video')).toBeAttached();
        await waiting(page);

        const bar = page.getByRole('status').filter({ hasText: 'A new version of Den is ready.' });
        // Given time to be wrongly drawn, it is still not on the picture.
        await page.waitForTimeout(500);
        await expect(bar).toBeHidden();

        await page.getByRole('button', { name: 'Close' }).click();
        await expect(page.locator('.player')).toHaveCount(0);
        await expect(bar).toBeVisible();
        expect((await bar.boundingBox()).y).toBe(0);
      } finally {
        await browser.close();
      }
    });
  });
}
