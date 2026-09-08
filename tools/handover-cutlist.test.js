/* Pure-join tests for HandoverDetail.assemble — no SDK, stub records only.
 * Run: node tools/handover-cutlist.test.js
 */
'use strict';
var HandoverDetail = require('../app/supervisor/js/handover-detail.js');

var pass = 0, fail = 0;
function ok(name, cond) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; console.log('  FAIL ' + name); }
}
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' == ' + JSON.stringify(b) + ')', a === b); }

// ---- roll label parser --------------------------------------------------
(function () {
    console.log('parseRollLabel');
    var p = HandoverDetail._parseRollLabel;
    var a = p('L2-R1');
    eq('single bare label', a.length, 1);
    eq('single label text', a[0].label, 'L2-R1');
    eq('single label mtr 0', a[0].mtr, 0);

    var b = p('L2-R1 5m, L2-R2 1.05m');
    eq('two rolls parsed', b.length, 2);
    eq('roll 1 label', b[0].label, 'L2-R1');
    eq('roll 1 mtr', b[0].mtr, 5);
    eq('roll 2 mtr', b[1].mtr, 1.05);

    eq('empty -> []', p('').length, 0);
    eq('FOAM not mangled', p('FOAM')[0].label, 'FOAM');
    // single roll WITH a metre suffix (a requirement-row Roll_Label) -> stripped
    eq('single roll + metres label', p('L1-R1 8m')[0].label, 'L1-R1');
    eq('single roll + metres mtr', p('L1-R1 8m')[0].mtr, 8);
})();

// ---- Creator date helpers (picker sort + filter) --------------------
(function () {
    console.log('date helpers');
    var c = HandoverDetail._creatorDateToTs;
    var f = HandoverDetail._fmtCreatorDate;
    ok('08-Sep-2026 < 12-Sep-2026', c('08-Sep-2026') < c('12-Sep-2026'));
    ok('12-Aug-2026 < 08-Sep-2026 (cross-month)', c('12-Aug-2026') < c('08-Sep-2026'));
    ok('31-Dec-2025 < 01-Jan-2026 (cross-year)', c('31-Dec-2025') < c('01-Jan-2026'));
    eq('garbage -> 0', c('not a date'), 0);
    eq('empty -> 0', c(''), 0);
    eq('fmt round-trips a known date', f(new Date(2026, 8, 8)), '08-Sep-2026');
    eq('fmt pads single digit', f(new Date(2026, 0, 3)), '03-Jan-2026');
})();

