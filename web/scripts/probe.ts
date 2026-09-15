// What a trailer actually did, reported by the device that played it. Dev server only.
//
// iOS Safari has no console unless a Mac is tethered to it, so a phone cannot be asked what it saw — and
// the phone is exactly where the unanswered questions are. This injects a small probe into the pages the
// dev server hands out, and logs what it beacons back, so a real browsing session on a real device is
// readable from the terminal beside reel's own log.
//
// `apply: 'serve'` keeps this out of a build entirely, and `DEN_PROBE=1` keeps it out of the dev server
// unless it was asked for (see vite.config.ts). Both matter: injected unconditionally, the beacon lands in
// the e2e suite as well, where an unmocked `POST /__probe` fails every spec that guards the network.
import type { Plugin } from 'vite';

/** Runs in the page. Deliberately small, dependency-free, and silent when anything is unsupported. */
const PROBE = `
(() => {
  // Which device spoke, because the open question is iOS against macOS and the log cannot otherwise tell.
  const ua = navigator.userAgent;
  const device = /iPhone|iPad/.test(ua) ? 'ios' : /Macintosh/.test(ua) ? 'mac' : 'other';
  const send = (line) => {
    try {
      navigator.sendBeacon('/__probe', line + '\\n');
    } catch {
      /* A probe that throws would be worse than one that misses a line. */
    }
  };
  const seen = new WeakSet();
  const look = () => {
    for (const v of document.querySelectorAll('video')) {
      if (seen.has(v)) continue;
      seen.add(v);
      // The billboard's element carries its own class; anything else on a detail page is the hero.
      const where = v.classList.contains('ambient') ? 'billboard' : 'hero';
      const born = performance.now();
      const since = () => Math.round(performance.now() - born) + 'ms';
      // Only the tail of the path: a minted blob is long, and its last characters identify it well enough.
      const src = () => {
        const u = v.currentSrc || v.getAttribute('src') || '-';
        return u.replace(/^https?:\\/\\/[^/]+/, '').slice(-64);
      };
      const note = (why, extra) =>
        send([device, location.pathname, where, why, since(), src(), extra || ''].join(' | '));
      // stalled and waiting are the two that say "slow" rather than "broken", which is the open question.
      for (const event of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'stalled', 'waiting'])
        v.addEventListener(event, () => note(event));
      v.addEventListener('error', () => note('error', 'code=' + (v.error ? v.error.code : '?')));
      // The only honest "a frame is on screen" signal. Safari 15.4+.
      if (v.requestVideoFrameCallback)
        v.requestVideoFrameCallback(() => note('firstframe', v.videoWidth + 'x' + v.videoHeight));
      note('mounted');
    }
  };
  // Polled rather than observed: the app mounts and replaces these elements as it navigates, and a
  // MutationObserver over the whole document costs more than a cheap look four times a second.
  setInterval(look, 250);
  addEventListener('pageshow', look);
})();
`;

export function probe(): Plugin {
  return {
    name: 'den-probe',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__probe', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk;
          // A beacon is a line or two; anything larger is not this.
          if (body.length > 64_000) request.destroy();
        });
        request.on('end', () => {
          for (const line of body.split('\n'))
            if (line.trim()) server.config.logger.info(`probe ${line}`);
          response.statusCode = 204;
          response.end();
        });
      });
    },
    transformIndexHtml() {
      return [{ tag: 'script', children: PROBE, injectTo: 'head' as const }];
    },
  };
}
