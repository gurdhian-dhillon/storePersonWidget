#!/usr/bin/env node
// New edge cases for the store-issue / supervisor-receive flow, beyond the
// existing 51 tests. Data shapes come from the migration model:
//   - Issue_Lines: one row per (voucher, material, lot); carries Received_Qty /
//     Disputed_Qty / Line_Status, NOT Requirement. Watermarks Fanned_Qty /
//     Dispute_Raised_Qty give the idempotency.
//   - receiveMaterials = settle (handover) + fan (Material_Requirement credit
//     + Stock_Dispute) + drain (In_Transit -> disbursed/disputed).
//
// Each case here is deliberately NOVEL: it walks an input shape the existing
// tests do not, so it exists to catch behaviour that was never pinned down.
//
//   usage: node tools/issue-receive-edge-cases.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { receiveMaterials, r2 } = require('./receive-model.js');
const ReceiveRead = require('../app/supervisor/js/receive-read.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
}

// ===========================================================================
// SECTION 1 — receive-model.js: settle + fan + drain edge cases
// ===========================================================================

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
function checkInvariants(state, note) {
  state.issues.forEach((mi) => mi.lines.forEach((ln) => {
    if (ln.lineStatus !== 'Issued') {
      assert.strictEqual(r2(ln.receivedQty + ln.disputedQty), r2(ln.qty),
        `${note}: I1 line ${ln.id} ${ln.receivedQty}+${ln.disputedQty} != ${ln.qty}`);
    }
    assert.ok(ln.receivedQty >= -1e-9, `${note}: I4 line ${ln.id} received negative`);
    assert.ok(ln.disputedQty >= -1e-9, `${note}: I4 line ${ln.id} disputed negative`);
  }));
  state.requirements.forEach((rq) => {
    assert.ok(rq.receivedQty <= rq.issuedQty + 1e-9,
      `${note}: I3 req ${rq.id} received ${rq.receivedQty} > issued ${rq.issuedQty}`);
  });
  Object.keys(state.rawMaterials).forEach((m) => {
    assert.ok(state.rawMaterials[m].inTransitQty >= -1e-9, `${note}: I4 ${m} in-transit negative`);
  });
}

// 1.1 — the SHORT figure typed LARGER than owed must clamp, never over-credit
//      and never raise a dispute. (Typo: he keys 100 for a 10-metre line.)
test('EDGE: short typed LARGER than owed clamps to owed - no over-credit, no dispute', () => {
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 10 })] })],
    requirements: [reqRow({ issuedQty: 10 })]
  });
  s.rawMaterials.M1.inTransitQty = 10;
  const res = receiveMaterials(s, {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M1', owed: 10, received: 100, remark: '' }]
  });
  checkInvariants(s, 'over-short');
  const ln = s.issues[0].lines[0];
  assert.strictEqual(ln.receivedQty, 10);          // arrived = owed = 10, not 100
  assert.strictEqual(ln.disputedQty, 0);           // nothing short
  assert.strictEqual(ln.lineStatus, 'Received');
  assert.strictEqual(s.requirements[0].receivedQty, 10);
  assert.strictEqual(res.raisedDisputeIds.length, 0); // nothing short -> no ticket
  // The unspent shortLeft must not leak anywhere on a re-run either.
  const res2 = receiveMaterials(s, {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M1', owed: 10, received: 100, remark: '' }]
  });
  assert.strictEqual(res2.raisedDisputeIds.length, 0);
  assert.strictEqual(s.requirements[0].receivedQty, 10);
});

