import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork } from './network.mjs';

const videoBytes=await readFile(new URL('./media/trailer.webm',import.meta.url));
const movie={id:42,imdb_id:'tt42',title:'The Movie',poster_path:'/poster.jpg',backdrop_path:'/backdrop.jpg',overview:'The description belongs below the title.',genres:[{name:'Drama'}]};
async function mock(page, trailer, bytes=videoBytes) {
  await guardNetwork(page);
  await page.route('https://api.themoviedb.org/**',r=>r.fulfill({json:movie}));
  await page.route('https://image.tmdb.org/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>'}));
  await page.route('**/reel/fixture/meta/**',trailer);
  await page.route('**/play/trailer.webm',r=>{
    const range=/bytes=(\d+)-(\d*)/.exec(r.request().headers().range??'');
    const start=range?Number(range[1]):0;
    const end=range?.[2]?Number(range[2]):bytes.length-1;
    return r.fulfill({status:range?206:200,contentType:'video/webm',body:bytes.subarray(start,end+1),
      headers:{'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
  });
}
for(const width of [390,1280]) test(`detail trailer layout and lifecycle at ${width}px`,async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page=await browser.newPage({viewport:{width,height:800},hasTouch:width<760});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let releaseTrailer;const ready=new Promise(r=>releaseTrailer=r);
    await mock(page,async r=>{await ready;await r.fulfill({json:{meta:{links:[{trailers:'http://internal/play/trailer.webm'}]}}});});
    await page.goto('http://127.0.0.1:5198/test/detail-trailer.html');
    await expect(page.locator('h1')).toHaveText('The Movie');
    const geometry=()=>page.evaluate(()=>['.hero','.head','.hero-actions','.overview'].map(s=>{
      const r=document.querySelector(s).getBoundingClientRect();return {top:r.top+scrollY,height:r.height};
    }));
    const before=await geometry();
    const media=await page.locator('[data-detail-media]').boundingBox();
    if(width<760) expect(before[1].top).toBeGreaterThanOrEqual(media.y+media.height);
    else expect(before[1].top).toBeLessThan(media.y+media.height);
    await page.evaluate(()=>window.originalVideo=document.querySelector('video'));
    releaseTrailer();
    const video=page.locator('video');
    await expect(video).toHaveClass(/\bplaying\b/);
    expect(await video.evaluate(v=>v.muted)).toBe(true);
    expect(await video.evaluate(v=>v.currentTime)).toBeLessThan(3);
    expect(await video.evaluate(v=>v.loop)).toBe(false);
    expect(await video.evaluate(v=>v.controls)).toBe(width<760);
    expect(await geometry()).toEqual(before);
    expect(await page.evaluate(()=>window.originalVideo===document.querySelector('video'))).toBe(true);
    // A gesture freezes the decoded frame, including each independently displayed copy.
    const frozen=await page.evaluate(async()=>{
      const {capturePage}=await import('/src/lib/pageSnapshot.ts');
      const source=document.querySelector('video');
      const snapshot=capturePage();
      const result=[];
      for(let i=0;i<2;i++) {
        const overlay=document.createElement('div');
        overlay.style.cssText='position:fixed;inset:0;z-index:99';
        overlay.append(snapshot.show());document.body.append(overlay);
        const canvas=overlay.querySelector('canvas');
        const actual=source.getBoundingClientRect(),copy=canvas.getBoundingClientRect();
        result.push({pixel:Array.from(canvas.getContext('2d').getImageData(0,0,1,1).data),
          bounds:[actual.x,actual.y,actual.width,actual.height],frozen:[copy.x,copy.y,copy.width,copy.height],
          fit:getComputedStyle(canvas).objectFit});
        overlay.remove();
      }
      return result;
    });
    for(const frame of frozen) {
      expect(frame.pixel[0]).toBeGreaterThan(240);
      expect(frame.pixel[1]).toBeLessThan(10);
      expect(frame.frozen).toEqual(frame.bounds);
      expect(frame.fit).toBe(width<760?'contain':'cover');
    }
    await page.screenshot({path:test.info().outputPath(`detail-trailer-${width}.png`)});
    await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
    await expect.poll(()=>video.evaluate(v=>v.paused)).toBe(true);
    await page.evaluate(()=>scrollTo(0,0));
    await expect.poll(()=>video.evaluate(v=>v.paused)).toBe(false);
    await page.emulateMedia({reducedMotion:'reduce'});
    await expect(video).not.toHaveAttribute('src');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await expect(video).toHaveClass(/\bplaying\b/);
    expect(await geometry()).toEqual(before);
    await video.evaluate(v=>v.currentTime=v.duration-.2);
    await expect(video).not.toHaveClass(/\bplaying\b/);
    expect(await video.evaluate(v=>v.paused)).toBe(true);
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('fixture:active',{detail:false})));
    await expect(video).not.toHaveAttribute('src');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('fixture:active',{detail:true})));
    await expect(video).toHaveClass(/\bplaying\b/);
    expect(await video.evaluate(v=>v.currentTime)).toBeLessThan(3);
    expect(errors).toEqual([]);
  } finally {await browser.close();}
});
for(const reduced of [false,true]) test(`detail trailer still fallback: ${reduced?'reduced motion':'unavailable'}`,async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page=await browser.newPage({reducedMotion:reduced?'reduce':'no-preference'});let requests=0;
    await mock(page,r=>{requests++;return r.fulfill({json:{meta:{links:[]}}});});
    await page.goto('http://127.0.0.1:5198/test/detail-trailer.html');
    await expect(page.locator('h1')).toHaveText('The Movie');
    if(!reduced) await expect.poll(()=>requests).toBe(1);
    await expect(page.locator('video')).not.toHaveClass(/\bplaying\b/);
    await expect(page.locator('video')).not.toHaveAttribute('src');
    await expect(page.locator('.backdrop')).toBeVisible();
    if(reduced) expect(requests).toBe(0);
  } finally {await browser.close();}
});

