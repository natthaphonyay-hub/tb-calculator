// ถ่ายรูปหน้าจอสำหรับคู่มือ manual/img/ จากหน้าเว็บในเครื่อง (จอมือถือ 390 px ความละเอียด 2 เท่า)
// ใช้: node tests/make-manual-shots.mjs   แก้หน้าตาแอปแล้วรันใหม่ แล้วสร้าง PDF ตาม README
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'manual', 'img'); mkdirSync(out, { recursive: true });
const url = pathToFileURL(join(root, 'index.html')).href;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tb-shots-'))}`, '--disable-gpu', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ } await sleep(200); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0; const wait = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; wait.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || x);
  return r.result.result.value;
};
const W = 390;
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 2, mobile: true });
async function fresh() {
  await send('Page.navigate', { url });
  for (let i = 0; i < 50; i++) { if (await ev('document.readyState') === 'complete') break; await sleep(100); }
  await ev('document.fonts.ready.then(() => 1)');
  await ev(`window.__set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }; 1`);
}
// ถ่ายเฉพาะกรอบที่ครอบองค์ประกอบทุกตัวใน selectors (ใส่ขอบเผื่อ 8 px) รูปจะได้ไม่ยาวเกินหน้า A4 ของคู่มือ
async function shot(name, selectors, pad = 8) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: Math.max(900, await ev('Math.ceil(document.documentElement.scrollHeight)')), deviceScaleFactor: 2, mobile: true });
  const list = JSON.stringify([].concat(selectors));
  const r = await ev(`(() => { const bs = ${list}.map(s => { const el = document.querySelector(s); if (!el) throw new Error('ไม่เจอ ' + s); return el.getBoundingClientRect(); });
    const x1 = Math.min(...bs.map(b => b.left)), y1 = Math.min(...bs.map(b => b.top)), x2 = Math.max(...bs.map(b => b.right)), y2 = Math.max(...bs.map(b => b.bottom));
    return { x: x1 + scrollX, y: y1 + scrollY, w: x2 - x1, h: y2 - y1 }; })()`);
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(W, r.w + pad * 2), height: r.h + pad * 2, scale: 1 };
  const res = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  writeFileSync(join(out, name), Buffer.from(res.result.data, 'base64'));
  console.log('ภาพ', name, Math.round(clip.width), 'x', Math.round(clip.height));
}
const card = n => `#sResult > .card:nth-of-type(${n})`;
const acard = n => `#aResult > .card:nth-of-type(${n})`;

// หน้าเริ่มยา
await fresh();
await ev(`__set('#sAge','45'); __set('#sDate','2026-11-08'); __set('#sWeight','52.0'); 1`);
await shot('s01-start-input.png', '#pageStart > .card');
await shot('s02-start-dose.png', card(1));
await ev(`document.querySelector('#sMore').open = true; 1`);
await shot('s03-start-follow.png', ['#sMore > summary', '#sMore table.follow']);
await ev(`document.querySelector('#sMore').open = false; document.querySelector('button[data-note="short"][data-page="s"]').click(); 1`);
await shot('s04-start-note.png', card(2));
await ev(`document.querySelector('#sEditToggle').click(); document.querySelector('button[data-act="plus"][data-code="H"][data-kind="start"]').click(); 1`);
await shot('s05-start-edit.png', [`${card(1)} .head-row`, '#sDrugs .drug[data-code="H"]']);
await fresh();
await ev(`__set('#sAge','45'); __set('#sDate','2026-11-08'); __set('#sWeight','80.5'); 1`);
await shot('s06-flag-blue.png', '#sDrugs .drug[data-code="E"]');
await fresh();
await ev(`__set('#sAge','45'); __set('#sDate','2026-11-08'); __set('#sWeight','30.0'); 1`);
await shot('s07-flag-yellow.png', '#sDrugs .drug[data-code="H"]');
await fresh();
await ev(`__set('#sAge','15'); __set('#sWeight','40.0'); 1`);
await shot('s08-message-age.png', '#sMsg');

// หน้าปรับยา
await fresh();
await ev(`document.querySelector('#tabAdjust').click(); __set('#aAge','45'); __set('#aDate','2026-12-08'); __set('#aOld','48.0'); __set('#aNew','52.0'); 1`);
await shot('a01-adjust-input.png', '#pageAdjust > .card');
await shot('a02-adjust-result.png', [`${acard(1)} > .band`, '#aCompare .cmp-row[data-code="R"]']);
await ev(`document.querySelector('.seg button[data-phase="continuation"]').click(); __set('#aOld','69.0'); __set('#aNew','71.0'); 1`);
await shot('a03-adjust-same.png', '#aVerdict');
await ev(`__set('#aOld','52.0'); __set('#aNew','53.0'); document.querySelector('#aEditToggle').click();
  for (const [act, s] of [['plus', 450], ['minus', 300], ['minus', 300]]) document.querySelector('button[data-act="' + act + '"][data-code="R"][data-s="' + s + '"][data-kind="cur"]').click(); 1`);
await shot('a04-adjust-current.png', '#aCompare .cmp-row[data-code="R"]');
await ev(`document.querySelector('#aEditToggle').click(); document.querySelector('button[data-note="short"][data-page="a"]').click(); 1`);
await shot('a05-adjust-note.png', acard(2));

ws.close(); chrome.kill();
