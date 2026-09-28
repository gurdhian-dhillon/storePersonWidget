// Sales order pipeline — what makes it hold at volume, and what the admin
// redesign added on top.
//
// The list used to download every stage log of every order in the factory
// (~100,000 rows at this org's real volume) to draw one bar per row. It now
// reads OPEN stage logs only and derives loss from the Production_Loss batches;
// the full history is read for one order when it is opened. These checks pin:
//
//   - every id list is chunked at 25, and the list never asks for closed logs
//   - finishing is ONE date-bounded read at volume, falling back to id chunks
//     when the criteria is refused — with identical figures either way
//   - a rate limit reports an error for that load and never marks the report
//     missing for the session
//   - the list's loss, read off the batches, equals the expand's, read off the
//     stage logs
//   - order lines are joined by Remake_Of, so two sizes of one product are two
//     lines
//   - at risk / idle fire when they should and not otherwise; Packed is never
//     called late; the Packed window; Pending off getRecords with its due date
//   - the view: red-only tile badges, the supervisor filter, the rejected-
//     pending link, Convert reporting on the page, and opening on Pending when
//     the factory is empty
//
//   usage: node tools/admin-pipeline-scale.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '\n         ' + String(detail).slice(0, 500) : '')); }
}

function iso(off) {
    const d = new Date(); d.setDate(d.getDate() + off);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function creatorTs(off) {   // "05-Sep-2026 10:00:00", Creator's date-time form
    const d = new Date(); d.setDate(d.getDate() + off);
    return String(d.getDate()).padStart(2, '0') + '-' + MON[d.getMonth()] + '-' + d.getFullYear() + ' 10:00:00';
}
function parseTs(s) {
    s = String(s || '');
    let m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (m) return new Date(+m[3], MON.indexOf(m[2]), +m[1]).getTime();
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return NaN;
}
const L = (id, label) => ({ ID: String(id), display_value: label || String(id) });

// ---------------------------------------------------------------------------
// A getRecords stub that EVALUATES the criteria (==, !=, >= over ids, strings
// and dates, with && / || / parentheses), records every call, and lets a test
// refuse calls to simulate a rate limit or a criteria Creator will not take.
// ---------------------------------------------------------------------------
function makeApi(tables, opts) {
    opts = opts || {};
    const calls = [];
    function fieldVal(r, f) {
        const v = r[f];
        return (v && typeof v === 'object') ? String(v.ID) : (v === undefined || v === null ? '' : String(v));
    }
    function compile(crit) {
        const js = crit.replace(/(\w+)\s*(==|!=|>=)\s*("[^"]*"|\d+)/g, function (_, f, op, val) {
            return 'cmp(r,' + JSON.stringify(f) + ',' + JSON.stringify(op) + ',' + JSON.stringify(val.replace(/^"|"$/g, '')) + ')';
        });
        return new Function('r', 'cmp', 'return ' + js + ';');
    }
    function cmp(r, f, op, val) {
        const v = fieldVal(r, f);
        if (op === '==') return v === val;
        if (op === '!=') return v !== val;
        return parseTs(v) >= parseTs(val);
    }
    return {
        calls,
        getRecords(cfg) {
            calls.push({ report: cfg.report_name, criteria: cfg.criteria || '' });
            if (opts.refuse) {
                const err = opts.refuse(cfg);
                if (err) return Promise.reject(err);
            }
            let rows = tables[cfg.report_name];
            if (rows === undefined) return Promise.reject({ code: 2894, message: 'Invalid report name' });
            if (cfg.criteria) {
                const fn = compile(cfg.criteria);
                rows = rows.filter(r => fn(r, cmp));
            }
            if (cfg.max_records && rows.length > cfg.max_records) rows = rows.slice(0, cfg.max_records);
            if (!rows.length) return Promise.reject({ code: 9280, message: 'No records found' });
            return Promise.resolve({ data: rows });
        },
        invokeCustomApi() { return Promise.resolve({ result: '{"errors":[],"orders":[]}' }); }
    };
}

const DIR = path.join(__dirname, '..', 'app', 'admin', 'anotherPage', 'js');
function loadData(api) {
    const ctx = { console: { log() {}, warn() {}, error() {} }, Promise, JSON, Object, Number, String, isNaN, Math, Date, Array,
        ZOHO: { CREATOR: { DATA: api } } };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(DIR, 'pipeline-data.js'), 'utf8'), ctx);
    return ctx.PipelineData;
}
function idsIn(crit) { return (crit.match(/==\s*\d+/g) || []).length; }

