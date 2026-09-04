#!/usr/bin/env node
// Parity: buildHandoverSummary(issues) totals MUST equal the fan-out totals.
//
// The issue press builds issues[] once. issueMaterialsApply fans issues[].
// allocations to Material_Requirement + stock. issueMaterialsHandover writes
// ONE Material_Issue whose Issue_Lines come from buildHandoverSummary(issues).
// If the two disagree, the handover record says a different quantity left the
// counter than the requirement rows recorded — the exact desync this migration
// must not introduce.
//
// THE INVARIANT, per material:
//   Σ handover line .qty            === Σ allocations.giveQty
//   Σ handover line .piecesFromRaw  === Σ allocations.giveRaw
//   Σ handover line .piecesFromWaste=== Σ allocations.giveWaste
//
//   usage: node tools/issue-handover-parity.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');

function grab(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error('not found: ' + sig);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + sig);
}

const ctx = { console: { log() {}, warn() {}, error() {} } };
vm.createContext(ctx);
// round2 lives in lot-allocator.js in the browser; provide the same impl.
vm.runInContext('function round2(n){return Math.round((Number(n)||0)*100)/100;}', ctx);
vm.runInContext(grab('function buildHandoverSummary(issues)'), ctx);
const buildHandoverSummary = ctx.buildHandoverSummary;

