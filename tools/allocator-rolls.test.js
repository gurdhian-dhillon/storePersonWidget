#!/usr/bin/env node
// Multi-roll test suite for the roll-based rewrite of app/js/lot-allocator.js.
// Tests the 9 multi-roll behavior cases and conservation invariants.
//
//   usage: node tools/allocator-rolls.test.js

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
vm.runInContext(src + '\nthis.A = { round2, remnantYield, perRowFor, lotFill, chooseLotForOrder, orderMetres,\n  lotIsPieces, lotPieces, lotGreigePieces, applyLotAllocation,\n  applyFabricOverride, shortReasonFor,\n  setOverride: function (k, v) { lotOverrides[k] = v; },\n  clearOverrides: function () { for (var k in lotOverrides) delete lotOverrides[k]; },\n  setDeclined: function (k, v) { wasteDeclined[k] = v; },\n  clearDeclined: function () { for (var k in wasteDeclined) delete wasteDeclined[k]; } };', ctx);
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

// ---- Conservation Invariants Checker (C) --------------------------------------
function assertInvariants(m, rollsBefore) {
  // C1: Σ rollLines metres across all orders == freshMetres charged
  const allRollLines = [];
  (m.lotLines || []).forEach(ln => {
    if (ln.rolls && Array.isArray(ln.rolls)) {
      ln.rolls.forEach(r => allRollLines.push(r));
    }
  });

  if (allRollLines.length > 0) {
    const sumRollLines = Math.round(allRollLines.reduce((acc, r) => acc + (Number(r.metres) || 0), 0) * 100) / 100;
    approx(sumRollLines, Number(m.freshMeters) || 0, 0.01);
  }

  // C2: no roll.length < 0
  (m.lots || []).forEach(l => {
    (l.rolls || []).forEach(r => {
      if (r.length < 0) throw new Error(`Invariant failed: roll ${r.label} has negative length ${r.length}`);
    });
  });

  // C3: Σ Available roll.length after allocation == before − Σ freshMetres
  if (rollsBefore && rollsBefore.length > 0) {
    const sumBefore = Math.round(rollsBefore.reduce((acc, r) => acc + (r.status === 'Available' ? r.length : 0), 0) * 100) / 100;
    const currentRolls = (m.lots || []).flatMap(l => l.rolls || []);
    const sumAfter = Math.round(currentRolls.reduce((acc, r) => acc + (r.status === 'Available' ? r.length : 0), 0) * 100) / 100;
    const expectedAfter = Math.round((sumBefore - (Number(m.freshMeters) || 0)) * 100) / 100;
    approx(sumAfter, expectedAfter, 0.01);
  }

  // C4: covers is true IFF owed pieces all reach 0
  (m.orderOutcomes || []).forEach(oc => {
    if (oc.why === 'ready') {
      const remainingOwed = (oc.pieces || 0) - (oc.coveredPieces || oc.pieces || 0);
      assert.strictEqual(remainingOwed, 0, `Invariant failed: order ${oc.planId} is marked ready but owed pieces remaining`);
    }
  });
}

// =====================================================================
console.log('\nPART B - multi-roll behaviour (9 cases)');

