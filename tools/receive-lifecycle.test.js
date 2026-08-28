#!/usr/bin/env node
// LIFECYCLE: plan-time requirement -> widget builds the issue payload ->
// issueMaterials applies it -> widget builds the receive payload ->
// receiveMaterials applies it (chunked + resumable finalize).
//
// The point of this file is the OPTIMISATION CLAIM: "nothing changed in
// functionality, just optimised". So every test asserts CONSERVATION and
// EQUIVALENCE, not a specific number:
//
//   - every metre / piece that left the shelf is either received or disputed,
//     never lost and never duplicated;
//   - In_Transit returns to exactly 0 once the receipt is settled;
//     Settled_Qty == Qty on every line;
//   - a receipt applied in ONE call and the SAME receipt applied in N chunks
//     (finalize resumed over a budget) leave byte-identical ledger state;
//   - the readiness sweep rolls Item_Status / Order_Status to the same place
//     whether swept in one pass or resumed across SWEEP_BUDGET slices.
//
// Ports mirror the .dg files:
//   issueApply       deluge/issueMaterials.dg  (allocation-applier body)
//   recvApply        deluge/receiveMaterials.dg (settlement-applier + sweep)
//   buildIssuePayload  app/js/main.js buildFabricIssueLine + accessory branch
//   buildRecvPayload   app/supervisor/js/receive.js submitReceipt distribution
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
// A tiny in-memory Creator: the four forms these functions touch, addressed
// by id, so a "point lookup" in the port is just a map read.
// ---------------------------------------------------------------------------
function makeWorld() {
  return {
    Raw_Material: {},         // id -> {Is_Fabric, Unit, Wash_Quantity, Quantity, In_Transit_Qty, Disputed_Qty, ...}
    Raw_Material_Lot: {},     // id -> {Wash_Quantity, In_Transit_Qty, Disputed_Qty, Lot_Number}
    Material_Requirement: {}, // id -> {Plan, Plan_Item, Material, Material_Name, Unit, Is_Fabric, Required_Qty, Required_Pieces, Issued_Qty, Received_Qty, Pieces_From_Raw, Pieces_From_Waste, Issued_Lot, Source}
    Plan_Item: {},            // id -> {Plan, Item_Status}
    Production_Planning: {},   // id -> {Order_Status, Sales_Order}
    Material_Issue: {},        // id -> {Voucher_No, Issue_Status, Issued_To, Plan, Issue_Lines: [ {ID, Material, Material_Name, Qty, Unit, Cut_Size_Width, Cut_Size_Length, Settled_Qty, Lot, Requirement, Plan_Item, Lot_Override_Note} ]}
    Stock_Dispute: [],        // list of raised disputes
    Waste_Movement: {},       // id -> {Movement_Type, Piece_Count, Waste_Piece, Plan, Plan_Item, Parent_Movement}
    Waste_Master: {},         // id -> {Piece_Count, In_Transit_Count, Disputed_Count, Status, SKU}
    _seq: 1000
  };
}
function nextId(w) { return String(++w._seq); }

// ---------------------------------------------------------------------------
// PORT: issueMaterials body (allocation-applier). One chunk = one call.
// Mirrors deluge/issueMaterials.dg steps 1-6. Returns the SIV voucher id.
// ---------------------------------------------------------------------------
function issueApply(w, supId, issues) {
  const errs = [];
  const issueLines = [];
  let primaryPlanId = 0;

  issues.forEach(issue => {
    const matId = String(issue.materialId);
    const cutW = Number(issue.cutWidth) || 0;
    const cutL = Number(issue.cutLength) || 0;
    const mat = w.Raw_Material[matId];
    if (!mat) { errs.push('Material ' + matId + ' not found'); return; }
    const isFab = !!mat.Is_Fabric;

    let issuedTotal = 0;

    // 1. allocations
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

    // 2. remnant picks
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

    // 3. lot moves
    (issue.lotMoves || []).forEach(lm => {
      const lot = w.Raw_Material_Lot[String(lm.lotId)];
      if (!lot) { errs.push(mat.SKU + ': lot ' + lm.lotId + ' not found'); return; }
      const q = Number(lm.qty) || 0;
      let newWash = (Number(lot.Wash_Quantity) || 0) - q;
      if (newWash < 0) { errs.push(mat.SKU + ': lot clamped'); newWash = 0; }
      lot.Wash_Quantity = newWash;
      lot.In_Transit_Qty = (Number(lot.In_Transit_Qty) || 0) + q;
    });

    // 4. parent Raw_Material move
    const avail = isFab ? (Number(mat.Wash_Quantity) || 0) : (Number(mat.Quantity) || 0);
    const balance = avail - issuedTotal;
    if (isFab) {
      mat.Wash_Quantity = balance;
      mat.Quantity = balance + (Number(mat.Unwash_Quantity) || 0) + (Number(mat.Unallocated_Qty) || 0);
    } else {
      mat.Quantity = balance;
    }
    mat.In_Transit_Qty = (Number(mat.In_Transit_Qty) || 0) + issuedTotal;

    // 5. gather Issue_Lines
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

  // 6. voucher
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
      Issue_Lines: lines
    };
  }
  return { voucherId, errs };
}

