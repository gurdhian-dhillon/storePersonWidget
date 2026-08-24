#!/usr/bin/env node
// Faithful Node port of the ledger arithmetic in deluge/syncPurchaseInflow.dg,
// plus lifecycle tests over it. The port mirrors the .dg line for line - same
// delta, same clamp at zero, same reversal - so a failure here names a real
// Deluge line.
//
//   usage: node tools/inflow.test.js
//
// What is being protected. Every one of these is a way the sync could add or
// destroy stock silently, which is the only failure mode that matters here:
//
//   - an unchanged document applies NOTHING on a second run
//   - an edited document applies the DELTA, never the total
//   - a reduction stops at zero and never reaches into a lot
//   - a removed line gives back exactly what it took
//   - an unmapped line applies nothing and lands in full once mapped
//   - fabric goes to Unallocated_Qty, everything else to Quantity

'use strict';
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- The world -----------------------------------------------------------

// Raw_Material, keyed by Creator id.
function material(opts) {
  return {
    id: opts.id,
    sku: opts.sku,
    invId: opts.invId,           // Inventory_Item_ID, '' when unmapped
    isFabric: !!opts.isFabric,
    Unallocated_Qty: opts.unallocated || 0,
    Quantity: opts.quantity || 0
  };
}

function world(mats) {
  return {
    mats: mats,
    ledger: [],                  // Inventory_Inflow rows
    unmappedBySku: {},           // Raw_Material with a SKU but no Inventory_Item_ID
    MAIN: 'LOC-MAIN'
  };
}

function findByInv(w, invId) {
  if (!invId) return null;
  for (const m of w.mats) if (m.invId === invId) return m;
  return null;
}

function ledgerRow(w, key) {
  for (const r of w.ledger) if (r.key === key) return r;
  return null;
}

// ---- PORT: one run of syncPurchaseInflow over a set of documents ---------
//
// syncPurchaseInflow.dg, the per-line block. A document is a
//   { id, no, date, modified, location, status, lines: [{ lineId, itemId, qty }] }
// and `date`/`cutover` are plain sortable strings here - the Deluge side
// compares real dates, which behave the same way.

