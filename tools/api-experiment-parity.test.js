#!/usr/bin/env node
// Parity tests for ApiExperiment.assemble() vs getStoreMaterialRequirements.dg.
//
// assemble() takes the nine getRecords-shaped row arrays and must produce the
// SAME supervisor-block / material-entry shape the custom function returns.
// Each test fixtures raw rows and asserts the assembled output against what the
// Deluge would emit for the same data.
//
// Cannot hit live Creator, so the fixtures ARE the contract: getRecords rows in,
// custom-function-shaped payload out. If assemble() diverges from the Deluge,
// one of these should fail.
//
//   usage: node tools/api-experiment-parity.test.js

'use strict';
const assert = require('assert');
const ApiExperiment = require('../app/js/api-experiment.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
}

// ---- getRecords-row helpers -------------------------------------------------
// A Creator lookup field comes back as { ID, zc_display_value, <displayField> }.
function lk(id, disp, field) {
  const o = { ID: String(id), zc_display_value: disp == null ? String(id) : String(disp) };
  if (field) o[field] = disp;
  return o;
}

// Minimal builders — only the fields assemble() reads.
function plan(o) {
  return Object.assign({
    ID: '1', Order_Status: 'Pending', Sales_Order: lk('SO1', 'SO-00001', 'Sales_Order'),
    Priority_Key: 1000001
  }, o);
}
function req(o) {
  return Object.assign({
    ID: 'r1', Plan: lk('1'), Assigned_To: lk('E1'), Material: lk('M1'),
    Is_Fabric: false, Cut_Size_Width: 0, Cut_Size_Length: 0, Required_Pieces: 0,
    Pieces_From_Waste: 0, Pieces_From_Raw: 0, Source: 'Plan',
    Material_Name: 'Thread', Unit: 'Cone', Required_Qty: 0, Issued_Qty: 0,
    Plan_Item: lk('PI1'), Issued_Lot: '', Reason: ''
  }, o);
}
function emp(id, name) { return { ID: String(id), Employee_Name: name }; }
function planItem(id, name, remake) { return { ID: String(id), Item_Name: name, Is_Remake: !!remake }; }
function rawMat(o) {
  return Object.assign({
    ID: 'M1', SKU: 'RM-01', Material_Display_Name: '', Name: 'Thread',
    Quantity: 0, Fabric_Width_Inches: '', Print_Base: ''
  }, o);
}
function lot(o) {
  return Object.assign({
    ID: 'L1', Material: lk('M1'), Lot_Number: 'LOT-1', Lot_Label: '',
    Status: 'Active', Wash_Quantity: 0, Unwash_Quantity: 0, In_Wash_Qty: 0, Form: ''
  }, o);
}
function fabricPiece(o) {
  return Object.assign({
    ID: 'FP1', Lot: lk('L1'), Piece_Length_Cm: 0, Piece_Width_Cm: 0,
    Piece_Count: 0, State: 'Wash', Carton_Number: ''
  }, o);
}
function wasteM(o) {
  return Object.assign({
    ID: 'W1', SKU: lk('M1'), Piece_Width: 0, Piece_Length: 0, Piece_Count: 0,
    Lot: '', Carton_Number: ''
  }, o);
}
function exc(o) {
  return Object.assign({
    ID: 'X1', Type_field: '', Type: '', SKU: lk('M1'), PO_Number: '',
    Shortfall_Qty: 0, Required_Qty: 0, Lot: '', Exception_Lines: []
  }, o);
}

function assemble(raw) {
  return ApiExperiment.assemble(Object.assign({
    plans: [], reqs: [], emps: [], planItems: [], rawMats: [], lots: [],
    pieces: [], waste: [], exceptions: []
  }, raw));
}
function matOf(out, supId, matId) {
  const b = (out.plans || []).find((s) => s.supervisorId === String(supId));
  if (!b) return null;
  return (b.materials || []).find((m) => m.materialId === String(matId)) || null;
}

// =========================================================================
// 1. OPEN-PLAN FILTER — only Pending / Partially Received / In Progress
// =========================================================================
test('only requirements on open plans are aggregated', () => {
  const out = assemble({
    plans: [
      plan({ ID: '1', Order_Status: 'Pending' }),
      plan({ ID: '2', Order_Status: 'Material Ready' }),   // NOT open
      plan({ ID: '3', Order_Status: 'In Progress' })
    ],
    reqs: [
      req({ ID: 'a', Plan: lk('1'), Required_Qty: 10 }),
      req({ ID: 'b', Plan: lk('2'), Required_Qty: 999 }),  // dropped
      req({ ID: 'c', Plan: lk('3'), Required_Qty: 5 })
    ],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({})]
  });
  const m = matOf(out, 'E1', 'M1');
  assert.strictEqual(m.required, 15, 'plan 2 excluded, 10 + 5');
});

