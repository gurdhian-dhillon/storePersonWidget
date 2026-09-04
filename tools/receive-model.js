/* =============================================================================
 * REFERENCE MODEL for the new receiveMaterials — the arithmetic only, so the
 * lifecycle can be tested in Node before it is transcribed to Deluge.
 *
 * NEW GRAIN: Material_Issue.Issue_Lines are one row per (voucher, material,
 * lot). They carry Qty (issued), Received_Qty, Disputed_Qty, Line_Status. They
 * do NOT carry Requirement.
 *
 * receiveMaterials does TWO things per confirmed handover:
 *
 *  1. SETTLE the Issue_Lines (handover record — feeds postTransferOrders):
 *       arrived  = the amount the supervisor confirmed for this material×lot
 *                  (full owed, or the short figure he typed for that material,
 *                  split across that material's lines oldest-line-first)
 *       Received_Qty  += arrived
 *       Disputed_Qty   = Qty - Received_Qty
 *       Line_Status    = Received | Partially_Received | Disputed
 *
 *  2. FAN the arrived amount back to Material_Requirement (readiness test):
 *       for each still-owed requirement of that material, oldest-first,
 *       credit Received_Qty up to (Issued_Qty - Received_Qty). The shortfall
 *       that could not be credited stays as Disputed_Qty on the requirement
 *       and raises one Stock_Dispute per (plan, material), stamped with the
 *       voucher SIV.
 *
 * DISPUTE NETTING: the figure the supervisor types is already net of open
 * disputes (same as the screen). So an open dispute for (plan, material)
 * reduces the owed amount before it is settled — drawn down as applied so it
 * is not netted twice.
 *
 * INVARIANTS the lifecycle test asserts:
 *   I1  Issue_Line: Qty === Received_Qty + Disputed_Qty   (always, after settle)
 *   I2  per material, Σ Issue_Line Received_Qty === Σ requirement Received_Qty
 *       credited from this receipt   (the fan conserves quantity)
 *   I3  requirement Received_Qty <= Issued_Qty   (never over-credit)
 *   I4  nothing goes negative
 *   I5  Raw_Material.In_Transit_Qty drops by exactly the settled amount
 *       (arrived + short), never below 0
 *   I6  a fully-received handover has every line Line_Status "Received" and
 *       raises no dispute
 * ========================================================================== */
'use strict';

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ---- world -----------------------------------------------------------------
// state = {
//   issues: [ { id, voucher, supId, lines: [
//       { id, materialId, lot, qty, receivedQty, disputedQty, lineStatus } ] } ],
//   requirements: [ { id, planId, planItemId, supId, materialId,
//       issuedQty, receivedQty, disputedQty, addedSeq } ],
//   rawMaterials: { matId: { inTransitQty, disputedQty } },
//   lots:        { lotId: { inTransitQty, disputedQty } },
//   disputes:    [ { id, planId, materialId, voucher, issuedQty, receivedQty,
//       disputedQty, status, resolutionLines: [ { resolvedQty } ] } ],
//   nextDisputeId: 1
// }

// Open outbound, non-waste disputed quantity for a material, across every plan.
function openDisputeLeftForMat(state, matId) {
  let left = 0;
  state.disputes.forEach((d) => {
    if (d.status !== 'Open') return;
    if (d.isWaste) return;
    if ((d.direction || 'Outbound') !== 'Outbound') return;
    if (String(d.materialId) !== String(matId)) return;
    const res = (d.resolutionLines || []).reduce((t, r) => t + (Number(r.resolvedQty) || 0), 0);
    left += Math.max(0, (Number(d.disputedQty) || 0) - res);
  });
  return r2(left);
}

function openDisputeLeft(state, planId, matId) {
  let left = 0;
  state.disputes.forEach((d) => {
    if (d.status !== 'Open') return;
    if (String(d.planId) !== String(planId) || String(d.materialId) !== String(matId)) return;
    const res = (d.resolutionLines || []).reduce((t, r) => t + (Number(r.resolvedQty) || 0), 0);
    left += Math.max(0, (Number(d.disputedQty) || 0) - res);
  });
  return left;
}

