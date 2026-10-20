// Opening a link in a new tab, read the way that cannot miss it: what a modified click opened, and where.
import { expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

/** How long the browser may take to open a tab and commit its first document, on a loaded runner. */
export const NEW_TAB_MS = 30_000;

/**
 * The addresses of the tabs `click` opens, once each has committed its first document.
 *
 * In Chromium they are read from the browser's own target list, not from Playwright's pages. Playwright attaches to a
 * tab the browser opened itself while that tab's first navigation may already be committing, and it only listens for
 * commits once `Page.getFrameTree` has answered. A commit in between is never seen: a tab whose tree still read "" is
 * never handed over (its page event waits for that commit for good), and one that read about:blank is handed over and
 * keeps that address. `Target.targetInfoChanged` is the browser's, and it says where the tab is either way.
 */
export async function openedByBrowser(browser, context, page, click) {
  if (browser.browserType().name() !== 'chromium') {
    const opened = context.waitForEvent('page', { timeout: NEW_TAB_MS });
    await click();
    const other = await opened;
    await expect.poll(() => other.url(), { timeout: NEW_TAB_MS }).not.toBe('about:blank');
    return context
      .pages()
      .filter((p) => p !== page)
      .map((p) => p.url());
  }
  const cdp = await browser.newBrowserCDPSession();
  try {
    const before = new Set(
      (await cdp.send('Target.getTargets')).targetInfos.map((target) => target.targetId),
    );
    const tabs = new Map();
    const seen = ({ targetInfo }) => {
      if (targetInfo.type === 'page' && !before.has(targetInfo.targetId))
        tabs.set(targetInfo.targetId, targetInfo.url);
    };
    cdp.on('Target.targetCreated', seen);
    cdp.on('Target.targetInfoChanged', seen);
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await click();
    const committed = () => {
      const urls = [...tabs.values()];
      return urls.length > 0 && urls.every((url) => url && url !== 'about:blank') ? urls : null;
    };
    await expect.poll(committed, { timeout: NEW_TAB_MS }).not.toBeNull();
    return committed();
  } finally {
    await cdp.detach();
  }
}

/**
 * Keep a tab opened at `opening` from starting the app: its document is a stub where a route can answer it, and where
 * none can, what the dev server's page asks for next is refused.
 *
 * No route sees the tab's document request in WebKit, nor in Chromium when the tab asks before Playwright has attached
 * to it, so the dev server answers with the app's page. What that page then asks for is refused here: its manifest and
 * icons, and its entry script, so the app never starts there and makes none of its requests. The opening page's own
 * requests to this origin are its page routes' to answer, which come first, so it never meets these.
 */
export async function stubNewTab(context, opening) {
  await context.route(opening, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Opened</title>' }),
  );
  await context.route(
    new RegExp(
      `^${E2E_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:src/main\\.ts|manifest\\.webmanifest|favicon[^/]*|apple-touch-icon\\.png)$`,
    ),
    (route) => route.abort('blockedbyclient'),
  );
}
