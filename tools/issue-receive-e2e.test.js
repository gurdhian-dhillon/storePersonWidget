#!/usr/bin/env node
// END-TO-END lifecycle: issue -> handover record -> receive -> transfer ->
// dispute resolution, with GLOBAL CONSERVATION invariants asserted after every
// single step.
//
// This is the test that would catch a wrong += / -= anywhere in the chain. The
// per-function tests check each part in isolation; this one checks that the
// parts still add up when run against each other, which is where a migration
// like this actually breaks.
//
// THE INVARIANTS (checked after EVERY step, in every scenario):
//
//  C1  STOCK IS NEVER CREATED OR DESTROYED. Per material:
//        onHand + inTransit + disputed + consumed  ==  the opening figure
//      "consumed" is what a receipt confirmed into production; a write-off on a
//      Lost dispute moves to writtenOff, which is also counted.
//  C2  HANDOVER TOTALS THE FAN. Per material:
//        Sum of Issue_Lines.Qty  ==  the Issued_Qty the requirements gained.
//  C3  RECEIPT CONSERVES. Per material:
//        Sum of Issue_Lines.Received_Qty  ==  the Received_Qty the requirements
//        hold (nothing is credited that no line confirmed, and nothing
//        confirmed goes uncredited).
//  C4  LINE INVARIANT. Every settled line: Qty == Received_Qty + Disputed_Qty.
//  C5  NEVER OVER-CREDIT. Every requirement: Received_Qty <= Issued_Qty.
//  C6  TRANSFER NEVER EXCEEDS WHAT WAS CONFIRMED.
//        Transferred_Qty <= Received_Qty, on every line.
//  C7  NOTHING NEGATIVE, anywhere.
//
//   usage: node tools/issue-receive-e2e.test.js

