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
        Wash_Quantity: 0, Unwash_Quantity: 0, In_Print_Qty: 0, Unallocated_Qty: 0, Quantity: 0,
        Inventory_Item_ID: 'I-x'
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
    const printerId = ifnullStr(p.printerId, '').trim();
    const rowsRaw = p.lines || [];

    if (printerId === '' || !isNum(printerId)) err = 'No printer chosen';
    if (!err && rowsRaw.length === 0) err = 'Nothing to send - add at least one line';
    if (!err && rowsRaw.length > 40) err = 'At most 40 lines';
    if (!err && !byId(W.printers, printerId).length) err = 'Printer not found';

    // ---- pass 1: the rows ----------------------------------------------------
    const matOk = {}, lotOk = {};
    const gKeys = [], groups = {};          // key -> { src, lot, state, tgt, metres, pieces, amount }
    const lsKeys = [], needLS = {};         // lot|state -> metres
    const lotOrder = [], needLot = {};
    let totalCm = 0, rowNo = 0;

    function checkMat(id, kind) {
        const rs = byId(W.mats, id);
        if (!rs.length) return 'Line ' + rowNo + ': ' + kind + ' not found';
        const m = rs[0];
        const w = str(m.Fabric_Width_Inches).trim() === '' ? 0 : parseFloat(m.Fabric_Width_Inches);
        if (str(m.Is_Fabric).toLowerCase() !== 'true') return m.SKU + ' is not a fabric';
        if (w <= 0) return m.SKU + ' has no fabric width on record';
        if (str(m.Inventory_Item_ID).trim() === '') return m.SKU + ' has no Zoho Inventory item mapped';
        matOk[id] = { sku: m.SKU, width: w };
        return '';
    }

    if (!err) {
        for (const rw of rowsRaw) {
            rowNo++;
            const sMat = ifnullStr(rw.sourceMaterialId, '').trim();
            const sLot = ifnullStr(rw.sourceLotId, '').trim();
            const sState = ifnullStr(rw.sourceState, '').trim();
            const tMat = ifnullStr(rw.targetMaterialId, '').trim();
            const len = dec(rw.lengthCm), cd = dec(rw.count), c = Math.trunc(cd), rate = dec(rw.rate);

            if (sMat === '' || !isNum(sMat)) err = 'Line ' + rowNo + ': no base fabric chosen';
            else if (sLot === '' || !isNum(sLot)) err = 'Line ' + rowNo + ': no lot chosen';
            else if (sState !== 'Wash' && sState !== 'Unwash') err = 'Line ' + rowNo + ': washed or unwashed?';
            else if (tMat === '' || !isNum(tMat)) err = 'Line ' + rowNo + ': no print fabric chosen';
            else if (tMat === sMat) err = 'Line ' + rowNo + ': base and print fabric are the same material';
            else if (len <= 0) err = 'Line ' + rowNo + ': needs a piece length in cm';
            else if (cd <= 0) err = 'Line ' + rowNo + ': needs a piece count above zero';
            else if (c !== cd) err = 'Line ' + rowNo + ': piece count must be a whole number';
            else if (rate < 0) err = 'Line ' + rowNo + ': the rate cannot be negative';
            if (err) break;

            if (!matOk[sMat]) { err = checkMat(sMat, 'base fabric'); if (err) break; }
            if (!matOk[tMat]) { err = checkMat(tMat, 'print fabric'); if (err) break; }
            if (Math.abs(matOk[sMat].width - matOk[tMat].width) > 0.01) {
                err = 'Line ' + rowNo + ': width mismatch - ' + matOk[sMat].sku + ' / ' + matOk[tMat].sku; break;
            }

            if (!lotOk[sLot]) {
                const ls = byId(W.lots, sLot);
                if (!ls.length) { err = 'Line ' + rowNo + ': lot not found'; break; }
                const l = ls[0];
                if (String(l.Material) !== sMat) { err = 'Line ' + rowNo + ': lot ' + l.Lot_Number + ' belongs to a different material'; break; }
                if (str(l.Status) === 'Blocked') { err = 'Line ' + rowNo + ': lot ' + l.Lot_Number + ' is blocked'; break; }
                if (lotRolls(W, l.ID).length === 0) { err = 'Lot ' + l.Lot_Number + ' has no rolls recorded'; break; }
                lotOk[sLot] = { rec: l, mat: sMat, num: str(l.Lot_Number), wash: dec(l.Wash_Quantity), unwash: dec(l.Unwash_Quantity) };
                lotOrder.push(sLot); needLot[sLot] = 0;
            } else if (lotOk[sLot].mat !== sMat) {
                err = 'Line ' + rowNo + ': lot ' + lotOk[sLot].num + ' belongs to a different material'; break;
            }

            const mtr = (len * c) / 100;
            const gk = sLot + '|' + sState + '|' + tMat;
            if (!groups[gk]) { gKeys.push(gk); groups[gk] = { src: sMat, lot: sLot, state: sState, tgt: tMat, metres: 0, pieces: 0, amount: 0 }; }
            groups[gk].metres += mtr; groups[gk].pieces += c; groups[gk].amount += c * rate;
            const lsk = sLot + '|' + sState;
            if (needLS[lsk] == null) { lsKeys.push(lsk); needLS[lsk] = 0; }
            needLS[lsk] += mtr; needLot[sLot] += mtr;
            totalCm += len * c;
        }
    }
    if (!err && gKeys.length > 15) err = 'At most 15 base/print fabric combinations';
    const metresSent = totalCm / 100;
    if (!err && metresSent <= 0) err = 'Nothing to send - the lines add up to zero';

    // ---- budgets, per lot + state ---------------------------------------------
    if (!err) {
        for (const k of lsKeys) {
            const [lot, state] = k.split('|');
            const L = lotOk[lot];
            const have = state === 'Wash' ? L.wash : L.unwash;
            if (needLS[k] > have + 0.0001) {
                err = 'Lot ' + L.num + ' of ' + matOk[L.mat].sku + ' has only ' + have + ' Mtr ' +
                      (state === 'Wash' ? 'washed' : 'unwashed') + ' - this job order needs ' + r2(needLS[k]);
                break;
            }
        }
    }

    // ---- roll plan, one per lot, on the lot's TOTAL ----------------------------
    const plan = [];   // {lot, id, label, metres}
    if (!err) {
        for (const lot of lotOrder) {
            const avail = lotRolls(W, lot)
                .filter(r => r.Roll_Status === 'Available' && dec(r.Roll_Length) > 0)
                .map(r => ({ id: String(r.ID), label: str(r.Roll_Label), len: dec(r.Roll_Length) }));
            if (!avail.length) { err = 'Lot ' + lotOk[lot].num + ' has no cuttable rolls'; break; }
            const sorted = avail.map((r, i) => ({ r, i })).sort((a, b) =>
                a.r.len !== b.r.len ? a.r.len - b.r.len : a.i - b.i).map(x => x.r);
            let remain = needLot[lot];
            for (const r of sorted) {
                if (remain <= 0.001) break;
                const take = Math.min(r.len, remain);
                plan.push({ lot, id: r.id, label: r.label, metres: take });
                remain -= take;
            }
            if (remain > 0.01) { err = 'Lot ' + lotOk[lot].num + ' has ' + r2(needLot[lot] - remain) + ' Mtr across its rolls'; break; }
        }
    }

    // ---- move the ledger: verify every roll, then write ---------------------
    if (!err) {
        for (const pr of plan) {
            const rr = W.rolls.find(x => String(x.ID) === pr.id);
            if (!rr) { err = 'Roll ' + pr.label + ' vanished'; break; }
            if (pr.metres > dec(rr.Roll_Length) + 0.0001) { err = 'Roll ' + pr.label + ' has ' + dec(rr.Roll_Length) + ' Mtr - a concurrent change moved the stock. Nothing was sent'; break; }
        }
    }
    if (err) return { success: false, error: err };

    for (const pr of plan) {
        const rr = W.rolls.find(x => String(x.ID) === pr.id);
        rr.Roll_Length = r2(dec(rr.Roll_Length) - pr.metres);
        if (rr.Roll_Length <= 0) rr.Roll_Status = 'Consumed';
    }
    for (const k of lsKeys) {
        const [lot, state] = k.split('|');
        const l = lotOk[lot].rec, need = needLS[k];
        if (state === 'Wash') l.Wash_Quantity = r2(dec(l.Wash_Quantity) - need);
        else l.Unwash_Quantity = r2(dec(l.Unwash_Quantity) - need);
        l.In_Print_Qty = r2(dec(l.In_Print_Qty) + need);
        const m = byId(W.mats, lotOk[lot].mat)[0];
        if (state === 'Wash') m.Wash_Quantity = r2(dec(m.Wash_Quantity) - need);
        else m.Unwash_Quantity = r2(dec(m.Unwash_Quantity) - need);
        m.Quantity = r2(dec(m.Wash_Quantity) + dec(m.Unwash_Quantity) + dec(m.Unallocated_Qty));
        m.In_Print_Qty = r2(dec(m.In_Print_Qty) + need);
    }

    // ---- one job per (lot, state, print fabric) -----------------------------
    let lastJNum = 0;
    W.jobs.forEach(j => {
        const parts = str(j.Job_No).split('-');
        const n = parts.length > 1 ? parts[parts.length - 1].trim() : '';
        if (/^\d+$/.test(n) && Number(n) > lastJNum) lastJNum = Number(n);
    });
    const usedOnRoll = {};
    let batchNo = '';
    const made = [];
    gKeys.forEach((gk, gi) => {
        const g = groups[gk];
        const jobNo = 'PJ-' + String(lastJNum + 1 + gi).padStart(5, '0');
        if (gi === 0) batchNo = jobNo;
        let need = g.metres;
        const rolls = [];
        plan.forEach((pr, k) => {
            if (need <= 0.001 || pr.lot !== g.lot) return;
            const used = usedOnRoll[k] || 0, left = pr.metres - used;
            if (left <= 0.001) return;
            const take = Math.min(left, need);
            rolls.push({ Roll_Label: pr.label, Metres: r2(take) });
            usedOnRoll[k] = used + take; need -= take;
        });
        const job = {
            ID: nid(W), Job_No: jobNo, Print_Batch: batchNo,
            Source_Material: g.src, Source_Lot: g.lot, Printed_Material: g.tgt, Printer: printerId,
            Source_State: g.state, Metres_Sent: r2(g.metres), Metres_Returned: 0, Job_Status: 'At_Printer',
            Send_Lines: rowsRaw.filter(rw => ifnullStr(rw.sourceLotId, '') + '|' + ifnullStr(rw.sourceState, '') + '|' + ifnullStr(rw.targetMaterialId, '') === gk)
                .map(rw => ({ Piece_Length_Cm: dec(rw.lengthCm), Piece_Count: Math.trunc(dec(rw.count)), Rate: dec(rw.rate) })),
            Source_Rolls: rolls, Receive_Lines: []
        };
        W.jobs.push(job);
        made.push({ jobId: job.ID, jobNo, sku: matOk[g.tgt].sku, sourceSku: matOk[g.src].sku, lotNumber: lotOk[g.lot].num,
                    state: g.state, pieces: g.pieces, metresSent: r2(g.metres), amount: r2(g.amount) });
    });

    return { success: true, batchNo, jobId: made[0].jobId, jobNo: made[0].jobNo, jobs: made,
             metresSent: r2(metresSent),
             cuts: plan.map(pr => ({ lotNumber: lotOk[pr.lot].num, rollId: pr.id, label: pr.label, metres: r2(pr.metres) })) };
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
// Rows off the fixture's base, lot L1, washed, into its print fabric, unless
// `rows` gives the whole list. `lines` (length/count/rate) shape the default
// rows, so the receive/cancel lifecycle tests read as they always did.
function rowOf(f, l, o) {
    return Object.assign({ sourceMaterialId: f.src.ID, sourceLotId: f.srcLot.ID, sourceState: 'Wash',
                           targetMaterialId: f.tgt.ID, lengthCm: l.lengthCm, count: l.count, rate: l.rate || 0 }, o || {});
}
function send(f, over) {
    over = over || {};
    const rowOver = over.sourceState ? { sourceState: over.sourceState } : null;
    const rows = over.rows || (over.lines || LINES).map(l => rowOf(f, l, rowOver));
    return sendToPrint(f.W, { printerId: over.printerId !== undefined ? over.printerId : f.printer.ID, lines: rows });
}
// A second print fabric at the same width — the floral beside the checks.
function addFloral(f) {
    return addMat(f.W, { SKU: 'RM-101', Name: 'Grey Floral', Type_field: 'printed fabric',
                         Fabric_Width_Inches: '60' });
}
// A second base with its own lot and rolls — white cotton, 58 in.
function addCotton(f) {
    const base = addMat(f.W, { SKU: 'RM-002', Name: 'White Cotton', Fabric_Width_Inches: '58',
                               Wash_Quantity: 0, Unwash_Quantity: 30, Quantity: 30 });
    const lot = addLot(f.W, { Material: base.ID, Lot_Number: 'W1', Wash_Quantity: 0, Unwash_Quantity: 30 });
    addRoll(f.W, lot.ID, 'W1-R1', 30);
    const stripes = addMat(f.W, { SKU: 'RM-103', Name: 'Blue Stripes', Fabric_Width_Inches: '58' });
    return { base, lot, stripes };
}

