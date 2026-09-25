#!/usr/bin/env node
// ---- DAMAGE DIALOG: ONE SPOILED GARMENT CAN BE TWO PIECES OF ONE CLOTH ----
//
// A fabric BOM row may need more than one cut of its size per item - a duvet
// set's two pillow fronts. buildItemRequirements now plans pcs = items x perItem
// (BOM Required_Quantity on a fabric row) and getDamageProposal carries perItem
// through. The dialog's per-row "Pieces spoiled" is counted in THAT ROW's cut
// pieces, so for a pillow row one ruined set must seed 2, and the cap must be
// garments lost x 2 - otherwise he cannot even type the truth.
//
// Runs the real app/supervisor/js/reissue.js in a vm with a stub DOM and reads
// back the rendered inputs.
//
//   usage: node tools/damage-pieces-per-item.test.js

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function load() {
    const els = {};
    const el = (id) => els[id] || (els[id] = { id: id, innerHTML: '', value: '', addEventListener() {} });
    const ctx = {
        console: console,
        alert() {},
        document: {
            getElementById: el,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {}
        },
        window: {},
        // Globals shell.js / receive.js define for the page.
        TAB_LOADERS: {},
        escapeHtml: (s) => String(s == null ? '' : s),
        round2: (n) => Math.round((Number(n) || 0) * 100) / 100,
        fmt: (n) => String(Math.round((Number(n) || 0) * 100) / 100)
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'supervisor', 'js', 'reissue.js'), 'utf8'), ctx);
    return { ctx: ctx, el: el };
}

// value="" and max="" of every .dmg-pcs input, in row order.
function pcsInputs(html) {
    const out = [];
    const re = /<input type="number" class="dmg-pcs"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) {
        const tag = m[0];
        const attr = (n) => { const a = new RegExp(' ' + n + '="([^"]*)"').exec(tag); return a ? a[1] : null; };
        out.push({ i: +attr('data-i'), max: attr('max') === null ? null : +attr('max'), value: +attr('value') });
    }
    return out;
}
function qtyInputs(html) {
    const out = [];
    const re = /class="dmg-qty" data-i="(\d+)"[^>]*? value="([\d.]+)"/g;
    let m;
    while ((m = re.exec(html))) out.push(+m[2]);
    return out;
}

// DCBPEVA-5IND-1 as getDamageProposal would return it for qty = 1 set, 124" cloth.
function duvetMaterials() {
    return [
        { matId: '1', name: 'Riva',          isFab: true,  unit: 'Mtr',  qty: 2.44, pieces: 1, cutLen: 244, cutWid: 264, perRow: 1, perUnit: 0, perItem: 1 },
        { matId: '2', name: 'Maris Mustard', isFab: true,  unit: 'Mtr',  qty: 2.79, pieces: 1, cutLen: 279, cutWid: 264, perRow: 1, perUnit: 0, perItem: 1 },
        { matId: '1', name: 'Riva',          isFab: true,  unit: 'Mtr',  qty: 0.80, pieces: 2, cutLen: 80,  cutWid: 50,  perRow: 6, perUnit: 0, perItem: 2 },
        { matId: '2', name: 'Maris Mustard', isFab: true,  unit: 'Mtr',  qty: 0.95, pieces: 2, cutLen: 95,  cutWid: 50,  perRow: 6, perUnit: 0, perItem: 2 },
        { matId: '3', name: 'Thread',        isFab: false, unit: 'Cone', qty: 0.1,  pieces: 0, cutLen: 0,   cutWid: 0,   perRow: 0, perUnit: 0.1, perItem: 1 }
    ];
}

function render(env, garments, maxPieces) {
    env.ctx.damageCtx = {
        plan: {}, item: { id: 'x' }, materials: duvetMaterials(),
        phaseName: 'Stitching', stageLogId: '', maxPieces: maxPieces, pieces: garments
    };
    vm.runInContext('renderDamageProposal()', env.ctx);
    return env.el('dmg-mats').innerHTML;
}

console.log('\ndamage dialog - pieces per item');

test('1 set lost at a stage: pillow rows seed and cap at 2, duvet rows at 1', () => {
    const html = render(load(), 1, 1);
    const p = pcsInputs(html);
    assert.deepStrictEqual(p.map(r => r.value), [1, 1, 2, 2, 1]);
    assert.deepStrictEqual(p.map(r => r.max), [1, 1, 2, 2, 1]);
});

test('seeded quantity is worked from the row\'s own pieces (2 pillow fronts = 1 row = 0.80 m)', () => {
    const q = qtyInputs(render(load(), 1, 1));
    assert.deepStrictEqual(q, [2.44, 2.79, 0.8, 0.95, 0.1]);
});

test('4 sets lost: pillow rows 8 pieces = 2 rows of 6', () => {
    const html = render(load(), 4, 4);
    assert.deepStrictEqual(pcsInputs(html).map(r => r.value), [4, 4, 8, 8, 4]);
    assert.deepStrictEqual(qtyInputs(html), [9.76, 11.16, 1.6, 1.9, 0.4]);
});

test('Report damage (no stage count) has no cap on any row', () => {
    const html = render(load(), 1, -1);
    assert.ok(pcsInputs(html).every(r => r.max === null));
});

test('a proposal from an old server (no perItem) behaves exactly as before', () => {
    const env = load();
    env.ctx.damageCtx = {
        plan: {}, item: { id: 'x' }, maxPieces: 3, pieces: 3,
        materials: duvetMaterials().map(m => { const c = Object.assign({}, m); delete c.perItem; return c; })
    };
    vm.runInContext('renderDamageProposal()', env.ctx);
    const p = pcsInputs(env.el('dmg-mats').innerHTML);
    assert.deepStrictEqual(p.map(r => r.value), [3, 3, 3, 3, 3]);
    assert.deepStrictEqual(p.map(r => r.max), [3, 3, 3, 3, 3]);
});

test('perItem on a non-fabric row is ignored (thread counts garments)', () => {
    const env = load();
    vm.runInContext('damageCtx = { maxPieces: 5 };', env.ctx);
    assert.strictEqual(vm.runInContext('rowSeedFor({ isFab: false, perItem: 3 }, 2)', env.ctx), 2);
    assert.strictEqual(vm.runInContext('rowCapFor({ isFab: false, perItem: 3 })', env.ctx), 5);
});

console.log('\ndamage-pieces-per-item: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