// ---- reference: sum the fan-out side straight off issues[].allocations ------
function fanTotals(issues) {
  const t = {};
  (issues || []).forEach((line) => {
    (line.allocations || []).forEach((a) => {
      const m = String(line.materialId || '');
      if (!t[m]) t[m] = { qty: 0, raw: 0, waste: 0 };
      t[m].qty = round2(t[m].qty + (Number(a.giveQty) || 0));
      t[m].raw += Number(a.giveRaw) || 0;
      t[m].waste += Number(a.giveWaste) || 0;
    });
  });
  return t;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function handoverTotals(summary) {
  const t = {};
  summary.lines.forEach((r) => {
    const m = String(r.materialId || '');
    if (!t[m]) t[m] = { qty: 0, raw: 0, waste: 0 };
    t[m].qty = round2(t[m].qty + (Number(r.qty) || 0));
    t[m].raw += Number(r.piecesFromRaw) || 0;
    t[m].waste += Number(r.piecesFromWaste) || 0;
  });
  return t;
}

function assertParity(issues) {
  const fan = fanTotals(issues);
  const hand = handoverTotals(buildHandoverSummary(issues));
  const mats = new Set([...Object.keys(fan), ...Object.keys(hand)]);
  mats.forEach((m) => {
    const f = fan[m] || { qty: 0, raw: 0, waste: 0 };
    const h = hand[m] || { qty: 0, raw: 0, waste: 0 };
    assert.strictEqual(h.qty, f.qty, `material ${m}: qty ${h.qty} != ${f.qty}`);
    assert.strictEqual(h.raw, f.raw, `material ${m}: raw ${h.raw} != ${f.raw}`);
    assert.strictEqual(h.waste, f.waste, `material ${m}: waste ${h.waste} != ${f.waste}`);
  });
  return buildHandoverSummary(issues);
}

// ---- fixtures --------------------------------------------------------------

test('single trim line, one allocation', () => {
  const s = assertParity([{
    materialId: 'M1', unit: 'Cone', isFabric: false,
    allocations: [{ mrqId: 'r1', planId: 'p1', giveQty: 5, giveRaw: 0, giveWaste: 0, issuedLot: '' }],
    issueLines: [{ mrqId: 'r1', qty: 5, note: '' }]
  }]);
  assert.strictEqual(s.lines.length, 1);
  assert.strictEqual(s.lines[0].lot, '');
  assert.strictEqual(s.planCount, 1);
});

test('trim fanned across 3 plans -> ONE material×lot line', () => {
  const s = assertParity([{
    materialId: 'M1', unit: 'Cone', isFabric: false,
    allocations: [
      { mrqId: 'r1', planId: 'p1', giveQty: 2.33, giveRaw: 0, giveWaste: 0, issuedLot: '' },
      { mrqId: 'r2', planId: 'p2', giveQty: 2.33, giveRaw: 0, giveWaste: 0, issuedLot: '' },
      { mrqId: 'r3', planId: 'p3', giveQty: 2.34, giveRaw: 0, giveWaste: 0, issuedLot: '' }
    ],
    issueLines: []
  }]);
  assert.strictEqual(s.lines.length, 1);
  assert.strictEqual(s.lines[0].qty, 7);   // 2.33+2.33+2.34, no re-rounding drift
  assert.strictEqual(s.planCount, 3);
});

test('fabric, two lots -> two material×lot lines', () => {
  const s = assertParity([{
    materialId: 'M2', unit: 'Mtr', isFabric: true,
    allocations: [
      { mrqId: 'r1', planId: 'p1', giveQty: 10.5, giveRaw: 20, giveWaste: 0, issuedLot: 'L1' },
      { mrqId: 'r2', planId: 'p1', giveQty: 4.25, giveRaw: 8, giveWaste: 0, issuedLot: 'L2' }
    ],
    issueLines: [
      { mrqId: 'r1', qty: 10.5, cutW: 55, cutL: 55, note: '' },
      { mrqId: 'r2', qty: 4.25, cutW: 55, cutL: 55, note: '' }
    ]
  }]);
  assert.strictEqual(s.lines.length, 2);
  const l1 = s.lines.find((x) => x.lot === 'L1');
  const l2 = s.lines.find((x) => x.lot === 'L2');
  assert.strictEqual(l1.qty, 10.5); assert.strictEqual(l1.piecesFromRaw, 20);
  assert.strictEqual(l2.qty, 4.25); assert.strictEqual(l2.piecesFromRaw, 8);
});

test('same material, same lot, two requirements -> merged into one line', () => {
  const s = assertParity([{
    materialId: 'M2', unit: 'Mtr', isFabric: true,
    allocations: [
      { mrqId: 'r1', planId: 'p1', giveQty: 6, giveRaw: 12, giveWaste: 0, issuedLot: 'L1' },
      { mrqId: 'r2', planId: 'p2', giveQty: 3, giveRaw: 6, giveWaste: 0, issuedLot: 'L1' }
    ],
    issueLines: [
      { mrqId: 'r1', qty: 6, note: '' },
      { mrqId: 'r2', qty: 3, note: '' }
    ]
  }]);
  assert.strictEqual(s.lines.length, 1);
  assert.strictEqual(s.lines[0].qty, 9);
  assert.strictEqual(s.lines[0].piecesFromRaw, 18);
});

test('offcut-only material (giveWaste>0, no lot) -> a pieces-only line', () => {
  const s = assertParity([{
    materialId: 'M3', unit: 'Mtr', isFabric: true,
    allocations: [
      { mrqId: 'r1', planId: 'p1', giveQty: 0, giveRaw: 0, giveWaste: 5, issuedLot: '' }
    ],
    issueLines: []
  }]);
  assert.strictEqual(s.lines.length, 1);
  assert.strictEqual(s.lines[0].lot, '');
  assert.strictEqual(s.lines[0].qty, 0);
  assert.strictEqual(s.lines[0].piecesFromWaste, 5);
});

test('mix: fresh from a lot + offcut credit on same material', () => {
  const s = assertParity([{
    materialId: 'M4', unit: 'Mtr', isFabric: true,
    allocations: [
      { mrqId: 'r1', planId: 'p1', giveQty: 8, giveRaw: 16, giveWaste: 0, issuedLot: 'L9' },
      { mrqId: 'r2', planId: 'p1', giveQty: 0, giveRaw: 0, giveWaste: 4, issuedLot: '' }
    ],
    issueLines: [{ mrqId: 'r1', qty: 8, note: '' }]
  }]);
  // one row for L9, one for the offcut-only ('' lot)
  assert.strictEqual(s.lines.length, 2);
});

test('printed pieces stay per physical piece, not merged', () => {
  const s = assertParity([{
    materialId: 'M5', unit: 'Mtr', isFabric: true,
    allocations: [
      { mrqId: 'r1', planId: 'p1', giveQty: 9, giveRaw: 3, giveWaste: 0, issuedLot: 'LP' }
    ],
    issueLines: [
      { mrqId: 'r1', qty: 3, cutW: 100, cutL: 300, note: 'PRINTED_PIECE | 1x 300' },
      { mrqId: 'r1', qty: 3, cutW: 100, cutL: 300, note: 'PRINTED_PIECE | 1x 300' },
      { mrqId: 'r1', qty: 3, cutW: 100, cutL: 300, note: 'PRINTED_PIECE | 1x 300' }
    ]
  }]);
  // 3 separate rows, each printed:true, raw split 1/1/1, total raw 3, total qty 9
  const printed = s.lines.filter((x) => x.printed);
  assert.strictEqual(printed.length, 3);
  assert.strictEqual(printed.reduce((t, x) => t + x.piecesFromRaw, 0), 3);
  assert.strictEqual(round2(printed.reduce((t, x) => t + x.qty, 0)), 9);
});

test('multi-material press: totals hold per material', () => {
  const s = assertParity([
    {
      materialId: 'M1', unit: 'Cone', isFabric: false,
      allocations: [
        { mrqId: 'a', planId: 'p1', giveQty: 1.1, giveRaw: 0, giveWaste: 0, issuedLot: '' },
        { mrqId: 'b', planId: 'p2', giveQty: 2.2, giveRaw: 0, giveWaste: 0, issuedLot: '' }
      ],
      issueLines: []
    },
    {
      materialId: 'M2', unit: 'Mtr', isFabric: true,
      allocations: [
        { mrqId: 'c', planId: 'p1', giveQty: 5.55, giveRaw: 10, giveWaste: 2, issuedLot: 'L1' },
        { mrqId: 'd', planId: 'p3', giveQty: 5.55, giveRaw: 10, giveWaste: 2, issuedLot: 'L1' }
      ],
      issueLines: []
    }
  ]);
  assert.strictEqual(s.planCount, 3);
  const m2 = s.lines.find((x) => x.materialId === 'M2');
  assert.strictEqual(m2.qty, 11.1);
  assert.strictEqual(m2.piecesFromRaw, 20);
  assert.strictEqual(m2.piecesFromWaste, 4);
});

// ---- partial press: only the APPLIED chunks may be recorded --------------
//
// A press that dies at chunk k has moved chunks 0..k-1's stock. The handover
// must record exactly those - recording all of them claims cloth that never
// left the shelf; recording none strands the material with no voucher, so the
// supervisor can never receive it.

vm.runInContext(grab('function splitIssuesByAllocation(issues, maxAllocs)'), ctx);
const splitIssuesByAllocation = ctx.splitIssuesByAllocation;

function appliedFrom(chunks, appliedCount) {
  const out = [];
  for (let i = 0; i < appliedCount && i < chunks.length; i++) {
    (chunks[i] || []).forEach((l) => out.push(l));
  }
  return out;
}

test('partial press: summary of the applied chunks only, and it still balances', () => {
  const issues = [
    {
      materialId: 'M1', unit: 'Cone', isFabric: false,
      allocations: [
        { mrqId: 'a', planId: 'p1', giveQty: 4, giveRaw: 0, giveWaste: 0, issuedLot: '' },
        { mrqId: 'b', planId: 'p2', giveQty: 6, giveRaw: 0, giveWaste: 0, issuedLot: '' }
      ],
      issueLines: []
    },
    {
      materialId: 'M2', unit: 'Mtr', isFabric: true,
      allocations: [
        { mrqId: 'c', planId: 'p3', giveQty: 9, giveRaw: 18, giveWaste: 0, issuedLot: 'L1' }
      ],
      issueLines: []
    }
  ];
  // Force one material line per chunk.
  const chunks = splitIssuesByAllocation(issues, 2);
  assert.ok(chunks.length >= 2, 'fixture must split into at least 2 chunks');

  // Only chunk 0 landed.
  const applied = appliedFrom(chunks, 1);
  const s = buildHandoverSummary(applied);
  const fan = fanTotals(applied);
  const hand = handoverTotals(s);
  Object.keys(fan).forEach((m) => {
    assert.strictEqual(hand[m].qty, fan[m].qty, `partial: ${m} qty`);
    assert.strictEqual(hand[m].raw, fan[m].raw, `partial: ${m} raw`);
  });
  // and it must NOT contain a material from an unapplied chunk
  const appliedMats = {};
  applied.forEach((l) => { appliedMats[String(l.materialId)] = 1; });
  s.lines.forEach((r) => {
    assert.ok(appliedMats[r.materialId], 'recorded a material that never landed: ' + r.materialId);
  });
});

test('partial press: zero chunks applied -> empty summary, nothing recorded', () => {
  const issues = [{
    materialId: 'M1', unit: 'Cone', isFabric: false,
    allocations: [{ mrqId: 'a', planId: 'p1', giveQty: 4, giveRaw: 0, giveWaste: 0, issuedLot: '' }],
    issueLines: []
  }];
  const chunks = splitIssuesByAllocation(issues, 100);
  const s = buildHandoverSummary(appliedFrom(chunks, 0));
  assert.strictEqual(s.lines.length, 0);
});

test('whole press applied: summary equals the full-issues summary', () => {
  const issues = [{
    materialId: 'M2', unit: 'Mtr', isFabric: true,
    allocations: [
      { mrqId: 'c', planId: 'p1', giveQty: 5, giveRaw: 10, giveWaste: 0, issuedLot: 'L1' },
      { mrqId: 'd', planId: 'p2', giveQty: 5, giveRaw: 10, giveWaste: 0, issuedLot: 'L1' }
    ],
    issueLines: []
  }];
  const chunks = splitIssuesByAllocation(issues, 100);
  const all = buildHandoverSummary(issues);
  const applied = buildHandoverSummary(appliedFrom(chunks, chunks.length));
  assert.deepStrictEqual(applied.lines, all.lines);
  assert.strictEqual(applied.planCount, all.planCount);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
