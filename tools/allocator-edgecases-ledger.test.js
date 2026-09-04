#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
    console.log('FAIL  ' + name + '\n      ' + e.message);
  }
}
function approx(a, b, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + '+/-' + eps + ', got ' + a);
}

// ---- load the allocator under test ---------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const ctx = { console, Math, Number, Object, String, Array, JSON };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.A = { round2, remnantYield, perRowFor, lotFill, chooseLotForOrder, orderMetres,\n  applyLotAllocation,\n  applyFabricOverride, shortReasonFor,\n  setOverride: function (k, v) { lotOverrides[k] = v; },\n  clearOverrides: function () { for (var k in lotOverrides) delete lotOverrides[k]; },\n  setDeclined: function (k, v) { wasteDeclined[k] = v; },\n  clearDeclined: function () { for (var k in wasteDeclined) delete wasteDeclined[k]; } };', ctx);
const A = ctx.A;

// ---- helpers and fixtures ------------------------------------------------------
function line(planItemId, reqPcs, issPcs, planId, cutW, cutL) {
  return { planId: planId || 'PLAN1', planItemId, reqPieces: reqPcs, issPieces: issPcs || 0,
           cutW: cutW || 55, cutL: cutL || 55, issuedLot: '', issuedLotNo: '', item: 'X', isRemake: false };
}
function rollLot(lotId, rollsList, opts) {
  opts = opts || {};
  const rolls = rollsList.map((r, i) => ({
    rollId: r.rollId || (opts.no || lotId) + '-R' + (i + 1),
    label: r.label || (opts.no || lotId) + '-R' + (i + 1),
    length: Number(r.length !== undefined ? r.length : r) || 0,
    status: r.status || 'Available',
    origin: r.origin || 'Purchased'
  }));
  const totalMetres = Math.round(rolls.reduce((sum, r) => sum + (r.status === 'Available' ? r.length : 0), 0) * 100) / 100;
  return {
    lotId, lotNumber: opts.no || lotId, blocked: !!opts.blocked,
    wash: opts.wash !== undefined ? opts.wash : totalMetres,
    unwash: opts.unwash || 0, inWash: opts.inWash || 0,
    form: 'Roll', pieces: [],
    rolls: rolls
  };
}
function material(materialId, m) {
  return Object.assign({
    materialId, isFabric: true, sku: 'FAB', unit: 'Mtr',
    fabricWidthCm: 137.16, cutWidth: 55, cutLength: 55,
    requiredPieces: 0, issuedPieces: 0, outstandingPieces: 0,
    freshMeters: 0, remaining: 0, availableStock: 0,
    lines: [], wasteStock: [], lots: [], openExceptions: [],
  }, m);
}
function sup(supervisorId, mats) { return { supervisorId, supervisorName: 'S', materials: mats }; }

// =====================================================================
console.log('\nPART C - edge cases ledger (10 cases)');

test('1 Cross-lot same rollId: L1 R1 drain isolated from L2 R1', () => {
  const lotL1 = rollLot('L1', [{ rollId: 'R1', label: 'L1-R1', length: 10 }], { wash: 10 });
  const lotL2 = rollLot('L2', [{ rollId: 'R1', label: 'L2-R1', length: 10 }], { wash: 10 });
  const lnA = line('IT1', 10, 0, 'PLAN_A', 55, 50);
  lnA.issuedLot = 'L1'; lnA.issuedLotNo = 'L1';
  const lnB = line('IT2', 16, 0, 'PLAN_B', 55, 50);
  lnB.issuedLot = 'L2'; lnB.issuedLotNo = 'L2';
  const m = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 50,
    lines: [lnA, lnB],
    lots: [lotL1, lotL2]
  });
  const data = [sup('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  const oa = out.orderOutcomes.find(function (o) { return o.planId === 'PLAN_A'; });
  const ob = out.orderOutcomes.find(function (o) { return o.planId === 'PLAN_B'; });
  assert.ok(oa, 'PLAN_A outcome exists');
  assert.ok(ob, 'PLAN_B outcome exists');
  assert.strictEqual(oa.why, 'pinned');
  assert.strictEqual(ob.why, 'pinned');
  approx(oa.metres, 5);
  approx(ob.metres, 8);
  assert.strictEqual(out.lotLines.length, 2);
  const la = out.lotLines.find(function (l) { return l.planId === 'PLAN_A'; });
  const lb = out.lotLines.find(function (l) { return l.planId === 'PLAN_B'; });
  assert.ok(la); assert.ok(lb);
  assert.strictEqual(la.lotId, 'L1');
  assert.strictEqual(lb.lotId, 'L2');
  approx(la.qty, 5);
  approx(lb.qty, 8);
  assert.strictEqual(la.rolls.length, 1);
  assert.strictEqual(lb.rolls.length, 1);
  assert.strictEqual(la.rolls[0].rollId, 'R1');
  assert.strictEqual(lb.rolls[0].rollId, 'R1');
  approx(la.rolls[0].metres, 5);
  approx(lb.rolls[0].metres, 8);
});

