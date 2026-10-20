#!/usr/bin/env node

// Read-only local readiness checks for a TV preview or package. This never starts a server,
// changes DNS, installs a package, or sends credentials. Network output is deliberately redacted.
import { URL } from 'node:url';

const DEFAULT_EDGE = 'http://192.168.86.193:8094';
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const has = (name) => args.includes(name);
if (has('--help')) {
  console.log(`Usage: node scripts/tv-preflight.mjs [options]

Options:
  --url <https-url>          TV launcher/preview URL (or DEN_TV_URL/DEN_TV_HOST)
  --entry-url <url>          Local-only entry probe override for fixture testing
  --edge <url>               Den Edge origin (or DEN_EDGE; defaults to the LAN origin)
  --api-origin <https-url>   Installed Tizen API origin (or DEN_TV_API_ORIGIN)
  --media-url <https-url>    Representative HLS playlist (or DEN_TV_MEDIA_URL)
  --timeout-ms <n>           Per-request timeout (default: 5000)
  --json                     Emit safe machine-readable output
  --skip-network             Validate configured URLs without making requests`);
  process.exit(0);
}

const timeoutMs = Number(value('--timeout-ms') ?? 5000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 60_000)
  throw new Error('--timeout-ms must be an integer between 250 and 60000');
const json = has('--json');
const skipNetwork = has('--skip-network');
const failures = [];
const checks = [];

function safeOrigin(text) {
  try {
    return new URL(text).origin;
  } catch {
    return '<invalid-origin>';
  }
}

function redact(text) {
  try {
    const url = new URL(text);
    return url.origin + '/<redacted>';
  } catch {
    return '<invalid-url>';
  }
}

function record(label, status, details = {}) {
  const item = { label, status, ...details };
  checks.push(item);
  if (status === 'fail') failures.push(item);
  if (!json) {
    const suffix = Object.entries(details)
      .map(([key, itemValue]) => `${key}=${itemValue}`)
      .join(' ');
    console.log(
      `${status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL'} ${label}${suffix ? ` ${suffix}` : ''}`,
    );
  }
}

