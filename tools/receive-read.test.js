#!/usr/bin/env node
// ReceiveRead.assemble() — the supervisor receive list built from flat
// getRecords rows. Must produce the shape render()/submitReceipt() in
// receive.js consume, matching what getSupervisorMaterials.dg emits for the
// same data.
//
//   materials[]  — one per material with a still-owed handover line;
//                  pending = Σ (Issue_Lines.Qty - Received_Qty) over his vouchers
//   lots[]       — per material, one per lot label, qty sums
//   orders[]     — per material, one per plan (from Material_Requirement), pending
//                  = issued - received, netted against open disputes
//   waste[]      — his Issued Waste_Movements minus Received children
//   printedPieces[] — PRINTED_PIECE Issue_Lines, one per line
//
//   usage: node tools/receive-read.test.js

'use strict';
const assert = require('assert');
const ReceiveRead = require('../app/supervisor/js/receive-read.js');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---- getRecords-row helpers ----
function lk(id, disp, field) {
  const o = { ID: String(id), zc_display_value: disp == null ? String(id) : String(disp) };
  if (field) o[field] = disp;
  return o;
}
function emp(o) {
  return Object.assign({ ID: 'E1', Employee_Name: 'Ravi', Designation: 'Supervisor', Status: 'Active' }, o);
}
function issueLine(o) {
  return Object.assign({
    ID: 'il1', Material: lk('M1'), Material_Name: 'Thread', Qty: 0, Received_Qty: 0, Disputed_Qty: 0, Settled_Qty: 0, Line_Status: 'Issued',
    Unit: 'Cone', Lot: '', Cut_Size_Width: 0, Cut_Size_Length: 0, Lot_Override_Note: ''
  }, o);
}
function issue(o) {
  return Object.assign({ ID: 'V1', Issued_To: lk('E1'), Issue_Lines: [] }, o);
}
function req(o) {
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
function wm(o) {
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
function raw(over) { return Object.assign({}, BASE, over); }

// assemble returns a Promise (it does a follow-up fetch for waste-piece SKUs,
// but with no `have()` in Node it resolves immediately with waste _wastePieceId
// unresolved — fine, we assert the non-waste shape here and waste counts).
function run(over) {
  return ReceiveRead.assemble('E1', raw(over));
}

test('one trim handover, fully owed -> one material line', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Qty: 5, Received_Qty: 0 })] })]
  });
  assert.strictEqual(out.materials.length, 1);
  const m = out.materials[0];
  assert.strictEqual(m.materialId, 'M1');
  assert.strictEqual(m.pending, 5);
  assert.strictEqual(m.unit, 'Cone');
  assert.strictEqual(m.isFabric, false);
  assert.deepStrictEqual(m.voucherIds, ['V1']);
});

test('partly received -> pending is the remainder', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Qty: 10, Received_Qty: 4 })] })]
  });
  assert.strictEqual(out.materials[0].pending, 6);
});

test('fully received -> not on the list', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Qty: 10, Received_Qty: 10 })] })]
  });
  assert.strictEqual(out.materials.length, 0);
});

test('two lots of one fabric -> two lot lines, pending sums', async () => {
  const out = await run({
    issues: [issue({
      Issue_Lines: [
        issueLine({ ID: 'a', Material: lk('M2'), Qty: 10, Lot: lk('L1'), Unit: 'Mtr' }),
        issueLine({ ID: 'b', Material: lk('M2'), Qty: 4, Lot: lk('L2'), Unit: 'Mtr' })
      ]
    })]
  });
  assert.strictEqual(out.materials.length, 1);
  const m = out.materials[0];
  assert.strictEqual(m.pending, 14);
  assert.strictEqual(m.lots.length, 2);
  assert.strictEqual(m.lots.find((l) => l.lot === 'LOT-88').qty, 10);
  assert.strictEqual(m.lots.find((l) => l.lot === 'LOT-99').qty, 4);
});

