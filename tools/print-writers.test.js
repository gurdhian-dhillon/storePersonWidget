#!/usr/bin/env node
// The three functions that convert plain cloth to printed, ported to Node and
// run as a lifecycle. Printing v2 — rolls, no minting, no Fabric_Piece.
//
//   sendToPrint       deluge/sendToPrint.dg
//   receiveFromPrint  deluge/receiveFromPrint.dg
//   cancelPrintJob    deluge/cancelPrintJob.dg
//
// The ports mirror the .dg files block for block - same guard ORDER, same caps,
// same clamps, same roll maths - so a failure here names a real Deluge line.
// Where a port reproduces a Deluge quirk (EMPTY is not null, integer division
// truncates) the helper is named for it.
//
//   usage: node tools/print-writers.test.js

'use strict';
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; failures.push(name + ' — ' + e.message); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ---- Deluge semantics --------------------------------------------------------
function ifnullStr(v, d) { return (v === null || v === undefined || v === '') ? d : String(v); }
function dec(v) { const n = parseFloat(ifnullStr(v, '0')); return isNaN(n) ? 0 : n; }
function isNum(s) { return /^-?\d+(\.\d+)?$/.test(String(s)); }
function r2(n) { return Math.round(n * 100) / 100; }

// ---- the world -------------------------------------------------------------
function mkWorld() { return { mats: [], lots: [], rolls: [], printers: [], jobs: [], seq: 100 }; }
function nid(W) { W.seq += 1; return String(W.seq); }
function byId(rows, id) { return rows.filter(r => String(r.ID) === String(id)); }

function addMat(W, o) {
    const m = Object.assign({
        ID: nid(W), SKU: 'RM-x', Name: 'x', Material_Display_Name: '', Is_Fabric: 'true',
        Type_field: 'Plain Fabric', Fabric_Width_Inches: '60',
        Wash_Quantity: 0, Unwash_Quantity: 0, In_Print_Qty: 0, Unallocated_Qty: 0, Quantity: 0
    }, o);
    W.mats.push(m); return m;
}
function addLot(W, o) {
    const l = Object.assign({
        ID: nid(W), Material: '', Lot_Number: 'L1', Status: 'Active',
        Wash_Quantity: 0, Unwash_Quantity: 0, In_Wash_Qty: 0, In_Print_Qty: 0,
        In_Transit_Qty: 0, Disputed_Qty: 0
    }, o);
    W.lots.push(l); return l;
}
function addRoll(W, lotId, label, len, status) {
    const r = { ID: nid(W), Lot: String(lotId), Roll_Label: label, Roll_Length: len,
                Roll_Status: status || 'Available', Origin: 'Purchased', Source_Receipt: 'SEED' };
    W.rolls.push(r); return r;
}
function addPrinter(W, name) { const p = { ID: nid(W), Party_Name: name }; W.printers.push(p); return p; }
function lotRolls(W, lotId) { return W.rolls.filter(r => String(r.Lot) === String(lotId)); }
function rollSum(W, lotId) {
    return r2(lotRolls(W, lotId)
        .filter(r => r.Roll_Status !== 'Consumed' && r.Roll_Status !== 'Blocked')
        .reduce((a, r) => a + dec(r.Roll_Length), 0));
}
function shelf(l) { return r2(dec(l.Wash_Quantity) + dec(l.Unwash_Quantity) + dec(l.In_Wash_Qty)); }