// 1. Continuity: lot with rolls [750, 8], order needs a 10 m marker length
test('B1 Continuity: 8 m roll yields 0 rows; lot covers only if 750 m roll alone covers', () => {
  const fab = { fabricWidthCm: 137.16 }; // perRow for cutW 55 = 2
  const cutL = 1000; // 10 m
  const cutW = 55;

  // Case A: lot with rolls [750, 8]. Order needs 150 pieces (75 rows = 750 m).
  // 750 m roll yields floor(75000/1000) * 2 = 150 pieces. 8 m roll yields 0 pieces.
  const lotA = rollLot('L1', [{ length: 750 }, { length: 8 }]);
  const fA = A.lotFill(lotA, [{ cutW: 55, cutL: 1000, pieces: 150 }], fab, false);
  assert.strictEqual(fA.covers, true, '750 m roll alone must cover 150 pieces');
  approx(fA.freshMetres, 750);

  // Case B: lot with rolls [745, 8] (total 753 m). Order needs 150 pieces (75 rows = 750 m).
  // Under scalar (753 >= 750), scalar allocator says covered.
  // Under rolls: 745 m yields 74 rows (148 pieces), 8 m yields 0 rows -> capacity 148 < 150 -> covers MUST be false!
  const lotB = rollLot('L2', [{ length: 745 }, { length: 8 }]);
  const fB = A.lotFill(lotB, [{ cutW: 55, cutL: 1000, pieces: 150 }], fab, false);
  assert.strictEqual(fB.covers, false, 'rolls [745, 8] must NOT cover 150 pieces of 10m marker even though scalar wash 753 >= 750');
});

// 2. Smallest-first drain: lot with rolls [5, 5, 20], cut 1.5 m, order = 12 pieces at perRow 1
test('B2 Smallest-first drain: rolls [5, 5, 20] drain two 5 m rolls first, then 6 from 20 m', () => {
  const rolls = [
    { label: 'L1-R1', length: 5 },
    { label: 'L1-R2', length: 5 },
    { label: 'L1-R3', length: 20 }
  ];
  const rollsBefore = JSON.parse(JSON.stringify(rolls));
  const data = [sup('S1', [material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 150,
    requiredPieces: 12, issuedPieces: 0,
    lines: [line('IT1', 12, 0, 'PLAN1', 55, 150)],
    lots: [rollLot('L1', rolls)]
  })])];

  A.applyLotAllocation(data);
  const m = data[0].materials[0];

  assert.strictEqual(m.lotLines.length, 1);
  approx(m.freshMeters, 18.0); // 3*1.5 + 3*1.5 + 6*1.5 = 18.0 m

  const ln = m.lotLines[0];
  assert.ok(ln.rolls, 'lotLine must carry rolls[]');
  assert.strictEqual(ln.rolls.length, 3);
  assert.strictEqual(ln.rolls[0].label, 'L1-R1');
  approx(ln.rolls[0].metres, 4.5);
  assert.strictEqual(ln.rolls[1].label, 'L1-R2');
  approx(ln.rolls[1].metres, 4.5);
  assert.strictEqual(ln.rolls[2].label, 'L1-R3');
  approx(ln.rolls[2].metres, 9.0);

  assertInvariants(m, rollsBefore);
});

// 3. Tie-break: rolls [10 label 'B-R2', 10 label 'B-R1'] -> B-R1 is drained first
test('B3 Tie-break: equal length rolls pick lowest Roll_Label (B-R1 before B-R2)', () => {
  const rolls = [
    { label: 'B-R2', length: 10 },
    { label: 'B-R1', length: 10 }
  ];
  const rollsBefore = JSON.parse(JSON.stringify(rolls));
  const data = [sup('S1', [material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 150,
    requiredPieces: 3, issuedPieces: 0, // 3 rows * 1.5m = 4.5m
    lines: [line('IT1', 3, 0, 'PLAN1', 55, 150)],
    lots: [rollLot('L1', rolls)]
  })])];

  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  const ln = m.lotLines[0];

  assert.ok(ln.rolls, 'lotLine must carry rolls[]');
  assert.strictEqual(ln.rolls[0].label, 'B-R1', 'B-R1 must drain before B-R2 on alphabetical tie-break');
  approx(ln.rolls[0].metres, 4.5);

  assertInvariants(m, rollsBefore);
});

