// How often a browser sends the household's assistant projection while its library keeps changing, as it does while a
// TV saves playback progress every minute (Continue Watching carries the progress). den-edge takes 60 sends an hour per
// grant from all the household's devices together (den-spec assistant-v1 §15), so a browser that sent every change
// once it had stood 30 s spent that budget alone, and one refused tried again every 30 s, a whole build each time.
// Real time throughout: the publish tick and the library Worker's clock are the page's own (`@soak`).
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, forgetPublication, routeBigHousehold } from './big-library.mjs';

/** A film nobody in the household has touched: toggling its Watchlist is a change of the projection. */
const FILM = 990_001;
/** Each change stands longer than two publish ticks (30 s), so every one of them would have settled and been sent. */
const CHANGE_EVERY_MS = 65_000;

test('a big household’s projection is sent at most every five minutes while its library changes, and a refusal is waited out @soak', async () => {
  test.setTimeout(900_000);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const edge = newEdge({ profiles: true });
    await bigHousehold(context, edge);
    await forgetPublication(context, edge);

    // Two tabs: one on a film, which publishes (its Web Lock) and is where the library changes; Home beside it.
    const film = await context.newPage();
    await routeBigHousehold(film, edge);
    const sent = edge.assistant.projections.length;
    await film.goto(`${E2E_ORIGIN}/movie/${FILM}`);
    await expect.poll(() => edge.assistant.projections.length, { timeout: 60_000 }).toBe(sent + 1);
    const home = await context.newPage();
    await routeBigHousehold(home, edge);
    await home.goto(`${E2E_ORIGIN}/`);

    const watchlist = film.getByRole('button', { name: 'Watchlist', exact: true });
    for (let change = 0; change < 4; change += 1) {
      const pressed = await watchlist.getAttribute('aria-pressed');
      await watchlist.click();
      await expect(watchlist).not.toHaveAttribute('aria-pressed', pressed ?? 'false');
      await film.waitForTimeout(CHANGE_EVERY_MS);
    }
    // Four changes over four minutes and twenty seconds, each sent before (a send a minute): none until five minutes
    // after the first send, from either tab.
    expect.soft(edge.assistant.projections.length - sent, 'projections sent').toBe(1);

    // den-edge refuses every upload with an hour's wait. A page opened next — this browser having forgotten what it
    // sent, so it builds and sends at once — is refused once and waits that hour. The tabs close first: an open one
    // records its publication again whenever it builds.
    await film.close();
    await home.close();
    edge.assistant.retryAfter = 3600;
    await forgetPublication(context, edge);
    const again = await context.newPage();
    await routeBigHousehold(again, edge);
    await again.goto(`${E2E_ORIGIN}/`);
    await expect.poll(() => edge.assistant.refused.length, { timeout: 60_000 }).toBe(1);
    // Three publish ticks: each would have built and sent it again.
    await again.waitForTimeout(100_000);
    expect(edge.assistant.refused.length, 'uploads refused').toBe(1);
  } finally {
    await browser.close();
  }
});
