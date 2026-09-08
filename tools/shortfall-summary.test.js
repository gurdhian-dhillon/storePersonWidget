#!/usr/bin/env node
// buildShortfallSummary — the fabric BUY figure.
//
// Pins the two properties the store person asked for after the JS-API cutover:
//
//   1. Cloth that cannot complete an order under the one-lot rule (stranded
//      greige spread thin across lots, or an order no single lot can seat) is
//      SHORT and drives a PO. The old calc netted it into "owned" as raw metres
//      and the shortfall vanished.
//   2. The figure is ISSUE-INVARIANT. Handing an order over drops its pieces
//      from demand AND the washed metres it took from what the allocator could
//      place, by the same amount — so the PO figure does not move. Issuing for
//      one supervisor must never grow or shrink another's shortage.
//
//   usage: node tools/shortfall-summary.test.js

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

// ---- load the real allocator (owns round2, applyLotAllocation) ---------------
const allocSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');

function extract(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has function ' + name +
    ' — update tools/shortfall-summary.test.js');
  let depth = 0, j = mainSrc.indexOf('{', i);
  for (let k = j; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i, j);
}

const fns = ['fmt', 'qty', 'isPieceTracked', 'isFullyIssued', 'exTypeFor',
             'openRequestFor', 'requestState', 'fabricShortMetres', 'buildShortfallSummary']
  .map(extract).join('\n');

const sandbox = {
  console, Math, Number, String, Object, Array, JSON, parseInt, parseFloat, isNaN,
  document: { getElementById: () => null },
  window: {},
  escapeHtml: s => String(s == null ? '' : s),
};
vm.createContext(sandbox);
vm.runInContext(allocSrc + '\n' + fns, sandbox);
const buildShortfallSummary = sandbox.buildShortfallSummary;
const applyLotAllocation = sandbox.applyLotAllocation;
const round2 = sandbox.round2;

// Give a scalar-metres lot fixture ONE seed roll carrying its whole shelf total
// (wash + unwash + inWash), labelled the way deluge/seedLotRolls.dg labels it.
// The allocator is rolls-only: without this a lot has no cuttable cloth at all.
function seedRoll(lot) {
  const shelf = round2((Number(lot.wash) || 0) + (Number(lot.unwash) || 0) +
                       (Number(lot.inWash) || 0));
  lot.rolls = shelf > 0
    ? [{ rollId: lot.lotNumber + '-R1', label: lot.lotNumber + '-R1',
         length: shelf, status: 'Available', origin: 'Purchased' }]
    : [];
  return lot;
}

