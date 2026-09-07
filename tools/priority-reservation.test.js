#!/usr/bin/env node
// Phase B, Piece 3 — STOCK IS RESERVED DOWN THE PRIORITY ORDER.
//
// The five ledgers (wasteLeft / lotLeft / greigeLeft / pieceLeft / rollLeft) are
// now seeded ONCE from the whole rack and drained across every card in array
// order, instead of being re-seeded per supervisor. Array order IS priority
// order; render() arranges it.
//
// THIS IS NOT A PARITY STEP, and that is deliberate. Sharing the ledger is the
// feature — it MUST change card 2+'s numbers whenever there is contention. So
// this suite asserts three things instead of "identical to before":
//
//   1. NO CONTENTION  -> nothing changes. Enough for everyone, everyone served.
//   2. CONTENTION     -> correctly reserved, and reordering flips who is short.
//   3. CONSERVATION   -> the cards together never promise more than the rack
//                        holds, per material and per roll. Never over-promise.
//
//   usage: node tools/priority-reservation.test.js

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
  eps = eps === undefined ? 0.01 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + '+/-' + eps + ', got ' + a);
}

// ---- load the allocator --------------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const ctx = { console, Math, Number, Object, String, Array, JSON };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.A = { applyLotAllocation, lotFill, round2,\n  clearOverrides: function () { for (var k in lotOverrides) delete lotOverrides[k]; },\n  clearDeclined: function () { for (var k in wasteDeclined) delete wasteDeclined[k]; } };', ctx);
const A = ctx.A;

// ---- fixtures ------------------------------------------------------------------
// perRow 1 (width == cutW), cut 0.50 m, so metres and pieces map 1:2 cleanly:
// 10 pieces = 10 rows = 5.00 m.
function line(planItemId, reqPcs, planId) {
  return { planId: planId || 'PLAN1', planItemId, mrqId: planItemId + '-m',
           reqPieces: reqPcs, issPieces: 0, cutW: 55, cutL: 50,
           issuedLot: '', issuedLotNo: '', item: 'X', isRemake: false };
}
function lotWith(lotId, metres) {
  return {
    lotId: lotId, lotNumber: lotId, blocked: false,
    wash: metres, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
    rolls: [{ rollId: lotId + '-R1', label: lotId + '-R1', length: metres,
              status: 'Available', origin: 'Purchased' }]
  };
}
function material(materialId, m) {
  return Object.assign({
    materialId: materialId, isFabric: true, sku: 'FAB', unit: 'Mtr',
    fabricWidthCm: 55, cutWidth: 55, cutLength: 50,
    requiredPieces: 0, issuedPieces: 0, outstandingPieces: 0,
    freshMeters: 0, remaining: 0, availableStock: 0,
    lines: [], wasteStock: [], lots: [], openExceptions: []
  }, m);
}
function sup(id, mats) { return { supervisorId: id, supervisorName: id, materials: mats }; }

// One supervisor wanting `pieces` of M1, against a shared lot of `rackMetres`.
// Every card gets its OWN lot object carrying the SAME figures — which is what
// the server really sends: the true rack, repeated per card.
function card(id, pieces, rackMetres) {
  return sup(id, [material('M1', {
    requiredPieces: pieces,
    lines: [line('IT-' + id, pieces, 'PLAN-' + id)],
    lots: [lotWith('L1', rackMetres)]
  })]);
}

function servedMetres(supBlock) {
  return (supBlock.materials[0].lotLines || [])
    .reduce(function (t, ln) { return t + (Number(ln.qty) || 0); }, 0);
}
function outcomeWhy(supBlock) {
  var o = (supBlock.materials[0].orderOutcomes || [])[0];
  return o ? o.why : '(none)';
}

// =====================================================================
console.log('\n1 — NO CONTENTION: nothing changes');

test('N1 enough for everyone -> every card served in full', () => {
  // 100 m rack. Three cards wanting 10 / 10 / 10 pieces = 5 m each = 15 m total.
  // Nobody is short, so the reservation is invisible.
  const data = [card('S1', 10, 100), card('S2', 10, 100), card('S3', 10, 100)];
  A.applyLotAllocation(data);
  data.forEach(function (s) {
    approx(servedMetres(s), 5.00);
    assert.strictEqual(outcomeWhy(s), 'ready', s.supervisorId + ' should be served');
  });
});

