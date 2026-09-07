#!/usr/bin/env node
// Phase B, Piece 4 — the reorder controls and the draft/applied split.
//
// Two pieces of state, and keeping them apart IS the design:
//   __priorityOrder  what the numbers on screen were computed against
//   __draftOrder     what the arrows are building, not yet applied
//
// The arrows move cards immediately; the figures stay frozen until Apply. This
// suite pins that, plus the thing most likely to break silently: __reqData must
// always be in the same order as the cards that were drawn, because every issue
// handler looks its supervisor up by CARD INDEX.
//
//   usage: node tools/priority-reorder-ui.test.js

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

// ---- extract the ordering functions from main.js -------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');
function extract(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has function ' + name +
    ' — update tools/priority-reorder-ui.test.js');
  let depth = 0, j = mainSrc.indexOf('{', i);
  for (let k = j; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i, j);
}

// A stub DOM + stub render/card-paint, so the ordering logic can be exercised
// without the whole widget. `paints` records every redraw so the test can prove
// a redraw happened WITHOUT an allocation.
function makeWorld() {
  const state = { paints: 0, renders: 0, lastPainted: null };
  const el = { innerHTML: '', classList: { add() {}, remove() {} } };
  const sandbox = {
    console, Math, Number, String, Object, Array, JSON, isFinite, Infinity,
    document: { getElementById: () => el },
    window: { __reqData: [], __rawData: null },
    // Stubs for everything redrawCards touches other than the ordering itself.
    renderSupervisorCard: (s) => '[' + s.supervisorId + ']',
    renderShortfallSummary: () => '',
    refreshCardState: () => {},
    // render() is the ALLOCATING path — counting calls is how the tests prove
    // an arrow click did not re-allocate.
    render: function () { state.renders++; },
    __state: state
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extract('priorityRankOf') + '\n' +
    extract('defaultPriorityOrder') + '\n' +
    'var __priorityOrder = null, __draftOrder = null;\n' +
    extract('orderByPriority') + '\n' +
    extract('displayOrder') + '\n' +
    extract('movePriority') + '\n' +
    extract('applyPriorityOrder') + '\n' +
    extract('cancelPriorityOrder') + '\n' +
    extract('priorityBarHtml') + '\n' +
    extract('redrawCards') + '\n' +
    'this.api = {\n' +
    '  orderByPriority: orderByPriority,\n' +
    '  movePriority: movePriority,\n' +
    '  applyPriorityOrder: applyPriorityOrder,\n' +
    '  cancelPriorityOrder: cancelPriorityOrder,\n' +
    '  priorityBarHtml: priorityBarHtml,\n' +
    '  redrawCards: redrawCards,\n' +
    '  getDraft: function () { return __draftOrder; },\n' +
    '  getApplied: function () { return __priorityOrder; },\n' +
    '  setApplied: function (o) { __priorityOrder = o; },\n' +
    '  reset: function () { __priorityOrder = null; __draftOrder = null; }\n' +
    '};', sandbox);
  return { api: sandbox.api, win: sandbox.window, state, el };
}

// A supervisor block with one plan, so defaultPriorityOrder has something to
// rank. `rank` is the order-source rank; key = rank * 1e6 + seq.
function sup(id, rank, seq) {
  return {
    supervisorId: id, supervisorName: id,
    materials: [{ materialId: 'M1', lines: [{
      planId: 'P-' + id, priorityKey: rank * 1000000 + (seq || 1), planStartDate: ''
    }] }]
  };
}
const ids = (arr) => arr.map(s => s.supervisorId);

// =====================================================================
console.log('\nDEFAULT ORDER — orderByPriority with nothing applied');

test('D1 falls back to the computed default when no order is set', () => {
  const w = makeWorld();
  // Deliberately out of rank order in the array: Custom, Shopify, Faire.
  const data = [sup('C', 3), sup('A', 1), sup('B', 2)];
  assert.deepStrictEqual(ids(w.api.orderByPriority(data)), ['A', 'B', 'C']);
});

test('D2 an applied order overrides the default', () => {
  const w = makeWorld();
  const data = [sup('C', 3), sup('A', 1), sup('B', 2)];
  w.api.setApplied(['C', 'B', 'A']);
  assert.deepStrictEqual(ids(w.api.orderByPriority(data)), ['C', 'B', 'A']);
});

test('D3 a supervisor the applied order does not name lands at the END', () => {
  // A new plan mid-session brings a card the saved order has never seen. It
  // must not vanish and must not jump the queue.
  const w = makeWorld();
  const data = [sup('A', 1), sup('B', 2), sup('NEW', 1)];
  w.api.setApplied(['B', 'A']);
  assert.deepStrictEqual(ids(w.api.orderByPriority(data)), ['B', 'A', 'NEW']);
});

test('D4 does not mutate the array it is given', () => {
  const w = makeWorld();
  const data = [sup('C', 3), sup('A', 1), sup('B', 2)];
  const before = ids(data).join(',');
  w.api.orderByPriority(data);
  assert.strictEqual(ids(data).join(','), before,
    'orderByPriority must return a new array, not sort in place');
});

// =====================================================================
console.log('\nARROWS — the draft, and NO re-allocation');

test('A1 first arrow click seeds the draft from what is on screen', () => {
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2), sup('C', 3)];
  assert.strictEqual(w.api.getDraft(), null, 'no draft before the first click');
  w.api.movePriority('B', -1);
  assert.deepStrictEqual(w.api.getDraft(), ['B', 'A', 'C']);
});

test('A2 moving up and down swaps neighbours', () => {
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2), sup('C', 3)];
  w.api.movePriority('C', -1);
  assert.deepStrictEqual(w.api.getDraft(), ['A', 'C', 'B']);
  w.api.movePriority('C', 1);
  assert.deepStrictEqual(w.api.getDraft(), ['A', 'B', 'C']);
});