function syncRun(w, docs, opts) {
  opts = opts || {};
  const cutover = opts.cutover || '2000-01-01';
  const source = opts.source || 'Receive';
  const out = { opened: 0, unchanged: 0, skippedDocs: 0, skippedLines: 0,
                applied: 0, reversed: 0, unmapped: 0, blocked: 0,
                created: 0, stamped: 0, notRaw: 0, noWidth: 0 };

  // Which documents this run opens. Mirrors the list-side filter.
  const retryDocs = new Set();
  for (const r of w.ledger) {
    if (r.Sync_Status === 'Unmapped' || r.Sync_Status === 'Blocked_Reduction') retryDocs.add(r.docId);
  }

  for (const d of docs) {
    const st = (d.status || 'received').toLowerCase();
    if (st === 'in_transit' || st === 'draft' || st === 'void' || st === 'cancelled') {
      out.skippedDocs++;
      continue;
    }
    const rst = (d.receivedStatus || '').toLowerCase();
    if (rst !== '' && rst !== 'received') {
      out.skippedDocs++;
      continue;
    }
    if (d.date < cutover) continue;

    const seenMod = (function () {
      for (const r of w.ledger) if (r.docId === d.id) return r.Doc_Modified;
      return '';
    })();
    if (seenMod !== '' && seenMod === d.modified && !retryDocs.has(d.id)) {
      out.unchanged++;
      continue;
    }

    out.opened++;
    const seenKeys = new Set();

    for (const ln of d.lines) {
      const key = d.id + '|' + ln.lineId;
      seenKeys.add(key);

      const prev = ledgerRow(w, key);
      const haveQty = prev ? prev.Applied_Qty : 0;
      const docQty = ln.qty;

      const mat = findByInv(w, ln.itemId);
      const lineLoc = ln.warehouse || d.location;

      let status = 'Applied';
      const wantDelta = docQty - haveQty;
      let moveQty = wantDelta;

      // --- auto-create, when Creator has never heard of the item ---
      let notRaw = false;
      let mat2 = mat;
      if (!mat2 && opts.autoCreate) {
        const inv = (opts.inventoryItems || {})[ln.itemId];
        if (!inv) {
          // could not read it
        } else if (inv.sku && w.unmappedBySku[inv.sku.toUpperCase()]) {
          // 1. exists in Creator under this SKU, unmapped - stamp, never mint
          mat2 = w.unmappedBySku[inv.sku.toUpperCase()];
          mat2.invId = ln.itemId;
          delete w.unmappedBySku[inv.sku.toUpperCase()];
          out.stamped++;
        } else if (!opts.cfProductType) {
          // constants not set - never guess
        } else if ((inv.productType || '').toLowerCase() !== 'raw material') {
          notRaw = true;
        } else if (!inv.sku || !inv.name) {
          // refuse: SKU is the join key, Name is mandatory
        } else {
          // 3. mint it
          mat2 = material({
            id: 'NEW-' + ln.itemId, sku: inv.sku, invId: ln.itemId,
            isFabric: /fabric/i.test(inv.type || '')
          });
          mat2.width = inv.width || 0;
          w.mats.push(mat2);
          out.created++;
          if (mat2.isFabric && !mat2.width) out.noWidth++;
        }
      }

      // No location test: every location counts. See the note in the .dg -
      // stock_on_hand is org-wide and Creator has no location concept, so
      // ignoring a location guarantees drift nothing can explain.
      if (!mat2 && notRaw) {
        status = 'Skipped_Not_Raw_Material'; moveQty = 0; out.notRaw++;
      } else if (!mat2) {
        status = 'Unmapped'; moveQty = 0; out.unmapped++;
      } else if (source === 'Bill' && ln.receiveItemId) {
        status = 'Skipped_Duplicate'; moveQty = 0; out.skippedLines++;
      }

      // targetTxt is decided only once isFabTxt is final - the auto-create
      // can flip it. Same ordering as the .dg.
      const target = (mat2 && mat2.isFabric) ? 'Unallocated' : 'Quantity';

      if (status === 'Applied' && moveQty !== 0) {
        const haveNow = target === 'Unallocated' ? mat2.Unallocated_Qty : mat2.Quantity;
        if (moveQty < 0 && (haveNow + moveQty) < 0) {
          moveQty = -haveNow;
          status = 'Blocked_Reduction';
          out.blocked++;
        }
      }

      if (status !== 'Unmapped' && status !== 'Skipped_Not_Raw_Material' && moveQty !== 0) {
        if (target === 'Unallocated') mat2.Unallocated_Qty += moveQty;
        else mat2.Quantity += moveQty;
        out.applied++;
      }

      const newApplied = haveQty + moveQty;
      if (prev) {
        prev.Doc_Qty = docQty;
        prev.Applied_Qty = newApplied;
        prev.Doc_Modified = d.modified;
        prev.Sync_Status = status;
      } else {
        w.ledger.push({
          key: key, docId: d.id, lineId: ln.lineId, itemId: ln.itemId,
          Material: mat2 ? mat2.id : '', Target: target,
          Doc_Qty: docQty, Applied_Qty: newApplied,
          Doc_Modified: d.modified, Sync_Status: status
        });
      }
    }

    // A line the document no longer has.
    for (const r of w.ledger) {
      if (r.docId !== d.id || seenKeys.has(r.key)) continue;

      const backQty = r.Applied_Qty;
      let gonMove = 0;
      if (backQty > 0 && r.Material !== '') {
        const gm = w.mats.find(function (m) { return m.id === r.Material; });
        const gonHave = r.Target === 'Unallocated' ? gm.Unallocated_Qty : gm.Quantity;
        gonMove = Math.min(backQty, gonHave);
        if (gonMove > 0) {
          if (r.Target === 'Unallocated') gm.Unallocated_Qty -= gonMove;
          else gm.Quantity -= gonMove;
          out.reversed++;
        }
      }
      r.Doc_Qty = 0;
      r.Applied_Qty = backQty - gonMove;
      r.Doc_Modified = d.modified;
      r.Sync_Status = gonMove < backQty ? 'Blocked_Reduction' : 'Applied';
      if (gonMove < backQty) out.blocked++;
    }
  }

  return out;
}

// ---- Fixtures ------------------------------------------------------------

const LINEN = { id: 'M1', sku: 'RM-00011', invId: 'INV-11', isFabric: true };
const THREAD = { id: 'M2', sku: 'RM-00050', invId: 'INV-50', isFabric: false };

function freshWorld() {
  return world([material(LINEN), material(THREAD)]);
}

function receive(over) {
  return Object.assign({
    id: 'PR1', no: 'PR-00001', date: '2026-09-01', modified: 't1',
    location: 'LOC-MAIN', status: 'received',
    lines: [{ lineId: 'L1', itemId: 'INV-11', qty: 200 }]
  }, over || {});
}

// ---- Tests ---------------------------------------------------------------

