import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'dist-tv-tizen-package');

async function filesBelow(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(child)));
    else result.push(child);
  }
  return result;
}

if (!(await stat(directory).catch(() => undefined))?.isDirectory()) {
  throw new Error(`Tizen package output does not exist: ${directory}`);
}

const styles = [];
for (const file of (await filesBelow(directory)).filter((file) => file.endsWith('.js'))) {
  // Diagnostics writes a JSON capability report through textContent; it is data, not an injected stylesheet.
  if (basename(file).startsWith('diagnostics-')) continue;
  const code = await readFile(file, 'utf8');
  for (const match of code.matchAll(/\.textContent\s*=\s*`([\s\S]*?)`/g)) {
    styles.push({ chunk: basename(file), css: match[1] });
  }
}

if (styles.length === 0) throw new Error(`No embedded component styles found in ${directory}`);

const checks = {
  customProperties: /var\(--/g,
  clamp: /\bclamp\(/g,
  minOrMax: /\b(?:min|max)\(/g,
  grid: /display\s*:\s*(?:inline-)?grid\b/g,
  gap: /(?:^|[;}])\s*(?:row-|column-)?gap\s*:/gm,
  focusVisible: /:focus-visible\b/g,
  focusWithin: /:focus-within\b/g,
  has: /:has\(/g,
  is: /:is\(/g,
  webkitAny: /:-webkit-any\(/g,
  colorMix: /color-mix\(/g,
  logicalProperties: /\b(?:margin|padding|border|inset)-(?:inline|block)(?:-(?:start|end))?\s*:/g,
};

const count = (text, expression) => text.match(expression)?.length ?? 0;
const css = styles.map((style) => style.css).join('\n');
const variables = new Map();
for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
  variables.set(match[1], (variables.get(match[1]) ?? 0) + 1);
}

const byChunk = styles
  .map(({ chunk, css: chunkCss }) => ({
    chunk,
    total: Object.values(checks).reduce((sum, expression) => sum + count(chunkCss, expression), 0),
  }))
  .filter(({ total }) => total > 0)
  .sort((a, b) => b.total - a.total)
  .slice(0, 10);

console.log(`Tizen 3 emitted-CSS report: ${directory}`);
console.log(
  `Embedded CSS: ${Buffer.byteLength(css).toLocaleString()} bytes in ${styles.length} blocks`,
);
for (const [name, expression] of Object.entries(checks)) {
  console.log(`${name}: ${count(css, expression)}`);
}
console.log(
  `unsupportedIs: ${Math.max(0, count(css, checks.is) - count(css, checks.webkitAny))} (` +
    `${count(css, checks.is)} :is rules, ${count(css, checks.webkitAny)} paired Chromium 47 fallbacks)`,
);
console.log(
  `Remaining variables: ${[...variables.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, occurrences]) => `${name}=${occurrences}`)
    .join(', ')}`,
);
console.log(
  `Highest-risk chunks: ${byChunk.map(({ chunk, total }) => `${chunk}=${total}`).join(', ')}`,
);