test('2 Consumed roll not seeded: only R2 10m offered not 20m', () => {
  const lot = {
    lotId: 'L1', lotNumber: 'L1', blocked: false,
    wash: 20, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
    rolls: [
      { rollId: 'R1', label: 'R1', length: 10, status: 'Consumed' },
      { rollId: 'R2', label: 'R2', length: 10, status: 'Available' }
    ],
    waste: []
  };
  const fab = { fabricWidthCm: 55 };
  const f30 = A.lotFill(lot, [{ cutW: 55, cutL: 50, pieces: 30 }], fab, false);
  approx(f30.freshMetres, 10);
  assert.strictEqual(f30.covers, false, '30 pcs needs 15m but only R2 10m available');
  const f20 = A.lotFill(lot, [{ cutW: 55, cutL: 50, pieces: 20 }], fab, false);
  approx(f20.freshMetres, 10);
  assert.strictEqual(f20.covers, true);

  const lot2 = rollLot('L1', [{ rollId: 'R1', length: 10, status: 'Consumed' }, { rollId: 'R2', length: 10, status: 'Available' }], { wash: 20 });
  const ln = line('IT1', 30, 0, 'PLAN1', 55, 50);
  const mat = material('M1', { fabricWidthCm: 55, cutWidth: 55, cutLength: 50, lines: [ln], lots: [lot2] });
  const data = [sup('S1', [mat])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  assert.strictEqual(out.lotLines.length, 0, 'consumed roll must not contribute, 30 pcs over 10m should not allocate');
  const oc = out.orderOutcomes.find(function (o) { return o.planId === 'PLAN1'; });
  assert.ok(oc);
  assert.strictEqual(oc.why, 'skipped');
});

test('3 Zero-length roll not seeded: only 10m available', () => {
  const lot = {
    lotId: 'L1', lotNumber: 'L1', blocked: false,
    wash: 10, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
    rolls: [
      { rollId: 'R0', label: 'R0', length: 0, status: 'Available' },
      { rollId: 'R1', label: 'R1', length: 10, status: 'Available' }
    ],
    waste: []
  };
  const fab = { fabricWidthCm: 55 };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 50, pieces: 20 }], fab, false);
  approx(f.freshMetres, 10);
  assert.strictEqual(f.covers, true);
  assert.strictEqual(f.rollsAfter.length, 1);
  assert.strictEqual(f.rollsAfter[0].rollId, 'R1');

  const lot2 = rollLot('L1', [{ rollId: 'R0', length: 0 }, { rollId: 'R1', length: 10 }]);
  const ln = line('IT1', 20, 0, 'PLAN1', 55, 50);
  const mat = material('M1', { fabricWidthCm: 55, cutWidth: 55, cutLength: 50, lines: [ln], lots: [lot2] });
  const data = [sup('S1', [mat])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  assert.strictEqual(out.lotLines.length, 1);
  const ll = out.lotLines[0];
  assert.strictEqual(ll.rolls.length, 1);
  assert.strictEqual(ll.rolls[0].rollId, 'R1');
  approx(ll.qty, 10);
});

