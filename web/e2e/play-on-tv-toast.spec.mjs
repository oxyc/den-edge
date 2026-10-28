// Feedback after "Play on TV" (den-edge#235): one toast, updated in place, driven entirely by
// `playOnTv.svelte.ts` through `LibrarySession.notify`. `LibraryFixture.svelte` hands `Library.svelte` a log it
// built itself — the real wire protocol is covered elsewhere — so this walks the toast the way a viewer sees it:
// Sent → the hint, if the TV hasn't opened Den → Playing, once a fresh position shows up (what a library pull
// would carry) → dismissed.
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

async function openTitle(page, { pendingStatus = 200, pendingBody = { queued: true } } = {}) {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>',
    }),
  );
  const appends = [];
  await page.route('**/inbox/append', async (r) => {
    appends.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true } });
  });
  await page.route('**/inbox/pending', (r) =>
    r.fulfill({ status: pendingStatus, json: pendingBody }),
  );
  // The hint delay, den-edge peeks and the toast's hold are the page's own timers: the test moves its clock.
  await page.clock.install();
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&page=title&type=movie&id=1001&link-host=tv`,
  );
  await expect(page.getByRole('heading', { name: 'Movie 1001', level: 1 })).toBeVisible();
  return { appends };
}

const toast = (page) => page.locator('p.library-status.toast');
const play = (page) => page.getByRole('button', { name: /on TV$/ });

/** `playOnTv.svelte.ts`: den-edge is peeked every PEEK_MS; HINT_MS without word adds the hint. */
const PEEK_MS = 2_000;
const HINT_MS = 10_000;
/** `profileSession.svelte.ts`: how long a passing toast stays. */
const TOAST_MS = 6_000;

/** Moves the page's clock past `ms`, then lets the den-edge peek that fired there be answered and read. */
async function passTime(page, ms) {
  const peeked = page.waitForResponse('**/inbox/pending');
  await page.clock.fastForward(ms);
  await peeked;
}

test('toast walks Sending → Sent → the hint → Playing, then dismisses', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // den-edge never says it was received: the TV stays closed for the whole send.
    const { appends } = await openTitle(page);
    await play(page).click();
    await expect(toast(page)).toHaveText('Sent to Living Room TV…');
    expect(appends).toHaveLength(1);
    expect(Object.keys(appends[0])).toEqual(['sealed']);

    // Not before the hint delay.
    await passTime(page, HINT_MS - PEEK_MS);
    await expect(toast(page)).toHaveText('Sent to Living Room TV…');

    // No word from den-edge within the hint delay: the toast gains the hint and stays up rather than clearing.
    await passTime(page, PEEK_MS);
    await expect(toast(page)).toHaveText(
      'Sent to Living Room TV… Den needs to be open on Living Room TV.',
    );
    await passTime(page, TOAST_MS);
    await expect(toast(page)).toBeVisible();

    // The TV opens Den and starts it: a fresh position for the title, exactly what the library pull would carry.
    await page.evaluate(() => window.denTestLivePosition({ type: 'movie', id: 1001 }, 42));
    await expect(toast(page)).toHaveText('Playing on Living Room TV');

    // And then it dismisses, like any other passing toast.
    await page.clock.fastForward(TOAST_MS);
    await expect(toast(page)).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('skips the hint once den-edge says the TV already took it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await openTitle(page, { pendingBody: { queued: false } });
    await play(page).click();
    await expect(toast(page)).toHaveText('Sent to Living Room TV…');
    // Past the hint delay, with den-edge having said it is gone from the queue — no hint, no false alarm. A second
    // peek past it is answered too, so the first one's answer has been read before the toast is.
    await passTime(page, HINT_MS + 500);
    await passTime(page, PEEK_MS);
    await expect(toast(page)).toHaveText('Sent to Living Room TV…');
  } finally {
    await browser.close();
  }
});

test('says so when den-edge is unreachable, same as before this feature', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await guardNetwork(page);
    await page.route('**/routes', (r) => r.fulfill({ json: {} }));
    await routeTmdb(page, (r) => r.fulfill({ json: movie }));
    await page.route('https://image.tmdb.org/**', (r) =>
      r.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
      }),
    );
    await page.route('**/inbox/append', (r) => r.abort('failed'));
    await page.goto(
      `${E2E_ORIGIN}/test/library.html?populated&page=title&type=movie&id=1001&link-host=tv`,
    );
    await expect(page.getByRole('heading', { name: 'Movie 1001', level: 1 })).toBeVisible();
    await play(page).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Couldn’t reach Living Room TV. Check that this device is online.',
    );
    await expect(toast(page)).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
