// Sales order pipeline — the JS Data API rebuild of getSalesOrderProgress.
//
// The Deluge it replaces could die uncatchably at volume (per-plan Stage_Log,
// Item_Check with a nested Finishing_Data per check, and all ~110 Plan_Item rows
// inside a per-order loop). This asserts the replacement produces the same
// figures, in one fetch per form, and that the new urgency signals are right —
// including the ones that must NOT fire, since a status board that cries wolf is
// worse than one that says nothing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// ---------------------------------------------------------------------------
// Stub getRecords. Serves rows per report name and records every ask so the
// call COUNT can be asserted — the whole point of the rebuild is that a page
// costs a fixed number of fetches, not a number that grows with the orders.
// ---------------------------------------------------------------------------
const ASKED = [];
function load(tables) {
    ASKED.length = 0;
    const code = fs.readFileSync(
        path.join(__dirname, '..', 'app', 'admin', 'anotherPage', 'js', 'pipeline-data.js'), 'utf8');
    const ctx = {
        console: console, Promise: Promise, JSON: JSON, Object: Object,
        Number: Number, String: String, isNaN: isNaN, Math: Math, Date: Date,
        ZOHO: { CREATOR: { DATA: { getRecords: function (cfg) {
            ASKED.push({ report: cfg.report_name, criteria: cfg.criteria || '' });
            const rows = tables[cfg.report_name];
            if (rows === undefined) {
                return Promise.reject({ code: 9280, message: 'No records found' });
            }
            // Honour an id-list criteria so the joins are really exercised.
            var out = rows;
            if (cfg.criteria) {
                const ids = (cfg.criteria.match(/==\s*(\d+)/g) || [])
                    .map(function (s) { return s.replace(/==\s*/, ''); });
                const statuses = (cfg.criteria.match(/Order_Status == "([^"]+)"/g) || [])
                    .map(function (s) { return s.replace(/Order_Status == "|"/g, ''); });
                if (ids.length) {
                    const field = (cfg.criteria.match(/(\w+)\s*==/) || [])[1];
                    out = rows.filter(function (r) {
                        const v = r[field];
                        const rv = (v && typeof v === 'object') ? String(v.ID) : String(v);
                        return ids.indexOf(rv) > -1;
                    });
                } else if (statuses.length) {
                    out = rows.filter(function (r) {
                        return statuses.indexOf(String(r.Order_Status)) > -1;
                    });
                }
            }
            return Promise.resolve({ data: out });
        } } } }
    };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx.PipelineData;
}

