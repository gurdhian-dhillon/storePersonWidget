#!/usr/bin/env node
// The OFFCUT ledger - the one part of the issue flow nothing else in tools/
// covers. deluge-maths ports the CREDIT arithmetic and pipeline drives the real
// allocator against it, but the movement records around it were untested:
//
//   issueWaste       deluge/issueMaterials.dg:432-555   (pick validation + yields)
//                    deluge/issueMaterials.dg:1040-1069 (Piece_Count -> In_Transit)
//                    deluge/issueMaterials.dg:1883-2006 (fan credit + Issued movements)
//   recvWasteMv      deluge/receiveMaterials.dg:791-930 (receipt children + disputes)
//   itemReady        deluge/receiveMaterials.dg:1355-1422 (the readiness gate)
//   declareWaste     deluge/saveWasteFromCutting.dg     (the post-cutting return)
//
// The ports mirror the .dg files block for block - same guards, same caps, same
// clamps - so a failure here names a real Deluge line. Tests marked GAP-DOC pin
// CURRENT behaviour that is deliberate-but-lossy, so the suite stays green while
// the gap is open and flips the moment it closes.
//
//   usage: node tools/waste-return.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- Deluge semantics ----------------------------------------------------------
function ifnullStr(v, dflt) {
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s === '' ? dflt : s;
}
function dec(v) { const n = parseFloat(ifnullStr(v, '0')); return isNaN(n) ? 0 : n; }
function dFloor(n) { return Math.floor(n); }

// ---- the world -----------------------------------------------------------------
function mkWorld() {
  return { seq: 7000,
           Raw_Material: [], Waste_Master: [], Waste_Movement: [],
           Stage_Log: [], Material_Issue: [], Production_Planning: [],
           disputes: [] };
}
function nid(W) { W.seq += 1; return String(W.seq); }
function byId(rows, id) { return rows.filter(r => String(r.ID) === String(id)); }

function addMat(W, sku, name) {
  const rec = { ID: nid(W), SKU: sku, Material_Display_Name: name || '', Name: name || '' };
  W.Raw_Material.push(rec); return rec;
}
function addWastePiece(W, o) {
  const rec = Object.assign({
    ID: nid(W), SKU: '', Piece_Width: 40, Piece_Length: 165, Piece_Count: 3,
    In_Transit_Count: 0, Disputed_Count: 0, Status: 'Available', Lot: '',
  }, o || {});
  W.Waste_Master.push(rec); return rec;
}
function addStageLog(W, planItemId, phaseName, operator) {
  const rec = { ID: nid(W), Plan_Item: String(planItemId), Phase_Name: phaseName,
                Operator: operator === undefined ? null : operator };
  W.Stage_Log.push(rec); return rec;
}
function addPlan(W, id, supId, startDate) {
  W.Production_Planning.push({ ID: String(id), Assigned_To: supId,
                               Plan_Start_Date: startDate === undefined ? '2026-08-01' : startDate });
}

