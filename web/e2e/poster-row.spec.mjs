import { expect, test } from '@playwright/test';
import { guardNetwork } from './network.mjs';

test('Coming Soon captions stay on one line in a horizontal-only shelf', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await page.goto('http://127.0.0.1:5198/test/poster-row.html');

  const row = page.getByRole('region', { name: 'Coming Soon' });
  await expect(row.locator('.card')).toHaveCount(10);
  const caption = row.locator('.caption').first();
  await expect(caption).toHaveText('An Exceptional… · Sep 19');
  expect(
    await caption.evaluate((node) => ({
      fits: node.scrollWidth <= node.clientWidth,
      lines: Math.round(node.scrollHeight / Number.parseFloat(getComputedStyle(node).lineHeight)),
      overflow: getComputedStyle(node).overflow,
      textOverflow: getComputedStyle(node).textOverflow,
      whiteSpace: getComputedStyle(node).whiteSpace,
    })),
  ).toEqual({
    fits: true,
    lines: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });

  const track = row.locator('.track');
  const geometry = await track.evaluate((node) => {
    // Move past the first snap point; a smaller assignment can legitimately snap straight back to zero.
    node.scrollLeft = 250;
    node.scrollTop = 100;
    return {
      overflowX: getComputedStyle(node).overflowX,
      overflowY: getComputedStyle(node).overflowY,
      scrollLeft: node.scrollLeft,
      scrollTop: node.scrollTop,
      scrollable: node.scrollWidth > node.clientWidth,
    };
  });
  expect(geometry).toMatchObject({
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollTop: 0,
    scrollable: true,
  });
  expect(geometry.scrollLeft).toBeGreaterThan(0);
  await page.close();
});
