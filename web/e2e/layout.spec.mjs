import { guardNetwork } from './network.mjs';
import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

test('layout regressions', async () => {
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
try {
const page=await browser.newPage(); await guardNetwork(page); const errors=[]; let requests=0;
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/routes',route=>route.fulfill({json:{}}));
await page.route('https://api.themoviedb.org/**',route=> {requests++;return route.fulfill({json:{results:Array.from({length:20},(_,i)=>({id:i+1,title:'Fixture movie '+i,name:'Fixture series '+i,poster_path:'/poster.jpg',backdrop_path:'/backdrop.jpg',release_date:'2026-01-01',vote_average:7,genre_ids:[18]})),page:1,total_pages:10}})});
await page.route('https://image.tmdb.org/**',route=>route.fulfill({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>'}));
await page.goto('http://127.0.0.1:5198/test/library.html');
await page.waitForTimeout(2500);
console.log(JSON.stringify({errors,requests,images:await page.locator('img').count(),text:(await page.locator('body').innerText()).slice(0,200)}));
assert.deepEqual(errors,[]);
assert.ok(await page.locator('img').count()>0,'library should render posters');
for (const width of [390,1280]) {
 const context=await browser.newContext({viewport:{width,height:800}});
 const detailPage=await context.newPage(); await guardNetwork(detailPage); const runtime=[];
 detailPage.on('pageerror',e=>runtime.push(e.message));
 let releaseMeta,releaseImages;
 const metadata=new Promise(r=>releaseMeta=r); const pictures=new Promise(r=>releaseImages=r);
 await detailPage.route('https://api.themoviedb.org/**',async route=>{await metadata; await route.fulfill({json:{id:42,title:'A Movie Worth Watching',poster_path:'/poster.jpg',backdrop_path:'/backdrop.jpg',release_date:'2026-01-01',runtime:120,overview:'A movie description.',genres:[{name:'Drama'}]}})});
 await detailPage.route('https://image.tmdb.org/**',async route=>{await pictures; await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>'})});
 await detailPage.goto('http://127.0.0.1:5198/test/detail.html');
 const before=await detailPage.locator('.hero').boundingBox();
 releaseMeta(); await detailPage.waitForSelector('h1');
 const loaded=await detailPage.locator('.hero').boundingBox();
 assert.ok(Math.abs(loaded.height-before.height)<2, 'hero should reserve its loading height');
 const poster=await detailPage.locator('.poster').boundingBox();
 assert.ok(Math.abs(poster.height-poster.width*1.5)<1,'poster space must be reserved before image load');
 releaseImages(); await detailPage.waitForFunction(()=>Array.from(document.images).every(i=>i.complete));
 const painted=await detailPage.locator('.hero').boundingBox();
 assert.equal(painted.height,loaded.height,'image loading must not move the hero');
 assert.deepEqual(runtime,[]);
 console.log('detail '+width+': loading hero and delayed poster dimensions remain stable');
 await context.close();
}
} finally {await browser.close();}

});