for(const failure of ['media error','autoplay blocked']) test(`detail trailer still fallback: ${failure}`,async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await mock(page,r=>r.fulfill({json:{meta:{links:[{trailers:'http://internal/play/trailer.webm'}]}}}));
    if(failure==='media error') {
      await page.route('**/play/trailer.webm',r=>r.fulfill({status:404,body:'Unavailable'}));
    } else {
      await page.addInitScript(()=>{
        window.playAttempts=0;
        HTMLMediaElement.prototype.play=function(){
          window.playAttempts++;
          return Promise.reject(new DOMException('Autoplay blocked','NotAllowedError'));
        };
      });
    }
    await page.goto('http://127.0.0.1:5198/test/detail-trailer.html');
    await expect(page.locator('h1')).toHaveText('The Movie');
    const video=page.locator('video');
    if(failure==='media error') await expect.poll(()=>video.evaluate(v=>!!v.error)).toBe(true);
    else await expect.poll(()=>page.evaluate(()=>window.playAttempts)).toBeGreaterThan(0);
    await expect(video).not.toHaveClass(/\bplaying\b/);
    expect(await video.evaluate(v=>v.paused)).toBe(true);
    await expect(page.locator('.backdrop')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {await browser.close();}
});

test('detail trailer ignores a URL that resolves after leaving the page',async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page=await browser.newPage();
    let release, responded;const ready=new Promise(r=>release=r);const responseSent=new Promise(r=>responded=r);
    await mock(page,async r=>{await ready;await r.fulfill({json:{meta:{links:[{trailers:'http://internal/play/trailer.webm'}]}}}).catch(()=>{});responded();});
    const requested=page.waitForRequest('**/reel/fixture/meta/**');
    await page.goto('http://127.0.0.1:5198/test/detail-trailer.html');
    await requested;
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('fixture:active',{detail:false})));
    release();await responseSent;
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await expect(page.locator('video')).not.toHaveAttribute('src');
    expect(await page.locator('video').evaluate(v=>v.paused)).toBe(true);
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('fixture:active',{detail:true})));
    await expect(page.locator('video')).toHaveClass(/\bplaying\b/);
  } finally {await browser.close();}
});

// A fully transparent player must not depend on a compositor callback to reveal itself.
// Suppress that callback while keeping the real decoder/playback events running.
test('mobile trailer reveals without a compositor callback or a tap',async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page=await browser.newPage({viewport:{width:390,height:800},hasTouch:true});
    await page.addInitScript(()=>{
      HTMLVideoElement.prototype.requestVideoFrameCallback=()=>1;
      HTMLVideoElement.prototype.cancelVideoFrameCallback=()=>{};
    });
    await mock(page,r=>r.fulfill({json:{meta:{links:[{trailers:'http://internal/play/trailer.webm'}]}}}));
    await page.goto('http://127.0.0.1:5198/test/detail-trailer.html');
    const video=page.locator('video');
    await expect.poll(()=>video.evaluate(v=>v.currentTime)).toBeGreaterThan(0);
    await expect(video).toHaveCSS('opacity','1');
    expect(await video.evaluate(v=>v.paused)).toBe(false);
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('fixture:active',{detail:false})));
    await expect(video).not.toHaveAttribute('src');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('fixture:active',{detail:true})));
    await expect(video).toHaveCSS('opacity','1');
  } finally {await browser.close();}
});

