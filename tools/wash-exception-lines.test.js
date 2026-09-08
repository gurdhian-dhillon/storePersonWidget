#!/usr/bin/env node
// ---- WASH EXCEPTION LINES ARE COLLAPSED PER PLAN, SAME AS THE PO PATH ----
//
// REGRESSION. A fabric material spread over many small orders put ONE
// Exception_Lines row per REQUIREMENT ROW on the ticket — a real case had 105
// lines on a single Wash_Needed ticket for one lot of one material. Every row
// just repeated "this order needs this fabric" with nothing summarising it;
// the ticket was unreadable and the "N orders waiting" figure derived from it
// was wrong by the same multiple the PO path was fixed for earlier
// (poLinesFor, now generalised as exceptionLinesFor and shared by both raise
// paths).
//
// submitSummaryException (the per-material wash/purchase dialog) and
// raiseAllWashRequests (the "raise all" button) both sent `e.lines` — one row
// per requirement — straight through. Neither went through the collapse the
// bulk PO screen already had. This pins that both now do.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function makeDoc() {
  const els = {};
  const mk = (id) => {
    const e = {
      id: id, _cls: {}, value: '', textContent: '', innerHTML: '',
      disabled: false, hidden: false, style: {}, checked: false,
      children: [], dataset: {},
      classList: {
        add(c) { e._cls[c] = true; }, remove(c) { delete e._cls[c]; },
        contains(c) { return !!e._cls[c]; }, toggle(c) { e._cls[c] = !e._cls[c]; }
      },
      addEventListener() {}, appendChild() {}, removeAttribute(k) { delete e['_a_' + k]; },
      setAttribute(k, v) { e['_a_' + k] = v; }, getAttribute(k) { return e['_a_' + k]; },
      scrollIntoView() {}, focus() {}, querySelector: () => mk('q'), querySelectorAll: () => []
    };
    return e;
  };
  return {
    getElementById(id) { if (!els[id]) els[id] = mk(id); return els[id]; },
    querySelector(s) { return this.getElementById('sel:' + s); },
    querySelectorAll() { return []; },
    createElement(t) { return mk('new:' + t); },
    addEventListener() {}, body: { appendChild() {} }
  };
}

function load() {
  const sb = {
    window: {}, document: makeDoc(),
    console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {}, table() {} },
    ZOHO: { CREATOR: { DATA: {} } }, alert() {}, setTimeout: (f) => f && 0,
    requestAnimationFrame: () => 0,
    JSON, Math, Number, String, Object, Array, Date, isFinite, parseFloat, parseInt
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/lot-allocator.js'), 'utf8'), sb);
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/main.js'), 'utf8'), sb); } catch (e) {}
  return sb;
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  — ' + detail); }
}

// 105 requirement rows across only 18 distinct plans — the real shape.
function build105Lines() {
  const perPlan = [8, 7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 5, 4, 4]; // sums to 105
  const lines = [];
  perPlan.forEach((rowsForThisPlan, p) => {
    for (let r = 0; r < rowsForThisPlan; r++) {
      lines.push({
        planId: 'p' + p, salesOrder: 'SO-' + p, supervisorId: 'S' + (p % 3),
        required: 10, issued: p % 2 === 0 ? 4 : 0
      });
    }
  });
  return lines;
}

console.log('\n=== exceptionLinesFor collapses many rows to one per plan ===');
{
  const S = load();
  const lines = build105Lines();
  const rowCount = lines.length;
  const distinctPlans = new Set(lines.map(l => l.planId)).size;

  const out = S.exceptionLinesFor({ lines: lines });

  ok('the source fixture reproduces the real shape', rowCount > 100,
    'rowCount=' + rowCount + ' (the real ticket had 105)');
  ok('collapsed to one line per DISTINCT plan', out.length === distinctPlans,
    'distinctPlans=' + distinctPlans + ' collapsedLines=' + out.length);
  ok('no plan is dropped', out.map(l => l.planId).sort().join(',') ===
    [...new Set(lines.map(l => l.planId))].sort().join(','), 'plan set mismatch');
  ok('no plan is duplicated', new Set(out.map(l => l.planId)).size === out.length,
    'duplicate plan rows in the collapsed output');
}

