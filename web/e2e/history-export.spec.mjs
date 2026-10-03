import { readFile } from 'node:fs/promises';
import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

test('Settings downloads the watch history as CSV and JSON, built in the browser', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
    await guardNetwork(page);
    await page.route('**/routes', (route) => route.fulfill({ json: {} }));
    await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
    await page.route('**/config', (route) => route.fulfill({ json: {} }));
    await routeTmdb(page, (route) => route.fulfill({ status: 404, json: {} }));
    await page.goto('http://127.0.0.1:5198/test/settings.html');

    await page.getByRole('button', { name: /Download watch history/ }).click();
    const row = page.getByRole('region', { name: 'Download watch history' });

    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      row.getByRole('button', { name: 'Download CSV' }).click(),
    ]);
    expect(csv.suggestedFilename()).toMatch(/^den-history-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((await readFile(await csv.path(), 'utf8')).split('\r\n')).toEqual([
      'type,tmdb_id,imdb_id,title,year,season,episode,watched_at,rewatch,source,status,watchlist,reaction,rating',
      'movie,550,tt0137523,Fight Club,1999,,,2026-09-10T00:26:40.000Z,true,den,watched,false,love,10',
      'movie,550,tt0137523,Fight Club,1999,,,2025-10-09T08:53:20.000Z,false,den,watched,false,love,10',
      '',
    ]);

    const [json] = await Promise.all([
      page.waitForEvent('download'),
      row.getByRole('button', { name: 'Download JSON' }).click(),
    ]);
    expect(json.suggestedFilename()).toMatch(/^den-history-\d{4}-\d{2}-\d{2}\.json$/);
    const history = JSON.parse(await readFile(await json.path(), 'utf8'));
    expect(history.titles).toEqual([
      expect.objectContaining({
        type: 'movie',
        tmdbId: 550,
        title: 'Fight Club',
        rating: 10,
        plays: [
          { watchedAt: '2025-10-09T08:53:20.000Z', rewatch: false, source: 'den' },
          { watchedAt: '2026-09-10T00:26:40.000Z', rewatch: true, source: 'den' },
        ],
      }),
    ]);
  } finally {
    await browser.close();
  }
});