// 1.2 — one short figure for a material spanning TWO lots on one voucher is
//      drawn down OLDEST-LINE-FIRST; each lot drains under its own in-transit.
test('EDGE: one short figure across TWO lots drains oldest-line-first, per lot', () => {
  const s = world({
    issues: [issue({ lines: [
      line({ id: 'a', materialId: 'M1', lot: 'L1', qty: 6 }),
      line({ id: 'b', materialId: 'M1', lot: 'L2', qty: 4 })
    ] })],
    requirements: [reqRow({ issuedQty: 10 })]
  });
  s.rawMaterials.M1.inTransitQty = 10;
  s.lots.L1.inTransitQty = 6;
  s.lots.L2.inTransitQty = 4;
  const res = receiveMaterials(s, {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M1', owed: 10, received: 7, remark: '' }]
  });
  checkInvariants(s, 'two-lot-short');
  const a = s.issues[0].lines[0], b = s.issues[0].lines[1];
  // shortLeft=7: line a (owed 6) takes all 6 -> arrived 6, short 0;
  // line b (owed 4) gets the remaining 1 -> arrived 1, short 3.
  assert.strictEqual(a.receivedQty, 6); assert.strictEqual(a.disputedQty, 0);
  assert.strictEqual(a.lineStatus, 'Received');
  assert.strictEqual(b.receivedQty, 1); assert.strictEqual(b.disputedQty, 3);
  assert.strictEqual(b.lineStatus, 'Partially_Received');
  // requirement credited 7 total, no over-credit
  assert.strictEqual(s.requirements[0].receivedQty, 7);
  // stock: raw drains 10 -> 0, both lots fully drain; the 3-short lands on L2.
  assert.strictEqual(s.rawMaterials.M1.inTransitQty, 0);
  assert.strictEqual(s.rawMaterials.M1.disputedQty, 3);
  assert.strictEqual(s.lots.L1.inTransitQty, 0);
  assert.strictEqual(s.lots.L2.inTransitQty, 0);
  assert.strictEqual(s.lots.L2.disputedQty, 3);
  // one dispute, stamped with the voucher
  assert.strictEqual(res.raisedDisputeIds.length, 1);
  assert.strictEqual(s.disputes[0].disputedQty, 3);
  assert.strictEqual(s.disputes[0].voucher, 'SIV-1');
});

// 1.3 — a material with TWO requirement rows across two OPEN plans; a 5-short
//       receipt is disputed NEWEST-first (the fan filled oldest-first).
test('EDGE: short arrives credited oldest plan, dispute lands on the newest open row', () => {
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
    shortMaterials: [{ materialId: 'M2', owed: 15, received: 10, remark: '' }]
  });
  checkInvariants(s, 'multi-plan-short');
  assert.strictEqual(s.requirements[0].receivedQty, 10); // oldest filled first
  assert.strictEqual(s.requirements[1].receivedQty, 0);  // newest got nothing
  // shortfall 5, disputed newest-first -> P2 (the one still owed 5)
  assert.strictEqual(s.disputes.length, 1);
  assert.strictEqual(String(s.disputes[0].planId), 'P2');
  assert.strictEqual(s.disputes[0].disputedQty, 5);
  // P1 is full - no dispute lands there.
  assert.strictEqual(r2(s.requirements[0].issuedQty - s.requirements[0].receivedQty), 0);
});

// 1.4 — he confirms "received: 0" on a short -> nothing arrives, EVERYTHING
//       disputed. The item must NOT be released to production.
test('EDGE: received 0 confirmed -> nothing arrives, whole owed disputed', () => {
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 10 })] })],
    requirements: [reqRow({ issuedQty: 10 })]
  });
  s.rawMaterials.M1.inTransitQty = 10;
  const res = receiveMaterials(s, {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M1', owed: 10, received: 0, remark: 'nothing came' }]
  });
  checkInvariants(s, 'recv-0');
  const ln = s.issues[0].lines[0];
  assert.strictEqual(ln.receivedQty, 0);
  assert.strictEqual(ln.disputedQty, 10);
  assert.strictEqual(ln.lineStatus, 'Disputed');      // received==0 -> pure Disputed
  assert.strictEqual(s.requirements[0].receivedQty, 0); // readiness test must fail
  assert.strictEqual(s.rawMaterials.M1.inTransitQty, 0); // whole owed drained out of transit
  assert.strictEqual(s.rawMaterials.M1.disputedQty, 10);
  assert.strictEqual(res.raisedDisputeIds.length, 1);
  assert.strictEqual(s.disputes[0].disputedQty, 10);
});