// ---------------------------------------------------------------------------
// A factory of N orders, one plan each. Every plan: an item mid-Stitching whose
// Cutting stage lost 2 (covered by a Production_Loss batch), an item finished
// and checked, and an item with material in hand and no stage.
// ---------------------------------------------------------------------------
function factory(n) {
    const t = { Sales_Order_Report: [], Production_Planning_Report: [], Plan_Item_Report: [],
        Stage_Log_Report: [], All_Items: [], Finishing_Data_Report: [], Material_Requirement_Report: [],
        Item_Master_Report: [] };
    for (let i = 1; i <= n; i++) {
        const so = String(1000 + i), plan = String(5000 + i);
        const a = String(700000 + i * 10 + 1), b = String(700000 + i * 10 + 2), c = String(700000 + i * 10 + 3),
              loss = String(700000 + i * 10 + 4), chk = String(900000 + i);
        t.Sales_Order_Report.push({ ID: so, Sales_Order: 'SO-' + so, Order_Status: 'In Progress',
            Expected_Delivery_Date: iso(20), Customer: L('1', 'Faire') });
        t.Production_Planning_Report.push({ ID: plan, Sales_Order: L(so), Plan_No: 'PLAN-' + plan,
            Assigned_To: L(i % 2 ? '11' : '12', i % 2 ? 'Aniket' : 'Vivek'), Added_Time: creatorTs(-10) });
        t.Plan_Item_Report.push(
            { ID: a, Plan: L(plan), Line_No: 1, Item_Name: 'Duvet', Item_Sku: L('31', 'DUV-K'), Item_Status: 'In_Production',
              Qty_Ordered: 10, Qty_Produced: 0, Modified_Time: creatorTs(-2) },
            { ID: b, Plan: L(plan), Line_No: 2, Item_Name: 'Sheet', Item_Sku: L('32', 'SHT-K'), Item_Status: 'Complete',
              Qty_Ordered: 5, Qty_Produced: 5 },
            { ID: c, Plan: L(plan), Line_No: 3, Item_Name: 'Napkin', Item_Sku: L('33', 'NAP'), Item_Status: 'Ready_For_Production',
              Qty_Ordered: 4, Qty_Produced: 0 },
            { ID: loss, Plan: L(plan), Line_No: 4, Item_Name: 'Duvet', Is_Remake: true, Remake_Reason: 'Production_Loss',
              Remake_Of: L(a), Item_Status: 'Awaiting_Material', Qty_Ordered: 2, Qty_Produced: 0 });
        t.Stage_Log_Report.push(
            { Plan: L(plan), Plan_Item: L(a), Phase_Name: 'Cutting', Sequence_No: 1, Stage_Status: 'Done', Qty_In: 10, Qty_Out: 8, Log_Date: iso(-4) },
            { Plan: L(plan), Plan_Item: L(a), Phase_Name: 'Stitching', Sequence_No: 2, Stage_Status: 'In_Progress', Qty_In: 8, Qty_Out: 0, Log_Date: iso(-2) },
            { Plan: L(plan), Plan_Item: L(b), Phase_Name: 'Cutting', Sequence_No: 1, Stage_Status: 'Done', Qty_In: 5, Qty_Out: 5, Log_Date: iso(-6) });
        t.All_Items.push({ ID: chk, Plan: L(plan), Plan_Item: L(b), Qty_Inspected: 5, Qty_Approved: 5, Qty_Rejected: 0, Qty_Alteration: 0,
            Added_Time: creatorTs(-3) });
        t.Finishing_Data_Report.push({ ID: String(800000 + i), Item_Check: L(chk), Finishing_Status: i % 3 ? 'Done' : 'In_Progress',
            Added_Time: creatorTs(-2) });
    }
    // A finishing job from long ago, for a check that is not on screen — the
    // date-bounded read must not pull it, and must not be confused by it.
    t.Finishing_Data_Report.push({ ID: '899999', Item_Check: L('123'), Finishing_Status: 'Done', Added_Time: creatorTs(-200) });
    t.Item_Master_Report.push({ ID: '31', SKU: 'DUV-K', Size: 'King', Color: 'White' },
        { ID: '32', SKU: 'SHT-K', Size: 'King', Color: 'Grey' }, { ID: '33', SKU: 'NAP', Size: '45 x 45', Color: 'Natural' });
    return t;
}

