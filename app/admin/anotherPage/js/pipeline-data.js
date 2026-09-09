/* ==========================================================================
 * SALES ORDER PIPELINE — the data layer, over the JS Data API.
 *
 * REPLACES `getSalesOrderProgress` (deluge/anotherPageScripts/, 630 lines).
 *
 * WHY IT MOVED OFF DELUGE. That function did, per page of 25 orders, for each
 * order, for each plan on it:
 *
 *     Stage_Log[Plan == plan.ID] sort by Sequence_No desc     every stage log
 *     Item_Check[Plan == plan.ID]                             every check
 *       -> Finishing_Data[Item_Check == ...] PER CHECK        nested
 *     Plan_Item[Plan == plan.ID]                              all ~110 rows
 *
 * A Faire order is one plan with ~110 items and ~8 stages — roughly 880
 * Stage_Log rows for ONE order. One of those anywhere on a page could push the
 * execution past Creator's statement limit, and THAT LIMIT IS NOT CATCHABLE: it
 * kills the script, the function's own try/catch never runs, and the widget gets
 * a bare HTTP 500 with no error card (CLAUDE.md). The screen would simply go
 * blank at volume, with nothing saying why.
 *
 * The JS Data API has no statement limit. This is a PURE READ — nothing here
 * writes — so the whole thing is criteria queries and joins done in the browser,
 * needing no Creator paste and no Custom API argument change.
 *
 * HOW IT STAYS CHEAP. Deluge's cost was per-plan queries inside a per-order
 * loop. Here every form is fetched ONCE for the whole page, bounded by the
 * plans on it, and joined in memory:
 *
 *     1 fetch  Sales_Order      the page of orders (criteria by status)
 *     1 fetch  Production_Planning   plans for those orders
 *     1 fetch  Plan_Item        items for those plans
 *     1 fetch  Stage_Log        stage logs for those plans
 *     1 fetch  Item_Check       checks for those plans
 *     1 fetch  Finishing_Data   finishing rows for those checks
 *     1 fetch  Employee / Customer_Master   names, cached
 *
 * Nine calls for a whole page rather than nine per order.
 *
 * WHAT IT ADDS THAT THE DELUGE NEVER HAD. `Sales_Order.Expected_Delivery_Date`
 * exists — createPlanForOneOrder copies it onto Plan_End_Date — and the
 * dashboard read it ZERO times. Without it there is no late, no due-soon, no
 * at-risk, which is most of what an order-status screen is for. Every row now
 * carries the delivery date, days until/since it, and how long the order has sat
 * without stage movement.
 * ========================================================================== */