// ---------------------------------------------------------------------------
// PORT: receiveMaterials body. One call = one chunk. finalize:true runs the
// readiness sweep over at most SWEEP_BUDGET of plansTouched and returns
// sweepRemaining; the caller loops until sweepDone.
// ---------------------------------------------------------------------------
const SWEEP_BUDGET = 15;

function recvApply(w, supId, payload) {
  const errs = [];
  const doFinalize = String(payload.finalize === undefined ? 'true' : payload.finalize) !== 'false';
  const mats = payload.materials || [];
  const wastes = payload.waste || [];
  const printed = payload.printedPieces || [];
  const plansTouched = [];
  (payload.plansTouched || []).forEach(p => {
    const s = String(p).trim();
    if (s && plansTouched.indexOf(s) < 0) plansTouched.push(s);
  });
  const touchedVoucherIds = [];

  // ---- materials: apply each settlement ----
  mats.forEach(mm => {
    const matId = String(mm.materialId);
    if (!matId) { errs.push('Material : invalid'); return; }
    let settledTot = 0, confirmedTot = 0, shortTot = 0;

    (mm.settlements || []).forEach(st => {
      const settleQ = Number(st.settle) || 0;
      let confirmQ = Number(st.confirmed) || 0;
      if (confirmQ > settleQ) confirmQ = settleQ;
      const shortQ = settleQ - confirmQ;
      if (settleQ <= 0) return;

      // 1. settle the Issue_Line via its voucher
      if (touchedVoucherIds.indexOf(String(st.voucherId)) < 0) touchedVoucherIds.push(String(st.voucherId));
      const voucher = w.Material_Issue[String(st.voucherId)];
      let lineFound = false;
      if (voucher) {
        const ln = voucher.Issue_Lines.filter(x => String(x.ID) === String(st.issueLineId))[0];
        if (ln) {
          lineFound = true;
          const room = (Number(ln.Qty) || 0) - (Number(ln.Settled_Qty) || 0);
          let applyS = settleQ;
          if (applyS > room) applyS = Math.max(0, room);
          ln.Settled_Qty = (Number(ln.Settled_Qty) || 0) + applyS;
        }
      }
      if (!lineFound) { errs.push('Material ' + matId + ': issue line ' + st.issueLineId + ' not found'); return; }

      settledTot += settleQ; confirmedTot += confirmQ; shortTot += shortQ;

      // 2. credit the requirement
      if (st.requirementId) {
        const req = w.Material_Requirement[String(st.requirementId)];
        if (req) req.Received_Qty = (Number(req.Received_Qty) || 0) + confirmQ;
      }

      // 3. lot In_Transit -> production / disputed
      if (st.lot) {
        const lot = w.Raw_Material_Lot[String(st.lot)];
        if (lot) {
          const ltIn = Number(lot.In_Transit_Qty) || 0;
          const offIt = Math.min(settleQ, ltIn);
          lot.In_Transit_Qty = ltIn - offIt;
          if (shortQ > 0) lot.Disputed_Qty = (Number(lot.Disputed_Qty) || 0) + shortQ;
        }
      }
    });

    // 5. parent Raw_Material
    if (settledTot > 0) {
      const mat = w.Raw_Material[matId];
      if (mat) {
        const itQty = Number(mat.In_Transit_Qty) || 0;
        const offParent = Math.min(settledTot, itQty);
        mat.In_Transit_Qty = itQty - offParent;
        if (shortTot > 0) mat.Disputed_Qty = (Number(mat.Disputed_Qty) || 0) + shortTot;
      }
    }

    // 6. one dispute per plan carrying a gap
    if (shortTot > 0) {
      const perPlan = {};
      (mm.settlements || []).forEach(st => {
        const settleQ = Number(st.settle) || 0;
        let confirmQ = Number(st.confirmed) || 0;
        if (confirmQ > settleQ) confirmQ = settleQ;
        const shortQ = settleQ - confirmQ;
        if (shortQ > 0 && st.planId) {
          perPlan[st.planId] = perPlan[st.planId] || { short: 0, pend: 0, got: 0 };
          perPlan[st.planId].short += shortQ;
          perPlan[st.planId].pend += settleQ;
          perPlan[st.planId].got += confirmQ;
        }
      });
      Object.keys(perPlan).forEach(pid => {
        w.Stock_Dispute.push({
          Material: matId, Supervisor: supId, Plan: pid,
          Direction: 'Outbound', Is_Waste: false, Status: 'Open',
          Issued_Qty: perPlan[pid].pend, Received_Qty: perPlan[pid].got,
          Disputed_Qty: perPlan[pid].short
        });
      });
    }
  });

  // ---- waste (unchanged shape; point lookup on Waste_Movement) ----
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
      w.Stock_Dispute.push({ Material: wm ? wm.SKU : null, Supervisor: supId, Plan: wi.Plan, Direction: 'Outbound', Is_Waste: true, Status: 'Open', Disputed_Qty: stillOut, Waste_Piece: wi.Waste_Piece });
    }
  });

  // ---- printed pieces (point lookup on voucher) ----
  printed.forEach(pr => {
    if (touchedVoucherIds.indexOf(String(pr.voucherId)) < 0) touchedVoucherIds.push(String(pr.voucherId));
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
      w.Stock_Dispute.push({ Material: ln.Material, Supervisor: supId, Direction: 'Outbound', Is_Waste: false, Status: 'Open', Disputed_Qty: stillOutP });
    }
  });

  // ---- voucher Issue_Status, off the lines this receipt just settled ----
  // Runs on EVERY call, not just finalize. Per voucher, off its own Issue_Lines
  // — no dependency on Material_Issue.Plan or plansTouched.
  touchedVoucherIds.forEach(vId => {
    const v = w.Material_Issue[String(vId)];
    if (!v || v.Issue_Status === 'Received') return;
    let anyLine = false, allSettled = true;
    v.Issue_Lines.forEach(ln => {
      anyLine = true;
      if ((Number(ln.Settled_Qty) || 0) < (Number(ln.Qty) || 0)) allSettled = false;
    });
    v.Issue_Status = (anyLine && allSettled) ? 'Received' : 'Partially_Received';
  });

  // ---- readiness sweep, budgeted + resumable ----
  let sweepRemaining = [];
  let sweepAllDone = true;
  const sweepPlans = [];
  if (doFinalize) {
    plansTouched.forEach((pid, i) => {
      if (i < SWEEP_BUDGET) sweepPlans.push(pid);
      else { sweepAllDone = false; sweepRemaining.push(pid); }
    });
  }
  sweepPlans.forEach(pid => {
    const plan = w.Production_Planning[pid];
    if (!plan) return;
    const items = Object.keys(w.Plan_Item).map(k => w.Plan_Item[k]).filter(pi => String(pi.Plan) === pid);
    let allReady = 0, total = 0;
    items.forEach(pItem => {
      total++;
      let itemReady = true, reqCount = 0;
      Object.keys(w.Material_Requirement).forEach(k => {
        const row = w.Material_Requirement[k];
        if (String(row.Plan_Item) !== String(pItem._id)) return;
        reqCount++;
        const issQty = Number(row.Issued_Qty) || 0;
        const recQty = Number(row.Received_Qty) || 0;
        const reqQty = Number(row.Required_Qty) || 0;
        if (recQty < issQty) { itemReady = false; }
        if (row.Is_Fabric) {
          const reqPcs = Number(row.Required_Pieces) || 0;
          const issPcs = (Number(row.Pieces_From_Waste) || 0) + (Number(row.Pieces_From_Raw) || 0);
          if (reqPcs <= 0 || issPcs < reqPcs) itemReady = false;
        } else {
          if (reqQty <= 0 || issQty < reqQty) itemReady = false;
        }
      });
      if (reqCount === 0) itemReady = false;
      if (itemReady && pItem.Item_Status === 'Awaiting_Material') pItem.Item_Status = 'Ready_For_Production';
      if (pItem.Item_Status !== 'Awaiting_Material') allReady++;
    });
    const st = plan.Order_Status;
    if (total > 0 && allReady > 0 && st !== 'In Progress' && st !== 'Production Complete') {
      if (allReady === total) plan.Order_Status = 'Material Ready';
      else if (st === 'Pending') plan.Order_Status = 'Partially Received';
    }
  });

  return { errs, sweepRemaining, sweepDone: sweepAllDone };
}

