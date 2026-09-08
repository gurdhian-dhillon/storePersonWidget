#!/usr/bin/env node
// ---- THE STORE ISSUE SCREEN, END TO END ----
//
// Everything the store person sees on the Issue tab has to be right the moment
// he presses Refresh, and stay right through a priority change, a declined
// remnant and a hand-edited metres box. That is four separate pieces of state
// (the raw payload, the allocation, the draft order, the applied order) and the
// screen is only correct when all four agree.
//
// What this pins:
//   A  Refresh — merge, allocate, filter, cache: the four caches agree
//   B  Priority — move / apply / cancel, and the numbers that follow
//   C  Fresh vs waste allocation is stable across a re-render
//   D  "What is missing" — the wash list and the PO list
//   E  Idempotence — a second Refresh over the same payload changes nothing
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// ---- a DOM stub with real element state, so render() can be driven ----
function makeDoc() {
  const els = {};
  const mk = (id) => {
    const e = {
      id: id, _cls: {}, value: '', textContent: '', innerHTML: '',
      disabled: false, hidden: false, style: {}, checked: false,
      children: [], dataset: {},
      classList: {
        add(c) { e._cls[c] = true; }, remove(c) { delete e._cls[c]; },
        contains(c) { return !!e._cls[c]; }, toggle(c) { e._cls[c] = !e._cls[c]; }
      },
      addEventListener() {}, appendChild() {}, removeAttribute(k) { delete e['_a_' + k]; },
      setAttribute(k, v) { e['_a_' + k] = v; }, getAttribute(k) { return e['_a_' + k]; },
      scrollIntoView() {}, focus() {}, querySelector: () => mk('q'), querySelectorAll: () => []
    };
    return e;
  };
  return {
    _els: els,
    getElementById(id) { if (!els[id]) els[id] = mk(id); return els[id]; },
    querySelector(s) { return this.getElementById('sel:' + s); },
    querySelectorAll() { return []; },
    createElement(t) { return mk('new:' + t); },
    addEventListener() {},
    body: { appendChild() {} }
  };
}

function load() {
  const doc = makeDoc();
  const sb = {
    window: {}, document: doc, console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {}, table() {} },
    ZOHO: { CREATOR: { DATA: {} } }, alert() {}, setTimeout: (f) => f && 0,
    requestAnimationFrame: () => 0,
    JSON, Math, Number, String, Object, Array, Date, isFinite, parseFloat, parseInt
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/lot-allocator.js'), 'utf8'), sb);
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/main.js'), 'utf8'), sb); } catch (e) {}
  return sb;
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  — ' + detail); }
}

// ---- payload fixtures, in the server's shape ----
const roll = (id, len) => ({ rollId: id, label: id.toUpperCase(), length: len, status: 'Available' });
const lotOf = (id, o) => Object.assign(
  { lotId: id, lotNumber: id, wash: 0, unwash: 0, inWash: 0, blocked: false, rolls: [], form: 'Roll' }, o);

// A fabric row for one supervisor. `lines` are the requirement rows.
function fabric(o) {
  const lines = o.lines || [];
  const req = lines.reduce((s, l) => s + (l.reqPieces || 0), 0);
  const iss = lines.reduce((s, l) => s + (l.issPieces || 0), 0);
  return Object.assign({
    materialId: '9', material: 'Linen Fabric', sku: 'RM-9', unit: 'Mtr',
    isFabric: true, isReissue: false, fabricWidthCm: 150,
    required: req, issued: iss, remaining: Math.max(0, req - iss),
    requiredPieces: req, issuedPieces: iss, outstandingPieces: Math.max(0, req - iss),
    requiredTotal: req,
    availableStock: 0, unwashedStock: 0, inWashStock: 0, unallocatedQty: 0,
    poCoveredQty: 0, openExceptions: [], lots: [], wasteStock: [],
    cuts: lines.map(l => ({ cutW: l.cutW, cutL: l.cutL, reqPieces: l.reqPieces, issPieces: l.issPieces || 0 })),
    freshMeters: 0
  }, o);
}

