// Behaviour checks for the Netflix UI plugin against staging.
//   node test/plugin.spec.mjs [--only=desktop] [--out=screenshots/build] [--disable-check]
// Exit code 1 when any assert fails. Screenshots go to <out>/<viewport>-<name>.png.
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.staging.env'), 'utf8')
    .split('\n').map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map(m => [m[1], m[2]]));
const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
}));
const BASE = env.STAGING_URL.replace(/\/$/, '');
const KEY = env.STAGING_API_KEY;
const OUT = path.resolve(root, args.out || 'screenshots/build');
const PLUGIN_ID = '6e2f1c0a9b7d4c1e8f3a5d6b7c8e9f10';
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
    phone: { browser: chromium, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    iphone: { browser: webkit, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
    desktop: { browser: chromium, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    tv: { browser: chromium, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, layout: 'tv' }
};

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

async function apiFetch(p, opts = {}) {
    return fetch(BASE + p, { ...opts, headers: { Authorization: `MediaBrowser Token="${KEY}"`, ...(opts.headers || {}) } });
}

async function login(page) {
    await page.goto(`${BASE}/web/#/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#txtManualName, .btnManual', { timeout: 30000 });
    if (!(await page.locator('.manualLoginForm:not(.hide)').count())) {
        const b = page.locator('.btnManual');
        if (await b.count()) await b.first().click();
    }
    await page.fill('#txtManualName', env.STAGING_VIEWER_USER);
    await page.fill('#txtManualPassword', env.STAGING_VIEWER_PASS);
    await page.locator('.manualLoginForm .button-submit').click();
    await page.waitForFunction(() => location.hash.includes('home'), null, { timeout: 30000 });
    await page.mouse.move(2, 2).catch(() => {});
}

async function waitHome(page, timeout = 40000) {
    await page.waitForSelector('#nfx-hero .nfx-btn--play', { timeout });
    await page.waitForFunction(() => document.querySelectorAll('[data-nfx-row]').length >= 2, null, { timeout });
    await page.waitForTimeout(1500);
}

async function shot(page, vp, name) {
    await page.screenshot({ path: path.join(OUT, `${vp}-${name}.png`) });
}

async function runViewport(vpName) {
    const vp = VIEWPORTS[vpName];
    const browser = await vp.browser.launch();
    const ctx = await browser.newContext({
        viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor,
        isMobile: vp.isMobile, hasTouch: vp.hasTouch, userAgent: vp.userAgent
    });
    if (vp.layout) await ctx.addInitScript((l) => { try { localStorage.setItem('layout', l); } catch { /* */ } }, vp.layout);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror ' + e.message + ' ' + (e.stack || '')));

    try {
        await login(page);
        await waitHome(page);
        const info = await page.evaluate(() => ({
            ver: window.__NFX_VERSION__,
            heroes: document.querySelectorAll('#nfx-hero').length,
            rows: [...document.querySelectorAll('[data-nfx-row]')].map(r => r.getAttribute('data-nfx-row')),
            html: document.documentElement.className,
            sw: (() => { const y = window.scrollY; window.scrollTo(400, y); const sx = window.scrollX; window.scrollTo(0, y); return sx; })(),
            iw: document.documentElement.scrollWidth,
            scrollerUpgraded: [...document.querySelectorAll('[data-nfx-row] [is="emby-scroller"]')].every(s => s.classList.contains('emby-scroller'))
        }));
        check(`${vpName}: netflix.js loaded`, info.ver, info.ver);
        check(`${vpName}: exactly one #nfx-hero`, info.heroes === 1, String(info.heroes));
        check(`${vpName}: >= 2 plugin rows`, info.rows.length >= 2, info.rows.join(','));
        check(`${vpName}: html has nfx class`, /\bnfx\b/.test(info.html), info.html);
        check(`${vpName}: row scrollers upgraded`, info.scrollerUpgraded);
        // stock desktop rows overflow the body (clipped by overflow hidden, only scrollable by script);
        // what matters is touch layouts, where a sideways page pan is visible
        if (vp.hasTouch) check(`${vpName}: no horizontal page scroll`, info.sw === 0, `scrollX after scrollTo(400) = ${info.sw}, scrollWidth ${info.iw}`);
        else console.log(`info  ${vpName}: scrollWidth ${info.iw} (stock rows, body overflow hidden)`);
        await shot(page, vpName, 'home');
        await page.evaluate(() => window.scrollTo(0, 1200));
        await page.waitForTimeout(900);
        const scrolled = await page.evaluate(() => document.documentElement.classList.contains('nfx-scrolled'));
        check(`${vpName}: nfx-scrolled toggles`, scrolled);
        await shot(page, vpName, 'home-scrolled');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(600);

        if (vpName === 'desktop') {
            // hover preview on a genre row card
            const card = page.locator('[data-nfx-row^="genre-"] .nfx-card').nth(1);
            await card.scrollIntoViewIfNeeded();
            await card.hover();
            await page.waitForTimeout(1400);
            const open = await page.evaluate(() => {
                const p = document.querySelector('.nfx-preview.is-open');
                return p ? { w: p.style.width, meta: p.querySelector('.nfx-preview__meta').textContent } : null;
            });
            check('desktop: hover preview opens', open, open ? JSON.stringify(open) : 'none');
            await shot(page, vpName, 'hover-preview');
            await page.mouse.move(5, 5);
            await page.waitForTimeout(600);
            const closed = await page.evaluate(() => !document.querySelector('.nfx-preview.is-open'));
            check('desktop: hover preview closes on leave', closed);
            // hover preview on a stock card too
            const stock = page.locator('.homeSectionsContainer .verticalSection:not([data-nfx-row]) .card[data-id]').first();
            if (await stock.count()) {
                await stock.scrollIntoViewIfNeeded();
                await stock.hover();
                await page.waitForTimeout(1400);
                check('desktop: preview on stock card', await page.locator('.nfx-preview.is-open').count() === 1);
                await shot(page, vpName, 'hover-preview-stock');
                await page.mouse.move(5, 5);
                await page.waitForTimeout(400);
            }
            await page.evaluate(() => window.scrollTo(0, 0));

            // home -> details -> home, 5 times
            for (let i = 0; i < 5; i++) {
                const c = page.locator('[data-nfx-row] .nfx-card').nth(i);
                await c.scrollIntoViewIfNeeded();
                await c.click();
                await page.waitForFunction(() => location.hash.includes('details'), null, { timeout: 15000 });
                await page.waitForTimeout(1200);
                await page.goBack();
                await page.waitForFunction(() => location.hash.includes('home'), null, { timeout: 15000 });
                await page.waitForTimeout(1200);
            }
            await waitHome(page);
            const after = await page.evaluate(() => {
                const keys = [...document.querySelectorAll('[data-nfx-row]')].map(r => r.getAttribute('data-nfx-row'));
                return { heroes: document.querySelectorAll('#nfx-hero').length, dupRows: keys.length !== new Set(keys).size, keys };
            });
            check('desktop: 5x home/details/home leaves 1 hero, no dup rows', after.heroes === 1 && !after.dupRows, JSON.stringify(after));

            // More Info goes to details
            await page.locator('#nfx-hero .nfx-btn--info').click();
            await page.waitForFunction(() => location.hash.includes('details'), null, { timeout: 15000 });
            check('desktop: More Info opens details', true);
            await page.goBack();
            await waitHome(page);

            // Play starts playback through the stock player
            await page.locator('#nfx-hero .nfx-btn--play').click();
            let playing = false;
            try {
                await page.waitForSelector('#videoOsdPage:not(.hide), .videoPlayerContainer', { timeout: 20000 });
                playing = true;
            } catch { /* */ }
            check('desktop: hero Play starts playback', playing);
            if (playing) {
                await page.waitForTimeout(4000);
                await page.mouse.move(700, 500);
                await page.waitForTimeout(500);
                await shot(page, vpName, 'player');
                await page.keyboard.press('Escape').catch(() => {});
                await page.goBack().catch(() => {});
                await page.waitForTimeout(2000);
            }
        }

        if (vpName === 'tv') {
            await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
            let reached = false;
            const trail = [];
            for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(250); }
            for (let i = 0; i < 12 && !reached; i++) {
                await page.keyboard.press('ArrowUp');
                await page.waitForTimeout(300);
                const a = await page.evaluate(() => {
                    const e = document.activeElement;
                    return e ? (e.className || e.tagName).toString().slice(0, 60) : '';
                });
                trail.push(a);
                reached = await page.evaluate(() => !!document.activeElement && document.activeElement.matches('#nfx-hero .nfx-btn--play'));
            }
            if (!reached) {
                // left/right within the hero actions row
                for (let i = 0; i < 3 && !reached; i++) {
                    await page.keyboard.press('ArrowLeft');
                    await page.waitForTimeout(250);
                    reached = await page.evaluate(() => !!document.activeElement && document.activeElement.matches('#nfx-hero .nfx-btn--play'));
                }
            }
            check('tv: D-pad reaches hero Play', reached, trail.join(' > '));
            await shot(page, vpName, 'hero-focus');
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(400);
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(600);
            await shot(page, vpName, 'row-focus');
        }
    } catch (e) {
        const at = (e.stack || '').split('\n').find(l => l.includes('plugin.spec.mjs')) || '';
        check(`${vpName}: run completed`, false, e.message.split('\n')[0] + ' ' + at.trim());
        await shot(page, vpName, 'failure').catch(() => {});
    }

    const nfx = errors.filter(t => /nfx|netflix/i.test(t));
    check(`${vpName}: no nfx console errors`, nfx.length === 0, nfx.slice(0, 3).join(' | '));
    fs.appendFileSync(path.join(OUT, 'console.txt'), errors.map(e => `[${vpName}] ${e}`).join('\n') + (errors.length ? '\n' : ''));
    await browser.close();
}

async function waitUp() {
    for (let i = 0; i < 60; i++) {
        try { const r = await fetch(BASE + '/System/Info/Public'); if (r.ok) return; } catch { /* */ }
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('staging did not come back');
}

async function restartStaging() {
    await apiFetch('/System/Restart', { method: 'POST' });
    await new Promise(r => setTimeout(r, 8000));
    await waitUp();
    await new Promise(r => setTimeout(r, 5000));
}

async function disableCheck() {
    const plugins = await (await apiFetch('/Plugins')).json();
    const me = plugins.find(p => p.Id.replace(/-/g, '') === PLUGIN_ID);
    if (!me) { check('disable: plugin present', false); return; }
    await apiFetch(`/Plugins/${me.Id}/${me.Version}/Disable`, { method: 'POST' });
    await restartStaging();
    const html = await (await fetch(BASE + '/web/index.html')).text();
    check('disable: index.html has no injection', !html.includes('/NetflixUi/netflix.js'));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await login(page);
    await page.waitForSelector('.homeSectionsContainer .card', { timeout: 40000 });
    await page.waitForTimeout(3000);
    const st = await page.evaluate(() => ({ js: !!window.__NFX_VERSION__, hero: !!document.querySelector('#nfx-hero'), rows: document.querySelectorAll('[data-nfx-row]').length }));
    check('disable: stock UI, no hero/rows/js', !st.js && !st.hero && st.rows === 0, JSON.stringify(st));
    await page.screenshot({ path: path.join(OUT, 'desktop-disabled-stock.png') });
    await browser.close();
    await apiFetch(`/Plugins/${me.Id}/${me.Version}/Enable`, { method: 'POST' });
    await restartStaging();
    const html2 = await (await fetch(BASE + '/web/index.html')).text();
    const count = html2.split('/NetflixUi/netflix.js').length - 1;
    check('re-enable: injection back exactly once', count === 1, String(count));
}

async function serverChecks() {
    const html = await (await fetch(BASE + '/web/index.html')).text();
    check('index.html injection exactly once', html.split('/NetflixUi/netflix.js').length - 1 === 1);
    const js = await fetch(BASE + '/NetflixUi/netflix.js');
    check('GET /NetflixUi/netflix.js 200', js.status === 200, String(js.status));
    const css = await fetch(BASE + '/NetflixUi/netflix.css');
    check('GET /NetflixUi/netflix.css 200', css.status === 200, String(css.status));
    const anon = await fetch(BASE + '/NetflixUi/Hero');
    check('Hero needs auth', anon.status === 401, String(anon.status));
    const plugins = await (await apiFetch('/Plugins')).json();
    const byName = n => plugins.find(p => p.Name === n);
    for (const n of ['Netflix UI', 'File Transformation', 'Intro Skipper']) {
        const p = byName(n);
        check(`plugin ${n} Active`, p && p.Status === 'Active', p ? `${p.Version} ${p.Status}` : 'missing');
    }
}

fs.writeFileSync(path.join(OUT, 'console.txt'), '');
await serverChecks();
const only = args.only ? String(args.only).split(',') : ['phone', 'desktop', 'tv'];
for (const vp of only) if (VIEWPORTS[vp]) await runViewport(vp);
if (args['disable-check']) await disableCheck();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
