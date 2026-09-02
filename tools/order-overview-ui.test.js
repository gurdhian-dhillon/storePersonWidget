#!/usr/bin/env node
// Order Overview tab (app/supervisor/js/order-overview.js), exercised in a stub
// DOM via vm. Covers the sort control, the overdue flag, lazy item load +
// caching, and the cross-tab jump.
//
//   usage: node tools/order-overview-ui.test.js

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

const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'supervisor', 'js', 'order-overview.js'), 'utf8');

// ---- minimal stub DOM -------------------------------------------------------
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    className: '',
    _html: '',
    _attrs: {},
    _children: [],
    _listeners: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
    get id() { return this._attrs.id || ''; },
    set id(v) { this._attrs.id = v; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(c) { this._children.push(c); return c; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  };
}

function makeCtx() {
  const els = {};
  const calls = [];
  const doc = {
    _byId: els,
    getElementById(id) { return els[id] || null; },
    querySelector(sel) {
      // supports '.ov-order-card[data-plan="X"]' and '.item-body'
      const m = /\.ov-order-card\[data-plan="([^"]+)"\]/.exec(sel);
      if (m) {
        for (const k in els) {
          if (els[k]._attrs && els[k]._attrs['data-plan'] === m[1]) return els[k];
        }
      }
      return null;
    },
    createElement: makeEl,
  };
  // panel + a couple of card/body elements the tests wire up by hand
  els['panel-order-overview'] = makeEl('section');

  const ctx = {
    document: doc,
    window: {},
    console: { log() {}, warn() {}, error() {} },
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c])),
    fmt: (n) => String(Math.round((Number(n) || 0) * 100) / 100),
    setTabCount: (id, n) => calls.push(['setTabCount', id, n]),
    currentSupervisorId: () => '77',
    showTab: (name) => calls.push(['showTab', name]),
    tabsLoaded: {},
    productionSelectPlan: (pid) => calls.push(['productionSelectPlan', String(pid)]),
    TAB_LOADERS: {},
    ZOHO: {
      CREATOR: {
        DATA: {
          _next: null,
          invokeCustomApi(opts) {
            calls.push(['api', opts.api_name, opts.payload]);
            const r = ctx.ZOHO.CREATOR.DATA._next;
            ctx.ZOHO.CREATOR.DATA._next = null;
            return Promise.resolve({ result: JSON.stringify(r || { errors: [], items: [], remakeCount: 0 }) });
          },
        },
      },
    },
    _els: els,
    _calls: calls,
  };
  ctx.window = ctx; // globals reachable as window.*
  return ctx;
}

function load(ctx) {
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'order-overview.js' });
  return ctx;
}

// ---- fixtures -------------------------------------------------------------
function order(o) {
  return Object.assign({
    planId: '1', planNo: 'PLAN-1', salesOrder: 'SO-1', customerPerson: 'Ann',
    deliveryDate: '10-Sep-2026', orderStatus: 'In Progress', orderSource: 'Shopify',
    priorityKey: 1000001, itemCount: 3,
  }, o);
}

// A fixed "today" for overdue tests: freeze Date via ctx override is messy;
// instead we build delivery dates relative to the real today.
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return d.getDate() + '-' + mon + '-' + d.getFullYear();
}

// ===========================================================================

test('sort: delivery date puts soonest first, undated last', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [
    order({ planId: 'a', deliveryDate: '20-Sep-2026', priorityKey: 5 }),
    order({ planId: 'b', deliveryDate: '', priorityKey: 2 }),
    order({ planId: 'c', deliveryDate: '05-Sep-2026', priorityKey: 9 }),
    order({ planId: 'd', deliveryDate: '', priorityKey: 1 }),
  ];
  ctx.OV_SORT = 'delivery';
  const ids = ctx.ovVisibleOrders().map((o) => o.planId);
  assert.deepStrictEqual(ids, ['c', 'a', 'd', 'b'],
    'dated asc then undated by priority asc; got ' + ids);
});

test('sort: priority is Priority_Key ascending', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [
    order({ planId: 'a', priorityKey: 4000040 }),
    order({ planId: 'b', priorityKey: 1000002 }),
    order({ planId: 'c', priorityKey: 2000003 }),
  ];
  ctx.OV_SORT = 'priority';
  assert.deepStrictEqual(ctx.ovVisibleOrders().map((o) => o.planId), ['b', 'c', 'a']);
});

