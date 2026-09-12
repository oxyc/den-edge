import { guardNetwork } from './network.mjs';
import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

test('snapshots regressions', async () => {
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
try {
for (const width of [390,1280]) {
 const page=await browser.newPage({viewport:{width,height:800}}); await guardNetwork(page);
 await page.goto('http://127.0.0.1:5198/test/snapshot.html');
 await page.waitForSelector('.hero');
 await page.waitForTimeout(350);
 const result=await page.evaluate(async()=>{
  scrollTo(0,140);
  document.querySelector('.rail').scrollLeft=400;
  const {capturePage}=await import('/src/lib/pageSnapshot.ts');
  const animated=document.querySelector('.animated');
  animated.getAnimations().forEach(a=>a.pause());
  const before=getComputedStyle(animated);
  const visual={transform:before.transform,opacity:before.opacity};
  const snapshot=capturePage();
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;z-index:99;';
  overlay.append(snapshot.show());document.body.append(overlay);
  const second=document.createElement('div');
  second.style.cssText='position:fixed;inset:0;z-index:100;';
  second.append(snapshot.show());document.body.append(second);
  if (!overlay.querySelector('.hero') || !second.querySelector('.hero')) throw Error('Showing snapshot twice must not move shared DOM');
  await new Promise(r=>requestAnimationFrame(r));
  if(second.querySelector('.rail').scrollLeft!==400) throw Error('Second snapshot must retain rail position');
  second.remove();
  const live=document.querySelector('#app .hero').getBoundingClientRect();
  const frozen=overlay.querySelector('.hero').getBoundingClientRect();
  const computed=getComputedStyle(overlay.querySelector('.animated'));
  return {visual,frozenVisual:{transform:computed.transform,opacity:computed.opacity},live:{top:live.top,left:live.left,width:live.width,height:live.height},frozen:{top:frozen.top,left:frozen.left,width:frozen.width,height:frozen.height},rail:overlay.querySelector('.rail').scrollLeft};
 });
 console.log(width,result);
 assert.deepEqual(result.frozen,result.live,'snapshot and live page must occupy identical pixels');
 assert.equal(result.rail,400);
 assert.deepEqual(result.frozenVisual,result.visual,'snapshot must preserve the painted animation frame');
 await page.close();
}
} finally {await browser.close();}

});
