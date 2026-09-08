#!/usr/bin/env node
// ---- A SMALL SHORTFALL MUST REISSUE A WHOLE MARKER ROW ----
//
// The case: the store issues 5m for 10 pieces (55x100 cut on 150cm cloth, so
// 2 pieces a row, 5 rows). The supervisor receives 4.9m — 0.1m short — and the
// store admits the mistake (Store_Correction).
//
// WHAT MUST NOT HAPPEN: the store is asked to reissue 0.1m. Cloth only leaves in
// whole marker rows; 0.1m cuts nothing, so the piece it was supposed to make is
// never made, the requirement never closes, and the item sits at
// Awaiting_Material for ever with the store having "issued" everything asked of
// it. That is the silent-loss family CLAUDE.md records.
//
// WHAT MUST HAPPEN: a whole row (1m here) comes back onto the bill.
//
// The mechanism is the .ceil() in resolveDispute §3:
//     backPcs = ceil(Pieces_From_Raw * pull / Issued_Qty)
// which turns 0.1m of a 5m/10-piece row into a WHOLE piece owed, and the
// allocator then rounds that piece up to a whole marker row.
//
// Both halves are load-bearing and this pins both: the round-up on resolve, and
// the allocator sizing from PIECES rather than from the metres gap.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const sb = { window: {}, console: { log() {}, warn() {}, error() {} },
  JSON, Math, Number, String, Object, Array };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/lot-allocator.js'), 'utf8'), sb);
const { allocateEveryCard, round2 } = sb;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  — ' + detail); }
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- resolveDispute §3, the Store_Correction wind-back, ported ----
function storeCorrection(row, pull) {
  const uIss = Number(row.issuedQty) || 0;
  const uRec = Number(row.receivedQty) || 0;
  const gapU = r2(uIss - uRec);
  if (gapU <= 0) return row;
  let take = Math.min(pull, gapU);

  row.issuedQty = r2(uIss - take);
  if (row.isFabric) {
    const rawPcs = Number(row.piecesFromRaw) || 0;
    if (rawPcs > 0 && uIss > 0) {
      // ROUNDED UP — a part-row of cloth cuts no whole piece.
      let backPcs = Math.ceil((rawPcs * take) / uIss);
      if (backPcs > rawPcs) backPcs = rawPcs;
      row.piecesFromRaw = rawPcs - backPcs;
    }
  }
  return row;
}

// ---- what the store screen then asks for, through the REAL allocator ----
function metresAskedFor(reqPieces, issuedPieces, cutW, cutL, fabricWidthCm) {
  const owed = Math.max(0, reqPieces - issuedPieces);
  if (owed <= 0) return 0;
  const m = {
    materialId: '9', material: 'Linen', sku: 'RM-9', unit: 'Mtr', isFabric: true,
    fabricWidthCm: fabricWidthCm,
    lots: [{ lotId: 'L1', lotNumber: 'L1', wash: 9999, unwash: 0, inWash: 0,
             blocked: false, form: 'Roll',
             rolls: [{ rollId: 'r1', label: 'R1', length: 9999, status: 'Available' }] }],
    wasteStock: [],
    lines: [{ planId: 'p1', planItemId: 'i1', mrqId: 'm1',
              cutW: cutW, cutL: cutL, reqPieces: reqPieces, issPieces: issuedPieces }]
  };
  allocateEveryCard([{ supervisorId: 'A', supervisorName: 'A', materials: [m] }]);
  return r2((m.lotLines || []).reduce((s, l) => s + (Number(l.qty) || 0), 0));
}

// 2 pieces a row, 1m rows.
const FAB_W = 150, CUT_W = 55, CUT_L = 100;
const PER_ROW = Math.floor(FAB_W / CUT_W);
const ROW_M = CUT_L / 100;

// ============================================================
console.log('\n=== X1. THE CASE: 0.1m short on a 5m / 10-piece row ===');
// ============================================================
{
  const row = { isFabric: true, reqPieces: 10, issuedQty: 5.0,
                receivedQty: 4.9, piecesFromRaw: 10 };
  storeCorrection(row, 0.1);

  ok('a WHOLE piece comes back onto the bill', row.piecesFromRaw === 9,
    'piecesFromRaw=' + row.piecesFromRaw + ' (0.2 of a piece, rounded UP to 1)');
  ok('Issued_Qty drops by the real metres', row.issuedQty === 4.9,
    'issuedQty=' + row.issuedQty);

  const asked = metresAskedFor(row.reqPieces, row.piecesFromRaw, CUT_W, CUT_L, FAB_W);
  ok('THE STORE IS ASKED FOR A WHOLE ROW, not 0.1m', asked === ROW_M,
    'asked=' + asked + 'm  (a 0.1m reissue would cut nothing and strand the piece)');
  ok('and never for less than the gap', asked >= 0.1, 'asked=' + asked);
}