// ===========================================================================
// sendToPrint  — deluge/sendToPrint.dg
// ===========================================================================
function sendToPrint(W, p) {
    let err = '';
    const srcMatId = ifnullStr(p.sourceMaterialId, '').trim();
    const srcLotId = ifnullStr(p.sourceLotId, '').trim();
    const tgtMatId = ifnullStr(p.targetMaterialId, '').trim();
    const printerId = ifnullStr(p.printerId, '').trim();
    const srcState = ifnullStr(p.sourceState, '').trim();
    const linesRaw = p.lines || [];
    const rollPlanRaw = p.rollPlan || [];

    if (srcMatId === '' || !isNum(srcMatId)) err = 'No source material given';
    if (!err && (srcLotId === '' || !isNum(srcLotId))) err = 'No source lot given';
    if (!err && (tgtMatId === '' || !isNum(tgtMatId))) err = 'No target printed material chosen';
    if (!err && srcState !== 'Wash' && srcState !== 'Unwash') err = 'Source state must be Wash or Unwash';
    if (!err && (printerId === '' || !isNum(printerId))) err = 'No printer given';
    if (!err && linesRaw.length === 0) err = 'Nothing to send';
    if (!err && srcMatId === tgtMatId) err = 'Source and target are the same material';

    let srcWidth = '', srcRec = null;
    if (!err) {
        const rs = byId(W.mats, srcMatId);
        if (!rs.length) err = 'Source material not found';
        else { srcRec = rs[0]; srcWidth = str(srcRec.Fabric_Width_Inches).trim();
               if (str(srcRec.Is_Fabric).toLowerCase() !== 'true') err = 'not a fabric'; }
    }

    let tgtWidth = '';
    if (!err) {
        const rs = byId(W.mats, tgtMatId);
        if (!rs.length) err = 'Target printed material not found';
        else {
            const t = rs[0];
            if (str(t.Is_Fabric).toLowerCase() !== 'true') err = t.SKU + ' is not a fabric';
            // "printed fabric" Type check is OFF for now — width only.
            else {
                tgtWidth = str(t.Fabric_Width_Inches).trim();
                const sw = srcWidth === '' ? 0 : parseFloat(srcWidth);
                const tw = tgtWidth === '' ? 0 : parseFloat(tgtWidth);
                if (sw <= 0 || tw <= 0) err = 'no fabric width on record';
                else if (Math.abs(sw - tw) > 0.01) err = 'Width mismatch';
            }
        }
    }
    if (!err && !byId(W.printers, printerId).length) err = 'Printer not found';

    let lot = null, lotWash = 0, lotUnwash = 0, lotInPrint = 0, lotNum = '';
    if (!err) {
        const ls = byId(W.lots, srcLotId);
        if (!ls.length) err = 'Source lot not found';
        else {
            lot = ls[0];
            if (String(lot.Material) !== srcMatId) err = 'That lot belongs to a different material';
            else if (str(lot.Status) === 'Blocked') err = 'That lot is blocked';
            else {
                lotNum = str(lot.Lot_Number);
                lotWash = dec(lot.Wash_Quantity); lotUnwash = dec(lot.Unwash_Quantity);
                lotInPrint = dec(lot.In_Print_Qty);
            }
        }
    }
    if (!err && lot && lotRolls(W, lot.ID).length === 0)
        err = 'Lot ' + lotNum + ' has no rolls recorded';

    let totalCm = 0, pieces = 0;
    if (!err) {
        for (const ln of linesRaw) {
            const len = dec(ln.lengthCm), cd = dec(ln.count), c = Math.trunc(cd);
            if (len <= 0) { err = 'needs a piece length'; break; }
            if (cd <= 0) { err = 'count above zero'; break; }
            if (c !== cd) { err = 'whole number'; break; }
            totalCm += len * c; pieces += c;
        }
    }
    let metresSent = 0;
    if (!err) { metresSent = totalCm / 100; if (metresSent <= 0) err = 'adds up to zero'; }

    if (!err) {
        const have = srcState === 'Wash' ? lotWash : lotUnwash;
        if (metresSent > have) err = 'Lot ' + lotNum + ' has only ' + have + ' Mtr ' + srcState;
    }

    // ---- roll plan --------------------------------------------------------
    const avail = !err ? lotRolls(W, lot.ID)
        .filter(r => r.Roll_Status === 'Available' && dec(r.Roll_Length) > 0)
        .map(r => ({ id: String(r.ID), label: str(r.Roll_Label), len: dec(r.Roll_Length) })) : [];
    if (!err && avail.length === 0) err = 'no cuttable rolls';

    let plan = [];  // {id,label,metres}
    if (!err && rollPlanRaw.length > 0) {
        let sum = 0; const seen = [];
        for (const rp of rollPlanRaw) {
            const rid = ifnullStr(rp.rollId, '').trim(), m = dec(rp.metres);
            if (rid === '' || !isNum(rid)) { err = 'roll in the plan has no id'; break; }
            if (m <= 0) { err = 'metres above zero'; break; }
            if (seen.indexOf(rid) !== -1) { err = 'names one roll twice'; break; }
            seen.push(rid);
            const hit = avail.find(a => a.id === rid);
            if (!hit) { err = 'Roll ' + rid + ' is not a cuttable roll'; break; }
            if (m > hit.len) { err = 'Roll ' + hit.label + ' has ' + hit.len; break; }
            plan.push({ id: rid, label: hit.label, metres: m }); sum += m;
        }
        if (!err && Math.abs(sum - metresSent) > 0.01) err = 'roll plan totals ' + sum;
    } else if (!err) {
        // sort by length ascending, tie -> original position (stable)
        const sorted = avail.map((r, i) => ({ r, i })).sort((a, b) =>
            a.r.len !== b.r.len ? a.r.len - b.r.len : a.i - b.i).map(x => x.r);
        let remain = metresSent;
        for (const r of sorted) {
            if (remain <= 0.001) break;
            const take = Math.min(r.len, remain);
            plan.push({ id: r.id, label: r.label, metres: take });
            remain -= take;
        }
        if (remain > 0.01) err = 'Lot ' + lotNum + ' has ' + r2(metresSent - remain) + ' Mtr across its rolls';
    }
    if (!err && plan.length === 0) err = 'Could not work out which rolls to cut';

    // ---- move the ledger: pass 1 verify all, pass 2 write --------------
    let lotWashOut = 0, lotUnwashOut = 0, lotInPrintOut = 0, matInPrintOut = 0;
    if (!err) {
        for (const pr of plan) {
            const rr = W.rolls.find(x => String(x.ID) === pr.id);
            if (!rr) { err = 'Roll ' + pr.label + ' vanished'; break; }
            if (pr.metres > dec(rr.Roll_Length) + 0.0001) {
                err = 'Roll ' + pr.label + ' has ' + dec(rr.Roll_Length) + ' Mtr, the cut plan needs ' +
                      pr.metres + ' - a concurrent change moved the stock. Nothing was sent; reload and try again.';
                break;
            }
        }
    }
    if (!err) {
        for (const pr of plan) {
            const rr = W.rolls.find(x => String(x.ID) === pr.id);
            rr.Roll_Length = r2(dec(rr.Roll_Length) - pr.metres);
            if (rr.Roll_Length <= 0) rr.Roll_Status = 'Consumed';
        }
    }
    if (!err) {
        lotWashOut = lotWash; lotUnwashOut = lotUnwash; lotInPrintOut = r2(lotInPrint + metresSent);
        if (srcState === 'Wash') { lotWashOut = r2(lotWash - metresSent); lot.Wash_Quantity = lotWashOut; }
        else { lotUnwashOut = r2(lotUnwash - metresSent); lot.Unwash_Quantity = lotUnwashOut; }
        lot.In_Print_Qty = lotInPrintOut;

        const mat = byId(W.mats, srcMatId)[0];
        matInPrintOut = r2(dec(mat.In_Print_Qty) + metresSent);
        if (srcState === 'Wash') mat.Wash_Quantity = r2(dec(mat.Wash_Quantity) - metresSent);
        else mat.Unwash_Quantity = r2(dec(mat.Unwash_Quantity) - metresSent);
        mat.Quantity = r2(dec(mat.Wash_Quantity) + dec(mat.Unwash_Quantity) + dec(mat.Unallocated_Qty));
        mat.In_Print_Qty = matInPrintOut;
    }

    if (err) return { success: false, error: err };

    const job = {
        ID: nid(W), Source_Material: srcMatId, Source_Lot: srcLotId, Printed_Material: tgtMatId,
        Printer: printerId, Source_State: srcState, Metres_Sent: metresSent, Metres_Returned: 0,
        Job_Status: 'At_Printer',
        Send_Lines: linesRaw.map(l => ({ Piece_Length_Cm: dec(l.lengthCm), Piece_Count: Math.trunc(dec(l.count)) })),
        Source_Rolls: plan.map(pr => ({ Roll_Label: pr.label, Metres: pr.metres })),
        Receive_Lines: []
    };
    W.jobs.push(job);
    return { success: true, jobId: job.ID, metresSent: r2(metresSent),
             rollPlan: plan.map(pr => ({ rollId: pr.id, label: pr.label, metres: r2(pr.metres) })),
             lotWash: lotWashOut, lotUnwash: lotUnwashOut, lotInPrint: lotInPrintOut,
             materialInPrint: matInPrintOut };
}
function str(v) { return v === null || v === undefined ? '' : String(v); }

