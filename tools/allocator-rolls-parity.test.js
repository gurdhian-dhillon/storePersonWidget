#!/usr/bin/env node
// Parity test suite for the roll-based rewrite of app/js/lot-allocator.js.
// Every one of the 31 existing allocator.test.js scenarios, re-run with each
// lot given ONE seed roll = its old scalar metres.
//
// Assert the output (covers, freshMetres, metresPer, lotLines, wastePicks,
// the per-order outcomes) is BYTE-IDENTICAL to the current scalar allocator's
// output for that scenario.
//
//   usage: node tools/allocator-rolls-parity.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0, skipped = 0;
const failures = [];
function test(name, fn) {
  // The pure-helper cases (C*) don't need a baseline; the rest compare against
  // A_scalar. If the baseline is missing, skip the comparison cases rather than
  // fail them.
  if (typeof A_scalar === 'undefined' || (A_scalar === null && name[0] !== 'C')) {
    skipped++; console.log('  skip ' + name + '  (no parity baseline)'); return;
  }
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}
function approx(a, b, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + '+/-' + eps + ', got ' + a);
}

// ---- load the allocator, TWO versions ---------------------------------------
//
// A_rolls  = the working tree (the roll rewrite under test).
// A_scalar = the FROZEN pre-rewrite baseline, read from git. The parity guard is
//   "seed-roll fixture through A_rolls == same fixture through A_scalar". Loading
//   A_scalar as a second copy of the working file is wrong — it would run the
//   new code both sides and prove nothing. If git can't produce the baseline
//   (detached checkout, shallow clone), the parity run is SKIPPED loudly rather
//   than run against a fake baseline.
const { execFileSync } = require('child_process');

function loadAllocator(src, label) {
  const ctx = { console, Math, Number, Object, String, Array, JSON };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.A = { round2, remnantYield, perRowFor, lotFill, chooseLotForOrder, orderMetres,\n  lotIsPieces: (typeof lotIsPieces === "function" ? lotIsPieces : function () { return false; }),\n  lotPieces: (typeof lotPieces === "function" ? lotPieces : function () { return []; }),\n  lotGreigePieces: (typeof lotGreigePieces === "function" ? lotGreigePieces : function () { return 0; }),\n  applyLotAllocation,\n  setOverride: function (k, v) { lotOverrides[k] = v; },\n  clearOverrides: function () { for (var k in lotOverrides) delete lotOverrides[k]; },\n  setDeclined: function (k, v) { wasteDeclined[k] = v; },\n  clearDeclined: function () { for (var k in wasteDeclined) delete wasteDeclined[k]; } };', ctx);
  return ctx.A;
}

const workingSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');

