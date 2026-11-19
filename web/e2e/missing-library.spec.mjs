// A paired library whose log den-edge doesn't hold, under `NEW_LIBRARIES=members`: the production RoutedLibrary and
// Worker, with den-edge refusing to start the library (`403 new_libraries_closed`).
import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { routeLibraryEdge } from './library-edge.mjs';

const ROUTED_FIXTURE = `${E2E_ORIGIN}/test/live-position.html`;
const NOTICE =
  'This device’s library isn’t on Den. Your changes are kept here—join your household’s library in Settings › Linked devices.';

let captured = [];
test.afterEach(async ({}, info) => {
  await info.attach('capture.txt', { body: captured.join('\n') });
});

async function openTitle(page, id) {
  await page.goto(ROUTED_FIXTURE);
  await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible();
  await page.evaluate(
    (path) => document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path } })),
    `/movie/${id}`,
  );
  await expect(page.getByRole('heading', { name: `Movie ${id}`, level: 1 })).toBeVisible();
}

test('a library den-edge will not start keeps the edit, hands off to Linked devices, and clears once the log exists', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const edge = { missing: true };
  const log = (captured = []);
  const t0 = Date.now();
  page.on('worker', (w) => stamp(`worker ${w.url()}`));
  const stamp = (line) => log.push(`${Date.now() - t0} ${line}`);
  page.on('console', (m) => stamp(`console.${m.type()} ${m.text()}`));
  page.on('pageerror', (e) => stamp(`pageerror ${e.message}`));
  page.on('request', (r) => stamp(`req ${r.method()} ${r.url()}`));
  page.on('requestfailed', (r) => stamp(`reqfailed ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => stamp(`res ${r.status()} ${r.url()}`));
  await routeLibraryEdge(page, edge);
  edge.trace = log;
  const reads = () => edge.libraryRequests.filter(({ path }) => path.endsWith('/changes')).length;
  // One maintenance pass: going back online schedules one at once, and its read is what den-edge sees of it.
  const maintenancePass = async () => {
    const before = reads();
    await context.setOffline(true);
    await context.setOffline(false);
    await expect.poll(reads, { timeout: 45_000 }).toBeGreaterThan(before);
  };

  await openTitle(page, 1500);
  const love = page.getByRole('button', { name: 'Love', exact: true });
  stamp('CLICK love');
  await love.click();

  const alert = page.getByRole('alert');
  try {
    await expect(alert).toContainText(NOTICE);
  } catch (error) {
    await test.info().attach('capture.txt', { body: log.join('\n') });
    throw error;
  }
  await expect(alert).not.toContainText('Waiting to sync');
  // Receipt setup fails for the same reason; its Try again cannot succeed, so it must not stand beside the notice.
  await expect(page.getByText('Saved playback progress couldn’t be updated')).toHaveCount(0);
  const action = alert.getByRole('button', { name: 'Open Linked devices' });
  await expect(action).toBeVisible();
  // The edit is kept on this device and still shown.
  await expect(love).toHaveAttribute('aria-pressed', 'true');
  expect(edge.refusedStarts).toBeGreaterThan(0);
  const missing = edge.libraryRequests.find(({ path }) => path.endsWith('/batch')).libraryId;

  // Two passes later nothing was sent again: the second pass's read starts only after the first pass's replay ended.
  const refusedStarts = edge.refusedStarts;
  const batches = edge.batches;
  await maintenancePass();
  await maintenancePass();
  expect(edge.batches, 'no batch within the ten-minute re-check').toBe(batches);
  expect(edge.refusedStarts).toBe(refusedStarts);
  await expect(alert).toContainText(NOTICE);

  // Relaunched, the kept edit is still there and the same notice comes back.
  await openTitle(page, 1500);
  await expect(love).toHaveAttribute('aria-pressed', 'true');
  await expect(alert).toContainText(NOTICE);

  // The action opens Linked devices, where the household's library is joined. It joins, creates and resets nothing.
  const requestsBefore = edge.libraryRequests.length;
  await action.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/settings');
  const linkedDevices = page.locator('#linked-devices > .row');
  await expect(linkedDevices).toHaveAttribute('aria-expanded', 'true');
  await expect(linkedDevices).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Join another library' })).toBeVisible();
  const since = edge.libraryRequests.slice(requestsBefore);
  expect(
    since.filter(({ libraryId, method }) => libraryId !== missing || method === 'DELETE'),
    'no other library is started or joined, and nothing is reset',
  ).toEqual([]);

  // Another device of the household writes the log: the next read finds it, the notice clears, and the kept edit goes.
  const refusedBeforeRecovery = edge.refusedStarts;
  const batchesBeforeRecovery = edge.batches;
  edge.missing = false;
  await maintenancePass();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => edge.batches).toBeGreaterThan(batchesBeforeRecovery);
  expect(edge.refusedStarts).toBe(refusedBeforeRecovery);
});
