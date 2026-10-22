// Time-to-content budgets on a household the size of a long-lived one (`big-library.mjs`), as a phone opens it again:
// WebKit at an iPhone's size, and Chromium at a phone's size with its page CPU slowed four times. Each surface is a
// returning visit, so what is measured is a household's every day rather than its first sync. It runs against the
// production build, alone (`playwright.budgets.config.ts`, `npm run test:e2e:budgets`, CI's `e2e budgets` job), never
// in the dev-server shards: there the time was the dev server's five hundred modules and the shards beside it.
//
// Two budgets per surface. Time to its content (the billboard's description, a personal row's first poster, the
// episode list, Settings' heading), generous enough for CI. And the IndexedDB transactions its library Worker makes:
// on a desktop each is nearly free, but on iOS each is a round trip to the storage process, and a load that made
// hundreds of them — one per title the library names — kept the phone's billboard text, rows and episode lists waiting
// for seconds while a desktop drew them at once. That count is what a lab machine can measure of the phone's cost.
//
// A library surface's rows have a budget of their own (`shelves ready`): they are named by the same library Worker
// that publishes the household's assistant projection, which costs a phone's Worker seconds. The visits give that
// publish the phone's cost (`PHONE_PROJECTION_MS`), and a returning visit, with the household as the last one
// published it, must build and upload none.
//
// In Chromium each visit also has a memory budget (`MEMORY_MB`): what the page and its library Workers still hold once
// it has settled. iOS ends a tab's WebContent process under memory pressure, and the tab then reloads when it is
// returned to; what a phone's tab holds between visits is what decides how soon. In WebKit it is that process's own
// footprint (`WEBKIT_MB`, `pageFootprint`).
//
// A new surface: add an entry to SURFACES with the path and the `markReady` fields that mean it has drawn (adding
// one to `markReady` if none fits).