// =========================================================================
// 2. AGGREGATION KEY = supId | matId | source  (reissue never merges)
// =========================================================================
test('Plan and Reissue rows for one material stay separate', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [
      req({ ID: 'a', Source: 'Plan', Required_Qty: 28.35 }),
      req({ ID: 'b', Source: 'Reissue', Required_Qty: 3 }),
      req({ ID: 'c', Source: '', Required_Qty: 1 })     // empty -> "Plan"
    ],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({})]
  });
  const b = out.plans.find((s) => s.supervisorId === 'E1');
  assert.strictEqual(b.materials.length, 2, 'one Plan entry, one Reissue entry');
  const planM = b.materials.find((m) => !m.isReissue);
  const reissM = b.materials.find((m) => m.isReissue);
  assert.strictEqual(planM.required, 29.35, 'empty source folded into Plan');
  assert.strictEqual(reissM.required, 3);
});

// =========================================================================
// 3. NON-FABRIC — remaining = required - issued, availableStock = Quantity
// =========================================================================
test('non-fabric: remaining and availableStock', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [req({ Required_Qty: 100, Issued_Qty: 40 })],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ Quantity: 250 })]
  });
  const m = matOf(out, 'E1', 'M1');
  assert.strictEqual(m.isFabric, false);
  assert.strictEqual(m.remaining, 60);
  assert.strictEqual(m.availableStock, 250);
});

// =========================================================================
// 4. FABRIC piece counters + per-cut summary
// =========================================================================
test('fabric: reqPieces / issPieces / wasteIssuedPieces / cuts', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [
      req({
        ID: 'a', Is_Fabric: true, Material: lk('F1'), Material_Name: 'Linen', Unit: 'Mtr',
        Cut_Size_Width: 55, Cut_Size_Length: 55, Required_Pieces: 40,
        Pieces_From_Waste: 4, Pieces_From_Raw: 6, Required_Qty: 28.35, Issued_Qty: 5
      }),
      req({
        ID: 'b', Is_Fabric: true, Material: lk('F1'), Material_Name: 'Linen', Unit: 'Mtr',
        Cut_Size_Width: 240, Cut_Size_Length: 240, Required_Pieces: 10,
        Pieces_From_Waste: 0, Pieces_From_Raw: 0, Required_Qty: 24, Issued_Qty: 0
      })
    ],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'F1', SKU: 'RM-F1', Name: 'Linen', Fabric_Width_Inches: '44' })]
  });
  const m = matOf(out, 'E1', 'F1');
  assert.strictEqual(m.isFabric, true);
  assert.strictEqual(m.requiredPieces, 50, '40 + 10');
  assert.strictEqual(m.issuedPieces, 10, '(4+6) + 0');
  assert.strictEqual(m.wasteIssuedPieces, 4);
  assert.strictEqual(m.outstandingPieces, 40, '50 - 10');
  assert.strictEqual(m.cuts.length, 2, 'two cut sizes');
  const c55 = m.cuts.find((c) => c.cutW === 55);
  assert.strictEqual(c55.reqPieces, 40);
  assert.strictEqual(c55.issPieces, 10);
});

