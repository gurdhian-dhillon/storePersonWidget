#!/usr/bin/env node
// The store widget's PRINT TAB (v2 — rolls, no minting, no pattern), exercised
// in a stub DOM via vm. The Print tab region of app/js/main.js is loaded
// VERBATIM between its markers, so a failure here names a real line of the
// widget.
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
            innerHTML: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} } }, props || {});
        return els[id];
    }
    el('panel-print', {});
    return { sandbox, els, el, log, get: n => sandbox[n], setConfirm: v => { confirmAnswer = v; } };
}

// ---- fixture payload, PrintData.load()'s shape ---------------------------
function payload(over) {
    return Object.assign({
        source: [
            { id: '10', name: 'Grey Sheeting', sku: 'RM-001', type: 'Plain Fabric', widthCm: 152.4,
              lots: [
                  { lotId: '901', lotNumber: 'L1', wash: 42.6, unwash: 8, inPrint: 0, blocked: false,
                    rolls: [
                        { rollId: 'r1', label: 'L1-R1', length: 8, status: 'Available', origin: 'Purchased' },
                        { rollId: 'r2', label: 'L1-R2', length: 34.6, status: 'Available', origin: 'Purchased' }
                    ] },
                  { lotId: '902', lotNumber: 'L2', wash: 100, unwash: 0, inPrint: 0, blocked: true, rolls: [] }
              ] },
            // a PLAIN fabric at the same width — with the Type filter off it is
            // an eligible target too
            { id: '12', name: 'Ecru Sheeting', sku: 'RM-003', type: 'Plain Fabric', widthCm: 152.4,
              lots: [ { lotId: '920', lotNumber: 'E1', wash: 5, unwash: 0, inPrint: 0, blocked: false, rolls: [] } ] }
        ],
        target: [
            { id: '20', name: 'Grey Block Print', sku: 'RM-100', type: 'printed fabric', widthCm: 152.4,
              lots: [ { lotId: '950', lotNumber: 'P1', wash: 5, unwash: 0, inPrint: 0, blocked: false, rolls: [] } ] },
            { id: '21', name: 'Wide Print', sku: 'RM-101', type: 'printed fabric', widthCm: 228.6, lots: [] }
        ],
        printers: [ { id: '77', name: 'Zed Prints' } ],
        jobs: [
            { jobId: '900', sourceMaterialId: '10', sourceName: 'Grey Sheeting', sourceSku: 'RM-001',
              sourceLotId: '901', sourceLotNumber: 'L1',
              printedMaterialId: '20', printedName: 'Grey Block Print', printedSku: 'RM-100',
              printerName: 'Zed Prints', sourceState: 'Wash', metresSent: 20, sentOn: '2026-09-01',
              jobStatus: 'At_Printer',
              sendLines: [ { lineIndex: 0, lengthCm: 300, count: 4 }, { lineIndex: 1, lengthCm: 400, count: 2 } ] }
        ]
    }, over || {});
}

// ===========================================================================
console.log('\nload');

test('L1 loadPrint reads PrintData and paints the panel', () => {
    const w = makeWorld(undefined, { loadResult: payload() });
    w.sandbox.loadPrint();
    assert.strictEqual(w.get('PRINT_DATA').source.length, 2);
    assert.ok(w.els['panel-print'].innerHTML.indexOf('print-list') !== -1);
});

console.log('\nsend form — target filter');

test('T1 target list is ANY fabric at the SAME width, minus self (Type filter OFF)', () => {
    const w = makeWorld(payload());
    const m = w.get('PRINT_DATA').source[0];       // RM-001, width 152.4
    const tgts = w.sandbox.targetsFor(m).map(t => t.sku).sort();
    // RM-100 (printed, 152.4) AND RM-003 (plain, 152.4). RM-101 is 228.6 -> out.
    // RM-001 itself -> out.
    assert.deepStrictEqual(tgts, ['RM-003', 'RM-100']);
});

test('T1b targets are deduped when a printed SKU is in both lists', () => {
    const w = makeWorld(payload({
        target: [ { id: '10', name: 'x', sku: 'RM-001', type: 'printed fabric', widthCm: 152.4, lots: [] } ]
    }));
    const m = Object.assign({}, w.get('PRINT_DATA').source[0], { id: '99', widthCm: 152.4 });
    const ids = w.sandbox.targetsFor(m).map(t => t.id);
    assert.strictEqual(new Set(ids).size, ids.length);
});

test('T2 send form HTML lists a matching SKU and has no pattern control', () => {
    const w = makeWorld(payload());
    const html = w.sandbox.printSendFormHtml(w.get('PRINT_DATA').source[0]);
    assert.ok(/RM-100 — Grey Block Print/.test(html), html.slice(0, 400));
    assert.ok(!/Pattern/.test(html), 'no pattern control');
    assert.ok(!/creates a new material/.test(html), 'no minting note');
});

test('T3 no fabric at a width says so', () => {
    const w = makeWorld(payload());
    const m = Object.assign({}, w.get('PRINT_DATA').source[0], { widthCm: 999 });
    const html = w.sandbox.printSendFormHtml(m);
    assert.ok(/No fabric on record/.test(html), html.slice(0, 300));
});

console.log('\nsend form — roll plan');

