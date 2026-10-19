import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

const soak = process.env.DEN_TV_SOAK === '1';
const soakMinutes = Number(process.env.DEN_TV_SOAK_MINUTES ?? 30);
if (soak && (!Number.isFinite(soakMinutes) || soakMinutes <= 0 || soakMinutes > 240))
  throw new Error('DEN_TV_SOAK_MINUTES must be between 0 (exclusive) and 240');
// Traces retain every DOM snapshot and distort this resource experiment. Failures still retain screenshots
// and the sample series; the separate restoration regression tests retain their normal traces.
test.use({ trace: 'off', video: 'off' });

test(
  soak
    ? 'TV Home sustained remote browsing @soak'
    : 'real TV Home keeps remote focus and retained resources bounded across repeated visits',
  async ({ page, browserName }, info) => {
    if (soak) test.setTimeout(soakMinutes * 60_000 + 120_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await routeGuestEdge(page, newEdge());
    await page.route('**/atlas/manifest.json', (route) =>
      route.fulfill({
        json: {
          id: 'com.den.atlas',
          catalogs: [{ id: 'popular', type: 'movie', name: 'Popular' }],
        },
      }),
    );
    await page.route('**/atlas/catalog/**', (route) =>
      route.fulfill({
        json: {
          metas: [1002, 1003, 1004].map((id) => ({
            type: 'movie',
            moviedb_id: id,
            name: `Movie ${id}`,
            posterPath: `/poster-${id}.jpg`,
            releaseInfo: '2026',
          })),
        },
      }),
    );
    await page.route('**/atlas/index/**', (route) =>
      route.fulfill({
        json: {
          titles: [1002, 1003, 1004].map((id) => ({
            type: 'movie',
            id,
            title: `Movie ${id}`,
            posterPath: `/poster-${id}.jpg`,
            year: 2026,
          })),
          total: 3,
        },
      }),
    );
    let releaseRecommendations;
    const recommendationsHeld = new Promise((resolve) => (releaseRecommendations = resolve));
    await page.route('**/atlas/recommend**', async (route) => {
      await recommendationsHeld;
      await route.fulfill({
        json: {
          version: 1,
          slides: [
            { type: 'movie', id: 1002 },
            { type: 'movie', id: 1003 },
            { type: 'movie', id: 1004 },
          ],
        },
      });
    });
    await page.goto(E2E_ORIGIN);
    await page.getByRole('button', { name: 'Look around instead' }).click();
    const hero = page.locator('[data-route-page][data-active="true"] .billboard');
    await expect(hero).toHaveAttribute('aria-hidden', 'true');
    await expect(hero).toHaveAttribute('data-loading', 'true');
    const shelfTrack = page.getByRole('region', { name: 'Mind-Bending' }).locator('.track');
    await expect(shelfTrack).toBeAttached({ timeout: 30_000 });
    const beforeRecommendation = await Promise.all([
      hero.evaluate((node) => node.getBoundingClientRect().height),
      shelfTrack.evaluate((node) => node.getBoundingClientRect().top + scrollY),
    ]);
    expect(beforeRecommendation[0]).toBeGreaterThan(700);
    releaseRecommendations();
    await expect(hero).toContainText('Movie 1002', { timeout: 30_000 });
    await expect(hero).not.toHaveAttribute('data-loading', 'true');
    const afterRecommendation = await Promise.all([
      hero.evaluate((node) => node.getBoundingClientRect().height),
      shelfTrack.evaluate((node) => node.getBoundingClientRect().top + scrollY),
    ]);
    expect(afterRecommendation).toEqual(beforeRecommendation);
    await expect(hero.getByRole('heading', { name: 'Movie 1002' })).toBeVisible();
    await expect(hero.locator('.expand')).toHaveCount(0);
    const pager = hero.locator('.pager');
    await expect(pager).toBeVisible();
    await expect(pager.locator('.dot')).toHaveCount(3);
    await expect(pager.getByRole('button')).toHaveCount(0);
    await expect(pager.locator('.dot.on')).toHaveCount(1);
    const [copyBox, dotsBox] = await Promise.all([
      hero.locator('.slide[aria-hidden="false"] .text').boundingBox(),
      pager.locator('.dots').boundingBox(),
    ]);
    expect(copyBox).not.toBeNull();
    expect(dotsBox).not.toBeNull();
    expect(Math.abs(dotsBox.x - copyBox.x)).toBeLessThanOrEqual(1);
    await expect(hero.getByRole('button', { name: /Watchlist|Seen/ })).toHaveCount(0);
    await expect(hero.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
    await shelfTrack.evaluate((track) => track.scrollIntoView({ block: 'center' }));
    await expect(shelfTrack).toBeVisible();
    const shelf = await shelfTrack.evaluate((track) => {
      const box = track.getBoundingClientRect();
      const style = getComputedStyle(track);
      const wrapper = track.closest('.row-window');
      const wrapperBox = wrapper.getBoundingClientRect();
      return {
        width: box.width,
        left: box.left,
        right: box.right,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        firstChildLeft: track.firstElementChild?.getBoundingClientRect().left,
        headingLeft: track.closest('.row')?.querySelector('h2')?.getBoundingClientRect().left,
        wrapperLeft: wrapperBox.left,
        wrapperRight: wrapperBox.right,
      };
    });
    expect(Math.abs(shelf.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(shelf.right - page.viewportSize().width)).toBeLessThanOrEqual(1);
    expect(Number.parseFloat(shelf.paddingLeft)).toBeGreaterThan(0);
    expect(shelf.paddingRight).toBe('0px');
    expect(Math.abs(shelf.firstChildLeft - shelf.headingLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(shelf.wrapperLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(shelf.wrapperRight - page.viewportSize().width)).toBeLessThanOrEqual(1);
    const services = page.getByRole('region', { name: 'Services' });
    if (await services.count()) {
      const [headingBox, firstTileBox] = await Promise.all([
        services.getByRole('heading', { name: 'Services' }).boundingBox(),
        services.locator('.tile, .hold').first().boundingBox(),
      ]);
      expect(headingBox).not.toBeNull();
      expect(firstTileBox).not.toBeNull();
      expect(Math.abs(firstTileBox.x - headingBox.x)).toBeLessThanOrEqual(1);
      const posterHeadingBox = await page
        .getByRole('region', { name: 'Mind-Bending' })
        .getByRole('heading', { name: 'Mind-Bending' })
        .boundingBox();
      expect(posterHeadingBox).not.toBeNull();
      expect(Math.abs(posterHeadingBox.x - headingBox.x)).toBeLessThanOrEqual(1);
    }
    await page.evaluate(() => scrollTo(0, 0));
    // The first enriched recommendation renders before the others. Wait for the real slides before asking
    // the remote to page; an early ArrowRight correctly has nowhere to go and must not be queued speculatively.
    await expect(hero.locator('.slide')).toHaveCount(3);
    const more = hero.getByRole('link', { name: 'More', exact: true });
    await expect(more).toHaveCount(1);
    await expect(hero.locator('.slide[aria-hidden="false"] a')).toHaveCount(1);
    // The billboard is the first content row. Down from Search must enter it, even though a lower service tile
    // happens to have a closer horizontal center and would win a generic geometry-only scan.
    const search = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', {
      name: 'Search',
      exact: true,
    });
    await search.focus();
    await page.keyboard.press('ArrowDown');
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('data-tv-carousel-action', 'hero');
    await page.screenshot({ path: info.outputPath('tv-home.png') });
    const baselineWorkers = page.workers().length;
    const heroPagingMs = [];
    const pageHero = async (key, title) => {
      const heading = hero.getByRole('heading', { name: title });
      await expect(hero.getByRole('link', { name: 'More', exact: true })).toBeFocused();
      const started = performance.now();
      await page.keyboard.press(key);
      await expect(heading).toBeVisible();
      await expect(hero.getByRole('link', { name: 'More', exact: true })).toBeFocused();
      heroPagingMs.push(performance.now() - started);
    };
    const directions = new Set();
    const navigateHero = async (title) => {
      for (let step = 0; step < 3; step++) {
        const slides = await hero.locator('.slide').evaluateAll((nodes) =>
          nodes.map((node, index) => ({
            index,
            // Chromium 87 receives `inert` as an unsupported expando property, not a DOM attribute. The
            // carousel's ARIA state is rendered consistently and is what viewers and accessibility APIs observe.
            active: node.getAttribute('aria-hidden') !== 'true',
            title: node.getAttribute('aria-label'),
          })),
        );
        const current = slides.findIndex((slide) => slide.active);
        const target = slides.findIndex((slide) => slide.title === title);
        expect(current).toBeGreaterThanOrEqual(0);
        expect(target).toBeGreaterThanOrEqual(0);
        if (current === target) return;
        const key = target > current ? 'ArrowRight' : 'ArrowLeft';
        const next = current + (key === 'ArrowRight' ? 1 : -1);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(slides.length);
        expect(slides[next].title).toBeTruthy();
        directions.add(key);
        await pageHero(key, slides[next].title);
      }
      throw new Error(`hero did not reach ${title} through its current slide order`);
    };
    const samples = [];
    const started = performance.now();
    let nextSample = started;
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
    if (cdp) await cdp.send('Performance.enable');
    let cycles = 0;
    const sample = async (final = false) => {
      // Collect only between complete Home/detail/Back journeys. Forced GC makes retained-heap samples
      // comparable; it does not measure natural GC pauses or the resources of physical TV decoders.
      await page.waitForTimeout(2_000);
      if (cdp) await cdp.send('HeapProfiler.collectGarbage');
      const counters = cdp ? await cdp.send('Memory.getDOMCounters') : null;
      const metrics = cdp ? (await cdp.send('Performance.getMetrics')).metrics : [];
      samples.push({
        elapsedMs: performance.now() - started,
        cycles,
        routes: await page.locator('[data-route-page]').count(),
        workers: page.workers().length,
        documentElements: await page.locator('*').count(),
        ...counters,
        heapBytes: metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value ?? null,
      });
      console.log('TV soak sample', JSON.stringify(samples.at(-1)));
      await writeFile(
        info.outputPath('tv-browsing-soak.json'),
        JSON.stringify({ browserName, soakMinutes, cycles, samples }, null, 2),
      );
      if (cdp && process.env.DEN_TV_SOAK_HEAP === '1' && (samples.length === 1 || final)) {
        const chunks = [];
        const collect = ({ chunk }) => chunks.push(chunk);
        cdp.on('HeapProfiler.addHeapSnapshotChunk', collect);
        await cdp.send('HeapProfiler.takeHeapSnapshot');
        cdp.off('HeapProfiler.addHeapSnapshotChunk', collect);
        const name = final ? 'final.heapsnapshot' : 'warm.heapsnapshot';
        const path = info.outputPath(name);
        await writeFile(path, chunks.join(''));
        await info.attach(name, {
          path,
          contentType: 'application/json',
        });
      }
    };
    for (
      let cycle = 0;
      cycle < (cdp ? 200 : 40) || (soak && performance.now() - started < soakMinutes * 60_000);
      cycle++
    ) {
      const titleId = 1002 + (cycle % 3);
      if (cycle > 0) await navigateHero(`Movie ${titleId}`);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/movie/${titleId}(?:-|$)`));
      await expect(page.getByRole('heading', { name: `Movie ${titleId}`, level: 1 })).toBeVisible();
      expect(await page.locator('[data-route-page]').count()).toBeLessThanOrEqual(4);
      if (cycle === 0) await page.screenshot({ path: info.outputPath('tv-detail.png') });
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/$/);
      await expect(more).toBeFocused();
      expect(await page.locator('[data-route-page]').count()).toBeLessThanOrEqual(3);
      expect(page.workers().length).toBeLessThanOrEqual(Math.max(1, baselineWorkers));
      cycles++;
      if ((soak || cdp) && cycles >= 40 && performance.now() >= nextSample) {
        await sample();
        nextSample = performance.now() + 60_000;
      }
      // Give timers, idle tasks and background cleanup real wall-clock time between bursts.
      if (soak && cycles % 40 === 0) await page.waitForTimeout(1_000);
    }
    expect([...directions]).toEqual(expect.arrayContaining(['ArrowLeft', 'ArrowRight']));

    await info.attach('tv-hero-paging-latency.json', {
      body: Buffer.from(JSON.stringify(heroPagingMs, null, 2)),
      contentType: 'application/json',
    });

    expect(errors).toEqual([]);
    if (soak || cdp) {
      await sample(true);
      await info.attach('tv-browsing-soak.json', {
        path: info.outputPath('tv-browsing-soak.json'),
        contentType: 'application/json',
      });
      if (cdp && samples.length >= 2) {
        const first = samples[0];
        const last = samples.at(-1);
        // Broad sustained-growth guards, not a claim of leak freedom. The full time series is retained
        // so changes inside these tolerances remain visible rather than being hidden by a pass/fail flag.
        expect(last.nodes).toBeLessThanOrEqual(first.nodes * 1.25 + 100);
        expect(last.jsEventListeners).toBeLessThanOrEqual(first.jsEventListeners * 1.25 + 20);
        expect(last.heapBytes).toBeLessThanOrEqual(first.heapBytes * 1.5 + 4 * 1024 * 1024);
      }
      await cdp?.detach();
    }
  },
);
