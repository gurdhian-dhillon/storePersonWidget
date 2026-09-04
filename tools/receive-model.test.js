#!/usr/bin/env node
// Lifecycle test for the new receiveMaterials arithmetic (tools/receive-model.js).
// Runs issue -> receive-full / receive-short / dispute and asserts the
// invariants that must hold or stock silently desyncs.
//
//   usage: node tools/receive-model.test.js

'use strict';
const assert = require('assert');
const { receiveMaterials, r2 } = require('./receive-model.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
}

// ---- builders ----
function line(o) {
  return Object.assign({
    id: 'il1', materialId: 'M1', lot: '', qty: 0, receivedQty: 0, disputedQty: 0, lineStatus: 'Issued'
  }, o);
}
function issue(o) {
  return Object.assign({ id: 'V1', voucher: 'SIV-1', supId: 'E1', lines: [] }, o);
}
function reqRow(o) {
  return Object.assign({
    id: 'r1', planId: 'P1', planItemId: 'PI1', supId: 'E1', materialId: 'M1',
    issuedQty: 0, receivedQty: 0, disputedQty: 0, addedSeq: 1
  }, o);
}
function world(o) {
  return Object.assign({
    issues: [], requirements: [],
    rawMaterials: { M1: { inTransitQty: 0, disputedQty: 0 }, M2: { inTransitQty: 0, disputedQty: 0 } },
    lots: { L1: { inTransitQty: 0, disputedQty: 0 }, L2: { inTransitQty: 0, disputedQty: 0 } },
    disputes: [], nextDisputeId: 1
  }, o);
}

// ---- invariant checks ----
function checkInvariants(state, note) {
  state.issues.forEach((mi) => mi.lines.forEach((ln) => {
    // I1: Qty === Received + Disputed  (only for lines that were touched)
    if (ln.lineStatus !== 'Issued') {
      assert.strictEqual(r2(ln.receivedQty + ln.disputedQty), r2(ln.qty),
        `${note}: I1 line ${ln.id} ${ln.receivedQty}+${ln.disputedQty} != ${ln.qty}`);
    }
    assert.ok(ln.receivedQty >= -1e-9, `${note}: I4 line ${ln.id} received negative`);
    assert.ok(ln.disputedQty >= -1e-9, `${note}: I4 line ${ln.id} disputed negative`);
  }));
  state.requirements.forEach((rq) => {
    // I3: never over-credit
    assert.ok(rq.receivedQty <= rq.issuedQty + 1e-9,
      `${note}: I3 req ${rq.id} received ${rq.receivedQty} > issued ${rq.issuedQty}`);
    assert.ok(rq.receivedQty >= -1e-9, `${note}: I4 req ${rq.id} received negative`);
  });
  Object.keys(state.rawMaterials).forEach((m) => {
    assert.ok(state.rawMaterials[m].inTransitQty >= -1e-9, `${note}: I4 ${m} in-transit negative`);
  });
}

// =========================================================================

test('full receipt of one trim line: line Received, requirement credited, in-transit drained', () => {
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 10 })] })],
    requirements: [reqRow({ issuedQty: 10 })]
  });
  s.rawMaterials.M1.inTransitQty = 10;
  const res = receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'full');
  assert.strictEqual(s.issues[0].lines[0].receivedQty, 10);
  assert.strictEqual(s.issues[0].lines[0].disputedQty, 0);
  assert.strictEqual(s.issues[0].lines[0].lineStatus, 'Received');
  assert.strictEqual(s.requirements[0].receivedQty, 10);   // I2: fan conserved
  assert.strictEqual(s.rawMaterials.M1.inTransitQty, 0);   // I5
  assert.strictEqual(res.raisedDisputeIds.length, 0);      // I6
});

