#!/usr/bin/env node
// Supervisor receive screen — roll display, lot-rolls-model.md Step 5/7.
//
//   lotColumn(m)        — per-material lot list, each lot now naming the
//                          roll(s) it came off underneath it (m.lots[].rolls)
//   matBreakdownHtml(m,i) — per-order "Where this goes" breakdown, each order
//                          now tagged with the lot+roll it cuts from
//                          (o.lotRolls)
//
// Exercised in isolation via vm, same pattern as store-history-merge.test.js.
//
//   usage: node tools/supervisor-receive-rolls.test.js

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

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'supervisor', 'js', 'receive.js'), 'utf8');

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
};
vm.createContext(ctx);
vm.runInContext(
  grab('function escapeHtml(') + '\n' +
  grab('function fmt(') + '\n' +
  grab('function ordItemsId(') + '\n' +
  grab('function ordChevId(') + '\n' +
  src.slice(src.indexOf('var CHEV_SVG'), src.indexOf(';', src.indexOf('var CHEV_SVG')) + 1) + '\n' +
  grab('function lotColumn(') + '\n' +
  grab('function matBreakdownHtml(') + '\n' +
  'this.lotColumn = lotColumn;' +
  'this.matBreakdownHtml = matBreakdownHtml;',
  ctx);

// ---- lotColumn -----------------------------------------------------------

test('lotColumn: single lot, no rolls (pre-Step-5) -> plain lot line, no roll sub-line', () => {
  const html = ctx.lotColumn({ isFabric: true, unit: 'Mtr', lots: [{ lot: 'L1', qty: 10, rolls: [] }] });
  assert.ok(/<b>L1<\/b>/.test(html));
  assert.ok(!/rcv-roll/.test(html), 'no roll sub-line when rolls[] is empty');
});