// ===========================================================================
// receiveFromPrint  — deluge/receiveFromPrint.dg
// ===========================================================================
function receiveFromPrint(W, p) {
    let err = '';
    const jobId = ifnullStr(p.jobId, '').trim();
    const lotIdIn = ifnullStr(p.lotId, '').trim();
    const lotNumIn = ifnullStr(p.lotNumber, '').trim();
    const piecesRaw = p.pieces || [];

    if (jobId === '' || !isNum(jobId)) err = 'No print job given';
    if (!err && piecesRaw.length === 0) err = 'Nothing came back';

    let job = null, srcMat = '', srcLot = '', prMat = '', metresSent = 0;
    const sentLen = [], sentCnt = []; let piecesSent = 0;
    if (!err) {
        const js = byId(W.jobs, jobId);
        if (!js.length) err = 'Print job not found';
        else {
            job = js[0];
            if (job.Job_Status !== 'At_Printer') err = 'That job is ' + job.Job_Status;
            else {
                srcMat = String(job.Source_Material); srcLot = String(job.Source_Lot);
                prMat = String(job.Printed_Material); metresSent = dec(job.Metres_Sent);
                for (const sl of job.Send_Lines) {
                    sentLen.push(dec(sl.Piece_Length_Cm)); sentCnt.push(dec(sl.Piece_Count));
                    piecesSent += dec(sl.Piece_Count);
                }
            }
        }
    }
    if (!err && sentLen.length === 0) err = 'no send lines';
    if (!err && prMat === '') err = 'no printed material';

    // existing labels on this printed material
    const existingLabels = [];
    if (!err) {
        W.lots.filter(l => String(l.Material) === prMat).forEach(l => {
            lotRolls(W, l.ID).forEach(r => {
                const lbl = str(r.Roll_Label).trim().toUpperCase();
                if (lbl) existingLabels.push(lbl);
            });
        });
    }

    // ---- the pieces: one per physical piece, each with a typed roll label ----
    let metresReturned = 0, washM = 0, unwashM = 0, piecesReturned = 0;
    const cntByIdx = {}, stateByIdx = {}, seenLabels = [];
    if (!err) {
        for (const pc of piecesRaw) {
            const idxS = ifnullStr(pc.lineIndex, '').toString().trim();
            const lbl = ifnullStr(pc.label, '').trim();
            const st = ifnullStr(pc.state, '').trim();
            if (idxS === '' || !isNum(idxS)) { err = 'does not say which size'; break; }
            if (lbl === '') { err = 'needs a roll label'; break; }
            if (st !== 'Wash' && st !== 'Unwash') { err = 'must say washed or unwashed'; break; }
            if (seenLabels.indexOf(lbl.toUpperCase()) !== -1) { err = 'Roll label ' + lbl + ' is used twice'; break; }
            if (existingLabels.indexOf(lbl.toUpperCase()) !== -1) { err = 'Roll label ' + lbl + ' already exists'; break; }
            const i = parseInt(idxS, 10);
            if (i < 0 || i >= sentLen.length) { err = 'does not match anything sent'; break; }
            seenLabels.push(lbl.toUpperCase());
            const now = (cntByIdx[idxS] || 0) + 1;
            cntByIdx[idxS] = now;
            if (!stateByIdx[idxS]) stateByIdx[idxS] = st;
            else if (stateByIdx[idxS] !== st) { err = 'pieces of one size must all be washed or all unwashed'; break; }
            if (now > sentCnt[i]) { err = 'Only ' + sentCnt[i] + ' pieces of ' + sentLen[i] + ' cm went out'; break; }
            const m = sentLen[i] / 100;
            metresReturned += m; piecesReturned += 1;
            if (st === 'Wash') washM += m; else unwashM += m;
        }
    }
    if (!err && metresReturned <= 0) err = 'Nothing came back';

    let lot = null, lotNumOut = '';
    if (!err) {
        if (lotIdIn !== '') {
            const ls = byId(W.lots, lotIdIn);
            if (!ls.length) err = 'Lot not found';
            else { lot = ls[0];
                   if (String(lot.Material) !== prMat) err = 'belongs to a different material';
                   else if (str(lot.Status) === 'Blocked') err = 'blocked';
                   else lotNumOut = str(lot.Lot_Number); }
        } else {
            if (lotNumIn === '') err = 'Give the new printed lot a number';
            else {
                const clash = W.lots.some(l => String(l.Material) === prMat &&
                    str(l.Lot_Number).trim().toUpperCase() === lotNumIn.toUpperCase());
                if (clash) err = 'Lot ' + lotNumIn + ' already exists';
                else {
                    lotNumOut = lotNumIn;
                    lot = addLot(W, { Material: prMat, Lot_Number: lotNumOut, Print_Job: jobId, Source_Lot: srcLot });
                }
            }
        }
    }
    if (!err && !lot) err = 'Could not resolve a printed lot';

    // ---- the rolls: one per piece, label from the payload ----
    let rollRows = 0;
    if (!err) {
        for (const pc of piecesRaw) {
            const i = parseInt(ifnullStr(pc.lineIndex, '0'), 10);
            const lenM = sentLen[i] / 100;
            addRoll(W, lot.ID, ifnullStr(pc.label, '').trim(), lenM, 'Available');
            W.rolls[W.rolls.length - 1].Origin = 'Printed';
            W.rolls[W.rolls.length - 1].Source_Receipt = jobId;
            rollRows++;
        }
    }

    if (!err) {
        if (srcLot !== '') { const sl = byId(W.lots, srcLot)[0];
            if (sl) sl.In_Print_Qty = Math.max(0, r2(dec(sl.In_Print_Qty) - metresSent)); }
        if (srcMat !== '') { const sm = byId(W.mats, srcMat)[0];
            if (sm) sm.In_Print_Qty = Math.max(0, r2(dec(sm.In_Print_Qty) - metresSent)); }
        lot.Wash_Quantity = r2(dec(lot.Wash_Quantity) + washM);
        lot.Unwash_Quantity = r2(dec(lot.Unwash_Quantity) + unwashM);
        const pm = byId(W.mats, prMat)[0];
        pm.Wash_Quantity = r2(dec(pm.Wash_Quantity) + washM);
        pm.Unwash_Quantity = r2(dec(pm.Unwash_Quantity) + unwashM);
        pm.Quantity = r2(dec(pm.Wash_Quantity) + dec(pm.Unwash_Quantity) + dec(pm.Unallocated_Qty));

        job.Metres_Returned = r2(metresReturned);
        job.Printed_Lot = lot.ID;
        job.Job_Status = 'Received';
        // Receive_Lines: one row per SENT size, count + state derived
        job.Receive_Lines = sentLen.map((L, i) => ({
            Piece_Length_Cm: L,
            Piece_Count: cntByIdx[String(i)] || 0,
            State: stateByIdx[String(i)] || ''
        }));
    }

    if (err) return { success: false, error: err };
    return { success: true, printedLotId: lot.ID, lotNumber: lotNumOut,
             metresSent: r2(metresSent), metresReturned: r2(metresReturned),
             loss: r2(metresSent - metresReturned), piecesSent, piecesReturned,
             piecesLost: piecesSent - piecesReturned,
             lotWash: lot.Wash_Quantity, lotUnwash: lot.Unwash_Quantity, rollRows };
}