function parseUrl(
  label,
  text,
  { https = false, http = false, remote = false, exactOrigin = false, allowHttpLocal = false } = {},
) {
  if (!text) {
    record(label, 'skip', { reason: 'not configured' });
    return undefined;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    record(label, 'fail', { reason: 'invalid URL' });
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (http && !['http:', 'https:'].includes(url.protocol)) {
    record(label, 'fail', { origin: safeOrigin(text), reason: 'HTTP(S) origin is required' });
    return undefined;
  }
  if (https && url.protocol !== 'https:' && !(allowHttpLocal && loopback)) {
    record(label, 'fail', { origin: safeOrigin(text), reason: 'HTTPS is required' });
    return undefined;
  }
  if (url.username || url.password || url.hash) {
    record(label, 'fail', {
      origin: safeOrigin(text),
      reason: 'credentials/fragments are not allowed',
    });
    return undefined;
  }
  if (remote && loopback) {
    record(label, 'fail', { origin: safeOrigin(text), reason: 'TV URL cannot use loopback' });
    return undefined;
  }
  if (exactOrigin && (url.pathname !== '/' || url.search)) {
    record(label, 'fail', {
      origin: safeOrigin(text),
      reason: 'origin must not contain a path/query',
    });
    return undefined;
  }
  record(label, 'pass', { origin: url.origin, scheme: url.protocol.slice(0, -1) });
  return url;
}

async function responseText(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, Math.max(0, limit - length));
      chunks.push(chunk);
      length += chunk.length;
      if (chunk.length < value.length) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function probe(
  label,
  url,
  { origin, media = false, entry = false, module = false, health = false } = {},
) {
  if (!url) return;
  if (skipNetwork) {
    record(label, 'skip', { reason: 'network disabled', target: redact(url.href) });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: {
        accept: entry
          ? 'text/html'
          : module
            ? 'text/javascript, application/javascript'
            : media
              ? 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.5'
              : 'application/json',
        ...(media ? { range: 'bytes=0-4095' } : {}),
        ...(origin ? { origin } : {}),
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? 'unknown';
    const allowOrigin = response.headers.get('access-control-allow-origin');
    const body = await responseText(
      response,
      media ? 128 * 1024 : entry || module ? 256 * 1024 : 64 * 1024,
    );
    const elapsedMs = Math.round(performance.now() - started);
    if (response.status < 200 || response.status >= 300) {
      record(label, 'fail', { target: redact(url.href), http: response.status, elapsedMs });
      return;
    }
    if (media && !/^#EXTM3U\b/m.test(body)) {
      record(label, 'fail', {
        target: redact(url.href),
        http: response.status,
        reason: 'response is not an HLS playlist',
      });
      return;
    }
    if (entry && (!/^\s*<!doctype html\b/i.test(body) || !/<html\b/i.test(body))) {
      record(label, 'fail', {
        target: redact(url.href),
        http: response.status,
        reason: 'response is not an HTML app entry',
      });
      return;
    }
    if (entry && !/<script\b[^>]*type=["']module["'][^>]*src=/i.test(body)) {
      record(label, 'fail', {
        target: redact(url.href),
        http: response.status,
        reason: 'entry does not expose a module script',
      });
      return;
    }
    if (entry && !/<title>\s*Den TV\s*<\/title>/i.test(body)) {
      record(label, 'fail', { target: redact(url.href), reason: 'entry is not the Den TV build' });
      return;
    }
    if (health) {
      let healthy = false;
      try {
        healthy = JSON.parse(body).status === 'ok';
      } catch {
        /* Not a health response. */
      }
      if (!healthy) {
        record(label, 'fail', {
          target: redact(url.href),
          reason: 'response is not a healthy Den Edge',
        });
        return;
      }
    }
    if (
      module &&
      (!/^(?:text|application)\/(?:javascript|ecmascript)$/.test(contentType) ||
        /<html\b|<!doctype html\b/i.test(body))
    ) {
      record(label, 'fail', {
        target: redact(url.href),
        http: response.status,
        reason: 'module request returned HTML instead of JavaScript',
      });
      return;
    }
    const crossOrigin = origin && origin !== url.origin;
    if (crossOrigin && !allowOrigin) {
      record(label, 'fail', {
        target: redact(url.href),
        http: response.status,
        reason: 'CORS header missing for TV origin',
      });
      return;
    }
    if (crossOrigin && allowOrigin !== '*' && allowOrigin !== origin) {
      record(label, 'fail', {
        target: redact(url.href),
        http: response.status,
        reason: 'CORS origin mismatch',
      });
      return;
    }
    record(label, 'pass', {
      target: redact(url.href),
      http: response.status,
      type: contentType,
      cors: crossOrigin ? allowOrigin : 'not required for this request',
      elapsedMs,
    });
    return body;
  } catch (error) {
    record(label, 'fail', {
      target: redact(url.href),
      reason: error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : 'request failed',
    });
  } finally {
    clearTimeout(timer);
  }
}

const tvText =
  value('--url') ??
  process.env.DEN_TV_URL ??
  (process.env.DEN_TV_HOST ? `https://${process.env.DEN_TV_HOST}/` : undefined);
const tv = parseUrl('tv-hostname', tvText, { https: true, remote: true, exactOrigin: true });
const entryText = value('--entry-url');
const entry = entryText
  ? parseUrl('tv-entry-origin', entryText, { https: true, exactOrigin: true, allowHttpLocal: true })
  : tv;
const edge = parseUrl('edge-origin', value('--edge') ?? process.env.DEN_EDGE ?? DEFAULT_EDGE, {
  http: true,
  exactOrigin: true,
});
const api = parseUrl('tizen-api-origin', value('--api-origin') ?? process.env.DEN_TV_API_ORIGIN, {
  https: true,
  exactOrigin: true,
});
const media = parseUrl('media-playlist', value('--media-url') ?? process.env.DEN_TV_MEDIA_URL, {
  https: true,
  allowHttpLocal: true,
});

const entryBody = await probe('tv-entry', entry, { entry: true });
if (entryBody) {
  const source = /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i.exec(entryBody)?.[1];
  if (!source) record('tv-module', 'fail', { reason: 'module source is missing' });
  else {
    let moduleUrl;
    try {
      moduleUrl = new URL(source, entry);
      if (moduleUrl.origin !== entry.origin || !['http:', 'https:'].includes(moduleUrl.protocol)) {
        record('tv-module', 'fail', { reason: 'entry module must be served from the TV origin' });
        moduleUrl = undefined;
      }
    } catch {
      record('tv-module', 'fail', { reason: 'module source is not a URL' });
    }
    await probe('tv-module', moduleUrl, { module: true });
  }
}
// The hosted preview proxies this backend; the TV does not make a cross-origin request to its LAN address.
await probe('edge-health', edge && new URL('/health', edge), { health: true });
await probe('tizen-api-health', api && new URL('/health', api), {
  origin: tv?.origin,
  health: true,
});
await probe('media-playlist', media, { origin: tv?.origin, media: true });

const output = { ok: failures.length === 0, checks };
if (json) console.log(JSON.stringify(output, null, 2));
if (failures.length) process.exitCode = 1;
