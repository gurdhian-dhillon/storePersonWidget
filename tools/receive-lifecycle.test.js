#!/usr/bin/env node
// LIFECYCLE: plan-time requirement -> widget builds the issue payload ->
// issueMaterials applies it -> widget builds the receive payload ->
// receiveMaterials applies it (SWEEP + phased finalize, both resumable).
//
// Every test asserts CONSERVATION and EQUIVALENCE, not a specific number:
//
//   - every metre / piece that left the shelf is either received or disputed,
//     never lost and never duplicated;
//   - In_Transit returns to exactly 0 once the receipt is settled;
//     Settled_Qty == Qty on every line the sweep touched;
//   - a receipt swept in ONE slice and the SAME receipt swept in N slices
//     (LINE_BUDGET small) leave identical ledger state;
//   - the readiness sweep rolls Item_Status / Order_Status to the same place
//     whether run in one finalize call or resumed across ITEM_BUDGET slices;
//   - an open dispute for a plan+material is netted off the lines the sweep
//     settles, exactly as getSupervisorMaterials shows him, and only once even
//     when the sweep is resumed.
//
// Ports mirror the .dg files:
//   issueApply       deluge/issueMaterials.dg  (allocation-applier body)
//   recvApply        deluge/receiveMaterials.dg (sweep slice + finalize phase)
//   buildIssuePayload  app/js/main.js buildFabricIssueLine + accessory branch
//   screenView         deluge/getSupervisorMaterials.dg (rolled-up read side)
//   buildRecvPayload   app/supervisor/js/receive.js submitReceipt
//
//   usage: node tools/receive-lifecycle.test.js

'use strict';
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}
function approx(a, b, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + ' +/- ' + eps + ', got ' + a);
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ---------------------------------------------------------------------------
// A tiny in-memory Creator.
// ---------------------------------------------------------------------------
function makeWorld() {
  return {
    Raw_Material: {},
    Raw_Material_Lot: {},
    Material_Requirement: {},
    Plan_Item: {},
    Production_Planning: {},
    Material_Issue: {},
    Stock_Dispute: [],
    Waste_Movement: {},
    Waste_Master: {},
    _seq: 1000
  };
}
function nextId(w) { return String(++w._seq); }

// ---------------------------------------------------------------------------
// PORT: issueMaterials body (allocation-applier). One chunk = one call.
// ---------------------------------------------------------------------------
function issueApply(w, supId, issues) {
  const errs = [];
  const issueLines = [];
  let primaryPlanId = 0;

  issues.forEach(issue => {
    const matId = String(issue.materialId);
    const mat = w.Raw_Material[matId];
    if (!mat) { errs.push('Material ' + matId + ' not found'); return; }
    const isFab = !!mat.Is_Fabric;
    let issuedTotal = 0;

    (issue.allocations || []).forEach(a => {
      const mrq = w.Material_Requirement[String(a.mrqId)];
      if (!mrq) { errs.push(mat.SKU + ': requirement ' + a.mrqId + ' not found'); return; }
      const giveQty = Number(a.giveQty) || 0;
      const giveRaw = Math.trunc(Number(a.giveRaw) || 0);
      const giveWaste = Math.trunc(Number(a.giveWaste) || 0);
      mrq.Issued_Qty = (Number(mrq.Issued_Qty) || 0) + giveQty;
      if (isFab) {
        mrq.Pieces_From_Raw = (Number(mrq.Pieces_From_Raw) || 0) + giveRaw;
        mrq.Pieces_From_Waste = (Number(mrq.Pieces_From_Waste) || 0) + giveWaste;
        if (a.issuedLot && !mrq.Issued_Lot) mrq.Issued_Lot = String(a.issuedLot);
      }
      if (!primaryPlanId && a.planId) primaryPlanId = String(a.planId);
      issuedTotal += giveQty;
    });

    (issue.wastePicks || []).forEach(pk => {
      const wm = w.Waste_Master[String(pk.wasteId)];
      if (!wm) { errs.push(mat.SKU + ': waste piece ' + pk.wasteId + ' not found'); return; }
      const take = Math.trunc(Number(pk.pieces) || 0);
      if (take <= 0) return;
      let left = (Number(wm.Piece_Count) || 0) - take;
      if (left < 0) { errs.push(mat.SKU + ': waste ' + pk.wasteId + ' clamped'); left = 0; }
      wm.Piece_Count = left;
      wm.In_Transit_Count = (Number(wm.In_Transit_Count) || 0) + take;
      if (left <= 0) wm.Status = 'Issued';
      const mvId = nextId(w);
      w.Waste_Movement[mvId] = {
        Movement_Type: 'Issued', Piece_Count: take,
        Waste_Piece: String(pk.wasteId),
        Plan: pk.planId ? String(pk.planId) : null,
        Plan_Item: pk.planItemId ? String(pk.planItemId) : null,
        Moved_By: supId, Parent_Movement: null
      };
    });

    (issue.lotMoves || []).forEach(lm => {
      const lot = w.Raw_Material_Lot[String(lm.lotId)];
      if (!lot) { errs.push(mat.SKU + ': lot ' + lm.lotId + ' not found'); return; }
      const q = Number(lm.qty) || 0;
      let newWash = (Number(lot.Wash_Quantity) || 0) - q;
      if (newWash < 0) { errs.push(mat.SKU + ': lot clamped'); newWash = 0; }
      lot.Wash_Quantity = newWash;
      lot.In_Transit_Qty = (Number(lot.In_Transit_Qty) || 0) + q;
    });

    const avail = isFab ? (Number(mat.Wash_Quantity) || 0) : (Number(mat.Quantity) || 0);
    const balance = avail - issuedTotal;
    if (isFab) {
      mat.Wash_Quantity = balance;
      mat.Quantity = balance + (Number(mat.Unwash_Quantity) || 0) + (Number(mat.Unallocated_Qty) || 0);
    } else {
      mat.Quantity = balance;
    }
    mat.In_Transit_Qty = (Number(mat.In_Transit_Qty) || 0) + issuedTotal;

    (issue.issueLines || []).forEach(ls => {
      issueLines.push({
        matId: matId,
        matDisp: mat.Material_Display_Name || mat.Name || mat.SKU,
        unit: mat.Unit || '',
        qty: Number(ls.qty) || 0,
        cutW: Number(ls.cutW) || 0, cutL: Number(ls.cutL) || 0,
        lot: ls.lotId ? String(ls.lotId) : '',
        note: (ls.note || '').replace(/\n/g, ' | '),
        req: ls.mrqId ? String(ls.mrqId) : '',
        planItem: ls.planItemId ? String(ls.planItemId) : ''
      });
    });
  });

  let voucherId = null;
  if (issueLines.length > 0) {
    voucherId = nextId(w);
    const lines = issueLines.map(ln => ({
      ID: nextId(w),
      Material: ln.matId, Material_Name: ln.matDisp,
      Qty: ln.qty, Unit: ln.unit,
      Cut_Size_Width: ln.cutW, Cut_Size_Length: ln.cutL,
      Settled_Qty: 0,
      Lot: ln.lot || null,
      Requirement: ln.req || null,
      Plan_Item: ln.planItem || null,
      Lot_Override_Note: ln.note || ''
    }));
    w.Material_Issue[voucherId] = {
      Voucher_No: 'SIV-' + voucherId, Issue_Status: 'Issued',
      Issued_To: supId, Plan: primaryPlanId || null,
      Issue_Lines: lines, _order: voucherId
    };
  }
  return { voucherId, errs };
}