var PipelineData = (function () {
    'use strict';

    // Candidates per form, best guess first — the same discovery the
    // consumption detail uses, and for the same reason: this org's report link
    // names are NOT consistent (api-experiment.js carries `All_items_Report` and
    // `All_Material_Lots`, and Item_Check turned out to be `All_Items`), so a
    // name that looks obvious is a guess.
    //
    // The first entry of each list is already proven against this org by
    // api-experiment.js, handover-detail.js or receive-read.js, so the common
    // case is one call and no probing.
    var CANDIDATES = {
        orders:   ['Sales_Order_Report', 'All_Sales_Orders', 'Sales_Order'],
        plans:    ['Production_Planning_Report', 'All_Production_Plans'],
        items:    ['Plan_Item_Report', 'All_Plan_Items'],
        stages:   ['Stage_Log_Report', 'All_Stage_Logs', 'Stage_Log'],
        checks:   ['All_Items', 'Item_Check_Report', 'Item_Check'],
        finish:   ['Finishing_Data_Report', 'All_Finishing_Data', 'Finishing_Data'],
        emps:     ['Employee_Report', 'All_Employees']

        // NO CUSTOMER REPORT. The customer name comes off the Sales_Order
        // lookup's own display_value, which is whatever Creator shows for the
        // linked record — so it needs no second fetch and, more usefully, no
        // guess about which field on Customer_Master holds the name. That guess
        // is exactly what left the Pending tab showing blank customers for
        // months: getPendingSalesOrders queried a form called `Customer` that
        // does not exist, and a query against a missing form returns nothing
        // silently.
    };

    var RPT = {};          // resolved names, cached for the session
    var UNRESOLVED = {};   // forms that failed every candidate

    // Sales_Order.Order_Status, in the order the workflow runs (CLAUDE.md).
    var FLOW = ['Pending', 'In Progress', 'Production Complete', 'Checking Passed',
                'Finishing Complete', 'Packed', 'Dispatched'];

    // "In Production" on the dashboard is four real statuses — everything
    // between planning and packing. Kept as one bucket because that is how the
    // screen has always grouped it and how the admin talks about it.
    var IN_PRODUCTION = ['In Progress', 'Production Complete', 'Checking Passed',
                         'Finishing Complete'];

    function have() {
        return typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
            typeof ZOHO.CREATOR.DATA.getRecords === 'function';
    }

    function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
    function str(v) { return v == null ? '' : String(v); }

    // A lookup arrives as a bare id or as { ID, display_value } depending on the
    // report's field config; both shapes appear in this org.
    function idOf(v) {
        if (v == null) return '';
        if (typeof v === 'object') return str(v.ID || v.id || '');
        return str(v);
    }
    function labelOf(v) {
        if (v == null) return '';
        if (typeof v === 'object') return str(v.display_value || v.zc_display_value || '');
        return str(v);
    }

    // ---- dates -----------------------------------------------------------
    //
    // Creator hands dates back in several shapes and an ISO string parsed with
    // `new Date(str)` is the classic off-by-one (it is read as UTC and shifts a
    // day west of Greenwich). Parsed by parts instead — the same care the
    // existing dashboard takes with its own date handling.
    function parseDate(v) {
        var s = str(v).trim();
        if (!s) return null;

        // dd-MMM-yyyy (Creator's usual display form)
        var m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
        if (m) {
            var mons = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
            var mi = mons.indexOf(m[2].toLowerCase());
            if (mi > -1) return new Date(+m[3], mi, +m[1]);
        }
        // yyyy-MM-dd
        m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
        // dd/MM/yyyy
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return new Date(+m[3], +m[2] - 1, +m[1]);

        var d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }

    function midnight(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    // Whole days from today. Negative = in the past. Counted between midnights
    // so "due today" is 0 whatever the clock says.
    function daysFromToday(v) {
        var d = parseDate(v);
        if (!d) return null;
        var ms = midnight(d).getTime() - midnight(new Date()).getTime();
        return Math.round(ms / 86400000);
    }

    // ---- fetching --------------------------------------------------------

    function getAll(reportName, criteria) {
        return new Promise(function (resolve) {
            if (!have()) { resolve({ rows: [], exists: false, error: 'JS Data API unavailable' }); return; }
            var rows = [];

            function isNoRecords(err) {
                if (!err) return false;
                var s = '';
                try { s = JSON.stringify(err); } catch (e) { s = String(err); }
                s = (s + ' ' + (err.message || '') + ' ' +
                     (err.responseJSON ? JSON.stringify(err.responseJSON) : '')).toLowerCase();
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

                ZOHO.CREATOR.DATA.getRecords(cfg).then(function (resp) {
                    var data = (resp && (resp.data || resp.records)) || [];
                    for (var i = 0; i < data.length; i++) rows.push(data[i]);
                    var next = resp && (resp.record_cursor || resp.cursor);
                    if (next && data.length > 0) page(next);
                    else resolve({ rows: rows, exists: true });
                }).catch(function (err) {
                    // A 9280 means the report EXISTS and matched nothing, which
                    // is what makes name-probing safe: it is the difference
                    // between "no stage logs on this page" and "no such report".
                    if (isNoRecords(err)) { resolve({ rows: rows, exists: true }); return; }
                    resolve({ rows: [], exists: false,
                        error: reportName + ': ' + (err && err.message ? err.message : 'could not be read') });
                });
            }
            page(null);
        });
    }

    function fetch(key, criteria) {
        var names = CANDIDATES[key] || [];
        if (RPT[key]) return getAll(RPT[key], criteria);
        if (UNRESOLVED[key]) {
            return Promise.resolve({ rows: [], exists: false, error: UNRESOLVED[key] });
        }
        var tried = [];
        function attempt(i) {
            if (i >= names.length) {
                UNRESOLVED[key] = key + ' (tried ' + tried.join(', ') + ')';
                return Promise.resolve({ rows: [], exists: false, error: UNRESOLVED[key] });
            }
            var name = names[i];
            tried.push(name);
            return getAll(name, criteria).then(function (res) {
                if (res.exists) {
                    RPT[key] = name;
                    if (i > 0) {
                        console.log('[pipeline] ' + key + ' resolved to "' + name + '"');
                    }
                    return res;
                }
                return attempt(i + 1);
            });
        }
        return attempt(0);
    }

    // (a == 1 || a == 2 || ...) for a set of ids.
    function idCriteria(field, ids) {
        if (!ids.length) return null;
        return '(' + ids.map(function (i) { return field + ' == ' + i; }).join(' || ') + ')';
    }

    // Creator criteria have a practical length limit, so a long id list is
    // chunked and the results concatenated. 60 ids per query keeps each well
    // inside it while still being one call per 60 rather than one per id.
    function fetchByIds(key, field, ids) {
        var uniq = [];
        var seen = {};
        ids.forEach(function (i) {
            var s = str(i);
            if (s && !seen[s]) { seen[s] = true; uniq.push(s); }
        });
        if (!uniq.length) return Promise.resolve({ rows: [], exists: true });

        var chunks = [];
        for (var i = 0; i < uniq.length; i += 60) chunks.push(uniq.slice(i, i + 60));

        return Promise.all(chunks.map(function (c) {
            return fetch(key, idCriteria(field, c));
        })).then(function (results) {
            var rows = [];
            var error = null;
            results.forEach(function (r) {
                if (r.error && !error) error = r.error;
                rows = rows.concat(r.rows || []);
            });
            return { rows: rows, exists: !error, error: error };
        });
    }

    /* ----------------------------------------------------------------------
     * counts() — the four dashboard tiles, plus every status behind them.
     *
     * One fetch of every order's status field. Counting client-side rather
     * than seven `.count()` queries means the tiles and the list can never
     * disagree about what status an order is in.
     * -------------------------------------------------------------------- */
    function counts() {
        return fetch('orders', null).then(function (res) {
            var byStatus = {};
            FLOW.forEach(function (s) { byStatus[s] = 0; });
            var total = 0;

            (res.rows || []).forEach(function (so) {
                var st = str(so.Order_Status).trim();
                total++;
                if (byStatus[st] === undefined) byStatus[st] = 0;
                byStatus[st]++;
            });

            var inProd = 0;
            IN_PRODUCTION.forEach(function (s) { inProd += byStatus[s] || 0; });

            return {
                total: total,
                byStatus: byStatus,
                pending: byStatus['Pending'] || 0,
                inProduction: inProd,
                packed: byStatus['Packed'] || 0,
                dispatched: byStatus['Dispatched'] || 0,
                error: res.error || null
            };
        });
    }

    /* ----------------------------------------------------------------------
     * page(opts) -> { orders, total, notes }   (name is historical — it does
     * not page; it returns the whole enriched bucket, main.js pages for display)
     *
     * opts: { status }  — one of the tile buckets ('Pending', 'In Production',
     * 'Packed', 'Dispatched'), a single Order_Status, or '' for everything
     * currently live. page/pageSize/search/sort are accepted and ignored.
     * -------------------------------------------------------------------- */
    //
    // ENRICHES THE WHOLE BUCKET, NOT ONE PAGE. Every order of the requested
    // status set is fetched, joined and returned. The caller pages the result
    // for DISPLAY, but "needs attention" (overdue / awaiting material / stuck)
    // and the risk-chip filter run over the full array on the client — so they
    // count every order, not just the 25 on screen. That was the whole bug:
    // the risk bar honestly said "on this page" because that was all it had.
    //
    // `search` and `sort` are no longer applied here — main.js owns both, over
    // the full enriched set, so the table / counts / pager cannot disagree
    // about what is listed. `page`/`pageSize` are ignored (kept in the signature
    // so an old caller does not break).
    //
    // Cost: the joins were bounded by 25 orders' plans; now by every
    // in-production order's plans (~one plan each). Still one getRecords per
    // form for the whole set (fetchByIds chunks the id list at 60), and there
    // is NO statement limit on the JS Data API — the reason this left Deluge.
    function page(opts) {
        opts = opts || {};
        var wanted = str(opts.status).trim();
        var notes = [];

        var statuses;
        if (wanted === 'In Production') statuses = IN_PRODUCTION.slice();
        else if (wanted === '' || wanted === 'All') statuses = FLOW.slice();
        else statuses = [wanted];

        var crit = '(' + statuses.map(function (s) {
            return 'Order_Status == "' + s + '"';
        }).join(' || ') + ')';

        return fetch('orders', crit).then(function (soRes) {
            if (soRes.error) notes.push(soRes.error);
            var orders = (soRes.rows || []).map(function (so) {
                var due = so.Expected_Delivery_Date;
                return {
                    id: str(so.ID),
                    salesOrder: str(so.Sales_Order),
                    status: str(so.Order_Status).trim(),
                    orderDate: str(so.Sales_Order_Date || so.Added_Time),
                    // THE FIELD THE OLD DASHBOARD NEVER READ.
                    dueDate: str(due),
                    daysToDue: daysFromToday(due),
                    customerId: idOf(so.Customer),
                    customerName: labelOf(so.Customer),
                    source: str(so.Order_Source),
                    shortClosed: so.Short_Closed === true || str(so.Short_Closed) === 'true',
                    shortCloseReason: str(so.Short_Close_Reason || ''),
                    // filled by the joins below
                    planId: '', planNo: '', supervisor: '',
                    orderedQty: 0, producedQty: 0, itemCount: 0, completedItems: 0,
                    remakeItems: 0, rejectedQty: 0,
                    currentStage: '', currentStageStatus: '', lastCompletedStage: '',
                    lastMovement: null, daysSinceMovement: null,
                    items: [], stages: [], blocked: 0
                };
            });

            var total = orders.length;
            if (!orders.length) {
                return { orders: [], total: 0, notes: notes };
            }

            // ---- the joins, one fetch per form for the WHOLE bucket ----
            return enrich(orders, notes).then(function () {
                // Urgency depends on stage movement, only known after the joins.
                var out = sortOrders(orders, 'urgency');
                return { orders: out, total: total, notes: notes };
            });
        });
    }

    // How an order is ranked. 'urgency' is the default because a list of a
    // hundred orders sorted by date answers "what is newest", and the question
    // an admin actually arrives with is "what needs me".
    function sortOrders(list, sort) {
        var copy = list.slice();
        if (sort === 'date') {
            copy.sort(function (a, b) {
                var da = parseDate(a.orderDate), db = parseDate(b.orderDate);
                return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
            });
            return copy;
        }
        if (sort === 'order') {
            copy.sort(function (a, b) { return a.salesOrder.localeCompare(b.salesOrder); });
            return copy;
        }
        // urgency: soonest due first, undated last — an order with no delivery
        // date cannot be judged late and must not be ranked as if it were.
        copy.sort(function (a, b) {
            var av = a.daysToDue, bv = b.daysToDue;
            if (av === null && bv === null) return 0;
            if (av === null) return 1;
            if (bv === null) return -1;
            return av - bv;
        });
        return copy;
    }

    // ---- the joins -------------------------------------------------------
    function enrich(orders, notes) {
        var orderIds = orders.map(function (o) { return o.id; });
        var byId = {};
        orders.forEach(function (o) { byId[o.id] = o; });

        return fetchByIds('plans', 'Sales_Order', orderIds).then(function (planRes) {
            if (planRes.error) notes.push(planRes.error);
            var plans = planRes.rows || [];
            var planIds = [];
            var planById = {};

            plans.forEach(function (p) {
                var soId = idOf(p.Sales_Order);
                var o = byId[soId];
                planIds.push(str(p.ID));
                planById[str(p.ID)] = { soId: soId, planNo: str(p.Plan_No) };
                if (!o) return;
                // One order produces exactly one plan (createProductionPlans
                // inserts inside its per-order loop), so the first is the one.
                if (!o.planId) {
                    o.planId = str(p.ID);
                    o.planNo = str(p.Plan_No);
                    o.planStatus = str(p.Order_Status);
                    o.supervisorId = idOf(p.Assigned_To);
                    o.supervisor = labelOf(p.Assigned_To);
                }
            });

            if (!planIds.length) return null;

            return Promise.all([
                fetchByIds('items', 'Plan', planIds),
                fetchByIds('stages', 'Plan', planIds),
                fetchByIds('checks', 'Plan', planIds)
            ]).then(function (res) {
                var itemRes = res[0], stageRes = res[1], checkRes = res[2];
                [itemRes, stageRes, checkRes].forEach(function (r) {
                    if (r.error) notes.push(r.error);
                });

                // --- checks, and which of them are finished ---
                var checks = checkRes.rows || [];
                var checkIds = checks.map(function (c) { return str(c.ID); });

                return fetchByIds('finish', 'Item_Check', checkIds).then(function (finRes) {
                    if (finRes.error) notes.push(finRes.error);

                    // "This batch is finished" is Finishing_Data with
                    // Finishing_Status == "Done" — the single test five
                    // functions share (CLAUDE.md). DONE MEANS DONE; anything
                    // else means the job is still open, which is the safe way
                    // for a missing value to be wrong.
                    var doneChecks = {};
                    (finRes.rows || []).forEach(function (fd) {
                        if (str(fd.Finishing_Status).trim() === 'Done') {
                            doneChecks[idOf(fd.Item_Check)] = true;
                        }
                    });

                    var checkedItems = {}, finishedItems = {}, altByItem = {};
                    checks.forEach(function (c) {
                        var pi = idOf(c.Plan_Item);
                        if (!pi) return;
                        checkedItems[pi] = true;
                        if (num(c.Qty_Approved) > 0 && doneChecks[str(c.ID)]) {
                            finishedItems[pi] = true;
                        }
                        if (num(c.Qty_Alteration) > 0) {
                            altByItem[pi] = num(c.Qty_Alteration);
                        }
                    });

                    // --- stage logs, newest activity per plan AND per item ---
                    // Deluge sorted Stage_Log by Sequence_No DESC and kept the
                    // FIRST in-progress / done phase seen per item — i.e. the
                    // furthest-along one. Here rows arrive unordered, so the
                    // highest Sequence_No wins.
                    var stageByPlan = {};
                    (stageRes.rows || []).forEach(function (lg) {
                        var pid = idOf(lg.Plan);
                        if (!stageByPlan[pid]) {
                            stageByPlan[pid] = { open: [], done: [], last: null, byItem: {} };
                        }
                        var b = stageByPlan[pid];
                        var st = str(lg.Stage_Status).trim();
                        var row = {
                            phase: str(lg.Phase_Name),
                            seq: num(lg.Sequence_No),
                            status: st,
                            qtyIn: num(lg.Qty_In),
                            qtyOut: num(lg.Qty_Out),
                            itemId: idOf(lg.Plan_Item),
                            on: str(lg.Log_Date || lg.Modified_Time || lg.Added_Time)
                        };
                        if (st === 'In_Progress') b.open.push(row);
                        else if (st === 'Done') b.done.push(row);

                        // Per-item furthest-along phase, open and done tracked
                        // separately (an item can have a done Cutting and an open
                        // Stitching at once — the open one wins for "current").
                        if (row.itemId) {
                            var bi = b.byItem[row.itemId] || (b.byItem[row.itemId] = { open: null, done: null });
                            if (st === 'In_Progress' && (!bi.open || row.seq > bi.open.seq)) bi.open = row;
                            else if (st === 'Done' && (!bi.done || row.seq > bi.done.seq)) bi.done = row;
                        }

                        // The most recent evidence that ANYTHING moved on this
                        // plan — what "stuck for N days" is measured from.
                        var d = parseDate(row.on);
                        if (d && (!b.last || d.getTime() > b.last.getTime())) b.last = d;
                    });

                    // --- items ---
                    var itemsByPlan = {};
                    (itemRes.rows || []).forEach(function (it) {
                        var pid = idOf(it.Plan);
                        if (!itemsByPlan[pid]) itemsByPlan[pid] = [];
                        itemsByPlan[pid].push(it);
                    });

                    // --- fold into the orders ---
                    //
                    // ONE PRODUCT NAME CAN BE AT SEVERAL STAGES AT ONCE. The
                    // order line's own pieces might be through checking while its
                    // check-remake batch is back at Stitching and its production-
                    // loss batch is at Cutting. A single row with one stage pill
                    // cannot say that. So `o.items[]` is one PARENT per name, and
                    // each parent carries `flows[]` — one entry per Plan_Item
                    // (original / check_remake / production_loss / alteration),
                    // each with its OWN stage. The drawer renders the parent as a
                    // summary and the flows as child rows.
                    var FLOW_TYPE = function (isRemake, reason) {
                        if (!isRemake) return 'original';
                        if (reason === 'Alteration') return 'alteration';
                        if (reason === 'Production_Loss') return 'production_loss';
                        return 'check_remake'; // Check_Reject, and any older value
                    };
                    var FLOW_ORDER = { original: 0, check_remake: 1, production_loss: 2, alteration: 3 };

                    orders.forEach(function (o) {
                        if (!o.planId) return;
                        var items = itemsByPlan[o.planId] || [];
                        var sb = stageByPlan[o.planId] || { open: [], done: [], last: null, byItem: {} };
                        var ordSt = o.status;
                        var ordFinDone = (ordSt === 'Finishing Complete' || ordSt === 'Packed' || ordSt === 'Dispatched');

                        o.itemCount = items.length;

                        // One flow per Plan_Item row, with its own stage.
                        var flows = items.map(function (it) {
                            var iid = str(it.ID);
                            var isRemake = it.Is_Remake === true || str(it.Is_Remake) === 'true';
                            var reason = str(it.Remake_Reason).trim();
                            var flowType = FLOW_TYPE(isRemake, reason);
                            var status = str(it.Item_Status).trim();
                            var name = str(it.Item_Name) || ('Item #' + iid);
                            var qOrd = num(it.Qty_Ordered);
                            var qProd = num(it.Qty_Produced);
                            var qAcc = num(it.Qty_Accepted);
                            var qRej = num(it.Qty_Rejected);
                            var qAlt = altByItem[iid] || 0;

                            // Order-level totals: original lines only — a batch
                            // remakes pieces the original line already counts.
                            if (flowType === 'original') {
                                o.orderedQty += qOrd;
                                o.producedQty += qProd;
                                if (qRej > 0 && checkedItems[iid]) o.rejectedQty += qRej;
                            }
                            if (isRemake) o.remakeItems++;
                            if (flowType === 'production_loss') o.lossFlows = (o.lossFlows || 0) + 1;
                            if (status === 'Complete') o.completedItems++;
                            if (status === 'Awaiting_Material') o.blocked++;

                            var finDone = ordFinDone || !!finishedItems[iid];

                            // This flow's furthest-along stage, from the per-item
                            // stage map (open wins over done), then derived.
                            var bi = sb.byItem[iid] || { open: null, done: null };
                            var stage = '', stageStatus = '';
                            if (bi.open) { stage = bi.open.phase; stageStatus = 'Running'; }
                            else if (bi.done) { stage = bi.done.phase; stageStatus = 'Done'; }

                            if (stage === '') {
                                if (finDone) { stage = 'Finishing'; stageStatus = 'Done'; }
                                else if (status === 'Complete') { stage = 'Checking'; stageStatus = 'Passed'; }
                                else if (status === 'Awaiting_Check') { stage = 'Checking'; stageStatus = 'Queued'; }
                                else if (status === 'Awaiting_Material') { stage = ''; stageStatus = 'Awaiting material'; }
                            }

                            return {
                                id: iid, name: name, sku: labelOf(it.Item_Sku),
                                flowType: flowType,
                                lineNo: num(it.Line_No),
                                status: status,
                                qtyOrdered: qOrd, qtyProduced: qProd,
                                qtyAccepted: qAcc, qtyRejected: qRej, qtyAltered: qAlt,
                                stage: stage, stageStatus: stageStatus,
                                finishingComplete: finDone,
                                checked: !!checkedItems[iid],
                                // A batch with no material raised yet still sits
                                // at Awaiting_Material — the store has not been
                                // asked. Worth flagging on a production-loss row.
                                awaitingMaterial: status === 'Awaiting_Material'
                            };
                        });

                        // Group flows by product name -> one parent per name.
                        var groupMap = {}, groupOrder = [];
                        flows.forEach(function (f) {
                            var g = groupMap[f.name];
                            if (!g) {
                                g = { name: f.name, itemName: f.name, sku: f.sku, lineNo: f.lineNo,
                                      qtyOrdered: 0, qtyProduced: 0, qtyAccepted: 0,
                                      qtyRejected: 0, qtyAltered: 0,
                                      hasRemake: false, hasLoss: false, hasAlteration: false,
                                      flows: [] };
                                groupMap[f.name] = g;
                                groupOrder.push(f.name);
                            }
                            // The parent's headline numbers come from the
                            // ORIGINAL line; the batches add their own quantities.
                            if (f.flowType === 'original') {
                                g.qtyOrdered = f.qtyOrdered;
                                g.qtyProduced = f.qtyProduced;
                                g.qtyAccepted = f.qtyAccepted;
                                g.qtyRejected = f.qtyRejected;
                                if (f.sku) g.sku = f.sku;
                                if (g.lineNo === 0 || f.lineNo < g.lineNo) g.lineNo = f.lineNo;
                            } else if (f.flowType === 'alteration') {
                                g.hasAlteration = true;
                                g.qtyAltered += f.qtyOrdered;
                            } else if (f.flowType === 'production_loss') {
                                g.hasLoss = true;
                            } else {
                                g.hasRemake = true;
                            }
                            g.flows.push(f);
                        });

                        o.items = groupOrder.map(function (nm) {
                            var g = groupMap[nm];
                            g.flows.sort(function (a, b) {
                                var d = (FLOW_ORDER[a.flowType] || 0) - (FLOW_ORDER[b.flowType] || 0);
                                return d !== 0 ? d : a.lineNo - b.lineNo;
                            });
                            return g;
                        }).sort(function (a, b) { return a.lineNo - b.lineNo; });

                        // Item count = ORDER LINES (parent groups), which is how
                        // the admin counts them — not raw Plan_Item rows.
                        o.itemCount = o.items.length;

                        // Order-level current stage: furthest-along open, else done.
                        var open = sb.open.slice().sort(function (a, b) { return b.seq - a.seq; });
                        var done = sb.done.slice().sort(function (a, b) { return b.seq - a.seq; });
                        if (open.length) {
                            o.currentStage = open[0].phase;
                            o.currentStageStatus = 'In_Progress';
                        } else if (done.length) {
                            o.currentStage = done[0].phase;
                            o.currentStageStatus = 'Done';
                        }
                        if (done.length) o.lastCompletedStage = done[0].phase;
                        o.stages = open.concat(done);

                        // HOW LONG SINCE ANYTHING HAPPENED — the stuck signal.
                        if (sb.last) {
                            o.lastMovement = sb.last;
                            o.daysSinceMovement = Math.round(
                                (midnight(new Date()).getTime() - midnight(sb.last).getTime()) / 86400000);
                        }
                    });

                    return null;
                });
            });
        });
    }

    /* ----------------------------------------------------------------------
     * risk(order) — why this order might need attention, worst first.
     *
     * Deliberately NOT a score. A number would need a weighting nobody could
     * defend ("is three days late worse than two blocked items?"), and it would
     * hide the reason behind an answer. These are named states; the row shows
     * the worst one and the admin reads the word, not a rank.
     * -------------------------------------------------------------------- */
    function risk(order) {
        var out = [];
        var d = order.daysToDue;

        if (order.status === 'Dispatched' || order.status === 'Packed') {
            // Nothing is chased once it has shipped or is boxed and waiting.
            return out;
        }

        // Only OVERDUE is flagged, not "due soon". A due-soon chip fires on
        // every healthy order in its last few days and trains the admin to
        // ignore the bar — overdue is the state that actually needs a decision.
        if (d !== null && d < 0) {
            out.push({ level: 'late', label: Math.abs(d) + ' day' + (Math.abs(d) === 1 ? '' : 's') + ' overdue',
                       why: 'past its expected delivery date and not yet packed' });
        }

        if (order.blocked > 0) {
            out.push({ level: 'blocked',
                       label: order.blocked + ' item' + (order.blocked === 1 ? '' : 's') + ' awaiting material',
                       why: 'the store has not issued what these items need, so no work can start on them' });
        }

        // Stuck: nothing has moved for a fortnight on an order that is not
        // finished. Two weeks rather than a few days — a plan legitimately sits
        // while cloth is washed or a vendor holds panels, and crying wolf on
        // those would make the flag worth ignoring.
        if (order.daysSinceMovement !== null && order.daysSinceMovement >= 14 &&
            order.status !== 'Finishing Complete') {
            out.push({ level: 'stuck',
                       label: 'no movement for ' + order.daysSinceMovement + ' days',
                       why: 'no stage has started or finished on this order in that time' });
        }

        if (order.shortClosed) {
            out.push({ level: 'short', label: 'short closed',
                       why: order.shortCloseReason || 'shipping short was recorded deliberately' });
        }

        return out;
    }

    function worstRisk(order) {
        var rs = risk(order);
        if (!rs.length) return null;
        var rank = { late: 0, blocked: 1, stuck: 2, short: 3 };
        var best = rs[0];
        rs.forEach(function (r) {
            if (rank[r.level] < rank[best.level]) best = r;
        });
        return best;
    }

    return {
        counts: counts,
        page: page,
        risk: risk,
        worstRisk: worstRisk,
        parseDate: parseDate,
        daysFromToday: daysFromToday,
        sortOrders: sortOrders,
        FLOW: FLOW,
        IN_PRODUCTION: IN_PRODUCTION,
        RPT: RPT,
        CANDIDATES: CANDIDATES
    };
})();