// ===========================================================================
// TESTS — sendToPrint, one row per piece size
// ===========================================================================
console.log('\nsendToPrint');

test('S1 happy path: one job, metres out of Wash into In_Print_Qty, SKU total unchanged', () => {
    const f = fixture();
    const r = send(f);
    assert.ok(r.success, r.error);
    assert.strictEqual(r.metresSent, 20);
    assert.strictEqual(f.W.jobs.length, 1);
    assert.strictEqual(f.srcLot.Wash_Quantity, 80);
    assert.strictEqual(f.srcLot.In_Print_Qty, 20);
    assert.strictEqual(f.src.Wash_Quantity, 80);
    assert.strictEqual(f.src.In_Print_Qty, 20);
    assert.strictEqual(f.src.Quantity, 100);   // 80 wash + 20 unwash
});

test('S2 the lot is cut shortest roll first', () => {
    const f = fixture();  // rolls 8, 42, 70
    const r = send(f);
    assert.deepStrictEqual(r.cuts.map(p => [p.label, p.metres]), [['L1-R1', 8], ['L1-R2', 12]]);
    const rolls = lotRolls(f.W, f.srcLot.ID);
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
    assert.ok(/has only 15 Mtr washed/.test(r.error), r.error);
});

test('S5 rolls cannot cover the metres -> reject, nothing moved', () => {
    const f = fixture({ lotWash: 100, wash: 100, rolls: [['L1-R1', 5], ['L1-R2', 6]] });
    const r = send(f);
    assert.ok(!r.success);
    assert.ok(/across its rolls/.test(r.error), r.error);
    assert.strictEqual(f.srcLot.Wash_Quantity, 100);
});