// ---------------------------------------------------------------------------
// PORT: the widget's issue-payload builder for ONE fabric material.
// Mirrors app/js/main.js buildFabricIssueLine — but the allocator's lotLines
// are supplied directly here (its full logic is covered by allocator.test.js
// and deluge-maths.test.js PART B), so this only exercises the payload shaping
// that feeds the two Deluge functions under test.
// ---------------------------------------------------------------------------
function buildIssuePayload(m) {
  // m: { materialId, unit, cutWidth, cutLength, isReissue,
  //      lines: [ {mrqId, planId, planItemId, reqPieces, issPieces} ],
  //      lotLines: [ {lotId, planItemId, qty, fromRaw, fromWaste, note} ],
  //      wastePicks: [ {wasteId, planItemId, width, length} ],
  //      picks: [ {wasteId, planItemId, pieces} ] }
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
// remnantYield — verbatim from app/js/lot-allocator.js:74
function remnantYield(rr, cutW, cutL) {
  const wv = Number(rr.width) || 0, lv = Number(rr.length) || 0;
  if (!(cutW > 0 && cutL > 0) || wv < cutW || lv < cutL) return 0;
  return Math.floor(wv / cutW) * Math.floor(lv / cutL);
}

// ---------------------------------------------------------------------------
// PORT: app/supervisor/js/receive.js submitReceipt — distribute the confirmed
// quantity across m.lines oldest-first, then chunk.
// ---------------------------------------------------------------------------
function buildRecvMaterials(screenMaterials, receivedByMat) {
  // screenMaterials: what getSupervisorMaterials emits — each with .lines[]
  //   ({issueLineId, voucherId, lot, requirementId, planId, pending}), newest first.
  // receivedByMat: {materialId -> metres he confirms}
  const out = [];
  const plansTouched = {};
  screenMaterials.forEach(m => {
    const val = receivedByMat[m.materialId] === undefined ? m.pending : receivedByMat[m.materialId];
    let v = val; if (v < 0) v = 0; if (v > m.pending) v = m.pending;
    const lines = (m.lines || []).slice().reverse(); // oldest first
    let confirmLeft = r2(v);
    const settlements = [];
    lines.forEach(ln => {
      const owe = Number(ln.pending) || 0;
      if (owe <= 0) return;
      let conf = confirmLeft;
      if (conf > owe) conf = owe;
      confirmLeft = r2(confirmLeft - conf);
      settlements.push({ issueLineId: ln.issueLineId, voucherId: ln.voucherId, lot: ln.lot || '', requirementId: ln.requirementId || '', planId: ln.planId || '', settle: r2(owe), confirmed: r2(conf) });
      if (ln.planId) plansTouched[String(ln.planId)] = 1;
    });
    out.push({ materialId: m.materialId, received: r2(v), remark: '', settlements });
  });
  return { materials: out, plansTouched: Object.keys(plansTouched) };
}

function chunkReceipt(materials, plansTouched, MAX_ROWS) {
  const work = [];
  materials.forEach(m => {
    (m.settlements || []).forEach(s => work.push({ materialId: m.materialId, received: m.received, remark: m.remark, s }));
    if (!m.settlements || m.settlements.length === 0) work.push({ materialId: m.materialId, received: m.received, remark: m.remark, s: null });
  });
  const chunks = [];
  for (let off = 0; off < work.length; off += MAX_ROWS) {
    const slice = work.slice(off, off + MAX_ROWS);
    const matMap = {}, order = [];
    slice.forEach(it => {
      let mw = matMap[it.materialId];
      if (!mw) { mw = { materialId: it.materialId, received: it.received, remark: it.remark, settlements: [] }; matMap[it.materialId] = mw; order.push(it.materialId); }
      if (it.s) mw.settlements.push(it.s);
    });
    chunks.push({ materials: order.map(id => matMap[id]), waste: [], printedPieces: [], plansTouched: [], finalize: false });
  }
  if (chunks.length === 0) chunks.push({ materials: [], waste: [], printedPieces: [], plansTouched: [], finalize: false });
  return chunks;
}

// Run the whole receive: N settlement chunks (finalize:false), then finalize
// loop resumed over SWEEP_BUDGET until sweepDone.
function runReceive(w, supId, materials, plansTouched, MAX_ROWS) {
  const chunks = chunkReceipt(materials, plansTouched, MAX_ROWS);
  chunks.forEach(cp => { recvApply(w, supId, cp); });
  let queue = plansTouched.slice();
  let guard = 0;
  for (;;) {
    const res = recvApply(w, supId, { materials: [], waste: [], printedPieces: [], finalize: true, plansTouched: queue });
    if (res.sweepDone || res.sweepRemaining.length === 0) break;
    if (res.sweepRemaining.length >= queue.length) break; // no progress
    queue = res.sweepRemaining;
    if (++guard > 50) throw new Error('finalize loop did not converge');
  }
}

// ---------------------------------------------------------------------------
// Build getSupervisorMaterials' "still-owed" view from the world — the read
// side, so the widget's receive payload is built from the same lines the
// issue actually wrote.
// ---------------------------------------------------------------------------
function screenView(w, supId) {
  const byMat = {};
  Object.keys(w.Material_Issue).forEach(vId => {
    const v = w.Material_Issue[vId];
    if (String(v.Issued_To) !== String(supId)) return;
    v.Issue_Lines.forEach(ln => {
      const pend = (Number(ln.Qty) || 0) - (Number(ln.Settled_Qty) || 0);
      if (pend <= 0) return;
      const mId = String(ln.Material);
      if (!byMat[mId]) {
        const mat = w.Raw_Material[mId] || {};
        byMat[mId] = { materialId: mId, unit: mat.Unit || '', pending: 0, lines: [] };
      }
      byMat[mId].pending = r2(byMat[mId].pending + pend);
      const req = ln.Requirement ? w.Material_Requirement[String(ln.Requirement)] : null;
      byMat[mId].lines.push({
        issueLineId: String(ln.ID), voucherId: String(vId),
        lot: ln.Lot ? String(ln.Lot) : '',
        requirementId: ln.Requirement ? String(ln.Requirement) : '',
        planId: req ? String(req.Plan) : '',
        pending: pend
      });
    });
  });
  // newest voucher first — mimic Added_Time desc by reversing insertion order
  return Object.keys(byMat).map(k => {
    byMat[k].lines.reverse();
    return byMat[k];
  });
}

// ---------------------------------------------------------------------------
// SCENARIO BUILDERS
// ---------------------------------------------------------------------------
function seedFabricPlan(w, opts) {
  // one plan, one item, one fabric requirement + one lot with enough washed cloth
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

// ===========================================================================
console.log('PART A — issue then FULL receive: nothing lost, In_Transit returns to 0');

test('A1 full receipt: every issued metre is received, In_Transit 0, lines fully settled', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 18.70, reqPieces: 100 });
  // widget allocation: 18.70 m off L1, 100 fresh pieces
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

  // ledger after issue
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 18.70);
  approx(w.Raw_Material[s.matId].Wash_Quantity, 81.30);
  approx(w.Raw_Material_Lot[s.lotId].In_Transit_Qty, 18.70);
  approx(w.Material_Requirement[s.mrqId].Issued_Qty, 18.70);
  assert.strictEqual(w.Material_Requirement[s.mrqId].Pieces_From_Raw, 100);

  // widget builds the receive payload from the screen view, he confirms all
  const view = screenView(w, 'SUP1');
  const { materials, plansTouched } = buildRecvMaterials(view, {}); // {} => full pending
  runReceive(w, 'SUP1', materials, plansTouched, 120);

  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
  approx(w.Raw_Material_Lot[s.lotId].In_Transit_Qty, 0, 1e-9);
  approx(w.Material_Requirement[s.mrqId].Received_Qty, 18.70);
  approx(totalSettled(w), totalIssued(w));
  assert.strictEqual(totalDisputed(w), 0, 'nothing disputed on a full receipt');
  assert.strictEqual(w.Plan_Item[s.itemId].Item_Status, 'Ready_For_Production');
  assert.strictEqual(w.Production_Planning[s.planId].Order_Status, 'Material Ready');
  // THE BUG THIS TEST GUARDS: the voucher must read Received once every line
  // is settled - it used to depend on the readiness sweep and Material_Issue.Plan.
  var vId = Object.keys(w.Material_Issue)[0];
  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Received', 'voucher not marked Received after a full receipt');
});

