// "Play on TV" with a TV that reports how each play went (den-spec play-results-v1, oxyc/den#476): the toast follows
// the TV's own sealed results — Waking → Preparing source → Playing, or why not, with Try again where a new send can
// help. The TV here is the test: it opens the household envelope the page appended, learns its id, and seals its
// results under that id exactly as a TV would, behind a stand-in for den-edge's held `GET /play/result/{address}`.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
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

/** `LibraryFixture.svelte`'s TV publishes 'A' × 43 as its household play key: 32 zero bytes. */
const PLAY_KEY = Buffer.alloc(32);
const ENC = Buffer.from(hkdfSync('sha256', PLAY_KEY, 'den/link/v1', 'enc', 32));
const SALT = 'den/play-result/v1';

/** The id of a household envelope, opened as the TV opens it (inbox-v1 §1). */
function envelopeId(sealed) {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', ENC, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from('den/inbox/v1'));
  decipher.setAuthTag(bytes.subarray(-16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8')).id;
}

const derive = (id, info, length) =>
  Buffer.from(hkdfSync('sha256', Buffer.from(id, 'hex'), SALT, info, length));
const addressOf = (id) => derive(id, 'address', 16).toString('hex');

/** A result sealed for request `id`, as a TV seals it (play-results-v1 §2). */
function sealResult(id, body) {
  const address = addressOf(id);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(id, 'key', 32), nonce);
  cipher.setAAD(Buffer.concat([Buffer.from(SALT), Buffer.from([0]), Buffer.from(address)]));
  const plaintext = JSON.stringify({ at: Date.now(), ...body, v: 1 }).padEnd(128, ' ');
  return Buffer.concat([
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url');
}

/**
 * The title page, a TV that reports results, and a stand-in TV: `say(body)` has it post a result for the last play
 * sent; a held read of the results answers once there is something new, as den-edge's does.
 */
async function openTitle(page, { listening = true } = {}) {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>',
    }),
  );
  const ids = [];
  const results = new Map();
  let waiting = [];
  await page.route('**/inbox/append', async (r) => {
    ids.push(envelopeId(r.request().postDataJSON().sealed));
    await r.fulfill({ json: { ok: true } });
  });
  await page.route('**/inbox/pending', (r) => r.fulfill({ json: { queued: true } }));
  await page.route('**/inbox/listening', (r) => r.fulfill({ json: { listening } }));
  const reads = [];
  await page.route('**/play/result/**', async (r) => {
    const url = new URL(r.request().url());
    const address = url.pathname.split('/').at(-1);
    const after = Number(url.searchParams.get('after') ?? 0);
    reads.push(address);
    while ((results.get(address) ?? []).length <= after)
      await new Promise((resolve) => waiting.push(resolve));
    await r.fulfill({ json: { results: results.get(address) } });
  });
  const say = (body) => {
    const id = ids.at(-1);
    const address = addressOf(id);
    results.set(address, [...(results.get(address) ?? []), sealResult(id, body)]);
    const woken = waiting;
    waiting = [];
    for (const wake of woken) wake();
  };
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&page=title&type=movie&id=1001&link-host=tv&tv-results`,
  );
  await expect(page.getByRole('heading', { name: 'Movie 1001', level: 1 })).toBeVisible();
  return { ids, reads, say };
}

const toast = (page) => page.locator('p.library-status.toast');
const play = (page) => page.getByRole('button', { name: /on TV$/ });

async function withPage(run) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    await run(await browser.newPage({ viewport: { width: 1280, height: 800 } }));
  } finally {
    await browser.close();
  }
}

test('follows the TV: Waking → Preparing source → Playing, and only the TV says Playing', async () => {
  await withPage(async (page) => {
    const { ids, reads, say } = await openTitle(page, { listening: false });
    await play(page).click();
    await expect(toast(page)).toHaveText('Waking Living Room TV…');
    expect(ids).toHaveLength(1);
    // The page reads the results at the address the request's own id derives, and nothing else knows it.
    await expect.poll(() => reads[0]).toBe(addressOf(ids[0]));

    // Another device's position on the same title is not this request's evidence.
    await page.evaluate(() => window.denTestLivePosition({ type: 'movie', id: 1001 }, 42));
    await expect(toast(page)).toHaveText('Waking Living Room TV…');

    say({ state: 'preparing' });
    await expect(toast(page)).toHaveText('Preparing source on Living Room TV…');
    say({ state: 'playing' });
    await expect(toast(page)).toHaveText('Playing on Living Room TV');
  });
});

test('says why it did not play, with Try again only where a new send can help', async () => {
  await withPage(async (page) => {
    const { ids, say } = await openTitle(page);
    await play(page).click();
    await expect(toast(page)).toHaveText('Sent to Living Room TV…');
    say({ state: 'preparing' });
    say({ reason: 'no_source', state: 'failed' });
    await expect(toast(page)).toHaveText('No playable source on Living Room TV.');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

    // Too late for the TV: Try again sends a new request, never the old one again.
    await play(page).click();
    await expect.poll(() => ids.length).toBe(2);
    say({ reason: 'expired', state: 'failed' });
    await expect(toast(page)).toHaveText('Living Room TV got it too late to play it.Try again');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
    await expect(toast(page)).toHaveText('Sent to Living Room TV…');
  });
});