test('S6 lot with no rolls at all -> reject', () => {
    const f = fixture({ rolls: [] });
    const r = send(f);
    assert.ok(!r.success);
    assert.ok(/no rolls recorded/.test(r.error), r.error);
});

test('S7 target Type is NOT checked for now — any same-width fabric is accepted', () => {
    const f = fixture();
    f.tgt.Type_field = 'Plain Fabric';
    assert.ok(send(f).success);
});

test('S8 width mismatch is refused, naming the line', () => {
    const f = fixture({ tgtWidth: '44' });
    const r = send(f);
    assert.ok(!r.success);
    assert.ok(/Line 1: width mismatch/.test(r.error), r.error);
});

test('S9 an unmapped print fabric is refused before anything moves', () => {
    const f = fixture();
    f.tgt.Inventory_Item_ID = '';
    const r = send(f);
    assert.ok(!r.success && /no Zoho Inventory item mapped/.test(r.error), r.error);
    assert.strictEqual(f.srcLot.Wash_Quantity, 100);
});

test('S10 no printer -> refused', () => {
    const f = fixture();
    const r = send(f, { printerId: '' });
    assert.ok(!r.success && /No printer chosen/.test(r.error), r.error);
});

test('S11 a lot of another material is refused, naming the line', () => {
    const f = fixture(); const c = addCotton(f);
    const r = send(f, { rows: [rowOf(f, { lengthCm: 100, count: 1 }, { sourceLotId: c.lot.ID })] });
    assert.ok(!r.success && /Line 1: lot W1 belongs to a different material/.test(r.error), r.error);
});