test('short receipt: line partly received, gap disputed, requirement + raw disputed', () => {
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 10, lot: 'L1' })] })],
    requirements: [reqRow({ issuedQty: 10 })]
  });
  s.rawMaterials.M1.inTransitQty = 10;
  s.lots.L1.inTransitQty = 10;
  const res = receiveMaterials(s, {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M1', owed: 10, received: 7, remark: 'wet' }]
  });
  checkInvariants(s, 'short');
  const ln = s.issues[0].lines[0];
  assert.strictEqual(ln.receivedQty, 7);
  assert.strictEqual(ln.disputedQty, 3);
  assert.strictEqual(ln.lineStatus, 'Partially_Received');
  assert.strictEqual(s.requirements[0].receivedQty, 7);
  // requirement has NO disputedQty field - the gap (issued 10 - received 7)
  // plus the open Stock_Dispute is the record.
  assert.strictEqual(r2(s.requirements[0].issuedQty - s.requirements[0].receivedQty), 3);
  assert.strictEqual(s.rawMaterials.M1.inTransitQty, 0);   // whole owed left in-transit
  assert.strictEqual(s.rawMaterials.M1.disputedQty, 3);
  assert.strictEqual(s.lots.L1.inTransitQty, 0);
  assert.strictEqual(s.lots.L1.disputedQty, 3);
  assert.strictEqual(res.raisedDisputeIds.length, 1);
  const d = s.disputes[0];
  assert.strictEqual(d.disputedQty, 3);
  assert.strictEqual(d.voucher, 'SIV-1');                  // stamped
  assert.strictEqual(String(d.planId), 'P1');
  assert.strictEqual(String(d.materialId), 'M1');
});

test('I2: one material×lot line fans across TWO requirements, arrived conserved', () => {
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', materialId: 'M2', lot: 'L1', qty: 15 })] })],
    requirements: [
      reqRow({ id: 'r1', planId: 'P1', materialId: 'M2', issuedQty: 10, addedSeq: 1 }),
      reqRow({ id: 'r2', planId: 'P2', materialId: 'M2', issuedQty: 5, addedSeq: 2 })
    ]
  });
  s.rawMaterials.M2.inTransitQty = 15;
  s.lots.L1.inTransitQty = 15;
  receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'fan-2');
  const lineRcv = s.issues[0].lines[0].receivedQty;
  const reqRcv = s.requirements.reduce((t, r) => t + r.receivedQty, 0);
  assert.strictEqual(lineRcv, 15);
  assert.strictEqual(reqRcv, 15);            // I2: fan conserved
  assert.strictEqual(s.requirements[0].receivedQty, 10);  // oldest filled first
  assert.strictEqual(s.requirements[1].receivedQty, 5);
});

test('short fan: arrived credited oldest-first, shortfall disputed newest-first', () => {
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', materialId: 'M2', lot: 'L1', qty: 15 })] })],
    requirements: [
      reqRow({ id: 'r1', planId: 'P1', materialId: 'M2', issuedQty: 10, addedSeq: 1 }),
      reqRow({ id: 'r2', planId: 'P2', materialId: 'M2', issuedQty: 5, addedSeq: 2 })
    ]
  });
  s.rawMaterials.M2.inTransitQty = 15;
  s.lots.L1.inTransitQty = 15;
  receiveMaterials(s, {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M2', owed: 15, received: 11, remark: '' }]
  });
  checkInvariants(s, 'short-fan');
  // arrived 11: oldest r1 (10) full, r2 gets 1. shortfall 4: newest r2 first.
  assert.strictEqual(s.requirements[0].receivedQty, 10);
  assert.strictEqual(s.requirements[1].receivedQty, 1);
  // r2's gap (5 issued - 1 received) = 4 carries the shortfall; r1 is full.
  assert.strictEqual(r2(s.requirements[1].issuedQty - s.requirements[1].receivedQty), 4);
  assert.strictEqual(r2(s.requirements[0].issuedQty - s.requirements[0].receivedQty), 0);
  // one dispute for P2 (where the gap landed)
  assert.strictEqual(s.disputes.length, 1);
  assert.strictEqual(String(s.disputes[0].planId), 'P2');
  assert.strictEqual(s.disputes[0].disputedQty, 4);
});

