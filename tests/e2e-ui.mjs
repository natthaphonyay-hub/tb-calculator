// ทดสอบหน้าเว็บจริงใน Chrome แบบคนกด: กรอกช่อง กดปุ่มแก้เม็ด กดใช้ขนาดที่เสนอ สลับแท็บ แล้วอ่านตัวเลขบนจอกับข้อความ note
// เทียบกับตัวคำนวณที่โหลดแยกใน Node และตรวจว่าไม่มีอะไรล้นจอที่ความกว้าง 300 ถึง 1280 px ถ่ายภาพจอไว้ที่ tmp/shots/
// ใช้: node tests/e2e-ui.mjs   (ต้องมี Google Chrome ที่ตำแหน่งปกติของ macOS)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEngine } from './run-engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const url = pathToFileURL(join(root, 'index.html')).href;
const shots = join(root, 'tmp', 'shots'); mkdirSync(shots, { recursive: true });
const api = loadEngine();
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tb-e2e-'))}`,
  '--disable-gpu', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 60; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}
const ws = new WebSocket(await target());
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0; const waiting = new Map(); const pageErrors = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map(a => a.value).join(' '));
});
const send = (method, params = {}) => new Promise(res => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result.result.value;
};
await send('Runtime.enable');
await send('Page.enable');
async function load(width = 1280, height = 900) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await send('Page.navigate', { url });
  for (let i = 0; i < 50; i++) { if (await ev('document.readyState') === 'complete') break; await sleep(100); }
  await ev('document.fonts.ready.then(() => true)');
}
async function shot(name, width) {
  const h = await ev('Math.ceil(document.documentElement.scrollHeight)');
  await send('Emulation.setDeviceMetricsOverride', { width, height: Math.min(h, 6000), deviceScaleFactor: 1, mobile: width < 700 });
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(shots, name), Buffer.from(r.result.data, 'base64'));
}

// ตัวช่วยที่รันในหน้า
const H = String.raw`
  window.__t = {
    set(sel, v) { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); },
    click(sel) { const el = document.querySelector(sel); if (!el) throw new Error('no ' + sel); el.click(); },
    rows(box, kind) { return [...document.querySelectorAll(box + ' .drug' + (kind ? '[data-kind="' + kind + '"]' : ''))].map(d => ({ code: d.dataset.code, dose: +d.dataset.dose, mgkg: d.dataset.mgkg,
      edited: d.dataset.edited === '1', flags: [...d.querySelectorAll('.flag')].map(f => f.dataset.flag), tabs: d.querySelector('.tabs-text').textContent,
      text: d.textContent.replace(/\s+/g, ' ').trim() })); },
    overflow() {
      const doc = document.documentElement, bad = [];
      if (doc.scrollWidth > doc.clientWidth + 1) bad.push('page ' + doc.scrollWidth + '>' + doc.clientWidth);
      document.querySelectorAll('.ddose, .dsub, .cell, .cmp-name, .verdict strong, input, .tabs button, .btn, .flag button, .follow td, .phases .kv, .stepper').forEach(el => {
        if (el.offsetParent === null) return;
        if (el.scrollWidth > el.clientWidth + 1) bad.push((el.id || el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth + ' ' + el.textContent.trim().slice(0, 30));
        const r = el.getBoundingClientRect(); if (r.right > doc.clientWidth + 1) bad.push('right ' + (el.className || el.tagName) + ' ' + Math.round(r.right));
      });
      return bad;
    },
  }; true`;

let checks = 0; const fails = [];
const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); };
const fmtW = w10 => `${Math.floor(w10 / 10)}.${w10 % 10}`;