console.log('\nsyncPurchaseInflow ledger\n');

test('fabric lands in Unallocated_Qty, never in a lot and never in Quantity', function () {
  const w = freshWorld();
  syncRun(w, [receive()]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 200);
  assert.strictEqual(w.mats[0].Quantity, 0);
});

test('non-fabric lands in Quantity', function () {
  const w = freshWorld();
  syncRun(w, [receive({ lines: [{ lineId: 'L1', itemId: 'INV-50', qty: 12 }] })]);
  assert.strictEqual(w.mats[1].Quantity, 12);
  assert.strictEqual(w.mats[1].Unallocated_Qty, 0);
});

test('THE ONE THAT MATTERS: an unchanged document adds nothing on a second run', function () {
  const w = freshWorld();
  syncRun(w, [receive()]);
  const r = syncRun(w, [receive()]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 200, 'a re-read must not re-add');
  assert.strictEqual(r.unchanged, 1);
  assert.strictEqual(r.opened, 0, 'and must not cost a call');
});

test('an edited document applies the delta, not the total', function () {
  const w = freshWorld();
  syncRun(w, [receive()]);
  syncRun(w, [receive({ modified: 't2', lines: [{ lineId: 'L1', itemId: 'INV-11', qty: 260 }] })]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 260, 'expected 200 + 60, not 200 + 260');
});

test('a downward correction takes back only the difference', function () {
  const w = freshWorld();
  syncRun(w, [receive()]);
  syncRun(w, [receive({ modified: 't2', lines: [{ lineId: 'L1', itemId: 'INV-11', qty: 180 }] })]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 180);
});

test('a reduction stops at zero and never reaches into a lot', function () {
  const w = freshWorld();
  syncRun(w, [receive()]);
  // The store person gives 195 of the 200 a tone; saveStockInward drains
  // Unallocated_Qty by that much. Only 5 is left to take back.
  w.mats[0].Unallocated_Qty -= 195;
  const r = syncRun(w, [receive({ modified: 't2', lines: [{ lineId: 'L1', itemId: 'INV-11', qty: 180 }] })]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 0, 'must not go negative');
  assert.strictEqual(r.blocked, 1, 'and must say so');
  assert.strictEqual(ledgerRow(w, 'PR1|L1').Applied_Qty, 195, 'the unapplied 15 stays owed');
});

test('a blocked reduction completes later, once cloth comes back to Unallocated', function () {
  const w = freshWorld();
  syncRun(w, [receive()]);
  w.mats[0].Unallocated_Qty -= 195;
  syncRun(w, [receive({ modified: 't2', lines: [{ lineId: 'L1', itemId: 'INV-11', qty: 180 }] })]);
  // Nothing about the document changed - the retry has to come from the
  // Blocked_Reduction row, not from last_modified_time.
  w.mats[0].Unallocated_Qty += 40;
  const r = syncRun(w, [receive({ modified: 't2', lines: [{ lineId: 'L1', itemId: 'INV-11', qty: 180 }] })]);
  assert.strictEqual(r.opened, 1, 'a blocked document must be re-opened');
  assert.strictEqual(w.mats[0].Unallocated_Qty, 25, 'expected 40 - the 15 still owed');
  assert.strictEqual(ledgerRow(w, 'PR1|L1').Applied_Qty, 180);
});

test('a removed line gives back exactly what it took', function () {
  const w = freshWorld();
  syncRun(w, [receive({ lines: [
    { lineId: 'L1', itemId: 'INV-11', qty: 200 },
    { lineId: 'L2', itemId: 'INV-50', qty: 12 }
  ] })]);
  assert.strictEqual(w.mats[1].Quantity, 12);
  syncRun(w, [receive({ modified: 't2', lines: [{ lineId: 'L1', itemId: 'INV-11', qty: 200 }] })]);
  assert.strictEqual(w.mats[1].Quantity, 0);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 200, 'the surviving line is untouched');
});

test('an unmapped line applies nothing, then lands in full once mapped', function () {
  const w = freshWorld();
  const r1 = syncRun(w, [receive({ lines: [{ lineId: 'L1', itemId: 'INV-99', qty: 75 }] })]);
  assert.strictEqual(r1.unmapped, 1);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 0);
  assert.strictEqual(w.mats[1].Quantity, 0);

  // Somebody stamps Inventory_Item_ID. The document has not changed.
  w.mats[1].invId = 'INV-99';
  const r2 = syncRun(w, [receive({ lines: [{ lineId: 'L1', itemId: 'INV-99', qty: 75 }] })]);
  assert.strictEqual(r2.opened, 1, 'an unmapped document must be re-opened');
  assert.strictEqual(w.mats[1].Quantity, 75);
});