'use strict';
const assert = require('assert');
const { receiveMaterials } = require('./receive-model.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// =========================================================================
// THE WORLD
// =========================================================================
function newWorld(materials) {
  const w = {
    rawMaterials: {}, lots: {}, requirements: [], issues: [], disputes: [],
    nextDisputeId: 1, nextIssueId: 1, voucherSeq: 0,
    opening: {},            // matId -> opening on-hand, for C1
    consumed: {},           // matId -> confirmed into production
    writtenOff: {}          // matId -> Lost write-offs
  };
  Object.keys(materials).forEach((m) => {
    w.rawMaterials[m] = { onHand: materials[m], inTransitQty: 0, disputedQty: 0 };
    w.opening[m] = materials[m];
    w.consumed[m] = 0;
    w.writtenOff[m] = 0;
  });
  return w;
}

function addLot(w, lotId, qty) {
  w.lots[lotId] = { onHand: qty, inTransitQty: 0, disputedQty: 0 };
}

function addReq(w, o) {
  w.requirements.push(Object.assign({
    id: 'r' + (w.requirements.length + 1), planId: 'P1', planItemId: 'PI1',
    supId: 'E1', materialId: 'M1', planOpen: true,
    requiredQty: 0, issuedQty: 0, receivedQty: 0,
    addedSeq: w.requirements.length + 1
  }, o));
  return w.requirements[w.requirements.length - 1];
}

// =========================================================================
// STEP 1 — ISSUE (models issueMaterialsApply + issueMaterialsHandover)
// =========================================================================
// allocations: [{ reqId, giveQty, lot }]
// Applies to the requirement + stock (apply), then writes ONE handover record
// with lines at material x lot grain (handover), exactly as the split does.
function issue(w, supId, allocations) {
  // --- apply: requirement counters + stock ---
  allocations.forEach((a) => {
    const rq = w.requirements.find((x) => x.id === a.reqId);
    assert.ok(rq, 'unknown requirement ' + a.reqId);
    rq.issuedQty = r2(rq.issuedQty + a.giveQty);
    const rm = w.rawMaterials[rq.materialId];
    rm.onHand = r2(rm.onHand - a.giveQty);
    rm.inTransitQty = r2(rm.inTransitQty + a.giveQty);
    if (a.lot) {
      const lt = w.lots[a.lot];
      lt.onHand = r2(lt.onHand - a.giveQty);
      lt.inTransitQty = r2(lt.inTransitQty + a.giveQty);
    }
  });

  // --- handover: aggregate to material x lot, ONE Material_Issue ---
  const byKey = {};
  const order = [];
  allocations.forEach((a) => {
    const rq = w.requirements.find((x) => x.id === a.reqId);
    const k = rq.materialId + '|' + (a.lot || '');
    if (!byKey[k]) {
      byKey[k] = {
        id: 'il' + (order.length + 1) + '_v' + w.nextIssueId,
        materialId: rq.materialId, lot: a.lot || '',
        qty: 0, receivedQty: 0, disputedQty: 0, settledQty: 0, lineStatus: 'Issued'
      };
      order.push(k);
    }
    byKey[k].qty = r2(byKey[k].qty + a.giveQty);
  });
  w.voucherSeq += 1;
  const mi = {
    id: 'V' + w.nextIssueId,
    voucher: 'SIV-' + String(w.voucherSeq).padStart(5, '0'),
    supId: supId,
    transferStatus: 'Pending',
    lines: order.map((k) => byKey[k])
  };
  w.nextIssueId += 1;
  w.issues.push(mi);
  return mi;
}

// =========================================================================
// STEP 2 — RECEIVE (the real receive-model)
// =========================================================================
function receive(w, supId, voucherIds, shortMaterials) {
  // Track what the confirmed part consumes into production, for C1.
  const before = {};
  w.issues.forEach((mi) => mi.lines.forEach((l) => {
    before[l.id] = Number(l.receivedQty) || 0;
  }));

  const res = receiveMaterials(w, {
    supId: supId, vouchers: voucherIds, shortMaterials: shortMaterials || []
  });

  // Confirmed metres leave in-transit and become production consumption.
  w.issues.forEach((mi) => mi.lines.forEach((l) => {
    const delta = r2((Number(l.receivedQty) || 0) - (before[l.id] || 0));
    if (delta > 0) w.consumed[l.materialId] = r2(w.consumed[l.materialId] + delta);
  }));
  return res;
}

// =========================================================================
// STEP 3 — TRANSFER (models postTransferOrders)
// =========================================================================
// Moves Received_Qty - Transferred_Qty per line. Marks the voucher Done only
// when no line is still "Issued" and nothing is left to move.
function transfer(w) {
  const moved = {};
  w.issues.forEach((mi) => {
    if (mi.transferStatus === 'Done' || mi.transferStatus === 'Failed') return;
    let stillOwed = false;
    let anyMove = false;
    mi.lines.forEach((l) => {
      const trf = Number(l.transferredQty) || 0;
      const move = r2((Number(l.receivedQty) || 0) - trf);
      if (l.lineStatus === 'Issued') stillOwed = true;
      if (move > 0) {
        l.transferredQty = r2(trf + move);
        moved[l.materialId] = r2((moved[l.materialId] || 0) + move);
        anyMove = true;
      }
    });
    if (!anyMove && !stillOwed) mi.transferStatus = 'Done';
  });
  return moved;
}

// =========================================================================
// STEP 4 — RESOLVE DISPUTE (models resolveDispute sections 3 + 3a)
// =========================================================================
function resolveDispute(w, disputeId, kind, qty) {
  const d = w.disputes.find((x) => x.id === disputeId);
  assert.ok(d, 'unknown dispute ' + disputeId);
  const already = (d.resolutionLines || []).reduce((t, r) => t + (Number(r.resolvedQty) || 0), 0);
  const remaining = r2((Number(d.disputedQty) || 0) - already);
  const take = Math.min(qty, remaining);
  if (take <= 0) return 0;

  // --- section 3: the requirement side ---
  const rows = w.requirements.filter((rq) => String(rq.planId) === String(d.planId)
    && String(rq.materialId) === String(d.materialId));
  if (kind === 'Found') {
    let toCredit = take;
    rows.sort((a, b) => a.addedSeq - b.addedSeq).forEach((rq) => {
      if (toCredit <= 0) return;
      const gap = r2(rq.issuedQty - rq.receivedQty);
      if (gap <= 0) return;
      const give = Math.min(gap, toCredit);
      rq.receivedQty = r2(rq.receivedQty + give);
      toCredit = r2(toCredit - give);
    });
    // it reached production
    w.consumed[d.materialId] = r2(w.consumed[d.materialId] + take);
    w.rawMaterials[d.materialId].disputedQty = r2(w.rawMaterials[d.materialId].disputedQty - take);
  } else {
    // Store_Correction / Lost: the requirement re-opens
    let toUnissue = take;
    rows.sort((a, b) => b.addedSeq - a.addedSeq).forEach((rq) => {
      if (toUnissue <= 0) return;
      const gap = r2(rq.issuedQty - rq.receivedQty);
      if (gap <= 0) return;
      const pull = Math.min(gap, toUnissue);
      rq.issuedQty = r2(rq.issuedQty - pull);
      toUnissue = r2(toUnissue - pull);
    });
    w.rawMaterials[d.materialId].disputedQty = r2(w.rawMaterials[d.materialId].disputedQty - take);
    if (kind === 'Store_Correction') {
      w.rawMaterials[d.materialId].onHand = r2(w.rawMaterials[d.materialId].onHand + take);
    } else {
      w.writtenOff[d.materialId] = r2(w.writtenOff[d.materialId] + take);
    }
  }

  // --- section 3a: the handover record ---
  let ilTake = take;
  w.issues.forEach((mi) => {
    if (String(mi.voucher) !== String(d.voucher)) return;
    let hit = false;
    mi.lines.forEach((l) => {
      if (ilTake <= 0) return;
      if (String(l.materialId) !== String(d.materialId)) return;
      if (d.lot && String(l.lot) !== String(d.lot)) return;
      hit = true;
      if (kind === 'Found') {
        const put = Math.min(Number(l.disputedQty) || 0, ilTake);
        l.receivedQty = r2((Number(l.receivedQty) || 0) + put);
        l.disputedQty = r2((Number(l.disputedQty) || 0) - put);
        l.lineStatus = l.disputedQty <= 0 ? 'Received' : 'Partially_Received';
        ilTake = r2(ilTake - put);
      } else {
        l.lineStatus = 'Received';
      }
    });
    // a Found on an already-transferred voucher has to be re-openable
    if (hit && kind === 'Found' && mi.transferStatus === 'Done') mi.transferStatus = 'Pending';
  });

  d.resolutionLines = d.resolutionLines || [];
  d.resolutionLines.push({ resolvedQty: take, resolution: kind });
  if (r2(already + take) >= r2(d.disputedQty)) d.status = 'Resolved';
  return take;
}

// =========================================================================
// THE INVARIANTS
// =========================================================================
function check(w, note) {
  // C1 — stock conservation per material
  Object.keys(w.opening).forEach((m) => {
    const rm = w.rawMaterials[m];
    const total = r2(rm.onHand + rm.inTransitQty + rm.disputedQty
      + w.consumed[m] + w.writtenOff[m]);
    assert.strictEqual(total, r2(w.opening[m]),
      `${note}: C1 ${m} onHand ${rm.onHand} + inTransit ${rm.inTransitQty} + disputed ${rm.disputedQty} + consumed ${w.consumed[m]} + writtenOff ${w.writtenOff[m]} = ${total}, opening ${w.opening[m]}`);
  });

  // C3 — receipt conserves: line received == requirement received, per material
  const lineRcv = {};
  const lineQty = {};
  w.issues.forEach((mi) => mi.lines.forEach((l) => {
    lineRcv[l.materialId] = r2((lineRcv[l.materialId] || 0) + (Number(l.receivedQty) || 0));
    lineQty[l.materialId] = r2((lineQty[l.materialId] || 0) + (Number(l.qty) || 0));

    // C4 — line invariant, once the line has been touched by receipt
    if (l.lineStatus !== 'Issued') {
      assert.strictEqual(r2((Number(l.receivedQty) || 0) + (Number(l.disputedQty) || 0)), r2(l.qty),
        `${note}: C4 line ${l.id} ${l.receivedQty}+${l.disputedQty} != ${l.qty}`);
    }
    // C6 — never transfer more than was confirmed
    assert.ok((Number(l.transferredQty) || 0) <= (Number(l.receivedQty) || 0) + 1e-9,
      `${note}: C6 line ${l.id} transferred ${l.transferredQty} > received ${l.receivedQty}`);
    // C7
    assert.ok((Number(l.receivedQty) || 0) >= -1e-9, `${note}: C7 line ${l.id} received negative`);
    assert.ok((Number(l.disputedQty) || 0) >= -1e-9, `${note}: C7 line ${l.id} disputed negative`);
  }));

  const reqRcv = {};
  w.requirements.forEach((rq) => {
    reqRcv[rq.materialId] = r2((reqRcv[rq.materialId] || 0) + (Number(rq.receivedQty) || 0));
    // C5 — never over-credit
    assert.ok(rq.receivedQty <= rq.issuedQty + 1e-9,
      `${note}: C5 req ${rq.id} received ${rq.receivedQty} > issued ${rq.issuedQty}`);
    // C7
    assert.ok(rq.issuedQty >= -1e-9, `${note}: C7 req ${rq.id} issued negative`);
    assert.ok(rq.receivedQty >= -1e-9, `${note}: C7 req ${rq.id} received negative`);
  });

  Object.keys(lineRcv).forEach((m) => {
    assert.strictEqual(lineRcv[m], r2(reqRcv[m] || 0),
      `${note}: C3 ${m} lines received ${lineRcv[m]} != requirements received ${reqRcv[m] || 0}`);
  });

  // C7 — stock never negative
  Object.keys(w.rawMaterials).forEach((m) => {
    const rm = w.rawMaterials[m];
    assert.ok(rm.onHand >= -1e-9, `${note}: C7 ${m} onHand negative (${rm.onHand})`);
    assert.ok(rm.inTransitQty >= -1e-9, `${note}: C7 ${m} inTransit negative`);
    assert.ok(rm.disputedQty >= -1e-9, `${note}: C7 ${m} disputed negative`);
  });
  Object.keys(w.lots).forEach((k) => {
    assert.ok(w.lots[k].onHand >= -1e-9, `${note}: C7 lot ${k} onHand negative`);
    assert.ok(w.lots[k].inTransitQty >= -1e-9, `${note}: C7 lot ${k} inTransit negative`);
  });
}

// C2 — handover totals the issue fan (checked right after an issue)
function checkC2(w, mi, allocations, note) {
  const byMat = {};
  allocations.forEach((a) => {
    const rq = w.requirements.find((x) => x.id === a.reqId);
    byMat[rq.materialId] = r2((byMat[rq.materialId] || 0) + a.giveQty);
  });
  const lineByMat = {};
  mi.lines.forEach((l) => {
    lineByMat[l.materialId] = r2((lineByMat[l.materialId] || 0) + l.qty);
  });
  Object.keys(byMat).forEach((m) => {
    assert.strictEqual(lineByMat[m], byMat[m],
      `${note}: C2 ${m} handover ${lineByMat[m]} != fanned ${byMat[m]}`);
  });
}

// =========================================================================
// SCENARIOS
// =========================================================================

test('E2E: plain issue -> full receipt -> transfer', () => {
  const w = newWorld({ M1: 100 });
  addLot(w, 'L1', 100);
  const r1 = addReq(w, { id: 'r1', materialId: 'M1', requiredQty: 30 });
  check(w, 'open');

  const allocs = [{ reqId: 'r1', giveQty: 30, lot: 'L1' }];
  const mi = issue(w, 'E1', allocs);
  checkC2(w, mi, allocs, 'issued');
  check(w, 'issued');
  assert.strictEqual(r1.issuedQty, 30);
  assert.strictEqual(w.rawMaterials.M1.inTransitQty, 30);

  receive(w, 'E1', [mi.id], []);
  check(w, 'received');
  assert.strictEqual(r1.receivedQty, 30);
  assert.strictEqual(w.rawMaterials.M1.inTransitQty, 0);
  assert.strictEqual(w.consumed.M1, 30);

  const moved = transfer(w);
  check(w, 'transferred');
  assert.strictEqual(moved.M1, 30);
  assert.strictEqual(mi.lines[0].transferredQty, 30);

  // a second transfer run moves nothing and marks it Done
  const moved2 = transfer(w);
  check(w, 'transferred-twice');
  assert.strictEqual(moved2.M1, undefined);
  assert.strictEqual(mi.transferStatus, 'Done');
});

test('E2E: short receipt -> dispute -> Found -> transfer picks up the rest', () => {
  const w = newWorld({ M1: 100 });
  addLot(w, 'L1', 100);
  const r1 = addReq(w, { id: 'r1', materialId: 'M1', requiredQty: 20 });

  const allocs = [{ reqId: 'r1', giveQty: 20, lot: 'L1' }];
  const mi = issue(w, 'E1', allocs);
  checkC2(w, mi, allocs, 'issued');
  check(w, 'issued');

  receive(w, 'E1', [mi.id], [{ materialId: 'M1', owed: 20, received: 15 }]);
  check(w, 'short-received');
  assert.strictEqual(mi.lines[0].receivedQty, 15);
  assert.strictEqual(mi.lines[0].disputedQty, 5);
  assert.strictEqual(r1.receivedQty, 15);
  assert.strictEqual(w.rawMaterials.M1.disputedQty, 5);
  assert.strictEqual(w.disputes.length, 1);

  const moved = transfer(w);
  check(w, 'transferred-partial');
  assert.strictEqual(moved.M1, 15, 'only the CONFIRMED part may transfer');
  assert.strictEqual(mi.transferStatus, 'Pending', 'a disputed line keeps the voucher open');

  // the transfer run above left nothing to move, so the voucher goes Done
  transfer(w);
  assert.strictEqual(mi.transferStatus, 'Done');

  // ...then he finds it
  const took = resolveDispute(w, w.disputes[0].id, 'Found', 5);
  assert.strictEqual(took, 5);
  check(w, 'found');
  assert.strictEqual(mi.lines[0].receivedQty, 20);
  assert.strictEqual(mi.lines[0].disputedQty, 0);
  assert.strictEqual(r1.receivedQty, 20);
  assert.strictEqual(mi.transferStatus, 'Pending', 'a Found must re-open the voucher for transfer');

  const moved2 = transfer(w);
  check(w, 'transferred-found');
  assert.strictEqual(moved2.M1, 5, 'the found metres must transfer');
  assert.strictEqual(mi.lines[0].transferredQty, 20);
});

test('E2E: short receipt -> Store_Correction -> re-issue on a NEW handover', () => {
  const w = newWorld({ M1: 100 });
  addLot(w, 'L1', 100);
  const r1 = addReq(w, { id: 'r1', materialId: 'M1', requiredQty: 20 });

  const a1 = [{ reqId: 'r1', giveQty: 20, lot: 'L1' }];
  const mi1 = issue(w, 'E1', a1);
  check(w, 'issued');
  receive(w, 'E1', [mi1.id], [{ materialId: 'M1', owed: 20, received: 12 }]);
  check(w, 'short');
  assert.strictEqual(w.disputes.length, 1);

  // the store finds it never left the shelf
  resolveDispute(w, w.disputes[0].id, 'Store_Correction', 8);
  check(w, 'corrected');
  assert.strictEqual(r1.issuedQty, 12, 'the requirement must re-open');
  assert.strictEqual(r1.receivedQty, 12);
  assert.strictEqual(w.rawMaterials.M1.onHand, 88, 'the cloth is back on the shelf');
  assert.strictEqual(w.rawMaterials.M1.disputedQty, 0);
  assert.strictEqual(mi1.lines[0].lineStatus, 'Received', 'the dispute on the line is closed');

  // and the store issues the missing 8 again — a NEW handover
  const a2 = [{ reqId: 'r1', giveQty: 8, lot: 'L1' }];
  const mi2 = issue(w, 'E1', a2);
  checkC2(w, mi2, a2, 're-issued');
  check(w, 're-issued');
  assert.strictEqual(r1.issuedQty, 20);
  assert.notStrictEqual(mi2.voucher, mi1.voucher, 'a re-issue is its own voucher');

  receive(w, 'E1', [mi2.id], []);
  check(w, 're-received');
  assert.strictEqual(r1.receivedQty, 20);
  transfer(w);
  check(w, 're-transferred');
});

test('E2E: both sides deny -> Lost writes off, requirement re-opens', () => {
  const w = newWorld({ M1: 50 });
  addLot(w, 'L1', 50);
  const r1 = addReq(w, { id: 'r1', materialId: 'M1', requiredQty: 10 });
  const mi = issue(w, 'E1', [{ reqId: 'r1', giveQty: 10, lot: 'L1' }]);
  receive(w, 'E1', [mi.id], [{ materialId: 'M1', owed: 10, received: 6 }]);
  check(w, 'short');

  resolveDispute(w, w.disputes[0].id, 'Lost', 4);
  check(w, 'lost');
  assert.strictEqual(r1.issuedQty, 6, 'lost material re-opens the requirement');
  assert.strictEqual(w.writtenOff.M1, 4);
  assert.strictEqual(w.rawMaterials.M1.disputedQty, 0);
  assert.strictEqual(w.rawMaterials.M1.onHand, 40, 'lost cloth does NOT come back');
});

test('E2E: one press across THREE plans, one lot — fan and receipt both conserve', () => {
  const w = newWorld({ M1: 200 });
  addLot(w, 'L1', 200);
  const rA = addReq(w, { id: 'rA', planId: 'PA', materialId: 'M1', requiredQty: 10, addedSeq: 1 });
  const rB = addReq(w, { id: 'rB', planId: 'PB', materialId: 'M1', requiredQty: 20, addedSeq: 2 });
  const rC = addReq(w, { id: 'rC', planId: 'PC', materialId: 'M1', requiredQty: 30, addedSeq: 3 });

  const allocs = [
    { reqId: 'rA', giveQty: 10, lot: 'L1' },
    { reqId: 'rB', giveQty: 20, lot: 'L1' },
    { reqId: 'rC', giveQty: 30, lot: 'L1' }
  ];
  const mi = issue(w, 'E1', allocs);
  checkC2(w, mi, allocs, 'issued');
  check(w, 'issued');
  assert.strictEqual(mi.lines.length, 1, 'one material x lot line for the whole press');
  assert.strictEqual(mi.lines[0].qty, 60);

  receive(w, 'E1', [mi.id], []);
  check(w, 'received');
  assert.strictEqual(rA.receivedQty, 10);
  assert.strictEqual(rB.receivedQty, 20);
  assert.strictEqual(rC.receivedQty, 30);
  transfer(w);
  check(w, 'transferred');
});

test('E2E: two lots of one material — each lot drains its own stock', () => {
  const w = newWorld({ M1: 100 });
  addLot(w, 'L1', 60);
  addLot(w, 'L2', 40);
  addReq(w, { id: 'r1', materialId: 'M1', requiredQty: 50 });
  const allocs = [
    { reqId: 'r1', giveQty: 30, lot: 'L1' },
    { reqId: 'r1', giveQty: 20, lot: 'L2' }
  ];
  const mi = issue(w, 'E1', allocs);
  checkC2(w, mi, allocs, 'issued');
  check(w, 'issued');
  assert.strictEqual(mi.lines.length, 2, 'one line per material x lot');
  assert.strictEqual(w.lots.L1.inTransitQty, 30);
  assert.strictEqual(w.lots.L2.inTransitQty, 20);

  receive(w, 'E1', [mi.id], []);
  check(w, 'received');
  assert.strictEqual(w.lots.L1.inTransitQty, 0);
  assert.strictEqual(w.lots.L2.inTransitQty, 0);
});

test('E2E: two presses to one supervisor, second received first', () => {
  const w = newWorld({ M1: 100 });
  addLot(w, 'L1', 100);
  const r1 = addReq(w, { id: 'r1', materialId: 'M1', requiredQty: 40 });

  const mi1 = issue(w, 'E1', [{ reqId: 'r1', giveQty: 15, lot: 'L1' }]);
  const mi2 = issue(w, 'E1', [{ reqId: 'r1', giveQty: 25, lot: 'L1' }]);
  check(w, 'two-issues');
  assert.strictEqual(r1.issuedQty, 40);

  // he confirms the SECOND handover first
  receive(w, 'E1', [mi2.id], []);
  check(w, 'second-received');
  assert.strictEqual(mi2.lines[0].receivedQty, 25);
  assert.strictEqual(mi1.lines[0].receivedQty, 0, 'the first handover is untouched');
  assert.strictEqual(r1.receivedQty, 25);

  receive(w, 'E1', [mi1.id], []);
  check(w, 'first-received');
  assert.strictEqual(r1.receivedQty, 40);
  transfer(w);
  check(w, 'transferred');
});

test('E2E: receipt run TWICE end to end changes nothing the second time', () => {
  const w = newWorld({ M1: 100 });
  addLot(w, 'L1', 100);
  addReq(w, { id: 'r1', materialId: 'M1', requiredQty: 20 });
  const mi = issue(w, 'E1', [{ reqId: 'r1', giveQty: 20, lot: 'L1' }]);

  const short = [{ materialId: 'M1', owed: 20, received: 14 }];
  receive(w, 'E1', [mi.id], short);
  check(w, 'first');
  const snap = JSON.stringify({
    issues: w.issues, reqs: w.requirements, raw: w.rawMaterials,
    lots: w.lots, disputes: w.disputes, consumed: w.consumed
  });

  receive(w, 'E1', [mi.id], short);
  check(w, 'second');
  assert.strictEqual(JSON.stringify({
    issues: w.issues, reqs: w.requirements, raw: w.rawMaterials,
    lots: w.lots, disputes: w.disputes, consumed: w.consumed
  }), snap, 'a repeated receipt changed state');
});

test('E2E: fan died — re-running the receipt repairs it, conservation holds', () => {
  const w = newWorld({ M1: 100 });
  addLot(w, 'L1', 100);
  const r1 = addReq(w, { id: 'r1', materialId: 'M1', requiredQty: 20 });
  const mi = issue(w, 'E1', [{ reqId: 'r1', giveQty: 20, lot: 'L1' }]);

  receive(w, 'E1', [mi.id], [{ materialId: 'M1', owed: 20, received: 15 }]);
  check(w, 'ok');

  // Simulate "the fan never ran". The watermarks are written LAST, after the
  // credit and the dispute, so a fan that died leaves them UNSTAMPED — that is
  // precisely the signal the next press reads.
  r1.receivedQty = 0;
  w.disputes = [];
  mi.lines.forEach((l) => { l.fannedQty = 0; l.disputeRaisedQty = 0; });
  // (the lines' Received/Disputed and the stock stay settled, exactly as
  //  receiveHandover left them)

  receive(w, 'E1', [mi.id], []);
  check(w, 'repaired');
  assert.strictEqual(r1.receivedQty, 15, 'the missing credit was not repaired');
  assert.strictEqual(w.disputes.length, 1, 'the missing dispute was not repaired');
  assert.strictEqual(mi.lines[0].receivedQty, 15, 'the lines must not move');
  assert.strictEqual(mi.lines[0].disputedQty, 5);
});

test('E2E: awkward decimals across many small allocations — no drift', () => {
  const w = newWorld({ M1: 1000 });
  addLot(w, 'L1', 1000);
  const allocs = [];
  for (let i = 0; i < 37; i++) {
    addReq(w, { id: 'r' + i, planId: 'P' + i, materialId: 'M1', requiredQty: 1, addedSeq: i + 1 });
    allocs.push({ reqId: 'r' + i, giveQty: 1.37, lot: 'L1' });
  }
  const mi = issue(w, 'E1', allocs);
  checkC2(w, mi, allocs, 'issued');
  check(w, 'issued');
  assert.strictEqual(mi.lines[0].qty, r2(1.37 * 37));

  receive(w, 'E1', [mi.id], []);
  check(w, 'received');
  const reqTotal = r2(w.requirements.reduce((t, rq) => t + rq.receivedQty, 0));
  assert.strictEqual(reqTotal, mi.lines[0].receivedQty, 'fan drifted');
  transfer(w);
  check(w, 'transferred');
});

test('E2E: a closed plan holding an owed row never steals a later credit', () => {
  const w = newWorld({ M1: 100 });
  addLot(w, 'L1', 100);
  // stale row: issued long ago on a plan that has since finished, never received
  const stale = addReq(w, { id: 'rOld', planId: 'PDONE', materialId: 'M1', addedSeq: 1, planOpen: false });
  stale.issuedQty = 9;
  w.rawMaterials.M1.onHand = r2(w.rawMaterials.M1.onHand - 9);
  w.rawMaterials.M1.inTransitQty = 9;

  const live = addReq(w, { id: 'rNew', planId: 'PLIVE', materialId: 'M1', requiredQty: 10, addedSeq: 2 });
  const mi = issue(w, 'E1', [{ reqId: 'rNew', giveQty: 10, lot: 'L1' }]);
  check(w, 'issued');

  receive(w, 'E1', [mi.id], []);
  check(w, 'received');
  assert.strictEqual(stale.receivedQty, 0, 'the stale closed-plan row stole the credit');
  assert.strictEqual(live.receivedQty, 10);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
