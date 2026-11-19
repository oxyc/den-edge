// Evidence for the TV focus and readiness waits that have failed on CI without reproducing locally (#1376). Each
// helper only adds what the page looked like to the failure message; none of them retries or relaxes the wait.

const describe = (node) =>
  node
    ? `${node.tagName.toLowerCase()}${node.className ? '.' + String(node.className).trim().replace(/\s+/g, '.') : ''}` +
      `[${node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 24) ?? ''}]`
    : 'null';

/** Keeps the last 40 focus changes (with the caller of any programmatic `focus()`/`blur()`) on `window`. */
export async function recordFocusTrail(page) {
  await page.addInitScript(() => {
    const trail = (window.__focusTrail = []);
    const push = (kind, node, stack = '') => {
      trail.push(
        `${Math.round(performance.now())}ms ${kind} ${node ? node.tagName.toLowerCase() + '.' + String(node.className).trim().replace(/\s+/g, '.') : 'null'} ${location.pathname}${stack}`,
      );
      if (trail.length > 40) trail.shift();
    };
    for (const method of ['focus', 'blur']) {
      const original = HTMLElement.prototype[method];
      HTMLElement.prototype[method] = function (...args) {
        push(`${method}()`, this, ` <- ${new Error().stack.split('\n').slice(2, 4).join(' <- ').trim()}`);
        return original.apply(this, args);
      };
    }
    document.addEventListener('focusin', (event) => push('focusin', event.target), true);
    document.addEventListener('focusout', (event) => push('focusout', event.target), true);
  });
}

async function snapshot(page, rootSelector) {
  return page
    .evaluate(
      ({ rootSelector, describeSource }) => {
        const describe = new Function(`return ${describeSource}`)();
        const root = document.querySelector(rootSelector);
        return {
          path: location.pathname,
          active: describe(document.activeElement),
          visibility: document.visibilityState,
          hasFocus: document.hasFocus(),
          pages: [...document.querySelectorAll('[data-route-page]')].map(
            (node) => `${node.getAttribute('data-route-page')} active=${node.getAttribute('data-active')}`,
          ),
          root: root ? root.outerHTML.slice(0, 1200) : 'missing',
          trail: window.__focusTrail ?? 'not recorded',
        };
      },
      { rootSelector, describeSource: describe.toString() },
    )
    .catch((error) => `snapshot failed: ${error.message}`);
}

/** Runs `wait`; when it fails, rethrows with the page state that explains it appended. */
export async function withPageState(page, rootSelector, wait) {
  try {
    await wait();
  } catch (error) {
    error.message += `\n\nPage state: ${JSON.stringify(await snapshot(page, rootSelector), null, 1)}`;
    throw error;
  }
}