test('S12 fractional / zero-count / negative-rate lines refused', () => {
    const f = fixture();
    assert.ok(/whole number/.test(send(f, { lines: [{ lengthCm: 300, count: 2.5 }] }).error));
    assert.ok(/piece length/.test(send(f, { lines: [{ lengthCm: 0, count: 3 }] }).error));
    assert.ok(/cannot be negative/.test(send(f, { lines: [{ lengthCm: 300, count: 3, rate: -1 }] }).error));
    assert.strictEqual(f.W.jobs.length, 0);
});

test('S13 Source_Rolls records what was cut', () => {
    const f = fixture();
    const r = send(f);
    const job = byId(f.W.jobs, r.jobId)[0];
    assert.deepStrictEqual(job.Source_Rolls.map(x => [x.Roll_Label, x.Metres]), [['L1-R1', 8], ['L1-R2', 12]]);
});

test('S14 each row keeps its own rate on the job\'s Send_Lines', () => {
    const f = fixture();
    send(f, { lines: [{ lengthCm: 550, count: 2, rate: 175 }, { lengthCm: 275, count: 4, rate: 90 }] });
    assert.deepStrictEqual(f.W.jobs[0].Send_Lines.map(l => [l.Piece_Length_Cm, l.Piece_Count, l.Rate]),
        [[550, 2, 175], [275, 4, 90]]);
});