// ----------------------------------------------------------------------------
// A rack that is short by exactly one order under the one-lot rule.
//
//   fabric 124" wide (314.96 cm) — dummy data, but it is what the org runs;
//   cut 150x150 -> perRow = floor(314.96/150) = 2 pieces per 1.5 m marker row.
//   Each order is 10 pieces = ceil(10/2) = 5 rows = 7.5 m.
//
//   L2: 15 m washed, 4.3 m greige   -> seats 2 whole orders (15/7.5), 4.3 strands
//   L1: 3.2 m washed                -> seats 0 orders
//   demand: 3 orders = 22.5 m
//   the allocator places 15 m (2 orders on L2); order 3 has no home
//   -> short 7.5 m, PO for 7.5 m
// ----------------------------------------------------------------------------
function makeData(opts) {
  opts = opts || {};
  const issuedPieces = opts.issuedPieces || 0; // pieces already handed over on plan 1
  // Issuing hands cloth over: it leaves the shelf (in transit), so on the next
  // load the lot's washed figure comes back reduced by what went out. One
  // 10-piece order off L2 = ceil(10/2)*150/100 = 7.5 m.
  const issuedMetres = issuedPieces >= 10 ? 7.5 : 0;

  function line(planId, so, mrq, reqP, issP) {
    return {
      mrqId: mrq, planId: planId, salesOrder: so, planItemId: 'IT-' + planId,
      item: 'Napkin Set', isRemake: false, supervisorId: 'S1',
      required: 7.5, issued: issP > 0 ? 7.5 : 0,
      cutW: 150, cutL: 150, reqPieces: reqP, issPieces: issP,
      issuedLot: '', issuedLotNo: '', reason: ''
    };
  }

  const mat = {
    materialId: 'RM-1', material: 'Linen / Solid / Test', sku: 'RM-1', unit: 'Mtr',
    isFabric: true,
    availableStock: round2(18.2 - issuedMetres), unwashedStock: 4.3, inWashStock: 0,
    poCoveredQty: 0,
    fabricWidthCm: 314.96,
    requiredPieces: 30, issuedPieces: issuedPieces,
    cuts: [{ cutW: 150, cutL: 150, reqPieces: 30, issPieces: issuedPieces }],
    cutsJson: '[]',
    // SEED ROLLS. The allocator is rolls-only since the lot->rolls migration:
    // a lot with no Lot_Rolls has no cuttable cloth and every order against it
    // reports `skipped`. One roll = the lot's shelf total is exactly what the
    // backfill (deluge/seedLotRolls.dg) writes, and is the shape that makes the
    // roll allocator reproduce the old scalar behaviour.
    lots: [
      seedRoll({ lotId: 'L2', lotNumber: 'L2', blocked: false, wash: round2(15 - issuedMetres), unwash: 4.3, inWash: 0, form: 'Roll', pieces: [] }),
      seedRoll({ lotId: 'L1', lotNumber: 'L1', blocked: false, wash: 3.2, unwash: 0, inWash: 0, form: 'Roll', pieces: [] })
    ],
    wasteStock: [],
    lines: [
      line('P1', 'SO-1', 'MRQ-1', 10, issuedPieces >= 10 ? 10 : 0),
      line('P2', 'SO-2', 'MRQ-2', 10, 0),
      line('P3', 'SO-3', 'MRQ-3', 10, 0)
    ],
    openExceptions: []
  };

  const data = [{ supervisorId: 'S1', supervisorName: 'Suraj', materials: [mat] }];
  applyLotAllocation(data);
  return data;
}

// ---- multi-cut-size order (the real bug) -----------------------------------
//
// CONFIRMED against a live bug report: one order/plan spanning many DISTINCT
// cut sizes was being converted to metres using ONE aggregate piece count and
// a SINGLE guessed cut size (the plan's first line) instead of each cut
// size's own marker-row rounding. A 515-piece order across ~100 different
// sizes read as 1,308 m under the old per-plan guess; the true per-cut total
// was 660 m — the guess picked one large cut (279x254) and applied it to
// hundreds of much smaller pieces that each needed far fewer marker rows.
//
// Reduced to two cut sizes here (still enough to prove the bug): a big cut
// that wastes most of the fabric width per row, and a small cut that packs
// many rows per marker length. Applying the BIG cut's geometry to the SMALL
// cut's pieces (the old bug) overstates metres; the correct per-cut sum does
// not.
function makeMultiCutData() {
  const fw = 300; // fabric width cm
  // Big cut: 250 wide x 200 long, perRow = floor(300/250) = 1. 5 pieces -> 5
  // rows -> 5 * 200/100 = 10 m.
  // Small cut: 50 wide x 50 long, perRow = floor(300/50) = 6. 30 pieces ->
  // ceil(30/6)=5 rows -> 5 * 50/100 = 2.5 m.
  // Correct total: 10 + 2.5 = 12.5 m.
  // Old bug (applies the FIRST line's cut — the big one — to ALL 35 pieces
  // combined): perRow(250)=1, ceil(35/1)=35 rows * 200/100 = 70 m.
  const mat = {
    materialId: 'RM-9', material: 'Linen / Solid / Multi-Cut', sku: 'RM-9', unit: 'Mtr',
    isFabric: true,
    availableStock: 0, unwashedStock: 0, inWashStock: 0,
    poCoveredQty: 0, fabricWidthCm: fw,
    requiredPieces: 35, issuedPieces: 0,
    cuts: [
      { cutW: 250, cutL: 200, reqPieces: 5, issPieces: 0 },
      { cutW: 50, cutL: 50, reqPieces: 30, issPieces: 0 }
    ],
    cutsJson: '[]',
    // NO lots at all -> the whole order is skipped, exercising the
    // `why: 'skipped'` / `o.cuts[].pieces` path.
    lots: [],
    wasteStock: [],
    lines: [
      { mrqId: 'MRQ-BIG', planId: 'PX', salesOrder: 'SO-X', planItemId: 'IT-PX-1',
        item: 'Big Panel', isRemake: false, supervisorId: 'S1',
        required: 10, issued: 0, cutW: 250, cutL: 200, reqPieces: 5, issPieces: 0,
        issuedLot: '', issuedLotNo: '', reason: '' },
      { mrqId: 'MRQ-SMALL', planId: 'PX', salesOrder: 'SO-X', planItemId: 'IT-PX-2',
        item: 'Small Trim', isRemake: false, supervisorId: 'S1',
        required: 2.5, issued: 0, cutW: 50, cutL: 50, reqPieces: 30, issPieces: 0,
        issuedLot: '', issuedLotNo: '', reason: '' }
    ],
    openExceptions: []
  };
  const data = [{ supervisorId: 'S1', supervisorName: 'Suraj', materials: [mat] }];
  applyLotAllocation(data);
  return data;
}