// ============================================================
console.log('\n=== X2. every small shortfall reissues at least one row ===');
// ============================================================
{
  [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.99].forEach(short => {
    const row = { isFabric: true, reqPieces: 10, issuedQty: 5.0,
                  receivedQty: r2(5.0 - short), piecesFromRaw: 10 };
    storeCorrection(row, short);
    const asked = metresAskedFor(row.reqPieces, row.piecesFromRaw, CUT_W, CUT_L, FAB_W);
    ok('short ' + short + 'm reissues a whole row', asked >= ROW_M - 0.0001,
      'pieces back=' + (10 - row.piecesFromRaw) + ' asked=' + asked + 'm');
  });
}

// ============================================================
console.log('\n=== X3. larger shortfalls scale to whole rows too ===');
// ============================================================
{
  [[1.0, 1], [1.5, 2], [2.0, 2], [2.5, 3], [3.0, 3]].forEach(([short, minRows]) => {
    const row = { isFabric: true, reqPieces: 10, issuedQty: 5.0,
                  receivedQty: r2(5.0 - short), piecesFromRaw: 10 };
    storeCorrection(row, short);
    const asked = metresAskedFor(row.reqPieces, row.piecesFromRaw, CUT_W, CUT_L, FAB_W);
    ok('short ' + short + 'm asks at least ' + minRows + ' row(s)',
      asked >= minRows * ROW_M - 0.0001,
      'pieces back=' + (10 - row.piecesFromRaw) + ' asked=' + asked + 'm');
    ok('  and never less than the shortfall itself', asked >= short - 0.0001,
      'asked=' + asked + ' short=' + short);
  });
}

// ============================================================
console.log('\n=== X4. the reissue is always a WHOLE number of rows ===');
// ============================================================
{
  // Whatever the shortfall, the metres asked for must be a multiple of the cut
  // length — cloth does not leave in part-rows.
  let allWhole = true, worst = '';
  for (let i = 1; i <= 49; i++) {
    const short = r2(i / 10);
    if (short >= 5) continue;
    const row = { isFabric: true, reqPieces: 10, issuedQty: 5.0,
                  receivedQty: r2(5.0 - short), piecesFromRaw: 10 };
    storeCorrection(row, short);
    const asked = metresAskedFor(row.reqPieces, row.piecesFromRaw, CUT_W, CUT_L, FAB_W);
    const rows = asked / ROW_M;
    if (Math.abs(rows - Math.round(rows)) > 0.0001) { allWhole = false; worst = short + 'm -> ' + asked + 'm'; }
  }
  ok('every shortfall from 0.1 to 4.9 reissues whole rows', allWhole,
    'first fractional: ' + worst);
}

// ============================================================
console.log('\n=== X5. a NON-FABRIC row has no rows to round to ===');
// ============================================================
{
  // Thread, labels: the metres (cones) ARE the unit, so 0.1 back is 0.1 asked.
  // Pieces_From_Raw is not touched — correctly, it means nothing here.
  const row = { isFabric: false, reqPieces: 0, issuedQty: 40,
                receivedQty: 39.9, piecesFromRaw: 0 };
  storeCorrection(row, 0.1);
  ok('a trim reissues the exact quantity', row.issuedQty === 39.9,
    'issuedQty=' + row.issuedQty + ' (no marker rows on a cone of thread)');
  ok('and no piece counter is disturbed', row.piecesFromRaw === 0,
    'piecesFromRaw=' + row.piecesFromRaw);
}

// ============================================================
console.log('\n=== X6. the guard in the source ===');
// ============================================================
{
  const src = fs.readFileSync(path.join(ROOT, 'deluge/resolveDispute.dg'), 'utf8');
  ok('the piece wind-back is rounded UP', /backPcs = \(\(rawPcs \* pull\) \/ issuedMtr\)\.ceil\(\)/.test(src),
    'a part-row of cloth cuts no whole piece — .ceil() is what makes the reissue a whole row');
  ok('and it is capped at what the row actually holds', /if\(backPcs > rawPcs\)/.test(src),
    'never hand back more pieces than were issued');
  ok('the reason is recorded beside it', /part-row of cloth\s*\n\s*\/\/\s*cuts no whole piece/.test(src),
    'the comment explains why it rounds up');
}

console.log('\n========================================');
console.log('dispute-reissue-row: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
