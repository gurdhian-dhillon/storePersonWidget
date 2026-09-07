/* Stock In tab — roll-entry integration tests. lot-rolls-model.md Step 6.
 *
 * Covers: rendering roll rows from stockRolls state, add/remove mutating that
 * state and only re-rendering the rolls block + footer (never the row being
 * typed in), the footer's exact-sum gate (button disabled until rolls total
 * the unallocated figure), submitStockIn's client-side validation (label
 * required, length > 0, no duplicate label within one submission, sum must
 * match exactly), and the on-blur collision check against getStoreLots'
 * rollLabels.
 */
const vm = require('vm');
const fs = require('fs');
const assert = require('assert');

const ROOT = 'C:/Users/gurdh/OneDrive/Desktop/getStoreMaterial/storePersonWidget/app/js/';

// ---- tiny DOM stub, same shape as sku-row.test.js's -------------------------
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
  if (sel.indexOf('.') > 0 && sel[0] !== '.') {
    return sel.split('.').filter(Boolean).every((c, i) =>
      i === 0 && sel[0] !== '.' ? el.tagName === c.toUpperCase() : el._class.has(c));
  }
  if (sel.startsWith('.')) return sel.slice(1).split('.').every(c => el._class.has(c));
  if (sel.startsWith('#')) return el._id === sel.slice(1);
  return el.tagName === sel.toUpperCase();
}
function query(root, sel, first) {
  const out = [];
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
  console, alert: (m) => { ctx.__alerts.push(m); }, setTimeout: (f) => { try { f(); } catch (e) {} },
  clearTimeout() {}, navigator: { userAgent: 'node' }, location: { href: '', search: '' },
  ZOHO: { CREATOR: { init: () => Promise.resolve(), DATA: { invokeCustomApi: () => Promise.resolve({ code: 3000, result: {} }) } } },
};
ctx.__alerts = [];
ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.globalThis = ctx;
vm.createContext(ctx);
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

// ---- fixture: one material, 50 Mtr unallocated, one existing lot with rolls -
function mat(unallocated, existingRollLabels) {
  return {
    materialId: 'M1', sku: 'RM-1', material: 'Dusty Gold Linen', unit: 'Mtr',
    wash: 0, unwash: 0, unallocated: unallocated, inWash: 0, lotCount: 1,
    lots: [{
      lotId: 'L1', lotNumber: 'L1', label: '', status: 'Active',
      unwash: 0, wash: 0, inTransit: 0, disputed: 0, inWash: 0,
      rollLabels: existingRollLabels || []
    }]
  };
}

// getElementById only finds what is actually on the page - VIV auto-creates
// during the initial module load ONLY, so every test mounts the same shell
// stockCardBodyHtml's real HTML would have put there: the card itself (what
// toggleStockCard looks up), the lot <select>, and the two containers the
// roll functions write into (si-rolls-<id>, si-foot-<id>). The row inputs
// inside si-rolls (si-rl-lbl-/si-rl-len-) come from setting its innerHTML,
// same as the real render does, and register themselves into REG as a side
// effect of that - see renderCard below.
function mountCard(matId) {
  const card = makeEl('div'); card.id = 'si-card-' + matId;
  makeEl('div').id = 'si-rolls-' + matId;
  makeEl('div').id = 'si-foot-' + matId;
  makeEl('select').id = 'si-lot-' + matId;
  return card;
}

function renderCard(m) {
  ctx.document.getElementById('si-rolls-' + m.materialId).innerHTML = ctx.stockRollLinesHtml(m);
  ctx.document.getElementById('si-foot-' + m.materialId).innerHTML = ctx.stockRollFooterHtml(m);
}

function setup(unallocated, existingRollLabels) {
  REG = {};
  ctx.__alerts = [];
  ctx.stockMats = [mat(unallocated, existingRollLabels)];
  ctx.stockRolls = {};
  ctx.stockOpenId = null;
  mountCard('M1');
  return ctx.stockMats[0];
}