// ===============================================================================
// PORT: issueMaterials pick validation + credit + Issued movements
// ===============================================================================
function issueWaste(W, opts) {
  // opts: matId, matName, cutW, cutL, isFab, picks, rows
  // rows are in FAN ORDER (plan order, oldest first): {id, planId, pin,
  // requiredPieces, fromWaste, fromRaw}
  const res = { errors: [], movements: [] };
  let pickErr = '';

  // ---- validation (:432-555). FIRST fault wins; the gate at :983 refuses. ----
  const pkW = {}, pkL = {}, pkYield = {};
  let piecesFromWaste = 0, wFree = 0;
  const wPinTot = {};
  for (const pkRaw of opts.picks) {
    if (pickErr !== '') continue;                       // no break in Deluge
    const wId = ifnullStr(pkRaw.wasteId, '');
    const wantPcs = dFloor(dec(ifnullStr(pkRaw.pieces, '0')));
    const recs = byId(W.Waste_Master, wId);
    if (wId === '' || recs.length === 0) pickErr = opts.matName + ': waste piece ' + wId + ' not found';
    else {
      const w = recs[0];
      const havePcs = dFloor(dec(w.Piece_Count));
      if (String(w.Status) !== 'Available') pickErr = opts.matName + ': waste piece ' + wId + ' is no longer available';
      else if (ifnullStr(w.SKU, '') !== String(opts.matId)) pickErr = opts.matName + ': waste piece ' + wId + ' belongs to a different material';
      else if (wantPcs <= 0 || wantPcs > havePcs) pickErr = opts.matName + ': asked ' + wantPcs + ' waste pieces but only ' + havePcs + ' left';
      else {
        // yieldPer (:520-532): grain-fixed, ZERO when the remnant cannot take
        // the cut. Still issued physically - credited 0.
        let yieldPer = 1;
        if (opts.isFab && opts.cutW > 0 && opts.cutL > 0) {
          yieldPer = 0;
          if (dec(w.Piece_Width) >= opts.cutW && dec(w.Piece_Length) >= opts.cutL) {
            yieldPer = dFloor(dec(w.Piece_Width) / opts.cutW) * dFloor(dec(w.Piece_Length) / opts.cutL);
          }
        }
        piecesFromWaste += wantPcs * yieldPer;
        const pin = ifnullStr(pkRaw.planItemId, '');
        if (pin === '') wFree += wantPcs * yieldPer;
        else wPinTot[pin] = (wPinTot[pin] || 0) + wantPcs * yieldPer;
        pkW[wId] = dec(w.Piece_Width);
        pkL[wId] = dec(w.Piece_Length);
        pkYield[wId] = yieldPer;
      }
    }
  }
  if (pickErr !== '') { res.errors.push(pickErr); return res; }   // gate :983

  // ---- stock move (:1040-1069): off the rack, into transit, Issued when empty ----
  for (const pkRaw of opts.picks) {
    const takePcs = dFloor(dec(ifnullStr(pkRaw.pieces, '0')));
    for (const wRec of byId(W.Waste_Master, String(pkRaw.wasteId))) {
      const leftPcs = dFloor(dec(wRec.Piece_Count)) - takePcs;
      wRec.Piece_Count = leftPcs;
      wRec.In_Transit_Count = dFloor(dec(wRec.In_Transit_Count)) + takePcs;
      if (leftPcs <= 0) wRec.Status = 'Issued';
    }
  }

  // ---- the fan (:1883-2006), with the movement-once guard OUTSIDE the passes ----
  let wasteLogged = false;
  let fanWaste = piecesFromWaste;
  for (const row of opts.rows) {
    if (fanWaste <= 0) break;                          // fanWaste exhausted
    const pRem2 = row.requiredPieces - (row.fromWaste + row.fromRaw);
    if (pRem2 <= 0) continue;
    const rowPin = ifnullStr(row.pin, '');
    const pinHave = wPinTot[rowPin] || 0;
    let giveW = wFree + pinHave;
    if (giveW > fanWaste) giveW = fanWaste;
    if (giveW > pRem2) giveW = pRem2;
    if (giveW > 0) {
      row.fromWaste += giveW;
      fanWaste -= giveW;
      const useP = Math.min(giveW, pinHave);
      if (useP > 0) wPinTot[rowPin] = pinHave - useP;
      wFree = Math.max(0, wFree - (giveW - useP));
      // THE MOVEMENTS: once per press, on the FIRST row that took credit, full
      // pick counts regardless of which row absorbed them (:1950-1994).
      if (wasteLogged === false) {
        wasteLogged = true;
        for (const pkRaw of opts.picks) {
          const wId3 = ifnullStr(pkRaw.wasteId, '');
          const nPcs3 = dFloor(dec(ifnullStr(pkRaw.pieces, '0')));
          if (nPcs3 > 0 && pkYield[wId3] !== undefined) {
            const mv = { ID: nid(W), Movement_Type: 'Issued',
                         Piece_Width: pkW[wId3], Piece_Length: pkL[wId3],
                         Piece_Count: nPcs3,
                         Pieces_Yielded: nPcs3 * pkYield[wId3],
                         Waste_Piece: wId3,
                         Plan: String(row.planId), Plan_Item: String(row.pin),
                         Parent_Movement: '' };
            W.Waste_Movement.push(mv);
            res.movements.push(mv);
          }
        }
      }
    }
  }
  return res;
}

