#!/usr/bin/env node
// Raw_Material.Quantity maintenance - commit 61fa3a5 "updating raw materail
// quantity" plus the working-tree movement-block move in issueMaterials.
//
// THE DEFINITION the commit establishes (issueMaterials.dg:2145-2146):
//   Quantity = Wash_Quantity + Unwash_Quantity + Unallocated_Qty   ("the shelf")
//   Total holdings = shelf + In_Transit + Disputed (+ In_Wash + In_Print)
// Every writer that moves one of the three shelf counters must rewrite
// Quantity in the same pass, EMPTY-safe, or the figure drifts from reality.
//
// The user-stated target: "quantity in creator will be equal to stock on hand
// in inventory". These tests verify the MAINTENANCE of that definition across
// every writer. The definitional split against reconcileRawMaterial (which
// compares the SIX-counter sum to Inventory stock_on_hand) is pinned as a
// documented finding at the bottom - see F-series.
//
// Ports mirror the .dg blocks line for line:
//   storeInward     saveStockInward.dg:287-318
//   issueFabric     issueMaterials.dg:2148-2166   (fabric branch)
//   issueNonFabric  issueMaterials.dg:2156-2158
//   washCycle       completeWashRequest.dg:206-214 / cancelWashRequest.dg:131-139
//   sendToPrintMove sendToPrint.dg:680-694
//   printReceived   receiveFromPrint.dg:630-639
//   disputeRestore  resolveDispute.dg:700-724
//   syncUnallocated syncPurchaseInflow.dg:1050-1072
//
//   usage: node tools/raw-quantity.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- Deluge semantics ----------------------------------------------------------
// A Creator field never written is EMPTY, not null; ifnull() does not catch it.
function rd(v) { const s = (v === null || v === undefined) ? '' : String(v).trim(); return s === '' ? 0 : parseFloat(s); }
function d2(n) { return Math.round(n * 100) / 100; }

// ---- the record ----------------------------------------------------------------
function mat(over) {
  // quantity:'EMPTY' simulates a field Creator has never written - distinct
  // from a real 0, and exactly what a pre-commit fabric SKU looks like.
  return Object.assign({
    Wash_Quantity: 0, Unwash_Quantity: 0, Unallocated_Qty: 0,
    In_Wash_Qty: 0, In_Print_Qty: 0, In_Transit_Qty: 0, Disputed_Qty: 0,
    Quantity: 0, Is_Fabric: true,
  }, over || {});
}
function emptyLike(wash) {
  const r = mat({ Wash_Quantity: wash });
  r.Unwash_Quantity = undefined;
  r.Unallocated_Qty = undefined;
  r.Quantity = undefined;
  return r;
}
// THE INVARIANT under test, after every writer.
function assertShelf(rec, where) {
  const expect = d2(rd(rec.Wash_Quantity) + rd(rec.Unwash_Quantity) + rd(rec.Unallocated_Qty));
  assert.strictEqual(d2(rd(rec.Quantity)), expect,
    where + ': Quantity ' + rd(rec.Quantity) + ' != shelf ' + expect +
    ' (W=' + rd(rec.Wash_Quantity) + ' U=' + rd(rec.Unwash_Quantity) + ' A=' + rd(rec.Unallocated_Qty) + ')');
}
function totalOwned(rec) {
  return d2(shelf(rec) + rd(rec.In_Transit_Qty) + rd(rec.Disputed_Qty) + rd(rec.In_Wash_Qty) + rd(rec.In_Print_Qty));
}
function shelf(rec) { return d2(rd(rec.Wash_Quantity) + rd(rec.Unwash_Quantity) + rd(rec.Unallocated_Qty)); }

// ---- ports ---------------------------------------------------------------------
// saveStockInward.dg:287-318 - fromNew into the state, part out of Unallocated.
function storeInward(rec, state, qty, unallocHave) {
  let fromUnalloc = qty;
  if (fromUnalloc > unallocHave) fromUnalloc = unallocHave;
  if (fromUnalloc < 0) fromUnalloc = 0;
  const fromNew = qty - fromUnalloc;
  let matUnwashOut = 0.0, matWashOut = 0.0;
  if (state === 'Wash') {
    rec.Wash_Quantity = rd(rec.Wash_Quantity) + fromNew;
    matUnwashOut = rd(rec.Unwash_Quantity);
    matWashOut = rd(rec.Wash_Quantity);
  } else {
    rec.Unwash_Quantity = rd(rec.Unwash_Quantity) + fromNew;
    matUnwashOut = rd(rec.Unwash_Quantity);
    matWashOut = rd(rec.Wash_Quantity);
  }
  if (fromUnalloc > 0) rec.Unallocated_Qty = unallocHave - fromUnalloc;
  rec.Quantity = matWashOut + matUnwashOut + rd(rec.Unallocated_Qty);
  return { added: qty };
}