test('A1b voucher flips even when its plan is NOT in plansTouched', () => {
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
  const { materials } = buildRecvMaterials(view, {});
  // plansTouched deliberately EMPTY - the old sweep-only flip would never run,
  // so the voucher would stay "Issued" for ever. The per-voucher check must
  // still close it.
  runReceive(w, 'SUP1', materials, [], 120);

  var vId = Object.keys(w.Material_Issue)[0];
  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Received', 'voucher stuck at Issued when plansTouched was empty');
  approx(totalSettled(w), totalIssued(w));
});

test('A1c chunked receive: a voucher whose last line lands in an early chunk is closed there, not at finalize', () => {
  // 3 plans, one accessory issue -> one voucher with 3 lines. MAX_ROWS 1 so
  // each line is its own chunk (finalize:false). The 3rd settlement chunk
  // settles the voucher's last line; the voucher must read Received after that
  // chunk, before the finalize call runs at all.
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 3);
  issueApply(w, 'SUP1', sc.issues);
  const vId = Object.keys(w.Material_Issue)[0];
  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Issued');

  const view = screenView(w, 'SUP1');
  const built = buildRecvMaterials(view, {}); // confirm all

  // Run ONLY the settlement chunks (no finalize), one row each.
  const chunks = chunkReceipt(built.materials, built.plansTouched, 1);
  chunks.forEach(cp => recvApply(w, 'SUP1', cp));

  assert.strictEqual(w.Material_Issue[vId].Issue_Status, 'Received',
    'voucher not Received after its last line settled in a non-finalize chunk');
});