// 4. Roll can't yield a full row: cut 1.5 m, roll 1.0 m -> contributes 0, never picked, never negative
test('B4 Roll cannot yield a full row: 1.0 m roll vs 1.5 m cut contributes 0 pieces', () => {
  const rolls = [{ label: 'L1-R1', length: 1.0 }];
  const rollsBefore = JSON.parse(JSON.stringify(rolls));
  const lot = rollLot('L1', rolls);
  const fab = { fabricWidthCm: 55 };

  const f = A.lotFill(lot, [{ cutW: 55, cutL: 150, pieces: 1 }], fab, false);
  assert.strictEqual(f.covers, false);
  approx(f.freshMetres, 0);

  const data = [sup('S1', [material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 150,
    requiredPieces: 1, issuedPieces: 0,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 150)],
    lots: [lot]
  })])];

  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.lotLines.length, 0);
  assert.strictEqual(lot.rolls[0].length, 1.0, 'roll must remain 1.0 m');

  assertInvariants(m, rollsBefore);
});

// 5. Two orders on one card racing one roll: roll 6 m, two orders each needing 5.5 m
test('B5 Two orders racing one roll: order 1 takes 5.5 m, order 2 sees shortened roll and is short', () => {
  const rolls = [{ label: 'L1-R1', length: 6.0 }];
  const rollsBefore = JSON.parse(JSON.stringify(rolls));
  const lot = rollLot('L1', rolls);

  const data = [sup('S1', [material('M1', {
    fabricWidthCm: 137.16, cutWidth: 55, cutLength: 55, // perRow = 2 -> 20 pcs = 10 rows * 0.55m = 5.50m
    requiredPieces: 40,
    lines: [line('IT1', 20, 0, 'PLANA', 55, 55), line('IT2', 20, 0, 'PLANB', 55, 55)],
    lots: [lot]
  })])];

  A.applyLotAllocation(data);
  const m = data[0].materials[0];

  const a = m.orderOutcomes.find(o => o.planId === 'PLANA');
  const b = m.orderOutcomes.find(o => o.planId === 'PLANB');

  assert.strictEqual(a.why, 'ready');
  approx(a.metres, 5.50);
  assert.strictEqual(b.why, 'skipped');

  // In-memory spend() check: roll must be decremented in memory
  approx(lot.rolls[0].length, 0.50, 0.01);

  assertInvariants(m, rollsBefore);
});

// 6. Printed lot as short rolls: a lot of rolls [3, 3, 3, 3] vs a 55 cm cut -> 15 rows total (for 3 rolls)
test('B6 Printed lot as short rolls: [3, 3, 3] rolls vs 55 cm cut yields 15 rows, not 16', () => {
  const fab = { fabricWidthCm: 55 }; // perRow = 1
  const rolls = [
    { label: 'P-R1', length: 3.0 },
    { label: 'P-R2', length: 3.0 },
    { label: 'P-R3', length: 3.0 }
  ];
  const lot = rollLot('LP', rolls);

  // Each 3.0 m roll yields floor(300/55) = 5 rows. 3 rolls = 15 rows = 15 pieces.
  // 16 pieces would require continuous 9 m (floor(900/55) = 16), which fails across short rolls.
  const f16 = A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 16 }], fab, false);
  assert.strictEqual(f16.covers, false, '16 pieces cannot be cut from three 3.0 m rolls (each yields only 5 rows = 15 total)');

  const f15 = A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 15 }], fab, false);
  assert.strictEqual(f15.covers, true, '15 pieces must be covered exactly');
  approx(f15.freshMetres, 8.25); // 3 rolls * 5 rows * 0.55 = 8.25 m
});

// 7. chooseLotForOrder ranking: lot A rolls Σ 19 m in one roll, lot B rolls [19, 1] Σ 20 m
test('B7 chooseLotForOrder ranking: lot A (19 m roll) chosen over lot B ([19, 1] m rolls)', () => {
  const fab = { fabricWidthCm: 55 }; // perRow = 1
  const lotA = rollLot('LOT_A', [{ length: 19.0 }]);
  const lotB = rollLot('LOT_B', [{ length: 19.0 }, { length: 1.0 }]);

  // Order needs 10 pieces of 1.5 m (10 rows * 1.5 m = 15 m)
  const demands = [{ cutW: 55, cutL: 150, pieces: 10 }];

  const choice = A.chooseLotForOrder([lotB, lotA], demands, fab);
  assert.ok(choice, 'must choose a covering lot');
  assert.strictEqual(choice.lot.lotId, 'LOT_A', 'Lot A (19 m) must rank before Lot B (20 m total with 1 m unusable short roll)');
});