test('S1c a plan spanning TWO cut sizes sums per-cut marker rows, not one guessed cut applied to all pieces', () => {
  const s = buildShortfallSummary(makeMultiCutData());
  assert.strictEqual(s.toBuy.length, 1, 'one buy row');
  const b = s.toBuy[0];
  assert.ok(Math.abs(b.qty - 12.5) < 0.01,
    'correct per-cut total is 12.5 m (10 + 2.5), got ' + b.qty +
    ' — 70 would mean the old per-plan single-cut bug is back');
});

// ---- multi-supervisor aggregation ------------------------------------------
//
// allocateMaterial runs ONCE PER CARD against a SHARED, draining ledger, so a
// material demanded by two supervisors produces TWO SEPARATE orderOutcomes
// arrays — one per card. buildShortfallSummary used to read only the first
// card's array (`byMat[key]` created once, orderOutcomes taken at creation
// and never merged), so a second supervisor's stranded order was silently
// invisible to the PO figure. Two cards, same material: card A's rack fully
// covers its own order; nothing is left for card B's, which must therefore
// show up as short too.
function makeTwoCardData() {
  function line(planId, so, mrq, sup) {
    return {
      mrqId: mrq, planId: planId, salesOrder: so, planItemId: 'IT-' + planId,
      item: 'Napkin Set', isRemake: false, supervisorId: sup,
      required: 7.5, issued: 0,
      cutW: 150, cutL: 150, reqPieces: 10, issPieces: 0,
      issuedLot: '', issuedLotNo: '', reason: ''
    };
  }
  function mat(sup, lineDef) {
    return {
      materialId: 'RM-9', material: 'Linen / Solid / Two-Card', sku: 'RM-9', unit: 'Mtr',
      isFabric: true,
      availableStock: 7.5, unwashedStock: 0, inWashStock: 0,
      poCoveredQty: 0, fabricWidthCm: 314.96,
      requiredPieces: 10, issuedPieces: 0,
      cuts: [{ cutW: 150, cutL: 150, reqPieces: 10, issPieces: 0 }],
      cutsJson: '[]',
      // ONE roll, 7.5 m — exactly enough for ONE card's order, nothing left
      // for the other.
      lots: [seedRoll({ lotId: 'LX', lotNumber: 'LX', blocked: false, wash: 7.5, unwash: 0, inWash: 0, form: 'Roll', pieces: [] })],
      wasteStock: [],
      lines: [lineDef],
      openExceptions: []
    };
  }
  const data = [
    { supervisorId: 'S1', supervisorName: 'Suraj', materials: [mat('S1', line('PA', 'SO-A', 'MRQ-A', 'S1'))] },
    { supervisorId: 'S2', supervisorName: 'Vivek', materials: [mat('S2', line('PB', 'SO-B', 'MRQ-B', 'S2'))] }
  ];
  applyLotAllocation(data);
  return data;
}

