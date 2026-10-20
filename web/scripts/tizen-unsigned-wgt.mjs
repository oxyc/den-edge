#!/usr/bin/env node

// A WGT is a ZIP whose application files live at its root. Samsung's distributor signature is
// device-specific, so releases publish this unsigned widget for installers such as Apps2Samsung to
// sign for the destination TV.
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [sourceText, outputText] = process.argv.slice(2);
if (!sourceText || !outputText) {
  console.error('Usage: node scripts/tizen-unsigned-wgt.mjs <app-directory> <output.wgt>');
  process.exit(2);
}

const source = resolve(sourceText);
const output = resolve(outputText);
if (!output.endsWith('.wgt')) throw new Error('Unsigned Tizen output must end in .wgt');
for (const required of ['config.xml', 'index.html', 'icon.png'])
  if (!existsSync(resolve(source, required)))
    throw new Error(`Tizen app directory is missing ${required}`);

rmSync(output, { force: true });
const zipped = spawnSync('zip', ['-q', '-X', '-r', output, '.'], {
  cwd: source,
  encoding: 'utf8',
});
if (zipped.error?.code === 'ENOENT') throw new Error('zip is required to create the unsigned WGT');
if (zipped.status !== 0)
  throw new Error(`Could not create unsigned WGT: ${(zipped.stderr || zipped.stdout).trim()}`);

const listed = spawnSync('unzip', ['-Z1', output], { encoding: 'utf8' });
if (listed.error?.code === 'ENOENT')
  throw new Error('unzip is required to verify the unsigned WGT');
if (listed.status !== 0)
  throw new Error(`Could not inspect unsigned WGT: ${(listed.stderr || listed.stdout).trim()}`);
const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
for (const required of ['config.xml', 'index.html', 'icon.png'])
  if (!entries.includes(required)) throw new Error(`Unsigned WGT has no root ${required}`);
if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..')))
  throw new Error('Unsigned WGT contains an unsafe path');
if (entries.some((entry) => /^(?:author-signature|signature\d*)\.xml$/i.test(entry)))
  throw new Error('Unsigned WGT unexpectedly contains a signature');

console.log(`Created unsigned Tizen widget at ${output}`);