// The last commit BEFORE the roll rewrite touched lot-allocator.js. Pinned so
// the baseline never drifts. Update only if you deliberately re-baseline.
const BASELINE_REF = 'e000519:app/js/lot-allocator.js';
let baselineSrc = null;
let baselineErr = null;
try {
  baselineSrc = execFileSync('git', ['show', BASELINE_REF], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
} catch (e) {
  baselineErr = e.message;
}

const A_rolls = loadAllocator(workingSrc, 'working');
const A_scalar = baselineSrc ? loadAllocator(baselineSrc, 'baseline') : null;

if (!A_scalar) {
  console.log('\n!!  PARITY BASELINE UNAVAILABLE  !!');
  console.log('    git show ' + BASELINE_REF + ' failed: ' + baselineErr);
  console.log('    The parity comparisons below cannot run. Multi-roll behaviour');
  console.log('    is still checked by tools/allocator-rolls.test.js.\n');
}

// ---- builders -----------------------------------------------------------------
function line(planItemId, reqPcs, issPcs, planId, issuedLot) {
  return { planId: planId || 'PLAN1', planItemId, reqPieces: reqPcs, issPieces: issPcs || 0,
           issuedLot: issuedLot || '', issuedLotNo: issuedLot || '', item: 'X', isRemake: false };
}
function scalarRoll(lotId, wash, opts) {
  opts = opts || {};
  return { lotId, lotNumber: opts.no || lotId, blocked: !!opts.blocked,
           wash: wash, unwash: opts.unwash || 0, inWash: opts.inWash || 0,
           form: 'Roll', pieces: [] };
}
function seedRollLot(lotId, wash, opts) {
  opts = opts || {};
  const rollLen = Math.round(((Number(wash) || 0) + (Number(opts.unwash) || 0) + (Number(opts.inWash) || 0)) * 100) / 100;
  const label = (opts.no || lotId) + '-R1';
  return {
    lotId, lotNumber: opts.no || lotId, blocked: !!opts.blocked,
    wash: wash, unwash: opts.unwash || 0, inWash: opts.inWash || 0,
    form: 'Roll', pieces: [],
    rolls: [
      { rollId: label, label: label, length: rollLen, status: 'Available', origin: 'Purchased' }
    ]
  };
}
function pieceLot(lotId, pieces, opts) {
  opts = opts || {};
  return { lotId, lotNumber: opts.no || lotId, blocked: !!opts.blocked,
           wash: opts.wash || 0, unwash: opts.unwash || 0, inWash: opts.inWash || 0,
           form: 'Pieces', pieces: pieces };
}
function seedPieceLot(lotId, pieces, opts) {
  opts = opts || {};
  const pLot = pieceLot(lotId, pieces, opts);
  // Also attach seed rolls corresponding to the pieces for when Pieces-form merges
  pLot.rolls = (pieces || []).map((p, idx) => ({
    rollId: (opts.no || lotId) + '-P' + (idx + 1),
    label: (opts.no || lotId) + '-P' + (idx + 1),
    length: Math.round((Number(p.lengthCm || 0) / 100) * 100) / 100,
    status: 'Available',
    origin: 'Printed'
  }));
  return pLot;
}
function fpiece(pieceId, lenCm, widCm, count, state) {
  return { pieceId, lengthCm: lenCm, widthCm: widCm, count: count || 1, state: state || 'Wash', carton: '' };
}
function remnant(wasteId, w, l, pcs, lotId) {
  return { wasteId, width: w, length: l, pieces: pcs, lotId: lotId || '', lot: '', carton: '' };
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

function snapshotLotFill(f) {
  return {
    covers: f.covers,
    freshMetres: f.freshMetres,
    fromFresh: f.fromFresh,
    metresPer: f.metresPer,
    fromWaste: f.fromWaste,
    shortBy: f.shortBy,
    picks: f.picks
  };
}
function snapshotChooseLot(c) {
  if (!c) return null;
  return { lotId: c.lot.lotId, ready: c.ready };
}
function snapshotMaterial(m) {
  return {
    freshMeters: m.freshMeters,
    remaining: m.remaining,
    piecesCoveredByWaste: m.piecesCoveredByWaste,
    freshPieces: m.freshPieces,
    lotLines: (m.lotLines || []).map(ln => ({
      lotId: ln.lotId,
      lotNumber: ln.lotNumber,
      qty: ln.qty,
      planItemId: ln.planItemId,
      planId: ln.planId,
      fromRaw: ln.fromRaw,
      fromWaste: ln.fromWaste,
      overrideFrom: ln.overrideFrom
    })),
    wastePicks: (m.wastePicks || []).map(wp => ({
      wasteId: wp.wasteId,
      pieces: wp.pieces,
      planItemId: wp.planItemId
    })),
    orderOutcomes: (m.orderOutcomes || []).map(o => ({
      planId: o.planId,
      why: o.why,
      metres: o.metres,
      needMetres: o.needMetres
    }))
  };
}

function assertParity(name, scalarVal, rollVal) {
  const sStr = JSON.stringify(scalarVal);
  const rStr = JSON.stringify(rollVal);
  if (sStr !== rStr) {
    throw new Error(`PARITY DISCREPANCY in ${name}:\nOLD (scalar): ${sStr}\nNEW (seed-roll): ${rStr}`);
  }
}

// =====================================================================
console.log('\nPART C - pure helpers (parity check)');

test('C1 remnantYield: floor-across x floor-along', () => {
  assert.strictEqual(A_rolls.remnantYield({ width: 300, length: 400 }, 187, 137),
                     A_scalar.remnantYield({ width: 300, length: 400 }, 187, 137));
  assert.strictEqual(A_rolls.remnantYield({ width: 300, length: 400 }, 187, 137), 2);
});
test('C2 grain fixed: narrower than cut is ZERO however long', () => {
  assert.strictEqual(A_rolls.remnantYield({ width: 100, length: 900 }, 187, 137),
                     A_scalar.remnantYield({ width: 100, length: 900 }, 187, 137));
  assert.strictEqual(A_rolls.remnantYield({ width: 100, length: 900 }, 187, 137), 0);
});
test('C3 exact fit = 1; just-short length = 0', () => {
  assert.strictEqual(A_rolls.remnantYield({ width: 55, length: 55 }, 55, 55),
                     A_scalar.remnantYield({ width: 55, length: 55 }, 55, 55));
  assert.strictEqual(A_rolls.remnantYield({ width: 55, length: 54.9 }, 55, 55),
                     A_scalar.remnantYield({ width: 55, length: 54.9 }, 55, 55));
});
test('C4 perRowFor boundaries incl. cut-wider-than-cloth refusal', () => {
  assert.strictEqual(A_rolls.perRowFor({ fabricWidthCm: 167.64 }, 55),
                     A_scalar.perRowFor({ fabricWidthCm: 167.64 }, 55));
  assert.strictEqual(A_rolls.perRowFor({ fabricWidthCm: 110 }, 110),
                     A_scalar.perRowFor({ fabricWidthCm: 110 }, 110));
  assert.strictEqual(A_rolls.perRowFor({ fabricWidthCm: 109.99 }, 110),
                     A_scalar.perRowFor({ fabricWidthCm: 109.99 }, 110));
  assert.strictEqual(A_rolls.perRowFor({ fabricWidthCm: 0 }, 55),
                     A_scalar.perRowFor({ fabricWidthCm: 0 }, 55));
});

console.log('\nPART D - lotFill simulation (parity check)');

test('D1 roll: rows capped by cloth; shortfall reported in PIECES', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 20 }];
  const fab = { fabricWidthCm: 137.16 };
  const f_scalar = A_scalar.lotFill(scalarRoll('L1', 5.00), dem, fab, false);
  const f_rolls = A_rolls.lotFill(seedRollLot('L1', 5.00), dem, fab, false);
  assertParity('D1', snapshotLotFill(f_scalar), snapshotLotFill(f_rolls));
});
test('D2 waste before fresh; least-waste-per-cut scoring picks the snug remnant', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 4 }];
  const fab = { fabricWidthCm: 137.16 };
  const lot_s = scalarRoll('L1', 100);
  lot_s.waste = [remnant('BIG', 200, 300, 1, 'L1'), remnant('SNUG', 120, 115, 1, 'L1')];
  const lot_r = seedRollLot('L1', 100);
  lot_r.waste = [remnant('BIG', 200, 300, 1, 'L1'), remnant('SNUG', 120, 115, 1, 'L1')];
  const f_scalar = A_scalar.lotFill(lot_s, dem, fab, false);
  const f_rolls = A_rolls.lotFill(lot_r, dem, fab, false);
  assertParity('D2', snapshotLotFill(f_scalar), snapshotLotFill(f_rolls));
});
test('D3 pieces lot: mini-roll cuts EXACTLY the rows needed; tails are not charged', () => {
  const dem = [{ cutW: 60, cutL: 55, pieces: 25 }];
  const fab = { fabricWidthCm: 140 };
  const lot_s = pieceLot('LP', [fpiece('p1', 300, 140), fpiece('p2', 300, 140), fpiece('p3', 300, 140)], { wash: 9.00 });
  const lot_r = seedPieceLot('LP', [fpiece('p1', 300, 140), fpiece('p2', 300, 140), fpiece('p3', 300, 140)], { wash: 9.00 });
  const f_scalar = A_scalar.lotFill(lot_s, dem, fab, false);
  const f_rolls = A_rolls.lotFill(lot_r, dem, fab, false);
  assertParity('D3', snapshotLotFill(f_scalar), snapshotLotFill(f_rolls));
});
test('D4 roll greige never serves TODAY, covers once washed', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 10 }];
  const fab = { fabricWidthCm: 137.16 };
  const f_scalar_today = A_scalar.lotFill(scalarRoll('L1', 0, { unwash: 50 }), dem, fab, false);
  const f_rolls_today = A_rolls.lotFill(seedRollLot('L1', 0, { unwash: 50 }), dem, fab, false);
  assertParity('D4 today', snapshotLotFill(f_scalar_today), snapshotLotFill(f_rolls_today));

  const f_scalar_wash = A_scalar.lotFill(scalarRoll('L1', 0, { unwash: 50 }), dem, fab, true);
  const f_rolls_wash = A_rolls.lotFill(seedRollLot('L1', 0, { unwash: 50 }), dem, fab, true);
  assertParity('D4 wash', snapshotLotFill(f_scalar_wash), snapshotLotFill(f_rolls_wash));
});
test('D5 greige PIECES excluded even from after-wash simulation (documented phase-2 gap)', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 5 }];
  const fab = { fabricWidthCm: 140 };
  const lot_s = pieceLot('LP', [fpiece('p1', 300, 140, 5, 'Unwash')], { wash: 0 });
  const lot_r = seedPieceLot('LP', [fpiece('p1', 300, 140, 5, 'Unwash')], { wash: 0 });
  const f_scalar = A_scalar.lotFill(lot_s, dem, fab, true);
  const f_rolls = A_rolls.lotFill(lot_r, dem, fab, true);
  assertParity('D5', snapshotLotFill(f_scalar), snapshotLotFill(f_rolls));
});
test('D7 EMPTY form means Roll - legacy lots stay cuttable', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 20 }];
  const fab = { fabricWidthCm: 137.16 };
  const lot_s = scalarRoll('L1', 6.00); lot_s.form = '';
  const lot_r = seedRollLot('L1', 6.00); lot_r.form = '';
  const f_scalar = A_scalar.lotFill(lot_s, dem, fab, false);
  const f_rolls = A_rolls.lotFill(lot_r, dem, fab, false);
  assertParity('D7', snapshotLotFill(f_scalar), snapshotLotFill(f_rolls));
});

