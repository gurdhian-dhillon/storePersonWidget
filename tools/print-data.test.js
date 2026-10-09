#!/usr/bin/env node
// app/js/print-data.js — the Print tab's read side, assembled from stub
// getRecords rows. PrintData._assemble is pure, so it is tested directly with
// hand-built report rows shaped like Creator's field_config:'all' output.
//
//   usage: node tools/print-data.test.js

'use strict';
const assert = require('assert');
const PrintData = require('../app/js/print-data.js');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; failures.push(name + ' — ' + e.message); }
}

// ---- fixtures -------------------------------------------------------------
// Two plain fabrics (one with lots+rolls, one with none), one printed fabric
// at the same width as the first plain, one printed at a different width.
const rawMats = [
    { ID: '1', Name: 'Grey Sheeting', Material_Display_Name: 'Grey Sheeting / Plain / Grey',
      SKU: 'RM-001', Is_Fabric: 'true', Type_field: 'Plain Fabric', Fabric_Width_Inches: '60' },
    { ID: '2', Name: 'Blue Linen', Material_Display_Name: 'Blue Linen / Plain / Blue',
      SKU: 'RM-002', Is_Fabric: 'true', Type_field: 'plain fabric', Fabric_Width_Inches: '44' },
    { ID: '3', Name: 'Grey Sheeting Block Print', Material_Display_Name: 'Grey Sheeting / Plain / Grey / BP',
      SKU: 'RM-100', Is_Fabric: 'true', Type_field: 'Printed Fabric', Fabric_Width_Inches: '60' },
    { ID: '4', Name: 'Wide Printed', Material_Display_Name: 'Wide Printed',
      SKU: 'RM-101', Is_Fabric: 'true', Type_field: 'printed fabric', Fabric_Width_Inches: '90' },
    { ID: '5', Name: 'Some Thread', Material_Display_Name: 'Some Thread',
      SKU: 'RM-200', Is_Fabric: 'false', Type_field: '', Fabric_Width_Inches: '' }
];

const lots = [
    { ID: '10', Material: { ID: '1' }, Lot_Number: 'L1', Wash_Quantity: '40.5',
      Unwash_Quantity: '10', In_Print_Qty: '5', Status: 'Active',
      Lot_Rolls: [
          { ID: '101', Roll_Label: 'L1-R1', Roll_Length: '8', Roll_Status: 'Available', Origin: 'Purchased' },
          { ID: '102', Roll_Label: 'L1-R2', Roll_Length: '42.5', Roll_Status: 'Available', Origin: 'Purchased' },
          { ID: '103', Roll_Label: 'L1-R3', Roll_Length: '0', Roll_Status: 'Consumed', Origin: 'Purchased' }
      ] },
    { ID: '11', Material: { ID: '3' }, Lot_Number: 'P1', Wash_Quantity: '12',
      Unwash_Quantity: '0', In_Print_Qty: '0', Status: 'Active',
      Lot_Rolls: [
          { ID: '111', Roll_Label: 'P1-P1', Roll_Length: '3', Roll_Status: 'Available', Origin: 'Printed' }
      ] },
    // a lot with no Material — must be skipped without throwing
    { ID: '12', Material: null, Lot_Number: 'orphan', Wash_Quantity: '99' }
];

const printers = [
    { ID: '77', Party_Name: 'Zed Prints' },
    { ID: '78', Party_Name: 'Ace Printing' }
];

const jobs = [
    { ID: '900', Job_Status: 'At_Printer', Source_Material: { ID: '1' }, Source_Lot: { ID: '10' },
      Printed_Material: { ID: '3' }, Printer: { ID: '77' }, Source_State: 'Wash',
      Metres_Sent: '18', Sent_On: '2026-09-01',
      Send_Lines: [
          { Piece_Length_Cm: '300', Piece_Count: '4' },
          { Piece_Length_Cm: '300', Piece_Count: '2' }
      ] },
    { ID: '901', Job_Status: 'Received', Source_Material: { ID: '1' }, Metres_Sent: '5' },
    { ID: '902', Job_Status: 'Cancelled', Source_Material: { ID: '2' }, Metres_Sent: '2' }
];

const D = PrintData._assemble(rawMats, lots, printers, jobs);