// =========================================================================
// 5. FRESH METRES — per-cut whole-marker-row estimate (Deluge 1289-1333)
//    fabricWidthCm = 44 in * 2.54 = 111.76
//    cut 55: perRow = floor(111.76/55) = 2 ;  remain = 40-10 = 30
//            rows = ceil(30/2) = 15 ;  metres = 15 * 55 / 100 = 8.25
//    cut 240: perRow = floor(111.76/240) = 0 -> that cut contributes nothing
//    freshMeters = 8.25  ;  required = remaining = 8.25
// =========================================================================
test('fabric: freshMeters per-cut whole-marker-row calc', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [
      req({
        ID: 'a', Is_Fabric: true, Material: lk('F1'), Material_Name: 'Linen', Unit: 'Mtr',
        Cut_Size_Width: 55, Cut_Size_Length: 55, Required_Pieces: 40,
        Pieces_From_Waste: 4, Pieces_From_Raw: 6, Required_Qty: 28.35, Issued_Qty: 5
      }),
      req({
        ID: 'b', Is_Fabric: true, Material: lk('F1'), Material_Name: 'Linen', Unit: 'Mtr',
        Cut_Size_Width: 240, Cut_Size_Length: 240, Required_Pieces: 10,
        Pieces_From_Waste: 0, Pieces_From_Raw: 0, Required_Qty: 24, Issued_Qty: 0
      })
    ],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'F1', SKU: 'RM-F1', Name: 'Linen', Fabric_Width_Inches: '44' })]
  });
  const m = matOf(out, 'E1', 'F1');
  assert.strictEqual(m.freshMeters, 8.25);
  assert.strictEqual(m.required, 8.25, 'Deluge sets matEntry.required = freshMeters');
  assert.strictEqual(m.remaining, 8.25);
  assert.strictEqual(m.requiredTotal, 52.35, 'requiredTotal keeps the raw sum');
});

test('fabric: no countable cut -> freshMeters falls back to req - iss', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [req({
      Is_Fabric: true, Material: lk('F1'), Material_Name: 'Linen', Unit: 'Mtr',
      Cut_Size_Width: 0, Cut_Size_Length: 0, Required_Pieces: 0,   // no piece data
      Required_Qty: 30, Issued_Qty: 12
    })],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'F1', Name: 'Linen', Fabric_Width_Inches: '44' })]
  });
  const m = matOf(out, 'E1', 'F1');
  assert.strictEqual(m.freshMeters, 18, '30 - 12');
  assert.strictEqual(m.remaining, 18);
});

// =========================================================================
// 6. LOTS — blocked flagged, empty dropped, in-wash kept, rollup sums ALL
// =========================================================================
test('lots: blocked flagged & kept, empty dropped, calc* sums every lot', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [req({ Is_Fabric: true, Material: lk('F1'), Material_Name: 'Linen', Unit: 'Mtr', Required_Qty: 10 })],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'F1', Name: 'Linen', Fabric_Width_Inches: '44' })],
    lots: [
      lot({ ID: 'L1', Material: lk('F1'), Lot_Number: 'A', Wash_Quantity: 40, Unwash_Quantity: 10 }),
      lot({ ID: 'L2', Material: lk('F1'), Lot_Number: 'B', Status: 'Blocked', Wash_Quantity: 18 }),
      lot({ ID: 'L3', Material: lk('F1'), Lot_Number: 'C', Wash_Quantity: 0, Unwash_Quantity: 0, In_Wash_Qty: 0 }), // empty -> dropped from list
      lot({ ID: 'L4', Material: lk('F1'), Lot_Number: 'D', In_Wash_Qty: 25 })  // at wash -> kept
    ]
  });
  const m = matOf(out, 'E1', 'F1');
  const ids = m.lots.map((l) => l.lotId).sort();
  assert.deepStrictEqual(ids, ['L1', 'L2', 'L4'], 'empty L3 dropped, blocked L2 and in-wash L4 kept');
  assert.strictEqual(m.lots.find((l) => l.lotId === 'L2').blocked, true);
  assert.strictEqual(m.availableStock, 58, 'calcWash sums ALL lots incl blocked+empty: 40+18+0+0');
  assert.strictEqual(m.unwashedStock, 10);
  assert.strictEqual(m.inWashStock, 25);
});

// =========================================================================
// 7. PIECES-FORM LOT — wash = sum of washed pieces' metres, pieces attached
//    two Wash pieces 300cm x 5, one Unwash 300cm x 2
//    wash = (300/100)*5 = 15   (Unwash excluded)
// =========================================================================
test('pieces-form lot: wash from washed pieces only, piece list carried', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [req({ Is_Fabric: true, Material: lk('F1'), Material_Name: 'Print', Unit: 'Mtr', Required_Qty: 5 })],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'F1', Name: 'Print', Fabric_Width_Inches: '44' })],
    lots: [lot({ ID: 'LP', Material: lk('F1'), Lot_Number: 'P', Form: 'Pieces' })],
    pieces: [
      fabricPiece({ ID: 'p1', Lot: lk('LP'), Piece_Length_Cm: 300, Piece_Width_Cm: 110, Piece_Count: 5, State: 'Wash' }),
      fabricPiece({ ID: 'p2', Lot: lk('LP'), Piece_Length_Cm: 300, Piece_Width_Cm: 110, Piece_Count: 2, State: 'Unwash' })
    ]
  });
  const m = matOf(out, 'E1', 'F1');
  const lp = m.lots.find((l) => l.lotId === 'LP');
  assert.strictEqual(lp.form, 'Pieces');
  assert.strictEqual(lp.wash, 15, '(300/100)*5, unwash excluded');
  assert.strictEqual(lp.pieces.length, 2, 'both pieces carried for the allocator');
  assert.strictEqual(m.availableStock, 15, 'material rollup uses the pieces sum');
});

