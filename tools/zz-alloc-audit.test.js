'use strict';
// Audit harness for app/js/lot-allocator.js — reproduces the bugs in the audit report.
// Loads the REAL allocator via vm (read-only, never edits it) and simulates scenarios.
//   usage: node tools/zz-alloc-audit.test.js
// Covers: rolls continuity, waste lot-scoping, pin/dry/override, atom/greige,
// cross-card reservation, write-back, metre override.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const ctx = { console, Math, Number, Object, String, Array, JSON };
vm.createContext(ctx);
vm.runInContext(src + `
this.A = { round2, remnantYield, perRowFor, lotFill, chooseLotForOrder, orderMetres,
  applyLotAllocation, applyFabricOverride, shortReasonFor, hasOwnStock, plainBaseStock,
  lotsFor, usableLots,
  _clearAll: function(){ for (var k in lotOverrides) delete lotOverrides[k]; for (var k2 in wasteDeclined) delete wasteDeclined[k2]; },
  _setOverride: function(k,v){ lotOverrides[k]=v; },
  _setDeclined: function(k,v){ wasteDeclined[k]=v; }
};`, ctx);
const A = ctx.A;
let PASS = 0, FAIL = 0;
function ok(name, fn) {
  A._clearAll();
  try { fn(); PASS++; console.log('  ok  ' + name); }
  catch (e) { FAIL++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
}
function approx(a, b, eps) {
  eps = eps === undefined ? 1e-6 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + ' got ' + a);
}
function L(lotId, o) {
  o = o || {};
  const rolls = (o.rolls || []).map((r, i) => ({
    rollId: r.rollId || (lotId + '-R' + (i + 1)),
    label: r.label || (lotId + '-R' + (i + 1)),
    length: Number(r.length !== undefined ? r.length : r) || 0,
    status: r.status || 'Available', origin: r.origin || 'Purchased'
  }));
  const tot = rolls.filter(r => r.status === 'Available').reduce((s, r) => s + r.length, 0);
  return { lotId, lotNumber: o.no || lotId, blocked: !!o.blocked,
    wash: o.wash !== undefined ? o.wash : Math.round(tot * 100) / 100,
    unwash: o.unwash || 0, inWash: o.inWash || 0, form: 'Roll', pieces: [], rolls };
}
function W(wasteId, w, l, pcs, lotId, extra) {
  return Object.assign({ wasteId, width: w, length: l, pieces: pcs, lotId: lotId || '', lot: lotId || '', carton: 'C-1' }, extra || {});
}
function LN(planItemId, req, iss, planId, cutW, cutL, extra) {
  return Object.assign({ planId: planId || 'P1', planItemId, reqPieces: req, issPieces: iss || 0,
    cutW: cutW || 55, cutL: cutL || 55, mrqId: 'MRQ-' + planItemId, issuedLot: '', issuedLotNo: '' }, extra || {});
}
function M(mid, o) {
  return Object.assign({ materialId: mid, isFabric: true, sku: 'FAB', unit: 'Mtr',
    fabricWidthCm: 150, cutWidth: 55, cutLength: 55, requiredPieces: 0, issuedPieces: 0,
    freshMeters: 0, remaining: 0, availableStock: 0, lines: [], wasteStock: [], lots: [], cuts: [] }, o || {});
}
function S(sid, mats, name) { return { supervisorId: sid, supervisorName: name || sid, materials: mats }; }

console.log('\n=== AUDIT A: rolls continuity ===');
ok('A1 8+2 split cannot cut 10m marker', () => {
  const fab = { fabricWidthCm: 150 };
  const lot = { wash: 10, unwash: 0, inWash: 0, blocked: false,
    rolls: [{ rollId: 'R1', label: 'L-R1', length: 8, status: 'Available' },
            { rollId: 'R2', label: 'L-R2', length: 2, status: 'Available' }], waste: [] };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 1000, pieces: 2 }], fab, false);
  assert.strictEqual(f.covers, false, 'MUST NOT cover');
  approx(f.freshMetres, 0);
  assert.strictEqual(f.shortBy, 2);
});
ok('A2 750+8: 10m marker off the 750 roll', () => {
  const fab = { fabricWidthCm: 150 };
  const lot = { wash: 758, unwash: 0, inWash: 0, blocked: false,
    rolls: [{ rollId: 'R1', label: 'L-R1', length: 750, status: 'Available' },
            { rollId: 'R2', label: 'L-R2', length: 8, status: 'Available' }], waste: [] };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 1000, pieces: 2 }], fab, false);
  assert.strictEqual(f.covers, true);
  approx(f.freshMetres, 10);
  assert.strictEqual(f.rollLinesPer[0][0].label, 'L-R1');
});
ok('A3 shortest-first drain', () => {
  const fab = { fabricWidthCm: 150 };
  const lot = { wash: 17, unwash: 0, inWash: 0, blocked: false,
    rolls: [{ rollId: 'R1', label: 'L-R1', length: 12, status: 'Available' },
            { rollId: 'R2', label: 'L-R2', length: 5, status: 'Available' }], waste: [] };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 100, pieces: 8 }], fab, false);
  assert.strictEqual(f.covers, true);
  approx(f.freshMetres, 4);
  assert.strictEqual(f.rollLinesPer[0][0].label, 'L-R2');
});