/* ---------- 1. หน้าเริ่มยา: ทุกน้ำหนักขอบ + สุ่ม เทียบตัวคำนวณ ---------- */
await load(1280);
await ev(H);
const weights = new Set(['20.0', '29.9', '30.0', '34.9', '35.0', '49.5', '49.9', '50.0', '52.0', '69.9', '70.0', '80.2', '80.3', '100.2', '100.3', '107.1', '150.0', '200.0']);
let r = 20260611; const rnd = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
while (weights.size < 220) weights.add(fmtW(200 + Math.floor(rnd() * 1801)));
let nStart = 0;
for (const w of weights) {
  await ev(`__t.set('#sAge','45'); __t.set('#sDate','2026-11-08'); __t.set('#sWeight','${w}'); true`);
  const got = await ev(`({ rows: __t.rows('#sDrugs'), note: document.querySelector('#sNote').textContent, line: document.querySelector('#sLine').textContent, hidden: document.querySelector('#sResult').hidden })`);
  const reg = api.regimen(45, w), plan = api.planFrom(reg, null);
  ok(!got.hidden, `${w} result hidden`);
  for (const c of api.ORDER) {
    const row = got.rows.find(x => x.code === c), x = reg.drugs[c];
    ok(row && row.dose === x.dose && row.mgkg === x.mgkg && !row.edited, `${w} ${c} dose/mgkg on screen`);
    ok(row && row.tabs === api.tabsText(c, x.tabs, 'th'), `${w} ${c} tablets text`);
    const want = x.flag ? [x.flag] : [];
    ok(row && JSON.stringify(row.flags) === JSON.stringify(want), `${w} ${c} flags ${JSON.stringify(row && row.flags)} vs ${JSON.stringify(want)}`);
    if (x.atmax) ok(row.text.includes('ขนาดสูงสุด'), `${w} ${c} shows ขนาดสูงสุด`);
  }
  ok(got.note === api.buildStartNote(plan, '2026-11-08'), `${w} note text`);
  ok(got.line === api.buildStartShort(plan, '2026-11-08'), `${w} short note text`);
  nStart++;
}

/* ---------- 2. ข้อความเมื่อคำนวณไม่ได้ ---------- */
for (const [age, w, key] of [['15', '52.0', 'อายุ 15 ปีลงมา'], ['45.5', '52.0', 'จำนวนเต็ม'], ['45', '52.25', 'ทศนิยมได้ 1'], ['45', '19.9', '20.0 ถึง 200.0'], ['45', '200.1', '20.0 ถึง 200.0']]) {
  await ev(`__t.set('#sAge','${age}'); __t.set('#sWeight','${w}'); true`);
  const g = await ev(`({ msg: document.querySelector('#sMsg').hidden ? '' : document.querySelector('#sMsg').textContent, res: document.querySelector('#sResult').hidden })`);
  ok(g.msg.includes(key) && g.res, `message for age ${age} weight ${w}: ${g.msg}`);
}