function trim(o) {
  return Object.assign({
    materialId: '20', material: 'Thread', sku: 'RM-20', unit: 'Cone',
    isFabric: false, isReissue: false,
    required: 0, issued: 0, remaining: 0, requiredTotal: 0,
    availableStock: 0, unwashedStock: 0, inWashStock: 0,
    poCoveredQty: 0, openExceptions: [], lines: []
  }, o);
}

const sup = (id, name, mats) => ({ supervisorId: id, supervisorName: name, materials: mats });

// ============================================================
console.log('\n=== A. REFRESH: merge -> allocate -> filter -> cache ===');
// ============================================================
{
  const S = load();
  // Two lots of the same fabric, 30m each. Two supervisors want 20 pieces each
  // at 1 piece/row x 1m => 20m apiece. Rack covers both, one lot each.
  const mkData = () => [
    sup('A', 'Suraj', [fabric({
      availableStock: 60,
      lots: [lotOf('L1', { wash: 30, rolls: [roll('r1', 30)] }),
             lotOf('L2', { wash: 30, rolls: [roll('r2', 30)] })],
      lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA', cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0, priorityKey: 100 }]
    })]),
    sup('B', 'Aniket', [fabric({
      availableStock: 60,
      lots: [lotOf('L1', { wash: 30, rolls: [roll('r1', 30)] }),
             lotOf('L2', { wash: 30, rolls: [roll('r2', 30)] })],
      lines: [{ planId: 'pB', planItemId: 'iB', mrqId: 'mB', cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0, priorityKey: 200 }]
    })])
  ];

  S.render(mkData());

  const raw = S.window.__rawData, req = S.window.__reqData;
  ok('__rawData holds every supervisor', raw.length === 2, 'len=' + raw.length);
  ok('__reqData holds the actionable ones', req.length === 2, 'len=' + req.length);

  const totalIssued = raw.reduce((s, sp) => s + sp.materials.reduce(
    (t, m) => t + (m.lotLines || []).reduce((x, l) => x + l.qty, 0), 0), 0);
  ok('never allocates more than the rack', totalIssued <= 60.0001, 'allocated=' + totalIssued);
  ok('both supervisors served', totalIssued === 40, 'allocated=' + totalIssued + ' (20m each)');

  // Each order whole, off ONE lot
  raw.forEach(sp => sp.materials.forEach(m => {
    const byOrder = {};
    (m.lotLines || []).forEach(l => {
      byOrder[l.planId] = byOrder[l.planId] || new Set();
      byOrder[l.planId].add(l.lotId);
    });
    Object.keys(byOrder).forEach(o =>
      ok('order ' + o + ' cut from one lot', byOrder[o].size === 1,
        'lots=' + [...byOrder[o]].join(',')));
  }));

  // The two cards must not both be given the same roll
  const perRoll = {};
  raw.forEach(sp => sp.materials.forEach(m => (m.lotLines || []).forEach(l =>
    (l.rolls || []).forEach(r => {
      const k = l.lotId + '|' + r.rollId;
      perRoll[k] = Math.round(((perRoll[k] || 0) + r.metres) * 100) / 100;
    }))));
  Object.keys(perRoll).forEach(k =>
    ok('roll ' + k + ' not over-cut', perRoll[k] <= 30.0001, 'cut=' + perRoll[k]));
}

