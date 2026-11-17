#!/usr/bin/env node

// Render the shared Den artwork at the exact LG, Samsung, and Android TV launcher sizes.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { brandAssets } from './brand-assets.mjs';

const webRoot = resolve(import.meta.dirname, '..');
const root = resolve(webRoot, '..');
const derivation = (id) => {
  const found = brandAssets.derived.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`brand provenance is missing ${id}`);
  return found;
};
const squares = derivation('tv-launcher-square');
const appIconDerivation = derivation('android-app-icon');
const bannerDerivation = derivation('android-banner');
const source = readFileSync(resolve(root, squares.source)).toString('base64');
const androidSource = readFileSync(resolve(root, appIconDerivation.source)).toString('base64');
const bannerSource = readFileSync(resolve(root, bannerDerivation.source)).toString('base64');
for (const { target } of [
  ...squares.outputs,
  ...appIconDerivation.outputs,
  ...bannerDerivation.outputs,
])
  mkdirSync(dirname(resolve(root, target)), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const output of squares.outputs) {
    const [width, height] = output.size;
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    await page.setContent(
      `<style>html,body,img{width:100%;height:100%;margin:0}img{display:block}</style><img src="data:image/png;base64,${source}">`,
    );
    await page.locator('img').evaluate((image) => image.decode());
    await page.screenshot({ path: resolve(root, output.target), omitBackground: false });
    await page.close();
  }
  const appIcon = await browser.newPage({
    viewport: {
      width: appIconDerivation.outputs[0].size[0],
      height: appIconDerivation.outputs[0].size[1],
    },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  await appIcon.setContent(
    `<style>html,body,img{width:100%;height:100%;margin:0;background:transparent}img{display:block}</style><img src="data:image/svg+xml;base64,${androidSource}">`,
  );
  await appIcon.locator('img').evaluate((image) => image.decode());
  await appIcon.screenshot({
    path: resolve(root, appIconDerivation.outputs[0].target),
    omitBackground: true,
  });
  await appIcon.close();
  const banner = await browser.newPage({
    viewport: {
      width: bannerDerivation.outputs[0].size[0],
      height: bannerDerivation.outputs[0].size[1],
    },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  await banner.setContent(
    `<style>
      html,body{width:100%;height:100%;margin:0;background:#0b0b0f;overflow:hidden}
      body{display:flex;align-items:center;justify-content:center;gap:18px;color:#f2efe9;font:600 52px/1 sans-serif}
      img{display:block;width:104px;height:104px}
    </style><img src="data:image/svg+xml;base64,${bannerSource}" alt=""><span>Den</span>`,
  );
  await banner.locator('img').evaluate((image) => image.decode());
  await banner.screenshot({
    path: resolve(root, bannerDerivation.outputs[0].target),
    omitBackground: false,
  });
  await banner.close();
} finally {
  await browser.close();
}