// receiptsJson equivalent:
//   { vouchers: [voucherId,...],
//     shortMaterials: [ { materialId, owed, received, remark } ] }
// "received" is what actually arrived for that material across the named
// vouchers; anything not listed = received in full.
function receiveMaterials(state, receipts) {
  const supId = receipts.supId;
  const voucherSet = new Set((receipts.vouchers || []).map(String));
  const shortByMat = {};       // matId -> received (arrived) figure typed
  const shortRemark = {};
  (receipts.shortMaterials || []).forEach((s) => {
    shortByMat[String(s.materialId)] = Number(s.received) || 0;
    shortRemark[String(s.materialId)] = s.remark || '';
  });

  // shortLeft: matId -> how much of the typed "arrived" figure is still to
  // credit as it walks that material's lines. Seeded from shortByMat.
  const shortLeft = Object.assign({}, shortByMat);

  // per-receipt accumulators
  const settledByMat = {};     // matId -> total owed settled (arrived + short)
  const arrivedByMat = {};     // matId -> arrived (confirmed) part
  const shortAmtByMat = {};    // matId -> short part
  const settledByLot = {};
  const shortByLot = {};
  const voucherOfMat = {};     // matId -> voucher (for dispute stamp; first seen)

  // ---- 1. SETTLE THE ISSUE LINES, per (voucher, material, lot) ----
  // Walk confirmed vouchers; within each, walk lines. For a material with a
  // short figure, arrived is drawn from shortLeft, oldest-line-first.
  state.issues.forEach((mi) => {
    if (String(mi.supId) !== String(supId)) return;
    if (!voucherSet.has(String(mi.id))) return;
    mi.lines.forEach((ln) => {
      const matId = String(ln.materialId);
      const lot = String(ln.lot || '');

      // TOTALS from what the line already holds, so a line settled by an
      // earlier call still reports itself to the fan (which credits only the
      // difference). This is what makes a failed fan recoverable.
      const rcvNow = Number(ln.receivedQty) || 0;
      const dspNow = Number(ln.disputedQty) || 0;
      if (rcvNow > 0 || dspNow > 0) {
        arrivedByMat[matId] = r2((arrivedByMat[matId] || 0) + rcvNow);
        if (dspNow > 0) shortAmtByMat[matId] = r2((shortAmtByMat[matId] || 0) + dspNow);
        if (!voucherOfMat[matId]) voucherOfMat[matId] = String(mi.voucher || mi.id);
      }

      // OWED is what receipt has not accounted for at all — Qty minus arrived
      // minus disputed. Qty - receivedQty alone would make a short line look
      // unsettled for ever and a second Confirm would mark the disputed part
      // received.
      const owedFull = r2((Number(ln.qty) || 0) - rcvNow - dspNow);
      if (owedFull <= 0) return;

      // NO DISPUTE NETTING. Every line records its own disputedQty, so an
      // earlier handover's shortfall is accounted on THAT line and this line's
      // owed is genuinely this line's. Netting on top would suppress real
      // pending metres and break qty === received + disputed. Duplicate
      // disputes are prevented in the fan, where toDispute is the short TOTAL
      // minus what is already open for the material.
      const owed = owedFull;

      // Split owed into arrived vs short using the typed figure.
      let arrived = owed;
      let short = 0;
      if (shortLeft[matId] != null) {
        const sl = shortLeft[matId];
        if (sl >= owed) { arrived = owed; shortLeft[matId] = r2(sl - owed); }
        else { arrived = Math.max(0, sl); shortLeft[matId] = 0; }
        short = r2(owed - arrived);
      }

      // Settle the line: the WHOLE owed leaves in-transit this receipt.
      // Received and Disputed each grow by their own share of owed, so
      // qty === receivedQty + disputedQty holds exactly.
      ln.receivedQty = r2(rcvNow + arrived);
      ln.disputedQty = r2(dspNow + short);
      ln.lineStatus = ln.disputedQty <= 0 ? 'Received'
        : (ln.receivedQty > 0 ? 'Partially_Received' : 'Disputed');

      settledByMat[matId] = r2((settledByMat[matId] || 0) + owed);
      arrivedByMat[matId] = r2((arrivedByMat[matId] || 0) + arrived);
      if (short > 0) shortAmtByMat[matId] = r2((shortAmtByMat[matId] || 0) + short);
      if (lot) {
        settledByLot[lot] = r2((settledByLot[lot] || 0) + owed);
        if (short > 0) shortByLot[lot] = r2((shortByLot[lot] || 0) + short);
      }
      if (!voucherOfMat[matId]) voucherOfMat[matId] = String(mi.voucher || mi.id);
    });
  });

  // ---- 2. FAN the arrived amount to Material_Requirement, oldest-first ----
  // For each material with an arrived amount, credit its still-owed
  // requirements (oldest addedSeq first) up to Issued_Qty - Received_Qty.
  // The shortfall (settled - arrived, i.e. shortAmtByMat) is applied to the
  // requirement Disputed_Qty on the newest rows and raises a Stock_Dispute
  // per (plan, material).
  const raisedDisputeIds = [];

  // WHAT IS LEFT TO FAN, off the LINE WATERMARKS of the vouchers in scope.
  //   fannedQty        - how much of receivedQty is already credited
  //   disputeRaisedQty - how much of disputedQty already has a Stock_Dispute
  // Same idiom as Settled/Transferred in postTransferOrders. This is the only
  // formulation correct in all four cases: fan died, receipt repeated,
  // handovers confirmed SEPARATELY, and a Store_Correction having since
  // reduced Issued_Qty. Comparing a scope-limited line total against the
  // all-time requirement total under-credits the second of two handovers.
  const toCreditByMat = {};
  const toDisputeByMat = {};
  const scopeLines = [];
  state.issues.forEach((mi) => {
    if (String(mi.supId) !== String(supId)) return;
    if (!voucherSet.has(String(mi.id))) return;
    mi.lines.forEach((ln) => {
      scopeLines.push(ln);
      const m = String(ln.materialId);
      const credit = r2((Number(ln.receivedQty) || 0) - (Number(ln.fannedQty) || 0));
      if (credit > 0) toCreditByMat[m] = r2((toCreditByMat[m] || 0) + credit);
      const disp = r2((Number(ln.disputedQty) || 0) - (Number(ln.disputeRaisedQty) || 0));
      if (disp > 0) toDisputeByMat[m] = r2((toDisputeByMat[m] || 0) + disp);
    });
  });

  Object.keys(toCreditByMat).concat(Object.keys(toDisputeByMat))
    .filter((m, i, a) => a.indexOf(m) === i)
    .forEach((matId) => {
    // BOUNDED TO OPEN PLANS - an abandoned owed row on a finished plan would
    // swallow the credit oldest-first and starve the plan actually received for.
    // planOpen defaults true so a fixture that does not care need not set it.
    const openRows = state.requirements
      .filter((rq) => String(rq.supId) === String(supId)
        && String(rq.materialId) === matId
        && rq.planOpen !== false);

    let toCredit = toCreditByMat[matId] || 0;
    let toDispute = toDisputeByMat[matId] || 0;

    const rows = openRows
      .filter((rq) => r2((Number(rq.issuedQty) || 0) - (Number(rq.receivedQty) || 0)) > 0)
      .sort((a, b) => a.addedSeq - b.addedSeq);

    // Credit arrived, oldest-first.
    rows.forEach((rq) => {
      if (toCredit <= 0) return;
      const room = r2((Number(rq.issuedQty) || 0) - (Number(rq.receivedQty) || 0));
      const give = Math.min(room, toCredit);
      rq.receivedQty = r2((Number(rq.receivedQty) || 0) + give);
      toCredit = r2(toCredit - give);
    });

    // Dispute the shortfall, NEWEST-first (mirrors the fan that filled them),
    // and record which plan(s) carry it so one dispute per (plan, material).
    // NOTHING is written on the requirement for the shortfall - it has no
    // disputedQty field; the (issuedQty - receivedQty) gap plus the open
    // Stock_Dispute IS the record, exactly as the old receiveMaterials.
    const shortByPlan = {};
    const rowsNewestFirst = rows.slice().sort((a, b) => b.addedSeq - a.addedSeq);
    rowsNewestFirst.forEach((rq) => {
      if (toDispute <= 0) return;
      const room = r2((Number(rq.issuedQty) || 0) - (Number(rq.receivedQty) || 0));
      const put = Math.min(room, toDispute);
      if (put <= 0) return;
      shortByPlan[String(rq.planId)] = r2((shortByPlan[String(rq.planId)] || 0) + put);
      toDispute = r2(toDispute - put);
    });

    // Raise / update one Stock_Dispute per (plan, material) with a gap.
    Object.keys(shortByPlan).forEach((planId) => {
      const gap = shortByPlan[planId];
      if (gap <= 0) return;
      let d = state.disputes.find((x) => x.status === 'Open'
        && String(x.planId) === planId && String(x.materialId) === matId
        && !x.isWaste && (x.direction || 'Outbound') === 'Outbound');
      const arrivedShare = 0; // this plan's arrived is folded into the fan credit above
      if (d) {
        d.issuedQty = r2((Number(d.issuedQty) || 0) + gap);
        d.disputedQty = r2((Number(d.disputedQty) || 0) + gap);
        d.voucher = d.voucher || voucherOfMat[matId] || '';
      } else {
        d = {
          id: state.nextDisputeId++,
          planId: planId,
          materialId: matId,
          voucher: voucherOfMat[matId] || '',
          direction: 'Outbound',
          isWaste: false,
          issuedQty: gap,
          receivedQty: arrivedShare,
          disputedQty: gap,
          status: 'Open',
          resolutionLines: []
        };
        state.disputes.push(d);
      }
      raisedDisputeIds.push(d.id);
    });

    // STAMP THE WATERMARKS for this material. Everything it had to fan is
    // applied, so the lines record it and a repeat computes 0. Written LAST so
    // a failure before this leaves them unstamped and the next press redoes
    // the work - which is safe: the credit is capped by each requirement's own
    // room and the dispute upsert lands on the same open ticket.
    scopeLines.forEach((ln) => {
      if (String(ln.materialId) !== matId) return;
      ln.fannedQty = r2(Number(ln.receivedQty) || 0);
      ln.disputeRaisedQty = r2(Number(ln.disputedQty) || 0);
    });
  });

  // ---- 3. DRAIN In_Transit -> (production / Disputed) ----
  Object.keys(settledByMat).forEach((matId) => {
    const rm = state.rawMaterials[matId] || (state.rawMaterials[matId] = { inTransitQty: 0, disputedQty: 0 });
    const drain = settledByMat[matId];
    const sh = shortAmtByMat[matId] || 0;
    const off = Math.min(drain, rm.inTransitQty);
    rm.inTransitQty = r2(rm.inTransitQty - off);
    if (sh > 0) rm.disputedQty = r2((rm.disputedQty || 0) + sh);
  });
  Object.keys(settledByLot).forEach((lotId) => {
    const lt = state.lots[lotId] || (state.lots[lotId] = { inTransitQty: 0, disputedQty: 0 });
    const drain = settledByLot[lotId];
    const sh = shortByLot[lotId] || 0;
    const off = Math.min(drain, lt.inTransitQty);
    lt.inTransitQty = r2(lt.inTransitQty - off);
    if (sh > 0) lt.disputedQty = r2((lt.disputedQty || 0) + sh);
  });

  return {
    arrivedByMat, shortAmtByMat, settledByMat,
    raisedDisputeIds
  };
}

module.exports = { receiveMaterials, openDisputeLeft, r2 };