// ============================================================
console.log('\n=== B. PRIORITY: move / cancel / apply ===');
// ============================================================
{
  const S = load();
  // ONE lot of 20m; both want 20m. Only the first card can be served.
  const mkData = () => ['A', 'B'].map((id, i) => sup(id, 'S' + id, [fabric({
    availableStock: 20,
    lots: [lotOf('L1', { wash: 20, rolls: [roll('r1', 20)] })],
    lines: [{ planId: 'p' + id, planItemId: 'i' + id, mrqId: 'm' + id,
              cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0, priorityKey: 100 + i }]
  })]));

  S.render(mkData());
  const served = () => (S.window.__rawData || []).map(sp => ({
    id: sp.supervisorId,
    m: sp.materials.reduce((t, m) => t + (m.lotLines || []).reduce((x, l) => x + l.qty, 0), 0)
  }));

  let s0 = served();
  const first0 = S.window.__reqData[0].supervisorId;
  ok('card order is the priority order', first0 === 'A', 'first=' + first0);
  ok('only the top card is served', s0.filter(x => x.m > 0).length === 1,
    JSON.stringify(s0));
  ok('the top card gets it', s0.find(x => x.id === 'A').m === 20, JSON.stringify(s0));

  // --- move B up: DRAW changes, numbers must NOT ---
  S.movePriority('B', -1);
  const drawnFirst = S.window.__reqData[0].supervisorId;
  ok('draft reorders the cards', drawnFirst === 'B', 'first=' + drawnFirst);
  let s1 = served();
  ok('draft does NOT move the cloth yet', s1.find(x => x.id === 'A').m === 20,
    JSON.stringify(s1) + ' (the Apply bar says the figures are stale)');

  // --- cancel: back to the applied order ---
  S.cancelPriorityOrder();
  ok('cancel restores the applied order', S.window.__reqData[0].supervisorId === 'A',
    'first=' + S.window.__reqData[0].supervisorId);
  ok('cancel leaves the numbers alone', served().find(x => x.id === 'A').m === 20,
    JSON.stringify(served()));

  // --- move B up and APPLY: now the cloth follows ---
  S.movePriority('B', -1);
  S.applyPriorityOrder();
  const s2 = served();
  ok('apply re-allocates', s2.find(x => x.id === 'B').m === 20, JSON.stringify(s2));
  ok('and takes it off the other card', s2.find(x => x.id === 'A').m === 0, JSON.stringify(s2));
  ok('still never over-issues', s2.reduce((t, x) => t + x.m, 0) <= 20.0001, JSON.stringify(s2));
  ok('card order follows the applied order', S.window.__reqData[0].supervisorId === 'B',
    'first=' + S.window.__reqData[0].supervisorId);

  // --- the applied order SURVIVES a refresh with fresh server data ---
  S.render(mkData());
  const s3 = served();
  ok('applied order survives Refresh', S.window.__reqData[0].supervisorId === 'B',
    'first=' + S.window.__reqData[0].supervisorId);
  ok('and the allocation follows it', s3.find(x => x.id === 'B').m === 20, JSON.stringify(s3));
}

// ============================================================
console.log('\n=== C. FRESH vs WASTE, stable across re-render ===');
// ============================================================
{
  const S = load();
  // 6 pieces wanted at 150x100. ONE remnant of 150x150 yields
  // floor(150/150) x floor(150/100) = 1 cut, so the single remnant on the rack
  // covers exactly 1 piece and fresh cloth must cover the other 5.
  //
  // The remnant geometry is deliberate. An earlier version of this fixture used
  // 150x400 remnants and asserted "2 remnants = 2 pieces" — but each of those
  // yields FOUR cuts, so waste covered all six and fresh was correctly 0. The
  // test was wrong, not the allocator; a remnant's yield is an area question,
  // never a row count.
  const mkData = () => [sup('A', 'Suraj', [fabric({
    availableStock: 100,
    lots: [lotOf('L1', { wash: 100, rolls: [roll('r1', 100)] })],
    wasteStock: [{ wasteId: 'w1', lotId: 'L1', width: 150, length: 150, pieces: 1, carton: 'C1', lot: 'L1' }],
    lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA', cutW: 150, cutL: 100, reqPieces: 6, issPieces: 0 }]
  })])];

  S.render(mkData());
  const m = S.window.__rawData[0].materials[0];
  const wasteCredit = (m.lotLines || []).reduce((t, l) => t + (Number(l.fromWaste) || 0), 0);
  const wasteP = (m.wastePicks || []).reduce((t, p) => t + (Number(p.pieces) || 0), 0);
  const freshM = (m.lotLines || []).reduce((t, l) => t + l.qty, 0);
  const freshP = (m.lotLines || []).reduce((t, l) => t + (Number(l.fromRaw) || 0), 0);

  ok('the remnant is taken', wasteP === 1, 'remnants picked=' + wasteP);
  ok('it is credited for its yield', wasteCredit === 1,
    'wasteCredit=' + wasteCredit + ' (150x150 yields 1 cut of 150x100)');
  ok('waste + fresh covers the demand', wasteCredit + freshP === 6,
    'waste=' + wasteCredit + ' fresh=' + freshP);
  ok('fresh metres match the fresh pieces', freshM === freshP,
    'metres=' + freshM + ' pieces=' + freshP + ' (1 pc/row, 1m rows)');
  ok('fresh cloth covers exactly the uncovered pieces', freshP === 5,
    'fresh=' + freshP);
  ok('autoPieces stamped for the box ceiling',
    (m.wastePicks || []).every(p => p.autoPieces !== undefined),
    JSON.stringify((m.wastePicks || []).map(p => p.autoPieces)));

  // Re-render the SAME payload: the split must not drift
  const before = JSON.stringify({ w: m.wastePicks, l: m.lotLines });
  S.render(mkData());
  const m2 = S.window.__rawData[0].materials[0];
  ok('the split is stable across a re-render',
    JSON.stringify({ w: m2.wastePicks, l: m2.lotLines }) === before,
    'drifted');
}

