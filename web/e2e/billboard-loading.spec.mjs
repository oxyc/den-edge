import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';

for(const width of [390,844,1280]) test(`billboard reserves text and artwork before loading at ${width}px`,async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page=await browser.newPage({viewport:{width,height:800},reducedMotion:'reduce'});
    await guardNetwork(page);
    let releaseMetadata, releaseImages, requests=0;
    const metadata=new Promise(r=>releaseMetadata=r), images=new Promise(r=>releaseImages=r);
    await page.route('https://api.themoviedb.org/**',async r=>{
      requests++;
      await metadata;
      await r.fulfill({json:{id:42,title:'Detail title',backdrop_path:'/backdrop.jpg',runtime:145,genres:[{name:'Science Fiction'},{name:'Adventure'},{name:'Drama'}],overview:'A substantial movie overview that fills the allotted space. '.repeat(20)}});
    });
    await page.route('https://image.tmdb.org/**',async r=>{
      await images;
      await r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="blue"/></svg>'});
    });
    await page.goto('http://127.0.0.1:5198/test/billboard.html');
    const hero=page.locator('.billboard');
    const empty=await hero.boundingBox();
    await page.evaluate(()=>window.dispatchEvent(new Event('fixture:titles')));
    await expect(page.locator('.slide')).toHaveCount(2);
    const geometry=()=>page.evaluate(()=>{
      const measure=el=>{const r=el.getBoundingClientRect();return {top:r.top+scrollY,height:r.height};};
      return ['.billboard','.slide h2','.slide .facts','.slide .overview','.slide .actions','[data-following-content]'].map(s=>measure(document.querySelector(s)));
    });
    const before=await geometry();
    expect(before[0].height).toBe(empty.height);
    releaseMetadata();
    await expect(page.locator('.overview').first()).toContainText('substantial movie overview');
    expect(await geometry()).toEqual(before);
    releaseImages();
    await expect(hero.locator('img.backdrop.lit')).toHaveCount(1);
    await page.waitForFunction(()=>Array.from(document.images).every(i=>i.complete));
    expect(await geometry()).toEqual(before);
    await page.locator('.dot').nth(1).click();
    await expect(page.locator('.dot').nth(1)).toHaveAttribute('aria-current','true');
    expect((await hero.boundingBox()).height).toBe(empty.height);
    expect(requests,'concurrent metadata learning should be deduplicated').toBe(2);
  } finally {await browser.close();}
});
