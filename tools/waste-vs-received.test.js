#!/usr/bin/env node
// ---- EXPECTED WASTE vs WHAT THE SUPERVISOR ACTUALLY RECEIVED ----
//
// getExpectedWaste predicts the remnants a cutting run should throw off. The
// question this suite exists to answer: is that prediction measured against the
// cloth the supervisor ACTUALLY GOT, or against what the store said it sent?
//
// The three figures on a Material_Requirement row are not the same number:
//   Issued_Qty    what the store handed over
//   Received_Qty  what the supervisor confirmed arrived
//   the gap       disputed — raised as a Stock_Dispute, resolved separately
//
// receiveFanOut writes Received_Qty and leaves Issued_Qty alone (its own
// comment: "room" is Issued_Qty - Received_Qty). getExpectedWaste reads
// Issued_Qty. So on a SHORT receipt the two diverge, and this measures by how
// much and in which direction.
//
// The geometry, ported from getExpectedWaste.dg Pass 2 (one lot at a time):
//   perRow   = floor(fabricWidth / cutW)
//   sideW    = fabricWidth - perRow*cutW      -> the side strip, full length
//   rows     = ceil(pieces / perRow)
//   lastRow  = pieces - (rows-1)*perRow       -> the part-filled last row
//   tail     = lotMetres*100 - rows*cutL      -> what is left on the roll
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  — ' + detail); }
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- Pass 2, per lot ----
// Returns the remnant pieces one lot's fresh cloth throws off.
function freshWasteForLot(lotMetres, pieces, cutW, cutL, fabricWidthCm) {
  const out = [];
  const perRow = Math.floor(fabricWidthCm / cutW);
  if (perRow <= 0 || pieces <= 0) return out;

  const sideW = r2(fabricWidthCm - perRow * cutW);
  const rows = Math.ceil(pieces / perRow);
  const usedCm = rows * cutL;

  // 1. the side strip — full length of every row cut
  if (sideW > 0) out.push({ kind: 'side', count: 1, width: sideW, length: r2(usedCm) });

  // 2. the part-filled last row
  const lastRow = pieces - (rows - 1) * perRow;
  const spare = perRow - lastRow;
  if (spare > 0) out.push({ kind: 'partrow', count: 1, width: r2(spare * cutW), length: cutL });

  // 3. the tail left on the roll
  const tail = r2(lotMetres * 100 - usedCm);
  if (tail > 0) out.push({ kind: 'tail', count: 1, width: fabricWidthCm, length: tail });

  return out;
}

const areaOf = (rem) => r2(rem.reduce((s, r) => s + r.count * r.width * r.length, 0) / 10000);

// ============================================================
console.log('\n=== W1. the geometry itself ===');
// ============================================================
{
  // 150cm cloth, 55cm cut => 2 per row, 40cm side strip.
  const rem = freshWasteForLot(10, 10, 55, 100, 150);
  const side = rem.filter(r => r.kind === 'side')[0];
  const part = rem.filter(r => r.kind === 'partrow')[0];
  const tail = rem.filter(r => r.kind === 'tail')[0];

  ok('a side strip is predicted', !!side, JSON.stringify(rem));
  ok('side strip width = width - perRow*cutW', side && side.width === 40,
    'width=' + (side && side.width) + ' (150 - 2*55)');
  ok('side strip length = rows cut', side && side.length === 500,
    'length=' + (side && side.length) + ' (5 rows x 100cm)');
  ok('10 pieces at 2/row fill every row exactly', !part,
    'partrow=' + JSON.stringify(part) + ' (no spare)');
  ok('the tail is what is left on the roll', tail && tail.length === 500,
    'tail=' + (tail && tail.length) + ' (1000cm roll - 500cm cut)');
}
{
  // 11 pieces at 2/row => 6 rows, last row holds 1, one 55cm space spare.
  const rem = freshWasteForLot(10, 11, 55, 100, 150);
  const part = rem.filter(r => r.kind === 'partrow')[0];
  ok('an odd count leaves a part-filled row', !!part, JSON.stringify(rem));
  ok('the part row is the unused width', part && part.width === 55,
    'width=' + (part && part.width) + ' (1 spare space x 55cm)');
  ok('and one cut length long', part && part.length === 100, 'length=' + (part && part.length));
}
{
  // A cut wider than the cloth yields nothing at all.
  ok('a cut wider than the cloth predicts nothing',
    freshWasteForLot(10, 5, 200, 100, 150).length === 0, 'must not invent waste');
  ok('zero pieces predicts nothing', freshWasteForLot(10, 0, 55, 100, 150).length === 0, '');
}