// issueMaterials.dg:2148-2166 - fabric moves shelf -> transit, NOT consumption.
function issueFabric(rec, available, issueQty) {
  const balance = available - issueQty;
  rec.Wash_Quantity = balance;
  rec.Quantity = balance + rd(rec.Unwash_Quantity) + rd(rec.Unallocated_Qty);   // EMPTY-safe terms
  rec.In_Transit_Qty = rd(rec.In_Transit_Qty) + issueQty;
  return balance;
}
// :2156-2158 - non-fabric consumes directly.
function issueNonFabric(rec, available, issueQty) {
  rec.Quantity = available - issueQty;
  return rec.Quantity;
}

// completeWashRequest.dg:206-214 / cancelWashRequest.dg:131-139
function completeWash(rec, fromInWash, fromGreige, moveQty) {
  rec.In_Wash_Qty = rd(rec.In_Wash_Qty) - fromInWash;
  rec.Unwash_Quantity = rd(rec.Unwash_Quantity) - fromGreige;
  rec.Wash_Quantity = rd(rec.Wash_Quantity) + moveQty;
  rec.Quantity = rd(rec.Wash_Quantity) + rd(rec.Unwash_Quantity) + rd(rec.Unallocated_Qty);
}
function cancelWash(rec, moveQty) {
  rec.In_Wash_Qty = rd(rec.In_Wash_Qty) - moveQty;
  rec.Unwash_Quantity = rd(rec.Unwash_Quantity) + moveQty;
  rec.Quantity = rd(rec.Wash_Quantity) + rd(rec.Unwash_Quantity) + rd(rec.Unallocated_Qty);
}

// sendToPrint.dg:680-694 / receiveFromPrint.dg:630-639
function sendToPrintMove(rec, metresSent, srcState) {
  if (srcState === 'Wash') rec.Wash_Quantity = rd(rec.Wash_Quantity) - metresSent;
  else rec.Unwash_Quantity = rd(rec.Unwash_Quantity) - metresSent;
  rec.In_Print_Qty = rd(rec.In_Print_Qty) + metresSent;
  rec.Quantity = rd(rec.Wash_Quantity) + rd(rec.Unwash_Quantity) + rd(rec.Unallocated_Qty);
}
function printReceived(rec, washMetres, unwashMetres) {
  rec.Wash_Quantity = rd(rec.Wash_Quantity) + washMetres;
  rec.Unwash_Quantity = rd(rec.Unwash_Quantity) + unwashMetres;
  rec.Quantity = rd(rec.Wash_Quantity) + rd(rec.Unwash_Quantity) + rd(rec.Unallocated_Qty);
}

// resolveDispute.dg:700-724 - Store_Correction puts cloth back on the shelf.
function disputeRestore(rec, takeD) {
  rec.Disputed_Qty = rd(rec.Disputed_Qty) - takeD;
  if (rec.Is_Fabric === true) {
    rec.Wash_Quantity = rd(rec.Wash_Quantity) + takeD;
    rec.Quantity = rec.Wash_Quantity + rd(rec.Unwash_Quantity) + rd(rec.Unallocated_Qty);
  } else {
    rec.Quantity = rd(rec.Quantity) + takeD;
  }
}

// syncPurchaseInflow.dg:1052-1062 - purchase correction into Unallocated.
function syncUnallocated(rec, moveQty) {
  rec.Unallocated_Qty = rd(rec.Unallocated_Qty) + moveQty;
  rec.Quantity = rec.Unallocated_Qty + rd(rec.Unwash_Quantity) + rd(rec.Wash_Quantity);
}

// ---- tests ---------------------------------------------------------------------

console.log('\nthe maintenance invariant holds after every writer');

test('Q1 inward: shelf rises by the booking, Quantity tracks it', () => {
  const r = mat();
  storeInward(r, 'Wash', 50, 0);
  assertShelf(r, 'after inward');
  assert.strictEqual(d2(r.Quantity), 50);
  storeInward(r, 'Unwash', 20, 0);
  assertShelf(r, 'after greige inward');
  assert.strictEqual(d2(r.Quantity), 70);
});

