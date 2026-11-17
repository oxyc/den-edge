#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brandAssets } from './brand-assets.mjs';

const root = resolve(import.meta.dirname, '../..');
const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(resolve(root, path));
const digest = (path) => createHash('sha256').update(read(path)).digest('hex');
const sha256 = /^[0-9a-f]{64}$/;
const validSize = (size) =>
  Array.isArray(size) &&
  size.length === 2 &&
  size.every((dimension) => Number.isInteger(dimension) && dimension > 0);
const pngSize = (path) => {
  const bytes = read(path);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  )
    throw new Error('not a PNG with an IHDR header');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

if (brandAssets.den.repository !== 'https://github.com/oxyc/den')
  fail('Den provenance does not name the authoritative repository');
if (!/^[0-9a-f]{40}$/.test(brandAssets.den.revision)) fail('Den revision is not an exact commit');
if (brandAssets.den.generator.path !== 'scripts/gen-icon.swift')
  fail('Den provenance does not name the icon generator');
if (!sha256.test(brandAssets.den.generator.sha256)) fail('Den generator sha256 is not exact');
if (brandAssets.den.generator.invocation !== 'make icon')
  fail('Den generator invocation is not the supported Make target');
if (!sha256.test(brandAssets.den.generator.makefileSha256))
  fail('Den generator Makefile sha256 is not exact');
if (process.env.DEN_BRAND_CHECKOUT) {
  const show = (path) =>
    execFileSync(
      'git',
      ['-C', process.env.DEN_BRAND_CHECKOUT, 'show', `${brandAssets.den.revision}:${path}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  for (const [path, expected] of [
    [brandAssets.den.generator.path, brandAssets.den.generator.sha256],
    ['Makefile', brandAssets.den.generator.makefileSha256],
    ...brandAssets.copied.map(({ source, sha256 }) => [source, sha256]),
  ]) {
    try {
      const actual = createHash('sha256').update(show(path)).digest('hex');
      if (actual !== expected)
        fail(`Den ${brandAssets.den.revision}:${path}: sha256 ${actual}, expected ${expected}`);
    } catch (error) {
      fail(`Den ${brandAssets.den.revision}:${path}: cannot verify source: ${error.message}`);
    }
  }
}
const generatorDigest = digest(brandAssets.edgeGenerator.path);
if (!sha256.test(brandAssets.edgeGenerator.sha256)) fail('Edge renderer sha256 is not exact');
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
  if (asset.target.endsWith('.png')) {
    if (!validSize(asset.size)) fail(`${asset.target}: missing exact PNG dimensions`);
    else
      try {
        const actual = pngSize(asset.target);
        if (actual[0] !== asset.size[0] || actual[1] !== asset.size[1])
          fail(`${asset.target}: ${actual.join('×')}, expected ${asset.size.join('×')}`);
      } catch (error) {
        fail(`${asset.target}: ${error.message}`);
      }
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
  if (!sha256.test(asset.sha256)) fail(`${asset.target}: copied output sha256 is not exact`);
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
    if (!validSize(output.size)) fail(`${output.target}: invalid output size`);
}

const image = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i;
const inventory = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8')
  .split('\0')
  .filter((path) => image.test(path))
  .sort();
const exclusions = brandAssets.excluded.map(({ target }) => target);
for (const exclusion of brandAssets.excluded) {
  if (!exclusion.reason) fail(`${exclusion.target}: exclusion needs a reviewable reason`);
  try {
    read(exclusion.target);
  } catch (error) {
    fail(`${exclusion.target}: excluded asset is absent: ${error.message}`);
  }
}
const expected = [...new Set([...recorded, ...exclusions])].sort();
if (recorded.length + exclusions.length !== expected.length)
  fail('brand provenance graph contains duplicate or multiply classified targets');
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