// ---------------------------------------------------------------------------
// PORT: receiveMaterials. Budgets are `let` so tests can shrink them to force
// resume paths.
// ---------------------------------------------------------------------------
let LINE_BUDGET = 250;
let VOUCHER_BUDGET = 60;
let ITEM_BUDGET = 250;

function planItemsOf(w, planId) {
  return Object.keys(w.Plan_Item).map(k => w.Plan_Item[k]).filter(x => String(x.Plan) === String(planId));
}
function reqsOfItem(w, itemId) {
  return Object.keys(w.Material_Requirement).map(k => w.Material_Requirement[k])
    .filter(r => String(r.Plan_Item) === String(itemId));
}

function recvApply(w, supId, payload) {
  const errs = [];
  const doFinalize = String(payload.finalize) === 'true';
  const vouchersIn = (payload.vouchers || []).map(String);
  const shortMatsIn = payload.shortMaterials || [];
  const wastes = payload.waste || [];
  const printed = payload.printedPieces || [];
  const plansTouchedIn = [];
  (payload.plansTouched || []).forEach(p => { const s = String(p).trim(); if (s && plansTouchedIn.indexOf(s) < 0) plansTouchedIn.push(s); });
  const disputeIdsIn = (payload.disputeIds || []).map(String);
  const swCur = payload.sweepCursor || {};
  const fnCur = payload.finalizeCursor || {};

  let newDispIds = [];
  let sweepCursor = null, sweepDone = true;
  let finalizeCursor = { ph: 'done' }, finalizeDone = true;

  if (!doFinalize) {
    // ================= SWEEP SLICE =================
    let startV = Number(swCur.v) || 0;
    let afterLine = swCur.l ? String(swCur.l) : '';

    const shortLeft = {};
    if (swCur.sd) { Object.keys(swCur.sd).forEach(k => { shortLeft[k] = Number(swCur.sd[k]) || 0; }); }
    else { shortMatsIn.forEach(sm => { if (sm.materialId) shortLeft[String(sm.materialId)] = Number(sm.received) || 0; }); }

    const dispNet = {};
    if (swCur.nd) { Object.keys(swCur.nd).forEach(k => { dispNet[k] = Number(swCur.nd[k]) || 0; }); }
    else {
      w.Stock_Dispute.forEach(d => {
        if (d.Status === 'Open' && !d.Is_Waste && (d.Direction || 'Outbound') === 'Outbound' && d.Plan && d.Material) {
          const left = (Number(d.Disputed_Qty) || 0) - (d.Resolution_Lines || []).reduce((s, r) => s + (Number(r.Resolved_Qty) || 0), 0);
          if (left > 0) { const k = String(d.Plan) + '|' + String(d.Material); dispNet[k] = (dispNet[k] || 0) + left; }
        }
      });
    }

    const settledByMat = {}, shortByMat = {}, confByMat = {}, settledByLot = {}, shortByLot = {};
    const pmShort = {}, pmPend = {}, pmGot = {}, pmItem = {}, pmName = {}, pmUnit = {}, pmKeys = [];

    let linesDone = 0, budgetHit = false, vIdx = 0;
    for (let vi = 0; vi < vouchersIn.length; vi++) {
      const vTxt = vouchersIn[vi];
      if (!budgetHit && vIdx >= startV && vTxt) {
        let reachedResume = !(vIdx === startV && afterLine !== '');
        const vRec = w.Material_Issue[vTxt];
        if (vRec) {
          for (let li = 0; li < vRec.Issue_Lines.length; li++) {
            if (budgetHit) break;
            const miLn = vRec.Issue_Lines[li];
            const lnIdTxt = String(miLn.ID);
            if (!reachedResume) { if (lnIdTxt === afterLine) reachedResume = true; continue; }

            const lnQ = Number(miLn.Qty) || 0;
            let owed = lnQ - (Number(miLn.Settled_Qty) || 0);
            const matTxt = String(miLn.Material || '');
            const reqTxt = miLn.Requirement ? String(miLn.Requirement) : '';
            const lotTxt = miLn.Lot ? String(miLn.Lot) : '';
            let rPlan = '', rItem = '';
            if (owed > 0 && reqTxt) {
              const rq = w.Material_Requirement[reqTxt];
              if (rq) {
                rPlan = rq.Plan ? String(rq.Plan) : '';
                rItem = rq.Plan_Item ? String(rq.Plan_Item) : '';
                if (pmName[matTxt] === undefined) pmName[matTxt] = rq.Material_Name || '';
                if (pmUnit[matTxt] === undefined) pmUnit[matTxt] = rq.Unit || '';
              }
            }
            if (owed > 0 && rPlan && matTxt) {
              const dnKey = rPlan + '|' + matTxt;
              const dnLeft = dispNet[dnKey];
              if (dnLeft && dnLeft > 0) { const t = Math.min(dnLeft, owed); owed = r2(owed - t); dispNet[dnKey] = r2(dnLeft - t); }
            }

            if (owed > 0) {
              if (pmName[matTxt] === undefined && miLn.Material_Name) pmName[matTxt] = miLn.Material_Name;
              if (pmUnit[matTxt] === undefined && miLn.Unit) pmUnit[matTxt] = miLn.Unit;

              let conf = owed, shortQ = 0;
              if (shortLeft[matTxt] !== undefined) {
                const sl = shortLeft[matTxt];
                if (sl >= owed) { conf = owed; shortLeft[matTxt] = r2(sl - owed); }
                else { conf = Math.max(0, sl); shortLeft[matTxt] = 0; }
                shortQ = r2(owed - conf);
              }

              miLn.Settled_Qty = lnQ;
              if (reqTxt) { const rq = w.Material_Requirement[reqTxt]; if (rq) rq.Received_Qty = r2((Number(rq.Received_Qty) || 0) + conf); }

              settledByMat[matTxt] = r2((settledByMat[matTxt] || 0) + owed);
              confByMat[matTxt] = r2((confByMat[matTxt] || 0) + conf);
              if (shortQ > 0) shortByMat[matTxt] = r2((shortByMat[matTxt] || 0) + shortQ);
              if (lotTxt) {
                settledByLot[lotTxt] = r2((settledByLot[lotTxt] || 0) + owed);
                if (shortQ > 0) shortByLot[lotTxt] = r2((shortByLot[lotTxt] || 0) + shortQ);
              }
              if (shortQ > 0 && rPlan) {
                const k = rPlan + '|' + matTxt;
                if (pmShort[k] === undefined) { pmKeys.push(k); pmShort[k] = 0; pmPend[k] = 0; pmGot[k] = 0; pmItem[k] = rItem; }
                pmShort[k] = r2(pmShort[k] + shortQ); pmPend[k] = r2(pmPend[k] + owed); pmGot[k] = r2(pmGot[k] + conf);
              }
            }

            afterLine = lnIdTxt;
            startV = vIdx;
            linesDone++;
            if (linesDone >= LINE_BUDGET) budgetHit = true;
          }
        }
        if (!budgetHit) { startV = vIdx + 1; afterLine = ''; }
      }
      vIdx++;
    }

    Object.keys(settledByMat).forEach(mk => {
      const mat = w.Raw_Material[mk];
      if (mat) {
        const it = Number(mat.In_Transit_Qty) || 0;
        mat.In_Transit_Qty = r2(it - Math.min(settledByMat[mk], it));
        if (shortByMat[mk] > 0) mat.Disputed_Qty = r2((Number(mat.Disputed_Qty) || 0) + shortByMat[mk]);
      }
    });
    Object.keys(settledByLot).forEach(lk => {
      const lot = w.Raw_Material_Lot[lk];
      if (lot) {
        const it = Number(lot.In_Transit_Qty) || 0;
        lot.In_Transit_Qty = r2(it - Math.min(settledByLot[lk], it));
        if (shortByLot[lk] > 0) lot.Disputed_Qty = r2((Number(lot.Disputed_Qty) || 0) + shortByLot[lk]);
      }
    });

    pmKeys.forEach(k => {
      if (!(pmShort[k] > 0)) return;
      const parts = k.split('|');
      const pPlan = parts[0], pMat = parts[1];
      let ex = w.Stock_Dispute.filter(d =>
        String(d.Supervisor) === String(supId) && String(d.Plan) === pPlan && String(d.Material) === pMat &&
        d.Status === 'Open' && (d.Direction || 'Outbound') === 'Outbound' && !d.Is_Waste)[0];
      if (ex) {
        ex.Issued_Qty = r2((Number(ex.Issued_Qty) || 0) + pmPend[k]);
        ex.Received_Qty = r2((Number(ex.Received_Qty) || 0) + pmGot[k]);
        ex.Disputed_Qty = r2((Number(ex.Disputed_Qty) || 0) + pmShort[k]);
      } else {
        ex = {
          _id: 'DSP-' + supId + '-' + pPlan + '-' + pMat,
          Material: pMat, Supervisor: supId, Plan: pPlan, Plan_Item: pmItem[k] || null,
          Material_Name: pmName[pMat] || ('Material ' + pMat), Unit: pmUnit[pMat] || '',
          Direction: 'Outbound', Is_Waste: false, Status: 'Open',
          Issued_Qty: pmPend[k], Received_Qty: pmGot[k], Disputed_Qty: pmShort[k]
        };
        w.Stock_Dispute.push(ex);
      }
      newDispIds.push(String(ex._id));
    });

    sweepDone = !budgetHit;
    if (budgetHit) sweepCursor = { v: startV, l: afterLine, sd: Object.assign({}, shortLeft), nd: Object.assign({}, dispNet) };

    // ---- waste (first sweep call only; widget sends [] on resume) ----
    wastes.forEach(wr => {
      const wi = w.Waste_Movement[String(wr.rowId)];
      if (!wi || wi.Movement_Type !== 'Issued') return;
      const issuedW = Number(wi.Piece_Count) || 0;
      let alreadyW = 0;
      Object.keys(w.Waste_Movement).forEach(k => {
        const rv = w.Waste_Movement[k];
        if (rv.Parent_Movement === String(wr.rowId) && rv.Movement_Type === 'Received') alreadyW += Number(rv.Piece_Count) || 0;
      });
      let take = Math.trunc(Number(wr.received) || 0);
      if (alreadyW + take > issuedW) take = issuedW - alreadyW;
      if (take < 0) take = 0;
      if (take > 0) {
        const rvId = nextId(w);
        w.Waste_Movement[rvId] = { Movement_Type: 'Received', Piece_Count: take, Parent_Movement: String(wr.rowId), Waste_Piece: wi.Waste_Piece, Plan: wi.Plan, Plan_Item: wi.Plan_Item };
      }
      let stillOut = issuedW - (alreadyW + take);
      if (stillOut < 0) stillOut = 0;
      const wm = w.Waste_Master[String(wi.Waste_Piece)];
      if (wm) {
        const witCount = Number(wm.In_Transit_Count) || 0;
        const settlePcs = Math.min(take + stillOut, witCount);
        wm.In_Transit_Count = witCount - settlePcs;
        if (stillOut > 0) wm.Disputed_Count = (Number(wm.Disputed_Count) || 0) + stillOut;
      }
      if (stillOut > 0) {
        const d = { _id: 'DSP-W-' + wr.rowId, Material: wm ? wm.SKU : null, Supervisor: supId, Plan: wi.Plan, Direction: 'Outbound', Is_Waste: true, Status: 'Open', Disputed_Qty: stillOut, Issued_Qty: issuedW, Received_Qty: alreadyW + take, Waste_Piece: wi.Waste_Piece };
        w.Stock_Dispute.push(d);
        newDispIds.push(d._id);
      }
    });

    // ---- printed pieces (first sweep call only) ----
    printed.forEach(pr => {
      const voucher = w.Material_Issue[String(pr.voucherId)];
      if (!voucher) { errs.push('Printed piece ' + pr.issueLineId + ' not found'); return; }
      const ln = voucher.Issue_Lines.filter(x => String(x.ID) === String(pr.issueLineId))[0];
      if (!ln) { errs.push('Printed piece ' + pr.issueLineId + ' not found'); return; }
      const remain = (Number(ln.Qty) || 0) - (Number(ln.Settled_Qty) || 0);
      let takeP = Number(pr.received) || 0;
      if (takeP > remain) takeP = remain;
      ln.Settled_Qty = (Number(ln.Settled_Qty) || 0) + takeP;
      const stillOutP = remain - takeP;
      if (ln.Requirement) {
        const req = w.Material_Requirement[String(ln.Requirement)];
        if (req) {
          const room = Math.max(0, (Number(req.Issued_Qty) || 0) - (Number(req.Received_Qty) || 0));
          req.Received_Qty = (Number(req.Received_Qty) || 0) + Math.min(takeP, room);
        }
      }
      if (ln.Material) {
        const mat = w.Raw_Material[String(ln.Material)];
        if (mat) {
          const itQty = Number(mat.In_Transit_Qty) || 0;
          mat.In_Transit_Qty = itQty - Math.min(remain, itQty);
          if (stillOutP > 0) mat.Disputed_Qty = (Number(mat.Disputed_Qty) || 0) + stillOutP;
        }
      }
      if (ln.Lot) {
        const lot = w.Raw_Material_Lot[String(ln.Lot)];
        if (lot) {
          const itQty = Number(lot.In_Transit_Qty) || 0;
          lot.In_Transit_Qty = itQty - Math.min(remain, itQty);
          if (stillOutP > 0) lot.Disputed_Qty = (Number(lot.Disputed_Qty) || 0) + stillOutP;
        }
      }
      if (stillOutP > 0) {
        const d = { _id: 'DSP-P-' + pr.issueLineId, Material: ln.Material, Supervisor: supId, Direction: 'Outbound', Is_Waste: false, Status: 'Open', Disputed_Qty: stillOutP, Issued_Qty: remain, Received_Qty: takeP };
        w.Stock_Dispute.push(d);
        newDispIds.push(d._id);
      }
    });
  } else {
    // ================= FINALIZE PHASE =================
    let ph = fnCur.ph || 'vouchers';

    if (ph === 'vouchers') {
      let vi = Number(fnCur.vi) || 0, vc = 0, vProc = 0;
      vouchersIn.forEach(vTxt => {
        if (vc >= vi && vProc < VOUCHER_BUDGET) {
          const v = w.Material_Issue[vTxt];
          if (v && v.Issue_Status !== 'Received') {
            let anyL = false, allS = true;
            v.Issue_Lines.forEach(ln => { anyL = true; if ((Number(ln.Settled_Qty) || 0) < (Number(ln.Qty) || 0)) allS = false; });
            v.Issue_Status = (anyL && allS) ? 'Received' : 'Partially_Received';
          }
          vProc++;
        }
        vc++;
      });
      const newVi = vi + vProc;
      finalizeDone = false;
      finalizeCursor = (newVi >= vouchersIn.length) ? { ph: 'items', pi: 0, ii: 0 } : { ph: 'vouchers', vi: newVi };
    } else if (ph === 'items') {
      let pi = Number(fnCur.pi) || 0, ii = Number(fnCur.ii) || 0;
      let itemsThisCall = 0, pc = 0, nextPi = pi, nextIi = ii, stopped = false;
      plansTouchedIn.forEach(plId => {
        if (!stopped && pc >= pi && itemsThisCall < ITEM_BUDGET && plId) {
          const plan = w.Production_Planning[plId];
          const plSt = plan ? plan.Order_Status : '';
          const skipN = (pc === pi) ? ii : 0;
          const items = planItemsOf(w, plId);
          let iC = 0, sweptHere = 0;
          items.forEach(pItem => {
            if (iC >= skipN && itemsThisCall < ITEM_BUDGET) {
              if (pItem.Item_Status === 'Awaiting_Material') {
                let itemReady = true, reqCount = 0;
                reqsOfItem(w, pItem._id).forEach(row => {
                  reqCount++;
                  const issQty = Number(row.Issued_Qty) || 0, recQty = Number(row.Received_Qty) || 0, reqQty = Number(row.Required_Qty) || 0;
                  if (recQty < issQty) itemReady = false;
                  if (row.Is_Fabric) {
                    const reqPcs = Number(row.Required_Pieces) || 0;
                    const issPcs = (Number(row.Pieces_From_Waste) || 0) + (Number(row.Pieces_From_Raw) || 0);
                    if (reqPcs <= 0 || issPcs < reqPcs) itemReady = false;
                  } else {
                    if (reqQty <= 0 || issQty < reqQty) itemReady = false;
                  }
                });
                if (reqCount === 0) itemReady = false;
                Object.keys(w.Waste_Movement).forEach(kk => {
                  const wi = w.Waste_Movement[kk];
                  if (wi.Movement_Type !== 'Issued' || String(wi.Plan_Item) !== String(pItem._id)) return;
                  const wC = Number(wi.Piece_Count) || 0;
                  let wR = 0;
                  Object.keys(w.Waste_Movement).forEach(k3 => { const rv = w.Waste_Movement[k3]; if (rv.Parent_Movement === kk && rv.Movement_Type === 'Received') wR += Number(rv.Piece_Count) || 0; });
                  if (wR < wC) itemReady = false;
                });
                if (itemReady) pItem.Item_Status = 'Ready_For_Production';
              }
              itemsThisCall++; sweptHere++;
            }
            iC++;
          });
          const doneIi = skipN + sweptHere;
          if (doneIi >= iC) {
            const awC = planItemsOf(w, plId).filter(x => x.Item_Status === 'Awaiting_Material').length;
            if (iC > 0 && plan && plSt !== 'In Progress' && plSt !== 'Production Complete') {
              if (awC === 0) plan.Order_Status = 'Material Ready';
              else if (plSt === 'Pending' && awC < iC) plan.Order_Status = 'Partially Received';
            }
            nextPi = pc + 1; nextIi = 0;
          } else {
            nextPi = pc; nextIi = doneIi; stopped = true;
          }
        }
        pc++;
      });
      finalizeDone = false;
      finalizeCursor = (nextPi >= plansTouchedIn.length) ? { ph: 'transfer' } : { ph: 'items', pi: nextPi, ii: nextIi };
    } else if (ph === 'transfer') {
      finalizeCursor = { ph: 'notify' }; finalizeDone = false;
    } else if (ph === 'notify') {
      // digest built from disputeIdsIn - tests don't assert mail, just closes.
      void disputeIdsIn;
      finalizeCursor = { ph: 'done' }; finalizeDone = true;
    } else {
      finalizeCursor = { ph: 'done' }; finalizeDone = true;
    }
  }

  return { errs, disputeIds: newDispIds, sweepCursor, sweepDone, finalizeCursor, finalizeDone };
}