test('4 Two orders same card same lot same roll: rollLeft drain', () => {
  const lot = rollLot('L1', [{ rollId: 'R1', label: 'L1-R1', length: 10 }]);
  const lnA = line('IT1', 10, 0, 'PLAN_A', 55, 50);
  const lnB = line('IT2', 12, 0, 'PLAN_B', 55, 50);
  const mat = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 50,
    lines: [lnA, lnB],
    lots: [lot]
  });
  const data = [sup('S1', [mat])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  const oa = out.orderOutcomes.find(function (o) { return o.planId === 'PLAN_A'; });
  const ob = out.orderOutcomes.find(function (o) { return o.planId === 'PLAN_B'; });
  assert.ok(oa); assert.ok(ob);
  assert.strictEqual(oa.why, 'ready');
  approx(oa.metres, 5);
  assert.strictEqual(ob.why, 'skipped', 'second order should be skipped because roll left only 5m after first');
  assert.strictEqual(out.lotLines.length, 1);
  approx(out.lotLines[0].qty, 5);
});

// INVERTED BY PHASE B. This asserted "no cross-card reservation" — both
// supervisors offered the same 8 m off one 10 m roll — and was correct for the
// code as it then stood. The ledgers are now shared across cards and walked in
// priority order, so the first supervisor's 8 m really is gone before the
// second is measured. Asserting the NEW rule:
test('5 Two supervisors same roll: the roll is RESERVED down priority order', () => {
  function makeMat() {
    return material('M1', {
      fabricWidthCm: 55, cutWidth: 55, cutLength: 50,
      lines: [line('IT1', 16, 0, 'PLAN1', 55, 50)],
      lots: [rollLot('L1', [{ rollId: 'R1', length: 10, label: 'L1-R1' }], { wash: 10 })]
    });
  }
  // One 10 m roll, perRow 1, cut 0.5 m. Each supervisor wants 16 pieces = 16
  // rows = 8 m. The roll can serve one of them and leave 2 m.
  const data = [sup('S1', [makeMat()]), sup('S2', [makeMat()])];
  A.applyLotAllocation(data);
  const m1 = data[0].materials[0];
  const m2 = data[1].materials[0];

  // S1 first: served in full.
  assert.strictEqual(m1.lotLines.length, 1, 'S1 must be served');
  approx(m1.lotLines[0].qty, 8);
  const o1 = m1.orderOutcomes.find(function (o) { return o.planId === 'PLAN1'; });
  assert.strictEqual(o1.why, 'ready');

  // S2 second: 2 m left = 4 rows = 4 pieces, short of the 16 it needs, and an
  // order is served whole or not at all — so it is skipped, not part-served.
  assert.strictEqual(m2.lotLines.length, 0,
    'S2 must not be offered cloth S1 has taken');
  const o2 = m2.orderOutcomes.find(function (o) { return o.planId === 'PLAN1'; });
  assert.strictEqual(o2.why, 'skipped');

  // CONSERVATION: the two cards together never promise more than the roll
  // holds. This is the invariant the whole reservation exists to guarantee.
  const promised = (m1.lotLines || []).concat(m2.lotLines || [])
    .reduce(function (t, ln) { return t + (Number(ln.qty) || 0); }, 0);
  assert.ok(promised <= 10 + 0.0001,
    'promised ' + promised + ' m off a 10 m roll — over-promise');
});

test('6 AfterWash commitment drains rolls but emits no lotLines', () => {
  const lot = rollLot('L1', [{ rollId: 'R1', label: 'L1-R1', length: 10 }], { wash: 5, unwash: 5, inWash: 0 });
  const lnA = line('IT1', 16, 0, 'PLAN_A', 55, 50);
  const lnB = line('IT2', 10, 0, 'PLAN_B', 55, 50);
  const mat = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 50,
    lines: [lnA, lnB],
    lots: [lot]
  });
  const data = [sup('S1', [mat])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  const oa = out.orderOutcomes.find(function (o) { return o.planId === 'PLAN_A'; });
  assert.ok(oa);
  assert.strictEqual(oa.why, 'afterWash', 'PLAN_A should be afterWash');
  assert.strictEqual(oa.metres, 0, 'afterWash emits 0 metres');
  assert.strictEqual(out.lotLines.length, 0, 'afterWash commitment must not emit lotLines');
  const ob = out.orderOutcomes.find(function (o) { return o.planId === 'PLAN_B'; });
  assert.ok(ob);
  assert.strictEqual(ob.why, 'skipped');
});