// ---- assemble ---------------------------------------------------------
(function () {
    console.log('assemble — one SIV, two materials, two orders');

    var raw = {
        issues: [{
            ID: '900', Voucher_No: 'SIV-00042', Issue_Date: '08-Sep-2026', Issue_Time: '13:09',
            Issued_To: { ID: '10' }, Issue_Status: 'Issued', Transfer_Status: 'Pending', Plan_Count: 2,
            Issue_Lines: [
                {
                    ID: 'L1', Material: { ID: 'M1' }, Material_Name: 'Linen 60"', Lot: { ID: 'LOT1' },
                    Qty: 12.5, Received_Qty: 0, Disputed_Qty: 0, Line_Status: 'Issued',
                    Unit: 'Mtr', Cut_Size_Width: 55, Cut_Size_Length: 80,
                    Pieces_From_Raw: 18, Pieces_From_Waste: 2, Roll_Label: 'L1-R1 8m, L1-R2 4.5m'
                },
                {
                    ID: 'L2', Material: { ID: 'M2' }, Material_Name: 'Thread white', Lot: '',
                    Qty: 4, Received_Qty: 4, Disputed_Qty: 0, Line_Status: 'Issued',
                    Unit: 'Cone', Cut_Size_Width: 0, Cut_Size_Length: 0,
                    Pieces_From_Raw: 0, Pieces_From_Waste: 0, Roll_Label: ''
                }
            ]
        }],
        reqs: [
            // plan P1, item I1 — fabric M1 off LOT1
            {
                ID: 'R1', Material: { ID: 'M1' }, Issued_Lot: { ID: 'LOT1' }, Plan: { ID: 'P1' },
                Plan_Item: { ID: 'I1' }, Pieces_From_Raw: 10, Pieces_From_Waste: 2, Required_Pieces: 12,
                Issued_Qty: 7.5, Received_Qty: 0, Cut_Size_Width: 55, Cut_Size_Length: 80,
                Source: 'Plan', Roll_Label: 'L1-R1 8m', Is_Fabric: true
            },
            // plan P2, item I2 — fabric M1 off LOT1
            {
                ID: 'R2', Material: { ID: 'M1' }, Issued_Lot: { ID: 'LOT1' }, Plan: { ID: 'P2' },
                Plan_Item: { ID: 'I2' }, Pieces_From_Raw: 8, Pieces_From_Waste: 0, Required_Pieces: 8,
                Issued_Qty: 5, Received_Qty: 0, Cut_Size_Width: 55, Cut_Size_Length: 80,
                Source: 'Reissue', Reason: 'Check reject', Roll_Label: 'L1-R2 4.5m', Is_Fabric: true
            },
            // plan P1, item I1 — trim M2, no lot
            {
                ID: 'R3', Material: { ID: 'M2' }, Issued_Lot: '', Plan: { ID: 'P1' },
                Plan_Item: { ID: 'I1' }, Pieces_From_Raw: 0, Pieces_From_Waste: 0, Required_Pieces: 0,
                Issued_Qty: 4, Received_Qty: 4, Source: 'Plan', Is_Fabric: false
            },
            // a requirement for a material this SIV never issued — must be ignored
            {
                ID: 'R4', Material: { ID: 'M9' }, Issued_Lot: { ID: 'LOT9' }, Plan: { ID: 'P1' },
                Plan_Item: { ID: 'I1' }, Pieces_From_Raw: 5, Issued_Qty: 3, Is_Fabric: true
            }
        ],
        plans: [
            { ID: 'P1', Plan_No: 'PLN-1', Sales_Order: { ID: 'SO1' }, Order_Status: 'In Progress' },
            { ID: 'P2', Plan_No: 'PLN-2', Sales_Order: { ID: 'SO2' }, Order_Status: 'Partially Received' }
        ],
        salesOrders: [
            { ID: 'SO1', Sales_Order: 'ORD-1001' },
            { ID: 'SO2', Sales_Order: 'ORD-1002' }
        ],
        planItems: [
            { ID: 'I1', Item_Sku: { ID: 'IM1' }, Item_Name: 'Napkin set', Item_Status: 'Awaiting_Material', Is_Remake: false },
            { ID: 'I2', Item_Sku: { ID: 'IM2' }, Item_Name: 'Runner', Item_Status: 'Awaiting_Material', Is_Remake: true, Remake_Reason: 'Check_Reject' }
        ],
        itemMasters: [
            { ID: 'IM1', SKU: 'NAP-6' },
            { ID: 'IM2', SKU: 'RUN-1' }
        ],
        rawMats: [
            { ID: 'M1', Material_Display_Name: 'Linen 60"', Unit: 'Mtr', Is_Fabric: true },
            { ID: 'M2', Name: 'Thread white', Unit: 'Cone', Is_Fabric: false }
        ],
        lots: [{ ID: 'LOT1', Lot_Number: 'L1' }],
        emps: [{ ID: '10', Employee_Name: 'Ravi', Designation: 'Supervisor', Status: 'Active' }]
    };

    var d = HandoverDetail.assemble('900', raw);

    // header
    eq('voucher no', d.header.voucherNo, 'SIV-00042');
    eq('issued-to name', d.header.issuedToName, 'Ravi');
    eq('total qty', d.header.totalQty, 16.5);
    eq('received qty', d.header.receivedQty, 4);
    eq('owed qty', d.header.owedQty, 12.5);
    eq('receipt status', d.header.receiptStatus, 'Partially received');

    // cloth — one entry per MATERIAL, lots nested
    eq('cloth materials', d.cloth.length, 2);
    var fab = d.cloth.filter(function (c) { return c.materialId === 'M1'; })[0];
    eq('fabric lot count', fab.lots.length, 1);
    eq('fabric lot label', fab.lots[0].lot, 'L1');
    eq('fabric roll count', fab.lots[0].rolls.length, 2);
    eq('fabric roll1 label (key is .roll)', fab.lots[0].rolls[0].roll, 'L1-R1');
    eq('fabric roll1 mtr', fab.lots[0].rolls[0].mtr, 8);
    eq('fabric lot qtyIssued', fab.lots[0].qtyIssued, 12.5);
    eq('fabric pieces from raw', fab.piecesFromRaw, 18);
    ok('cloth has NO cutWidth', fab.cutWidth === undefined);
    ok('cloth has NO cutLength', fab.cutLength === undefined);
    var trim = d.cloth.filter(function (c) { return c.materialId === 'M2'; })[0];
    eq('trim owed 0', trim.owed, 0);
    eq('trim has no lots', trim.lots.length, 0);

    // cut list
    eq('cut list materials', d.cutList.length, 2);
    var m1 = d.cutList.filter(function (m) { return m.materialId === 'M1'; })[0];
    eq('M1 orders', m1.orders.length, 2);
    var o1 = m1.orders.filter(function (o) { return o.salesOrder === 'ORD-1001'; })[0];
    eq('O1 item count', o1.itemCount, 1);
    eq('O1 total pieces', o1.totalPieces, 12);
    eq('O1 total qty (cloth metres = Issued_Qty)', o1.totalQty, 7.5);
    eq('O1 item sku', o1.items[0].sku, 'NAP-6');
    eq('O1 item pieces', o1.items[0].pieces, 12);
    eq('O1 item lotRoll lot', o1.items[0].lotRolls[0].lot, 'L1');
    eq('O1 item lotRoll roll', o1.items[0].lotRolls[0].roll, 'L1-R1');

    var o2 = m1.orders.filter(function (o) { return o.salesOrder === 'ORD-1002'; })[0];
    eq('O2 item is remake', o2.items[0].isRemake, true);
    eq('O2 item remake reason', o2.items[0].remakeReason, 'Check_Reject');

    var m2 = d.cutList.filter(function (m) { return m.materialId === 'M2'; })[0];
    eq('M2 orders', m2.orders.length, 1);
    eq('M2 item qty', m2.orders[0].items[0].issuedQty, 4);

    // the M9 requirement must not have leaked in
    ok('M9 ignored', d.cutList.every(function (m) { return m.materialId !== 'M9'; }));
})();