test('an EARLIER handover dispute does not suppress a later handover line', () => {
  // Line V1 is 10 NEW metres physically on the counter. A dispute of 3 from an
  // earlier handover is about THAT handover's cloth, recorded on THAT line -
  // it must not reduce what he is asked to confirm here.
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 10 })] })],
    requirements: [reqRow({ issuedQty: 10 })],
    disputes: [{
      id: 99, planId: 'P1', materialId: 'M1', voucher: 'SIV-0', direction: 'Outbound',
      isWaste: false, issuedQty: 3, receivedQty: 0, disputedQty: 3, status: 'Open', resolutionLines: []
    }],
    nextDisputeId: 100
  });
  s.rawMaterials.M1.inTransitQty = 10;
  const res = receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'earlier-dispute');
  assert.strictEqual(s.issues[0].lines[0].receivedQty, 10);
  assert.strictEqual(s.issues[0].lines[0].disputedQty, 0);
  assert.strictEqual(s.requirements[0].receivedQty, 10);
  // no NEW dispute raised - nothing was short on THIS receipt.
  assert.strictEqual(res.raisedDisputeIds.length, 0);
  assert.strictEqual(s.disputes.length, 1);
});

test('a short receipt raises no DUPLICATE when a dispute already covers it', () => {
  // Line already settled short (7 received, 3 disputed) AND already fanned -
  // the watermarks say so. Re-confirming must add nothing anywhere.
  const s = world({
    issues: [issue({ lines: [line({
      id: 'a', qty: 10, receivedQty: 7, disputedQty: 3,
      fannedQty: 7, disputeRaisedQty: 3, lineStatus: 'Partially_Received'
    })] })],
    requirements: [reqRow({ issuedQty: 10, receivedQty: 7 })],
    disputes: [{
      id: 99, planId: 'P1', materialId: 'M1', voucher: 'SIV-1', direction: 'Outbound',
      isWaste: false, issuedQty: 3, receivedQty: 0, disputedQty: 3, status: 'Open', resolutionLines: []
    }],
    nextDisputeId: 100
  });
  s.rawMaterials.M1.inTransitQty = 0;
  const res = receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'no-dup');
  assert.strictEqual(s.issues[0].lines[0].receivedQty, 7);
  assert.strictEqual(s.issues[0].lines[0].disputedQty, 3);
  assert.strictEqual(s.requirements[0].receivedQty, 7);
  assert.strictEqual(res.raisedDisputeIds.length, 0);
  assert.strictEqual(s.disputes.length, 1);
});

test('two lots of one material on one voucher: each lot drained separately', () => {
  const s = world({
    issues: [issue({ lines: [
      line({ id: 'a', materialId: 'M2', lot: 'L1', qty: 8 }),
      line({ id: 'b', materialId: 'M2', lot: 'L2', qty: 4 })
    ] })],
    requirements: [reqRow({ materialId: 'M2', issuedQty: 12 })]
  });
  s.rawMaterials.M2.inTransitQty = 12;
  s.lots.L1.inTransitQty = 8;
  s.lots.L2.inTransitQty = 4;
  receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'two-lot');
  assert.strictEqual(s.lots.L1.inTransitQty, 0);
  assert.strictEqual(s.lots.L2.inTransitQty, 0);
  assert.strictEqual(s.rawMaterials.M2.inTransitQty, 0);
  assert.strictEqual(s.requirements[0].receivedQty, 12);
});

test('second receipt on an already-part-received line only settles the remainder', () => {
  // 6 confirmed, nothing disputed, 4 still unaccounted for.
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 10, receivedQty: 6, disputedQty: 0, lineStatus: 'Partially_Received' })] })],
    requirements: [reqRow({ issuedQty: 10, receivedQty: 6 })]
  });
  s.rawMaterials.M1.inTransitQty = 4;
  receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'second');
  assert.strictEqual(s.issues[0].lines[0].receivedQty, 10);
  assert.strictEqual(s.issues[0].lines[0].disputedQty, 0);
  assert.strictEqual(s.requirements[0].receivedQty, 10);
  assert.strictEqual(s.rawMaterials.M1.inTransitQty, 0);
});

