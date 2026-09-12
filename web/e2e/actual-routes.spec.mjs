import { guardNetwork } from './network.mjs';
import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

test('actual-routes regressions', async () => {
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
try {
 for(const width of [390,1280]) {
  const context=await browser.newContext({viewport:{width,height:800}});const page=await context.newPage(); await guardNetwork(page);const errors=[];let docs=0;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.isNavigationRequest()&&r.frame()===page.mainFrame())docs++;});
  await page.route('**/routes',r=>r.fulfill({json:{}}));
  await page.route('https://image.tmdb.org/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>'}));
  let releaseActor;const actorReady=new Promise(r=>releaseActor=r);
  await page.route('https://api.themoviedb.org/**',async r=>{
   if(r.request().url().includes('/person/')) {await actorReady;return r.fulfill({json:{id:7,name:'An Actor',biography:'Actor biography',cast:[]}});}
   return r.fulfill({json:{id:42,title:'The Movie',poster_path:'/poster.jpg',backdrop_path:'/backdrop.jpg',release_date:'2026-01-01',overview:'A long description. '.repeat(250),genres:[{name:'Drama'}],credits:{cast:[{id:7,name:'An Actor',profile_path:'/actor.jpg'}]},recommendations:{results:[]}}});
  });
  await page.addInitScript(()=>{
    window.scrollLog=[];
    const scroll=window.scrollTo.bind(window);
    window.scrollTo=(...args)=>{window.scrollLog.push({args,height:document.documentElement.scrollHeight,page:document.querySelector('[data-active="true"] h1')?.textContent});return scroll(...args);};
  });
  await page.goto('http://127.0.0.1:5198/test/actual-routes.html#title/movie/42');
  await page.waitForSelector('[data-active="true"] .backdrop');
  // Offscreen lazy actor images need not load before capturing the visible page.
  await page.evaluate(async()=>{
    const visible = Array.from(document.images).filter(image => {
      const box = image.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
    });
    await Promise.race([
      Promise.all(visible.map(image => image.decode().catch(() => {}))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('visible fixture images did not decode')), 5000)),
    ]);
  });
  const liveFrame=await page.screenshot({path:test.info().outputPath('live-detail-'+width+'.png')});
  await page.evaluate(async()=>{
    const {capturePage}=await import('/src/lib/pageSnapshot.ts');
    const overlay=document.createElement('div');overlay.dataset.visualCheck='';
    overlay.style.cssText='position:fixed;inset:0;z-index:9;pointer-events:none';
    overlay.append(capturePage().show());document.body.append(overlay);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  });
  const frozenFrame=await page.screenshot({path:test.info().outputPath('frozen-detail-'+width+'.png')});
  await test.info().attach('live-detail-'+width,{body:liveFrame,contentType:'image/png'});
  await test.info().attach('frozen-detail-'+width,{body:frozenFrame,contentType:'image/png'});
  assert.ok(liveFrame.equals(frozenFrame),'detail snapshot must paint exactly like the live detail, including its backdrop');
  await page.evaluate(()=>document.querySelector('[data-visual-check]').remove());
  const actor=page.locator('[data-active="true"] a').filter({hasText:'An Actor'});
  await actor.scrollIntoViewIfNeeded();await page.waitForTimeout(300);
  const before=await page.evaluate(()=>scrollY);
  await page.evaluate(()=>window.heading=document.querySelector('[data-active="true"] h1'));
  await actor.click();
  await page.waitForSelector('[data-loading-snapshot]');
  assert.equal(await page.locator('[data-loading-snapshot] h1').innerText(),'The Movie','keep outgoing snapshot while actor data loads');
  assert.equal(await page.locator('[data-loading-snapshot] [role="status"]').count(),1);
  releaseActor();
  await page.waitForSelector('[data-loading-snapshot]',{state:'detached'});
  await page.waitForSelector('[data-active="true"] h1:text-is("An Actor")');await page.waitForTimeout(300);
  await page.goBack();await page.waitForSelector('[data-active="true"] h1:text-is("The Movie")');await page.waitForTimeout(400);
  const after=await page.evaluate(()=>scrollY);
  console.log(JSON.stringify({width,before,after,errors,docs,debug:await page.evaluate(()=>({log:window.scrollLog,same:window.heading===document.querySelector('[data-active="true"] h1')}))}));assert.ok(before>300);assert.equal(after,before);assert.deepEqual(errors,[]);assert.equal(docs,1);
  for(const forward of [true,false]) {
    await page.evaluate(forward=>{
      const target=document.querySelector('[data-active="true"]');
      const coords=forward?[innerWidth-5,innerWidth-50,innerWidth-150]:[5,50,150];
      for(const [i,type] of ['touchstart','touchmove','touchend'].entries()) {
        const touch=new Touch({identifier:1,target,clientX:coords[i],clientY:300});
        target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:i===2?[]:[touch],changedTouches:[touch]}));
      }
    },forward);
    await page.waitForSelector('[data-swipe-preview]',{state:'detached'});
    assert.equal(await page.locator('[data-active="true"] h1').innerText(),forward?'An Actor':'The Movie');
  }
  assert.equal(await page.evaluate(()=>scrollY),before);
  assert.equal(await page.evaluate(()=>window.heading===document.querySelector('[data-active="true"] h1')),true);
  assert.equal(docs,1);
  assert.deepEqual(errors,[],'swipes must not introduce runtime errors');
  console.log(width+': actor spinner over snapshot, repeated swipe-forward/back, preserved movie DOM and scroll, one document request passed');
  await context.close();
 }
} finally {await browser.close();}

});