// ---------------------------------------------------------------------------
// PORT: the widget's issue-payload builder for ONE fabric material.
// ---------------------------------------------------------------------------
function buildIssuePayload(m) {
  const cutW = Number(m.cutWidth) || 0, cutL = Number(m.cutLength) || 0;
  const src = m.isReissue ? 'Reissue' : 'Plan';

  const mrqByItem = {}, planByItem = {}, owedByItem = {};
  (m.lines || []).forEach(ln => {
    const it = String(ln.planItemId || '');
    if (it && mrqByItem[it] === undefined) {
      mrqByItem[it] = ln.mrqId; planByItem[it] = ln.planId;
      owedByItem[it] = Math.max(0, (Number(ln.reqPieces) || 0) - (Number(ln.issPieces) || 0));
    }
  });

  const lotLines = (m.lotLines || []).filter(ln => (Number(ln.qty) || 0) > 0);

  const moveByLot = {}, moveOrder = [];
  lotLines.forEach(ln => {
    const k = String(ln.lotId);
    if (!moveByLot[k]) { moveByLot[k] = { lotId: ln.lotId, qty: 0, isPieces: false, pieces: [] }; moveOrder.push(k); }
    moveByLot[k].qty = r2(moveByLot[k].qty + (Number(ln.qty) || 0));
  });
  const lotMoves = moveOrder.map(k => moveByLot[k]);

  const qtyByItem = {}, rawByItem = {}, wasteByItem = {}, lotByItem = {}, itemOrder = [], seen = {};
  lotLines.forEach(ln => {
    const it = String(ln.planItemId || '');
    if (!seen[it]) { seen[it] = true; itemOrder.push(it); qtyByItem[it] = 0; rawByItem[it] = 0; wasteByItem[it] = 0; }
    qtyByItem[it] = r2(qtyByItem[it] + (Number(ln.qty) || 0));
    rawByItem[it] += Number(ln.fromRaw) || 0;
    wasteByItem[it] += Number(ln.fromWaste) || 0;
    if (!lotByItem[it]) lotByItem[it] = ln.lotId;
  });

  const wastePicksOut = [];
  (m.picks || []).forEach(pk => {
    const s = (m.wastePicks || []).filter(x => String(x.wasteId) === String(pk.wasteId))[0] || {};
    const yieldPer = remnantYield({ width: s.width, length: s.length }, cutW, cutL);
    const it = String(pk.planItemId || s.planItemId || '');
    if (!seen[it]) { seen[it] = true; itemOrder.push(it); qtyByItem[it] = 0; rawByItem[it] = 0; wasteByItem[it] = pk.pieces * yieldPer; }
    wastePicksOut.push({ wasteId: pk.wasteId, pieces: pk.pieces, planId: planByItem[it] || '', planItemId: it, yieldPer, pieceWidth: s.width, pieceLength: s.length });
  });

  const allocations = itemOrder.filter(it => it !== '' && mrqByItem[it] !== undefined).map(it => {
    const owed = owedByItem[it] === undefined ? Infinity : owedByItem[it];
    let wst = wasteByItem[it] || 0, raw = rawByItem[it] || 0;
    if (wst > owed) wst = owed;
    if (raw > owed - wst) raw = Math.max(0, owed - wst);
    return { mrqId: mrqByItem[it], planId: planByItem[it] || '', planItemId: it, giveQty: r2(qtyByItem[it] || 0), giveRaw: raw, giveWaste: wst, issuedLot: String(lotByItem[it] || '') };
  });

  const issueLines = allocations.map(a => {
    const ln = lotLines.filter(x => String(x.planItemId || '') === a.planItemId)[0] || {};
    return { mrqId: a.mrqId, planItemId: a.planItemId, lotId: a.issuedLot, qty: a.giveQty, unit: m.unit, cutW, cutL, note: ln.note || '', overrideFrom: '' };
  });

  return { materialId: m.materialId, source: src, isFabric: true, cutWidth: cutW, cutLength: cutL, allocations, lotMoves, wastePicks: wastePicksOut, issueLines };
}
function remnantYield(rr, cutW, cutL) {
  const wv = Number(rr.width) || 0, lv = Number(rr.length) || 0;
  if (!(cutW > 0 && cutL > 0) || wv < cutW || lv < cutL) return 0;
  return Math.floor(wv / cutW) * Math.floor(lv / cutL);
}

