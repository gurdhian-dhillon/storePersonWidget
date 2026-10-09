#!/usr/bin/env node
// raisePrintPO - one Zoho Inventory Purchase Order per print JOB ORDER (every
// Print_Job of one sendToPrint press, joined by Print_Batch) - ported to Node
// and run against a fake Inventory. The port mirrors deluge/raisePrintPO.dg
// block for block (same guard order, same skips, same stamps), so a failure
// here names a real Deluge line.
//
// What this pins: one PO per batch, one line per PRICED design (qty = pieces,
// rate = per piece), never a second PO for the same batch - not on a re-run,
// not after a crash between the POST and the stamp - and a failure that is
// left on the jobs for the card to show.
//
//   usage: node tools/print-po.test.js

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function ifnullStr(v, d) { return (v === null || v === undefined || v === '') ? d : String(v); }
function dec(v) { const n = parseFloat(ifnullStr(v, '0')); return isNaN(n) ? 0 : n; }
function str(v) { return v === null || v === undefined ? '' : String(v); }
function CrashError() { this.message = 'statement limit'; }

// ---- fake Inventory ----------------------------------------------------------
function mkInv() {
    return {
        items: [{ name: 'Printing Charges', item_id: 'SVC-PRINT' }],
        pos: [],                  // what landed
        down: false,              // every call fails
        checkDown: false,         // only the reference check fails
        crashAfterPost: false,    // POST lands, then the script dies (uncatchable)
        seq: 40,
        findItems(name) {
            if (this.down) return { code: 1, message: 'unreachable' };
            return { code: 0, items: this.items.filter(i => i.name.toLowerCase().indexOf(name.toLowerCase()) !== -1) };
        },
        findPos(ref) {
            if (this.down || this.checkDown) return { code: 1, message: 'unreachable' };
            return { code: 0, purchaseorders: this.pos.filter(p => p.reference_number === ref) };
        },
        post(body) {
            if (this.down) return { code: 1, message: 'unreachable' };
            this.seq += 1;
            const po = Object.assign({ purchaseorder_id: 'POID-' + this.seq,
                                       purchaseorder_number: 'PO-000' + this.seq }, body);
            this.pos.push(po);
            if (this.crashAfterPost) { this.crashAfterPost = false; throw new CrashError(); }
            return { code: 0, purchaseorder: po };
        }
    };
}

// ---- the world ---------------------------------------------------------------
function mkWorld() {
    return {
        inv: mkInv(),
        mats: {
            '1': { SKU: 'RM-045', Material_Display_Name: 'Natural Linen', Fabric_Width_Inches: '116' },
            '3': { SKU: 'RM-113', Material_Display_Name: 'Natural Linen / Red Checks', Fabric_Width_Inches: '116' },
            '4': { SKU: 'RM-114', Material_Display_Name: 'Natural Linen / Red Floral', Fabric_Width_Inches: '116' }
        },
        lots: { '10': { Lot_Number: 'L2' } },
        printers: {
            '78': { Party_Name: 'Sanwariya Prints', Inventory_Contact_ID: 'C-SANW' },
            '79': { Party_Name: 'Unmapped Prints', Inventory_Contact_ID: '' }
        },
        jobs: []
    };
}
// The job order in the photo: checks + floral, 5 x 5.50 m each, 175 a piece.
function jobOrder(W, over) {
    over = over || {};
    const base = { Print_Batch: 'PJ-00012', Printer: '78', Source_Material: '1', Source_Lot: '10',
                   Job_Status: 'At_Printer', PO_Number: '', PO_ID: '', PO_Last_Error: '' };
    W.jobs.push(Object.assign({}, base, { ID: '1', Job_No: 'PJ-00012', Printed_Material: '3',
        Source_State: 'Wash', Send_Lines: [{ Piece_Length_Cm: 550, Piece_Count: 5, Rate: 175 }] }, over.a || {}));
    W.jobs.push(Object.assign({}, base, { ID: '2', Job_No: 'PJ-00013', Printed_Material: '4',
        Source_State: 'Wash', Send_Lines: [{ Piece_Length_Cm: 550, Piece_Count: 5, Rate: 175 }] }, over.b || {}));
}