// ===============================================================================
// PORT: receiveMaterials waste receipt (:791-930)
// ===============================================================================
function recvWasteMv(W, rowId, gotPcs, openDispWP) {
  const out = { found: false, taken: 0, disputed: 0 };
  for (const wi of byId(W.Waste_Movement, String(rowId))) {
    if (wi.Movement_Type !== 'Issued') continue;
    out.found = true;
    const issuedW = dec(wi.Piece_Count);
    let alreadyW = 0;
    for (const rv of W.Waste_Movement.filter(m => String(m.Parent_Movement) === String(wi.ID) && m.Movement_Type === 'Received')) {
      alreadyW += dec(rv.Piece_Count);
    }
    let takePcs = gotPcs;
    if (alreadyW + takePcs > issuedW) takePcs = issuedW - alreadyW;
    if (takePcs < 0) takePcs = 0;
    if (takePcs > 0) {
      W.Waste_Movement.push({ ID: nid(W), Movement_Type: 'Received',
                              Piece_Count: takePcs, Parent_Movement: String(wi.ID),
                              Waste_Piece: wi.Waste_Piece, Plan: wi.Plan, Plan_Item: wi.Plan_Item });
    }
    let stillOut = issuedW - (alreadyW + takePcs);
    if (stillOut < 0) stillOut = 0;

    // Net off disputes already open for this waste piece (:876-887).
    const wKeyF = String(wi.Waste_Piece);
    const dispLeft = openDispWP[wKeyF];
    if (dispLeft !== undefined && dispLeft > 0 && stillOut > 0) {
      const takeOff = Math.min(dispLeft, stillOut);
      stillOut -= takeOff;
      openDispWP[wKeyF] = dispLeft - takeOff;
    }

    for (const wmStock of byId(W.Waste_Master, String(wi.Waste_Piece))) {
      const witCount = dFloor(dec(wmStock.In_Transit_Count));
      const wdispCount = dFloor(dec(wmStock.Disputed_Count));
      let settlePcs = takePcs + stillOut;
      if (settlePcs > witCount) settlePcs = witCount;
      wmStock.In_Transit_Count = witCount - settlePcs;
      if (stillOut > 0) wmStock.Disputed_Count = wdispCount + stillOut;
      if (dec(wmStock.Piece_Count) <= 0 && (witCount - settlePcs) <= 0 && (wdispCount + stillOut) <= 0) {
        wmStock.Status = 'Consumed';
      }
    }
    if (stillOut > 0) W.disputes.push({ wastePiece: wi.Waste_Piece, disputed: stillOut });
    out.taken = takePcs;
    out.disputed = stillOut;
    break;
  }
  return out;
}

// ===============================================================================
// PORT: the readiness gate (:1355-1422)
// ===============================================================================
function itemReady(W, itemId) {
  const rows = W.reqs.filter(r => String(r.item) === String(itemId));
  if (rows.length === 0) return false;
  for (const row of rows) {
    if (row.received < row.issued) return false;
    if (row.isFab) {
      if (row.requiredPieces <= 0 || (row.fromWaste + row.fromRaw) < row.requiredPieces) return false;
    } else {
      if (row.requiredQty <= 0 || row.issued < row.requiredQty) return false;
    }
  }
  for (const wi of W.Waste_Movement.filter(m => m.Movement_Type === 'Issued' && String(m.Plan_Item) === String(itemId))) {
    let wRecv = 0;
    for (const rv of W.Waste_Movement.filter(m => String(m.Parent_Movement) === String(wi.ID) && m.Movement_Type === 'Received')) {
      wRecv += dec(rv.Piece_Count);
    }
    if (wRecv < dec(wi.Piece_Count)) return false;
  }
  return true;
}