test('ROLL: one Issue_Line naming a single roll -> lot.rolls has one entry, full qty', async () => {
  const out = await run({
    issues: [issue({
      Issue_Lines: [issueLine({ Material: lk('M2'), Qty: 10, Lot: lk('L1'), Unit: 'Mtr', Roll_Label: 'LOT-88-R1' })]
    })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  assert.strictEqual(m.lots.length, 1);
  const l = m.lots[0];
  assert.strictEqual(l.lot, 'LOT-88');
  assert.strictEqual(l.rolls.length, 1);
  assert.strictEqual(l.rolls[0].roll, 'LOT-88-R1');
  assert.strictEqual(l.rolls[0].qty, 10);
});

test('ROLL: one Issue_Line naming TWO rolls ("L R1 5m, L R2 1.05m") splits qty per roll', async () => {
  const out = await run({
    issues: [issue({
      Issue_Lines: [issueLine({
        Material: lk('M2'), Qty: 6.05, Lot: lk('L1'), Unit: 'Mtr',
        Roll_Label: 'LOT-88-R1 5m, LOT-88-R2 1.05m'
      })]
    })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  const l = m.lots[0];
  assert.strictEqual(l.qty, 6.05, 'lot total is the whole owed amount, unaffected by roll split');
  assert.strictEqual(l.rolls.length, 2);
  assert.strictEqual(l.rolls[0].roll, 'LOT-88-R1');
  assert.strictEqual(l.rolls[0].qty, 5);
  assert.strictEqual(l.rolls[1].roll, 'LOT-88-R2');
  assert.strictEqual(l.rolls[1].qty, 1.05);
});

test('ROLL: a PARTLY-RECEIVED multi-roll line pro-rates segment metres to what is still owed', async () => {
  // Line issued 6.05m across two rolls (5 + 1.05), but 3.05 already received -
  // owed is 3. Sub-lines must sum to 3 (owed), not 6.05 (the original split).
  const out = await run({
    issues: [issue({
      Issue_Lines: [issueLine({
        Material: lk('M2'), Qty: 6.05, Received_Qty: 3.05, Lot: lk('L1'), Unit: 'Mtr',
        Roll_Label: 'LOT-88-R1 5m, LOT-88-R2 1.05m'
      })]
    })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  const l = m.lots[0];
  assert.strictEqual(l.qty, 3, 'lot total is owed, not original');
  const rollTotal = l.rolls.reduce((t, r) => t + r.qty, 0);
  assert.strictEqual(rollTotal, 3, 'roll sub-lines must sum to owed, not the original 6.05');
});

test('ROLL: a bare roll label ending in "m" (e.g. "FOAM") is not mangled', async () => {
  const out = await run({
    issues: [issue({
      Issue_Lines: [issueLine({ Material: lk('M2'), Qty: 5, Lot: lk('L1'), Unit: 'Mtr', Roll_Label: 'FOAM' })]
    })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  const l = m.lots[0];
  assert.strictEqual(l.rolls.length, 1);
  assert.strictEqual(l.rolls[0].roll, 'FOAM', 'must not be stripped to "FOA"');
});

test('ROLL: order breakdown with a bare label ending in "m" is not dropped or mangled', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Material: lk('M2'), Qty: 5, Unit: 'Mtr', Lot: lk('L1'), Roll_Label: 'FOAM' })] })],
    reqs: [req({ Material: lk('M2'), Issued_Qty: 5, Received_Qty: 0, Issued_Lot: lk('L1'), Roll_Label: 'FOAM' })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  const o = m.orders[0];
  assert.strictEqual(o.lotRolls.length, 1);
  assert.strictEqual(o.lotRolls[0].roll, 'FOAM');
});

test('ROLL: TWO Issue_Lines on the SAME roll accumulate into one rolls[] entry, not two', async () => {
  const out = await run({
    issues: [issue({
      Issue_Lines: [
        issueLine({ ID: 'a', Material: lk('M2'), Qty: 3, Lot: lk('L1'), Unit: 'Mtr', Roll_Label: 'LOT-88-R1' }),
        issueLine({ ID: 'b', Material: lk('M2'), Qty: 2, Lot: lk('L1'), Unit: 'Mtr', Roll_Label: 'LOT-88-R1' })
      ]
    })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  const l = m.lots[0];
  assert.strictEqual(l.rolls.length, 1);
  assert.strictEqual(l.rolls[0].qty, 5);
});

test('ROLL: an Issue_Line with NO Roll_Label (pre-Step-5 handover) -> lot.rolls is empty, lot.qty unaffected', async () => {
  const out = await run({
    issues: [issue({
      Issue_Lines: [issueLine({ Material: lk('M2'), Qty: 7, Lot: lk('L1'), Unit: 'Mtr', Roll_Label: '' })]
    })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  const l = m.lots[0];
  assert.strictEqual(l.qty, 7);
  assert.deepStrictEqual(l.rolls, []);
});

test('ROLL: order breakdown carries lotRolls[] from Material_Requirement.Issued_Lot + Roll_Label', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Material: lk('M2'), Qty: 10, Unit: 'Mtr', Lot: lk('L1'), Roll_Label: 'LOT-88-R1' })] })],
    reqs: [req({ Material: lk('M2'), Issued_Qty: 10, Received_Qty: 0, Issued_Lot: lk('L1'), Roll_Label: 'LOT-88-R1' })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  assert.strictEqual(m.orders.length, 1);
  const o = m.orders[0];
  assert.strictEqual(o.lotRolls.length, 1);
  assert.strictEqual(o.lotRolls[0].lot, 'LOT-88');
  assert.strictEqual(o.lotRolls[0].roll, 'LOT-88-R1');
});

test('ROLL: order breakdown with a MULTI-ROLL requirement row lists each roll once', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Material: lk('M2'), Qty: 6, Unit: 'Mtr', Lot: lk('L1'), Roll_Label: 'LOT-88-R1 4m, LOT-88-R2 2m' })] })],
    reqs: [req({ Material: lk('M2'), Issued_Qty: 6, Received_Qty: 0, Issued_Lot: lk('L1'), Roll_Label: 'LOT-88-R1 4m, LOT-88-R2 2m' })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  const o = m.orders[0];
  assert.strictEqual(o.lotRolls.length, 2);
  assert.strictEqual(o.lotRolls[0].roll, 'LOT-88-R1');
  assert.strictEqual(o.lotRolls[1].roll, 'LOT-88-R2');
});

