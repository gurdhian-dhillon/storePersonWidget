#!/usr/bin/env node
// Edge-case tests for lotFill in app/js/lot-allocator.js (unit).
// Covers consumed/zero-length filtering, case sensitivity, empty rolls,
// blocked, greige gate, cut wider than fabric, zero cutL, lexicographic
// tie-break, multi-demand sharing, remnant+roll gate bounding, wash gate
// exhaustion.
//   usage: node tools/allocator-edgecases-lotfill.test.js

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
vm.runInContext(src + '\nthis.A = { round2, remnantYield, perRowFor, lotFill };', ctx);
const A = ctx.A;

// ---- helpers ------------------------------------------------------------------
function makeLot(opts) {
  opts = opts || {};
  return {
    wash: opts.wash !== undefined ? opts.wash : 0,
    unwash: opts.unwash !== undefined ? opts.unwash : 0,
    inWash: opts.inWash !== undefined ? opts.inWash : 0,
    blocked: !!opts.blocked,
    rolls: opts.rolls || [],
    waste: opts.waste || []
  };
}
function roll(rollId, label, length, status) {
  return { rollId: rollId, label: label, length: length, status: status || 'Available' };
}
function waste(wasteId, w, l, pcs) {
  return { wasteId: wasteId, width: w, length: l, pieces: pcs };
}

// =====================================================================
console.log('\nlotFill edge cases (12)');

test('1 Consumed roll filtering — only Available counts', () => {
  // wash 20 but only 10 m of Available rolls; demand 15 pieces @ 1m/row needs 15m
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 20,
    rolls: [
      roll('R1', 'R1', 10, 'Consumed'),
      roll('R2', 'R2', 10, 'Available')
    ]
  });
  const demands = [{ cutW: 55, cutL: 100, pieces: 15 }]; // perRow 1, 1m per row
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, false, 'only 10 m Available should not cover 15 pieces');
  approx(f.freshMetres, 10);
  assert.strictEqual(f.fromFresh[0], 10);
  assert.strictEqual(f.shortBy, 5);
  // the Consumed roll must not appear drained
  const after = f.rollsAfter;
  assert.strictEqual(after.length, 1, 'Consumed roll filtered from working copy');
  assert.strictEqual(after[0].label, 'R2');
});

test('2 Zero-length roll ignored — only 10m roll counts', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 12,
    rolls: [
      roll('R1', 'R1', 0, 'Available'),
      roll('R2', 'R2', 10, 'Available')
    ]
  });
  const demands = [{ cutW: 55, cutL: 100, pieces: 12 }]; // needs 12m
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, false, 'zero-length roll must not contribute');
  approx(f.freshMetres, 10);
  assert.strictEqual(f.fromFresh[0], 10);
  assert.strictEqual(f.shortBy, 2);
  assert.strictEqual(f.rollsAfter.length, 1);
  assert.strictEqual(f.rollsAfter[0].label, 'R2');
});

test('3 Lowercase consumed status — case-sensitive, not filtered (current behaviour)', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 10,
    rolls: [roll('R1', 'R1', 10, 'consumed')] // lowercase
  });
  const demands = [{ cutW: 55, cutL: 100, pieces: 5 }]; // needs 5m
  const f = A.lotFill(lot, demands, fab, false);
  // Current code does String(status) !== 'Consumed' — lowercase passes filter
  assert.strictEqual(f.covers, true, 'lowercase consumed should still be counted (case-sensitive)');
  approx(f.freshMetres, 5);
  assert.strictEqual(f.fromFresh[0], 5);
  assert.strictEqual(f.shortBy, 0);
  assert.strictEqual(f.rollsAfter.length, 1);
  approx(f.rollsAfter[0].length, 5); // 10 - 5
});

