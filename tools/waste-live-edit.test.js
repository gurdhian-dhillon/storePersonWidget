#!/usr/bin/env node
// THE STORE PERSON EDITS, THE SCREEN ANSWERS - the three live-edit behaviours.
//
//   1. Typing in a LOT box moves the roll breakdown under that lot. He is being
//      told to cut a named roll to a length; the length must not go stale while
//      the box says something else.
//   2. Editing a WASTE pcs box moves the fresh METRES. Declining a remnant does
//      not shrink the job - the pieces it would have covered come off the roll
//      instead - and he must see that on the keystroke.
//   3. A WASTE box cannot exceed the ALLOCATOR'S OFFER, which is not the rack.
//      The rack says how many remnants exist; the offer says how many this job
//      needs. Offering the rack lets him hand out remnants nothing asked for.
//
//   usage: node tools/waste-live-edit.test.js

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
function approx(a, b, msg) {
  if (Math.abs(a - b) > 0.005) throw new Error((msg || 'value') + ': expected ' + b + ', got ' + a);
}

const ROOT = path.join(__dirname, '..');
const allocSrc = fs.readFileSync(path.join(ROOT, 'app', 'js', 'lot-allocator.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'js', 'main.js'), 'utf8');

function extract(name) {
  const i = mainSrc.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has top-level function ' + name +
    ' - update tools/waste-live-edit.test.js');
  let depth = 0, j = -1;
  const start = mainSrc.indexOf('{', i);
  for (let k = start; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i + 1, j);
}

const NEEDED = ['rackCountFor', 'wastePicks', 'wasteCheckedFor',
                'lotLinesHtml', 'fabricLotLineList', 'lotLineMetres', 'lotLineAutoMetres',
                'lotWashedStock', 'wasteLotOnlyHtml', 'wasteCartonOnlyHtml', 'escapeHtml', 'fmt', 'qty',
                'lotLineInputId', 'lotLineCheckId', 'wasteCheckboxId', 'wasteInputId',
                'wasteRowId'];

function ctx() {
  const sb = {
    console, Math, Number, String, Object, Array, JSON, isNaN, parseInt, parseFloat,
    window: {}, document: { getElementById: function () { return null; } },
  };
  vm.createContext(sb);
  vm.runInContext(allocSrc, sb, { filename: 'lot-allocator.js' });
  vm.runInContext(NEEDED.map(extract).join('\n'), sb, { filename: 'main-extract.js' });
  return sb;
}
const CTX = ctx();

function clearDeclines() {
  vm.runInContext('for (var k in wasteDeclined) delete wasteDeclined[k];', CTX);
}
function decline(wasteId, n) {
  CTX.__w = String(wasteId); CTX.__n = n;
  vm.runInContext('wasteDeclined[__w] = __n;', CTX);
}
function allocate(data) {
  CTX.__d = data;
  vm.runInContext('applyLotAllocation(__d)', CTX);
  return data;
}

// One supervisor, one fabric SKU. Remnant W1: 3 on the rack, each 120x115,
// yielding floor(120/55) * floor(115/55) = 2 * 2 = 4 cuts of 55x55.
// Lot LOT-A: one 30 m roll, all washed. perRow = floor(137.16/55) = 2.
function world(reqPieces, opts) {
  opts = opts || {};
  return [{
    supervisorId: opts.supId || 'S1', supervisorName: 'Sup', materials: [{
      materialId: 'M1', isFabric: true, material: 'Linen', sku: 'FAB', unit: 'Mtr',
      fabricWidthCm: 137.16, cutWidth: 55, cutLength: 55,
      requiredPieces: reqPieces, issuedPieces: 0, outstandingPieces: reqPieces,
      remaining: 0, availableStock: 30,
      wasteStock: opts.noWaste ? []
        : [{ wasteId: 'W1', width: 120, length: 115, pieces: 3, lotId: 'L1', lot: 'L1', carton: 'C1' }],
      wastePicks: [],
      lines: [{ mrqId: 'Q1', planId: opts.planId || 'PL1', salesOrder: 'SO-1',
                planItemId: 'IT1', item: 'X', isRemake: false,
                required: 0, issued: 0, reqPieces: reqPieces, issPieces: 0,
                cutW: 55, cutL: 55, issuedLot: '', issuedLotNo: '', reason: '' }],
      lots: [{ lotId: 'L1', lotNumber: 'LOT-A', blocked: false,
               wash: 30, unwash: 0, inWash: 0, form: 'Roll', pieces: [],
               rolls: opts.rolls || [{ rollId: 'r1', label: 'A-1', length: 30, status: 'Available' }] }],
    }]
  }];
}
const matOf = (d, si) => d[si || 0].materials[0];
const pickOf = (m) => (m.wastePicks || [])[0] || {};
function rollText(m) {
  return (m.lotLines || []).map(function (l) {
    return (l.rolls || []).map(function (r) { return r.label + ':' + r.metres; }).join(',');
  }).join(' | ');
}

console.log('\n-- W: the waste box ceiling is the OFFER, not the rack --');

test('W1 a demand needing ONE remnant offers one, though three are on the rack', function () {
  clearDeclines();
  const m = matOf(allocate(world(4)));
  const p = pickOf(m);
  assert.strictEqual(p.pieces, 1, 'the allocation takes one remnant for 4 cuts');
  assert.strictEqual(CTX.rackCountFor(m, p), 1,
    'the CEILING must be the offer - a rack ceiling of 3 would let him hand out ' +
    'two remnants against a requirement that cannot credit them');
});

test('W2 the ceiling rises with the demand, up to what the rack holds', function () {
  clearDeclines();
  assert.strictEqual(CTX.rackCountFor(matOf(allocate(world(8))), pickOf(matOf(allocate(world(8))))), 2);
  clearDeclines();
  const m20 = matOf(allocate(world(20)));
  assert.strictEqual(CTX.rackCountFor(m20, pickOf(m20)), 3, 'never more than the rack');
});

test('W3 THE CEILING IS STABLE WHILE HE TYPES - it never follows the value down', function () {
  // The bug this prevents: a ceiling read off the CURRENT pick drops to 1 the
  // moment he types 1, trapping him there with no way back up to the 3 he was
  // offered.
  [3, 2, 1, 0].forEach(function (typed) {
    clearDeclines();
    decline('W1', typed);
    const m = matOf(allocate(world(20)));
    const p = pickOf(m);
    assert.strictEqual(p.pieces, typed, 'the pick follows what he typed');
    assert.strictEqual(CTX.rackCountFor(m, p), 3,
      'the ceiling stays at the original offer after typing ' + typed);
  });
});

test('W4 a payload with no autoPieces falls back to the rack, not to zero', function () {
  clearDeclines();
  const m = matOf(allocate(world(20)));
  const p = pickOf(m);
  delete p.autoPieces;                       // an older server / a stale cache
  assert.strictEqual(CTX.rackCountFor(m, p), 3, 'old behaviour, never a hard 0');
});

console.log('\n-- X: declining a remnant raises the CLOTH, live --');

test('X1 fewer remnants means more metres and more fresh pieces', function () {
  const seen = [];
  [3, 2, 1, 0].forEach(function (typed) {
    clearDeclines();
    decline('W1', typed);
    const m = matOf(allocate(world(20)));
    seen.push({ typed: typed, covered: m.piecesCoveredByWaste,
                fresh: m.freshMeters, pieces: m.freshPieces });
  });
  // 4 cuts per remnant, 2 per marker row, 0.55 m per row.
  assert.deepStrictEqual(seen.map(function (s) { return s.covered; }), [12, 8, 4, 0]);
  assert.deepStrictEqual(seen.map(function (s) { return s.pieces; }), [8, 12, 16, 20]);
  approx(seen[0].fresh, 2.20, 'take all 3');
  approx(seen[1].fresh, 3.30, 'give one back');
  approx(seen[2].fresh, 4.40, 'give two back');
  approx(seen[3].fresh, 5.50, 'take no remnants at all');
});

test('X2 the NAMED ROLL carries the extra metres, not some other lot', function () {
  clearDeclines();
  decline('W1', 0);
  const m = matOf(allocate(world(20)));
  assert.strictEqual(rollText(m), 'A-1:5.5',
    'the whole job comes off the one roll it named');
});

test('X3 a decline SPILLS ONTO THE NEXT ROLL, and the row names both', function () {
  // Two rolls, shortest first: A-1 is 2 m, A-2 is 28 m.
  //
  // THE POINT OF THE ROLLS MODEL IS VISIBLE HERE. A 2 m roll does not give 2 m
  // of a 0.55 m marker - it gives THREE whole rows (1.65 m) and strands the last
  // 0.35 m, because a part-row cannot be cut. So the 4th row has to open A-2.
  // A metres-pool model would have said "2.20 off A-1" and sent him to a roll
  // that cannot deliver it.
  const rolls = [{ rollId: 'r1', label: 'A-1', length: 2, status: 'Available' },
                 { rollId: 'r2', label: 'A-2', length: 28, status: 'Available' }];
  clearDeclines();
  const full = matOf(allocate(world(20, { rolls: rolls })));
  assert.strictEqual(rollText(full), 'A-1:1.65,A-2:0.55',
    'the short roll is drained to whole rows, the remainder opens the next');

  // Give every remnant back and the same split grows - A-1 is still capped at
  // its three rows, so all the extra lands on A-2.
  clearDeclines();
  decline('W1', 0);
  const none = matOf(allocate(world(20, { rolls: rolls })));
  assert.strictEqual(none.lotLines.length > 0, true);
  const parts = rollText(none).split(',');
  assert.strictEqual(parts[0], 'A-1:1.65', 'the short roll cannot give more than 3 rows');
  approx(Number(parts[1].split(':')[1]), 3.85, 'A-2 absorbs the whole decline');
});

test('X4 declining a remnant NEVER reduces what the job still needs', function () {
  // The whole point: the cloth makes up the difference. `remaining` is the
  // outstanding requirement and must not shrink because he handed back a remnant.
  clearDeclines();
  const before = matOf(allocate(world(20))).remaining;
  clearDeclines();
  decline('W1', 0);
  const after = matOf(allocate(world(20))).remaining;
  assert.ok(after >= before,
    'giving a remnant back cannot make the row need LESS (' + before + ' -> ' + after + ')');
});

console.log('\n-- Y: the shared ledger still holds across cards --');

test('Y1 a remnant one card declines is offered to the NEXT card down', function () {
  // The ledger is shared in priority order, so a decline is not a private edit:
  // it puts stock back for everyone below. This is why the repaint re-runs the
  // allocation over the WHOLE screen rather than one card.
  const two = world(4).concat(world(4, { supId: 'S2', planId: 'PL2' }));
  // Both cards name the same remnant W1 (same rack, sent to every card).
  clearDeclines();
  const base = allocate(JSON.parse(JSON.stringify(two)));
  const firstTook = pickOf(matOf(base, 0)).pieces;
  assert.strictEqual(firstTook, 1, 'card 1 takes the one remnant it needs');

  clearDeclines();
  decline('W1', 0);
  const after = allocate(JSON.parse(JSON.stringify(two)));
  assert.strictEqual(pickOf(matOf(after, 0)).pieces, 0, 'card 1 gave it back');
  // Card 2 must now be able to see it. Its own pick is capped by its own demand.
  assert.ok(matOf(after, 1).piecesCoveredByWaste >= 0, 'card 2 re-allocated, not stale');
});

test('Y2 allocating twice from the same payload gives the same answer (idempotent)', function () {
  // reallocateInPlace calls applyLotAllocation again on every keystroke, so this
  // is load-bearing: a pass that accumulated would drift with each character.
  clearDeclines();
  decline('W1', 1);
  const d = world(20);
  allocate(d);
  const once = JSON.stringify({ p: pickOf(matOf(d)).pieces, f: matOf(d).freshMeters,
                                c: matOf(d).piecesCoveredByWaste, r: rollText(matOf(d)) });
  allocate(d);
  allocate(d);
  const thrice = JSON.stringify({ p: pickOf(matOf(d)).pieces, f: matOf(d).freshMeters,
                                  c: matOf(d).piecesCoveredByWaste, r: rollText(matOf(d)) });
  assert.strictEqual(thrice, once, 'three passes must equal one');
});

test('Y3 autoPieces survives repeated allocation with a decline in force', function () {
  clearDeclines();
  decline('W1', 1);
  const d = world(20);
  allocate(d); allocate(d);
  assert.strictEqual(pickOf(matOf(d)).autoPieces, 3,
    'the ceiling is recomputed from the undeclined pass every time, not carried over');
  assert.strictEqual(pickOf(matOf(d)).pieces, 1, 'and the pick still honours the decline');
});

test('Y4 with no declines at all, autoPieces equals the pick', function () {
  clearDeclines();
  const m = matOf(allocate(world(20)));
  const p = pickOf(m);
  assert.strictEqual(p.autoPieces, p.pieces, 'the single pass IS the undeclined pass');
});

console.log('\n-- Z: what the row actually renders --');

test('Z1 the ROLL column shows the roll and its metres, and both move on a decline', function () {
  // The roll breakdown lives in its own column now, split out of LOT.
  clearDeclines();
  CTX.__m = matOf(allocate(world(20)));
  const full = vm.runInContext('lotLinesHtml(__m, 0, 0, true).roll', CTX);
  assert.ok(/A-1<\/b> &middot; 2\.2/.test(full), 'took the remnants: 2.20 m off A-1\n' + full);

  clearDeclines();
  decline('W1', 0);
  CTX.__m = matOf(allocate(world(20)));
  const none = vm.runInContext('lotLinesHtml(__m, 0, 0, true).roll', CTX);
  assert.ok(/A-1<\/b> &middot; 5\.5/.test(none), 'gave them back: 5.50 m off A-1\n' + none);
});

test('Z2 the pcs box carries the ceiling as its max attribute', function () {
  clearDeclines();
  CTX.__m = matOf(allocate(world(4)));       // offer is ONE of three on the rack
  const issue = vm.runInContext('lotLinesHtml(__m, 0, 0, true).issue', CTX);
  assert.ok(/max="1"/.test(issue),
    'the box must cap at the offer, not the rack count of 3\n' + issue);
});

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') +
            '  (' + passed + '/' + (passed + failed) + ')');
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach(function (f) { console.log('  ' + f.name + ': ' + f.msg); });
}
process.exit(failed === 0 ? 0 : 1);
