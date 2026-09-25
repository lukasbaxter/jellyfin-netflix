// Screenshot harness for the jellyfin-netflix theme.
// Usage: node test/shoot.mjs [--only=phone|desktop|tv|legacy|webkit] [--pages=home,detail] [--out=dir]
// Reads ../.staging.env for STAGING_URL and the viewer login.
// macOS blocks Playwright's WebKit from LAN addresses (Local Network privacy). For --only=webkit
// open a tunnel first and override the URL:
//   ssh -fNL 2199:localhost:2199 server && STAGING_URL=http://localhost:2199 node test/shoot.mjs --only=webkit
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function readEnv() {
    const env = {};
    const f = path.join(root, '.staging.env');
    if (!fs.existsSync(f)) throw new Error('.staging.env missing');
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return env;
}

const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
}));

const env = readEnv();
const BASE = (process.env.STAGING_URL || env.STAGING_URL).replace(/\/$/, '');
const USER = env.STAGING_VIEWER_USER;
const PASS = env.STAGING_VIEWER_PASS;
const KEY = env.STAGING_API_KEY;
const OUT = path.resolve(root, args.out || 'test/out');

export const VIEWPORTS = {
    phone: { browser: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    webkit: { browser: 'webkit', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    desktop: { browser: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    tv: { browser: 'chromium', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, layout: 'tv' },
    legacy: { browser: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, layout: 'desktop-legacy' }
};

async function api(p) {
    const r = await fetch(BASE + p, { headers: { Authorization: `MediaBrowser Token="${KEY}"` } });
    if (!r.ok) throw new Error(`${p} -> ${r.status}`);
    return r.json();
}

// Pick sample items once, with the admin key (viewer sees all libraries).
async function pickItems() {
    // Stable picks so screenshots compare run to run: well-rated items with a backdrop and a logo.
    const q = 'Recursive=true&Limit=1&SortBy=CommunityRating,SortName&SortOrder=Descending&HasBackdrop=true&ImageTypes=Logo&MinCommunityRating=7.5&HasOverview=true';
    const movie = (await api(`/Items?IncludeItemTypes=Movie&${q}`)).Items[0]
        || (await api('/Items?IncludeItemTypes=Movie&Recursive=true&Limit=1')).Items[0];
    const series = (await api(`/Items?IncludeItemTypes=Series&${q}`)).Items[0]
        || (await api('/Items?IncludeItemTypes=Series&Recursive=true&Limit=1')).Items[0];
    let season = null;
    if (series) season = (await api(`/Items?ParentId=${series.Id}&IncludeItemTypes=Season&Limit=1`)).Items[0];
    const views = (await api('/Library/VirtualFolders')) || [];
    const moviesLib = views.find(v => v.CollectionType === 'movies' && /^movies$/i.test(v.Name)) || views.find(v => v.CollectionType === 'movies');
    return { movie, series, season, moviesLibId: moviesLib && moviesLib.ItemId };
}

const nfxErrors = [];
const consoleLines = [];

async function settle(page, ms = 2500) {
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* keep going */ }
    await page.waitForTimeout(ms);
}

async function login(page) {
    await page.goto(`${BASE}/web/#/login`, { waitUntil: 'domcontentloaded' });
    await settle(page, 1500);
    const manualVisible = await page.locator('.manualLoginForm:not(.hide)').count();
    if (!manualVisible) {
        const btn = page.locator('.btnManual');
        if (await btn.count()) await btn.first().click();
    }
    await page.fill('#txtManualName', USER);
    await page.fill('#txtManualPassword', PASS);
    await page.locator('.manualLoginForm .button-submit').click();
    await page.waitForFunction(() => location.hash.includes('home'), null, { timeout: 30000 });
    await settle(page, 3000);
}

async function checkOverflow(page, vpName, pageName) {
    // Real horizontal page scroll: try to scroll sideways and see if the page moves.
    const r = await page.evaluate(() => {
        const y = window.scrollY;
        window.scrollTo(400, y);
        const sx = window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft;
        window.scrollTo(0, y);
        return { sx, sw: document.documentElement.scrollWidth, iw: window.innerWidth };
    });
    if (r.sx > 0) {
        const line = `OVERFLOW ${vpName}/${pageName}: page scrolls sideways by ${r.sx}px (scrollWidth ${r.sw}, innerWidth ${r.iw})`;
        consoleLines.push(line);
        console.log(line);
    }
}

async function shot(page, vpName, name, opts = {}) {
    const dir = path.join(OUT, vpName);
    fs.mkdirSync(dir, { recursive: true });
    await checkOverflow(page, vpName, name);
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: !!opts.full });
    console.log(`  ${vpName}/${name}.png`);
}

async function scrollTo(page, y) {
    await page.evaluate((yy) => {
        window.scrollTo(0, yy);
        const s = document.querySelector('.page:not(.hide) .scrollY, .mainAnimatedPage:not(.hide)');
        if (s && s.scrollHeight > s.clientHeight) s.scrollTop = yy;
    }, y);
    await page.waitForTimeout(900);
}

