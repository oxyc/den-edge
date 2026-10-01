import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

const svg = (w, h, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`;

/** Title 42 is open, with "Another Movie" (43) in its Starring row; 43's details wait for `release`. */
async function setup(page) {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('https://image.tmdb.org/**', (r) => {
    const backdrop = r.request().url().includes('backdrop');
    return r.fulfill({
      contentType: 'image/svg+xml',
      body: backdrop ? svg(1280, 720, 'teal') : svg(200, 300, 'blue'),
    });
  });
  let release;
  const ready = new Promise((r) => (release = r));
  await routeTmdb(page, async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/person/7/combined_credits'))
      return r.fulfill({
        json: {
          cast: [
            {
              id: 43,
              media_type: 'movie',
              title: 'Another Movie',
              poster_path: '/another.jpg',
              release_date: '2025-01-01',
            },
          ],
          crew: [],
        },
      });
    if (path.endsWith('/movie/43')) {
      await ready;
      return r.fulfill({
        json: {
          id: 43,
          title: 'Another Movie',
          poster_path: '/another.jpg',
          backdrop_path: '/backdrop-43.jpg',
          release_date: '2025-01-01',
          recommendations: { results: [] },
        },
      });
    }
    return r.fulfill({
      json: {
        id: 42,
        title: 'The Movie',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        release_date: '2026-01-01',
        credits: { cast: [{ id: 7, name: 'An Actor', profile_path: '/actor.jpg' }] },
        recommendations: { results: [] },
      },
    });
  });
  // Which named pictures each View Transition animated, and any it threw.
  await page.addInitScript(() => {
    window.morphs = [];
    window.transitionErrors = [];
    const start = document.startViewTransition?.bind(document);
    if (start)
      document.startViewTransition = (update) => {
        const transition = start(update);
        transition.ready
          .then(() =>
            window.morphs.push(
              document
                .getAnimations()
                .map((a) => a.effect?.pseudoElement ?? '')
                .some((p) => p === '::view-transition-group(den-hero-media)'),
            ),
          )
          .catch((e) => window.transitionErrors.push(String(e)));
        window.lastTransition = transition.finished.catch(() => {});
        return transition;
      };
  });
  await page.addInitScript(() => history.replaceState(null, '', '/movie/42'));
  await page.goto('http://127.0.0.1:5198/test/actual-routes.html');
  await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
  const card = page
    .locator('[data-active="true"]')
    .getByRole('link', { name: /^Another Movie/ })
    .first();
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('img')).toBeVisible();
  return { card, release };
}

// Opening a title from a row while TMDB has yet to answer: the title's own page shows at once, as its skeleton,
// rather than the page just left being held over it under a spinner until the answer comes.
test('a title opens on its own skeleton, with no cover of the page it was opened from', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const { card, release } = await setup(page);
  // Any cover at all, however briefly, is what this guards against.
  await page.evaluate(() => {
    window.covered = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-loading-snapshot]')) window.covered = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await card.tap();
  const loading = page.locator('[data-active="true"] [aria-label="Loading title"]');
  await expect(loading).toHaveCount(1);
  await expect(page.locator('[data-loading-snapshot]')).toHaveCount(0);
  // The hero stands in with the very poster the card was showing, which needs no request, so no spinner.
  await expect(loading.locator('img.seed-still')).toHaveAttribute(
    'src',
    'https://image.tmdb.org/t/p/w342/another.jpg',
  );
  await expect(loading.locator('.spinner')).toHaveCount(0);
  release();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('Another Movie');
  expect(await page.evaluate(() => window.covered)).toBe(false);
  await page.close();
});

// The pressed poster flies into the hero; from then until the trailer, the hero's box and every picture in it keep
// their size, place and scale — the backdrop only fades in over the placeholder. Back flies it home to the card.
test('a pressed poster morphs into the hero, which then never resizes or rescales; Back reverses it', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const { card, release } = await setup(page);
  await card.tap();
  await expect(page).toHaveURL(/\/movie\/43/);
  await page.evaluate(() => window.lastTransition);
  // Every frame from here: the hero's box, and each picture's box, transform and fit.
  await page.evaluate(() => {
    window.frames = [];
    const loop = () => {
      const visual = document.querySelector(
        '[data-route-page][data-active="true"] [data-morph-hero]',
      );
      if (visual) {
        const box = visual.getBoundingClientRect();
        window.frames.push({
          box: [box.x, box.y, box.width, box.height].map(Math.round).join(','),
          pictures: [...visual.querySelectorAll('img')].map((el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return {
              kind: el.className.split(' ').find((c) => !c.startsWith('svelte-')),
              rect: [r.x, r.y, r.width, r.height].map(Math.round).join(','),
              transform: s.transform,
              fit: s.objectFit,
              position: s.objectPosition,
            };
          }),
        });
      }
      if (window.frames.length < 400) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.waitForTimeout(300);
  release();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('Another Movie');
  await expect(page.locator('[data-active="true"] img.backdrop.shown')).toHaveCount(1);
  await page.waitForTimeout(400);
  const frames = await page.evaluate(() => window.frames);
  expect(frames.length).toBeGreaterThan(20);
  expect(new Set(frames.map((f) => f.box)).size, 'the hero box never changes').toBe(1);
  const looks = new Map();
  for (const f of frames)
    for (const p of f.pictures) {
      const look = `${p.rect} ${p.transform} ${p.fit} ${p.position}`;
      (looks.get(p.kind) ?? looks.set(p.kind, new Set()).get(p.kind)).add(look);
    }
  for (const [kind, seen] of looks)
    expect([...seen], `${kind} keeps its size, place and scale`).toHaveLength(1);

  // The card stays where the viewer left it, its row still filled, while the title is in front.
  await expect(page.locator('[data-active="false"] a.card[href^="/movie/43"]')).toHaveCount(1);
  await page.goBack();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
  await page.evaluate(() => window.lastTransition);
  expect(await page.evaluate(() => window.morphs)).toEqual([true, true]);
  expect(await page.evaluate(() => window.transitionErrors)).toEqual([]);
  await page.close();
});

// A poster tapped while the page is still scrolling under the finger's last fling: the title opens at its top and
// stays there, rather than carrying on the glide that was moving the page it came from.
test('a poster tapped mid-scroll opens its title at the top, and Back returns to where the page was', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const { card, release } = await setup(page);
  release();
  // Room to scroll on both pages, and the poster somewhere down the first.
  await page.evaluate(() => (document.body.style.paddingBottom = '3000px'));
  await card.scrollIntoViewIfNeeded();
  const left = await page.evaluate(() => scrollY);
  expect(left).toBeGreaterThan(0);
  // The glide a fling leaves running: the page keeps moving, frame after frame, with no new touch, while the
  // poster is tapped. It went on moving the document once the title had replaced the page, which opened partway
  // down. It runs until ten frames after the title is the page in front.
  await page.evaluate(() => {
    // Where the page was as it was left: where Back must bring it.
    addEventListener('click', () => (window.leftAt = scrollY), { capture: true, once: true });
    let after = 0;
    window.glided = new Promise((done) => {
      const glide = () => {
        scrollBy({ top: 8, behavior: 'instant' });
        const title = document.querySelector('[data-route-page][data-active="true"] h1');
        if (title?.textContent === 'Another Movie') after++;
        if (after < 10) requestAnimationFrame(glide);
        else done();
      };
      requestAnimationFrame(glide);
    });
  });
  await card.tap();
  await page.evaluate(() => window.glided);
  await expect(page.locator('[data-active="true"] h1')).toHaveText('Another Movie');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => scrollY), 'the title stays at its top').toBe(0);
  // A new touch is the viewer's own scrolling again.
  await page.touchscreen.tap(200, 700);
  await page.evaluate(() => scrollTo(0, 300));
  expect(await page.evaluate(() => scrollY)).toBe(300);

  await page.goBack();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => scrollY), 'Back returns to where the page was').toBe(
    await page.evaluate(() => window.leftAt),
  );
  await page.close();
});

/** The rings a poster card draws: the link's own, the artwork's, and whether the row cuts the artwork's off. */
const rings = (card) =>
  card.evaluate((link) => {
    const art = link.querySelector('.art');
    const ring = getComputedStyle(art);
    const box = art.getBoundingClientRect();
    const track = link.closest('.track').getBoundingClientRect();
    const offset = parseFloat(ring.outlineOffset);
    const reach = Math.max(0, offset + parseFloat(ring.outlineWidth));
    return {
      visible: link.matches(':focus-visible'),
      link: getComputedStyle(link).outlineStyle,
      art: ring.outlineStyle,
      clipped: box.top - reach < track.top || box.bottom + reach > track.bottom,
    };
  });

test('a poster card shows one unclipped ring for the keyboard, and none after a tap and Back', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const { card, release } = await setup(page);
  release();
  // Reached by the keyboard.
  await page.keyboard.press('Shift');
  await card.focus();
  expect(await rings(card)).toEqual({ visible: true, link: 'none', art: 'solid', clipped: false });

  // Tapped, opened, and come back to: focus returns to the card, but no ring, since no key was pressed.
  await card.tap();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('Another Movie');
  await page.goBack();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
  await page.evaluate(() => window.lastTransition);
  await expect.poll(() => card.evaluate((link) => document.activeElement === link)).toBe(true);
  expect(await rings(card)).toMatchObject({ visible: false, art: 'none' });
  await page.close();
});
