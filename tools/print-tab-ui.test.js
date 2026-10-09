#!/usr/bin/env node
// The store widget's PRINT TAB — the job-order screen and the create form —
// exercised in a stub DOM via vm. The Print tab region of app/js/main.js is
// loaded VERBATIM between its markers, so a failure here names a real line of
// the widget.
//
//   usage: node tools/print-tab-ui.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function plain(v) { return JSON.parse(JSON.stringify(v)); }
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; failures.push(name); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');
function extractFn(name) {
    const i = mainSrc.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('main.js no longer has function ' + name);
    let depth = 0, j = mainSrc.indexOf('{', i);
    for (let k = j; k < mainSrc.length; k++) {
        if (mainSrc[k] === '{') depth++;
        else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
    }
    return mainSrc.slice(i, j);
}
function extractRegion(a, b) {
    const i = mainSrc.indexOf(a), j = mainSrc.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error('Print tab markers moved — update this test');
    return mainSrc.slice(i, j);
}
const HELPERS = [extractFn('escapeHtml'), extractFn('fmt')].join('\n');
const PRINT_SRC = extractRegion('// ---- Print tab ----', '// Boot. Issue is the home tab');

function thenable(value) {
    return { then: function (cb) { cb(value); return { catch: function () {} }; }, catch: function () {} };
}

function makeWorld(data, opts) {
    opts = opts || {};
    const els = {};
    const log = { alerts: [], confirms: [], prompts: [], calls: [], posts: [] };
    let confirmAnswer = opts.confirmAnswer === undefined ? true : opts.confirmAnswer;

    const sandbox = {
        console: { log() {}, error() {}, info() {}, warn() {} },
        Math, Number, String, Object, Array, JSON, parseInt, parseFloat, isNaN, Date,
        document: {
            getElementById: function (id) { return els[id] || null; },
            querySelectorAll: function () { return { forEach: function () {} }; }
        },
        requestAnimationFrame: function () {},
        alert: function (m) { log.alerts.push(String(m)); },
        confirm: function (m) { log.confirms.push(String(m)); return confirmAnswer; },
        prompt: function () { log.prompts.push(1); return opts.promptAnswer === undefined ? 'a reason' : opts.promptAnswer; },
        showTab: function () {},
        PrintData: {
            load: function () { return thenable(opts.loadResult !== undefined ? opts.loadResult : data); }
        },
        ZOHO: { CREATOR: { DATA: { invokeCustomApi: function (o) {
            log.calls.push(o);
            if (o.http_method === 'POST') log.posts.push(o);
            const body = opts.apiResult !== undefined ? opts.apiResult : { success: true };
            return thenable({ result: JSON.stringify(body) });
        } } } }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(HELPERS + '\n' + PRINT_SRC, sandbox);
    if (data !== undefined) sandbox.PRINT_DATA = data;

    function el(id, props) {
        els[id] = Object.assign({ value: '', checked: false, disabled: false, textContent: '',
            innerHTML: '', className: '', style: {}, scrollIntoView() {},
            classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} } }, props || {});
        return els[id];
    }
    el('panel-print', {});
    return { sandbox, els, el, log, get: n => sandbox[n], setConfirm: v => { confirmAnswer = v; } };
}

