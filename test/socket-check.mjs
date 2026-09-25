// Web client websocket check with legacy auth OFF.
// Usage: node test/socket-check.mjs            (staging from ../.staging.env)
//        node test/socket-check.mjs --keep-legacy-off
// Turns EnableLegacyAuthorization off on staging, logs the viewer in through the real
// web client, then checks:
//   1. after login the client opens /socket with ApiKey= (not api_key=) and it stays open
//   2. no socket 403 in the console after login
//   3. remote control works: a second session (the API key) sends a message to the
//      browser session and the browser shows it
// Legacy auth is always restored to what it was, even on failure.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const l of fs.readFileSync(path.join(root, '.staging.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
}
const BASE = (process.env.STAGING_URL || env.STAGING_URL).replace(/\/$/, '');
const H = { Authorization: `MediaBrowser Token="${env.STAGING_API_KEY}"`, 'Content-Type': 'application/json' };
const keepOff = process.argv.includes('--keep-legacy-off');

async function getCfg() { return (await fetch(BASE + '/System/Configuration', { headers: H })).json(); }
async function setLegacy(v) {
    const c = await getCfg();
    c.EnableLegacyAuthorization = v;
    const r = await fetch(BASE + '/System/Configuration', { method: 'POST', headers: H, body: JSON.stringify(c) });
    if (!r.ok) throw new Error('set legacy ' + r.status);
}

const results = [];
const pass = (ok, msg) => { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); };

const legacy0 = (await getCfg()).EnableLegacyAuthorization;
console.log('INFO  EnableLegacyAuthorization was ' + legacy0);
let browser;
try {
    await setLegacy(false);
    pass((await getCfg()).EnableLegacyAuthorization === false, 'legacy auth is off for the test');

    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const sockets = [];
    let loggedIn = false;
    const after403 = [];
    page.on('websocket', ws => {
        const rec = { url: ws.url(), afterLogin: loggedIn, frames: 0, closed: false };
        sockets.push(rec);
        ws.on('framereceived', () => rec.frames++);
        ws.on('close', () => { rec.closed = true; });
    });
    page.on('console', m => { if (loggedIn && /socket/i.test(m.text()) && /403/.test(m.text())) after403.push(m.text()); });

    await page.goto(`${BASE}/web/#/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    if (!(await page.locator('.manualLoginForm:not(.hide)').count())) {
        const b = page.locator('.btnManual');
        if (await b.count()) await b.first().click();
    }
    await page.fill('#txtManualName', env.STAGING_VIEWER_USER);
    await page.fill('#txtManualPassword', env.STAGING_VIEWER_PASS);
    loggedIn = true;
    await page.locator('.manualLoginForm .button-submit').click();
    await page.waitForFunction(() => location.hash.includes('home'), null, { timeout: 30000 });
    await page.waitForTimeout(8000);

    const post = sockets.filter(s => s.afterLogin);
    for (const s of post) console.log('INFO  socket ' + s.url.replace(/(ApiKey|api_key)=[0-9a-f]+/i, '$1=<token>') + ` frames=${s.frames} closed=${s.closed}`);
    const live = post.filter(s => /[?&]ApiKey=/.test(s.url) && !s.closed);
    pass(live.length >= 1, 'after login the web client socket uses ApiKey= and is open');
    pass(!post.some(s => /[?&]api_key=/.test(s.url)), 'no socket with api_key= after login');
    pass(after403.length === 0, 'no socket 403 in the console after login' + (after403.length ? ': ' + after403[0] : ''));

    // Second session: find the browser session and send it a message.
    const sessions = await (await fetch(BASE + '/Sessions?ActiveWithinSeconds=120', { headers: H })).json();
    const mine = sessions.find(s => s.UserName === env.STAGING_VIEWER_USER && /Web/i.test(s.Client || '') && s.SupportsRemoteControl);
    pass(!!mine, 'browser session is listed with SupportsRemoteControl');
    if (mine) {
        const text = 'nfx socket check ' + Date.now();
        const r = await fetch(`${BASE}/Sessions/${mine.Id}/Message`, { method: 'POST', headers: H, body: JSON.stringify({ Header: 'nfx', Text: text, TimeoutMs: 5000 }) });
        pass(r.status === 204, 'remote control message accepted (' + r.status + ')');
        let seen = false;
        try { await page.getByText(text).first().waitFor({ timeout: 8000 }); seen = true; } catch { /* not seen */ }
        pass(seen, 'the browser received the remote control message over the socket');
    }
} catch (e) {
    pass(false, 'error: ' + e.message);
} finally {
    if (browser) await browser.close();
    if (!keepOff) {
        await setLegacy(legacy0);
        pass((await getCfg()).EnableLegacyAuthorization === legacy0, 'EnableLegacyAuthorization restored to ' + legacy0);
    }
}
const fails = results.filter(x => !x).length;
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
