import { guardNetwork } from './network.mjs';
import { test } from '@playwright/test';
import { chromium, firefox } from '@playwright/test';
import assert from 'node:assert/strict';

test('navigation regressions', async () => {
for (const [name, engine] of [['chromium', chromium]]) {
  const browser = await engine.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({viewport:{width,height:800}, hasTouch:true});
    const page = await context.newPage(); await guardNetwork(page);
    const errors=[];
    await page.addInitScript(() => {
      window.transitionChecks = []; window.transitionErrors = [];
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = update => {
        const transition = start(update);
        transition.ready.then(() => window.transitionChecks.push({
          oldAnimation: getComputedStyle(document.documentElement, '::view-transition-old(root)').animationName,
          newAnimation: getComputedStyle(document.documentElement, '::view-transition-new(root)').animationName,
          scroll: scrollY,
          direction: document.documentElement.dataset.denNavigation,
          oldOpacity: getComputedStyle(document.documentElement, '::view-transition-old(root)').opacity,
          newOpacity: getComputedStyle(document.documentElement, '::view-transition-new(root)').opacity,
        })).catch(e => window.transitionErrors.push(String(e)));
        return transition;
      };
    });
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('http://127.0.0.1:5198/test/router.html');
    const active = page.locator('[data-route-page][data-active="true"]');
    await active.getByLabel('Search').fill('my query');
    await active.getByText('Load more').click();
    await active.locator('.rail').evaluate(el => el.scrollLeft=500);
    await page.evaluate(() => window.scrollTo(0,950));
    await active.getByText('Details',{exact:true}).click();
    await page.waitForFunction(() => location.hash === '#title/tv/1399' && scrollY === 0);
    await page.waitForTimeout(250);
    await page.evaluate(() => window.scrollTo(0,1100));
    await active.getByText('Person',{exact:true}).click();
    await page.waitForFunction(() => location.hash === '#person/287' && scrollY === 0);
    await page.waitForTimeout(250);
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#title/tv/1399' && scrollY > 800);
    await page.waitForTimeout(250);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-active="true"] [data-page="library"]') && scrollY > 800);
    assert.equal(await active.getByLabel('Search').inputValue(),'my query');
    assert.equal(await active.locator('[data-count]').innerText(),'12');
    assert.equal(await active.locator('.rail').evaluate(el => el.scrollLeft),500);
    await page.goForward();
    await page.waitForFunction(() => location.hash === '#title/tv/1399');
    await page.waitForTimeout(260);
    // Touch events exercise the fallback without depending on host browser gesture settings.
    await page.evaluate(() => {
      const target=document.querySelector('[data-active="true"] section');
      const touch=x=>new Touch({identifier:1,target,clientX:x,clientY:300});
      for(const [type,x] of [['touchstart',5],['touchmove',50],['touchend',140]]) {
        const allowed = target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[touch(x)],changedTouches:[touch(x)]}));
        if(type === 'touchstart' && allowed) throw Error('App must claim the edge before native history starts');
        if(type === 'touchmove') {
          const overlay = document.querySelector('[data-swipe-preview]');
          if(!overlay || overlay.children[0].querySelector('h1').textContent !== 'library' || overlay.children[1].querySelector('h1').textContent !== 'title') throw Error('Swipe must reveal the previous page while dragging');
          if(overlay.children[0].querySelector('input').value !== 'my query') throw Error('Previous snapshot lost search state');
        }
      }
    });
    await page.waitForFunction(() => document.querySelector('[data-active="true"] [data-page="library"]') && scrollY > 800);
    assert.equal(await active.locator('.rail').evaluate(el => el.scrollLeft),500);
    await page.waitForSelector('[data-swipe-preview]', {state:'detached'});
    for (const cancel of [true,false]) {
      await page.evaluate(cancel => {
        const target = document.querySelector('[data-active="true"] section');
        const touch = x => new Touch({identifier:2,target,clientX:x,clientY:300});
        for (const [type,x] of [['touchstart',innerWidth-5],['touchmove',innerWidth-45],['touchend',innerWidth-(cancel ? 50 : 150)]]) {
          const allowed=target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[touch(x)],changedTouches:[touch(x)]}));
          if(type==='touchstart' && allowed) throw Error('Forward edge must be claimed');
          if(type==='touchmove') {
            const overlay=document.querySelector('[data-swipe-preview]');
            if(!overlay || overlay.children[0].querySelector('h1').textContent!=='title') throw Error('Forward target must be visible during the leftward drag');
            if(overlay.children[1].getBoundingClientRect().x>=0) throw Error('Current snapshot must move left');
          }
        }
      },cancel);
      await page.waitForSelector('[data-swipe-preview]', {state:'detached'});
      if(cancel) assert.equal(await active.locator('h1').innerText(),'library');
    }
    await page.waitForFunction(() => location.hash === '#title/tv/1399' && scrollY === 1100);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-active="true"] [data-page="library"]') && scrollY === 950);
    await page.waitForTimeout(260);
    await page.getByText('Movies',{exact:true}).click();
    await page.waitForFunction(() => location.hash === '#movies' && scrollY === 0);
    const noForward = await page.evaluate(() => {
      const target=document.querySelector('[data-active="true"] section');
      const touch=new Touch({identifier:3,target,clientX:innerWidth-5,clientY:300});
      const allowed=target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true,touches:[touch],changedTouches:[touch]}));
      return allowed && !document.querySelector('[data-swipe-preview]');
    });
    assert.ok(noForward,'new navigation must discard the old Forward destination');
    await page.getByText('Home',{exact:true}).click();
    await page.waitForFunction(() => location.hash === '#library' && scrollY > 800);
    await page.waitForTimeout(250);
    const transitions = await page.evaluate(() => window.transitionChecks);

    assert.deepEqual(await page.evaluate(() => window.transitionErrors),[],'ordinary transitions must not time out');
    assert.ok(transitions.length > 0, 'view transitions should run');
    assert.ok(transitions.every(t => t.direction === 'back' ? t.oldAnimation === 'den-back-out' && t.newAnimation === 'den-back-in' && t.oldOpacity === '1' && t.newOpacity === '1' : t.oldAnimation === 'none' && ['den-page-reveal','den-detail-open'].includes(t.newAnimation)), 'Back uses two opaque snapshots; forward opens gently: '+JSON.stringify(transitions));
    assert.deepEqual(errors,[]);
    console.log(`${name} ${width}: nested back/forward, query, loaded rows, horizontal scroll, tab return, swipe-back and swipe-forward/cancel passed`);
    await context.close();
  }
  for (const mode of ['reduced-motion', 'unsupported', 'rapid']) {
    const context = await browser.newContext({reducedMotion:mode === 'reduced-motion' ? 'reduce' : 'no-preference'});
    const page = await context.newPage(); await guardNetwork(page);
    const errors=[];
    page.on('pageerror', e => errors.push(String(e)));
    if(mode === 'unsupported') await page.addInitScript(() => document.startViewTransition = undefined);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.locator('input').fill('retained');
    await page.evaluate(() => {
      scrollTo(0,950);
      document.dispatchEvent(new CustomEvent('den:navigate',{detail:'#title/tv/1399'}));
      document.dispatchEvent(new CustomEvent('den:navigate',{detail:'#person/287'}));
    });
    await page.waitForFunction(() => document.querySelector('[data-active="true"] [data-page="person"]'));
    await page.waitForTimeout(250);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-active="true"] [data-page="title"]'));
    await page.waitForTimeout(250);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-active="true"] [data-page="library"]') && scrollY === 950);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('[data-active="true"] input').inputValue(),'retained');
    assert.deepEqual(errors,[]);
    console.log(mode + ': rapid navigation and restored Back passed');
    await context.close();
  }
  {
    const context=await browser.newContext({viewport:{width:390,height:800},hasTouch:true});
    const page=await context.newPage(); await guardNetwork(page);
    let documents=0;
    page.on('request',r=>{if(r.isNavigationRequest() && r.frame()===page.mainFrame()) documents++;});
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    for(const hash of ['#title/tv/1399','#person/287']) {
      await page.evaluate(hash=>document.dispatchEvent(new CustomEvent('den:navigate',{detail:hash})),hash);
      await page.waitForTimeout(300);
    }
    await page.goBack();await page.waitForTimeout(300);
    const overlays=await page.evaluate(()=>{
      const target=document.querySelector('[data-active="true"] section');
      const send=(type,x,id)=>{const touch=new Touch({identifier:id,target,clientX:x,clientY:300});return target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[touch],changedTouches:[touch]}));};
      send('touchstart',5,1);send('touchmove',50,1);
      const endAllowed=send('touchend',140,1);
      const button=Array.from(target.querySelectorAll('button')).find(b=>b.textContent==='Person');
      const ghostAllowed=button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,clientX:140,clientY:300}));
      send('touchstart',innerWidth-5,2);
      return {count:document.querySelectorAll('[data-swipe-preview]').length,endAllowed,ghostAllowed};
    });
    assert.equal(overlays.count,1,'opposite gestures must not overlap while landing');
    assert.equal(overlays.endAllowed,false,'touchend must remain owned by the app');
    assert.equal(overlays.ghostAllowed,false,'swipes must not also click through to a title or person');
    await page.waitForTimeout(700);
    assert.equal(await page.locator('[data-active="true"] h1').innerText(),'library');
    assert.equal(documents,1,'gestures must not cause another document request');
    console.log('gesture overlap: single owner and no document reload passed');
    await context.close();
  }
  {
    const context=await browser.newContext({viewport:{width:390,height:800},hasTouch:true});
    const page=await context.newPage(); await guardNetwork(page);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('den:navigate',{detail:'#person/287'})));
    await page.waitForTimeout(300);
    for (const [from,to,selector,expected] of [
      [90,220,'section','library'],
      [300,150,'section','person'],
      [5,150,'.rail div','library'],
      [385,230,'.rail div','person'],
    ]) {
      await page.evaluate(({from,to,selector})=>{
        const target=document.querySelector('[data-active="true"] '+selector);
        const touch=x=>new Touch({identifier:10,target,clientX:x,clientY:300});
        for(const [type,x] of [['touchstart',from],['touchmove',(from+to)/2],['touchend',to]])
          target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[touch(x)],changedTouches:[touch(x)]}));
      },{from,to,selector});
      await page.waitForFunction(expected=>document.querySelector('[data-active="true"] h1')?.textContent===expected,expected);
      await page.waitForSelector('[data-swipe-preview]',{state:'detached'});
    }
    const unaffected=await page.evaluate(()=>{
      const send=(selector,coords)=>{
        const target=document.querySelector('[data-active="true"] '+selector);
        return coords.map(([type,x,y])=>{
          const touch=new Touch({identifier:20,target,clientX:x,clientY:y});
          return target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[touch],changedTouches:[touch]}));
        });
      };
      return {
        vertical:send('section',[['touchstart',100,300],['touchmove',102,360],['touchend',102,400]]),
        carousel:send('.rail div',[['touchstart',100,300],['touchmove',220,300],['touchend',240,300]]),
        overlays:document.querySelectorAll('[data-swipe-preview]').length,
      };
    });
    assert.deepEqual(unaffected,{vertical:[true,true,true],carousel:[true,true,true],overlays:0});
    console.log('interior back/forward and carousel-edge history passed; vertical scrolling and interior carousel gestures remain native');
    await context.close();
  }
  {
    const context=await browser.newContext({viewport:{width:390,height:800},hasTouch:true,reducedMotion:'reduce'});
    const page=await context.newPage(); await guardNetwork(page);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    const go=async hash=>{
      await page.evaluate(hash=>document.dispatchEvent(new CustomEvent('den:navigate',{detail:hash})),hash);
      await page.waitForTimeout(80);
    };
    await go('#title/movie/1');
    // Returning Home can overlap a background refresh/loading cover. The cover is movie 1,
    // but the Home history entry must still own a Home snapshot when movie 2 is opened.
    await page.evaluate(()=>{
      const home=document.querySelector('[data-page="library"]');
      const marker=document.createElement('span');marker.dataset.routeLoading='';home.append(marker);
    });
    await go('#library');
    await page.waitForSelector('[data-loading-snapshot]');
    await go('#title/movie/2');
    const heading=await page.evaluate(()=>{
      const target=document.querySelector('[data-active="true"] section');
      for(const [type,x] of [['touchstart',5],['touchmove',150]]) {
        const touch=new Touch({identifier:30,target,clientX:x,clientY:300});
        target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:[touch],changedTouches:[touch]}));
      }
      return document.querySelector('[data-swipe-preview]')?.children[0].querySelector('h1')?.textContent;
    });
    assert.equal(heading,'library','movie 1 must never be saved as the Home snapshot while a loading cover is visible');
    await context.close();
    console.log('Home → movie 1 → loading Home → movie 2: Back snapshot belongs to Home');
  }
  {
    const context=await browser.newContext({viewport:{width:390,height:800},hasTouch:true,reducedMotion:'reduce'});
    const page=await context.newPage(); await guardNetwork(page);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    await page.evaluate(()=>location.hash='#person/7');
    await page.waitForFunction(()=>document.querySelector('[data-active="true"] h1')?.textContent==='person');
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('den:navigate',{detail:'#title/movie/2'})));
    await page.waitForFunction(()=>document.querySelector('[data-active="true"] h1')?.textContent==='title');
    const heading=await page.evaluate(()=>{
      const target=document.querySelector('[data-active="true"] section');
      for(const [type,x] of [['touchstart',5],['touchmove',150]]) {
        const touch=new Touch({identifier:40,target,clientX:x,clientY:300});
        target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:[touch],changedTouches:[touch]}));
      }
      return document.querySelector('[data-swipe-preview]')?.children[0].querySelector('h1')?.textContent;
    });
    assert.equal(heading,'person','unscoped hash entry must not inherit Home snapshot');
    await page.evaluate(()=>{
      const target=document.querySelector('[data-active="true"] section');
      const touch=new Touch({identifier:40,target,clientX:150,clientY:300});
      target.dispatchEvent(new TouchEvent('touchend',{bubbles:true,cancelable:true,touches:[],changedTouches:[touch]}));
      document.dispatchEvent(new CustomEvent('den:navigate',{detail:'#movies'}));
    });
    await page.waitForSelector('[data-swipe-preview]',{state:'detached'});
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-active="true"] h1').innerText(),'movies');
    await context.close();
    console.log('direct hash history adoption and competing-navigation gesture cancellation passed');
  }
  {
    const context=await browser.newContext({viewport:{width:390,height:800},reducedMotion:'reduce'});
    const page=await context.newPage(); await guardNetwork(page);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    const go=async hash=>{
      await page.evaluate(hash=>document.dispatchEvent(new CustomEvent('den:navigate',{detail:hash})),hash);
      await page.waitForTimeout(80);
    };
    await page.evaluate(()=>scrollTo(0,950));
    await go('#title/movie/9');
    assert.equal(await page.evaluate(()=>scrollY),0,'opening a movie from scrolled Home starts at top');
    await page.evaluate(()=>scrollTo(0,1100));
    await page.goBack();
    await page.waitForFunction(()=>scrollY===950);
    await page.goForward();
    await page.waitForFunction(()=>scrollY===1100);
    await page.goBack();
    await page.waitForFunction(()=>scrollY===950);
    await go('#title/movie/9');
    assert.equal(await page.evaluate(()=>scrollY),0,'explicitly reopening a movie starts at top, even if cached');
    await context.close();
    console.log('fresh/reopened detail starts at top; Home and history traversal retain their scroll');
  }
  {
    const context=await browser.newContext({viewport:{width:390,height:800},reducedMotion:'reduce'});
    const page=await context.newPage(); await guardNetwork(page);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    const go=async hash=>{
      await page.evaluate(hash=>document.dispatchEvent(new CustomEvent('den:navigate',{detail:hash})),hash);
      await page.waitForTimeout(80);
    };
    await go('#title/movie/42');
    await page.locator('[data-active="true"] input').fill('first visit');
    await page.evaluate(()=>scrollTo(0,1100));
    await go('#person/7');
    await go('#title/movie/42');
    await page.locator('[data-active="true"] input').fill('second visit');
    assert.equal(await page.evaluate(()=>scrollY),0);
    await page.goBack();
    await page.waitForFunction(()=>document.querySelector('[data-active="true"] h1')?.textContent==='person');
    await page.goBack();
    await page.waitForFunction(()=>document.querySelector('[data-active="true"] h1')?.textContent==='title' && scrollY===1100);
    assert.equal(await page.locator('[data-active="true"] input').inputValue(),'first visit');
    await context.close();
    console.log('duplicate movie visits keep separate scroll and local form state');
  }
  {
    const context=await browser.newContext({reducedMotion:'reduce'});
    const page=await context.newPage(); await guardNetwork(page);
    await page.goto('http://127.0.0.1:5198/test/router.html');
    await page.waitForSelector('[data-active="true"]');
    for(const id of [41,42,43]) {
      await page.evaluate(id=>document.dispatchEvent(new CustomEvent('den:navigate',{detail:'#title/movie/'+id})),id);
      await page.waitForFunction(id=>document.querySelector('[data-active="true"] section')?.dataset.routeId===String(id),id);
      await page.goBack();
      await page.waitForFunction(()=>document.querySelector('[data-active="true"] h1')?.textContent==='library');
    }
    await context.close();
    console.log('new branches at reused history positions render the selected movie ID');
  }
  } finally { await browser.close(); }
}

});