// ---------------------------------------------------------------------------
// PORT: getSupervisorMaterials read side. Rolls the still-owed Issue_Lines
// into one row per material with orders[] (per plan) + voucherIds[]. Nets open
// disputes per plan+material off the displayed pending.
// ---------------------------------------------------------------------------
function screenView(w, supId) {
  const byMat = {};
  // newest voucher first, mirroring Added_Time desc
  const vIds = Object.keys(w.Material_Issue).slice().reverse();
  vIds.forEach(vId => {
    const v = w.Material_Issue[vId];
    if (String(v.Issued_To) !== String(supId)) return;
    v.Issue_Lines.forEach(ln => {
      const pend = (Number(ln.Qty) || 0) - (Number(ln.Settled_Qty) || 0);
      if (pend <= 0) return;
      const mId = String(ln.Material);
      if (!byMat[mId]) {
        const mat = w.Raw_Material[mId] || {};
        byMat[mId] = { materialId: mId, unit: mat.Unit || '', isFabric: !!mat.Is_Fabric, pending: 0, _ord: {}, _ordK: [], _vou: [] };
      }
      const M = byMat[mId];
      M.pending = r2(M.pending + pend);
      const req = ln.Requirement ? w.Material_Requirement[String(ln.Requirement)] : null;
      const planId = req && req.Plan ? String(req.Plan) : '';
      if (M._ord[planId] === undefined) { M._ord[planId] = { planId, pending: 0, lineCount: 0 }; M._ordK.push(planId); }
      M._ord[planId].pending = r2(M._ord[planId].pending + pend);
      M._ord[planId].lineCount++;
      if (M._vou.indexOf(String(vId)) < 0) M._vou.push(String(vId));
    });
  });

  // net open disputes, per plan+material
  const dn = {};
  w.Stock_Dispute.forEach(d => {
    if (d.Status === 'Open' && !d.Is_Waste && (d.Direction || 'Outbound') === 'Outbound' && d.Plan && d.Material) {
      const left = (Number(d.Disputed_Qty) || 0) - (d.Resolution_Lines || []).reduce((s, r) => s + (Number(r.Resolved_Qty) || 0), 0);
      if (left > 0) { const kk = String(d.Plan) + '|' + String(d.Material); dn[kk] = (dn[kk] || 0) + left; }
    }
  });
  Object.keys(byMat).forEach(mId => {
    const M = byMat[mId];
    M._ordK.forEach(k => {
      const kk = k + '|' + mId;
      if (dn[kk] > 0) {
        const t = Math.min(dn[kk], M._ord[k].pending);
        M._ord[k].pending = r2(M._ord[k].pending - t);
        M.pending = r2(M.pending - t);
        dn[kk] = r2(dn[kk] - t);
      }
    });
  });

  return Object.keys(byMat).map(k => {
    const M = byMat[k];
    return { materialId: M.materialId, unit: M.unit, isFabric: M.isFabric, pending: M.pending, orders: M._ordK.map(kk => M._ord[kk]), voucherIds: M._vou };
  }).filter(m => m.pending > 0.0000001);
}

