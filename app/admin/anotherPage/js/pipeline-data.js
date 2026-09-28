/* ==========================================================================
 * SALES ORDER PIPELINE — the data layer, over the JS Data API.
 *
 * REPLACES `getSalesOrderProgress` (deluge/anotherPageScripts/, 630 lines),
 * whose per-plan Stage_Log / Item_Check / Plan_Item walks inside a per-order
 * loop could hit Creator's uncatchable statement limit on one large order.
 * The JS Data API has no statement limit. This is a PURE READ.
 *
 * TWO DEPTHS, AND THAT IS WHAT MAKES IT SCALE.
 *
 * The list needs every order of the bucket — "needs attention" and the tile
 * badges must count all of them, not the 25 on screen — but it does NOT need
 * every record behind every order. At this org's real volume (111 open orders
 * on one supervisor, Faire orders of ~110 items and ~8 stages) the whole trail
 * is ~12,000 Plan_Items and up to ~100,000 Stage_Log rows. Downloading that to
 * draw one bar per row is a minute of "Loading…" and a very large response held
 * in the browser, on every Refresh.
 *
 *   LIST (page)      Sales_Order, plans, Plan_Item, Item_Check, the OPEN
 *                    Stage_Log rows only, Finishing_Data (see fetchFinishing),
 *                    and the requests behind batches waiting for material.
 *   ONE ORDER        the plan's FULL Stage_Log, its Finishing_Data by check,
 *   (detail)         and Item_Master for size / colour — fetched when the admin
 *                    opens that order, one plan's worth, and kept.
 *
 * Closed stage logs are only needed for two things on the list, and both have
 * a cheaper, exact source:
 *   - WHAT WAS LOST. coverProductionLoss keeps the Production_Loss batches
 *     equal to what the family's stage logs lost — it is idempotent and that is
 *     its whole design — so the batches' targets ARE the loss. spreadLoss()
 *     takes it off the open flows. The order's bar is exact; only which of two
 *     concurrently-open flows of one line carried a loss can differ, and the
 *     expand, which has the logs, shows that exactly.
 *   - WHEN IT LAST MOVED. Closing a stage writes the Plan_Item (Item_Status,
 *     Qty_Produced), so Plan_Item.Modified_Time moves with it.
 *
 * Packed and Dispatched draw no piece bar at all, so they fetch only plans and
 * items (for ordered / produced), and only for orders that reached that status
 * in the last 30 days unless asked for older. Nothing writes Dispatched yet, so
 * without the window Packed would grow with every order the company ever ships.
 *
 * Every id list is chunked at 25 (the store screen's PLAN_CHUNK) and every
 * getRecords goes through app/js/data-throttle.js: at most 4 in flight, 2955
 * retried. A rate-limit or timeout that outlasts the retries is reported for
 * THIS load only — it never marks a report as missing for the session.
 * ========================================================================== */

