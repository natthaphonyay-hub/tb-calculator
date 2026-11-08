// Runs the engine inside index.html (DATA + CALC blocks) on a list of scenarios and prints JSON.
// usage: node tests/run-engine.mjs <scenarios.json>
// scenario kinds: {kind:'regimen', age, weight} | {kind:'adjust', age, old, new, phase, current?} | {kind:'dates', start}
//                 {kind:'notes', age, weight, start, edits?} -> checks note text is ASCII + Thai and has no undefined/NaN
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export function loadEngine() {
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  const block = (a, b) => {
    const i = html.indexOf(a), j = html.indexOf(b);
    if (i < 0 || j < 0) throw new Error(`missing block ${a}`);
    return html.slice(i, j);
  };
  return new Function(`${block('// DATA-START', '// DATA-END')}\n${block('// CALC-START', '// CALC-END')}
return { regimen, adjust, dates, planFrom, editFlag, buildStartNote, buildStartShort, buildAdjustNote, buildAdjustShort,
  parseWeight, parseAge, mgkg10, fmt10, num, tabsText, tabsMap, tabsFromCounts, chooseCalc, rowOf, monthEnd, addMonths, parseISO,
  thDate, thShort, DRUGS, ROWS, ORDER, PHASE_DRUGS, COMBOS, EDIT_MARK };`)();
}

const SAFE = /^[\t\n\x20-\x7E฀-๿]*$/;
const BAD = /undefined|NaN|Infinity|null|\[object/;

export function runScenario(api, p) {
  if (p.kind === 'regimen') {
    const r = api.regimen(p.age, p.weight);
    if (!r.ok) return r;
    return { ok: true, method: r.method, drugs: r.drugs };
  }
  if (p.kind === 'adjust') {
    const r = api.adjust(p.age, p.old, p.new, p.phase, p.current || null);
    if (!r.ok) return r;
    return { ok: true, result: r.result, changed: r.changed, old: r.old, new: r.new };
  }
  if (p.kind === 'dates') {
    const d = api.dates(p.start);
    return { end_intensive: d.end_intensive, start_continuation: d.start_continuation, end_treatment: d.end_treatment,
      days_intensive: d.days_intensive, days_continuation: d.days_continuation, month_end: d.month_end };
  }
  if (p.kind === 'notes') {
    const reg = api.regimen(p.age, p.weight);
    if (!reg.ok) return { ok: false, reason: reg.reason };
    const plan = api.planFrom(reg, p.edits || null);
    const texts = [api.buildStartNote(plan, p.start), api.buildStartShort(plan, p.start)];
    if (p.old) {
      const adj = api.adjust(p.age, p.old, p.weight, p.phase, p.current || null);
      if (!adj.ok) return { ok: false, reason: adj.reason };
      const np = api.planFrom(adj.to, p.edits || null);
      texts.push(api.buildAdjustNote(adj, p.phase, np, p.start), api.buildAdjustShort(adj, p.phase, np));
    }
    return { ok: true, safe: texts.every(t => SAFE.test(t)), bad: texts.some(t => BAD.test(t)), n: texts.length };
  }
  throw new Error('unknown kind ' + p.kind);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const api = loadEngine();
  const list = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(list.map(p => runScenario(api, p))));
}