test('A3 an arrow click REDRAWS but never re-allocates', () => {
  // The whole reason Apply exists. render() is the allocating path; a click
  // must not reach it.
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2), sup('C', 3)];
  w.api.movePriority('B', -1);
  assert.strictEqual(w.state.renders, 0,
    'moving a card must NOT re-run the allocation');
  assert.ok(w.el.innerHTML.indexOf('[B]') < w.el.innerHTML.indexOf('[A]'),
    'the card list must be repainted in the draft order');
});

test('A4 moving past either end leaves NO TRACE — no draft, no Apply bar', () => {
  // A click that cannot move anything must not raise the Apply bar. Seeding a
  // draft first would offer to "apply" an order nobody changed and re-run the
  // allocation for nothing.
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2)];
  w.api.movePriority('A', -1);            // already top
  assert.strictEqual(w.api.getDraft(), null, 'top card up-arrow: no draft');
  w.api.movePriority('B', 1);             // already bottom
  assert.strictEqual(w.api.getDraft(), null, 'bottom card down-arrow: no draft');
  assert.strictEqual(w.api.priorityBarHtml(), '', 'and no Apply bar');
});

test('A5 an unknown supervisor id is ignored, and leaves no draft', () => {
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2)];
  w.api.movePriority('GHOST', -1);
  assert.strictEqual(w.api.getDraft(), null, 'no draft for a card that is not there');
});

// =====================================================================
console.log('\nINDEX SAFETY — __reqData must match the drawn order');

test('I1 redraw keeps __reqData in the SAME order as the cards drawn', () => {
  // Every issue handler does window.__reqData[supIdx] where supIdx is the
  // card's position. Draw in one order and cache in another and every Issue
  // button points at the wrong supervisor.
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2), sup('C', 3)];
  w.api.movePriority('C', -1);            // draft: A, C, B
  const drawn = w.el.innerHTML;
  const drawnOrder = ['A', 'B', 'C'].slice().sort(
    (x, y) => drawn.indexOf('[' + x + ']') - drawn.indexOf('[' + y + ']'));
  assert.deepStrictEqual(drawnOrder, ['A', 'C', 'B'], 'sanity: drawn order');
  assert.deepStrictEqual(ids(w.win.__reqData), drawnOrder,
    '__reqData order must match the order the cards were drawn in');
});

// =====================================================================
console.log('\nAPPLY / CANCEL');

test('P1 Apply promotes the draft and re-allocates once', () => {
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2), sup('C', 3)];
  w.win.__rawData = w.win.__reqData;
  w.api.movePriority('C', -1);            // draft A, C, B
  assert.strictEqual(w.state.renders, 0);
  w.api.applyPriorityOrder();
  assert.deepStrictEqual(w.api.getApplied(), ['A', 'C', 'B'],
    'the draft becomes the applied order');
  assert.strictEqual(w.api.getDraft(), null, 'the draft is cleared');
  assert.strictEqual(w.state.renders, 1, 'Apply re-allocates exactly once');
});

test('P2 Cancel discards the draft and restores the applied order', () => {
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2), sup('C', 3)];
  w.api.movePriority('C', -1);
  w.api.cancelPriorityOrder();
  assert.strictEqual(w.api.getDraft(), null, 'draft discarded');
  assert.strictEqual(w.api.getApplied(), null, 'applied order untouched');
  assert.strictEqual(w.state.renders, 0, 'Cancel must not re-allocate');
  // Redrawn back in the original order.
  assert.ok(w.el.innerHTML.indexOf('[A]') < w.el.innerHTML.indexOf('[B]'));
  assert.ok(w.el.innerHTML.indexOf('[B]') < w.el.innerHTML.indexOf('[C]'));
});

test('P3 Apply with no draft does nothing', () => {
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1)];
  w.api.applyPriorityOrder();
  assert.strictEqual(w.state.renders, 0);
  assert.strictEqual(w.api.getApplied(), null);
});

test('P4 an applied order SURVIVES a re-render (the Refresh path)', () => {
  // loadRequirements() re-fetches and calls render(), which calls
  // orderByPriority — __priorityOrder is module state and is never touched by
  // the fetch, so the chosen order persists.
  const w = makeWorld();
  w.api.setApplied(['C', 'B', 'A']);
  const fresh = [sup('A', 1), sup('B', 2), sup('C', 3)];   // server order
  assert.deepStrictEqual(ids(w.api.orderByPriority(fresh)), ['C', 'B', 'A']);
});

// =====================================================================
console.log('\nTHE APPLY BAR');

test('B1 the bar is absent until a draft exists, and gone again after Apply', () => {
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2)];
  w.win.__rawData = w.win.__reqData;
  assert.strictEqual(w.api.priorityBarHtml(), '', 'no bar with no draft');
  w.api.movePriority('B', -1);
  assert.ok(w.api.priorityBarHtml().indexOf('Apply order') > -1, 'bar appears');
  w.api.applyPriorityOrder();
  assert.strictEqual(w.api.priorityBarHtml(), '', 'bar gone after Apply');
});

test('B2 the bar says the figures are stale — the one non-obvious thing', () => {
  const w = makeWorld();
  w.win.__reqData = [sup('A', 1), sup('B', 2)];
  w.api.movePriority('B', -1);
  const bar = w.api.priorityBarHtml();
  assert.ok(/still for the previous order/i.test(bar),
    'the bar must say the numbers below are stale');
});

// ----------------------------------------------------------------------------
console.log('\n========================================');
console.log('priority-reorder-ui: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  - ' + f.name + ': ' + f.msg)); process.exit(1); }
