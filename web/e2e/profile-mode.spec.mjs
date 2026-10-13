import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { routeLibraryEdge } from './library-edge.mjs';
import { guardNetwork } from './network.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/profile-mode.html`;
const ROUTED_FIXTURE = `${E2E_ORIGIN}/test/live-position.html`;

async function open(page, enabled, suffix = '') {
  await guardNetwork(page);
  await page.route('**/capabilities/profiles', (route) =>
    enabled
      ? route.fulfill({ headers: { 'cache-control': 'no-store' }, json: { enabled: true } })
      : route.fulfill({
          status: 404,
          headers: { 'cache-control': 'no-store' },
          json: { error: 'not_found' },
        }),
  );
  await page.goto(`${FIXTURE}${suffix}`);
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture?.snapshot().checked))
    .toBe(true);
}

test('default-off capability leaves the legacy Owner path and storage untouched', async ({
  page,
}) => {
  await open(page, false);

  await expect(page.getByRole('button', { name: /Switch profile/ })).toHaveCount(0);
  await expect(page.locator('[data-mode]')).toHaveText('Legacy Owner active');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.snapshot()))
    .toMatchObject({ enabled: false, capability: 'disabled', mode: 'owner', keys: [] });
});

for (const [failure, answer] of [
  [
    'server error',
    (route) =>
      route.fulfill({
        status: 503,
        headers: { 'cache-control': 'no-store' },
        json: { error: 'unavailable' },
      }),
  ],
  [
    'malformed response',
    (route) => route.fulfill({ headers: { 'cache-control': 'no-store' }, body: '{broken json' }),
  ],
  ['network failure', (route) => route.abort('connectionfailed')],
]) {
  test(`${failure} stays neutral and never exposes legacy Owner`, async ({ page }) => {
    await guardNetwork(page);
    await page.route('**/capabilities/profiles', answer);
    await page.goto(FIXTURE);
    await expect
      .poll(() => page.evaluate(() => window.denProfileModeFixture?.snapshot().checked))
      .toBe(true);

    await expect(page.getByRole('heading', { name: 'Profiles couldn’t be opened' })).toBeVisible();
    await expect(page.locator('[data-mode]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Switch profile/ })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.denProfileModeFixture.snapshot().capability))
      .toBe('indeterminate');
  });
}

test('RoutedLibrary keeps Owner hidden when profile discovery is indeterminate', async ({
  page,
}) => {
  await routeLibraryEdge(page, {});
  await page.route('**/capabilities/profiles', (route) =>
    route.fulfill({
      status: 503,
      headers: { 'cache-control': 'no-store' },
      json: { error: 'unavailable' },
    }),
  );
  await page.goto(ROUTED_FIXTURE);

  await expect(page.getByRole('heading', { name: 'Profiles couldn’t be opened' })).toBeVisible();
  await expect(
    page.getByText('The Owner library remains hidden. Reload Den to try again.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Switch profile/ })).toHaveCount(0);
});

test('capability discovery never exposes or enables the legacy Owner UI', async ({ page }) => {
  await guardNetwork(page);
  let answerCapability;
  const capability = new Promise((resolve) => (answerCapability = resolve));
  await page.route('**/capabilities/profiles', async (route) => {
    await capability;
    await route.fulfill({ headers: { 'cache-control': 'no-store' }, json: { enabled: true } });
  });
  await page.goto(FIXTURE);

  await expect(page.getByRole('status')).toHaveText('Checking profiles…');
  await expect(page.locator('[data-mode]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Switch profile/ })).toHaveCount(0);
  answerCapability();
  await expect(page.getByRole('heading', { name: 'Owner access' })).toBeVisible();
  await expect(page.getByLabel('Owner PIN')).toBeFocused();
  await expect(page.locator('[data-pin-slot].active')).toHaveCount(1);
  await expect(page.locator('[data-pin-slot]').first()).toHaveClass(/active/);
  await expect(page.locator('[data-pin-slot]').first()).toHaveClass(/ready/);
  await expect(page.locator('[data-mode]')).toHaveCount(0);
});

test('missing active mode requires the configured Owner PIN and persists success', async ({
  page,
}) => {
  await open(page, true, '?pin=1234');

  await expect(page.locator('[data-mode]')).toHaveCount(0);
  await expect(page.getByLabel('Owner PIN')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Owner PIN')).toHaveAttribute('pattern', '[0-9][0-9][0-9][0-9]');
  await page.getByLabel('Owner PIN').fill('0000');
  await expect(page.getByRole('alert')).toHaveText('That PIN didn’t match.');
  await expect(page.locator('[data-pin-slot].filled')).toHaveCount(0);
  await expect(page.getByLabel('Owner PIN')).toBeFocused();
  await expect(page.locator('[data-mode]')).toHaveCount(0);

  await page.getByLabel('Owner PIN').fill('1234');
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('den.profile.active.v1')))
    .toBe(JSON.stringify({ mode: 'owner' }));
});

test('a corrupt active marker cannot expose Owner without its PIN', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('den.profile.active.v1', '{broken'));
  await open(page, true, '?pin=1234');

  await expect(page.getByRole('heading', { name: 'Owner access' })).toBeVisible();
  await expect(page.locator('[data-mode]')).toHaveCount(0);
});

test('preview directory switches sticky Kids and Visitor without a launch picker', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/capabilities/profiles', (route) =>
    route.fulfill({
      headers: { 'cache-control': 'no-store' },
      json: { enabled: true, preview: true },
    }),
  );
  await page.goto(`${FIXTURE}?pin=1234`);
  await expect(page.getByRole('heading', { name: 'Owner access' })).toBeVisible();
  await page.getByLabel('Owner PIN').fill('1234');

  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await expect(page.getByRole('button', { name: 'Use Kids' })).toBeVisible();
  await expect(
    page.getByText('Profile preview · content filtering is not active yet'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Use Kids' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Kids active');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.snapshot()))
    .toMatchObject({
      effectivePreferences: {
        excludedGenres: [],
        excludedLanguages: [],
        hideAnime: false,
        hideWatched: false,
        watchRegion: 'FI',
        services: [{ id: 8, country: 'FI' }],
        servicesConfigured: true,
      },
      contentPolicy: { maximumAge: 12, unknownRatings: 'block' },
    });
  await expect(
    page.getByRole('button', { name: 'Switch profile, current Kids' }),
  ).not.toBeFocused();

  await page.reload();
  await expect(page.locator('[data-mode]')).toHaveText('Kids active');
  await page.getByRole('button', { name: 'Switch profile, current Kids' }).focus();
  await page.getByRole('button', { name: 'Switch profile, current Kids' }).press('Enter');
  await page.getByRole('dialog').press('Escape');
  await expect(page.getByRole('button', { name: 'Switch profile, current Kids' })).toBeFocused();
  await page.getByRole('button', { name: 'Switch profile, current Kids' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  await expect(page.getByText('Owner approval required')).toBeVisible();
  await expect(page.getByLabel('Owner PIN')).toBeFocused();
  await expect(page.locator('[data-pin-slot]').first()).toHaveClass(/active/);
  await expect(page.getByLabel('Owner PIN')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Owner PIN')).toHaveAttribute('pattern', '[0-9][0-9][0-9][0-9]');
  await page.getByLabel('Owner PIN').fill('0000');
  await expect(page.getByRole('alert')).toHaveText('That PIN didn’t match.');
  await expect(page.locator('[data-pin-slot].filled')).toHaveCount(0);
  await expect(page.getByLabel('Owner PIN')).toBeFocused();
  await page.getByLabel('Owner PIN').fill('123');
  await expect(page.locator('[data-pin-slot].filled')).toHaveCount(3);
  await page.getByLabel('Owner PIN').press('4');
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.snapshot()))
    .toMatchObject({
      effectivePreferences: {
        excludedGenres: [],
        excludedLanguages: [],
        hideAnime: false,
        hideWatched: false,
        watchRegion: 'FI',
        services: [{ id: 8, country: 'FI' }],
        servicesConfigured: true,
      },
      contentPolicy: { maximumAge: null, unknownRatings: 'allow' },
    });

  await page.getByRole('button', { name: 'Switch profile, current Visitor' }).click();
  await page.getByRole('button', { name: 'Use Kids' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Kids active');
  await page.getByRole('button', { name: 'Switch profile, current Kids' }).click();
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await page.getByLabel('Owner PIN').fill('1234');
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');
});

test('preview Kid and Visitor Settings are personal while household administration stays unreachable', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('den.profile.active.v1'))
      localStorage.setItem(
        'den.profile.active.v1',
        JSON.stringify({
          version: 1,
          mode: 'persistent',
          profileId: '00000000000000000000000000000001',
        }),
      );
  });
  await page.route('**/capabilities/profiles', (route) =>
    route.fulfill({
      headers: { 'cache-control': 'no-store' },
      json: { enabled: true, preview: true },
    }),
  );
  await page.goto(`${FIXTURE}?settings`);
  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Kids' }).click();

  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Playback', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Content', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'About', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
  await expect(page.getByText('Up to age 12 · managed by Owner')).toBeVisible();
  await page.getByRole('button', { name: 'Streaming household Finland' }).click();
  await expect(page.getByText('Region: Finland · 1 shared service')).toBeVisible();
  await expect(page.getByText('Parental PIN')).toHaveCount(0);

  await page.getByLabel('Audio language').selectOption('da');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.denProfileModeFixture.snapshot().effectivePreferences.audioLanguage,
      ),
    )
    .toBe('da');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).find((key) =>
          key.startsWith('den.profile.preferences.preview.v1:'),
        ),
      ),
    )
    .toBe('den.profile.preferences.preview.v1:00000000000000000000000000000002');
  await page.reload();
  await expect(page.getByLabel('Audio language')).toHaveValue('da');

  await page.getByRole('button', { name: 'Switch profile, current Kids' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  await page.getByLabel('Owner PIN').fill('1234');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.snapshot().preferencesIdentity))
    .toMatchObject({ kind: 'visitor' });
  await page.getByLabel('Subtitle language', { exact: true }).selectOption('es');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.denProfileModeFixture.snapshot().effectivePreferences.subtitleLanguage,
      ),
    )
    .toBe('es');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
          .filter((key) => key !== null)
          .filter((key) => key.startsWith('den.profile.visitor.v1:'))
          .map((key) => localStorage.getItem(key)),
      ),
    )
    .toContainEqual(expect.stringContaining('"subtitleLanguage":"es"'));
  await page.reload();
  await expect(page.getByLabel('Subtitle language', { exact: true })).toHaveValue('es');
  await expect(page.getByLabel('Audio language')).toHaveValue('');

  const visitorPrefix = await page.evaluate(() =>
    Object.keys(localStorage).find((key) => key.startsWith('den.profile.visitor.v1:')),
  );
  expect(visitorPrefix).toBeTruthy();
  await page.getByRole('button', { name: 'Switch profile, current Visitor' }).click();
  await page.getByRole('button', { name: 'Use Kids' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('den.profile.visitor.v1:')),
      ),
    )
    .toEqual([]);
  await expect(page.getByLabel('Audio language')).toHaveValue('da');
});