test('Q2 the wash cycle: greige-through is shelf-neutral, in-wash returns RAISE the shelf they had left', () => {
  const r = mat({ Wash_Quantity: 30, Unwash_Quantity: 20, In_Wash_Qty: 12 });
  r.Quantity = rd(r.Wash_Quantity) + rd(r.Unwash_Quantity);   // consistent start: 50
  // 7 of the 12 at the wash house come back washed, 4 more washed straight
  // from greige. moveQty must equal fromInWash + fromGreige for the ledger to
  // close; 5 remain at the wash house.
  completeWash(r, 7, 4, 11);
  assertShelf(r, 'after completeWash');
  assert.strictEqual(d2(r.Quantity), 57, '50 - 4 greige washed away + 11 back = the 7 in-wash returns');
  assert.strictEqual(d2(r.In_Wash_Qty), 5);

  // A cancelled wash request comes back to the GREIGE shelf - off In_Wash,
  // which was never on the shelf, so the shelf rises by the cancelled metres.
  cancelWash(r, 5);
  assertShelf(r, 'after cancelWash');
  assert.strictEqual(d2(r.Quantity), 62, 'the 5 cancelled metres are back on the rack');
  assert.strictEqual(d2(r.In_Wash_Qty), 0);
});

test('Q3 ISSUE: fabric Quantity falls by exactly what left the shelf - transit is not on it', () => {
  const r = mat({ Wash_Quantity: 42.6, Unwash_Quantity: 8 });
  const ownedBefore = totalOwned(r);
  issueFabric(r, 42.6, 10);
  assertShelf(r, 'after issue');
  assert.strictEqual(d2(r.Wash_Quantity), 32.6);
  assert.strictEqual(d2(r.In_Transit_Qty), 10);
  assert.strictEqual(d2(r.Quantity), 40.6, 'shelf only');
  assert.strictEqual(totalOwned(r), ownedBefore, 'the company still owns all 50.60');
});

test('Q4 non-fabric still consumes directly - untouched by this change', () => {
  const r = mat({ Is_Fabric: false, Quantity: 100 });
  issueNonFabric(r, 100, 7);
  assert.strictEqual(d2(r.Quantity), 93);
});

test('Q5 EMPTY fields: a fabric SKU the old code never wrote normalises instead of NaN-ing', () => {
  const r = emptyLike(42.6);          // Unwash/Unallocated/Quantity all EMPTY
  issueFabric(r, 42.6, 2.75);
  assertShelf(r, 'after first-ever write');
  assert.strictEqual(d2(r.Quantity), 39.85);
  assert.ok(Number.isFinite(r.Quantity), 'no NaN reached the record');
});

test('Q6 print round trip: send drops the plain shelf, receipt raises the printed one, loss leaves both', () => {
  const plain = mat({ Wash_Quantity: 42.6 });
  const printed = mat();              // freshly minted, everything EMPTY-ish zero
  sendToPrintMove(plain, 20, 'Wash');
  assertShelf(plain, 'plain after send');
  assert.strictEqual(d2(plain.Quantity), 22.6, 'cloth at the printer is OFF the plain shelf');
  assert.strictEqual(d2(plain.In_Print_Qty), 20);
  // 17.25 comes back, 2.75 written off for ever.
  printReceived(printed, 17.25, 0);
  assertShelf(printed, 'printed after receipt');
  assert.strictEqual(d2(printed.Quantity), 17.25);
  assert.strictEqual(totalOwned(plain), 42.6, 'the send alone moved nothing the company owns');
});

test('Q7 a restored dispute comes back ON the shelf, and Quantity follows it up', () => {
  const r = mat({ Wash_Quantity: 32.6, In_Transit_Qty: 10, Disputed_Qty: 4 });
  const before = shelf(r);
  disputeRestore(r, 4);
  assertShelf(r, 'after Store_Correction');
  assert.strictEqual(d2(r.Quantity), before + 4);
  assert.strictEqual(d2(r.Disputed_Qty), 0);
});

test('Q8 an inventory-side correction lands in Unallocated and the shelf absorbs it', () => {
  const r = mat({ Wash_Quantity: 30, Unwash_Quantity: 8 });
  syncUnallocated(r, 12);
  assertShelf(r, 'after sync correction');
  assert.strictEqual(d2(r.Quantity), 50);
});

console.log('\nlifecycle - the ledger end to end');

