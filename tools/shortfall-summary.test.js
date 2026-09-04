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
             'openRequestFor', 'requestState', 'buildShortfallSummary']
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
    lots: [
      { lotId: 'L2', lotNumber: 'L2', blocked: false, wash: round2(15 - issuedMetres), unwash: 4.3, inWash: 0, form: 'Roll', pieces: [] },
      { lotId: 'L1', lotNumber: 'L1', blocked: false, wash: 3.2, unwash: 0, inWash: 0, form: 'Roll', pieces: [] }
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

// ---- 1. the stranded order shows up as a PO --------------------------------
test('S1 unplaceable order -> a buy row for its metres', () => {
  const s = buildShortfallSummary(makeData());
  assert.strictEqual(s.toBuy.length, 1, 'exactly one buy row');
  const b = s.toBuy[0];
  assert.strictEqual(b.e.materialId, 'RM-1');
  // one 10-piece order stranded = ceil(10/2)*150/100 = 7.5 m
  assert.ok(Math.abs(b.qty - 7.5) < 0.01, 'PO qty ~7.5 m, got ' + b.qty);
});

test('S2 stranded greige is NOT netted into owned', () => {
  // 4.3 (L2 greige) + 3.2 (L1 washed) = 7.5 m of real cloth that cannot seat an
  // order. If it were counted as owned the buy row would disappear.
  const s = buildShortfallSummary(makeData());
  assert.ok(s.toBuy.length === 1 && s.toBuy[0].qty > 0.01,
    'stranded cloth must still read as short');
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
  // widen L2 so it holds all 3 orders (22.5 m) washed
  data[0].materials[0].lots[0].wash = 30;
  data[0].materials[0].lots[0].unwash = 0;
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

// ----------------------------------------------------------------------------
console.log('\n========================================');
console.log('shortfall-summary: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  - ' + f.name + ': ' + f.msg)); process.exit(1); }