// ---- fixture payload, PrintData.load()'s shape ---------------------------
// Two bases: Grey Sheeting 152.4 cm (lots L1, L2-blocked) and White Cotton 147.3
// cm (lot W1). Printed: two at 152.4 (checks, floral), one at 147.3 (stripes),
// one at 228.6 that nothing can become.
function payload(over) {
    return Object.assign({
        source: [
            { id: '10', name: 'Grey Sheeting', sku: 'RM-001', type: 'Plain Fabric', widthCm: 152.4,
              lots: [
                  { lotId: '901', lotNumber: 'L1', wash: 42.6, unwash: 8, inPrint: 0, blocked: false,
                    rolls: [
                        { rollId: 'r1', label: 'L1-R1', length: 8, status: 'Available', origin: 'Purchased' },
                        { rollId: 'r2', label: 'L1-R2', length: 42.6, status: 'Available', origin: 'Purchased' }
                    ] },
                  { lotId: '902', lotNumber: 'L2', wash: 100, unwash: 0, inPrint: 0, blocked: true, rolls: [] }
              ] },
            { id: '12', name: 'White Cotton', sku: 'RM-003', type: 'Plain Fabric', widthCm: 147.32,
              lots: [ { lotId: '920', lotNumber: 'W1', wash: 0, unwash: 30, inPrint: 0, blocked: false,
                        rolls: [ { rollId: 'w1', label: 'W1-R1', length: 30, status: 'Available' } ] } ] }
        ],
        target: [
            { id: '20', name: 'Red Checks', sku: 'RM-100', type: 'printed fabric', widthCm: 152.4, lots: [
                { lotId: '950', lotNumber: 'P1', wash: 5, unwash: 0, inPrint: 0, blocked: false, rolls: [] } ] },
            { id: '22', name: 'Red Floral', sku: 'RM-102', type: 'printed fabric', widthCm: 152.4, lots: [] },
            { id: '23', name: 'Blue Stripes', sku: 'RM-103', type: 'printed fabric', widthCm: 147.32, lots: [] },
            { id: '21', name: 'Wide Print', sku: 'RM-101', type: 'printed fabric', widthCm: 228.6, lots: [] }
        ],
        printers: [ { id: '77', name: 'Zed Prints' }, { id: '78', name: 'Sanwariya Prints' } ],
        jobs: [
            // newest first, as print-data.js returns them: one open job order of
            // two designs (PJ-00012, PJ-00013), one received single job.
            { jobId: '912', jobNo: 'PJ-00013', printBatch: 'PJ-00012', jobStatus: 'At_Printer',
              sourceMaterialId: '10', sourceName: 'Grey Sheeting', sourceSku: 'RM-001',
              sourceLotId: '901', sourceLotNumber: 'L1', sourceState: 'Wash',
              printedMaterialId: '22', printedName: 'Red Floral', printedSku: 'RM-102',
              printerId: '78', printerName: 'Sanwariya Prints', metresSent: 27.5, sentOn: '04-Aug-2026',
              sentOnTs: Date.UTC(2026, 7, 4), invOutStatus: 'Posted', poNumber: 'PO-00042', poError: '',
              sendLines: [ { lineIndex: 0, lengthCm: 550, count: 5, rate: 175 } ] },
            { jobId: '900', jobNo: 'PJ-00012', printBatch: 'PJ-00012', jobStatus: 'At_Printer',
              sourceMaterialId: '10', sourceName: 'Grey Sheeting', sourceSku: 'RM-001',
              sourceLotId: '901', sourceLotNumber: 'L1', sourceState: 'Wash',
              printedMaterialId: '20', printedName: 'Red Checks', printedSku: 'RM-100',
              printerId: '78', printerName: 'Sanwariya Prints', metresSent: 20, sentOn: '04-Aug-2026',
              sentOnTs: Date.UTC(2026, 7, 4), invOutStatus: 'Posted', poNumber: 'PO-00042', poError: '',
              sendLines: [ { lineIndex: 0, lengthCm: 300, count: 4, rate: 175 },
                           { lineIndex: 1, lengthCm: 400, count: 2, rate: 0 } ] },
            { jobId: '880', jobNo: 'PJ-00009', printBatch: 'PJ-00009', jobStatus: 'Received',
              sourceMaterialId: '12', sourceName: 'White Cotton', sourceSku: 'RM-003',
              sourceLotId: '920', sourceLotNumber: 'W1', sourceState: 'Unwash',
              printedMaterialId: '23', printedName: 'Blue Stripes', printedSku: 'RM-103',
              printerId: '77', printerName: 'Zed Prints', metresSent: 11, metresReturned: 8.25,
              piecesReturned: 3, returnedOn: '20-Sep-2026', sentOn: '10-Sep-2026', sentOnTs: Date.now() - 5 * 86400000,
              invOutStatus: 'Posted', poNumber: '', poError: '',
              sendLines: [ { lineIndex: 0, lengthCm: 275, count: 4, rate: 90 } ] }
        ],
        rateHistory: [
            { printerId: '78', printerName: 'Sanwariya Prints', printedMaterialId: '20', printedSku: 'RM-100',
              lengthCm: 550, rate: 175, sentOn: '04-Aug-2026', jobNo: 'PJ-00012' },
            { printerId: '78', printerName: 'Sanwariya Prints', printedMaterialId: '20', printedSku: 'RM-100',
              lengthCm: 300, rate: 110, sentOn: '04-Aug-2026', jobNo: 'PJ-00012' },
            { printerId: '77', printerName: 'Zed Prints', printedMaterialId: '22', printedSku: 'RM-102',
              lengthCm: 550, rate: 160, sentOn: '01-Jul-2026', jobNo: 'PJ-00004' },
            { printerId: '78', printerName: 'Sanwariya Prints', printedMaterialId: '20', printedSku: 'RM-100',
              lengthCm: 550, rate: 150, sentOn: '01-Jan-2026', jobNo: 'PJ-00001' }
        ]
    }, over || {});
}

