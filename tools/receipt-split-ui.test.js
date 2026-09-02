#!/usr/bin/env node
// The "Material you received" card's per-item split
// (supReceiptRows / renderSupReceipts in app/supervisor/js/tabs.js), exercised
// in isolation via vm. Covers the double roll-up (by material, then by item),
// the "single unnamed bucket -> no split shown" suppression, and that the main
// per-material row is unchanged.
//
//   usage: node tools/receipt-split-ui.test.js

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

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'supervisor', 'js', 'tabs.js'), 'utf8');

// Pull just the two functions we need, plus their one helper dependency.
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
  // Mirrors receive.js: known code -> label, unknown/empty -> spaced or ''.
  itemStatusLabel: (s) => ({
    Awaiting_Material: 'No material yet',
    Ready_For_Production: 'Ready',
    In_Production: 'In production',
    Awaiting_Check: 'Awaiting check',
    Complete: 'Complete',
  })[s] || (s || '').replace(/_/g, ' '),
};
vm.createContext(ctx);
vm.runInContext(
  grab('function supReceiptRows(') + '\n' +
  grab('function renderSupReceipts(') + '\n' +
  'this.supReceiptRows = supReceiptRows; this.renderSupReceipts = renderSupReceipts;',
  ctx);

// ---- fixtures -------------------------------------------------------------
// One handover, one material (thread) fanned across two items + a plain fabric
// line with no item, plus a second material that went entirely to one unnamed
// bucket (pre-Plan_Item handover).
function receiptsFixture() {
  return [{
    time: '09:15', status: 'Issued',
    lines: [
      { material: 'DMC Thread', unit: 'Cone', qty: 3, itemName: 'Napkins', itemStatus: 'In_Production' },
      { material: 'DMC Thread', unit: 'Cone', qty: 2, itemName: 'Runners', itemStatus: 'Complete' },
      { material: 'DMC Thread', unit: 'Cone', qty: 1, itemName: 'Napkins', itemStatus: 'In_Production' },
      { material: 'Cotton 60in', unit: 'Mtr', qty: 40, itemName: '', itemStatus: '' },
    ],
  }];
}

// ---- tests -------------------------------------------------------------
test('roll-up: one row per (material,unit), qty summed', () => {
  const rows = ctx.supReceiptRows(receiptsFixture());
  assert.strictEqual(rows.length, 2, 'two material rows');
  const thread = rows.find((r) => r.material === 'DMC Thread');
  assert.strictEqual(thread.qty, 6, 'thread qty 3+2+1');
  const cotton = rows.find((r) => r.material === 'Cotton 60in');
  assert.strictEqual(cotton.qty, 40);
});

test('split: thread groups by item, same item merged', () => {
  const rows = ctx.supReceiptRows(receiptsFixture());
  const thread = rows.find((r) => r.material === 'DMC Thread');
  assert.strictEqual(thread.forItems.length, 2, 'Napkins + Runners');
  const nap = thread.forItems.find((x) => x.name === 'Napkins');
  assert.strictEqual(nap.qty, 4, 'Napkins 3+1 merged');
  assert.strictEqual(nap.status, 'In_Production');
  const run = thread.forItems.find((x) => x.name === 'Runners');
  assert.strictEqual(run.qty, 2);
});

test('suppression: a material with only one unnamed bucket shows no split', () => {
  const rows = ctx.supReceiptRows(receiptsFixture());
  const cotton = rows.find((r) => r.material === 'Cotton 60in');
  assert.strictEqual(cotton.forItems.length, 0, 'no split rows for the blank bucket');
});

test('mixed: a material split between a named item and a blank bucket keeps both', () => {
  const rows = ctx.supReceiptRows([{
    time: '10:00', status: 'Received',
    lines: [
      { material: 'Label', unit: 'Pcs', qty: 100, itemName: 'Napkins', itemStatus: 'Complete' },
      { material: 'Label', unit: 'Pcs', qty: 20, itemName: '', itemStatus: '' },
    ],
  }]);
  const label = rows[0];
  assert.strictEqual(label.forItems.length, 2);
  assert.strictEqual(label.forItems.find((x) => x.name === '').qty, 20);
});

test('render: split sub-rows appear under the material, labelled', () => {
  const html = ctx.renderSupReceipts(receiptsFixture());
  assert.ok(/recv-split-row/.test(html), 'a split row is rendered');
  assert.ok(/&rarr; Napkins/.test(html), 'Napkins sub-row');
  assert.ok(/&rarr; Runners/.test(html), 'Runners sub-row');
  assert.ok(/In production/.test(html), 'status label mapped, not the raw code');
  // The blank-bucket material must NOT get a "-> Unassigned" row (suppressed).
  assert.ok(!/Unassigned/.test(html), 'no Unassigned row for the suppressed bucket');
});

test('render: main per-material row is unchanged (qty + unit + status pill)', () => {
  const html = ctx.renderSupReceipts(receiptsFixture());
  assert.ok(/DMC Thread/.test(html));
  assert.ok(/Awaiting your check/.test(html), 'Issued -> "Awaiting your check"');
  assert.ok(/6<span class="unit">Cone/.test(html), 'summed thread qty on the main row');
});

test('empty receipts -> empty string', () => {
  assert.strictEqual(ctx.renderSupReceipts([]), '');
  assert.strictEqual(ctx.renderSupReceipts(null), '');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
