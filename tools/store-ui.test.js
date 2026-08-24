#!/usr/bin/env node
// Store-screen waste checkbox + pcs input, exercised in a stub DOM via vm.
// Covers the decline feedback loop the docs describe ("Untick it and the cloth
// has to make up the difference", "reduced the count on"):
//
//   usage: node tools/store-ui.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- load the real allocator (owns wasteDeclined / wasteAllowed) --------------
const allocSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');

// ---- extract the waste-row functions from main.js ------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');
function extract(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has function ' + name +
    ' - the UI test contract changed; update tools/store-ui.test.js');
  let depth = 0, j = mainSrc.indexOf('{', i);
  for (let k = j; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i, j);
}
const fns = ['wastePicks', 'wasteCheckboxId', 'wasteInputId', 'wasteRowId',
             'wasteCheckedFor', 'rackCountFor',
             'setWasteChecked', 'onWasteCheckboxChange', 'onWasteInputChange']
  .map(extract).join('\n');

// ---- stub DOM + world ----------------------------------------------------------
function makeWorld() {
  // One fabric material shaped as the server sends it: wastePicks EMPTY (the
  // allocator owns that list once applyLotAllocation runs). Remnant W1 has 3
  // on the rack, each yielding floor(120/55)*floor(115/55)=4 cuts of 55x55 -
  // enough to cover the whole 10-piece demand, so the pick is waste-only.
  const mat = {
    materialId: 'M1', isFabric: true, material: 'Linen / Test', sku: 'FAB',
    fabricWidthCm: 137.16, cutWidth: 55, cutLength: 55,
    requiredPieces: 10, issuedPieces: 0,
    freshMeters: 0, remaining: 0, availableStock: 10,
    wasteStock: [{ wasteId: 'W1', width: 120, length: 115, pieces: 3, lotId: 'L1', lot: 'L1', carton: '' }],
    wastePicks: [],
    lines: [{ planId: 'PL1', salesOrder: 'SO-1', planItemId: 'IT1', item: 'X', isRemake: false,
              required: 5.5, issued: 0, reqPieces: 10, issPieces: 0, issuedLot: '', issuedLotNo: '', reason: '' }],
    lots: [{ lotId: 'L1', lotNumber: 'L1', blocked: false, wash: 5, unwash: 0, inWash: 0, form: 'Roll', pieces: [] }],
  };
  const els = {};
  const documentStub = {
    getElementById: function (id) { return els[id] || null; },
  };
  const state = { renderCalls: 0, refreshCalls: 0 };
  const sandbox = {
    document: documentStub,
    console,
    Math, Number, String, Object, parseInt, isNaN,
    wasteDeclined: {},
    window: { __reqData: [ { materials: [mat] } ], __rawData: null },
    render: function (d) {
      state.renderCalls++;
      // The real render re-runs the allocator BEFORE repainting (a decline
      // re-sizes picks and fresh metres), so the stub must too. Resolved off
      // the sandbox - this closure lives in the Node realm.
      applyLotAllocationFn(d || window.__reqData);
      // Mirror what the real render draws, so the test asserts the CONTRACT:
      // checkbox <- wasteCheckedFor(pick); pcs input <- pick.pieces.
      (d || window.__reqData).forEach(function (sup) {
        sup.materials.forEach(function (m, mi) {
          wastePicksFn(m).forEach(function (p, pi) {
            const cb = els[wasteCheckboxIdFn(0, mi, pi)];
            const inp = els[wasteInputIdFn(0, mi, pi)];
            if (cb) cb.checked = wasteCheckedForFn(p);
            if (inp) inp.value = p.pieces;
          });
        });
      });
    },
    refreshCardState: function () { state.refreshCalls++; },
  };
  vm.createContext(sandbox);
  vm.runInContext(allocSrc + '\n' + fns, sandbox);
  const api = {
    wastePicksFn: n => sandbox['wastePicks'], 
  };
  // grab function refs for the render stub (hoisted inside sandbox)
  sandbox.vmRun = vm.runInContext;
  const get = n => sandbox[n];
  const wastePicksFn = get('wastePicks');
  const wasteCheckboxIdFn = get('wasteCheckboxId');
  const wasteInputIdFn = get('wasteInputId');
  const wasteCheckedForFn = get('wasteCheckedFor');
  const applyLotAllocationFn = get('applyLotAllocation');

  function el(id, props) {
    els[id] = Object.assign({ checked: true, value: '0', disabled: false,
      classList: { toggle() {} } }, props || {});
    return els[id];
  }
  // Build the two widgets the handlers address.
  const cb = el(wasteCheckboxIdFn(0, 0, 0));
  const inp = el(wasteInputIdFn(0, 0, 0));
  const w = { sandbox, get, mat, els, state, cb, inp,
           onWasteCheckboxChange: get('onWasteCheckboxChange'),
           onWasteInputChange: get('onWasteInputChange'),
           setWasteChecked: get('setWasteChecked'),
           wasteDeclined: () => sandbox.wasteDeclined };
  // Initial paint, exactly as the screen builds it.
  sandbox.render(sandbox.window.__reqData);
  return w;
}

