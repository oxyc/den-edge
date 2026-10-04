import { guardNetwork } from './network.mjs';
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

// A tab open since before a release can dynamically import a chunk den-edge no longer has — Vite's own preload
// helper reports that as `vite:preloadError` (`main.ts`), whichever row, dialog or screen asked for it. Deferring
// recovery to the next navigation, as a merely-newer release does, would leave that visit finishing the page
// it's already on half-drawn. `recoverChunkFailure` (`release.ts`) reloads at once instead, whenever nothing on
// screen would be lost, so the very next load — this release's own shell and chunks — renders the whole page
// rather than the gap the missing one left.
test('a missing chunk reloads onto a fully rendered page instead of staying half-drawn', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.goto(`${E2E_ORIGIN}/test/router.html`);
  const active = page.locator('[data-route-page][data-active="true"]');
  await active.getByText('Details', { exact: true }).waitFor();

  // Only a real reload clears this; `recoverChunkFailure` deferring (as it would scrolled, or with something
  // playing) would leave it standing.
  await page.evaluate(() => {
    window.denSameDocument = true;
  });

  await Promise.all([
    page.waitForLoadState('load'),
    page
      .evaluate(async () => {
        const { recoverChunkFailure } = await import('/src/lib/release.ts');
        recoverChunkFailure();
      })
      // The reload tears the page down mid-call; that rejection is the proof it fired, not a failure.
      .catch(() => undefined),
  ]);

  // The page that loaded next is whole, not stuck on whatever was missing when the chunk failed.
  await active.getByText('Details', { exact: true }).waitFor();
  expect(await page.evaluate(() => window.denSameDocument)).toBeUndefined();
});
