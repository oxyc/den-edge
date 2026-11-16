#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { brandAssets } from './brand-assets.mjs';

const root = resolve(import.meta.dirname, '../..');
const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(resolve(root, path));
const digest = (path) => createHash('sha256').update(read(path)).digest('hex');

if (!/^[0-9a-f]{40}$/.test(brandAssets.den.revision)) fail('Den revision is not an exact commit');
const generatorDigest = digest(brandAssets.edgeGenerator.path);
if (generatorDigest !== brandAssets.edgeGenerator.sha256)
  fail(
    `${brandAssets.edgeGenerator.path}: renderer changed; review the derivation graph and record sha256 ${generatorDigest}`,
  );

const recorded = [];
for (const asset of [
  ...brandAssets.copied,
  ...brandAssets.derived.flatMap(({ source, outputs }) =>
    outputs.map((output) => ({ ...output, source })),
  ),
  ...brandAssets.local,
]) {
  recorded.push(asset.target);
  try {
    const actual = digest(asset.target);
    if (actual !== asset.sha256)
      fail(`${asset.target}: sha256 ${actual}, expected ${asset.sha256}`);
  } catch (error) {
    fail(`${asset.target}: ${error.message}`);
  }
  for (const [consumer, needle] of asset.consumers) {
    try {
      if (!read(consumer).toString('utf8').includes(needle))
        fail(`${asset.target}: ${consumer} no longer contains ${JSON.stringify(needle)}`);
    } catch (error) {
      fail(`${asset.target}: cannot inspect consumer ${consumer}: ${error.message}`);
    }
  }
}

for (const asset of brandAssets.copied) {
  if (!asset.source.startsWith('docs/brand/web/'))
    fail(`${asset.target}: copied Den source must be in docs/brand/web`);
  if (asset.target === asset.source) fail(`${asset.target}: source and target must differ`);
}

const copiedTargets = new Set(brandAssets.copied.map(({ target }) => target));
const derivationIds = brandAssets.derived.map(({ id }) => id);
if (new Set(derivationIds).size !== derivationIds.length)
  fail('brand provenance graph contains duplicate derivation ids');
for (const derivation of brandAssets.derived) {
  if (!copiedTargets.has(derivation.source))
    fail(`${derivation.id}: source ${derivation.source} is not a checked Den copy`);
  if (derivation.outputs.length === 0) fail(`${derivation.id}: derivation has no outputs`);
  for (const output of derivation.outputs)
    if (
      !Array.isArray(output.size) ||
      output.size.length !== 2 ||
      output.size.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)
    )
      fail(`${output.target}: invalid output size`);
}

const inventory = [
  'web/src/assets/den-mark.svg',
  ...readdirSync(resolve(root, 'web/public'))
    .filter((name) => /^(?:apple-touch-icon|favicon|icon-|og\.)/.test(name))
    .map((name) => `web/public/${name}`),
  ...readdirSync(resolve(root, 'web/tv-packaging/assets'))
    .filter((name) => name.endsWith('.png'))
    .map((name) => `web/tv-packaging/assets/${name}`),
  ...readdirSync(resolve(root, 'android-tv/app/src/main/res/drawable-nodpi'))
    .filter((name) => name.endsWith('.png'))
    .map((name) => `android-tv/app/src/main/res/drawable-nodpi/${name}`),
].sort();
const expected = [...new Set(recorded)].sort();
if (recorded.length !== expected.length) fail('brand provenance graph contains duplicate targets');
if (JSON.stringify(inventory) !== JSON.stringify(expected))
  fail(
    `brand asset inventory differs:\nactual ${JSON.stringify(inventory)}\nrecorded ${JSON.stringify(expected)}`,
  );

if (failures.length > 0) {
  console.error(`Brand asset provenance failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `Brand asset provenance passed: ${brandAssets.copied.length} Den copies, ${brandAssets.derived.length} derivations, ${brandAssets.local.length} Edge-owned asset.`,
);
