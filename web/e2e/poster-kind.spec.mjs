import { chromium, expect, test, webkit } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

async function installTmdbFixture(context, atlas) {
  const page = await context.newPage();
  await page.goto(`${E2E_ORIGIN}/worker-network-fixture.html`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/worker-network-fixture.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate(
    (enabled) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = resolve;
        navigator.serviceWorker.controller.postMessage({ type: 'configure', atlas: enabled }, [
          channel.port2,
        ]);
      }),
    atlas,
  );
  const requests = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) => resolve(event.data);
          navigator.serviceWorker.controller.postMessage('network-requests', [channel.port2]);
        }),
    );
  return { page, requests };
}

/**
 * Home at phone width on a library whose watchlist holds a film and two series, under a stand-in TMDB whose lists carry one
 * series the library does not hold. TMDB's list answers have no season counts, so that one says only "Series".
 *
 * With `atlas`, atlas is there too, and its "New on Netflix" charts lead New Releases with what just landed on
 * Netflix: Series 2005 (held, so its layout is known), a series the library does not hold, and a film.
 */
async function openHome(browser, { atlas = false, workerMode = 'shared' } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  // Exercise both transports in Chromium. WebKit keeps rendering coverage on the in-page fallback: unlike a
  // context-owned Service Worker, Playwright's route API cannot observe either kind of WebKit worker request.
  if (workerMode !== 'shared')
    await context.addInitScript((mode) => {
      Object.defineProperty(globalThis, 'SharedWorker', { value: undefined });
      if (mode === 'inline') Object.defineProperty(globalThis, 'Worker', { value: undefined });
    }, workerMode);
  // The catch-all is registered first. The fixture Service Worker then owns TMDB at the browser-context origin, so
  // page, Worker and SharedWorker requests all receive the same finite pager before the app page exists.
  await guardNetwork(context);
  const { page, requests: tmdbRequests } = await installTmdbFixture(context, atlas);
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&series-kinds${atlas ? '&services' : ''}`,
  );
  return { page, tmdbRequests };
}

for (const [name, slug, engine, workerMode] of [
  ['Chromium SharedWorker', 'chromium-shared', chromium, 'shared'],
  ['Chromium Worker', 'chromium-worker', chromium, 'worker'],
  ['WebKit', 'webkit', webkit, 'inline'],
]) {
  test(`a poster's year line tells a series from a film at phone width in ${name}`, async () => {
    const browser = await engine.launch(
      engine === chromium
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      const { page, tmdbRequests } = await openHome(browser, { workerMode });
      const line = (title) =>
        page
          .locator('a.card', { has: page.locator('.name', { hasText: title }) })
          .first()
          .locator('.caption');
      const watchlist = page.getByRole('region', { name: 'Watchlist', exact: true });
      await expect(watchlist.locator('.name')).toHaveText([
        'Series 2005',
        'Series 2004',
        'Movie 1002',
      ]);
      // A film is its year alone; a series the library holds counts its seasons, or its only season's episodes.
      await expect(line('Movie 1002')).toHaveText('2019');
      await expect(line('Series 2005')).toHaveText('2019 · 4 seasons');
      await expect(line('Series 2004')).toHaveText('2019 · 12 episodes');
      // The longest of them fits its card: cut short with an ellipsis, never wrapped onto a third line.
      const caption = line('Series 2005');
      const fits = await caption.evaluate((node) => ({
        overflow: getComputedStyle(node).textOverflow,
        lines: Math.round(
          node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight),
        ),
      }));
      expect(fits).toEqual({ overflow: 'ellipsis', lines: 1 });
      // The element's own scroll: Playwright's leaves WebKit's window where it is.
      const reveal = (region) =>
        region.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await reveal(watchlist);
      await page.screenshot({ path: test.info().outputPath(`poster-kind-${slug}-library.png`) });

      // A series from a TMDB list, whose layout nothing here holds, says only that it is one. Its row mounts its
      // cards as it nears the screen.
      const row = page.getByRole('region', {
        name: 'Because you added Series 2005 to your Watchlist',
      });
      const films = page.getByRole('region', { name: 'Because you watched Movie 1005' });
      await reveal(films);
      await expect(films.locator('.caption')).toHaveText(['2019']);
      const recommendation = films.locator('h2 .heading-link');
      await recommendation.focus();
      const ring = await recommendation.evaluate((node) => {
        const heading = node.closest('h2').getBoundingClientRect();
        const link = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          offset: style.outlineOffset,
          ringRight: link.right + parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
          clipRight: heading.right,
        };
      });
      expect(ring.offset).toBe('-3px');
      expect(ring.ringRight).toBeLessThanOrEqual(ring.clipRight + 0.5);
      await reveal(row);
      await expect(row.locator('.caption')).toHaveText(['2019 · Series']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      const network = await tmdbRequests();
      const requests = network.requests;
      expect(network.unexpected, 'all worker-owned requests must be mocked').toEqual([]);
      expect(
        requests.length,
        'worker-owned TMDB traffic reached the context fixture',
      ).toBeGreaterThan(0);
      expect(
        Math.max(
          1,
          ...requests.map((request) =>
            Number(new URL(request, E2E_ORIGIN).searchParams.get('page') ?? 1),
          ),
        ),
        'the first empty page ends every worker-owned TMDB pager',
      ).toBeLessThanOrEqual(2);
      await page.screenshot({ path: test.info().outputPath(`poster-kind-${slug}-rows.png`) });
    } finally {
      await browser.close();
    }
  });

  test(`a card named by its service still tells a series from a film at phone width in ${name}`, async () => {
    const browser = await engine.launch(
      engine === chromium
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      const { page, tmdbRequests } = await openHome(browser, { atlas: true, workerMode });
      // The services' names come from their directory, asked for as the Services rail nears the screen: scrolled
      // past on the way down, as a viewer would.
      const services = page.getByRole('region', { name: 'Services', exact: true });
      await services.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      const netflix = services.getByRole('link', { name: 'Netflix' });
      await expect(netflix).toBeVisible();
      await netflix.focus();
      await expect(netflix).toHaveCSS('outline-style', 'none');
      await expect(netflix.locator('.art')).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
      await expect(netflix.locator('.art')).toHaveCSS('outline-width', '3px');
      // What just landed on Netflix leads New Releases, each card named by the service in place of its year.
      const row = page.getByRole('region', { name: 'New Releases', exact: true });
      const line = (title) =>
        row
          .locator('a.card', { has: page.locator('.name', { hasText: title }) })
          .locator('.caption');
      // Rows above it settle as they load, so it is brought back on screen until its cards mount.
      await expect(async () => {
        await row.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await expect(line('Charted movie')).toBeAttached({ timeout: 500 });
      }).toPass();
      // A film stays "Netflix"; a series says it is one, with its seasons where the library holds its layout.
      await expect(line('Charted movie')).toHaveText('Netflix');
      await expect(line('Series 2005')).toHaveText('Netflix · 4 seasons');
      await expect(line('Charted series')).toHaveText('Netflix · Series');
      // A TMDB title in the same row has no service and keeps its year line.
      await expect(line('Unheld movie')).toHaveText('2019');

      const fits = await line('Series 2005').evaluate((node) => ({
        overflow: getComputedStyle(node).textOverflow,
        lines: Math.round(
          node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight),
        ),
      }));
      expect(fits).toEqual({ overflow: 'ellipsis', lines: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      const network = await tmdbRequests();
      const requests = network.requests;
      expect(network.unexpected, 'all worker-owned requests must be mocked').toEqual([]);
      expect(
        requests.length,
        'worker-owned TMDB traffic reached the context fixture',
      ).toBeGreaterThan(0);
      expect(
        Math.max(
          1,
          ...requests.map((request) =>
            Number(new URL(request, E2E_ORIGIN).searchParams.get('page') ?? 1),
          ),
        ),
        'the first empty page ends every worker-owned TMDB pager',
      ).toBeLessThanOrEqual(2);
      await page.screenshot({ path: test.info().outputPath(`poster-kind-${slug}-service.png`) });
    } finally {
      await browser.close();
    }
  });
}