// ---- over-received clamp: a line received MORE than issued must not offset
//      a genuinely pending line on the same handover ---------------------
(function () {
    console.log('assemble — over-received line does not offset a pending one');
    var raw = {
        issues: [{
            ID: '901', Voucher_No: 'SIV-00043', Issued_To: { ID: '10' },
            Issue_Status: 'Issued', Transfer_Status: 'Done',
            Issue_Lines: [
                { ID: 'A', Material: { ID: 'M1' }, Lot: { ID: 'LOT1' }, Qty: 10, Received_Qty: 13, Disputed_Qty: 0, Line_Status: 'Received', Unit: 'Mtr' },
                { ID: 'B', Material: { ID: 'M1' }, Lot: { ID: 'LOT2' }, Qty: 10, Received_Qty: 0, Disputed_Qty: 0, Line_Status: 'Issued', Unit: 'Mtr' }
            ]
        }],
        reqs: [], plans: [], salesOrders: [], planItems: [], itemMasters: [],
        rawMats: [{ ID: 'M1', Name: 'Linen', Unit: 'Mtr', Is_Fabric: true }],
        lots: [{ ID: 'LOT1', Lot_Number: 'L1' }, { ID: 'LOT2', Lot_Number: 'L2' }],
        emps: [{ ID: '10', Employee_Name: 'Ravi', Designation: 'Supervisor', Status: 'Active' }]
    };
    var d = HandoverDetail.assemble('901', raw);
    // Both lines are M1 -> one cloth entry, two lots. Line A owes max(0,10-13)=0
    // (clamped, not -3), line B owes 10 -> material owed 10, not 7.
    eq('over-received total owed (header)', d.header.owedQty, 10);
    var m1c = d.cloth.filter(function (c) { return c.materialId === 'M1'; })[0];
    eq('merged material owed', m1c.owed, 10);
    eq('merged material has 2 lots', m1c.lots.length, 2);
    eq('L1 qtyIssued', m1c.lots.filter(function (l) { return l.lot === 'L1'; })[0].qtyIssued, 10);
    eq('L2 qtyIssued', m1c.lots.filter(function (l) { return l.lot === 'L2'; })[0].qtyIssued, 10);
    eq('receipt status partial', d.header.receiptStatus, 'Partially received');
})();