test('N2 exactly enough -> still everyone served, nothing left over', () => {
  // 15 m rack, three cards wanting 5 m each. The last card gets the last metre.
  const data = [card('S1', 10, 15), card('S2', 10, 15), card('S3', 10, 15)];
  A.applyLotAllocation(data);
  data.forEach(function (s) {
    approx(servedMetres(s), 5.00);
    assert.strictEqual(outcomeWhy(s), 'ready');
  });
  approx(data.reduce(function (t, s) { return t + servedMetres(s); }, 0), 15.00);
});

test('N3 a single card is unaffected by the hoist', () => {
  const data = [card('S1', 10, 100)];
  A.applyLotAllocation(data);
  approx(servedMetres(data[0]), 5.00);
  assert.strictEqual(outcomeWhy(data[0]), 'ready');
});

// =====================================================================
console.log('\n2 — CONTENTION: correctly reserved');

test('C1 100 m, three cards wanting 60/50/40 pieces', () => {
  // perRow 1, cut 0.5 m -> 60 pieces = 30 m, 50 = 25 m, 40 = 20 m. Total 75 m
  // of a 100 m rack, so actually everyone fits. Make it bite: use a 40 m rack.
  //   S1 wants 30 m -> served, 10 m left
  //   S2 wants 25 m -> only 10 m left, cannot seat a whole order -> skipped
  //   S3 wants 20 m -> still 10 m left -> skipped
  const data = [card('S1', 60, 40), card('S2', 50, 40), card('S3', 40, 40)];
  A.applyLotAllocation(data);
  approx(servedMetres(data[0]), 30.00);
  assert.strictEqual(outcomeWhy(data[0]), 'ready');
  assert.strictEqual(servedMetres(data[1]), 0);
  assert.strictEqual(outcomeWhy(data[1]), 'skipped');
  assert.strictEqual(servedMetres(data[2]), 0);
  assert.strictEqual(outcomeWhy(data[2]), 'skipped');
});

test('C2 the rack drains down the order, card by card', () => {
  // 12 m rack. Each card wants 10 pieces = 5 m.
  //   S1 -> 5 m   (7 m left)
  //   S2 -> 5 m   (2 m left)
  //   S3 -> 2 m is only 4 rows, short of 10 pieces -> skipped
  const data = [card('S1', 10, 12), card('S2', 10, 12), card('S3', 10, 12)];
  A.applyLotAllocation(data);
  approx(servedMetres(data[0]), 5.00);
  approx(servedMetres(data[1]), 5.00);
  assert.strictEqual(servedMetres(data[2]), 0);
  assert.strictEqual(outcomeWhy(data[2]), 'skipped');
});

test('C3 REORDERING flips who is short — same rack, same demand', () => {
  // The whole point of letting the store person choose. 5 m rack, two cards
  // each wanting 10 pieces = 5 m: it serves exactly one.
  const first = [card('A', 10, 5), card('B', 10, 5)];
  A.applyLotAllocation(first);
  approx(servedMetres(first[0]), 5.00, 0.01);   // A served
  assert.strictEqual(servedMetres(first[1]), 0); // B short

  // Now put B first. Nothing else changes.
  const second = [card('B', 10, 5), card('A', 10, 5)];
  A.applyLotAllocation(second);
  approx(servedMetres(second[0]), 5.00, 0.01);   // B served
  assert.strictEqual(servedMetres(second[1]), 0); // A short

  // Same rack, same demand, opposite answer — decided purely by the order.
});

test('C4 a lower card still gets what a higher one did NOT want', () => {
  // 20 m rack. S1 wants 10 pieces = 5 m. S2 wants 20 pieces = 10 m.
  // Reservation must not starve S2 — 15 m is left, plenty.
  const data = [card('S1', 10, 20), card('S2', 20, 20)];
  A.applyLotAllocation(data);
  approx(servedMetres(data[0]), 5.00);
  approx(servedMetres(data[1]), 10.00);
  assert.strictEqual(outcomeWhy(data[1]), 'ready');
});

test('C5 contention on ONE material does not starve another', () => {
  // S1 and S2 both want M1 (contested) and M2 (plentiful). M1 running out for
  // S2 must not stop S2 being served M2.
  function twoMat(id, m1Pieces, m2Pieces) {
    return sup(id, [
      material('M1', { requiredPieces: m1Pieces,
        lines: [line('IT-' + id + '-1', m1Pieces, 'PLAN-' + id)],
        lots: [lotWith('L1', 5)] }),
      material('M2', { requiredPieces: m2Pieces,
        lines: [line('IT-' + id + '-2', m2Pieces, 'PLAN-' + id)],
        lots: [lotWith('L2', 100)] })
    ]);
  }
  const data = [twoMat('S1', 10, 10), twoMat('S2', 10, 10)];
  A.applyLotAllocation(data);
  // M1: 5 m rack, 5 m each -> S1 served, S2 short.
  approx(servedMetres({ materials: [data[0].materials[0]] }), 5.00);
  assert.strictEqual(servedMetres({ materials: [data[1].materials[0]] }), 0);
  // M2: 100 m rack -> BOTH served.
  approx(servedMetres({ materials: [data[0].materials[1]] }), 5.00);
  approx(servedMetres({ materials: [data[1].materials[1]] }), 5.00);
});