test('P1 auto plan is shortest roll first', () => {
    const w = makeWorld(payload());
    w.el('ps-lot-10', { value: '901' });
    w.el('ps-state-10', { value: 'Wash' });
    w.sandbox.printSendLines['10'] = [{ len: '300', count: '4' }];   // 12 m
    const plan = w.sandbox.autoRollPlan(w.get('PRINT_DATA').source[0]);
    assert.deepStrictEqual(plain(plan.map(p => [p.label, p.metres])), [['L1-R1', 8], ['L1-R2', 4]]);
});

test('P2 roll plan HTML shows the cut instruction', () => {
    const w = makeWorld(payload());
    w.el('ps-lot-10', { value: '901' });
    w.el('ps-state-10', { value: 'Wash' });
    w.sandbox.printSendLines['10'] = [{ len: '300', count: '4' }];
    const html = w.sandbox.rollPlanHtml(w.get('PRINT_DATA').source[0]);
    assert.ok(/L1-R1/.test(html) && /L1-R2/.test(html), html.slice(0, 400));
    assert.ok(/shortest roll first/.test(html));
});

test('P3 send blocked when an edited plan does not total the metres', () => {
    const w = makeWorld(payload());
    w.el('ps-lot-10', { value: '901' });
    w.el('ps-state-10', { value: 'Wash' });
    w.el('ps-tgt-10', { value: '20' });
    w.el('ps-printer-10', { value: '77' });
    w.el('ps-btn-10', {});
    w.sandbox.printSendLines['10'] = [{ len: '300', count: '4' }];   // 12 m needed
    w.sandbox.printSendPlan['10'] = { r1: '8', r2: '1' };            // totals 9
    w.el('ps-len-10-0', { value: '300' }); w.el('ps-cnt-10-0', { value: '4' });
    w.sandbox.submitSendToPrint('10');
    assert.strictEqual(w.log.posts.length, 0);
    assert.ok(/cut plan totals/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

test('P4 clean send posts sourceMaterialId/targetMaterialId and no rollPlan when untouched', () => {
    const w = makeWorld(payload());
    w.el('ps-lot-10', { value: '901' });
    w.el('ps-state-10', { value: 'Wash' });
    w.el('ps-tgt-10', { value: '20' });
    w.el('ps-printer-10', { value: '77' });
    w.el('ps-btn-10', {});
    w.el('ps-len-10-0', { value: '300' }); w.el('ps-cnt-10-0', { value: '3' });
    w.sandbox.printSendLines['10'] = [{ len: '300', count: '3' }];
    w.sandbox.submitSendToPrint('10');
    assert.strictEqual(w.log.posts.length, 1);
    const body = JSON.parse(w.log.posts[0].payload.payloadJson);
    assert.strictEqual(body.sourceMaterialId, '10');
    assert.strictEqual(body.targetMaterialId, '20');
    assert.strictEqual(body.rollPlan, undefined);
    assert.deepStrictEqual(plain(body.lines), [{ lengthCm: 300, count: 3 }]);
});

test('P5 send refuses over-draw before the round trip', () => {
    const w = makeWorld(payload());
    w.el('ps-lot-10', { value: '901' });   // L1 wash 42.6
    w.el('ps-state-10', { value: 'Wash' });
    w.el('ps-tgt-10', { value: '20' });
    w.el('ps-printer-10', { value: '77' });
    w.el('ps-btn-10', {});
    w.el('ps-len-10-0', { value: '5000' }); w.el('ps-cnt-10-0', { value: '1' });  // 50 m
    w.sandbox.printSendLines['10'] = [{ len: '5000', count: '1' }];
    w.sandbox.submitSendToPrint('10');
    assert.strictEqual(w.log.posts.length, 0);
    assert.ok(/more cloth than the lot holds/.test(w.log.alerts.join(' ')));
});

console.log('\nreceive form');

test('RC1 receive has ONE row per piece, a Roll label column, no carton/width', () => {
    const w = makeWorld(payload());
    // seed printRecvPieces via printJobsHtml
    w.sandbox.printJobsHtml();
    const html = w.sandbox.printReceiveFormHtml(w.get('PRINT_DATA').jobs[0]);
    assert.ok(!/Carton/.test(html), 'no carton column');
    assert.ok(/Roll label/.test(html), 'has a roll label column');
    // 4 + 2 = 6 sent pieces -> 6 label inputs
    const n = (html.match(/pr-lbl-900-/g) || []).length;
    assert.strictEqual(n, 6);
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
    const html = w.sandbox.recvFooterHtml(w.get('PRINT_DATA').jobs[0]);
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
    w.sandbox.printRecvPieces['900'] = [
        { lineIndex: 0, len: 300, label: '', state: 'Wash' },
        { lineIndex: 0, len: 300, label: '', state: 'Wash' },
        { lineIndex: 0, len: 300, label: '', state: 'Wash' },
        { lineIndex: 1, len: 400, label: '', state: 'Wash' },
        { lineIndex: 1, len: 400, label: '', state: 'Wash' }
    ];
    // the payload fixture sends 4+2 pieces; align the state array length
    w.sandbox.printRecvPieces['900'].push({ lineIndex: 1, len: 400, label: '', state: 'Wash' });
    w.setConfirm(true);
    w.sandbox.submitReceivePrint('900');
    assert.strictEqual(w.log.posts.length, 1);
    const body = JSON.parse(w.log.posts[0].payload.payloadJson);
    assert.strictEqual(body.lotNumber, 'P2');
    assert.strictEqual(body.lines, undefined);
    assert.deepStrictEqual(plain(body.pieces), [
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
