#!/usr/bin/env node
// Node port of the roll-sum check added to reconcileRawMaterial.dg and
// verifyLotSync.dg for lot-rolls-model.md Step 8.
//
// The invariant: for a lot with any Lot_Rolls rows at all,
//   Σ Lot_Rolls.Roll_Length == Wash_Quantity + Unwash_Quantity + In_Wash_Qty
// (rolls are only cloth still on the shelf - In_Transit_Qty and
// Disputed_Qty have left it and are deliberately excluded, same split the
// existing piece-versus-lot check already makes).
//
// A lot with ZERO Lot_Rolls rows is skipped, not reported - that is a
// migration-coverage gap (never seeded/backfilled), not drift.
//
//   usage: node tools/reconcile-roll-sum.test.js

function rollGapFor(lot) {
  // lot: { wash, unwash, inWash, rolls: [{length}, ...] }
  if (!lot.rolls || lot.rolls.length === 0) return null; // skipped, not checked
  const rollSum = round2(lot.rolls.reduce((t, r) => t + r.length, 0));
  const shelfExpect = round2(lot.wash + lot.unwash + lot.inWash);
  const gap = round2(rollSum - shelfExpect);
  return { rollSum, shelfExpect, gap, broken: Math.abs(gap) > 0.005 };
}
function round2(n) { return Math.round(n * 100) / 100; }

const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

test('A rolls sum matches shelf exactly -> not broken', () => {
  const r = rollGapFor({ wash: 10, unwash: 5, inWash: 0, rolls: [{ length: 10 }, { length: 5 }] });
  assert.strictEqual(r.broken, false);
  assert.strictEqual(r.gap, 0);
});

test('B In_Wash counts toward the shelf side (still a roll, per the doc)', () => {
  const r = rollGapFor({ wash: 0, unwash: 0, inWash: 8, rolls: [{ length: 8 }] });
  assert.strictEqual(r.broken, false);
});

test('C In_Transit and Disputed are excluded from the invariant entirely', () => {
  // Roll sum reflects only what is still on the shelf - a lot with cloth
  // out on issue/dispute still balances as long as the ON-SHELF rolls match
  // the ON-SHELF wash columns.
  const r = rollGapFor({ wash: 4, unwash: 0, inWash: 0, rolls: [{ length: 4 }] });
  assert.strictEqual(r.broken, false, 'in-transit/disputed metres are not part of this check at all');
});

test('D a real drift is caught (roll sum short of the wash columns)', () => {
  const r = rollGapFor({ wash: 10, unwash: 0, inWash: 0, rolls: [{ length: 7 }] });
  assert.strictEqual(r.broken, true);
  assert.strictEqual(r.gap, -3);
});

test('E a real drift is caught (roll sum over the wash columns)', () => {
  const r = rollGapFor({ wash: 5, unwash: 0, inWash: 0, rolls: [{ length: 5 }, { length: 2 }] });
  assert.strictEqual(r.broken, true);
  assert.strictEqual(r.gap, 2);
});

test('F a lot with NO Lot_Rolls rows at all is skipped, not reported', () => {
  const r = rollGapFor({ wash: 10, unwash: 0, inWash: 0, rolls: [] });
  assert.strictEqual(r, null, 'no rolls at all -> migration gap, not drift');
});

test('G rounding tolerance of 0.005 absorbs float noise, not real drift', () => {
  const r1 = rollGapFor({ wash: 10, unwash: 0, inWash: 0, rolls: [{ length: 10.004 }] });
  assert.strictEqual(r1.broken, false, 'within tolerance');
  const r2 = rollGapFor({ wash: 10, unwash: 0, inWash: 0, rolls: [{ length: 10.006 }] });
  assert.strictEqual(r2.broken, true, 'just outside tolerance');
});

test('H a Consumed (0-length) roll still counts toward the sum - status does not exclude it', () => {
  const r = rollGapFor({ wash: 5, unwash: 0, inWash: 0, rolls: [{ length: 0 }, { length: 5 }] });
  assert.strictEqual(r.broken, false, 'zero-length rolls contribute zero, which is correct - never excluded');
});

console.log('\n' + '='.repeat(40));
console.log('reconcile-roll-sum: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