console.log('\n=== AUDIT B: waste lot-scoping ===');
ok('B1 waste on L2 does NOT serve L1-pinned order', () => {
  const l1 = L('L1', { rolls: [{ length: 10 }], wash: 10 });
  const l2 = L('L2', { rolls: [{ length: 10 }], wash: 10 });
  const w = W('W9', 200, 200, 5, 'L2');
  const ln = LN('IT1', 4, 0, 'P1', 55, 55, { issuedLot: 'L1', issuedLotNo: 'L1' });
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1, l2], wasteStock: [w] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  assert.strictEqual(out.wastePicks.length, 0, 'L2 waste must not serve L1 pin, got ' + JSON.stringify(out.wastePicks));
  assert.strictEqual(out.lotLines[0].lotId, 'L1');
});
ok('B2 unlotted waste NEVER offered (invisible stock)', () => {
  const l1 = L('L1', { rolls: [{ length: 10 }], wash: 10 });
  const w = W('WU', 200, 200, 5, '');
  w.lot = ''; w.lotId = '';
  const ln = LN('IT1', 4, 0, 'P1', 55, 55);
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1], wasteStock: [w] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      offered=' + out.wastePicks.some(p => String(p.wasteId) === 'WU') + ' freshMeters=' + out.freshMeters);
  assert.strictEqual(out.wastePicks.some(p => String(p.wasteId) === 'WU'), false);
});
ok('B3 narrow remnant yields 0', () => {
  assert.strictEqual(A.remnantYield({ width: 50, length: 500 }, 55, 55), 0);
  assert.strictEqual(A.remnantYield({ width: 110, length: 110 }, 55, 55), 4);
});

console.log('\n=== AUDIT C: pin/dry/override ===');
ok('C1 remake follows SETTLED original pin', () => {
  const l1 = L('L1', { rolls: [{ length: 50 }], wash: 50 });
  const l2 = L('L2', { rolls: [{ length: 50 }], wash: 5 });
  const settled = LN('IT-ORIG', 100, 100, 'P1', 55, 55, { issuedLot: 'L1', issuedLotNo: 'L1' });
  const remake = LN('IT-RE', 4, 0, 'P1', 55, 55);
  const m = M('M1', { fabricWidthCm: 150, lines: [settled, remake], lots: [l1, l2] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  assert.ok(out.lotLines.length > 0);
  out.lotLines.forEach(ln => assert.strictEqual(ln.lotId, 'L1'));
});
ok('C2 dry pin allocates NOTHING + names lot', () => {
  const l2 = L('L2', { rolls: [{ length: 50 }], wash: 50 });
  const ln = LN('IT1', 10, 2, 'P1', 55, 55, { issuedLot: 'L9', issuedLotNo: 'L9-GONE' });
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l2] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  assert.strictEqual(out.lotLines.length, 0);
  assert.ok((out.pinnedDry || '').indexOf('L9-GONE') > -1);
  assert.ok(out.shortReason && out.shortReason.kind === 'pinnedDry');
});
ok('C3 override rescues dry pin', () => {
  const mk = () => M('M1', { fabricWidthCm: 150, lines: [LN('IT1', 10, 2, 'P1', 55, 55, { issuedLot: 'L9', issuedLotNo: 'L9-GONE' })], lots: [L('L2', { rolls: [{ length: 50 }], wash: 50 })] });
  const d1 = [S('S1', [mk()])];
  A.applyLotAllocation(d1);
  assert.strictEqual(d1[0].materials[0].lotLines.length, 0);
  A._setOverride('S1|M1|P1', { lotId: 'L2', note: 'checked shade ok' });
  const d2 = [S('S1', [mk()])];
  A.applyLotAllocation(d2);
  assert.strictEqual(d2[0].materials[0].lotLines[0].lotId, 'L2');
});
ok('C4 BUG: override to BLOCKED lot honoured (quarantined cloth issued)', () => {
  // BUG 1 in audit report. Currently PASSES (= bug present): blocked lot LB is allocated.
  // After the fix this test must be flipped to expect 0 lotLines + a blocked reason.
  const lb = L('LB', { rolls: [{ length: 50 }], wash: 50, blocked: true });
  const ln = LN('IT1', 10, 2, 'P1', 55, 55, { issuedLot: 'L9', issuedLotNo: 'L9-GONE' });
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [lb] });
  A._setOverride('S1|M1|P1', { lotId: 'LB', note: 'x' });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      lotLines=' + JSON.stringify(out.lotLines.map(l => l.lotId)) + ' reason=' + JSON.stringify(out.shortReason));
  assert.strictEqual(out.lotLines.length > 0 && out.lotLines[0].lotId, 'LB');
});
ok('C5 pinned PARTIAL short: reason is misleading empty', () => {
  // BUG 2 in audit report. Pinned L1 gives 1 of 10m; other lots full but unusable.
  // Currently reason.kind === 'empty' ("rack simply empty") — should be a pinned-short reason.
  const l1 = L('L1', { rolls: [{ length: 1 }], wash: 1 });
  const l2 = L('L2', { rolls: [{ length: 50 }], wash: 50 });
  const ln = LN('IT1', 20, 0, 'P1', 55, 100, { issuedLot: 'L1', issuedLotNo: 'L1' });
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1, l2] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      lotLines=' + JSON.stringify(out.lotLines) + ' remaining=' + out.remaining + ' reason=' + JSON.stringify(out.shortReason));
  assert.strictEqual(out.lotLines[0].lotId, 'L1');
  approx(out.lotLines.reduce((s, l) => s + l.qty, 0), 1);
});

