import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.staging.env', import.meta.url),'utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const [w,h,out,mobile] = [+process.argv[2], +process.argv[3], process.argv[4], process.argv[5]==='m'];
const b = await chromium.launch();
const ctx = await b.newContext({viewport:{width:w,height:h}, deviceScaleFactor: mobile?3:1, isMobile: mobile, hasTouch: mobile});
if (process.env.NFX_LOCAL) {
  await ctx.route(/\/NetflixUi\/netflix\.css/, r=>r.fulfill({contentType:'text/css',body:fs.readFileSync(new URL('../theme/dist/netflix.css', import.meta.url))}));
  await ctx.route(/\/NetflixUi\/netflix\.js/, r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync(new URL('../plugin/web/netflix.js', import.meta.url))}));
}
const p = await ctx.newPage();
// log in as the test admin first so the device has two profiles, then as the viewer
for (const [u,pw] of [[env.STAGING_ADMIN_USER, env.STAGING_ADMIN_PASS],[env.STAGING_VIEWER_USER, env.STAGING_VIEWER_PASS]]) {
  await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
  // "Add Profile" style: drop the current token without revoking it
  await p.evaluate(()=>{ const c=JSON.parse(localStorage.getItem('jellyfin_credentials')||'null'); if(c){c.Servers.forEach(s=>{s.AccessToken=null;s.UserId=null}); localStorage.setItem('jellyfin_credentials',JSON.stringify(c));} });
  await p.reload(); await p.waitForTimeout(2500);
  if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
  await p.fill('#txtManualName', u); await p.fill('#txtManualPassword', pw);
  await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(5000);
}
// a fresh app open
await p.evaluate(()=>sessionStorage.clear()); await p.reload(); await p.waitForTimeout(5000);
await p.screenshot({path: out});
console.log(await p.evaluate(()=>JSON.stringify((JSON.parse(localStorage.getItem('nfx-profiles')||'[]')).map(x=>x.Name))));
await b.close();