// ---- source list --------------------------------------------------------
test('source = fabrics with >= 1 lot, non-fabric excluded', () => {
    const ids = D.source.map(m => m.id).sort();
    assert.deepStrictEqual(ids, ['1', '3']);   // 2 has no lot, 4 has no lot, 5 is not fabric
});

test('source carries width in cm and raw type', () => {
    const m = D.source.find(x => x.id === '1');
    assert.strictEqual(m.widthCm, 152.4);      // 60 * 2.54
    assert.strictEqual(m.type, 'Plain Fabric');
});

test('source lot carries wash/unwash/inPrint and rolls', () => {
    const m = D.source.find(x => x.id === '1');
    assert.strictEqual(m.lots.length, 1);
    const l = m.lots[0];
    assert.strictEqual(l.lotNumber, 'L1');
    assert.strictEqual(l.wash, 40.5);
    assert.strictEqual(l.unwash, 10);
    assert.strictEqual(l.inPrint, 5);
    assert.strictEqual(l.blocked, false);
    assert.strictEqual(l.rolls.length, 3);     // ALL rolls returned, incl. consumed
});

test('orphan lot (no Material) is skipped, not thrown', () => {
    assert.ok(D.source.every(m => m.lots.every(l => l.lotNumber !== 'orphan')));
});

// ---- target list -------------------------------------------------------
test('target = printed fabric by Type_field, case-insensitive', () => {
    const ids = D.target.map(m => m.id).sort();
    assert.deepStrictEqual(ids, ['3', '4']);   // both "printed fabric" / "Printed Fabric"
});

test('target includes a printed SKU with no stock yet', () => {
    const m = D.target.find(x => x.id === '4');
    assert.ok(m, 'RM-101 present despite no lots');
    assert.deepStrictEqual(m.lots, []);
});

test('a printed fabric that has stock is in BOTH lists', () => {
    assert.ok(D.source.some(m => m.id === '3'));
    assert.ok(D.target.some(m => m.id === '3'));
});

// ---- printers ---------------------------------------------------------
test('printers sorted by name', () => {
    assert.deepStrictEqual(D.printers.map(p => p.name), ['Ace Printing', 'Zed Prints']);
});

// ---- jobs -----------------------------------------------------------
// EVERY job now, newest first — the screen groups them into job orders and
// filters open / recent itself.
test('jobs = every job, whatever its status, newest first', () => {
    assert.deepStrictEqual(D.jobs.map(j => [j.jobId, j.jobStatus]),
        [['902', 'Cancelled'], ['901', 'Received'], ['900', 'At_Printer']]);
});

test('job resolves source/printed/printer names through the maps', () => {
    const j = D.jobs.find(x => x.jobId === '900');
    assert.strictEqual(j.sourceName, 'Grey Sheeting / Plain / Grey');
    assert.strictEqual(j.sourceLotNumber, 'L1');
    assert.strictEqual(j.printedName, 'Grey Sheeting / Plain / Grey / BP');
    assert.strictEqual(j.printerName, 'Zed Prints');
    assert.strictEqual(j.sourceState, 'Wash');
    assert.strictEqual(j.metresSent, 18);
});

test('job send lines carry lineIndex, length, count and rate (0 when never priced)', () => {
    const sl = D.jobs.find(x => x.jobId === '900').sendLines;
    assert.deepStrictEqual(sl, [ { lineIndex: 0, lengthCm: 300, count: 4, rate: 0 },
                                 { lineIndex: 1, lengthCm: 300, count: 2, rate: 0 } ]);
});

test('Sent_On is read in either Creator format; anything else is null', () => {
    assert.strictEqual(PrintData._parseDate('04-Aug-2026'), Date.UTC(2026, 7, 4));
    assert.strictEqual(PrintData._parseDate('2026-08-04'), Date.UTC(2026, 7, 4));
    assert.strictEqual(PrintData._parseDate('08/04/2026'), null);
    assert.strictEqual(PrintData._parseDate(''), null);
});