test('ROLL: order breakdown with a lot but NO roll (offcut-only requirement row) still names the lot', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Material: lk('M2'), Qty: 6, Unit: 'Mtr', Lot: lk('L1') })] })],
    reqs: [req({ Material: lk('M2'), Issued_Qty: 6, Received_Qty: 0, Issued_Lot: lk('L1'), Roll_Label: '' })]
  });
  const m = out.materials.find((x) => x.materialId === 'M2');
  const o = m.orders[0];
  assert.strictEqual(o.lotRolls.length, 1);
  assert.strictEqual(o.lotRolls[0].lot, 'LOT-88');
  assert.strictEqual(o.lotRolls[0].roll, '');
});

test('order breakdown from Material_Requirement, netted against a dispute', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Qty: 10, Received_Qty: 0 })] })],
    reqs: [req({ Issued_Qty: 10, Received_Qty: 0 })],
    disputes: [{
      ID: 'D1', Direction: 'Outbound', Is_Waste: false, Plan: lk('P1'), Material: lk('M1'),
      Disputed_Qty: 3, Status: 'Open', Resolution_Lines: []
    }]
  });
  const m = out.materials[0];
  assert.strictEqual(m.orders.length, 1);
  assert.strictEqual(m.orders[0].planId, 'P1');
  assert.strictEqual(m.orders[0].salesOrder, 'SO-00001');
  assert.strictEqual(m.orders[0].pending, 7);   // 10 issued - 3 disputed
});

test('reissue source -> material and order flagged', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Qty: 5 })] })],
    reqs: [req({ Issued_Qty: 5, Source: 'Reissue' })]
  });
  assert.strictEqual(out.materials[0].isReissue, true);
  assert.strictEqual(out.materials[0].orders[0].isReissue, true);
});

test('plansAssigned counts open plans; plansAwaiting subtracts fed', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({ Qty: 5 })] })],
    reqs: [
      req({ ID: 'r1', Plan: lk('P1'), Issued_Qty: 5 }),
      req({ ID: 'r2', Plan: lk('P2'), Material: lk('M1'), Issued_Qty: 0 })
    ],
    plans: [plan({ ID: 'P1' }), plan({ ID: 'P2', Order_Status: 'Material Ready' })]
  });
  assert.strictEqual(out.plansAssigned, 2);
  // P1 fed (has an owed handover line + owed req), P2 not fed
  assert.strictEqual(out.plansAwaiting, 1);
});

test('printed piece -> its own row, not merged into materials', async () => {
  const out = await run({
    issues: [issue({
      Issue_Lines: [
        issueLine({ ID: 'p1', Material: lk('M2'), Qty: 3, Unit: 'Mtr', Lot: lk('L1'),
          Lot_Override_Note: 'PRINTED_PIECE | 1x 300', Cut_Size_Width: 100, Cut_Size_Length: 300 }),
        issueLine({ ID: 'p2', Material: lk('M2'), Qty: 3, Unit: 'Mtr', Lot: lk('L1'),
          Lot_Override_Note: 'PRINTED_PIECE | 1x 300' })
      ]
    })]
  });
  assert.strictEqual(out.materials.length, 0);
  assert.strictEqual(out.printedPieces.length, 2);
  assert.strictEqual(out.printedPieces[0].issueLineId, 'p1');
  assert.strictEqual(out.printedPieces[0].voucherId, 'V1');
  assert.strictEqual(out.printedPieces[0].lot, 'LOT-88');
  assert.strictEqual(out.printedPieces[0].pending, 3);
});