var PipelineData = (function () {
    'use strict';

    // Candidates per form, best guess first. This org's report link names are
    // NOT consistent (Item_Check turned out to be `All_Items`), so a name that
    // looks obvious is a guess. The first of each is already proven live.
    var CANDIDATES = {
        orders:     ['Sales_Order_Report', 'All_Sales_Orders', 'Sales_Order'],
        plans:      ['Production_Planning_Report', 'All_Production_Plans'],
        items:      ['Plan_Item_Report', 'All_Plan_Items'],
        stages:     ['Stage_Log_Report', 'All_Stage_Logs', 'Stage_Log'],
        checks:     ['All_Items', 'Item_Check_Report', 'Item_Check'],
        finish:     ['Finishing_Data_Report', 'All_Finishing_Data', 'Finishing_Data'],
        emps:       ['Employee_Report', 'All_Employees'],
        reqs:       ['Material_Requirement_Report', 'All_Material_Requirements'],
        itemMaster: ['Item_Master_Report', 'All_Item_Master', 'All_Item_Masters']

        // NO CUSTOMER REPORT. The customer name comes off the Sales_Order
        // lookup's own display_value, so it needs no second fetch and no guess
        // about which Customer_Master field holds the name.
    };

    var RPT = {};          // resolved names, cached for the session
    var UNRESOLVED = {};   // forms that failed every candidate — for real
    var CHUNK = 25;

    // Sales_Order.Order_Status, in the order the workflow runs (CLAUDE.md).
    var FLOW = ['Pending', 'In Progress', 'Production Complete', 'Checking Passed',
                'Finishing Complete', 'Packed', 'Dispatched'];

    // "In the factory": everything between planning and packing.
    var IN_PRODUCTION = ['In Progress', 'Production Complete', 'Checking Passed',
                         'Finishing Complete'];

    // At risk: due within this many days with pieces nobody has started.
    var AT_RISK_DAYS = 7;
    // Idle: nothing recorded for this long. Two weeks, not a few days — cloth
    // at the wash or panels with a vendor legitimately sit.
    var IDLE_DAYS = 14;

    function have() {
        return typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
            typeof ZOHO.CREATOR.DATA.getRecords === 'function';
    }

    function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
    function str(v) { return v == null ? '' : String(v); }
    function isTrue(v) { return v === true || str(v) === 'true'; }

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
    // Parsed by parts: `new Date('2026-09-12')` is read as UTC and lands a day
    // early west of Greenwich.
    var MONS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    function parseDate(v) {
        if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
        var s = str(v).trim();
        if (!s) return null;

        // dd-MMM-yyyy (Creator's usual display form)
        var m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
        if (m) {
            var mi = MONS.indexOf(m[2].toLowerCase());
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

    // Whole days from today. Negative = in the past.
    function daysFromToday(v) {
        var d = parseDate(v);
        if (!d) return null;
        var ms = midnight(d).getTime() - midnight(new Date()).getTime();
        return Math.round(ms / 86400000);
    }

    // A date as a criteria literal, "05-Sep-2026 00:00:00".
    function critDate(d) {
        var m = MONS[d.getMonth()];
        return (d.getDate() < 10 ? '0' : '') + d.getDate() + '-' + m.charAt(0).toUpperCase() + m.slice(1) +
            '-' + d.getFullYear() + ' 00:00:00';
    }

    // ---- fetching --------------------------------------------------------

    // A rate limit that outlasted data-throttle.js's retries, or a call it
    // timed out. Neither says anything about whether the report exists.
    function isTransient(err) {
        if (!err) return false;
        var s = '';
        try { s = JSON.stringify(err); } catch (e) { s = String(err); }
        s += ' ' + (err.message || '') + ' ' + (err.description || '');
        if (String(err.code) === '2955') return true;
        var status = err.status || err.statusCode || (err.response && err.response.status);
        if (String(status) === '429') return true;
        return /2955|limit for a minute|maximum number of api calls|timed out/i.test(s);
    }

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

    // One report, every page. `probe` reads a single small page with no
    // criteria — only to learn whether the report exists.
    function getAll(reportName, criteria, probe) {
        return new Promise(function (resolve) {
            if (!have()) { resolve({ rows: [], exists: false, error: 'JS Data API unavailable' }); return; }
            var rows = [];

            function page(cursor) {
                var cfg = { report_name: reportName, field_config: 'all', max_records: probe ? 200 : 1000 };
                if (criteria) cfg.criteria = criteria;
                if (cursor) cfg.record_cursor = cursor;

                ZOHO.CREATOR.DATA.getRecords(cfg).then(function (resp) {
                    var data = (resp && (resp.data || resp.records)) || [];
                    for (var i = 0; i < data.length; i++) rows.push(data[i]);
                    var next = resp && (resp.record_cursor || resp.cursor);
                    if (next && data.length > 0 && !probe) page(next);
                    else resolve({ rows: rows, exists: true });
                }).catch(function (err) {
                    // A 9280 means the report EXISTS and matched nothing.
                    if (isNoRecords(err)) { resolve({ rows: rows, exists: true }); return; }
                    resolve({ rows: [], exists: false, transient: isTransient(err),
                        error: reportName + ': ' + (err && err.message ? err.message : 'could not be read') });
                });
            }
            page(null);
        });
    }

    // A form by key, finding its report name on first use.
    //
    // A failed query is only taken to mean "wrong report name" once a bare
    // probe of that name ALSO fails. Otherwise a rejected criteria, or a rate
    // limit on a busy morning, walked on to the next candidate and cached the
    // form as missing for the rest of the session — every later Refresh then
    // skipped it and its pieces read "not accounted for".
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
                if (res.exists) { found(name, i); return res; }
                if (res.transient) return res;
                if (!criteria) return attempt(i + 1);
                return getAll(name, null, true).then(function (p) {
                    if (p.exists) { found(name, i); return res; }   // it is there; the query failed
                    if (p.transient) return res;
                    return attempt(i + 1);
                });
            });
        }
        function found(name, i) {
            RPT[key] = name;
            if (i > 0) console.log('[pipeline] ' + key + ' resolved to "' + name + '"');
        }
        return attempt(0);
    }

    // (a == 1 || a == 2 || ...) for a set of ids.
    function idCriteria(field, ids) {
        if (!ids.length) return null;
        return '(' + ids.map(function (i) { return field + ' == ' + i; }).join(' || ') + ')';
    }

    function uniq(ids) {
        var out = [], seen = {};
        ids.forEach(function (i) {
            var s = str(i);
            if (s && !seen[s]) { seen[s] = true; out.push(s); }
        });
        return out;
    }

    // Chunked id-list fetch. `extra` is ANDed on after the id list.
    function fetchByIds(key, field, ids, extra) {
        var u = uniq(ids);
        if (!u.length) return Promise.resolve({ rows: [], exists: true });

        var chunks = [];
        for (var i = 0; i < u.length; i += CHUNK) chunks.push(u.slice(i, i + CHUNK));

        return Promise.all(chunks.map(function (c) {
            var crit = idCriteria(field, c);
            return fetch(key, extra ? crit + ' && (' + extra + ')' : crit);
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

    // FINISHING ON THE LIST. Finishing_Data carries no Plan, only Item_Check
    // and Plan_Item, so the only exact key is the check id — at volume
    // thousands of ids, hundreds of calls. Instead: every job still open, plus
    // every job added since the oldest plan on screen started (a finishing job
    // cannot predate its plan). One walk, filtered in memory by check id.
    //
    // Whether this org's getRecords accepts a date-time criteria has not been
    // proven live, so a refusal falls back to the exact id chunks — slower,
    // never wrong. A handful of checks goes straight to the ids.
    function fetchFinishing(checkIds, since) {
        if (checkIds.length <= CHUNK || !since) return fetchByIds('finish', 'Item_Check', checkIds);
        var crit = '(Finishing_Status != "Done" || Added_Time >= "' + critDate(since) + '")';
        return fetch('finish', crit).then(function (res) {
            if (!res.error) return res;
            console.warn('[pipeline] finishing by date refused (' + res.error + ') — reading by check id');
            return fetchByIds('finish', 'Item_Check', checkIds);
        });
    }

    /* ----------------------------------------------------------------------
     * page(opts) -> { orders, total, older, notes }
     *
     * opts.status  'In Production' (the factory), 'Packed', 'Dispatched', a
     *              single Order_Status, or '' for everything live.
     * opts.windowDays  Packed / Dispatched only: just the orders that reached
     *              the status in that many days (Sales_Order.Modified_Time — the
     *              status write is the record's last edit). 0 = all.
     *
     * Returns the WHOLE bucket; the view pages it for display. `older` is how
     * many were left out by the window.
     * -------------------------------------------------------------------- */
    function page(opts) {
        opts = opts || {};
        var wanted = str(opts.status).trim();
        var notes = [];

        var statuses;
        if (wanted === 'In Production') statuses = IN_PRODUCTION.slice();
        else if (wanted === '' || wanted === 'All') statuses = FLOW.slice();
        else statuses = [wanted];
        var shipping = wanted === 'Packed' || wanted === 'Dispatched';

        var crit = '(' + statuses.map(function (s) {
            return 'Order_Status == "' + s + '"';
        }).join(' || ') + ')';

        return fetch('orders', crit).then(function (soRes) {
            if (soRes.error) notes.push(soRes.error);
            var all = (soRes.rows || []).map(orderOf);
            var total = all.length;

            var orders = all, older = 0;
            if (shipping && opts.windowDays > 0) {
                orders = all.filter(function (o) {
                    return o.daysInStatus === null || o.daysInStatus <= opts.windowDays;
                });
                older = total - orders.length;
            }
            if (!orders.length) return { orders: [], total: total, older: older, notes: notes };

            return enrich(orders, notes, shipping).then(function () {
                return { orders: sortOrders(orders, 'urgency'), total: total, older: older, notes: notes };
            });
        });
    }

    function orderOf(so) {
        var due = so.Expected_Delivery_Date;
        var since = parseDate(so.Modified_Time);
        return {
            id: str(so.ID),
            salesOrder: str(so.Sales_Order),
            status: str(so.Order_Status).trim(),
            orderDate: str(so.Sales_Order_Date || so.Added_Time),
            dueDate: str(due),
            daysToDue: daysFromToday(due),
            daysInStatus: since ? -daysFromToday(since) : null,
            customerId: idOf(so.Customer),
            customerName: labelOf(so.Customer),
            // The Dispatched table (left as it was) reads `customer`.
            customer: labelOf(so.Customer),
            source: str(so.Order_Source),
            shortClosed: isTrue(so.Short_Closed),
            shortCloseReason: str(so.Short_Close_Reason || ''),
            // filled by the joins below
            planId: '', planNo: '', supervisor: '', supervisorId: '',
            orderedQty: 0, producedQty: 0, finishedQty: 0, pct: 0,
            itemCount: 0, completedItems: 0, remakeItems: 0,
            currentStage: '', lastMovement: null, daysSinceMovement: null,
            items: [], blocked: 0, pos: emptyPos(), placed: 0, unplaced: 0, shortPieces: 0,
            exact: false
        };
    }

    // How an order is ranked. 'urgency' is the default because the question
    // an admin arrives with is "what needs me", not "what is newest".
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

    // ---- where every piece is -------------------------------------------
    //
    // Every piece of every Plan_Item is placed from the record that says where
    // it is — nothing is guessed from a stage name.
    //
    //   Plan_Item.Item_Status       Awaiting_Material / Ready / In_Production …
    //   Stage_Log (per item)        which stage is open (and, in the expand,
    //                               what each closed stage lost)
    //   Item_Check (per item)       inspected, approved, rejected, altered
    //   Finishing_Data (per check)  In_Progress or Done — DONE MEANS DONE
    //   Material_Requirement        whether a batch's cloth was ever asked for
    //
    // A FLOW is one Plan_Item: the order line itself, or a batch hanging off it
    // (checker rejected -> remade, lost in production -> remade, alteration).
    // A LINE is the order line plus its batches, joined by Remake_Of — which
    // coverProductionLoss and saveItemCheck always point at the ROOT. It used
    // to be joined by Item_Name, which merged a King/White and a Queen/Grey of
    // the same product into one row with one SKU and the two quantities summed.
    //
    // Pieces a check REJECTED, a stage LOST or a check sent to ALTERATION leave
    // their flow and reappear as the target of the batch that replaces them, so
    // across a line the places add back to what was ordered. What does not on a
    // short-closed order is what was deliberately not made.

    var FLOW_TYPE = function (isRemake, reason) {
        if (!isRemake) return 'original';
        if (reason === 'Alteration') return 'alteration';
        if (reason === 'Production_Loss') return 'production_loss';
        return 'check_remake'; // Check_Reject, and any older value
    };
    var FLOW_ORDER = { original: 0, check_remake: 1, production_loss: 2, alteration: 3 };

    // The seven places, in the order a piece moves through them.
    var PLACES = ['waitingMaterial', 'readyToStart', 'inProduction', 'awaitingCheck',
                  'waitingFinishing', 'inFinishing', 'finished'];

    function emptyPos() {
        return {
            waitingMaterial: 0, waitingStore: 0, waitingRequest: 0,
            readyToStart: 0, inProduction: 0, stages: {}, stageOrder: [],
            awaitingCheck: 0, waitingFinishing: 0, inFinishing: 0, finished: 0,
            cancelled: 0, lost: 0, rejected: 0, altered: 0,
            rework: { check_remake: 0, production_loss: 0, alteration: 0 }
        };
    }

    function addStage(pos, phase, seq, qty) {
        if (!qty) return;
        if (!pos.stages[phase]) {
            pos.stages[phase] = { qty: 0, seq: seq };
            pos.stageOrder.push(phase);
        }
        pos.stages[phase].qty += qty;
        if (seq < pos.stages[phase].seq) pos.stages[phase].seq = seq;
        pos.stageOrder.sort(function (a, b) { return pos.stages[a].seq - pos.stages[b].seq; });
    }

    function takeFromStages(pos, qty) {
        pos.stageOrder.slice().forEach(function (ph) {
            if (qty <= 0) return;
            var t = Math.min(qty, pos.stages[ph].qty);
            pos.stages[ph].qty -= t;
            qty -= t;
            if (!pos.stages[ph].qty) {
                delete pos.stages[ph];
                pos.stageOrder = pos.stageOrder.filter(function (p) { return p !== ph; });
            }
        });
    }

    function addPos(into, p) {
        ['waitingMaterial', 'waitingStore', 'waitingRequest', 'readyToStart', 'inProduction',
         'awaitingCheck', 'waitingFinishing', 'inFinishing', 'finished',
         'cancelled', 'lost', 'rejected', 'altered'].forEach(function (k) { into[k] += p[k]; });
        p.stageOrder.forEach(function (ph) { addStage(into, ph, p.stages[ph].seq, p.stages[ph].qty); });
        Object.keys(p.rework).forEach(function (k) { into.rework[k] += p.rework[k]; });
    }

    function placedTotal(pos) {
        return PLACES.reduce(function (a, k) { return a + pos[k]; }, 0);
    }

    // One flow's pieces, placed. `ctx` carries the joined per-item records;
    // on the list ctx.stagesByItem holds the OPEN logs only.
    function flowPieces(it, flowType, ctx) {
        var iid = str(it.ID);
        var pos = emptyPos();
        var target = num(it.Qty_Ordered);
        var produced = num(it.Qty_Produced);
        var status = str(it.Item_Status).trim();

        // ---- checking and finishing ----
        var inspected = 0;
        (ctx.checksByItem[iid] || []).forEach(function (c) {
            var a = num(c.Qty_Approved), r = num(c.Qty_Rejected), t = num(c.Qty_Alteration);
            var insp = num(c.Qty_Inspected);
            inspected += insp > 0 ? insp : (a + r + t);
            pos.rejected += r;
            pos.altered += t;
            var fin = ctx.finishByCheck[str(c.ID)];
            if (fin === 'Done') pos.finished += a;
            else if (fin) pos.inFinishing += a;        // a job exists and is not Done
            else pos.waitingFinishing += a;
        });
        pos.awaitingCheck = Math.max(0, produced - inspected);

        // ---- production ----
        var logs = (ctx.stagesByItem[iid] || []).slice().sort(function (a, b) { return a.seq - b.seq; });
        var open = null, lastDone = null;
        logs.forEach(function (lg) {
            if (lg.status === 'Done') {
                pos.lost += Math.max(0, lg.qtyIn - lg.qtyOut);
                if (!lastDone || lg.seq > lastDone.seq) lastDone = lg;
            } else if (lg.status === 'In_Progress') {
                if (!open || lg.seq > open.seq) open = lg;
            }
        });
        var remaining = Math.max(0, target - produced - pos.lost);

        if (status === 'Complete' && produced === 0 && !logs.length && inspected === 0) {
            // A batch shortCloseOrder cancelled before anyone started it.
            pos.cancelled = target;
        } else if (status === 'Awaiting_Material') {
            pos.waitingMaterial = remaining;
            if (flowType !== 'original' && !ctx.requested[iid]) pos.waitingRequest = remaining;
            else pos.waitingStore = remaining;
        } else if (remaining > 0 && (status === 'Complete' || status === 'Awaiting_Check')) {
            // Production is over for this flow, so whatever it did not produce
            // left the flow short. That is a loss (the Production_Loss batch
            // covers it) — exact on the list too, where the closed logs that
            // show it stage by stage are not loaded.
            pos.lost += remaining;
        } else if (remaining > 0) {
            // In_Production with no OPEN log is between two stages — on the
            // list the closed ones are not loaded, so status decides, not logs.
            if (!logs.length && status !== 'In_Production') {
                pos.readyToStart = remaining;
            } else {
                pos.inProduction = remaining;
                if (open) addStage(pos, open.phase, open.seq, remaining);
                else addStage(pos, 'Between stages', (lastDone ? lastDone.seq : 0) + 0.5, remaining);
            }
        }
        return { pos: pos, open: open, lastDone: lastDone, target: target };
    }

    // THE LIST'S LOSS, without the closed stage logs. A line's loss is its
    // Production_Loss batches' targets (coverProductionLoss sets coverage TO the
    // derived loss). Flows whose production is over already counted their
    // shortfall as lost; the rest of the loss is still inside a flow that is
    // being worked, so it comes off that flow's "in production" — the order
    // line first. Alteration batches are outside it, as they are in
    // coverProductionLoss: their survivors are declared, not derived.
    function spreadLoss(flows) {
        var loss = 0, counted = 0;
        flows.forEach(function (f) {
            if (f.flowType === 'production_loss') loss += f.target;
            if (f.flowType !== 'alteration') counted += f.pos.lost;
        });
        var left = Math.max(0, loss - counted);
        flows.forEach(function (f) {
            if (left <= 0 || f.flowType === 'alteration' || f.pos.inProduction <= 0) return;
            var x = Math.min(left, f.pos.inProduction);
            f.pos.inProduction -= x;
            f.pos.lost += x;
            takeFromStages(f.pos, x);
            left -= x;
        });
    }

    // Rework still to come off a batch — what is not yet finished.
    function addRework(f) {
        if (f.flowType === 'original') return;
        var p = f.pos;
        p.rework[f.flowType] += p.waitingMaterial + p.readyToStart + p.inProduction +
            p.awaitingCheck + p.waitingFinishing + p.inFinishing;
    }

    function enrich(orders, notes, shipping) {
        var orderIds = orders.map(function (o) { return o.id; });
        var byId = {};
        orders.forEach(function (o) { byId[o.id] = o; });

        return fetchByIds('plans', 'Sales_Order', orderIds).then(function (planRes) {
            if (planRes.error) notes.push(planRes.error);
            var planIds = [];
            var planAdded = {};
            var oldest = null;

            (planRes.rows || []).forEach(function (p) {
                var o = byId[idOf(p.Sales_Order)];
                if (!o) return;
                // One order produces exactly one plan (createPlanForOneOrder),
                // so the first is the one.
                if (o.planId) return;
                var pid = str(p.ID);
                planIds.push(pid);
                o.planId = pid;
                o.planNo = str(p.Plan_No);
                o.planStatus = str(p.Order_Status);
                o.supervisorId = idOf(p.Assigned_To);
                o.supervisor = labelOf(p.Assigned_To);
                var added = parseDate(p.Added_Time);
                if (added) {
                    planAdded[pid] = added;
                    if (!oldest || added.getTime() < oldest.getTime()) oldest = added;
                }
            });
            if (!planIds.length) return null;

            // Packed / Dispatched: ordered and produced, nothing else.
            if (shipping) {
                return fetchByIds('items', 'Plan', planIds).then(function (itemRes) {
                    if (itemRes.error) notes.push(itemRes.error);
                    var ctx = { full: false, checksByItem: {}, finishByCheck: {}, stagesByItem: {}, requested: {} };
                    var itemsByPlan = groupBy(itemRes.rows || [], 'Plan');
                    orders.forEach(function (o) { foldOrder(o, itemsByPlan[o.planId] || [], ctx, null); });
                    return null;
                });
            }

            return Promise.all([
                fetchByIds('items', 'Plan', planIds),
                fetchByIds('stages', 'Plan', planIds, 'Stage_Status == "In_Progress"'),
                fetchByIds('checks', 'Plan', planIds)
            ]).then(function (res) {
                var itemRes = res[0], stageRes = res[1], checkRes = res[2];
                [itemRes, stageRes, checkRes].forEach(function (r) { if (r.error) notes.push(r.error); });
                var items = itemRes.rows || [];
                var checks = checkRes.rows || [];

                // Batches still waiting for material: were they ever asked for?
                // None at all means the wait is the supervisor's (Reissue tab).
                var awaitBatchIds = items.filter(function (it) {
                    return isTrue(it.Is_Remake) && str(it.Item_Status).trim() === 'Awaiting_Material';
                }).map(function (it) { return str(it.ID); });

                return Promise.all([
                    fetchFinishing(checks.map(function (c) { return str(c.ID); }), oldest),
                    fetchByIds('reqs', 'Plan_Item', awaitBatchIds)
                ]).then(function (res2) {
                    var finRes = res2[0], reqRes = res2[1];
                    if (finRes.error) notes.push(finRes.error);
                    if (reqRes.error) notes.push(reqRes.error);

                    var ctx = { full: false, checksByItem: {}, finishByCheck: {}, stagesByItem: {}, requested: {} };
                    var lastByPlan = {};
                    function moved(pid, v) {
                        var d = parseDate(v);
                        if (pid && d && (!lastByPlan[pid] || d.getTime() > lastByPlan[pid].getTime())) lastByPlan[pid] = d;
                    }
                    Object.keys(planAdded).forEach(function (pid) { moved(pid, planAdded[pid]); });

                    var planOfCheck = indexChecks(checks, ctx, moved);
                    indexFinishing(finRes.rows || [], ctx, planOfCheck, moved);
                    (reqRes.rows || []).forEach(function (rq) { ctx.requested[idOf(rq.Plan_Item)] = true; });
                    // The criteria asks for open logs only; filtered again here
                    // because the list's loss arithmetic depends on it.
                    indexStages((stageRes.rows || []).filter(function (lg) {
                        return str(lg.Stage_Status).trim() === 'In_Progress';
                    }), ctx, moved);
                    items.forEach(function (it) { moved(idOf(it.Plan), it.Modified_Time); });

                    var itemsByPlan = groupBy(items, 'Plan');
                    var checksByPlan = groupBy(checks, 'Plan');
                    orders.forEach(function (o) {
                        var its = itemsByPlan[o.planId] || [];
                        // Kept for the expand, which re-folds this order with
                        // its full stage history.
                        o._src = { items: its, checks: checksByPlan[o.planId] || [],
                                   requested: ctx.requested, last: lastByPlan[o.planId] || null };
                        foldOrder(o, its, ctx, lastByPlan[o.planId]);
                    });
                    return null;
                });
            });
        });
    }

    function groupBy(rows, field) {
        var out = {};
        rows.forEach(function (r) {
            var k = idOf(r[field]);
            (out[k] || (out[k] = [])).push(r);
        });
        return out;
    }

    function indexChecks(checks, ctx, moved) {
        var planOfCheck = {};
        checks.forEach(function (c) {
            var pi = idOf(c.Plan_Item);
            if (pi) (ctx.checksByItem[pi] || (ctx.checksByItem[pi] = [])).push(c);
            planOfCheck[str(c.ID)] = idOf(c.Plan);
            moved(idOf(c.Plan), c.Check_Date || c.Added_Time);
        });
        return planOfCheck;
    }

    // DONE MEANS DONE; any other value is an open job (CLAUDE.md). Rows for
    // checks not on screen (the date-bounded read) are skipped.
    function indexFinishing(rows, ctx, planOfCheck, moved) {
        rows.forEach(function (fd) {
            var cid = idOf(fd.Item_Check);
            if (planOfCheck[cid] === undefined) return;
            var st = str(fd.Finishing_Status).trim();
            // A Done row wins over a stray open one for the same check.
            if (ctx.finishByCheck[cid] !== 'Done') ctx.finishByCheck[cid] = st === 'Done' ? 'Done' : 'Open';
            moved(planOfCheck[cid], fd.Modified_Time || fd.Added_Time);
        });
    }

    function indexStages(rows, ctx, moved) {
        rows.forEach(function (lg) {
            var row = {
                phase: str(lg.Phase_Name) || 'Stage',
                seq: num(lg.Sequence_No),
                status: str(lg.Stage_Status).trim(),
                qtyIn: num(lg.Qty_In),
                qtyOut: num(lg.Qty_Out)
            };
            var iid = idOf(lg.Plan_Item);
            if (iid) (ctx.stagesByItem[iid] || (ctx.stagesByItem[iid] = [])).push(row);
            moved(idOf(lg.Plan), lg.Log_Date || lg.Modified_Time || lg.Added_Time);
        });
    }

    // One order: its lines, each line's flows, and the pieces of all of them.
    function foldOrder(o, items, ctx, last) {
        o.pos = emptyPos();
        o.orderedQty = 0; o.producedQty = 0;
        o.remakeItems = 0; o.completedItems = 0; o.blocked = 0;
        o.items = []; o.itemCount = 0;
        if (!o.planId) return;

        // Batches with no Remake_Of (older records) fall back to the order
        // line of the same name, so they are not orphaned into a line of
        // their own.
        var rootByName = {};
        items.forEach(function (it) {
            var nm = str(it.Item_Name);
            if (!isTrue(it.Is_Remake) && nm && !rootByName[nm]) rootByName[nm] = str(it.ID);
        });

        var groups = {}, order = [];
        items.forEach(function (it) {
            var isRemake = isTrue(it.Is_Remake);
            var flowType = FLOW_TYPE(isRemake, str(it.Remake_Reason).trim());
            var name = str(it.Item_Name) || ('Item #' + str(it.ID));
            var fp = flowPieces(it, flowType, ctx);
            var status = str(it.Item_Status).trim();
            var key = isRemake ? (idOf(it.Remake_Of) || rootByName[str(it.Item_Name)] || str(it.ID)) : str(it.ID);

            var flow = {
                id: str(it.ID), flowType: flowType, status: status,
                lineNo: num(it.Line_No),
                target: fp.target, produced: num(it.Qty_Produced),
                stage: fp.open ? fp.open.phase : '',
                lastStage: fp.lastDone ? fp.lastDone.phase : '',
                pos: fp.pos
            };

            var g = groups[key];
            if (!g) {
                g = { key: key, name: name, sku: '', skuId: '', size: '', color: '', lineNo: flow.lineNo,
                      ordered: 0, produced: 0, flows: [], pos: emptyPos(), hasRoot: false };
                groups[key] = g;
                order.push(key);
            }
            if (flowType === 'original') {
                g.hasRoot = true;
                g.name = name;
                g.lineNo = flow.lineNo;
                g.ordered += flow.target;
                g.produced += flow.produced;
                o.orderedQty += flow.target;
                o.producedQty += flow.produced;
            }
            if (!g.skuId || flowType === 'original') {
                var sid = idOf(it.Item_Sku);
                if (sid) { g.skuId = sid; g.sku = labelOf(it.Item_Sku); }
            }
            if (isRemake) o.remakeItems++;
            if (status === 'Complete') o.completedItems++;
            if (status === 'Awaiting_Material') o.blocked++;
            g.flows.push(flow);
        });

        o.items = order.map(function (k) {
            var g = groups[k];
            g.flows.sort(function (a, b) {
                return (FLOW_ORDER[a.flowType] - FLOW_ORDER[b.flowType]) || (a.lineNo - b.lineNo);
            });
            if (!ctx.full) spreadLoss(g.flows);
            g.flows.forEach(function (f) { addRework(f); addPos(g.pos, f.pos); });

            var info = o.skuInfo && o.skuInfo[g.skuId];
            if (info) {
                if (info.sku) g.sku = info.sku;
                g.size = info.size;
                g.color = info.color;
            }
            // Whatever the line's flows do not account for: cancelled by a
            // short close, or — on an order that was not short-closed — pieces
            // no record places, which is a data problem worth seeing.
            g.unplaced = Math.max(0, g.ordered - placedTotal(g.pos) - g.pos.cancelled);
            addPos(o.pos, g.pos);
            return g;
        }).sort(function (a, b) { return a.lineNo - b.lineNo; });

        o.itemCount = o.items.length;
        o.placed = placedTotal(o.pos);
        o.unplaced = o.items.reduce(function (a, g) { return a + g.unplaced; }, 0);
        o.shortPieces = o.shortClosed ? (o.pos.cancelled + o.unplaced) : 0;

        // Once the order says finishing is complete (or it is packed), every
        // piece it will ship is finished — whatever a stray open finishing row
        // says. The status is the forward-only record of that.
        if (o.status === 'Finishing Complete' || o.status === 'Packed' || o.status === 'Dispatched') {
            o.finishedQty = Math.max(0, o.orderedQty - o.shortPieces);
        } else {
            o.finishedQty = o.pos.finished;
        }
        o.pct = o.orderedQty > 0 ? Math.min(100, Math.round((o.finishedQty / o.orderedQty) * 100)) : 0;

        // The furthest-along open stage, for the row's one-word summary.
        var furthest = null;
        o.items.forEach(function (g) {
            g.flows.forEach(function (f) {
                if (f.stage) {
                    var seq = 0;
                    (ctx.stagesByItem[f.id] || []).forEach(function (lg) { if (lg.phase === f.stage) seq = lg.seq; });
                    if (!furthest || seq > furthest.seq) furthest = { phase: f.stage, seq: seq };
                }
            });
        });
        o.currentStage = furthest ? furthest.phase : '';

        // HOW LONG SINCE ANYTHING HAPPENED — any stage, check, finishing stamp,
        // item write (a receipt, a stage closing) or, failing all of those, the
        // plan being made. The last is what catches an order whose material
        // arrived and nobody has touched since.
        o.lastMovement = null;
        o.daysSinceMovement = null;
        if (last) {
            o.lastMovement = last;
            o.daysSinceMovement = Math.round(
                (midnight(new Date()).getTime() - midnight(last).getTime()) / 86400000);
        }
    }

    /* ----------------------------------------------------------------------
     * detail(order) -> the same order, re-folded from its full records.
     *
     * One plan's Stage_Log (~880 rows on a Faire order — one call), its
     * Finishing_Data by check id, and Item_Master for size and colour. Kept on
     * the order (order.exact), so opening it again costs nothing.
     * -------------------------------------------------------------------- */
    function detail(o) {
        if (!o || !o.planId || !o._src || o.exact) return Promise.resolve(o);
        var src = o._src;
        var notes = [];
        var checkIds = src.checks.map(function (c) { return str(c.ID); });
        var skuIds = src.items.map(function (it) { return idOf(it.Item_Sku); });

        return Promise.all([
            fetch('stages', 'Plan == ' + o.planId),
            fetchByIds('finish', 'Item_Check', checkIds),
            fetchByIds('itemMaster', 'ID', skuIds)
        ]).then(function (res) {
            res.forEach(function (r) { if (r.error) notes.push(r.error); });
            var ctx = { full: true, checksByItem: {}, finishByCheck: {}, stagesByItem: {}, requested: src.requested };
            var last = src.last;
            function moved(pid, v) {
                var d = parseDate(v);
                if (d && (!last || d.getTime() > last.getTime())) last = d;
            }
            var planOfCheck = indexChecks(src.checks, ctx, moved);
            indexFinishing(res[1].rows || [], ctx, planOfCheck, moved);
            indexStages(res[0].rows || [], ctx, moved);

            o.skuInfo = {};
            (res[2].rows || []).forEach(function (im) {
                o.skuInfo[str(im.ID)] = { sku: str(im.SKU), size: labelOf(im.Size), color: labelOf(im.Color) };
            });

            foldOrder(o, src.items, ctx, last);
            // Exact only when every read landed; a failed one is retried the
            // next time the order is opened.
            o.exact = !notes.length;
            o.detailNote = notes.length ? 'Some detail could not be read: ' + notes.join('; ') : '';
            return o;
        });
    }

    /* ----------------------------------------------------------------------
     * pending() -> { orders }, off getRecords.
     *
     * Replaces the getPendingSalesOrders Custom API as the first choice. That
     * function walks every pending order's Item_Table in one execution — 119
     * pending Faire orders is ~13,000 subform rows, the orders x lines shape
     * that hits the statement limit, and a Pending backlog that size is exactly
     * what a stalled batch workflow leaves. Here the subform comes nested in
     * the record (field_config 'all', as Raw_Material_Lot's Lot_Rolls does),
     * and it also brings Expected_Delivery_Date, which the Custom API never
     * sent.
     * -------------------------------------------------------------------- */
    function pending() {
        return fetch('orders', '(Order_Status == "Pending")').then(function (res) {
            if (res.error) throw new Error(res.error);
            return {
                orders: (res.rows || []).map(function (so) {
                    var sub = Array.isArray(so.Item_Table) ? so.Item_Table : null;
                    var names = sub ? uniq(sub.map(function (r) { return labelOf(r.Item_Name).trim(); })) : [];
                    var due = so.Expected_Delivery_Date;
                    return {
                        id: str(so.ID),
                        salesOrder: str(so.Sales_Order),
                        customer: labelOf(so.Customer),
                        orderDate: str(so.Sales_Order_Date || so.Added_Time),
                        dueDate: str(due),
                        daysToDue: daysFromToday(due),
                        source: str(so.Order_Source),
                        itemCount: sub ? sub.length : null,
                        itemsSummary: names.join(', '),
                        rejectReason: str(so.Plan_Reject_Reason).replace(/\s*\r?\n\s*/g, ' | ').trim(),
                        lastOutcome: str(so.Batch_Run_Outcome).trim()
                    };
                })
            };
        });
    }

    /* ----------------------------------------------------------------------
     * risk(order) — why this order might need attention, worst first.
     *
     * Deliberately NOT a score: named states, the row shows the worst one and
     * the admin reads the word, not a rank.
     * -------------------------------------------------------------------- */
    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    function risk(order) {
        var out = [];
        var d = order.daysToDue;
        var st = order.status;

        // Nothing writes Dispatched yet, so every order ever shipped stays
        // Packed — and would be called overdue the day its date passed. Until
        // dispatch exists a packed order is not chased at all.
        if (st === 'Dispatched' || st === 'Packed') return out;

        if (d !== null && d < 0) {
            out.push({ level: 'late', label: plural(Math.abs(d), 'day') + ' overdue',
                       why: 'past its expected delivery date and not yet packed' });
        }

        var pos = order.pos || emptyPos();

        // AT RISK: close to its date with pieces nobody has started. Not "due
        // soon" — that fires on every healthy order in its last week and trains
        // the admin to ignore the bar. This only fires when the week left is
        // plainly not enough.
        var notStarted = pos.waitingMaterial + pos.readyToStart;
        if (d !== null && d >= 0 && d <= AT_RISK_DAYS && notStarted > 0) {
            out.push({ level: 'risk',
                       label: (d === 0 ? 'due today' : 'due in ' + plural(d, 'day')) + ' · ' + notStarted + ' pcs not started',
                       why: 'due within a week, and some pieces have not started production' });
        }

        // WHO the material wait is on. A batch nobody has asked the store for
        // is the supervisor's to raise (Reissue tab), not the store's to issue.
        if (pos.waitingMaterial > 0) {
            var who = pos.waitingRequest > 0 && pos.waitingStore > 0 ? 'store and supervisor'
                : (pos.waitingRequest > 0 ? 'supervisor has not requested it' : 'store has not issued it');
            out.push({ level: 'blocked',
                       label: pos.waitingMaterial + ' pc' + (pos.waitingMaterial === 1 ? '' : 's') + ' waiting for material',
                       why: who });
        }

        if (order.daysSinceMovement !== null && order.daysSinceMovement >= IDLE_DAYS) {
            out.push({ level: 'stuck',
                       label: 'idle ' + order.daysSinceMovement + ' days',
                       why: 'nothing recorded in that time — no stage, check, finishing step or material receipt' });
        }

        if (order.shortClosed) {
            out.push({ level: 'short', label: 'short closed',
                       why: order.shortCloseReason || 'shipping short was recorded deliberately' });
        }
        return out;
    }

    var RISK_RANK = { late: 0, risk: 1, blocked: 2, stuck: 3, short: 4 };
    function worstRisk(order) {
        var rs = risk(order);
        if (!rs.length) return null;
        var best = rs[0];
        rs.forEach(function (r) { if (RISK_RANK[r.level] < RISK_RANK[best.level]) best = r; });
        return best;
    }

    /* ----------------------------------------------------------------------
     * packings() — what went into the boxes, off getPackingHistory: the newest
     * 50 packing records with every box, weight and item. Keyed by sales order
     * NUMBER, which is how that function identifies the order.
     * -------------------------------------------------------------------- */
    function packings() {
        if (typeof ZOHO === 'undefined' || !ZOHO.CREATOR || !ZOHO.CREATOR.DATA) {
            return Promise.resolve({ bySo: {}, error: 'Creator SDK unavailable' });
        }
        return ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'getPackingHistory',
            http_method: 'POST',
            payload: { payloadJson: JSON.stringify({}) }
        }).then(function (response) {
            var result = response && response.result !== undefined ? response.result : response;
            var parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed && parsed.errors && parsed.errors.length) throw new Error(parsed.errors.join(', '));
            var bySo = {};
            ((parsed && parsed.packings) || []).forEach(function (p) {
                var key = str(p.salesOrder).trim();
                // Newest first from the server; keep the newest if an order was
                // somehow packed twice.
                if (key && !bySo[key]) bySo[key] = p;
            });
            return { bySo: bySo, error: '' };
        }).catch(function (err) {
            return { bySo: {}, error: 'getPackingHistory: ' + ((err && err.message) || String(err)) };
        });
    }

    return {
        page: page,
        detail: detail,
        pending: pending,
        packings: packings,
        risk: risk,
        worstRisk: worstRisk,
        parseDate: parseDate,
        daysFromToday: daysFromToday,
        sortOrders: sortOrders,
        FLOW: FLOW,
        IN_PRODUCTION: IN_PRODUCTION,
        PLACES: PLACES,
        CHUNK: CHUNK,
        RPT: RPT,
        CANDIDATES: CANDIDATES
    };
})();
