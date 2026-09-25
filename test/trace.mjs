import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const mode = process.argv[2] || 'theme';
const b = await chromium.launch({ headless: true, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: 2 });
if (mode === 'local') {
  await ctx.route(/\/NetflixUi\/netflix\.css/, r=>r.fulfill({contentType:'text/css',body:fs.readFileSync('../theme/dist/netflix.css','utf8') + (process.env.EXTRA_CSS||'')}));
  await ctx.route(/\/NetflixUi\/netflix\.js/, r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync('../plugin/web/netflix.js')}));
}
if (mode === 'stock') await ctx.route(/\/NetflixUi\/netflix\.(css|js)/, r=>r.fulfill({contentType: r.request().url().includes('.css')?'text/css':'application/javascript', body:''}));
const p = await ctx.newPage(); await p.bringToFront();
await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
await p.fill('#txtManualName', env.STAGING_VIEWER_USER); await p.fill('#txtManualPassword', env.STAGING_VIEWER_PASS);
await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(9000);
const cdp = await ctx.newCDPSession(p);
const events = [];
cdp.on('Tracing.dataCollected', d => events.push(...d.value));
const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink,cc,gpu,viz', transferMode: 'ReportEvents' });
// scroll down the home page, hover five cards, page a row
for (let i=0;i<25;i++) { await p.mouse.wheel(0, 100); await p.waitForTimeout(30); }
await p.waitForTimeout(500);
const sel = mode==='stock' ? '.homeSectionsContainer .card' : '#nfx-home .nfx-row[data-nfx-row^="genre-"] .nfx-card';
const cards = p.locator(sel);
for (let i=0;i<5;i++) { const bb = await cards.nth(i+2).boundingBox().catch(()=>null); if (!bb) continue; await p.mouse.move(bb.x+bb.width/2, bb.y+bb.height/2, {steps: 12}); await p.waitForTimeout(900); }
for (let i=0;i<25;i++) { await p.mouse.wheel(0, -100); await p.waitForTimeout(30); }
await p.waitForTimeout(500);
await cdp.send('Tracing.end'); await done;
fs.writeFileSync(`../screenshots/trace-${mode}.json`, JSON.stringify(events));
// summarise main-thread + raster work by type
const agg = {};
for (const e of events) {
  if (e.ph !== 'X' || !e.dur) continue;
  const n = e.name;
  if (!/^(UpdateLayoutTree|RecalculateStyles|Layout|Paint|PaintImage|RasterTask|Decode Image|ImageDecodeTask|FunctionCall|EventDispatch|UpdateLayerTree|Composite Layers|PrePaint|Layerize|Commit|GPUTask|v8.run|TimerFire|FireAnimationFrame|HitTest|ParseAuthorStyleSheet)$/.test(n)) continue;
  (agg[n] = agg[n] || {ms:0, n:0, max:0}); agg[n].ms += e.dur/1000; agg[n].n++; agg[n].max = Math.max(agg[n].max, e.dur/1000);
}
const frames = events.filter(e=>e.name==='DrawFrame' || e.name==='Graphics.Pipeline').length;
const dropped = events.filter(e=>/DroppedFrame|Dropped/.test(e.name)).length;
const gpu = events.filter(e=>(e.name==='GPUTask'||e.name==='RasterTask'||e.name==='Paint')&&e.dur).map(e=>e.dur/1000).sort((a,b)=>b-a);
console.log(mode, process.env.LABEL||'', 'paint+raster+gpu total', Math.round(gpu.reduce((a,b)=>a+b,0))+'ms', 'worst', gpu.slice(0,3).map(Math.round).join('/')+'ms');
if(0) console.log(mode, 'frames drawn', frames, 'dropped', dropped);
if (process.env.FULL) Object.entries(agg).sort((a,b)=>b[1].ms-a[1].ms).slice(0,12).forEach(([k,v])=>console.log('  ', k.padEnd(20), Math.round(v.ms)+'ms', 'n='+v.n, 'max='+Math.round(v.max)+'ms'));
await b.close();
