import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const [profilePath, mapsPath] = process.argv.slice(2);
if (!profilePath || !mapsPath) {
  console.error('usage: node scripts/analyze-allocation-profile.mjs <profile.json> <assets-dir>');
  process.exitCode = 2;
} else {
  const files = (root) =>
    readdirSync(root).flatMap((name) => {
      const file = join(root, name);
      return statSync(file).isDirectory() ? files(file) : [file];
    });
  const sourceRanges = new Map();
  const maps = new Map(
    files(mapsPath)
      .filter((file) => file.endsWith('.js.map'))
      .map((file) => {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const [index, source] of raw.sources.entries()) {
          const lines = raw.sourcesContent?.[index]?.split('\n') ?? [];
          const start = lines.findIndex((line) => /function episodeRow\s*\(/.test(line));
          if (start < 0) continue;
          const length = lines
            .slice(start + 1)
            .findIndex((line) => /^function |^export function /.test(line));
          sourceRanges.set(source, {
            start: start + 1,
            end: length < 0 ? lines.length : start + length + 1,
          });
        }
        return [basename(file, '.map'), new TraceMap(raw)];
      }),
  );
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  const mib = (bytes) => Math.round((bytes / 2 ** 20) * 100) / 100;
  const frame = (generated) => {
    let map;
    try {
      map = maps.get(basename(new URL(generated.url).pathname));
    } catch {
      map = undefined;
    }
    if (!map)
      return {
        name: generated.functionName || '(anonymous)',
        source: generated.url || '',
        line: generated.lineNumber + 1,
      };
    const original = originalPositionFor(map, {
      line: generated.lineNumber + 1,
      column: Math.max(0, generated.columnNumber),
    });
    return {
      name: original.name || generated.functionName || '(anonymous)',
      source: original.source || generated.url || '',
      line: original.line,
    };
  };
  const includes = (stack, source, name) =>
    stack.some(
      (entry) =>
        entry.source.includes(source) && (!name || entry.name === name || name.test(entry.name)),
    );
  const inEpisodeRow = ({ source, line }) => {
    const range = sourceRanges.get(source);
    return range && line >= range.start && line <= range.end;
  };
  const classify = (stack) => ({
    json: stack.some(({ name }) => name.startsWith('JSON.')),
    cryptoOrFactDecode:
      includes(stack, '/libraryLocalValue.ts') ||
      includes(stack, '/crypto.ts') ||
      stack.some(({ name }) => /decrypt|encrypt|digest|subtle/i.test(name)),
    projectDocument:
      includes(stack, '/libraryV4.ts', /projectDocument|projectTitle/) ||
      (includes(stack, '/libraryV4.ts') && includes(stack, '/log.ts', /rows/)),
    episodeRowProjection:
      includes(stack, '/libraryV4.ts', /episodeRow/) || stack.some(inEpisodeRow),
    applyLog:
      includes(stack, '/library.ts', /applyLog/) ||
      (includes(stack, '/library.ts', /add|finish/) && includes(stack, '/libraryLogAuthority.ts')),
    factStore: includes(stack, '/libraryFactStore.ts'),
    structuredCloneReceiveProxy: includes(
      stack,
      '/libraryServiceWorkerTransport.ts',
      /#message|#r/,
    ),
  });
  const records = profile.records.map((record) => {
    const frames = new Map();
    const stacks = [];
    const categories = {};
    let allocatedBytes = 0;
    const visit = (node, parents = []) => {
      const current = frame(node.callFrame ?? {});
      const stack = [...parents, current];
      if (node.selfSize) {
        allocatedBytes += node.selfSize;
        const key = `${current.name} @ ${current.source}:${current.line ?? '?'}`;
        frames.set(key, (frames.get(key) ?? 0) + node.selfSize);
        stacks.push({ bytes: node.selfSize, stack });
        for (const [name, matches] of Object.entries(classify(stack)))
          if (matches) categories[name] = (categories[name] ?? 0) + node.selfSize;
      }
      for (const child of node.children ?? []) visit(child, stack);
    };
    visit(record.allocation.head);
    const cpuElapsedMs = record.cpu ? (record.cpu.endTime - record.cpu.startTime) / 1000 : null;
    const sampledJsMs = record.cpu?.timeDeltas
      ? record.cpu.timeDeltas.reduce((sum, delta) => sum + delta, 0) / 1000
      : null;
    return {
      name: record.name,
      depth: record.depth,
      allocatedMiB: mib(allocatedBytes),
      retainedHeapMiB: mib(record.heap.usedSize),
      wasmMiB: mib(record.accounting?.wasm ?? 0),
      cpuProfileElapsedMs: cpuElapsedMs,
      sampledJsTimelineMs: sampledJsMs,
      accounting: record.accounting,
      inclusiveOwnersMiB: Object.fromEntries(
        Object.entries(categories).map(([name, bytes]) => [name, mib(bytes)]),
      ),
      topFrames: [...frames]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 30)
        .map(([name, bytes]) => ({ name, selfMiB: mib(bytes) })),
      topStacks: stacks
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, 30)
        .map(({ bytes, stack }) => ({
          selfMiB: mib(bytes),
          stack: stack
            .slice(-12)
            .reverse()
            .map(
              ({ name, source, line }) => `${name}@${basename(source || 'native')}:${line ?? '?'}`,
            ),
        })),
    };
  });
  console.log(JSON.stringify({ profileComplete: profile.profileComplete, records }, null, 2));
}
