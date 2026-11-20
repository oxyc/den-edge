// A saved page language and subtitle choice are read on the first frame, from startup policy. Deferred policy
// (mutations, delivery) loads later and may take a while on a slow phone; until it does, a library that had changed
// either setting used to read as English with subtitles explicitly Off, and a title played then started without the
// subtitle it should have had.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

test('a saved language and Automatic subtitles read correctly before deferred policy loads', async ({
  page,
}) => {
  const edge = newEdge();
  await routeGuestEdge(page, edge);
  await routeTmdb(page, (route) =>
    route.fulfill({ json: { page: 1, total_pages: 1, results: [] } }),
  );
  await page.goto(`${ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? 'null')?.[0]?.guest),
      { timeout: 30_000 },
    )
    .toBe(true);

  const batch = (response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/batch');
  const changes = (response) => new URL(response.url()).pathname.endsWith('/changes');
  await Promise.all([
    page.waitForResponse(changes, { timeout: 30_000 }),
    page.goto(`${ORIGIN}/settings`),
  ]);
  const subtitles = page.locator('#subtitle-language select');
  const language = page.locator('#interface-language select');
  // Opening the library also checks this device in: one `set:devices` write, a second after the first reads settle
  // (RoutedLibrary). When the invite page left before its own check-in, that write lands on this page, and in CI it
  // was still kept unsent at the reload below (a fourth batch, started 23 ms after it). Any kept work makes the next
  // Worker replay it before it opens, which needs deferred policy: Settings then never drew. Let the check-in finish
  // first: this device listed, and nothing waiting to sync.
  await page.locator('#linked-devices > button.row').click();
  await expect(page.locator('#linked-devices .device-self')).toBeVisible({ timeout: 30_000 });
  await page.locator('#diagnostics > button.row').click();
  await expect(
    page.locator('#diagnostics-panel dl > div', { hasText: 'Waiting to sync' }).locator('dd'),
  ).toHaveText('Nothing', { timeout: 30_000 });
  // Swedish, then back to Automatic: the stored row now holds the cleared subtitle keys, which only den-core reads.
  for (const [select, value] of [
    [subtitles, 'sv'],
    [subtitles, '__automatic'],
    [language, 'sv'],
  ]) {
    await expect(select).toBeEnabled({ timeout: 30_000 });
    const [saved] = await Promise.all([
      page.waitForResponse(batch, { timeout: 30_000 }),
      select.selectOption(value),
    ]);
    expect(saved.ok()).toBe(true);
  }

  // A successful response is observed before the command has removed its durable pending-work record. Settings
  // stays disabled until that cleanup has finished; reloading earlier can make the next Worker correctly ask for
  // deferred policy to replay the last write, which defeats the startup-only state this test means to exercise.
  await expect(language).toBeEnabled({ timeout: 30_000 });

  // What the reloaded page draws first is the saved Settings view this browser keeps, and that view is written behind
  // the edits (a debounced writer): under load the reload overtook the last two, and Settings drew the Swedish
  // subtitle the first edit had saved. Reading the view back is the only way to know it holds the edits, since nothing
  // else may reconcile it here.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { indexedVault } = await import('/src/lib/localVault.ts');
          const { readFinishedLibraryViews } = await import('/src/lib/finishedLibraryViews.ts');
          const [{ libraryKey }] = JSON.parse(localStorage.getItem('den.links'));
          const views = await readFinishedLibraryViews(libraryKey, indexedVault(indexedDB), [
            'settings',
          ]);
          const saved = views?.pieces.settings?.preferences;
          return (
            saved && {
              interfaceLanguage: saved.interfaceLanguage,
              subtitleLanguage: saved.subtitleLanguage,
              explicitSubtitle: !!saved.hasExplicitSubtitlePreference,
            }
          );
        }),
      { timeout: 30_000 },
    )
    .toEqual({ interfaceLanguage: 'sv', subtitleLanguage: undefined, explicitSubtitle: false });

  // Deferred policy never arrives from here on, in the page or its library Worker: its request is left unanswered.
  await page.route('**/den_core_deferred_bg.wasm', () => {});
  // What the page draws now comes from this browser's own copy; a pull may wait on deferred policy, so none is awaited.
  await page.reload();
  const startupSubtitles = page.locator('#subtitle-language select');
  const startupLanguage = page.locator('#interface-language select');
  const loading = page.locator('.settings-load[role="status"]');
  await expect(loading).toBeVisible({ timeout: 30_000 });
  await expect(loading).toHaveText('Läser in dina inställningar...');
  const playbackInputs = page.locator('#playback select, #playback input');
  await expect(playbackInputs).toHaveCount(6);
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => input.disabled)))
    .toBe(true);
  await expect(
    page.locator('#content, #connections, #sharing, #assistants, #import, #advanced'),
  ).toHaveCount(0);
  await expect(startupSubtitles).toHaveValue('__automatic', {
    timeout: 30_000,
  });
  await expect(startupSubtitles).toBeDisabled();
  await expect(startupLanguage).toHaveValue('sv');
  await expect(startupLanguage).toBeDisabled();
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
});