// ---------------------------------------------------------------------------
// PORT: app/supervisor/js/receive.js submitReceipt.
// ---------------------------------------------------------------------------
function buildRecvPayload(screenMaterials, receivedByMat) {
  receivedByMat = receivedByMat || {};
  const vouchers = [];
  const plansTouched = {};
  const shortMaterials = [];
  screenMaterials.forEach(m => {
    (m.voucherIds || []).forEach(v => { if (vouchers.indexOf(String(v)) < 0) vouchers.push(String(v)); });
    (m.orders || []).forEach(o => { if (o.planId) plansTouched[String(o.planId)] = 1; });
    const typed = receivedByMat[m.materialId];
    if (typed !== undefined && r2(typed) < r2(m.pending)) {
      shortMaterials.push({ materialId: m.materialId, owed: r2(m.pending), received: r2(Math.max(0, typed)), remark: '' });
    }
  });
  // widget reverses its newest-first union to oldest-first
  vouchers.reverse();
  return { vouchers, shortMaterials, plansTouched: Object.keys(plansTouched) };
}

function runReceive(w, supId, screenMaterials, receivedByMat, opts) {
  opts = opts || {};
  const { vouchers, shortMaterials, plansTouched } = buildRecvPayload(screenMaterials, receivedByMat);
  let sweepCursor = {}, guard = 0, first = true;
  const disputeIds = {};
  for (;;) {
    const res = recvApply(w, supId, {
      vouchers, shortMaterials,
      waste: first ? (opts.waste || []) : [],
      printedPieces: first ? (opts.printed || []) : [],
      sweepCursor, finalize: 'false'
    });
    first = false;
    (res.disputeIds || []).forEach(d => { disputeIds[d] = 1; });
    if (res.sweepDone || !res.sweepCursor) break;
    sweepCursor = res.sweepCursor;
    if (++guard > 2000) throw new Error('sweep loop did not converge');
  }
  let fc = {}, g2 = 0;
  for (;;) {
    const res = recvApply(w, supId, {
      vouchers, plansTouched, disputeIds: Object.keys(disputeIds),
      finalize: 'true', finalizeCursor: fc
    });
    if (res.finalizeDone) break;
    fc = res.finalizeCursor;
    if (++g2 > 2000) throw new Error('finalize loop did not converge');
  }
}

// ---------------------------------------------------------------------------
// SCENARIO BUILDERS
// ---------------------------------------------------------------------------
function seedFabricPlan(w, opts) {
  const planId = nextId(w);
  const itemId = nextId(w);
  const mrqId = nextId(w);
  const matId = nextId(w);
  const lotId = nextId(w);

  w.Production_Planning[planId] = { Order_Status: 'Pending', Sales_Order: null, _id: planId };
  w.Plan_Item[itemId] = { Plan: planId, Item_Status: 'Awaiting_Material', _id: itemId };
  w.Raw_Material[matId] = { Is_Fabric: true, Unit: 'Mtr', SKU: 'RM-FAB', Name: 'Fabric', Wash_Quantity: opts.washOnShelf, Quantity: opts.washOnShelf, In_Transit_Qty: 0, Disputed_Qty: 0, Unwash_Quantity: 0, Unallocated_Qty: 0 };
  w.Raw_Material_Lot[lotId] = { Wash_Quantity: opts.washOnShelf, In_Transit_Qty: 0, Disputed_Qty: 0, Lot_Number: 'L1' };
  w.Material_Requirement[mrqId] = {
    Plan: planId, Plan_Item: itemId, Material: matId, Material_Name: 'Fabric', Unit: 'Mtr',
    Is_Fabric: true, Required_Qty: opts.reqQty, Required_Pieces: opts.reqPieces,
    Issued_Qty: 0, Received_Qty: 0, Pieces_From_Raw: 0, Pieces_From_Waste: 0, Issued_Lot: null, Source: 'Plan', _id: mrqId
  };
  return { planId, itemId, mrqId, matId, lotId };
}