// =========================================================================
// 8. WASTE STOCK — available only, zero-dim/count dropped, lot number + carton
// =========================================================================
test('wasteStock: filters and lot/carton resolution', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [req({ Is_Fabric: true, Material: lk('F1'), Material_Name: 'Linen', Unit: 'Mtr', Required_Qty: 10 })],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'F1', Name: 'Linen', Fabric_Width_Inches: '44' })],
    lots: [lot({ ID: 'L9', Material: lk('F1'), Lot_Number: 'DONNA', Wash_Quantity: 5 })],
    waste: [
      wasteM({ ID: 'w1', SKU: lk('F1'), Piece_Width: 40, Piece_Length: 55, Piece_Count: 3, Lot: lk('L9'), Carton_Number: 'C7' }),
      wasteM({ ID: 'w2', SKU: lk('F1'), Piece_Width: 0, Piece_Length: 55, Piece_Count: 3 }),   // zero width -> dropped
      wasteM({ ID: 'w3', SKU: lk('F1'), Piece_Width: 40, Piece_Length: 55, Piece_Count: 0 })    // zero count -> dropped
    ]
  });
  const m = matOf(out, 'E1', 'F1');
  assert.strictEqual(m.wasteStock.length, 1, 'w2 and w3 dropped');
  const w = m.wasteStock[0];
  assert.strictEqual(w.wasteId, 'w1');
  assert.strictEqual(w.pieces, 3);
  assert.strictEqual(w.lot, 'DONNA', 'lot number resolved from the lot map');
  assert.strictEqual(w.carton, 'C7');
});

// =========================================================================
// 9. EXCEPTIONS + poCoveredQty netting
// =========================================================================
test('open exceptions grouped, poCovered netted against on-hand', () => {
  const out = assemble({
    plans: [plan({ ID: '1' }), plan({ ID: '2', ID: '2' })],
    reqs: [req({ Required_Qty: 100, Issued_Qty: 0, Material: lk('M1'), Material_Name: 'Thread' })],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'M1', Quantity: 30 })],   // on-hand 30 < required 120 -> PO still counts
    exceptions: [
      exc({
        ID: 'x1', Type_field: 'Shortage', SKU: lk('M1'), PO_Number: 'SO-PO-0042',
        Shortfall_Qty: 50, Required_Qty: 120,
        Exception_Lines: [{ Plan: lk('1') }, { Plan: lk('2') }, { Plan: lk('1') }]
      }),
      exc({ ID: 'x2', Type: 'Wash', SKU: lk('M1'), Lot: lk('L1'), Exception_Lines: [{ Plan: lk('1') }] })
    ]
  });
  const m = matOf(out, 'E1', 'M1');
  assert.strictEqual(m.openExceptions.length, 2);
  const sh = m.openExceptions.find((x) => x.type === 'Shortage');
  assert.deepStrictEqual(sh.planIds.sort(), ['1', '2'], 'deduped covered plans');
  assert.strictEqual(sh.poNumber, 'SO-PO-0042');
  const wash = m.openExceptions.find((x) => x.type === 'Wash');
  assert.strictEqual(wash.lot, 'L1', 'wash ticket carries its lot');
  assert.strictEqual(m.poCoveredQty, 50, 'PO counted: on-hand 30 < required 120');
});

test('poCovered NOT counted once FABRIC on-hand covers the requirement', () => {
  // Deluge nets against calcWashByMat (fabric) — a fabric lot with enough
  // washed stock zeroes the PO. (For a NON-fabric material calcWash is 0, so a
  // non-fabric PO shortage is always counted — matches the Deluge.)
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [req({ Is_Fabric: true, Material: lk('F1'), Material_Name: 'Linen', Unit: 'Mtr',
                 Required_Qty: 100, Cut_Size_Width: 0 })],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'F1', Name: 'Linen', Fabric_Width_Inches: '44' })],
    lots: [lot({ ID: 'L1', Material: lk('F1'), Lot_Number: 'A', Wash_Quantity: 200 })], // on-hand 200 >= 120
    exceptions: [exc({
      Type_field: 'Shortage', SKU: lk('F1'), PO_Number: 'PO-9', Shortfall_Qty: 50, Required_Qty: 120,
      Exception_Lines: [{ Plan: lk('1') }]
    })]
  });
  const m = matOf(out, 'E1', 'F1');
  assert.strictEqual(m.poCoveredQty, 0, 'fabric stock has landed, PO no longer netted');
});