// ============================================================
console.log('\n=== D. WHAT IS MISSING — wash list and PO list ===');
// ============================================================
{
  const S = load();
  // L1: nothing washed, 40 greige => the order can only be met after a wash.
  const washData = () => [sup('A', 'Suraj', [fabric({
    availableStock: 0, unwashedStock: 40,
    lots: [lotOf('L1', { wash: 0, unwash: 40, rolls: [roll('r1', 40)] })],
    lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA', cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0 }]
  })])];

  S.render(washData());
  const sum = S.window.__summary;
  ok('a wash row is raised', (sum.toWash || []).length === 1,
    'toWash=' + JSON.stringify((sum.toWash || []).map(x => ({ lot: x.lot && x.lot.lotNumber, q: x.qty }))));
  if ((sum.toWash || []).length === 1) {
    const w = sum.toWash[0];
    ok('it names the committed lot', w.lot && w.lot.lotId === 'L1', 'lot=' + (w.lot && w.lot.lotId));
    ok('it never asks for more greige than the lot holds', w.qty <= 40.0001, 'qty=' + w.qty);
    ok('it asks for what the order needs', w.qty === 20, 'qty=' + w.qty + ' (20 pieces x 1m)');
  }
  ok('nothing is issued off greige',
    (S.window.__rawData[0].materials[0].lotLines || []).length === 0, 'lotLines present');
  ok('and it is NOT also on the buy list', (sum.toBuy || []).length === 0,
    'toBuy=' + JSON.stringify((sum.toBuy || []).map(x => x.qty)) +
    ' (the cloth is owned — washing it is the action, not buying)');

  // --- a genuine purchase shortfall: no cloth in any state ---
  const S2 = load();
  S2.render([sup('A', 'Suraj', [fabric({
    availableStock: 0, unwashedStock: 0,
    lots: [], lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA',
                        cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0 }]
  })])]);
  const sum2 = S2.window.__summary;
  ok('a PO row is raised when there is no cloth at all', (sum2.toBuy || []).length === 1,
    'toBuy=' + JSON.stringify((sum2.toBuy || []).map(x => x.qty)));
  if ((sum2.toBuy || []).length === 1) {
    ok('the PO covers the whole order', sum2.toBuy[0].qty === 20, 'qty=' + sum2.toBuy[0].qty);
  }
  ok('no wash row (there is no greige to wash)', (sum2.toWash || []).length === 0,
    'toWash=' + (sum2.toWash || []).length);

  // --- TWO SUPERVISORS, one shelf: the shortfall is counted ONCE ---
  const S3 = load();
  const two = ['A', 'B'].map(id => sup(id, 'S' + id, [fabric({
    availableStock: 0,
    lots: [], lines: [{ planId: 'p' + id, planItemId: 'i' + id, mrqId: 'm' + id,
                        cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0 }]
  })]));
  S3.render(two);
  const sum3 = S3.window.__summary;
  ok('one PO row for the material, not one per supervisor',
    (sum3.toBuy || []).length === 1, 'rows=' + (sum3.toBuy || []).length);
  if ((sum3.toBuy || []).length === 1) {
    ok('and it totals BOTH supervisors', sum3.toBuy[0].qty === 40,
      'qty=' + sum3.toBuy[0].qty + ' (20 + 20)');
  }

  // --- a PO already out must drop the row ---
  const S4 = load();
  S4.render([sup('A', 'Suraj', [fabric({
    availableStock: 0, poCoveredQty: 20,
    lots: [], lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA',
                        cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0 }]
  })])]);
  ok('a raised PO drops the material off the buy list',
    (S4.window.__summary.toBuy || []).length === 0,
    'toBuy=' + JSON.stringify((S4.window.__summary.toBuy || []).map(x => x.qty)));

  // --- a TRIM shortfall counts owned stock in every state ---
  const S5 = load();
  S5.render([sup('A', 'Suraj', [trim({
    required: 100, remaining: 100, requiredTotal: 100, availableStock: 30,
    lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA', required: 100, issued: 0 }]
  })])]);
  const b5 = S5.window.__summary.toBuy || [];
  ok('trim PO = demand - owned', b5.length === 1 && b5[0].qty === 70,
    'rows=' + b5.length + ' qty=' + (b5[0] && b5[0].qty));
}

