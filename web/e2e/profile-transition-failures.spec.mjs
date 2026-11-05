// Profile activity libraries through the real app, DedicatedWorker authority and IndexedDB persistence. The only
// injected boundary is a Worker transport failure/hold on the newly selected profile; household PIN verification,
// the coordinator, mounted gate/switcher and durable active marker are production paths.
import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const installProfileWorkerControl = (page) =>
  page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.denProfileWorkerFault = 'none';
    window.denProfileWorkerFailures = 0;
    window.Worker = class extends NativeWorker {
      #hold = false;

      constructor(url, options) {
        super(url, options);
        if (
          !/\/libraryServiceWorker(?:\.ts|-[\w-]+\.js)$/.test(new URL(url, location.href).pathname)
        )
          return;
        const fault = window.denProfileWorkerFault;
        this.#hold = fault === 'hold';
        if (fault === 'fail') {
          window.denProfileWorkerFailures += 1;
          queueMicrotask(() =>
            this.dispatchEvent(
              new ErrorEvent('error', { message: 'fixture rejected the profile Worker open' }),
            ),
          );
        }
      }

      postMessage(message, ...rest) {
        if (this.#hold && message?.type === 'hello') return;
        return super.postMessage(message, ...rest);
      }
    };
  });

async function makeProtectedHousehold(page, edge) {
  await routeGuestEdge(page, edge);
  await page.goto(`${E2E_ORIGIN}/`);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await page.goto(`${E2E_ORIGIN}/movie/1002`);
  await expect(page.getByRole('button', { name: 'Watchlist', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
  const owner = page.getByRole('button', { name: 'Switch profile, current Owner' });
  await expect(owner).toBeVisible({ timeout: 30_000 });
  await owner.click();
  await page.getByRole('button', { name: 'Use Kids' }).click();
  await page.getByLabel('New Owner PIN').fill('1234');
  await page.getByLabel('Confirm Owner PIN').fill('1234');
  await expect(page.getByRole('button', { name: 'Switch profile, current Kids' })).toBeVisible({
    timeout: 30_000,
  });
}

const marker = (page) => page.evaluate(() => localStorage.getItem('den.profile.active.v1'));

test('profile open failures stay retryable, preserve selection, and commit only a ready Worker', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Worker fault injection is covered once; package builds cover TV engines.',
  );
  test.setTimeout(180_000);
  const edge = newEdge({ profiles: true });
  await installProfileWorkerControl(page);
  await makeProtectedHousehold(page, edge);
  const household = [...edge.libraries].find(([, library]) => library.wireMin === 5)?.[0];
  const profileLibraries = [...edge.libraries.keys()].filter((id) => id !== household);
  const kidLibrary = [...edge.libraryRequests]
    .reverse()
    .find(({ id, action }) => action === 'changes' && profileLibraries.includes(id))?.id;
  const ownerLibrary = profileLibraries.find((id) => id !== kidLibrary);
  expect(household).toBeTruthy();
  expect(kidLibrary).toBeTruthy();
  expect(ownerLibrary).toBeTruthy();

  // With no marker, the mounted Owner gate first proves the wrong-PIN control. A correct PIN then reaches a real
  // profile Worker whose two bounded startup generations fail, and must be classified as unavailable, not denied.
  await page.evaluate(() => localStorage.removeItem('den.profile.active.v1'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Owner access' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel('Owner PIN').fill('0000');
  await expect(page.getByRole('alert')).toHaveText('That PIN didn’t match.');
  expect(await marker(page)).toBeNull();

  await page.evaluate(() => (window.denProfileWorkerFault = 'fail'));
  const ownerHead = edge.libraries.get(ownerLibrary).head;
  await page.getByLabel('Owner PIN').fill('1234');
  await expect(page.getByRole('alert')).toHaveText('Owner couldn’t be opened. Try again.', {
    timeout: 30_000,
  });
  expect(await marker(page)).toBeNull();
  expect(edge.libraries.get(ownerLibrary).head).toBe(ownerHead);
  expect(await page.evaluate(() => window.denProfileWorkerFailures)).toBeGreaterThanOrEqual(2);

  await page.evaluate(() => (window.denProfileWorkerFault = 'none'));
  await page.getByLabel('Owner PIN').fill('1234');
  const owner = page.getByRole('button', { name: 'Switch profile, current Owner' });
  await expect(owner).toBeVisible({ timeout: 30_000 });
  const ownerMarker = await marker(page);
  expect(JSON.parse(ownerMarker)).toMatchObject({ version: 1, mode: 'persistent' });

  // Owner -> Kid asks for no PIN. The same real Worker rejection must therefore be a visible switch failure while
  // Owner and its durable marker stay authoritative; restoring the transport lets the same screen retry.
  await owner.click();
  await page.evaluate(() => (window.denProfileWorkerFault = 'fail'));
  const kidHead = edge.libraries.get(kidLibrary).head;
  await page.getByRole('button', { name: 'Use Kids' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'The profile switch couldn’t be completed. Try again.',
    { timeout: 30_000 },
  );
  await expect(owner).toBeVisible();
  expect(await marker(page)).toBe(ownerMarker);
  expect(edge.libraries.get(kidLibrary).head).toBe(kidHead);

  await page.evaluate(() => (window.denProfileWorkerFault = 'none'));
  await page.getByRole('button', { name: 'Use Kids' }).click();
  const kids = page.getByRole('button', { name: 'Switch profile, current Kids' });
  await expect(kids).toBeVisible({ timeout: 30_000 });
  const kidMarker = await marker(page);
  expect(kidMarker).not.toBe(ownerMarker);

  await page.reload();
  await expect(kids).toBeVisible({ timeout: 30_000 });
  expect(await marker(page)).toBe(kidMarker);
});

test('disposing a stale real profile Worker publishes no session or marker', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Worker fault injection is covered once; package builds cover TV engines.',
  );
  test.setTimeout(180_000);
  const edge = newEdge({ profiles: true });
  await installProfileWorkerControl(page);
  await makeProtectedHousehold(page, edge);

  const kids = page.getByRole('button', { name: 'Switch profile, current Kids' });
  await kids.click();
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await page.getByLabel('Owner PIN').fill('1234');
  const owner = page.getByRole('button', { name: 'Switch profile, current Owner' });
  await expect(owner).toBeVisible({ timeout: 30_000 });
  const ownerMarker = await marker(page);

  await owner.click();
  await page.evaluate(() => (window.denProfileWorkerFault = 'hold'));
  const useKids = page.getByRole('button', { name: 'Use Kids' });
  await useKids.click();
  await expect(useKids).toBeDisabled();
  // App teardown closes the held model. The new document starts from the still-committed Owner marker, with no stale
  // Kid publication and no credential/failure alert carried across the disposal.
  await page.reload();
  await expect(owner).toBeVisible({ timeout: 30_000 });
  expect(await marker(page)).toBe(ownerMarker);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
