/* =============================================================================
 * EXPERIMENT — build the store-issue-requirements payload with the Creator JS
 * Data API instead of the getStoreMaterialRequirements custom function.
 *
 * This is a faithful JS port of getStoreMaterialRequirements' DATA ASSEMBLY:
 * every supervisor block and every material entry comes out in the SAME shape,
 * with the SAME field names, so the client-side allocator (applyLotAllocation
 * in lot-allocator.js) and every renderer in main.js run UNCHANGED on top of
 * it. loadRequirements() calls ApiExperiment.run() and passes the result
 * straight to render().
 *
 * FORMS READ (10 reports, via getRecords with cursor paging):
 *   Production_Planning_Report   open plans (Pending/Partially Received/In Progress)
 *   Material_Requirement_Report  the demand rows
 *   Employee_Report              supervisor names
 *   Plan_Item_Report             item name + remake flag
 *   All_items_Report             Raw_Material: SKU, display name, qty, width, print base
 *   All_Material_Lots            Raw_Material_Lot: wash / unwash / in-wash / form / status
 *   Fabric_Piece_Report          printed-cloth pieces (for Pieces-form lots)
 *   Waste_Master_Report          available offcuts
 *   Material_Exception_Report    open shortage / wash tickets
 *
 * WHAT IS PORTED (mirrors the Deluge):
 *   - aggregation key supId|matId|source, sum required/issued/pieces
 *   - per-cut summary (cutsJson), per-line list (lines[])
 *   - per-material stock rollup from lots (wash/unwash/in-wash), fabric width
 *   - lot list with blocked / empty-lot / in-wash handling, Pieces vs Roll form
 *   - wasteStock[] per material with its lot number + carton
 *   - openExceptions[] with covered plan ids, poNumber, lot
 *   - poCoveredQty netting
 *
 * NOT PORTED (edge features — noted where they would apply):
 *   - PRINT-BASE CHAINING. A printed SKU that is out of printed stock will not
 *     fall back to naming its plain-cloth base lot. printBase / printBaseLots
 *     come out empty. Plain (non-printed) fabric is unaffected.
 *   - No parallel paging — one cursor walk per report.
 *
 * REMOVE AFTER THE EXPERIMENT: delete this file and its <script> tag in
 * widget.html, and restore the CUSTOM-API PATH block in loadRequirements().
 * ========================================================================== */