// ===========================================================================
console.log('\nA. opening a card seeds exactly one empty roll row');
// ===========================================================================
{
  setup(50);
  ctx.toggleStockCard('M1');
  ok('one row seeded', ctx.stockRolls.M1.length === 1, ctx.stockRolls.M1);
  ok('row starts empty', ctx.stockRolls.M1[0].label === '' && ctx.stockRolls.M1[0].length === '');

  // Reopening (toggle off then on) must NOT reset what he already typed.
  ctx.stockRolls.M1[0] = { label: 'L1-R1', length: '30' };
  ctx.toggleStockCard('M1'); // close
  ctx.toggleStockCard('M1'); // reopen
  ok('reopening keeps the typed row', ctx.stockRolls.M1[0].label === 'L1-R1' &&
    ctx.stockRolls.M1[0].length === '30', ctx.stockRolls.M1);
}

// ===========================================================================
console.log('\nB. add / remove roll lines');
// ===========================================================================
{
  const m = setup(50);
  ctx.toggleStockCard('M1');
  renderCard(m);

  ctx.document.getElementById('si-rl-lbl-M1-0').value = 'L1-R1';
  ctx.document.getElementById('si-rl-len-M1-0').value = '30';
  ctx.addStockRollLine('M1');
  ok('add creates a second row', ctx.stockRolls.M1.length === 2, ctx.stockRolls.M1);
  ok('first row survived the add', ctx.stockRolls.M1[0].label === 'L1-R1' &&
    ctx.stockRolls.M1[0].length === '30');

  ctx.document.getElementById('si-rl-lbl-M1-1').value = 'L1-R2';
  ctx.document.getElementById('si-rl-len-M1-1').value = '20';
  ctx.refreshStockRollTotals('M1');
  ok('total reads 50 of 50 after both rows filled',
    ctx.document.getElementById('si-foot-M1').innerHTML.indexOf('50 of 50') !== -1,
    ctx.document.getElementById('si-foot-M1').innerHTML);

  ctx.removeStockRollLine('M1', 0);
  ok('remove drops to one row', ctx.stockRolls.M1.length === 1, ctx.stockRolls.M1);
  ok('remaining row is the second one that was typed',
    ctx.stockRolls.M1[0].label === 'L1-R2' && ctx.stockRolls.M1[0].length === '20');

  // Removing the LAST row must never leave zero rows — at least one is
  // mandatory, so the UI itself cannot produce an empty submission shape.
  ctx.removeStockRollLine('M1', 0);
  ok('removing the only row leaves one EMPTY row, never zero',
    ctx.stockRolls.M1.length === 1 && ctx.stockRolls.M1[0].label === '', ctx.stockRolls.M1);
}

// ===========================================================================
console.log('\nC. footer gate: button disabled until the sum matches EXACTLY');
// ===========================================================================
{
  const m = setup(50);
  ctx.toggleStockCard('M1');
  ctx.stockRolls.M1 = [{ label: 'L1-R1', length: '30' }];
  var html1 = ctx.stockRollFooterHtml(m);
  ok('under-total: disabled', /disabled/.test(html1), html1);
  ok('under-total: shows the shortfall message', /must total exactly/.test(html1));

  ctx.stockRolls.M1 = [{ label: 'L1-R1', length: '30' }, { label: 'L1-R2', length: '20' }];
  var html2 = ctx.stockRollFooterHtml(m);
  ok('exact total: NOT disabled', !/disabled/.test(html2), html2);

  ctx.stockRolls.M1 = [{ label: 'L1-R1', length: '30' }, { label: 'L1-R2', length: '20.003' }];
  var html3 = ctx.stockRollFooterHtml(m);
  ok('within float-rounding tolerance still reads as matching',
    !/disabled/.test(html3), html3);

  ctx.stockRolls.M1 = [{ label: 'L1-R1', length: '30' }, { label: 'L1-R2', length: '25' }];
  var html4 = ctx.stockRollFooterHtml(m);
  ok('over-total: disabled too, not just under', /disabled/.test(html4), html4);
}

