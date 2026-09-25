import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const p = await b.newPage(); await p.goto('chrome://gpu'); await p.waitForTimeout(1500);
const t = await p.evaluate(()=>document.body.innerText + [...document.querySelectorAll('*')].map(e=>e.shadowRoot?e.shadowRoot.textContent:'').join(' '));
console.log((t.match(/(Rasterization|Compositing|WebGL|OpenGL|GL_RENDERER|ANGLE)[^\n]{0,80}/g)||[]).slice(0,10).join('\n'));
await b.close();