var ApiExperiment = (function () {
    'use strict';

    var OPEN_STATUSES = ['Pending', 'Partially Received', 'In Progress'];

    // Report link names. Adjust here if getRecords throws "<name>: ...".
    var RPT = {
        plans: 'Production_Planning_Report',
        reqs: 'Material_Requirement_Report',
        emps: 'Employee_Report',
        planItems: 'Plan_Item_Report',
        rawMat: 'All_items_Report',
        lots: 'All_Material_Lots',
        pieces: 'Fabric_Piece_Report',
        waste: 'Waste_Master_Report',
        exceptions: 'Material_Exception_Report'
    };

    function have() {
        return typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
            typeof ZOHO.CREATOR.DATA.getRecords === 'function';
    }

    // ---- getRecords with cursor paging -----------------------------------
    function getAll(reportName, criteria) {
        return new Promise(function (resolve, reject) {
            var rows = [];
            var calls = 0;

            // Creator signals "nothing to return" from getRecords as an HTTP 400
            // with one of several codes, NOT as an empty list. All of them are a
            // valid empty result for us — an org with no available waste, no open
            // exceptions, a report whose form has no rows yet — so they resolve
            // to [], not reject:
            //   9280 — no records match the given criteria
            //   9220 — no records exist in this report at all
            //   3100 — no data available (older builds)
            function isNoRecords(err) {
                if (!err) return false;
                var s = '';
                try { s = JSON.stringify(err); } catch (e) { s = String(err); }
                s = (s + ' ' + (err.message || '') + ' ' + (err.responseText || '') +
                    ' ' + (err.responseJSON ? JSON.stringify(err.responseJSON) : '')).toLowerCase();
                var code = err.code;
                if (code == null && err.responseJSON) code = err.responseJSON.code;
                return code === 9280 || code === 9220 || code === 3100 ||
                    s.indexOf('9280') !== -1 || s.indexOf('9220') !== -1 ||
                    s.indexOf('no records found') !== -1 ||
                    s.indexOf('no records exist') !== -1 ||
                    s.indexOf('no data available') !== -1;
            }

            function page(cursor) {
                var cfg = { report_name: reportName, field_config: 'all', max_records: 1000 };
                if (criteria) cfg.criteria = criteria;
                if (cursor) cfg.record_cursor = cursor;
                calls++;
                ZOHO.CREATOR.DATA.getRecords(cfg).then(function (resp) {
                    var data = (resp && (resp.data || resp.records)) || [];
                    for (var i = 0; i < data.length; i++) rows.push(data[i]);
                    var next = resp && (resp.record_cursor || resp.cursor);
                    if (next && data.length > 0) page(next);
                    else resolve({ rows: rows, calls: calls });
                }).catch(function (err) {
                    if (isNoRecords(err)) {
                        console.log('[api-experiment] ' + reportName + ': 0 rows (9280) — treating as empty');
                        resolve({ rows: rows, calls: calls });
                        return;
                    }
                    reject(new Error(reportName + ': ' + (err && err.message ? err.message : JSON.stringify(err))));
                });
            }
            page(null);
        });
    }

    // ---- value coercion --------------------------------------------------
    function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
    function str(v) { return v == null ? '' : String(v); }
    function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

    function lookupId(v) {
        if (v == null) return '';
        if (typeof v === 'object') return String(v.ID || v.id || '');
        return String(v);
    }
    function lookupText(v, field) {
        if (v == null) return '';
        if (typeof v === 'object') return String(v[field] || v.zc_display_value || '');
        return String(v);
    }
    function truthy(v) {
        return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes' || v === 'yes' || v === 'True';
    }
    // Free text crossing into the payload — the Deluge flattens newlines/tabs.
    function flat(v) {
        return str(v).replace(/"/g, "'").replace(/\r/g, '').replace(/\n/g, ' | ').replace(/\t/g, ' ');
    }

    // =====================================================================
    function run() {
        if (!have()) return Promise.reject(new Error('ZOHO.CREATOR.DATA.getRecords not available'));

        var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

        var planCriteria = OPEN_STATUSES.map(function (s) { return 'Order_Status == "' + s + '"'; }).join(' || ');

        return Promise.all([
            getAll(RPT.plans, planCriteria),
            getAll(RPT.reqs, null),
            getAll(RPT.emps, null),
            getAll(RPT.planItems, null),
            getAll(RPT.rawMat, null),
            getAll(RPT.lots, null),
            getAll(RPT.pieces, 'Piece_Status == "Available"'),
            getAll(RPT.waste, 'Status == "Available"'),
            getAll(RPT.exceptions, 'Status == "Open"')
        ]).then(function (res) {
            var raw = {
                plans: res[0].rows, reqs: res[1].rows, emps: res[2].rows,
                planItems: res[3].rows, rawMats: res[4].rows, lots: res[5].rows,
                pieces: res[6].rows, waste: res[7].rows, exceptions: res[8].rows
            };
            var out = assemble(raw);
            var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            out._experiment = {
                via: 'ZOHO.CREATOR.DATA.getRecords',
                getRecordsCalls: res.reduce(function (n, r) { return n + r.calls; }, 0),
                rowsFetched: {
                    plans: raw.plans.length, requirements: raw.reqs.length, employees: raw.emps.length,
                    planItems: raw.planItems.length, rawMaterials: raw.rawMats.length, lots: raw.lots.length,
                    pieces: raw.pieces.length, waste: raw.waste.length, exceptions: raw.exceptions.length
                },
                wallMs: Math.round(t1 - t0),
                printBasePorted: false,
                paged: false
            };
            console.log('[api-experiment] done', out._experiment);
            return out;
        });
    }

    // The PURE assembly — the JS port of getStoreMaterialRequirements' data
    // build. Takes the nine fetched row-arrays, returns { plans: [...] } in the
    // exact shape the custom function returns. No SDK, no promises, so it is
    // fully unit-testable (see tools/api-experiment-parity.test.js).
    //
    //   raw = { plans, reqs, emps, planItems, rawMats, lots, pieces, waste,
    //           exceptions }   — arrays of getRecords-shaped records
    function assemble(raw) {
        var plans = raw.plans || [], reqs = raw.reqs || [], emps = raw.emps || [],
            planItems = raw.planItems || [], rawMats = raw.rawMats || [], lots = raw.lots || [],
            pieces = raw.pieces || [], waste = raw.waste || [], exceptions = raw.exceptions || [];

        {
            // ---------- id-keyed maps ----------------------------------
            // Re-filter by Order_Status HERE, not just in the getRecords
            // criteria: the Deluge's plan query is the gate, so assemble()
            // must be that gate too regardless of what the caller passed.
            var openPlan = {};   // planId -> { salesOrder, priorityKey }
            plans.forEach(function (p) {
                if (OPEN_STATUSES.indexOf(str(p.Order_Status).trim()) === -1) return;
                openPlan[String(p.ID)] = {
                    salesOrder: lookupText(p.Sales_Order, 'Sales_Order'),
                    priorityKey: num(p.Priority_Key)
                };
            });

            var empName = {};
            emps.forEach(function (e) { empName[String(e.ID)] = str(e.Employee_Name); });

            var piInfo = {};
            planItems.forEach(function (pi) {
                piInfo[String(pi.ID)] = { name: str(pi.Item_Name).trim(), isRemake: truthy(pi.Is_Remake) };
            });

            // Raw_Material — SKU, display name, qty, fabric width (inches -> cm),
            // print base id.
            var rmById = {};
            rawMats.forEach(function (rm) {
                rmById[String(rm.ID)] = {
                    sku: str(rm.SKU).trim(),
                    // Deluge matDispByMat is Material_Display_Name ONLY (no Name
                    // fallback) — an empty display name lets the row fall back to
                    // the requirement's snapshot Material_Name in showName below.
                    dispName: str(rm.Material_Display_Name).trim(),
                    qty: num(rm.Quantity),
                    widthCm: num(rm.Fabric_Width_Inches) * 2.54,
                    printBase: lookupId(rm.Print_Base)
                };
            });

            // Fabric_Piece grouped by lot id (available only, fetched with that
            // criteria). Piece_Length_Cm / Piece_Width_Cm / Piece_Count / State.
            var piecesByLot = {};
            pieces.forEach(function (fp) {
                var lotId = lookupId(fp.Lot);
                if (!lotId) return;
                (piecesByLot[lotId] = piecesByLot[lotId] || []).push({
                    pieceId: String(fp.ID),
                    lengthCm: num(fp.Piece_Length_Cm),
                    widthCm: num(fp.Piece_Width_Cm),
                    count: num(fp.Piece_Count),
                    state: str(fp.State).trim() || 'Wash',
                    carton: str(fp.Carton_Number).trim()
                });
            });

            // Raw_Material_Lot grouped by material id. Also a lot-id -> lot-number
            // map (built before the blocked/empty filter, so an offcut can still
            // name its lot after that lot drops off the picker).
            var lotsByMat = {};
            var lotNumById = {};
            lots.forEach(function (l) {
                var matId = lookupId(l.Material);
                lotNumById[String(l.ID)] = str(l.Lot_Number).trim();
                if (!matId) return;
                (lotsByMat[matId] = lotsByMat[matId] || []).push(l);
            });

            // Waste_Master (available) grouped by SKU/material id, plus
            // per-piece lot + carton maps.
            var wasteByMat = {};
            var wasteLotById = {};
            var wasteCartonById = {};
            waste.forEach(function (w) {
                var mid = lookupId(w.SKU);
                var pw = num(w.Piece_Width), pl = num(w.Piece_Length), pc = num(w.Piece_Count);
                if (!mid || pw <= 0 || pl <= 0 || pc <= 0) return;
                (wasteByMat[mid] = wasteByMat[mid] || []).push({
                    wasteId: String(w.ID), width: pw, length: pl, count: pc
                });
                wasteLotById[String(w.ID)] = lookupId(w.Lot);
                wasteCartonById[String(w.ID)] = str(w.Carton_Number).trim();
            });

            // Material_Exception (open) grouped by SKU, + poCovered netting.
            // (poCovered netting needs on-hand, computed after the lot rollup —
            // so exceptions are grouped now and poCovered filled in below.)
            var excBySku = {};
            var poRawBySku = {}; // sku -> [{ shortfall, required }] pending on-hand check
            exceptions.forEach(function (oex) {
                var exT = str(oex.Type_field).trim() || str(oex.Type).trim();
                var exSku = lookupId(oex.SKU);
                if (!exT || !exSku) return;

                var coveredPlans = [];
                var lines = oex.Exception_Lines || [];
                (Array.isArray(lines) ? lines : []).forEach(function (ln) {
                    var pId = lookupId(ln.Plan);
                    if (pId && coveredPlans.indexOf(pId) === -1) coveredPlans.push(pId);
                });

                var exPoNo = str(oex.PO_Number).trim();
                if (exT === 'Shortage' && exPoNo) {
                    (poRawBySku[exSku] = poRawBySku[exSku] || []).push({
                        shortfall: num(oex.Shortfall_Qty), required: num(oex.Required_Qty)
                    });
                }

                (excBySku[exSku] = excBySku[exSku] || []).push({
                    type: exT, planIds: coveredPlans, poNumber: exPoNo, lot: lookupId(oex.Lot)
                });
            });

            // ---------- aggregate the requirement rows ----------------
            // key = supId|matId|source
            var agg = {};
            var orderedKeys = [];
            var neededMats = {};
            var supName = {};

            reqs.forEach(function (mr) {
                var planId = lookupId(mr.Plan);
                if (!openPlan[planId]) return;

                var supId = lookupId(mr.Assigned_To);
                var matId = lookupId(mr.Material);
                if (!supId || !matId) return;

                var isFab = truthy(mr.Is_Fabric);
                var cutW = isFab ? num(mr.Cut_Size_Width) : 0;
                var cutL = isFab ? num(mr.Cut_Size_Length) : 0;
                var reqPieces = isFab ? num(mr.Required_Pieces) : 0;
                var fromWaste = isFab ? num(mr.Pieces_From_Waste) : 0;
                var fromRaw = isFab ? num(mr.Pieces_From_Raw) : 0;
                var issPieces = fromWaste + fromRaw;

                var src = str(mr.Source).trim() || 'Plan';
                var isReissue = src === 'Reissue';
                var key = supId + '|' + matId + '|' + src;

                var cur = agg[key];
                if (!cur) {
                    cur = {
                        supId: supId, matId: matId,
                        name: str(mr.Material_Name), unit: str(mr.Unit),
                        isFabric: isFab, isReissue: isReissue,
                        required: 0, issued: 0,
                        reqPieces: 0, issPieces: 0, wasteIssPieces: 0,
                        cuts: {}, lines: []
                    };
                    agg[key] = cur;
                    orderedKeys.push(key);
                }
                neededMats[matId] = true;
                supName[supId] = empName[supId] || ('Supervisor ' + supId);

                cur.required += num(mr.Required_Qty);
                cur.issued += num(mr.Issued_Qty);
                cur.reqPieces += reqPieces;
                cur.issPieces += issPieces;
                cur.wasteIssPieces += fromWaste;

                if (isFab) {
                    var ck = cutW + 'x' + cutL;
                    var cc = cur.cuts[ck] || (cur.cuts[ck] = { cutW: cutW, cutL: cutL, reqPieces: 0, issPieces: 0 });
                    cc.reqPieces += reqPieces;
                    cc.issPieces += issPieces;
                }

                var piId = lookupId(mr.Plan_Item);
                var pi = piInfo[piId] || { name: '', isRemake: false };
                var issuedLot = lookupId(mr.Issued_Lot);
                cur.lines.push({
                    mrqId: String(mr.ID),
                    planId: planId,
                    salesOrder: (openPlan[planId] || {}).salesOrder || '',
                    planItemId: piId,
                    item: flat(pi.name),
                    isRemake: pi.isRemake,
                    supervisorId: supId,
                    required: num(mr.Required_Qty),
                    issued: num(mr.Issued_Qty),
                    cutW: cutW, cutL: cutL,
                    reqPieces: reqPieces, issPieces: issPieces,
                    issuedLot: issuedLot,
                    // Readable number for the pinned lot, resolved from the lot
                    // map. Deluge emits this as issuedLotNo (line 1409); the
                    // allocator falls back to the id without it.
                    issuedLotNo: issuedLot ? (lotNumById[issuedLot] || '') : '',
                    reason: flat(mr.Reason)
                });
            });

            // ---------- per-material lot rollup ----------------------
            // For every material in play: build lots[] (blocked/empty filtered,
            // Pieces vs Roll), sum calcWash / calcUnwash / calcInWash.
            var lotJsonByMat = {};   // matId -> lots[] (objects, not JSON)
            var calcWashByMat = {};
            var calcUnwashByMat = {};
            var calcInWashByMat = {};

            Object.keys(neededMats).forEach(function (matId) {
                var matLots = lotsByMat[matId] || [];
                var out = [];
                var mWash = 0, mUnwash = 0, mInWash = 0;

                matLots.forEach(function (l) {
                    var st = str(l.Status).trim() || 'Active';
                    var blocked = st === 'Blocked';

                    var lrWash = num(l.Wash_Quantity);
                    var lrUnwash = num(l.Unwash_Quantity);
                    var lrInWash = num(l.In_Wash_Qty);
                    var form = str(l.Form).trim();
                    if (form !== 'Pieces') form = 'Roll';

                    var lrPieces = [];
                    if (form === 'Pieces') {
                        var fps = piecesByLot[String(l.ID)] || [];
                        var pieceMtr = 0;
                        fps.forEach(function (fp) {
                            if (fp.count > 0 && fp.lengthCm > 0) {
                                lrPieces.push({
                                    pieceId: fp.pieceId, lengthCm: fp.lengthCm, widthCm: fp.widthCm,
                                    count: fp.count, state: fp.state, carton: fp.carton
                                });
                                if (fp.state === 'Wash') pieceMtr += (fp.lengthCm / 100) * fp.count;
                            }
                        });
                        lrWash = pieceMtr; // Pieces lot's issuable stock is its washed pieces
                    }

                    // Empty lot is not a choice — unless its cloth is at the wash.
                    if (lrWash > 0 || lrUnwash > 0 || lrInWash > 0) {
                        out.push({
                            lotId: String(l.ID),
                            lotNumber: flat(l.Lot_Number),
                            label: flat(l.Lot_Label),
                            blocked: blocked,
                            wash: lrWash,
                            unwash: lrUnwash,
                            inWash: lrInWash,
                            form: form,
                            pieces: lrPieces
                        });
                    }

                    // Rollup counts every lot (blocked + empty), mirroring the
                    // Deluge's calc* maps.
                    mWash += lrWash;
                    mUnwash += lrUnwash;
                    mInWash += lrInWash;
                });

                lotJsonByMat[matId] = out;
                calcWashByMat[matId] = r2(mWash);
                calcUnwashByMat[matId] = r2(mUnwash);
                calcInWashByMat[matId] = r2(mInWash);
            });

            // ---------- poCovered netting (needs on-hand) ------------
            var poCoveredBySku = {};
            Object.keys(poRawBySku).forEach(function (sku) {
                var onHand = calcWashByMat[sku];
                if (onHand === undefined) onHand = (rmById[sku] || {}).qty || 0;
                var total = 0;
                poRawBySku[sku].forEach(function (row) {
                    if (row.required <= 0 || onHand < row.required) total += row.shortfall;
                });
                if (total > 0) poCoveredBySku[sku] = r2(total);
            });

            // ---------- shape into supervisor blocks ----------------
            var bySup = {};
            var supSeen = [];

            orderedKeys.forEach(function (key) {
                var e = agg[key];
                var matId = e.matId;
                var rm = rmById[matId] || {};
                var isFab = e.isFabric;

                var block = bySup[e.supId];
                if (!block) {
                    block = { supervisorId: e.supId, supervisorName: supName[e.supId] || '', materials: [] };
                    bySup[e.supId] = block;
                    supSeen.push(e.supId);
                }

                var availableStock = isFab
                    ? (calcWashByMat[matId] || 0)
                    : (rm.qty || 0);
                var unwashedStock = isFab ? (calcUnwashByMat[matId] || 0) : 0;
                var inWashStock = isFab ? (calcInWashByMat[matId] || 0) : 0;

                var showName = e.name;
                if (rm.dispName) showName = rm.dispName;

                var mat = {
                    materialId: matId,
                    material: showName,
                    sku: rm.sku || '',
                    unit: e.unit,
                    isFabric: isFab,
                    isReissue: e.isReissue,
                    required: e.required,
                    issued: e.issued,
                    remaining: e.required - e.issued,
                    availableStock: availableStock,
                    poCoveredQty: poCoveredBySku[matId] || 0,
                    lines: e.lines,
                    openExceptions: excBySku[matId] || []
                };

                if (isFab) {
                    var outstandingPieces = e.reqPieces - e.issPieces;
                    if (outstandingPieces < 0) outstandingPieces = 0;

                    var cutsArr = Object.keys(e.cuts).map(function (k) { return e.cuts[k]; });

                    // FRESH METRES — the Deluge's pre-waste per-cut whole-marker-
                    // row estimate (getStoreMaterialRequirements.dg lines
                    // 1289-1333). applyLotAllocation recomputes this once it has
                    // the lots + waste, but its own no-piece-data fallback reads
                    // m.freshMeters, and for a stale widget this IS the figure —
                    // so it must match the Deluge, not be 0.
                    var fWidth = rm.widthCm || 0;
                    var freshMeters = 0;
                    var anyCountable = false;
                    cutsArr.forEach(function (ck) {
                        var cw = num(ck.cutW), cl = num(ck.cutL);
                        var remainCut = num(ck.reqPieces) - num(ck.issPieces);
                        if (remainCut < 0) remainCut = 0;
                        if (num(ck.reqPieces) > 0 && cw > 0 && cl > 0 && fWidth > 0) {
                            var perRow = Math.floor(fWidth / cw);
                            if (perRow > 0) {
                                anyCountable = true;
                                if (remainCut > 0) {
                                    var fmRows = Math.ceil(remainCut / perRow);
                                    freshMeters += (fmRows * cl) / 100;
                                }
                            }
                        }
                    });
                    if (!anyCountable) {
                        freshMeters = e.required - e.issued;
                        if (freshMeters < 0) freshMeters = 0;
                    }
                    freshMeters = r2(freshMeters);

                    // wasteStock[] — every remnant of this material with its lot
                    // number + carton, raw (the allocator lot-matches it).
                    var stock = (wasteByMat[matId] || []).map(function (w) {
                        var lotId = wasteLotById[w.wasteId] || '';
                        return {
                            wasteId: w.wasteId,
                            width: w.width, length: w.length, pieces: w.count,
                            lotId: lotId,
                            lot: lotId ? (lotNumById[lotId] || '') : '',
                            carton: wasteCartonById[w.wasteId] || ''
                        };
                    });

                    mat.unwashedStock = unwashedStock;
                    mat.inWashStock = inWashStock;
                    mat.cuts = cutsArr;
                    mat.cutsJson = JSON.stringify(cutsArr); // some readers expect the string
                    mat.fabricWidthCm = rm.widthCm || 0;
                    mat.requiredPieces = e.reqPieces;
                    mat.issuedPieces = e.issPieces;
                    mat.wasteIssuedPieces = e.wasteIssPieces;
                    mat.outstandingPieces = outstandingPieces;
                    mat.lots = lotJsonByMat[matId] || [];
                    mat.wasteStock = stock;

                    // Fabric OUTPUT fields, matching the Deluge's pre-waste
                    // values (lines 1335-1354). applyLotAllocation overwrites
                    // freshMeters / remaining / required / wastePicks /
                    // piecesCoveredByWaste / freshPieces once it runs; these are
                    // the honest fallback a stale widget renders.
                    mat.wastePicks = [];
                    mat.freshMeters = freshMeters;
                    mat.piecesCoveredByWaste = 0;
                    mat.freshPieces = outstandingPieces; // - coveredPcsTotal (0 pre-alloc)
                    mat.requiredTotal = e.required;
                    // Deluge: matEntry.required = freshMeters; remaining = freshMeters.
                    mat.required = freshMeters;
                    mat.remaining = freshMeters;

                    // Print-base chaining NOT ported.
                    mat.printBase = '';
                    mat.printBaseName = '';
                    mat.printBaseLots = [];
                }

                block.materials.push(mat);
            });

            var plansOut = supSeen.map(function (sid) { return bySup[sid]; });

            // Priority order: the Deluge sorts by Priority_Key across the plan
            // walk. Here we approximate — each supervisor's best (lowest)
            // priorityKey across the plans that feed his materials.
            var supPrio = {};
            reqs.forEach(function (mr) {
                var pid = lookupId(mr.Plan);
                var sid = lookupId(mr.Assigned_To);
                if (!openPlan[pid] || !sid) return;
                var pk = openPlan[pid].priorityKey || 1e15;
                if (supPrio[sid] === undefined || pk < supPrio[sid]) supPrio[sid] = pk;
            });
            plansOut.sort(function (a, b) {
                var pa = supPrio[a.supervisorId], pb = supPrio[b.supervisorId];
                if (pa == null) pa = 1e15;
                if (pb == null) pb = 1e15;
                if (pa !== pb) return pa - pb;
                return String(a.supervisorName).localeCompare(String(b.supervisorName));
            });

            return { plans: plansOut };
        }
    }

    // ---- compare against the custom function ---------------------------
    function compare() {
        if (!have() || typeof ZOHO.CREATOR.DATA.invokeCustomApi !== 'function') {
            console.warn('[api-experiment] compare needs getRecords AND invokeCustomApi');
            return;
        }
        var pApi = run();
        var tB = performance.now();
        var pFn = ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'getStoreMaterialRequirements',
            http_method: 'POST',
            payload: { skipCountTxt: '0', pagePlansTxt: '' }
        }).then(function (resp) {
            var parsed;
            try { parsed = JSON.parse(resp.result); } catch (e) { parsed = null; }
            return { plans: (parsed && parsed.plans) || [], _ms: Math.round(performance.now() - tB) };
        });

        return Promise.all([pApi, pFn]).then(function (r) {
            var api = r[0], fn = r[1];
            function totals(plans) {
                var t = {};
                (plans || []).forEach(function (b) {
                    var req = 0, iss = 0, stock = 0;
                    (b.materials || []).forEach(function (m) {
                        req += num(m.required); iss += num(m.issued); stock += num(m.availableStock);
                    });
                    t[b.supervisorName || b.supervisorId] = {
                        materials: (b.materials || []).length, required: r2(req), issued: r2(iss), stock: r2(stock)
                    };
                });
                return t;
            }
            var tApi = totals(api.plans), tFn = totals(fn.plans);
            console.log('%c[api-experiment] COMPARE', 'font-weight:bold');
            console.log('  wall   — getRecords ' + api._experiment.wallMs + 'ms   custom fn ' + fn._ms + 'ms (unpaged)');
            console.log('  calls  — getRecords ' + api._experiment.getRecordsCalls + '   custom fn 1');
            console.log('  supers — getRecords ' + Object.keys(tApi).length + '   custom fn ' + Object.keys(tFn).length);
            var merged = {};
            Object.keys(tApi).concat(Object.keys(tFn)).forEach(function (k) {
                merged[k] = {
                    'api.mats': tApi[k] ? tApi[k].materials : '—', 'fn.mats': tFn[k] ? tFn[k].materials : '—',
                    'api.req': tApi[k] ? tApi[k].required : '—', 'fn.req': tFn[k] ? tFn[k].required : '—',
                    'api.iss': tApi[k] ? tApi[k].issued : '—', 'fn.iss': tFn[k] ? tFn[k].issued : '—',
                    'api.stock': tApi[k] ? tApi[k].stock : '—', 'fn.stock': tFn[k] ? tFn[k].stock : '—'
                };
            });
            console.table(merged);
            console.log('  rows fetched:', api._experiment.rowsFetched);
            return { getRecords: api, customFn: fn };
        });
    }

    // ---- raw-key inspector -------------------------------------------------
    // Dumps the first record of every report so the EXACT keys getRecords
    // returns can be compared against what assemble() reads. A report can
    // expose a column under a name that differs from its form field link
    // (renamed column, a duplicate re-added as Cut_Size_Width1, a label with
    // spaces) and every mismatch silently reads as undefined -> 0.
    //   ApiExperiment.keys()               all reports
    //   ApiExperiment.keys('reqs')         one, by RPT key
    function keys(which) {
        if (!have()) { console.warn('[api-experiment] getRecords not available'); return; }
        var names = which ? [which] : Object.keys(RPT);
        return Promise.all(names.map(function (n) {
            return getAll(RPT[n], null).then(function (r) {
                var row = r.rows[0];
                console.log('%c[' + n + '] ' + RPT[n] + ' — ' + r.rows.length + ' rows',
                    'font-weight:bold');
                if (!row) { console.log('  (empty)'); return { report: n, keys: [], sample: null }; }
                console.log('  keys:', Object.keys(row).sort().join(', '));
                console.log('  sample:', row);
                return { report: n, keys: Object.keys(row).sort(), sample: row };
            });
        }));
    }

    return {
        run: run, compare: compare, assemble: assemble, keys: keys,
        _getAll: getAll, _reports: RPT
    };
})();

if (typeof window !== 'undefined') window.ApiExperiment = ApiExperiment;
if (typeof module !== 'undefined' && module.exports) module.exports = ApiExperiment;