test('an in-transit receive moves nothing - the cloth is on a lorry', function () {
  const w = freshWorld();
  const r = syncRun(w, [receive({ status: 'in_transit' })]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 0);
  assert.strictEqual(r.skippedDocs, 1);
});

test('a receive at any location lands - the first real one came in at Head Office', function () {
  const w = freshWorld();
  const r = syncRun(w, [receive({ location: 'LOC-HEAD-OFFICE' })]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 200, 'a location filter would have dropped a real arrival');
  assert.strictEqual(r.skippedLines, 0);
});

test('a receive whose received_status is not "received" moves nothing', function () {
  const w = freshWorld();
  // status runs on to "billed" once the money side happens, so it stops being
  // the field that says whether the cloth arrived.
  const r = syncRun(w, [receive({ status: 'billed', receivedStatus: 'pending' })]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 0);
  assert.strictEqual(r.skippedDocs, 1);
});

test('a billed receive that WAS received still lands', function () {
  const w = freshWorld();
  // Exactly the shape probePurchaseInflow read back off the live org.
  syncRun(w, [receive({ status: 'billed', receivedStatus: 'received' })]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 200);
});

test('THE CUTOVER: documents from before go-live are never applied', function () {
  const w = freshWorld();
  syncRun(w, [receive({ date: '2026-06-01' })], { cutover: '2026-09-01' });
  assert.strictEqual(w.mats[0].Unallocated_Qty, 0, 'this stock is already in the opening balance');
});

test('a bill line that names a receive is refused, not double-counted', function () {
  const w = freshWorld();
  const r = syncRun(w, [receive({ lines: [
    { lineId: 'L1', itemId: 'INV-11', qty: 200, receiveItemId: 'RI-1' }
  ] })], { source: 'Bill' });
  assert.strictEqual(w.mats[0].Unallocated_Qty, 0);
  assert.strictEqual(r.skippedLines, 1);
});

test('two documents for one material accumulate', function () {
  const w = freshWorld();
  syncRun(w, [
    receive(),
    receive({ id: 'PR2', no: 'PR-00002', lines: [{ lineId: 'L1', itemId: 'INV-11', qty: 55 }] })
  ]);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 255);
  // Same line id on a different document must not collide in the ledger.
  assert.strictEqual(w.ledger.length, 2);
});

// ---- auto-create ---------------------------------------------------------

const AC = {
  autoCreate: true,
  cfProductType: 'CF-PRODUCT-TYPE',
  inventoryItems: {
    'INV-NEW-FAB': { sku: 'RM-00099', name: 'Linen 60s', unit: 'MTR - m',
                     productType: 'Raw Material', type: 'Fabric', width: 58 },
    'INV-NEW-PRT': { sku: 'RM-00098', name: 'Printed voile', unit: 'MTR - m',
                     productType: 'Raw Material', type: 'Printed fabric', width: 44 },
    'INV-NEW-ACC': { sku: 'RM-00097', name: 'Cotton thread', unit: 'Cone',
                     productType: 'Raw Material', type: '' },
    'INV-NEW-NOW': { sku: 'RM-00096', name: 'Mystery cloth', unit: 'MTR - m',
                     productType: 'Raw Material', type: 'Fabric' },
    'INV-NEW-FIN': { sku: 'SKU-00001', name: 'Napkin set', unit: 'pcs',
                     productType: 'Finished Goods', type: '' },
    'INV-NEW-NOSKU': { sku: '', name: 'HeliosZoho test item', unit: 'MTR - m',
                       productType: 'Raw Material', type: 'Fabric' }
  }
};

function acReceive(itemId, qty) {
  return receive({ lines: [{ lineId: 'L1', itemId: itemId, qty: qty || 100 }] });
}

test('AUTO-CREATE: a new raw fabric is minted and its cloth lands the same run', function () {
  const w = freshWorld();
  const r = syncRun(w, [acReceive('INV-NEW-FAB')], AC);
  assert.strictEqual(r.created, 1);
  const made = w.mats.find(function (m) { return m.sku === 'RM-00099'; });
  assert.ok(made, 'material was not created');
  assert.strictEqual(made.isFabric, true);
  assert.strictEqual(made.Unallocated_Qty, 100, 'must land on the same run, not the next');
  assert.strictEqual(made.Quantity, 0);
});