// ===========================================================================
// cancelPrintJob  — deluge/cancelPrintJob.dg
// ===========================================================================
function cancelPrintJob(W, p) {
    let err = '';
    const jobId = ifnullStr(p.jobId, '').trim();
    if (jobId === '' || !isNum(jobId)) err = 'No print job given';

    let job = null, srcMat = '', srcLot = '', srcState = '', metresSent = 0;
    if (!err) {
        const js = byId(W.jobs, jobId);
        if (!js.length) err = 'Print job not found';
        else {
            job = js[0];
            if (job.Job_Status !== 'At_Printer') err = 'That job is ' + job.Job_Status;
            else { srcMat = String(job.Source_Material); srcLot = String(job.Source_Lot);
                   srcState = str(job.Source_State).trim(); metresSent = dec(job.Metres_Sent); }
        }
    }
    if (!err && srcState !== 'Wash' && srcState !== 'Unwash') err = 'does not say which counter';
    if (!err && metresSent <= 0) err = 'no metres against it';

    let newRollLabel = '', lotWashOut = 0, lotInPrintOut = 0;
    if (!err) {
        if (srcLot !== '') {
            const l = byId(W.lots, srcLot)[0];
            const lotNum = str(l.Lot_Number).trim();
            lotInPrintOut = Math.max(0, r2(dec(l.In_Print_Qty) - metresSent));
            l.In_Print_Qty = lotInPrintOut;
            if (srcState === 'Wash') { lotWashOut = r2(dec(l.Wash_Quantity) + metresSent); l.Wash_Quantity = lotWashOut; }
            else { l.Unwash_Quantity = r2(dec(l.Unwash_Quantity) + metresSent); lotWashOut = dec(l.Wash_Quantity); }
            newRollLabel = (lotNum || 'LOT' + srcLot) + '-C' + jobId;
            addRoll(W, l.ID, newRollLabel, metresSent, 'Available');
            W.rolls[W.rolls.length - 1].Origin = 'Returned';
            W.rolls[W.rolls.length - 1].Source_Receipt = jobId;
        }
        if (srcMat !== '') {
            const m = byId(W.mats, srcMat)[0];
            m.In_Print_Qty = Math.max(0, r2(dec(m.In_Print_Qty) - metresSent));
            if (srcState === 'Wash') m.Wash_Quantity = r2(dec(m.Wash_Quantity) + metresSent);
            else m.Unwash_Quantity = r2(dec(m.Unwash_Quantity) + metresSent);
            m.Quantity = r2(dec(m.Wash_Quantity) + dec(m.Unwash_Quantity) + dec(m.Unallocated_Qty));
        }
        job.Job_Status = 'Cancelled';
    }

    if (err) return { success: false, error: err };
    return { success: true, restoredTo: srcState, metres: r2(metresSent),
             newRollLabel, lotWash: lotWashOut, lotInPrint: lotInPrintOut };
}