test('U1 a fresh pick renders CHECKED with its allocated count', () => {
  const w = makeWorld();
  assert.strictEqual(w.cb.checked, true);
  assert.strictEqual(String(w.inp.value), '3', 'allocation took all 3 rack pieces');
});

test('U2 UNCHECK declines: checkbox re-renders UNTICKED at 0, state declined to 0', () => {
  const w = makeWorld();
  w.cb.checked = false;                       // the browser toggles it first
  w.onWasteCheckboxChange(0, 0, 0);
  assert.strictEqual(w.wasteDeclined().W1, 0);
  assert.strictEqual(w.cb.checked, false, 'declined remnant must render UNTICKED');
  assert.strictEqual(String(w.inp.value), '0');
});

test('U3 typing while declined is accepted up to the RACK count (not the 0 pick)', () => {
  const w = makeWorld();
  w.cb.checked = false; w.onWasteCheckboxChange(0, 0, 0);
  w.inp.value = '2'; w.onWasteInputChange(0, 0, 0);
  assert.strictEqual(w.wasteDeclined().W1, 2, 'typed 2 must stick');
  assert.strictEqual(String(w.inp.value), '2');
  // Above the rack clamps to the rack (3) — and the full rack IS no decline,
  // same semantics as U5.
  w.inp.value = '9'; w.onWasteInputChange(0, 0, 0);
  assert.strictEqual(w.wasteDeclined().W1, undefined, 'full rack = allowance withdrawn');
  assert.strictEqual(String(w.inp.value), '3');
});

test('U4 typing while declined NEVER silently restores the full allowance', () => {
  const w = makeWorld();
  w.cb.checked = false; w.onWasteCheckboxChange(0, 0, 0);
  w.inp.value = '2'; w.onWasteInputChange(0, 0, 0);
  assert.strictEqual(w.wasteDeclined().W1, 2, 'a re-type of the same figure must not un-decline');
  w.inp.value = '1'; w.onWasteInputChange(0, 0, 0);
  assert.strictEqual(w.wasteDeclined().W1, 1);
});

test('U5 typing the FULL rack count is equivalent to no decline at all', () => {
  const w = makeWorld();
  w.cb.checked = false; w.onWasteCheckboxChange(0, 0, 0);
  w.inp.value = '3'; w.onWasteInputChange(0, 0, 0);
  assert.strictEqual(w.wasteDeclined().W1, undefined, 'full rack = allowance withdrawn');
});

test('U6 re-CHECK clears the decline and the render follows', () => {
  const w = makeWorld();
  w.cb.checked = false; w.onWasteCheckboxChange(0, 0, 0);
  w.cb.checked = true; w.onWasteCheckboxChange(0, 0, 0);
  assert.strictEqual(w.wasteDeclined().W1, undefined);
  assert.strictEqual(w.cb.checked, true);
  assert.strictEqual(String(w.inp.value), '3');   // allocation restored the full 3
});

test('U7 the render contract reads the decline (checkbox derived, never hardcoded)', () => {
  const w = makeWorld();
  w.cb.checked = false; w.onWasteCheckboxChange(0, 0, 0);
  // Force a render the way Refresh would:
  w.sandbox.window.__rawData = w.sandbox.window.__reqData;
  w.get('render') ? null : null;
  w.sandbox.render(w.sandbox.window.__reqData);
  assert.strictEqual(w.cb.checked, false);
});
