#!/usr/bin/env node

// Rasterize the checked-in brand SVG at the exact sizes required by webOS.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(import.meta.dirname, '..');
const source = `file://${join(webRoot, 'public', 'favicon.svg')}`;
const target = join(webRoot, 'tv-packaging', 'assets');
mkdirSync(target, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const size of [80, 130]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    await page.goto(source);
    await page.screenshot({ path: join(target, `icon-${size}.png`), omitBackground: false });
    await page.close();
  }
} finally {
  await browser.close();
}
