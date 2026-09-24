// Outside WebKit the player fetches hls.js as its own chunk only when a session starts. When that chunk can't be had
// (offline, or gone after a deploy), the player says so and lets den-remux's session go at once rather than at the
// close. Asking for the chunk again from the same page does not fetch it here: Chromium answers a second `import()` of
// a module whose fetch failed with the same failure (the check before the reload). Reloading the page does.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';

const ORIGIN = 'http://127.0.0.1:5198';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const hls = new URL('./media/hls/', import.meta.url);

const session = (n) => ({
  sid: n,
  playlist: `/direct/s/${n}/sig/master.m3u8`,
  duration: 60,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  video: { codec: 'vp9', transcoded: false },
  audioTrack: 0,
  audioTracks: [],
});

test('a player whose hls.js cannot be loaded ends its session and offers a reload', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext({
      userAgent: CHROME_MAC,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await guardNetwork(page);
    const asked = { started: 0, ended: [] };
    await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
    await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
    await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
    await page.route(`${ORIGIN}/direct/session`, (r) =>
      r.fulfill({ status: 201, json: session(`d${++asked.started}`) }),
    );
    await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases: [] } }));
    await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
      const request = r.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'DELETE') {
        asked.ended.push(path);
        return r.fulfill({ status: 204 });
      }
      if (request.method() === 'POST') return r.fulfill({ status: 204 });
      const file = path.endsWith('/master.m3u8') ? 'media.m3u8' : path.split('/').pop();
      return r.fulfill({
        contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        body: await readFile(new URL(file, hls)),
      });
    });
    // The chunk, as the dev server names it, gone.
    const chunk = /\/node_modules\/\.vite\/deps\/hls__js\.js/;
    await page.route(chunk, (r) => r.abort('internetdisconnected'));
    const fetched = [];
    page.on('request', (r) => chunk.test(r.url()) && fetched.push(r.url()));
    await page.goto(`${ORIGIN}/test/player.html`);

    await expect(page.getByText('Couldn’t load the player.')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.player video')).toHaveCount(0);
    await expect.poll(() => asked.ended).toEqual(['/direct/s/d1/sig']);

    await page.unroute(chunk);
    // The chunk can be had again, and the same page still can't import it: nothing is fetched, the same failure comes.
    expect(fetched).toHaveLength(1);
    const again = await page.evaluate(
      (url) =>
        import(url).then(
          () => 'loaded',
          () => 'failed',
        ),
      fetched[0],
    );
    expect(again).toBe('failed');
    expect(fetched).toHaveLength(1);
    await page.getByRole('button', { name: 'Reload' }).click();
    await page.waitForFunction(
      () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
      undefined,
      { timeout: 30_000 },
    );
    expect(asked.started).toBe(2);
    expect(fetched).toHaveLength(2);
    expect(asked.ended).toEqual(['/direct/s/d1/sig']);
  } finally {
    await browser.close();
  }
});