console.log('\n=== the WASH submit sends the collapsed shape, not e.lines ===');
{
  const S = load();
  const lines = build105Lines();
  const entry = { qty: 50, lot: { lotId: 'L3' } };
  const e = {
    materialId: '9', needed: 500, stock: 0, unwashed: 500, unit: 'Mtr',
    lines: lines,
    openExceptions: []
  };

  // Reproduce exactly what submitSummaryException builds, without driving the
  // DOM dialog — read the real function's payload-building logic by calling
  // the shared helper it now uses.
  const sentLines = S.exceptionLinesFor(e);

  ok('the wash payload is collapsed per plan', sentLines.length < lines.length,
    'raw=' + lines.length + ' collapsed=' + sentLines.length);
  ok('collapsed to the real distinct-plan count', sentLines.length === 18,
    'collapsed=' + sentLines.length);

  // Confirm the actual source sends exceptionLinesFor(e), not e.lines, in both
  // raise paths that touch wash tickets. Sliced from each function's own start
  // to the START OF THE NEXT top-level function — a fixed-length window would
  // silently stop checking the real code the moment either function grows past
  // it and start passing for the wrong reason.
  const src = fs.readFileSync(path.join(ROOT, 'app/js/main.js'), 'utf8');
  const fnBody = (name) => {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) return null;
    const next = src.indexOf('\nfunction ', start + 1);
    return src.slice(start, next > 0 ? next : undefined);
  };

  const summaryFn = fnBody('submitSummaryException');
  const allFn = fnBody('raiseAllWashRequests');

  ok('submitSummaryException is still where this test expects it', !!summaryFn, 'not found — update this test');
  ok('raiseAllWashRequests is still where this test expects it', !!allFn, 'not found — update this test');
  if (summaryFn) {
    ok('submitSummaryException sends the collapsed lines',
      /lines:\s*exceptionLinesFor\(e\)/.test(summaryFn),
      'still sending e.lines directly would put one row per requirement on the ticket');
    ok('submitSummaryException no longer sends raw e.lines as the payload',
      !/lines:\s*e\.lines(\s*\|\|\s*\[\])?\s*$/m.test(summaryFn.replace(/,\s*$/, '')),
      'a raw e.lines send would reintroduce the 105-row ticket');
  }
  if (allFn) {
    ok('raiseAllWashRequests sends the collapsed lines',
      /lines:\s*exceptionLinesFor\(e\)/.test(allFn),
      'the "raise all" button must not regress independently of the per-row dialog');
  }
  ok('the bulk PO path still uses the same shared helper',
    /lines:\s*exceptionLinesFor\(item\.e\)/.test(src),
    'wash and purchase must not diverge onto two different collapse rules');
}

console.log('\n=== a plan with several cut sizes still sums correctly ===');
{
  const S = load();
  const lines = [
    { planId: 'p1', salesOrder: 'SO-1', supervisorId: 'S1', required: 10, issued: 2 },
    { planId: 'p1', salesOrder: 'SO-1', supervisorId: 'S1', required: 5, issued: 0 },
    { planId: 'p1', salesOrder: 'SO-1', supervisorId: 'S1', required: 8, issued: 8 },
    { planId: 'p2', salesOrder: 'SO-2', supervisorId: 'S2', required: 20, issued: 20 }
  ];
  const out = S.exceptionLinesFor({ lines: lines });
  const p1 = out.filter(l => l.planId === 'p1')[0];
  ok('one line for p1', out.filter(l => l.planId === 'p1').length === 1, '');
  ok('required summed across p1\'s rows', p1.required === 23, 'required=' + p1.required);
  ok('issued summed across p1\'s rows', p1.issued === 10, 'issued=' + p1.issued);
  ok('a plan needing nothing more still appears (it named the demand)',
    out.some(l => l.planId === 'p2'), 'p2 missing');
}

console.log('\n========================================');
console.log('wash-exception-lines: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