test('4 Empty rolls array — covers false unless waste covers', () => {
  const fab = { fabricWidthCm: 55 };
  // without waste: impossible
  const lotEmpty = makeLot({ wash: 10, rolls: [] });
  const demands = [{ cutW: 55, cutL: 55, pieces: 5 }];
  const f0 = A.lotFill(lotEmpty, demands, fab, false);
  assert.strictEqual(f0.covers, false);
  approx(f0.freshMetres, 0);
  assert.strictEqual(f0.shortBy, 5);
  assert.strictEqual(f0.fromFresh[0], 0);
  assert.strictEqual(f0.rollsAfter.length, 0);

  // with waste that alone covers the demand: 120x115 yields floor(120/55)=2 * floor(115/55)=2 =4 per piece
  // use 2 pieces of waste -> 8 capacity, demand 5 -> covered without rolls
  const lotWithWaste = makeLot({
    wash: 10,
    rolls: [],
    waste: [waste('W1', 120, 115, 2)]
  });
  const f1 = A.lotFill(lotWithWaste, demands, fab, false);
  assert.strictEqual(f1.covers, true, 'waste alone should cover when rolls empty');
  assert.strictEqual(f1.fromWaste[0], 5);
  assert.strictEqual(f1.fromFresh[0], 0);
  approx(f1.freshMetres, 0);
  assert.strictEqual(f1.shortBy, 0);
});

test('5 Blocked status lot — lotFill does NOT check blocked (caller does)', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 10,
    blocked: true,
    rolls: [roll('R1', 'R1', 10, 'Available')]
  });
  const demands = [{ cutW: 55, cutL: 100, pieces: 5 }];
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, true, 'blocked lot must still allocate inside lotFill');
  approx(f.freshMetres, 5);
  assert.strictEqual(f.fromFresh[0], 5);
});

test('6 Greige mode — wash=5 unwash=10 inWash=5 demand needs 12m', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 5, unwash: 10, inWash: 5,
    rolls: [roll('R1', 'R1', 20, 'Available')]
  });
  // perRow 1 (55/55), cutL 150 => 1.5m per row, 8 pieces => 12m (8 rows)
  const demands = [{ cutW: 55, cutL: 150, pieces: 8 }];
  const fToday = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(fToday.covers, false, 'wash 5 cannot cover 12m today');
  assert.ok(fToday.shortBy > 0);
  approx(fToday.freshMetres, 4.5); // floor(500/150)=3 rows *1.5
  assert.strictEqual(fToday.fromFresh[0], 3);

  const fGreige = A.lotFill(lot, demands, fab, true);
  assert.strictEqual(fGreige.covers, true, 'wash+greige 20 should cover 12m');
  approx(fGreige.freshMetres, 12);
  assert.strictEqual(fGreige.fromFresh[0], 8);
  assert.strictEqual(fGreige.shortBy, 0);
});

test('7 Cut wider than fabric — perRow 0 demand skipped, covers false', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 10,
    rolls: [roll('R1', 'R1', 10, 'Available')]
  });
  const demands = [{ cutW: 60, cutL: 55, pieces: 5 }]; // cutW 60 > fabric 55
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, false);
  approx(f.freshMetres, 0);
  assert.strictEqual(f.fromFresh[0], 0);
  assert.strictEqual(f.shortBy, 5);
  // also perRowFor itself
  assert.strictEqual(A.perRowFor(fab, 60), 0);
});

test('8 Zero cutL — demand skipped', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 10,
    rolls: [roll('R1', 'R1', 10, 'Available')]
  });
  const demands = [{ cutW: 55, cutL: 0, pieces: 5 }];
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, false);
  approx(f.freshMetres, 0);
  assert.strictEqual(f.fromFresh[0], 0);
  assert.strictEqual(f.shortBy, 5);
});

test('9 Lexicographic label tie-break — R10 drains before R2', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 10,
    rolls: [
      roll('R10', 'R10', 5, 'Available'),
      roll('R2', 'R2', 5, 'Available')
    ]
  });
  // perRow 1, cutL 150 => 1.5m per row, 2 pieces => 2 rows => 3.0m (spec says 3.33m approx)
  const demands = [{ cutW: 55, cutL: 150, pieces: 2 }];
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, true);
  approx(f.freshMetres, 3.0);
  assert.strictEqual(f.fromFresh[0], 2);
  // shortest-first with lexicographic tie-break: R10 before R2
  assert.ok(f.rollLinesPer[0].length >= 1, 'should have rollLines');
  assert.strictEqual(f.rollLinesPer[0][0].label, 'R10', 'R10 must drain before R2 lexicographically');
  approx(f.rollLinesPer[0][0].metres, 3.0);
  // rollsAfter sorted lex tie-break as well: R10 first, now 2m left; R2 still 5m
  assert.strictEqual(f.rollsAfter[0].label, 'R10');
  approx(f.rollsAfter[0].length, 2.0);
  assert.strictEqual(f.rollsAfter[1].label, 'R2');
  approx(f.rollsAfter[1].length, 5.0);
});