function buildManyPlanScenario(w, nPlans) {
  const matId = nextId(w);
  w.Raw_Material[matId] = { Is_Fabric: false, Unit: 'Cone', SKU: 'RM-THREAD', Name: 'Thread', Quantity: 100000, In_Transit_Qty: 0, Disputed_Qty: 0 };
  const issues = [];
  const perPlan = [];
  for (let i = 0; i < nPlans; i++) {
    const planId = nextId(w), itemId = nextId(w), mrqId = nextId(w);
    w.Production_Planning[planId] = { Order_Status: 'Pending', Sales_Order: null, _id: planId };
    w.Plan_Item[itemId] = { Plan: planId, Item_Status: 'Awaiting_Material', _id: itemId };
    w.Material_Requirement[mrqId] = {
      Plan: planId, Plan_Item: itemId, Material: matId, Material_Name: 'Thread', Unit: 'Cone',
      Is_Fabric: false, Required_Qty: 2, Required_Pieces: 0, Issued_Qty: 0, Received_Qty: 0,
      Pieces_From_Raw: 0, Pieces_From_Waste: 0, Issued_Lot: null, Source: 'Plan', _id: mrqId
    };
    perPlan.push({ planId, itemId, mrqId });
  }
  issues.push({
    materialId: matId, source: 'Plan', isFabric: false, cutWidth: 0, cutLength: 0,
    allocations: perPlan.map(p => ({ mrqId: p.mrqId, planId: p.planId, planItemId: p.itemId, giveQty: 2, giveRaw: 0, giveWaste: 0, issuedLot: '' })),
    lotMoves: [], wastePicks: [],
    issueLines: perPlan.map(p => ({ mrqId: p.mrqId, planItemId: p.itemId, lotId: '', qty: 2, unit: 'Cone', cutW: 0, cutL: 0, note: '', overrideFrom: '' }))
  });
  return { matId, perPlan, issues };
}

function totalIssued(w) {
  let t = 0;
  Object.keys(w.Material_Issue).forEach(k => w.Material_Issue[k].Issue_Lines.forEach(ln => { t += Number(ln.Qty) || 0; }));
  return r2(t);
}
function totalSettled(w) {
  let t = 0;
  Object.keys(w.Material_Issue).forEach(k => w.Material_Issue[k].Issue_Lines.forEach(ln => { t += Number(ln.Settled_Qty) || 0; }));
  return r2(t);
}
function totalDisputed(w) {
  return r2(w.Stock_Dispute.reduce((s, d) => s + (Number(d.Disputed_Qty) || 0), 0));
}
function snapshot(w) { return JSON.stringify(w, Object.keys(w).sort()); }

function withBudgets(line, voucher, item, fn) {
  const a = LINE_BUDGET, b = VOUCHER_BUDGET, c = ITEM_BUDGET;
  LINE_BUDGET = line; VOUCHER_BUDGET = voucher; ITEM_BUDGET = item;
  try { fn(); } finally { LINE_BUDGET = a; VOUCHER_BUDGET = b; ITEM_BUDGET = c; }
}

// ===========================================================================
console.log('PART A — issue then FULL receive: nothing lost, In_Transit returns to 0');

test('A1 full receipt: every issued metre is received, In_Transit 0, lines fully settled', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 18.70, reqPieces: 100 });
  const m = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 18.70, fromRaw: 100, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  const pay = buildIssuePayload(m);
  const { errs, voucherId } = issueApply(w, 'SUP1', [pay]);
  assert.deepStrictEqual(errs, [], 'issue produced no errors');
  assert.ok(voucherId, 'a voucher was minted');

  approx(w.Raw_Material[s.matId].In_Transit_Qty, 18.70);
  approx(w.Raw_Material[s.matId].Wash_Quantity, 81.30);
  approx(w.Raw_Material_Lot[s.lotId].In_Transit_Qty, 18.70);
  approx(w.Material_Requirement[s.mrqId].Issued_Qty, 18.70);
  assert.strictEqual(w.Material_Requirement[s.mrqId].Pieces_From_Raw, 100);

  runReceive(w, 'SUP1', screenView(w, 'SUP1'), {});

  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
  approx(w.Raw_Material_Lot[s.lotId].In_Transit_Qty, 0, 1e-9);
  approx(w.Material_Requirement[s.mrqId].Received_Qty, 18.70);
  approx(totalSettled(w), totalIssued(w));
  assert.strictEqual(totalDisputed(w), 0, 'nothing disputed on a full receipt');
  assert.strictEqual(w.Plan_Item[s.itemId].Item_Status, 'Ready_For_Production');
  assert.strictEqual(w.Production_Planning[s.planId].Order_Status, 'Material Ready');
  const vId = Object.keys(w.Material_Issue)[0];
  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Received', 'voucher not marked Received after a full receipt');
});

test('A1b voucher flips even when its plan is NOT in plansTouched (widget still passes vouchers)', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 18.70, reqPieces: 100 });
  const m = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 18.70, fromRaw: 100, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m)]);
  const view = screenView(w, 'SUP1');
  const built = buildRecvPayload(view, {});
  // sweep loop
  recvApply(w, 'SUP1', { vouchers: built.vouchers, shortMaterials: [], sweepCursor: {}, finalize: 'false' });
  // finalize with plansTouched EMPTY - the vouchers phase still closes the voucher
  let fc = {}, res;
  do { res = recvApply(w, 'SUP1', { vouchers: built.vouchers, plansTouched: [], disputeIds: [], finalize: 'true', finalizeCursor: fc }); fc = res.finalizeCursor; } while (!res.finalizeDone);

  const vId = Object.keys(w.Material_Issue)[0];
  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Received', 'voucher stuck at Issued when plansTouched was empty');
  approx(totalSettled(w), totalIssued(w));
});

test('A1c voucher status moves in the finalize "vouchers" phase, not during the sweep', () => {
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 3);
  issueApply(w, 'SUP1', sc.issues);
  const vId = Object.keys(w.Material_Issue)[0];
  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Issued');

  const built = buildRecvPayload(screenView(w, 'SUP1'), {});
  // sweep only - lines settle, voucher status untouched
  recvApply(w, 'SUP1', { vouchers: built.vouchers, shortMaterials: [], sweepCursor: {}, finalize: 'false' });
  approx(totalSettled(w), totalIssued(w));
  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Issued', 'sweep should not touch Issue_Status');

  // finalize vouchers phase closes it
  recvApply(w, 'SUP1', { vouchers: built.vouchers, plansTouched: built.plansTouched, finalize: 'true', finalizeCursor: { ph: 'vouchers' } });
  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Received');
});

test('A1d short receipt against a material spanning two vouchers: both fully settle, gap disputed once', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 20, reqPieces: 100 });
  const mk = (qty, raw, issP) => buildIssuePayload({
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: issP }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: qty, fromRaw: raw, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  });
  issueApply(w, 'SUP1', [mk(11, 55, 0)]);
  issueApply(w, 'SUP1', [mk(9, 45, 55)]);

  runReceive(w, 'SUP1', screenView(w, 'SUP1'), { [s.matId]: 11 });

  const statuses = Object.keys(w.Material_Issue).map(id => w.Material_Issue[id].Issue_Status).sort();
  assert.deepStrictEqual(statuses, ['Received', 'Received']);
  approx(totalSettled(w), totalIssued(w));
  approx(totalDisputed(w), 9);
  assert.strictEqual(w.Stock_Dispute.length, 1, 'one dispute for the plan+material gap, not one per voucher');
});

test('A2 short receipt: the gap is disputed, issued == received + disputed, In_Transit 0', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 20, reqPieces: 100 });
  const m = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 20, fromRaw: 100, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m)]);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 20);

  runReceive(w, 'SUP1', screenView(w, 'SUP1'), { [s.matId]: 14.5 });

  approx(w.Material_Requirement[s.mrqId].Received_Qty, 14.5);
  approx(totalDisputed(w), 5.5);
  approx(r2(w.Material_Requirement[s.mrqId].Received_Qty + totalDisputed(w)), 20);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
  approx(w.Raw_Material_Lot[s.lotId].In_Transit_Qty, 0, 1e-9);
  approx(w.Raw_Material[s.matId].Disputed_Qty, 5.5);
  approx(w.Raw_Material_Lot[s.lotId].Disputed_Qty, 5.5);
  assert.strictEqual(w.Plan_Item[s.itemId].Item_Status, 'Awaiting_Material');
  assert.strictEqual(w.Production_Planning[s.planId].Order_Status, 'Pending');
});

