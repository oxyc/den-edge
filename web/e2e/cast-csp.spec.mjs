// The real built Cast page under the Content-Security-Policy den-edge serves it with (`src/cast.rs`), which admits no
// inline style or script. The page's Cast button is its own, shown once the SDK has found a receiver, and coloured by
// the player through the CSSOM: none of that may need an inline exception, or the button would never show.
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_ORIGIN } from './base-url.mjs';

const ORIGIN = E2E_ORIGIN;
const CAST = 'https://cast.test';
const web = fileURLToPath(new URL('..', import.meta.url));

/** The policy `cast.rs` builds, read from its source: its `format!` literal, continuations joined. */
function servedPolicy() {
  const source = readFileSync(join(web, '..', 'src', 'cast.rs'), 'utf8');
  const literal = /let csp = format!\(\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(source)?.[1];
  if (!literal) throw new Error('no CSP literal in src/cast.rs');
  return literal.replace(/\\\n\s*/g, '').replace('{PARENT_ORIGINS}', ORIGIN);
}

/** Google's sender, as far as discovery goes: a receiver is on the network once `setOptions` has started it. */
const SDK = `
  window.chrome = window.chrome || {};
  window.chrome.cast = {
    AutoJoinPolicy: { PAGE_SCOPED: 'page_scoped' },
    media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845' },
  };
  const listeners = {};
  let state = 'NO_DEVICES_AVAILABLE';
  const context = {
    setOptions() {
      setTimeout(() => {
        state = 'NOT_CONNECTED';
        (listeners.caststatechanged || []).forEach((fn) => fn({ castState: state }));
      }, 50);
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getCurrentSession() { return null; },
    getCastState() { return state; },
    endCurrentSession() {},
  };
  window.cast = { framework: {
    CastContext: { getInstance: () => context },
    CastContextEventType: { SESSION_STATE_CHANGED: 'sessionstatechanged', CAST_STATE_CHANGED: 'caststatechanged' },
    RemotePlayer: function () {},
    RemotePlayerController: function () { this.addEventListener = () => {}; },
    RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
  } };
  const announce = setInterval(() => {
    if (!window.__onGCastApiAvailable) return;
    clearInterval(announce);
    window.__onGCastApiAvailable(true);
  }, 10);
`;

let built;
test.beforeAll(() => {
  built = mkdtempSync(join(tmpdir(), 'den-cast-csp-'));
  execFileSync('npx', ['vite', 'build', '--config', 'vite.cast.config.ts', '--outDir', built], {
    cwd: web,
    // Production uses CSP's space-separated source-list syntax for the same build value. The sender must parse
    // both entries rather than treating the whole value as one impossible postMessage origin.
    env: { ...process.env, VITE_DEN_PARENT_ORIGINS: `${ORIGIN} https://another-parent.test` },
    stdio: 'ignore',
  });
});
test.afterAll(() => rmSync(built, { recursive: true, force: true }));

test('under the policy den-edge serves, the Cast button shows once a receiver is found', async () => {
  const policy = servedPolicy();
  expect(policy).not.toContain('unsafe-inline');
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route('https://www.gstatic.com/**', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: SDK }),
    );
    await context.route(`${CAST}/**`, async (r) => {
      const path = new URL(r.request().url()).pathname;
      const file = path === '/' ? 'index.html' : path.slice(1);
      const type = file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : 'text/css';
      const body = await readFile(join(built, file)).catch(() => undefined);
      if (!body) return r.abort().catch(() => undefined);
      return r.fulfill({ contentType: type, headers: { 'content-security-policy': policy }, body });
    });
    // The player as the cast page sees it: the handshake, then the Cast button's layout and colour.
    await page.route(`${ORIGIN}/cast-parent`, (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><script>
          addEventListener('message', (e) => {
            if (e.origin !== '${CAST}' || e.data.type !== 'den-ready') return;
            e.source.postMessage({ type: 'den-discover' }, '${CAST}');
            e.source.postMessage({ type: 'den-layout', layout: 'button', color: 'rgb(255, 0, 0)', iconSize: 22 }, '${CAST}');
          });
        </script><iframe src="${CAST}/" style="width:44px;height:44px" onload="this.contentWindow.postMessage({ type: 'den-handshake', generation: 'csp' }, '${CAST}')"></iframe>`,
      }),
    );
    await context.addInitScript(() => {
      window.violations = [];
      addEventListener('securitypolicyviolation', (event) =>
        window.violations.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    });
    await page.goto(`${ORIGIN}/cast-parent`);
    const cast = page.frameLocator(`iframe[src^="${CAST}"]`).locator('#cast');
    await expect(cast).toBeVisible();
    await expect(cast).toHaveCSS('color', 'rgb(255, 0, 0)');
    const box = await cast.boundingBox();
    expect(box?.width).toBeGreaterThan(0);
    const frame = page.frames().find((candidate) => candidate.url().startsWith(CAST));
    expect(await frame.evaluate(() => window.violations)).toEqual([]);
  } finally {
    await browser.close();
  }
});
