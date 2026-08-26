#!/usr/bin/env node
// THE "NO PRINTED STOCK, BUT THERE IS PLAIN CLOTH" ROW.
//
// docs/printing.md, "Issuing printed fabric" -> "On the row":
//
//   | no printed stock of this pattern | No printed stock - 120 Mtr of plain on L2 | Print... |
//
// and the reason it exists: "a row that goes blank while plain cloth sits on the
// rack is exactly the silent state that redesign was written to kill."
//
// Executes the REAL app/js/lot-allocator.js and the REAL lotShortHtml out of
// app/js/main.js - no port, no copy - so the kind the allocator returns and the
// line the screen draws cannot drift apart.
//
//   usage: node tools/print-shortreason.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
// The allocator runs inside a vm, so everything it builds carries THAT realm's
// Object/Array prototypes and deepStrictEqual refuses them on identity alone.
// Round-tripping through JSON compares the values, which is what is under test.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- load the real allocator --------------------------------------------------
const allocSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const ctx = { console, Math, Number, Object, String, Array, JSON };
vm.createContext(ctx);
vm.runInContext(allocSrc +
  '\nthis.A = { round2, applyLotAllocation, hasOwnStock, plainBaseStock, shortReasonFor };', ctx);
const A = ctx.A;

// ---- the real render, lifted out of main.js -----------------------------------
// Same extraction the store-ui test uses: pull the function bodies by name so a
// rename here fails loudly instead of testing a stale copy.
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');
function extract(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has function ' + name +
    ' - the UI contract changed; update tools/print-shortreason.test.js');
  let depth = 0, j = mainSrc.indexOf('{', i);
  for (let k = j; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i, j);
}
const uiCtx = { console, Math, Number, String, Object, Array };
vm.createContext(uiCtx);
vm.runInContext(['escapeHtml', 'fmt', 'lotShortHtml'].map(extract).join('\n') +
  '\nthis.UI = { lotShortHtml };', uiCtx);
const UI = uiCtx.UI;

// main.js also has to carry the click target, or the button renders onto nothing.
if (mainSrc.indexOf('function openPrintForBase(') < 0) {
  throw new Error('main.js has no openPrintForBase - the Print... button has no handler');
}

// ---- builders -----------------------------------------------------------------
// 137.16 cm cloth, 55x55 cut -> 2 marker rows across, so a 10-piece demand is
// 5 rows = 2.75 m. Every figure below is derived from that.
function line(planItemId, reqPcs, opts) {
  opts = opts || {};
  return { planId: opts.planId || 'PLAN1', planItemId, reqPieces: reqPcs,
           issPieces: opts.issPieces || 0, issuedLot: opts.issuedLot || '',
           issuedLotNo: opts.issuedLotNo || opts.issuedLot || '',
           salesOrder: 'SO-1', item: 'Cushion', isRemake: false,
           supervisorId: 'SUP-A', required: 2.75, issued: 0, reason: '' };
}
function roll(lotId, wash, opts) {
  opts = opts || {};
  return { lotId, lotNumber: opts.no || lotId, blocked: !!opts.blocked,
           wash: wash, unwash: opts.unwash || 0, inWash: opts.inWash || 0,
           form: 'Roll', pieces: [] };
}
function pieceLot(lotId, pieces, opts) {
  opts = opts || {};
  return { lotId, lotNumber: opts.no || lotId, blocked: !!opts.blocked,
           wash: opts.wash || 0, unwash: opts.unwash || 0, inWash: opts.inWash || 0,
           form: 'Pieces', pieces: pieces };
}
function fpiece(pieceId, lenCm, widCm, count, state) {
  return { pieceId, lengthCm: lenCm, widthCm: widCm,
           count: (count === undefined ? 1 : count),
           state: state || 'Wash', carton: 'C7' };
}
function material(m) {
  return Object.assign({
    materialId: 'M1', material: 'Linen / BP Flower', sku: 'RM-00112', unit: 'Mtr',
    isFabric: true, isReissue: false,
    fabricWidthCm: 137.16, cutWidth: 55, cutLength: 55,
    requiredPieces: 10, issuedPieces: 0, wasteIssuedPieces: 0, outstandingPieces: 10,
    required: 2.75, requiredTotal: 2.75, issued: 0, remaining: 2.75,
    freshMeters: 2.75, freshPieces: 10, piecesCoveredByWaste: 0,
    availableStock: 0, unwashedStock: 0, inWashStock: 0,
    lines: [line('IT1', 10)], wasteStock: [], wastePicks: [], lots: [],
    openExceptions: [],
    // The three fields getStoreMaterialRequirements now emits on every fabric
    // row. An empty printBase is plain cloth, which is most of the rack.
    printBase: '', printBaseName: '', printBaseLots: []
  }, m);
}
function allocate(m) {
  const data = [{ supervisorId: 'SUP-A', supervisorName: 'Ravi', materials: [m] }];
  A.applyLotAllocation(data);
  return m;
}