console.log('\nPART E - chooseLotForOrder (parity check)');

test('E1 smallest covering lot wins among ready ones', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 20 }];
  const fab = { fabricWidthCm: 137.16 };
  const c_scalar = A_scalar.chooseLotForOrder([scalarRoll('BIG', 50), scalarRoll('SMALL', 6)], dem, fab);
  const c_rolls = A_rolls.chooseLotForOrder([seedRollLot('BIG', 50), seedRollLot('SMALL', 6)], dem, fab);
  assertParity('E1', snapshotChooseLot(c_scalar), snapshotChooseLot(c_rolls));
});
test('E2 an order nothing covers WHOLE is skipped, never split', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 30 }];
  const fab = { fabricWidthCm: 137.16 };
  const c_scalar = A_scalar.chooseLotForOrder([scalarRoll('A', 3), scalarRoll('B', 4)], dem, fab);
  const c_rolls = A_rolls.chooseLotForOrder([seedRollLot('A', 3), seedRollLot('B', 4)], dem, fab);
  assertParity('E2', snapshotChooseLot(c_scalar), snapshotChooseLot(c_rolls));
});
test('E3 ready tier beats after-wash tier', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 20 }];
  const fab = { fabricWidthCm: 137.16 };
  const c_scalar = A_scalar.chooseLotForOrder([scalarRoll('GREIGE', 0, { unwash: 50 }), scalarRoll('READY', 10)], dem, fab);
  const c_rolls = A_rolls.chooseLotForOrder([seedRollLot('GREIGE', 0, { unwash: 50 }), seedRollLot('READY', 10)], dem, fab);
  assertParity('E3', snapshotChooseLot(c_scalar), snapshotChooseLot(c_rolls));
});
test('E4 blocked lots are never candidates', () => {
  const dem = [{ cutW: 55, cutL: 55, pieces: 2 }];
  const fab = { fabricWidthCm: 137.16 };
  const c_scalar = A_scalar.chooseLotForOrder([scalarRoll('QUAR', 50, { blocked: true })], dem, fab);
  const c_rolls = A_rolls.chooseLotForOrder([seedRollLot('QUAR', 50, { blocked: true })], dem, fab);
  assertParity('E4', snapshotChooseLot(c_scalar), snapshotChooseLot(c_rolls));
});