test('waste: Issued movement minus Received children', async () => {
  const out = await run({
    wasteMv: [
      wm({ ID: 'W1', Piece_Count: 5, Piece_Width: 300, Piece_Length: 400 }),
      wm({ ID: 'W2', Movement_Type: 'Received', Parent_Movement: lk('W1'), Piece_Count: 2 })
    ]
  });
  assert.strictEqual(out.waste.length, 1);
  assert.strictEqual(out.waste[0].rowId, 'W1');
  assert.strictEqual(out.waste[0].pending, 3);
  assert.strictEqual(out.waste[0].width, 300);
  // The lot field always exists on a waste row (filled from Waste_Master.Lot by
  // the follow-up fetch; '' in Node where that fetch is skipped). The bug this
  // guards: the row shape had no `lot` at all and the screen hardcoded "-".
  assert.strictEqual(out.waste[0].lot, '');
});

test('waste fully received -> not listed', async () => {
  const out = await run({
    wasteMv: [
      wm({ ID: 'W1', Piece_Count: 5 }),
      wm({ ID: 'W2', Movement_Type: 'Received', Parent_Movement: lk('W1'), Piece_Count: 5 })
    ]
  });
  assert.strictEqual(out.waste.length, 0);
});

test('REGRESSION: the DISPUTED part of a line is not pending receipt', async () => {
  // 7 confirmed, 3 disputed on a 10-metre line: nothing is still owed. Leaving
  // the 3 here lets the same material be received a second time and the item
  // released to production on material nobody has.
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({
      Qty: 10, Received_Qty: 7, Disputed_Qty: 3, Line_Status: 'Partially_Received'
    })] })],
    reqs: [req({ Issued_Qty: 10, Received_Qty: 7 })]
  });
  assert.strictEqual(out.materials.length, 0);
});

test('REGRESSION: an EARLIER dispute does not hide a new handover line', async () => {
  // The dispute belongs to an earlier handover and is recorded on THAT line.
  // These 10 metres are physically on the counter and ARE pending.
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({
      Qty: 10, Received_Qty: 0, Disputed_Qty: 0, Line_Status: 'Issued'
    })] })],
    reqs: [req({ Issued_Qty: 10, Received_Qty: 0 })],
    disputes: [{
      ID: 'D1', Direction: 'Outbound', Is_Waste: false, Plan: lk('P1'), Material: lk('M1'),
      Disputed_Qty: 4, Status: 'Open', Resolution_Lines: []
    }]
  });
  assert.strictEqual(out.materials[0].pending, 10);
});

test('REGRESSION: a LEGACY line reads Settled_Qty, not the new fields', async () => {
  // A legacy line (no Line_Status) settled by the old receiveMaterials has
  // Settled_Qty == Qty and empty Received/Disputed. Reading the new fields
  // would show a fully-received old handover as fully pending.
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({
      Qty: 10, Settled_Qty: 10, Received_Qty: 0, Disputed_Qty: 0, Line_Status: ''
    })] })],
    reqs: [req({ Issued_Qty: 10, Received_Qty: 10 })]
  });
  assert.strictEqual(out.materials.length, 0);
});

test('REGRESSION: a LEGACY line only part-settled is still pending for the rest', async () => {
  const out = await run({
    issues: [issue({ Issue_Lines: [issueLine({
      Qty: 10, Settled_Qty: 4, Received_Qty: 0, Disputed_Qty: 0, Line_Status: ''
    })] })],
    reqs: [req({ Issued_Qty: 10, Received_Qty: 4 })]
  });
  assert.strictEqual(out.materials.length, 1);
  assert.strictEqual(out.materials[0].pending, 6);
});

test('empty supervisor -> only the picker', async () => {
  // run() with '' returns just supervisors; assemble is not the entry there,
  // but assert the fixture path: no issues -> no materials.
  const out = await run({ issues: [], reqs: [], wasteMv: [] });
  assert.strictEqual(out.materials.length, 0);
  assert.strictEqual(out.waste.length, 0);
  assert.strictEqual(out.supervisors.length, 1);
  assert.strictEqual(out.supervisors[0].name, 'Ravi');
});

runAll();