test('sort: customer groups a name together, blank last', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [
    order({ planId: 'a', customerPerson: 'Zoe', deliveryDate: '10-Sep-2026' }),
    order({ planId: 'b', customerPerson: '', deliveryDate: '01-Sep-2026' }),
    order({ planId: 'c', customerPerson: 'Ann', deliveryDate: '20-Sep-2026' }),
    order({ planId: 'd', customerPerson: 'Ann', deliveryDate: '05-Sep-2026' }),
  ];
  ctx.OV_SORT = 'customer';
  const ids = ctx.ovVisibleOrders().map((o) => o.planId);
  assert.deepStrictEqual(ids, ['d', 'c', 'a', 'b'],
    'Ann (by date within), then Zoe, then blank; got ' + ids);
});

test('sort: status ranks Pending -> In Progress', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [
    order({ planId: 'a', orderStatus: 'In Progress', priorityKey: 1 }),
    order({ planId: 'b', orderStatus: 'Pending', priorityKey: 9 }),
    order({ planId: 'c', orderStatus: 'Material Ready', priorityKey: 5 }),
    order({ planId: 'd', orderStatus: 'Partially Received', priorityKey: 3 }),
  ];
  ctx.OV_SORT = 'status';
  assert.deepStrictEqual(ctx.ovVisibleOrders().map((o) => o.planId), ['b', 'c', 'd', 'a']);
});

test('overdue: only a past delivery date flags', () => {
  const ctx = load(makeCtx());
  assert.strictEqual(ctx.ovIsOverdue(daysFromNow(-1)), true, 'yesterday is overdue');
  assert.strictEqual(ctx.ovIsOverdue(daysFromNow(3)), false, 'future is not');
  assert.strictEqual(ctx.ovIsOverdue(''), false, 'no date is not overdue');
  assert.strictEqual(ctx.ovIsOverdue('garbage'), false, 'unparseable is not overdue');
});

test('render: empty list shows placeholder and zeroes the badge', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [];
  ctx.renderOrderOverview();
  const html = ctx._els['panel-order-overview'].innerHTML;
  assert.ok(/No open orders/.test(html), 'placeholder shown');
  assert.ok(ctx._calls.some((c) => c[0] === 'setTabCount' && c[1] === 'count-order-overview' && c[2] === 0));
});

test('render: one card per order, overdue pill on the late one, badge = count', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [
    order({ planId: 'x', salesOrder: 'SO-10', deliveryDate: daysFromNow(-2) }),
    order({ planId: 'y', salesOrder: 'SO-11', deliveryDate: daysFromNow(5) }),
  ];
  ctx.OV_SORT = 'delivery';
  ctx.renderOrderOverview();
  const html = ctx._els['panel-order-overview'].innerHTML;
  assert.ok(/SO-10/.test(html) && /SO-11/.test(html), 'both orders rendered');
  assert.ok(/status-shortfall">Overdue/.test(html), 'overdue pill present');
  assert.ok(/Open in Production/.test(html), 'jump button present');
  assert.ok(/ov-search-input/.test(html), 'search box present');
  assert.ok(/ov-chip[^>]*>Overdue only/.test(html), 'overdue chip present');
  assert.ok(/ov-sort-link is-active[^>]*>Delivery/.test(html), 'active sort link reflects OV_SORT');
  assert.ok(/2 open orders/.test(html), 'count line');
  assert.ok(ctx._calls.some((c) => c[0] === 'setTabCount' && c[1] === 'count-order-overview' && c[2] === 2));
});

test('onOvSort(key) re-renders without re-fetching', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [order({ planId: 'a' }), order({ planId: 'b', priorityKey: 5 })];
  ctx.OV_SORT = 'delivery';
  ctx.onOvSort('priority');
  assert.strictEqual(ctx.OV_SORT, 'priority');
  assert.ok(!ctx._calls.some((c) => c[0] === 'api'), 'no server call on sort');
  const before = ctx._calls.length;
  ctx.onOvSort('priority');
  assert.strictEqual(ctx._calls.length, before, 'clicking the active link does nothing');
});

test('search: filters by SO number and customer, count line reflects it', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [
    order({ planId: '1', salesOrder: 'SO-100', customerPerson: 'Alice' }),
    order({ planId: '2', salesOrder: 'SO-200', customerPerson: 'Bob' }),
    order({ planId: '3', salesOrder: 'SO-201', customerPerson: 'Alice' }),
  ];
  ctx.onOvSearch('alice');
  let html = ctx._els['panel-order-overview'].innerHTML;
  assert.ok(/SO-100/.test(html) && /SO-201/.test(html) && !/SO-200/.test(html), 'customer match');
  assert.ok(/2 of 3 orders/.test(html), 'count line narrowed');
  assert.ok(!ctx._calls.some((c) => c[0] === 'api'), 'no server call');

  ctx.onOvSearch('so-200');
  html = ctx._els['panel-order-overview'].innerHTML;
  assert.ok(/SO-200/.test(html) && !/SO-100/.test(html), 'SO number match');

  ctx.onOvSearch('zzz');
  html = ctx._els['panel-order-overview'].innerHTML;
  assert.ok(/No orders match/.test(html), 'empty-filter placeholder, toolbar still shown');
  assert.ok(/ov-search-input/.test(html), 'toolbar kept on no-match');

  ctx.onOvClearSearch();
  html = ctx._els['panel-order-overview'].innerHTML;
  assert.ok(/3 open orders/.test(html) && /SO-200/.test(html), 'clear restores all');
});