/* ---------- 3. แก้เม็ด ใช้ขนาดที่เสนอ กลับค่าตามตาราง ---------- */
await ev(`__t.set('#sAge','45'); __t.set('#sWeight','52.0'); true`);
await ev(`__t.click('#sEditToggle'); __t.click('button[data-act="plus"][data-code="H"][data-kind="start"]'); true`);
let g = await ev(`({ rows: __t.rows('#sDrugs'), note: document.querySelector('#sNote').textContent })`);
let h = g.rows.find(x => x.code === 'H');
ok(h.dose === 400 && h.edited && h.flags[0] === 'red', `H +1 tablet = 400 red ${JSON.stringify(h)}`);
ok(g.note.includes('Isoniazid 100 mg 4 tab oral วันละครั้ง = 400 mg (7.7 mg/kg) (เภสัชปรับจากตาราง)'), 'note marks edited H');
await ev(`__t.click('button[data-act="reset"][data-code="H"][data-kind="start"]'); true`);
h = (await ev(`__t.rows('#sDrugs')`)).find(x => x.code === 'H');
ok(h.dose === 300 && !h.edited && h.flags.length === 0, 'H reset to table');
await ev(`__t.set('#sWeight','80.5'); true`);
await ev(`__t.click('#sDrugs .flag button[data-code="E"]'); true`);
g = await ev(`({ rows: __t.rows('#sDrugs'), note: document.querySelector('#sNote').textContent })`);
const e = g.rows.find(x => x.code === 'E');
ok(e.dose === 1300 && e.edited && e.flags.length === 0 && e.mgkg === '16.1', `E suggestion used ${JSON.stringify(e)}`);
ok(g.note.includes('Ethambutol 400 mg 2 tab + 500 mg 1 tab oral วันละครั้ง = 1,300 mg (16.1 mg/kg) (เภสัชปรับจากตาราง)'), 'note after suggestion');
await ev(`__t.set('#sWeight','30.0'); true`);
await ev(`__t.click('#sDrugs .flag button[data-code="H"]'); true`);
h = (await ev(`__t.rows('#sDrugs')`)).find(x => x.code === 'H');
ok(h.dose === 100 && h.edited && h.flags[0] === 'blue', `30 kg H other choice 100 mg -> blue ${JSON.stringify(h)}`);
await ev(`__t.set('#sWeight','52.0'); true`);
h = (await ev(`__t.rows('#sDrugs')`)).find(x => x.code === 'H');
ok(h.dose === 300 && !h.edited, 'changing weight clears edits');
const copy = await ev(`(async () => { const b = document.querySelector('#sCopy'); b.click(); await new Promise(r => setTimeout(r, 150)); return b.textContent; })()`);
ok(/คัดลอก.*แล้ว|เลือกข้อความแล้ว/.test(copy), `copy button feedback: ${copy}`);
const toggled = await ev(`(() => { document.querySelector('button[data-note="short"][data-page="s"]').click(); return [document.querySelector('#sNote').hidden, document.querySelector('#sLine').hidden]; })()`);
ok(toggled[0] === true && toggled[1] === false, 'note toggle shows the short note');

/* ---------- 4. หน้าปรับยา ---------- */
await ev(`__t.click('#tabAdjust'); __t.set('#aAge','45'); __t.set('#aDate','2026-12-08'); true`);
const adjCases = [['48.0', '52.0', 'intensive'], ['69.0', '71.0', 'intensive'], ['69.0', '71.0', 'continuation'], ['52.0', '53.5', 'intensive'], ['34.0', '36.0', 'intensive'], ['49.9', '50.0', 'continuation'], ['80.2', '80.3', 'intensive']];
while (adjCases.length < 120) adjCases.push([fmtW(200 + Math.floor(rnd() * 1801)), fmtW(200 + Math.floor(rnd() * 1801)), rnd() < 0.5 ? 'intensive' : 'continuation']);
let nAdj = 0;
for (const [a, b, ph] of adjCases) {
  await ev(`document.querySelector('.seg button[data-phase="${ph}"]').click(); __t.set('#aOld','${a}'); __t.set('#aNew','${b}'); true`);
  const got = await ev(`({ res: document.querySelector('#aVerdict').dataset.result, rows: __t.rows('#aCompare .cmp-row', 'new'), cur: __t.rows('#aCompare .cmp-row', 'cur'), note: document.querySelector('#aNote').textContent, line: document.querySelector('#aLine').textContent })`);
  const adj = api.adjust(45, a, b, ph, null), np = api.planFrom(adj.to, null);
  ok(got.res === adj.result, `${a}->${b} ${ph} verdict ${got.res} vs ${adj.result}`);
  for (const c of api.PHASE_DRUGS[ph]) {
    ok(got.rows.find(x => x.code === c).dose === adj.new[c], `${a}->${b} ${c} new dose`);
    ok(got.cur.find(x => x.code === c).dose === adj.old[c], `${a}->${b} ${c} current dose`);
  }
  ok(got.rows.length === api.PHASE_DRUGS[ph].length, `${a}->${b} rows only phase drugs`);
  ok(got.note === api.buildAdjustNote(adj, ph, np, '2026-12-08'), `${a}->${b} ${ph} note`);
  ok(got.line === api.buildAdjustShort(adj, ph, np), `${a}->${b} ${ph} short note text`);
  nAdj++;
}
// ขนาดที่กินอยู่จริงต่างจากตาราง: 52 -> 53 ระยะต่อเนื่อง แต่กิน R 450 อยู่
await ev(`document.querySelector('.seg button[data-phase="continuation"]').click(); __t.set('#aOld','52.0'); __t.set('#aNew','53.0'); true`);
await ev(`__t.click('#aEditToggle');
  __t.click('button[data-act="plus"][data-code="R"][data-s="450"][data-kind="cur"]');
  __t.click('button[data-act="minus"][data-code="R"][data-s="300"][data-kind="cur"]');
  __t.click('button[data-act="minus"][data-code="R"][data-s="300"][data-kind="cur"]'); true`);
