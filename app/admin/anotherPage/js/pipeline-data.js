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
     * page(opts) -> { orders, total, totalPages, page, notes }
     *
     * opts: { status, page, pageSize, search, sort }
     *
     * `status` is one of the tile buckets ('Pending', 'In Production',
     * 'Packed', 'Dispatched') or a single Order_Status, or '' for everything
     * currently live.
     * -------------------------------------------------------------------- */
    function page(opts) {
        opts = opts || {};
        var wanted = str(opts.status).trim();
        var pageNo = Math.max(1, num(opts.page) || 1);
        var pageSize = num(opts.pageSize) || 25;
        var search = str(opts.search).trim().toLowerCase();
        var sort = str(opts.sort) || 'urgency';
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

            // Free-text filter before paging, so the count matches the list.
            if (search) {
                orders = orders.filter(function (o) {
                    return (o.salesOrder + ' ' + o.customerName + ' ' + o.status)
                        .toLowerCase().indexOf(search) > -1;
                });
            }

            var total = orders.length;
            orders = sortOrders(orders, sort);

            var from = (pageNo - 1) * pageSize;
            var slice = orders.slice(from, from + pageSize);
            var totalPages = Math.max(1, Math.ceil(total / pageSize));

            if (!slice.length) {
                return { orders: [], total: total, totalPages: totalPages,
                         page: pageNo, notes: notes };
            }

            // ---- the joins, one fetch per form for the WHOLE page ----
            return enrich(slice, notes).then(function () {
                // Sorting again: urgency depends on stage movement, which is
                // only known after the joins. Cheap — it is one page of rows.
                var out = sortOrders(slice, sort);
                return { orders: out, total: total, totalPages: totalPages,
                         page: pageNo, notes: notes };
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

                    // --- stage logs, newest activity per plan ---
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
                    orders.forEach(function (o) {
                        if (!o.planId) return;
                        var items = itemsByPlan[o.planId] || [];
                        var sb = stageByPlan[o.planId] || { open: [], done: [], last: null };

                        o.itemCount = items.length;
                        items.forEach(function (it) {
                            var iid = str(it.ID);
                            var ordered = num(it.Qty_Ordered);
                            var produced = num(it.Qty_Produced);
                            var status = str(it.Item_Status).trim();
                            var isRemake = it.Is_Remake === true || str(it.Is_Remake) === 'true';

                            o.orderedQty += ordered;
                            o.producedQty += produced;
                            o.rejectedQty += num(it.Qty_Rejected);
                            if (isRemake) o.remakeItems++;
                            if (status === 'Complete') o.completedItems++;
                            // AWAITING MATERIAL IS THE BLOCKER THAT MATTERS.
                            // An item here cannot be worked on at all — the
                            // store owes it cloth — and it is invisible on a
                            // produced/ordered ratio.
                            if (status === 'Awaiting_Material') o.blocked++;

                            o.items.push({
                                id: iid,
                                name: str(it.Item_Name),
                                sku: labelOf(it.Item_Sku),
                                ordered: ordered,
                                produced: produced,
                                status: status,
                                isRemake: isRemake,
                                remakeReason: str(it.Remake_Reason),
                                checked: !!checkedItems[iid],
                                finished: !!finishedItems[iid],
                                alteration: altByItem[iid] || 0,
                                lineNo: num(it.Line_No)
                            });
                        });

                        // Current stage: the open one furthest along, else the
                        // last one completed. Sorted by Sequence_No the same way
                        // the Deluge did.
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

                        // HOW LONG SINCE ANYTHING HAPPENED. A stuck order looks
                        // identical to a healthy one on a produced/ordered
                        // ratio; this is the only figure that separates them.
                        if (sb.last) {
                            o.lastMovement = sb.last;
                            o.daysSinceMovement = Math.round(
                                (midnight(new Date()).getTime() - midnight(sb.last).getTime()) / 86400000);
                        }

                        o.items.sort(function (a, b) { return a.lineNo - b.lineNo; });
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

        if (d !== null) {
            if (d < 0) {
                out.push({ level: 'late', label: Math.abs(d) + ' day' + (Math.abs(d) === 1 ? '' : 's') + ' overdue',
                           why: 'past its expected delivery date and not yet packed' });
            } else if (d === 0) {
                out.push({ level: 'due', label: 'due today', why: 'expected delivery is today' });
            } else if (d <= 3) {
                out.push({ level: 'due', label: 'due in ' + d + ' day' + (d === 1 ? '' : 's'),
                           why: 'expected delivery is within three days' });
            }
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
        var rank = { late: 0, blocked: 1, stuck: 2, due: 3, short: 4 };
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