// ===============================================================================
// PORT: saveWasteFromCutting (whole file)
// ===============================================================================
function declareWaste(W, planId, planItemId, phaseName, piecesJson) {
  const res = { errors: [], kept: 0, scrapped: 0, unlotted: 0, duplicate: false };
  try {
    const itemIdStr = ifnullStr(planItemId, '');
    const phName = ifnullStr(phaseName, '');

    // Lot provenance (:62-133): supervisor-scoped handover scan, first lot wins,
    // two distinct lots -> ambiguous, provenance left blank.
    const lotForMat = {}; const ambigMat = [];
    let wSupId = 0, wPlanStart = null;
    for (const wp of W.Production_Planning.filter(p => String(p.ID) === String(planId))) {
      wSupId = wp.Assigned_To || 0;
      wPlanStart = wp.Plan_Start_Date === undefined ? null : wp.Plan_Start_Date;
    }
    if (wSupId !== 0 && itemIdStr !== '') {
      const issues = W.Material_Issue.filter(i => String(i.Issued_To) === String(wSupId) &&
        (wPlanStart === null || i.Issue_Date >= wPlanStart));
      for (const wIss of issues) {
        for (const wLn of wIss.lines) {
          if (ifnullStr(wLn.Plan_Item, '') === itemIdStr) {
            const lnMatW = ifnullStr(wLn.Material, ''), lnLotW = ifnullStr(wLn.Lot, '');
            if (lnMatW !== '' && lnLotW !== '') {
              const prev = lotForMat[lnMatW] || '';
              if (prev === '') lotForMat[lnMatW] = lnLotW;
              else if (prev !== lnLotW && !ambigMat.includes(lnMatW)) ambigMat.push(lnMatW);
            }
          }
        }
      }
    }

    let stageId = 0, stageOperator = null;
    if (itemIdStr !== '' && phName !== '') {
      for (const sl of W.Stage_Log.filter(s => String(s.Plan_Item) === itemIdStr && s.Phase_Name === phName)) {
        stageId = sl.ID; stageOperator = sl.Operator;
      }
    }
    if (stageId !== 0 && W.Waste_Movement.some(m => String(m.Stage_Log) === String(stageId))) res.duplicate = true;

    if (res.duplicate === false) {
      let rowNo = 0;
      for (const pcRaw of piecesJson) {
        rowNo += 1;
        const skuId = ifnullStr(pcRaw.sku, '');
        const pw = dec(pcRaw.width), pl = dec(pcRaw.length), pc = dFloor(dec(pcRaw.count));
        const keepFlag = ifnullStr(pcRaw.keep, 'false').trim().toLowerCase();
        const remarks = ifnullStr(pcRaw.remarks, '');

        let pieceLot = ifnullStr(pcRaw.lotId, '');
        if (pieceLot === '' && !ambigMat.includes(skuId)) pieceLot = lotForMat[skuId] || '';

        const matRecs = byId(W.Raw_Material, skuId);
        if (skuId === '' || matRecs.length === 0) {
          res.errors.push('Row ' + rowNo + ': material ' + skuId + ' not found');
        } else if (pw <= 0 || pl <= 0 || pc <= 0) {
          res.errors.push('Row ' + rowNo + ': width, length and count must all be greater than zero');
        } else {
          const newStatus = keepFlag === 'true' ? 'Pending_Receipt' : 'Scrapped';
          const moveType = keepFlag === 'true' ? 'Declared' : 'Scrapped';
          const wr = { ID: nid(W), SKU: skuId, Piece_Width: pw, Piece_Length: pl,
                       Piece_Count: pc, Status: newStatus, Remarks: remarks,
                       In_Transit_Count: 0, Disputed_Count: 0, Lot: '',
                       Stage_Log: '' };
          if (pieceLot !== '') wr.Lot = pieceLot;
          W.Waste_Master.push(wr);
          if (pieceLot === '') res.unlotted += 1;

          const mv = { ID: nid(W), Movement_Type: moveType, Piece_Width: pw,
                       Piece_Length: pl, Piece_Count: pc, Remarks: remarks,
                       Waste_Piece: wr.ID, Plan: String(planId), Plan_Item: itemIdStr,
                       Stage_Log: stageId !== 0 ? stageId : '', Moved_By: stageOperator,
                       Parent_Movement: '' };
          if (stageId === 0) mv.Stage_Log = '';
          W.Waste_Movement.push(mv);

          if (newStatus === 'Pending_Receipt') res.kept += 1; else res.scrapped += 1;
        }
      }
    }
  } catch (e) {
    return { errors: ['DELUGE: ' + e.message], kept: 0, scrapped: 0, unlotted: 0, duplicate: false };
  }
  return res;
}

// ===============================================================================
// fixtures
// ===============================================================================
function fixture() {
  const W = mkWorld();
  W.mat = addMat(W, 'RM-00112', 'Grey Sheeting / Plain / Grey');
  addPlan(W, 'PLAN1', 'SUP-A', '2026-08-01');
  return W;
}
// A 55x55 cut off 137.16 cm cloth: 2 across. A 40x165 remnant yields
// floor(40/55)=0 -> ZERO. A 120x170 remnant yields 2*3=6.
const CUT = { cutW: 55, cutL: 55 };

function reqRow(over) {
  return Object.assign({ id: 'R1', planId: 'PLAN1', item: 'IT1', pin: '',
                         requiredPieces: 10, requiredQty: 2.75, isFab: true,
                         issued: 0, received: 0, fromWaste: 0, fromRaw: 0 }, over || {});
}

console.log('\nissue-side: validation, credit, movements');

test('GAP-DOC I1 an ALL-ZERO-YIELD handover moves the cloth to In_Transit_Count but writes NO movement - nothing can ever receipt it', () => {
  // issueMaterials.dg:1912 - giveW = min(pool, fanWaste=0, ...) = 0 skips the
  // whole credit AND movement block, while :1040-1069 has ALREADY decremented
  // Piece_Count and raised In_Transit_Count. The remnant is physically gone,
  // sits in transit for ever (getWastePendingReceipt lists movements; there is
  // none), and nothing is credited - the recoverable direction, but the
  // counters are stuck. Unreachable through the widget (remnantYield returns 0
  // and the scorer skips it); reachable from anywhere, because Custom API.
  const W = fixture();
  const small = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 40, Piece_Length: 165, Piece_Count: 2 });
  const rows = [reqRow()];
  const r = issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: small.ID, pieces: 2 }], rows }));
  assert.strictEqual(r.errors.length, 0, r.errors.join(';'));
  assert.strictEqual(rows[0].fromWaste, 0, 'floor(40/55)=0 across - no credit');
  assert.strictEqual(small.Piece_Count, 0, 'the cloth really left the rack');
  assert.strictEqual(small.In_Transit_Count, 2);
  assert.strictEqual(small.Status, 'Issued');
  assert.strictEqual(r.movements.length, 0, 'CURRENT behaviour - no movement, so no receipt path exists');
});