test('S0 a material demanded by TWO supervisor cards counts BOTH cards\' stranded orders, not just the first', () => {
  const s = buildShortfallSummary(makeTwoCardData());
  assert.strictEqual(s.toBuy.length, 1, 'one buy row for the shared material');
  const b = s.toBuy[0];
  // Card A (priority order first) takes the whole 7.5 m roll; card B's
  // identical order finds nothing left and is stranded. The PO figure must
  // reflect card B's 7.5 m shortfall, not read as fully covered because card
  // A's own orderOutcomes (empty of any skip) was the only one consulted.
  assert.ok(Math.abs(b.qty - 7.5) < 0.01,
    'PO qty must include the second card\'s stranded order (7.5 m), got ' + b.qty);
});

// ---- 1. the stranded order shows up as a PO --------------------------------
test('S1 unplaceable order -> a buy row for its metres', () => {
  const s = buildShortfallSummary(makeData());
  assert.strictEqual(s.toBuy.length, 1, 'exactly one buy row');
  const b = s.toBuy[0];
  assert.strictEqual(b.e.materialId, 'RM-1');
  // one 10-piece order stranded = ceil(10/2)*150/100 = 7.5 m
  assert.ok(Math.abs(b.qty - 7.5) < 0.01, 'PO qty ~7.5 m, got ' + b.qty);
});

test('S1b usableMetres reports what the allocator actually placed, less than raw stock when some is stranded', () => {
  // L2 (15 m) seats exactly 2 orders = 15 m usable; L1's 3.2 m is too little
  // for a third 7.5 m order and sits unusable, even though it is real stock.
  // Raw stock is 18.2 m (15 + 3.2), so usableMetres (15) must be strictly
  // less than e.stock (18.2) — that gap IS the 3.2 m stranded on L1.
  const s = buildShortfallSummary(makeData());
  const b = s.toBuy[0];
  assert.ok(Math.abs(b.e.usableMetres - 15) < 0.01,
    'usableMetres should be 15 (two placed orders), got ' + b.e.usableMetres);
  assert.ok(b.e.usableMetres < b.e.stock,
    'usable must be less than raw stock when some cloth is stranded (usable=' +
    b.e.usableMetres + ' stock=' + b.e.stock + ')');
});

test('S2 stranded greige is NOT netted into owned', () => {
  // 4.3 (L2 greige) + 3.2 (L1 washed) = 7.5 m of real cloth that cannot seat an
  // order. If it were counted as owned the buy row would disappear.
  const s = buildShortfallSummary(makeData());
  assert.ok(s.toBuy.length === 1 && s.toBuy[0].qty > 0.01,
    'stranded cloth must still read as short');
});

test('S2b grossDemand is the TRUE total across every line, not the allocator short-metres figure', () => {
  // 3 orders x 7.5 m each = 22.5 m gross demand, but only one order (7.5 m) is
  // actually unplaceable -> the buy row's qty stays 7.5 while grossDemand
  // reports the full 22.5. This is the exact "Needed 1,308 / In stock 3,000 /
  // Short 1,308" confusion from the real bug report: e.needed used to BE the
  // short-metres figure, so "Needed" and "Short by" always matched and never
  // explained the actual math against on-hand stock.
  const s = buildShortfallSummary(makeData());
  const b = s.toBuy[0];
  assert.ok(Math.abs(b.e.grossDemand - 22.5) < 0.01,
    'grossDemand should be 22.5 (3 x 7.5), got ' + b.e.grossDemand);
  assert.ok(Math.abs(b.qty - 7.5) < 0.01, 'the PO figure itself is unchanged at 7.5');
  assert.ok(b.e.grossDemand > b.qty, 'gross demand must be strictly larger than the short-metres PO figure here');
});