// 1.5 — CORRUPT data: a line where receivedQty ALREADY exceeds qty (hand-edited,
//       a bad migration). The owed must go NEGATIVE-skipped before any settle, so
//       nothing is created/disputed and nothing goes negative.
test('EDGE: line whose receivedQty already exceeds qty is skipped, no dispute, no negative', () => {
  // NOTE: checkInvariants' I1 (qty === received + disputed) cannot hold for a
  // deliberately corrupt line - that is exactly why it is the corrupt case. So
  // we assert the model's behaviour directly instead of the lifecycle wrapper.
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', qty: 5, receivedQty: 7, disputedQty: 0, lineStatus: 'Received' })] })],
    requirements: [reqRow({ issuedQty: 5, receivedQty: 5 })]
  });
  s.rawMaterials.M1.inTransitQty = 0;
  const res = receiveMaterials(s, { supId: 'E1', vouchers: ['V1'], shortMaterials: [] });
  const ln = s.issues[0].lines[0];
  assert.strictEqual(ln.receivedQty, 7);    // untouched
  assert.strictEqual(ln.disputedQty, 0);    // untouched, no invented dispute
  assert.strictEqual(s.requirements[0].receivedQty, 5); // never over-credited (I3 holds)
  assert.ok(s.requirements[0].receivedQty <= s.requirements[0].issuedQty);
  assert.strictEqual(s.rawMaterials.M1.inTransitQty, 0); // drained 0, never below 0 (I4)
  assert.strictEqual(res.raisedDisputeIds.length, 0);
  assert.strictEqual(s.disputes.length, 0); // corrupt row must not mint a ticket
});

// 1.6 — re-running a full receipt with the SAME payload is fully idempotent even
//       when the short figure was typed (the clamps in 1.1 apply to re-runs too).
test('EDGE: idempotent re-run of a SHORT receipt (watermarks hold)', () => {
  const s = world({
    issues: [issue({ lines: [line({ id: 'a', lot: 'L1', qty: 10 })] })],
    requirements: [reqRow({ issuedQty: 10 })]
  });
  s.rawMaterials.M1.inTransitQty = 10;
  s.lots.L1.inTransitQty = 10;
  const payload = {
    supId: 'E1', vouchers: ['V1'],
    shortMaterials: [{ materialId: 'M1', owed: 10, received: 6, remark: '' }]
  };
  receiveMaterials(s, payload);
  const snap = JSON.parse(JSON.stringify({ lines: s.issues[0].lines, reqs: s.requirements, raw: s.rawMaterials, lots: s.lots, disp: s.disputes }));
  const res2 = receiveMaterials(s, payload);
  checkInvariants(s, 'short-rerun');
  assert.deepStrictEqual(s.issues[0].lines, snap.lines, 'lines moved on re-run');
  assert.deepStrictEqual(s.requirements, snap.reqs, 'requirements moved on re-run');
  assert.deepStrictEqual(s.rawMaterials, snap.raw, 'raw stock moved on re-run');
  assert.deepStrictEqual(s.lots, snap.lots, 'lot stock moved on re-run');
  assert.strictEqual(s.disputes.length, snap.disp.length, 'a duplicate dispute was raised');
  assert.strictEqual(res2.raisedDisputeIds.length, 0);
});

// ===========================================================================
// SECTION 2 — receive-read.js: the flat-list SUPERVISOR RECEIVE LIST
// ===========================================================================

const queue = [];
function rtest(name, fn) { queue.push({ name, fn }); }
async function runReadAll() {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
  }
}