console.log('\nPART F - applyLotAllocation end-to-end (parity check)');

test('F1 unpinned order: pre-selects its lot, sized in whole marker rows', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 20, issuedPieces: 0, freshMeters: 5.50,
    lines: [line('IT1', 20, 0)], lots: [fnRoll('L1', 10)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F1', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F2 remnant covers part; fresh need shrinks by covered pieces', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 20, issuedPieces: 0, freshMeters: 5.50,
    lines: [line('IT1', 20, 0)],
    wasteStock: [remnant('W1', 120, 115, 1, 'L1')],
    lots: [fnRoll('L1', 10)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F2', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F3 PIN: order stays on its lot however cheap the others are', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 100, issuedPieces: 54,
    lines: [line('IT1', 100, 54, 'PLAN9', 'L1')],
    lots: [fnRoll('L1', 3), fnRoll('CHEAP', 30)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F3', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F4 pin read from SETTLED lines too (the remake-shade bug)', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 4, issuedPieces: 0,
    lines: [line('ORIG', 100, 100, 'PLAN9', 'L1'), line('REMAKE', 4, 0, 'PLAN9', '')],
    lots: [fnRoll('L1', 2), fnRoll('OTHER', 30)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F4', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F5 dry pin (lot emptied off the payload) -> NOTHING moves until a human decides', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 10, issuedPieces: 6,
    lines: [line('IT1', 10, 6, 'PLAN9', 'DEADLOT')],
    lots: [fnRoll('RICH', 30)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F5', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F6 an override rescues the dry pin and records BOTH tones', () => {
  A_scalar.clearOverrides(); A_rolls.clearOverrides();
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 10, issuedPieces: 6,
    lines: [line('IT1', 10, 6, 'PLAN9', 'DEADLOT')],
    lots: [fnRoll('NEW', 30)],
  })])];
  A_scalar.setOverride('S1|M1|PLAN9', { lotId: 'NEW', note: 'ok by eye' });
  A_rolls.setOverride('S1|M1|PLAN9', { lotId: 'NEW', note: 'ok by eye' });
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F6', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
  A_scalar.clearOverrides(); A_rolls.clearOverrides();
});