// ===========================================================================
// raisePrintPO  — deluge/raisePrintPO.dg
// ===========================================================================
function raisePrintPO(W, batchNo, dryRun) {
    let err = '', poNumber = '', poId = '', already = false, notPriced = false, lineCount = 0;
    const isDry = ['true', 'yes', '1'].indexOf(str(dryRun).trim().toLowerCase()) !== -1;
    const bn = str(batchNo).trim();
    let posted = null;

    try {
        if (bn === '') err = 'No print batch given';

        let jobCount = 0, printerTxt = '', printerMixed = false;
        const lines = [];
        if (!err) {
            const batch = W.jobs.filter(j => j.Print_Batch === bn).sort((a, b) => Number(a.ID) - Number(b.ID));
            for (const pj of batch) {
                jobCount++;
                const pTxt = str(pj.Printer).trim();
                if (printerTxt === '') printerTxt = pTxt;
                else if (pTxt !== '' && pTxt !== printerTxt) printerMixed = true;
                if (str(pj.PO_Number).trim() !== '') { poNumber = str(pj.PO_Number).trim(); already = true; }

                if (str(pj.Job_Status).trim() !== 'Cancelled') {
                    const pr = W.mats[str(pj.Printed_Material)] || {};
                    const sm = W.mats[str(pj.Source_Material)] || {};
                    const lt = W.lots[str(pj.Source_Lot)] || {};
                    let name = str(pr.Material_Display_Name) || str(pr.SKU);
                    if (name.length > 100) name = name.substring(0, 100);
                    const st = str(pj.Source_State).trim();
                    // ONE PO LINE PER PRICED ROW - the rate is per piece and per size.
                    (pj.Send_Lines || []).forEach(sl => {
                        const c = Math.trunc(dec(sl.Piece_Count)), rate = dec(sl.Rate);
                        if (!(c > 0 && rate > 0)) return;
                        let desc = str(pr.SKU) + ' | ' + Math.round(dec(sl.Piece_Length_Cm)) / 100 + ' m';
                        if (str(pr.Fabric_Width_Inches)) desc += ' x ' + pr.Fabric_Width_Inches + ' in';
                        desc += ' | base ' + str(sm.SKU);
                        if (str(lt.Lot_Number)) desc += ' lot ' + lt.Lot_Number;
                        if (st === 'Unwash') desc += ' (unwashed)'; else if (st === 'Wash') desc += ' (washed)';
                        desc += ' | ' + str(pj.Job_No);
                        lines.push({ item_id: '__ITEM__', name, description: desc, quantity: c, rate });
                        lineCount++;
                    });
                }
            }
            if (jobCount === 0) err = 'No print jobs carry batch ' + bn;
            else if (printerMixed) err = 'Batch ' + bn + ' names two different printers';
        }

        if (!err && !already && lineCount === 0) notPriced = true;
        const goOn = !err && !already && !notPriced;

        let vendor = '';
        if (goOn) {
            const tp = W.printers[printerTxt];
            vendor = tp ? str(tp.Inventory_Contact_ID).trim() : '';
            if (vendor === '') err = (tp ? tp.Party_Name : '') + ' has no Inventory contact id - run syncThirdParties';
        }

        let itemId = '';
        if (!err && goOn) {
            const r = W.inv.findItems('Printing Charges');
            if (r.code === 0) {
                const hit = r.items.find(i => i.name.toLowerCase() === 'printing charges');
                if (hit) itemId = hit.item_id;
            }
            if (itemId === '') err = "Service item 'Printing Charges' not found in Inventory - create it first";
        }

        if (!err && goOn) {
            const r = W.inv.findPos(bn);
            if (r.code !== 0) err = 'Could not check Inventory for an existing PO on ' + bn + ' - nothing posted';
            else {
                const hit = r.purchaseorders.find(p => str(p.reference_number).toLowerCase() === bn.toLowerCase());
                if (hit) { poNumber = hit.purchaseorder_number; poId = hit.purchaseorder_id; already = true; }
            }
        }

        if (!err && goOn && !already) {
            const body = { vendor_id: vendor, reference_number: bn,
                           line_items: lines.map(l => Object.assign({}, l, { item_id: itemId })) };
            if (!isDry) {
                const r = W.inv.post(body);
                if (r.code !== 0) err = 'Inventory refused the PO: ' + r.message;
                else { poNumber = r.purchaseorder.purchaseorder_number; poId = r.purchaseorder.purchaseorder_id; posted = body; }
            } else {
                posted = body;   // logged, not sent
            }
        }

        if (!err && !isDry && poNumber !== '') {
            W.jobs.filter(j => j.Print_Batch === bn).forEach(j => {
                j.PO_Number = poNumber; if (poId) j.PO_ID = poId; j.PO_Last_Error = '';
            });
        }
    } catch (e) {
        if (e instanceof CrashError) throw e;   // uncatchable in Deluge too
        err = 'DELUGE: ' + e.message;
    }

    if (err) {
        if (bn !== '' && !isDry) W.jobs.filter(j => j.Print_Batch === bn).forEach(j => { j.PO_Last_Error = err; });
        return { success: false, error: err };
    }
    return { success: true, poNumber, poId, lines: lineCount, already, notPriced, dryRun: isDry, body: posted };
}

