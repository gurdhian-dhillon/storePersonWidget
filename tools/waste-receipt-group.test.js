#!/usr/bin/env node
// The store waste-receipt list (app/js/main.js): rows are sorted so the same
// fabric's remnants sit together, the sales-order / plan-number line is gone,
// and the carton autofill stays within one fabric. Exercised in isolation via
// vm.
//
//   usage: node tools/waste-receipt-group.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');

function grab(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error('not found: ' + sig);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + sig);
}

// The sort lives inline in loadWasteReceipt. Pull just that expression out by
// re-implementing the exact comparator the file uses, then assert the file
// still contains it (guards against the sort being removed).
function sortLikeWidget(pieces) {
  return pieces
    .map(function (p, i) { return { p: p, i: i }; })
    .sort(function (a, b) {
      var ka = String(a.p.materialId || '') + ' ' + String(a.p.material || '');
      var kb = String(b.p.materialId || '') + ' ' + String(b.p.material || '');
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a.i - b.i;
    })
    .map(function (x) { return x.p; });
}

function makeCtx(pending) {
  const boxes = {};
  pending.forEach(function (_p, i) { boxes['wr-carton-' + i] = { value: '' }; });
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    wastePending: pending,
    wasteRecvEdit: false,
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c])),
    fmt: (n) => String(Math.round((Number(n) || 0) * 100) / 100),
    document: { getElementById(id) { return boxes[id] || null; } },
    wasteRecvGotId: (i) => 'wr-got-' + i,
    wasteRecvShortId: (i) => 'wr-short-' + i,
    wasteRecvNoteId: (i) => 'wr-note-' + i,
    wasteRecvCartonId: (i) => 'wr-carton-' + i,
    wasteRecvCarton(i) {
      const b = boxes['wr-carton-' + i];
      return b ? String(b.value).trim() : '';
    },
    _boxes: boxes,
  };
  vm.createContext(ctx);
  vm.runInContext(
    grab('function wastePendingHtml(') + '\n' +
    grab('function onWasteCartonInput(') + '\n' +
    'this.wastePendingHtml = wastePendingHtml; this.onWasteCartonInput = onWasteCartonInput;',
    ctx);
  return ctx;
}

// ---- fixtures ---------------------------------------------------------------
// Deliberately interleaved by fabric, as the server (Added_Time order) can
// return them.
function interleaved() {
  return [
    { id: '1', materialId: '901', material: 'Linen / Chambray / Olive', count: 1, length: 1370, width: 127.96, lot: 'L1', supervisor: 'Vivek', declaredOn: '02-Sep-2026' },
    { id: '2', materialId: '900', material: 'Linen / Solid / Dusty Gold', count: 1, length: 1460, width: 131.94, lot: 'L1', supervisor: 'Vivek', declaredOn: '02-Sep-2026' },
    { id: '3', materialId: '901', material: 'Linen / Chambray / Olive', count: 1, length: 685, width: 127.96, lot: 'L1', supervisor: 'Vivek', declaredOn: '02-Sep-2026' },
  ];
}

// ---- tests ----------------------------------------------------------------
test('the widget file still sorts the pending list by fabric', () => {
  assert.ok(
    src.indexOf('Sort so the same fabric') !== -1 &&
    src.indexOf('String(a.p.materialId') !== -1,
    'the fabric-grouping sort is present in loadWasteReceipt');
});

test('sort groups same-fabric rows together, stable within a fabric', () => {
  const out = sortLikeWidget(interleaved());
  assert.deepStrictEqual(out.map((p) => p.id), ['2', '1', '3'],
    'Gold (900) first, then the two Olive (901) in their original order');
});

test('render: no sales-order or plan-number text, declared-by line kept', () => {
  const ctx = makeCtx(sortLikeWidget(interleaved()));
  const html = ctx.wastePendingHtml();
  assert.ok(!/SO-|PLAN-|salesOrder|planNo/.test(html), 'no order/plan text');
  assert.ok(/from Vivek · 02-Sep-2026/.test(html), 'declared-by line kept');
});

test('render: no group headers / accordion — just a plain table', () => {
  const ctx = makeCtx(sortLikeWidget(interleaved()));
  const html = ctx.wastePendingHtml();
  assert.ok(!/waste-group-row|waste-fabric|toggleWasteFabric/.test(html));
  assert.ok(/<th>Piece<\/th>/.test(html), 'the original Piece column header');
});

test('render: every row keeps its flat-index carton input', () => {
  const ctx = makeCtx(sortLikeWidget(interleaved()));
  const html = ctx.wastePendingHtml();
  assert.ok(/id="wr-carton-0"/.test(html));
  assert.ok(/id="wr-carton-1"/.test(html));
  assert.ok(/id="wr-carton-2"/.test(html));
});

test('carton autofill fills the rest of the SAME fabric only', () => {
  const ctx = makeCtx(sortLikeWidget(interleaved())); // [Gold, Olive, Olive]
  ctx._boxes['wr-carton-1'].value = 'C7';
  ctx.onWasteCartonInput(1);
  assert.strictEqual(ctx._boxes['wr-carton-2'].value, 'C7', 'second Olive filled');
  assert.strictEqual(ctx._boxes['wr-carton-0'].value, '', 'Gold row above untouched');
});

test('carton autofill stops at the next fabric', () => {
  const p = sortLikeWidget([
    { id: 'a', materialId: '901', material: 'Olive', count: 1, length: 1, width: 1, lot: 'L1', supervisor: 'V', declaredOn: 'x' },
    { id: 'b', materialId: '901', material: 'Olive', count: 1, length: 1, width: 1, lot: 'L1', supervisor: 'V', declaredOn: 'x' },
    { id: 'c', materialId: '902', material: 'Sylph', count: 1, length: 1, width: 1, lot: 'L1', supervisor: 'V', declaredOn: 'x' },
  ]);
  const ctx = makeCtx(p);
  ctx._boxes['wr-carton-0'].value = 'C1';
  ctx.onWasteCartonInput(0);
  assert.strictEqual(ctx._boxes['wr-carton-1'].value, 'C1', 'sibling Olive filled');
  assert.strictEqual(ctx._boxes['wr-carton-2'].value, '', 'Sylph not filled');
});

test('empty list renders the one-liner, no table', () => {
  const ctx = makeCtx([]);
  const html = ctx.wastePendingHtml();
  assert.ok(/waste-none/.test(html));
  assert.ok(!/<table/.test(html));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