// ===========================================================================
// fixtures
// ===========================================================================
function fixture(opts) {
    opts = opts || {};
    const W = mkWorld();
    const src = addMat(W, { SKU: 'RM-001', Name: 'Grey Sheeting', Type_field: 'Plain Fabric',
        Fabric_Width_Inches: '60', Wash_Quantity: opts.wash != null ? opts.wash : 100,
        Unwash_Quantity: opts.unwash != null ? opts.unwash : 20, Quantity: 120 });
    const srcLot = addLot(W, { Material: src.ID, Lot_Number: 'L1',
        Wash_Quantity: opts.lotWash != null ? opts.lotWash : 100,
        Unwash_Quantity: opts.lotUnwash != null ? opts.lotUnwash : 20 });
    (opts.rolls || [['L1-R1', 8], ['L1-R2', 42], ['L1-R3', 70]]).forEach(r => addRoll(W, srcLot.ID, r[0], r[1]));
    const tgt = addMat(W, { SKU: 'RM-100', Name: 'Grey Block Print', Type_field: 'printed fabric',
        Fabric_Width_Inches: opts.tgtWidth || '60' });
    const printer = addPrinter(W, 'Zed Prints');
    return { W, src, srcLot, tgt, printer };
}
const LINES = [{ lengthCm: 300, count: 3 }, { lengthCm: 275, count: 4 }];  // 9 + 11 = 20 m, 7 pieces
function send(f, over) {
    return sendToPrint(f.W, Object.assign({
        sourceMaterialId: f.src.ID, sourceLotId: f.srcLot.ID, sourceState: 'Wash',
        targetMaterialId: f.tgt.ID, printerId: f.printer.ID, lines: LINES
    }, over || {}));
}

// ===========================================================================
// TESTS — sendToPrint
// ===========================================================================
console.log('\nsendToPrint');

test('S1 happy path: job created, metres out of Wash into In_Print_Qty', () => {
    const f = fixture();
    const r = send(f);
    assert.ok(r.success, r.error);
    assert.strictEqual(r.metresSent, 20);
    assert.strictEqual(f.srcLot.Wash_Quantity, 80);
    assert.strictEqual(f.srcLot.In_Print_Qty, 20);
    assert.strictEqual(f.src.Wash_Quantity, 80);
    assert.strictEqual(f.src.In_Print_Qty, 20);
    // SKU total unchanged
    assert.strictEqual(f.src.Quantity, 100);   // 80 wash + 20 unwash
});

test('S2 auto plan is shortest roll first', () => {
    const f = fixture();  // rolls 8, 42, 70
    const r = send(f);
    // 20 m: all 8 off R1, then 12 off R2
    assert.deepStrictEqual(r.rollPlan.map(p => [p.label, p.metres]),
        [['L1-R1', 8], ['L1-R2', 12]]);
    const rolls = lotRolls(f.W, f.srcLot.ID);
    assert.strictEqual(rolls.find(x => x.Roll_Label === 'L1-R1').Roll_Length, 0);
    assert.strictEqual(rolls.find(x => x.Roll_Label === 'L1-R1').Roll_Status, 'Consumed');
    assert.strictEqual(rolls.find(x => x.Roll_Label === 'L1-R2').Roll_Length, 30);
    assert.strictEqual(rolls.find(x => x.Roll_Label === 'L1-R3').Roll_Length, 70);
});

test('S3 roll sum stays equal to the shelf columns after send', () => {
    const f = fixture();
    send(f);
    assert.strictEqual(rollSum(f.W, f.srcLot.ID), shelf(f.srcLot));
});

test('S4 budget: cannot send more than the chosen state holds', () => {
    const f = fixture({ lotWash: 15, wash: 15 });
    const r = send(f);
    assert.ok(!r.success);
    assert.ok(/only 15 Mtr Wash/.test(r.error), r.error);
});

test('S5 rolls cannot cover the metres -> reject, nothing moved', () => {
    const f = fixture({ lotWash: 100, wash: 100, rolls: [['L1-R1', 5], ['L1-R2', 6]] });
    const r = send(f);
    assert.ok(!r.success);
    assert.ok(/across its rolls/.test(r.error), r.error);
    assert.strictEqual(f.srcLot.Wash_Quantity, 100);   // untouched
});

test('S6 lot with no rolls at all -> reject', () => {
    const f = fixture({ rolls: [] });
    const r = send(f);
    assert.ok(!r.success);
    assert.ok(/no rolls recorded/.test(r.error), r.error);
});

test('S7 target Type is NOT checked for now — any same-width fabric is accepted', () => {
    const f = fixture();
    f.tgt.Type_field = 'Plain Fabric';   // not "printed fabric"
    const r = send(f);
    assert.ok(r.success, r.error);        // width matches, so it goes through
});

test('S8 width mismatch is refused', () => {
    const f = fixture({ tgtWidth: '44' });
    const r = send(f);
    assert.ok(!r.success);
    assert.ok(/Width mismatch/.test(r.error), r.error);
});

test('S9 manual roll plan honoured when it totals the metres', () => {
    const f = fixture();  // rolls 8, 42, 70
    const rolls = lotRolls(f.W, f.srcLot.ID);
    const r2Id = rolls.find(x => x.Roll_Label === 'L1-R2').ID;
    const r3Id = rolls.find(x => x.Roll_Label === 'L1-R3').ID;
    const r = send(f, { rollPlan: [{ rollId: r2Id, metres: 5 }, { rollId: r3Id, metres: 15 }] });
    assert.ok(r.success, r.error);
    assert.strictEqual(rolls.find(x => x.Roll_Label === 'L1-R1').Roll_Length, 8);   // untouched
    assert.strictEqual(rolls.find(x => x.Roll_Label === 'L1-R2').Roll_Length, 37);
    assert.strictEqual(rolls.find(x => x.Roll_Label === 'L1-R3').Roll_Length, 55);
});

