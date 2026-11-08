import { test, expect, chromium } from '@playwright/test';
import { createHash, hkdfSync } from 'node:crypto';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';
import { sharedWorkerBridge } from './shared-worker-bridge.mjs';

const raw = Buffer.alloc(32, 7);
const libraryKey = raw.toString('base64');
const derive = (salt, info, bytes) =>
  Buffer.from(hkdfSync('sha256', raw, Buffer.from(salt), Buffer.from(info), bytes));
const libraryId = derive('den/library/salt/v1', 'den/library/id/v1', 16).toString('hex');
const token = derive('den/library/v2', 'token', 32).toString('hex');
const tokenHash = createHash('sha256').update(token).digest('base64url');
const link = {
  inboxKey: 'deadbeefcafe1234',
  name: 'Living Room TV',
  linkedAt: 4_000,
  libraryKey,
  linkKey: 'fixture',
};
const retirementLock = `den.library.${libraryId}.retirement`;

const keys = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('den-library', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kept');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction('kept', 'readonly');
          const found = transaction.objectStore('kept').getAllKeys();
          transaction.oncomplete = () => {
            request.result.close();
            resolve(found.result.map(String).sort());
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );

test('the routed app fences multi-tab retirement, survives reload, and cleans before immediate relink', async () => {
  test.setTimeout(90_000);
  const shared = process.env.DEN_E2E_SHARED_WORKER === '1';
  const bridge = shared ? await sharedWorkerBridge() : null;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext();
    await context.addInitScript((seed) => {
      if (!localStorage.getItem('den.links'))
        localStorage.setItem('den.links', JSON.stringify([seed]));
    }, link);
    const edge = newEdge();
    edge.libraries.set(libraryId, { tokenHash, rows: new Map(), head: 0, wireMin: 4 });
    if (bridge) {
      const forwarder = await context.newPage();
      await routeGuestEdge(forwarder, edge);
      await bridge.answerFrom(forwarder);
    }
    const first = await context.newPage();
    const other = await context.newPage();
    await routeGuestEdge(first, edge);
    await routeGuestEdge(other, edge);
    await Promise.all([first.goto(`${E2E_ORIGIN}/settings`), other.goto(`${E2E_ORIGIN}/settings`)]);
    await expect(first.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(other.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect
      .poll(() => first.workers().some((worker) => worker.url().includes('libraryServiceWorker')))
      .toBe(!shared);

    await first.evaluate(
      ({ id }) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('den-library', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction('kept', 'readwrite');
            const kept = transaction.objectStore('kept');
            kept.put(new Uint8Array([1]), `${id}:history`);
            kept.put(new Uint8Array([2]), `${id}-other:history`);
            kept.put(new Uint8Array([3]), 'local:history');
            transaction.oncomplete = () => (request.result.close(), resolve());
            transaction.onerror = () => reject(transaction.error);
          };
        }),
      { id: libraryId },
    );

    if (!shared)
      // A production SharedWorker holds this exact lease while another tab owns its realm. The development build
      // deliberately selects a DedicatedWorker, so hold the same cross-tab drain fence explicitly in that variant.
      await other.evaluate(
        (name) =>
          new Promise((held, reject) => {
            navigator.locks
              .request(name, { mode: 'shared' }, () => {
                held(true);
                return new Promise(() => {});
              })
              .catch(reject);
          }),
        retirementLock,
      );

    await first.getByRole('button', { name: /Sign out/ }).click();
    const signOut = first.getByRole('region', { name: 'Sign out' });
    await signOut.getByRole('button', { name: 'Sign out on this browser' }).click();
    await first.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect
      .poll(() => first.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? '[]')))
      .toEqual([]);
    expect(await keys(first)).toContain(`${libraryId}:history`);

    await expect(first.getByRole('alert')).toContainText('Another Den tab', { timeout: 30_000 });
    await first.reload();
    await expect(first.getByRole('alert')).toContainText('You’re signed out');

    // Relink immediately, while the old owner is still held. The new Worker's shared lease queues behind the
    // reload-restored exclusive receipt rather than opening the retired prefix.
    await first.evaluate((seed) => localStorage.setItem('den.links', JSON.stringify([seed])), link);
    await first.reload();
    await expect(first.getByRole('alert')).toContainText('Another Den tab');
    await other.close();

    await expect(first.getByRole('alert')).toHaveCount(0, { timeout: 30_000 });
    await expect(first.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
      timeout: 30_000,
    });
    const finalKeys = await keys(first);
    expect(finalKeys).not.toContain(`${libraryId}:history`);
    expect(finalKeys).toContain(`${libraryId}-other:history`);
    expect(finalKeys).toContain('local:history');
    expect(finalKeys).toContain(`retirement-generation:${libraryId}`);
    expect(
      await first.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? '[]')),
    ).toHaveLength(1);
    if (bridge)
      expect(bridge.served.filter((path) => path.startsWith('/lib/')).length).toBeGreaterThan(0);
  } finally {
    await browser.close();
    await bridge?.close();
  }
});
