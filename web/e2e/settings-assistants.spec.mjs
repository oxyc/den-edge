import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

const MCP_URL = 'https://den.example/mcp';

/**
 * Settings, with den-edge's `/config` saying `config` and its `/oauth/connections` answering `connections`. Returns the
 * page and the connector requests it made.
 */
async function settings(browser, { config, connections = [] }) {
  const asked = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    reducedMotion: 'reduce',
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:5198',
  });
  const page = await context.newPage();
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('**/version', (r) => r.fulfill({ json: { version: '0.67.0' } }));
  await page.route('**/config', (r) => r.fulfill({ json: config }));
  await routeTmdb(page, (route) => route.fulfill({ json: { results: [], images: {} } }));
  await page.route('**/oauth/connections**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    asked.push(`${request.method()} ${path}`);
    if (request.method() === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ json: { connections } });
  });
  await page.goto('http://127.0.0.1:5198/test/settings.html');
  return { page, asked };
}

const CONNECTED = [
  {
    sid: 'a'.repeat(32),
    client: 'Claude',
    redirectHost: 'claude.ai',
    kind: 'member',
    guest: null,
    createdAt: Date.UTC(2026, 8, 20),
    usedAt: Date.UTC(2026, 8, 22),
  },
  {
    sid: 'b'.repeat(32),
    client: 'ChatGPT',
    redirectHost: 'chatgpt.com',
    kind: 'guest',
    guest: 'Sam',
    createdAt: Date.UTC(2026, 8, 21),
    usedAt: Date.UTC(2026, 8, 21),
  },
];

test('Assistants gives the connector address to copy, how to add it, and what is connected', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { page, asked } = await settings(browser, {
      config: { mcpUrl: MCP_URL },
      connections: CONNECTED,
    });
    const section = page.getByRole('region', { name: /Assistants/ });
    await expect(
      page.getByRole('heading', {
        name: /Assistants.*MCP connector for Claude and ChatGPT/,
        level: 2,
      }),
    ).toBeVisible();

    // The address is the one den-edge's /config names, shown before the row is opened, and copied from it.
    const connector = page.getByRole('button', { name: /Connector address/ });
    await expect(connector).toContainText(MCP_URL);
    await connector.click();
    const panel = page.getByRole('region', { name: 'Connector address' });
    await expect(panel.getByLabel('Connector address')).toHaveValue(MCP_URL);
    await panel.getByRole('button', { name: 'Copy' }).click();
    await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MCP_URL);
    await expect(panel.getByRole('heading', { name: 'Claude' })).toBeVisible();
    await expect(panel).toContainText('Add custom connector');
    await expect(panel.getByRole('heading', { name: 'ChatGPT' })).toBeVisible();
    await expect(panel).toContainText('Discovery only');
    await expect(panel).toContainText('nothing from TMDB');

    // Who is connected, by name and the host that holds it, as a member's or a guest's.
    const row = page.getByRole('button', { name: /Connected assistants/ });
    await expect(row).toContainText('2 connected');
    await row.click();
    const listed = page.getByRole('region', { name: 'Connected assistants' }).getByRole('listitem');
    await expect(listed).toHaveCount(2);
    await expect(listed.filter({ hasText: 'Claude' })).toContainText('claude.ai');
    await expect(listed.filter({ hasText: 'Claude' })).toContainText('Member · connected');
    await expect(listed.filter({ hasText: 'ChatGPT' })).toContainText('Guest · Sam');

    // Disconnect asks first, then ends that connection alone.
    await section.getByRole('button', { name: 'Disconnect Claude' }).click();
    const confirm = section.getByRole('group', { name: 'Disconnect Claude?' });
    await confirm.getByRole('button', { name: 'Disconnect' }).click();
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText('ChatGPT');
    expect(asked).toEqual([
      'GET /oauth/connections',
      `DELETE /oauth/connections/${'a'.repeat(32)}`,
    ]);
  } finally {
    await browser.close();
  }
});

test('Assistants says when the connector is not enabled on this server', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { page, asked } = await settings(browser, { config: {} });
    const section = page.getByRole('region', { name: /Assistants/ });
    await expect(section).toContainText('Not enabled on this server');
    await expect(section.getByRole('button', { name: 'Copy' })).toHaveCount(0);
    await expect(section).not.toContainText('Add custom connector');
    expect(asked).toEqual([]);
  } finally {
    await browser.close();
  }
});
