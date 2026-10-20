#!/usr/bin/env node

// Resize the same artwork used when Den is pinned to an iOS home screen to the exact TV package icon sizes.
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(import.meta.dirname, '..');
const source = readFileSync(join(webRoot, 'public', 'apple-touch-icon.png')).toString('base64');
const target = join(webRoot, 'tv-packaging', 'assets');
mkdirSync(target, { recursive: true });
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
} finally {
  await browser.close();
}
