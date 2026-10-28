import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

// Every poster reads its title's standing (seen, watchlisted, watching) from one shared store. A library change hands
// over a whole new map; only the posters whose title changed may be woken, not every card on the page.

test('a library change wakes only the posters whose standing changed', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/standing.html`);
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const hand = (entries) => page.evaluate((entries) => window.fixtureStandings(entries), entries);
  const all = Array.from({ length: 200 }, (_, n) => [`movie:${n + 1}`, 'watchlist']);
  const before = await hand(all);
  const after = await hand(
    all.map(([key, standing]) => [key, key === 'movie:7' ? 'watched' : standing]),
  );
  const woken = Object.keys(after).filter((key) => after[key] !== before[key]);
  expect(woken).toEqual(['movie:7']);
});