function lk(id, disp, field) {
  const o = { ID: String(id), zc_display_value: disp == null ? String(id) : String(disp) };
  if (field) o[field] = disp;
  return o;
}
function emp(o) {
  return Object.assign({ ID: 'E1', Employee_Name: 'Ravi', Designation: 'Supervisor', Status: 'Active' }, o);
}
// NOTE: these helpers carry a `rd` prefix purely to avoid the hoisted name
// collision with SECTION 1's identical names (issue/req). Do not rename back.
function rdIssueLine(o) {
  return Object.assign({
    ID: 'il1', Material: lk('M1'), Material_Name: 'Thread', Qty: 0, Received_Qty: 0, Disputed_Qty: 0, Settled_Qty: 0, Line_Status: 'Issued',
    Unit: 'Cone', Lot: '', Cut_Size_Width: 0, Cut_Size_Length: 0, Lot_Override_Note: ''
  }, o);
}
function rdIssue(o) {
  return Object.assign({ ID: 'V1', Issued_To: lk('E1'), Issue_Lines: [] }, o);
}
function rdReq(o) {
  return Object.assign({
    ID: 'r1', Plan: lk('P1'), Assigned_To: lk('E1'), Material: lk('M1'),
    Issued_Qty: 0, Received_Qty: 0, Source: 'Plan', Reason: '', Is_Fabric: false
  }, o);
}
function plan(o) {
  return Object.assign({ ID: 'P1', Plan_No: 'PLN-1', Sales_Order: lk('SO1'), Order_Status: 'Pending' }, o);
}
function so(o) { return Object.assign({ ID: 'SO1', Sales_Order: 'SO-00001' }, o); }
function rm(o) {
  return Object.assign({ ID: 'M1', Material_Display_Name: 'Thread', Name: 'Thread', SKU: 'RM-1', Unit: 'Cone', Is_Fabric: false }, o);
}
function lotRec(o) { return Object.assign({ ID: 'L1', Lot_Number: 'LOT-88' }, o); }
function rdWm(o) {
  return Object.assign({
    ID: 'W1', Movement_Type: 'Issued', Waste_Piece: lk('WP1'), Plan: lk('P1'),
    Piece_Count: 0, Piece_Width: 0, Piece_Length: 0, Cut_Size_Width: 0,
    Cut_Size_Length: 0, Pieces_Yielded: 0
  }, o);
}
const BASE = {
  emps: [emp()], issues: [], reqs: [], disputes: [], wasteMv: [],
  rawMats: [rm(), rm({ ID: 'M2', Material_Display_Name: 'Donna', SKU: 'RM-2', Unit: 'Mtr', Is_Fabric: true })],
  lots: [lotRec(), lotRec({ ID: 'L2', Lot_Number: 'LOT-99' })],
  plans: [plan()], salesOrders: [so()]
};
function rdRaw(over) { return Object.assign({}, BASE, over); }
function rdRun(over) { return ReceiveRead.assemble('E1', rdRaw(over)); }

// 2.1 — one material pending across TWO vouchers -> a SINGLE material row with
//       pending summed and BOTH voucher ids (the screen must offer one confirm
//       that settles both handovers).
rtest('EDGE: same material pending across TWO vouchers -> one row, both voucherIds', async () => {
  const out = await rdRun({
    issues: [
      rdIssue({ ID: 'V1', Issue_Lines: [rdIssueLine({ ID: 'a', Qty: 4, Received_Qty: 0 })] }),
      rdIssue({ ID: 'V2', Issue_Lines: [rdIssueLine({ ID: 'b', Qty: 6, Received_Qty: 0 })] })
    ],
    reqs: [rdReq({ Issued_Qty: 10 })]
  });
  assert.strictEqual(out.materials.length, 1);
  const m = out.materials[0];
  assert.strictEqual(m.pending, 10);                       // 4 + 6
  assert.deepStrictEqual(m.voucherIds.sort(), ['V1', 'V2']); // both handovers settle here
  assert.strictEqual(m.orders[0].pending, 10);
});

// 2.2 — one voucher already PART-SETTLED plus a second full one: pending is the
//       true remainder across both, not a double count of the settled part.
rtest('EDGE: part-settled voucher + second voucher -> pending is the true remainder', async () => {
  const out = await rdRun({
    issues: [
      rdIssue({ ID: 'V1', Issue_Lines: [rdIssueLine({ ID: 'a', Qty: 10, Received_Qty: 4, Line_Status: 'Partially_Received' })] }),
      rdIssue({ ID: 'V2', Issue_Lines: [rdIssueLine({ ID: 'b', Qty: 3, Received_Qty: 0 })] })
    ],
    reqs: [rdReq({ Issued_Qty: 13, Received_Qty: 4 })]
  });
  const m = out.materials[0];
  assert.strictEqual(m.pending, 9);                        // (10-4) + 3
  assert.strictEqual(m.orders[0].pending, 9);              // 13 - 4
});

// 2.3 — a PRINTED piece PARTIALLY received: it appears as its own row showing
//       ONLY the remaining pieces (fully-received ones must disappear).
rtest('EDGE: printed piece partially received -> own row, remainder only', async () => {
  const out = await rdRun({
    issues: [rdIssue({
      Issue_Lines: [
        rdIssueLine({ ID: 'p1', Material: lk('M2'), Qty: 3, Unit: 'Mtr', Received_Qty: 2, Line_Status: 'Partially_Received',
          Lot: lk('L1'), Lot_Override_Note: 'PRINTED_PIECE | 1x 300', Cut_Size_Width: 100, Cut_Size_Length: 300 }),
        rdIssueLine({ ID: 'p2', Material: lk('M2'), Qty: 3, Unit: 'Mtr', Received_Qty: 3, Line_Status: 'Received',
          Lot: lk('L1'), Lot_Override_Note: 'PRINTED_PIECE | 1x 300', Cut_Size_Width: 100, Cut_Size_Length: 300 })
      ]
    })]
  });
  // fully-received p2 drops off; only the one still owed shows
  assert.strictEqual(out.printedPieces.length, 1);
  assert.strictEqual(out.printedPieces[0].issueLineId, 'p1');
  assert.strictEqual(out.printedPieces[0].pending, 1);     // 3 - 2
  assert.strictEqual(out.printedPieces[0].qty, 3);
  assert.strictEqual(out.materials.length, 0);
});

