// Sales order pipeline VIEW (app/admin/anotherPage/js/pipeline-view.js), run for
// real over pipeline-data.js with a stubbed Creator.
//
// What it pins, each one a thing the old tab got wrong:
//   - the "In the factory" list holds EVERY active status — the old In
//     Production card, once clicked, loaded only In Progress and an overdue
//     order at Checking Passed left the list
//   - one step narrows to exactly its own status
//   - the order's pieces are PLACED, and they add back to what was ordered
//     (the old pop-up read "5 in QC queue, 0 passed" for five passed pieces)
//   - batches (remake / loss / alteration) are labelled as rework, and a batch
//     nobody asked material for says it is the supervisor's move
//   - a short-closed order says how many will not be made
//   - Packed joins the packing record: boxes, pieces, chargeable weight
//
//   usage: node tools/admin-pipeline-view.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + String(detail).slice(0, 400) : '')); }
}

function iso(off) {
    const d = new Date(); d.setDate(d.getDate() + off);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const L = (id, label) => ({ ID: String(id), display_value: label || String(id) });

const T = {
    Sales_Order_Report: [
        { ID: '1', Sales_Order: 'SO-A', Order_Status: 'In Progress', Expected_Delivery_Date: iso(5), Customer: L('c', 'Faire') },
        { ID: '2', Sales_Order: 'SO-B', Order_Status: 'Checking Passed', Expected_Delivery_Date: iso(-3), Customer: L('c', 'Shopify') },
        { ID: '3', Sales_Order: 'SO-C', Order_Status: 'Finishing Complete', Expected_Delivery_Date: iso(2), Customer: L('c', 'Faire'),
          Short_Closed: true, Short_Close_Reason: 'Lot ran out' },
        { ID: '4', Sales_Order: 'SO-P', Order_Status: 'Packed', Expected_Delivery_Date: iso(1), Customer: L('c', 'Nordstrom') }
    ],
    Production_Planning_Report: [
        { ID: '11', Sales_Order: L('1'), Plan_No: 'PLAN-1', Assigned_To: L('e1', 'Suraj') },
        { ID: '12', Sales_Order: L('2'), Plan_No: 'PLAN-2', Assigned_To: L('e1', 'Suraj') },
        { ID: '13', Sales_Order: L('3'), Plan_No: 'PLAN-3', Assigned_To: L('e2', 'Ramesh') },
        { ID: '14', Sales_Order: L('4'), Plan_No: 'PLAN-4', Assigned_To: L('e2', 'Ramesh') }
    ],
    Plan_Item_Report: [
        // SO-A: 36 pieces over three lines, with a remake and a loss batch.
        { ID: 'a1', Plan: L('11'), Line_No: 1, Item_Name: 'Duvet', Item_Sku: L('s', 'DUV-1'), Item_Status: 'Complete', Qty_Ordered: 10, Qty_Produced: 10 },
        { ID: 'a2', Plan: L('11'), Line_No: 1, Item_Name: 'Duvet', Is_Remake: true, Remake_Reason: 'Check_Reject', Item_Status: 'In_Production', Qty_Ordered: 2, Qty_Produced: 0 },
        { ID: 'a3', Plan: L('11'), Line_No: 2, Item_Name: 'Sheet', Item_Sku: L('s', 'SHT-1'), Item_Status: 'Awaiting_Check', Qty_Ordered: 6, Qty_Produced: 4 },
        { ID: 'a4', Plan: L('11'), Line_No: 2, Item_Name: 'Sheet', Is_Remake: true, Remake_Reason: 'Production_Loss', Item_Status: 'Awaiting_Material', Qty_Ordered: 2, Qty_Produced: 0 },
        { ID: 'a5', Plan: L('11'), Line_No: 3, Item_Name: 'Napkin', Item_Sku: L('s', 'NAP-1'), Item_Status: 'In_Production', Qty_Ordered: 20, Qty_Produced: 0 },
        // SO-B: 5 passed checking, finishing open.
        { ID: 'b1', Plan: L('12'), Line_No: 1, Item_Name: 'Tablecloth', Item_Status: 'Complete', Qty_Ordered: 5, Qty_Produced: 5 },
        // SO-C: 20 ordered, 18 made, the loss batch cancelled by short close.
        { ID: 'c1', Plan: L('13'), Line_No: 1, Item_Name: 'Napkin', Item_Status: 'Complete', Qty_Ordered: 20, Qty_Produced: 18 },
        { ID: 'c2', Plan: L('13'), Line_No: 1, Item_Name: 'Napkin', Is_Remake: true, Remake_Reason: 'Production_Loss', Item_Status: 'Complete', Qty_Ordered: 2, Qty_Produced: 0 },
        { ID: 'p1', Plan: L('14'), Line_No: 1, Item_Name: 'Tablecloth', Item_Status: 'Complete', Qty_Ordered: 10, Qty_Produced: 10 }
    ],
    Stage_Log_Report: [
        { Plan: L('11'), Plan_Item: L('a1'), Phase_Name: 'Cutting', Sequence_No: 1, Stage_Status: 'Done', Qty_In: 10, Qty_Out: 10, Log_Date: iso(-9) },
        { Plan: L('11'), Plan_Item: L('a1'), Phase_Name: 'Stitching', Sequence_No: 2, Stage_Status: 'Done', Qty_In: 10, Qty_Out: 10, Log_Date: iso(-6) },
        { Plan: L('11'), Plan_Item: L('a2'), Phase_Name: 'Stitching', Sequence_No: 2, Stage_Status: 'In_Progress', Qty_In: 2, Qty_Out: 0, Log_Date: iso(-1) },
        { Plan: L('11'), Plan_Item: L('a3'), Phase_Name: 'Stitching', Sequence_No: 2, Stage_Status: 'Done', Qty_In: 6, Qty_Out: 4, Log_Date: iso(-3) },
        { Plan: L('11'), Plan_Item: L('a5'), Phase_Name: 'Cutting', Sequence_No: 1, Stage_Status: 'Done', Qty_In: 20, Qty_Out: 20, Log_Date: iso(-2) },
        { Plan: L('11'), Plan_Item: L('a5'), Phase_Name: 'Stitching', Sequence_No: 2, Stage_Status: 'In_Progress', Qty_In: 20, Qty_Out: 0, Log_Date: iso(-1) },
        { Plan: L('13'), Plan_Item: L('c1'), Phase_Name: 'Stitching', Sequence_No: 2, Stage_Status: 'Done', Qty_In: 20, Qty_Out: 18, Log_Date: iso(-8) }
    ],
    All_Items: [
        { ID: 'k1', Plan: L('11'), Plan_Item: L('a1'), Qty_Approved: 8, Qty_Rejected: 2, Qty_Alteration: 0 },
        { ID: 'k2', Plan: L('12'), Plan_Item: L('b1'), Qty_Approved: 5, Qty_Rejected: 0, Qty_Alteration: 0 },
        { ID: 'k3', Plan: L('13'), Plan_Item: L('c1'), Qty_Approved: 18, Qty_Rejected: 0, Qty_Alteration: 0 },
        { ID: 'k4', Plan: L('14'), Plan_Item: L('p1'), Qty_Approved: 10, Qty_Rejected: 0, Qty_Alteration: 0 }
    ],
    Finishing_Data_Report: [
        { Item_Check: L('k1'), Finishing_Status: 'Done' },
        { Item_Check: L('k2'), Finishing_Status: 'In_Progress' },
        { Item_Check: L('k3'), Finishing_Status: 'Done' },
        { Item_Check: L('k4'), Finishing_Status: 'Done' }
    ],
    Material_Requirement_Report: []
};

const PACKINGS = [{ salesOrder: 'SO-P', packedOn: iso(-1), packedBy: 'Mohan', boxCount: 2, pieces: 10,
    grossWeight: 9.4, volumetricWeight: 11.2, chargeableWeight: 11.2, gadInvoiceStatus: 'Posted', gadInvoiceNo: 'INV-9',
    boxes: [{ boxNo: 1, carton: 'Outer A', outerLength: 60, outerWidth: 40, outerHeight: 40, grossWeight: 5, volumetricWeight: 19.2,
              items: [{ sku: 'TC-1', itemName: 'Tablecloth', qty: 6 }] },
            { boxNo: 2, carton: 'Outer B', outerLength: 50, outerWidth: 40, outerHeight: 30, grossWeight: 4.4, volumetricWeight: 12,
              items: [{ sku: 'TC-1', itemName: 'Tablecloth', qty: 4 }] }] }];

function makeEl() { return { innerHTML: '', _plBound: true, addEventListener() {}, querySelector() { return null; } }; }
const els = { 'pipeline-section': makeEl() };
const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Promise, JSON, Object, Number, String, Math, Date, isNaN, Array, setTimeout, clearTimeout,
    alert() {},
    window: { scrollY: 0, scrollTo() {} },
    document: {
        documentElement: { scrollTop: 0 },
        getElementById(id) { return els[id] || null; },
        querySelector() { return null; },
        createElement() { return { innerHTML: '', querySelector() { return null; } }; }
    },
    ZOHO: { CREATOR: { DATA: {
        getRecords(cfg) {
            let rows = T[cfg.report_name];
            if (rows === undefined) return Promise.reject({ code: 2894, message: 'no such report' });
            if (cfg.report_name === 'Sales_Order_Report' && cfg.criteria) {
                const want = (cfg.criteria.match(/"([^"]+)"/g) || []).map(s => s.replace(/"/g, ''));
                rows = rows.filter(o => want.indexOf(o.Order_Status) !== -1);
            }
            if (!rows.length) return Promise.reject({ code: 9280, message: 'No records found' });
            return Promise.resolve({ data: rows });
        },
        invokeCustomApi(o) {
            if (o.api_name === 'getOrderPipelineCounts') {
                return Promise.resolve({ result: JSON.stringify({ pending: 0, inProgress: 1, completed: 0, qcPassed: 1, finishingComplete: 1, packed: 1, dispatched: 0 }) });
            }
            if (o.api_name === 'getPackingHistory') return Promise.resolve({ result: JSON.stringify({ errors: [], packings: PACKINGS }) });
            return Promise.resolve({ result: '{"errors":[],"orders":[]}' });
        }
    } } }
};
ctx.window.document = ctx.document;
vm.createContext(ctx);
const dir = path.join(__dirname, '..', 'app', 'admin', 'anotherPage', 'js');
vm.runInContext(fs.readFileSync(path.join(dir, 'pipeline-data.js'), 'utf8'), ctx, { filename: 'pipeline-data.js' });
vm.runInContext(fs.readFileSync(path.join(dir, 'pipeline-view.js'), 'utf8'), ctx, { filename: 'pipeline-view.js' });
const run = (src) => vm.runInContext(src, ctx);
const tick = () => new Promise(r => setTimeout(r, 30));

