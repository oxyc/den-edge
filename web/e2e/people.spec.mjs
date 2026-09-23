import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

const FIXTURE = 'http://127.0.0.1:5198/test/nav-search.html';
const active = (page) => page.locator('[data-route-page][data-active="true"]');

/** Two actors and a director, each with the titles atlas says they are known for. */
const PEOPLE = [
  { id: 'Q1', name: 'Ann Actor', tmdbId: 11, roles: ['cast'], knownFor: ['First Film', 'A Show'] },
  { id: 'Q2', name: 'Bob Actor', tmdbId: 12, roles: ['cast'], knownFor: ['Second Film'] },
  { id: 'Q3', name: 'Cid Director', tmdbId: 13, roles: ['director'], knownFor: ['Third Film'] },
];

/** atlas's people routes, answering by the traits asked; every address is recorded as sent. */
async function serveAtlas(page) {
  const asked = [];
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('**/atlas/manifest.json', (r) =>
    r.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } }),
  );
  await page.route('**/atlas/catalog/**', (r) => r.fulfill({ json: { metas: [] } }));
  await page.route('**/atlas/recommend', (r) => r.fulfill({ json: { version: 1, slides: [] } }));
  await page.route('**/atlas/index/**', (r) => r.fulfill({ json: { labels: [] } }));
  await page.route('**/atlas/index/filter/**', (r) => {
    const url = new URL(r.request().url());
    asked.push(url.pathname.replace(/^.*\/atlas/, '') + url.search);
    const role = /role:([a-z]+)/.exec(url.searchParams.get('traits') ?? '')?.[1];
    const people = PEOPLE.filter((p) => !role || p.roles.includes(role));
    if (url.pathname.endsWith('/people/counts.json'))
      return r.fulfill({
        json: {
          total: people.length,
          traits: {
            role: {
              mode: 'and',
              complete: true,
              values: { cast: role === 'director' ? 0 : 2, director: role === 'cast' ? 0 : 1 },
              ...(role ? { selected: [role] } : {}),
            },
            gender: {
              mode: 'single',
              complete: true,
              values: { Q6581072: 1 },
              labels: { Q6581072: 'female' },
            },
          },
          traitCoverage: {},
        },
      });
    if (url.pathname.endsWith('/people.json'))
      return r.fulfill({
        json: {
          people: people.map((p) => ({
            ...p,
            credits: 2,
            knownFor: p.knownFor.map((title, i) => ({
              type: 'movie',
              id: i + 1,
              title,
              year: 2020,
            })),
          })),
          total: people.length,
          order: 'prominence',
          labels: {},
        },
      });
    if (url.pathname.endsWith('/counts.json'))
      return r.fulfill({
        json: { total: 3, kinds: { genre: { mode: 'and', complete: true, values: { 18: 3 } } } },
      });
    return r.fulfill({ json: { values: [], complete: true } });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="185" height="278"><rect width="185" height="278" fill="#264c68"/></svg>',
    }),
  );
  await routeTmdb(page, (r) => {
    const person = /\/person\/(\d+)$/.exec(new URL(r.request().url()).pathname)?.[1];
    if (person)
      return r.fulfill({ json: { id: Number(person), name: 'Someone', profile_path: '/p.jpg' } });
    return r.fulfill({ json: { results: [], total_pages: 1 } });
  });
  return asked;
}

test('People lists who atlas credits, a role narrows it in the address, and Back restores it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await guardNetwork(page);
    const asked = await serveAtlas(page);
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/people')}`);

    const grid = active(page).locator('.grid');
    const card = (name) => grid.getByRole('link', { name: new RegExp(`^${name}`) });
    await expect(active(page).getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    await expect(card('Ann Actor')).toBeVisible();
    await expect(card('Ann Actor')).toHaveAttribute('href', '/person/11');
    await expect(card('Ann Actor')).toContainText('First Film, A Show');
    await expect(card('Cid Director')).toBeVisible();
    await expect(active(page).getByText('3 people', { exact: true })).toBeVisible();
    expect(asked).toContain('/index/filter/all/people.json');
    await expect.poll(() => asked).toContain('/index/filter/all/people/counts.json');

    // A role from the rail: its own history entry, asked of atlas as a trait, shown as a pill.
    const rail = active(page).getByRole('navigation', { name: 'Browse by category' });
    await rail
      .getByRole('group', { name: 'Role' })
      .getByRole('button', { name: 'Directors', exact: true })
      .click();
    await expect(page).toHaveURL(/\/people\?t=role-director$/);
    await expect(card('Cid Director')).toBeVisible();
    await expect(card('Ann Actor')).toHaveCount(0);
    expect(asked).toContain('/index/filter/all/people.json?traits=role:director');
    const selected = active(page).getByRole('group', { name: 'Selected' });
    await expect(selected.getByRole('button', { name: 'Remove Directors' })).toBeVisible();

    // Back takes the pick out, on the same page.
    await page.goBack();
    await expect(page).toHaveURL(/\/people$/);
    await expect(card('Ann Actor')).toBeVisible();
    await expect(selected).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