// The create form, opened, with rows in state AND drawn in the stub DOM so the
// readers see what a user would have typed.
function row(src, lot, state, tgt, len, count, rate, rateAuto) {
    return { src, lot, state, tgt, len: String(len == null ? '' : len), count: String(count == null ? '' : count),
             rate: String(rate == null ? '' : rate), rateAuto: !!rateAuto };
}
function openCreate(w, printer, rows) {
    w.sandbox.openPrintCreate();
    const pc = w.get('printCreate');
    pc.printer = printer;
    pc.rows = rows;
    w.el('pc-printer', { value: printer });
    w.el('pc-btn', {});
    rows.forEach((r, i) => {
        w.el('pc-src-' + i, { value: r.src }); w.el('pc-lot-' + i, { value: r.lot });
        w.el('pc-st-' + i, { value: r.state }); w.el('pc-tgt-' + i, { value: r.tgt });
        w.el('pc-len-' + i, { value: r.len }); w.el('pc-cnt-' + i, { value: r.count });
        w.el('pc-rate-' + i, { value: r.rate }); w.el('pc-hint-' + i, {});
        w.el('pc-mtr-' + i, {}); w.el('pc-amt-' + i, {});
    });
    return pc;
}
const body = w => JSON.parse(w.log.posts[0].payload.payloadJson);

// ===========================================================================
console.log('\nthe job-order screen');

test('L1 loadPrint reads PrintData and paints toolbar, create slot and orders', () => {
    const w = makeWorld(undefined, { loadResult: payload() });
    w.sandbox.loadPrint();
    const html = w.els['panel-print'].innerHTML;
    assert.ok(/print-toolbar/.test(html) && /print-orders/.test(html));
    assert.ok(/\+ Create print job/.test(html));
    assert.ok(!/Search fabric/.test(html), 'the fabric list is gone');
});

test('O1 jobs group into job orders by Print_Batch; open view shows only what is at the printer', () => {
    const w = makeWorld(payload());
    const orders = w.sandbox.printOrders();
    assert.deepStrictEqual(plain(orders.map(o => [o.batchNo, o.jobs.map(j => j.jobNo)])),
        [['PJ-00012', ['PJ-00012', 'PJ-00013']], ['PJ-00009', ['PJ-00009']]]);
    const html = w.sandbox.printJobsHtml();
    assert.ok(/PJ-00012 &middot; Sanwariya Prints/.test(html));
    assert.ok(!/PJ-00009 &middot;/.test(html), 'the received order is not in the open view');
});