test('I1b a MIXED handover (one zero-yield pick beside a good one) still logs BOTH remnants', () => {
  // The movement loop walks every pick, guarded only by pkYield != null - the
  // zero-yield remnant is logged with Pieces_Yielded = 0 once any row takes
  // credit. Only the all-zero case above falls down the hole.
  const W = fixture();
  const small = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 40, Piece_Length: 165, Piece_Count: 1 });
  const big = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 120, Piece_Length: 170, Piece_Count: 1 });
  const rows = [reqRow({ requiredPieces: 10 })];
  const r = issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: small.ID, pieces: 1 }, { wasteId: big.ID, pieces: 1 }], rows }));
  assert.strictEqual(rows[0].fromWaste, 6);
  assert.strictEqual(r.movements.length, 2);
  const zero = r.movements.find(m => String(m.Waste_Piece) === String(small.ID));
  assert.strictEqual(zero.Pieces_Yielded, 0, 'on the record as handed over, credited nothing');
});

test('I2 yield is grain-fixed: 120x170 gives 2 across x 3 along = 6 cuts per piece', () => {
  const W = fixture();
  const big = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 120, Piece_Length: 170, Piece_Count: 1 });
  const rows = [reqRow({ requiredPieces: 20 })];
  issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: big.ID, pieces: 1 }], rows }));
  assert.strictEqual(rows[0].fromWaste, 6);
  assert.strictEqual(big.Status, 'Issued');
});

test('I3 every refusal fires before anything moves', () => {
  const W = fixture();
  const gone = addWastePiece(W, { SKU: W.mat.ID, Status: 'Consumed' });
  const foreign = addWastePiece(W, { SKU: 'OTHER' });
  const short = addWastePiece(W, { SKU: W.mat.ID, Piece_Count: 1 });
  const a = issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: '99999', pieces: 1 }], rows: [reqRow()] }));
  assert.ok(/not found/.test(a.errors[0]));
  const b = issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: gone.ID, pieces: 1 }], rows: [reqRow()] }));
  assert.ok(/no longer available/.test(b.errors[0]));
  const c = issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: foreign.ID, pieces: 1 }], rows: [reqRow()] }));
  assert.ok(/different material/.test(c.errors[0]));
  const d = issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: short.ID, pieces: 3 }], rows: [reqRow()] }));
  assert.ok(/only 1 left/.test(d.errors[0]));
  assert.strictEqual(W.Waste_Movement.length, 0, 'nothing written behind a refusal');
});

test('I4 movements are written ONCE PER PRESS even when the fan spans two plans, stamped to the FIRST plan that took credit', () => {
  const W = fixture();
  addPlan(W, 'PLAN2', 'SUP-A', '2026-08-02');
  const rem = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 120, Piece_Length: 170, Piece_Count: 2 });
  // Two plans, one row each; the remnant's 12 cuts serve both.
  const rows = [reqRow({ id: 'R1', planId: 'PLAN1', requiredPieces: 8 }),
                reqRow({ id: 'R2', planId: 'PLAN2', requiredPieces: 8 })];
  const r = issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: rem.ID, pieces: 2 }], rows }));
  assert.strictEqual(r.movements.length, 1, 'ONE movement set, not one per plan');
  assert.strictEqual(String(r.movements[0].Plan), 'PLAN1', 'stamped to the first plan');
  assert.strictEqual(r.movements[0].Piece_Count, 2, 'FULL pick count, not the per-row share');
  assert.strictEqual(rows[0].fromWaste, 8);
  assert.strictEqual(rows[1].fromWaste, 4, 'the remainder spilled to the second plan');
});

test('I5 a PINNED pick serves its own item even when an earlier unpinned row is needier', () => {
  const W = fixture();
  const rem = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 120, Piece_Length: 170, Piece_Count: 1 });
  const rows = [reqRow({ id: 'R1', item: 'IT1', pin: '', requiredPieces: 10 }),
                reqRow({ id: 'R2', item: 'IT2', pin: 'IT2', requiredPieces: 4 })];
  issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: rem.ID, pieces: 1, planItemId: 'IT2' }], rows }));
  // giveW is capped by what the row OWES (pRem2): the remnant yields 6 cuts but
  // IT2 needs only 4 - the surplus 2 go with him physically and become waste
  // again after cutting (:557). The unpinned row drew nothing: the free pool
  // was empty and a pinned pick is not on offer to it.
  assert.strictEqual(rows[1].fromWaste, 4);
  assert.strictEqual(rows[0].fromWaste, 0);
});

