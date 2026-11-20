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
  // TEMP-1184 capture: a timeline of the kept finished-views entries against the writes and the reload.
  const timeline = [];
  const mark = (what) => timeline.push(`${Date.now() % 1_000_000} ${what}`);
  page.on('console', (message) => {
    if (message.text().startsWith('IDBWATCH')) mark(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/batch') || url.pathname.endsWith('/changes'))
      mark(`${response.request().method()} ${url.pathname.split('/').pop()}${url.search} ${response.status()}`);
  });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    let last = '';
    const digest = (value) => {
      if (!value) return 'none';
      const bytes = new Uint8Array(value.buffer ?? value);
      let hash = 0;
      for (const byte of bytes) hash = (hash * 31 + byte) | 0;
      return `${bytes.length}:${hash}`;
    };
    const watch = (db) => {
      db.onversionchange = () => db.close();
      setInterval(() => {
        try {
          const store = db.transaction('kept').objectStore('kept');
          const keys = store.getAllKeys();
          keys.onsuccess = () => {
            const wanted = keys.result.filter((key) =>
              /(:finished-views\.v1|:local-authority\.v1|:runtime:pending:.*)$/.test(String(key)),
            );
            Promise.all(
              wanted.map(
                (key) =>
                  new Promise((done) => {
                    const got = store.get(key);
                    got.onsuccess = () => done(`${String(key).split(':').slice(1).join(':')}=${digest(got.result)}`);
                    got.onerror = () => done('error');
                  }),
              ),
            ).then((parts) => {
              const now = parts.join(' ');
              if (now !== last) {
                last = now;
                console.log(`IDBWATCH ${now}`);
              }
            });
          };
        } catch {}
      }, 20);
    };
    const find = async () => {
      if (!(await indexedDB.databases()).some((db) => db.name === 'den-library'))
        return setTimeout(find, 20);
      const open = indexedDB.open('den-library');
      open.onsuccess = () => watch(open.result);
    };
    void find();
  });
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

  // Deferred policy never arrives from here on, in the page or its library Worker: its request is left unanswered.
  await page.route('**/den_core_deferred_bg.wasm', () => {});
  // What the page draws now comes from this browser's own copy; a pull may wait on deferred policy, so none is awaited.
  mark('RELOAD');
  const index = test.info().repeatEachIndex;
  const printTimeline = async () => {
    const value = await page
      .locator('#subtitle-language select')
      .inputValue({ timeout: 1_000 })
      .catch(() => '?');
    if (value === '__automatic' || value === '?') return;
    mark(`value ${value}`);
    console.log(`TIMELINE-1184 ${index}\n${timeline.join('\n')}`);
  };
  setTimeout(() => void printTimeline(), 8_000);
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