// The plain cloth behind the printed SKU, as the server sends it: the base's own
// lots, in exactly the same shape as this material's.
const BASE = {
  printBase: 'MB-9', printBaseName: 'Grey Sheeting / Plain / Grey',
  printBaseLots: [roll('LB2', 120, { no: 'L2' })]
};

// =====================================================================
console.log('\nPART A - a printed row with nothing printed, and plain cloth behind it');

test('A1 zero pieces + plain cloth on the base -> noPrinted, naming the base lot and its metres', () => {
  const m = allocate(material(BASE));
  assert.ok(m.shortReason, 'a short printed row must say why');
  assert.strictEqual(m.shortReason.kind, 'noPrinted');
  assert.strictEqual(m.shortReason.base, 'Grey Sheeting / Plain / Grey');
  assert.strictEqual(m.shortReason.baseId, 'MB-9');
  assert.deepStrictEqual(plain(m.shortReason.lots), [{ lotNumber: 'L2', qty: 120 }]);
});

test('A2 the row still asks for the cloth it needs - the reason is a reason, not a write-off', () => {
  const m = allocate(material(BASE));
  assert.strictEqual(m.remaining, 2.75, 'ceil(10/2) rows x 55 cm');
  assert.strictEqual(m.freshPieces, 10, 'still fully owed');
  assert.deepStrictEqual(plain(m.lotLines), [], 'nothing can be handed over');
});

test('A3 the line and the Print... button render, and the button carries the BASE id', () => {
  const m = allocate(material(BASE));
  const html = UI.lotShortHtml(m, 0, 0);
  assert.ok(html.indexOf('No printed stock') > -1, html);
  assert.ok(html.indexOf('120 Mtr of plain on <b>L2</b>') > -1, html);
  assert.ok(html.indexOf('Print&hellip;</button>') > -1, 'the button reads Print...');
  assert.ok(html.indexOf("openPrintForBase('MB-9')") > -1,
    'the button must open the PLAIN material, not the printed one: ' + html);
  assert.ok(html.indexOf('Grey Sheeting / Plain / Grey') > -1,
    'the base material is named somewhere on the control');
});

test('A4 greige plain counts - a print run may go out unwashed, so greige is cloth to print', () => {
  const m = allocate(material(Object.assign({}, BASE, {
    printBaseLots: [roll('LB2', 0, { no: 'L2', unwash: 80 })]
  })));
  assert.strictEqual(m.shortReason.kind, 'noPrinted');
  assert.deepStrictEqual(plain(m.shortReason.lots), [{ lotNumber: 'L2', qty: 80 }]);
});

test('A5 washed and greige on one base lot are one figure, and the biggest lot leads', () => {
  const m = allocate(material(Object.assign({}, BASE, {
    printBaseLots: [roll('LB1', 10, { no: 'L1', unwash: 5 }),
                    roll('LB2', 100, { no: 'L2', unwash: 20 })]
  })));
  assert.deepStrictEqual(plain(m.shortReason.lots),
    [{ lotNumber: 'L2', qty: 120 }, { lotNumber: 'L1', qty: 15 }]);
  const html = UI.lotShortHtml(m, 0, 0);
  assert.ok(html.indexOf('120 Mtr of plain on <b>L2</b>, 15 on <b>L1</b>') > -1, html);
});

test('A6 a BLOCKED base lot is not cloth he can send - it must not be offered', () => {
  const m = allocate(material(Object.assign({}, BASE, {
    printBaseLots: [roll('LB2', 120, { no: 'L2', blocked: true })]
  })));
  assert.notStrictEqual(m.shortReason.kind, 'noPrinted',
    'quarantined plain cloth cannot go to a printer');
  assert.strictEqual(m.shortReason.kind, 'nolots');
});

