import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const watchEvents = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-06-14T02:38:10Z,6000,A film,Goodrich`;
const viewingHistory = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title","Video Duration in 1080p","City","ISP Name"
Feature,2026-06-14T02:37:00Z,6000,Goodrich,6000000,Private City,Private ISP`;

async function openSettingsFixture() {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
  await guardNetwork(page);
  const pageOwned = [];
  await page.addInitScript(() => {
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-den-test-fetch-realm', 'page');
      return pageFetch(input, { ...init, headers });
    };
  });
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  // Settings' Sharing section lists the household's invites whenever it gets round to it; none here.
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: { simklClientId: 'client-1' } }));
  await routeTmdb(page, (route) => {
    if (route.request().headers()['x-den-test-fetch-realm']) pageOwned.push(route.request().url());
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/configuration')) return route.fulfill({ json: { images: {} } });
    if (path.endsWith('/watch/providers/regions')) return route.fulfill({ json: { results: [] } });
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
  return { browser, page, pageOwned };
}

test('provider imports recover a lost semantic reply with the same durable operation', async () => {
  const { browser, page, pageOwned } = await openSettingsFixture();
  try {
    await page.goto(`${E2E_ORIGIN}/test/settings.html`);

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
    await importRow.getByRole('button', { name: 'Import viewing history' }).click();
    await expect(importRow.getByRole('status')).toContainText('Saved 1 change');

    // Lose Prime's semantic reply after the real fixture authority committed it. The same operation id is retried,
    // so the authority applies the import once even though the page could not know whether the first call saved.
    await page.goto(`${E2E_ORIGIN}/test/settings.html?lose-import-reply`);
    await page.getByRole('button', { name: /Prime Video viewing history/ }).click();
    const retryPrime = page.getByRole('region', { name: 'Prime Video viewing history' });
    const retryPrimeInput = retryPrime.locator('input[type=file]');
    await retryPrimeInput.setInputFiles([
      { name: 'Watch Events.csv', mimeType: 'text/csv', buffer: Buffer.from(watchEvents) },
      { name: 'Viewing History.csv', mimeType: 'text/csv', buffer: Buffer.from(viewingHistory) },
    ]);
    await retryPrime.getByRole('button', { name: 'Import viewing history' }).click();
    await expect(retryPrime.getByRole('alert')).toContainText('Changes may already be saved');
    await expect(retryPrime.getByText('Choose both files…')).toBeVisible();
    await expect(retryPrime.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(await page.evaluate(() => globalThis.fixtureHistoryImports)).toEqual({
      attempts: 1,
      applications: 1,
      replies: 0,
      operationIds: [expect.any(String)],
    });
    await retryPrime.getByRole('button', { name: 'Try again' }).click();
    await expect(retryPrime.getByRole('status')).toContainText('Saved 1 change');
    const primeRetries = await page.evaluate(() => globalThis.fixtureHistoryImports);
    expect(primeRetries.attempts).toBe(2);
    expect(primeRetries.applications).toBe(1);
    expect(new Set(primeRetries.operationIds).size).toBe(1);

    // Netflix owns a separate retained session, but uses the same failure/replay boundary and recovery contract.
    await page.goto(`${E2E_ORIGIN}/test/settings.html?lose-import-reply`);
    await page.getByRole('button', { name: /Netflix viewing history/ }).click();
    const netflix = page.getByRole('region', { name: 'Netflix viewing history' });
    await netflix.locator('input[type=file]').setInputFiles({
      name: 'NetflixViewingHistory.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Title,Date\nGoodrich,6/14/26\n'),
    });
    await netflix.getByRole('button', { name: 'Mark 1 film or series as seen' }).click();
    await expect(netflix.getByRole('alert')).toContainText('Changes may already be saved');
    await expect(netflix.getByText('Choose file…')).toBeVisible();
    await netflix.getByRole('button', { name: 'Try again' }).click();
    await expect(netflix.getByRole('status')).toContainText('Saved 1 change');
    const netflixRetries = await page.evaluate(() => globalThis.fixtureHistoryImports);
    expect(netflixRetries.attempts).toBe(2);
    expect(netflixRetries.applications).toBe(1);
    expect(new Set(netflixRetries.operationIds).size).toBe(1);
    expect(pageOwned, 'provider requests must stay inside the content Worker').toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a mounted import row follows activity-model replacement and fences the old reply', async () => {
  const { browser, page } = await openSettingsFixture();
  try {
    await page.goto(`${E2E_ORIGIN}/test/settings.html?hold-import-reply`);
    const settingsHeading = await page
      .getByRole('heading', { name: 'Settings', level: 1 })
      .elementHandle();
    await page.getByRole('button', { name: /Prime Video viewing history/ }).click();
    const prime = page.getByRole('region', { name: 'Prime Video viewing history' });
    await prime.locator('input[type=file]').setInputFiles([
      { name: 'Watch Events.csv', mimeType: 'text/csv', buffer: Buffer.from(watchEvents) },
      { name: 'Viewing History.csv', mimeType: 'text/csv', buffer: Buffer.from(viewingHistory) },
    ]);
    await prime.getByRole('button', { name: 'Import viewing history' }).click();
    await expect(prime.getByRole('status')).toHaveText('Saving…');
    await page.waitForFunction(() => globalThis.fixtureHistoryImports?.applications === 1);

    await page.evaluate(() => globalThis.fixtureImportScope.replace());
    expect(await settingsHeading.isVisible()).toBe(true);
    await expect(prime.getByText('Choose both files…')).toBeVisible();
    await expect(prime.getByText('Saving…')).toHaveCount(0);

    await page.evaluate(() => globalThis.fixtureImportScope.release());
    await page.waitForFunction(() => globalThis.fixtureHistoryImports?.replies === 1);
    await expect(prime.getByText('Choose both files…')).toBeVisible();
    await expect(prime.getByText(/Saved \d+ change/)).toHaveCount(0);

    await page.evaluate(() => globalThis.fixtureImportScope.restore());
    await expect(prime.getByRole('status')).toContainText('Saved 1 change');
  } finally {
    await browser.close();
  }
});
