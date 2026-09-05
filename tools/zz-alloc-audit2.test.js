'use strict';
// Audit harness part 2 for app/js/lot-allocator.js — edge probes.
//   usage: node tools/zz-alloc-audit2.test.js
// Covers: roll Blocked status, nofit need vs waste, stale override,
// metre-edit volatility, waste-only lots, multi-cut drain order.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const ctx = { console, Math, Number, Object, String, Array, JSON };
vm.createContext(ctx);
vm.runInContext(src + `
this.A = { round2, remnantYield, perRowFor, lotFill, chooseLotForOrder, orderMetres,
  applyLotAllocation, applyFabricOverride, shortReasonFor,
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
function W(wasteId, w, l, pcs, lotId) {
  return { wasteId, width: w, length: l, pieces: pcs, lotId: lotId || '', lot: lotId || '', carton: 'C-1' };
}
function LN(id, req, iss, planId, cutW, cutL, extra) {
  return Object.assign({ planId: planId || 'P1', planItemId: id, reqPieces: req, issPieces: iss || 0,
    cutW: cutW || 55, cutL: cutL || 55, mrqId: 'MRQ-' + id, issuedLot: '', issuedLotNo: '' }, extra || {});
}
function M(mid, o) {
  return Object.assign({ materialId: mid, isFabric: true, sku: 'FAB', unit: 'Mtr', fabricWidthCm: 150,
    cutWidth: 55, cutLength: 55, freshMeters: 0, remaining: 0, availableStock: 0,
    lines: [], wasteStock: [], lots: [], cuts: [] }, o || {});
}
function S(sid, mats) { return { supervisorId: sid, supervisorName: sid, materials: mats }; }

console.log('\n=== AUDIT I: roll Blocked status ===');
ok('I1 BUG: roll with status Blocked is STILL allocated', () => {
  // BUG 5 in audit report. lotFill / allocateMaterial / seeding only exclude
  // 'Consumed'; a 'Blocked' roll is treated as usable.
  const fab = { fabricWidthCm: 150 };
  const lot = { wash: 10, unwash: 0, inWash: 0, blocked: false,
    rolls: [{ rollId: 'R1', label: 'L-R1', length: 10, status: 'Blocked' }], waste: [] };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 100, pieces: 4 }], fab, false);
  console.log('      Blocked-roll fill covers=' + f.covers + ' fresh=' + f.freshMetres);
  assert.strictEqual(f.covers, true, 'proves Blocked rolls treated as usable');
});

console.log('\n=== AUDIT J: nofit need vs waste ===');
ok('J1 skipped order withholds waste too (atom rule, documents need figure)', () => {
  const l1 = L('L1', { rolls: [{ length: 1 }], wash: 1 });
  const w2 = W('W2', 110, 100, 1, 'L1'); // yields 2 pcs of 55x100
  const ln = LN('A', 20, 0, 'P1', 55, 100);
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1], wasteStock: [w2] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      outcomes=' + JSON.stringify(out.orderOutcomes) + ' reason=' + JSON.stringify(out.shortReason) + ' remaining=' + out.remaining);
});

console.log('\n=== AUDIT K: stale override lot ===');
ok('K1 override pointing at non-existent lot safely ignored (stays dry)', () => {
  const l1 = L('L1', { rolls: [{ length: 50 }], wash: 50 });
  const ln = LN('A', 10, 2, 'P1', 55, 55, { issuedLot: 'L9', issuedLotNo: 'L9-GONE' });
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1] });
  A._setOverride('S1|M1|P1', { lotId: 'LZZZ', note: 'stale' });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      lotLines=' + out.lotLines.length + ' reason=' + JSON.stringify(out.shortReason) + ' pinnedDry=' + out.pinnedDry);
});

console.log('\n=== AUDIT L: metre-edit volatility ===');
ok('L1 BUG: metre edit wiped by re-allocation', () => {
  // BUG 4 in audit report. A hand-typed edit is discarded the next time the
  // allocation re-runs (waste change / reorder / full render) with no notice.
  const l1 = L('L1', { rolls: [{ length: 20 }], wash: 20 });
  const w = W('W1', 200, 200, 2, 'L1');
  const ln = LN('A', 20, 0, 'P1', 55, 100);
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1], wasteStock: [w] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  const auto = out.autoMetres;
  A.applyFabricOverride(out, 'L1', auto - 1);
  const edited = out.lotLines.reduce((s, l) => s + l.qty, 0);
  console.log('      auto=' + auto + ' edited=' + edited + ' metresEdited=' + out.metresEdited);
  A._setDeclined('W1', 0);
  A.applyLotAllocation(data);
  const out2 = data[0].materials[0];
  console.log('      after realloc lotTotal=' + out2.lotLines.reduce((s, l) => s + l.qty, 0) + ' metresEdited=' + out2.metresEdited + ' (edit lost)');
});

console.log('\n=== AUDIT M: waste-only lot (no rolls) ===');
ok('M1 lot with no rolls but covering waste serves order with no lotLines', () => {
  const l1 = { lotId: 'L1', lotNumber: 'L1', blocked: false, wash: 0, unwash: 0, inWash: 0, form: 'Roll', pieces: [], rolls: [] };
  const w = W('W1', 300, 300, 2, 'L1');
  const ln = LN('A', 4, 0, 'P1', 55, 55);
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1], wasteStock: [w] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      picks=' + JSON.stringify(out.wastePicks) + ' lotLines=' + out.lotLines.length + ' remaining=' + out.remaining + ' reason=' + JSON.stringify(out.shortReason));
  assert.strictEqual(out.remaining, 0);
});

console.log('\n=== AUDIT N: demand order within lot ===');
ok('N1 two cuts drain shortest roll in demand order (order-dependence documented)', () => {
  const fab = { fabricWidthCm: 150 };
  const mkLot = () => ({ wash: 15, unwash: 0, inWash: 0, blocked: false,
    rolls: [{ rollId: 'R1', label: 'R-S', length: 5, status: 'Available' },
            { rollId: 'R2', label: 'R-L', length: 10, status: 'Available' }], waste: [] });
  const fwd = A.lotFill(mkLot(), [{ cutW: 55, cutL: 400, pieces: 2 }, { cutW: 55, cutL: 100, pieces: 2 }], fab, false);
  const rev = A.lotFill(mkLot(), [{ cutW: 55, cutL: 100, pieces: 2 }, { cutW: 55, cutL: 400, pieces: 2 }], fab, false);
  console.log('      fwd=' + JSON.stringify(fwd.rollLinesPer) + ' rev=' + JSON.stringify(rev.rollLinesPer));
  assert.strictEqual(fwd.covers, true);
  assert.strictEqual(rev.covers, true);
});

console.log('\n========================================');
console.log('AUDIT2 DONE: ' + PASS + ' passed, ' + FAIL + ' failed');
if (FAIL) process.exit(1);