test('S10 manual roll plan that does not total the metres is refused', () => {
    const f = fixture();
    const r2Id = lotRolls(f.W, f.srcLot.ID).find(x => x.Roll_Label === 'L1-R2').ID;
    const r = send(f, { rollPlan: [{ rollId: r2Id, metres: 10 }] });
    assert.ok(!r.success);
    assert.ok(/roll plan totals 10/.test(r.error), r.error);
});

test('S11 manual roll plan over a roll length is refused', () => {
    const f = fixture();
    const r1Id = lotRolls(f.W, f.srcLot.ID).find(x => x.Roll_Label === 'L1-R1').ID;
    const r = send(f, { rollPlan: [{ rollId: r1Id, metres: 20 }] });
    assert.ok(!r.success);
    assert.ok(/L1-R1 has 8/.test(r.error), r.error);
});

test('S12 fractional / zero-count lines refused', () => {
    const f = fixture();
    assert.ok(!send(f, { lines: [{ lengthCm: 300, count: 2.5 }] }).success);
    assert.ok(!send(f, { lines: [{ lengthCm: 0, count: 3 }] }).success);
});

test('S13 Source_Rolls subform records what was cut', () => {
    const f = fixture();
    const r = send(f);
    const job = byId(f.W.jobs, r.jobId)[0];
    assert.deepStrictEqual(job.Source_Rolls.map(x => [x.Roll_Label, x.Metres]),
        [['L1-R1', 8], ['L1-R2', 12]]);
});

test('S14 a hand plan that over-draws one roll is rejected whole, nothing written', () => {
    // The .dg verifies the WHOLE plan (pass 1) before decrementing any roll
    // (pass 2). A concurrent-shrink race can only be checked at Execute, but the
    // testable property is: a plan where one roll does not fit writes NOTHING -
    // not the roll that would have fit, not the lot counter, no job.
    const f = fixture({ rolls: [['L1-R1', 8], ['L1-R2', 8]], lotWash: 100, wash: 100 });
    const r1 = lotRolls(f.W, f.srcLot.ID).find(x => x.Roll_Label === 'L1-R1');
    const r2 = lotRolls(f.W, f.srcLot.ID).find(x => x.Roll_Label === 'L1-R2');
    const wash0 = f.srcLot.Wash_Quantity, jobs0 = f.W.jobs.length;
    const r = send(f, { lines: [{ lengthCm: 300, count: 5 }],   // 15 m
        rollPlan: [{ rollId: r1.ID, metres: 7 }, { rollId: r2.ID, metres: 8 }, { rollId: r2.ID, metres: 8 }] });
    assert.ok(!r.success);   // names r2 twice
    assert.strictEqual(r1.Roll_Length, 8);   // untouched
    assert.strictEqual(r2.Roll_Length, 8);
    assert.strictEqual(f.srcLot.Wash_Quantity, wash0);
    assert.strictEqual(f.W.jobs.length, jobs0);
});

test('S15 a hand plan naming one roll twice is refused', () => {
    const f = fixture();
    const rid = lotRolls(f.W, f.srcLot.ID).find(x => x.Roll_Label === 'L1-R3').ID;
    const r = send(f, { rollPlan: [{ rollId: rid, metres: 10 }, { rollId: rid, metres: 10 }] });
    assert.ok(!r.success);
    assert.ok(/names one roll twice/.test(r.error), r.error);
});

// ===========================================================================
// TESTS — receiveFromPrint
// ===========================================================================
console.log('\nreceiveFromPrint');

function sent(opts) {
    const f = fixture(opts);
    const r = send(f, opts && opts.send);
    assert.ok(r.success, 'setup send failed: ' + r.error);
    f.jobId = r.jobId;
    return f;
}
const RECV_ALL = [
    { lineIndex: 0, count: 3, state: 'Wash' },
    { lineIndex: 1, count: 4, state: 'Wash' }
];

// Wrapper: the real payload is pieces[] — one entry per physical piece, each
// with a TYPED roll label. The tests pass `lines` ({lineIndex,count,state}) for
// brevity and this expands each into `count` pieces with generated labels
// (<lotNumber>-P1, -P2, ...). A test exercising label rules passes `pieces`
// directly.
let _lbl = 0;
function receive(W, p) {
    if (!p.pieces) {
        const base = (p.lotNumber || p.lotId || 'X');
        const pieces = [];
        (p.lines || []).forEach(ln => {
            for (let k = 0; k < Math.trunc(dec(ln.count)); k++) {
                _lbl += 1;
                pieces.push({ lineIndex: ln.lineIndex, label: base + '-P' + _lbl, state: ln.state });
            }
        });
        p = Object.assign({}, p, { pieces });
    }
    return receiveFromPrint(W, p);
}