g = await ev(`({ res: document.querySelector('#aVerdict').dataset.result, verdict: document.querySelector('#aVerdict').textContent, cur: __t.rows('#aCompare .cmp-row', 'cur'), neu: __t.rows('#aCompare .cmp-row', 'new'), note: document.querySelector('#aNote').textContent })`);
ok(g.cur.find(x => x.code === 'R').dose === 450 && g.neu.find(x => x.code === 'R').dose === 600 && g.res === 'adjust' && g.verdict.includes('Rifampicin'), `current R 450 -> adjust ${g.verdict}`);
ok(g.note.includes('Rifampicin เดิม 450 mg เป็น 600 mg (300 mg 2 cap) oral วันละครั้ง'), 'note uses dose actually taken');

/* ---------- 5. ล้นจอ + ภาพจอ ---------- */
const widths = [300, 320, 360, 390, 414, 768, 1024, 1280];
let nLayout = 0;
for (const wpx of widths) {
  await load(wpx); await ev(H);
  for (const w of ['30.0', '52.0', '80.5', '100.5', '200.0']) {
    await ev(`__t.set('#sAge','61'); __t.set('#sDate','2026-12-31'); __t.set('#sWeight','${w}'); true`);
    if (w === '80.5') await ev(`__t.click('#sEditToggle'); true`);
    const bad = await ev('__t.overflow()');
    ok(bad.length === 0, `start ${wpx}px ${w}kg overflow: ${bad.join(' | ')}`); nLayout++;
  }
  await ev(`__t.click('#tabAdjust'); __t.set('#aAge','45'); __t.set('#aOld','48.0'); __t.set('#aNew','100.5'); __t.click('#aEditToggle'); true`);
  const bad = await ev('__t.overflow()');
  ok(bad.length === 0, `adjust ${wpx}px overflow: ${bad.join(' | ')}`); nLayout++;
}
for (const wpx of [390, 1280]) {
  await load(wpx); await ev(H);
  await ev(`__t.set('#sAge','45'); __t.set('#sDate','2026-11-08'); __t.set('#sWeight','52.0'); true`); await shot(`start-52-${wpx}.png`, wpx);
  await load(wpx); await ev(H);
  await ev(`__t.set('#sAge','45'); __t.set('#sDate','2026-11-08'); __t.set('#sWeight','80.5'); true`); await shot(`start-80.5-${wpx}.png`, wpx);
  await load(wpx); await ev(H);
  await ev(`__t.set('#sAge','45'); __t.set('#sDate','2026-11-08'); __t.set('#sWeight','30.0'); true`); await shot(`start-30-${wpx}.png`, wpx);
  await load(wpx); await ev(H);
  await ev(`__t.click('#tabAdjust'); __t.set('#aAge','45'); __t.set('#aDate','2026-12-08'); __t.set('#aOld','48.0'); __t.set('#aNew','52.0'); true`); await shot(`adjust-48-52-${wpx}.png`, wpx);
  await load(wpx); await ev(H);
  await ev(`__t.set('#sAge','15'); __t.set('#sWeight','40.0'); true`); await shot(`message-age15-${wpx}.png`, wpx);
}

ok(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));
ws.close(); chrome.kill();
console.log(JSON.stringify({ start: nStart, adjust: nAdj, layout: nLayout, widths, checks, fails: fails.length }, null, 0));
for (const f of fails.slice(0, 25)) console.log('FAIL', f);
process.exit(fails.length ? 1 : 0);
