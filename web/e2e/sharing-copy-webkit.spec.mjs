import { existsSync } from 'node:fs';
import { test, expect, webkit, devices } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

// Real WebKit, touch-emulated: Settings › Sharing › Invite a guest's "Copy link"/"Copy code" never turned to
// "Copied" on an iPhone, because `copy()` called `navigator.clipboard.writeText` with no fallback. Chromium's
// own clipboard permission model is too permissive to tell a fixed button from a broken one here, which is
// why this is WebKit-only rather than the default project.
test.skip(
  !process.env.CI && !existsSync(webkit.executablePath()),
  'needs WebKit: npx playwright install webkit',
);

async function openInvite(page) {
  await page.route('**/lib/*/grants', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        json: {
          code: 'deadbeef.abcdefghijklmnopqrstuv',
          grant: {
            gid: 'g1',
            name: 'Alex',
            status: 'invited',
            addons: ['scout'],
            createdAt: Date.now(),
            codeExpiresAt: Date.now() + 86_400_000,
            accessDays: null,
            accessUntil: null,
            redeemedAt: null,
            expiresAt: null,
            devices: 1,
            deviceCount: 0,
            lastUsedAt: null,
            playsTotal: 12,
            hoursTotal: 9,
            playsThisMonth: 4,
            hoursThisMonth: 3,
          },
        },
      });
    }
    return route.fulfill({ json: { grants: [] } });
  });
  await page.goto(`${E2E_ORIGIN}/test/sharing-copy.html`);
  await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();
  await page.getByLabel('Guest’s name').fill('Alex');
  await page.getByRole('button', { name: 'Create invite' }).click();
}

/** The copy button next to the field of that aria-label — scoped so a tap on one never matches the other
 *  once both can read "Copied". */
function copyButtonFor(page, fieldLabel) {
  return page
    .locator('span.copy')
    .filter({ has: page.getByLabel(fieldLabel, { exact: true }) })
    .getByRole('button');
}

async function tap(page, locator) {
  const box = await locator.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test('a guest’s row shows plays and hours, never a title', async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'] });
    const page = await context.newPage();
    await openInvite(page);

    await expect(page.getByText('4 plays · 3 h this month · 12 plays total')).toBeVisible();
  } finally {
    await browser.close();
  }
});

test('Copy link turns to Copied on a touch-emulated iPhone', async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'] });
    const page = await context.newPage();
    await openInvite(page);

    const copyLink = copyButtonFor(page, 'Invite link');
    await expect(copyLink).toHaveText('Copy link');
    await tap(page, copyLink);
    await expect(copyLink).toHaveText('Copied', { timeout: 3000 });

    const copyCode = copyButtonFor(page, 'Invite code');
    await expect(copyCode).toHaveText('Copy code');
    await tap(page, copyCode);
    await expect(copyCode).toHaveText('Copied', { timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('Copy link still lands somewhere when the Clipboard API itself is refused', async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'] });
    const page = await context.newPage();
    // Simulates the real-device refusal this codebase cannot reproduce in WebKit's own test build (it allows
    // the write unconditionally): the clipboard helper's execCommand/select fallback is what this exercises.
    await page.addInitScript(() => {
      const refuse = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: refuse, write: refuse, readText: refuse },
        configurable: true,
      });
    });
    await openInvite(page);

    const copyLink = copyButtonFor(page, 'Invite link');
    await tap(page, copyLink);
    // Either execCommand('copy') on the selected field still landed it ("Copied"), or every programmatic
    // path failed and the page says so while leaving the field selected for a long-press copy — never a
    // button stuck silently on "Copy link".
    await expect(copyLink)
      .toHaveText('Copied', { timeout: 3000 })
      .catch(async () => {
        await expect(page.getByText('Select and copy the link.')).toBeVisible();
      });
  } finally {
    await browser.close();
  }
});