test('an in-flight switch cannot finish behind a dismissed dialog', async ({ page }) => {
  await guardNetwork(page);
  await page.route('**/capabilities/profiles', (route) =>
    route.fulfill({
      headers: { 'cache-control': 'no-store' },
      json: { enabled: true, preview: true },
    }),
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      'den.profile.active.v1',
      JSON.stringify({
        version: 1,
        mode: 'persistent',
        profileId: '00000000000000000000000000000001',
      }),
    ),
  );
  await page.goto(`${FIXTURE}?pin=1234&slowLock=1`);

  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Who’s watching?' });
  await expect(dialog).toBeVisible();
  await dialog.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect(dialog).toBeHidden();
});

test('profile control moves from the desktop header to the mobile Settings row', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      'den.profile.active.v1',
      JSON.stringify({
        version: 1,
        mode: 'persistent',
        profileId: '00000000000000000000000000000001',
      }),
    ),
  );
  await page.route('**/capabilities/profiles', (route) =>
    route.fulfill({
      headers: { 'cache-control': 'no-store' },
      json: { enabled: true, preview: true },
    }),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(FIXTURE);
  const headerTrigger = page.locator('.profile-trigger');
  await expect(headerTrigger).toBeVisible();
  await expect(headerTrigger).toHaveAttribute('aria-label', 'Switch profile, current Owner');
  await expect(headerTrigger).toHaveAttribute('title', 'Switch profile, current Owner');
  await expect(headerTrigger.locator('svg')).toHaveCount(1);
  await expect(headerTrigger).not.toContainText(/[OKV]/);
  await expect(headerTrigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(headerTrigger).toHaveCSS('border-top-width', '0px');
  await expect(headerTrigger.locator('.neutral')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(headerTrigger.locator('.den-arch')).toHaveCount(1);
  const occupant = headerTrigger.locator('.occupant');
  const edge = await headerTrigger.evaluate((trigger) => {
    const svg = trigger.querySelector('svg').getBoundingClientRect();
    const doorway = trigger.querySelector('.doorway-clip');
    const box = trigger.getBoundingClientRect();
    return {
      svgLeftGap: svg.left - box.left,
      svgRightGap: box.right - svg.right,
      doorwayTransform: getComputedStyle(doorway).transform,
      doorwayClip: getComputedStyle(doorway).clipPath,
    };
  });
  expect(Math.abs(edge.svgLeftGap - edge.svgRightGap)).toBeLessThanOrEqual(0.5);
  expect(edge.doorwayTransform).toBe('none');
  expect(edge.doorwayClip).toContain('den-opening');
  const restingTransform = await occupant.evaluate((node) => getComputedStyle(node).transform);
  await headerTrigger.hover();
  await expect
    .poll(() => occupant.evaluate((node) => getComputedStyle(node).transform))
    .not.toBe(restingTransform);
  await page.mouse.move(0, 700);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedTransform = await occupant.evaluate((node) => getComputedStyle(node).transform);
  await headerTrigger.hover();
  await expect(occupant).toHaveCSS('transition-duration', '0s');
  await expect
    .poll(() => occupant.evaluate((node) => getComputedStyle(node).transform))
    .toBe(reducedTransform);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.mobile-profile-row')).toBeHidden();

  await headerTrigger.click();
  const dialog = page.getByRole('dialog', { name: 'Who’s watching?' });
  await expect(dialog).toBeVisible();
  await dialog.locator('form').dispatchEvent('pointerdown', { pointerType: 'mouse' });
  await dialog.dispatchEvent('click');
  await expect(dialog).toBeVisible();
  await dialog.dispatchEvent('pointerdown', { pointerType: 'mouse' });
  await dialog.locator('form').dispatchEvent('click');
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 700);
  await expect(dialog).toBeHidden();
  await expect(headerTrigger).not.toBeFocused();

  await page.setViewportSize({ width: 390, height: 780 });
  await expect(page.locator('.profile-trigger')).toBeHidden();
  await expect(page.locator('.mobile-profile-row')).toBeVisible();
  await page.locator('.mobile-profile-row').click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('dialog')).toHaveCount(1);
  await dialog.dispatchEvent('pointerdown', { pointerType: 'touch' });
  await dialog.dispatchEvent('click');
  await expect(dialog).toBeHidden();
});

