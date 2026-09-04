#!/usr/bin/env node
// Edge-case tests for applyFabricOverride and shortReasonFor in app/js/lot-allocator.js
// Covers single/multi-roll edits, clamping, zero/restore, fromRaw re-derivation,
// and shortReasonFor nofit/blocked/priority.
//
//   usage: node tools/allocator-edgecases-override.test.js  (do not run per task — just write)

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
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

// ---- fixture builders ----------------------------------------------------------
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

// helper to build a fabric material with autoLotLines via applyLotAllocation
function buildAutoMaterial(opts) {
  opts = opts || {};
  var rolls = opts.rolls || [{ length: 10 }];
  var lotId = opts.lotId || 'L1';
  var lotOpts = opts.lotOpts || {};
  var cutW = opts.cutW !== undefined ? opts.cutW : 55;
  var cutL = opts.cutL !== undefined ? opts.cutL : 100;
  var pcs = opts.pieces !== undefined ? opts.pieces : 8;
  var fabW = opts.fabricWidthCm !== undefined ? opts.fabricWidthCm : 55;
  var lot = rollLot(lotId, rolls, lotOpts);
  var matOpts = {
    fabricWidthCm: fabW, cutWidth: cutW, cutLength: cutL,
    requiredPieces: pcs,
    lines: opts.lines || [line(opts.planItemId || 'IT1', pcs, 0, opts.planId || 'PLAN1', cutW, cutL)],
    lots: opts.lots || [lot]
  };
  if (opts.wasteStock) matOpts.wasteStock = opts.wasteStock;
  if (opts.extraMats) Object.assign(matOpts, opts.extraMats);
  var mat = material(opts.materialId || 'M1', matOpts);
  A.applyLotAllocation([sup(opts.supervisorId || 'S1', [mat])]);
  return mat;
}

// =====================================================================
console.log('\nGROUP 1 - applyFabricOverride edge cases');

test('O1 Edit-down single-roll lot 10m auto 8m edit to 5m', () => {
  var mat = buildAutoMaterial({
    rolls: [{ label: 'L1-R1', length: 10 }],
    cutW: 55, cutL: 100, pieces: 8, fabricWidthCm: 55,
    lotId: 'L1'
  });
  // auto should be 8m (8 pieces * 1.0m per row, perRow=1)
  var autoQty = (mat.autoLotLines || []).reduce((t, ln) => t + (Number(ln.qty) || 0), 0);
  approx(autoQty, 8);
  approx(mat.autoLotLines[0].qty, 8);
  A.applyFabricOverride(mat, 'L1', 5);
  var ln = mat.lotLines.filter(l => String(l.lotId) === 'L1')[0];
  assert.ok(ln, 'lot line must exist after override');
  approx(ln.qty, 5);
  assert.ok(Array.isArray(ln.rolls), 'rolls must be array');
  assert.strictEqual(ln.rolls.length, 1);
  approx(ln.rolls[0].metres, 5);
  assert.strictEqual(ln.rolls[0].label, 'L1-R1');
});

test('O2 Edit-down multi-roll newest-first [5,5,20] 18m to 9m', () => {
  // cut 1.5m (150), perRow=1, 12 pieces => 18m drained shortest-first: 4.5+4.5+9
  var mat = buildAutoMaterial({
    rolls: [{ label: 'L1-R1', length: 5 }, { label: 'L1-R2', length: 5 }, { label: 'L1-R3', length: 20 }],
    cutW: 55, cutL: 150, pieces: 12, fabricWidthCm: 55,
    lotId: 'L1'
  });
  var autoQty = mat.autoLotLines.reduce((t, ln) => t + (Number(ln.qty) || 0), 0);
  approx(autoQty, 18);
  // verify drain order
  var autoLn = mat.autoLotLines[0];
  assert.strictEqual(autoLn.rolls.length, 3);
  approx(autoLn.rolls[0].metres, 4.5);
  approx(autoLn.rolls[1].metres, 4.5);
  approx(autoLn.rolls[2].metres, 9);
  A.applyFabricOverride(mat, 'L1', 9);
  var ln = mat.lotLines[0];
  approx(ln.qty, 9);
  // newest-first unwind: R1 and R2 keep full auto, R3 drops out
  assert.strictEqual(ln.rolls.length, 2, 'R3 should drop out when editing 18->9');
  assert.strictEqual(ln.rolls[0].label, 'L1-R1');
  approx(ln.rolls[0].metres, 4.5);
  assert.strictEqual(ln.rolls[1].label, 'L1-R2');
  approx(ln.rolls[1].metres, 4.5);
  // must NOT average to 3,3,3
  assert.ok(ln.rolls.every(r => r.metres !== 3), 'should not average across rolls');
});