test('F7 blocked pin is unusable even though full', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 10, issuedPieces: 6,
    lines: [line('IT1', 10, 6, 'PLAN9', 'QUAR')],
    lots: [fnRoll('QUAR', 40, { blocked: true })],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F7', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F8 two orders one card: second sees what is LEFT; never split, never steal', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    lines: [line('IT1', 20, 0, 'PLANA'), line('IT2', 20, 0, 'PLANB')],
    requiredPieces: 40,
    lots: [fnRoll('L1', 7.70)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F8', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F9 two SUPERVISORS both offered the rack - no reservation ledger', () => {
  const mk = (id, fnRoll) => ({ supervisorId: id, supervisorName: 'x', materials: [material('M1', {
    requiredPieces: 20, issuedPieces: 0, freshMeters: 5.50,
    lines: [line('IT1', 20, 0)], lots: [fnRoll('L1', 6.00)],
  })] });
  const d_s = [mk('S1', scalarRoll), mk('S2', scalarRoll)]; A_scalar.applyLotAllocation(d_s);
  const d_r = [mk('S1', seedRollLot), mk('S2', seedRollLot)]; A_rolls.applyLotAllocation(d_r);
  assertParity('F9 S1', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
  assertParity('F9 S2', snapshotMaterial(d_s[1].materials[0]), snapshotMaterial(d_r[1].materials[0]));
});

test('F10 within ONE card two orders cannot promise the same metres twice', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    lines: [line('IT1', 20, 0, 'PLANA'), line('IT2', 20, 0, 'PLANB')],
    requiredPieces: 40,
    lots: [fnRoll('L1', 11.00)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F10', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F11 afterWash commit: nothing issues today; wash aimed at THE lot', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 20, issuedPieces: 0,
    lines: [line('IT1', 20, 0)],
    lots: [fnRoll('G', 1.10, { unwash: 5.50 })],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F11', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F12 pinned lot holding ONLY inWash keeps the pin (wait, never switch)', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 10, issuedPieces: 8,
    lines: [line('IT1', 10, 8, 'PLAN9', 'LAWAY')],
    lots: [fnRoll('LAWAY', 0, { inWash: 12 }), fnRoll('FRESH', 30)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F12', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F13 declined remnant: allocation drops AND fresh need grows; row kept at zero', () => {
  A_scalar.clearDeclined(); A_rolls.clearDeclined();
  const mkData = fnRoll => [sup('S1', [material('M1', {
    requiredPieces: 20, issuedPieces: 0, freshMeters: 5.50,
    lines: [line('IT1', 20, 0)],
    wasteStock: [remnant('W1', 120, 115, 1, 'L1')],
    lots: [fnRoll('L1', 10)],
  })])];
  A_scalar.setDeclined('W1', 0); A_rolls.setDeclined('W1', 0);
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F13', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
  A_scalar.clearDeclined(); A_rolls.clearDeclined();
});

test('F14 pieces-lot end-to-end: per-piece CUT instructions travel to the payload', () => {
  const d_s = [sup('S1', [material('M1', {
    fabricWidthCm: 140, cutWidth: 60,
    requiredPieces: 25, issuedPieces: 0,
    lines: [line('IT1', 25, 0)],
    lots: [pieceLot('LP', [fpiece('p1', 300, 140), fpiece('p2', 300, 140), fpiece('p3', 300, 140)], { wash: 9.00 })],
  })])];
  const d_r = [sup('S1', [material('M1', {
    fabricWidthCm: 140, cutWidth: 60,
    requiredPieces: 25, issuedPieces: 0,
    lines: [line('IT1', 25, 0)],
    lots: [seedPieceLot('LP', [fpiece('p1', 300, 140), fpiece('p2', 300, 140), fpiece('p3', 300, 140)], { wash: 9.00 })],
  })])];
  A_scalar.applyLotAllocation(d_s);
  A_rolls.applyLotAllocation(d_r);
  assertParity('F14', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F15a TWO-piece remnant splits across two items of one order', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    lines: [line('ITA', 4, 0), line('ITB', 4, 0)],
    requiredPieces: 8,
    wasteStock: [remnant('W1', 200, 300, 2, 'L1')],
    lots: [fnRoll('L1', 10)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F15a', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

test('F15b a SINGLE-piece remnant serves ONE item whole - surplus is not promised away', () => {
  const mkData = fnRoll => [sup('S1', [material('M1', {
    lines: [line('ITA', 4, 0), line('ITB', 4, 0)],
    requiredPieces: 8,
    wasteStock: [remnant('W1', 200, 300, 1, 'L1')],
    lots: [fnRoll('L1', 10)],
  })])];
  const d_s = mkData(scalarRoll); A_scalar.applyLotAllocation(d_s);
  const d_r = mkData(seedRollLot); A_rolls.applyLotAllocation(d_r);
  assertParity('F15b', snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
});

console.log('\nPART G - randomized property sweep (parity check)');

function mkRnd(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

test('G1 sweep invariants hold over 400 random racks/orders with seed rolls', () => {
  const rnd = mkRnd(2026);
  for (let iter = 0; iter < 400; iter++) {
    const widthCm = [113.03, 120.015, 137.16][Math.floor(rnd() * 3)];
    const cutW = [40, 55][Math.floor(rnd() * 2)];
    const perRow = Math.floor(widthCm / cutW);
    if (perRow < 1) continue;
    const nLots = 1 + Math.floor(rnd() * 3);
    const lots_s = [];
    const lots_r = [];
    for (let i = 0; i < nLots; i++) {
      const wash = Math.round(rnd() * 12 * 100) / 100;
      const unwash = rnd() < 0.3 ? Math.round(rnd() * 8 * 100) / 100 : 0;
      lots_s.push(scalarRoll('L' + i, wash, { unwash }));
      lots_r.push(seedRollLot('L' + i, wash, { unwash }));
    }
    if (rnd() < 0.2) {
      const bIdx = Math.floor(rnd() * lots_s.length);
      lots_s[bIdx].blocked = true;
      lots_r[bIdx].blocked = true;
    }
    const nRem = Math.floor(rnd() * 4);
    const rem_s = [];
    const rem_r = [];
    for (let i = 0; i < nRem; i++) {
      const r_item = remnant('W' + i + '_' + iter, cutW + Math.floor(rnd() * 80), 55 + Math.floor(rnd() * 200),
        1 + Math.floor(rnd() * 2), lots_s[0].lotId);
      rem_s.push(JSON.parse(JSON.stringify(r_item)));
      rem_r.push(JSON.parse(JSON.stringify(r_item)));
    }
    const nOrd = 1 + Math.floor(rnd() * 3);
    const lines_s = [];
    const lines_r = [];
    let totReq = 0;
    for (let o = 0; o < nOrd; o++) {
      const pcs = 2 + Math.floor(rnd() * 30);
      totReq += pcs;
      lines_s.push(line('IT' + o, pcs, 0, 'PL' + o));
      lines_r.push(line('IT' + o, pcs, 0, 'PL' + o));
    }
    const d_s = [sup('S1', [material('M' + iter % 7, {
      fabricWidthCm: widthCm, cutWidth: cutW, requiredPieces: totReq,
      lines: lines_s, wasteStock: rem_s, lots: lots_s,
    })])];
    const d_r = [sup('S1', [material('M' + iter % 7, {
      fabricWidthCm: widthCm, cutWidth: cutW, requiredPieces: totReq,
      lines: lines_r, wasteStock: rem_r, lots: lots_r,
    })])];
    A_scalar.applyLotAllocation(d_s);
    A_rolls.applyLotAllocation(d_r);

    assertParity('G1 iter ' + iter, snapshotMaterial(d_s[0].materials[0]), snapshotMaterial(d_r[0].materials[0]));
  }
});

console.log('\n========================================');
console.log('allocator-rolls-parity: ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}
if (skipped > 0 && passed === 0) {
  console.log('  (parity baseline was unavailable — nothing compared)');
  process.exit(2);
}