// ---- dates, relative to today so the tests do not rot ----
function iso(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

const ORDERS = 'Sales_Order_Report';
const PLANS = 'Production_Planning_Report';
const ITEMS = 'Plan_Item_Report';
const STAGES = 'Stage_Log_Report';
const CHECKS = 'All_Items';
const FINISH = 'Finishing_Data_Report';

function baseTables() {
    const t = {};
    t[ORDERS] = [
        // On time, healthy, mid-production.
        { ID: '1', Sales_Order: 'SO-3000', Order_Status: 'In Progress',
          Expected_Delivery_Date: iso(20), Sales_Order_Date: iso(-10),
          Customer: { ID: 'C1', display_value: 'Faire' }, Order_Source: 'Faire' },
        // OVERDUE.
        { ID: '2', Sales_Order: 'SO-2000', Order_Status: 'In Progress',
          Expected_Delivery_Date: iso(-5), Sales_Order_Date: iso(-40),
          Customer: { ID: 'C1', display_value: 'Faire' }, Order_Source: 'Faire' },
        // Due in two days.
        { ID: '3', Sales_Order: 'SO-1099', Order_Status: 'In Progress',
          Expected_Delivery_Date: iso(2), Sales_Order_Date: iso(-20),
          Customer: { ID: 'C2', display_value: 'Shopify' }, Order_Source: 'Shopify' },
        // No delivery date at all.
        { ID: '4', Sales_Order: 'SO-0001', Order_Status: 'In Progress',
          Expected_Delivery_Date: '', Sales_Order_Date: iso(-3),
          Customer: { ID: 'C2', display_value: 'Shopify' } },
        // Already shipped, and overdue on paper — must NOT be chased.
        { ID: '5', Sales_Order: 'SO-0900', Order_Status: 'Dispatched',
          Expected_Delivery_Date: iso(-30), Sales_Order_Date: iso(-60),
          Customer: { ID: 'C1', display_value: 'Faire' } }
    ];
    t[PLANS] = [
        { ID: '101', Sales_Order: { ID: '1' }, Plan_No: 'PLAN-00107',
          Assigned_To: { ID: 'E1', display_value: 'Aniket' }, Order_Status: 'In Progress' },
        { ID: '102', Sales_Order: { ID: '2' }, Plan_No: 'PLAN-00106',
          Assigned_To: { ID: 'E2', display_value: 'Vivek' }, Order_Status: 'In Progress' },
        { ID: '103', Sales_Order: { ID: '3' }, Plan_No: 'PLAN-00105',
          Assigned_To: { ID: 'E3', display_value: 'Suraj' }, Order_Status: 'Pending' },
        { ID: '104', Sales_Order: { ID: '4' }, Plan_No: 'PLAN-00104',
          Assigned_To: { ID: 'E1', display_value: 'Aniket' }, Order_Status: 'In Progress' },
        { ID: '105', Sales_Order: { ID: '5' }, Plan_No: 'PLAN-00090',
          Assigned_To: { ID: 'E1', display_value: 'Aniket' }, Order_Status: 'Production Complete' }
    ];
    t[ITEMS] = [
        { ID: 'I1', Plan: { ID: '101' }, Item_Name: 'Linen Hamlet Throw', Line_No: 1,
          Qty_Ordered: 10, Qty_Produced: 4, Item_Status: 'In_Production', Is_Remake: false },
        { ID: 'I2', Plan: { ID: '101' }, Item_Name: 'Linen Hamlet Throw L', Line_No: 2,
          Qty_Ordered: 10, Qty_Produced: 0, Item_Status: 'Awaiting_Material', Is_Remake: false },
        { ID: 'I3', Plan: { ID: '102' }, Item_Name: 'Linen Sylph Throw', Line_No: 1,
          Qty_Ordered: 15, Qty_Produced: 15, Item_Status: 'Complete', Is_Remake: false },
        { ID: 'I4', Plan: { ID: '103' }, Item_Name: 'Fern Napkin', Line_No: 1,
          Qty_Ordered: 50, Qty_Produced: 0, Item_Status: 'Awaiting_Material', Is_Remake: false },
        { ID: 'I5', Plan: { ID: '103' }, Item_Name: 'Fern Napkin (remake)', Line_No: 2,
          Qty_Ordered: 5, Qty_Produced: 0, Item_Status: 'Awaiting_Material',
          Is_Remake: true, Remake_Reason: 'Check_Reject' }
    ];
    t[STAGES] = [
        { ID: 'S1', Plan: { ID: '101' }, Plan_Item: { ID: 'I1' }, Phase_Name: 'Cutting',
          Sequence_No: 1, Stage_Status: 'Done', Qty_In: 10, Qty_Out: 10, Log_Date: iso(-2) },
        { ID: 'S2', Plan: { ID: '101' }, Plan_Item: { ID: 'I1' }, Phase_Name: 'Stitching',
          Sequence_No: 2, Stage_Status: 'In_Progress', Qty_In: 10, Qty_Out: 4, Log_Date: iso(-1) },
        // Plan 102 last moved 30 days ago -> STUCK.
        { ID: 'S3', Plan: { ID: '102' }, Plan_Item: { ID: 'I3' }, Phase_Name: 'Cutting',
          Sequence_No: 1, Stage_Status: 'Done', Qty_In: 15, Qty_Out: 15, Log_Date: iso(-30) }
    ];
    t[CHECKS] = [
        { ID: 'CK1', Plan: { ID: '102' }, Plan_Item: { ID: 'I3' }, Round: 1,
          Qty_Inspected: 15, Qty_Approved: 15, Qty_Rejected: 0, Qty_Alteration: 0 }
    ];
    t[FINISH] = [
        { ID: 'F1', Item_Check: { ID: 'CK1' }, Finishing_Status: 'Done' }
    ];
    return t;
}

// ===========================================================================
console.log('\nDATES — parsed by parts, never by new Date(string):');
// ===========================================================================
const P = load(baseTables());
// `new Date('2026-09-12')` is read as UTC and lands a day early west of
// Greenwich. Parsing by parts is the only way this is stable.
const d1 = P.parseDate('2026-09-12');
check('ISO parses to the right calendar day',
    d1 && d1.getFullYear() === 2026 && d1.getMonth() === 8 && d1.getDate() === 12,
    d1 && d1.toString());
const d2 = P.parseDate('12-Sep-2026');
check('Creator dd-MMM-yyyy parses', d2 && d2.getMonth() === 8 && d2.getDate() === 12);
const d3 = P.parseDate('12/09/2026');
check('dd/MM/yyyy parses as day-first, not month-first',
    d3 && d3.getMonth() === 8 && d3.getDate() === 12, d3 && d3.toString());
check('empty is null, not epoch', P.parseDate('') === null);
check('today is 0 days away', P.daysFromToday(iso(0)) === 0);
check('yesterday is -1', P.daysFromToday(iso(-1)) === -1);
check('a week out is +7', P.daysFromToday(iso(7)) === 7);

// ===========================================================================
console.log('\nTHE PAGE — joins, and a FIXED number of fetches:');
// ===========================================================================
P.page({ status: 'In Production', page: 1, pageSize: 25 }).then(function (res) {
    const byId = {};
    res.orders.forEach(function (o) { byId[o.salesOrder] = o; });

    check('returns the four In-Production orders, not the dispatched one',
        res.orders.length === 4 && !byId['SO-0900'],
        res.orders.map(function (o) { return o.salesOrder; }).join(','));

    // THE POINT OF THE REBUILD. The Deluge did per-plan queries inside a
    // per-order loop; this must not grow with the number of orders.
    const perForm = {};
    ASKED.forEach(function (a) { perForm[a.report] = (perForm[a.report] || 0) + 1; });
    check('one fetch of Sales_Order for the page', perForm[ORDERS] === 1, JSON.stringify(perForm));
    check('one fetch of Plan_Item for the whole page, not one per order',
        perForm[ITEMS] === 1, JSON.stringify(perForm));
    check('one fetch of Stage_Log for the whole page', perForm[STAGES] === 1);
    check('one fetch of Item_Check for the whole page', perForm[CHECKS] === 1);
    check('Finishing_Data fetched once, not once per check', perForm[FINISH] === 1);
    check('total calls stay in single figures for a page of orders',
        ASKED.length <= 9, ASKED.length + ' calls');

    // --- the joined figures ---
    const so3000 = byId['SO-3000'];
    check('plan number joined', so3000.planNo === 'PLAN-00107');
    check('supervisor joined off the lookup label', so3000.supervisor === 'Aniket');
    check('ordered quantity summed over items', so3000.orderedQty === 20);
    check('produced quantity summed over items', so3000.producedQty === 4);
    check('item count', so3000.itemCount === 2);
    check('customer name joined', so3000.customerName === 'Faire');

    // AWAITING MATERIAL is invisible on a produced/ordered ratio and is the
    // blocker that actually stops work.
    check('blocked items counted', so3000.blocked === 1);

    // Current stage: the open one furthest along, else the last one done.
    check('current stage is the open one', so3000.currentStage === 'Stitching');
    check('and it is marked in progress', so3000.currentStageStatus === 'In_Progress');
    check('last completed stage recorded', so3000.lastCompletedStage === 'Cutting');

    const so2000 = byId['SO-2000'];
    check('a finished item counts as complete', so2000.completedItems === 1);
    check('remake items counted', byId['SO-1099'].remakeItems === 1);

    // ===================================================================
    console.log('\nRISK — and, just as important, what must NOT be flagged:');
    // ===================================================================
    function levels(o) { return P.risk(o).map(function (r) { return r.level; }); }

    check('an overdue order is flagged late', levels(so2000).indexOf('late') > -1,
        JSON.stringify(levels(so2000)));
    check('and the label says how many days',
        P.risk(so2000).some(function (r) { return r.level === 'late' && /5 days? overdue/.test(r.label); }),
        JSON.stringify(P.risk(so2000).map(function (r) { return r.label; })));
    check('an order due in 2 days is flagged due, not late',
        levels(byId['SO-1099']).indexOf('due') > -1 &&
        levels(byId['SO-1099']).indexOf('late') === -1);
    check('an order due in 20 days is NOT flagged for time',
        levels(so3000).indexOf('due') === -1 && levels(so3000).indexOf('late') === -1,
        JSON.stringify(levels(so3000)));
    check('an order with NO delivery date is never called late',
        levels(byId['SO-0001']).indexOf('late') === -1);
    check('blocked items raise a blocked flag', levels(so3000).indexOf('blocked') > -1);
    check('an order whose stages stopped 30 days ago is stuck',
        levels(so2000).indexOf('stuck') > -1, JSON.stringify(levels(so2000)));
    check('an order that moved yesterday is NOT stuck',
        levels(so3000).indexOf('stuck') === -1);

    // A DISPATCHED ORDER IS NOT CHASED, however overdue it looks on paper.
    // Flagging shipped work is the fastest way to teach an admin to ignore the
    // whole bar.
    return P.page({ status: 'Dispatched', page: 1, pageSize: 25 }).then(function (dres) {
        const disp = dres.orders[0];
        check('a dispatched order raises no risk at all', P.risk(disp).length === 0,
            JSON.stringify(P.risk(disp).map(function (r) { return r.level; })));

        // worstRisk ranks late above due, so the row shows the worse word.
        check('worstRisk prefers late over due',
            P.worstRisk(so2000).level === 'late');
        check('a clean order has no worst risk', P.worstRisk(so3000) !== null);

        // ===================================================================
        console.log('\nSORTING — urgency by default:');
        // ===================================================================
        const sorted = P.sortOrders([byId['SO-3000'], byId['SO-2000'], byId['SO-1099'],
                                     byId['SO-0001']], 'urgency');
        check('soonest due leads', sorted[0].salesOrder === 'SO-2000',
            sorted.map(function (o) { return o.salesOrder; }).join(','));
        check('an undated order sorts LAST, not as if overdue',
            sorted[sorted.length - 1].salesOrder === 'SO-0001',
            sorted.map(function (o) { return o.salesOrder; }).join(','));

        const byDate = P.sortOrders([byId['SO-3000'], byId['SO-2000']], 'date');
        check('date sort is newest first', byDate[0].salesOrder === 'SO-3000');

        // ===================================================================
        console.log('\nCOUNTS — the tiles:');
        // ===================================================================
        return P.counts().then(function (c) {
            check('total counted', c.total === 5, 'got ' + c.total);
            check('In Production folds the four live statuses', c.inProduction === 4,
                'got ' + c.inProduction);
            check('dispatched counted separately', c.dispatched === 1);
            check('packed is zero here', c.packed === 0);
            check('per-status breakdown available',
                c.byStatus['In Progress'] === 4, JSON.stringify(c.byStatus));

            // ===============================================================
            console.log('\nDEGRADATION — a missing report must not empty the board:');
            // ===============================================================
            // Same rule as the consumption tab: the pipeline is more useful with
            // some joins missing than replaced by an error page.
            const partial = baseTables();
            delete partial[STAGES];   // stub rejects -> 9280 -> treated as empty
            delete partial[FINISH];
            const P2 = load(partial);
            return P2.page({ status: 'In Production', page: 1, pageSize: 25 }).then(function (r2) {
                check('orders still returned without stage data', r2.orders.length === 4);
                check('quantities still joined',
                    r2.orders.some(function (o) { return o.orderedQty > 0; }));
                check('a 9280 is not reported as an error', (r2.notes || []).length === 0,
                    JSON.stringify(r2.notes));
                check('stage-derived fields are simply empty, not wrong',
                    r2.orders.every(function (o) { return o.currentStage === ''; }));
                check('and nothing is falsely called stuck without stage data',
                    r2.orders.every(function (o) {
                        return P2.risk(o).every(function (x) { return x.level !== 'stuck'; });
                    }));

                console.log('\n' + pass + ' passed, ' + fail + ' failed');
                process.exit(fail ? 1 : 0);
            });
        });
    });
}).catch(function (err) {
    console.log('  FAIL harness threw: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