test('I6 pinned picks are spent BEFORE the free pool', () => {
  const W = fixture();
  const pinned = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 120, Piece_Length: 170, Piece_Count: 1 });
  const loose = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 120, Piece_Length: 170, Piece_Count: 1 });
  const rows = [reqRow({ id: 'R1', item: 'IT1', pin: 'IT1', requiredPieces: 10 })];
  issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: pinned.ID, pieces: 1, planItemId: 'IT1' },
            { wasteId: loose.ID, pieces: 1 }],
    rows }));
  assert.strictEqual(rows[0].fromWaste, 10, 'capped at what the row owes (10 of 12)');
  // Both movements exist; the press handed both remnants over.
  assert.strictEqual(W.Waste_Movement.length, 2);
});

console.log('\nreceive-side: receipts, disputes, readiness');

function receivedFixture() {
  const W = fixture();
  const rem = addWastePiece(W, { SKU: W.mat.ID, Piece_Width: 120, Piece_Length: 170, Piece_Count: 2 });
  const rows = [reqRow({ requiredPieces: 10, issued: 2.75, received: 2.75, fromRaw: 4 })];
  issueWaste(W, Object.assign({}, CUT, { matId: W.mat.ID, matName: 'G', isFab: true,
    picks: [{ wasteId: rem.ID, pieces: 2 }], rows }));
  W.reqs = rows;                                     // the readiness gate reads these
  return { W, rem, rows };
}

test('R1 a full receipt closes the movement and settles ALL the transit - the whole pending amount leaves either way', () => {
  const { W, rem } = receivedFixture();
  const mv = W.Waste_Movement[0];
  recvWasteMv(W, mv.ID, 1, {});                      // half confirmed
  assert.strictEqual(rem.In_Transit_Count, 0, 'confirmed + disputed BOTH leave transit (:500)');
  assert.strictEqual(rem.Disputed_Count, 1);
  recvWasteMv(W, mv.ID, 1, {});
  assert.strictEqual(rem.In_Transit_Count, 0);
});

test('R2 the readiness gate demands metres AND pieces AND every movement receipted', () => {
  const { W } = receivedFixture();
  const mv = W.Waste_Movement[0];
  // Pieces complete, movement NOT yet receipted -> not ready.
  assert.strictEqual(itemReady(W, 'IT1'), false, 'offcut movement unreceived');
  recvWasteMv(W, mv.ID, 2, {});
  assert.strictEqual(itemReady(W, 'IT1'), true, 'metres settled, pieces complete, remnants confirmed');
  // Now break ONLY the metres: the gate reads row by row.
  W.reqs[0].received = 2.00;
  assert.strictEqual(itemReady(W, 'IT1'), false);
});

test('R3 a SHORT receipt disputes only the remainder, and a re-run cannot double it', () => {
  const { W, rem } = receivedFixture();
  const mv = W.Waste_Movement[0];
  const disp = {};
  recvWasteMv(W, mv.ID, 1, disp);
  assert.strictEqual(W.disputes.length, 1);
  assert.strictEqual(W.disputes[0].disputed, 1);
  assert.strictEqual(rem.Disputed_Count, 1);
  // Second receipt brings the rest: no new dispute for the already-disputed piece.
  recvWasteMv(W, mv.ID, 1, disp);
  assert.strictEqual(W.disputes.length, 1, 'dispute netting held');
  assert.strictEqual(rem.In_Transit_Count, 0);
  assert.strictEqual(rem.Disputed_Count, 1);
});

test('R4 an over-receipt caps at what went out and never invents pieces', () => {
  const { W, rem } = receivedFixture();
  recvWasteMv(W, W.Waste_Movement[0].ID, 99, {});
  assert.strictEqual(rem.In_Transit_Count, 0);
  assert.strictEqual(rem.Disputed_Count, 0);
  assert.strictEqual(W.disputes.length, 0);
});

test('R5 CONSUMED only when everything is settled and nothing is left anywhere', () => {
  const a = receivedFixture();
  recvWasteMv(a.W, a.W.Waste_Movement[0].ID, 2, {});          // all confirmed
  assert.strictEqual(a.rem.Status, 'Consumed');
  assert.strictEqual(a.rem.Piece_Count, 0);

  const g = receivedFixture();                                // nothing confirmed
  recvWasteMv(g.W, g.W.Waste_Movement[0].ID, 0, {});
  assert.strictEqual(g.rem.Disputed_Count, 2);
  assert.strictEqual(g.rem.Status, 'Issued', 'disputed cloth is owned but not consumed');
});

console.log('\nreturn side: saveWasteFromCutting');

