/* =============================================================================
 * JS-Data-API replacement for getSupervisorMaterials.dg (retired) — the
 * supervisor's receive list, built from flat getRecords reads instead of a
 * paged Deluge walk.
 *
 * WHY IT CAN BE FLAT NOW. After the issue-model migration the receive screen
 * reads the HANDOVER records (Material_Issue / Issue_Lines at material x lot
 * grain) — one form, bounded by the supervisor's own vouchers, ~200 lines a
 * voucher at worst. No fan, no plan walk, no fat subform, so no chunking.
 *
 * It produces the EXACT shape render(merged) in receive.js consumes:
 *   { supervisors:[{id,name}],
 *     materials:[{materialId,material,unit,isFabric,isReissue,pending,
 *                 lots:[{lot,qty,rolls:[{roll,qty}]}],
 *                 orders:[{planId,planNo,salesOrder,pending,
 *                 isReissue,reason,lineCount,lot,rolls:[{roll,qty}]}], voucherIds:[..] }],
 *     waste:[{rowId,planId,planNo,salesOrder,materialId,material,width,length,
 *             pending,cutWidth,cutLength,yields}],
 *     printedPieces:[{issueLineId,voucherId,materialId,material,unit,qty,pending,
 *                     cutWidth,cutLength,planNo,salesOrder,lot,planId}],
 *     plansAssigned, plansAwaiting, errors:[] }
 *
 * READS (getRecords, cursor-paged):
 *   Material_Issue_Report       his handovers, Issue_Lines inline
 *   Material_Requirement_Report Assigned_To == sup  (order breakdown + plansAssigned)
 *   Stock_Dispute_Report        Supervisor == sup, Status == "Open" (net off pending)
 *   Waste_Movement_Report       Moved_By == sup  (issued offcuts + received children)
 *   Employee_Report             the supervisor picker
 *   Production_Planning_Report  plan no + sales-order id            (lazy, by id set)
 *   Sales_Order (All_Sales_Orders?) sales-order number             (lazy)
 *   Raw_Material (All_items_Report)  display name, unit             (whole, small)
 *   Raw_Material_Lot (All_Material_Lots) lot number                 (whole)
 *
 * "STILL OWED" on an Issue_Line = Qty - Received_Qty > 0. Same test
 * receiveMaterials settles against.
 *
 * receive.js calls this directly — no flag, no Deluge fallback. Console:
 * ReceiveRead.run(supId).
 * ========================================================================== */