test('10 Multiple demands sharing rolls — first takes most of shortest, second gets remainder + next', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 20,
    rolls: [
      roll('R1', 'R1', 5, 'Available'),
      roll('R2', 'R2', 10, 'Available')
    ]
  });
  // perRow 1, cutL 100 => 1m per row
  // d0: 4 pieces => 4m, d1: 2 pieces => 2m
  const demands = [
    { cutW: 55, cutL: 100, pieces: 4 },
    { cutW: 55, cutL: 100, pieces: 2 }
  ];
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, true);
  approx(f.freshMetres, 6.0);
  assert.strictEqual(f.fromFresh[0], 4);
  assert.strictEqual(f.fromFresh[1], 2);
  approx(f.metresPer[0], 4.0);
  approx(f.metresPer[1], 2.0);
  // first demand consumes 4m from R1 leaving 1m
  assert.strictEqual(f.rollLinesPer[0].length, 1);
  assert.strictEqual(f.rollLinesPer[0][0].label, 'R1');
  approx(f.rollLinesPer[0][0].metres, 4.0);
  // second demand straddles remainder of R1 + 1m from R2
  assert.strictEqual(f.rollLinesPer[1].length, 2, 'second demand should split across two rolls');
  assert.strictEqual(f.rollLinesPer[1][0].label, 'R1');
  approx(f.rollLinesPer[1][0].metres, 1.0);
  assert.strictEqual(f.rollLinesPer[1][1].label, 'R2');
  approx(f.rollLinesPer[1][1].metres, 1.0);
  // rollsAfter reflects drained lengths
  assert.strictEqual(f.rollsAfter[0].label, 'R1');
  approx(f.rollsAfter[0].length, 0.0);
  assert.strictEqual(f.rollsAfter[1].label, 'R2');
  approx(f.rollsAfter[1].length, 9.0);
});

test('11 Remnant + roll interaction — remnant covers part, rolls cover rest, gate still bounds', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 5,
    rolls: [roll('R1', 'R1', 10, 'Available')],
    waste: [waste('W1', 120, 115, 1)] // yields 4 pieces of 55x55
  });
  const demands = [{ cutW: 55, cutL: 55, pieces: 10 }]; // perRow 1, 0.55m per row
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, true);
  assert.strictEqual(f.fromWaste[0], 4, 'remnant should cover 4 pieces');
  assert.strictEqual(f.fromFresh[0], 6, 'rolls should cover remaining 6 pieces');
  approx(f.freshMetres, 3.3); // 6 * 0.55
  approx(f.metresPer[0], 3.3);
  assert.ok(f.freshMetres <= 5 + 1e-9, 'gate 5m must bound fresh metres even after remnant');
  assert.strictEqual(f.picks['W1'], 1);
  assert.strictEqual(f.shortBy, 0);
});

test('12 Wash gate exhaustion mid-demand — wash 3 demand needs 6m rolls have 10m -> only 2 rows placed', () => {
  const fab = { fabricWidthCm: 55 };
  const lot = makeLot({
    wash: 3,
    rolls: [roll('R1', 'R1', 10, 'Available')]
  });
  // perRow 1, cutL 150 => 1.5m per row, 4 pieces => 4 rows => 6m needed
  const demands = [{ cutW: 55, cutL: 150, pieces: 4 }];
  const f = A.lotFill(lot, demands, fab, false);
  assert.strictEqual(f.covers, false);
  // gate 3 allows floor(300/150)=2 rows => 3m => 2 pieces
  approx(f.freshMetres, 3.0);
  assert.strictEqual(f.fromFresh[0], 2);
  assert.strictEqual(f.shortBy, 2);
  assert.strictEqual(f.rollLinesPer[0].length, 1);
  approx(f.rollLinesPer[0][0].metres, 3.0);
  approx(f.rollsAfter[0].length, 7.0); // 10 - 3
});

console.log('\n========================================');
console.log('allocator-edgecases-lotfill: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