test('R1 receive into a new lot: one Lot_Rolls row per piece, label from the payload', () => {
    const f = sent();
    const r = receiveFromPrint(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', pieces: [
        { lineIndex: 0, label: 'ROLL-A', state: 'Wash' },
        { lineIndex: 0, label: 'ROLL-B', state: 'Wash' },
        { lineIndex: 0, label: 'ROLL-C', state: 'Wash' },
        { lineIndex: 1, label: 'ROLL-D', state: 'Wash' },
        { lineIndex: 1, label: 'ROLL-E', state: 'Wash' },
        { lineIndex: 1, label: 'ROLL-F', state: 'Wash' },
        { lineIndex: 1, label: 'ROLL-G', state: 'Wash' }
    ]});
    assert.ok(r.success, r.error);
    assert.strictEqual(r.rollRows, 7);
    const rolls = lotRolls(f.W, r.printedLotId);
    assert.strictEqual(rolls.length, 7);
    assert.strictEqual(rolls.filter(x => x.Roll_Length === 3).length, 3);
    assert.strictEqual(rolls.filter(x => x.Roll_Length === 2.75).length, 4);
    assert.ok(rolls.every(x => x.Origin === 'Printed'));
    assert.deepStrictEqual(rolls.map(x => x.Roll_Label).sort(),
        ['ROLL-A', 'ROLL-B', 'ROLL-C', 'ROLL-D', 'ROLL-E', 'ROLL-F', 'ROLL-G']);
});

test('R1b a piece with no label is refused', () => {
    const f = sent();
    const r = receiveFromPrint(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', pieces: [
        { lineIndex: 0, label: '', state: 'Wash' }
    ]});
    assert.ok(!r.success);
    assert.ok(/needs a roll label/.test(r.error), r.error);
});

test('R1c a label used twice in one receipt is refused', () => {
    const f = sent();
    const r = receiveFromPrint(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', pieces: [
        { lineIndex: 0, label: 'DUP', state: 'Wash' },
        { lineIndex: 1, label: 'dup', state: 'Wash' }   // case-insensitive
    ]});
    assert.ok(!r.success);
    assert.ok(/used twice/.test(r.error), r.error);
});

test('R1d a label already on the printed material is refused', () => {
    const f = sent();
    const r1 = receiveFromPrint(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', pieces: [
        { lineIndex: 0, label: 'TAKEN', state: 'Wash' }
    ]});
    assert.ok(r1.success, r1.error);
    const s2 = send(f, { lines: [{ lengthCm: 300, count: 1 }] });
    const r2 = receiveFromPrint(f.W, { jobId: s2.jobId, lotId: r1.printedLotId, lotNumber: '', pieces: [
        { lineIndex: 0, label: 'taken', state: 'Wash' }
    ]});
    assert.ok(!r2.success);
    assert.ok(/already exists/.test(r2.error), r2.error);
});

test('R2 printed lot metres == Σ Roll_Length', () => {
    const f = sent();
    const r = receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: RECV_ALL });
    const lot = byId(f.W.lots, r.printedLotId)[0];
    assert.strictEqual(shelf(lot), 20);
    assert.strictEqual(rollSum(f.W, r.printedLotId), 20);
});

test('R3 source In_Print_Qty cleared, source counters NOT credited back', () => {
    const f = sent();          // after send: lot wash 80, inPrint 20
    receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: RECV_ALL });
    assert.strictEqual(f.srcLot.In_Print_Qty, 0);
    assert.strictEqual(f.srcLot.Wash_Quantity, 80);   // stays down — became another material
    assert.strictEqual(f.src.In_Print_Qty, 0);
});

test('R4 short return: only labelled pieces book; loss is whole pieces', () => {
    const f = sent();
    const r = receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: [
        { lineIndex: 0, count: 3, state: 'Wash' },
        { lineIndex: 1, count: 2, state: 'Wash' }   // 2 of 4 back
    ]});
    assert.ok(r.success, r.error);
    assert.strictEqual(r.piecesLost, 2);
    assert.strictEqual(r.loss, r2(20 - (9 + 5.5)));
    assert.strictEqual(r.rollRows, 5);
});

test('R5 more pieces of a size than went out is refused', () => {
    const f = sent();
    const r = receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: [
        { lineIndex: 0, count: 5, state: 'Wash' },   // only 3 sent
        { lineIndex: 1, count: 4, state: 'Wash' }
    ]});
    assert.ok(!r.success);
    assert.ok(/Only 3 pieces of 300 cm went out/.test(r.error), r.error);
});

test('R6 a piece naming a size that was never sent is refused', () => {
    const f = sent();
    const r = receiveFromPrint(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', pieces: [
        { lineIndex: 9, label: 'X', state: 'Wash' }
    ]});
    assert.ok(!r.success);
    assert.ok(/does not match anything sent/.test(r.error), r.error);
});

test('R6b pieces of one size disagreeing on state is refused', () => {
    const f = sent();
    const r = receiveFromPrint(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', pieces: [
        { lineIndex: 0, label: 'A', state: 'Wash' },
        { lineIndex: 0, label: 'B', state: 'Unwash' }
    ]});
    assert.ok(!r.success);
    assert.ok(/washed or all unwashed/.test(r.error), r.error);
});

test('R7 no pieces at all -> refused', () => {
    const f = sent();
    const r = receiveFromPrint(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', pieces: [] });
    assert.ok(!r.success);
    assert.ok(/Nothing came back/.test(r.error), r.error);
});

test('R7b Receive_Lines has one row per SENT size, count + state derived', () => {
    const f = sent();
    receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: [
        { lineIndex: 0, count: 3, state: 'Wash' },
        { lineIndex: 1, count: 0, state: 'Wash' }   // this size came back as nothing
    ]});
    const job = byId(f.W.jobs, f.jobId)[0];
    assert.strictEqual(job.Receive_Lines.length, 2);
    assert.deepStrictEqual(job.Receive_Lines.map(rl => [rl.Piece_Length_Cm, rl.Piece_Count]),
        [[300, 3], [275, 0]]);
});

test('R8 receiving a Received job is refused', () => {
    const f = sent();
    receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: RECV_ALL });
    const r = receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P2', lines: RECV_ALL });
    assert.ok(!r.success);
    assert.ok(/That job is Received/.test(r.error), r.error);
});

