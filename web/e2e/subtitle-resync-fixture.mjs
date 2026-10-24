import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';
import { installAvplayInitScript, callsNamed } from './avplay-fixture.mjs';

const BASE = `/remux/s/${'a'.repeat(22)}/${'b'.repeat(22)}`;
const ORIGINAL = `${ORIGIN}/fixture-original.vtt`;
const VTT = (start, text) => `WEBVTT\n\n00:00:${start}.000 --> 00:00:59.000\n${text}\n`;

async function fixture(page, { fail = false, held = false, hashMatch = false } = {}) {
  const samsung = process.env.DEN_TV_PLATFORM === 'tizen';
  if (samsung) await installAvplayInitScript(page);
  await guardNetwork(page);
  await page.route(`${ORIGIN}/assets/**`, (route) => route.continue());
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/playback/**`, (route) => route.fulfill({ status: 204 }));
  const release = { label: 'Subtitle fixture', filename: 'fixture.mkv', size: 1 };
  let starts = 0;
  await page.route(`${ORIGIN}/remux/releases`, (route) =>
    route.fulfill({ json: { releases: [release] } }),
  );
  await page.route(`${ORIGIN}/remux/session`, (route) => {
    starts++;
    return route.fulfill({
      status: 201,
      json: {
        sid: 'a'.repeat(22),
        playlist: `${BASE}/master.m3u8`,
        duration: 60,
        release,
        audioTrack: 0,
        audioTracks: [{ language: 'en', channels: 2 }],
        subtitleResync: { supported: true, url: `${BASE}/subtitle-resync` },
        subtitles: [
          {
            value: 'candidate:1',
            language: 'en',
            name: 'English 1',
            source: 'opensubtitles',
            rendition: 0,
            resyncSupported: true,
          },
          {
            value: 'candidate:2',
            language: 'en',
            name: 'English 2',
            source: 'opensubtitles',
            rendition: 1,
            resyncSupported: true,
          },
        ],
        externalSubtitles: [
          { value: 'candidate:1', language: 'en', name: 'English 1', url: ORIGINAL },
          { value: 'candidate:2', language: 'en', name: 'English 2', url: `${ORIGINAL}?second` },
        ],
      },
    });
  });
  await page.route(`${ORIGINAL}*`, (route) =>
    route.fulfill({ contentType: 'text/vtt', body: VTT('12', 'Original') }),
  );
  await page.route(`${ORIGIN}${BASE}/**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 204 });
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const file = name === 'master.m3u8' ? 'media.m3u8' : name;
    return route.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(`./media/hls/${file}`, import.meta.url)),
    });
  });
  await page.route(`${ORIGIN}${BASE}/sub0.aligned.vtt`, (route) =>
    route.fulfill({ contentType: 'text/vtt', body: VTT('02', 'Aligned') }),
  );
  let releaseAlignment;
  const gate = new Promise((resolve) => {
    releaseAlignment = resolve;
  });
  let requested = 0;
  await page.route(`${ORIGIN}${BASE}/subtitle-resync`, async (route) => {
    const body = route.request().postDataJSON();
    if (body.checkOnly)
      return route.fulfill({ json: { supported: !hashMatch, source: 'opensubtitles', hashMatch } });
    expect(body).toEqual({ rendition: 0, audioTrack: 0 });
    requested++;
    if (held) await gate;
    return route
      .fulfill(
        fail
          ? { status: 503, json: { error: 'alignment_failed' } }
          : {
              json: { url: `${BASE}/sub0.aligned.vtt`, offsetMs: -10000, viaSparse: false },
            },
      )
      .catch(() => {});
  });
  await page.goto(`${ORIGIN}/test/player.html?remux=/remux&subtitleLanguage=en`);
  if (!process.env.DEN_TV_PLATFORM)
    await page.addStyleTag({ path: fileURLToPath(new URL('../src/app.css', import.meta.url)) });
  const video = page.locator('.player video');
  await expect.poll(() => video.evaluate((el) => el.currentTime)).toBeGreaterThan(0);
  const menu = page.getByRole('button', { name: /^Subtitles:/ });
  // The saved language preference must resolve to the concrete first candidate without a manual menu pick.
  await expect(menu).toHaveAttribute('aria-label', 'Subtitles: English 1');
  return {
    video,
    menu,
    starts: () => starts,
    requested: () => requested,
    releaseAlignment,
    samsung,
  };
}

async function manualOffset(page, menu) {
  await menu.click();
  await page.getByRole('menuitem', { name: /^Adjust subtitle timing/ }).click();
  // The TV editor uses remote Left/Right; desktop has visible half-second controls.
  if (process.env.DEN_TV_PLATFORM) await page.keyboard.press('ArrowRight');
  else await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.keyboard.press('Escape');
}

export function subtitleResyncJourneys() {
  test('audio re-sync preserves playback and candidate, clears manual adjustment and retains aligned reset baseline', async ({
    page,
  }) => {
    const f = await fixture(page);
    await manualOffset(page, f.menu);
    await f.menu.click();
    const resync = page.getByRole('menuitem', { name: 'Re-sync with audio', exact: true });
    await expect(resync).toBeVisible();
    const before = await f.video.evaluate((el) => el.currentTime);
    await page.screenshot({ path: test.info().outputPath('subtitle-resync-menu.png') });
    await resync.click();
    await expect(page.getByText('Subtitles re-synced · -10.0s', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        f.video.evaluate(
          (el) =>
            [...el.textTracks].find((track) => track.label === 'candidate:1')?.cues?.[0]?.startTime,
        ),
      )
      .toBe(2);
    await expect.poll(() => f.video.evaluate((el) => el.currentTime)).toBeGreaterThan(before);
    expect(f.starts()).toBe(1);
    if (f.samsung) {
      expect(await callsNamed(page, 'prepareAsync')).toHaveLength(1);
      await expect(page.locator('.den-avplay-captions')).toHaveText('Aligned');
    }
    await f.menu.click();
    await expect(page.getByRole('menuitemradio', { name: 'English 1' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(
      page.getByRole('menuitem', { name: 'Adjust subtitle timing (-10.0s)', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await manualOffset(page, f.menu);
    await f.menu.click();
    await expect(
      page.getByRole('menuitem', { name: 'Adjust subtitle timing (-9.5s)', exact: true }),
    ).toBeVisible();
    await page.getByRole('menuitem', { name: /^Reset subtitle timing/ }).click();
    await f.menu.click();
    await expect(
      page.getByRole('menuitem', { name: 'Adjust subtitle timing (-10.0s)', exact: true }),
    ).toBeVisible();
  });

  test('failed re-sync leaves the current subtitle and manual offset intact', async ({ page }) => {
    const f = await fixture(page, { fail: true });
    await manualOffset(page, f.menu);
    await f.menu.click();
    await page.getByRole('menuitem', { name: 'Re-sync with audio', exact: true }).click();
    await expect(
      page.getByText('Subtitles could not be re-synced. Your current timing is unchanged.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('track[label="candidate:1"]')).toHaveAttribute('src', ORIGINAL);
    await f.menu.click();
    await expect(
      page.getByRole('menuitem', { name: 'Adjust subtitle timing (+0.5s)', exact: true }),
    ).toBeVisible();
    expect(f.starts()).toBe(1);
  });

  test('changing the chosen candidate discards a late alignment', async ({ page }) => {
    const f = await fixture(page, { held: true });
    await f.menu.click();
    await page.getByRole('menuitem', { name: 'Re-sync with audio', exact: true }).click();
    await expect.poll(f.requested).toBe(1);
    await f.menu.click();
    await page.getByRole('menuitemradio', { name: 'English 2' }).click();
    f.releaseAlignment();
    await expect(page.getByText('Re-syncing subtitles with audio…', { exact: true })).toHaveCount(
      0,
    );
    await expect(page.locator('track[label="candidate:1"]')).toHaveAttribute('src', ORIGINAL);
    await f.menu.click();
    await expect(page.getByRole('menuitemradio', { name: 'English 2' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(f.starts()).toBe(1);
  });

  test('a hash-exact subtitle does not offer audio alignment', async ({ page }) => {
    const f = await fixture(page, { hashMatch: true });
    await f.menu.click();
    await expect(
      page.getByRole('menuitem', { name: 'Re-sync with audio', exact: true }),
    ).toHaveCount(0);
    expect(f.requested()).toBe(0);
  });

  test('replacing playback discards an alignment from the previous session', async ({ page }) => {
    const f = await fixture(page, { held: true });
    await f.menu.click();
    await page.getByRole('menuitem', { name: 'Re-sync with audio', exact: true }).click();
    await expect.poll(f.requested).toBe(1);
    await page.getByRole('button', { name: /^Audio track:/ }).click();
    await page.getByRole('menuitem', { name: 'Re-sync audio & video', exact: true }).click();
    await expect.poll(f.starts).toBe(2);
    f.releaseAlignment();
    await expect(page.getByText('Re-syncing subtitles with audio…', { exact: true })).toHaveCount(
      0,
    );
    await expect(page.locator('track[label="candidate:1"]')).toHaveAttribute('src', ORIGINAL);
    await expect(page.getByText('Subtitles re-synced · -10.0s', { exact: true })).toHaveCount(0);
  });
}
