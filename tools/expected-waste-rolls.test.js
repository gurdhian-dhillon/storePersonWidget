#!/usr/bin/env node
// Node port of getExpectedWaste.dg's Pass 2, before and after lot-rolls-
// model.md's Step 4 change (one tail per ROLL, not per lot).
//
//   usage: node tools/expected-waste-rolls.test.js
//
// getExpectedWaste is Deluge, so nothing here runs the real function - this
// mirrors the arithmetic by hand, the same way tools/deluge-maths.test.js
// covers issueMaterials. Two things are pinned:
//   A. PARITY - a lot with exactly one roll = its old scalar must produce
//      byte-identical output to the pre-Step-4 lot-only logic.
//   B. MULTI-ROLL - hand-worked cases: N rolls on one lot must yield N side-
//      strip/partial-row tails, not one, in DRAIN ORDER, with a genuine
//      partial row landing on whichever roll the demand actually runs out
//      on (never split across two).
//
// If deluge/getExpectedWaste.dg's Pass 2 changes, re-verify this port still
// matches it statement for statement before trusting either side.

function floor(n) { return Math.floor(n); }

// ---- OLD (pre-Step-4): one tail per LOT --------------------------------
function pass2Old({ remain, fabricWidthCm, cutW, cutL, lotList, lotQtyByKey, matId }) {
  const perRowR = floor(fabricWidthCm / cutW);
  const sideWR = fabricWidthCm - (perRowR * cutW);
  const gen = [];
  let freshCm = 0;

  for (const lotCut of lotList) {
    if (remain <= 0) break;
    let pcsHere = remain;
    if (lotCut !== '') {
      const lq = lotQtyByKey[matId + '|' + lotCut] || 0;
      const rowsHere = floor((lq * 100) / cutL);
      pcsHere = perRowR * rowsHere;
      if (pcsHere > remain) pcsHere = remain;
    }
    if (pcsHere > 0) {
      const fullRowsR = floor(pcsHere / perRowR);
      const lastRowR = pcsHere - (fullRowsR * perRowR);
      const rawRows = fullRowsR + (lastRowR > 0 ? 1 : 0);
      freshCm += rawRows * cutL;
      if (fullRowsR > 0 && sideWR > 0) {
        gen.push({ width: sideWR, length: fullRowsR * cutL, count: 1, origin: 'side', lot: lotCut });
      }
      if (lastRowR > 0) {
        const partWR = fabricWidthCm - (lastRowR * cutW);
        if (partWR > 0) gen.push({ width: partWR, length: cutL, count: 1, origin: 'partial_row', lot: lotCut });
      }
      remain -= pcsHere;
    }
  }
  return { gen, freshCm, remain };
}

// ---- NEW (Step 4): one tail per ROLL, nested inside each lot -----------
function pass2New({ remain, fabricWidthCm, cutW, cutL, lotList, lotQtyByKey, rollSeqByKey, rollQtyByKey, matId }) {
  const perRowR = floor(fabricWidthCm / cutW);
  const sideWR = fabricWidthCm - (perRowR * cutW);
  const gen = [];
  let freshCm = 0;

  for (const lotCut of lotList) {
    if (remain <= 0) break;
    const rollSeqTxt = lotCut !== '' ? (rollSeqByKey[matId + '|' + lotCut] || '') : '';
    const rollList = rollSeqTxt !== '' ? rollSeqTxt.split('~') : [''];

    for (const rollCut of rollList) {
      if (remain <= 0) break;
      let pcsHere = remain;
      if (rollCut !== '') {
        const rq = rollQtyByKey[matId + '|' + lotCut + '|' + rollCut] || 0;
        const rowsHere = floor((rq * 100) / cutL);
        pcsHere = perRowR * rowsHere;
        if (pcsHere > remain) pcsHere = remain;
      } else if (lotCut !== '') {
        const lq = lotQtyByKey[matId + '|' + lotCut] || 0;
        const rowsHere = floor((lq * 100) / cutL);
        pcsHere = perRowR * rowsHere;
        if (pcsHere > remain) pcsHere = remain;
      }
      if (pcsHere > 0) {
        const fullRowsR = floor(pcsHere / perRowR);
        const lastRowR = pcsHere - (fullRowsR * perRowR);
        const rawRows = fullRowsR + (lastRowR > 0 ? 1 : 0);
        freshCm += rawRows * cutL;
        if (fullRowsR > 0 && sideWR > 0) {
          gen.push({ width: sideWR, length: fullRowsR * cutL, count: 1, origin: 'side', lot: lotCut, roll: rollCut });
        }
        if (lastRowR > 0) {
          const partWR = fabricWidthCm - (lastRowR * cutW);
          if (partWR > 0) gen.push({ width: partWR, length: cutL, count: 1, origin: 'partial_row', lot: lotCut, roll: rollCut });
        }
        remain -= pcsHere;
      }
    }
  }
  return { gen, freshCm, remain };
}