console.log('\n=== AUDIT D: atom/greige ===');
ok('D1 oversize order SKIPPED, next served', () => {
  const l1 = L('L1', { rolls: [{ length: 5 }], wash: 5 });
  const big = LN('BIG', 40, 0, 'PBIG', 55, 100);
  const small = LN('SML', 4, 0, 'PSML', 55, 100);
  const m = M('M1', { fabricWidthCm: 150, lines: [big, small], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  assert.strictEqual(out.orderOutcomes.find(o => o.planId === 'PBIG').why, 'skipped');
  assert.ok(out.lotLines.some(l => l.planId === 'PSML'));
  assert.ok(!out.lotLines.some(l => l.planId === 'PBIG'));
});
ok('D2 afterWash COMMIT emits nothing, raises wash', () => {
  const l1 = L('L1', { rolls: [{ length: 25 }], wash: 1, unwash: 20 });
  const ln = LN('IT1', 20, 0, 'P1', 55, 100);
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  const o = out.orderOutcomes.find(x => x.planId === 'P1');
  console.log('      why=' + o.why + ' greige=' + o.greige + ' lotLines=' + out.lotLines.length + ' remaining=' + out.remaining);
  assert.strictEqual(o.why, 'afterWash');
  assert.strictEqual(out.lotLines.length, 0);
  assert.ok(o.greige > 0 && out.washLots.length > 0);
});
ok('D3 spent greige not promised twice', () => {
  const l1 = L('L1', { rolls: [{ length: 30 }], wash: 1, unwash: 12 });
  const a = LN('A', 20, 0, 'PA', 55, 100);
  const b = LN('B', 20, 0, 'PB', 55, 100);
  const m = M('M1', { fabricWidthCm: 150, lines: [a, b], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      PA:' + out.orderOutcomes.find(x => x.planId === 'PA').why + ' PB:' + out.orderOutcomes.find(x => x.planId === 'PB').why);
  assert.strictEqual(out.orderOutcomes.find(x => x.planId === 'PA').why, 'afterWash');
  assert.strictEqual(out.orderOutcomes.find(x => x.planId === 'PB').why, 'skipped');
});
ok('D4 committed order locks waste (documents atom behaviour)', () => {
  const l1 = L('L1', { rolls: [{ length: 25 }], wash: 0, unwash: 20 });
  const w = W('W1', 200, 200, 2, 'L1');
  const a = LN('A', 20, 0, 'PA', 55, 100);
  const b = LN('B', 4, 0, 'PB', 55, 55);
  const m = M('M1', { fabricWidthCm: 150, lines: [a, b], lots: [l1], wasteStock: [w] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      PA:' + out.orderOutcomes.find(x => x.planId === 'PA').why + ' PB:' + out.orderOutcomes.find(x => x.planId === 'PB').why + ' picks=' + JSON.stringify(out.wastePicks));
});

console.log('\n=== AUDIT E: reservation ===');
ok('E1 contested roll: S1 served, S2 short', () => {
  const mkLot = () => L('L1', { rolls: [{ length: 6 }], wash: 6 });
  const m1 = M('M1', { fabricWidthCm: 150, lines: [LN('A', 8, 0, 'PA', 55, 100)], lots: [mkLot()] });
  const m2 = M('M1', { fabricWidthCm: 150, lines: [LN('B', 8, 0, 'PB', 55, 100)], lots: [mkLot()] });
  const data = [S('S1', [m1]), S('S2', [m2])];
  A.applyLotAllocation(data);
  console.log('      S1=' + data[0].materials[0].lotLines.length + ' S2=' + data[1].materials[0].lotLines.length + ' S2reason=' + JSON.stringify(data[1].materials[0].shortReason));
  assert.strictEqual(data[0].materials[0].lotLines.length, 1);
  assert.strictEqual(data[1].materials[0].lotLines.length, 0);
});
ok('E2 contested remnant: first takes it', () => {
  const mk = () => L('L1', { rolls: [{ length: 1 }], wash: 1 });
  const w = () => W('WS', 200, 200, 1, 'L1');
  const m1 = M('M1', { fabricWidthCm: 150, lines: [LN('A', 4, 0, 'PA', 55, 55)], lots: [mk()], wasteStock: [w()] });
  const m2 = M('M1', { fabricWidthCm: 150, lines: [LN('B', 4, 0, 'PB', 55, 55)], lots: [mk()], wasteStock: [w()] });
  const data = [S('S1', [m1]), S('S2', [m2])];
  A.applyLotAllocation(data);
  console.log('      S1 picks=' + JSON.stringify(data[0].materials[0].wastePicks) + ' S2 picks=' + JSON.stringify(data[1].materials[0].wastePicks));
});

console.log('\n=== AUDIT F: write-back ===');
ok('F1 multi-cut need=per-cut rows', () => {
  const l1 = L('L1', { rolls: [{ length: 20 }, { length: 20 }], wash: 40 });
  const a = LN('A', 3, 0, 'P1', 55, 100);
  const b = LN('B', 3, 0, 'P1', 75, 200);
  const m = M('M1', { fabricWidthCm: 150, lines: [a, b], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      freshMeters=' + out.freshMeters + ' remaining=' + out.remaining);
  approx(out.freshMeters, 6);
});
ok('F2 waste-complete row: 0 fresh, 0 remaining', () => {
  const l1 = L('L1', { rolls: [{ length: 20 }], wash: 20 });
  const w = W('W1', 300, 300, 3, 'L1');
  const ln = LN('A', 4, 0, 'P1', 55, 55);
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1], wasteStock: [w] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      freshPieces=' + out.freshPieces + ' covered=' + out.piecesCoveredByWaste + ' remaining=' + out.remaining);
  assert.strictEqual(out.freshPieces, 0);
  assert.strictEqual(out.lotLines.length, 0);
  approx(out.remaining, 0);
});

console.log('\n=== AUDIT G: override metres ===');
ok('G1 edit DOWN halves total', () => {
  const l1 = L('L1', { rolls: [{ label: 'L1-R1', rollId: 'R1', length: 20 }, { label: 'L1-R2', rollId: 'R2', length: 20 }], wash: 40 });
  const ln = LN('A', 20, 0, 'P1', 55, 100);
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  const auto = out.autoMetres;
  A.applyFabricOverride(out, 'L1', auto / 2);
  const tot = out.lotLines.filter(l => l.lotId === 'L1').reduce((s, l) => s + l.qty, 0);
  approx(tot, auto / 2, 0.02);
});
ok('G2 BUG: edit UP over cap silently drops excess (box 50, payload 5)', () => {
  // BUG 3 in audit report. Ask 50m with an 11m cap: payload carries ~5m,
  // the UI box keeps 50. Must clamp the box or warn.
  const l1 = L('L1', { rolls: [{ label: 'L1-R1', rollId: 'R1', length: 5 }, { label: 'L1-R2', rollId: 'R2', length: 6 }], wash: 11 });
  const ln = LN('A', 8, 0, 'P1', 55, 100);
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  A.applyFabricOverride(out, 'L1', 50);
  const tot = out.lotLines.filter(l => l.lotId === 'L1').reduce((s, l) => s + l.qty, 0);
  console.log('      asked 50 -> got ' + tot);
  assert.ok(tot < 50 && tot <= 11 + 1e-6);
});

console.log('\n=== AUDIT H: misc ===');
ok('H1 one order two cuts -> one lot', () => {
  const l1 = L('L1', { rolls: [{ length: 30 }], wash: 30 });
  const a = LN('A', 4, 0, 'P1', 55, 100);
  const b = LN('B', 4, 0, 'P1', 75, 200);
  const m = M('M1', { fabricWidthCm: 150, lines: [a, b], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const lots = [...new Set(data[0].materials[0].lotLines.map(l => l.lotId))];
  assert.strictEqual(lots.length, 1);
});
console.log('\n========================================');
console.log('AUDIT DONE: ' + PASS + ' passed, ' + FAIL + ' failed');
if (FAIL) process.exit(1);