// ---- multi-lot, multi-roll-each: one material off 2 lots, 2 rolls each ----
(function () {
    console.log('assemble — one material, 2 lots, 2 rolls each');
    var raw = {
        issues: [{
            ID: '903', Voucher_No: 'SIV-50', Issued_To: { ID: '10' }, Issue_Status: 'Issued',
            Issue_Lines: [
                { ID: 'A', Material: { ID: 'M1' }, Lot: { ID: 'LOT1' }, Qty: 30, Received_Qty: 0, Line_Status: 'Issued', Unit: 'Mtr', Roll_Label: 'R2 12m, R1 18m', Pieces_From_Raw: 40 },
                { ID: 'B', Material: { ID: 'M1' }, Lot: { ID: 'LOT2' }, Qty: 20, Received_Qty: 0, Line_Status: 'Issued', Unit: 'Mtr', Roll_Label: 'R3 8m, R4 12m', Pieces_From_Raw: 25 }
            ]
        }],
        reqs: [], plans: [], salesOrders: [], planItems: [], itemMasters: [],
        rawMats: [{ ID: 'M1', Name: 'Linen', Unit: 'Mtr', Is_Fabric: true }],
        lots: [{ ID: 'LOT1', Lot_Number: 'L1' }, { ID: 'LOT2', Lot_Number: 'L2' }],
        emps: [{ ID: '10', Employee_Name: 'Ravi', Designation: 'Supervisor', Status: 'Active' }]
    };
    var d = HandoverDetail.assemble('903', raw);
    eq('one cloth entry', d.cloth.length, 1);
    var c = d.cloth[0];
    eq('total issued', c.qtyIssued, 50);
    eq('total pieces', c.piecesFromRaw, 65);
    eq('2 lots', c.lots.length, 2);
    var l1 = c.lots.filter(function (l) { return l.lot === 'L1'; })[0];
    var l2 = c.lots.filter(function (l) { return l.lot === 'L2'; })[0];
    eq('L1 2 rolls', l1.rolls.length, 2);
    eq('L1 roll R2 mtr', l1.rolls.filter(function (r) { return r.roll === 'R2'; })[0].mtr, 12);
    eq('L1 roll R1 mtr', l1.rolls.filter(function (r) { return r.roll === 'R1'; })[0].mtr, 18);
    eq('L2 2 rolls', l2.rolls.length, 2);
    eq('L2 roll R3 mtr', l2.rolls.filter(function (r) { return r.roll === 'R3'; })[0].mtr, 8);
})();

// ---- legacy line (no Line_Status) reads Settled_Qty ------------------
(function () {
    console.log('assemble — legacy line dual-read');
    var raw = {
        issues: [{
            ID: '902', Voucher_No: 'SIV-9', Issued_To: { ID: '10' }, Issue_Status: 'Issued',
            Issue_Lines: [
                { ID: 'X', Material: { ID: 'M1' }, Lot: '', Qty: 5, Settled_Qty: 5, Unit: 'Cone' }
            ]
        }],
        reqs: [], plans: [], salesOrders: [], planItems: [], itemMasters: [],
        rawMats: [{ ID: 'M1', Name: 'Thread', Unit: 'Cone', Is_Fabric: false }],
        lots: [], emps: [{ ID: '10', Employee_Name: 'Ravi', Designation: 'Supervisor', Status: 'Active' }]
    };
    var d = HandoverDetail.assemble('902', raw);
    eq('legacy fully-settled owes 0', d.header.owedQty, 0);
    eq('legacy receipt status', d.header.receiptStatus, 'Received in full');
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