// ============================================================
console.log('\n=== E. IDEMPOTENCE: Refresh twice, nothing moves ===');
// ============================================================
{
  const S = load();
  const mk = () => [
    sup('A', 'Suraj', [fabric({
      availableStock: 50,
      lots: [lotOf('L1', { wash: 20, unwash: 10, rolls: [roll('r1', 20)] }),
             lotOf('L2', { wash: 30, rolls: [roll('r2', 30)] })],
      wasteStock: [{ wasteId: 'w1', lotId: 'L2', width: 150, length: 300, pieces: 2 }],
      lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA', cutW: 150, cutL: 100, reqPieces: 12, issPieces: 0 },
              { planId: 'pB', planItemId: 'iB', mrqId: 'mB', cutW: 75, cutL: 200, reqPieces: 6, issPieces: 0 }]
    })]),
    sup('B', 'Aniket', [trim({
      required: 40, remaining: 40, requiredTotal: 40, availableStock: 25,
      lines: [{ planId: 'pC', planItemId: 'iC', mrqId: 'mC', required: 40, issued: 0 }]
    })])
  ];

  const snap = (S2) => {
    const shot = (S2.window.__rawData || []).map(sp => ({
      id: sp.supervisorId,
      mats: sp.materials.map(m => ({
        id: m.materialId,
        lotLines: (m.lotLines || []).map(l => ({ lot: l.lotId, q: l.qty, mrq: l.mrqId, raw: l.fromRaw, w: l.fromWaste })),
        picks: (m.wastePicks || []).map(p => ({ w: p.wasteId, pc: p.pieces })),
        remaining: m.remaining, freshMeters: m.freshMeters,
        stockLeft: m.stockLeftForCard, washLots: m.washLots
      }))
    }));
    const s = S2.window.__summary || {};
    return JSON.stringify({
      shot,
      wash: (s.toWash || []).map(x => ({ m: x.e.materialId, q: x.qty, lot: x.lot && x.lot.lotId })),
      buy: (s.toBuy || []).map(x => ({ m: x.e.materialId, q: x.qty }))
    });
  };

  S.render(mk());
  const first = snap(S);
  S.render(mk());
  const second = snap(S);
  S.render(mk());
  const third = snap(S);

  ok('second Refresh identical to the first', first === second, 'drifted');
  ok('third Refresh identical too', second === third, 'drifted');
}

