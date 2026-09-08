#!/usr/bin/env node
// ---- THE "STILL SHORT N Mtr" FIGURE ON A `nofit` ROW MUST BE THE STUCK
// ---- ORDER'S OWN NEED, NOT THE ROW'S REMAINING TOTAL ----
//
// REGRESSION, reported live. shortReasonFor's `nofit` branch returned
// `short: round2(want - got)` — the WHOLE ROW's remaining fresh-cloth demand
// — while separately computing `need: round2(r.noFitSmallest)`, the actual
// metres the ONE stuck order needs. Only `short` was ever rendered
// (app/js/main.js prints why.short, never why.need), so the two could
// disagree and only the wrong one showed.
//
// They disagree exactly when OTHER orders on the same row were served from
// REMNANTS rather than a lot: offcuts reduce `m.remaining` (fresh-cloth-only)
// without changing what the stuck order itself needs. Live case: two orders
// (10 pcs, 5 pcs) were served from one waste remnant, dropping `m.remaining`
// for the whole material row to 7.5 — but the order still stuck needed a
// genuine 9 m (two 150x150 items, 5 pcs each, on one order the atom rule
// must serve off ONE roll) and no roll anywhere had more than 7.5 m. The
// screen read "Still short 7.5 Mtr ... closest is L2" right next to a lot
// box showing L2 free at 7.5 m — reading as though 7.5 more would close the
// gap, when the true gap was 9 m and L2 could never have covered it.
//
// The fix: `short` now equals `need` (`r.noFitSmallest`) in this branch —
// there was never a second figure to compute; `want - got` was simply the
// wrong number for this message.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  — ' + detail); }
}

function load() {
  const sb = { window: {}, console, JSON, Math, Number, String, Object, Array };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/lot-allocator.js'), 'utf8'), sb);
  return sb;
}

const roll = (id, len) => ({ rollId: id, label: id, length: len, status: 'Available' });

// ============================================================
console.log('\n=== the exact reported case ===');
// ============================================================
{
  const S = load();
  const FW = 314.96, CUT_W = 150, CUT_L = 150;
  const lines = [];
  // 100 orders of 10 pcs (7.5m each) — matches the live CSV (PLAN-00006..105)
  for (let n = 6; n <= 105; n++) {
    const id = 'PLAN-' + String(n).padStart(5, '0');
    lines.push({ planId: id, planItemId: id + '-i', mrqId: id + '-m',
                 cutW: CUT_W, cutL: CUT_L, reqPieces: 10, issPieces: 0 });
  }
  // The stuck order: one plan, TWO items, 5 pcs each — 4.5m per item,
  // 9m total, and the atom rule needs it off ONE roll.
  lines.push({ planId: 'PLAN-00001', planItemId: 'PLAN-00001-i1', mrqId: 'PLAN-00001-m1',
               cutW: CUT_W, cutL: CUT_L, reqPieces: 5, issPieces: 0 });
  lines.push({ planId: 'PLAN-00001', planItemId: 'PLAN-00001-i2', mrqId: 'PLAN-00001-m2',
               cutW: CUT_W, cutL: CUT_L, reqPieces: 5, issPieces: 0 });

  const m = {
    materialId: '9', material: 'Linen Fabric', sku: 'RM-00001', unit: 'Mtr', isFabric: true,
    fabricWidthCm: FW,
    lots: [
      { lotId: 'L1', lotNumber: 'L1', wash: 297, unwash: 0, inWash: 0, blocked: false, form: 'Roll',
        rolls: [roll('L1-R1', 297)] },
      { lotId: 'L2', lotNumber: 'L2', wash: 300, unwash: 0, inWash: 0, blocked: false, form: 'Roll',
        rolls: [roll('R1', 150), roll('R2', 150)] },
      { lotId: 'L3', lotNumber: 'L3', wash: 150, unwash: 0, inWash: 0, blocked: false, form: 'Roll',
        rolls: [roll('L3-R1', 150)] }
    ],
    // A 15-pc remnant on L1 that two OTHER orders draw from instead of a lot
    // — this is what drops m.remaining below the stuck order's own need.
    wasteStock: [{ wasteId: 'w1', lotId: 'L1', width: 150, length: 150, pieces: 15,
                   carton: 'C-CB1', lot: 'L1' }],
    lines: lines
  };

  S.allocateEveryCard([{ supervisorId: 'A', supervisorName: 'Suraj', materials: [m] }]);

  const stuck = (m.orderOutcomes || []).filter(o => o.why === 'skipped');
  ok('exactly one order is genuinely stuck', stuck.length === 1, 'stuck=' + stuck.length);
  ok('the stuck order needs 9m (two 4.5m items on one roll)',
    stuck[0] && stuck[0].needMetres === 9, 'needMetres=' + (stuck[0] && stuck[0].needMetres));

  const reason = m.shortReason;
  ok('the row reports nofit', reason && reason.kind === 'nofit', 'kind=' + (reason && reason.kind));
  ok('need is the stuck order\'s own figure (9), not the row total',
    reason && reason.need === 9, 'need=' + (reason && reason.need));
  ok('short EQUALS need — this is the fix',
    reason && reason.short === reason.need,
    'short=' + (reason && reason.short) + ' need=' + (reason && reason.need) +
    (reason && reason.short !== 9 ? '  <-- STILL SHOWING THE ROW TOTAL, NOT THE ORDER\'S NEED' : ''));
  ok('short is 9, not the misleading row-remainder 7.5',
    reason && reason.short === 9,
    'short=' + (reason && reason.short) + ' (the live bug showed 7.5 here)');
  ok('the nearest lot is named correctly', reason && reason.lot === 'L2', 'lot=' + (reason && reason.lot));
  ok('and its longest cuttable piece is reported (7.5, the truth about L2)',
    reason && reason.have === 7.5, 'have=' + (reason && reason.have));
}

// ============================================================
console.log('\n=== a row with NO waste involved: short should equal want-got too ===');
// ============================================================
{
  // Sanity check: when nothing on the row was covered by remnants, the old
  // and new figures happen to coincide — this must still work correctly, not
  // just in the case that exposed the bug.
  const S = load();
  const FW = 150, CUT_W = 150, CUT_L = 100;
  const m = {
    materialId: '9', material: 'Linen', sku: 'RM-9', unit: 'Mtr', isFabric: true,
    fabricWidthCm: FW,
    lots: [
      { lotId: 'L1', lotNumber: 'L1', wash: 5, unwash: 0, inWash: 0, blocked: false, form: 'Roll',
        rolls: [roll('r1', 5)] }
    ],
    wasteStock: [],
    lines: [{ planId: 'p1', planItemId: 'i1', mrqId: 'm1', cutW: CUT_W, cutL: CUT_L,
              reqPieces: 10, issPieces: 0 }]  // needs 10 rows x 1m = 10m, only 5m on the roll
  };
  S.allocateEveryCard([{ supervisorId: 'A', supervisorName: 'A', materials: [m] }]);
  const reason = m.shortReason;
  ok('single-order row: short still equals need', reason && reason.short === reason.need,
    'short=' + (reason && reason.short) + ' need=' + (reason && reason.need));
  ok('and both equal the true 10m gap', reason && reason.short === 10, 'short=' + (reason && reason.short));
}

console.log('\n========================================');
console.log('nofit-short-figure: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