test('7 InWash lot with zero wash+unwash: gate includes inWash only when greige true', () => {
  const lot = {
    lotId: 'L1', lotNumber: 'L1', blocked: false,
    wash: 0, unwash: 0, inWash: 10, form: 'Roll', pieces: [],
    rolls: [{ rollId: 'R1', label: 'R1', length: 10, status: 'Available' }],
    waste: []
  };
  const fab = { fabricWidthCm: 55 };
  const demand = [{ cutW: 55, cutL: 50, pieces: 10 }];
  const fFalse = A.lotFill(lot, demand, fab, false);
  approx(fFalse.freshMetres, 0);
  assert.strictEqual(fFalse.covers, false);
  const fTrue = A.lotFill(lot, demand, fab, true);
  approx(fTrue.freshMetres, 5);
  assert.strictEqual(fTrue.covers, true, 'inWash should count only when greige true');
});

test('8 Roll exactly one marker row: yields 1 row not 0', () => {
  const lot = {
    lotId: 'L1', lotNumber: 'L1', blocked: false,
    wash: 0.55, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
    rolls: [{ rollId: 'R1', label: 'R1', length: 0.55, status: 'Available' }],
    waste: []
  };
  const fab = { fabricWidthCm: 55 };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 1 }], fab, false);
  assert.strictEqual(f.covers, true);
  approx(f.freshMetres, 0.55);
});

test('9 Roll just under one marker row: yields 0 rows', () => {
  const lot = {
    lotId: 'L1', lotNumber: 'L1', blocked: false,
    wash: 0.54, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
    rolls: [{ rollId: 'R1', label: 'R1', length: 0.54, status: 'Available' }],
    waste: []
  };
  const fab = { fabricWidthCm: 55 };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 1 }], fab, false);
  assert.strictEqual(f.covers, false);
  approx(f.freshMetres, 0);
});

test('10 Working-copy filtering: Consumed rolls filtered from lot.rolls, lotFill never sees them', () => {
  const lot = {
    lotId: 'L1', lotNumber: 'L1', blocked: false,
    wash: 10, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
    rolls: [
      { rollId: 'R1', label: 'R1', length: 10, status: 'Consumed' },
      { rollId: 'R2', label: 'R2', length: 10, status: 'Available' }
    ],
    waste: []
  };
  const fab = { fabricWidthCm: 55 };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 50, pieces: 20 }], fab, false);
  assert.strictEqual(f.rollsAfter.length, 1);
  assert.strictEqual(f.rollsAfter[0].rollId, 'R2');
  approx(f.freshMetres, 10);
  const f2 = A.lotFill(lot, [{ cutW: 55, cutL: 50, pieces: 30 }], fab, false);
  assert.strictEqual(f2.covers, false);

  const lot2 = rollLot('L1', [{ rollId: 'R1', length: 10, status: 'Consumed' }, { rollId: 'R2', length: 10, status: 'Available' }]);
  const ln = line('IT1', 20, 0, 'PLAN1', 55, 50);
  const mat = material('M1', { fabricWidthCm: 55, cutWidth: 55, cutLength: 50, lines: [ln], lots: [lot2] });
  const data = [sup('S1', [mat])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  assert.strictEqual(out.lotLines.length, 1);
  assert.strictEqual(out.lotLines[0].rolls.length, 1);
  assert.strictEqual(out.lotLines[0].rolls[0].rollId, 'R2');
});

console.log('\n========================================');
console.log('allocator-edgecases-ledger: ' + passed + ' passed, ' + failed + ' failed');
console.log('\n--- Edge Cases Ledger Scorecard ---');
results.forEach(function (r) {
  console.log('[' + r.status + '] ' + r.name + (r.error ? ' -> ' + r.error : ''));
});
if (failed > 0) process.exitCode = 1;
