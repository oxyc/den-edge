// `bigHousehold` waits on den-edge for its move, not on the page. A machine short of memory has the kernel kill a
// renderer mid-move; that page sends nothing more, so the wait sat out its whole three minutes and read as a move that
// stalled at some thousands of rows. A crashed page must fail the setup at once, saying so.
import { test, expect } from '@playwright/test';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold } from './big-library.mjs';

test('a household page that crashes mid-move fails the big household at once, saying so', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const edge = newEdge({ profiles: true });
  let crashedAt = 0;
  context.once('page', async (page) => {
    // Once the Owner library holds part of the history: the move is under way.
    await expect
      .poll(
        () => Math.max(0, ...[...edge.libraries.values()].map((library) => library.rows.size)),
        {
          timeout: 45_000,
        },
      )
      .toBeGreaterThan(500);
    const cdp = await context.newCDPSession(page);
    crashedAt = Date.now();
    await cdp.send('Page.crash').catch(() => {});
  });
  await expect(bigHousehold(context, edge)).rejects.toThrow(/household page crashed/);
  expect(crashedAt).toBeGreaterThan(0);
  expect(Date.now() - crashedAt).toBeLessThan(5_000);
  await context.close();
});