test('Visitor stays active across reload, PIN denial preserves it, and success disposes only its visit', async ({
  page,
}) => {
  const writes = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  });
  await open(page, true, '?pin=1234');

  await page.getByLabel('Owner PIN').fill('1234');
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');

  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect(page.getByText('Visitor can’t manage household settings.')).toBeVisible();
  const first = await page.evaluate(async () => {
    await window.denProfileModeFixture.setActivity('progress:movie:550', 'half');
    return window.denProfileModeFixture.snapshot();
  });
  expect(first.policyCeiling).toBeUndefined();
  expect(first.effectivePreferences).toMatchObject({
    excludedGenres: [],
    excludedLanguages: [],
    hideAnime: false,
    hideWatched: false,
    watchRegion: 'FI',
    services: [{ id: 8, country: 'FI' }],
  });
  expect(first.policyKeys).toEqual(['settings']);
  expect(first.policyHasWriter).toBe(false);
  expect(first.householdExposesModel).toBe(false);
  expect(first.servicesExposeModel).toBe(false);

  writes.length = 0;
  await page.getByRole('button', { name: 'Add activity' }).click();
  await expect(page.getByRole('region', { name: 'Visitor watchlist' })).toContainText('Fight Club');
  await expect(page.getByRole('region', { name: 'Visitor Continue Watching' })).toContainText(
    'Game of Thrones 40%',
  );
  await expect(page.getByRole('region', { name: 'Visitor watched' })).toContainText('The Matrix');
  expect(writes).toEqual([]);

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture?.snapshot().checked))
    .toBe(true);
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect(page.getByRole('region', { name: 'Visitor watchlist' })).toContainText('Fight Club');
  await expect(page.getByRole('region', { name: 'Visitor Continue Watching' })).toContainText(
    'Game of Thrones 40%',
  );
  await expect(page.getByRole('region', { name: 'Visitor watched' })).toContainText('The Matrix');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.getActivity('progress:movie:550')))
    .toBe('half');
  expect((await page.evaluate(() => window.denProfileModeFixture.snapshot())).visitId).toBe(
    first.visitId,
  );

  writes.length = 0;
  await expect(page.evaluate(() => window.denProfileModeFixture.outbound())).resolves.toEqual([
    { outcome: 'suppressed' },
    { outcome: 'suppressed' },
  ]);
  expect(writes).toEqual([]);

  await page.getByRole('button', { name: 'Switch profile, current Visitor' }).click();
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await page.getByLabel('Owner PIN').fill('0000');
  await expect(page.getByRole('alert')).toHaveText('That PIN didn’t match.');
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.getActivity('progress:movie:550')))
    .toBe('half');

  await page.getByLabel('Owner PIN').fill('1234');
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');
  const ended = await page.evaluate(() => window.denProfileModeFixture.snapshot());
  expect(ended.keys).toEqual(['den.profile.active.v1']);
});