function declaredFixture() {
  const W = fixture();
  // One handover to SUP-A carrying lines for item IT1 off LOT9 (one line) -
  // the only place a remnant's provenance can come from.
  W.Material_Issue.push({ ID: nid(W), Issued_To: 'SUP-A', Issue_Date: '2026-08-03',
    lines: [
      { Plan_Item: 'IT1', Material: W.mat.ID, Lot: 'LOT9' },
      { Plan_Item: 'IT1', Material: W.mat.ID, Lot: 'LOT9' },
    ] });
  addStageLog(W, 'IT1', 'Cutting', 'OP-7');
  return W;
}

test('W1 kept rows land Pending_Receipt with a Declared movement; discarded rows are STILL WRITTEN as Scrapped', () => {
  const W = declaredFixture();
  const r = declareWaste(W, 'PLAN1', 'IT1', 'Cutting', [
    { sku: W.mat.ID, width: 40, length: 165, count: 1, keep: true, remarks: '' },
    { sku: W.mat.ID, width: 30, length: 90, count: 2, keep: false, remarks: 'too narrow' },
  ]);
  assert.strictEqual(r.errors.length, 0, r.errors.join(';'));
  assert.strictEqual(r.kept, 1);
  assert.strictEqual(r.scrapped, 1);
  const kept = W.Waste_Master.filter(x => x.Status === 'Pending_Receipt')[0];
  const scrapped = W.Waste_Master.filter(x => x.Status === 'Scrapped')[0];
  assert.ok(kept && scrapped, 'both rows exist');
  assert.strictEqual(scrapped.Remarks, 'too narrow', 'scrap stays reportable, not vanished');
  const types = W.Waste_Movement.map(m => m.Movement_Type).sort();
  assert.deepStrictEqual(types, ['Declared', 'Scrapped']);
});

test('W2 provenance: single lot derived from the handover, payload lotId wins, TWO lots means blank and counted', () => {
  const W = declaredFixture();
  let r = declareWaste(W, 'PLAN1', 'IT1', 'Cutting', [{ sku: W.mat.ID, width: 40, length: 165, count: 1, keep: true }]);
  assert.strictEqual(W.Waste_Master[0].Lot, 'LOT9', 'derived from the issue line');

  const g = declaredFixture();
  r = declareWaste(g, 'PLAN1', 'IT1', 'Cutting', [{ sku: g.mat.ID, width: 40, length: 165, count: 1, keep: true, lotId: 'LOT77' }]);
  assert.strictEqual(g.Waste_Master[0].Lot, 'LOT77', 'he said which roll; that wins');

  const a = declaredFixture();
  a.Material_Issue[0].lines[1].Lot = 'LOT10';      // second line, different lot
  r = declareWaste(a, 'PLAN1', 'IT1', 'Cutting', [{ sku: a.mat.ID, width: 40, length: 165, count: 1, keep: true }]);
  assert.strictEqual(a.Waste_Master[0].Lot, '', 'ambiguous - blank beats a lie');
  assert.strictEqual(r.unlotted, 1, 'and the gap is counted, not hidden');
});

test('W3 a retried stage is REFUSED as a duplicate - not silently declared twice', () => {
  const W = declaredFixture();
  declareWaste(W, 'PLAN1', 'IT1', 'Cutting', [{ sku: W.mat.ID, width: 40, length: 165, count: 1, keep: true }]);
  const before = W.Waste_Master.length;
  const r = declareWaste(W, 'PLAN1', 'IT1', 'Cutting', [{ sku: W.mat.ID, width: 50, length: 100, count: 1, keep: true }]);
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(W.Waste_Master.length, before, 'no second set of remnants');
});

test('W4 a bad row is reported and the GOOD rows around it still land', () => {
  const W = declaredFixture();
  const r = declareWaste(W, 'PLAN1', 'IT1', 'Cutting', [
    { sku: 'NOSUCH', width: 40, length: 165, count: 1, keep: true },
    { sku: W.mat.ID, width: 0, length: 100, count: 1, keep: true },
    { sku: W.mat.ID, width: 60, length: 200, count: 1, keep: true },
  ]);
  assert.strictEqual(r.errors.length, 2);
  assert.ok(/Row 1: material NOSUCH not found/.test(r.errors[0]));
  assert.ok(/Row 2: width, length and count/.test(r.errors[1]));
  assert.strictEqual(r.kept, 1, 'row 3 was fine and is not punished for its neighbours');
});

test('W5 the declaration carries the stage link - the same key the duplicate test reads', () => {
  const W = declaredFixture();
  declareWaste(W, 'PLAN1', 'IT1', 'Cutting', [{ sku: W.mat.ID, width: 40, length: 165, count: 1, keep: true }]);
  const mv = W.Waste_Movement[0];
  const stage = W.Stage_Log[0];
  assert.strictEqual(String(mv.Stage_Log), String(stage.ID));
  assert.strictEqual(mv.Moved_By, 'OP-7', 'the operator who cut, not the login');
});