test('R9 top up an existing printed lot', () => {
    const f = sent();
    const r1 = receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: RECV_ALL });
    // a second job into the same lot
    const s2 = send(f, { lines: [{ lengthCm: 300, count: 2 }] });   // 6 m
    const r2r = receive(f.W, { jobId: s2.jobId, lotId: r1.printedLotId, lotNumber: '', lines: [
        { lineIndex: 0, lengthCm: 300, count: 2, state: 'Wash' }
    ]});
    assert.ok(r2r.success, r2r.error);
    assert.strictEqual(lotRolls(f.W, r1.printedLotId).length, 9);
    assert.strictEqual(rollSum(f.W, r1.printedLotId), 26);
});

test('R10 mixed wash/unwash return splits onto the two counters', () => {
    const f = sent();
    const r = receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: [
        { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash' },
        { lineIndex: 1, lengthCm: 275, count: 4, state: 'Unwash' }
    ]});
    assert.ok(r.success, r.error);
    assert.strictEqual(r.lotWash, 9);
    assert.strictEqual(r.lotUnwash, 11);
});

// ===========================================================================
// TESTS — cancelPrintJob
// ===========================================================================
console.log('\ncancelPrintJob');

test('C1 cancel puts metres back to the counter AND adds ONE new roll', () => {
    const f = sent();          // after send: lot wash 80, inPrint 20, R1 consumed, R2 at 30
    const rollsBefore = lotRolls(f.W, f.srcLot.ID).length;
    const r = cancelPrintJob(f.W, { jobId: f.jobId, reason: 'unprinted' });
    assert.ok(r.success, r.error);
    assert.strictEqual(f.srcLot.Wash_Quantity, 100);
    assert.strictEqual(f.srcLot.In_Print_Qty, 0);
    assert.strictEqual(f.src.Wash_Quantity, 100);
    // exactly one new roll, of the whole sent metres
    const rollsAfter = lotRolls(f.W, f.srcLot.ID);
    assert.strictEqual(rollsAfter.length, rollsBefore + 1);
    const nu = rollsAfter.find(x => x.Origin === 'Returned');
    assert.strictEqual(nu.Roll_Length, 20);
    assert.strictEqual(nu.Roll_Label, r.newRollLabel);
});

test('C2 after cancel: roll sum still equals shelf columns', () => {
    const f = sent();
    cancelPrintJob(f.W, { jobId: f.jobId, reason: '' });
    assert.strictEqual(rollSum(f.W, f.srcLot.ID), shelf(f.srcLot));
    assert.strictEqual(shelf(f.srcLot), 120);   // 100 wash + 20 unwash
});

test('C3 cannot cancel a Received job', () => {
    const f = sent();
    receive(f.W, { jobId: f.jobId, lotId: '', lotNumber: 'P1', lines: RECV_ALL });
    const r = cancelPrintJob(f.W, { jobId: f.jobId, reason: '' });
    assert.ok(!r.success);
    assert.ok(/That job is Received/.test(r.error), r.error);
});

test('C4 unwash send cancels back to Unwash', () => {
    const f = sent({ lotWash: 5, wash: 5, send: { sourceState: 'Unwash' } });
    const r = cancelPrintJob(f.W, { jobId: f.jobId, reason: '' });
    assert.strictEqual(r.restoredTo, 'Unwash');
    assert.strictEqual(f.srcLot.Unwash_Quantity, 20);   // 20 - 20 + 20
    assert.strictEqual(f.srcLot.Wash_Quantity, 5);
});

// ===========================================================================
// LIFECYCLE — the reconciliation identity end to end
// ===========================================================================
console.log('\nlifecycle');

test('X1 send -> receive: source SKU down by loss, printed SKU up by returned', () => {
    const f = fixture();
    const srcTotal0 = f.src.Quantity;   // 120
    const s = send(f);
    // mid-flight: source total unchanged (cloth still ours, in In_Print_Qty)
    assert.strictEqual(r2(dec(f.src.Wash_Quantity) + dec(f.src.Unwash_Quantity) + dec(f.src.In_Print_Qty)), srcTotal0);
    const r = receive(f.W, { jobId: s.jobId, lotId: '', lotNumber: 'P1', lines: [
        { lineIndex: 0, lengthCm: 300, count: 3, state: 'Wash' },
        { lineIndex: 1, lengthCm: 275, count: 3, state: 'Wash' }   // 1 lost
    ]});
    // source: 120 - 20 sent, In_Print cleared -> 100. loss 2.75 simply gone.
    assert.strictEqual(r2(dec(f.src.Wash_Quantity) + dec(f.src.Unwash_Quantity) + dec(f.src.In_Print_Qty)), 100);
    // printed SKU: exactly what came back
    assert.strictEqual(dec(f.tgt.Wash_Quantity), r.metresReturned);
    assert.strictEqual(r.metresReturned, r2(9 + 8.25));
});

test('X2 send -> cancel: every counter back where it started', () => {
    const f = fixture();
    const w0 = f.srcLot.Wash_Quantity, s0 = shelf(f.srcLot), q0 = f.src.Quantity;
    const s = send(f);
    cancelPrintJob(f.W, { jobId: s.jobId, reason: '' });
    assert.strictEqual(f.srcLot.Wash_Quantity, w0);
    assert.strictEqual(f.srcLot.In_Print_Qty, 0);
    assert.strictEqual(shelf(f.srcLot), s0);
    assert.strictEqual(f.src.Quantity, q0);
    assert.strictEqual(rollSum(f.W, f.srcLot.ID), shelf(f.srcLot));
});

// ---- summary -------------------------------------------------------------
console.log('\n========================================');
console.log('print-writers: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
