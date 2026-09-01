/* One-line-per-SKU store screen — integration tests.
 *
 * Covers: the allocator with one entry per SKU spanning many cut sizes; the
 * render (one <tr>, per-lot boxes); buildFabricIssueLine's payload; partial-issue
 * fan-out to plan items; per-lot hand edit. Single-cut regression: the payload's
 * allocations/lotMoves for a one-cut SKU are structurally what they were before.
 */
const vm = require('vm');
const fs = require('fs');
const assert = require('assert');

const ROOT = 'C:/Users/gurdh/OneDrive/Desktop/getStoreMaterial/storePersonWidget/app/js/';

// ---- tiny DOM stub (enough for renderFabricRows + the handlers) --------------
let REG = {};
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(), children: [], parent: null,
    _class: new Set(), _attr: {}, _text: '', _id: '', _value: '',
    checked: false, indeterminate: false, disabled: false, readOnly: false,
    title: '', style: {}, dataset: {}, addEventListener() {}, removeEventListener() {},
    focus() {}, blur() {}, click() {}, appendChild(c) { c.parent = this; this.children.push(c); return c; },
    get id() { return this._id; }, set id(v) { this._id = v; if (v) REG[v] = this; },
    get value() { return this._value; }, set value(v) { this._value = String(v); },
    get classList() { const s = this._class; return {
      add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)),
      toggle: (c, on) => { if (on === undefined) s.has(c) ? s.delete(c) : s.add(c); else on ? s.add(c) : s.delete(c); },
      contains: (c) => s.has(c) }; },
    get className() { return [...this._class].join(' '); },
    set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); },
    setAttribute(k, v) { this._attr[k] = String(v); if (k === 'class') this.className = v; },
    getAttribute(k) { return this._attr[k]; },
    get innerHTML() { return this._innerHTML || ''; },
    set innerHTML(html) { this._innerHTML = html; this.children = parseHTML(html, this); },
    get outerHTML() { return '<' + this.tagName.toLowerCase() + '>' + (this._innerHTML || '') + '</' + this.tagName.toLowerCase() + '>'; },
    set outerHTML(html) { const p = this.parent; if (!p) return; const i = p.children.indexOf(this);
      p.children.splice(i, 1, ...parseHTML(html, p)); },
    remove() { const p = this.parent; if (p) p.children.splice(p.children.indexOf(this), 1); },
    insertAdjacentHTML(pos, html) { const nodes = parseHTML(html, this.parent || this);
      if (pos === 'afterend' && this.parent) { const i = this.parent.children.indexOf(this);
        this.parent.children.splice(i + 1, 0, ...nodes); }
      else if (pos === 'beforeend') { nodes.forEach(n => { n.parent = this; this.children.push(n); }); } },
    querySelector(sel) { return query(this, sel, true); },
    querySelectorAll(sel) { return query(this, sel, false); },
    closest(sel) { let n = this; while (n) { if (matchSel(n, sel)) return n; n = n.parent; } return null; },
  };
}
function matchSel(el, sel) {
  if (!el || !el.tagName) return false;
  sel = sel.trim();
  if (sel.indexOf('.') > 0 && sel[0] !== '.') { // "tag.class" or ".a.b"
    return sel.split('.').filter(Boolean).every((c, i) =>
      i === 0 && sel[0] !== '.' ? el.tagName === c.toUpperCase() : el._class.has(c));
  }
  if (sel.startsWith('.')) return sel.slice(1).split('.').every(c => el._class.has(c));
  if (sel.startsWith('#')) return el._id === sel.slice(1);
  return el.tagName === sel.toUpperCase();
}
function query(root, sel, first) {
  const out = [];
  (function walk(n) { for (const c of n.children || []) {
    if (matchSel(c, sel)) { out.push(c); if (first) throw { f: c }; } walk(c); } });
  try { (function walk(n) { for (const c of n.children || []) {
    if (matchSel(c, sel)) { out.push(c); if (first) throw { f: c }; } walk(c); } })(root); }
  catch (e) { if (e && e.f) return e.f; throw e; }
  return first ? null : out;
}
function parseHTML(html, parent) {
  const nodes = []; const stack = [];
  const rx = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z_:-]+(?:=(?:"[^"]*"|'[^']*'))?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = rx.exec(html))) {
    if (m[3] !== undefined) { if (stack.length) stack[stack.length - 1]._text = (stack[stack.length - 1]._text || '') + m[3]; continue; }
    const raw = m[0], tag = m[1].toLowerCase();
    if (raw.startsWith('</')) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; } continue; }
    const selfClose = raw.endsWith('/>') || ['input', 'br', 'hr', 'img'].includes(tag);
    const el = makeEl(tag);
    const arx = /([a-zA-Z_:-]+)(?:=("([^"]*)"|'([^']*)'))?/g; let a;
    while ((a = arx.exec(m[2] || ''))) {
      const k = a[1], v = a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : '');
      if (k === 'class') el.className = v;
      else if (k === 'id') el.id = v;
      else if (k === 'value') el._value = v;
      else if (k === 'readonly') el.readOnly = true;
      else if (k === 'disabled' || k === 'checked') el[k] = true;
      else el.setAttribute(k, v);
    }
    const p = stack.length ? stack[stack.length - 1] : parent;
    el.parent = p;
    if (stack.length) stack[stack.length - 1].children.push(el); else nodes.push(el);
    if (!selfClose) stack.push(el);
  }
  return nodes;
}