// 2.4 — a pure-offcut fabric line (Qty 0 metres, pieces owed): nothing shows in
//       the METRES receive list (offcut coverage is handled by the waste
//       section, not the metres list). Pinned behaviour, not a defect.
rtest('EDGE: pure-offcut fabric line (qty 0) has nothing pending in the metres list', async () => {
  const out = await rdRun({
    issues: [rdIssue({
      Issue_Lines: [rdIssueLine({
        ID: 'f1', Material: lk('M2'), Qty: 0, Unit: 'Mtr', Lot: lk('L1'),
        Received_Qty: 0, Disputed_Qty: 0, Cut_Size_Width: 55, Cut_Size_Length: 55
      })]
    })],
    reqs: [rdReq({ Material: lk('M2'), Issued_Qty: 0 })]
  });
  // Owed = Qty - received - disputed = 0 - 0 - 0 = 0 -> not in the metres list.
  assert.strictEqual(out.materials.length, 0);
  assert.strictEqual(out.printedPieces.length, 0);
});

// 2.5 — an offcut ISSUED movement where part has been received AND part
//       disputed: waste pending nets the received children and the open dispute.
rtest('EDGE: waste movement with received children AND a partial open dispute nets both', async () => {
  const out = await rdRun({
    wasteMv: [
      rdWm({ ID: 'W1', Piece_Count: 5, Piece_Width: 300, Piece_Length: 400 }),
      rdWm({ ID: 'W2', Movement_Type: 'Received', Parent_Movement: lk('W1'), Piece_Count: 2 })
    ],
    disputes: [{
      ID: 'D1', Direction: 'Outbound', Is_Waste: true, Waste_Piece: lk('WP1'), Plan: lk('P1'),
      Disputed_Qty: 1, Status: 'Open', Resolution_Lines: [{ Resolved_Qty: 0 }]
    }]
  });
  assert.strictEqual(out.waste.length, 1);
  // 5 issued - 2 received children - 1 open dispute = 2 still pending
  assert.strictEqual(out.waste[0].pending, 2);
});

// 2.6 — a fully RESOLVED waste dispute must NOT reduce pending waste.
rtest('EDGE: a closed/resolved waste dispute does not reduce pending waste', async () => {
  const out = await rdRun({
    wasteMv: [
      rdWm({ ID: 'W1', Piece_Count: 4 }),
      rdWm({ ID: 'W2', Movement_Type: 'Received', Parent_Movement: lk('W1'), Piece_Count: 4 })
    ],
    disputes: [{
      ID: 'D1', Direction: 'Outbound', Is_Waste: true, Waste_Piece: lk('WP1'),
      Disputed_Qty: 2, Status: 'Open', Resolution_Lines: [{ Resolved_Qty: 2 }]
    }]
  });
  // fully received -> not pending regardless of the (fully resolved) dispute
  assert.strictEqual(out.waste.length, 0);
});

// ===========================================================================
// SECTION 3 — app/js/main.js handover-summary + allocation-split parity
// ===========================================================================

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
vm.runInContext('function round2(n){return Math.round((Number(n)||0)*100)/100;}', ctx);
vm.runInContext(grab('function buildHandoverSummary(issues)'), ctx);
vm.runInContext(grab('function splitIssuesByAllocation(issues, maxAllocs)'), ctx);
const buildHandoverSummary = ctx.buildHandoverSummary;
const splitIssuesByAllocation = ctx.splitIssuesByAllocation;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
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
  new Set([...Object.keys(fan), ...Object.keys(hand)]).forEach((m) => {
    const f = fan[m] || { qty: 0, raw: 0, waste: 0 };
    const h = hand[m] || { qty: 0, raw: 0, waste: 0 };
    assert.strictEqual(h.qty, f.qty, `material ${m}: qty ${h.qty} != ${f.qty}`);
    assert.strictEqual(h.raw, f.raw, `material ${m}: raw ${h.raw} != ${f.raw}`);
    assert.strictEqual(h.waste, f.waste, `material ${m}: waste ${h.waste} != ${f.waste}`);
  });
  return buildHandoverSummary(issues);
}
function appliedFrom(chunks, appliedCount) {
  const out = [];
  for (let i = 0; i < appliedCount && i < chunks.length; i++) {
    (chunks[i] || []).forEach((l) => out.push(l));
  }
  return out;
}