test('A1d partial receipt against a material spanning two vouchers: BOTH settle (short => dispute), both Received', () => {
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

  // He confirms only 11 of the 20 owed. A short receipt settles the WHOLE
  // owed amount off in-transit and disputes the gap - so every line settles.
  const view = screenView(w, 'SUP1');
  const built = buildRecvMaterials(view, { [s.matId]: 11 });
  runReceive(w, 'SUP1', built.materials, built.plansTouched, 120);

  const statuses = Object.keys(w.Material_Issue).map(id => w.Material_Issue[id].Issue_Status).sort();
  assert.deepStrictEqual(statuses, ['Received', 'Received']);
  approx(totalSettled(w), totalIssued(w));
  approx(totalDisputed(w), 9); // the 9 he did not get
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

  const view = screenView(w, 'SUP1');
  // he only got 14.5 of the 20
  const { materials, plansTouched } = buildRecvMaterials(view, { [s.matId]: 14.5 });
  runReceive(w, 'SUP1', materials, plansTouched, 120);

  approx(w.Material_Requirement[s.mrqId].Received_Qty, 14.5);
  approx(totalDisputed(w), 5.5);
  approx(r2(w.Material_Requirement[s.mrqId].Received_Qty + totalDisputed(w)), 20);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
  approx(w.Raw_Material_Lot[s.lotId].In_Transit_Qty, 0, 1e-9);
  approx(w.Raw_Material[s.matId].Disputed_Qty, 5.5);
  approx(w.Raw_Material_Lot[s.lotId].Disputed_Qty, 5.5);
  // item NOT ready — a short fabric receipt leaves recQty < issQty
  assert.strictEqual(w.Plan_Item[s.itemId].Item_Status, 'Awaiting_Material');
  assert.strictEqual(w.Production_Planning[s.planId].Order_Status, 'Pending');
});