// ============================================================
console.log('\n=== W2. ONE LOT AT A TIME — the rule that was got wrong once ===');
// ============================================================
{
  // 50 pieces off ONE lot vs the same 50 split 30/20 across two lots.
  // Each lot gets its OWN side strip and its OWN part-filled row.
  const one = freshWasteForLot(30, 50, 55, 100, 150);
  const a = freshWasteForLot(15, 30, 55, 100, 150);
  const b = freshWasteForLot(15, 20, 55, 100, 150);

  const sidesOne = one.filter(r => r.kind === 'side').length;
  const sidesTwo = a.filter(r => r.kind === 'side').length + b.filter(r => r.kind === 'side').length;
  ok('one lot yields ONE side strip', sidesOne === 1, 'strips=' + sidesOne);
  ok('two lots yield TWO side strips', sidesTwo === 2,
    'strips=' + sidesTwo + ' — different physical pieces, different tones');

  // And the split must never predict LESS waste than the single block.
  ok('splitting never under-predicts', areaOf(a) + areaOf(b) >= areaOf(one) - 0.01,
    'one=' + areaOf(one) + ' split=' + r2(areaOf(a) + areaOf(b)));
}

// ============================================================
console.log('\n=== W3. THE CORE QUESTION: predicted vs RECEIVED ===');
// ============================================================
{
  // The store issued 10m. The supervisor received only 8m — 2m disputed.
  // getExpectedWaste reads Issued_Qty (10), so it predicts the tail off 10m of
  // cloth the supervisor does not have.
  const ISSUED = 10, RECEIVED = 8;
  const pieces = 10, cutW = 55, cutL = 100, fw = 150;

  const predicted = freshWasteForLot(ISSUED, pieces, cutW, cutL, fw);
  const truth = freshWasteForLot(RECEIVED, pieces, cutW, cutL, fw);

  const pTail = predicted.filter(r => r.kind === 'tail')[0];
  const tTail = truth.filter(r => r.kind === 'tail')[0];

  console.log('     issued ' + ISSUED + 'm -> predicted tail ' + (pTail ? pTail.length : 0) + 'cm');
  console.log('     received ' + RECEIVED + 'm -> true tail     ' + (tTail ? tTail.length : 0) + 'cm');

  // THE OLD BEHAVIOUR, kept as the thing the fix removes: reading Issued_Qty
  // predicted a tail off cloth the supervisor does not have, over by exactly
  // the disputed metres. Pre-fix this was what the dialog offered.
  ok('reading ISSUED would over-predict the tail',
    pTail && tTail && pTail.length > tTail.length,
    'issued-basis=' + (pTail && pTail.length) + ' received-basis=' + (tTail && tTail.length));
  ok('and the over-prediction is exactly the shortfall',
    pTail && tTail && r2((pTail.length - tTail.length) / 100) === r2(ISSUED - RECEIVED),
    'gap=' + r2(((pTail ? pTail.length : 0) - (tTail ? tTail.length : 0)) / 100) +
    'm  shortfall=' + r2(ISSUED - RECEIVED) + 'm  — this is what W6 fixes');

  // The side strip and part row are driven by PIECES, not metres, so they are
  // unaffected — only the tail moves.
  const pSide = predicted.filter(r => r.kind === 'side')[0];
  const tSide = truth.filter(r => r.kind === 'side')[0];
  ok('the side strip is unaffected by the shortfall',
    pSide && tSide && pSide.length === tSide.length && pSide.width === tSide.width,
    'predicted=' + JSON.stringify(pSide) + ' true=' + JSON.stringify(tSide));
  console.log('     -> ONLY THE TAIL is wrong, and it is wrong by exactly the disputed metres.');
}

// ============================================================
console.log('\n=== W4. WHEN THE SHORTFALL EXCEEDS THE TAIL ===');
// ============================================================
{
  // Issued 6m for 10 pieces (needs 5m of rows). Received only 4m — less than
  // the cloth the rows require. The prediction claims a 100cm tail; the truth
  // is he could not even cut the job.
  const predicted = freshWasteForLot(6, 10, 55, 100, 150);
  const truth = freshWasteForLot(4, 10, 55, 100, 150);
  const pTail = predicted.filter(r => r.kind === 'tail')[0];
  const tTail = truth.filter(r => r.kind === 'tail')[0];

  ok('the prediction still claims a tail', !!pTail, 'tail=' + (pTail && pTail.length) + 'cm');
  ok('but on the received cloth there is none', !tTail,
    'true tail=' + JSON.stringify(tTail) + ' (5m of rows needed, only 4m arrived)');
  console.log('     -> a NEGATIVE tail is correctly dropped rather than predicted as waste,');
  console.log('        but the ISSUED-based figure still offers a remnant that cannot exist.');
}