test('rounding: 3 lines of a material summed vs one figure — no drift', () => {
  const s = world({
    issues: [issue({ lines: [
      line({ id: 'a', materialId: 'M2', lot: 'L1', qty: 2.33 }),
      line({ id: 'b', materialId: 'M2', lot: 'L1', qty: 2.33 }),
      line({ id: 'c', materialId: 'M2', lot: 'L1', qty: 2.34 })
    ] })],
    requirements: [reqRow({ materialId: 'M2', issuedQty: 7 })]
  });
  s.rawMaterials.M2.inTransitQty = 7;
  s.lots.L1.inTransitQty = 7;
  receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'round');
  const lineRcv = r2(s.issues[0].lines.reduce((t, l) => t + l.receivedQty, 0));
  assert.strictEqual(lineRcv, 7);
  assert.strictEqual(s.requirements[0].receivedQty, 7);
  assert.strictEqual(s.rawMaterials.M2.inTransitQty, 0);
});

// ---- regressions found in the full-migration audit ----------------------

test('REGRESSION: running the whole receipt TWICE changes nothing the second time', () => {
  // Idempotency. A double-click, a retry after a timeout, or a re-press after a
  // failed finalize must not credit anything twice.
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', materialId: 'M2', lot: 'L1', qty: 10 })] })],
    requirements: [reqRow({ materialId: 'M2', issuedQty: 10 })]
  });
  s.rawMaterials.M2.inTransitQty = 10;
  s.lots.L1.inTransitQty = 10;
  const payload = {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M2', owed: 10, received: 6, remark: 'wet' }]
  };
  receiveMaterials(s, payload);
  const after1 = JSON.parse(JSON.stringify({
    lines: s.issues[0].lines, reqs: s.requirements,
    raw: s.rawMaterials, lots: s.lots, disputes: s.disputes
  }));

  const res2 = receiveMaterials(s, payload);
  checkInvariants(s, 'idempotent');
  assert.deepStrictEqual(s.issues[0].lines, after1.lines, 'lines changed on re-run');
  assert.deepStrictEqual(s.requirements, after1.reqs, 'requirements changed on re-run');
  assert.deepStrictEqual(s.rawMaterials, after1.raw, 'raw stock changed on re-run');
  assert.deepStrictEqual(s.lots, after1.lots, 'lot stock changed on re-run');
  assert.strictEqual(s.disputes.length, after1.disputes.length, 'a duplicate dispute was raised');
  assert.strictEqual(res2.raisedDisputeIds.length, 0);
});

test('REGRESSION: a fan that never ran is recovered by re-running the receipt', () => {
  // The failure this guards: receiveHandover settled the lines, then
  // receiveFanOut died. The requirement was never credited and no dispute was
  // raised. Pressing Confirm again must apply exactly what never landed - if
  // the settle reported DELTAS instead of TOTALS the second call would report
  // nothing and the item could never reach Ready_For_Production.
  const s = world({
    // lines already settled: 7 arrived, 3 short
    issues: [issue({ lines: [line({ id: 'a', qty: 10, receivedQty: 7, disputedQty: 3, lineStatus: 'Partially_Received' })] })],
    // ...but the requirement was never credited and no dispute exists
    requirements: [reqRow({ issuedQty: 10, receivedQty: 0 })]
  });
  s.rawMaterials.M1.inTransitQty = 0;   // stock was already drained by the settle
  const res = receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'fan-recovery');
  assert.strictEqual(s.requirements[0].receivedQty, 7, 'the missing credit was not applied');
  assert.strictEqual(s.disputes.length, 1, 'the missing dispute was not raised');
  assert.strictEqual(s.disputes[0].disputedQty, 3);
  assert.strictEqual(res.raisedDisputeIds.length, 1);
  // the lines themselves must not move - they were already settled
  assert.strictEqual(s.issues[0].lines[0].receivedQty, 7);
  assert.strictEqual(s.issues[0].lines[0].disputedQty, 3);
  assert.strictEqual(s.rawMaterials.M1.inTransitQty, 0, 'stock drained twice');
});