test('O2 the order card sums its designs: pieces, metres, amount, PO', () => {
    const w = makeWorld(payload());
    const o = w.sandbox.printOrders()[0];
    assert.strictEqual(o.pieces, 11);                 // 4 + 2 + 5
    assert.strictEqual(o.metres, 47.5);
    assert.strictEqual(o.amount, 1575);               // 4x175 + 2x0 + 5x175
    const html = w.sandbox.printJobsHtml();
    assert.ok(/2 designs/.test(html) && /11 pieces &middot; 47\.5 Mtr/.test(html), html.slice(0, 900));
    assert.ok(/₹1575\.00/.test(html) && /PO-00042/.test(html));
    assert.ok(/At printer/.test(html));
});

test('O3 each design line names base, lot, state and its sizes with rates', () => {
    const w = makeWorld(payload());
    w.sandbox.printOrderOpen = 'PJ-00012';
    const html = w.sandbox.printJobsHtml();
    assert.ok(/from RM-001 lot L1 \(washed\)/.test(html));
    assert.ok(/4 × 300 cm @ ₹175\.00 · 2 × 400 cm/.test(html), 'unpriced size shows no rate');
    assert.ok(/onclick="togglePrintRecv\('900'\)">Receive/.test(html));
});

test('O4 Recent view shows the closed order with its outcome', () => {
    const w = makeWorld(payload());
    w.sandbox.setPrintView('recent');
    const html = w.sandbox.printJobsHtml();
    assert.ok(/PJ-00009 &middot; Zed Prints/.test(html));
    assert.ok(!/PJ-00012 &middot;/.test(html));
    assert.ok(/Received/.test(html));
    w.sandbox.printOrderOpen = 'PJ-00009';
    const open = w.sandbox.printJobsHtml();
    assert.ok(/3 of 4 pieces/.test(open) && /1 short, 2\.75 Mtr written off/.test(open), open);
});

test('O5 Recent hides orders closed more than 60 days ago, keeps undated ones', () => {
    const p = payload();
    p.jobs[2].sentOnTs = Date.now() - 90 * 86400000;
    const w = makeWorld(p);
    w.sandbox.setPrintView('recent');
    assert.ok(/No job orders closed/.test(w.sandbox.printJobsHtml()));
    p.jobs[2].sentOnTs = null;
    assert.ok(/PJ-00009/.test(w.sandbox.printJobsHtml()));
});

test('O6 a priced order with no PO shows the pill and a Raise PO for the batch', () => {
    const p = payload();
    p.jobs[0].poNumber = ''; p.jobs[1].poNumber = '';
    p.jobs[1].poError = 'Service item not found';
    const w = makeWorld(p);
    w.sandbox.printOrderOpen = 'PJ-00012';
    const html = w.sandbox.printJobsHtml();
    assert.ok(/No PO/.test(html));
    assert.ok(/Purchase order not raised &mdash; Service item not found/.test(html));
    w.el('pr-po-900', {});
    w.sandbox.retryPrintPO('900');
    assert.strictEqual(w.log.posts[0].api_name, 'raisePrintPO');
    assert.deepStrictEqual(plain(w.log.posts[0].payload), { batchNo: 'PJ-00012', dryRun: 'false' });
});

test('O7 an unpriced order asks for no PO', () => {
    const p = payload();
    p.jobs.forEach(j => { j.poNumber = ''; j.sendLines.forEach(l => { l.rate = 0; }); });
    const w = makeWorld(p);
    w.sandbox.printOrderOpen = 'PJ-00012';
    const html = w.sandbox.printJobsHtml();
    assert.ok(!/No PO/.test(html) && !/Raise PO/.test(html));
});

console.log('\ncreate form');

test('C1 Create opens a form with a printer select and one empty row; the toolbar button hides', () => {
    const w = makeWorld(payload());
    w.el('print-create', {}); w.el('print-toolbar', {});
    w.sandbox.openPrintCreate();
    assert.ok(/New print job/.test(w.els['print-create'].innerHTML));
    assert.ok(/Sanwariya Prints/.test(w.els['print-create'].innerHTML));
    assert.ok(/pc-src-0/.test(w.els['print-create'].innerHTML) && !/pc-src-1/.test(w.els['print-create'].innerHTML));
    assert.ok(!/Create print job<\/button>/.test(w.els['print-toolbar'].innerHTML.replace('id="pc-btn"', '')) ||
              !/print-create-btn/.test(w.els['print-toolbar'].innerHTML));
});