// ===========================================================================
console.log('\nraisePrintPO');

test('R1 one PO for the job order: one line per priced row, qty = pieces, rate = per piece', () => {
    const W = mkWorld(); jobOrder(W);
    const r = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(r.success, r.error);
    assert.strictEqual(W.inv.pos.length, 1);
    const po = W.inv.pos[0];
    assert.strictEqual(po.vendor_id, 'C-SANW');
    assert.strictEqual(po.reference_number, 'PJ-00012');
    assert.deepStrictEqual(po.line_items.map(l => [l.item_id, l.quantity, l.rate]),
        [['SVC-PRINT', 5, 175], ['SVC-PRINT', 5, 175]]);
    // 10 pieces x 175 = 1750 - per PIECE, not per metre (that would be 9625)
    assert.strictEqual(po.line_items.reduce((a, l) => a + l.quantity * l.rate, 0), 1750);
});

test('R2 the line says what the money was for: design, size L x W, base, lot, state, job', () => {
    const W = mkWorld(); jobOrder(W);
    raisePrintPO(W, 'PJ-00012', 'false');
    const l = W.inv.pos[0].line_items[0];
    assert.strictEqual(l.name, 'Natural Linen / Red Checks');
    assert.strictEqual(l.description, 'RM-113 | 5.5 m x 116 in | base RM-045 lot L2 (washed) | PJ-00012');
});

test('R2b two sizes of one design at two rates are TWO PO lines', () => {
    const W = mkWorld();
    jobOrder(W, { a: { Send_Lines: [ { Piece_Length_Cm: 550, Piece_Count: 5, Rate: 175 },
                                     { Piece_Length_Cm: 275, Piece_Count: 4, Rate: 90 } ] } });
    raisePrintPO(W, 'PJ-00012', 'false');
    assert.deepStrictEqual(W.inv.pos[0].line_items.map(l => [l.quantity, l.rate]), [[5, 175], [4, 90], [5, 175]]);
    assert.ok(/2\.75 m x 116 in/.test(W.inv.pos[0].line_items[1].description));
});