// ---- price history ----------------------------------------------------
// One row per PRICED SEND LINE — the rate is per piece and per size. Ids are
// 18 digits in Creator — past Number precision — and the history is newest
// first by id, compared as text. The jobs below are given out of order on
// purpose, and one id is a digit shorter (older).
const pricedJobs = [
    { ID: '3955559000000400010', Job_Status: 'Received', Job_No: 'PJ-00010',
      Printed_Material: { ID: '3' }, Printer: { ID: '77' }, Sent_On: '01-Aug-2026', PO_Number: 'PO-00040',
      Metres_Returned: '8.25', Returned_On: '20-Aug-2026',
      Send_Lines: [ { Piece_Length_Cm: '275', Piece_Count: '4', Rate: '150' } ],
      Receive_Lines: [ { Piece_Length_Cm: '275', Piece_Count: '3' } ] },
    { ID: '3955559000000400012', Job_Status: 'At_Printer', Job_No: 'PJ-00012',
      Printed_Material: { ID: '3' }, Printer: { ID: '78' }, Sent_On: '04-Aug-2026', PO_Number: 'PO-00042',
      Print_Batch: 'PJ-00012', Source_Material: { ID: '1' },
      Send_Lines: [ { Piece_Length_Cm: '550', Piece_Count: '5', Rate: '175' },
                    { Piece_Length_Cm: '275', Piece_Count: '2', Rate: '' } ] },
    { ID: '395555900000040001', Job_Status: 'Received', Job_No: 'PJ-00001',
      Printed_Material: { ID: '4' }, Printer: { ID: '78' }, Sent_On: '01-Jan-2026',
      Send_Lines: [ { Piece_Length_Cm: '300', Piece_Count: '2', Rate: '120' } ] },
    { ID: '3955559000000400013', Job_Status: 'Cancelled', Job_No: 'PJ-00013',
      Printed_Material: { ID: '3' }, Printer: { ID: '78' },
      Send_Lines: [ { Piece_Length_Cm: '550', Piece_Count: '1', Rate: '999' } ] }
];
const P = PrintData._assemble(rawMats, lots, printers, pricedJobs);

test('rateHistory = priced send lines of non-cancelled jobs, NEWEST first by 18-digit id', () => {
    assert.deepStrictEqual(P.rateHistory.map(h => [h.jobNo, h.lengthCm, h.rate]),
        [['PJ-00012', 550, 175], ['PJ-00010', 275, 150], ['PJ-00001', 300, 120]]);
});

test('rateHistory rows name printer, design, length and PO, with the rate as a number', () => {
    assert.deepStrictEqual(P.rateHistory[0], {
        printerId: '78', printerName: 'Ace Printing', printedMaterialId: '3', printedSku: 'RM-100',
        printedName: 'Grey Sheeting / Plain / Grey / BP', lengthCm: 550, rate: 175,
        sentOn: '04-Aug-2026', jobNo: 'PJ-00012', poNumber: 'PO-00042'
    });
});

test('a cancelled job\'s rate and a blank row rate are not price history', () => {
    assert.ok(!P.rateHistory.some(h => h.jobNo === 'PJ-00013'));
    assert.ok(!P.rateHistory.some(h => h.jobNo === 'PJ-00012' && h.lengthCm === 275));
});

test('a job carries batch, PO, printer id and what came back', () => {
    const j = P.jobs.find(x => x.jobNo === 'PJ-00012');
    assert.strictEqual(j.printBatch, 'PJ-00012');
    assert.strictEqual(j.poNumber, 'PO-00042');
    assert.strictEqual(j.poError, '');
    assert.strictEqual(j.printerId, '78');
    assert.strictEqual(j.sentOnTs, Date.UTC(2026, 7, 4));
    const r = P.jobs.find(x => x.jobNo === 'PJ-00010');
    assert.strictEqual(r.piecesReturned, 3);
    assert.strictEqual(r.metresReturned, 8.25);
    assert.strictEqual(r.returnedOn, '20-Aug-2026');
});

// ---- empty inputs -----------------------------------------------------
test('all-empty inputs assemble to empty lists', () => {
    const E = PrintData._assemble([], [], [], []);
    assert.deepStrictEqual(E, { source: [], target: [], printers: [], jobs: [], rateHistory: [] });
});

// ---- report ---------------------------------------------------------
console.log(`\nprint-data: ${passed} passed, ${failed} failed`);
if (failed) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
