import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

async function openMemberLibrary(page) {
  await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
}

async function expectBootstrapRetry(page) {
  await expect(page.getByRole('alert')).toContainText(
    'Saved playback progress couldn’t be updated. Try again.',
    { timeout: 30_000 },
  );
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await retry.focus();
  await expect(retry).toBeFocused();
  return retry;
}

test('the production library exposes one bounded receipt retry and announces recovery', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());

  const releases = [];
  let attempts = 0;
  await page.route(`${E2E_ORIGIN}/playback/receipts/drain`, async (route) => {
    expect(route.request().headers()['x-den-library-member']).toMatch(
      /^[0-9a-f]{32}:[0-9a-f]{64}$/,
    );
    const attempt = attempts++;
    await new Promise((resolve) => releases.push(resolve));
    if (attempt === 0) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    return route.fulfill({ json: { messages: [] } });
  });

  // Start a real member library through the shipped invite path. The production build deliberately carries only
  // its seed entry beside the app, not source-only fixture pages.
  await openMemberLibrary(page);

  await expect.poll(() => attempts, { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole('status')).toContainText('Checking saved playback progress…');
  releases.shift()();
  await expect(page.getByRole('alert')).toContainText(
    'Saved playback progress couldn’t be updated. Try again.',
  );
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();

  // The notice is announced as an alert; its only action remains a native keyboard/remote focus stop.
  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.press('Enter');
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByRole('status')).toContainText('Checking saved playback progress…');
  releases.shift()();
  await expect(page.getByRole('status')).toContainText('Saved playback progress is up to date.');
  await expect.poll(() => attempts).toBe(2);
});

test('an unavailable lazy receipt module exposes Retry and recovers through the production route', async ({
  page,
}) => {
  await page.addInitScript(() => (window.__denFailAssistantImport = true));
  await routeGuestEdge(page, newEdge());

  let drains = 0;
  await page.route(`${E2E_ORIGIN}/playback/receipts/drain`, (route) => {
    drains++;
    return route.fulfill({ json: { messages: [] } });
  });

  await openMemberLibrary(page);
  const retry = await expectBootstrapRetry(page);
  expect(drains).toBe(0);

  await page.evaluate(() => (window.__denFailAssistantImport = false));
  await retry.press('Enter');
  await expect.poll(() => drains, { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole('status')).toContainText('Saved playback progress is up to date.');
});

test('a rejected relay membership query exposes Retry and recovers through the production client', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  let drains = 0;
  await page.route(`${E2E_ORIGIN}/playback/receipts/drain`, (route) => {
    drains++;
    return route.fulfill({ json: { messages: [] } });
  });

  await openMemberLibrary(page);
  await expect.poll(() => drains, { timeout: 30_000 }).toBe(1);
  drains = 0;

  // The library Worker is real. Refuse the optimistic and adopted page-side protocol queries that RoutedLibrary
  // issues after their ready handshakes, exactly as authority error replies do; Retry then traverses the same client
  // and Worker. The optimistic failure must remain fenced while the adopted one owns the visible recovery.
  await page.addInitScript(() => {
    window.__receiptMembershipFailures = 0;
    window.__failReceiptMembership = true;
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (
        message?.type === 'query' &&
        message.query?.kind === 'relay.membership' &&
        window.__failReceiptMembership
      ) {
        window.__receiptMembershipFailures++;
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: [
                {
                  type: 'error',
                  protocol: message.protocol,
                  requestId: message.requestId,
                  error: {
                    code: 'unavailable',
                    message: 'fixture membership query failed',
                    retryable: true,
                  },
                },
              ],
            }),
          ),
        );
        return;
      }
      return transfer === undefined
        ? postMessage.call(this, message)
        : postMessage.call(this, message, transfer);
    };
  });
  await page.reload();
  const retry = await expectBootstrapRetry(page);
  expect(drains).toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.__receiptMembershipFailures))
    .toBeGreaterThan(0);

  await page.evaluate(() => (window.__failReceiptMembership = false));
  await retry.press('Enter');
  await expect.poll(() => drains).toBe(1);
  await expect(page.getByRole('status')).toContainText('Saved playback progress is up to date.');
});