const ctx = {
  document: { getElementById: (id) => REG[id] || null, createElement: makeEl,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    body: makeEl('body'), documentElement: makeEl('html') },
  console, alert: (m) => { ctx.__alert = m; }, setTimeout: (f) => { try { f(); } catch (e) {} },
  clearTimeout() {}, navigator: { userAgent: 'node' }, location: { href: '', search: '' },
  ZOHO: { CREATOR: { init: () => Promise.resolve(), DATA: { invokeCustomApi: () => Promise.resolve({ code: 3000, result: {} }) } } },
};
ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.globalThis = ctx;
vm.createContext(ctx);
// let unknown ids auto-vivify during module load, then lock
let VIV = true;
ctx.document.getElementById = (id) => { if (REG[id]) return REG[id];
  if (VIV) { const e = makeEl('div'); e._id = id; REG[id] = e; return e; } return null; };
vm.runInContext(fs.readFileSync(ROOT + 'lot-allocator.js', 'utf8'), ctx, { filename: 'lot-allocator.js' });
vm.runInContext(fs.readFileSync(ROOT + 'main.js', 'utf8'), ctx, { filename: 'main.js' });
VIV = false; REG = {};

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ', name); }
  else { fail++; console.log('  FAIL ', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
// Recursively pull all text out of a stub node tree.
function textOf(el) {
  if (!el) return '';
  let s = el._text || '';
  (el.children || []).forEach(c => { s += ' ' + textOf(c); });
  return s;
}

// ---- builders ---------------------------------------------------------------
// 150cm wide fabric. Two cut sizes: 55x90 (perRow 2) and 55x240 (perRow 2).
function line(planItemId, planId, salesOrder, reqPcs, issPcs, cutW, cutL, issuedLot) {
  return { mrqId: 'M-' + planItemId, planId: planId, salesOrder: salesOrder,
           planItemId: planItemId, item: 'Item ' + planItemId, isRemake: false,
           supervisorId: 'S1', required: 0, issued: 0, reqPieces: reqPcs, issPieces: issPcs || 0,
           cutW: cutW, cutL: cutL, issuedLot: issuedLot || '', issuedLotNo: issuedLot || '', reason: '' };
}
function roll(lotId, wash) {
  return { lotId: lotId, lotNumber: lotId, blocked: false, wash: wash, unwash: 0, inWash: 0,
           form: 'Roll', pieces: [], waste: [] };
}
function skuMat(lines, lots, cuts, opts) {
  opts = opts || {};
  return Object.assign({
    materialId: '900', material: 'Dusty Gold Linen', sku: 'RM-900', unit: 'Mtr',
    isFabric: true, isReissue: false, fabricWidthCm: 150,
    required: 0, issued: 0, remaining: 0, availableStock: 500,
    unwashedStock: 0, inWashStock: 0,
    requiredPieces: cuts.reduce((t, c) => t + c.reqPieces, 0),
    issuedPieces: 0, wasteIssuedPieces: 0,
    outstandingPieces: cuts.reduce((t, c) => t + (c.reqPieces - (c.issPieces || 0)), 0),
    freshMeters: 0, piecesCoveredByWaste: 0, freshPieces: 0,
    lines: lines, lots: lots, wasteStock: [], openExceptions: [],
    cuts: cuts, printBase: '', printBaseName: '', printBaseLots: [],
  }, opts);
}
function run(mats) {
  const data = [{ supervisorId: 'S1', supervisorName: 'Suraj', materials: mats }];
  ctx.applyLotAllocation(data);
  ctx.window.__reqData = data;
  return data;
}

// ===========================================================================
console.log('\nA. allocator: ONE entry per SKU spans many cut sizes');
// ===========================================================================
{
  // Two orders. SO-1 wants 10 pcs at 55x90; SO-2 wants 10 pcs at 55x240.
  // perRow 2 for both. 55x90: 5 rows = 4.5m. 55x240: 5 rows = 12.0m. Total 16.5m.
  const lines = [
    line('PI1', 'P1', 'SO-1', 10, 0, 55, 90),
    line('PI2', 'P2', 'SO-2', 10, 0, 55, 240),
  ];
  const cuts = [
    { cutW: 55, cutL: 90, reqPieces: 10, issPieces: 0 },
    { cutW: 55, cutL: 240, reqPieces: 10, issPieces: 0 },
  ];
  const data = run([skuMat(lines, [roll('L1', 200)], cuts)]);
  const m = data[0].materials[0];

  ok('one material entry', data[0].materials.length === 1);
  const total = m.lotLines.reduce((t, l) => t + l.qty, 0);
  ok('lotLines span both cuts', m.lotLines.length === 2, m.lotLines.map(l => [l.planItemId, l.cutW + 'x' + l.cutL, l.qty]));
  ok('metres total = 4.5 + 12.0 = 16.5', Math.abs(total - 16.5) < 0.01, { total });
  ok('remaining headline = 16.5', Math.abs(m.remaining - 16.5) < 0.01, { r: m.remaining });
  const byItem = {};
  m.lotLines.forEach(l => { byItem[l.planItemId] = l; });
  ok('PI1 line carries its 55x90 cut', byItem.PI1.cutW === 55 && byItem.PI1.cutL === 90);
  ok('PI2 line carries its 55x240 cut', byItem.PI2.cutW === 55 && byItem.PI2.cutL === 240);
  ok('PI1 fromRaw = 10 (5 rows x 2)', byItem.PI1.fromRaw === 10, byItem.PI1);
  ok('PI2 fromRaw = 10', byItem.PI2.fromRaw === 10, byItem.PI2);
}

// ===========================================================================
console.log('\nB. render: one <tr>, per-lot boxes, headline = SKU total');
// ===========================================================================
{
  REG = {};
  const lines = [
    line('PI1', 'P1', 'SO-1', 10, 0, 55, 90),
    line('PI2', 'P2', 'SO-2', 10, 0, 55, 240),
  ];
  const cuts = [
    { cutW: 55, cutL: 90, reqPieces: 10, issPieces: 0 },
    { cutW: 55, cutL: 240, reqPieces: 10, issPieces: 0 },
  ];
  const data = run([skuMat(lines, [roll('L1', 200)], cuts)]);
  const m = data[0].materials[0];
  const host = makeEl('tbody');
  host.innerHTML = ctx.renderFabricRows(m, 0, 0);

  const trs = host.querySelectorAll('tr');
  ok('exactly one row for the SKU', trs.length === 1, { n: trs.length });
  const tr = trs[0] || host;
  const lotBox = REG['fab-lot-0-0-0'];
  ok('one lot box rendered (single lot L1)', !!lotBox);
  ok('lot box holds the SKU total 16.5', lotBox && Math.abs(parseFloat(lotBox.value) - 16.5) < 0.01, { v: lotBox && lotBox.value });
  const lotChk = REG['fab-lot-check-0-0-0'];
  ok('lot checkbox present and checked', lotChk && lotChk.checked);
  ok('no leftover single main-row box', !REG['issue-input-0-0']);

  // The box lives in the ISSUE NOW cell, not the LOT cell.
  const issueCell = tr.querySelector && tr.querySelector('.col-issue');
  const lotCell = tr.querySelector && tr.querySelector('.col-lot-issue');
  const stockCell = tr.querySelector && tr.querySelector('.col-lot-stock');
  ok('TOTAL STOCK cell present', !!stockCell);
  ok('box is inside the ISSUE NOW cell', issueCell && !!issueCell.querySelector('#fab-lot-0-0-0'));
  ok('LOT cell does NOT contain the box', lotCell && !lotCell.querySelector('#fab-lot-0-0-0'));
  // LOT cell shows the recommended metres (16.5 for single lot), read as text.
  ok('LOT cell shows the recommendation 16.5', lotCell && /16\.5/.test(textOf(lotCell)),
    { t: lotCell && textOf(lotCell) });
  // TOTAL STOCK shows L1's washed 200.
  ok('TOTAL STOCK shows lot washed 200', stockCell && /200/.test(textOf(stockCell)),
    { t: stockCell && textOf(stockCell) });
}

// ===========================================================================
console.log('\nB2. two lots -> two sub-lines, each with its own stock figure');
// ===========================================================================
{
  REG = {};
  const lines = [
    line('PI1', 'P1', 'SO-1', 10, 0, 55, 275, 'L1'),
    line('PI2', 'P2', 'SO-2', 10, 0, 55, 275, 'L2'),
  ];
  const cuts = [{ cutW: 55, cutL: 275, reqPieces: 20, issPieces: 0 }];
  const data = run([skuMat(lines, [roll('L1', 100), roll('L2', 60)], cuts)]);
  const m = data[0].materials[0];
  const host = makeEl('tbody');
  host.innerHTML = ctx.renderFabricRows(m, 0, 0);
  const tr = host.querySelectorAll('tr')[0];

  ok('L1 box present', !!REG['fab-lot-0-0-0']);
  ok('L2 box present', !!REG['fab-lot-0-0-1']);
  const stockCell = tr.querySelector('.col-lot-stock');
  ok('TOTAL STOCK shows L1 washed 100', /100/.test(textOf(stockCell)), { h: textOf(stockCell) });
  ok('TOTAL STOCK shows L2 washed 60', /\b60\b/.test(textOf(stockCell)), { h: textOf(stockCell) });
}

// ===========================================================================
console.log('\nC. payload: one allocation per plan item, per-cut giveRaw');
// ===========================================================================
{
  REG = {};
  const lines = [
    line('PI1', 'P1', 'SO-1', 10, 0, 55, 90),
    line('PI2', 'P2', 'SO-2', 10, 0, 55, 240),
  ];
  const cuts = [
    { cutW: 55, cutL: 90, reqPieces: 10, issPieces: 0 },
    { cutW: 55, cutL: 240, reqPieces: 10, issPieces: 0 },
  ];
  const data = run([skuMat(lines, [roll('L1', 200)], cuts)]);
  const m = data[0].materials[0];
  const payload = ctx.buildFabricIssueLine(m, []);

  ok('wrapper cutWidth/cutLength = 0', payload.cutWidth === 0 && payload.cutLength === 0);
  ok('two allocations, one per plan item', payload.allocations.length === 2,
    payload.allocations.map(a => [a.planItemId, a.giveQty, a.giveRaw]));
  const aById = {}; payload.allocations.forEach(a => { aById[a.planItemId] = a; });
  ok('PI1 giveRaw 10, giveQty 4.5', aById.PI1.giveRaw === 10 && Math.abs(aById.PI1.giveQty - 4.5) < 0.01, aById.PI1);
  ok('PI2 giveRaw 10, giveQty 12.0', aById.PI2.giveRaw === 10 && Math.abs(aById.PI2.giveQty - 12.0) < 0.01, aById.PI2);
  ok('one lotMove for L1 summing 16.5', payload.lotMoves.length === 1 && Math.abs(payload.lotMoves[0].qty - 16.5) < 0.01, payload.lotMoves);
  const ilById = {}; payload.issueLines.forEach(il => { ilById[il.planItemId] = il; });
  ok('issueLine PI1 carries 55x90', ilById.PI1.cutW === 55 && ilById.PI1.cutL === 90, ilById.PI1);
  ok('issueLine PI2 carries 55x240', ilById.PI2.cutW === 55 && ilById.PI2.cutL === 240, ilById.PI2);
}

// ===========================================================================
console.log('\nD. single-cut regression: payload shape unchanged');
// ===========================================================================
{
  REG = {};
  // One SKU, one cut size, two orders — the pre-change common case.
  const lines = [
    line('PI1', 'P1', 'SO-1', 8, 0, 55, 275),
    line('PI2', 'P2', 'SO-2', 8, 0, 55, 275),
  ];
  const cuts = [{ cutW: 55, cutL: 275, reqPieces: 16, issPieces: 0 }];
  const data = run([skuMat(lines, [roll('L1', 200)], cuts)]);
  const m = data[0].materials[0];
  const payload = ctx.buildFabricIssueLine(m, []);

  // perRow = floor(150/55) = 2. 8 pcs -> 4 rows -> 11.0m each. Total 22.0m.
  ok('two allocations', payload.allocations.length === 2);
  payload.allocations.forEach(a => {
    ok('alloc ' + a.planItemId + ' giveRaw 8', a.giveRaw === 8, a);
    ok('alloc ' + a.planItemId + ' giveQty 11.0', Math.abs(a.giveQty - 11.0) < 0.01, a);
    ok('alloc ' + a.planItemId + ' issuedLot L1', a.issuedLot === 'L1', a);
    ok('alloc ' + a.planItemId + ' has mrqId + planId', !!a.mrqId && !!a.planId);
  });
  ok('one lotMove, 22.0m, not pieces', payload.lotMoves.length === 1 &&
    Math.abs(payload.lotMoves[0].qty - 22.0) < 0.01 && payload.lotMoves[0].isPieces === false, payload.lotMoves);
  ok('issueLines carry the single cut 55x275', payload.issueLines.every(il => il.cutW === 55 && il.cutL === 275));
}

// ===========================================================================
console.log('\nE. partial issue: short cloth starves the LATER order, not both');
// ===========================================================================
{
  REG = {};
  // Two orders each want 10 pcs at 55x275 (perRow 2 -> 5 rows -> 13.75m each = 27.5m).
  // Lot holds only 15m washed -> covers SO-1 whole (13.75) + 1 row of SO-2.
  const lines = [
    line('PI1', 'P1', 'SO-1', 10, 0, 55, 275),
    line('PI2', 'P2', 'SO-2', 10, 0, 55, 275),
  ];
  const cuts = [{ cutW: 55, cutL: 275, reqPieces: 20, issPieces: 0 }];
  const data = run([skuMat(lines, [roll('L1', 15)], cuts, { availableStock: 15 })]);
  const m = data[0].materials[0];
  const payload = ctx.buildFabricIssueLine(m, []);
  const aById = {}; payload.allocations.forEach(a => { aById[a.planItemId] = a; });

  ok('SO-1 (PI1) fully covered: giveRaw 10', aById.PI1 && aById.PI1.giveRaw === 10, aById.PI1);
  const pi2Raw = aById.PI2 ? aById.PI2.giveRaw : 0;
  ok('SO-2 (PI2) starved: giveRaw < 10', pi2Raw < 10, { pi2Raw });
  ok('SO-2 still gets whatever rows fit (>=0)', pi2Raw >= 0);
  // The starved pieces stay open: total credited < total owed.
  const credited = payload.allocations.reduce((t, a) => t + a.giveRaw + a.giveWaste, 0);
  ok('total credited < 20 owed -> requirement stays open', credited < 20, { credited });
}

// ===========================================================================
console.log('\nF. per-lot hand edit: only that lot re-derived, per-line cut');
// ===========================================================================
{
  REG = {};
  // One order, two cut sizes, cloth from ONE lot. Edit the lot down.
  const lines = [
    line('PI1', 'P1', 'SO-1', 10, 0, 55, 90),
    line('PI2', 'P1', 'SO-1', 10, 0, 55, 240),
  ];
  const cuts = [
    { cutW: 55, cutL: 90, reqPieces: 10, issPieces: 0 },
    { cutW: 55, cutL: 240, reqPieces: 10, issPieces: 0 },
  ];
  const data = run([skuMat(lines, [roll('L1', 200)], cuts)]);
  const m = data[0].materials[0];
  const autoTotal = m.lotLines.reduce((t, l) => t + l.qty, 0);   // 16.5
  ok('auto total 16.5', Math.abs(autoTotal - 16.5) < 0.01, { autoTotal });

  // Edit L1 down to 10.0m. Distributed proportionally: 90-cut line ~2.73,
  // 240-cut line ~7.27. Rows: floor(273/90)=3 -> 6pc; floor(727/240)=3 -> 6pc.
  ctx.applyFabricOverride(m, 'L1', 10.0);
  const newTotal = m.lotLines.reduce((t, l) => t + l.qty, 0);
  ok('lines sum to exactly 10.0', Math.abs(newTotal - 10.0) < 0.02, { newTotal });
  const rawTot = m.lotLines.reduce((t, l) => t + l.fromRaw, 0);
  ok('fromRaw re-derived, integers, <= 20 owed', rawTot <= 20 && m.lotLines.every(l => Number.isInteger(l.fromRaw)),
    m.lotLines.map(l => [l.cutW + 'x' + l.cutL, l.qty, l.fromRaw]));
  ok('metresEdited flagged', m.metresEdited === true);
  ok('remaining pinned to auto (not shrunk by the short edit)', Math.abs(m.remaining - 16.5) < 0.01, { r: m.remaining });

  // Payload reflects the edit.
  const payload = ctx.buildFabricIssueLine(m, []);
  const sumGiveQty = payload.allocations.reduce((t, a) => t + a.giveQty, 0);
  ok('payload giveQty sums to ~10.0', Math.abs(sumGiveQty - 10.0) < 0.05, { sumGiveQty });

  // Restore.
  ctx.applyFabricOverride(m, 'L1', 16.5);
  ok('restore -> metresEdited false, total 16.5', !m.metresEdited &&
    Math.abs(m.lotLines.reduce((t, l) => t + l.qty, 0) - 16.5) < 0.01);
}

// ===========================================================================
console.log('\nG. two lots on one SKU: editing lot A leaves lot B alone');
// ===========================================================================
{
  REG = {};
  // Two pinned orders, each to its own lot, same cut size.
  const lines = [
    line('PI1', 'P1', 'SO-1', 10, 0, 55, 275, 'L1'),
    line('PI2', 'P2', 'SO-2', 10, 0, 55, 275, 'L2'),
  ];
  const cuts = [{ cutW: 55, cutL: 275, reqPieces: 20, issPieces: 0 }];
  const data = run([skuMat(lines, [roll('L1', 100), roll('L2', 100)], cuts)]);
  const m = data[0].materials[0];
  const lotB_before = ctx.lotLineMetres(m, 'L2');

  ctx.applyFabricOverride(m, 'L1', 5.0);
  ok('lot L1 now ~5.0', Math.abs(ctx.lotLineMetres(m, 'L1') - 5.0) < 0.05, { a: ctx.lotLineMetres(m, 'L1') });
  ok('lot L2 unchanged', Math.abs(ctx.lotLineMetres(m, 'L2') - lotB_before) < 0.001, { b: ctx.lotLineMetres(m, 'L2'), was: lotB_before });

  const payload = ctx.buildFabricIssueLine(m, []);
  const aById = {}; payload.allocations.forEach(a => { aById[a.planItemId] = a; });
  ok('PI1 giveQty ~5.0', Math.abs(aById.PI1.giveQty - 5.0) < 0.05, aById.PI1);
  ok('PI2 giveQty unchanged (~13.75)', Math.abs(aById.PI2.giveQty - 13.75) < 0.05, aById.PI2);
  ok('two lotMoves, L1 and L2', payload.lotMoves.length === 2);
}

// ===========================================================================
console.log('\nH. headline TO BE ISSUED == Σ lot lines (per-item rounding shown)');
// ===========================================================================
{
  // 4 items, each 7 pcs, SAME cut 55x90 on 150cm fabric -> perRow 2.
  // Per item: ceil(7/2) = 4 rows -> 3.6m each  => Σ = 14.4m  (what leaves the roll)
  // Planning estimate: ceil(28/2) = 14 rows -> 12.6m         (the OLD headline)
  // The gap (1.8m) is 4 items x 1 part-row. Headline must now show 14.4, not 12.6.
  REG = {};
  const lines = [
    line('PI1', 'P1', 'SO-1', 7, 0, 55, 90),
    line('PI2', 'P2', 'SO-2', 7, 0, 55, 90),
    line('PI3', 'P3', 'SO-3', 7, 0, 55, 90),
    line('PI4', 'P4', 'SO-4', 7, 0, 55, 90),
  ];
  const cuts = [{ cutW: 55, cutL: 90, reqPieces: 28, issPieces: 0 }];
  const data = run([skuMat(lines, [roll('L1', 500)], cuts)]);
  const m = data[0].materials[0];

  const lotTotal = m.lotLines.reduce((t, l) => t + l.qty, 0);
  ok('4 lot lines, 3.6m each', m.lotLines.length === 4 &&
    m.lotLines.every(l => Math.abs(l.qty - 3.6) < 0.01), m.lotLines.map(l => l.qty));
  ok('Σ lot lines = 14.4 (per-item marker rows)', Math.abs(lotTotal - 14.4) < 0.01, { lotTotal });
  ok('m.remaining (TO BE ISSUED) == Σ lot lines, NOT the 12.6 estimate',
    Math.abs(m.remaining - 14.4) < 0.01, { remaining: m.remaining });

  // payload still credits only 7 pcs per item (the cut-piece math is intact)
  const payload = ctx.buildFabricIssueLine(m, []);
  ok('each allocation giveRaw = 7 (per-item pieces preserved)',
    payload.allocations.length === 4 && payload.allocations.every(a => a.giveRaw === 7),
    payload.allocations.map(a => a.giveRaw));
  ok('one lotMove summing 14.4', payload.lotMoves.length === 1 &&
    Math.abs(payload.lotMoves[0].qty - 14.4) < 0.01, payload.lotMoves);
}

// explicit mrqId, so one planItemId can carry two requirement rows.
function lineQ(mrqId, planItemId, planId, salesOrder, reqPcs, issPcs, cutW, cutL, issuedLot) {
  return { mrqId: mrqId, planId: planId, salesOrder: salesOrder,
           planItemId: planItemId, item: 'Item ' + planItemId, isRemake: false,
           supervisorId: 'S1', required: 0, issued: 0, reqPieces: reqPcs, issPieces: issPcs || 0,
           cutW: cutW, cutL: cutL, issuedLot: issuedLot || '', issuedLotNo: issuedLot || '', reason: '' };
}

// ===========================================================================
console.log('\nI. BUG 1: one Plan_Item, same fabric, TWO cut sizes -> both mrqs credited');
// ===========================================================================
{
  // One order P1, one item PI1, SAME fabric at two cuts:
  //   MRQ-A: 55x90  needs 10 pcs  (perRow floor(150/55)=2 -> 5 rows -> 4.5m)
  //   MRQ-B: 140x60 needs 6 pcs   (perRow floor(150/140)=1 -> 6 rows -> 3.6m)
  REG = {};
  const lines = [
    lineQ('MRQ-A', 'PI1', 'P1', 'SO-1', 10, 0, 55, 90),
    lineQ('MRQ-B', 'PI1', 'P1', 'SO-1', 6, 0, 140, 60),
  ];
  const cuts = [
    { cutW: 55, cutL: 90, reqPieces: 10, issPieces: 0 },
    { cutW: 140, cutL: 60, reqPieces: 6, issPieces: 0 },
  ];
  const data = run([skuMat(lines, [roll('L1', 500)], cuts)]);
  const m = data[0].materials[0];

  ok('allocator makes 2 lot lines (one per cut), both stamped with mrqId',
    m.lotLines.length === 2 && m.lotLines.every(l => !!l.mrqId),
    m.lotLines.map(l => [l.mrqId, l.cutW + 'x' + l.cutL, l.qty, l.fromRaw]));

  const payload = ctx.buildFabricIssueLine(m, []);
  ok('payload has TWO allocations, one per requirement row', payload.allocations.length === 2,
    payload.allocations.map(a => [a.mrqId, a.giveQty, a.giveRaw]));
  const byMrq = {}; payload.allocations.forEach(a => { byMrq[a.mrqId] = a; });
  ok('MRQ-A credited: giveRaw 10, giveQty 4.5',
    byMrq['MRQ-A'] && byMrq['MRQ-A'].giveRaw === 10 && Math.abs(byMrq['MRQ-A'].giveQty - 4.5) < 0.01, byMrq['MRQ-A']);
  ok('MRQ-B credited: giveRaw 6, giveQty 3.6',
    byMrq['MRQ-B'] && byMrq['MRQ-B'].giveRaw === 6 && Math.abs(byMrq['MRQ-B'].giveQty - 3.6) < 0.01, byMrq['MRQ-B']);
  ok('neither over-credited past its own owed',
    byMrq['MRQ-A'].giveRaw <= 10 && byMrq['MRQ-B'].giveRaw <= 6);
  const ilByMrq = {}; payload.issueLines.forEach(il => { ilByMrq[il.mrqId] = il; });
  ok('issueLine MRQ-A carries cut 55x90', ilByMrq['MRQ-A'] && ilByMrq['MRQ-A'].cutW === 55 && ilByMrq['MRQ-A'].cutL === 90, ilByMrq['MRQ-A']);
  ok('issueLine MRQ-B carries cut 140x60', ilByMrq['MRQ-B'] && ilByMrq['MRQ-B'].cutW === 140 && ilByMrq['MRQ-B'].cutL === 60, ilByMrq['MRQ-B']);
  ok('one lotMove, summing 8.1m off L1', payload.lotMoves.length === 1 && Math.abs(payload.lotMoves[0].qty - 8.1) < 0.01, payload.lotMoves);
}

// ===========================================================================
console.log('\nJ. BUG 1 + edit: per-lot override caps each requirement row separately');
// ===========================================================================
{
  REG = {};
  const lines = [
    lineQ('MRQ-A', 'PI1', 'P1', 'SO-1', 10, 0, 55, 90),
    lineQ('MRQ-B', 'PI1', 'P1', 'SO-1', 6, 0, 140, 60),
  ];
  const cuts = [
    { cutW: 55, cutL: 90, reqPieces: 10, issPieces: 0 },
    { cutW: 140, cutL: 60, reqPieces: 6, issPieces: 0 },
  ];
  const data = run([skuMat(lines, [roll('L1', 500)], cuts)]);
  const m = data[0].materials[0];
  // Edit L1 down to 5.0m total. 4.5 + 3.6 = 8.1 auto -> scale ~0.617.
  ctx.applyFabricOverride(m, 'L1', 5.0);
  const total = m.lotLines.reduce((t, l) => t + l.qty, 0);
  ok('lot lines sum to 5.0', Math.abs(total - 5.0) < 0.02, { total });
  const rawByMrq = {};
  m.lotLines.forEach(l => { rawByMrq[l.mrqId] = (rawByMrq[l.mrqId] || 0) + l.fromRaw; });
  ok('MRQ-A fromRaw capped <= its owed 10 and whole-row',
    rawByMrq['MRQ-A'] <= 10 && Number.isInteger(rawByMrq['MRQ-A']), rawByMrq);
  ok('MRQ-B fromRaw capped <= its OWN owed 6 (not MRQ-A\'s 10)',
    rawByMrq['MRQ-B'] <= 6 && Number.isInteger(rawByMrq['MRQ-B']), rawByMrq);
  const payload = ctx.buildFabricIssueLine(m, []);
  ok('payload still has 2 allocations after the edit', payload.allocations.length === 2);
  payload.allocations.forEach(a => {
    var cap = a.mrqId === 'MRQ-A' ? 10 : 6;
    ok(a.mrqId + ' giveRaw <= ' + cap, a.giveRaw <= cap, a);
  });
}

// ===========================================================================
console.log('\nK. BUG 2: SKU demand split across pages -> headline uses merged cuts');
// ===========================================================================
{
  // Simulate the post-merge shape: m.cuts carries only page 1's cut (55x90),
  // but m.lines carries BOTH (page 2 added 140x60). The allocator must size the
  // headline from the union, not from the incomplete m.cuts.
  REG = {};
  const lines = [
    line('PI1', 'P1', 'SO-1', 10, 0, 55, 90),   // "page 1"
    line('PI2', 'P2', 'SO-2', 6, 0, 140, 60),   // "page 2"
  ];
  const cutsPage1Only = [{ cutW: 55, cutL: 90, reqPieces: 10, issPieces: 0 }]; // 140x60 MISSING
  const data = run([skuMat(lines, [roll('L1', 500)], cutsPage1Only)]);
  const m = data[0].materials[0];

  // 55x90: 5 rows -> 4.5m.  140x60: 6 rows -> 3.6m.  Union total 8.1m.
  const lotTotal = m.lotLines.reduce((t, l) => t + l.qty, 0);
  ok('both cuts allocated despite m.cuts missing 140x60',
    m.lotLines.length === 2 && Math.abs(lotTotal - 8.1) < 0.01, m.lotLines.map(l => [l.cutW + 'x' + l.cutL, l.qty]));
  ok('headline (m.remaining) == 8.1, not the 4.5 that page-1 cuts alone would give',
    Math.abs(m.remaining - 8.1) < 0.01, { remaining: m.remaining });
}

console.log('\n========================================');
console.log('sku-row: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
