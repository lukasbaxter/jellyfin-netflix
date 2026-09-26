// how long after the cursor settles on a home card does the preview open, per realistic pattern
import { chromium } from 'playwright';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync('../.staging.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>l.split(/=(.*)/s).slice(0,2)));
const b = await chromium.launch(); const ctx = await b.newContext({viewport:{width:1512,height:900}, deviceScaleFactor: 2});
const p = await ctx.newPage();
await p.goto(env.STAGING_URL+'/web/#/login'); await p.waitForTimeout(2500);
if (await p.locator('.btnManual').isVisible().catch(()=>false)) await p.locator('.btnManual').click();
await p.fill('#txtManualName', env.STAGING_ADMIN_USER); await p.fill('#txtManualPassword', env.STAGING_ADMIN_PASS);
await p.locator('.manualLoginForm .button-submit').click(); await p.waitForTimeout(5000);
const gate = p.locator('.nfx-gate__profile, .nfx-gate [data-user]').first();
if (await gate.isVisible().catch(()=>false)) { await gate.click(); await p.waitForTimeout(3000); }
await p.addInitScript(()=>{});
await p.evaluate(() => { window.__open = []; new MutationObserver(() => { const el = document.querySelector('.nfx-preview');
  const o = !!(el && el.classList.contains('is-open')); if (o !== window.__last) { window.__last = o; window.__open.push([o, performance.now()]); } })
  .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); });
const cards = async () => p.$$eval('#nfx-home .nfx-card[data-id], .homeSectionsContainer .card[data-id]', els => els
  .map(e => e.getBoundingClientRect()).filter(r => r.top > 120 && r.bottom < 880 && r.left > 20 && r.right < 1490)
  .map(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width })));
const now = () => p.evaluate(() => performance.now());
async function result(name, t0) {
  await p.waitForTimeout(3000);
  const ev = await p.evaluate(() => window.__open.splice(0));
  const first = ev.find(e => e[0] && e[1] >= 0);
  console.log(name.padEnd(34), first ? Math.round(first[1] - t0) + ' ms' : 'NEVER opened (3 s)');
}
async function park() { await p.mouse.move(5, 5); await p.waitForTimeout(1200); await p.evaluate(() => window.__open.splice(0)); }
let c = await cards();
await park(); let t = await now(); await p.mouse.move(c[0].x, c[0].y, { steps: 1 }); await result('rest, one quick jump onto card', t);
await park(); await p.mouse.move(c[0].x - c[0].w * 1.5, c[0].y);
for (let i = 1; i <= 30; i++) { await p.mouse.move(c[0].x - c[0].w * 1.5 + i * c[0].w * 1.5 / 30, c[0].y); await p.waitForTimeout(16); }
t = await now(); await result('slow drag across a row, stop', t);
await p.mouse.move(c[0].x, c[0].y - c[0].w); await p.waitForTimeout(300); t = await now();
await p.mouse.move(c[0].x, c[0].y, { steps: 4 }); await result('leave card, come back', t);
// trackpad-style: cursor parked over the rows, page scrolls underneath it, cursor never moves again
await park(); c = await cards();
const tgt = c.find(k => k.y > 400) || c[1];
const y0 = await p.evaluate(() => scrollY);
await p.mouse.move(tgt.x, tgt.y - 150, { steps: 5 }); await p.waitForTimeout(600);
await p.evaluate(() => window.__open.splice(0));
t = await now(); await p.mouse.wheel(0, 150); await result('scroll under a still cursor', t);
console.log('  scrolled', (await p.evaluate(() => scrollY)) - y0, 'px; under cursor:', await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.closest('.card[data-id]') ? 'card' : 'not a card'; }, [tgt.x, tgt.y - 150]));
// smoothness: preview size per frame while it opens, vs the card it grows from
await park(); c = await cards();
await p.evaluate(() => { window.__fr = []; const tick = () => { const el = document.querySelector('.nfx-preview.is-open');
  if (el) window.__fr.push(Math.round(el.getBoundingClientRect().width)); if (window.__fr.length < 20) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
await p.mouse.move(c[2].x, c[2].y, { steps: 2 }); await p.waitForTimeout(900);
console.log('card width', Math.round(c[2].w), '-> preview width per frame', (await p.evaluate(() => window.__fr)).join(' '));
await b.close();
