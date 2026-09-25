import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
for (const [w,h,name] of [[1440,900,'desktop'],[390,844,'phone'],[1920,1080,'tv']]) {
  const m = name==='phone';
  const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:w,height:h}, deviceScaleFactor:m?3:1, isMobile:m, hasTouch:m});
  if (name==='tv') await ctx.addInitScript(()=>localStorage.setItem('layout','tv'));
  if (process.env.NFX_LOCAL) await ctx.route(/\/NetflixUi\/netflix\.css/, r=>r.fulfill({contentType:'text/css',body:fs.readFileSync('../theme/dist/netflix.css')}));
  const p = await ctx.newPage(); await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(3000);
  if (await p.locator('.btnManual').isVisible().catch(()=>false)) { await p.locator('.btnManual').click(); await p.waitForTimeout(500); }
  const r = await p.evaluate(()=>{const f=document.querySelector('#loginPage .manualLoginForm').getBoundingClientRect(); const ro=document.querySelector('#loginPage .readOnlyContent').getBoundingClientRect(); return {top:Math.round(f.top), bottom:Math.round(innerHeight-ro.bottom), left:Math.round(f.left), right:Math.round(innerWidth-f.right)}});
  console.log(name, JSON.stringify(r));
  await p.screenshot({path:`../screenshots/v3/${name}-login.png`}); await b.close();
}