// ===========================================================================
// TESTS — a job order: rows become jobs by (lot, state, print fabric)
// ===========================================================================
console.log('\nsendToPrint — job orders');

test('M1 two designs off one lot -> two jobs, numbered in order, one batch', () => {
    const f = fixture(); const floral = addFloral(f);
    const r = send(f, { rows: [ rowOf(f, { lengthCm: 550, count: 5, rate: 175 }),
                                rowOf(f, { lengthCm: 550, count: 5, rate: 175 }, { targetMaterialId: floral.ID }) ] });
    assert.ok(r.success, r.error);
    assert.deepStrictEqual(r.jobs.map(j => j.jobNo), ['PJ-00001', 'PJ-00002']);
    assert.strictEqual(r.batchNo, 'PJ-00001');
    assert.ok(f.W.jobs.every(j => j.Print_Batch === 'PJ-00001'));
    assert.deepStrictEqual(r.jobs.map(j => j.amount), [875, 875]);
});

test('M2 two sizes of ONE design off ONE lot are ONE job with two Send_Lines', () => {
    const f = fixture();
    const r = send(f, { rows: [ rowOf(f, { lengthCm: 550, count: 2, rate: 175 }),
                                rowOf(f, { lengthCm: 275, count: 4, rate: 90 }) ] });
    assert.strictEqual(r.jobs.length, 1);
    assert.strictEqual(f.W.jobs[0].Send_Lines.length, 2);
    assert.strictEqual(r.jobs[0].amount, 710);       // 2x175 + 4x90
});

test('M3 MIXED BASES in one job order: one job per base, each off its own lot, one batch', () => {
    const f = fixture(); const c = addCotton(f);
    const r = send(f, { rows: [
        rowOf(f, { lengthCm: 550, count: 2, rate: 175 }),                                         // 11 m washed off L1
        rowOf(f, { lengthCm: 275, count: 4, rate: 90 },
              { sourceMaterialId: c.base.ID, sourceLotId: c.lot.ID, sourceState: 'Unwash', targetMaterialId: c.stripes.ID })  // 11 m unwashed off W1
    ] });
    assert.ok(r.success, r.error);
    assert.deepStrictEqual(r.jobs.map(j => [j.sourceSku, j.lotNumber, j.state, j.sku]),
        [['RM-001', 'L1', 'Wash', 'RM-100'], ['RM-002', 'W1', 'Unwash', 'RM-103']]);
    assert.ok(f.W.jobs.every(j => j.Print_Batch === r.batchNo));
    assert.strictEqual(f.srcLot.Wash_Quantity, 89);
    assert.strictEqual(c.lot.Unwash_Quantity, 19);
    assert.strictEqual(c.base.In_Print_Qty, 11);
    assert.strictEqual(f.W.jobs[1].Source_Rolls[0].Roll_Label, 'W1-R1');
    assert.strictEqual(rollSum(f.W, c.lot.ID), shelf(c.lot));
});