import { test, expect, chromium, webkit, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import {
  BIG_LIBRARY_SCALE,
  bigHousehold,
  forgetPublication,
  holdProjectionBuilds,
  settleProjection,
  PHONE_PROJECTION_MS,
  routeBigHousehold,
  WATCHED_SERIES,
} from './big-library.mjs';

/** Milliseconds from navigation start to a surface's content. Today's iPhone took 5–10 s for most of these. */
const READY_MS = 4_000;
/** IndexedDB transactions a library Worker may make for one returning visit to a surface. */
const WORKER_TRANSACTIONS = 200;
/** The longest a single main-thread task may run on the throttled phone. */
const LONGEST_TASK_MS = 600;

/**
 * MB a page and its library Workers may hold once a returning visit has settled: each one's JS heap after a
 * collection, and the wasm memory of every den-core instance in them. About 21 MB on Home and 26 MB on the Watchlist.
 * A wasm memory never shrinks, so a Worker that lives as long as the page keeps whatever its largest op needed:
 * 0.271.65-0.271.70 built the assistant projection in the library Worker (61 MB of wasm for this household) and kept
 * it for the life of the tab, about 80 MB here and two to three times the WebKit process's footprint.
 */
const MEMORY_MB = 48;

/**
 * MB any one library Worker may allocate over a returning visit, collected or not: what a phone's tab peaks at while it
 * loads, not what it keeps. About 66 MB for the Owner's on Home, most of it the one fold its Home view is chosen from.
 * While a pass that read back only this browser's own writes kept no head, a library this browser had written (the
 * household's move writes the Owner's whole history) was read from den-edge and opened again on every visit: 3,079
 * rows (`ROWS_READ`), and 140 MB. The Watchlist names the whole history: from each title's kept TMDB answer, every
 * one read and parsed whole for its name and poster, it allocated about 225 MB; from each one's brief beside it
 * (`titleBrief`), it allocates no more than Home.
 */
const ALLOCATED_MB = 100;
/** Rows a returning visit may read from den-edge: what changed since the last one, which here is nothing. */
const ROWS_READ = 100;

/**
 * Documents a returning visit to one screen may fold, whatever the library's size: what it shows, not the whole
 * library. A screen that opens the full log folds every document (3,079 here, three times as many at
 * `BIG_LIBRARY_SCALE=3`), which an old TV or phone pays for in seconds and tens of MB. A count, not a time: Chromium
 * slows a page's CPU but not its Workers', where the folding happens.
 */
const FOLDED_DOCUMENTS = 500;

/**
 * MB WebKit's WebContent process may hold once a returning visit has settled (`pageFootprint`). What iOS ends a tab's
 * process by is its footprint, which macOS reads alike: 96-179 MB here across the surfaces, 0.271.68's 264-650 (its
 * library Worker kept the projection build's 61 MB of wasm, and more besides). CI's WebKit is Linux's WPE port, whose
 * resident memory reads about 2.5 times as much for the same page: 314-463 MB, 0.271.68's 466-749.
 */
const WEBKIT_MB = process.platform === 'linux' ? 520 : 260;

/** Milliseconds from navigation start to a library surface's `shelves ready` milestone (`startupTiming.ts`). */
const SHELVES_MS = 4_000;
/** Milliseconds a library Worker may take to answer, and a series' episodes to draw, while the projection is rebuilt. */
const DURING_REBUILD_MS = 1_000;

/**
 * `content`: what `markReady` must have seen drawn; the surface's time is the latest of them. `shelves`: the surface
 * names its library rows, and has its `shelves ready` milestone budgeted too. `background`: library promotions the
 * surface makes only once it has drawn, left out of `FOLDED_DOCUMENTS`.
 */
const SURFACES = [
  { name: 'Home', path: '/', content: ['billboardText', 'continuePoster'], shelves: true },
  { name: 'Series', path: '/series', content: ['rowPoster'], shelves: true },
  // Its watched history is the whole library's: asked for once the screen has drawn (`historyAsked`, Library.svelte).
  {
    name: 'Watchlist',
    path: '/watchlist',
    content: ['billboardText'],
    shelves: true,
    background: ['selection:history'],
  },
  { name: 'Series detail', path: `/tv/${WATCHED_SERIES}`, content: ['episodes'] },
  { name: 'Settings', path: '/settings', content: ['settings'] },
  // After the switch below: the household's Kid, whose billboard is age-checked title by title.
  { name: 'Kids Home', path: '/', content: ['billboardText'], profile: 'Kids' },
];

/** Use `profile` from Settings' own switcher, the one a phone has. */
async function switchProfile(context, edge, profile) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge);
  await page.goto(`${E2E_ORIGIN}/settings`);
  await page.getByRole('button', { name: /^Switch profile, current / }).click();
  await page.getByRole('button', { name: `Use ${profile}` }).click();
  // A household with no Owner PIN yet is asked for one, twice, before it leaves the Owner; four digits submit each.
  const pin = page.getByRole('textbox', { name: 'New Owner PIN' });
  if (await pin.isVisible().catch(() => false)) {
    await pin.fill('1234');
    await page.getByRole('textbox', { name: 'Confirm Owner PIN' }).fill('1234');
  }
  // The switch goes Home, which on a phone draws no switcher: the dialog closing is the switch done.
  await expect(page.getByRole('dialog', { name: 'Who’s watching?' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.close();
}

/** In the page, from navigation start: when each kind of content first drew, and every long main-thread task. */
function markReady() {
  const ready = (window.__ready = { longest: 0 });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        ready.longest = Math.max(ready.longest, Math.round(entry.duration));
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // WebKit has no long task timing.
  }
  const loaded = (scope) =>
    [...scope.querySelectorAll('.card img')].some((img) => img.complete && img.naturalWidth > 0);
  const first = (name, drawn) => {
    if (ready[name] === undefined && drawn) ready[name] = Math.round(performance.now());
  };
  const frame = () => {
    first(
      'billboardText',
      [...document.querySelectorAll('main .billboard article.slide .overview')].some((p) =>
        p.textContent.trim(),
      ),
    );
    const continued = document.querySelector('main section[aria-label="Continue Watching"]');
    first('continuePoster', continued && loaded(continued));
    first('rowPoster', [...document.querySelectorAll('main section')].some(loaded));
    first('episodes', document.querySelector('.episodes .episode'));
    first('settings', document.querySelector('h1')?.textContent?.trim() === 'Settings');
    if (performance.now() < 60_000) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * Count each Worker's IndexedDB transactions, and the wasm it compiles itself (`WebAssembly.compile` or
 * `compileStreaming`), from the moment it is seen. A compile of its own is a fresh one on every load: a module streamed
 * straight into instantiation is taken from WebKit's cache of its compiled code instead.
 */
function countWorkerWork(page) {
  const workers = [];
  page.on('worker', (worker) =>
    workers.push(
      worker
        .evaluate(() => {
          globalThis.__transactions = 0;
          globalThis.__stores = {};
          globalThis.__compiles = 0;
          const transaction = IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction = function (...args) {
            globalThis.__transactions++;
            const key = `${this.name}/${args[0]}/${args[1] ?? 'readonly'}`;
            globalThis.__stores[key] = (globalThis.__stores[key] ?? 0) + 1;
            return transaction.apply(this, args);
          };
          for (const name of ['compile', 'compileStreaming']) {
            const compile = WebAssembly[name];
            if (!compile) continue;
            WebAssembly[name] = function (...args) {
              globalThis.__compiles++;
              return compile.apply(this, args);
            };
          }
        })
        .then(() => worker)
        .catch(() => null),
    ),
  );
  return async () => {
    let transactions = 0;
    let compiles = 0;
    const libraryStartup = [];
    for (const worker of await Promise.all(workers)) {
      transactions += (await worker?.evaluate(() => globalThis.__transactions).catch(() => 0)) ?? 0;
      compiles += (await worker?.evaluate(() => globalThis.__compiles).catch(() => 0)) ?? 0;
      const metrics = await worker
        ?.evaluate(() => globalThis.__denLibraryStartupMetrics)
        .catch(() => undefined);
      if (metrics) libraryStartup.push(metrics);
      if (process.env.BIG_LIBRARY_DEBUG)
        console.log(
          JSON.stringify(await worker?.evaluate(() => globalThis.__stores).catch(() => null)),
        );
    }
    return { transactions, compiles, libraryStartup };
  };
}

/**
 * What the page behind `cdp` (Chromium) and each Worker it starts hold: the function it returns reads, by script, the
 * MB of each one's JS heap after a collection and of its wasm memories. A Worker's wasm memories are not
 * reachable from its globals, so each Worker is held at its start until it keeps every instance it makes. Only the
 * page's own Workers: a Worker one of them starts (the projection's) ends with its build.
 */
async function watchMemory(cdp) {
  const keep = () => {
    const memories = (globalThis.__denWasm = []);
    const kept = (made) => {
      const instance = made instanceof WebAssembly.Instance ? made : made?.instance;
      for (const value of Object.values(instance?.exports ?? {}))
        if (value instanceof WebAssembly.Memory) memories.push(value);
      return made;
    };
    for (const name of ['instantiate', 'instantiateStreaming']) {
      const instantiate = WebAssembly[name];
      if (instantiate)
        WebAssembly[name] = function (...args) {
          return instantiate.apply(this, args).then(kept);
        };
    }
  };
  const workers = new Map();
  const answers = new Map();
  let next = 0;
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const answer = JSON.parse(message);
    answers.get(answer.id)?.(answer);
  });
  const ask = (sessionId, method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      answers.set(id, (answer) => (answers.delete(id), resolve(answer.result)));
      void cdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(() => (answers.delete(id), resolve(undefined)));
    });
  cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo.type !== 'worker') return;
    workers.set(sessionId, targetInfo.url.replace(/^.*\//, '').replace(/-[\w-]{8}\.js$/, ''));
    await ask(sessionId, 'Runtime.evaluate', { expression: `(${keep})()` });
    // Everything it allocates from its start, collected or not (`ALLOCATED_MB`).
    await ask(sessionId, 'HeapProfiler.startSampling', {
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    if (waitingForDebugger) await ask(sessionId, 'Runtime.runIfWaitingForDebugger');
  });
  cdp.on('Target.detachedFromTarget', ({ sessionId }) => workers.delete(sessionId));
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
  });
  const mb = (bytes) => Math.round((bytes / 2 ** 20) * 10) / 10;
  return async () => {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const held = [
      { name: 'page', heap: mb((await cdp.send('Runtime.getHeapUsage')).usedSize), wasm: 0 },
    ];
    for (const [sessionId, name] of workers) {
      const sampled = await ask(sessionId, 'HeapProfiler.stopSampling');
      const allocated = (node) =>
        node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
      await ask(sessionId, 'HeapProfiler.enable');
      await ask(sessionId, 'HeapProfiler.collectGarbage');
      const heap = await ask(sessionId, 'Runtime.getHeapUsage');
      const wasm = await ask(sessionId, 'Runtime.evaluate', {
        expression:
          '(globalThis.__denWasm ?? []).reduce((sum, memory) => sum + memory.buffer.byteLength, 0)',
        returnByValue: true,
      });
      held.push({
        name,
        heap: mb(heap?.usedSize ?? 0),
        wasm: mb(wasm?.result?.value ?? 0),
        allocated: sampled ? mb(allocated(sampled.profile.head)) : 0,
      });
    }
    return held;
  };
}