test('overdue chip: toggles the filter, badge stays total', () => {
  const ctx = load(makeCtx());
  ctx.OV_ORDERS = [
    order({ planId: '1', salesOrder: 'SO-A', deliveryDate: daysFromNow(-3) }),
    order({ planId: '2', salesOrder: 'SO-B', deliveryDate: daysFromNow(4) }),
  ];
  ctx.onOvOverdueToggle();
  assert.strictEqual(ctx.OV_OVERDUE_ONLY, true);
  let html = ctx._els['panel-order-overview'].innerHTML;
  assert.ok(/SO-A/.test(html) && !/SO-B/.test(html), 'only the overdue one shown');
  assert.ok(/ov-chip is-on/.test(html), 'chip shows active');
  assert.ok(/1 of 2 orders/.test(html));
  // badge is always the true total, not the filtered count
  assert.ok(ctx._calls.some((c) => c[0] === 'setTabCount' && c[1] === 'count-order-overview' && c[2] === 2));

  ctx.onOvOverdueToggle();
  html = ctx._els['panel-order-overview'].innerHTML;
  assert.ok(/SO-B/.test(html), 'toggling off restores');
});

test('toggleOvOrder: first open fires getOrderItemList once, 2nd open is a cache hit', async () => {
  const ctx = load(makeCtx());
  // one card wired by hand
  const card = makeEl('div');
  card._attrs.id = 'ov-card-0';
  card._attrs['data-plan'] = '55';
  const body = makeEl('div');
  body._attrs.id = 'ov-body-0';
  card.querySelector = () => body;
  ctx._els['ov-card-0'] = card;
  ctx._els['ov-body-0'] = body;

  ctx.ZOHO.CREATOR.DATA._next = { errors: [], items: [{ name: 'Napkin', qty: 5, produced: 0, status: 'Awaiting_Material' }], remakeCount: 1 };

  ctx.toggleOvOrder(0);           // opens -> fetch
  await Promise.resolve(); await Promise.resolve();

  const apiCalls = ctx._calls.filter((c) => c[0] === 'api' && c[1] === 'getOrderItemList');
  assert.strictEqual(apiCalls.length, 1, 'one fetch on first open');
  assert.strictEqual(ctx.OV_ITEM_CACHE['55'].state, 'ok');
  assert.strictEqual(ctx.OV_ITEM_CACHE['55'].remakeCount, 1);

  // close then re-open -> no new fetch
  ctx.toggleOvOrder(0);          // close
  ctx.toggleOvOrder(0);          // open again
  const after = ctx._calls.filter((c) => c[0] === 'api' && c[1] === 'getOrderItemList');
  assert.strictEqual(after.length, 1, 'cache hit on re-open, no 2nd fetch');
});

test('ovBodyHtml: renders items + remake note when remakeCount > 0', () => {
  const ctx = load(makeCtx());
  ctx.OV_ITEM_CACHE['9'] = {
    state: 'ok',
    items: [
      { name: 'Basket', qty: 8, produced: 3, status: 'In_Production' },
      { name: 'Runner', qty: 2, produced: 0, status: 'Complete' },
    ],
    remakeCount: 2,
  };
  const html = ctx.ovBodyHtml('9');
  assert.ok(/Basket/.test(html) && /Runner/.test(html));
  assert.ok(/In production/.test(html), 'In_Production mapped to label');
  assert.ok(/Completed/.test(html), 'Complete mapped to label');
  assert.ok(/2 remake batches in progress/.test(html), 'remake note shown');
});

test('ovOpenInProduction: stops propagation, sets hint, switches tab', () => {
  const ctx = load(makeCtx());
  let stopped = false;
  ctx.tabsLoaded.production = true;
  ctx.ovOpenInProduction({ stopPropagation() { stopped = true; } }, '123');
  assert.strictEqual(stopped, true, 'ev.stopPropagation called');
  assert.strictEqual(ctx.window.__ovJumpPlanId, '123', 'jump hint set');
  assert.ok(ctx._calls.some((c) => c[0] === 'showTab' && c[1] === 'production'));
  assert.ok(ctx._calls.some((c) => c[0] === 'productionSelectPlan' && c[1] === '123'),
    'productionSelectPlan called because production was already loaded');
});

