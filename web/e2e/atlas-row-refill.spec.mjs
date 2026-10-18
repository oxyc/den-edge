import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

const IDS = [7101, 7102, 7103, 7104];

// atlas names a row's titles; their posters come from what den-edge has been told (`/metadata/title/query`). The
// Worker keeps a row's answer for five minutes, so an answer whose poster fill den-edge refused must not be kept as if
// it were complete: the row would stay posterless through every rebuild in that window.
test('an atlas row whose poster fill was refused gets its posters when it is rebuilt', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
  let rowRequests = 0;
  await page.route('**/atlas/**', (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/index/row/movie.json'))
      return route.fulfill({ status: 404, json: {} });
    rowRequests++;
    return route.fulfill({
      json: {
        titles:
          url.searchParams.get('skip') === '0'
            ? IDS.map((id) => ({ type: 'movie', id, title: `Atlas film ${id}` }))
            : [],
      },
    });
  });
  const metadataAnswers = [];
  await page.route('**/metadata/title/query', (route) => {
    // The first fill is refused, as den-edge's per-member allowance answers a burst.
    if (metadataAnswers.length === 0) {
      metadataAnswers.push(429);
      return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, json: {} });
    }
    metadataAnswers.push(200);
    const observedAt = Date.now() - 1_000;
    return route.fulfill({
      json: {
        entries: route
          .request()
          .postDataJSON()
          .titles.map(({ type, id }) => ({
            type,
            id,
            source: 'tmdb',
            fields: { posterPath: { value: `/refill-${id}.jpg`, observedAt } },
          })),
      },
    });
  });

  await page.goto(`${E2E_ORIGIN}/test/atlas-row-refill.html`);
  const row = page.getByRole('region', { name: 'Mind-Bending' });
  await expect(row.getByText(`Atlas film ${IDS[0]}`).first()).toBeVisible();
  await expect(row.locator('.placeholder').first()).toBeVisible();
  expect(metadataAnswers).toEqual([429]);
  await expect(row.locator('img')).toHaveCount(0);

  // Well inside the five-minute window.
  await page.evaluate(() => window.fixture.rebuild());
  await expect(row.locator(`img[src$="/refill-${IDS[0]}.jpg"]`)).toBeVisible();
  await expect(row.locator('.placeholder')).toHaveCount(0);
  expect(metadataAnswers).toEqual([429, 200]);

  // A complete answer is kept: rebuilding again asks neither atlas nor den-edge.
  const asked = { row: rowRequests, metadata: metadataAnswers.length };
  await page.evaluate(() => window.fixture.rebuild());
  await expect(row.locator(`img[src$="/refill-${IDS[0]}.jpg"]`)).toBeVisible();
  await page.waitForTimeout(300);
  expect({ row: rowRequests, metadata: metadataAnswers.length }).toEqual(asked);
});
