import { existsSync } from 'node:fs';
import { test, expect, webkit, devices } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

// Chromium cannot see this class of bug. iOS sizes a native <select> to its widest option and lets the text spill out of
// a narrower box; that overflow is not any element's own box, so the page scrolled sideways on an iPhone while
// `document.documentElement.scrollWidth` in Chromium stayed at the viewport width. Real WebKit at an iPhone's size, with
// the long region names an en-US phone shows, is what reproduces it.
test.skip(
  !process.env.CI && !existsSync(webkit.executablePath()),
  'needs WebKit: npx playwright install webkit',
);

const REGIONS = [
  { iso_3166_1: 'US', english_name: 'United States of America' },
  { iso_3166_1: 'BO', english_name: 'Bolivia (Plurinational State of)' },
  { iso_3166_1: 'SH', english_name: 'Saint Helena, Ascension and Tristan da Cunha' },
  { iso_3166_1: 'FM', english_name: 'Micronesia (Federated States of)' },
  { iso_3166_1: 'FI', english_name: 'Finland' },
];

test('Settings never scrolls sideways on an iPhone, however long a region name is', async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'], locale: 'en-US' });
    const page = await context.newPage();
    await guardNetwork(page);
    await page.route('**/routes', (r) => r.fulfill({ json: {} }));
    await page.route('**/version', (r) => r.fulfill({ json: { version: '0.67.0' } }));
    await page.route('**/config', (r) => r.fulfill({ json: { simklClientId: 'client-1' } }));
    await routeTmdb(page, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/configuration')) return route.fulfill({ json: { images: {} } });
      if (url.pathname.endsWith('/watch/providers/regions'))
        return route.fulfill({ json: { results: REGIONS } });
      return route.fulfill({ json: { results: [] } });
    });
    await page.goto('http://127.0.0.1:5198/test/settings.html');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    const widths = () =>
      page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));

    const initial = await widths();
    expect(initial.scroll).toBe(initial.viewport);

    await page.getByRole('button', { name: 'Expand all in Settings' }).click();
    const expanded = await widths();
    expect(expanded.scroll).toBe(expanded.viewport);
  } finally {
    await browser.close();
  }
});