test('L1 inward -> wash cycle -> two issues -> partial restore: every figure reconciles', () => {
  const r = mat();
  storeInward(r, 'Wash', 100, 0);
  storeInward(r, 'Unwash', 40, 0);
  assert.strictEqual(totalOwned(r), 140);

  // raiseMaterialException's move: 15 greige go OUT to the wash house.
  r.Unwash_Quantity = rd(r.Unwash_Quantity) - 15;
  r.In_Wash_Qty = rd(r.In_Wash_Qty) + 15;
  assert.strictEqual(totalOwned(r), 140);

  completeWash(r, 15, 5, 20);         // all 15 come back washed, plus 5 greige straight through
  assert.strictEqual(totalOwned(r), 140);

  issueFabric(r, rd(r.Wash_Quantity), 30);   // handover 1
  assert.strictEqual(totalOwned(r), 140);
  issueFabric(r, rd(r.Wash_Quantity), 12.5); // handover 2
  assert.strictEqual(totalOwned(r), 140);
  assertShelf(r, 'after both issues');

  // 6 of the second handover never arrive: disputed, then restored by the store.
  r.Disputed_Qty = rd(r.Disputed_Qty) + 6;
  r.In_Transit_Qty = rd(r.In_Transit_Qty) - 6;
  disputeRestore(r, 6);
  assertShelf(r, 'after restore');
  // Owned total is now 134: those 6 metres were received away by handover 1's
  // settlement... modelled here as transit settling without restoration.
  r.In_Transit_Qty = rd(r.In_Transit_Qty) - 36.5;   // supervisor confirms the rest
  assert.strictEqual(d2(totalOwned(r)), 103.5,
    'owned = shelf ' + shelf(r) + ' + remaining transit - everything confirmed into production');

  const invExpect = 140;              // Inventory was told NOTHING since inward
  assert.ok(totalOwned(r) < invExpect,
    'with consumption adjustments disabled, Creator-owned diverges from Inventory by exactly what production consumed');
});

console.log('\nstatic contract (deluge text passes)');

const dgPath = f => fs.readFileSync(path.join(__dirname, '..', 'deluge', f), 'utf8');
const WRITERS = [
  ['cancelWashRequest', /matRec\.Quantity\s*=\s*if\(qW/, 1],
  ['completeWashRequest', /matRec\.Quantity\s*=\s*if\(qW/, 1],
  ['raiseMaterialException', /rmMv\.Quantity\s*=\s*if\(qW/, 1],
  ['receiveFromPrint', /pmatNew\.Quantity\s*=\s*if\(qW/, 1],
  ['resolveDispute', /rm\.Quantity\s*=\s*rm\.Wash_Quantity \+ if\(qU/, 1],
  ['resolveStockDispute', /rm\.Quantity\s*=\s*rm\.Wash_Quantity \+ if\(qU/, 1],
  ['saveStockInward', /rmUpd\.Quantity\s*=\s*matWashOut \+ matUnwashOut/, 1],
  ['sendToPrint', /rmUpd\.Quantity\s*=\s*if\(qW/, 1],
];

test('S1 every committed writer rewrites Quantity with the SAME three-shelf-term formula', () => {
  for (const [f, re] of WRITERS) {
    assert.ok(re.test(dgPath(f + '.dg')), f + '.dg lost its Quantity rewrite');
  }
  assert.ok(/matRec\.Quantity\s*=\s*balance \+ if\(qU/.test(dgPath('issueMaterials.dg')),
    'issueMaterials fabric branch lost the rewrite');
});

test('S2 the read side sums the SAME three terms (getRawMaterialsList)', () => {
  const src = dgPath('getRawMaterialsList.dg');
  assert.ok(/totalQty\s*=\s*washQty \+ unwashQty \+ unallocQty/.test(src),
    'list total drifted from the maintained definition');
});

test('S3 DOCUMENTED SPLIT: reconcile compares the SIX-counter sum to Inventory, Quantity is the THREE-counter shelf', () => {
  // reconcileRawMaterial.dg:138. Not a bug in this commit - but it means
  // "Quantity == stock_on_hand" and "reconcile agrees" are DIFFERENT claims.
  // Whenever transit/disputed/in-wash/in-print are non-zero, the two figures
  // differ by exactly those counters. Pinned so the choice stays visible.
  const src = dgPath('reconcileRawMaterial.dg');
  assert.ok(/creatorQty\s*=\s*baseQty \+ tS\.toDecimal\(\) \+ dS\.toDecimal\(\) \+ iwS\.toDecimal\(\) \+ ipS\.toDecimal\(\) \+ unS\.toDecimal\(\)/.test(src),
    'reconcile changed its creator-side definition - revisit this pin');
});

test('S4 DOCUMENTED: the Consumption adjustment enqueue at receipt is DISABLED (receiveMaterials)', () => {
  const src = dgPath('receiveMaterials.dg');
  assert.ok(/INVENTORY ADJUSTMENT DISABLED FOR NOW/.test(src));
  assert.ok(!/\n\s*invQRes\s*=\s*thisapp\.queueInventoryPost\("Consumption"/.test(src),
    'consumption posting came back - the Q-series divergence notes need revisiting');
});

// ---- summary -------------------------------------------------------------------

console.log('\n========================================');
console.log('raw-quantity: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}
