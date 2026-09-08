/* =============================================================================
 * Handovers tab — ONE handover (SIV) at a time.
 *
 * WHY THIS EXISTS. The Receive tab answers "is what the store sent me correct?"
 * and clears the moment he confirms. It never answers "I have this combined pile
 * of cloth on my bench — what do I cut, from which roll, for which item?". That
 * information is written at issue time (issueMaterialsApply stamps
 * Material_Requirement.Issued_Lot / .Roll_Label / .Pieces_From_Raw) but nothing
 * surfaces it back to him afterwards. This tab does.
 *
 * PURE getRecords READS — no Deluge, no Custom API. A read-only join across
 * Material_Issue / Material_Requirement / Production_Planning / Plan_Item, all
 * bounded by ONE SIV: its Issue_Lines (~200 rows worst case) and the handful of
 * plans they touch. Nothing here walks a whole transactional form.
 *
 * HandoverDetail.cutList(voucherId) is the pure assembler (testable, no SDK).
 * Console: HandoverDetail.run(supId) lists his SIVs; HandoverDetail.cutList(id).
 * ========================================================================== */
var HandoverDetail = (function () {
    'use strict';

    var OPEN_PLAN_STATUSES = ['Pending', 'Material Ready', 'Partially Received', 'In Progress'];

    // How far back the SIV picker lists handovers. A handover older than this is
    // still reachable by its SIV link from the Receive tag (cutList fetches one
    // voucher by id, unbounded). Bump if a supervisor genuinely works a backlog
    // older than this.
    var PICKER_DAYS = 120;

    var RPT = {
        issues: 'Material_Issue_Report',
        reqs: 'Material_Requirement_Report',
        plans: 'Production_Planning_Report',
        salesOrders: 'Sales_Order_Report',
        planItems: 'Plan_Item_Report',
        itemMaster: 'Item_Master_Report',
        rawMat: 'All_items_Report',
        lots: 'All_Material_Lots',
        emps: 'Employee_Report'
    };

    function have() {
        return typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
            typeof ZOHO.CREATOR.DATA.getRecords === 'function';
    }

    // ---- getRecords with cursor paging (same shape as receive-read.js) ----
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

    // ---- coercion (same helpers as receive-read.js) ---------------------
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

    // WHAT ONE Issue_Line STILL OWES, clamped at zero per line.
    //
    // DUAL READ, the same test receive-read.js / receiveHandover use: a NEW
    // line carries Line_Status and settles into Received_Qty / Disputed_Qty; a
    // LEGACY line (old issueMaterials, no Line_Status) used Settled_Qty for
    // both. Reading the new fields on a legacy line shows a fully-received old
    // handover as fully pending. This is the third copy of the rule — keep it
    // identical to the other two.
    //
    // CLAMPED PER LINE, not on a running total: an over-received line
    // (Received > Qty) must not offset a genuinely pending one on the same
    // handover. Both the picker roll-up and the cloth rows call this so they
    // cannot disagree.
    function lineOwed(ln) {
        var q = num(ln.Qty);
        var owed = str(ln.Line_Status).trim() !== ''
            ? q - num(ln.Received_Qty) - num(ln.Disputed_Qty)
            : q - num(ln.Settled_Qty);
        return r2(Math.max(0, owed));
    }

    // A Roll_Label is either one bare label ("L2-R1") or several joined with a
    // per-roll metre suffix ("L2-R1 5m, L2-R2 1.05m"). Parse to [{label, mtr}]
    // — mtr is 0 for the bare single-roll case (the whole line came off it).
    // Same convention receive-read.js and the store's own issue screen use.
    function parseRollLabel(txt) {
        var s = flat(txt).trim();
        if (!s) return [];
        var out = [];
        s.split(',').forEach(function (seg) {
            var t = seg.trim();
            if (!t) return;
            // Strip a trailing " <number>m" metre suffix when there is one -
            // "L1-R1 8m" -> {label:"L1-R1", mtr:8}. A bare label with no such
            // suffix ("L1-R1", or "FOAM" which itself ends in m) is kept whole.
            var tNoM = (t.slice(-1) === 'm') ? t.slice(0, -1) : t;
            var sp = tNoM.lastIndexOf(' ');
            if (sp > 0) {
                var lbl = tNoM.slice(0, sp).trim();
                var mCand = tNoM.slice(sp + 1).trim();
                var m = Number(mCand);
                if (lbl && mCand !== '' && !isNaN(m)) {
                    out.push({ label: lbl, mtr: m });
                    return;
                }
            }
            out.push({ label: t, mtr: 0 });
        });
        return out;
    }

    // =====================================================================
    // run(supId) — the SIV picker list. Empty supId => supervisors only.
    function run(supervisorId) {
        if (!have()) return Promise.reject(new Error('ZOHO.CREATOR.DATA.getRecords not available'));
        var supId = str(supervisorId).trim();

        if (supId === '') {
            return getAll(RPT.emps, null).then(function (emps) {
                return { supervisors: buildSupervisors(emps), handovers: [] };
            });
        }

        // BOUNDED: the picker only needs handovers a supervisor might still act
        // on plus a short tail of recent completed ones for reference. An
        // Issued_To scan with no date bound grows forever, and getRecords
        // returns the full Issue_Lines subform on every row. Cut it at
        // PICKER_DAYS by Issue_Date; a handover older than that is still
        // reachable by pasting/linking its SIV from the Receive tag, which
        // fetches that one voucher directly.
        var since = new Date();
        since.setDate(since.getDate() - PICKER_DAYS);
        var sinceStr = fmtCreatorDate(since);
        var crit = 'Issued_To == ' + supId;
        if (sinceStr) crit += ' && Issue_Date >= "' + sinceStr + '"';

        return Promise.all([
            getAll(RPT.emps, null),
            getAll(RPT.issues, crit)
        ]).then(function (res) {
            var emps = res[0], issues = res[1] || [];
            var handovers = issues.map(function (mi) {
                var lines = mi.Issue_Lines || [];
                lines = Array.isArray(lines) ? lines : [];
                var matIds = {};
                var owed = 0, qty = 0;
                lines.forEach(function (ln) {
                    var m = lookupId(ln.Material); if (m) matIds[m] = 1;
                    qty += num(ln.Qty);
                    owed += lineOwed(ln);
                });
                return {
                    id: String(mi.ID),
                    voucherNo: flat(mi.Voucher_No) || ('(no SIV) ' + mi.ID),
                    issueDate: str(mi.Issue_Date),
                    issueTime: str(mi.Issue_Time),
                    issueTs: creatorDateToTs(mi.Issue_Date),
                    transferStatus: str(mi.Transfer_Status),
                    issueStatus: str(mi.Issue_Status),
                    planCount: num(mi.Plan_Count),
                    materialCount: Object.keys(matIds).length,
                    lineCount: lines.length,
                    totalQty: r2(qty),
                    owedQty: r2(owed),
                    fullyReceived: r2(owed) <= 0
                };
            }).sort(function (a, b) {
                // Newest first. Record ids are monotonic, so they are the
                // reliable order — a dd-MMM-yyyy string does not sort across
                // months. Parsed timestamp only as a tiebreak (ids equal is
                // impossible, so this never actually runs — kept for clarity).
                var byId = Number(b.id) - Number(a.id);
                if (byId !== 0) return byId;
                return (b.issueTs || 0) - (a.issueTs || 0);
            });
            return { supervisors: buildSupervisors(emps), handovers: handovers };
        });
    }

    // Creator dates come back "08-Sep-2026". Parse to a millis timestamp for
    // ordering / comparison; return 0 on anything unrecognised.
    var MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    function creatorDateToTs(v) {
        var s = str(v).trim();
        var m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
        if (!m) { var t = Date.parse(s); return isNaN(t) ? 0 : t; }
        var mon = MONTHS[m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()];
        if (mon == null) return 0;
        return new Date(Number(m[3]), mon, Number(m[1])).getTime();
    }
    // Build the "dd-MMM-yyyy" string Creator's criteria wants from a Date.
    var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function fmtCreatorDate(d) {
        if (!(d instanceof Date) || isNaN(d.getTime())) return '';
        var dd = ('0' + d.getDate()).slice(-2);
        return dd + '-' + MONTH_NAMES[d.getMonth()] + '-' + d.getFullYear();
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

    // =====================================================================
    // cutList(voucherId) — one handover in full: header, cloth rows, and the
    // per-material order/item cut list.
    function cutList(voucherId) {
        if (!have()) return Promise.reject(new Error('ZOHO.CREATOR.DATA.getRecords not available'));
        var vId = str(voucherId).trim();
        if (vId === '' || !/^\d+$/.test(vId)) {
            return Promise.reject(new Error('voucherId required'));
        }

        return Promise.all([
            getAll(RPT.issues, 'ID == ' + vId),
            getAll(RPT.rawMat, null),
            getAll(RPT.lots, null),
            getAll(RPT.emps, null)
        ]).then(function (res) {
            var raw = { issues: res[0], rawMats: res[1], lots: res[2], emps: res[3] };
            var mi = (raw.issues || [])[0];
            if (!mi) throw new Error('Handover not found');

            var supId = lookupId(mi.Issued_To);
            var lines = Array.isArray(mi.Issue_Lines) ? mi.Issue_Lines : [];

            // Requirement rows: everything assigned to this supervisor, then
            // matched down to this SIV's (material, lot) pairs in assemble().
            var reqFetch = supId
                ? getAll(RPT.reqs, 'Assigned_To == ' + supId)
                : Promise.resolve([]);

            return reqFetch.then(function (reqs) {
                raw.reqs = reqs || [];

                // Which (material, lot) pairs this SIV issued — the filter for
                // the requirement rows.
                var pairSet = {};
                lines.forEach(function (ln) {
                    var m = lookupId(ln.Material);
                    var l = lookupId(ln.Lot);
                    if (m) pairSet[m + '|' + l] = 1;
                });

                var planIds = {};
                raw.reqs.forEach(function (rq) {
                    var m = lookupId(rq.Material);
                    var l = lookupId(rq.Issued_Lot);
                    if (pairSet[m + '|' + l] || pairSet[m + '|']) {
                        var p = lookupId(rq.Plan); if (p) planIds[p] = 1;
                    }
                });
                var wantPlans = Object.keys(planIds);
                var planFetch = wantPlans.length
                    ? getAll(RPT.plans, wantPlans.map(function (p) { return 'ID == ' + p; }).join(' || '))
                    : Promise.resolve([]);

                return planFetch.then(function (plans) {
                    raw.plans = plans || [];
                    var soIds = {};
                    raw.plans.forEach(function (p) {
                        var so = lookupId(p.Sales_Order); if (so) soIds[so] = 1;
                    });
                    var itemFetch = wantPlans.length
                        ? getAll(RPT.planItems, wantPlans.map(function (p) { return 'Plan == ' + p; }).join(' || '))
                        : Promise.resolve([]);
                    var wantSO = Object.keys(soIds);
                    var soFetch = wantSO.length
                        ? getAll(RPT.salesOrders, wantSO.map(function (s) { return 'ID == ' + s; }).join(' || '))
                        : Promise.resolve([]);

                    return Promise.all([itemFetch, soFetch]).then(function (r2res) {
                        raw.planItems = r2res[0] || [];
                        raw.salesOrders = r2res[1] || [];

                        var skuIds = {};
                        raw.planItems.forEach(function (pi) {
                            var s = lookupId(pi.Item_Sku); if (s) skuIds[s] = 1;
                        });
                        var wantSku = Object.keys(skuIds);
                        var skuFetch = wantSku.length
                            ? getAll(RPT.itemMaster, wantSku.map(function (s) { return 'ID == ' + s; }).join(' || '))
                            : Promise.resolve([]);
                        return skuFetch.then(function (masters) {
                            raw.itemMasters = masters || [];
                            return assemble(vId, raw);
                        });
                    });
                });
            });
        });
    }

    // The PURE assembly — no SDK, no promises.
    //   raw = { issues:[mi], reqs, plans, salesOrders, planItems, itemMasters,
    //           rawMats, lots, emps }
    function assemble(voucherId, raw) {
        var mi = (raw.issues || [])[0] || {};
        var lines = Array.isArray(mi.Issue_Lines) ? mi.Issue_Lines : [];
        var reqs = raw.reqs || [], plans = raw.plans || [], salesOrders = raw.salesOrders || [],
            planItems = raw.planItems || [], itemMasters = raw.itemMasters || [],
            rawMats = raw.rawMats || [], lots = raw.lots || [], emps = raw.emps || [];

        // ---- id maps ----
        var empNameById = {};
        emps.forEach(function (e) { empNameById[String(e.ID)] = flat(e.Employee_Name); });

        var soNumById = {};
        salesOrders.forEach(function (s) { soNumById[String(s.ID)] = flat(s.Sales_Order); });

        var planInfo = {};
        plans.forEach(function (p) {
            planInfo[String(p.ID)] = {
                planNo: flat(p.Plan_No),
                salesOrder: soNumById[lookupId(p.Sales_Order)] || '',
                orderStatus: str(p.Order_Status).trim(),
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

        var skuById = {};
        itemMasters.forEach(function (im) { skuById[String(im.ID)] = flat(im.SKU); });

        var piById = {};
        planItems.forEach(function (pi) {
            piById[String(pi.ID)] = {
                sku: skuById[lookupId(pi.Item_Sku)] || '',
                name: flat(pi.Item_Name),
                status: str(pi.Item_Status).trim(),
                isRemake: truthy(pi.Is_Remake),
                remakeReason: str(pi.Remake_Reason).trim()
            };
        });

        // ---- header ----
        var totQty = 0, totReceived = 0, totOwed = 0;
        lines.forEach(function (ln) {
            totQty += num(ln.Qty);
            totReceived += num(ln.Received_Qty);
            totOwed += lineOwed(ln);   // clamped per line
        });
        totOwed = r2(totOwed);

        var receiptStatus = totOwed <= 0 ? 'Received in full'
            : (totReceived > 0 ? 'Partially received' : 'Not yet received');

        var header = {
            voucherId: String(mi.ID),
            voucherNo: flat(mi.Voucher_No) || '',
            issueDate: str(mi.Issue_Date),
            issueTime: str(mi.Issue_Time),
            issuedToName: empNameById[lookupId(mi.Issued_To)] || '',
            issueStatus: str(mi.Issue_Status).trim(),
            transferStatus: str(mi.Transfer_Status).trim(),
            receiptStatus: receiptStatus,
            planCount: num(mi.Plan_Count),
            totalQty: r2(totQty),
            receivedQty: r2(totReceived),
            owedQty: totOwed
        };

        // ---- cloth: ONE entry per material, its lots nested inside ----
        //
        // An Issue_Line is material x lot. A material issued off three lots is
        // three lines; grouping them here means the table shows the material
        // ONCE with its lots (and each lot's rolls) underneath, rather than the
        // name repeated three times. A trim has one line and no lot. Handles
        // 1 lot / 1 roll and N lots / M rolls each with one shape.
        //
        // NO CUT SIZE. A combined handover merges several orders onto one
        // material x lot line and its Cut_Size_* is stamped from whichever
        // allocation was first - not trustworthy. Cut size is per ITEM, in the
        // cut list below (Material_Requirement.Cut_Size_*, plan-time, per item).
        //
        // Pieces (raw + offcut) per lot ARE true totals and are kept.
        var pairSet = {};
        var clothByMat = {};
        var clothOrder = [];
        lines.forEach(function (ln) {
            var matId = lookupId(ln.Material);
            var rm = rmById[matId] || {};
            var lotId = lookupId(ln.Lot);
            pairSet[matId + '|' + lotId] = 1;
            var note = str(ln.Lot_Override_Note);

            var c = clothByMat[matId];
            if (!c) {
                c = {
                    materialId: matId,
                    material: rm.name || flat(ln.Material_Name),
                    unit: str(ln.Unit) || rm.unit || '',
                    isFabric: rm.isFabric === true,
                    isPrinted: note.indexOf('PRINTED_PIECE') !== -1,
                    qtyIssued: 0, qtyReceived: 0, qtyDisputed: 0, owed: 0,
                    piecesFromRaw: 0, piecesFromWaste: 0,
                    lots: [], _lotIdx: {}
                };
                clothByMat[matId] = c;
                clothOrder.push(matId);
            }
            if (note.indexOf('PRINTED_PIECE') !== -1) c.isPrinted = true;

            c.qtyIssued = r2(c.qtyIssued + num(ln.Qty));
            c.qtyReceived = r2(c.qtyReceived + num(ln.Received_Qty));
            c.qtyDisputed = r2(c.qtyDisputed + num(ln.Disputed_Qty));
            c.owed = r2(c.owed + lineOwed(ln));
            c.piecesFromRaw += num(ln.Pieces_From_Raw);
            c.piecesFromWaste += num(ln.Pieces_From_Waste);

            // Only fabric carries a meaningful lot/roll. A trim line's Lot is
            // blank - skip adding a lot entry for it.
            if (c.isFabric && lotId) {
                var lotLabel = lotNumById[lotId] || 'Not recorded';
                var li = c._lotIdx[lotId];
                if (li == null) {
                    li = c.lots.length;
                    c._lotIdx[lotId] = li;
                    c.lots.push({ lot: lotLabel, qtyIssued: 0, qtyReceived: 0, rolls: [], _rollIdx: {} });
                }
                var lotObj = c.lots[li];
                lotObj.qtyIssued = r2(lotObj.qtyIssued + num(ln.Qty));
                lotObj.qtyReceived = r2(lotObj.qtyReceived + num(ln.Received_Qty));
                parseRollLabel(ln.Roll_Label).forEach(function (r) {
                    var ri = lotObj._rollIdx[r.label];
                    if (ri == null) {
                        ri = lotObj.rolls.length;
                        lotObj._rollIdx[r.label] = ri;
                        lotObj.rolls.push({ roll: r.label, mtr: r.mtr });
                    } else {
                        lotObj.rolls[ri].mtr = r2(lotObj.rolls[ri].mtr + r.mtr);
                    }
                });
            }
        });
        var cloth = clothOrder.map(function (matId) {
            var c = clothByMat[matId];
            c.lots.forEach(function (l) { delete l._rollIdx; });
            delete c._lotIdx;
            return c;
        });

        // ---- cut list: matId -> { planId -> { items } } ----
        //
        // "Orders & items THIS CLOTH FEEDS" - deliberately not "this handover's
        // share". Requirement rows carry no SIV identity and their Issued_Qty /
        // Pieces_From_* are CUMULATIVE across every handover of that
        // (material, lot). So if the store ever splits one (material, lot) over
        // two handovers to the same supervisor, both SIVs' cut lists show the
        // same rows with the same totals - correct for the first, doubled after
        // the second. The cloth table above is always exactly this SIV; the cut
        // list is per cloth identity. Stamping the SIV onto the requirement
        // rows (a Deluge change + backfill) is the real fix if that split ever
        // becomes common; the wording carries the caveat until then.
        //
        // MATCH: requirement rows whose (material, Issued_Lot) is a pair this
        // SIV issued. A row served entirely by offcuts has a blank Issued_Lot -
        // matched when the SIV also carried a blank-lot line for that material.
        var matAgg = {};     // matId -> { name, unit, isFabric, planOrder:[], byPlan:{} }
        var matOrder = [];

        reqs.forEach(function (rq) {
            var matId = lookupId(rq.Material);
            if (!matId) return;
            var lotId = lookupId(rq.Issued_Lot);
            if (!pairSet[matId + '|' + lotId] && !pairSet[matId + '|']) return;

            var planId = lookupId(rq.Plan);
            var pInfo = planInfo[planId];
            if (!pInfo) return;

            var raw2 = num(rq.Pieces_From_Raw);
            var waste2 = num(rq.Pieces_From_Waste);
            var pieces = raw2 + waste2;
            var issuedQ = num(rq.Issued_Qty);
            var receivedQ = num(rq.Received_Qty);
            // Nothing issued against this row for this material — skip. (A plan
            // can carry requirement rows for a material it never got cloth for.)
            if (pieces <= 0 && issuedQ <= 0) return;

            var rm = rmById[matId] || {};
            var m = matAgg[matId];
            if (!m) {
                m = {
                    materialId: matId,
                    material: rm.name || 'Material',
                    unit: str(rq.Unit) || rm.unit || '',
                    isFabric: rm.isFabric === true || truthy(rq.Is_Fabric),
                    planOrder: [],
                    byPlan: {}
                };
                matAgg[matId] = m;
                matOrder.push(matId);
            }

            var pl = m.byPlan[planId];
            if (!pl) {
                pl = {
                    planId: planId,
                    planNo: pInfo.planNo,
                    salesOrder: pInfo.salesOrder,
                    orderStatus: pInfo.orderStatus,
                    itemOrder: [],
                    byItem: {}
                };
                m.byPlan[planId] = pl;
                m.planOrder.push(planId);
            }

            var itemId = lookupId(rq.Plan_Item);
            var pi = piById[itemId] || {};
            var it = pl.byItem[itemId];
            if (!it) {
                it = {
                    itemId: itemId,
                    sku: pi.sku || '',
                    name: pi.name || flat(rq.Item_Name) || '',
                    status: pi.status || '',
                    isRemake: pi.isRemake === true,
                    remakeReason: pi.remakeReason || str(rq.Reason).trim(),
                    source: str(rq.Source).trim() || 'Plan',
                    pieces: 0,
                    piecesFromRaw: 0,
                    piecesFromWaste: 0,
                    requiredPieces: 0,
                    issuedQty: 0,
                    receivedQty: 0,
                    cutWidth: num(rq.Cut_Size_Width),
                    cutLength: num(rq.Cut_Size_Length),
                    lotRolls: [],
                    _seen: {}
                };
                pl.byItem[itemId] = it;
                pl.itemOrder.push(itemId);
            }
            it.pieces += pieces;
            it.piecesFromRaw += raw2;
            it.piecesFromWaste += waste2;
            it.requiredPieces += num(rq.Required_Pieces);
            it.issuedQty = r2(it.issuedQty + issuedQ);
            it.receivedQty = r2(it.receivedQty + receivedQ);
            if (!it.cutWidth) it.cutWidth = num(rq.Cut_Size_Width);
            if (!it.cutLength) it.cutLength = num(rq.Cut_Size_Length);

            var lotLabel = lotId ? (lotNumById[lotId] || 'Not recorded') : '';
            if (lotLabel) {
                var rns = parseRollLabel(rq.Roll_Label);
                if (rns.length === 0) rns = [{ label: '', mtr: 0 }];
                rns.forEach(function (rn) {
                    var k = lotLabel + '|' + rn.label;
                    if (!it._seen[k]) {
                        it._seen[k] = 1;
                        it.lotRolls.push({ lot: lotLabel, roll: rn.label });
                    }
                });
            }
        });

        var cutListOut = matOrder.map(function (matId) {
            var m = matAgg[matId];
            var orders = m.planOrder.map(function (pid) {
                var pl = m.byPlan[pid];
                var items = pl.itemOrder.map(function (iid) {
                    var it = pl.byItem[iid];
                    delete it._seen;
                    return it;
                }).sort(function (a, b) {
                    return String(a.sku).localeCompare(String(b.sku)) ||
                        String(a.name).localeCompare(String(b.name));
                });
                var totPieces = 0, totQty = 0, totItems = items.length;
                items.forEach(function (it) { totPieces += it.pieces; totQty += it.issuedQty; });
                return {
                    planId: pl.planId,
                    planNo: pl.planNo,
                    salesOrder: pl.salesOrder,
                    orderStatus: pl.orderStatus,
                    itemCount: totItems,
                    totalPieces: totPieces,
                    // METRES OF CLOTH this order consumes from the handover -
                    // Σ Material_Requirement.Issued_Qty across its items. Tells
                    // the supervisor how much to lay out for this order.
                    totalQty: r2(totQty),
                    items: items
                };
            }).sort(function (a, b) {
                return String(a.salesOrder || a.planNo).localeCompare(String(b.salesOrder || b.planNo));
            });
            return {
                materialId: m.materialId,
                material: m.material,
                unit: m.unit,
                isFabric: m.isFabric,
                orders: orders
            };
        }).sort(function (a, b) {
            return String(a.material).localeCompare(String(b.material));
        });

        return { header: header, cloth: cloth, cutList: cutListOut, errors: [] };
    }

    return {
        run: run,
        cutList: cutList,
        assemble: assemble,
        _parseRollLabel: parseRollLabel,
        _creatorDateToTs: creatorDateToTs,
        _fmtCreatorDate: fmtCreatorDate,
        _reports: RPT
    };
})();

if (typeof window !== 'undefined') window.HandoverDetail = HandoverDetail;
if (typeof module !== 'undefined' && module.exports) module.exports = HandoverDetail;

/* =============================================================================
 * ---- TAB WIRING (browser only) ----
 * ========================================================================== */
(function () {
    'use strict';
    if (typeof document === 'undefined') return;

    // reuse receive.js helpers if present, else local fallbacks
    var esc = (typeof escapeHtml === 'function') ? escapeHtml : function (s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    };
    var f2 = (typeof fmt === 'function') ? fmt : function (n) {
        n = Number(n) || 0;
        return (Math.round(n * 100) / 100).toLocaleString();
    };

    var CHEV = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // Shop-floor label + pill class per Plan_Item status. Blue (status-info) for
    // "ready to cut", amber for waiting, grey-green for in-progress/done - same
    // spirit as the Order Overview map, tuned for this screen.
    var ITEM_STATUS = {
        Awaiting_Material: { text: 'No material yet', cls: 'status-partial' },
        Ready_For_Production: { text: 'Ready to cut', cls: 'status-info' },
        In_Production: { text: 'In production', cls: 'status-washing' },
        Awaiting_Check: { text: 'Awaiting check', cls: 'status-partial' },
        Complete: { text: 'Complete', cls: 'status-done' }
    };
    function itemStatus(s) {
        return ITEM_STATUS[s] || { text: (s || '').replace(/_/g, ' ') || '—', cls: 'status-partial' };
    }
    // Plan Order_Status (spaces) - blue when material is ready / moving.
    var ORDER_STATUS = {
        'Pending': { text: 'Awaiting material', cls: 'status-partial' },
        'Material Ready': { text: 'Material ready', cls: 'status-info' },
        'Partially Received': { text: 'Part material', cls: 'status-partial' },
        'In Progress': { text: 'In production', cls: 'status-info' }
    };
    function orderStatus(s) {
        return ORDER_STATUS[s] || { text: s || '—', cls: 'status-partial' };
    }

    // handover id we should open once the list has loaded (set by openHandover
    // from the Receive tab before the tab has ever been built).
    var pendingOpenId = null;
    var listLoadedForSup = null;

    function selEl() { return document.getElementById('hd-select'); }
    function contentEl() { return document.getElementById('hd-content'); }

    function loadList() {
        var supId = (typeof currentSupervisorId === 'function') ? currentSupervisorId()
            : (document.getElementById('sup-select') || {}).value || '';
        var sel = selEl();
        var content = contentEl();
        if (!sel || !content) return;

        sel.disabled = true;
        sel.innerHTML = '<option value="">Loading handovers…</option>';
        content.innerHTML = '<div class="hd-hint">Reading your handovers…</div>';

        HandoverDetail.run(supId || '').then(function (data) {
            listLoadedForSup = supId || '';
            var hs = data.handovers || [];
            sel.innerHTML = '<option value="">-- Select a handover --</option>' +
                hs.map(function (h) {
                    var bits = [h.voucherNo];
                    if (h.issueDate) bits.push(h.issueDate);
                    bits.push(h.materialCount + (h.materialCount === 1 ? ' material' : ' materials'));
                    if (h.planCount) bits.push(h.planCount + (h.planCount === 1 ? ' order' : ' orders'));
                    bits.push(h.fullyReceived ? 'received' : 'to receive');
                    return '<option value="' + esc(h.id) + '">' + esc(bits.join('  ·  ')) + '</option>';
                }).join('');
            sel.disabled = hs.length === 0;

            if (hs.length === 0) {
                content.innerHTML = '<div class="hd-empty"><h2>No handovers yet</h2>' +
                    '<p>Every store issue made to you shows up here once it exists.</p></div>';
                return;
            }

            var openId = pendingOpenId;
            pendingOpenId = null;
            if (openId && hs.some(function (h) { return h.id === String(openId); })) {
                sel.value = String(openId);
                renderOne(String(openId));
            } else {
                content.innerHTML = '<div class="hd-hint">Pick a handover above to see its cloth and cut list.</div>';
            }
        }).catch(function (err) {
            console.error('HandoverDetail.run failed:', err);
            sel.innerHTML = '<option value="">-- Select a handover --</option>';
            sel.disabled = true;
            content.innerHTML = '<div class="hd-empty"><div class="icon">⚠️</div>' +
                '<h2>Could not load your handovers</h2><p>Check the browser console.</p></div>';
        });
    }

    function renderOne(voucherId) {
        var content = contentEl();
        if (!content) return;
        content.innerHTML = '<div class="hd-hint">Loading handover…</div>';

        HandoverDetail.cutList(voucherId).then(function (d) {
            content.innerHTML = renderHeader(d.header) + renderCloth(d) + renderCutList(d);
        }).catch(function (err) {
            console.error('HandoverDetail.cutList failed:', err);
            content.innerHTML = '<div class="hd-empty"><div class="icon">⚠️</div>' +
                '<h2>Could not load this handover</h2><p>Check the browser console.</p></div>';
        });
    }

    function renderHeader(h) {
        var pills = '<span class="status-pill">' + esc(h.receiptStatus) + '</span>';
        if (h.transferStatus && h.transferStatus !== 'Done') {
            pills += ' <span class="status-pill status-partial">Transfer ' + esc(h.transferStatus) + '</span>';
        }
        var when = [h.issueDate, h.issueTime].filter(Boolean).join(' ');
        return '' +
            '<div class="hd-header">' +
                '<div class="hd-header-main">' +
                    '<h2>' + esc(h.voucherNo || 'Handover') + '</h2>' +
                    '<div class="hd-header-meta">' +
                        (when ? 'Issued ' + esc(when) : '') +
                        (h.issuedToName ? ' &middot; to ' + esc(h.issuedToName) : '') +
                        (h.planCount ? ' &middot; ' + h.planCount + (h.planCount === 1 ? ' order' : ' orders') : '') +
                    '</div>' +
                '</div>' +
                '<div class="hd-header-pills">' + pills + '</div>' +
                '<div class="hd-header-nums">' +
                    '<span><b>' + f2(h.totalQty) + '</b> issued</span>' +
                    '<span><b>' + f2(h.receivedQty) + '</b> received</span>' +
                    (h.owedQty > 0 ? '<span class="is-short"><b>' + f2(h.owedQty) + '</b> still owed</span>' : '') +
                '</div>' +
            '</div>';
    }

    function renderCloth(d) {
        var rows = (d.cloth || []).map(function (c) {
            // Lot cell: one line per lot — "L1 → R1, R2, R3". Stacked when the
            // material spans several lots. Trims (no lots) show "—".
            var lotCell = '—';
            if (c.isFabric && c.lots.length) {
                lotCell = '<div class="hd-lots">' + c.lots.map(function (l) {
                    var names = (l.rolls || []).filter(function (r) { return r.roll; })
                        .map(function (r) { return esc(r.roll); });
                    var rollTxt = names.length
                        ? '<span class="hd-roll-list">' + names.join(', ') + '</span>'
                        : '<span class="hd-roll-none">roll not recorded</span>';
                    return '<div class="hd-lot-line">' +
                        '<b class="hd-lot-name">' + esc(l.lot) + '</b>' +
                        '<span class="hd-lot-arrow">&rarr;</span>' +
                        rollTxt +
                    '</div>';
                }).join('') + '</div>';
            } else if (c.isFabric) {
                lotCell = '<span class="hd-roll-none">not recorded</span>';
            }

            // Pieces = how many cut pieces this cloth yields, and where they
            // come from. Plain total when it is all fresh cloth; only split out
            // "+ N offcut" when reused remnants actually contributed.
            var totPcs = c.piecesFromRaw + c.piecesFromWaste;
            var pcs = totPcs
                ? '<b>' + totPcs + '</b> pc' + (totPcs === 1 ? '' : 's') +
                  (c.piecesFromWaste ? ' <span class="hd-sub">(' + c.piecesFromWaste + ' from offcut)</span>' : '')
                : '—';

            return '<tr>' +
                '<td><div class="mat-name">' + esc(c.material) +
                    (c.isPrinted ? '<span class="fabric-badge">Printed</span>'
                        : (c.isFabric ? '<span class="fabric-badge">Fabric</span>' : '')) +
                    '</div></td>' +
                '<td class="col-lot">' + lotCell + '</td>' +
                '<td class="col-num col-strong">' + f2(c.qtyIssued) + ' <span class="unit">' + esc(c.unit) + '</span></td>' +
                '<td class="col-num">' + f2(c.qtyReceived) + '</td>' +
                '<td class="col-num">' + pcs + '</td>' +
                '</tr>';
        }).join('');
        if (!rows) return '';
        return '' +
            '<div class="mat-section">' +
                '<div class="section-title">Cloth in this handover' +
                    '<span class="section-note">one line per material &mdash; lot &amp; roll to cut from</span></div>' +
                '<div class="table-wrapper"><table>' +
                    '<thead><tr>' +
                        '<th>Material</th><th class="col-lot">Lot &amp; roll</th>' +
                        '<th class="col-num">Issued</th><th class="col-num">Received</th>' +
                        '<th class="col-num">Pieces to cut</th>' +
                    '</tr></thead><tbody>' + rows + '</tbody>' +
                '</table></div>' +
            '</div>';
    }

    var HEADER_CHEV = '<span class="chevron" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></span>';

    // One item-card per MATERIAL, same shell as the Production / Order Overview
    // cards. Expands to that material's orders, each order to its items.
    function renderCutList(d) {
        var mats = d.cutList || [];
        if (!mats.length) {
            return '<div class="mat-section">' +
                '<div class="section-title">What to produce with it</div>' +
                '<div class="bd-empty">No order/item detail is recorded against this handover&rsquo;s cloth yet.</div></div>';
        }

        var cards = mats.map(function (m, mi) {
            var totOrders = m.orders.length;
            var totItems = 0, totPieces = 0, totQty = 0;
            m.orders.forEach(function (o) {
                totItems += o.itemCount; totPieces += o.totalPieces; totQty += (o.totalQty || 0);
            });

            var meta = totOrders + (totOrders === 1 ? ' order' : ' orders') +
                ' &middot; ' + totItems + (totItems === 1 ? ' item' : ' items') +
                (m.isFabric
                    ? ' &middot; ' + totPieces + ' pcs &middot; ' + f2(totQty) + ' ' + esc(m.unit) + ' to cut'
                    : '');

            var isFab = m.isFabric;
            var orderBlocks = m.orders.map(function (o, oi) {
                var oid = 'hd-o-' + mi + '-' + oi;

                var itemRows = o.items.map(function (it) {
                    var tags = (it.isRemake
                        ? ' <span class="reissue-tag">' + esc((it.remakeReason || 'remake').replace(/_/g, ' ')) + '</span>'
                        : (it.source && it.source !== 'Plan'
                            ? ' <span class="reissue-tag">' + esc(it.source.replace(/_/g, ' ')) + '</span>' : ''));
                    var st = itemStatus(it.status);
                    var nameCell = '<td class="hd-i-name"><span class="mat-name">' +
                        (it.sku ? '<span class="mat-sku">' + esc(it.sku) + '</span> ' : '') +
                        esc(it.name || '—') + tags + '</span></td>';
                    var statusCell = '<td class="hd-i-status"><span class="status-pill ' + st.cls + '">' +
                        esc(st.text) + '</span></td>';

                    if (isFab) {
                        var cut = (it.cutLength || it.cutWidth)
                            ? f2(it.cutLength) + ' &times; ' + f2(it.cutWidth) + ' cm' : '—';
                        var lotRoll = (it.lotRolls || []).map(function (lr) {
                            return '<span class="bd-roll-tag">' +
                                esc(lr.lot) + (lr.roll ? ' &middot; ' + esc(lr.roll) : '') + '</span>';
                        }).join('') || '—';
                        return '<tr>' + nameCell +
                            '<td class="hd-i-num"><b>' + it.pieces + '</b> pc' + (it.pieces === 1 ? '' : 's') + '</td>' +
                            '<td class="hd-i-num"><b>' + f2(it.issuedQty) + '</b> ' + esc(m.unit) + '</td>' +
                            '<td class="hd-i-cut">' + cut + '</td>' +
                            '<td class="hd-i-roll">' + lotRoll + '</td>' +
                            statusCell + '</tr>';
                    }
                    return '<tr>' + nameCell +
                        '<td class="hd-i-num"><b>' + f2(it.issuedQty) + '</b> ' + esc(m.unit) + '</td>' +
                        statusCell + '</tr>';
                }).join('');

                var head = isFab
                    ? '<tr><th class="hd-i-name">Item</th><th class="hd-i-num">Pieces</th>' +
                      '<th class="hd-i-num">Cloth</th>' +
                      '<th class="hd-i-cut">Cut size (L &times; W)</th>' +
                      '<th class="hd-i-roll">Lot &amp; roll</th><th class="hd-i-status">Status</th></tr>'
                    : '<tr><th class="hd-i-name">Item</th><th class="hd-i-num">Quantity</th>' +
                      '<th class="hd-i-status">Status</th></tr>';

                var oname = esc(o.salesOrder || o.planNo || 'Order');
                var ometa = o.itemCount + (o.itemCount === 1 ? ' item' : ' items') +
                    (isFab ? ' &middot; <b>' + o.totalPieces + '</b> pcs &middot; <b>' +
                        f2(o.totalQty) + '</b> ' + esc(m.unit) + ' to cut' : '');
                var ost = orderStatus(o.orderStatus);
                return '' +
                    '<div class="hd-order">' +
                        '<button type="button" class="hd-order-head" onclick="hdToggle(\'' + oid + '\', this)">' +
                            '<span class="hd-order-chev">' + CHEV + '</span>' +
                            '<span class="hd-order-name">' + oname + '</span>' +
                            (o.orderStatus ? '<span class="status-pill ' + ost.cls + '">' + esc(ost.text) + '</span>' : '') +
                            '<span class="hd-order-meta">' + ometa + '</span>' +
                        '</button>' +
                        '<div class="hd-order-items hidden" id="' + oid + '">' +
                            '<table class="hd-item-table' + (isFab ? ' is-fabric' : ' is-trim') + '">' +
                                '<thead>' + head + '</thead><tbody>' + itemRows + '</tbody></table>' +
                        '</div>' +
                    '</div>';
            }).join('');

            return '' +
                '<div class="item-card" id="hd-mat-card-' + mi + '">' +
                    '<div class="item-header" onclick="hdToggleMat(' + mi + ')">' +
                        '<div class="item-header-info">' +
                            '<h2>' + esc(m.material) +
                                (m.isFabric ? ' <span class="fabric-badge">Fabric</span>' : '') + '</h2>' +
                            '<div class="item-meta-line"><span>' + meta + '</span></div>' +
                        '</div>' +
                        '<div class="item-header-right">' + HEADER_CHEV + '</div>' +
                    '</div>' +
                    '<div class="item-body"><div class="hd-order-list">' + orderBlocks + '</div></div>' +
                '</div>';
        }).join('');

        return '' +
            '<div class="mat-section">' +
                '<div class="section-title">Orders &amp; items this cloth feeds' +
                    '<span class="section-note">cloth &rarr; order &rarr; item &mdash; cut size &amp; pieces are per item</span></div>' +
                '<div class="hd-cutlist">' + cards + '</div>' +
            '</div>';
    }

    // ---- exports the markup calls by name ----
    window.hdToggleMat = function (mi) {
        var card = document.getElementById('hd-mat-card-' + mi);
        if (card) card.classList.toggle('open');
    };
    window.hdToggle = function (id, btn) {
        var box = document.getElementById(id);
        if (!box) return;
        var open = box.classList.toggle('hidden') === false;
        var chev = btn && btn.querySelector('.chevron');
        if (chev) chev.classList.toggle('is-open', open);
    };

    // Called from the Receive tab's SIV tags. Switches to this tab and opens the
    // handover once its list is in hand.
    //
    // ONE loadList() PER CALL, NOT TWO. showTab() lazy-loads the tab on its
    // FIRST open — it flips tabsLoaded.handovers and runs TAB_LOADERS.handovers
    // (loadList) itself. So the reload decision has to be read BEFORE showTab
    // runs, or the freshly-set flag makes us fire a second, racing loadList()
    // (two Employee_Report + Material_Issue_Report paging runs, then a doubled
    // cutList burst — the getRecords storm CLAUDE.md warns about).
    window.openHandover = function (voucherId) {
        pendingOpenId = voucherId;
        var supId = (typeof currentSupervisorId === 'function') ? currentSupervisorId() : '';
        var willLazyLoad = !tabsLoaded.handovers;          // showTab will call loadList
        var listStale = listLoadedForSup !== (supId || ''); // list is for another person

        if (typeof showTab === 'function') showTab('handovers');

        if (willLazyLoad) {
            // showTab already kicked loadList(); pendingOpenId will land in it.
            return;
        }
        if (listStale) {
            loadList();
            return;
        }
        // Tab already loaded for this supervisor — the list is current, just
        // select the SIV and render it. No refetch.
        pendingOpenId = null;
        var sel = selEl();
        if (sel) sel.value = String(voucherId);
        renderOne(String(voucherId));
    };

    selEl() && selEl().addEventListener('change', function () {
        var v = this.value;
        if (v) renderOne(v);
        else contentEl().innerHTML = '<div class="hd-hint">Pick a handover above to see its cloth and cut list.</div>';
    });

    TAB_LOADERS.handovers = loadList;
})();