test('A3 split handover: two issues against one item, then one receipt settles both', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 18.70, reqPieces: 100 });
  const m1 = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 11, fromRaw: 60, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m1)]);
  const m2 = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 60 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 7.70, fromRaw: 40, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m2)]);

  approx(w.Material_Requirement[s.mrqId].Issued_Qty, 18.70);
  assert.strictEqual(w.Material_Requirement[s.mrqId].Pieces_From_Raw, 100);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 18.70);

  runReceive(w, 'SUP1', screenView(w, 'SUP1'), {});

  approx(w.Material_Requirement[s.mrqId].Received_Qty, 18.70);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
  approx(totalSettled(w), totalIssued(w));
  assert.strictEqual(w.Plan_Item[s.itemId].Item_Status, 'Ready_For_Production');
});

// ===========================================================================
console.log('\nPART B — EQUIVALENCE: sliced sweep == one sweep, resumed finalize == one finalize');

test('B1 sliced sweep (LINE_BUDGET 1) == single-slice sweep (identical ledger)', () => {
  function play(lineBudget) {
    const w = makeWorld();
    buildManyPlanScenario(w, 20);
    issueApply(w, 'SUP1', buildManyPlanScenario.__last || []);
    return w;
  }
  // build once, replay with two budgets
  function run(lineBudget) {
    const w = makeWorld();
    const sc = buildManyPlanScenario(w, 20);
    issueApply(w, 'SUP1', sc.issues);
    withBudgets(lineBudget, 60, 250, () => runReceive(w, 'SUP1', screenView(w, 'SUP1'), {}));
    return w;
  }
  const wSingle = run(9999);
  const wSliced = run(1);
  assert.strictEqual(snapshot(wSliced), snapshot(wSingle), 'sliced and single-slice ledgers diverge');
});

test('B2 resumed finalize (ITEM_BUDGET 3) == one finalize: all 40 plans roll to Material Ready', () => {
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 40);
  issueApply(w, 'SUP1', sc.issues);
  const built = buildRecvPayload(screenView(w, 'SUP1'), {});
  assert.strictEqual(built.plansTouched.length, 40);
  withBudgets(250, 60, 3, () => runReceive(w, 'SUP1', screenView(w, 'SUP1'), {}));

  sc.perPlan.forEach(p => {
    approx(w.Material_Requirement[p.mrqId].Received_Qty, 2);
    assert.strictEqual(w.Plan_Item[p.itemId].Item_Status, 'Ready_For_Production', 'item ' + p.itemId + ' not ready');
    assert.strictEqual(w.Production_Planning[p.planId].Order_Status, 'Material Ready', 'plan ' + p.planId + ' not rolled');
  });
  approx(w.Raw_Material[sc.matId].In_Transit_Qty, 0, 1e-9);
  assert.strictEqual(totalDisputed(w), 0);
});

test('B2b multi-item plans: ITEM_BUDGET 2 across plans of 3 items each, all roll', () => {
  const w = makeWorld();
  const matId = nextId(w);
  w.Raw_Material[matId] = { Is_Fabric: false, Unit: 'Cone', SKU: 'RM-T', Name: 'T', Quantity: 1e6, In_Transit_Qty: 0, Disputed_Qty: 0 };
  const plans = [];
  const allocs = [], lines = [];
  for (let p = 0; p < 4; p++) {
    const planId = nextId(w);
    w.Production_Planning[planId] = { Order_Status: 'Pending', _id: planId };
    const items = [];
    for (let i = 0; i < 3; i++) {
      const itemId = nextId(w), mrqId = nextId(w);
      w.Plan_Item[itemId] = { Plan: planId, Item_Status: 'Awaiting_Material', _id: itemId };
      w.Material_Requirement[mrqId] = { Plan: planId, Plan_Item: itemId, Material: matId, Material_Name: 'T', Unit: 'Cone', Is_Fabric: false, Required_Qty: 1, Issued_Qty: 0, Received_Qty: 0, Pieces_From_Raw: 0, Pieces_From_Waste: 0, _id: mrqId };
      allocs.push({ mrqId, planId, planItemId: itemId, giveQty: 1, giveRaw: 0, giveWaste: 0, issuedLot: '' });
      lines.push({ mrqId, planItemId: itemId, lotId: '', qty: 1, unit: 'Cone', cutW: 0, cutL: 0, note: '', overrideFrom: '' });
      items.push(itemId);
    }
    plans.push({ planId, items });
  }
  issueApply(w, 'SUP1', [{ materialId: matId, isFabric: false, allocations: allocs, lotMoves: [], wastePicks: [], issueLines: lines }]);
  withBudgets(250, 60, 2, () => runReceive(w, 'SUP1', screenView(w, 'SUP1'), {}));

  plans.forEach(pl => {
    pl.items.forEach(it => assert.strictEqual(w.Plan_Item[it].Item_Status, 'Ready_For_Production', 'item ' + it));
    assert.strictEqual(w.Production_Planning[pl.planId].Order_Status, 'Material Ready', 'plan ' + pl.planId);
  });
  approx(w.Raw_Material[matId].In_Transit_Qty, 0, 1e-9);
});

test('B3 idempotent: running the whole receive again changes nothing', () => {
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 18);
  issueApply(w, 'SUP1', sc.issues);
  runReceive(w, 'SUP1', screenView(w, 'SUP1'), {});
  const before = snapshot(w);
  runReceive(w, 'SUP1', screenView(w, 'SUP1'), {});
  assert.strictEqual(snapshot(w), before, 're-running the whole receive mutated state');
});

test('B4 LINE_BUDGET boundary does not double-settle a line', () => {
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 5);
  issueApply(w, 'SUP1', sc.issues);
  withBudgets(1, 60, 250, () => runReceive(w, 'SUP1', screenView(w, 'SUP1'), {}));
  approx(totalSettled(w), totalIssued(w));
  approx(w.Raw_Material[sc.matId].In_Transit_Qty, 0, 1e-9);
  sc.perPlan.forEach(p => approx(w.Material_Requirement[p.mrqId].Received_Qty, 2));
  assert.strictEqual(totalDisputed(w), 0);
});

// ===========================================================================
console.log('\nPART C — conservation across mixed receipts and re-receipts');

test('C1 short receipt settles the whole line; a no-op second receipt changes nothing', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 18.70, reqPieces: 100 });
  const m = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 18.70, fromRaw: 100, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m)]);

  runReceive(w, 'SUP1', screenView(w, 'SUP1'), { [s.matId]: 10 });
  approx(w.Material_Requirement[s.mrqId].Received_Qty, 10);
  approx(totalDisputed(w), 8.70);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
  approx(totalSettled(w), totalIssued(w), 1e-9);

  const view2 = screenView(w, 'SUP1');
  assert.strictEqual(view2.length, 0, 'nothing pending after the short receipt settled the line');
  const before = snapshot(w);
  runReceive(w, 'SUP1', view2, {});
  assert.strictEqual(snapshot(w), before, 'a no-op second receipt changed state');
});