// 3.1 — SPLIT BOUNDARY: a material line carrying EXACTLY maxAllocs allocations
//       must not be sliced mid-line (it fits whole), and a following line must
//       flush the current chunk first. No empty chunk may be minted.
test('EDGE: a line at exactly maxAllocs never slices; boundary flush keeps chunks whole', () => {
  const issues = [
    {
      materialId: 'M1', unit: 'Cone', isFabric: false,
      allocations: [
        { mrqId: 'a', planId: 'p1', giveQty: 1, giveRaw: 0, giveWaste: 0, issuedLot: '' },
        { mrqId: 'b', planId: 'p2', giveQty: 2, giveRaw: 0, giveWaste: 0, issuedLot: '' }
      ],
      issueLines: []
    },
    {
      materialId: 'M2', unit: 'Mtr', isFabric: true,
      allocations: [{ mrqId: 'c', planId: 'p3', giveQty: 9, giveRaw: 18, giveWaste: 0, issuedLot: 'L1' }],
      issueLines: []
    }
  ];
  const chunks = splitIssuesByAllocation(issues, 2);
  // Line 1 has exactly 2 allocs == maxAllocs -> fits whole in chunk 0.
  // Line 2 (1 alloc) cannot fit -> flushes chunk 0, lands in chunk 1.
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].length, 1);
  assert.strictEqual(chunks[0][0].materialId, 'M1');       // line 1 kept whole
  const m1 = chunks[0][0];
  assert.strictEqual(m1.allocations.length, 2);            // NOT sliced
  assert.strictEqual(chunks[1][0].materialId, 'M2');
  // No empty chunk anywhere.
  chunks.forEach((c) => assert.ok(c.length > 0, 'empty chunk minted'));
});

// 3.2 — parity survives when the SAME material appears as BOTH a fresh-lot line
//       and an offcut line (giveQty>0 with a lot, and giveQty=0 waste-only).
test('EDGE: fresh-lot + offcut same material -> parity holds, two handover rows', () => {
  const issues = [{
    materialId: 'M4', unit: 'Mtr', isFabric: true,
    allocations: [
      { mrqId: 'r1', planId: 'p1', giveQty: 8, giveRaw: 16, giveWaste: 0, issuedLot: 'L9' },
      { mrqId: 'r2', planId: 'p1', giveQty: 0, giveRaw: 0, giveWaste: 4, issuedLot: '' }
    ],
    issueLines: [{ mrqId: 'r1', qty: 8, cutW: 55, cutL: 55, note: '' }]
  }];
  const s = assertParity(issues);
  // L9 row (8 m) + '' row (pieces-only) = 2 distinct handover lines.
  assert.strictEqual(s.lines.length, 2);
  const l9 = s.lines.find((x) => x.lot === 'L9');
  assert.strictEqual(l9.piecesFromRaw, 16);
  const off = s.lines.find((x) => x.lot === '');
  assert.strictEqual(off.piecesFromWaste, 4);
  assert.strictEqual(off.qty, 0);
});

