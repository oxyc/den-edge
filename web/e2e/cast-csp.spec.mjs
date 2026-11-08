// The real built Cast page under the Content-Security-Policy den-edge serves it with (`src/cast.rs`). Google's Cast
// launcher reveals itself by setting its own `style` attribute once a receiver is found; under `style-src 'self'`
// Chrome refuses that style, the launcher stays `display: none` at 0×0, and there is no button to cast with.
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

/**
 * Google's sender, as far as the launcher goes: the element notes the display it has when it is taken over, hides
 * itself through the CSSOM (which no policy stops) and, once the context reports a receiver, shows itself by rewriting
 * its `style` attribute with the display it noted, as the real one does. A launcher that was `hidden` when taken over
 * is therefore "shown" as `display: none`.
 */
const SDK = `
  window.chrome = window.chrome || {};
  window.chrome.cast = {
    AutoJoinPolicy: { PAGE_SCOPED: 'page_scoped' },
    media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845' },
  };
  customElements.define('google-cast-launcher', class extends HTMLElement {
    connectedCallback() { this.shown = getComputedStyle(this).display; this.style.display = 'none'; }
  });
  const listeners = {};
  let state = 'NO_DEVICES_AVAILABLE';
  const context = {
    setOptions() {
      setTimeout(() => {
        state = 'NOT_CONNECTED';
        const launcher = document.querySelector('google-cast-launcher');
        launcher.setAttribute('style', 'display: ' + launcher.shown + ';');
        window.launcherRevealed = true;
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

test('under the policy den-edge serves, the Cast launcher shows once a receiver is found', async () => {
  // The SDK above runs `setOptions` before the page adds the launcher, so its reveal must find one by then.
  const policy = servedPolicy();
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
      return r.fulfill({
        contentType: type,
        headers: { 'content-security-policy': policy },
        body: await readFile(join(built, file)),
      });
    });
    await page.route(`${ORIGIN}/cast-parent`, (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><iframe src="${CAST}/"></iframe>`,
      }),
    );
    await page.goto(`${ORIGIN}/cast-parent`);
    const cast = () => page.frames().find((frame) => frame.url().startsWith(CAST));
    await expect.poll(() => cast()?.evaluate(() => window.launcherRevealed === true)).toBe(true);
    const launcher = await cast().evaluate(() => {
      const element = document.querySelector('google-cast-launcher');
      const box = element.getBoundingClientRect();
      return { display: getComputedStyle(element).display, width: box.width, height: box.height };
    });
    expect(launcher.display).not.toBe('none');
    expect(launcher.width).toBeGreaterThan(0);
    expect(launcher.height).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});