test('R2c a job order with two BASES names each base on its own line', () => {
    const W = mkWorld();
    W.mats['2'] = { SKU: 'RM-046', Material_Display_Name: 'White Cotton', Fabric_Width_Inches: '58' };
    W.mats['7'] = { SKU: 'RM-120', Material_Display_Name: 'White Cotton / Blue Stripes', Fabric_Width_Inches: '58' };
    W.lots['21'] = { Lot_Number: 'W1' };
    jobOrder(W, { b: { Source_Material: '2', Source_Lot: '21', Source_State: 'Unwash', Printed_Material: '7',
                       Send_Lines: [ { Piece_Length_Cm: 275, Piece_Count: 8, Rate: 90 } ] } });
    raisePrintPO(W, 'PJ-00012', 'false');
    assert.strictEqual(W.inv.pos.length, 1, 'still ONE PO');
    assert.strictEqual(W.inv.pos[0].line_items[1].description, 'RM-120 | 2.75 m x 58 in | base RM-046 lot W1 (unwashed) | PJ-00013');
});

test('R3 the PO number is stamped on EVERY job of the batch, any earlier error cleared', () => {
    const W = mkWorld(); jobOrder(W, { a: { PO_Last_Error: 'old failure' } });
    const r = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(W.jobs.every(j => j.PO_Number === r.poNumber && j.PO_ID === r.poId && j.PO_Last_Error === ''));
});

test('R4 an unpriced row is left off the PO', () => {
    const W = mkWorld(); jobOrder(W, { b: { Send_Lines: [{ Piece_Length_Cm: 550, Piece_Count: 5, Rate: '' }] } });
    raisePrintPO(W, 'PJ-00012', 'false');
    assert.strictEqual(W.inv.pos[0].line_items.length, 1);
    assert.ok(/RM-113/.test(W.inv.pos[0].line_items[0].description));
});

test('R5 nothing priced -> success, notPriced, no PO, no error on the jobs', () => {
    const W = mkWorld(); jobOrder(W, { a: { Send_Lines: [{ Piece_Length_Cm: 550, Piece_Count: 5, Rate: 0 }] },
                         b: { Send_Lines: [{ Piece_Length_Cm: 550, Piece_Count: 5, Rate: '' }] } });
    const r = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(r.success && r.notPriced);
    assert.strictEqual(W.inv.pos.length, 0);
    assert.ok(W.jobs.every(j => j.PO_Last_Error === '' && j.PO_Number === ''));
});

test('R6 a cancelled job is not billed', () => {
    const W = mkWorld(); jobOrder(W, { b: { Job_Status: 'Cancelled' } });
    raisePrintPO(W, 'PJ-00012', 'false');
    assert.strictEqual(W.inv.pos[0].line_items.length, 1);
});

test('R7 run twice -> the second returns the same number and raises nothing', () => {
    const W = mkWorld(); jobOrder(W);
    const a = raisePrintPO(W, 'PJ-00012', 'false');
    const b = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(b.success && b.already);
    assert.strictEqual(b.poNumber, a.poNumber);
    assert.strictEqual(W.inv.pos.length, 1);
});

test('R8 a crash after the POST, before the stamp -> the re-run ADOPTS it, no duplicate', () => {
    const W = mkWorld(); jobOrder(W);
    W.inv.crashAfterPost = true;
    assert.throws(() => raisePrintPO(W, 'PJ-00012', 'false'));
    assert.ok(W.jobs.every(j => j.PO_Number === ''), 'never stamped');
    const r = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(r.success && r.already, JSON.stringify(r));
    assert.strictEqual(W.inv.pos.length, 1, 'still one PO');
    assert.ok(W.jobs.every(j => j.PO_Number === W.inv.pos[0].purchaseorder_number));
});

test('R9 if the existing-PO check fails, nothing is posted and the reason is left on the jobs', () => {
    const W = mkWorld(); jobOrder(W);
    W.inv.checkDown = true;
    const r = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(!r.success);
    assert.strictEqual(W.inv.pos.length, 0);
    assert.ok(W.jobs.every(j => /Could not check Inventory/.test(j.PO_Last_Error)));
});