test('wide mobile trailer and its swipe snapshot have opaque letterboxing',async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page=await browser.newPage({viewport:{width:390,height:800},hasTouch:true});
    const wide=await readFile(new URL('./media/trailer-wide.webm',import.meta.url));
    await mock(page,r=>r.fulfill({json:{meta:{links:[{trailers:'http://internal/play/trailer.webm'}]}}}),wide);
    await page.goto('http://127.0.0.1:5198/test/detail-trailer.html');
    const video=page.locator('video');
    await expect(video).toHaveCSS('opacity','1');
    const bounds=await page.locator('[data-detail-media]').boundingBox();
    // Native controls may fade independently. The bars and picture are checked at the centre.
    const clip={x:Math.round(bounds.x+bounds.width/2),y:Math.ceil(bounds.y),width:1,height:Math.floor(bounds.height)-1};
    const samples=async()=>{
      const png=await page.screenshot({clip});
      return page.evaluate(async data=>{
        const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();
        const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
        const context=canvas.getContext('2d');context.drawImage(img,0,0);
        return [5,Math.floor(img.height/2),img.height-6].map(y=>Array.from(context.getImageData(0,y,1,1).data));
      },png.toString('base64'));
    };
    const live=await samples();
    expect(live[0]).toEqual([0,0,0,255]);
    expect(live[2]).toEqual([0,0,0,255]);
    expect(live[1][0]).toBeGreaterThan(240);
    expect(live[1][2]).toBeLessThan(10);
    await page.evaluate(async()=>{
      const {capturePage}=await import('/src/lib/pageSnapshot.ts');
      const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:99';
      overlay.append(capturePage().show());document.body.append(overlay);
    });
    const frozen = await samples();
    expect(frozen[0]).toEqual(live[0]); expect(frozen[2]).toEqual(live[2]);
    // The red fixture must remain visible and opaque. Native video and canvas color conversion
    // need not produce byte-identical RGB; the black letterboxes above must remain exact.
    expect(frozen[1][0]).toBeGreaterThan(240);
    expect(frozen[1][1]).toBeLessThan(10);
    expect(frozen[1][2]).toBeLessThan(10);
    expect(frozen[1][3]).toBe(255);
  } finally {await browser.close();}
});

for(const width of [320,1280]) for(const exact of [true,false]) test(`Trailer opens YouTube at ${width}px: ${exact?'exact video':'search fallback'}`,async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page=await browser.newPage({viewport:{width,height:800},hasTouch:width<760,reducedMotion:'reduce'});
    await mock(page,r=>r.fulfill({json:{meta:{links:[]}}}));
    if(exact) await page.route('https://api.themoviedb.org/**',r=>r.fulfill({json:{...movie,videos:{results:[{site:'YouTube',type:'Trailer',official:true,key:'fixture-key'}]}}}));
    await page.context().route('https://www.youtube.com/**',r=>r.fulfill({contentType:'text/html',body:'<title>YouTube fixture</title>'}));
    await page.goto('http://127.0.0.1:5198/test/detail-trailer.html?browser-play');
    const trailer=page.getByRole('link',{name:'Trailer on YouTube'});
    await expect(trailer).toBeVisible();
    expect((await trailer.locator('span').boundingBox()).width).toBeGreaterThan(30);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    const url=exact?'https://www.youtube.com/watch?v=fixture-key':'https://www.youtube.com/results?search_query=The%20Movie%20official%20trailer';
    await expect(trailer).toHaveAttribute('href',url);
    await expect(page.locator('iframe')).toHaveCount(0);
    if(width<760) {
      await expect(trailer).not.toHaveAttribute('target');
      await trailer.click();
      await expect(page).toHaveURL(url);
    } else {
      await expect(trailer).toHaveAttribute('target','_blank');
      const opened=page.waitForEvent('popup');
      await trailer.click();
      const youtube=await opened;
      await expect(youtube).toHaveURL(url);
      await expect(page).toHaveURL(/detail-trailer\.html\?browser-play$/);
      await youtube.close();
    }
  } finally {await browser.close();}
});


for (const failed of ['missing', 'portrait']) test(`mobile trailer tries the next candidate after a ${failed} first trailer`, async () => {
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page = await browser.newPage({viewport:{width:390,height:800},hasTouch:true});
    await mock(page, r => r.fulfill({json:{meta:{links:[
      {trailers:'http://internal/play/first.webm'}, {trailers:'http://internal/play/trailer.webm'},
    ]}}}));
    if (failed === 'portrait') await page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoHeight');
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {get() { return this.currentSrc.includes('first.webm') ? 400 : descriptor.get.call(this); }});
    });
    await page.route('**/play/first.webm', r => r.fulfill(failed === 'missing' ? {status:404,body:'Gone'} : {contentType:'video/webm',body:videoBytes}));
    await page.goto('http://127.0.0.1:5198/test/detail-trailer.html');
    const video = page.locator('video');
    await expect(video).toHaveAttribute('src', /trailer.webm$/);
    await expect(video).toHaveClass(/playing/);
    expect(await video.evaluate(v => v.currentTime)).toBeLessThan(3);
    await expect(video).toHaveCSS('opacity','1');
  } finally { await browser.close(); }
});
