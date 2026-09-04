/* =============================================================================
 * JS-Data-API stand-in for getSupervisorMaterials — the supervisor's receive
 * list, built from flat getRecords reads instead of a paged Deluge walk.
 *
 * WHY IT CAN BE FLAT NOW. After the issue-model migration the receive screen
 * reads the HANDOVER records (Material_Issue / Issue_Lines at material x lot
 * grain) — one form, bounded by the supervisor's own vouchers, ~200 lines a
 * voucher at worst. No fan, no plan walk, no fat subform, so no chunking.
 *
 * It produces the EXACT shape render(merged) in receive.js consumes:
 *   { supervisors:[{id,name}],
 *     materials:[{materialId,material,unit,isFabric,isReissue,pending,
 *                 lots:[{lot,qty}], orders:[{planId,planNo,salesOrder,pending,
 *                 isReissue,reason,lineCount}], voucherIds:[..] }],
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
 * Behind a flag in receive.js (USE_JS_RECEIVE_READ); the getSupervisorMaterials
 * path stays as the fallback. Console: ReceiveRead.run(supId) / .compare(supId).
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

    // =====================================================================
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

        return Promise.all([
            getAll(RPT.emps, null),
            getAll(RPT.issues, 'Issued_To == ' + supId),
            getAll(RPT.reqs, 'Assigned_To == ' + supId),
            getAll(RPT.disputes, 'Supervisor == ' + supId + ' && Status == "Open"'),
            getAll(RPT.wasteMv, 'Moved_By == ' + supId),
            getAll(RPT.rawMat, null),
            getAll(RPT.lots, null)
        ]).then(function (res) {
            var raw = {
                emps: res[0], issues: res[1], reqs: res[2],
                disputes: res[3], wasteMv: res[4], rawMats: res[5], lots: res[6]
            };
            // Plans + sales orders: only the ones actually referenced.
            var planIds = {};
            raw.reqs.forEach(function (rq) {
                var p = lookupId(rq.Plan); if (p) planIds[p] = 1;
            });
            raw.wasteMv.forEach(function (wm) {
                var p = lookupId(wm.Plan); if (p) planIds[p] = 1;
            });
            var wantPlans = Object.keys(planIds);
            var planFetch = wantPlans.length
                ? getAll(RPT.plans, wantPlans.map(function (p) { return 'ID == ' + p; }).join(' || '))
                : Promise.resolve([]);
            return planFetch.then(function (plans) {
                raw.plans = plans;
                var soIds = {};
                plans.forEach(function (p) {
                    var so = lookupId(p.Sales_Order); if (so) soIds[so] = 1;
                });
                var wantSO = Object.keys(soIds);
                var soFetch = wantSO.length
                    ? getAll(RPT.salesOrders, wantSO.map(function (s) { return 'ID == ' + s; }).join(' || '))
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

                if (isPrinted) {
                    // One receipt row per printed Issue_Line — confirmed per piece.
                    printedPieces.push({
                        issueLineId: String(ln.ID),
                        voucherId: voucherId,
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
                        voucherIds: {}
                    };
                    mat[matId] = cur;
                    matOrder.push(matId);
                }
                cur.pending = r2(cur.pending + owed);
                cur.lots[lotLabel] = r2((cur.lots[lotLabel] || 0) + owed);
                cur.voucherIds[voucherId] = 1;
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
                    lineCount: 0
                };
                byPlan[planId] = e;
                list.push(planId);
            }
            e.pending = r2(e.pending + owedQ);
            e.lineCount += 1;
            if (isRe) { e.isReissue = true; mat[matId].isReissue = true; }
            if (!e.reason) e.reason = flat(rq.Reason);
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
                _wastePieceId: wpId,   // resolved to materialId/material after the extra fetch
                materialId: '',
                material: '',
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
                return { lot: lbl, qty: c.lots[lbl] };
            }).filter(function (l) { return l.qty > 0; });
            var ordersArr = (ordOrder[matId] || []).map(function (pid) {
                return ordAgg[matId][pid];
            });
            return {
                materialId: matId,
                material: c.name,
                unit: c.unit,
                isFabric: c.isFabric,
                isReissue: c.isReissue,
                pending: c.pending,
                lots: lotsArr,
                orders: ordersArr,
                voucherIds: Object.keys(c.voucherIds)
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
                .filter(function (x, i, a) { return x && a.indexOf(x) === i; })
        };
        return resolveWastePieceMaterials(out);
    }

    // Second, tiny fetch: waste-piece id -> its Raw_Material (SKU) + name. Only
    // the pieces actually on his still-owed Issued movements.
    function resolveWastePieceMaterials(out) {
        var ids = out._wastePieceIds || [];
        delete out._wastePieceIds;
        if (!ids.length || !have()) {
            return Promise.resolve(out);
        }
        var crit = ids.map(function (i) { return 'ID == ' + i; }).join(' || ');
        return getAll(RPT.wastePieces, crit).then(function (wps) {
            var skuByWp = {};
            (wps || []).forEach(function (w) {
                skuByWp[String(w.ID)] = lookupId(w.SKU);
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
                    delete w._wastePieceId;
                });
                return out;
            });
        });
    }

    // ---- compare against getSupervisorMaterials (paged) -----------------
    function compare(supervisorId) {
        if (!have() || typeof ZOHO.CREATOR.DATA.invokeCustomApi !== 'function') {
            console.warn('[receive-read] compare needs getRecords AND invokeCustomApi');
            return;
        }
        var pJs = run(supervisorId);
        var pFn = pageDeluge(supervisorId);
        return Promise.all([pJs, pFn]).then(function (r) {
            var js = r[0], fn = r[1];
            function totals(list) {
                var t = {};
                (list.materials || []).forEach(function (m) {
                    t[m.materialId] = { pending: r2(m.pending), lots: (m.lots || []).length, orders: (m.orders || []).length };
                });
                return t;
            }
            console.log('%c[receive-read] COMPARE', 'font-weight:bold');
            console.log('  materials — js ' + (js.materials || []).length + '   fn ' + (fn.materials || []).length);
            console.log('  waste     — js ' + (js.waste || []).length + '   fn ' + (fn.waste || []).length);
            console.log('  printed   — js ' + (js.printedPieces || []).length + '   fn ' + (fn.printedPieces || []).length);
            console.log('  plansAssigned — js ' + js.plansAssigned + '   fn ' + fn.plansAssigned);
            var tj = totals(js), tf = totals(fn), merged = {};
            Object.keys(tj).concat(Object.keys(tf)).forEach(function (k) {
                merged[k] = {
                    'js.pending': tj[k] ? tj[k].pending : '—', 'fn.pending': tf[k] ? tf[k].pending : '—',
                    'js.lots': tj[k] ? tj[k].lots : '—', 'fn.lots': tf[k] ? tf[k].lots : '—',
                    'js.orders': tj[k] ? tj[k].orders : '—', 'fn.orders': tf[k] ? tf[k].orders : '—'
                };
            });
            console.table(merged);
            return { js: js, fn: fn };
        });
    }

    function pageDeluge(supervisorId) {
        return new Promise(function (resolve, reject) {
            var merged = { materials: [], waste: [], printedPieces: [], _planFed: {}, errors: [] };
            function mergeIn(page) {
                (page.materials || []).forEach(function (bm) {
                    var em = merged.materials.filter(function (x) { return x.materialId === bm.materialId; })[0];
                    if (!em) { merged.materials.push(JSON.parse(JSON.stringify(bm))); return; }
                    em.pending = r2((em.pending || 0) + (bm.pending || 0));
                });
                (page.waste || []).forEach(function (w) { merged.waste.push(w); });
                (page.printedPieces || []).forEach(function (p) { merged.printedPieces.push(p); });
                if (page.plansAssigned) merged.plansAssigned = page.plansAssigned;
            }
            function fetchPage(skip, n) {
                if (n > 60) { resolve(merged); return; }
                ZOHO.CREATOR.DATA.invokeCustomApi({
                    api_name: 'getSupervisorMaterials',
                    http_method: 'POST',
                    payload: { supervisorId: String(supervisorId || ''), skipLinesTxt: String(skip) }
                }).then(function (resp) {
                    var parsed = JSON.parse(resp.result);
                    mergeIn(parsed);
                    var consumed = Number(parsed.linesConsumed) || 0;
                    if (consumed > 0) fetchPage(skip + consumed, n + 1);
                    else resolve(merged);
                }).catch(reject);
            }
            fetchPage(0, 0);
        });
    }

    return { run: run, compare: compare, assemble: assemble, _reports: RPT };
})();

if (typeof window !== 'undefined') window.ReceiveRead = ReceiveRead;
if (typeof module !== 'undefined' && module.exports) module.exports = ReceiveRead;
