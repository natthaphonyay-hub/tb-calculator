// สร้าง manual/tb-calculator-manual.pdf จาก manual/index.html (A4 ตาม @page ในหน้า รอฟอนต์และรูปโหลดครบก่อนพิมพ์)
// ใช้: node tests/make-manual-pdf.mjs   รันหลัง make-manual-shots.mjs ทุกครั้งที่แก้คู่มือหรือหน้าตาแอป
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const url = pathToFileURL(join(root, 'manual', 'index.html')).href;
const outFile = join(root, 'manual', 'tb-calculator-manual.pdf');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tb-pdf-'))}`, '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ } await sleep(200); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0; const wait = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; wait.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result.result.value;

await send('Page.navigate', { url });
for (let i = 0; i < 50; i++) { if (await ev('document.readyState') === 'complete') break; await sleep(100); }
await ev('document.fonts.ready.then(() => 1)');
const broken = await ev('[...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.getAttribute("src"))');
const font = await ev('document.fonts.check("16px Sarabun")');
if (broken.length || !font) { console.error('ยังไม่พร้อม รูปเสีย', broken, 'ฟอนต์ Sarabun', font); ws.close(); chrome.kill(); process.exit(1); }
const res = await send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
writeFileSync(outFile, Buffer.from(res.result.data, 'base64'));
console.log('เขียน', outFile);
ws.close(); chrome.kill();