test('S2c grossDemand nets off issued pieces (issue-invariant, like the PO figure)', () => {
  // Plan P1's 10 pieces (7.5 m) handed over -> that line's outstanding drops
  // to 0, so gross demand should fall from 22.5 to 15.
  const s = buildShortfallSummary(makeData({ issuedPieces: 10 }));
  const b = s.toBuy[0];
  assert.ok(Math.abs(b.e.grossDemand - 15) < 0.01,
    'grossDemand should drop to 15 once one order is issued, got ' + b.e.grossDemand);
});

// ---- 2. issue-invariance -------------------------------------------------
test('S3 PO figure does not move after an order is issued', () => {
  const before = buildShortfallSummary(makeData({ issuedPieces: 0 })).toBuy[0].qty;
  // plan P1's 10 pieces handed over: demand drops 10, and L2 loses the 7.5 m
  // washed that seated it — placeable drops by the same 7.5.
  const after = buildShortfallSummary(makeData({ issuedPieces: 10 })).toBuy[0].qty;
  assert.ok(Math.abs(before - after) < 0.01,
    'shortfall must be issue-invariant: before ' + before + ' after ' + after);
});

// ---- 3. enough cloth on ONE lot -> no PO --------------------------------
test('S4 a rack that can seat every order raises no PO', () => {
  const data = makeData();
  // widen L2 so it holds all 3 orders (22.5 m) washed. The ROLL has to grow
  // with the wash column — the allocator cuts from rolls, so leaving the seed
  // roll at its old length would keep the lot physically unable to serve the
  // orders however much the header claims.
  data[0].materials[0].lots[0].wash = 30;
  data[0].materials[0].lots[0].unwash = 0;
  data[0].materials[0].lots[0].rolls = [
    { rollId: 'L2-R1', label: 'L2-R1', length: 30, status: 'Available', origin: 'Purchased' }
  ];
  applyLotAllocation(data);
  const s = buildShortfallSummary(data);
  assert.strictEqual(s.toBuy.length, 0, 'no buy row when one lot covers everything');
});

// ---- 4. a session PO drops the row immediately -------------------------
test('S5 an open Shortage ticket covering every plan hides the buy row', () => {
  const data = makeData();
  data[0].materials[0].openExceptions = [
    { type: 'Shortage', lot: '', planIds: ['P1', 'P2', 'P3'] }
  ];
  const s = buildShortfallSummary(data);
  assert.strictEqual(s.toBuy.length, 0, 'PO already raised this session -> row gone');
});

test('S6 a Shortage ticket that misses a plan keeps the row (stale)', () => {
  const data = makeData();
  data[0].materials[0].openExceptions = [
    { type: 'Shortage', lot: '', planIds: ['P1', 'P2'] } // P3 not covered
  ];
  const s = buildShortfallSummary(data);
  assert.strictEqual(s.toBuy.length, 1, 'uncovered plan -> row stays');
});

// ---- 5. non-fabric BUY is unchanged ----------------------------------
test('S7 trim shortfall still = needed - owned', () => {
  const data = [{
    supervisorId: 'S1', supervisorName: 'Suraj', materials: [{
      materialId: 'TR-1', material: 'Thread', sku: 'TR-1', unit: 'Cone',
      isFabric: false,
      availableStock: 40, unwashedStock: 0, inWashStock: 0, poCoveredQty: 0,
      required: 100, issued: 0, remaining: 100,
      lots: [], wasteStock: [], lines: [
        { planId: 'P1', salesOrder: 'SO-1', planId2: '', required: 100, issued: 0, reqPieces: 0, issPieces: 0 }
      ],
      openExceptions: []
    }]
  }];
  applyLotAllocation(data);
  const s = buildShortfallSummary(data);
  assert.strictEqual(s.toBuy.length, 1);
  assert.ok(Math.abs(s.toBuy[0].qty - 60) < 0.01, 'trim short = 100 - 40 = 60, got ' + s.toBuy[0].qty);
});