test('M4 washed AND unwashed off one lot: two jobs, budgets per state, ONE roll plan for the lot', () => {
    const f = fixture();   // L1: 100 washed, 20 unwashed, rolls 8 / 42 / 70
    const r = send(f, { rows: [ rowOf(f, { lengthCm: 1000, count: 1 }),                          // 10 washed
                                rowOf(f, { lengthCm: 500, count: 1 }, { sourceState: 'Unwash' }) ] });  // 5 unwashed
    assert.ok(r.success, r.error);
    assert.strictEqual(r.jobs.length, 2);
    assert.strictEqual(f.srcLot.Wash_Quantity, 90);
    assert.strictEqual(f.srcLot.Unwash_Quantity, 15);
    assert.deepStrictEqual(r.cuts.map(c => [c.label, c.metres]), [['L1-R1', 8], ['L1-R2', 7]]);
    assert.deepStrictEqual(f.W.jobs[0].Source_Rolls.map(x => [x.Roll_Label, x.Metres]), [['L1-R1', 8], ['L1-R2', 2]]);
    assert.deepStrictEqual(f.W.jobs[1].Source_Rolls.map(x => [x.Roll_Label, x.Metres]), [['L1-R2', 5]]);
    assert.strictEqual(rollSum(f.W, f.srcLot.ID), shelf(f.srcLot));
});

test('M5 the budget is per lot+state over ALL rows: rows that fit alone but not together are refused', () => {
    const f = fixture({ lotWash: 50, wash: 50 }); const floral = addFloral(f);
    const r = send(f, { rows: [ rowOf(f, { lengthCm: 550, count: 5 }),
                                rowOf(f, { lengthCm: 550, count: 5 }, { targetMaterialId: floral.ID }) ] });   // 55 > 50
    assert.ok(!r.success);
    assert.ok(/has only 50 Mtr washed - this job order needs 55/.test(r.error), r.error);
});

test('M6 a bad LAST row leaves every earlier row unsent', () => {
    const f = fixture(); const c = addCotton(f);
    const wide = addMat(f.W, { SKU: 'RM-109', Fabric_Width_Inches: '90' });
    const r = send(f, { rows: [ rowOf(f, { lengthCm: 550, count: 2 }),
                                rowOf(f, { lengthCm: 275, count: 4 }, { sourceMaterialId: c.base.ID, sourceLotId: c.lot.ID,
                                      sourceState: 'Unwash', targetMaterialId: wide.ID }) ] });
    assert.ok(!r.success && /Line 2: width mismatch/.test(r.error), r.error);
    assert.strictEqual(f.W.jobs.length, 0);
    assert.strictEqual(f.srcLot.Wash_Quantity, 100);
    assert.strictEqual(lotRolls(f.W, f.srcLot.ID).find(x => x.Roll_Label === 'L1-R1').Roll_Length, 8);
});

test('M7 numbering continues from the jobs already on file', () => {
    const f = fixture(); const floral = addFloral(f);
    send(f, { lines: [{ lengthCm: 100, count: 1 }] });      // PJ-00001
    const r = send(f, { rows: [ rowOf(f, { lengthCm: 100, count: 1 }),
                                rowOf(f, { lengthCm: 100, count: 1 }, { targetMaterialId: floral.ID }) ] });
    assert.deepStrictEqual(r.jobs.map(j => j.jobNo), ['PJ-00002', 'PJ-00003']);
    assert.strictEqual(r.batchNo, 'PJ-00002');
});

test('M8 cancelling ONE job of a job order returns only its own metres', () => {
    const f = fixture(); const floral = addFloral(f);
    send(f, { rows: [ rowOf(f, { lengthCm: 550, count: 5 }),
                      rowOf(f, { lengthCm: 550, count: 5 }, { targetMaterialId: floral.ID }) ] });
    const c = cancelPrintJob(f.W, { jobId: f.W.jobs[1].ID, reason: 'unprinted' });
    assert.ok(c.success, c.error);
    assert.strictEqual(c.metres, 27.5);
    assert.strictEqual(f.srcLot.In_Print_Qty, 27.5);
    assert.strictEqual(f.W.jobs[0].Job_Status, 'At_Printer');
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
