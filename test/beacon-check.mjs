import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const b = await chromium.launch({ headless: true }); const p = await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
await p.fill('#txtManualName', env.STAGING_VIEWER_USER); await p.fill('#txtManualPassword', env.STAGING_VIEWER_PASS);
await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(6000);
await p.evaluate(()=>{ const t=Date.now(); while(Date.now()-t<300){} }); // a deliberate 300ms long frame
for (let i=0;i<10;i++) { await p.mouse.wheel(0, 200); await p.waitForTimeout(100); }
await p.waitForTimeout(17000);
await b.close();