// ===========================================================================
console.log('\nD. onStockRollLabelBlur: collision check against existing + within-submission');
// ===========================================================================
{
  const m = setup(50, ['L1-R1', 'L1-R2']);
  ctx.toggleStockCard('M1');
  renderCard(m);
  ctx.document.getElementById('si-lot-M1').value = 'L1';

  // Collides with an EXISTING roll on the selected lot.
  ctx.document.getElementById('si-rl-lbl-M1-0').value = 'l1-r1'; // case-insensitive
  ctx.onStockRollLabelBlur('M1', 0);
  ok('flags input invalid on existing-roll clash',
    ctx.document.getElementById('si-rl-lbl-M1-0').classList.contains('invalid'));
  ok('alert names the existing-lot clash', ctx.__alerts.some(a => /already exists on this lot/.test(a)),
    ctx.__alerts);

  // A label that does not clash clears the flag.
  ctx.__alerts = [];
  ctx.document.getElementById('si-rl-lbl-M1-0').value = 'L1-R9';
  ctx.onStockRollLabelBlur('M1', 0);
  ok('clean label is not flagged invalid',
    !ctx.document.getElementById('si-rl-lbl-M1-0').classList.contains('invalid'));
  ok('no alert for a clean label', ctx.__alerts.length === 0, ctx.__alerts);

  // Duplicate WITHIN this submission (two rows typed the same label).
  ctx.addStockRollLine('M1');
  ctx.document.getElementById('si-rl-lbl-M1-1').value = 'L1-R9';
  ctx.onStockRollLabelBlur('M1', 1);
  ok('flags the SECOND row as invalid, not the first',
    ctx.document.getElementById('si-rl-lbl-M1-1').classList.contains('invalid'));
  ok('alert names the within-submission duplicate',
    ctx.__alerts.some(a => /entered twice/.test(a)), ctx.__alerts);

  // Blank label is never flagged - emptiness is caught at submit, not on blur.
  ctx.__alerts = [];
  ctx.document.getElementById('si-rl-lbl-M1-1').value = '   ';
  ctx.onStockRollLabelBlur('M1', 1);
  ok('blank label is not flagged on blur',
    !ctx.document.getElementById('si-rl-lbl-M1-1').classList.contains('invalid'));
}

