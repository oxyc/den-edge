// Writes the navigation bar (`src/shell.ts`, built by `vite build --ssr`) into dist/index.html's #app, so the
// first paint needs no JavaScript. Runs before precompress, which then compresses the page with it.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const built = new URL('../dist-shell/shell.js', import.meta.url);
const { shell } = await import(built.href);
const html = await readFile(`${dist}index.html`, 'utf8');
const earlyHero = html.match(/<script data-den-early-hero>([\s\S]*?)<\/script>/)?.[1];
assert.ok(earlyHero, 'index.html has no early hero script');
assert.equal(
  `sha256-${createHash('sha256').update(earlyHero).digest('base64')}`,
  'sha256-P6cePhQlg6yr8H83d+82ZJT+sXtcuBC1UKjtm577mkA=',
  'Vite changed the early hero script bytes allowed by src/web.rs CSP',
);
const empty = '<div id="app"></div>';
assert.ok(html.includes(empty), 'index.html has no empty #app to fill');
const bar = shell();
assert.ok(bar.includes('class="bar-anchor'), 'the shell rendered no navigation bar');
await writeFile(`${dist}index.html`, html.replace(empty, `<div id="app">${bar}</div>`));
await rm(fileURLToPath(new URL('../dist-shell/', import.meta.url)), { recursive: true });
console.log(`shell: ${bar.length} bytes of navigation bar in index.html`);
