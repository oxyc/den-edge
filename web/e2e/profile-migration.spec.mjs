import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/profile-migration.html`;

const snapshot = (page) => page.evaluate(() => window.denProfileMigrationFixture.snapshot());

test.beforeEach(async ({ page }) => {
  await guardNetwork(page);
  await page.goto(FIXTURE);
});

test('the browser session stays inert until Owner action and only prepares the fenced rewrite', async ({
  page,
}) => {
  await expect
    .poll(() => snapshot(page))
    .toMatchObject({ calls: [], journal: null, status: 'inactive' });
  await page.getByRole('button', { name: 'Begin explicit Owner action' }).click();
  for (const effectCount of [1, 2, 4, 5, 6]) {
    await page.getByRole('button', { name: 'Advance one durable effect' }).click();
    await expect.poll(() => snapshot(page).then(({ calls }) => calls.length)).toBe(effectCount);
  }
  await expect
    .poll(() => snapshot(page))
    .toMatchObject({
      calls: ['fence', 'backup', 'candidate', 'copy', 'verify-owner', 'prepare'],
      status: 'ready-to-commit',
      journal: {
        state: 'ready-to-commit',
        fence: { generation: 'fixture-generation', base: 9 },
        backup: { id: 'fixture-backup' },
        candidate: { libraryKey: 'candidate-key' },
        prepared: { digest: 'fixture-prepared-digest' },
      },
    });

  await page.reload();
  await expect
    .poll(() => snapshot(page))
    .toMatchObject({
      calls: [],
      status: 'recoverable',
      journal: { state: 'ready-to-commit', prepared: { digest: 'fixture-prepared-digest' } },
    });
  await page.getByRole('button', { name: 'Advance one durable effect' }).click();
  await expect.poll(() => snapshot(page).then(({ status }) => status)).toBe('ready-to-commit');
  expect((await snapshot(page)).calls).toEqual([]);
});

test('a competing winner is adopted only after the losing candidate is retired', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Begin explicit Owner action' }).click();
  for (let step = 0; step < 3; step++) {
    await page.getByRole('button', { name: 'Advance one durable effect' }).click();
    await expect
      .poll(() => snapshot(page).then(({ calls }) => calls.length))
      .toBe(step + (step === 2 ? 2 : 1));
  }
  await page.getByRole('button', { name: 'Observe competing winner' }).click();

  for (const expected of ['retire', 'verify-winner', 'adopt']) {
    await page.getByRole('button', { name: 'Advance one durable effect' }).click();
    await expect.poll(() => snapshot(page).then(({ calls }) => calls.at(-1))).toBe(expected);
  }
  await expect
    .poll(() => snapshot(page))
    .toMatchObject({
      calls: ['fence', 'backup', 'candidate', 'copy', 'retire', 'verify-winner', 'adopt'],
      status: 'active',
      journal: null,
    });
});