test('AUTO-CREATE: "Printed fabric" is fabric too - contains, not equals', function () {
  const w = freshWorld();
  syncRun(w, [acReceive('INV-NEW-PRT')], AC);
  const made = w.mats.find(function (m) { return m.sku === 'RM-00098'; });
  assert.strictEqual(made.isFabric, true);
  assert.strictEqual(made.Unallocated_Qty, 100);
});

test('AUTO-CREATE: a non-fabric raw material goes to Quantity', function () {
  const w = freshWorld();
  syncRun(w, [acReceive('INV-NEW-ACC', 12)], AC);
  const made = w.mats.find(function (m) { return m.sku === 'RM-00097'; });
  assert.strictEqual(made.isFabric, false);
  assert.strictEqual(made.Quantity, 12);
  assert.strictEqual(made.Unallocated_Qty, 0);
});

test('AUTO-CREATE: a FINISHED GOOD is refused - it belongs to Item_Master', function () {
  const w = freshWorld();
  const r = syncRun(w, [acReceive('INV-NEW-FIN')], AC);
  assert.strictEqual(r.created, 0);
  assert.strictEqual(r.notRaw, 1);
  assert.ok(!w.mats.find(function (m) { return m.sku === 'SKU-00001'; }),
    'creating it here would put a garment on the store issue screen as cloth');
});

test('AUTO-CREATE: an item with no SKU is refused - SKU is the join key', function () {
  const w = freshWorld();
  const r = syncRun(w, [acReceive('INV-NEW-NOSKU')], AC);
  assert.strictEqual(r.created, 0);
  assert.strictEqual(r.unmapped, 1);
});

test('AUTO-CREATE: nothing is minted while the customfield_id is unset', function () {
  const w = freshWorld();
  const noCf = Object.assign({}, AC, { cfProductType: '' });
  const r = syncRun(w, [acReceive('INV-NEW-FAB')], noCf);
  assert.strictEqual(r.created, 0, 'an item that cannot be classified must never be guessed at');
  assert.strictEqual(r.unmapped, 1);
});

test('AUTO-CREATE: an existing unmapped SKU is STAMPED, never duplicated', function () {
  const w = freshWorld();
  const orphan = material({ id: 'M9', sku: 'RM-00099', invId: '', isFabric: true });
  w.mats.push(orphan);
  w.unmappedBySku['RM-00099'] = orphan;

  const r = syncRun(w, [acReceive('INV-NEW-FAB')], AC);
  assert.strictEqual(r.created, 0, 'a second row would split one material in two');
  assert.strictEqual(r.stamped, 1);
  assert.strictEqual(orphan.invId, 'INV-NEW-FAB');
  assert.strictEqual(orphan.Unallocated_Qty, 100);
  assert.strictEqual(w.mats.filter(function (m) { return m.sku === 'RM-00099'; }).length, 1);
});

test('AUTO-CREATE: a fabric with no width still lands, and is counted as needing one', function () {
  const w = freshWorld();
  const r = syncRun(w, [acReceive('INV-NEW-NOW')], AC);
  assert.strictEqual(r.created, 1);
  assert.strictEqual(r.noWidth, 1, 'the cut maths divides by the width - it has to be flagged');
  const made = w.mats.find(function (m) { return m.sku === 'RM-00096'; });
  assert.strictEqual(made.Unallocated_Qty, 100, 'the cloth is really on the rack - refusing it would be worse');
});

test('AUTO-CREATE: a second receive of a just-created material does not mint again', function () {
  const w = freshWorld();
  syncRun(w, [acReceive('INV-NEW-FAB')], AC);
  const r = syncRun(w, [receive({
    id: 'PR2', no: 'PR-00002', lines: [{ lineId: 'L1', itemId: 'INV-NEW-FAB', qty: 40 }]
  })], AC);
  assert.strictEqual(r.created, 0);
  assert.strictEqual(w.mats.filter(function (m) { return m.sku === 'RM-00099'; }).length, 1);
  assert.strictEqual(w.mats.find(function (m) { return m.sku === 'RM-00099'; }).Unallocated_Qty, 140);
});

test('the store person allocating a lot does not disturb the ledger', function () {
  const w = freshWorld();
  syncRun(w, [receive()]);
  w.mats[0].Unallocated_Qty -= 200;   // saveStockInward drains it into a lot
  const r = syncRun(w, [receive()]);
  assert.strictEqual(r.unchanged, 1);
  assert.strictEqual(w.mats[0].Unallocated_Qty, 0, 'must not be re-credited');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.msg);
  process.exit(1);
}