test('A3 split handover: two issues against one item, then one receipt settles both', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 18.70, reqPieces: 100 });
  // first issue: 60 pieces, 11 m
  const m1 = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 11, fromRaw: 60, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m1)]);
  // second issue: remaining 40 pieces, 7.70 m — issPieces now 60
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

  const view = screenView(w, 'SUP1');
  const { materials, plansTouched } = buildRecvMaterials(view, {}); // confirm all
  runReceive(w, 'SUP1', materials, plansTouched, 120);

  approx(w.Material_Requirement[s.mrqId].Received_Qty, 18.70);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
  approx(totalSettled(w), totalIssued(w));
  assert.strictEqual(w.Plan_Item[s.itemId].Item_Status, 'Ready_For_Production');
});

// ===========================================================================
console.log('\nPART B — EQUIVALENCE: chunked == single-call, resumed sweep == one sweep');

function buildManyPlanScenario(w, nPlans) {
  // one shared trim material issued against nPlans plans, one item each
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
  // one issue payload: an accessory line with one allocation per plan
  issues.push({
    materialId: matId, source: 'Plan', isFabric: false, cutWidth: 0, cutLength: 0,
    allocations: perPlan.map(p => ({ mrqId: p.mrqId, planId: p.planId, planItemId: p.itemId, giveQty: 2, giveRaw: 0, giveWaste: 0, issuedLot: '' })),
    lotMoves: [], wastePicks: [],
    issueLines: perPlan.map(p => ({ mrqId: p.mrqId, planItemId: p.itemId, lotId: '', qty: 2, unit: 'Cone', cutW: 0, cutL: 0, note: '', overrideFrom: '' }))
  });
  return { matId, perPlan, issues };
}

