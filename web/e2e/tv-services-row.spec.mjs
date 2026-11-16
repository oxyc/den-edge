import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

const geometry = (row) =>
  row.evaluate((section) => {
    const box = section.getBoundingClientRect();
    return { top: box.top + scrollY, height: box.height };
  });

async function pendingRow(page, query = '') {
  await page.goto(`${E2E_ORIGIN}/test/services-row.html${query}`);
  const row = page.locator('.services-row');
  await page.evaluate(() => document.fonts.ready);
  await expect(row).toHaveAttribute('data-layout-state', 'pending');
  const label = row.locator('.hold > :last-child').first();
  return {
    row,
    reserved: await geometry(row),
    labelFont: await label.evaluate((node) => getComputedStyle(node).fontSize),
  };
}

test('TV Services keeps its reserved height and complete localized unavailable notice', async ({
  page,
}) => {
  const { row, reserved } = await pendingRow(page, '?language=sv');

  await row.scrollIntoViewIfNeeded();
  await expect(row).toHaveAttribute('data-layout-state', 'settled');
  const notice = row.getByText('Tjänsterna är inte tillgängliga');
  await expect(notice).toBeVisible();
  expect(await geometry(row)).toEqual(reserved);
  expect(
    await notice.evaluate((node) => ({
      clipped: node.scrollWidth > node.clientWidth,
      whiteSpace: getComputedStyle(node).whiteSpace,
    })),
  ).toEqual({ clipped: false, whiteSpace: 'nowrap' });
});

test('TV Services keeps its reserved height when provider names resolve', async ({ page }) => {
  const { row, reserved, labelFont } = await pendingRow(page, '?result=resolved');

  await row.scrollIntoViewIfNeeded();
  await expect(row).toHaveAttribute('data-layout-state', 'settled');
  await expect(row.getByRole('link', { name: 'Netflix' })).toBeVisible();
  await expect(row.getByRole('link', { name: 'Max' })).toBeVisible();
  expect(await geometry(row)).toEqual(reserved);
  await expect(row.locator('.name').first()).toHaveCSS('font-size', labelFont);
});

test('TV Services keeps duplicate-country replacement in the reserved name line', async ({
  page,
}) => {
  const { row, reserved, labelFont } = await pendingRow(page, '?result=replacement');

  await row.scrollIntoViewIfNeeded();
  await expect(row).toHaveAttribute('data-layout-state', 'settled');
  await expect(row.getByRole('link', { name: 'Netflix' })).toBeVisible();
  expect(await geometry(row)).toEqual(reserved);
  await page.evaluate(() => globalThis.replaceServicesWithDuplicate());
  await expect(row.getByRole('link', { name: 'Netflix, US' })).toBeVisible();
  await expect(row.getByRole('link', { name: 'Netflix, FI' })).toBeVisible();
  await expect(row.locator('.country')).toHaveText(['US', 'FI']);
  await expect(row.locator('.country')).toHaveCount(2);
  expect(await geometry(row)).toEqual(reserved);
  for (const label of await row.locator('.label').all()) {
    await expect(label.locator('.name')).toHaveCSS('font-size', labelFont);
    expect(
      await label.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return [...node.children].every((child) => {
          const childBox = child.getBoundingClientRect();
          return childBox.top >= box.top && childBox.bottom <= box.bottom;
        });
      }),
    ).toBe(true);
  }
});