test('O3 Edit-up within last roll cap rolls [5,10] auto 4.5 edit to 8 clamp at 5', () => {
  // rolls [5,10], demand 3 pieces of 1.5m => 4.5m auto, only R1 used (shortest 5 drained first)
  var mat = buildAutoMaterial({
    rolls: [{ label: 'L1-R1', length: 5 }, { label: 'L1-R2', length: 10 }],
    cutW: 55, cutL: 150, pieces: 3, fabricWidthCm: 55,
    lotId: 'L1'
  });
  var autoQty = mat.autoLotLines.reduce((t, ln) => t + (Number(ln.qty) || 0), 0);
  approx(autoQty, 4.5);
  assert.strictEqual(mat.autoLotLines[0].rolls.length, 1, 'only shortest roll should be used');
  assert.strictEqual(mat.autoLotLines[0].rolls[0].label, 'L1-R1');
  // edit up to 8m: only last used roll (R1 cap 5) can extend, so placed = min(8,5) =5
  A.applyFabricOverride(mat, 'L1', 8);
  var ln = mat.lotLines[0];
  approx(ln.qty, 5, 0.01);
  assert.strictEqual(ln.rolls.length, 1);
  assert.strictEqual(ln.rolls[0].label, 'L1-R1');
  approx(ln.rolls[0].metres, 5);
  // must NOT spill onto unused R2
  assert.ok(!ln.rolls.some(r => r.label === 'L1-R2'), 'must not open unused roll R2');
  var placed = ln.rolls.reduce((t, r) => t + r.metres, 0);
  approx(placed, 5);
});

test('O4 Edit-up beyond last roll cap rolls [5,5] auto 9 edit to 20 clamp at 9.5', () => {
  // rolls [5,5], demand 6 pieces 1.5m => 9m auto (4.5+4.5)
  var mat = buildAutoMaterial({
    rolls: [{ label: 'L1-R1', length: 5 }, { label: 'L1-R2', length: 5 }],
    cutW: 55, cutL: 150, pieces: 6, fabricWidthCm: 55,
    lotId: 'L1'
  });
  var autoQty = mat.autoLotLines.reduce((t, ln) => t + (Number(ln.qty) || 0), 0);
  approx(autoQty, 9);
  assert.strictEqual(mat.autoLotLines[0].rolls.length, 2);
  approx(mat.autoLotLines[0].rolls[0].metres, 4.5);
  approx(mat.autoLotLines[0].rolls[1].metres, 4.5);
  // edit to 20m: only last roll extends, clamped at cap 5 => 4.5 + 5 =9.5
  A.applyFabricOverride(mat, 'L1', 20);
  var ln = mat.lotLines[0];
  approx(ln.qty, 9.5, 0.01);
  assert.strictEqual(ln.rolls.length, 2);
  assert.strictEqual(ln.rolls[0].label, 'L1-R1');
  approx(ln.rolls[0].metres, 4.5);
  assert.strictEqual(ln.rolls[1].label, 'L1-R2');
  approx(ln.rolls[1].metres, 5);
  var placed = ln.rolls.reduce((t, r) => t + r.metres, 0);
  approx(placed, 9.5, 0.01);
  assert.ok(placed < 20, 'excess must be silently not issued');
});

test('O5 Edit to 0 produces empty rollAlloc and zero qty fromRaw', () => {
  var mat = buildAutoMaterial({
    rolls: [{ label: 'L1-R1', length: 10 }],
    cutW: 55, cutL: 100, pieces: 5, fabricWidthCm: 55,
    lotId: 'L1'
  });
  approx(mat.autoLotLines[0].qty, 5);
  A.applyFabricOverride(mat, 'L1', 0);
  var ln = mat.lotLines.filter(l => String(l.lotId) === 'L1')[0];
  approx(ln.qty, 0);
  assert.strictEqual(ln.rolls.length, 0, 'zero edit must produce empty rolls');
  assert.strictEqual(ln.fromRaw, 0);
});