test('non-fabric PO shortage is always counted (calcWash is 0)', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [req({ Required_Qty: 100, Material: lk('M1'), Material_Name: 'Thread' })],
    emps: [emp('E1', 'Ravi')],
    rawMats: [rawMat({ ID: 'M1', Quantity: 200 })],
    exceptions: [exc({
      Type_field: 'Shortage', SKU: lk('M1'), PO_Number: 'PO-9', Shortfall_Qty: 50, Required_Qty: 120,
      Exception_Lines: [{ Plan: lk('1') }]
    })]
  });
  assert.strictEqual(matOf(out, 'E1', 'M1').poCoveredQty, 50);
});

// =========================================================================
// 10. LINES — one per requirement row, all fields, issuedLotNo resolved
// =========================================================================
test('lines: per-row detail, item name + remake flag, issuedLotNo', () => {
  const out = assemble({
    plans: [plan({ ID: '1', Sales_Order: lk('SO', 'SO-00010', 'Sales_Order') })],
    reqs: [
      req({ ID: 'r1', Plan_Item: lk('PI1'), Required_Qty: 10, Issued_Qty: 4, Issued_Lot: lk('L1') }),
      req({ ID: 'r2', Plan_Item: lk('PI2'), Required_Qty: 6, Reason: 'panels ruined\nat cutting' })
    ],
    emps: [emp('E1', 'Ravi')],
    planItems: [planItem('PI1', 'Napkins', false), planItem('PI2', 'Napkins', true)],
    rawMats: [rawMat({})],
    lots: [lot({ ID: 'L1', Lot_Number: 'L1-num', Wash_Quantity: 5 })]
  });
  const m = matOf(out, 'E1', 'M1');
  assert.strictEqual(m.lines.length, 2);
  const l1 = m.lines.find((x) => x.mrqId === 'r1');
  assert.strictEqual(l1.salesOrder, 'SO-00010');
  assert.strictEqual(l1.item, 'Napkins');
  assert.strictEqual(l1.isRemake, false);
  assert.strictEqual(l1.issued, 4);
  assert.strictEqual(l1.issuedLot, 'L1');
  assert.strictEqual(l1.issuedLotNo, 'L1-num', 'readable pinned-lot number');
  const l2 = m.lines.find((x) => x.mrqId === 'r2');
  assert.strictEqual(l2.isRemake, true);
  assert.strictEqual(l2.reason, "panels ruined | at cutting", 'newline flattened like the Deluge');
});

// =========================================================================
// 11. SHAPE — supervisor block + display-name fallback
// =========================================================================
test('supervisor block shape and display-name preference', () => {
  const out = assemble({
    plans: [plan({ ID: '1' })],
    reqs: [
      req({ ID: 'a', Assigned_To: lk('E1'), Material_Name: 'Snapshot Name' }),
      req({ ID: 'b', Assigned_To: lk('E2'), Material: lk('M2'), Material_Name: 'M2 snap' })
    ],
    emps: [emp('E1', 'Ravi'), emp('E2', 'Sana')],
    rawMats: [
      rawMat({ ID: 'M1', Material_Display_Name: 'Live Display Name' }),
      rawMat({ ID: 'M2', Material_Display_Name: '' })
    ]
  });
  assert.strictEqual(out.plans.length, 2, 'one block per supervisor');
  const m1 = matOf(out, 'E1', 'M1');
  assert.strictEqual(m1.material, 'Live Display Name', 'live display name wins over the snapshot');
  const m2 = matOf(out, 'E2', 'M2');
  assert.strictEqual(m2.material, 'M2 snap', 'falls back to the requirement snapshot when display name empty');
});

// =========================================================================
// 12. EMPTY INPUT
// =========================================================================
test('empty everything -> { plans: [] }', () => {
  const out = assemble({});
  assert.deepStrictEqual(out.plans, []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