async function run(vpName, items, pages) {
    const vp = VIEWPORTS[vpName];
    const bt = vp.browser === 'webkit' ? webkit : chromium;
    const browser = await bt.launch();
    const ctx = await browser.newContext({
        viewport: vp.viewport,
        deviceScaleFactor: vp.deviceScaleFactor,
        isMobile: vp.isMobile && vp.browser !== 'webkit' ? true : undefined,
        hasTouch: vp.hasTouch,
        // Real phone UAs so jellyfin-web's browser detection picks its phone paths.
        userAgent: vp.isMobile
            ? (vp.browser === 'webkit'
                ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
                : 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36')
            : undefined
    });
    if (vp.layout) {
        await ctx.addInitScript((l) => { try { localStorage.setItem('layout', l); } catch { /* ignore */ } }, vp.layout);
    }
    const page = await ctx.newPage();
    try {
        await runPages(page, vp, vpName, items, pages);
    } finally {
        await browser.close();
    }
}

async function runPages(page, vp, vpName, items, pages) {
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = `[${vpName}] ${m.text()}`;
        consoleLines.push(t);
        if (/nfx|netflix/i.test(t)) nfxErrors.push(t);
    });
    page.on('pageerror', (e) => {
        const t = `[${vpName}] pageerror ${e.message}`;
        consoleLines.push(t);
        if (/nfx|netflix/i.test(t + (e.stack || ''))) nfxErrors.push(t);
    });

    const want = (p) => !pages || pages.includes(p);
    const sid = async () => page.evaluate(() => (window.ApiClient && window.ApiClient.serverId && window.ApiClient.serverId()) || '');

    if (want('login')) {
        await page.goto(`${BASE}/web/#/login`, { waitUntil: 'domcontentloaded' });
        await settle(page, 1500);
        await shot(page, vpName, 'login-users');
        const btn = page.locator('.btnManual');
        if (await btn.count() && await btn.first().isVisible()) { await btn.first().click(); await page.waitForTimeout(600); }
        await shot(page, vpName, 'login');
    }
    await login(page);
    const serverId = await sid();

    if (want('home')) {
        await settle(page, 2500);
        await shot(page, vpName, 'home');
        await scrollTo(page, 1200);
        await shot(page, vpName, 'home-scrolled');
        await scrollTo(page, 0);
        if (vpName === 'desktop' || vpName === 'legacy') {
            const card = page.locator('.homeSectionsContainer .card').nth(2);
            if (await card.count()) {
                await card.hover();
                await page.waitForTimeout(1200);
                await shot(page, vpName, 'home-hover');
            }
        }
        if (vpName === 'tv') {
            for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(250); }
            await page.waitForTimeout(600);
            await shot(page, vpName, 'home-focus');
        }
    }
    // Full page load per route, so one page's controller state can't leak into the next shot.
    const go = async (hash) => {
        await page.goto('about:blank');
        await page.goto(`${BASE}/web/${hash}`, { waitUntil: 'domcontentloaded' });
        await settle(page, 3000);
    };
    if (want('movie') && items.movie) {
        await go(`#/details?id=${items.movie.Id}&serverId=${serverId}`);
        await shot(page, vpName, 'movie-detail');
        await scrollTo(page, 900);
        await shot(page, vpName, 'movie-detail-scrolled');
        await scrollTo(page, 0);
    }
    if (want('series') && items.series) {
        await go(`#/details?id=${items.series.Id}&serverId=${serverId}`);
        await shot(page, vpName, 'series-detail');
        if (items.season) {
            await go(`#/details?id=${items.season.Id}&serverId=${serverId}`);
            await shot(page, vpName, 'season-episodes');
        }
    }
    if (want('library') && items.moviesLibId) {
        await go(`#/movies?topParentId=${items.moviesLibId}`);
        await shot(page, vpName, 'library-movies');
    }
    if (want('search')) {
        await go('#/search?query=the');
        await shot(page, vpName, 'search');
    }
    if (want('osd') && items.movie) {
        await go(`#/details?id=${items.movie.Id}&serverId=${serverId}`);
        const play = page.locator('.page:not(.hide) .mainDetailButtons .btnPlay:not(.hide), .page:not(.hide) .mainDetailButtons .btnReplay:not(.hide)');
        if (await play.count()) {
            await play.first().click();
            try {
                await page.waitForSelector('#videoOsdPage:not(.hide)', { timeout: 20000 });
                await page.waitForTimeout(5000);
                await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.pause(); });
                await page.mouse.move(vp.viewport.width / 2, vp.viewport.height / 2);
                await page.mouse.move(vp.viewport.width / 2 + 10, vp.viewport.height / 2 + 10);
                await page.waitForTimeout(800);
                await shot(page, vpName, 'osd');
            } catch (e) {
                consoleLines.push(`[${vpName}] osd: ${e.message}`);
            }
            try { await page.keyboard.press('Escape'); } catch { /* ignore */ }
        }
    }
}

const all = ['phone', 'desktop', 'tv'];
const which = args.only ? String(args.only).split(',') : all;
const pages = args.pages ? String(args.pages).split(',') : null;
const items = await pickItems();
console.log('items:', items.movie && items.movie.Name, '|', items.series && items.series.Name, '| movies lib', items.moviesLibId);
for (const v of which) {
    console.log(`viewport ${v}`);
    try { await run(v, items, pages); } catch (e) { consoleLines.push(`[${v}] FAILED ${e.stack}`); console.log(`FAILED ${v}: ${e.message}`); }
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'console.txt'), consoleLines.join('\n') + '\n');
if (nfxErrors.length) {
    console.log('nfx errors:\n' + nfxErrors.join('\n'));
    process.exit(1);
}