// 3.3 — MIXED printed + regular allocation on the SAME material×lot: printed
//       rows must stay per-piece (never merged into the metres aggregate) and
//       parity must still balance.
test('EDGE: mixed printed + regular on one material keeps printed per-piece, parity holds', () => {
  const issues = [{
    materialId: 'M5', unit: 'Mtr', isFabric: true,
    allocations: [
      { mrqId: 'r1', planId: 'p1', giveQty: 3, giveRaw: 6, giveWaste: 0, issuedLot: 'LP' },
      { mrqId: 'r2', planId: 'p1', giveQty: 6, giveRaw: 12, giveWaste: 2, issuedLot: 'LP' }
    ],
    issueLines: [
      { mrqId: 'r1', qty: 3, cutW: 100, cutL: 300, note: 'PRINTED_PIECE | 1x 300' },
      { mrqId: 'r2', qty: 6, cutW: 55, cutL: 55, note: '' }
    ]
  }];
  const s = assertParity(issues);
  // r1 is a printed line -> its own printed row (raw 6, per-piece); r2 regular
  // aggregates into the LP material×lot row.
  const printed = s.lines.filter((x) => x.printed);
  assert.strictEqual(printed.length, 1);
  assert.strictEqual(printed[0].piecesFromRaw, 6);
  assert.strictEqual(printed[0].qty, 3);
  const reg = s.lines.find((x) => !x.printed && x.lot === 'LP');
  assert.strictEqual(reg.piecesFromRaw, 12);
  assert.strictEqual(reg.piecesFromWaste, 2);
  assert.strictEqual(reg.qty, 6);
  // total raw across printed + regular = 6 + 12 = fan.giveRaw 18
  assert.strictEqual(round2(s.lines.reduce((t, x) => t + x.piecesFromRaw, 0)), 18);
});

// 3.4 — SPLIT across a material whose allocations EXCEED maxAllocs: the line is
//       sliced in lockstep (allocations + issueLines), only the first slice
//       keeps lotMoves/wastePicks, and each slice is its own chunk. Electric:
//       this is what keeps a single thread of 300 allocations from overflowing.
test('EDGE: an oversized material line (allocs > maxAllocs) slices in lockstep, moves ride first', () => {
  const allocs = [];
  const iLines = [];
  for (let i = 0; i < 5; i++) {
    allocs.push({ mrqId: 'r' + i, planId: 'p1', giveQty: 1, giveRaw: 2, giveWaste: 0, issuedLot: 'L1' });
    iLines.push({ mrqId: 'r' + i, qty: 1, cutW: 55, cutL: 55, note: '' });
  }
  const issues = [{
    materialId: 'M2', unit: 'Mtr', isFabric: true,
    allocations: allocs,
    issueLines: iLines,
    lotMoves: [{ lotId: 'L1', metres: 5 }],
    wastePicks: [{ wasteId: 'W1', pieces: 0 }]
  }];
  const chunks = splitIssuesByAllocation(issues, 3);
  assert.strictEqual(chunks.length, 2);            // 5 allocs -> 3 + 2
  assert.strictEqual(chunks[0][0].allocations.length, 3);
  assert.strictEqual(chunks[1][0].allocations.length, 2);
  // issuesLines sliced in lockstep
  assert.strictEqual(chunks[0][0].issueLines.length, 3);
  assert.strictEqual(chunks[1][0].issueLines.length, 2);
  // lotMoves + wastePicks ride the FIRST slice only; the second has none
  assert.strictEqual(chunks[0][0].lotMoves.length, 1);
  assert.strictEqual(chunks[1][0].lotMoves.length, 0);
  assert.strictEqual(chunks[0][0].wastePicks.length, 1);
  assert.strictEqual(chunks[1][0].wastePicks.length, 0);
});

// 3.5 — an EMPTY allocations array (a material with no allocs, e.g. stale) must
//       not mint a handover line. The splitter keeps the line as a single chunk
//       (harmless - apply finds nothing to fan), so pin that it does NOT throw
//       and yields no handover rows, not that it drops the chunk.
test('EDGE: a material line with NO allocations yields no handover line; chunking is benign', () => {
  const issues = [{
    materialId: 'M1', unit: 'Cone', isFabric: false,
    allocations: [], issueLines: []
  }];
  const s = buildHandoverSummary(issues);
  assert.strictEqual(s.lines.length, 0);
  assert.strictEqual(s.planCount, 0);
  // The splitter wraps the empty line in one chunk (no crash); its allocations
  // are empty so apply is a no-op. Pinned as current intended behaviour.
  const chunks = splitIssuesByAllocation(issues, 100);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0][0].allocations.length, 0);
});

// ===========================================================================

// run everything
test('SECTION WARMUP: buildHandoverSummary / splitIssuesByAllocation are loadable', () => {
  // no-op sentinel so the sync runner has at least one fn (the read cases are
  // async below); asserts the vm hooks resolved.
  assert.strictEqual(typeof buildHandoverSummary, 'function');
  assert.strictEqual(typeof splitIssuesByAllocation, 'function');
});

Promise.all([runReadAll()]).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