test('O6 Edit to auto value restores original autoLotLines exactly', () => {
  var mat = buildAutoMaterial({
    rolls: [{ label: 'L1-R1', length: 5 }, { label: 'L1-R2', length: 5 }, { label: 'L1-R3', length: 20 }],
    cutW: 55, cutL: 150, pieces: 12, fabricWidthCm: 55,
    lotId: 'L1'
  });
  var autoCopy = JSON.parse(JSON.stringify(mat.autoLotLines));
  var autoQty = autoCopy.reduce((t, ln) => t + (Number(ln.qty) || 0), 0);
  // edit down then back to auto
  A.applyFabricOverride(mat, 'L1', 6);
  approx(mat.lotLines[0].qty, 6);
  assert.strictEqual(mat.metresEdited, true);
  A.applyFabricOverride(mat, 'L1', autoQty);
  assert.strictEqual(mat.lotLines.length, autoCopy.length);
  mat.lotLines.forEach((ln, i) => {
    approx(ln.qty, autoCopy[i].qty);
    assert.strictEqual(ln.rolls.length, autoCopy[i].rolls.length);
    ln.rolls.forEach((r, j) => {
      assert.strictEqual(r.rollId, autoCopy[i].rolls[j].rollId);
      assert.strictEqual(r.label, autoCopy[i].rolls[j].label);
      approx(r.metres, autoCopy[i].rolls[j].metres);
    });
    assert.strictEqual(ln.fromRaw, autoCopy[i].fromRaw);
    assert.strictEqual(ln.fromWaste, autoCopy[i].fromWaste);
  });
  assert.strictEqual(mat.metresEdited, false);
});

test('O7 fromRaw re-derivation after edit-down min(gross, owed - waste - other_lots)', () => {
  // fabricWidth 55 => perRow 1, cut 1.0m (100) => 1m per piece, gross == qty
  // owed 10, waste gives 2, fresh auto 8m, then edit down to 4m => gross 4, room 8 => give 4
  var lot = rollLot('L1', [{ label: 'L1-R1', length: 20 }]);
  // waste that yields 2 pieces of 55x100: width 110 (2 across), length 100 => 2 pieces per remnant? use width 55
  // simpler: single waste piece width 55 length 100 => 1 piece, but we use 2 pieces stock
  // Create wasteId W1 with 2 pieces available, cutW 55 cutL 100 => cap 1 per piece => 2 pieces total
  var waste = [{ wasteId: 'W1', width: 55, length: 100, pieces: 2, carton: 'C1', lot: 'L1', lotId: 'L1' }];
  // attach waste to lot via wasteStock
  var mat = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 100,
    requiredPieces: 10,
    lines: [line('IT1', 10, 0, 'PLAN1', 55, 100)],
    wasteStock: waste,
    lots: [lot]
  });
  // ensure lot knows waste
  lot.waste = waste.map(w => ({ wasteId: w.wasteId, width: w.width, length: w.length, pieces: w.pieces }));
  A.applyLotAllocation([sup('S1', [mat])]);
  // auto: waste covers 2, fresh covers 8 => 8m
  var autoLn = mat.autoLotLines[0];
  assert.ok(autoLn, 'auto lot line must exist');
  approx(autoLn.qty, 8);
  assert.strictEqual(autoLn.fromWaste, 2);
  assert.strictEqual(autoLn.fromRaw, 8);
  // edit down the lot to 4m
  A.applyFabricOverride(mat, 'L1', 4);
  var ln = mat.lotLines[0];
  approx(ln.qty, 4);
  assert.strictEqual(ln.rolls.length, 1);
  approx(ln.rolls[0].metres, 4);
  // gross = floor(4*100/100)=4 rows *1 =4 pieces, owed 10, waste 2, other 0 => room 8 => give min(4,8)=4
  assert.strictEqual(ln.fromRaw, 4);
  // also verify waste credit preserved via base: wasteBy still 2, so fromRaw capped correctly
  // second variant: edit down to 8 stays same
  A.applyFabricOverride(mat, 'L1', 8);
  approx(mat.lotLines[0].fromRaw, 8);
});

// =====================================================================
console.log('\nGROUP 2 - shortReasonFor edge cases');