test('A7 a row that is fully served says nothing at all', () => {
  const m = allocate(material(Object.assign({}, BASE, {
    lots: [roll('LP', 3.00, { no: 'P1' })]
  })));
  assert.strictEqual(m.shortReason, null, 'the lot covers it; there is no shortfall to explain');
});

// =====================================================================
console.log('\nPART B - no plain cloth anywhere: fall through to the generic reason');

test('B1 no base at all (an ordinary printed SKU with Print_Base unset) -> the old reason', () => {
  const m = allocate(material({ printBase: '', printBaseName: '', printBaseLots: [] }));
  assert.strictEqual(m.shortReason.kind, 'nolots',
    'never invent a print action where there is nothing to print from');
});

test('B2 base is named but its rack is empty -> the old reason, NOT noPrinted', () => {
  const m = allocate(material(Object.assign({}, BASE, { printBaseLots: [] })));
  assert.notStrictEqual(m.shortReason.kind, 'noPrinted');
  assert.strictEqual(m.shortReason.kind, 'nolots');
});

test('B3 base lots exist but hold zero - a zero lot is not cloth', () => {
  const m = allocate(material(Object.assign({}, BASE, {
    printBaseLots: [roll('LB2', 0, { no: 'L2' })]
  })));
  assert.strictEqual(m.shortReason.kind, 'nolots');
});

test('B4 the generic reasons keep working underneath: cloth that no whole job fits', () => {
  const m = allocate(material(Object.assign({}, BASE, {
    printBaseLots: [],
    lots: [roll('LP', 1.10, { no: 'P1' })]
  })));
  assert.strictEqual(m.shortReason.kind, 'nofit');
  assert.strictEqual(m.shortReason.lot, 'P1');
});

// =====================================================================
console.log('\nPART C - printed stock that EXISTS is never called missing');

test('C1 greige printed pieces are printed stock - the row must not say there is none', () => {
  // P4 holds 3 unwashed pieces. The allocator correctly refuses them (there is
  // no way to wash a piece yet - docs/printing.md, "Washing pieces"), so the row
  // is short. But cloth IS printed and on the rack: telling him to go and print
  // more would send him to a printer over cloth that only needs washing.
  const m = allocate(material(Object.assign({}, BASE, {
    lots: [pieceLot('LP', [fpiece('p1', 300, 140, 3, 'Unwash')], { no: 'P4', unwash: 9 })],
    unwashedStock: 9
  })));
  assert.ok(m.shortReason, 'the row is still short and still has to say why');
  assert.notStrictEqual(m.shortReason.kind, 'noPrinted',
    'nine metres of printed cloth are on the rack, unwashed');
  // Today that is the generic "none of this shade left" line. The
  // "P4 . 3 pieces to wash" row is the OTHER half of the docs table and is not
  // built - this test exists so building it cannot be mistaken for a regression
  // here, and so this case can never fall into noPrinted.
  assert.strictEqual(m.shortReason.kind, 'empty');
  assert.strictEqual(A.hasOwnStock(m), true);
});

test('C2 washed printed pieces that fall short - still printed stock, still not noPrinted', () => {
  const m = allocate(material(Object.assign({}, BASE, {
    lots: [pieceLot('LP', [fpiece('p1', 100, 140, 1, 'Wash')], { no: 'P4', wash: 1.00 })]
  })));
  assert.notStrictEqual(m.shortReason.kind, 'noPrinted');
});

test('C3 a wash the row is waiting on OUTRANKS the print suggestion', () => {
  // Greige metres on the printed material's own lot: the allocator commits the
  // lot and asks for the wash. Washing comes back in days and a print run does
  // not, so the wash line is the one action worth printing.
  const m = allocate(material(Object.assign({}, BASE, {
    lots: [roll('LP', 0, { no: 'P4', unwash: 50 })], unwashedStock: 50
  })));
  assert.strictEqual(m.shortReason.kind, 'wash');
  assert.deepStrictEqual(plain(m.shortReason.lots), [{ lotNumber: 'P4', qty: 2.75 }]);
});

test('C4 a DRY PIN outranks it too - he cannot print his way out of a shade decision', () => {
  // The order was already cut off P4, and P4 is gone (the server drops an
  // emptied lot). Nothing printed is on the rack, so noPrinted would otherwise
  // fire - but the order cannot move at all until he answers the pin.
  const m = allocate(material(Object.assign({}, BASE, {
    lots: [], lines: [line('IT1', 10, { issuedLot: 'LP', issuedLotNo: 'P4' })]
  })));
  assert.strictEqual(m.shortReason.kind, 'pinnedDry');
  assert.strictEqual(m.shortReason.lot, 'P4');
});