test('R10 a printer with no Inventory contact -> refused, reason on the jobs', () => {
    const W = mkWorld(); jobOrder(W, { a: { Printer: '79' }, b: { Printer: '79' } });
    const r = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(!r.success);
    assert.ok(/Unmapped Prints has no Inventory contact id/.test(r.error), r.error);
    assert.ok(W.jobs.every(j => j.PO_Last_Error === r.error));
});

test('R11 the service item missing -> refused, says to create it', () => {
    const W = mkWorld(); jobOrder(W);
    W.inv.items = [{ name: 'Job Work Charges', item_id: 'SVC-JW' }];
    const r = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(!r.success);
    assert.ok(/'Printing Charges' not found/.test(r.error), r.error);
});

test('R12 dry run builds the body and posts and stamps nothing', () => {
    const W = mkWorld(); jobOrder(W);
    const r = raisePrintPO(W, 'PJ-00012', 'true');
    assert.ok(r.success && r.dryRun);
    assert.strictEqual(r.body.line_items.length, 2);
    assert.strictEqual(W.inv.pos.length, 0);
    assert.ok(W.jobs.every(j => j.PO_Number === ''));
});

test('R13 a batch spanning two printers is refused', () => {
    const W = mkWorld(); jobOrder(W, { b: { Printer: '79' } });
    const r = raisePrintPO(W, 'PJ-00012', 'false');
    assert.ok(!r.success && /two different printers/.test(r.error), r.error);
});

test('R14 an unknown batch is refused', () => {
    const W = mkWorld(); jobOrder(W);
    const r = raisePrintPO(W, 'PJ-99999', 'false');
    assert.ok(!r.success && /No print jobs carry batch PJ-99999/.test(r.error), r.error);
});

// ---- the .dg files say what the port says ----------------------------------
console.log('\nthe .dg files');
const dg = f => fs.readFileSync(path.join(__dirname, '..', 'deluge', f), 'utf8');

test('raisePrintPO.dg: service item by name, the reference check BEFORE the post, hand-built body', () => {
    const s = dg('raisePrintPO.dg');
    assert.ok(s.includes('chargeItemName = "Printing Charges"'));
    const check = s.indexOf('purchaseorders?reference_number=');
    const post = s.indexOf('type :POST');
    assert.ok(check > 0 && post > check, 'existing-PO check precedes the POST');
    assert.ok(s.includes('parameters:bodyJson'), 'body is hand-built JSON');
    assert.ok(!/parameters:\s*\w+\.toString\(\)/.test(s), 'no Map.toString() body');
    assert.ok(s.includes('hdrMap.put("content-type","application/json")'));
    assert.ok(/pjS\.PO_Number = poNumber/.test(s) && /pjE\.PO_Last_Error = errTxt/.test(s));
    assert.ok(s.includes('Print_Job[Print_Batch == bn] sort by ID asc;'), 'sort by on its own assignment');
});

test('sendToPrint.dg: rows in, every job stamped with Print_Batch, each Send_Line with its Rate; PO in its own try, after the jobs', () => {
    const s = dg('sendToPrint.dg');
    assert.ok(s.includes('Print_Batch=batchNo') && s.includes('sRow.Rate=sRateS.toDecimal()') && !s.includes('Rate_Per_Piece'));
    const call = s.indexOf('thisapp.raisePrintPO(batchNo,"false")');
    assert.ok(call > 0);
    assert.ok(call > s.indexOf('newJobIds.add('), 'after the jobs exist');
    assert.ok(s.lastIndexOf('try', call) > s.indexOf('THE PURCHASE ORDER'), 'inside its own try');
    assert.ok(s.includes('"poError'), 'reports the PO outcome');
    assert.ok(s.includes('inp.get("lines")') && !s.includes('inp.get("designs")') && !s.includes('inp.get("targetMaterialId")'));
});

console.log('\nprint-po: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