test('C2 a row offers only print fabrics at the base\'s width', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('12', '920', 'Unwash', '', '', '')]);   // White Cotton 147.32
    const html = w.sandbox.createRowHtml(w.get('printCreate').rows[0], 0);
    assert.ok(/RM-103 — Blue Stripes/.test(html));
    assert.ok(!/RM-100/.test(html) && !/RM-101/.test(html));
});

test('C3 picking a base defaults its lot to the first unblocked one with cloth in that state', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('', '', 'Wash', '', '', '')]);
    w.els['pc-src-0'].value = '10';
    w.el('pc-rows', {});
    w.sandbox.onCreateSelect(0, 'src');
    assert.strictEqual(w.get('printCreate').rows[0].lot, '901', 'L2 is blocked');
});

test('C4 + Add line copies base, lot, state and print fabric, not sizes or rate', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 550, 5, 175)]);
    w.el('pc-rows', {});
    w.sandbox.addCreateRow();
    const r = plain(w.get('printCreate').rows[1]);
    assert.deepStrictEqual([r.src, r.lot, r.state, r.tgt, r.len, r.count], ['10', '901', 'Wash', '20', '', '']);
});

test('C5 the job order may mix bases: one call, every row with its own base, lot, state and rate', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [
        row('10', '901', 'Wash', '20', 550, 3, 175),      // 16.5 + 16.5 of L1's 42.6 washed
        row('10', '901', 'Wash', '22', 550, 3, 175),
        row('12', '920', 'Unwash', '23', 275, 8, 90)
    ]);
    w.sandbox.submitCreatePrint();
    assert.strictEqual(w.log.posts.length, 1, w.log.alerts.join(' | '));
    assert.strictEqual(w.log.posts[0].api_name, 'sendToPrint');
    const b = body(w);
    assert.strictEqual(b.printerId, '78');
    assert.deepStrictEqual(plain(b.lines), [
        { sourceMaterialId: '10', sourceLotId: '901', sourceState: 'Wash', targetMaterialId: '20', lengthCm: 550, count: 3, rate: 175 },
        { sourceMaterialId: '10', sourceLotId: '901', sourceState: 'Wash', targetMaterialId: '22', lengthCm: 550, count: 3, rate: 175 },
        { sourceMaterialId: '12', sourceLotId: '920', sourceState: 'Unwash', targetMaterialId: '23', lengthCm: 275, count: 8, rate: 90 }
    ]);
    assert.strictEqual(w.log.confirms.length, 0, 'everything priced');
});

test('C6 no printer -> refused before the round trip', () => {
    const w = makeWorld(payload());
    openCreate(w, '', [row('10', '901', 'Wash', '20', 550, 5, 175)]);
    w.sandbox.submitCreatePrint();
    assert.strictEqual(w.log.posts.length, 0);
    assert.ok(/Choose the printer/.test(w.log.alerts.join(' ')));
});

test('C7 a blank added row is skipped; a half-filled one is refused by line number', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 550, 5, 175), row('', '', 'Wash', '', '', '')]);
    w.sandbox.submitCreatePrint();
    assert.strictEqual(w.log.posts.length, 1);
    const w2 = makeWorld(payload());
    openCreate(w2, '78', [row('10', '901', 'Wash', '20', 550, 5, 175), row('10', '901', 'Wash', '', 300, 2, '')]);
    w2.sandbox.submitCreatePrint();
    assert.strictEqual(w2.log.posts.length, 0);
    assert.ok(/Line 2: choose the print fabric/.test(w2.log.alerts.join(' ')), w2.log.alerts.join(' '));
});