// ============================================================
console.log('\n=== F. GREIGE THE ATOM RULE STRANDED (regression) ===');
// ============================================================
{
  // 40m of demand across two supervisors, ONE lot holding 15m of greige and
  // nothing washed. The lot cannot cover either order WHOLE, so
  // chooseLotForOrder rejects it in both tiers, both orders are skipped, and
  // nothing is committed — which left `washByLot` empty and the wash list
  // silent. The screen said "buy 40" while 15m of the right shade sat unwashed
  // on the rack, with no button to send it anywhere.
  const S = load();
  const mk = (id) => sup(id, 'S' + id, [fabric({
    availableStock: 0, unwashedStock: 15,
    lots: [lotOf('L1', { wash: 0, unwash: 15, rolls: [roll('r1', 15)] })],
    lines: [{ planId: 'p' + id, planItemId: 'i' + id, mrqId: 'm' + id,
              cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0 }]
  })]);
  S.render([mk('A'), mk('B')]);
  const w = S.window.__summary.toWash || [];
  const b = S.window.__summary.toBuy || [];

  ok('stranded greige IS offered for washing', w.length === 1,
    'toWash=' + JSON.stringify(w.map(x => ({ lot: x.lot && x.lot.lotId, q: x.qty }))));
  if (w.length === 1) {
    ok('capped at what the lot actually holds', w[0].qty === 15, 'qty=' + w[0].qty);
    ok('flagged uncommitted (no order is waiting on it)', w[0].uncommitted === true,
      'uncommitted=' + w[0].uncommitted);
    ok('it names the lot', w[0].lot && w[0].lot.lotId === 'L1', 'lot=' + (w[0].lot && w[0].lot.lotId));
  }
  ok('the PO still stands until the wash lands', b.length === 1 && b[0].qty === 40,
    'toBuy=' + JSON.stringify(b.map(x => x.qty)) +
    ' (the allocator counts an unwashed lot as unavailable — correct)');
  ok('still nothing issued off greige',
    (S.window.__rawData[0].materials[0].lotLines || []).length === 0, 'lotLines present');

  // A COMMITTED lot must not also produce an uncommitted row for itself.
  const S2 = load();
  S2.render([sup('A', 'A', [fabric({
    availableStock: 0, unwashedStock: 40,
    lots: [lotOf('L1', { wash: 0, unwash: 40, rolls: [roll('r1', 40)] })],
    lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA', cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0 }]
  })])]);
  const w2 = S2.window.__summary.toWash || [];
  ok('a committed lot yields exactly ONE wash row', w2.length === 1,
    'rows=' + w2.length + ' ' + JSON.stringify(w2.map(x => ({ lot: x.lot && x.lot.lotId, q: x.qty, un: x.uncommitted }))));
  if (w2.length === 1) {
    ok('and it is the committed one, not the fallback', !w2[0].uncommitted,
      'uncommitted=' + w2[0].uncommitted);
  }

  // A BLOCKED lot's greige must never be offered — washing quarantined cloth
  // produces quarantined washed cloth, which still cannot be issued.
  const S3 = load();
  S3.render([sup('A', 'A', [fabric({
    availableStock: 0, unwashedStock: 15,
    lots: [lotOf('L1', { wash: 0, unwash: 15, blocked: true, rolls: [roll('r1', 15)] })],
    lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA', cutW: 150, cutL: 100, reqPieces: 20, issPieces: 0 }]
  })])]);
  ok('quarantined greige is never offered', (S3.window.__summary.toWash || []).length === 0,
    'toWash=' + (S3.window.__summary.toWash || []).length);

  // And the wash never asks for more than the job needs, even on a big pile.
  const S4 = load();
  S4.render([sup('A', 'A', [fabric({
    availableStock: 0, unwashedStock: 900,
    lots: [lotOf('L9', { wash: 0, unwash: 900, rolls: [roll('r9', 900)] })],
    lines: [{ planId: 'pA', planItemId: 'iA', mrqId: 'mA', cutW: 150, cutL: 100, reqPieces: 5, issPieces: 0 }]
  })])]);
  const w4 = S4.window.__summary.toWash || [];
  ok('never asks to wash more than the job needs', w4.length === 1 && w4[0].qty <= 5.0001,
    'qty=' + (w4[0] && w4[0].qty) + ' over a 900m greige pile for a 5m job');
}

console.log('\n========================================');
console.log('issue-screen: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
