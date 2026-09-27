// the stock loading spinner with the local theme css injected (nothing deployed)
import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1512,height:900}, deviceScaleFactor: 2});
await ctx.route(/\/NetflixUi\/netflix\.css/, r=>r.fulfill({contentType:'text/css',body:fs.readFileSync('../theme/dist/netflix.css')}));
const p = await ctx.newPage();
await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
await p.fill('#txtManualName', env.STAGING_ADMIN_USER); await p.fill('#txtManualPassword', env.STAGING_ADMIN_PASS);
await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(5000);
const gate = p.locator('.nfx-gate__profile, .nfx-gate [data-user]').first();
if (await gate.isVisible().catch(()=>false)) { await gate.click(); await p.waitForTimeout(3000); }
const info = await p.evaluate(() => { let s = document.querySelector('.docspinner');
  if (!s) { s = document.createElement('div'); s.className = 'docspinner mdl-spinner'; s.innerHTML = '<div class="mdl-spinner__layer"></div>'; document.body.appendChild(s); }
  s.classList.add('mdlSpinnerActive'); const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
  return { w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, anim: cs.animationName, display: cs.display }; });
console.log(info);
await p.waitForTimeout(300);
await p.screenshot({ path: '../screenshots/spinner-home.png' });
await b.close();
