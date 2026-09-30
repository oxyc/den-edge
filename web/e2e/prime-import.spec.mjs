import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

const watchEvents = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-06-14T02:38:10Z,6000,A film,Goodrich`;
const viewingHistory = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title","Video Duration in 1080p","City","ISP Name"
Feature,2026-06-14T02:37:00Z,6000,Goodrich,6000000,Private City,Private ISP`;

test('Prime import requires both schemas, previews locally, and writes the completed film', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
    await guardNetwork(page);
    await page.route('**/routes', (route) => route.fulfill({ json: {} }));
    await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
    await page.route('**/config', (route) =>
      route.fulfill({ json: { simklClientId: 'client-1' } }),
    );
    await routeTmdb(page, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/configuration')) return route.fulfill({ json: { images: {} } });
      if (path.endsWith('/watch/providers/regions'))
        return route.fulfill({ json: { results: [] } });
      if (path.endsWith('/watch/providers/movie') || path.endsWith('/watch/providers/tv'))
        return route.fulfill({ json: { results: [] } });
      if (path.endsWith('/search/multi'))
        return route.fulfill({
          json: {
            results: [
              {
                media_type: 'movie',
                id: 1,
                title: 'Goodrich',
                original_title: 'Goodrich',
                release_date: '2024-10-17',
              },
            ],
          },
        });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto('http://127.0.0.1:5198/test/settings.html');

    await page.getByRole('button', { name: /Prime Video viewing history/ }).click();
    const importRow = page.getByRole('region', { name: 'Prime Video viewing history' });
    await expect(importRow).toContainText('combined history');
    const input = importRow.locator('input[type=file]');
    await input.setInputFiles({
      name: 'Watch Events.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(watchEvents),
    });
    await expect(importRow.getByRole('alert')).toContainText('Choose both');

    await input.setInputFiles([
      { name: 'Watch Events.csv', mimeType: 'text/csv', buffer: Buffer.from(watchEvents) },
      { name: 'Viewing History.csv', mimeType: 'text/csv', buffer: Buffer.from(viewingHistory) },
    ]);
    await expect(importRow.getByText('Found 1 film and 0 episodes from 0 series.')).toBeVisible();
    await importRow.getByRole('button', { name: 'Import completed history' }).click();
    await expect(importRow.getByRole('status')).toContainText('Saved 1 change');
  } finally {
    await browser.close();
  }
});