test('O8 nofit reports longest roll not lot total rolls [10,10] wash20 demand 12', () => {
  var lot = rollLot('L1', [{ length: 10 }, { length: 10 }], { wash: 20 });
  var mat = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 1200,
    requiredPieces: 1, remaining: 12,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 1200)],
    lots: [lot]
  });
  var r = { lotLines: [], noFitSmallest: 12, pinnedDryLots: [], lotsUsed: [], noPieceData: false, washLots: [] };
  mat.washLots = [];
  mat.printBase = '';
  mat.printBaseLots = [];
  // ensure hasOwnStock true (lot has wash 20)
  mat.lots = [lot];
  var reason = A.shortReasonFor(mat, r, [lot]);
  assert.ok(reason, 'must return reason');
  assert.strictEqual(reason.kind, 'nofit');
  assert.strictEqual(reason.have, 10, 'have must be longest single roll 10, not lot total 20');
  assert.strictEqual(reason.need, 12);
});

test('O9 nofit skips blocked lots', () => {
  var blockedLot = rollLot('LB', [{ label: 'LB-R1', length: 20 }], { no: 'BLOCKED', wash: 20, blocked: true });
  blockedLot.lotId = 'LB'; blockedLot.lotNumber = 'BLOCKED'; blockedLot.blocked = true;
  var availLot = rollLot('LA', [{ label: 'LA-R1', length: 5 }], { no: 'AVAIL', wash: 5 });
  availLot.lotId = 'LA'; availLot.lotNumber = 'AVAIL';
  var mat = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 900,
    requiredPieces: 1, remaining: 9,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 900)],
    lots: [blockedLot, availLot]
  });
  mat.washLots = [];
  mat.printBase = '';
  mat.printBaseLots = [];
  mat.lots = [blockedLot, availLot];
  var r = { lotLines: [], noFitSmallest: 9, pinnedDryLots: [], lotsUsed: [], noPieceData: false };
  var reason = A.shortReasonFor(mat, r, [blockedLot, availLot]);
  assert.ok(reason);
  assert.strictEqual(reason.kind, 'nofit');
  assert.strictEqual(reason.lot, 'AVAIL');
  approx(reason.have, 5);
  assert.notStrictEqual(reason.have, 20, 'must not pick blocked lot longest 20');
});

test('O10 nofit skips Consumed rolls', () => {
  var lot = {
    lotId: 'L1', lotNumber: 'L1', blocked: false,
    wash: 25, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
    rolls: [
      { rollId: 'L1-R1', label: 'L1-R1', length: 20, status: 'Consumed', origin: 'Purchased' },
      { rollId: 'L1-R2', label: 'L1-R2', length: 5, status: 'Available', origin: 'Purchased' }
    ]
  };
  var mat = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 600,
    requiredPieces: 1, remaining: 6,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 600)],
    lots: [lot]
  });
  mat.washLots = [];
  mat.printBase = '';
  mat.printBaseLots = [];
  mat.lots = [lot];
  var r = { lotLines: [], noFitSmallest: 6, pinnedDryLots: [], lotsUsed: [], noPieceData: false };
  var reason = A.shortReasonFor(mat, r, [lot]);
  assert.ok(reason);
  assert.strictEqual(reason.kind, 'nofit');
  approx(reason.have, 5, 0.01);
  assert.notStrictEqual(reason.have, 20);
});