const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- Case A: PARITY - one roll per lot = old scalar behaviour exactly ----
test('A1 single lot, one roll = its scalar -> byte-identical to old', () => {
  const common = { remain: 20, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: ['L1'], matId: 'M1' };
  const oldR = pass2Old({ ...common, lotQtyByKey: { 'M1|L1': 18.0 } });
  const newR = pass2New({
    ...common,
    lotQtyByKey: { 'M1|L1': 18.0 },
    rollSeqByKey: { 'M1|L1': 'L1-R1' },
    rollQtyByKey: { 'M1|L1|L1-R1': 18.0 }
  });
  assert.strictEqual(newR.freshCm, oldR.freshCm);
  assert.strictEqual(newR.remain, oldR.remain);
  assert.strictEqual(JSON.stringify(newR.gen.map(g => ({ w: g.width, l: g.length, c: g.count, o: g.origin }))),
    JSON.stringify(oldR.gen.map(g => ({ w: g.width, l: g.length, c: g.count, o: g.origin }))));
});

test('A2 two lots, one roll each = old scalar -> byte-identical to old', () => {
  const common = { remain: 40, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: ['L1', 'L2'], matId: 'M1' };
  const lotQty = { 'M1|L1': 18.0, 'M1|L2': 20.0 };
  const oldR = pass2Old({ ...common, lotQtyByKey: lotQty });
  const newR = pass2New({
    ...common,
    lotQtyByKey: lotQty,
    rollSeqByKey: { 'M1|L1': 'L1-R1', 'M1|L2': 'L2-R1' },
    rollQtyByKey: { 'M1|L1|L1-R1': 18.0, 'M1|L2|L2-R1': 20.0 }
  });
  assert.strictEqual(newR.freshCm, oldR.freshCm);
  assert.strictEqual(newR.remain, oldR.remain);
  assert.deepStrictEqual(newR.gen.map(g => g.origin), oldR.gen.map(g => g.origin));
});

test('A3 no lot at all (pre-lot data) -> falls through to nameless pass, identical', () => {
  const common = { remain: 20, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: [''], matId: 'M1' };
  const oldR = pass2Old({ ...common, lotQtyByKey: {} });
  const newR = pass2New({ ...common, lotQtyByKey: {}, rollSeqByKey: {}, rollQtyByKey: {} });
  assert.strictEqual(newR.freshCm, oldR.freshCm);
  assert.strictEqual(newR.remain, oldR.remain);
});

// ---- Case B: MULTI-ROLL, hand-worked ----
test('B1 one lot, TWO rolls (30m + 20m), demand needs both -> TWO tails not one', () => {
  // 150cm fabric, cut 55x90. perRow = floor(150/55) = 2. sideW = 150-110=40.
  // Roll A: 30m -> 3000cm / 90 = 33.33 -> floor 33 rows -> 66 pieces.
  // Roll B: 20m -> 2000cm / 90 = 22.22 -> floor 22 rows -> 44 pieces.
  // Demand: remain = 100 pieces (needs both rolls in full since 66+44=110 >= 100)
  const r = pass2New({
    remain: 100, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: ['L1'], matId: 'M1',
    lotQtyByKey: { 'M1|L1': 50.0 },
    rollSeqByKey: { 'M1|L1': 'L1-R1~L1-R2' },
    rollQtyByKey: { 'M1|L1|L1-R1': 30.0, 'M1|L1|L1-R2': 20.0 }
  });
  // Roll A gives min(66, 100) = 66 pieces -> fullRows = floor(66/2) = 33, lastRow = 0.
  //   side strip: 33 rows * 90 = 2970cm, width 40. No partial row (lastRow=0).
  const sideEntries = r.gen.filter(g => g.origin === 'side');
  assert.strictEqual(sideEntries.length, 2, 'expected TWO side-strip tails, one per roll: ' + JSON.stringify(r.gen));
  assert.strictEqual(sideEntries[0].roll, 'L1-R1');
  assert.strictEqual(sideEntries[0].length, 33 * 90);
  // remain after roll A: 100 - 66 = 34. Roll B gives min(44, 34) = 34 pieces
  //   -> fullRows = floor(34/2) = 17, lastRow = 0 (34 is exactly divisible by 2)
  assert.strictEqual(sideEntries[1].roll, 'L1-R2');
  assert.strictEqual(sideEntries[1].length, 17 * 90);
  assert.strictEqual(r.remain, 0);
  assert.strictEqual(r.freshCm, (33 * 90) + (17 * 90));
});