test('C5 cloth at the wash house outranks it - it comes back in this shade', () => {
  // Pinned, because a lot too small to cover the order whole is never CHOSEN -
  // and atWash is about the lot this row is already committed to.
  const m = allocate(material(Object.assign({}, BASE, {
    lots: [roll('LP', 1.10, { no: 'P4', inWash: 40 })], inWashStock: 40,
    lines: [line('IT1', 10, { issuedLot: 'LP', issuedLotNo: 'P4' })]
  })));
  assert.strictEqual(m.shortReason.kind, 'atWash');
  assert.strictEqual(m.shortReason.lot, 'P4');
});

// =====================================================================
console.log('\nPART D - ordinary, non-printed fabric is untouched');

test('D1 plain fabric short of a whole job still reads nofit, with the same numbers', () => {
  const m = allocate(material({ lots: [roll('L1', 1.10)] }));
  assert.strictEqual(m.shortReason.kind, 'nofit');
  assert.strictEqual(m.shortReason.have, 1.1);
  assert.strictEqual(m.shortReason.need, 2.75);
  assert.strictEqual(UI.lotShortHtml(m, 0, 0).indexOf('Print&hellip;'), -1,
    'no Print button on cloth that is not printed');
});

test('D2 plain fabric with a blocked lot still reads blocked', () => {
  const m = allocate(material({ lots: [roll('L1', 18, { blocked: true })] }));
  assert.strictEqual(m.shortReason.kind, 'blocked');
});

test('D3 plain fabric fully served says nothing, and carries an empty printBase', () => {
  const m = allocate(material({ lots: [roll('L1', 3.00)] }));
  assert.strictEqual(m.shortReason, null);
  assert.strictEqual(m.printBase, '');
  assert.deepStrictEqual(plain(m.printBaseLots), []);
});

test('D4 a payload with no print fields at all (an older server) normalises, never throws', () => {
  const bare = material({ lots: [roll('L1', 1.10)] });
  delete bare.printBase; delete bare.printBaseName; delete bare.printBaseLots;
  const m = allocate(bare);
  assert.strictEqual(m.printBase, '');
  assert.strictEqual(m.printBaseName, '');
  assert.deepStrictEqual(plain(m.printBaseLots), []);
  assert.strictEqual(m.shortReason.kind, 'nofit');
});

// =====================================================================
console.log('\nPART E - the two helpers on their own');

test('E1 hasOwnStock counts greige, at-the-wash and quarantined cloth as stock', () => {
  assert.strictEqual(A.hasOwnStock({ lots: [] }), false);
  assert.strictEqual(A.hasOwnStock({ lots: [roll('L1', 0)] }), false);
  assert.strictEqual(A.hasOwnStock({ lots: [roll('L1', 0, { unwash: 3 })] }), true);
  assert.strictEqual(A.hasOwnStock({ lots: [roll('L1', 0, { inWash: 3 })] }), true);
  assert.strictEqual(A.hasOwnStock({ lots: [roll('L1', 9, { blocked: true })] }), true,
    'quarantined printed stock is still printed stock');
  assert.strictEqual(A.hasOwnStock({ lots: [pieceLot('LP', [fpiece('p', 300, 140, 2)])] }), true);
  assert.strictEqual(A.hasOwnStock({ lots: [pieceLot('LP', [fpiece('p', 300, 140, 0)])] }), false);
});

test('E2 plainBaseStock needs a base id AND cloth on it', () => {
  assert.strictEqual(A.plainBaseStock({ printBase: '', printBaseLots: [roll('L2', 9)] }), null);
  assert.strictEqual(A.plainBaseStock({ printBase: 'B', printBaseLots: [] }), null);
  const got = A.plainBaseStock({ printBase: 'B', printBaseName: 'N',
                                 printBaseLots: [roll('L2', 9, { unwash: 1 })] });
  assert.deepStrictEqual(plain(got), { id: 'B', name: 'N', lots: [{ lotNumber: 'L2', qty: 10 }] });
});

// =====================================================================
console.log('');
if (failed) {
  console.log(failed + ' failed, ' + passed + ' passed');
  failures.forEach(f => console.log('  - ' + f.name + ': ' + f.msg));
  process.exit(1);
}
console.log(passed + ' passed');
