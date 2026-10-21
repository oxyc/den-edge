#!/usr/bin/env node

// Render the shared Den artwork at the exact LG, Samsung, and Android TV launcher sizes.
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(import.meta.dirname, '..');
const sourcePath = join(webRoot, 'public', 'apple-touch-icon.png');
const source = readFileSync(sourcePath).toString('base64');
const androidSource = readFileSync(join(webRoot, 'public', 'favicon.svg')).toString('base64');
const target = join(webRoot, 'tv-packaging', 'assets');
const androidTarget = resolve(
  webRoot,
  '..',
  'android-tv',
  'app',
  'src',
  'main',
  'res',
  'drawable-nodpi',
);
mkdirSync(target, { recursive: true });
mkdirSync(androidTarget, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const size of [80, 117, 130]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    await page.setContent(
      `<style>html,body,img{width:100%;height:100%;margin:0}img{display:block}</style><img src="data:image/png;base64,${source}">`,
    );
    await page.locator('img').evaluate((image) => image.decode());
    await page.screenshot({ path: join(target, `icon-${size}.png`), omitBackground: false });
    await page.close();
  }
  const appIcon = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  await appIcon.setContent(
    `<style>html,body,img{width:100%;height:100%;margin:0;background:transparent}img{display:block}</style><img src="data:image/svg+xml;base64,${androidSource}">`,
  );
  await appIcon.locator('img').evaluate((image) => image.decode());
  await appIcon.screenshot({ path: join(androidTarget, 'app_icon.png'), omitBackground: true });
  await appIcon.close();
  const banner = await browser.newPage({
    viewport: { width: 320, height: 180 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  await banner.setContent(
    `<style>
      html,body{width:100%;height:100%;margin:0;background:#0b0b0f;overflow:hidden}
      body{display:flex;align-items:center;justify-content:center;gap:18px;color:#f2efe9;font:600 52px/1 sans-serif}
      img{display:block;width:104px;height:104px}
    </style><img src="data:image/svg+xml;base64,${androidSource}" alt=""><span>Den</span>`,
  );
  await banner.locator('img').evaluate((image) => image.decode());
  await banner.screenshot({ path: join(androidTarget, 'tv_banner.png'), omitBackground: false });
  await banner.close();
} finally {
  await browser.close();
}
