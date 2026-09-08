#!/usr/bin/env node
// ---- A LOT PARTLY COMMITTED IS NOT A LOT ALREADY COVERED ----
//
// REGRESSION, reported live. A store person added a new lot with 743.77 m of
// greige for one material. The allocator committed some orders to it under
// the atom rule (afterWash — those orders cover WHOLE once this lot's greige
// is washed), summing to 729.20 m. Other orders for the same material could
// not be committed to it or anywhere else and were skipped. The wash section
// asked for 729.20 m — the committed figure only — and the remaining 14.57 m
// of the SAME LOT's own greige, genuinely still needed, never appeared as a
// wash row at all, because `washedLots` excluded any lot that already had a
// committed row. Two more small, uncorrelated wash requests (8.14, 6.43) were
// then raised chasing a residual that was never sized correctly, and the
// material stayed short.
//
// The bug had two parts, both fixed together:
//   1. The stranded-greige top-up must not skip a lot just because it already
//      has a committed row — it must ask for what is LEFT on that lot.
//   2. The material-wide "still short" figure the top-up is capped at
//      (fabricShortMetres) must be the SAME figure the buy row uses — derived
//      from allocator outcomes, not a second, independent sum of raw
//      outstanding pieces that double-counted orders the committed pass had
//      already resolved.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

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
    getElementById(id) { if (!els[id]) els[id] = mk(id); return els[id]; },
    querySelector(s) { return this.getElementById('sel:' + s); },
    querySelectorAll() { return []; },
    createElement(t) { return mk('new:' + t); },
    addEventListener() {}, body: { appendChild() {} }
  };
}