test('O11 All rolls Consumed nofit falls through to blocked/empty not nofit', () => {
  var consumedLot = {
    lotId: 'L1', lotNumber: 'L1', blocked: false,
    wash: 0, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
    rolls: [
      { rollId: 'L1-R1', label: 'L1-R1', length: 20, status: 'Consumed', origin: 'Purchased' },
      { rollId: 'L1-R2', label: 'L1-R2', length: 10, status: 'Consumed', origin: 'Purchased' }
    ]
  };
  var mat = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 600,
    requiredPieces: 1, remaining: 6,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 600)],
    lots: [consumedLot]
  });
  mat.washLots = [];
  mat.printBase = '';
  mat.printBaseLots = [];
  mat.lots = [consumedLot];
  var r = { lotLines: [], noFitSmallest: 6, pinnedDryLots: [], lotsUsed: [], noPieceData: false };
  var reason = A.shortReasonFor(mat, r, [consumedLot]);
  assert.ok(reason, 'must return fallback reason');
  assert.notStrictEqual(reason.kind, 'nofit', 'all Consumed must not return nofit');
  assert.ok(reason.kind === 'empty' || reason.kind === 'blocked' || reason.kind === 'nolots', 'must fall through to empty/blocked/nolots got ' + reason.kind);
  // with blocked lot present should fall to blocked
  var blockedLot = rollLot('LB', [{ length: 5 }], { no: 'BL', wash: 5, blocked: true });
  blockedLot.lotId = 'LB'; blockedLot.lotNumber = 'BL'; blockedLot.blocked = true;
  blockedLot.wash = 5;
  var mat2 = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 600,
    requiredPieces: 1, remaining: 6,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 600)],
    lots: [consumedLot, blockedLot]
  });
  mat2.washLots = [];
  mat2.printBase = '';
  mat2.printBaseLots = [];
  mat2.lots = [consumedLot, blockedLot];
  var reason2 = A.shortReasonFor(mat2, r, [consumedLot, blockedLot]);
  assert.ok(reason2);
  assert.strictEqual(reason2.kind, 'blocked', 'with blocked stock present should fall to blocked');
});

test('O12 Priority ordering pinnedDry beats wash beats nofit', () => {
  // common lots
  var lotA = rollLot('LA', [{ length: 5 }], { no: 'LA', wash: 5 });
  lotA.lotId = 'LA'; lotA.lotNumber = 'LA';
  var lotB = rollLot('LB', [{ length: 5 }], { no: 'LB', wash: 5 });
  lotB.lotId = 'LB'; lotB.lotNumber = 'LB';
  // case 1: pinnedDry + wash + nofit => pinnedDry wins
  var mat1 = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 900,
    requiredPieces: 1, remaining: 9,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 900)],
    lots: [lotA, lotB]
  });
  mat1.washLots = [{ lotId: 'LA', lotNumber: 'LA', rowQty: 5 }];
  mat1.printBase = '';
  mat1.printBaseLots = [];
  mat1.lots = [lotA, lotB];
  var lotsById = [lotA, lotB];
  // need lots to have at least wash figure for blocked check to not swallow
  var r1 = { lotLines: [], noFitSmallest: 9, pinnedDryLots: ['L9'], pinnedBlocked: false, lotsUsed: [], noPieceData: false };
  var reason1 = A.shortReasonFor(mat1, r1, lotsById);
  assert.ok(reason1);
  assert.strictEqual(reason1.kind, 'pinnedDry', 'pinnedDry must beat wash and nofit');
  // case 2: wash + nofit (no pinnedDry) => wash wins
  var mat2 = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 900,
    requiredPieces: 1, remaining: 9,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 900)],
    lots: [lotA, lotB]
  });
  mat2.washLots = [{ lotId: 'LA', lotNumber: 'LA', rowQty: 5 }];
  mat2.printBase = '';
  mat2.printBaseLots = [];
  mat2.lots = [lotA, lotB];
  var r2 = { lotLines: [], noFitSmallest: 9, pinnedDryLots: [], lotsUsed: [], noPieceData: false };
  var reason2 = A.shortReasonFor(mat2, r2, lotsById);
  assert.ok(reason2);
  assert.strictEqual(reason2.kind, 'wash', 'wash must beat nofit');
  // case 3: only nofit => nofit
  var mat3 = material('M1', {
    fabricWidthCm: 55, cutWidth: 55, cutLength: 900,
    requiredPieces: 1, remaining: 9,
    lines: [line('IT1', 1, 0, 'PLAN1', 55, 900)],
    lots: [lotA, lotB]
  });
  mat3.washLots = [];
  mat3.printBase = '';
  mat3.printBaseLots = [];
  mat3.lots = [lotA, lotB];
  var r3 = { lotLines: [], noFitSmallest: 9, pinnedDryLots: [], lotsUsed: [], noPieceData: false };
  var reason3 = A.shortReasonFor(mat3, r3, lotsById);
  assert.ok(reason3);
  assert.strictEqual(reason3.kind, 'nofit', 'nofit alone must be returned');
});

// =====================================================================
console.log('\n========================================');
console.log('allocator-edgecases-override: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg));
  process.exit(1);
}
