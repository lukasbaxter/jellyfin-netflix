import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1440,height:900}});
if (process.env.NFX_LOCAL) {
  await ctx.route(/\/NetflixUi\/netflix\.css/, r=>r.fulfill({contentType:'text/css',body:fs.readFileSync('../theme/dist/netflix.css')}));
  await ctx.route(/\/NetflixUi\/netflix\.js/, r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync('../plugin/web/netflix.js')}));
}
const p = await ctx.newPage();
await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
await p.fill('#txtManualName', env.STAGING_VIEWER_USER); await p.fill('#txtManualPassword', env.STAGING_VIEWER_PASS);
await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(8000);
const cdp = await ctx.newCDPSession(p); await cdp.send('Performance.enable');
const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
// idle: count DOM mutations + style work over 3 s with nothing happening
await p.evaluate(()=>{ window.__mut=0; window.__src={}; new MutationObserver(ms=>{ms.forEach(x=>{window.__mut++; const t=x.target; const k=x.type+':'+(x.attributeName||'')+':'+(t.id||'')+'.'+String(t.className||t.nodeName).slice(0,40); window.__src[k]=(window.__src[k]||0)+1;})}).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true}); });
const a = await m(); await p.waitForTimeout(3000); const z = await m();
console.log(JSON.stringify(await p.evaluate(()=>window.__src),null,1)); console.log('IDLE 3s: mutations', await p.evaluate(()=>window.__mut), 'recalcStyle ms', Math.round((z.RecalcStyleDuration-a.RecalcStyleDuration)*1000), 'script ms', Math.round((z.ScriptDuration-a.ScriptDuration)*1000), 'layout ms', Math.round((z.LayoutDuration-a.LayoutDuration)*1000), 'task ms', Math.round((z.TaskDuration-a.TaskDuration)*1000));
// fps while moving the mouse across a row
const card = p.locator('#nfx-home .nfx-row[data-nfx-row^="genre-"] .nfx-card').nth(1);
await card.scrollIntoViewIfNeeded(); await p.waitForTimeout(800);
const bb = await card.boundingBox();
await p.evaluate(()=>{ window.__frames=[]; const f=t=>{window.__frames.push(t); if(window.__frames.length<400) requestAnimationFrame(f)}; requestAnimationFrame(f); });
await p.evaluate(()=>{ window.__t={}; document.addEventListener('mouseover', e=>{ if(!window.__t.over && e.target.closest && e.target.closest('#nfx-home .nfx-card')) window.__t.over=performance.now(); }, true); new MutationObserver(()=>{ const el=document.querySelector('.nfx-preview'); if(el && !window.__t.el) window.__t.el=performance.now(); if(el && el.classList.contains('is-open') && !window.__t.open) window.__t.open=performance.now(); }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']}); });
  const t0 = Date.now();
await p.mouse.move(bb.x-50, bb.y+bb.height/2); await p.mouse.move(bb.x+bb.width/2, bb.y+bb.height/2, {steps: 8});
const opened = await p.waitForSelector('.nfx-preview.is-open', {timeout: 5000}).then(()=>Date.now()-t0).catch(()=>'never');
for (let i=0;i<20;i++) await p.mouse.move(bb.x + (i%2? 900: 50), bb.y+bb.height/2, {steps: 6});
const fr = await p.evaluate(()=>{const f=window.__frames; const d=[]; for(let i=1;i<f.length;i++) d.push(f[i]-f[i-1]); d.sort((a,b)=>a-b); return {n:f.length, fps: Math.round(1000*(f.length-1)/(f[f.length-1]-f[0])), p50: Math.round(d[d.length>>1]), p95: Math.round(d[Math.floor(d.length*.95)])}});
console.log('in-page', await p.evaluate(()=>JSON.stringify({elAfterOver: Math.round(window.__t.el-window.__t.over), openAfterOver: Math.round(window.__t.open-window.__t.over)}))); console.log('hover open after', opened, 'ms; frames', JSON.stringify(fr));
await b.close();