test('lotColumn: single lot, ONE roll -> roll sub-line with label and qty', () => {
  const html = ctx.lotColumn({
    isFabric: true, unit: 'Mtr',
    lots: [{ lot: 'L1', qty: 10, rolls: [{ roll: 'L1-R1', qty: 10 }] }]
  });
  assert.ok(/rcv-roll"><b>L1-R1<\/b> &middot; 10 Mtr/.test(html), html);
});

test('lotColumn: single lot, TWO rolls -> TWO roll sub-lines, in order', () => {
  const html = ctx.lotColumn({
    isFabric: true, unit: 'Mtr',
    lots: [{ lot: 'L1', qty: 6.05, rolls: [{ roll: 'L1-R1', qty: 5 }, { roll: 'L1-R2', qty: 1.05 }] }]
  });
  const idxR1 = html.indexOf('L1-R1');
  const idxR2 = html.indexOf('L1-R2');
  assert.ok(idxR1 >= 0 && idxR2 >= 0 && idxR1 < idxR2, 'both rolls present, in drain order');
});

test('lotColumn: TWO lots, each with its own roll -> rolls stay under their own lot', () => {
  const html = ctx.lotColumn({
    isFabric: true, unit: 'Mtr',
    lots: [
      { lot: 'L1', qty: 10, rolls: [{ roll: 'L1-R1', qty: 10 }] },
      { lot: 'L2', qty: 4, rolls: [{ roll: 'L2-R1', qty: 4 }] }
    ]
  });
  const idxL1 = html.indexOf('L1<');
  const idxR1 = html.indexOf('L1-R1');
  const idxL2 = html.indexOf('L2<');
  const idxR2 = html.indexOf('L2-R1');
  assert.ok(idxL1 < idxR1 && idxR1 < idxL2 && idxL2 < idxR2, 'L1 roll appears before L2, not after both lots');
});

test('lotColumn: no lots at all -> "-" placeholder, unaffected by the roll change', () => {
  const html = ctx.lotColumn({ isFabric: true, unit: 'Mtr', lots: [] });
  assert.strictEqual(html, '<td class="col-lot">-</td>');
});

test('lotColumn: non-fabric material -> "-" placeholder regardless of lots array', () => {
  const html = ctx.lotColumn({ isFabric: false, unit: 'Cone', lots: [{ lot: 'L1', qty: 10, rolls: [{ roll: 'L1-R1', qty: 10 }] }] });
  assert.strictEqual(html, '<td class="col-lot">-</td>');
});

test('lotColumn: roll label is HTML-escaped', () => {
  const html = ctx.lotColumn({
    isFabric: true, unit: 'Mtr',
    lots: [{ lot: 'L1', qty: 5, rolls: [{ roll: '<script>', qty: 5 }] }]
  });
  assert.ok(!/<script>/.test(html), 'raw script tag must not appear');
  assert.ok(/&lt;script&gt;/.test(html));
});

// ---- matBreakdownHtml ------------------------------------------------------

test('matBreakdownHtml: order with no lotRolls -> no roll tag rendered', () => {
  const html = ctx.matBreakdownHtml({ unit: 'Mtr', orders: [
    { planId: 'P1', planNo: 'PLN-1', salesOrder: 'SO-1', pending: 5, isReissue: false, reason: '', lineCount: 1, lotRolls: [] }
  ] }, 0);
  assert.ok(!/bd-roll-tag/.test(html));
});

test('matBreakdownHtml: order with ONE lotRoll -> one tag, "lot · roll"', () => {
  const html = ctx.matBreakdownHtml({ unit: 'Mtr', orders: [
    { planId: 'P1', planNo: 'PLN-1', salesOrder: 'SO-1', pending: 5, isReissue: false, reason: '', lineCount: 1,
      lotRolls: [{ lot: 'L1', roll: 'L1-R1' }] }
  ] }, 0);
  assert.ok(/bd-roll-tag">L1 &middot; L1-R1<\/span>/.test(html), html);
});

test('matBreakdownHtml: order with a lot but NO roll -> tag shows just the lot', () => {
  const html = ctx.matBreakdownHtml({ unit: 'Mtr', orders: [
    { planId: 'P1', planNo: 'PLN-1', salesOrder: 'SO-1', pending: 5, isReissue: false, reason: '', lineCount: 1,
      lotRolls: [{ lot: 'L1', roll: '' }] }
  ] }, 0);
  assert.ok(/bd-roll-tag">L1<\/span>/.test(html), html);
});

test('matBreakdownHtml: order split across TWO lots/rolls -> TWO tags', () => {
  const html = ctx.matBreakdownHtml({ unit: 'Mtr', orders: [
    { planId: 'P1', planNo: 'PLN-1', salesOrder: 'SO-1', pending: 5, isReissue: false, reason: '', lineCount: 2,
      lotRolls: [{ lot: 'L1', roll: 'L1-R1' }, { lot: 'L2', roll: 'L2-R1' }] }
  ] }, 0);
  const tags = html.match(/bd-roll-tag/g) || [];
  assert.strictEqual(tags.length, 2);
  assert.ok(/L1 &middot; L1-R1/.test(html) && /L2 &middot; L2-R1/.test(html));
});

test('matBreakdownHtml: reissue tag still appears alongside the roll tag, not replaced by it', () => {
  const html = ctx.matBreakdownHtml({ unit: 'Mtr', orders: [
    { planId: 'P1', planNo: 'PLN-1', salesOrder: 'SO-1', pending: 5, isReissue: true, reason: '', lineCount: 1,
      lotRolls: [{ lot: 'L1', roll: 'L1-R1' }] }
  ] }, 0);
  assert.ok(/bd-roll-tag/.test(html) && /reissue-tag/.test(html), 'both tags present');
});

test('matBreakdownHtml: lot/roll text is HTML-escaped', () => {
  const html = ctx.matBreakdownHtml({ unit: 'Mtr', orders: [
    { planId: 'P1', planNo: 'PLN-1', salesOrder: 'SO-1', pending: 5, isReissue: false, reason: '', lineCount: 1,
      lotRolls: [{ lot: '<b>L1</b>', roll: '' }] }
  ] }, 0);
  assert.ok(!/<b>L1<\/b>/.test(html));
  assert.ok(/&lt;b&gt;L1&lt;\/b&gt;/.test(html));
});

console.log('\n' + '='.repeat(40));
console.log('supervisor-receive-rolls: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