test('B1 chunked receipt == single-call receipt (identical end state)', () => {
  // world A: one call. world B: chunks of 7 settlement rows + resumed finalize.
  function play(MAX_ROWS) {
    const w = makeWorld();
    const sc = buildManyPlanScenario(w, 20);
    issueApply(w, 'SUP1', sc.issues);
    const view = screenView(w, 'SUP1');
    const { materials, plansTouched } = buildRecvMaterials(view, {}); // confirm all
    runReceive(w, 'SUP1', materials, plansTouched, MAX_ROWS);
    return w;
  }
  const wSingle = play(9999);
  const wChunked = play(7);
  assert.strictEqual(snapshot(wChunked), snapshot(wSingle), 'chunked and single-call ledgers diverge');
});

test('B2 resumed sweep (SWEEP_BUDGET slices) == one sweep: all plans roll to Material Ready', () => {
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 40); // > 2x SWEEP_BUDGET, forces >=3 finalize passes
  issueApply(w, 'SUP1', sc.issues);
  const view = screenView(w, 'SUP1');
  const { materials, plansTouched } = buildRecvMaterials(view, {});
  assert.strictEqual(plansTouched.length, 40);
  runReceive(w, 'SUP1', materials, plansTouched, 120);

  sc.perPlan.forEach(p => {
    approx(w.Material_Requirement[p.mrqId].Received_Qty, 2);
    assert.strictEqual(w.Plan_Item[p.itemId].Item_Status, 'Ready_For_Production', 'item ' + p.itemId + ' not ready');
    assert.strictEqual(w.Production_Planning[p.planId].Order_Status, 'Material Ready', 'plan ' + p.planId + ' not rolled');
  });
  approx(w.Raw_Material[sc.matId].In_Transit_Qty, 0, 1e-9);
  assert.strictEqual(totalDisputed(w), 0);
});