test('REGRESSION: the fan skips an owed row on a CLOSED plan', () => {
  // r1 is a stale owed row on a finished plan. Without the open-plan bound it
  // would swallow the credit oldest-first and leave r2 - the plan actually
  // received for - uncredited and stuck at Awaiting_Material.
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', materialId: 'M2', lot: 'L1', qty: 5 })] })],
    requirements: [
      reqRow({ id: 'r1', planId: 'P0', materialId: 'M2', issuedQty: 5, addedSeq: 1, planOpen: false }),
      reqRow({ id: 'r2', planId: 'P1', materialId: 'M2', issuedQty: 5, addedSeq: 2 })
    ]
  });
  s.rawMaterials.M2.inTransitQty = 5;
  s.lots.L1.inTransitQty = 5;
  receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  checkInvariants(s, 'closed-plan');
  assert.strictEqual(s.requirements[0].receivedQty, 0);   // stale row untouched
  assert.strictEqual(s.requirements[1].receivedQty, 5);   // the live one credited
});

test('REGRESSION: a short receipt while an older dispute is open raises only the NEW gap', () => {
  // Older dispute of 2 already open. This receipt is 3 short. The fan must
  // raise only the difference, not a second dispute for the whole 3+2.
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 10 })] })],
    requirements: [reqRow({ issuedQty: 10 })],
    disputes: [{
      id: 99, planId: 'P1', materialId: 'M1', voucher: 'SIV-0', direction: 'Outbound',
      isWaste: false, issuedQty: 2, receivedQty: 0, disputedQty: 2, status: 'Open', resolutionLines: []
    }],
    nextDisputeId: 100
  });
  s.rawMaterials.M1.inTransitQty = 10;
  receiveMaterials(s, {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M1', owed: 10, received: 7, remark: '' }]
  });
  checkInvariants(s, 'older-dispute-short');
  assert.strictEqual(s.issues[0].lines[0].receivedQty, 7);
  assert.strictEqual(s.issues[0].lines[0].disputedQty, 3);
  assert.strictEqual(s.requirements[0].receivedQty, 7);
  assert.strictEqual(s.rawMaterials.M1.inTransitQty, 0);
  // The older 2 is a DIFFERENT handover's shortfall and stays open on its own.
  // This receipt is 3 short, so 3 more is raised - total genuinely disputed 5.
  // Only the NEW gap is added; the older ticket is not re-raised or doubled.
  const totalOpen = s.disputes.reduce((t, d) => t + d.disputedQty, 0);
  assert.strictEqual(totalOpen, 5, 'the new gap should add to the older ticket, not replace or double it');
  assert.strictEqual(s.disputes.length, 1, 'it must land on the existing open ticket, not a second one');
});

test('REGRESSION: a re-run does not re-raise the dispute it already raised', () => {
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 10 })] })],
    requirements: [reqRow({ issuedQty: 10 })]
  });
  s.rawMaterials.M1.inTransitQty = 10;
  const short = [{ materialId: 'M1', owed: 10, received: 7, remark: '' }];
  receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: short });
  const firstTotal = s.disputes.reduce((t, d) => t + d.disputedQty, 0);
  assert.strictEqual(firstTotal, 3);

  receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: short });
  checkInvariants(s, 're-run-dispute');
  const secondTotal = s.disputes.reduce((t, d) => t + d.disputedQty, 0);
  assert.strictEqual(secondTotal, 3, 'the dispute was raised twice');
  assert.strictEqual(s.disputes.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
