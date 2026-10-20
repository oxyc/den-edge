// "Play on TV" only through a link to a TV. A browser that joined another browser (Settings › "Use Den on your
// phone") holds a link whose inbox is that browser's: a Resume on TV sent through it was queued where no TV drains,
// and the toast named the other browser ("Sent to Mac…"). The library's device list says what kind of device the
// link's host is, and only a TV gets the action.
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const movie = {
  id: 1001,
  imdb_id: 'tt1001',
  title: 'Movie 1001',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A film, for the detail page to show.',
  genres: [{ name: 'Drama' }],
  release_date: '2026-01-01',
  vote_average: 7.5,
  vote_count: 500,
  credits: { cast: [] },
  recommendations: { results: [] },
};

async function openTitle(page, host) {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
  const appends = [];
  await page.route('**/inbox/append', async (r) => {
    appends.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true } });
  });
  await page.route('**/inbox/pending', (r) => r.fulfill({ json: { queued: true } }));
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&page=title&type=movie&id=1001&link-host=${host}`,
  );
  await expect(page.getByRole('heading', { name: 'Movie 1001', level: 1 })).toBeVisible();
  return { appends };
}

const onTv = (page) => page.getByRole('button', { name: /on TV$/ });

test('a link made by joining a browser offers no Play on TV and sends nothing', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const { appends } = await openTitle(page, 'browser');
    // The library's device list has been read by now: the same page with a TV host draws the button.
    await page.waitForTimeout(500);
    await expect(onTv(page)).toHaveCount(0);
    expect(appends).toHaveLength(0);
  } finally {
    await browser.close();
  }
});

test('a legacy browser link named Mac is not mistaken for a TV receiver', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const { appends } = await openTitle(page, 'legacy-browser');
    await page.waitForTimeout(500);
    await expect(onTv(page)).toHaveCount(0);
    expect(appends).toHaveLength(0);
  } finally {
    await browser.close();
  }
});

test('a link to a TV the device list shows still plays on it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const { appends } = await openTitle(page, 'tv');
    await onTv(page).click();
    await expect(page.locator('p.library-status.toast')).toHaveText('Sent to Living Room TV…');
    expect(appends).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

test('a legacy TV link is accepted only when its name resolves to a TV device', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const { appends } = await openTitle(page, 'legacy-tv');
    await onTv(page).click();
    await expect(page.locator('p.library-status.toast')).toHaveText('Sent to Living Room TV…');
    expect(appends).toHaveLength(1);
  } finally {
    await browser.close();
  }
});
