import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

for (const persistent of [false, true]) {
  test(`production TV recovers a missing screen chunk ${persistent ? 'without a reload loop' : 'with one fresh document'}`, async ({
    page,
  }) => {
    await routeGuestEdge(page, newEdge());
    // 404s served for the old release's Settings chunk and for the replacement's. A page may ask for the chunk more
    // than once (a second load after the first has failed fetches it again), so these count outcomes, not requests.
    let old = 0;
    let fresh = 0;
    // A replacement release has a new hashed module graph. Serve the same production bytes in a fresh asset
    // namespace after recovery; do not pretend a deleted immutable chunk reappears at its original URL.
    await page.route('**/settings?den-retry=*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replaceAll('/assets/', '/updated-assets/'),
      });
    });
    await page.route('**/updated-assets/**', async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace('/updated-assets/', '/assets/'),
      });
      const type = response.headers()['content-type'] ?? '';
      if (/javascript/.test(type))
        return route.fulfill({
          response,
          body: (await response.text()).replaceAll('assets/', 'updated-assets/'),
        });
      return route.fulfill({ response });
    });
    // The old release's chunk is gone for good: every request for it fails. The replacement's fails only when the
    // outage is persistent.
    await page.route('**/*assets/Settings-*.js', (route) => {
      const replacement = route.request().url().includes('/updated-assets/');
      if (!replacement || persistent) {
        if (replacement) fresh += 1;
        else old += 1;
        return route.fulfill({
          status: 404,
          // Match den-edge's missing-asset response.
          headers: { 'cache-control': 'no-store' },
          contentType: 'text/plain',
          body: 'Old release removed',
        });
      }
      return route.fallback();
    });
    await page.goto(E2E_ORIGIN);
    await page.getByRole('button', { name: 'Look around instead' }).click();
    const settings = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    const documents = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        documents.push(request.url());
    });
    await settings.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => documents.length).toBe(1);
    expect(new URL(documents[0]).searchParams.get('den-retry')).toMatch(/^[0-9a-z]+$/);
    if (persistent) {
      await expect(
        page.getByText('Couldn’t load this page. Check that this device is online.'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      await page.waitForTimeout(500);
      expect(fresh, 'the fresh document tried the replacement release').toBeGreaterThan(0);
    } else {
      await expect(page.getByRole('button', { name: /Linked devices/ })).toBeVisible();
    }
    expect(old, 'the old release’s chunk was asked for and missing').toBeGreaterThan(0);
    expect(documents).toHaveLength(1);
  });
}
