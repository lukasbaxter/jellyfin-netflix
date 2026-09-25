import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const b = await chromium.launch({headless:true}); const ctx = await b.newContext({ viewport: { width: 1512, height: 900 }, deviceScaleFactor: 2 });
if (process.env.NFX_LOCAL) {
  await ctx.route(/\/NetflixUi\/netflix\.css/, r=>r.fulfill({contentType:'text/css',body:fs.readFileSync('../theme/dist/netflix.css')}));
  await ctx.route(/\/NetflixUi\/netflix\.js/, r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync('../plugin/web/netflix.js')}));
}
const p = await ctx.newPage();
await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
await p.fill('#txtManualName', env.STAGING_VIEWER_USER); await p.fill('#txtManualPassword', env.STAGING_VIEWER_PASS);
await p.evaluate(()=>performance.clearResourceTimings());
await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(12000);
const r = await p.evaluate(()=>performance.getEntriesByType('resource').map(e=>({u:e.name.replace(location.origin,'').slice(0,110), d:Math.round(e.duration), s:e.transferSize||e.encodedBodySize, st:Math.round(e.startTime)})));
const img = r.filter(x=>/\/Images\//.test(x.u)), api = r.filter(x=>!/\/Images\//.test(x.u) && !/\.(js|css|woff2?|png|svg)(\?|$)/.test(x.u));
const sum = a => a.reduce((t,x)=>t+x.s,0);
console.log('requests', r.length, '| images', img.length, Math.round(sum(img)/1e6*10)/10+'MB', '| api', api.length);
console.log('image ms p50/p90/max', [.5,.9,1].map(q=>{const d=img.map(x=>x.d).sort((a,b)=>a-b); return d[Math.min(d.length-1,Math.floor(d.length*q))]}).join('/'));
console.log('slowest api:'); api.sort((a,b)=>b.d-a.d).slice(0,12).forEach(x=>console.log(' ', x.d+'ms', x.u));
const stock = img.filter(x=>/fillHeight|fillWidth/.test(x.u)); console.log('stock-card images', stock.length, stock.slice(0,3).map(x=>x.u));
console.log('biggest images:'); img.sort((a,b)=>b.s-a.s).slice(0,4).forEach(x=>console.log(' ', Math.round(x.s/1024)+'KB', x.d+'ms', x.u));
await b.close();