console.log('\nprediction <-> declaration seam');

test('P1 getExpectedWaste maths and saveWasteFromCutting agree on what a remnant IS (same grain-fixed shape)', () => {
  // The prediction emits a side strip (width - across*cutW) x usedLen and a tail
  // (pieceL - along*cutL) full-width. Whatever sizes it names must survive a
  // round trip through the declaration without being "fixed" by either side.
  const fabricWidthCm = 137.16, cutW = 55, cutL = 55;
  const across = Math.floor(fabricWidthCm / cutW);
  const sideW = fabricWidthCm - across * cutW;
  const pieceL = 300;
  const along = Math.floor(pieceL / cutL);
  const usedLen = along * cutL;
  const tail = pieceL - usedLen;
  assert.strictEqual(across, 2);
  approx(sideW, 27.16);
  assert.strictEqual(tail, 25);
  // And the DECLARATION accepts exactly these dimensions back.
  const W = declaredFixture();
  const r = declareWaste(W, 'PLAN1', 'IT1', 'Cutting', [
    { sku: W.mat.ID, width: Math.round(sideW * 100) / 100, length: usedLen, count: 1, keep: true },
    { sku: W.mat.ID, width: fabricWidthCm, length: tail, count: 1, keep: true },
  ]);
  assert.strictEqual(r.errors.length, 0, r.errors.join(';'));
  assert.strictEqual(r.kept, 2);
});

function approx(a, b, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + '+/-' + eps + ', got ' + a);
}

// ---- static contract pins ------------------------------------------------------
console.log('\nstatic contract (deluge text passes)');

const dgPath = f => fs.readFileSync(path.join(__dirname, '..', 'deluge', f), 'utf8');
const ISSUE_DG = dgPath('issueMaterials.dg');
const RECV_DG = dgPath('receiveMaterials.dg');
const DECLARE_DG = dgPath('saveWasteFromCutting.dg');
const READY_DG = RECV_DG;

test('S1 the lot lookup is written by the issuer and read by the receiver under the SAME field', () => {
  assert.ok(/liRow\.Lot\s*=\s*lotTxt\.toLong\(\)/.test(ISSUE_DG),
    'issueMaterials no longer stamps Issue_Lines.Lot - settlement loses its lot');
  assert.ok(/miLn\.Lot\b/.test(RECV_DG),
    'receiveMaterials no longer settles off the line lot');
});

test('S2 the three Waste_Status writers write only documented values - attributed by VARIABLE, not by the bare word Status', () => {
  // Several forms share the link name "Status" (CLAUDE.md), so a blind scan
  // for .Status = " would mix Material_Issue and friends into the check. Each
  // writer is asserted by its own variable instead.
  //   issueMaterials    -> wRec.Status      ("Issued")
  //   receiveMaterials  -> wmStock.Status   ("Consumed")
  //   saveWasteFromCutting -> newStatus     ("Pending_Receipt" / "Scrapped")
  assert.ok(/wRec\.Status\s*=\s*"Issued"/.test(ISSUE_DG));
  assert.ok(!/wRec\.Status\s*=\s*"[^"]*"/.test(ISSUE_DG.replace(/wRec\.Status\s*=\s*"Issued"/g, '')),
    'issueMaterials writes a SECOND Waste_Master status');
  const recvWrites = [...RECV_DG.matchAll(/wmStock\.Status\s*=\s*"([A-Za-z_]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(recvWrites, ['Consumed'],
    'receiveMaterials must consume a remnant and nothing else');
  assert.ok(/newStatus\s*=\s*"Scrapped"/.test(DECLARE_DG) && /newStatus\s*=\s*"Pending_Receipt"/.test(DECLARE_DG),
    'declaration writes Pending_Receipt or Scrapped, nothing else');
});

test('S3 receipts are CHILD MOVEMENTS pointing back via Parent_Movement - both writer and readers agree', () => {
  assert.ok(/Parent_Movement\s*=\s*wi\.ID/.test(RECV_DG), 'receipt child link changed');
  assert.ok(RECV_DG.includes('Movement_Type == "Received"'), 'readiness sums children by type');
  assert.ok(RECV_DG.includes('Movement_Type == "Issued"'), 'readiness walks issued movements by type');
  assert.ok(ISSUE_DG.includes('Movement_Type="Issued"'), 'issuer movement type changed');
  assert.ok(DECLARE_DG.includes('Movement_Type=moveType'), 'declaration movement type changed');
});

// ---- summary -------------------------------------------------------------------

console.log('\n========================================');
console.log('waste-return: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}
