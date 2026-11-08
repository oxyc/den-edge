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

/** Den's receiver page's policy, from its `RECEIVER_CSP` literal in `src/cast.rs`. */
function receiverPolicy() {
  const source = readFileSync(join(web, '..', 'src', 'cast.rs'), 'utf8');
  const literal = /const RECEIVER_CSP: &str = "((?:[^"\\]|\\[\s\S])*)"/.exec(source)?.[1];
  if (!literal) throw new Error('no RECEIVER_CSP literal in src/cast.rs');
  return literal.replace(/\\\n\s*/g, '');
}

/**
 * Google's receiver framework, as far as Den's receiver uses it: a context whose `canDisplayType` answers as a 4K
 * Chromecast on an HDR10 TV with Dolby Vision 8 and Dolby Digital passthrough. What the page sends a sender is kept in
 * `window.toSender`; `window.__fromSender(data)` is a sender's message on Den's namespace.
 */
const RECEIVER_SDK = `
  window.toSender = [];
  const custom = {};
  const context = {
    addCustomMessageListener(ns, fn) { custom[ns] = fn; },
    sendCustomMessage(ns, senderId, message) { window.toSender.push({ ns, senderId, message }); },
    canDisplayType(type) {
      if (window.started === undefined) throw new Error('canDisplayType before start');
      const codec = (/codecs="([^"]+)"/.exec(type) || [])[1] || '';
      if (Number((/width=(\\d+)/.exec(type) || [])[1] || 0) > 3840) return false;
      if (/eotf=arib-std-b67/.test(type)) return false;
      if (type.startsWith('audio/')) return ['mp4a.40.2', 'ec-3', 'ac-3'].includes(codec);
      const avc = /^avc1\\.6400([0-9a-f]{2})$/i.exec(codec);
      if (avc) return parseInt(avc[1], 16) <= 0x33;
      const hevc = /^(?:hvc1|hev1)\\.[12]\\.[46]\\.L(\\d+)\\.B0$/.exec(codec);
      if (hevc) return Number(hevc[1]) <= 153;
      return codec.startsWith('dvh1.08');
    },
    getPlayerManager() { return { addEventListener(_type, fn) { window.__mediaStatus = fn; } }; },
    start(options) { window.started = options; },
  };
  window.__fromSender = (data) => custom['urn:x-cast:fi.oxy.den']({ senderId: 'phone', data });
  window.cast = { framework: {
    CastReceiverContext: { getInstance: () => context },
    events: { EventType: { MEDIA_STATUS: 'mediastatus' } },
    system: { MessageType: { JSON: 'JSON' } },
  } };
`;

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

test('Den’s receiver, under its policy, shows Den while idle and tells a sender what the TV plays', async () => {
  const policy = receiverPolicy();
  expect(policy).toContain("frame-ancestors 'none'");
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const framework = [];
    await context.route('https://www.gstatic.com/**', (r) => {
      framework.push(new URL(r.request().url()).pathname);
      return r.fulfill({ contentType: 'text/javascript', body: RECEIVER_SDK });
    });
    await context.route(`${CAST}/**`, async (r) => {
      const file = new URL(r.request().url()).pathname.slice(1);
      const type = file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : 'text/css';
      const body = await readFile(join(built, file)).catch(() => undefined);
      if (!body) return r.abort().catch(() => undefined);
      return r.fulfill({ contentType: type, headers: { 'content-security-policy': policy }, body });
    });
    await context.addInitScript(() => {
      window.violations = [];
      addEventListener('securitypolicyviolation', (event) =>
        window.violations.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    });
    await page.goto(`${CAST}/receiver.html`);
    expect(framework).toEqual(['/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js']);
    await expect(page.locator('.brand')).toBeVisible();
    await expect(page.locator('.brand')).toHaveText('Den');
    await expect
      .poll(() => page.evaluate(() => window.started?.customNamespaces))
      .toEqual({ 'urn:x-cast:fi.oxy.den': 'JSON' });

    await page.evaluate(() => window.__fromSender({ type: 'den-capabilities' }));
    await expect.poll(() => page.evaluate(() => window.toSender.length)).toBe(1);
    const [answer] = await page.evaluate(() => window.toSender);
    expect(answer).toMatchObject({ ns: 'urn:x-cast:fi.oxy.den', senderId: 'phone' });
    expect(answer.message).toMatchObject({
      type: 'den-capabilities',
      details: { maxHeight: 2160 },
    });
    expect(answer.message.playable).toEqual({
      h264: 0x33,
      h264High10: 0,
      hevcMain: 153,
      hevcMain10: 153,
      hevcHighTier: 0,
      hdr: true,
      eac3: true,
      aacMultichannel: false,
      dolbyVision: { p5: false, p8: true },
      av1: 0,
      av1Main10: 0,
      av1Hdr: false,
      flac: false,
      aac71: false,
      vp9: false,
      vp9Profile2: false,
    });
    // Anything else on the namespace is not answered.
    await page.evaluate(() => window.__fromSender({ type: 'other' }));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.toSender.length)).toBe(1);

    // Playing, Google's player is the picture; idle again, Den's screen returns.
    await page.evaluate(() => window.__mediaStatus({ mediaStatus: { playerState: 'PLAYING' } }));
    await expect(page.locator('.brand')).toBeHidden();
    await page.evaluate(() => window.__mediaStatus({ mediaStatus: { playerState: 'IDLE' } }));
    await expect(page.locator('.brand')).toBeVisible();
    expect(await page.evaluate(() => window.violations)).toEqual([]);
  } finally {
    await browser.close();
  }
});
