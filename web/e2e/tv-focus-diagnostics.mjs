// Evidence for the TV focus and readiness waits that have failed on CI without reproducing locally (#1376). Each
// helper only adds what the page looked like to the failure message; none of them retries or relaxes the wait.

/** Keeps the last 40 focus changes (with the caller of any programmatic `focus()`/`blur()`) on `window`. */
export async function recordFocusTrail(page) {
  await page.addInitScript(() => {
    const trail = (window.__focusTrail = []);
    const push = (kind, node, stack = '') => {
      const label = String(node?.outerHTML ?? node).slice(0, 80);
      trail.push(
        `${Math.round(performance.now())}ms ${kind} ${label} ${location.pathname}${stack}`,
      );
      if (trail.length > 40) trail.shift();
    };
    for (const method of ['focus', 'blur']) {
      const original = HTMLElement.prototype[method];
      HTMLElement.prototype[method] = function (...args) {
        push(
          `${method}()`,
          this,
          ` <- ${new Error().stack.split('\n').slice(2, 4).join(' <- ').trim()}`,
        );
        return original.apply(this, args);
      };
    }
    document.addEventListener('focusin', (event) => push('focusin', event.target), true);
    document.addEventListener('focusout', (event) => push('focusout', event.target), true);
  });
}

async function snapshot(page, rootSelector) {
  return page
    .evaluate((selector) => {
      const root = document.querySelector(selector);
      return {
        path: location.pathname,
        active: document.activeElement?.outerHTML.slice(0, 200) ?? 'null',
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        pages: [...document.querySelectorAll('[data-route-page]')].map(
          (node) =>
            `${node.getAttribute('data-route-page')} active=${node.getAttribute('data-active')}`,
        ),
        root: root ? root.outerHTML.slice(0, 1200) : 'missing',
        trail: window.__focusTrail ?? 'not recorded',
      };
    }, rootSelector)
    .catch((error) => `snapshot failed: ${error.message}`);
}

/** Runs `wait`; when it fails, rethrows with the page state that explains it appended. */
export async function withPageState(page, rootSelector, wait) {
  try {
    await wait();
  } catch (error) {
    const state = await snapshot(page, rootSelector);
    error.message += `\n\nPage state: ${JSON.stringify(state, null, 1)}`;
    throw error;
  }
}
