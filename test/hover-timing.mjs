// time from mouse entering a home card to the hover preview being fully open
import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1512,height:900}});
const p = await ctx.newPage();
await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
await p.fill('#txtManualName', env.STAGING_ADMIN_USER); await p.fill('#txtManualPassword', env.STAGING_ADMIN_PASS);
await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(5000);
const gate = p.locator('.nfx-gate__profile, .nfx-gate [data-user]').first();
if (await gate.isVisible().catch(()=>false)) { await gate.click(); await p.waitForTimeout(3000); }
await p.evaluate(() => window.scrollTo(0, 500)); await p.waitForTimeout(1500);
const cards = await p.$$eval('#nfx-home .nfx-card[data-id], .homeSectionsContainer .card[data-id]', els => els
  .map(e => e.getBoundingClientRect()).filter(r => r.top > 150 && r.bottom < 850 && r.left > 20 && r.right < 1490)
  .slice(0, 3).map(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })));
if (cards.length < 2) { console.log('no cards found'); process.exit(1); }
async function timeOpen(c) {
  await p.evaluate(() => { window.__t = null; const pv = document.querySelector('.nfx-preview');
    window.__obs = new MutationObserver(() => { const el = document.querySelector('.nfx-preview.is-open'); if (el && !window.__t) window.__t = performance.now(); });
    window.__obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); });
  const t0 = await p.evaluate(() => performance.now());
  await p.mouse.move(c.x, c.y, { steps: 3 });
  await p.waitForTimeout(900);
  const r = await p.evaluate(() => { const el = document.querySelector('.nfx-preview'); const cs = el && getComputedStyle(el);
    return { t: window.__t, dur: cs && cs.transitionDuration }; });
  return { openMs: r.t ? Math.round(r.t - t0) : null, transition: r.dur };
}
await p.mouse.move(5, 5); await p.waitForTimeout(800);
console.log('cold hover  :', await timeOpen(cards[0]));
console.log('next card   :', await timeOpen(cards[1]));
await p.mouse.move(5, 5); await p.waitForTimeout(1200);
console.log('cold again  :', await timeOpen(cards[2] || cards[0]));
await b.close();