test('B2 one lot, TWO rolls, demand runs out mid-second-roll -> partial row on the SECOND roll only', () => {
  // Same setup, but demand = 68 pieces: roll A gives min(66,68)=66 (uses all of roll A, no partial),
  // remain=2 after roll A. Roll B: rowsHere = floor(2000/90)=22, capacity 44, but pcsHere=min(44,2)=2.
  // fullRows = floor(2/2) = 1, lastRow = 0. So roll B gets ONE full row, no partial - because 2 is
  // exactly perRow(2)*1.
  const r = pass2New({
    remain: 68, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: ['L1'], matId: 'M1',
    lotQtyByKey: { 'M1|L1': 50.0 },
    rollSeqByKey: { 'M1|L1': 'L1-R1~L1-R2' },
    rollQtyByKey: { 'M1|L1|L1-R1': 30.0, 'M1|L1|L1-R2': 20.0 }
  });
  const sideEntries = r.gen.filter(g => g.origin === 'side');
  assert.strictEqual(sideEntries.length, 2);
  assert.strictEqual(sideEntries[1].roll, 'L1-R2');
  assert.strictEqual(sideEntries[1].length, 1 * 90);
  assert.strictEqual(r.remain, 0);
});

test('B3 one lot, TWO rolls, demand leaves a genuine PARTIAL row on roll 2', () => {
  // demand = 67: roll A gives 66 (all of it, exact rows, no partial). remain=1 after roll A.
  // roll B: pcsHere = min(44,1) = 1. fullRows=floor(1/2)=0, lastRow=1-0=1 -> ONE partial row.
  const r = pass2New({
    remain: 67, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: ['L1'], matId: 'M1',
    lotQtyByKey: { 'M1|L1': 50.0 },
    rollSeqByKey: { 'M1|L1': 'L1-R1~L1-R2' },
    rollQtyByKey: { 'M1|L1|L1-R1': 30.0, 'M1|L1|L1-R2': 20.0 }
  });
  const partials = r.gen.filter(g => g.origin === 'partial_row');
  assert.strictEqual(partials.length, 1, JSON.stringify(r.gen));
  assert.strictEqual(partials[0].roll, 'L1-R2');
  // partWR = 150 - (1*55) = 95
  assert.strictEqual(partials[0].width, 95);
  assert.strictEqual(partials[0].length, 90);
  assert.strictEqual(r.remain, 0);
});

test('B4 TWO lots, each with TWO rolls -> FOUR tails total, oldest-lot-first, drain-order-within-lot', () => {
  const r = pass2New({
    remain: 200, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: ['L1', 'L2'], matId: 'M1',
    lotQtyByKey: { 'M1|L1': 50.0, 'M1|L2': 50.0 },
    rollSeqByKey: { 'M1|L1': 'L1-R1~L1-R2', 'M1|L2': 'L2-R1~L2-R2' },
    rollQtyByKey: {
      'M1|L1|L1-R1': 30.0, 'M1|L1|L1-R2': 20.0,
      'M1|L2|L2-R1': 30.0, 'M1|L2|L2-R2': 20.0
    }
  });
  const sideEntries = r.gen.filter(g => g.origin === 'side');
  assert.strictEqual(sideEntries.length, 4, JSON.stringify(r.gen));
  assert.deepStrictEqual(sideEntries.map(g => g.roll), ['L1-R1', 'L1-R2', 'L2-R1', 'L2-R2']);
});

test('B5 roll data MISSING for one lot (pre-Step-4 row) falls back to lot-only for that lot alone', () => {
  const r = pass2New({
    remain: 66, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: ['L1'], matId: 'M1',
    lotQtyByKey: { 'M1|L1': 30.0 },
    rollSeqByKey: {},   // no roll breakdown recorded for L1
    rollQtyByKey: {}
  });
  const oldR = pass2Old({
    remain: 66, fabricWidthCm: 150, cutW: 55, cutL: 90, lotList: ['L1'], matId: 'M1',
    lotQtyByKey: { 'M1|L1': 30.0 }
  });
  assert.strictEqual(r.freshCm, oldR.freshCm);
  assert.strictEqual(r.remain, oldR.remain);
});

console.log('\n' + '='.repeat(40));
console.log('getExpectedWaste-pass2-port: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