test('C8 budget is per lot AND state: rows that fit alone but not together are refused', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 2500, 1, 100),     // 25 m
                         row('10', '901', 'Wash', '22', 2500, 1, 100)]);   // 25 m -> 50 > 42.6 washed
    w.sandbox.submitCreatePrint();
    assert.strictEqual(w.log.posts.length, 0);
    assert.ok(/Lot L1 of RM-001 needs 50 Mtr washed, has 42\.6/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

test('C9 washed and unwashed off one lot are budgeted separately', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 4000, 1, 100),     // 40 of 42.6 washed
                         row('10', '901', 'Unwash', '22', 800, 1, 100)]);  // 8 of 8 unwashed
    w.sandbox.submitCreatePrint();
    assert.strictEqual(w.log.posts.length, 1, w.log.alerts.join(' | '));
});

test('C10 the lot\'s rolls are cut for its TOTAL, shortest first, shown per lot', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 550, 2, 175),      // 11
                         row('10', '901', 'Unwash', '22', 300, 1, 175),    // 3
                         row('12', '920', 'Unwash', '23', 275, 4, 90)]);   // 11 off W1
    const uses = w.sandbox.createLotUse(w.get('printCreate').rows);
    assert.deepStrictEqual(plain(uses.map(u => [u.lot.lotNumber, u.wash, u.unwash, u.plan.cuts.map(c => [c.label, c.metres])])), [
        ['L1', 11, 3, [['L1-R1', 8], ['L1-R2', 6]]],
        ['W1', 0, 11, [['W1-R1', 11]]]
    ]);
    const html = w.sandbox.createCutsHtml();
    assert.ok(/RM-001 · lot L1/.test(html) && /Cut 8 off L1-R1, 6 off L1-R2/.test(html), html);
});

test('C11 an unpriced row asks first; no sends nothing', () => {
    const w = makeWorld(payload(), { confirmAnswer: false });
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 550, 3, 175), row('10', '901', 'Wash', '22', 550, 3, '')]);
    w.sandbox.submitCreatePrint();
    assert.strictEqual(w.log.posts.length, 0);
    assert.ok(/No rate on Line 2 \(RM-102, 550 cm\)/.test(w.log.confirms.join(' ')), w.log.confirms.join(' '));
    assert.ok(/will not be on the purchase order/.test(w.log.confirms.join(' ')));
});

test('C12 fractional pieces and a negative rate are refused', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 550, 2.5, 175)]);
    w.sandbox.submitCreatePrint();
    assert.ok(/whole number of pieces/.test(w.log.alerts.join(' ')));
    const w2 = makeWorld(payload());
    openCreate(w2, '78', [row('10', '901', 'Wash', '20', 550, 2, -1)]);
    w2.sandbox.submitCreatePrint();
    assert.ok(/rate must be a number/.test(w2.log.alerts.join(' ')));
    assert.strictEqual(w.log.posts.length + w2.log.posts.length, 0);
});

test('C13 the total line counts pieces, metres and the PO amount', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 550, 5, 175), row('12', '920', 'Unwash', '23', 275, 8, 90)]);
    const t = w.sandbox.createTotalHtml();
    assert.ok(/<b>13<\/b> pieces &middot; <b>49\.5<\/b> Mtr &middot; PO <b>₹1595\.00<\/b>/.test(t), t);
});

test('C14 after a create whose PO failed, it says so; the form closes and the new order opens', () => {
    const w = makeWorld(payload(), { apiResult: { success: true, inventory: 'Posted', batchNo: 'PJ-00014',
        jobs: [ { jobNo: 'PJ-00014' } ], poNumber: '', poError: 'no Inventory contact id', poNotPriced: false } });
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 550, 5, 175)]);
    w.sandbox.submitCreatePrint();
    assert.ok(/Job order PJ-00014 created, but the purchase order was NOT raised/.test(w.log.alerts.join(' | ')));
    assert.strictEqual(w.get('printCreate'), null);
    assert.strictEqual(w.get('printOrderOpen'), 'PJ-00014');
});

