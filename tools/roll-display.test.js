#!/usr/bin/env node
// PHASE A — THE ROLL DISPLAY on the store issue row.
//
// A lot is a set of physical rolls, not a metres pool, so the row has to name
// WHICH ROLL to cut. This exercises lotLinesHtml's LOT column against real
// allocator output — the same shapes applyLotAllocation and applyFabricOverride
// actually produce, not hand-written ideals.
//
// The case that matters most is D1/D2: the two writers disagree on grain.
// applyLotAllocation splits a lot's rolls per requirement line; applyFabricOverride
// stamps the LOT's whole breakdown onto EVERY line of that lot. Summing across
// lines therefore double-counts an overridden lot by the number of lines it serves,
// which is why the display dedupes by rollId keeping the largest.
//
//   usage: node tools/roll-display.test.js

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

const ROOT = path.join(__dirname, '..');
const allocSrc = fs.readFileSync(path.join(ROOT, 'app', 'js', 'lot-allocator.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'js', 'main.js'), 'utf8');

// Pull a top-level function out of main.js by name, brace-balanced.
function extract(name) {
  const i = mainSrc.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has top-level function ' + name +
    ' - the roll-display test contract changed; update tools/roll-display.test.js');
  let depth = 0, j = -1;
  const start = mainSrc.indexOf('{', i);
  for (let k = start; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i + 1, j);
}

const NEEDED = ['lotLinesHtml', 'fabricLotLineList', 'lotLineMetres', 'lotLineAutoMetres',
                'lotWashedStock', 'wastePicks', 'wasteWhereHtml', 'escapeHtml', 'fmt', 'qty',
                'lotLineInputId', 'lotLineCheckId', 'wasteCheckboxId', 'wasteInputId',
                'wasteRowId', 'wasteCheckedFor', 'rackCountFor'];

function makeCtx() {
  const sandbox = {
    console, Math, Number, String, Object, Array, JSON, isNaN, parseInt, parseFloat,
    wasteDeclined: {},
    window: {},
    document: { getElementById: function () { return null; } },
  };
  vm.createContext(sandbox);
  // The allocator first — it owns round2 / lotsFor / perRowFor, which main.js
  // calls as globals because widget.html loads it first.
  vm.runInContext(allocSrc, sandbox, { filename: 'lot-allocator.js' });
  vm.runInContext(NEEDED.map(extract).join('\n'), sandbox, { filename: 'main-extract.js' });
  return sandbox;
}
const CTX = makeCtx();

function lotHtml(m) {
  CTX.__m = m;
  return vm.runInContext('lotLinesHtml(__m, 0, 0, true).lot', CTX);
}

// One fabric SKU with two lots. L1 has three rolls (2, 5, 9 m), L2 has one (12 m).
function material(lotLines, opts) {
  opts = opts || {};
  return {
    materialId: 'M1', isFabric: true, material: 'Linen / Test', sku: 'FAB', unit: 'Mtr',
    fabricWidthCm: 137.16, requiredPieces: 20, issuedPieces: 0,
    remaining: opts.remaining === undefined ? 20 : opts.remaining,
    availableStock: 28,
    wasteStock: [], wastePicks: [],
    lines: [],
    lots: [
      { lotId: 'L1', lotNumber: 'LOT-A', blocked: false, wash: 16, unwash: 0, inWash: 0,
        rolls: [{ rollId: 'r1', label: 'A-1', length: 2, status: 'Available' },
                { rollId: 'r2', label: 'A-2', length: 5, status: 'Available' },
                { rollId: 'r3', label: 'A-3', length: 9, status: 'Available' }] },
      { lotId: 'L2', lotNumber: 'LOT-B', blocked: false, wash: 12, unwash: 0, inWash: 0,
        rolls: [{ rollId: 'r9', label: 'B-1', length: 12, status: 'Available' }] },
    ],
    lotLines: lotLines,
  };
}

function line(lotId, lotNumber, qty, rolls, mrqId) {
  return { lotId: lotId, lotNumber: lotNumber, qty: qty, mrqId: mrqId || 'Q1',
           planItemId: 'IT1', planId: 'PL1', cutW: 55, cutL: 55,
           rolls: rolls, pieces: [], fromRaw: 0, fromWaste: 0 };
}

// Count the roll sub-lines and read back what they say.
function rollLines(html) {
  const out = [];
  const re = /<div class="lot-rolls"><b>([^<]*)<\/b> &middot; ([^<]*)<\/div>/g;
  let mm;
  while ((mm = re.exec(html)) !== null) out.push({ label: mm[1], text: mm[2].trim() });
  return out;
}

console.log('\n-- D: the roll display --');

test('D1 auto path — rolls split per line render once each, in drain order', function () {
  // applyLotAllocation grain: two requirement lines off LOT-A, each carrying
  // only the rolls IT cut. Shortest-first drain means A-1 (2m) is exhausted
  // first, then A-2 picks up the rest.
  const m = material([
    line('L1', 'LOT-A', 2, [{ rollId: 'r1', label: 'A-1', metres: 2 }], 'Q1'),
    line('L1', 'LOT-A', 3, [{ rollId: 'r2', label: 'A-2', metres: 3 }], 'Q2'),
  ]);
  const rl = rollLines(lotHtml(m));
  assert.strictEqual(rl.length, 2, 'two distinct rolls, two lines');
  assert.strictEqual(rl[0].label, 'A-1');
  assert.ok(/^2\b/.test(rl[0].text), 'A-1 shows 2, got ' + rl[0].text);
  assert.strictEqual(rl[1].label, 'A-2');
  assert.ok(/^3\b/.test(rl[1].text), 'A-2 shows 3, got ' + rl[1].text);
});

test('D2 override path — the SAME breakdown on every line is NOT summed', function () {
  // applyFabricOverride grain: it stamps the lot's whole rollAlloc onto every
  // line of that lot. Three lines x (A-1 2m + A-2 3m) must still read 2 and 3,
  // not 6 and 9.
  const alloc = [{ rollId: 'r1', label: 'A-1', metres: 2 },
                 { rollId: 'r2', label: 'A-2', metres: 3 }];
  const m = material([
    line('L1', 'LOT-A', 2, alloc.map(function (r) { return Object.assign({}, r); }), 'Q1'),
    line('L1', 'LOT-A', 2, alloc.map(function (r) { return Object.assign({}, r); }), 'Q2'),
    line('L1', 'LOT-A', 1, alloc.map(function (r) { return Object.assign({}, r); }), 'Q3'),
  ]);
  const rl = rollLines(lotHtml(m));
  assert.strictEqual(rl.length, 2, 'two rolls despite three lines, got ' + rl.length);
  assert.ok(/^2\b/.test(rl[0].text), 'A-1 must read 2, not 6 - got ' + rl[0].text);
  assert.ok(/^3\b/.test(rl[1].text), 'A-2 must read 3, not 9 - got ' + rl[1].text);
});

test('D3 mixed grain — dedupe keeps the LARGEST, never the first seen', function () {
  // A line carrying the partial figure ahead of one carrying the lot total must
  // not leave the display quoting the partial.
  const m = material([
    line('L1', 'LOT-A', 1, [{ rollId: 'r1', label: 'A-1', metres: 1 }], 'Q1'),
    line('L1', 'LOT-A', 2, [{ rollId: 'r1', label: 'A-1', metres: 2 }], 'Q2'),
  ]);
  const rl = rollLines(lotHtml(m));
  assert.strictEqual(rl.length, 1);
  assert.ok(/^2\b/.test(rl[0].text), 'kept the larger figure, got ' + rl[0].text);
});

test('D4 two lots — each lot renders only its OWN rolls', function () {
  const m = material([
    line('L1', 'LOT-A', 5, [{ rollId: 'r2', label: 'A-2', metres: 5 }], 'Q1'),
    line('L2', 'LOT-B', 7, [{ rollId: 'r9', label: 'B-1', metres: 7 }], 'Q2'),
  ]);
  const html = lotHtml(m);
  const rl = rollLines(html);
  assert.strictEqual(rl.length, 2);
  assert.deepStrictEqual(rl.map(function (r) { return r.label; }), ['A-2', 'B-1']);
  // The roll line must sit UNDER its own lot's name, not be collected at the end.
  assert.ok(html.indexOf('LOT-A') < html.indexOf('A-2'), 'A-2 under LOT-A');
  assert.ok(html.indexOf('A-2') < html.indexOf('LOT-B'), 'A-2 before LOT-B');
  assert.ok(html.indexOf('LOT-B') < html.indexOf('B-1'), 'B-1 under LOT-B');
});

test('D5 a single roll is STILL named', function () {
  // The whole point: he must never be left choosing which roll off a rack.
  const m = material([
    line('L2', 'LOT-B', 8, [{ rollId: 'r9', label: 'B-1', metres: 8 }], 'Q1'),
  ]);
  const rl = rollLines(lotHtml(m));
  assert.strictEqual(rl.length, 1, 'one roll, one named line');
  assert.strictEqual(rl[0].label, 'B-1');
});

test('D6 a roll driven to zero by an edit-down drops out', function () {
  const m = material([
    line('L1', 'LOT-A', 2, [{ rollId: 'r1', label: 'A-1', metres: 2 },
                            { rollId: 'r2', label: 'A-2', metres: 0 }], 'Q1'),
  ]);
  const rl = rollLines(lotHtml(m));
  assert.strictEqual(rl.length, 1, 'the 0 m roll is not an instruction');
  assert.strictEqual(rl[0].label, 'A-1');
});

test('D7 no rolls on the line — the lot line still renders, no roll sub-line', function () {
  // Legacy / not-yet-seeded lot. Must degrade to the old behaviour rather than
  // throwing or printing an empty bold tag.
  const m = material([line('L1', 'LOT-A', 4, [], 'Q1')]);
  const html = lotHtml(m);
  assert.strictEqual(rollLines(html).length, 0);
  assert.ok(html.indexOf('LOT-A') >= 0, 'the lot itself still shows');
  assert.ok(html.indexOf('lot-rolls') < 0, 'no empty roll block emitted');
});

test('D8 a roll label is HTML-escaped', function () {
  const m = material([
    line('L1', 'LOT-A', 2, [{ rollId: 'r1', label: 'A<script>&', metres: 2 }], 'Q1'),
  ]);
  const html = lotHtml(m);
  assert.ok(html.indexOf('<script>') < 0, 'no raw script tag reaches the DOM');
  assert.ok(html.indexOf('&lt;script&gt;') >= 0, 'escaped instead');
});

test('D9 a blank label renders a dash, not an empty bold', function () {
  const m = material([
    line('L1', 'LOT-A', 2, [{ rollId: 'r1', label: '', metres: 2 }], 'Q1'),
  ]);
  const rl = rollLines(lotHtml(m));
  assert.strictEqual(rl.length, 1);
  assert.strictEqual(rl[0].label, '—', 'placeholder rather than a bare <b></b>');
});

test('D10 every lot is editable — no Pieces lock survives', function () {
  // Phase A retired Fabric_Piece, so the old !isPiecesLot guard has nothing to
  // exclude. A lot line must offer its issue box.
  CTX.__m = material([line('L1', 'LOT-A', 2, [{ rollId: 'r1', label: 'A-1', metres: 2 }], 'Q1')]);
  const issue = vm.runInContext('lotLinesHtml(__m, 0, 0, true).issue', CTX);
  assert.ok(issue.indexOf('issue-input') >= 0, 'the metres box is offered');
  assert.ok(issue.indexOf('lot-line-static') < 0, 'not locked to static text');
});

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') +
            '  (' + passed + '/' + (passed + failed) + ')');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach(function (f) { console.log('  ' + f.name + ': ' + f.msg); });
}
process.exit(failed === 0 ? 0 : 1);