// ============================================================
console.log('\n=== W5. the fully-received case — prediction is exact ===');
// ============================================================
{
  // The ordinary path: everything issued arrived. Prediction == truth.
  [[10, 10], [15, 23], [30, 50], [7.5, 11]].forEach(([m, pcs]) => {
    const predicted = freshWasteForLot(m, pcs, 55, 100, 150);
    const truth = freshWasteForLot(m, pcs, 55, 100, 150);
    ok('full receipt of ' + m + 'm / ' + pcs + 'pcs predicts exactly',
      JSON.stringify(predicted) === JSON.stringify(truth), 'mismatch');
  });
}

// ============================================================
console.log('\n=== W6. THE FIX: the metres basis is min(issued, received) ===');
// ============================================================
{
  // Ported from getExpectedWaste.dg's lnqW selection: use Received_Qty only
  // when a receipt has actually been recorded AND it is smaller. A row issued
  // but not yet confirmed reads Received_Qty 0 — the ordinary in-transit state,
  // and the supervisor may legitimately end Cutting before pressing Confirm —
  // so that must fall back to Issued_Qty rather than predicting no tail at all.
  const basis = (issued, received) =>
    (received > 0 && received < issued) ? received : issued;

  ok('a short receipt uses the RECEIVED metres', basis(10, 8) === 8, 'basis=' + basis(10, 8));
  ok('a full receipt is unchanged', basis(10, 10) === 10, 'basis=' + basis(10, 10));
  ok('NOT YET RECEIVED falls back to issued', basis(10, 0) === 10,
    'basis=' + basis(10, 0) + ' — in transit, or Cutting ended before Confirm');
  ok('an over-receipt never widens the prediction', basis(10, 12) === 10,
    'basis=' + basis(10, 12) + ' — the roll cannot yield more than was cut off it');

  // And the tail is now right.
  const predicted = freshWasteForLot(basis(10, 8), 10, 55, 100, 150);
  const truth = freshWasteForLot(8, 10, 55, 100, 150);
  ok('the predicted tail now matches the cloth he holds',
    JSON.stringify(predicted) === JSON.stringify(truth),
    'predicted=' + JSON.stringify(predicted) + '\n     truth=' + JSON.stringify(truth));

  // The pieces-driven remnants are still untouched by the change.
  const full = freshWasteForLot(10, 10, 55, 100, 150);
  const pSide = predicted.filter(r => r.kind === 'side')[0];
  const fSide = full.filter(r => r.kind === 'side')[0];
  ok('the side strip is unchanged by the fix',
    pSide && fSide && pSide.width === fSide.width && pSide.length === fSide.length,
    'the strip is driven by PIECES, not metres');
}

// ============================================================
console.log('\n=== W7. what the SOURCE now does ===');
// ============================================================
{
  const src = fs.readFileSync(path.join(ROOT, 'deluge/getExpectedWaste.dg'), 'utf8');
  const flat = src.replace(/\s+/g, ' ');

  ok('getExpectedWaste now reads Received_Qty', /Received_Qty/.test(src),
    'the prediction is measured against what ARRIVED');
  ok('and takes the SMALLER of the two', /lnrW\.toDecimal\(\) > 0 && lnrW\.toDecimal\(\) < lnqW\.toDecimal\(\)/.test(flat),
    'min(issued, received), with 0 meaning "not yet received"');
  ok('the multi-roll shares are scaled by the same ratio',
    /rlScaleW = lnqW\.toDecimal\(\) \/ rlIssW\.toDecimal\(\)/.test(flat),
    'a shortfall cannot be pinned to one named roll');
  ok('and the scale can never exceed 1', /if\(rlScaleW > 1\)/.test(flat),
    'an over-receipt must not widen a roll share');
  ok('the reason is recorded in the source',
    /THE CLOTH HE IS ACTUALLY HOLDING, NOT WHAT THE STORE SENT/.test(src), '');

  // The receive path still deliberately leaves Issued_Qty alone — that is WHY
  // the two figures diverge and why this fix is needed at all.
  const fan = fs.readFileSync(path.join(ROOT, 'deluge/receiveFanOut.dg'), 'utf8');
  ok('receiveFanOut still credits Received_Qty and leaves Issued_Qty alone',
    /room.*on a requirement row is Issued_Qty - Received_Qty/.test(fan.replace(/\s+/g, ' ')),
    'the divergence is by design; the waste prediction now accounts for it');
}

console.log('\n========================================');
console.log('waste-vs-received: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
