import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { Plugin } from 'vite';

function diagnosticPath(value: string | undefined): string {
  // Keep only known navigation/static identities. Addon configuration, signed media, pairing and recovery
  // credentials can live in path segments, not just query strings. Unknown paths are deliberately opaque.
  const path = (value ?? '').split(/[?#]/, 1)[0] ?? '';
  if (
    /^\/(?:watchlist|search|settings|movies|series|__den\/release)?$/.test(path) ||
    /^\/(?:movie|tv|person)\/\d+$/.test(path) ||
    /^\/assets\/[\w.-]+\.(?:js|css|wasm|woff2?|svg|png|webp)$/.test(path)
  )
    return path;
  return '/[redacted]';
}

// Test-server evidence only. A Playwright-fulfilled API response says nothing about whether Vite received
// an unanswered document request (#746). Record at the actual HTTP boundary, before SPA/static middleware.
export function previewDiagnostics(file: string | undefined): Plugin | false {
  if (!file) return false;
  if (process.env.DEN_E2E !== '1') throw new Error('Preview diagnostics require DEN_E2E=1');

  return {
    name: 'den-e2e-preview-diagnostics',
    configurePreviewServer(server) {
      const warn = () =>
        console.warn('TV preview diagnostics unavailable; continuing without server evidence.');
      let output: WriteStream;
      try {
        mkdirSync(dirname(file), { recursive: true });
        output = createWriteStream(file, { flags: 'w' });
      } catch {
        warn();
        return;
      }
      let unavailable = false;
      let bytes = 0;
      let truncated = false;
      const write = (event: string, fields: Record<string, unknown> = {}) => {
        if (unavailable || truncated) return;
        const at = new Date().toISOString();
        const line = JSON.stringify({ at, event, ...fields }) + '\n';
        bytes += Buffer.byteLength(line);
        if (bytes > 8 * 1024 * 1024) {
          truncated = true;
          output.write(
            JSON.stringify({ at, event: 'truncated', limitBytes: 8 * 1024 * 1024 }) + '\n',
          );
          return;
        }
        output.write(line);
      };
      const pending = new Map<number, { method: string; path: string; started: number }>();
      let sequence = 0;
      const delay = monitorEventLoopDelay({ resolution: 20 });
      delay.enable();
      let previousCpu = process.cpuUsage();
      let previousLoop = performance.eventLoopUtilization();
      let previousSample = performance.now();

      write('start', {
        pid: process.pid,
        platform: process.env.DEN_TV_PLATFORM,
        engine: process.env.DEN_TV_TEST_ENGINE ?? 'chromium',
        commit: process.env.GITHUB_SHA,
        run: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        cpus: availableParallelism(),
        totalMemoryBytes: totalmem(),
      });
      server.middlewares.use((request, response, next) => {
        if (unavailable) return next();
        const id = ++sequence;
        // Never record headers, bodies, query strings or fragments (invite/capability material).
        const entry = {
          method: request.method ?? '',
          path: diagnosticPath(request.url),
          started: performance.now(),
        };
        pending.set(id, entry);
        write('request', { id, method: entry.method, path: entry.path });
        let ended = false;
        const end = (event: string) => {
          if (ended) return;
          ended = true;
          pending.delete(id);
          write(event, {
            id,
            durationMs: performance.now() - entry.started,
            status: response.headersSent ? response.statusCode : null,
          });
        };
        response.once('finish', () => end('finish'));
        response.once('close', () => end('close'));
        next();
      });

      // A missing heartbeat or a large elapsed interval is evidence too: it exposes preview event-loop
      // starvation. Load/memory are runner-wide; CPU and event-loop figures belong to this preview process.
      const timer = setInterval(() => {
        const now = performance.now();
        const cpu = process.cpuUsage();
        const loop = performance.eventLoopUtilization();
        write('sample', {
          elapsedMs: now - previousSample,
          cpuUserMicros: cpu.user - previousCpu.user,
          cpuSystemMicros: cpu.system - previousCpu.system,
          eventLoopUtilization: performance.eventLoopUtilization(loop, previousLoop).utilization,
          eventLoopDelayMaxMs: delay.max / 1e6,
          rssBytes: process.memoryUsage().rss,
          freeMemoryBytes: freemem(),
          loadAverage: loadavg(),
          pending: [...pending].map(([id, entry]) => ({ id, ageMs: now - entry.started })),
        });
        previousSample = now;
        previousCpu = cpu;
        previousLoop = loop;
        delay.reset();
      }, 1_000);
      timer.unref();
      output.once('error', () => {
        unavailable = true;
        clearInterval(timer);
        delay.disable();
        warn();
      });
      server.httpServer.once('listening', () => write('listening'));
      server.httpServer.once('close', () => {
        clearInterval(timer);
        delay.disable();
        write('stop', { pending: [...pending.keys()] });
        if (!unavailable) output.end();
      });
    },
  };
}
