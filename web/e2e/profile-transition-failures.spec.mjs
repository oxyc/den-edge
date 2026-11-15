// Profile activity libraries through the real app, DedicatedWorker authority and IndexedDB persistence. Injected
// faults stay at the Worker transport: opening can fail/hold, a recovery answer can be unavailable, and one terminal
// answer can be lost after the real Vault commit. PIN verification, durable work, coordinator, UI and reload are real.
import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const installProfileWorkerControl = (page) =>
  page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.denProfileWorkerFault = 'none';
    window.denProfileWorkerFailures = 0;
    window.denProfileTaskFault = 'none';
    window.denProfileTaskOperations = [];
    window.denProfileWorkerLostReplies = 0;
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
        if (message?.type === 'task' && message.task?.kind?.startsWith('profile.create'))
          window.denProfileTaskOperations.push({
            kind: message.task.kind,
            operationId: message.operationId,
            requestId: message.requestId,
          });
        return super.postMessage(message, ...rest);
      }

      addEventListener(type, listener, options) {
        if (type !== 'message' || typeof listener !== 'function')
          return super.addEventListener(type, listener, options);
        return super.addEventListener(
          type,
          (event) => {
            if (!Array.isArray(event.data)) return listener.call(this, event);
            const delivered = [];
            for (const message of event.data) {
              if (
                window.denProfileTaskFault === 'fail-resume' &&
                message?.type === 'task-result' &&
                message.result?.kind === 'profile.create.resume'
              ) {
                delivered.push({
                  type: 'error',
                  protocol: message.protocol,
                  requestId: message.requestId,
                  error: {
                    code: 'unavailable',
                    message: 'fixture lost the ready recovery answer',
                    retryable: true,
                  },
                });
                continue;
              }
              if (
                window.denProfileTaskFault === 'lose-create-reply' &&
                message?.type === 'task-result' &&
                message.result?.kind === 'profile.create' &&
                message.result?.outcome === 'created'
              ) {
                window.denProfileWorkerLostReplies += 1;
                continue;
              }
              delivered.push(message);
            }
            if (delivered.length)
              listener.call(this, new MessageEvent('message', { data: delivered }));
          },
          options,
        );
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

test('real Worker/Vault creates an additional Kid only after Owner PIN proof and restores it', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'DedicatedWorker/Vault authority is covered once; package builds cover TV engines.',
  );
  test.setTimeout(180_000);
  const edge = newEdge({ profiles: true });
  await installProfileWorkerControl(page);
  await makeProtectedHousehold(page, edge);

  await page.getByRole('button', { name: 'Switch profile, current Kids' }).click();
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await page.getByLabel('Owner PIN').fill('1234');
  const owner = page.getByRole('button', { name: 'Switch profile, current Owner' });
  await expect(owner).toBeVisible({ timeout: 30_000 });

  await owner.click();
  const dialog = page.getByRole('dialog', { name: 'Who’s watching?' });
  await page.evaluate(() => (window.denProfileTaskFault = 'fail-resume'));
  await dialog.getByRole('button', { name: 'Add Kid' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Den couldn’t finish the earlier Kid profile setup. Try again. If this keeps happening, use another linked browser.',
  );
  await page.evaluate(() => (window.denProfileTaskFault = 'none'));
  await page.getByRole('button', { name: 'Try setup again' }).click();
  await page.getByLabel('Kid name').fill('Sam');
  await page.getByLabel('Maximum age').fill('8');
  const before = [...edge.libraries].map(([id, library]) => [id, library.head]);

  await page.getByLabel('Owner PIN').fill('0000');
  await expect(page.getByRole('alert')).toHaveText('That PIN didn’t match.');
  expect([...edge.libraries].map(([id, library]) => [id, library.head])).toEqual(before);

  await page.evaluate(() => (window.denProfileTaskFault = 'lose-create-reply'));
  await page.getByLabel('Owner PIN').fill('1234');
  await expect.poll(() => page.evaluate(() => window.denProfileWorkerLostReplies)).toBe(1);
  expect(edge.libraries.size).toBe(before.length + 1);
  const createOperations = await page.evaluate(() =>
    window.denProfileTaskOperations.filter(({ kind }) => kind === 'profile.create'),
  );
  expect(createOperations).toHaveLength(2);
  expect(createOperations[0].operationId).not.toBe(createOperations[1].operationId);
  expect(
    await page.evaluate(() =>
      window.denProfileTaskOperations.some(({ kind }) => kind === 'profile.create.ack'),
    ),
  ).toBe(false);
  const retainedCreateKeys = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('den-library');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('kept', 'readonly');
          const keys = transaction.objectStore('kept').getAllKeys();
          keys.onerror = () => reject(keys.error);
          keys.onsuccess = () => resolve(keys.result.map(String));
        };
      }),
  );
  expect(retainedCreateKeys.some((key) => key.endsWith(':profile-create/v1/state'))).toBe(true);

  // The real Worker committed the exact operation but its terminal answer never reached the page. Reloading and
  // reopening the production form must recover the durable receipt, republish the directory, and never add a Kid.
  await page.reload();
  await expect(owner).toBeVisible({ timeout: 30_000 });
  await owner.click();
  await dialog.getByRole('button', { name: 'Add Kid' }).click();
  const sam = dialog.getByRole('button', { name: 'Use Sam' });
  await expect(sam).toBeVisible({ timeout: 30_000 });
  await expect(sam).toBeFocused();
  expect(edge.libraries.size).toBe(before.length + 1);

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.denProfileTaskOperations.filter(({ kind }) => kind === 'profile.create.ack')
            .length,
      ),
    )
    .toBe(1);
  await dialog.getByRole('button', { name: 'Add Kid' }).click();
  await expect(page.getByLabel('Kid name')).toHaveValue('');
  await page.getByRole('button', { name: 'Back to profiles' }).click();

  await sam.click();
  await expect(page.getByRole('button', { name: 'Switch profile, current Sam' })).toBeVisible({
    timeout: 30_000,
  });
  const samMarker = await marker(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Switch profile, current Sam' })).toBeVisible({
    timeout: 30_000,
  });
  expect(await marker(page)).toBe(samMarker);
});