/** `memoryMB`, the total of what `watchMemory` read, and `held`, the reading; nothing where nothing was read. */
const heldMB = (held) =>
  held
    ? { memoryMB: Math.round(held.reduce((sum, { heap, wasm }) => sum + heap + wasm, 0)), held }
    : {};

/**
 * The WebContent processes of Playwright's WebKit on this machine, by pid: on Linux its WPE port's `WPEWebProcess`
 * (or GTK's `WebKitWebProcess`), on macOS `com.apple.WebKit.WebContent`.
 */
function webContentPids() {
  if (process.platform === 'linux')
    return readdirSync('/proc').flatMap((name) => {
      try {
        return /^\d+$/.test(name) &&
          /(?:WPE|WebKit)WebProcess/.test(readFileSync(`/proc/${name}/cmdline`, 'utf8'))
          ? [Number(name)]
          : [];
      } catch {
        return [];
      }
    });
  return execFileSync('ps', ['-A', '-o', 'pid=,command='])
    .toString()
    .split('\n')
    .filter((line) => line.includes('ms-playwright') && line.includes('WebKit.WebContent'))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

/**
 * MB of memory `pid` holds of its own: on macOS its physical footprint (`footprint`), what iOS ends a tab's WebContent
 * process by; on Linux, its resident anonymous and shared memory. Null when it has gone.
 */
function footprintMB(pid) {
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const kb = (field) =>
        Number(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? 0);
      return Math.round((kb('RssAnon') + kb('RssShmem')) / 1024);
    }
    const out = execFileSync('footprint', ['-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const [, value, unit] = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(out) ?? [];
    return value ? Math.round(Number(value) * { KB: 1 / 1024, MB: 1, GB: 1024 }[unit]) : null;
  } catch {
    return null;
  }
}

/** MB a page fills to show which WebContent process is its own, and the least growth that shows it. */
const MARK_MB = 64;
const MARKED_MB = 48;

/**
 * What `page`'s WebContent process holds once it has settled, in WebKit, which no protocol of Playwright's reads
 * (`footprintMB`): read four times over three seconds, keeping the least, what it holds between its collections.
 * Which process is the page's is not something WebKit says: pages closed earlier keep theirs in WebKit's process
 * cache, and on macOS no WebContent process is its browser's child. So the page then fills `MARK_MB` of memory, and its
 * process is the one that grew by it. `processes`: every WebContent process read, MB, its own among them.
 */
async function pageFootprint(page) {
  const pids = webContentPids();
  const least = new Map();
  for (let sample = 0; sample < 4; sample += 1) {
    if (sample) await page.waitForTimeout(1_000);
    for (const pid of pids) {
      const mb = footprintMB(pid);
      if (mb !== null) least.set(pid, Math.min(least.get(pid) ?? Infinity, mb));
    }
  }
  // Another process may grow as much meanwhile, loading a page of its own: each round fills `MARK_MB` more, and only a
  // process that grew by it every round is the page's.
  let marked = [...least];
  for (let round = 0; round < 4 && (round === 0 || marked.length > 1); round += 1) {
    const before = new Map(marked.map(([pid]) => [pid, footprintMB(pid) ?? 0]));
    await page.evaluate(
      (mb) => (globalThis.__denMark ??= []).push(new Uint8Array(mb * 2 ** 20).fill(1)),
      MARK_MB,
    );
    marked = marked.filter(([pid]) => (footprintMB(pid) ?? 0) - before.get(pid) >= MARKED_MB);
  }
  await page.evaluate(() => delete globalThis.__denMark);
  const processes = [...least.values()].sort((a, b) => b - a);
  // Never a budget met by reading nothing, or another page's process.
  if (marked.length !== 1)
    throw new Error(
      `this page's WebContent process is not known: ${marked.length} of ${JSON.stringify(processes)} grew`,
    );
  return { footprintMB: marked[0][1], processes };
}

/** One returning visit to `surface`: the ms its content took, the Worker transactions, the longest task. */
async function visit(context, edge, surface, { cpu = 1, footprint } = {}) {
  const page = await context.newPage();
  // The household's assistant projection costs the library Worker what it costs a phone's (`PHONE_PROJECTION_MS`).
  await routeBigHousehold(page, edge, { projectionMs: PHONE_PROJECTION_MS });
  // Chromium's (the only engine slowed): what the page and its Workers hold, too.
  let memory;
  if (cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    memory = await watchMemory(cdp);
  }
  const workerWork = countWorkerWork(page);
  // Where a slow surface's time went, printed with its result: the page's startup milestones (`startupTiming.ts`).
  const marks = {};
  // Assistant projections the library Worker built, from its own line; a browser may report a Worker's console on the
  // page, on the Worker, or both.
  const built = { page: 0, worker: 0 };
  const isBuild = (message) => message.text().startsWith('den: assistant projection built');
  page.on('worker', (worker) =>
    worker.on?.('console', (message) => isBuild(message) && built.worker++),
  );
  page.on('console', (message) => {
    if (isBuild(message)) built.page++;
    const match =
      /^den: startup \+(\d+)ms (app module requested|worker ready|handover|shelves ready|billboard detail|first poster|episodes shown)/.exec(
        message.text(),
      );
    if (match && marks[match[2]] === undefined) marks[match[2]] = Number(match[1]);
  });
  // When each library promotion was heard, in ms from just before navigation: a `background` one must come after the
  // surface's content (which is timed from navigation start, so never later than this clock for the same moment).
  const started = Date.now();
  const promoted = {};
  const hearPromotion = (message) => {
    const reason = /library promoted \((.+)\)$/.exec(message.text())?.[1];
    if (reason && promoted[reason] === undefined) promoted[reason] = Date.now() - started;
  };
  page.on('console', hearPromotion);
  page.on('worker', (worker) => worker.on?.('console', hearPromotion));
  const projectionsBefore = edge.assistant?.projections.length ?? 0;
  // Rows den-edge sent the library Workers, from every changes page.
  const reads = [];
  page.on('response', (response) => {
    if (/\/lib\/[^/]+\/changes\?/.test(response.url()))
      reads.push(
        response.json().then(
          (body) => body.entries?.length ?? 0,
          () => 0,
        ),
      );
  });
  await page.goto(`${E2E_ORIGIN}${surface.path}`);
  const drawn = (ready) =>
    surface.content.every((name) => ready?.[name] !== undefined) &&
    (!surface.shelves || marks['shelves ready'] !== undefined);
  // Not an assertion: a surface that never draws is reported as Infinity against its budget below.
  await expect
    .poll(async () => drawn(await page.evaluate(() => window.__ready)), { timeout: 30_000 })
    .toBe(true)
    .catch(() => {});
  const ready = await page.evaluate(() => window.__ready);
  const contentMs = surface.content.every((name) => ready?.[name] !== undefined)
    ? Math.max(...surface.content.map((name) => ready[name]))
    : Infinity;
  const shelvesMs = marks['shelves ready'] ?? Infinity;
  // Let the Worker finish what the surface set off, then count.
  await page.waitForTimeout(2_000);
  const { longest, ...drawnAt } = ready;
  const { transactions, compiles, libraryStartup } = await workerWork();
  const held = await memory?.();
  const processes = await footprint?.(page);
  const result = {
    contentMs,
    ...(surface.shelves ? { shelvesMs } : {}),
    transactions,
    compiles,
    libraryStartup,
    projections: (edge.assistant?.projections.length ?? 0) - projectionsBefore,
    builds: Math.max(built.page, built.worker),
    rowsRead: (await Promise.all(reads)).reduce((sum, count) => sum + count, 0),
    longest,
    ...heldMB(held),
    ...processes,
    drawnAt,
    marks,
    promoted,
  };
  await page.close();
  return result;
}

/**
 * A rebuild of the assistant projection that is due, as after a change, the heartbeat or the day's renewal: this
 * device forgets what it last published, so the next page builds and uploads it, at the phone's cost. While it runs,
 * the library Workers are asked for names, and a series is opened from Continue Watching. How long each
 * took, how long the build took, and whether the publish was still under way when they had all answered.
 */
async function openDuringRebuild(context, edge, { cpu = 1, footprint } = {}) {
  await forgetPublication(context, edge);

  const page = await context.newPage();
  await routeBigHousehold(page, edge, { projectionMs: PHONE_PROJECTION_MS });
  let memory;
  if (cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    memory = await watchMemory(cdp);
  }
  edge.assistant.publishing = 0;
  const library = holdProjectionBuilds(page);
  let buildMs;
  page.on('console', (message) => {
    const built = /^den: assistant projection built in (\d+)ms/.exec(message.text());
    if (built) buildMs ??= Number(built[1]);
  });
  const uploads = edge.assistant.projections.length;
  await page.goto(`${E2E_ORIGIN}/`);
  const series = page
    .locator('main section[aria-label="Continue Watching"] a[href^="/tv/"]')
    .first();
  await expect(series).toBeVisible({ timeout: 30_000 });
  // The publish is under way: its build started (in its own Worker), or — where the build has no Worker of its own —
  // its upload reached den-edge.
  await expect
    .poll(async () => edge.assistant.publishing > 0 || (await library.started()), {
      timeout: 30_000,
    })
    .toBe(true);
  // What a page asks its library Worker meanwhile: the names its rows need, which `shelves ready` waits on and which
  // are answered after every request the Worker took before them.
  const namesMs = await library.ask({
    kind: 'library.metadata',
    titles: [{ type: 'tv', id: WATCHED_SERIES }],
  });
  const opened = Date.now();
  await series.click();
  await expect(page.locator('.episodes .episode').first()).toBeVisible({ timeout: 30_000 });
  const episodesMs = Date.now() - opened;
  const buildingThroughout = edge.assistant.projections.length === uploads;
  // Let the upload land and the publication be recorded (the Worker says it built only then).
  await expect.poll(() => buildMs, { timeout: 30_000 }).toBeDefined();
  // What the tab keeps once it has published: a phone's tab publishes after each change and at the heartbeat.
  const held = await memory?.();
  const processes = await footprint?.(page);
  await page.close();
  // The records forgotten held the layouts the device knew too: the surfaces after this are returning visits again
  // once Home and the Watchlist find the projection up to date.
  await settleProjection(context, edge);
  return { namesMs, episodesMs, buildingThroughout, buildMs, ...heldMB(held), ...processes };
}

const ENGINES = [
  ['WebKit iPhone', webkit, devices['iPhone 13'], {}],
  ['Chromium phone, 4× CPU', chromium, devices['Pixel 7'], { cpu: 4 }],
];

for (const [label, type, device, options] of ENGINES) {
  test(`${label}: a big household's surfaces draw within their budgets`, async () => {
    test.skip(
      type === webkit && !process.env.CI && !existsSync(webkit.executablePath()),
      'needs WebKit: npx playwright install webkit',
    );
    test.setTimeout(300_000 * BIG_LIBRARY_SCALE);
    const footprint = type === webkit ? pageFootprint : undefined;
    const browser = await type.launch(
      type === chromium ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    );
    try {
      const { defaultBrowserType: _, ...phone } = device;
      const context = await browser.newContext(phone);
      await context.addInitScript(markReady);
      const edge = newEdge({ profiles: true });
      await bigHousehold(context, edge);
      const rebuild = await openDuringRebuild(context, edge, { ...options, footprint });
      console.log(`${label}: during a rebuild ${JSON.stringify(rebuild)}`);
      for (const [name, ms] of [
        ['names for rows', rebuild.namesMs],
        ['a series’ episodes', rebuild.episodesMs],
      ])
        expect
          .soft(ms, `ms to ${name} while the projection is rebuilt`)
          .toBeLessThan(DURING_REBUILD_MS);
      expect
        .soft(rebuild.buildingThroughout, 'answered while the publish was still under way')
        .toBe(true);
      if (rebuild.held)
        expect
          .soft(
            rebuild.memoryMB,
            `MB the page and its Workers hold once the projection is published ${JSON.stringify(rebuild.held)}`,
          )
          .toBeLessThan(MEMORY_MB);
      if (footprint)
        expect
          .soft(
            rebuild.footprintMB,
            `MB of WebKit's WebContent process once the projection is published ${JSON.stringify(rebuild.processes)}`,
          )
          .toBeLessThan(WEBKIT_MB);
      const measured = [];
      for (const surface of SURFACES) {
        if (surface.profile) {
          await switchProfile(context, edge, surface.profile);
          // Its first visit, to the same returning state as the Owner's surfaces.
          await visit(context, edge, surface, options);
        }
        const result = await visit(context, edge, surface, { ...options, footprint });
        measured.push({ surface: surface.name, ...result });
        expect.soft(result.contentMs, `${surface.name}: ms to content`).toBeLessThan(READY_MS);
        if (surface.shelves)
          expect
            .soft(result.shelvesMs, `${surface.name}: ms to shelves ready`)
            .toBeLessThan(SHELVES_MS);
        expect
          .soft(result.transactions, `${surface.name}: library Worker IndexedDB transactions`)
          .toBeLessThan(WORKER_TRANSACTIONS);
        // den-core's modules are streamed into instantiation, from WebKit's cache of their compiled code; a Worker that
        // compiles one itself pays the whole compile on every load, which on an iPhone held the shelves back.
        expect.soft(result.compiles, `${surface.name}: wasm compiled in a Worker`).toBe(0);
        const folded = (result.libraryStartup ?? [])
          .filter(({ promotion }) => !surface.background?.includes(promotion))
          .reduce((sum, startup) => sum + startup.documentsFolded, 0);
        expect
          .soft(folded, `${surface.name}: library documents folded`)
          .toBeLessThan(FOLDED_DOCUMENTS);
        for (const reason of surface.background ?? [])
          if (result.promoted[reason] !== undefined)
            expect
              .soft(result.promoted[reason], `${surface.name}: ms to ${reason}, after its content`)
              .toBeGreaterThanOrEqual(result.contentMs);
        for (const startup of result.libraryStartup ?? []) {
          if (startup.viewSource !== 'cache') continue;
          expect
            .soft(startup.documentsDecrypted, `${surface.name}: cached documents decrypted`)
            .toBe(0);
          expect.soft(startup.documentsFolded, `${surface.name}: cached documents folded`).toBe(0);
        }
        // The household's lists are as the last visit published them: nothing is built or sent again.
        expect.soft(result.builds, `${surface.name}: assistant projections built`).toBe(0);
        expect.soft(result.projections, `${surface.name}: assistant projections uploaded`).toBe(0);
        expect
          .soft(result.rowsRead, `${surface.name}: rows read from den-edge`)
          .toBeLessThan(ROWS_READ);
        if (result.held)
          expect
            .soft(
              Math.max(...result.held.map(({ allocated }) => allocated ?? 0)),
              `${surface.name}: MB a library Worker allocated ${JSON.stringify(result.held)}`,
            )
            .toBeLessThan(ALLOCATED_MB);
        if (options.cpu)
          expect
            .soft(result.longest, `${surface.name}: longest task ms`)
            .toBeLessThan(LONGEST_TASK_MS);
        if (result.held)
          expect
            .soft(
              result.memoryMB,
              `${surface.name}: MB held by the page and its Workers ${JSON.stringify(result.held)}`,
            )
            .toBeLessThan(MEMORY_MB);
        if (footprint)
          expect
            .soft(
              result.footprintMB,
              `${surface.name}: MB of WebKit's WebContent process ${JSON.stringify(result.processes)}`,
            )
            .toBeLessThan(WEBKIT_MB);
      }
      expect
        .soft(
          measured.some(({ libraryStartup }) =>
            libraryStartup?.some(({ viewSource }) => viewSource === 'cache'),
          ),
          'at least one unchanged returning surface must exercise the finished-view cache',
        )
        .toBe(true);
      console.log(`${label}\n${measured.map((m) => JSON.stringify(m)).join('\n')}`);
    } finally {
      await browser.close();
    }
  });
}