// =====================================================================
console.log('\n3 — CONSERVATION: never over-promise');

test('V1 total promised never exceeds the rack, per material', () => {
  // Deliberately over-subscribed: 10 m rack, four cards wanting 5 m each.
  const data = [card('S1', 10, 10), card('S2', 10, 10),
                card('S3', 10, 10), card('S4', 10, 10)];
  A.applyLotAllocation(data);
  const promised = data.reduce(function (t, s) { return t + servedMetres(s); }, 0);
  assert.ok(promised <= 10 + 0.0001,
    'promised ' + promised + ' m off a 10 m rack');
  // And it should actually serve the two it can, not give up entirely.
  approx(promised, 10.00);
});

test('V2 conservation holds per ROLL, not just per material', () => {
  // One lot, two rolls: 6 m and 3 m. Three cards each wanting 10 pieces = 5 m.
  // Only the 6 m roll can seat a 5 m order (the 3 m roll yields 6 rows = 6
  // pieces, short of 10), so exactly one card is served and no roll goes
  // negative.
  function rollCard(id) {
    return sup(id, [material('M1', {
      requiredPieces: 10,
      lines: [line('IT-' + id, 10, 'PLAN-' + id)],
      lots: [{
        lotId: 'L1', lotNumber: 'L1', blocked: false,
        wash: 9, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
        rolls: [
          { rollId: 'L1-R1', label: 'L1-R1', length: 3, status: 'Available', origin: 'Purchased' },
          { rollId: 'L1-R2', label: 'L1-R2', length: 6, status: 'Available', origin: 'Purchased' }
        ]
      }]
    })]);
  }
  const data = [rollCard('S1'), rollCard('S2'), rollCard('S3')];
  A.applyLotAllocation(data);

  // Sum the per-roll metres every card was promised.
  const byRoll = {};
  data.forEach(function (s) {
    (s.materials[0].lotLines || []).forEach(function (ln) {
      (ln.rolls || []).forEach(function (r) {
        byRoll[r.rollId] = (byRoll[r.rollId] || 0) + (Number(r.metres) || 0);
      });
    });
  });
  assert.ok((byRoll['L1-R1'] || 0) <= 3 + 0.0001, 'R1 over-promised');
  assert.ok((byRoll['L1-R2'] || 0) <= 6 + 0.0001, 'R2 over-promised');
});

test('V3 the raw payload is never mutated — a re-run is idempotent', () => {
  // The reservation is a VIEW. Running twice on the same data must give the
  // same answer, which it can only do if the input lots are untouched.
  const build = () => [card('S1', 10, 12), card('S2', 10, 12), card('S3', 10, 12)];

  const one = build(); A.applyLotAllocation(one);
  const two = build(); A.applyLotAllocation(two);

  for (let i = 0; i < 3; i++) {
    approx(servedMetres(one[i]), servedMetres(two[i]), 0.0001);
    assert.strictEqual(outcomeWhy(one[i]), outcomeWhy(two[i]));
  }
  // And the lot on the payload still reads its original length.
  approx(Number(one[0].materials[0].lots[0].rolls[0].length), 12.00);
});

test('V4 running the SAME array twice does not double-spend', () => {
  // applyLotAllocation is called again on every re-render (a lot override, a
  // declined remnant). It reads the raw lots each time and rebuilds the
  // ledgers, so a second call on the same array must not halve everyone.
  const data = [card('S1', 10, 12), card('S2', 10, 12), card('S3', 10, 12)];
  A.applyLotAllocation(data);
  const firstRun = data.map(servedMetres);
  A.applyLotAllocation(data);
  const secondRun = data.map(servedMetres);
  for (let i = 0; i < 3; i++) {
    approx(firstRun[i], secondRun[i], 0.0001);
  }
});

// ----------------------------------------------------------------------------
console.log('\n========================================');
console.log('priority-reservation: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  - ' + f.name + ': ' + f.msg)); process.exit(1); }