// ---- 6. fully-issued fabric contributes zero, does not vanish -------
test('S8 a fully-issued fabric material adds no shortfall', () => {
  const data = makeData({ issuedPieces: 0 });
  // mark every line fully issued
  const mat = data[0].materials[0];
  mat.lines.forEach(l => { l.issPieces = l.reqPieces; l.issued = l.required; });
  mat.issuedPieces = mat.requiredPieces;
  applyLotAllocation(data);
  const s = buildShortfallSummary(data);
  assert.strictEqual(s.toBuy.length, 0, 'nothing outstanding -> no buy row');
});

// ---- 7. a PRINTED (Pieces-form) lot with ample stock raises NO PO --------
// The regression: a Block Print lot holds 641 m across short pieces, an order
// needs 2.1 m / a few cuts, the card says "All in stock" — but the metres-
// balance buy calc saw lotLines[].qty == 0 (Pieces lots yield pieces, not roll
// metres) and raised a false "short by 1.05 m". Driving the calc off
// orderOutcomes (the allocator's own verdict) fixes it: every order placed
// 'ready' with shortPieces 0 -> no PO.
test('S9 printed Pieces lot, order fully covered -> no false PO', () => {
  const mat = {
    materialId: 'PR-1', material: 'Linen / Block Print / Liliana', sku: 'PR-1', unit: 'Mtr',
    isFabric: true,
    availableStock: 641, unwashedStock: 0, inWashStock: 0, poCoveredQty: 0,
    fabricWidthCm: 314.96,
    requiredPieces: 4, issuedPieces: 0,
    cuts: [{ cutW: 100, cutL: 70, reqPieces: 4, issPieces: 0 }],
    cutsJson: '[]',
    // A printed lot, as SHORT ROLLS. Pre-migration this was a `form: 'Pieces'`
    // lot with 20 Fabric_Piece rows of 320 cm; under the rolls model printed
    // cloth is not a special case — each piece is simply a 3.2 m roll, which is
    // exactly what the Fabric_Piece -> Lot_Rolls migration writes.
    lots: [{
      lotId: 'LP', lotNumber: 'LP', blocked: false,
      wash: 64, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
      rolls: Array.from({ length: 20 }, (_, i) => ({
        rollId: 'LP-P' + (i + 1), label: 'LP-P' + (i + 1),
        length: 3.2, status: 'Available', origin: 'Printed'
      }))
    }],
    wasteStock: [],
    lines: [{
      mrqId: 'MRQ-P1', planId: 'PP1', salesOrder: 'SO-9', planItemId: 'IT-P1',
      item: 'Napkin', isRemake: false, supervisorId: 'S1',
      required: 2.1, issued: 0, cutW: 100, cutL: 70, reqPieces: 4, issPieces: 0,
      issuedLot: '', issuedLotNo: '', reason: ''
    }],
    openExceptions: []
  };
  const data = [{ supervisorId: 'S1', supervisorName: 'Suraj', materials: [mat] }];
  applyLotAllocation(data);
  const s = buildShortfallSummary(data);
  assert.strictEqual(s.toBuy.length, 0,
    'ample printed stock, order covered -> NO buy row (got qty ' +
    (s.toBuy[0] && s.toBuy[0].qty) + ')');
  assert.strictEqual(s.toWash.length, 0, 'nothing to wash either');
});

// ----------------------------------------------------------------------------
console.log('\n========================================');
console.log('shortfall-summary: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  - ' + f.name + ': ' + f.msg)); process.exit(1); }