console.log('\nprice history — printer + design + piece length');

test('H1 lastPrintRate: exact = the NEWEST for printer + design + length; then same printer other size; then other printer', () => {
    const w = makeWorld(payload());
    const h = w.sandbox.lastPrintRate('78', '20', 550);
    assert.strictEqual(h.exact.rate, 175, 'newest, not the older 150');
    assert.strictEqual(h.otherSize.lengthCm, 300);
    const h2 = w.sandbox.lastPrintRate('78', '22', 550);
    assert.strictEqual(h2.exact, null);
    assert.strictEqual(h2.otherPrinter.printerName, 'Zed Prints');
});

test('H2 typing a length that has a price on file fills the rate and says when', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', '', 5, '')]);
    w.els['pc-len-0'].value = '550';
    w.sandbox.onCreateInput(0, 'len');
    assert.strictEqual(w.els['pc-rate-0'].value, '175.00');
    assert.ok(/last ₹175\.00\/pc · 04-Aug-2026/.test(w.els['pc-hint-0'].textContent), w.els['pc-hint-0'].textContent);
});

test('H3 a different SIZE of the same design is said, not filled', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', '', 5, '')]);
    w.els['pc-len-0'].value = '275';
    w.sandbox.onCreateInput(0, 'len');
    assert.strictEqual(w.els['pc-rate-0'].value, '');
    // the newest price this printer has for the design at ANOTHER length
    assert.ok(/this printer: ₹175\.00\/pc for 550 cm/.test(w.els['pc-hint-0'].textContent), w.els['pc-hint-0'].textContent);
    assert.strictEqual(w.els['pc-hint-0'].className, 'print-rate-hist is-other');
});

test('H4 a TYPED rate survives a printer change; an AUTO one is cleared when the new printer has none', () => {
    const w = makeWorld(payload());
    openCreate(w, '78', [row('10', '901', 'Wash', '20', 550, 5, ''), row('10', '901', 'Wash', '20', 550, 1, '')]);
    w.sandbox.onCreatePrinterChange();                        // both auto-fill 175
    assert.strictEqual(w.els['pc-rate-0'].value, '175.00');
    w.els['pc-rate-1'].value = '190';
    w.sandbox.onCreateInput(1, 'rate');                       // row 2 typed
    w.els['pc-printer'].value = '77';
    w.sandbox.onCreatePrinterChange();                        // Zed never printed RM-100
    assert.strictEqual(w.els['pc-rate-0'].value, '', 'auto-fill cleared');
    assert.strictEqual(w.els['pc-rate-1'].value, '190', 'typed rate kept');
});

console.log('\nreceive form');

test('RC1 receive has ONE row per piece, a Roll label column, no carton/width', () => {
    const w = makeWorld(payload());
    w.sandbox.printJobsHtml();      // seeds printRecvPieces
    const job = w.get('PRINT_DATA').jobs.find(j => j.jobId === '900');
    const html = w.sandbox.printReceiveFormHtml(job);
    assert.ok(!/Carton/.test(html), 'no carton column');
    assert.ok(/Roll label/.test(html), 'has a roll label column');
    assert.strictEqual((html.match(/pr-lbl-900-/g) || []).length, 6);   // 4 + 2 sent pieces
});

test('RC1b the receive form opens under its design only when Receive is pressed', () => {
    const w = makeWorld(payload());
    w.sandbox.printOrderOpen = 'PJ-00012';
    assert.ok(!/pr-lbl-900-0/.test(w.sandbox.printJobsHtml()));
    w.sandbox.printRecvOpen['900'] = true;
    const html = w.sandbox.printJobsHtml();
    assert.ok(/pr-lbl-900-0/.test(html) && !/pr-lbl-912-0/.test(html));
});