test('a refused Visitor lock leaves the switch retryable and reports the failure', async ({
  page,
}) => {
  await open(page, true, '?pin=none&rejectLock');
  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  const marker = await page.evaluate(() => localStorage.getItem('den.profile.active.v1'));

  await page.getByRole('button', { name: 'Switch profile, current Visitor' }).click();
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'The profile switch couldn’t be completed. Try again.',
  );
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  expect(await page.evaluate(() => localStorage.getItem('den.profile.active.v1'))).toBe(marker);

  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');
  expect(await page.evaluate(() => localStorage.getItem('den.profile.active.v1'))).toBe(
    JSON.stringify({ mode: 'owner' }),
  );
});

test('two tabs merge Visitor activity and an Owner switch revokes the stale tab', async ({
  page,
  context,
}) => {
  await open(page, true, '?pin=none');
  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  const visitId = (await page.evaluate(() => window.denProfileModeFixture.snapshot())).visitId;

  const other = await context.newPage();
  await open(other, true, '?pin=none');
  await expect(other.locator('[data-mode]')).toHaveText('Visitor active');

  await Promise.all([
    page.evaluate(() => window.denProfileModeFixture.addVisitorWatchlist(1, 'One')),
    other.evaluate(() => window.denProfileModeFixture.addVisitorWatchlist(2, 'Two')),
  ]);
  for (const tab of [page, other]) {
    await expect
      .poll(() => tab.evaluate(() => window.denProfileModeFixture.snapshot().watchlist.sort()))
      .toEqual(['One', 'Two']);
  }

  await page.getByRole('button', { name: 'Switch profile, current Visitor' }).click();
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(other.locator('[data-mode]')).toHaveText('Owner active');
  await expect(
    other.evaluate(() => window.denProfileModeFixture.addVisitorWatchlist(3, 'Three')),
  ).resolves.toBe('inactive');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith(`den.profile.visitor.v1:${id}:`),
          ),
        visitId,
      ),
    )
    .toEqual([]);
  await other.close();
});