test('C2 issued total is conserved: received + disputed == issued, always', () => {
  const cases = [
    { conf: undefined, label: 'full' },
    { conf: 0, label: 'none' },
    { conf: 5.25, label: 'partial' },
    { conf: 18.70, label: 'exact' }
  ];
  cases.forEach(c => {
    const w = makeWorld();
    const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 18.70, reqPieces: 100 });
    const m = {
      materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
      lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 0 }],
      lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 18.70, fromRaw: 100, fromWaste: 0, note: '' }],
      wastePicks: [], picks: []
    };
    issueApply(w, 'SUP1', [buildIssuePayload(m)]);
    const issued = totalIssued(w);
    runReceive(w, 'SUP1', screenView(w, 'SUP1'), c.conf === undefined ? {} : { [s.matId]: c.conf });
    const rec = w.Material_Requirement[s.mrqId].Received_Qty;
    const dis = totalDisputed(w);
    approx(r2(rec + dis), issued, 1e-9);
    approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
    approx(w.Raw_Material_Lot[s.lotId].In_Transit_Qty, 0, 1e-9);
    approx(totalSettled(w), issued, 1e-9);
  });
});

// ===========================================================================
console.log('\nPART D — open-dispute netting during the sweep');

test('D1 an open dispute for a plan+material is netted off a fresh line, once, even sliced', () => {
  // one plan, one fabric item. First issue 20m, receive short (got 12) -> dispute 8.
  // Then a SECOND issue of 8m for the same item. On the next receipt the sweep
  // must NOT settle the 8 that is still in dispute - it nets it out.
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 200, reqQty: 20, reqPieces: 200 });
  const mk = (qty, raw, issP) => buildIssuePayload({
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 200, issPieces: issP }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: qty, fromRaw: raw, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  });
  issueApply(w, 'SUP1', [mk(20, 110, 0)]);
  runReceive(w, 'SUP1', screenView(w, 'SUP1'), { [s.matId]: 12 });
  approx(totalDisputed(w), 8);
  const recAfter1 = w.Material_Requirement[s.mrqId].Received_Qty;
  approx(recAfter1, 12);

  // second issue: 8 more metres for the same requirement
  issueApply(w, 'SUP1', [mk(8, 45, 110)]);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 8);

  // the screen nets the 8-in-dispute against this fresh 8m line -> shows 0 owed
  const view = screenView(w, 'SUP1');
  assert.strictEqual(view.length, 0, 'the fresh line is fully covered by the open dispute, so nothing is owed on screen');

  // he "confirms" whatever the screen shows (nothing). Sweep must not settle the
  // disputed 8 - In_Transit for that 8 stays put, Received does not move.
  const before = snapshot(w);
  runReceive(w, 'SUP1', view, {});
  approx(w.Material_Requirement[s.mrqId].Received_Qty, recAfter1, 1e-9);
  approx(totalDisputed(w), 8);
  assert.strictEqual(snapshot(w), before, 'sweep touched a line that was entirely in dispute');
});

test('D2 dispute netting is not double-applied when the sweep is resumed slice by slice', () => {
  // 3 plans share a trim. Plan 1 already has an open dispute of 2 (its whole
  // requirement). A fresh issue adds one 2-cone line per plan. Sliced sweep must
  // net plan 1 out exactly once and settle plans 2 & 3 in full.
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 3);
  issueApply(w, 'SUP1', sc.issues);
  // receive short on plan 1 only: got 0 of its 2 -> dispute 2
  runReceive(w, 'SUP1', screenView(w, 'SUP1'), {}); // first, receive plans 2,3,1 all in full
  // now everything settled & ready. Re-open by issuing again + disputing plan 1.
  // Simpler: fabricate the open dispute + a fresh line.
  const p1 = sc.perPlan[0];
  w.Stock_Dispute.push({ _id: 'DSP-SUP1-' + p1.planId + '-' + sc.matId, Supervisor: 'SUP1', Plan: p1.planId, Material: sc.matId, Direction: 'Outbound', Is_Waste: false, Status: 'Open', Disputed_Qty: 2, Issued_Qty: 2, Received_Qty: 0 });
  // fresh issue: 2 cones per plan again
  issueApply(w, 'SUP1', [{
    materialId: sc.matId, isFabric: false,
    allocations: sc.perPlan.map(p => ({ mrqId: p.mrqId, planId: p.planId, planItemId: p.itemId, giveQty: 2, giveRaw: 0, giveWaste: 0, issuedLot: '' })),
    lotMoves: [], wastePicks: [],
    issueLines: sc.perPlan.map(p => ({ mrqId: p.mrqId, planItemId: p.itemId, lotId: '', qty: 2, unit: 'Cone', cutW: 0, cutL: 0, note: '', overrideFrom: '' }))
  }]);

  const recBefore = sc.perPlan.map(p => w.Material_Requirement[p.mrqId].Received_Qty);
  withBudgets(1, 60, 250, () => runReceive(w, 'SUP1', screenView(w, 'SUP1'), {}));

  // plan 1: netted out - Received unchanged
  approx(w.Material_Requirement[p1.mrqId].Received_Qty, recBefore[0], 1e-9);
  // plans 2,3: fresh 2 cones each received in full
  approx(w.Material_Requirement[sc.perPlan[1].mrqId].Received_Qty, recBefore[1] + 2, 1e-9);
  approx(w.Material_Requirement[sc.perPlan[2].mrqId].Received_Qty, recBefore[2] + 2, 1e-9);
  // the pre-existing dispute is unchanged (netting doesn't resolve it)
  approx(totalDisputed(w), 2);
});

// ===========================================================================
console.log('\nPART E — waste + printed still ride the receipt');

test('E1 waste piece received in full alongside a fabric sweep', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 10, reqPieces: 40 });
  // a remnant issued to him for the same item
  const wpId = nextId(w), mvId = nextId(w);
  w.Waste_Master[wpId] = { Piece_Count: 0, In_Transit_Count: 3, Disputed_Count: 0, Status: 'Issued', SKU: s.matId };
  w.Waste_Movement[mvId] = { Movement_Type: 'Issued', Piece_Count: 3, Waste_Piece: wpId, Plan: s.planId, Plan_Item: s.itemId, Parent_Movement: null, Moved_By: 'SUP1' };

  const m = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 40, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 8, fromRaw: 40, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m)]);

  runReceive(w, 'SUP1', screenView(w, 'SUP1'), {}, { waste: [{ rowId: mvId, received: 3, remark: '' }] });

  approx(w.Waste_Master[wpId].In_Transit_Count, 0, 1e-9);
  assert.strictEqual(totalDisputed(w), 0);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
});

test('E2 waste piece short -> its own dispute, fabric still conserved', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 10, reqPieces: 40 });
  const wpId = nextId(w), mvId = nextId(w);
  w.Waste_Master[wpId] = { Piece_Count: 0, In_Transit_Count: 3, Disputed_Count: 0, Status: 'Issued', SKU: s.matId };
  w.Waste_Movement[mvId] = { Movement_Type: 'Issued', Piece_Count: 3, Waste_Piece: wpId, Plan: s.planId, Plan_Item: s.itemId, Parent_Movement: null, Moved_By: 'SUP1' };

  const m = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 40, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 8, fromRaw: 40, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m)]);
  runReceive(w, 'SUP1', screenView(w, 'SUP1'), {}, { waste: [{ rowId: mvId, received: 1, remark: 'two missing' }] });

  approx(w.Waste_Master[wpId].Disputed_Count, 2);
  assert.strictEqual(w.Stock_Dispute.filter(d => d.Is_Waste).length, 1);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9); // fabric fully received
});

console.log('\n========================================');
console.log('receive-lifecycle: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg)); process.exit(1); }