// ===========================================================================
console.log('\nE. submitStockIn: client-side validation gates the API call');
// ===========================================================================
{
  function primeSubmitDom(m) {
    ctx.toggleStockCard('M1');
    ctx.document.getElementById('si-lot-M1').value = 'L1'; // existing lot, no new-lot-number requirement
    renderCard(m);
  }

  // E1: empty label blocks submit before any network call.
  {
    const m = setup(50, []);
    primeSubmitDom(m);
    ctx.document.getElementById('si-rl-len-M1-0').value = '50';
    var called = false;
    var savedApi = ctx.ZOHO.CREATOR.DATA.invokeCustomApi;
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = () => { called = true; return Promise.resolve({ result: '{}' }); };
    ctx.submitStockIn('M1');
    ok('E1 blank label never reaches invokeCustomApi', called === false);
    ok('E1 alert says a label is needed', ctx.__alerts.some(a => /needs a label/.test(a)), ctx.__alerts);
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = savedApi;
  }

  // E2: zero/negative length blocks submit.
  {
    const m = setup(50, []);
    primeSubmitDom(m);
    ctx.document.getElementById('si-rl-lbl-M1-0').value = 'L1-R1';
    ctx.document.getElementById('si-rl-len-M1-0').value = '0';
    ctx.__alerts = [];
    var called = false;
    var savedApi = ctx.ZOHO.CREATOR.DATA.invokeCustomApi;
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = () => { called = true; return Promise.resolve({ result: '{}' }); };
    ctx.submitStockIn('M1');
    ok('E2 zero length never reaches invokeCustomApi', called === false);
    ok('E2 alert says length must be greater than zero',
      ctx.__alerts.some(a => /greater than zero/.test(a)), ctx.__alerts);
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = savedApi;
  }

  // E3: duplicate label within the submission blocks submit.
  {
    const m = setup(50, []);
    primeSubmitDom(m);
    ctx.document.getElementById('si-rl-lbl-M1-0').value = 'L1-R1';
    ctx.document.getElementById('si-rl-len-M1-0').value = '25';
    ctx.addStockRollLine('M1');
    ctx.document.getElementById('si-rl-lbl-M1-1').value = 'l1-r1';
    ctx.document.getElementById('si-rl-len-M1-1').value = '25';
    ctx.__alerts = [];
    var called = false;
    var savedApi = ctx.ZOHO.CREATOR.DATA.invokeCustomApi;
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = () => { called = true; return Promise.resolve({ result: '{}' }); };
    ctx.submitStockIn('M1');
    ok('E3 duplicate label never reaches invokeCustomApi', called === false);
    ok('E3 alert names the duplicate', ctx.__alerts.some(a => /entered twice/.test(a)), ctx.__alerts);
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = savedApi;
  }

  // E4: sum not matching the unallocated total blocks submit.
  {
    const m = setup(50, []);
    primeSubmitDom(m);
    ctx.document.getElementById('si-rl-lbl-M1-0').value = 'L1-R1';
    ctx.document.getElementById('si-rl-len-M1-0').value = '40';
    ctx.__alerts = [];
    var called = false;
    var savedApi = ctx.ZOHO.CREATOR.DATA.invokeCustomApi;
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = () => { called = true; return Promise.resolve({ result: '{}' }); };
    ctx.submitStockIn('M1');
    ok('E4 mismatched sum never reaches invokeCustomApi', called === false);
    ok('E4 alert says the totals must match exactly',
      ctx.__alerts.some(a => /must match exactly/.test(a)), ctx.__alerts);
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = savedApi;
  }

  // E5: a VALID submission (exact sum, unique labels, existing lot) reaches
  // the API with a rolls[] payload, not a lump qty.
  {
    const m = setup(50, []);
    primeSubmitDom(m);
    ctx.document.getElementById('si-rl-lbl-M1-0').value = 'L1-R1';
    ctx.document.getElementById('si-rl-len-M1-0').value = '30';
    ctx.addStockRollLine('M1');
    ctx.document.getElementById('si-rl-lbl-M1-1').value = 'L1-R2';
    ctx.document.getElementById('si-rl-len-M1-1').value = '20';
    ctx.__alerts = [];
    var sentPayload = null;
    var savedApi = ctx.ZOHO.CREATOR.DATA.invokeCustomApi;
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = (opts) => {
      sentPayload = JSON.parse(opts.payload.inwardJson);
      return { then: () => ({ catch: () => {} }) };
    };
    ctx.submitStockIn('M1');
    ok('E5 valid submission reaches the API', sentPayload !== null, sentPayload);
    ok('E5 payload has NO qty field (rolls only)', sentPayload && sentPayload.qty === undefined,
      sentPayload);
    ok('E5 payload carries both rolls with label+length',
      sentPayload && sentPayload.rolls && sentPayload.rolls.length === 2 &&
      sentPayload.rolls[0].label === 'L1-R1' && sentPayload.rolls[0].length === 30 &&
      sentPayload.rolls[1].label === 'L1-R2' && sentPayload.rolls[1].length === 20,
      sentPayload && sentPayload.rolls);
    ok('E5 no alert on a valid submission', ctx.__alerts.length === 0, ctx.__alerts);
    ctx.ZOHO.CREATOR.DATA.invokeCustomApi = savedApi;
  }
}

console.log('\n' + '='.repeat(40));
console.log('stock-in-rolls: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
