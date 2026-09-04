#!/usr/bin/env node
// The store History card's per-material merge (histMaterialGroups /
// histMaterialRows in app/js/main.js). One row per SKU; column 2 stacks a line
// per lot for fresh cloth, then a green line per offcut with size + lot +
// carton. Exercised in isolation via vm.
//
//   usage: node tools/store-history-merge.test.js

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

const ctx = {
  console: { log() {}, warn() {}, error() {} },
  escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c])),
  fmt: (n) => String(Math.round((Number(n) || 0) * 100) / 100),
};
vm.createContext(ctx);
vm.runInContext(
  grab('function histMaterialGroups(') + '\n' +
  grab('function histDistinctMaterialCount(') + '\n' +
  grab('function histMaterialRows(') + '\n' +
  'this.histMaterialGroups = histMaterialGroups;' +
  'this.histDistinctMaterialCount = histDistinctMaterialCount;' +
  'this.histMaterialRows = histMaterialRows;',
  ctx);

// ---- fixture: one handover, thread fanned across 6 plan-items on 2 lots,
// plus one fabric on 1 lot, plus 2 offcuts of that fabric.
function handover() {
  return {
    lines: [
      { material: 'DMC Thread', sku: 'RM-05', unit: 'Cone', lot: '', qty: 10 },
      { material: 'DMC Thread', sku: 'RM-05', unit: 'Cone', lot: '', qty: 10 },
      { material: 'DMC Thread', sku: 'RM-05', unit: 'Cone', lot: '', qty: 10 },
      { material: 'Linen 60"', sku: 'RM-01', unit: 'Mtr', lot: 'L1', qty: 12.5 },
      { material: 'Linen 60"', sku: 'RM-01', unit: 'Mtr', lot: 'L1', qty: 7.5 },
      { material: 'Linen 60"', sku: 'RM-01', unit: 'Mtr', lot: 'L3', qty: 4 },
    ],
    waste: [
      { material: 'Linen 60"', sku: 'RM-01', unit: 'Mtr', lot: 'L2', carton: 'C7', pieces: 3, cutWidth: 40, cutLength: 55 },
      { material: 'Linen 60"', sku: 'RM-01', unit: 'Mtr', lot: 'L2', carton: 'C7', pieces: 1, cutWidth: 40, cutLength: 55 },
    ],
  };
}

// ---- tests --------------------------------------------------------------
test('one group per SKU, SKU never repeats', () => {
  const g = ctx.histMaterialGroups(handover());
  assert.strictEqual(g.length, 2, 'DMC Thread + Linen');
  assert.strictEqual(ctx.histDistinctMaterialCount(handover()), 2);
});

test('fresh lines group by lot within a material, qty summed', () => {
  const linen = ctx.histMaterialGroups(handover()).find((x) => x.sku === 'RM-01');
  assert.strictEqual(linen.freshOrder.length, 2, 'L1 and L3');
  assert.strictEqual(linen.freshByLot['L1'].qty, 20, '12.5 + 7.5');
  assert.strictEqual(linen.freshByLot['L3'].qty, 4);
});

test('lotless fresh (thread) folds into one bucket', () => {
  const thr = ctx.histMaterialGroups(handover()).find((x) => x.sku === 'RM-05');
  assert.strictEqual(thr.freshOrder.length, 1);
  assert.strictEqual(thr.total, 30, '10+10+10');
});

test('offcuts attach to their SKU, carried as waste entries', () => {
  const linen = ctx.histMaterialGroups(handover()).find((x) => x.sku === 'RM-01');
  assert.strictEqual(linen.waste.length, 2);
  assert.strictEqual(linen.waste[0].carton, 'C7');
  assert.strictEqual(linen.waste[0].lot, 'L2');
  assert.strictEqual(linen.waste[1].pieces, 1);
});

test('render: one <tr> per material, 3 columns', () => {
  const html = ctx.histMaterialRows(handover());
  const rows = html.match(/<tr>/g) || [];
  assert.strictEqual(rows.length, 2);
  assert.ok(/RM-05/.test(html) && /RM-01/.test(html));
});

test('render: fresh lot lines stacked with per-lot qty', () => {
  const html = ctx.histMaterialRows(handover());
  assert.ok(/hist-lot[^>]*>L1<\/span> <span class="hist-src-qty">20/.test(html), 'L1 20 Mtr');
  assert.ok(/hist-lot[^>]*>L3<\/span> <span class="hist-src-qty">4/.test(html), 'L3 4 Mtr');
});

test('render: offcut line is green, shows size + lot + carton', () => {
  const html = ctx.histMaterialRows(handover());
  assert.ok(/hist-src-waste/.test(html), 'green waste line');
  assert.ok(/55 &times; 40<span class="unit">cm<\/span>/.test(html), 'size L x W');
  assert.ok(/Carton C7/.test(html));
  assert.ok(/hist-waste-where[^>]*>L2 &middot; Carton C7/.test(html), 'lot then carton');
});

test('render: total column = summed fresh qty for the material', () => {
  const html = ctx.histMaterialRows(handover());
  assert.ok(/col-strong">24<span class="unit">Mtr/.test(html), 'Linen total 20+4');
  assert.ok(/col-strong">30<span class="unit">Cone/.test(html), 'Thread total 30');
});

test('handover with no waste array still renders (fresh only)', () => {
  const h = handover();
  delete h.waste;
  const html = ctx.histMaterialRows(h);
  assert.ok(!/hist-src-waste/.test(html));
  assert.ok(/RM-01/.test(html));
});

test('empty handover -> placeholder row', () => {
  const html = ctx.histMaterialRows({ lines: [], waste: [] });
  assert.ok(/No lines on this handover/.test(html));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