test('B3 finalize is idempotent: running it again changes nothing', () => {
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 18);
  issueApply(w, 'SUP1', sc.issues);
  const view = screenView(w, 'SUP1');
  const { materials, plansTouched } = buildRecvMaterials(view, {});
  runReceive(w, 'SUP1', materials, plansTouched, 120);
  const before = snapshot(w);
  // widget re-press: settlements find lines already fully settled, sweep re-runs
  runReceive(w, 'SUP1', materials, plansTouched, 120);
  assert.strictEqual(snapshot(w), before, 're-running the whole receive mutated state');
});

test('B4 chunk boundary does not double-settle a line split across chunks', () => {
  // 3 plans, MAX_ROWS 1 -> every settlement is its own chunk + its own finalize-less call
  const w = makeWorld();
  const sc = buildManyPlanScenario(w, 3);
  issueApply(w, 'SUP1', sc.issues);
  const view = screenView(w, 'SUP1');
  const { materials, plansTouched } = buildRecvMaterials(view, {});
  runReceive(w, 'SUP1', materials, plansTouched, 1);
  approx(totalSettled(w), totalIssued(w));
  approx(w.Raw_Material[sc.matId].In_Transit_Qty, 0, 1e-9);
  sc.perPlan.forEach(p => approx(w.Material_Requirement[p.mrqId].Received_Qty, 2));
});

// ===========================================================================
console.log('\nPART C — conservation invariants across a mixed receipt');

test('C1 partial-then-final: two receipts against one voucher settle exactly once each', () => {
  const w = makeWorld();
  const s = seedFabricPlan(w, { washOnShelf: 100, reqQty: 18.70, reqPieces: 100 });
  const m = {
    materialId: s.matId, unit: 'Mtr', cutWidth: 55, cutLength: 55, isReissue: false,
    lines: [{ mrqId: s.mrqId, planId: s.planId, planItemId: s.itemId, reqPieces: 100, issPieces: 0 }],
    lotLines: [{ lotId: s.lotId, planItemId: s.itemId, qty: 18.70, fromRaw: 100, fromWaste: 0, note: '' }],
    wastePicks: [], picks: []
  };
  issueApply(w, 'SUP1', [buildIssuePayload(m)]);

  // FIRST receipt: he confirms 10 of 18.70. The rest stays pending (short =>
  // dispute for 8.70). NOTE: this mirrors the real behaviour — a short receipt
  // settles the whole line and disputes the gap.
  let view = screenView(w, 'SUP1');
  let built = buildRecvMaterials(view, { [s.matId]: 10 });
  runReceive(w, 'SUP1', built.materials, built.plansTouched, 120);

  approx(w.Material_Requirement[s.mrqId].Received_Qty, 10);
  approx(totalDisputed(w), 8.70);
  approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
  approx(totalSettled(w), totalIssued(w), 1e-9);

  // SECOND receipt: nothing is still owed on the screen (line fully settled),
  // so the widget sends an empty settlement set and only the finalize sweep runs.
  view = screenView(w, 'SUP1');
  assert.strictEqual(view.length, 0, 'nothing should be pending after the short receipt settled the line');
  built = buildRecvMaterials(view, {});
  const before = snapshot(w);
  runReceive(w, 'SUP1', built.materials, built.plansTouched, 120);
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
    const view = screenView(w, 'SUP1');
    const built = buildRecvMaterials(view, c.conf === undefined ? {} : { [s.matId]: c.conf });
    runReceive(w, 'SUP1', built.materials, built.plansTouched, 120);
    const rec = w.Material_Requirement[s.mrqId].Received_Qty;
    const dis = totalDisputed(w);
    approx(r2(rec + dis), issued, 1e-9);
    approx(w.Raw_Material[s.matId].In_Transit_Qty, 0, 1e-9);
    approx(w.Raw_Material_Lot[s.lotId].In_Transit_Qty, 0, 1e-9);
    approx(totalSettled(w), issued, 1e-9);
  });
});

console.log('\n========================================');
console.log('receive-lifecycle: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg)); process.exit(1); }