var ReceiveRead = (function () {
    'use strict';

    var OPEN_PLAN_STATUSES = ['Pending', 'Material Ready', 'Partially Received', 'In Progress'];

    var RPT = {
        issues: 'Material_Issue_Report',
        reqs: 'Material_Requirement_Report',
        disputes: 'Stock_Dispute_Report',
        wasteMv: 'Waste_Movement_Report',
        emps: 'Employee_Report',
        plans: 'Production_Planning_Report',
        salesOrders: 'Sales_Order_Report',
        rawMat: 'All_items_Report',
        lots: 'All_Material_Lots',
        wastePieces: 'Waste_Master_Report'
    };

    function have() {
        return typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
            typeof ZOHO.CREATOR.DATA.getRecords === 'function';
    }

    // ---- getRecords with cursor paging (same shape as api-experiment.js) ----
    function getAll(reportName, criteria) {
        return new Promise(function (resolve, reject) {
            var rows = [];
            function isNoRecords(err) {
                if (!err) return false;
                var s = '';
                try { s = JSON.stringify(err); } catch (e) { s = String(err); }
                s = (s + ' ' + (err.message || '') + ' ' + (err.responseText || '')).toLowerCase();
                return err.code === 9280 || s.indexOf('9280') !== -1 ||
                    s.indexOf('no records found') !== -1;
            }
            function page(cursor) {
                var cfg = { report_name: reportName, field_config: 'all', max_records: 1000 };
                if (criteria) cfg.criteria = criteria;
                if (cursor) cfg.record_cursor = cursor;
                ZOHO.CREATOR.DATA.getRecords(cfg).then(function (resp) {
                    var data = (resp && (resp.data || resp.records)) || [];
                    for (var i = 0; i < data.length; i++) rows.push(data[i]);
                    var next = resp && (resp.record_cursor || resp.cursor);
                    if (next && data.length > 0) page(next);
                    else resolve(rows);
                }).catch(function (err) {
                    if (isNoRecords(err)) { resolve(rows); return; }
                    reject(new Error(reportName + ': ' + (err && err.message ? err.message : JSON.stringify(err))));
                });
            }
            page(null);
        });
    }

    // ---- coercion --------------------------------------------------------
    function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
    function str(v) { return v == null ? '' : String(v); }
    function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
    function lookupId(v) {
        if (v == null) return '';
        if (typeof v === 'object') return String(v.ID || v.id || '');
        return String(v);
    }
    function truthy(v) {
        return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes' || v === 'yes' || v === 'True';
    }
    function flat(v) {
        return str(v).replace(/"/g, "'").replace(/\r/g, '').replace(/\n/g, ' | ').replace(/\t/g, ' ');
    }

    // ---- fetch a report scoped to a batch of ids, chunked --------------
    // Same technique as api-experiment.js's getAllByPlanIds: Creator's
    // criteria parser has a practical length limit on a long OR-string
    // (pipeline-data.js's fetchByIds already chunks at 60 with in-tree
    // proof that width is safe), so a long id list is split and the chunks
    // fetched in parallel, merged client-side. `extra`, if given, is ANDed
    // onto every chunk's criteria (e.g. 'Assigned_To == ' + supId), so the
    // per-supervisor scope survives the id-scoping rather than being lost.
    var ID_CHUNK = 60;
    function getAllByIds(reportName, field, ids, extra) {
        if (!ids.length) return Promise.resolve([]);
        var chunks = [];
        for (var i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
        return Promise.all(chunks.map(function (chunk) {
            var idCrit = '(' + chunk.map(function (id) { return field + ' == ' + id; }).join(' || ') + ')';
            var criteria = extra ? (extra + ' && ' + idCrit) : idCrit;
            return getAll(reportName, criteria);
        })).then(function (results) {
            var rows = [];
            results.forEach(function (r) { rows = rows.concat(r); });
            return rows;
        });
    }

    // =====================================================================
    // TWO PHASES for Material_Requirement, same shape and same reason as
    // api-experiment.js's store-screen fix: Material_Requirement has no
    // Order_Status of its own, and `Assigned_To == supId` alone is NOT
    // bounded — it returns every requirement row this supervisor has EVER
    // been assigned, all-time, including plans that finished months ago
    // (assemble() already discards those: `if (!pi || !pi.open) return;`
    // below). A supervisor who has worked a year of production would have
    // this grow the same way the store screen's unfiltered form-wide fetch
    // did, just partitioned by headcount instead of company-wide.
    //
    // Fixed by fetching this supervisor's OPEN plans first (Assigned_To +
    // Order_Status together — Production_Planning supports both in one
    // criteria string; the retired getSupervisorMaterials.dg already used
    // exactly this query), then scoping Material_Requirement to
    // `Assigned_To == supId && (Plan == id1 || ...)`, chunked via
    // getAllByIds. issues/disputes/wasteMv are unaffected — already scoped
    // to this supervisor and not the thing that was unbounded.
    function run(supervisorId) {
        if (!have()) return Promise.reject(new Error('ZOHO.CREATOR.DATA.getRecords not available'));
        var supId = str(supervisorId).trim();

        // Picker first — an empty supId call only needs the supervisor list.
        if (supId === '') {
            return getAll(RPT.emps, null).then(function (emps) {
                return {
                    supervisors: buildSupervisors(emps),
                    materials: [], waste: [], printedPieces: [],
                    plansAssigned: 0, plansAwaiting: 0, errors: []
                };
            });
        }

        var openPlanCriteria = '(' + OPEN_PLAN_STATUSES.map(function (s) {
            return 'Order_Status == "' + s + '"';
        }).join(' || ') + ')';

        return Promise.all([
            getAll(RPT.emps, null),
            getAll(RPT.issues, 'Issued_To == ' + supId),
            getAll(RPT.plans, 'Assigned_To == ' + supId + ' && ' + openPlanCriteria),
            getAll(RPT.disputes, 'Supervisor == ' + supId + ' && Status == "Open"'),
            getAll(RPT.wasteMv, 'Moved_By == ' + supId),
            getAll(RPT.rawMat, null),
            getAll(RPT.lots, null)
        ]).then(function (res) {
            var raw = {
                emps: res[0], issues: res[1], openPlans: res[2],
                disputes: res[3], wasteMv: res[4], rawMats: res[5], lots: res[6]
            };

            var openPlanIds = raw.openPlans.map(function (p) { return String(p.ID); });
            var reqFetch = getAllByIds(RPT.reqs, 'Plan', openPlanIds, 'Assigned_To == ' + supId);

            // wasteMv can reference a plan that has since closed — assemble()
            // already tolerates a waste row whose plan isn't in planInfo (it
            // falls back to blank planNo/salesOrder), so those ids are
            // resolved too, unioned with the open set, rather than dropped.
            var wasteMvPlanIds = {};
            raw.wasteMv.forEach(function (wm) {
                var p = lookupId(wm.Plan); if (p) wasteMvPlanIds[p] = 1;
            });
            openPlanIds.forEach(function (id) { delete wasteMvPlanIds[id]; });
            var extraPlanIds = Object.keys(wasteMvPlanIds);
            var extraPlanFetch = extraPlanIds.length
                ? getAllByIds(RPT.plans, 'ID', extraPlanIds)
                : Promise.resolve([]);

            return Promise.all([reqFetch, extraPlanFetch]).then(function (r2res) {
                raw.reqs = r2res[0];
                raw.plans = raw.openPlans.concat(r2res[1]);

                var soIds = {};
                raw.plans.forEach(function (p) {
                    var so = lookupId(p.Sales_Order); if (so) soIds[so] = 1;
                });
                var wantSO = Object.keys(soIds);
                var soFetch = wantSO.length
                    ? getAllByIds(RPT.salesOrders, 'ID', wantSO)
                    : Promise.resolve([]);
                return soFetch.then(function (sos) {
                    raw.salesOrders = sos;
                    return assemble(supId, raw);
                });
            });
        });
    }

    function buildSupervisors(emps) {
        var actives = (emps || []).filter(function (e) {
            return str(e.Designation).trim() === 'Supervisor' && str(e.Status).trim() === 'Active';
        });
        var list = actives.length ? actives : (emps || []);
        return list.map(function (e) {
            return { id: String(e.ID), name: flat(e.Employee_Name) };
        }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    }

    // The PURE assembly — testable, no SDK, no promises.
    //   raw = { emps, issues, reqs, disputes, wasteMv, rawMats, lots, plans, salesOrders }
    function assemble(supId, raw) {
        var issues = raw.issues || [], reqs = raw.reqs || [], disputes = raw.disputes || [],
            wasteMv = raw.wasteMv || [], rawMats = raw.rawMats || [], lots = raw.lots || [],
            plans = raw.plans || [], salesOrders = raw.salesOrders || [];

        // ---- id maps ----
        var soNumById = {};
        salesOrders.forEach(function (s) { soNumById[String(s.ID)] = flat(s.Sales_Order); });

        var planInfo = {};   // planId -> { planNo, salesOrder, open }
        plans.forEach(function (p) {
            planInfo[String(p.ID)] = {
                planNo: flat(p.Plan_No),
                salesOrder: soNumById[lookupId(p.Sales_Order)] || '',
                open: OPEN_PLAN_STATUSES.indexOf(str(p.Order_Status).trim()) !== -1
            };
        });

        var rmById = {};
        rawMats.forEach(function (rm) {
            var disp = str(rm.Material_Display_Name).trim() || str(rm.Name).trim() || str(rm.SKU).trim();
            rmById[String(rm.ID)] = { name: flat(disp), unit: str(rm.Unit), isFabric: truthy(rm.Is_Fabric) };
        });

        var lotNumById = {};
        lots.forEach(function (l) { lotNumById[String(l.ID)] = flat(l.Lot_Number); });

        // ---- open outbound disputes ----
        // DISPUTED QUANTITY IS NOT PENDING RECEIPT - but under the new grain
        // that is enforced by the LINE, not by netting here: a short receipt
        // writes the gap to Issue_Lines.Disputed_Qty, and the pending test below
        // subtracts it. Netting a material total on top would also suppress the
        // pending metres of a LATER handover of the same material, which are
        // genuinely on the counter.
        //
        // dispByPM is still used for the advisory "where this goes" order
        // breakdown, which is per plan and reads the requirement rows (whose
        // Issued - Received gap DOES still carry the disputed part).
        var dispByPM = {};   // "planId|matId" -> qty still open
        var dispByWP = {};   // wastePieceId   -> qty still open
        disputes.forEach(function (d) {
            var dir = str(d.Direction).trim() || 'Outbound';
            if (dir !== 'Outbound') return;
            var disputed = num(d.Disputed_Qty);
            var resolved = 0;
            var rl = d.Resolution_Lines || [];
            (Array.isArray(rl) ? rl : []).forEach(function (r) { resolved += num(r.Resolved_Qty); });
            var stillOpen = disputed - resolved;
            if (stillOpen <= 0) return;
            if (truthy(d.Is_Waste) && lookupId(d.Waste_Piece)) {
                var wk = lookupId(d.Waste_Piece);
                dispByWP[wk] = (dispByWP[wk] || 0) + stillOpen;
            } else if (lookupId(d.Material) && lookupId(d.Plan)) {
                var pk = lookupId(d.Plan) + '|' + lookupId(d.Material);
                dispByPM[pk] = (dispByPM[pk] || 0) + stillOpen;
            }
        });

        // ---- walk the handover Issue_Lines ----
        // materials aggregate: matId -> { matId, name, unit, isFabric, isReissue,
        //   pending, lots:{lotLabel->qty}, voucherIds:Set }
        var mat = {};
        var matOrder = [];
        var printedPieces = [];
        // per-plan order roll-up built from Material_Requirement below, keyed by
        // matId -> { planId -> {planId,planNo,salesOrder,pending,isReissue,reason,lineCount} }
        // NOTE: order breakdown comes from the requirement rows, not the handover
        // lines (handover is material x lot, has no plan). See below.

        issues.forEach(function (mi) {
            var voucherId = String(mi.ID);
            var voucherNo = flat(mi.Voucher_No) || '';
            var lines = mi.Issue_Lines || [];
            (Array.isArray(lines) ? lines : []).forEach(function (ln) {
                var qty = num(ln.Qty);
                var received = num(ln.Received_Qty);
                var disputed = num(ln.Disputed_Qty);
                // STILL OWED is what receipt has not accounted for AT ALL — not
                // arrived and not in dispute. The disputed part belongs to the
                // Disputes screen until it is resolved; leaving it here lets the
                // same material be received twice.
                //
                // DUAL READ, the same test postTransferOrders uses: a NEW line
                // carries Line_Status and settles into Received/Disputed; a
                // LEGACY line (no Line_Status, from the old issueMaterials) used
                // Settled_Qty for both. Reading the new fields on a legacy line
                // would show a fully-received old handover as fully pending.
                // Identical to what receiveHandover settles against, so the
                // screen and the write always agree on the figure.
                var owed;
                if (str(ln.Line_Status).trim() !== '') {
                    owed = r2(qty - received - disputed);
                } else {
                    owed = r2(qty - num(ln.Settled_Qty));
                }
                if (owed <= 0) return;

                var matId = lookupId(ln.Material);
                if (!matId) return;
                var rm = rmById[matId] || {};
                var unit = str(ln.Unit) || rm.unit || '';
                var isFab = rm.isFabric === true;

                var note = str(ln.Lot_Override_Note);
                var isPrinted = note.indexOf('PRINTED_PIECE') !== -1;

                var lotId = lookupId(ln.Lot);
                var lotLabel = lotId ? (lotNumById[lotId] || 'Not recorded') : 'Not recorded';
                // THE ROLL(S), lot-rolls-model.md Step 5/7. issueMaterialsHandover
                // stamps this per material x lot line - one label, or several
                // joined "L2-R1 5m, L2-R2 1.05m" (drain order) when the line
                // drained more than one roll. Kept as the raw string here; the
                // widget parses it the same way the store screen's own display
                // already does, so both read one convention.
                var rollLabelTxt = flat(ln.Roll_Label);

                if (isPrinted) {
                    // One receipt row per printed Issue_Line — confirmed per piece.
                    printedPieces.push({
                        issueLineId: String(ln.ID),
                        voucherId: voucherId,
                        voucherNo: voucherNo,
                        materialId: matId,
                        material: rm.name || flat(ln.Material_Name),
                        unit: unit,
                        qty: qty,
                        pending: owed,
                        cutWidth: num(ln.Cut_Size_Width),
                        cutLength: num(ln.Cut_Size_Length),
                        planNo: '',
                        salesOrder: '',
                        lot: lotLabel,
                        planId: ''
                    });
                    return;
                }

                var cur = mat[matId];
                if (!cur) {
                    cur = {
                        matId: matId,
                        name: rm.name || flat(ln.Material_Name),
                        unit: unit,
                        isFabric: isFab,
                        isReissue: false,
                        pending: 0,
                        lots: {},
                        // lotLabel -> { rollLabel -> qty }, and lotLabel -> [rollLabel,...]
                        // to keep drain order rather than object key order (which a
                        // numeric-looking label like "1" would silently reorder).
                        rollsByLot: {},
                        rollOrderByLot: {},
                        voucherIds: {},
                        voucherNoById: {}
                    };
                    mat[matId] = cur;
                    matOrder.push(matId);
                }
                cur.pending = r2(cur.pending + owed);
                cur.lots[lotLabel] = r2((cur.lots[lotLabel] || 0) + owed);
                cur.voucherIds[voucherId] = 1;
                if (voucherNo) cur.voucherNoById[voucherId] = voucherNo;

                if (rollLabelTxt) {
                    var rolls = cur.rollsByLot[lotLabel] || (cur.rollsByLot[lotLabel] = {});
                    var rollOrder = cur.rollOrderByLot[lotLabel] || (cur.rollOrderByLot[lotLabel] = []);
                    // A line can name several rolls at once ("L2-R1 5m, L2-R2
                    // 1.05m") - split and credit each its own share, same
                    // parsing the store screen's rollLinesFor already does.
                    var segs = rollLabelTxt.split(',');
                    if (segs.length <= 1) {
                        // One roll: no "Xm" suffix to parse, the WHOLE owed
                        // amount for this line came off it.
                        var rlbl = rollLabelTxt.trim();
                        if (!rlbl) { /* nothing to credit */ }
                        else {
                            if (!rolls[rlbl]) { rolls[rlbl] = 0; rollOrder.push(rlbl); }
                            rolls[rlbl] = r2(rolls[rlbl] + owed);
                        }
                    } else {
                        // Segment metres are the ORIGINAL amounts stamped at
                        // issue time, which sum to the line's full qty, not
                        // what's still owed (partly received/disputed since).
                        // Scale each segment by owed/qty so a half-received
                        // multi-roll line shows sub-lines that actually sum
                        // to the lot line's owed total, not the original.
                        var segTotal = 0;
                        var parsed = [];
                        segs.forEach(function (seg) {
                            var s = seg.trim();
                            // Only strip a trailing "m" when what's left still
                            // parses as a number - a label that itself ends in
                            // "m" (e.g. "FOAM") must not be mangled.
                            var sNoM = (s.slice(-1) === 'm') ? s.slice(0, -1) : s;
                            var sp = sNoM.lastIndexOf(' ');
                            if (sp <= 0) return;
                            var segLbl = sNoM.slice(0, sp).trim();
                            var mtrCand = sNoM.slice(sp + 1).trim();
                            var segMtr = Number(mtrCand);
                            if (!segLbl || mtrCand === '' || isNaN(segMtr)) return;
                            parsed.push({ label: segLbl, mtr: segMtr });
                            segTotal += segMtr;
                        });
                        var scale = (qty > 0 && segTotal > 0) ? (owed / qty) : 1;
                        parsed.forEach(function (p) {
                            var creditMtr = r2(p.mtr * scale);
                            if (!rolls[p.label]) { rolls[p.label] = 0; rollOrder.push(p.label); }
                            rolls[p.label] = r2(rolls[p.label] + creditMtr);
                        });
                    }
                }
            });
        });

        // ---- order breakdown from Material_Requirement ----
        // For each still-owed requirement row on an open plan, roll up per
        // (matId, planId). "Still owed" here mirrors the store screen: fabric on
        // pieces, non-fabric on qty. But the receive list's per-material pending
        // total is authoritative from the handover lines above — this is only the
        // "where this goes" breakdown, so we roll pending as issued - received
        // per requirement, clamped >= 0, and let it be advisory.
        var ordAgg = {};       // matId -> { planId -> entry }
        var ordOrder = {};     // matId -> [planId,...]
        var plansAssignedSet = {};
        var planFedSet = {};

        reqs.forEach(function (rq) {
            var planId = lookupId(rq.Plan);
            var pi = planInfo[planId];
            if (pi && pi.open) plansAssignedSet[planId] = 1;

            var matId = lookupId(rq.Material);
            if (!matId) return;
            if (!pi || !pi.open) return;

            var issued = num(rq.Issued_Qty);
            var receivedQ = num(rq.Received_Qty);
            var owedQ = r2(issued - receivedQ);
            // Net off any open dispute for this plan+material.
            var pk = planId + '|' + matId;
            var dleft = dispByPM[pk];
            if (dleft != null && dleft > 0) {
                var take = Math.min(dleft, owedQ);
                owedQ = r2(owedQ - take);
                dispByPM[pk] = dleft - take;
            }
            if (owedQ <= 0) return;
            // This material only shows on the receive list if a handover line
            // still owes it — skip an order-breakdown entry for a material with
            // no owed handover line.
            if (!mat[matId]) return;

            planFedSet[planId] = 1;

            var src = str(rq.Source).trim() || 'Plan';
            var isRe = src === 'Reissue';

            var byPlan = ordAgg[matId] || (ordAgg[matId] = {});
            var list = ordOrder[matId] || (ordOrder[matId] = []);
            var e = byPlan[planId];
            if (!e) {
                e = {
                    planId: planId,
                    planNo: pi.planNo,
                    salesOrder: pi.salesOrder,
                    pending: 0,
                    isReissue: false,
                    reason: '',
                    lineCount: 0,
                    // WHICH LOT + ROLL THIS ORDER'S CUT COMES FROM.
                    // Material_Requirement.Issued_Lot / .Roll_Label are the
                    // tone pin - written once, by issueMaterialsApply, from
                    // the FIRST allocation that gave this row fresh cloth.
                    // Several requirement rows can feed one (plan, material)
                    // entry (two cut sizes of the same fabric), and they can
                    // legitimately name different lots/rolls - lotRolls[]
                    // carries one entry per distinct (lot,roll) pair seen,
                    // not just the first or the last.
                    lotRolls: [],
                    _lotRollSeen: {}
                };
                byPlan[planId] = e;
                list.push(planId);
            }
            e.pending = r2(e.pending + owedQ);
            e.lineCount += 1;
            if (isRe) { e.isReissue = true; mat[matId].isReissue = true; }
            if (!e.reason) e.reason = flat(rq.Reason);

            var reqLotId = lookupId(rq.Issued_Lot);
            var reqLotLabel = reqLotId ? (lotNumById[reqLotId] || 'Not recorded') : '';
            var reqRollTxt = flat(rq.Roll_Label);
            if (reqLotLabel) {
                // One (lot, roll) pair per distinct roll named on this row -
                // a row split across two rolls names both, same parsing as
                // the material-level rollsByLot above. A row with a lot but
                // no roll (offcut-only, or issued before Step 5) still gets
                // a (lot, "") entry so the lot is not silently dropped.
                var rollNames = [''];
                if (reqRollTxt) {
                    var rsegs = reqRollTxt.split(',');
                    rollNames = rsegs.map(function (seg) {
                        var s = seg.trim();
                        if (rsegs.length <= 1) {
                            // A single roll carries no "Xm" suffix at all -
                            // the whole string is the label. Trimming a
                            // trailing "m" here would mangle a bare label
                            // that itself ends in "m" (e.g. "FOAM").
                            return s;
                        }
                        var sNoM = (s.slice(-1) === 'm') ? s.slice(0, -1) : s;
                        var sp = sNoM.lastIndexOf(' ');
                        // Only treat the tail after the space as the label
                        // when what precedes looks like "<label> <metres>" -
                        // i.e. the metres part actually parses as a number.
                        if (sp > 0 && !isNaN(Number(sNoM.slice(sp + 1).trim()))) {
                            return sNoM.slice(0, sp).trim();
                        }
                        return s.trim();
                    }).filter(Boolean);
                    if (rollNames.length === 0) rollNames = [''];
                }
                rollNames.forEach(function (rollName) {
                    var seenKey = reqLotLabel + '|' + rollName;
                    if (!e._lotRollSeen[seenKey]) {
                        e._lotRollSeen[seenKey] = true;
                        e.lotRolls.push({ lot: reqLotLabel, roll: rollName });
                    }
                });
            }
        });

        // ---- waste: his Issued movements minus their Received children ----
        var receivedByParent = {};
        wasteMv.forEach(function (wm) {
            if (str(wm.Movement_Type).trim() !== 'Received') return;
            var parent = lookupId(wm.Parent_Movement);
            if (!parent) return;
            receivedByParent[parent] = (receivedByParent[parent] || 0) + num(wm.Piece_Count);
        });

        // waste-piece -> its material id + lot, resolved from Waste_Master via
        // the movement's Waste_Piece would need another read; the movement itself
        // carries Plan / Plan_Item but not the SKU. getSupervisorMaterials reads
        // Waste_Master[ID == wi.Waste_Piece].SKU. We do the same with a small
        // extra fetch keyed by the waste-piece ids actually on Issued movements.
        var wasteOut = [];
        var issuedMoves = wasteMv.filter(function (wm) {
            return str(wm.Movement_Type).trim() === 'Issued';
        });

        issuedMoves.forEach(function (wi) {
            var count = num(wi.Piece_Count);
            var recv = receivedByParent[String(wi.ID)] || 0;
            var pend = count - recv;
            var wpId = lookupId(wi.Waste_Piece);
            var dleft = dispByWP[wpId];
            if (dleft != null && dleft > 0) {
                var take = Math.min(dleft, pend);
                pend = pend - Math.round(take);
                dispByWP[wpId] = dleft - take;
            }
            if (pend <= 0) return;

            var planId = lookupId(wi.Plan);
            var pi = planInfo[planId] || { planNo: '', salesOrder: '' };
            wasteOut.push({
                rowId: String(wi.ID),
                planId: planId,
                planNo: pi.planNo,
                salesOrder: pi.salesOrder,
                _wastePieceId: wpId,   // resolved to materialId/material/lot after the extra fetch
                materialId: '',
                material: '',
                lot: '',               // set from Waste_Master.Lot in resolveWastePieceMaterials
                width: num(wi.Piece_Width),
                length: num(wi.Piece_Length),
                pending: pend,
                cutWidth: num(wi.Cut_Size_Width),
                cutLength: num(wi.Cut_Size_Length),
                yields: num(wi.Pieces_Yielded)
            });
        });

        // ---- shape the output ----
        var materialsOut = matOrder.map(function (matId) {
            var c = mat[matId];
            var lotsArr = Object.keys(c.lots).map(function (lbl) {
                // rolls[] in DRAIN ORDER (rollOrderByLot), not object key
                // order - "R2" before "R10" only holds if the order is kept
                // explicitly. Empty when this lot's lines carried no
                // Roll_Label at all (a pre-Step-5 handover).
                var rollOrder = c.rollOrderByLot[lbl] || [];
                var rollMap = c.rollsByLot[lbl] || {};
                var rollsArr = rollOrder
                    .map(function (rlbl) { return { roll: rlbl, qty: rollMap[rlbl] }; })
                    .filter(function (r) { return r.qty > 0; });
                return { lot: lbl, qty: c.lots[lbl], rolls: rollsArr };
            }).filter(function (l) { return l.qty > 0; });
            var ordersArr = (ordOrder[matId] || []).map(function (pid) {
                var e = ordAgg[matId][pid];
                return {
                    planId: e.planId, planNo: e.planNo, salesOrder: e.salesOrder,
                    pending: e.pending, isReissue: e.isReissue, reason: e.reason,
                    lineCount: e.lineCount, lotRolls: e.lotRolls
                };
            });
            var voucherIdList = Object.keys(c.voucherIds);
            return {
                materialId: matId,
                material: c.name,
                unit: c.unit,
                isFabric: c.isFabric,
                isReissue: c.isReissue,
                pending: c.pending,
                lots: lotsArr,
                orders: ordersArr,
                voucherIds: voucherIdList,
                // [{ id, no }] - the SIV number beside the id, so the receive
                // card can name the handover and link into the Handovers tab.
                vouchers: voucherIdList.map(function (vid) {
                    return { id: vid, no: c.voucherNoById[vid] || '' };
                })
            };
        }).filter(function (m) { return m.pending > 0; });

        var out = {
            supervisors: buildSupervisors(raw.emps),
            materials: materialsOut,
            waste: wasteOut,
            printedPieces: printedPieces,
            plansAssigned: Object.keys(plansAssignedSet).length,
            plansAwaiting: Math.max(0, Object.keys(plansAssignedSet).length - Object.keys(planFedSet).length),
            errors: [],
            _wastePieceIds: wasteOut.map(function (w) { return w._wastePieceId; })
                .filter(function (x, i, a) { return x && a.indexOf(x) === i; }),
            // The Waste_Movement carries no lot; the second fetch reads
            // Waste_Master.Lot per piece and resolves it through this map.
            _lotNumById: lotNumById
        };
        return resolveWastePieceMaterials(out);
    }

    // Second, tiny fetch: waste-piece id -> its Raw_Material (SKU) + name + LOT.
    // Only the pieces actually on his still-owed Issued movements. The
    // Waste_Movement carries no lot, so the lot number comes from
    // Waste_Master.Lot here.
    function resolveWastePieceMaterials(out) {
        var ids = out._wastePieceIds || [];
        var lotNumById = out._lotNumById || {};
        delete out._wastePieceIds;
        delete out._lotNumById;
        if (!ids.length || !have()) {
            return Promise.resolve(out);
        }
        var crit = ids.map(function (i) { return 'ID == ' + i; }).join(' || ');
        return getAll(RPT.wastePieces, crit).then(function (wps) {
            var skuByWp = {};
            var lotByWp = {};
            (wps || []).forEach(function (w) {
                skuByWp[String(w.ID)] = lookupId(w.SKU);
                var lId = lookupId(w.Lot);
                var lNum = lId ? lotNumById[lId] : '';
                if (!lNum && w.Lot && typeof w.Lot === 'object') {
                    lNum = flat(w.Lot.zc_display_value || w.Lot.Lot_Number || '');
                }
                lotByWp[String(w.ID)] = lNum || '';
            });
            var wantMats = {};
            Object.keys(skuByWp).forEach(function (k) { if (skuByWp[k]) wantMats[skuByWp[k]] = 1; });
            // Names come from the Raw_Material list already loaded — but assemble
            // returned before we had it here. Re-fetch the few needed rows.
            var matIds = Object.keys(wantMats);
            var matFetch = matIds.length
                ? getAll('All_items_Report', matIds.map(function (m) { return 'ID == ' + m; }).join(' || '))
                : Promise.resolve([]);
            return matFetch.then(function (rms) {
                var nameById = {};
                (rms || []).forEach(function (rm) {
                    nameById[String(rm.ID)] = str(rm.Material_Display_Name).trim()
                        || str(rm.Name).trim() || str(rm.SKU).trim();
                });
                out.waste.forEach(function (w) {
                    var sku = skuByWp[w._wastePieceId] || '';
                    w.materialId = sku;
                    w.material = flat(nameById[sku] || '');
                    w.lot = lotByWp[w._wastePieceId] || '';
                    delete w._wastePieceId;
                });
                return out;
            });
        });
    }

    return { run: run, assemble: assemble, _reports: RPT, _getAllByIds: getAllByIds };
})();

if (typeof window !== 'undefined') window.ReceiveRead = ReceiveRead;
if (typeof module !== 'undefined' && module.exports) module.exports = ReceiveRead;