test('RC2 a piece with no label counts as lost; footer says pieces short', () => {
    const w = makeWorld(payload());
    w.sandbox.printRecvPieces['900'] = [
        { lineIndex: 0, len: 300, label: 'A', state: 'Wash' },
        { lineIndex: 0, len: 300, label: 'B', state: 'Wash' },
        { lineIndex: 0, len: 300, label: '',  state: 'Wash' },   // lost
        { lineIndex: 1, len: 400, label: 'C', state: 'Wash' },
        { lineIndex: 1, len: 400, label: '',  state: 'Wash' }    // lost
    ];
    const html = w.sandbox.recvFooterHtml(w.get('PRINT_DATA').jobs.find(j => j.jobId === '900'));
    assert.ok(/2 pieces short/.test(html), html);
});

test('RC3 receive posts pieces[] with lineIndex/label/state, no lines, no carton', () => {
    const w = makeWorld(payload());
    w.el('pr-lot-900', { value: '' });
    w.el('pr-num-900', { value: 'P2' });
    w.el('pr-btn-900', {});
    w.el('pr-lbl-900-0', { value: 'R-1' }); w.el('pr-st-900-0', { value: 'Wash' });
    w.el('pr-lbl-900-1', { value: 'R-2' }); w.el('pr-st-900-1', { value: 'Wash' });
    w.el('pr-lbl-900-2', { value: '' });    w.el('pr-st-900-2', { value: 'Wash' });   // lost
    w.el('pr-lbl-900-3', { value: 'R-4' }); w.el('pr-st-900-3', { value: 'Unwash' });
    w.el('pr-lbl-900-4', { value: '' });    w.el('pr-st-900-4', { value: 'Wash' });
    w.el('pr-lbl-900-5', { value: '' });    w.el('pr-st-900-5', { value: 'Wash' });
    w.sandbox.printRecvPieces['900'] = [0, 0, 0, 1, 1, 1].map(li =>
        ({ lineIndex: li, len: li ? 400 : 300, label: '', state: 'Wash' }));
    w.setConfirm(true);
    w.sandbox.submitReceivePrint('900');
    assert.strictEqual(w.log.posts.length, 1);
    const b = body(w);
    assert.strictEqual(b.lotNumber, 'P2');
    assert.strictEqual(b.lines, undefined);
    assert.deepStrictEqual(plain(b.pieces), [
        { lineIndex: 0, label: 'R-1', state: 'Wash' },
        { lineIndex: 0, label: 'R-2', state: 'Wash' },
        { lineIndex: 1, label: 'R-4', state: 'Unwash' }
    ]);
});

test('RC4 a duplicate roll label is blocked client-side', () => {
    const w = makeWorld(payload());
    w.el('pr-lot-900', { value: '' });
    w.el('pr-num-900', { value: 'P2' });
    w.el('pr-btn-900', {});
    w.el('pr-lbl-900-0', { value: 'DUP' }); w.el('pr-st-900-0', { value: 'Wash' });
    w.el('pr-lbl-900-1', { value: 'dup' }); w.el('pr-st-900-1', { value: 'Wash' });
    w.sandbox.printRecvPieces['900'] = [
        { lineIndex: 0, len: 300, label: '', state: 'Wash' },
        { lineIndex: 0, len: 300, label: '', state: 'Wash' }
    ];
    w.sandbox.submitReceivePrint('900');
    assert.strictEqual(w.log.posts.length, 0);
    assert.ok(/used twice/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

console.log('\ncancel');

test('CX1 "Came back unprinted" confirms as a new roll and posts cancelPrintJob', () => {
    const w = makeWorld(payload());
    w.el('pr-cancel-900', {});
    w.sandbox.submitCancelJob('900');
    assert.ok(/back onto lot L1 as a new roll/.test(w.log.confirms.join(' ')), w.log.confirms.join(' '));
    assert.strictEqual(w.log.posts.length, 1);
    assert.strictEqual(w.log.posts[0].api_name, 'cancelPrintJob');
});

// ---- report --------------------------------------------------------------
console.log('\n========================================');
console.log('print-tab-ui: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
