// The real cast page against a Cast SDK that says it is available before its framework has loaded, which is what
// desktop Chrome does. The page took that callback as final, never started Cast, and so never found a receiver:
// pressing Cast said "No Chromecast found" with one on the network.
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_ORIGIN } from './base-url.mjs';

const ORIGIN = E2E_ORIGIN;
const CAST = 'https://cast.test';
const web = fileURLToPath(new URL('..', import.meta.url));

/**
 * Google's sender as Chrome runs it: the availability callback first, the framework `frameworkDelay` ms later. Its
 * context sees a receiver only once `setOptions` has been called, as the real one starts discovery only then.
 */
const sdk = (frameworkDelay) => `
  window.chrome = window.chrome || {};
  window.chrome.cast = {
    AutoJoinPolicy: { PAGE_SCOPED: 'page_scoped' },
    media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845' },
  };
  const announce = setInterval(() => {
    if (!window.__onGCastApiAvailable) return;
    clearInterval(announce);
    window.__onGCastApiAvailable(true);
    setTimeout(defineFramework, ${frameworkDelay});
  }, 10);
  function defineFramework() {
    const listeners = {};
    let state = 'NO_DEVICES_AVAILABLE';
    const context = {
      setOptions() {
        window.castOptionsSet = true;
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
  }
`;

let built;
test.beforeAll(() => {
  built = mkdtempSync(join(tmpdir(), 'den-cast-sdk-'));
  execFileSync('npx', ['vite', 'build', '--config', 'vite.cast.config.ts', '--outDir', built], {
    cwd: web,
    env: { ...process.env, VITE_DEN_PARENT_ORIGINS: ORIGIN },
    stdio: 'ignore',
  });
});
test.afterAll(() => rmSync(built, { recursive: true, force: true }));

test('a Cast SDK whose framework arrives after its availability callback still finds the receiver', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await context.route('https://www.gstatic.com/**', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: sdk(500) }),
    );
    await context.route(`${CAST}/**`, async (r) => {
      const path = new URL(r.request().url()).pathname;
      const file = path === '/' ? 'index.html' : path.slice(1);
      const type = file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : 'text/css';
      return r.fulfill({ contentType: type, body: await readFile(join(built, file)) });
    });
    // The player, as far as the cast page can tell: it embeds the page and asks whether a receiver is there.
    await page.route(`${ORIGIN}/cast-parent`, (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><script>
          window.answers = [];
          addEventListener('message', (e) => {
            if (e.origin !== '${CAST}') return;
            if (e.data.type === 'den-ready') e.source.postMessage({ type: 'den-discover' }, '${CAST}');
            if (e.data.type === 'den-cast-availability') window.answers.push(e.data.available);
          });
        </script><iframe src="${CAST}/"></iframe>`,
      }),
    );
    await page.goto(`${ORIGIN}/cast-parent`);
    const cast = () => page.frames().find((frame) => frame.url().startsWith(CAST));
    await expect.poll(() => cast()?.evaluate(() => window.castOptionsSet === true)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.answers.at(-1))).toBe(true);
    expect(await cast().evaluate(() => document.querySelector('google-cast-launcher').hidden)).toBe(
      false,
    );
    expect(errors.filter((e) => e.includes('Cast could not start'))).toEqual([]);
  } finally {
    await browser.close();
  }
});
