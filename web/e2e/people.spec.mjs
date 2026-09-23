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
    const born = /born:([0-9-]+)/.exec(url.searchParams.get('traits') ?? '')?.[1];
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
            // Counted by decade; a range picked is named as atlas spells it.
            born: {
              mode: 'single',
              complete: true,
              values: { 1970: 2, 1980: 1 },
              ...(born ? { selected: [born] } : {}),
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
    // The typeaheads: people by name, and an occupation.
    if (url.pathname.endsWith('/values/person.json'))
      return r.fulfill({
        json: { values: [{ id: 'Q1', name: 'Ann Actor', count: 2, tmdbId: 11 }], complete: true },
      });
    if (url.pathname.endsWith('/people/values/occupation.json'))
      return r.fulfill({
        json: { values: [{ id: 'Q33999', name: 'actor', count: 2 }], complete: true },
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

test('The Explore and People headings link each other, carrying the type and the title facets', async () => {
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
    await serveAtlas(page);
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?type=tv&c=genre-18,rating-7')}`);

    const tabs = active(page).getByRole('navigation', { name: 'Explore or People' });
    await expect(active(page).getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Explore' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The rating floor is TMDB's, and scopes no credits: it stays on Explore.
    const toPeople = tabs.getByRole('link', { name: 'People' });
    await expect(toPeople).not.toHaveAttribute('aria-current');
    await expect(toPeople).toHaveAttribute('href', '/people?type=tv&c=genre-18');
    await toPeople.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/people\?type=tv&c=genre-18$/);
    await expect(active(page).getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    await expect(active(page).getByRole('link', { name: 'People' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // A person trait is People's alone: the way back takes the type and the genre, not the role.
    await active(page)
      .getByRole('navigation', { name: 'Browse by category' })
      .getByRole('group', { name: 'Role' })
      .getByRole('button', { name: 'Directors', exact: true })
      .click();
    await expect(page).toHaveURL(/\/people\?type=tv&c=genre-18&t=role-director$/);
    await active(page)
      .getByRole('navigation', { name: 'Explore or People' })
      .getByRole('link', { name: 'Explore' })
      .click();
    await expect(page).toHaveURL(/\/search\?type=tv&c=genre-18$/);
    await expect(active(page).getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('On People the bar’s field offers people facets and people by name, and a pick takes the text’s place', async () => {
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
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/people?type=movie')}`);
    const view = active(page);
    await expect(view.getByRole('heading', { name: 'People', exact: true })).toBeVisible();

    const field = page.getByRole('searchbox', { name: 'Search people, nationalities, roles…' });
    await expect(field).toHaveAttribute('placeholder', 'Search people, nationalities, roles…');
    await field.fill('act');
    // The text stays on People, in its address, instead of opening Search.
    await expect(page).toHaveURL(/\/people\?q=act&type=movie$/);

    const browse = view.getByRole('group', { name: 'Browse' });
    const actors = browse.getByRole('button', { name: 'Actors · role' });
    await expect(actors).toBeVisible();
    await expect(browse.getByRole('button', { name: 'Actor · occupation' })).toBeVisible();
    // Not a title facet atlas counts no titles for (Action, beside the mock's dramas only).
    await expect(browse.getByRole('button', { name: /^Action · / })).toHaveCount(0);
    // And the person the text names, opening their page.
    const ann = view.getByRole('region', { name: 'People by that name' }).getByRole('link', {
      name: /^Ann Actor/,
    });
    await expect(ann).toHaveAttribute('href', '/person/11');
    expect(asked.some((path) => path.startsWith('/index/filter/movie/values/person.json?'))).toBe(
      true,
    );

    // Picking a chip adds its pill and clears the text, as Explore's Browse row does.
    await actors.click();
    await expect(page).toHaveURL(/\/people\?type=movie&t=role-cast$/);
    await expect(field).toHaveValue('');
    await expect(
      view.getByRole('group', { name: 'Selected' }).getByRole('button', { name: 'Remove Actors' }),
    ).toBeVisible();
    await expect(view.getByRole('group', { name: 'Browse' })).toHaveCount(0);

    // Enter still searches titles, taking the type along.
    await field.fill('heat');
    await field.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=heat&type=movie$/);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('A second value of one kind is either-or, on People and on Explore', async () => {
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

    // People: Actors, then Directors — still offered, though atlas counts no actor who directs.
    const roles = () =>
      active(page)
        .getByRole('navigation', { name: 'Browse by category' })
        .getByRole('group', { name: 'Role' });
    await roles().getByRole('button', { name: 'Actors', exact: true }).click();
    await expect(page).toHaveURL(/\/people\?t=role-cast$/);
    await expect
      .poll(() => asked)
      .toContain('/index/filter/all/people/counts.json?traits=role:cast');
    await roles().getByRole('button', { name: 'Directors', exact: true }).click();
    await expect(page).toHaveURL(/\/people\?t=role-cast,role-director$/);
    await expect
      .poll(() => asked)
      .toContain('/index/filter/all/people.json?traits=role:cast|director');
    const selected = active(page).getByRole('group', { name: 'Selected' });
    await expect(selected).toContainText('Actors✕or Directors✕');

    // Explore: Drama, then Comedy, asked as one group once atlas's filter has answered.
    await page.goto(`${FIXTURE}?at=${encodeURIComponent('/search?type=tv&c=genre-18')}`);
    await expect.poll(() => asked).toContain('/index/filter/series/counts.json?sel=genre:18');
    const genres = active(page)
      .getByRole('navigation', { name: 'Browse by category' })
      .getByRole('group', { name: 'Genres' });
    await genres.getByRole('button', { name: 'Comedy', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?type=tv&c=genre-18,genre-35$/);
    await expect.poll(() => asked).toContain('/index/filter/series/titles.json?sel=genre:18|35');
    await expect(active(page).getByRole('group', { name: 'Selected' })).toContainText(
      'Drama✕or Comedy✕',
    );
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('A birth-year range takes a decade’s place, stays in the address, and an open end is asked open', async () => {
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

    const view = active(page);
    const from = view.getByRole('textbox', { name: 'Born from (year)' });
    const to = view.getByRole('textbox', { name: 'Born to (year)' });
    const selected = view.getByRole('group', { name: 'Selected' });
    const rail = view.getByRole('navigation', { name: 'Browse by category' });
    const decade = rail.getByRole('group', { name: 'Born' }).getByRole('button', {
      name: 'Born 1970s',
      exact: true,
    });

    // A decade first, then a range: the range takes its place, and says so.
    await decade.click();
    await expect(page).toHaveURL(/\/people\?t=born-1970$/);
    await from.fill('1976');
    await to.fill('1996');
    await to.press('Enter');
    await expect(page).toHaveURL(/\/people\?t=born-1976-1996$/);
    await expect(selected.getByRole('button', { name: 'Remove Born 1976–1996' })).toBeVisible();
    await expect(selected.getByRole('button', { name: 'Remove Born 1970s' })).toHaveCount(0);
    const status = view.locator('p.status');
    await expect(status).toHaveText('Born 1976–1996 replaced Born 1970s.');
    await expect.poll(() => asked).toContain('/index/filter/all/people.json?traits=born:1976-1996');
    await expect
      .poll(() => asked)
      .toContain('/index/filter/all/people/counts.json?traits=born:1976-1996');
    // Moving from one field to the other was no pick of its own.
    expect(asked).not.toContain('/index/filter/all/people.json?traits=born:1976-');
    // One born pick at a time: no decade is offered beside the range.
    await expect(decade).toHaveCount(0);

    // An emptied end is an open one.
    await to.fill('');
    await to.press('Enter');
    await expect(page).toHaveURL(/\/people\?t=born-from-1976$/);
    await expect.poll(() => asked).toContain('/index/filter/all/people.json?traits=born:1976-');
    await expect(selected.getByRole('button', { name: 'Remove Born 1976 or later' })).toBeVisible();

    // A year atlas can't take is said, and not asked.
    await to.fill('1700');
    await to.press('Enter');
    await expect(status).toContainText('Born: a year from 1800');
    await expect(page).toHaveURL(/\/people\?t=born-from-1976$/);

    // Back restores the closed range, fields and all; removing the pill empties them.
    await page.goBack();
    await expect(page).toHaveURL(/\/people\?t=born-1976-1996$/);
    await expect(from).toHaveValue('1976');
    await expect(to).toHaveValue('1996');
    await selected.getByRole('button', { name: 'Remove Born 1976–1996' }).click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(from).toHaveValue('');
    await expect(to).toHaveValue('');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