// 8. applyFabricOverride: single-roll lot hand-edit 10 -> 12 syncs ln.rolls; >1-roll lot refused
test('B8 applyFabricOverride: single-roll edit syncs ln.rolls[0].metres; multi-roll refused', () => {
  // Sub-case 8a: Single-roll lot
  const singleRollLot = rollLot('L1', [{ label: 'L1-R1', length: 15.0 }]);
  const matSingle = material('M1', {
    fabricWidthCm: 137.16, cutWidth: 55, cutLength: 55,
    requiredPieces: 20, issuedPieces: 0,
    lines: [line('IT1', 20, 0, 'PLAN1', 55, 55)],
    lots: [singleRollLot]
  });
  const dataSingle = [sup('S1', [matSingle])];
  A.applyLotAllocation(dataSingle);

  // Simulate user hand-editing metres to 12.0
  A.applyFabricOverride(matSingle, 'L1', 12.0);
  const lnSingle = matSingle.lotLines[0];
  approx(lnSingle.qty, 12.0);
  assert.ok(lnSingle.rolls, 'lotLine must carry rolls');
  assert.strictEqual(lnSingle.rolls.length, 1);
  approx(lnSingle.rolls[0].metres, 12.0, 0.01);

  // Sub-case 8b: Multi-roll lot
  const multiRollLot = rollLot('L2', [{ label: 'L2-R1', length: 8.0 }, { label: 'L2-R2', length: 8.0 }]);
  const matMulti = material('M2', {
    fabricWidthCm: 137.16, cutWidth: 55, cutLength: 55,
    requiredPieces: 20, issuedPieces: 0,
    lines: [line('IT2', 20, 0, 'PLAN2', 55, 55)],
    lots: [multiRollLot]
  });
  const dataMulti = [sup('S1', [matMulti])];
  A.applyLotAllocation(dataMulti);

  const autoQtyBefore = matMulti.lotLines[0].qty;
  // Hand-edit on multi-roll lot MUST be refused
  A.applyFabricOverride(matMulti, 'L2', 12.0);
  approx(matMulti.lotLines[0].qty, autoQtyBefore, 0.01);
});

// 9. shortReasonFor 'nofit': lot rolls [10, 10], order needs 12 m marker -> have figure is 10, not 20
test('B9 shortReasonFor nofit: reports longest roll length (10 m), not sum (20 m)', () => {
  const lot = rollLot('L1', [{ length: 10.0 }, { length: 10.0 }]);
  const fab = { fabricWidthCm: 55 };
  const demands = [{ cutW: 55, cutL: 1200, pieces: 1 }]; // 12 m marker length

  const mat = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 1200,
    requiredPieces: 1, issuedPieces: 0, remaining: 12.0,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 1200)],
    lots: [lot]
  });

  const r = {
    lotLines: [],
    noFitSmallest: 12.0,
    pinnedDryLots: [],
    lotsUsed: []
  };

  const reason = A.shortReasonFor(mat, r, [lot]);
  assert.ok(reason, 'must return a shortReason');
  assert.strictEqual(reason.kind, 'nofit');
  assert.strictEqual(reason.have, 10.0, 'have must report longest roll length (10), not lot total (20)');
  assert.strictEqual(reason.need, 12.0);
});

console.log('\n========================================');
console.log('allocator-rolls: ' + passed + ' passed, ' + failed + ' failed');
console.log('\n--- Multi-Roll Test Scorecard ---');
results.forEach(r => {
  console.log(`[${r.status}] ${r.name}${r.error ? ' -> ' + r.error : ''}`);
});