(async function main() {
    run('loadPipeline(); loadSalesOrderProgress();');
    for (let i = 0; i < 40 && !(run('Array.isArray(PIPE.orders.active)')); i++) await tick();

    console.log('\nTHE FACTORY LIST holds every active status:');
    const active = run('PIPE.orders.active.map(function (o) { return o.salesOrder + ":" + o.status; })');
    check('SO-A (In Progress), SO-B (Checking Passed), SO-C (Finishing Complete) all listed',
        active.length === 3 && ['SO-A', 'SO-B', 'SO-C'].every(s => active.some(a => a.indexOf(s + ':') === 0)), active.join(', '));
    check('the packed order is NOT in the factory list', !active.some(a => a.indexOf('SO-P') === 0));

    let html = run('renderPipeline(); document.getElementById("pipeline-section").innerHTML');
    check('strip: In the factory totals 3', /In the factory<\/span><b>3<\/b>/.test(html));
    check('the overdue order is flagged', /pl-flag-late[^>]*>3 days overdue/.test(html));

    run('PIPE.status = "Checking Passed"; renderPipeline();');
    html = run('document.getElementById("pipeline-section").innerHTML');
    check('one step narrows to its own status only',
        html.indexOf('SO-B') !== -1 && html.indexOf('SO-A') === -1 && html.indexOf('SO-C') === -1);
    run('PIPE.status = "";');

    console.log('\nEVERY PIECE PLACED:');
    const A = run('PIPE.orders.active.filter(function (o) { return o.salesOrder === "SO-A"; })[0]');
    check('SO-A: 2 waiting for material, 22 in production, 4 waiting for checking, 8 finished',
        A.pos.waitingMaterial === 2 && A.pos.inProduction === 22 && A.pos.awaitingCheck === 4 && A.pos.finished === 8,
        JSON.stringify({ m: A.pos.waitingMaterial, p: A.pos.inProduction, c: A.pos.awaitingCheck, f: A.pos.finished }));
    check('and they add back to the 36 ordered', A.placed === 36 && A.orderedQty === 36 && A.unplaced === 0,
        A.placed + ' / ' + A.orderedQty);
    check('the 22 are all at Stitching', A.pos.stages.Stitching && A.pos.stages.Stitching.qty === 22);
    check('8 of 36 finished = 22%', A.finishedQty === 8 && A.pct === 22);
    const B = run('PIPE.orders.active.filter(function (o) { return o.salesOrder === "SO-B"; })[0]');
    check('SO-B: 5 passed checking are IN FINISHING, not "in QC queue"',
        B.pos.inFinishing === 5 && B.pos.awaitingCheck === 0, JSON.stringify(B.pos));

    console.log('\nTHE EXPAND:');
    const detA = run('plDetailHtml(PIPE.orders.active.filter(function (o) { return o.salesOrder === "SO-A"; })[0])');
    check('headline names the ordered count', /Where the 36 pieces are/.test(detA));
    check('legend says who the material wait is on (supervisor, never requested)',
        /2 not requested by the supervisor/.test(detA), detA.match(/pl-key[^]*?<\/span>/));
    check('a remake chip is labelled as rework, at its stage',
        /is-rework"><em>Remake<\/em><b>2<\/b> at Stitching/.test(detA));
    check('the loss remake chip names the supervisor as the one to act',
        /<em>Loss remake<\/em><b>2<\/b> waiting — supervisor to request material/.test(detA));
    check('rejected (2) and lost (2) sit in their own columns',
        /is-bad">2<\/td>/.test(detA));
    check('rework summary line', /2 pcs being remade after checking rejected them/.test(detA) &&
        /2 pcs being remade after being lost in production/.test(detA));
    check('no leftover "not accounted for"', detA.indexOf('not accounted for') === -1);

    const detC = run('plDetailHtml(PIPE.orders.active.filter(function (o) { return o.salesOrder === "SO-C"; })[0])');
    check('short close: banner says 2 of the 20 will not be made', /2 pcs of the 20 ordered will not be made/.test(detC));
    check('short close: the cancelled batch reads "not being made"', /not being made \(short-closed\)/.test(detC));
    const C = run('PIPE.orders.active.filter(function (o) { return o.salesOrder === "SO-C"; })[0]');
    check('short close: 18 of 20 finished, 90%', C.finishedQty === 18 && C.pct === 90, C.finishedQty + ' ' + C.pct);

    console.log('\nPACKED:');
    run('PIPE.view = "packed"; loadSalesOrderProgress();');
    for (let i = 0; i < 40 && !(run('Array.isArray(PIPE.orders.packed) && !!PIPE.packings')); i++) await tick();
    run('PIPE.open["4"] = true; renderPipeline();');
    html = run('document.getElementById("pipeline-section").innerHTML');
    check('packed row shows boxes, pieces / ordered and chargeable weight',
        /pl-c-num">2<\/td>/.test(html) && /10<\/span> \/ 10/.test(html) && /11\.20 kg/.test(html));
    check('invoice status and number', /Posted<small>INV-9<\/small>/.test(html));
    check('the expand lists each box with what is in it',
        /Box 1<\/b>/.test(html) && /Box 2<\/b>/.test(html) && /× 6<\/b>/.test(html) && /× 4<\/b>/.test(html));

    console.log('\nCOUNTS when getOrderPipelineCounts is misconfigured in Creator:');
    // Creator answers "Improper Configuration" when the Custom API's method does
    // not match the call. The strip must still fill — from GET, else from the
    // Order Audit list — and must not show an error while it has numbers.
    const api = ctx.ZOHO.CREATOR.DATA;
    const realInvoke = api.invokeCustomApi;
    const refused = () => Promise.reject({ message: 'Improper Configuration..!!' });
    // Loaded lists replace the API's counts with exact ones (plSyncCounts);
    // clear them so these checks see what the API chain alone produced.
    run('PIPE.orders = { active: null, packed: null, dispatched: null }; PENDING_ORDERS = null;');

    api.invokeCustomApi = function (o) {
        if (o.api_name === 'getOrderPipelineCounts') {
            return o.http_method === 'GET'
                ? Promise.resolve({ result: JSON.stringify({ pending: 4, inProgress: 2, completed: 0, qcPassed: 0, finishingComplete: 0, packed: 0, dispatched: 0 }) })
                : refused();
        }
        return realInvoke(o);
    };
    run('PIPE.counts = null; PIPE.countsError = ""; loadPipeline();');
    for (let i = 0; i < 40 && !run('!!PIPE.counts'); i++) await tick();
    check('POST refused -> the GET answer is used', run('PIPE.counts && PIPE.counts.pending') === 4 && run('PIPE.countsError') === '');

    api.invokeCustomApi = function (o) {
        if (o.api_name === 'getOrderPipelineCounts') return refused();
        if (o.api_name === 'getAdminCalculation') {
            return Promise.resolve({ result: JSON.stringify({ orders: [
                { status: 'Pending' }, { status: 'In Progress' }, { status: 'In Progress' },
                { status: 'Finishing Complete' }, { status: 'Packed' }, { status: 'Dispatched' }] }) });
        }
        return realInvoke(o);
    };
    run('PIPE.counts = null; PIPE.countsError = ""; loadPipeline();');
    for (let i = 0; i < 40 && !run('!!PIPE.counts'); i++) await tick();
    const c = run('PIPE.counts') || {};
    check('both refused -> counted from the Order Audit list',
        c.pending === 1 && c.inProgress === 2 && c.finishingComplete === 1 && c.packed === 1 && c.dispatched === 1,
        JSON.stringify(c));
    check('Finishing Complete is counted (the old fallback dropped it)', c.finishingComplete === 1);
    check('and no error is shown while the strip has numbers', run('PIPE.countsError') === '');

    api.invokeCustomApi = function (o) {
        if (o.api_name === 'getOrderPipelineCounts' || o.api_name === 'getAdminCalculation') return refused();
        return realInvoke(o);
    };
    run('PIPE.counts = null; PIPE.countsError = ""; loadPipeline();');
    for (let i = 0; i < 40 && !run('!!PIPE.countsError'); i++) await tick();
    check('all three refused -> the error names each attempt',
        /POST: Improper Configuration/.test(run('PIPE.countsError')) && /GET:/.test(run('PIPE.countsError')) &&
        /Order Audit fallback:/.test(run('PIPE.countsError')), run('PIPE.countsError'));
    api.invokeCustomApi = realInvoke;

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
