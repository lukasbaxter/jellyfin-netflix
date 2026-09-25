// Real-browser perf probe: headed Brave, retina, measures frames + long tasks while scrolling and hovering.
import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: 2 });
if (process.env.NFX_LOCAL) {
  await ctx.route(/\/NetflixUi\/netflix\.css/, r=>r.fulfill({contentType:'text/css',body:fs.readFileSync('../theme/dist/netflix.css')}));
  await ctx.route(/\/NetflixUi\/netflix\.js/, r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync('../plugin/web/netflix.js')}));
}
if (process.env.NOPLUGIN) await ctx.route(/\/NetflixUi\/netflix\.(css|js)/, r=>r.fulfill({contentType: r.request().url().includes('.css')?'text/css':'application/javascript', body:''}));
const p = await ctx.newPage();
await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
await p.fill('#txtManualName', env.STAGING_VIEWER_USER); await p.fill('#txtManualPassword', env.STAGING_VIEWER_PASS);
await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(9000);
await p.evaluate(()=>{
  window.__lt=[]; try { new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__lt.push(Math.round(e.duration)))).observe({type:'longtask', buffered:false}); } catch(e){}
  window.__rec = () => { window.__f=[]; const f=t=>{window.__f.push(t); if(window.__f.length<100000 && window.__on) requestAnimationFrame(f)}; window.__on=true; requestAnimationFrame(f); };
  window.__stop = () => { window.__on=false; const f=window.__f; const d=[]; for(let i=1;i<f.length;i++) d.push(f[i]-f[i-1]); const s=[...d].sort((a,b)=>a-b); return {frames:f.length, fps:Math.round(1000*(f.length-1)/(f[f.length-1]-f[0])), p50:Math.round(s[s.length>>1]), p95:Math.round(s[Math.floor(s.length*.95)]), over50:d.filter(x=>x>50).length, long:window.__lt.splice(0)}; };
});
const idle = async () => { await p.evaluate(()=>window.__rec()); await p.waitForTimeout(2500); return p.evaluate(()=>window.__stop()); };
console.log('IDLE top   ', JSON.stringify(await idle()));
await p.evaluate(()=>window.__rec());
for (let i=0;i<30;i++) { await p.mouse.wheel(0, 120); await p.waitForTimeout(40); }
console.log('SCROLL     ', JSON.stringify(await p.evaluate(()=>window.__stop())));
await p.evaluate(()=>window.scrollTo(0, 900)); await p.waitForTimeout(1500);
await p.evaluate(()=>window.__rec());
const cards = p.locator(process.env.NOPLUGIN ? '.homeSectionsContainer .card' : '#nfx-home .nfx-row[data-nfx-row^="genre-"] .nfx-card');
for (let i=0;i<5;i++) { const bb = await cards.nth(i).boundingBox(); if (!bb) continue; await p.mouse.move(bb.x+bb.width/2, bb.y+bb.height/2, {steps: 10}); await p.waitForTimeout(700); }
console.log('HOVER      ', JSON.stringify(await p.evaluate(()=>window.__stop())));
await p.evaluate(()=>window.__rec());
const row = p.locator(process.env.NOPLUGIN ? '.homeSectionsContainer .verticalSection' : '#nfx-home .nfx-row[data-nfx-row^="genre-"]').nth(1); const rb = await row.boundingBox();
await p.mouse.move(rb.x+rb.width-20, rb.y+rb.height/2); await p.waitForTimeout(300);
for (let i=0;i<3;i++) { await p.mouse.click(rb.x+rb.width-20, rb.y+rb.height/2); await p.waitForTimeout(700); }
console.log('ROW ARROWS ', JSON.stringify(await p.evaluate(()=>window.__stop())));
console.log('IDLE after ', JSON.stringify(await idle()));
await b.close();