test('ovOpenInProduction: production NOT loaded -> only the hint + showTab', () => {
  const ctx = load(makeCtx());
  ctx.tabsLoaded.production = undefined;
  ctx.ovOpenInProduction({ stopPropagation() {} }, '456');
  assert.strictEqual(ctx.window.__ovJumpPlanId, '456');
  assert.ok(ctx._calls.some((c) => c[0] === 'showTab' && c[1] === 'production'));
  assert.ok(!ctx._calls.some((c) => c[0] === 'productionSelectPlan'),
    'no productionSelectPlan when production tab not yet loaded');
});

test('TAB_LOADERS registered under the hyphen key', () => {
  const ctx = load(makeCtx());
  assert.strictEqual(typeof ctx.TAB_LOADERS['order-overview'], 'function');
});

// ---- getOrderItemList roll-up (Deluge port) --------------------------------
// One row per ORIGINAL line; an original that is Complete but has an unfinished
// remake/alteration child (Remake_Of == original.ID, status != Complete) reads
// as In_Production. Mirrors deluge/getOrderItemList.dg pass 1 + pass 2.
function orderItemListRollup(planItems) {
  const remakeOpenByRoot = {};
  let remakeCount = 0;
  for (const it of planItems) {
    if (it.Is_Remake === true) {
      remakeCount++;
      if (it.Remake_Of != null && String(it.Item_Status || '').trim() !== 'Complete') {
        remakeOpenByRoot[String(it.Remake_Of)] = '1';
      }
    }
  }
  const items = [];
  for (const it of planItems) {
    if (it.Is_Remake === true) continue;
    const own = String(it.Item_Status || '').trim();
    let roll = own;
    if (own === 'Complete' && remakeOpenByRoot[String(it.ID)] === '1') roll = 'In_Production';
    items.push({ itemId: String(it.ID), name: it.Item_Name, status: roll });
  }
  return { items, remakeCount };
}

test('rollup: Complete original with a live remake child -> In_Production', () => {
  const rows = [
    { ID: 1, Item_Name: 'Duvet', Item_Status: 'Complete', Is_Remake: false },
    { ID: 2, Item_Name: 'Throw', Item_Status: 'Complete', Is_Remake: false },
    { ID: 3, Item_Name: 'Duvet (remake)', Item_Status: 'In_Production', Is_Remake: true, Remake_Of: 1 },
  ];
  const r = orderItemListRollup(rows);
  assert.deepStrictEqual(r.items.map((i) => [i.name, i.status]),
    [['Duvet', 'In_Production'], ['Throw', 'Complete']]);
  assert.strictEqual(r.remakeCount, 1);
});

test('rollup: Complete original whose remake also Complete -> stays Complete', () => {
  const rows = [
    { ID: 1, Item_Name: 'Duvet', Item_Status: 'Complete', Is_Remake: false },
    { ID: 3, Item_Name: 'Duvet (remake)', Item_Status: 'Complete', Is_Remake: true, Remake_Of: 1 },
  ];
  const r = orderItemListRollup(rows);
  assert.deepStrictEqual(r.items.map((i) => [i.name, i.status]), [['Duvet', 'Complete']]);
});

test('rollup: original not yet Complete keeps its own status regardless of children', () => {
  const rows = [
    { ID: 1, Item_Name: 'Duvet', Item_Status: 'Awaiting_Check', Is_Remake: false },
    { ID: 3, Item_Name: 'Duvet (remake)', Item_Status: 'Complete', Is_Remake: true, Remake_Of: 1 },
  ];
  const r = orderItemListRollup(rows);
  assert.strictEqual(r.items[0].status, 'Awaiting_Check');
});

test('rollup: remake rows never appear as their own item row', () => {
  const rows = [
    { ID: 1, Item_Name: 'Duvet', Item_Status: 'Complete', Is_Remake: false },
    { ID: 3, Item_Name: 'Duvet (alteration)', Item_Status: 'Ready_For_Production', Is_Remake: true, Remake_Of: 1 },
    { ID: 4, Item_Name: 'Duvet (remake #2)', Item_Status: 'Complete', Is_Remake: true, Remake_Of: 1 },
  ];
  const r = orderItemListRollup(rows);
  assert.strictEqual(r.items.length, 1, 'only the original');
  assert.strictEqual(r.items[0].status, 'In_Production', 'one child still Ready_For_Production');
  assert.strictEqual(r.remakeCount, 2);
});

// ===========================================================================
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach((f) => console.log('  - ' + f.name + ': ' + f.msg)); process.exit(1); }