function summary(orders) {
    return orders.map(o => [o.salesOrder, o.placed, o.pos.inProduction, o.pos.lost, o.pos.finished,
        o.pos.inFinishing, o.pos.waitingMaterial, o.pos.readyToStart].join(':')).sort().join('|');
}

(async function main() {
    // =======================================================================
    console.log('\nSCALE — 60 orders, one page() call:');
    // =======================================================================
    let T = factory(60);
    let api = makeApi(T);
    let P = loadData(api);
    let res = await P.page({ status: 'In Production' });
    check('all 60 orders come back', res.orders.length === 60, res.orders.length);
    check('no read failed', res.notes.length === 0, JSON.stringify(res.notes));

    const byReport = {};
    api.calls.forEach(c => { (byReport[c.report] = byReport[c.report] || []).push(c); });
    check('Plan_Item read in chunks of at most 25 plans (3 calls for 60)',
        byReport.Plan_Item_Report.length === 3 && byReport.Plan_Item_Report.every(c => idsIn(c.criteria) <= 25),
        byReport.Plan_Item_Report.map(c => idsIn(c.criteria)).join(','));
    check('no call anywhere carries more than 25 ids', api.calls.every(c => idsIn(c.criteria) <= 25));
    check('the list asks Stage_Log for OPEN logs only',
        byReport.Stage_Log_Report.every(c => /Stage_Status == "In_Progress"/.test(c.criteria)),
        byReport.Stage_Log_Report.map(c => c.criteria.slice(-40)).join(' | '));
    check('finishing is ONE date-bounded read, not 3 id chunks',
        byReport.Finishing_Data_Report.length === 1 && /Added_Time >= "/.test(byReport.Finishing_Data_Report[0].criteria),
        byReport.Finishing_Data_Report.map(c => c.criteria).join(' | '));

    const o1 = res.orders.filter(o => o.salesOrder === 'SO-1001')[0];
    check('loss read off the batch: 8 at Stitching, 2 lost, 2 waiting for material',
        o1.pos.inProduction === 8 && o1.pos.lost === 2 && o1.pos.stages.Stitching && o1.pos.stages.Stitching.qty === 8 &&
        o1.pos.waitingMaterial === 2, JSON.stringify({ p: o1.pos.inProduction, l: o1.pos.lost, s: o1.pos.stages, m: o1.pos.waitingMaterial }));
    check('material in hand, no stage: 4 ready to start', o1.pos.readyToStart === 4, o1.pos.readyToStart);
    check('every ordered piece placed (19)', o1.placed === 19 && o1.orderedQty === 19 && o1.unplaced === 0,
        o1.placed + '/' + o1.orderedQty);
    check('finishing joined through the date-bounded read (SO-1001 Done)', o1.pos.finished === 5, o1.pos.finished);
    const o3 = res.orders.filter(o => o.salesOrder === 'SO-1003')[0];
    check('an open finishing job reads as in finishing (SO-1003)', o3.pos.inFinishing === 5 && o3.pos.finished === 0);

    // The expand re-reads the full logs; it must place the same pieces.
    const before = summary([o1]);
    api.calls.length = 0;
    await P.detail(o1);
    check('the expand reads ONE plan\'s Stage_Log, all statuses',
        api.calls.filter(c => c.report === 'Stage_Log_Report').length === 1 &&
        api.calls.some(c => c.report === 'Stage_Log_Report' && c.criteria === 'Plan == 5001'),
        JSON.stringify(api.calls));
    check('the expand places exactly what the list did', summary([o1]) === before, before + ' vs ' + summary([o1]));
    check('and now knows which stage closed last', o1.items[0].flows[0].lastStage === 'Cutting');
    check('size and colour from Item_Master', o1.items[0].size === 'King' && o1.items[0].color === 'White',
        JSON.stringify(o1.items[0].size + '/' + o1.items[0].color));
    check('the order is marked exact', o1.exact === true);
    api.calls.length = 0;
    await P.detail(o1);
    check('opening it again reads nothing', api.calls.length === 0, api.calls.length);

    // =======================================================================
    console.log('\nFINISHING FALLBACK — the date criteria refused:');
    // =======================================================================
    const listed = summary(res.orders);
    api = makeApi(factory(60), { refuse: cfg => /Added_Time/.test(cfg.criteria || '') ? { code: 3330, message: 'Invalid criteria' } : null });
    P = loadData(api);
    res = await P.page({ status: 'In Production' });
    check('falls back to id chunks and reports nothing', res.notes.length === 0, JSON.stringify(res.notes));
    check('and the figures are identical', summary(res.orders) === listed);
    check('the report stays resolved (not written off as missing)', P.RPT.finish === 'Finishing_Data_Report', P.RPT.finish);

    // =======================================================================
    console.log('\nRATE LIMIT — outlasting the throttle\'s retries:');
    // =======================================================================
    let limited = true;
    api = makeApi(factory(3), { refuse: cfg => (limited && cfg.report_name === 'Plan_Item_Report')
        ? { code: 2955, message: 'maximum number of API calls that can be simultaneously initiated' } : null });
    P = loadData(api);
    res = await P.page({ status: 'In Production' });
    check('the load says what failed', res.notes.some(n => /Plan_Item_Report/.test(n)), JSON.stringify(res.notes));
    check('the other candidate names were NOT tried', !api.calls.some(c => c.report === 'All_Plan_Items'));
    limited = false;
    res = await P.page({ status: 'In Production' });
    check('the next load reads Plan_Item normally', res.notes.length === 0 && res.orders[0].orderedQty === 19,
        JSON.stringify(res.notes) + ' ' + res.orders[0].orderedQty);

    // =======================================================================
    console.log('\nORDER LINES — joined by Remake_Of, not by name:');
    // =======================================================================
    T = factory(1);
    T.Plan_Item_Report = [
        { ID: '11', Plan: L('5001'), Line_No: 1, Item_Name: 'Fern Duvet Cover', Item_Sku: L('31', 'FDC-K'), Item_Status: 'Complete', Qty_Ordered: 12, Qty_Produced: 12 },
        { ID: '12', Plan: L('5001'), Line_No: 2, Item_Name: 'Fern Duvet Cover', Item_Sku: L('32', 'FDC-Q'), Item_Status: 'Complete', Qty_Ordered: 10, Qty_Produced: 10 },
        { ID: '13', Plan: L('5001'), Line_No: 3, Item_Name: 'Fern Duvet Cover', Is_Remake: true, Remake_Reason: 'Check_Reject',
          Remake_Of: L('12'), Item_Status: 'In_Production', Qty_Ordered: 2, Qty_Produced: 0 },
        { ID: '14', Plan: L('5001'), Line_No: 4, Item_Name: 'Napkin', Item_Status: 'Complete', Qty_Ordered: 4, Qty_Produced: 4 },
        // An older batch with no Remake_Of still finds its line by name.
        { ID: '15', Plan: L('5001'), Line_No: 5, Item_Name: 'Napkin', Is_Remake: true, Remake_Reason: 'Check_Reject',
          Item_Status: 'Awaiting_Material', Qty_Ordered: 1, Qty_Produced: 0 }
    ];
    T.Stage_Log_Report = []; T.All_Items = []; T.Finishing_Data_Report = [];
    P = loadData(makeApi(T));
    res = await P.page({ status: 'In Production' });
    const lines = res.orders[0].items;
    check('two sizes of one product are TWO lines', lines.length === 3 &&
        lines[0].sku === 'FDC-K' && lines[1].sku === 'FDC-Q', lines.map(l => l.name + '/' + l.sku).join(', '));
    check('each keeps its own ordered quantity (12 and 10, not 22)', lines[0].ordered === 12 && lines[1].ordered === 10);
    check('the remake attaches to the line its Remake_Of names (Queen)',
        lines[0].flows.length === 1 && lines[1].flows.length === 2 && lines[1].flows[1].flowType === 'check_remake');
    check('a batch with no Remake_Of falls back to its line by name', lines[2].flows.length === 2, lines[2].flows.length);
    check('the order is still 26 ordered', res.orders[0].orderedQty === 26, res.orders[0].orderedQty);

    // =======================================================================
    console.log('\nRISK — at risk, idle, and what must NOT fire:');
    // =======================================================================
    T = factory(4);
    T.Sales_Order_Report[0].Expected_Delivery_Date = iso(3);     // due soon, 4 ready to start + 2 waiting
    T.Sales_Order_Report[1].Expected_Delivery_Date = iso(20);    // same work, plenty of time
    T.Sales_Order_Report[2].Expected_Delivery_Date = iso(2);     // due soon, but everything started
    T.Plan_Item_Report = T.Plan_Item_Report.filter(it => !(it.Plan.ID === '5003' && (it.Line_No === 3 || it.Line_No === 4)));
    // Order 4: material arrived 16 days ago; nobody has started anything.
    T.Plan_Item_Report = T.Plan_Item_Report.filter(it => it.Plan.ID !== '5004');
    T.Stage_Log_Report = T.Stage_Log_Report.filter(l => l.Plan.ID !== '5004');
    T.All_Items = T.All_Items.filter(c => c.Plan.ID !== '5004');
    T.Production_Planning_Report[3].Added_Time = creatorTs(-25);
    T.Plan_Item_Report.push({ ID: '9401', Plan: L('5004'), Line_No: 1, Item_Name: 'Throw', Item_Status: 'Ready_For_Production',
        Qty_Ordered: 30, Qty_Produced: 0, Modified_Time: creatorTs(-16) });
    P = loadData(makeApi(T));
    res = await P.page({ status: 'In Production' });
    const by = {}; res.orders.forEach(o => { by[o.salesOrder] = o; });
    const lv = o => P.risk(o).map(r => r.level);
    check('due in 3 days with pieces not started -> at risk', lv(by['SO-1001']).indexOf('risk') > -1, JSON.stringify(P.risk(by['SO-1001'])));
    check('its label says why', P.risk(by['SO-1001']).some(r => r.label === 'due in 3 days · 6 pcs not started'),
        JSON.stringify(P.risk(by['SO-1001']).map(r => r.label)));
    check('the same work due in 20 days is NOT at risk', lv(by['SO-1002']).indexOf('risk') === -1);
    check('due in 2 days with everything started is NOT at risk', lv(by['SO-1003']).indexOf('risk') === -1,
        JSON.stringify(P.risk(by['SO-1003'])));
    check('material 16 days in hand, nothing started -> idle', lv(by['SO-1004']).indexOf('stuck') > -1 &&
        P.risk(by['SO-1004']).some(r => r.label === 'idle 16 days'), JSON.stringify(P.risk(by['SO-1004'])));
    check('an order that moved 2 days ago is not idle', lv(by['SO-1002']).indexOf('stuck') === -1);
    check('late outranks at risk', P.worstRisk(Object.assign({}, by['SO-1001'], { daysToDue: -1 })).level === 'late');
    check('a Packed order past its date is NOT called late (dispatch is not built)',
        P.risk({ status: 'Packed', daysToDue: -30, pos: by['SO-1001'].pos }).length === 0);

    // =======================================================================
    console.log('\nPACKED — the window, and no piece reads:');
    // =======================================================================
    T = factory(2);
    T.Sales_Order_Report.forEach(o => { o.Order_Status = 'Packed'; });
    T.Sales_Order_Report[0].Modified_Time = creatorTs(-5);
    T.Sales_Order_Report[1].Modified_Time = creatorTs(-40);
    api = makeApi(T);
    P = loadData(api);
    res = await P.page({ status: 'Packed', windowDays: 30 });
    check('packed in the last 30 days: 1 shown, 1 older', res.orders.length === 1 && res.older === 1 && res.total === 2,
        res.orders.length + ' / ' + res.older + ' / ' + res.total);
    check('ordered quantity still joined', res.orders[0].orderedQty === 19, res.orders[0].orderedQty);
    check('Packed reads no Stage_Log, Item_Check or Finishing_Data',
        !api.calls.some(c => /Stage_Log|All_Items|Finishing/.test(c.report)), api.calls.map(c => c.report).join(','));
    res = await P.page({ status: 'Packed', windowDays: 0 });
    check('"Show older" lists both', res.orders.length === 2 && res.older === 0);

    // =======================================================================
    console.log('\nPENDING — off getRecords, with its due date:');
    // =======================================================================
    T = factory(0);
    T.Sales_Order_Report = [
        { ID: '1', Sales_Order: 'SO-P1', Order_Status: 'Pending', Expected_Delivery_Date: iso(5), Customer: L('1', 'Faire'),
          Sales_Order_Date: iso(-2), Plan_Reject_Reason: 'No BOM for: Riva Cushion\nSecond line', Batch_Run_Outcome: 'Rejected',
          Item_Table: [{ Item_Name: 'Riva Cushion' }, { Item_Name: L('9', 'Fern Throw') }, { Item_Name: 'Riva Cushion' }] },
        { ID: '2', Sales_Order: 'SO-P2', Order_Status: 'In Progress', Customer: L('1', 'Faire') }
    ];
    P = loadData(makeApi(T));
    const pend = await P.pending();
    check('only Pending orders', pend.orders.length === 1 && pend.orders[0].salesOrder === 'SO-P1');
    const p1 = pend.orders[0];
    check('due date and days to it', p1.daysToDue === 5, p1.daysToDue);
    check('line count off the nested Item_Table, names de-duplicated',
        p1.itemCount === 3 && p1.itemsSummary === 'Riva Cushion, Fern Throw', p1.itemCount + ' ' + p1.itemsSummary);
    check('a multi-line reject reason is flattened', p1.rejectReason === 'No BOM for: Riva Cushion | Second line', p1.rejectReason);

    // =======================================================================
    console.log('\nTHE VIEW:');
    // =======================================================================
    await viewChecks();

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

async function viewChecks() {
    const T = factory(4);
    T.Sales_Order_Report[0].Expected_Delivery_Date = iso(-3);             // late
    T.Sales_Order_Report[0].Order_Status = 'Production Complete';
    T.Sales_Order_Report[1].Expected_Delivery_Date = iso(3);              // at risk
    T.Sales_Order_Report.push({ ID: '77', Sales_Order: 'SO-PEND', Order_Status: 'Pending', Expected_Delivery_Date: iso(4),
        Customer: L('1', 'Faire'), Batch_Run_Outcome: 'Rejected', Plan_Reject_Reason: 'No BOM for: Riva',
        Item_Table: [{ Item_Name: 'Riva' }] });
    const api = makeApi(T);
    let converted = null;
    api.invokeCustomApi = function (o) {
        if (o.api_name === 'getOrderPipelineCounts') {
            return Promise.resolve({ result: JSON.stringify({ pending: 9, inProgress: 9, completed: 9, qcPassed: 0, finishingComplete: 0, packed: 0, dispatched: 0 }) });
        }
        if (o.api_name === 'convertSalesOrderToPlan') { converted = o.payload.soIdTxt; return Promise.resolve({ result: JSON.stringify({ success: true, planNo: 'PLAN-00900' }) }); }
        return Promise.resolve({ result: '{"errors":[],"orders":[]}' });
    };
    const els = { 'pipeline-section': { innerHTML: '', _plBound: true, addEventListener() {} } };
    let alerted = 0;
    const ctx = {
        console: { log() {}, warn() {}, error() {} }, Promise, JSON, Object, Number, String, Math, Date, isNaN, Array, setTimeout, clearTimeout,
        alert() { alerted++; },
        window: { scrollY: 0, scrollTo() {} },
        document: { documentElement: { scrollTop: 0 }, getElementById: id => els[id] || null, querySelector: () => null,
            createElement: () => ({ innerHTML: '', querySelector: () => null }) },
        ZOHO: { CREATOR: { DATA: api } }
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(DIR, 'pipeline-data.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(DIR, 'pipeline-view.js'), 'utf8'), ctx);
    const run = s => vm.runInContext(s, ctx);
    const tick = () => new Promise(r => setTimeout(r, 20));
    const html = () => run('renderPipeline(); document.getElementById("pipeline-section").innerHTML');

    run('loadPipeline(); loadSalesOrderProgress();');
    for (let i = 0; i < 60 && !run('Array.isArray(PIPE.orders.active) && Array.isArray(PENDING_ORDERS)'); i++) await tick();
    await tick();
    let h = html();

    check('counts come from the loaded lists, not the API\'s stale 9s',
        run('PIPE.counts.inProgress') === 3 && run('PIPE.counts.completed') === 1 && run('PIPE.counts.pending') === 1,
        JSON.stringify(run('PIPE.counts')));
    check('the Checking tile carries a red "1 late" badge', /pl-step-completed[^>]*>\s*<span class="pl-badge">1 late<\/span>/.test(h),
        (h.match(/pl-step-completed[^]{0,160}/) || [''])[0]);
    check('the Pending tile carries "1 rejected"', /pl-step-pending[^>]*>\s*<span class="pl-badge">1 rejected<\/span>/.test(h));
    check('at risk is NOT a tile badge — only red news goes on the strip', !/pl-badge">[^<]*at risk/.test(h));
    check('the attention bar has an at-risk chip', /pl-risk pl-risk-risk[^>]*><b>1<\/b> at risk/.test(h));
    check('and links to the pending order that could not be planned', /1<\/b> pending order could not be planned/.test(h));
    check('the stage cell has no "furthest" line', h.indexOf('furthest') === -1);
    check('the pieces cell has no percentage', !/finished<em>/.test(h));
    check('an "Updated" time sits in the toolbar', /pl-updated[^>]*>Updated \d{1,2}:\d{2} (AM|PM)/.test(h));
    check('orders start closed', h.indexOf('pl-detail-row') === -1);

    check('a supervisor picker with each person\'s load', /Aniket — 2 orders, 1 late/.test(h) && /Vivek — 2 orders/.test(h),
        (h.match(/<select[^]*?<\/select>/) || [''])[0]);
    run('PIPE.sup = "12";');
    h = html();
    check('picking a supervisor narrows the list to his orders',
        h.indexOf('SO-1002') !== -1 && h.indexOf('SO-1004') !== -1 && h.indexOf('SO-1001') === -1, '');
    run('PIPE.sup = "";');

    // Opening an order reads its detail once and renders the exact figures.
    run('PIPE.open["1002"] = true; plOpenDetail("1002");');
    check('opening shows the loading line meanwhile', /Reading this order/.test(run('plDetailHtml(PIPE.orders.active.filter(function (o) { return o.id === "1002"; })[0])')));
    for (let i = 0; i < 40 && run('!!PIPE.detailBusy["1002"]'); i++) await tick();
    const det = run('plDetailHtml(PIPE.orders.active.filter(function (o) { return o.id === "1002"; })[0])');
    check('the expand shows size and colour under the line', /pl-variant">King · White/.test(det), (det.match(/pl-i-name[^]{0,300}/) || [''])[0]);
    check('the expand does not repeat customer / due / supervisor',
        !/<small>Customer<\/small>/.test(det) && !/<small>Due<\/small>/.test(det) && !/<small>Supervisor<\/small>/.test(det));

    // Pending: due column, Convert reports on the page.
    run('PIPE.view = "pending";');
    h = html();
    check('pending shows the due date', /pl-due[^>]*>[^<]+<small>in 4d<\/small>/.test(h));
    check('a pending order that could not be planned is marked', /Could not plan/.test(h) && /flag-late/.test(h));
    run('convertOrderToPlan("77");');
    for (let i = 0; i < 40 && !run('!!PIPE.flash'); i++) await tick();
    check('Convert reports on the page, never in an alert', alerted === 0 && /SO-PEND is planned as PLAN-00900/.test(run('PIPE.flash.text')),
        run('PIPE.flash && PIPE.flash.text'));

    // Landing: an empty factory opens on Pending, once, on first load only.
    const T2 = factory(0);
    T2.Sales_Order_Report = [{ ID: '77', Sales_Order: 'SO-PEND', Order_Status: 'Pending', Customer: L('1', 'Faire') }];
    ctx.ZOHO.CREATOR.DATA = makeApi(T2);
    run('PIPE.view = "active"; PIPE.landed = false; PENDING_ORDERS = null; PIPE.orders.active = null; loadSalesOrderProgress();');
    for (let i = 0; i < 60 && !run('PIPE.landed'); i++) await tick();
    check('an empty factory opens on Pending', run('PIPE.view') === 'pending', run('PIPE.view'));
    run('PIPE.view = "active"; PIPE.orders.active = null; loadSalesOrderProgress();');
    for (let i = 0; i < 40 && !run('Array.isArray(PIPE.orders.active)'); i++) await tick();
    check('but only on the first load — after that the page never moves him', run('PIPE.view') === 'active');
}