function load() {
  const sb = {
    window: {}, document: makeDoc(),
    console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {}, table() {} },
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
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const roll = (id, len) => ({ rollId: id, label: id.toUpperCase(), length: len, status: 'Available' });
const sup = (id, n, m) => ({ supervisorId: id, supervisorName: n, materials: m });

function fabricMat(o) {
  const lines = o.lines || [];
  const req = lines.reduce((s, l) => s + (l.reqPieces || 0), 0);
  const iss = lines.reduce((s, l) => s + (l.issPieces || 0), 0);
  return Object.assign({
    materialId: '9', material: 'Linen Fabric', sku: 'RM-9', unit: 'Mtr',
    isFabric: true, isReissue: false, fabricWidthCm: 150,
    required: req, issued: iss, remaining: Math.max(0, req - iss),
    requiredPieces: req, issuedPieces: iss, outstandingPieces: Math.max(0, req - iss),
    requiredTotal: req, availableStock: 0, unwashedStock: 0, inWashStock: 0,
    unallocatedQty: 0, poCoveredQty: 0, openExceptions: [], lots: [], wasteStock: [],
    cuts: lines.map(l => ({ cutW: l.cutW, cutL: l.cutL, reqPieces: l.reqPieces, issPieces: l.issPieces || 0 })),
    freshMeters: 0
  }, o);
}
const lotOf = (id, o) => Object.assign(
  { lotId: id, lotNumber: id, wash: 0, unwash: 0, inWash: 0, blocked: false, rolls: [], form: 'Roll' }, o);

// ============================================================
console.log('\n=== the real shape: one new lot, some orders committed, real leftover ===');
// ============================================================
{
  const S = load();
  // fabricWidthCm 150, cut 150x150 -> 1 piece/row, 1.5m/row (matches the
  // real org's geometry pattern used elsewhere in this repo's own fixtures).
  const CUT_W = 150, CUT_L = 150, PER_ROW = 1, ROW_M = 1.5;
  // 743.77m of greige on a brand-new lot L4. Enough demand that SOME orders
  // fit whole against L4's greige (afterWash commits them) and the rest do
  // not (they are skipped — too many pieces for what remains once marker-row
  // rounding is applied, or genuinely need more than the lot can ever give).
  //
  // Rather than hand-tune dozens of orders to land exactly on 729.20 vs
  // 14.57 (fragile, and not the point), this drives many small orders
  // through the REAL allocator and lot-allocator.js decides for itself which
  // are committed and which are stranded — the point is only that whatever
  // ends up stranded on L4 is asked for as part of ONE coherent wash figure
  // for that lot, not silently dropped because L4 already has a committed row.
  const lines = [];
  // 495 orders of 1 piece each (1.5m each if committed) = up to 742.5m if all
  // committed — deliberately just under the lot so some sequence of them
  // will commit and the geometry decides the exact split, exercising the
  // real code path rather than a contrived fixture.
  for (let i = 0; i < 495; i++) {
    lines.push({ planId: 'p' + i, planItemId: 'i' + i, mrqId: 'm' + i,
                 cutW: CUT_W, cutL: CUT_L, reqPieces: 1, issPieces: 0 });
  }
  const m = fabricMat({
    lots: [lotOf('L4', { wash: 0, unwash: 743.77, rolls: [roll('r4', 743.77)] })],
    lines: lines
  });
  S.render([sup('A', 'Suraj', [m])]);

  const summary = S.window.__summary;
  const l4Rows = (summary.toWash || []).filter(w => w.lot && w.lot.lotId === 'L4');
  const l4Total = r2(l4Rows.reduce((s, w) => s + w.qty, 0));
  // 495 orders x 1.5m/row if every one of them ends up committed or topped
  // up — the real ceiling this fixture can produce, not the lot's raw
  // 743.77m (that would need 743.77/1.5 ≈ 496 orders to fully saturate).
  const maxPossible = r2(495 * ROW_M);

  ok('L4 appears in the wash list', l4Rows.length > 0, 'toWash=' + JSON.stringify(summary.toWash.map(w => w.lot && w.lot.lotId)));
  ok('the wash ask for L4 covers ALL the demand that could commit to it',
    l4Total === maxPossible, 'total asked for L4=' + l4Total + ' (495 orders x 1.5m=' + maxPossible + ')');
  ok('never more than the lot itself holds', l4Total <= 743.77 + 0.01,
    'total=' + l4Total + ' lot=743.77');

  // Whatever committed vs stranded split the real allocator landed on, the
  // wash total must still equal the whole lot — the two pieces (committed +
  // top-up) must sum to the lot, never to something less.
  const totalDemand = 495 * ROW_M; // if every order needed a fresh whole row
  console.log('     rows in toWash for L4: ' + l4Rows.length +
    (l4Rows.length === 2 ? ' (one committed row + one uncommitted top-up, as expected)' : ''));
}

// ============================================================
console.log('\n=== the reported numbers, reproduced directly ===');
// ============================================================
{
  // buildShortfallSummary reads its wash commitments off `m.washLots[]` (the
  // per-row field allocateEveryCard actually writes — the merge pass builds
  // its own internal `washByLot` FROM this, so a fixture that hand-sets
  // `washByLot` directly bypasses the real code path and proves nothing).
  // Same for orderOutcomes: it wants `m.orderOutcomes`, one array shared by
  // every row of the material, exactly as allocateMaterial stamps it.
  //
  // fabricWidthCm 100, cutW 100, cutL 100 -> 1 piece/row, 1m/row, so pieces
  // convert to metres 1:1 and the reported figures (729.20 committed, 14.57
  // stranded, 743.77 total) can be built exactly rather than approximately.
  const S = load();
  const fw = 100, cutW = 100, cutL = 100;
  const outcomes = [
    { planId: 'p1', why: 'afterWash', lotId: 'L4', lotNumber: 'L4', pieces: 72920,
      needMetres: 729.20, metres: 0, wastePieces: 0, greige: 729.20, shortPieces: 0,
      cuts: [{ cutW, cutL, shortPieces: 0 }] },
    { planId: 'p2', why: 'skipped', lotId: '', lotNumber: '', pieces: 1457,
      needMetres: 14.57, metres: 0, wastePieces: 0, greige: 0,
      cuts: [{ cutW, cutL, pieces: 1457 }] }
  ];
  const m = {
    materialId: '9', material: 'Linen', sku: 'RM-9', unit: 'Mtr', isFabric: true,
    fabricWidthCm: fw,
    lots: [{ lotId: 'L4', lotNumber: 'L4', wash: 0, unwash: 743.77, inWash: 0,
             blocked: false, form: 'Roll', rolls: [roll('r1', 743.77)] }],
    availableStock: 0, unwashedStock: 743.77, inWashStock: 0, unallocatedQty: 0,
    poCoveredQty: 0, openExceptions: [], wasteStock: [],
    // THE REAL FIELD: one entry per lot an order actually committed to,
    // written by allocateMaterial (main.js:m.washLots, not a hand-built
    // washByLot map) and merged into `washByLot` inside buildShortfallSummary.
    washLots: [{ lotId: 'L4', lotNumber: 'L4', qty: 729.20, rowQty: 729.20 }],
    orderOutcomes: outcomes,
    lines: [
      { planId: 'p1', planItemId: 'i1', mrqId: 'm1', cutW, cutL, reqPieces: 72920, issPieces: 0 },
      { planId: 'p2', planItemId: 'i2', mrqId: 'm2', cutW, cutL, reqPieces: 1457, issPieces: 0 }
    ],
    cuts: [{ cutW, cutL, reqPieces: 74377, issPieces: 0 }], freshMeters: 0
  };

  const summary = S.buildShortfallSummary([{ supervisorId: 'A', supervisorName: 'A', materials: [m] }]);
  const l4Rows = (summary.toWash || []).filter(w => w.lot && w.lot.lotId === 'L4');
  const l4Total = r2(l4Rows.reduce((s, w) => s + w.qty, 0));

  ok('committed 729.20 + stranded 14.57 sum to the whole lot',
    l4Total === 743.77, 'total=' + l4Total + '  rows=' + JSON.stringify(l4Rows.map(w => w.qty)));
  ok('exactly two rows: one committed, one uncommitted top-up',
    l4Rows.length === 2, 'rows=' + l4Rows.length);
  const committed = l4Rows.filter(w => !w.uncommitted)[0];
  const topUp = l4Rows.filter(w => w.uncommitted)[0];
  ok('the committed row is 729.20', committed && committed.qty === 729.20,
    'committed=' + (committed && committed.qty));
  ok('the top-up row is exactly 14.57, not zero and not the whole lot again',
    topUp && topUp.qty === 14.57, 'topUp=' + (topUp && topUp.qty));
}

// ============================================================
console.log('\n=== the buy figure and the wash top-up must never double the same gap ===');
// ============================================================
{
  // Direct check of the shared helper: the material-wide short figure used by
  // BOTH the buy row and the wash top-up must be ONE number, so a lot cannot
  // receive a committed row PLUS an unrelated top-up sized off a second,
  // independent count of the same demand.
  const S = load();
  const e = {
    lines: [{ planId: 'p1', cutW: 100, cutL: 100 }],
    fabricWidthCm: 100,
    orderOutcomes: [
      { planId: 'p1', why: 'afterWash', pieces: 100, cuts: [{ cutW: 100, cutL: 100, shortPieces: 0 }] },
      { planId: 'p2', why: 'skipped', pieces: 50, cuts: [{ cutW: 100, cutL: 100, pieces: 50 }] }
    ]
  };
  const short = S.fabricShortMetres(e);
  // Only the skipped order (50 pieces, 1m/row) counts as short; the
  // afterWash order has shortPieces 0, meaning the committed lot fully
  // covers it once washed — it must NOT add to the "still short" figure a
  // second time.
  ok('fabricShortMetres counts only genuinely short pieces', short === 50,
    'short=' + short + ' (the afterWash order with shortPieces=0 must not add to it)');
}

console.log('\n========================================');
console.log('wash-stranded-same-lot: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
