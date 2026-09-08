#!/usr/bin/env node
// ---- THE SUPERVISOR RECEIVE PATH ----
//
// The other side of the handover. Issuing moved cloth into In_Transit_Qty and
// wrote Issue_Lines; receiving settles those lines, drains In_Transit, fans the
// credit to Material_Requirement, and disputes whatever did not arrive.
//
// The invariant everything rests on is per line:
//     Qty == Received_Qty + Disputed_Qty
// and across the receipt:
//     Σ issued == Σ received + Σ disputed        (nothing vanishes)
//
// Modelled from deluge/receiveHandover.dg's settle (the owed / conf / shortQ
// block) and receiveFanOut's credit cap, plus the real widget predicates.
//
// What this pins:
//   R1  a full receipt settles every line exactly
//   R2  a SHORT receipt splits owed into received + disputed, never losing any
//   R3  idempotence — Confirm pressed twice settles nothing extra
//   R4  a two-stage receipt (partial, then the rest) converges
//   R5  legacy lines (Settled_Qty, no Line_Status) still settle and converge
//   R6  the throttle predicate does not fire on ordinary dispute notices
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  — ' + detail); }
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- the settle, ported from receiveHandover.dg lines ~150-270 ----
//
// lines: [{ id, materialId, lot, qty, received, disputed, settled, status }]
// shortMaterials: [{ materialId, received }]  — the ARRIVED figure he typed
function settle(lines, shortMaterials) {
  const shortLeft = {};
  (shortMaterials || []).forEach(sm => { shortLeft[String(sm.materialId)] = Number(sm.received) || 0; });

  const arrivedByMat = {}, shortByMat = {};

  lines.forEach(ln => {
    const lnQ = Number(ln.qty) || 0;
    const rcS = Number(ln.received) || 0;
    const dspNow = Number(ln.disputed) || 0;
    const setNow = Number(ln.settled) || 0;
    const isNew = String(ln.status || '') !== '';

    let rcvNow, owed;
    if (isNew) { rcvNow = rcS; owed = lnQ - rcvNow - dspNow; }
    else { rcvNow = rcS > 0 ? rcS : setNow; owed = lnQ - setNow; }

    const mat = String(ln.materialId);
    // Totals FIRST, from what the line already holds
    if (rcvNow > 0 || dspNow > 0) {
      arrivedByMat[mat] = r2((arrivedByMat[mat] || 0) + rcvNow);
      if (dspNow > 0) shortByMat[mat] = r2((shortByMat[mat] || 0) + dspNow);
    }

    if (owed > 0) {
      let conf = owed, shortQ = 0;
      const slLeft = shortLeft[mat];
      if (slLeft !== undefined) {
        if (slLeft >= owed) { conf = owed; shortLeft[mat] = r2(slLeft - owed); }
        else { conf = Math.max(0, slLeft); shortLeft[mat] = 0; }
        shortQ = r2(owed - conf);
      }
      const newRcv = r2(rcvNow + conf);
      const newDsp = r2(dspNow + shortQ);
      ln.received = newRcv;
      ln.disputed = newDsp;
      ln.settled = lnQ;
      ln.status = newDsp <= 0 ? 'Received' : 'Short';

      arrivedByMat[mat] = r2((arrivedByMat[mat] || 0) + conf);
      if (shortQ > 0) shortByMat[mat] = r2((shortByMat[mat] || 0) + shortQ);
    }
  });

  const perMaterial = Object.keys(arrivedByMat).map(m => ({
    materialId: m, arrived: r2(arrivedByMat[m]), short: r2(shortByMat[m] || 0)
  }));
  Object.keys(shortByMat).forEach(m => {
    if (!arrivedByMat[m]) perMaterial.push({ materialId: m, arrived: 0, short: r2(shortByMat[m]) });
  });
  return perMaterial;
}

const mkLine = (id, mat, lot, qty) => ({
  id: id, materialId: mat, lot: lot, qty: qty,
  received: 0, disputed: 0, settled: 0, status: 'Pending'
});

// ============================================================
console.log('\n=== R1. a FULL receipt settles every line exactly ===');
// ============================================================
{
  const lines = [mkLine('a', '9', 'L1', 20), mkLine('b', '9', 'L2', 12), mkLine('c', '20', '', 40)];
  const issued = lines.reduce((s, l) => s + l.qty, 0);
  const per = settle(lines, []);   // no shortMaterials => everything arrived

  lines.forEach(l => {
    ok('line ' + l.id + ': Qty == Received + Disputed',
      r2(l.received + l.disputed) === l.qty,
      'qty=' + l.qty + ' rcv=' + l.received + ' dsp=' + l.disputed);
    ok('line ' + l.id + ' marked Received', l.status === 'Received', 'status=' + l.status);
  });
  const gotAll = lines.reduce((s, l) => s + l.received, 0);
  ok('nothing disputed on a full receipt', lines.every(l => l.disputed === 0), 'disputes present');
  ok('everything issued was received', gotAll === issued, 'issued=' + issued + ' received=' + gotAll);
  const perTotal = per.reduce((s, p) => s + p.arrived, 0);
  ok('perMaterial totals match the lines', perTotal === issued,
    'perMaterial=' + perTotal + ' lines=' + issued);
}

// ============================================================
console.log('\n=== R2. a SHORT receipt splits owed, and loses nothing ===');
// ============================================================
{
  // 32m of material 9 issued across two lots; only 25 arrived.
  const lines = [mkLine('a', '9', 'L1', 20), mkLine('b', '9', 'L2', 12)];
  const issued = lines.reduce((s, l) => s + l.qty, 0);
  const per = settle(lines, [{ materialId: '9', received: 25 }]);

  lines.forEach(l => {
    ok('line ' + l.id + ': Qty == Received + Disputed',
      r2(l.received + l.disputed) === l.qty,
      'qty=' + l.qty + ' rcv=' + l.received + ' dsp=' + l.disputed);
  });
  const rcv = r2(lines.reduce((s, l) => s + l.received, 0));
  const dsp = r2(lines.reduce((s, l) => s + l.disputed, 0));
  ok('received matches what he typed', rcv === 25, 'received=' + rcv);
  ok('the gap is disputed, not lost', dsp === 7, 'disputed=' + dsp);
  ok('NOTHING VANISHES', r2(rcv + dsp) === issued,
    'issued=' + issued + ' received=' + rcv + ' disputed=' + dsp);

  // Oldest line first: L1 takes the full 20, L2 gets the remaining 5 of its 12.
  ok('drawn down oldest-line-first', lines[0].received === 20 && lines[1].received === 5,
    'L1=' + lines[0].received + ' L2=' + lines[1].received);
  ok('the short line is flagged', lines[1].status === 'Short', 'status=' + lines[1].status);
  ok('the full line is not', lines[0].status === 'Received', 'status=' + lines[0].status);

  const p9 = per.filter(p => p.materialId === '9')[0];
  ok('perMaterial reports arrived and short', p9 && p9.arrived === 25 && p9.short === 7,
    'arrived=' + (p9 && p9.arrived) + ' short=' + (p9 && p9.short));
}

// ============================================================
console.log('\n=== R3. IDEMPOTENCE — Confirm pressed twice ===');
// ============================================================
{
  const lines = [mkLine('a', '9', 'L1', 20), mkLine('b', '9', 'L2', 12)];
  const per1 = settle(lines, [{ materialId: '9', received: 25 }]);
  const snap = JSON.stringify(lines);
  // The widget retried; the same payload arrives again.
  const per2 = settle(lines, [{ materialId: '9', received: 25 }]);

  ok('the lines do not move on a re-run', JSON.stringify(lines) === snap,
    'before=' + snap + '\n     after =' + JSON.stringify(lines));
  ok('no extra metres are received', r2(lines.reduce((s, l) => s + l.received, 0)) === 25,
    'received=' + lines.reduce((s, l) => s + l.received, 0));
  ok('no extra dispute is raised', r2(lines.reduce((s, l) => s + l.disputed, 0)) === 7,
    'disputed=' + lines.reduce((s, l) => s + l.disputed, 0));
  // The second call still REPORTS the settled totals, so the fan can re-run.
  const p2 = per2.filter(p => p.materialId === '9')[0];
  ok('a re-run still reports totals for the fan', p2 && p2.arrived === 25 && p2.short === 7,
    'arrived=' + (p2 && p2.arrived) + ' short=' + (p2 && p2.short) +
    ' (the fan is capped at the requirement, so re-reporting cannot over-credit)');
}

// ============================================================
console.log('\n=== R4. TWO-STAGE receipt: partial now, the rest later ===');
// ============================================================
{
  const lines = [mkLine('a', '9', 'L1', 20), mkLine('b', '9', 'L2', 12)];
  settle(lines, [{ materialId: '9', received: 25 }]);   // 25 of 32, 7 disputed

  // The 7 turn up later on a NEW voucher — a fresh line for the same material.
  const later = [mkLine('c', '9', 'L2', 7)];
  settle(later, []);
  ok('the later line settles clean', later[0].received === 7 && later[0].disputed === 0,
    'rcv=' + later[0].received + ' dsp=' + later[0].disputed);

  const totalIssued = 32 + 7;
  const totalRcv = r2(lines.concat(later).reduce((s, l) => s + l.received, 0));
  const totalDsp = r2(lines.concat(later).reduce((s, l) => s + l.disputed, 0));
  ok('across both receipts nothing vanishes', r2(totalRcv + totalDsp) === totalIssued,
    'issued=' + totalIssued + ' rcv=' + totalRcv + ' dsp=' + totalDsp);
  ok('the original dispute is untouched by the later receipt', totalDsp === 7,
    'disputed=' + totalDsp + ' (it is resolved through the disputes screen, not here)');
}

// ============================================================
console.log('\n=== R5. LEGACY lines (Settled_Qty, no Line_Status) ===');
// ============================================================
{
  // A voucher issued before Line_Status existed: Settled_Qty is its
  // accounts-for figure, and its arrived part was never recorded per line.
  const legacy = [{ id: 'L', materialId: '9', lot: 'L1', qty: 20,
                    received: 0, disputed: 0, settled: 0, status: '' }];
  settle(legacy, []);
  ok('a legacy line still settles', legacy[0].received === 20,
    'rcv=' + legacy[0].received);
  ok('and converges to the new shape', legacy[0].status !== '' && legacy[0].settled === 20,
    'status=' + legacy[0].status + ' settled=' + legacy[0].settled);
  ok('Qty == Received + Disputed holds after conversion',
    r2(legacy[0].received + legacy[0].disputed) === 20,
    'rcv=' + legacy[0].received + ' dsp=' + legacy[0].disputed);

  // And it cannot be settled a second time by EITHER test.
  const snap = JSON.stringify(legacy);
  settle(legacy, []);
  ok('a converted legacy line is not re-settled', JSON.stringify(legacy) === snap, 'moved');
}

// ============================================================
console.log('\n=== R6. the throttle predicate vs ordinary dispute notices ===');
// ============================================================
{
  // REGRESSION. receive.js scanned EVERY errors[] entry for throttle codes with
  // a bare indexOf('429'). receiveHandover puts routine notices in errors[]:
  //   "Waste piece 429x120: 2 of 5 not received - dispute raised"
  //   "Waste piece 40x80: 4.29 of 9 not received - dispute raised"
  //   "Printed piece 3955559000000429001 not found"
  // The first two are not failures at all — they are what a short receipt is
  // SUPPOSED to produce. Matching them replayed the call five times over ~2
  // minutes and then aborted, so receiveFanOut never ran: the material read as
  // received but its requirement rows were never fanned and readiness never
  // recomputed.
  const src = fs.readFileSync(path.join(ROOT, 'app/supervisor/js/receive.js'), 'utf8');
  const m = src.match(/function isRateLimited\(err\)\s*\{[\s\S]*?\n    \}/);
  ok('isRateLimited is still where this test expects it', !!m, 'not found — update this test');
  if (m) {
    const body = m[0].replace(/^function isRateLimited\(err\)\s*\{/, '').replace(/\}\s*$/, '');
    const fn = new Function('err', 'String', 'RegExp', body);
    const isRL = (e) => { try { return !!fn(e, String, RegExp); } catch (x) { return 'THREW'; } };

    ok('a genuine 429 still retries', isRL({ message: 'HTTP 429' }) === true, '429');
    ok('a genuine status 429 still retries', isRL({ status: 429 }) === true, 'status');
    ok('4834 still retries', isRL({ message: 'code 4834' }) === true, '4834');
    ok('"too many requests" still retries', isRL({ message: 'Too Many Requests' }) === true, 'wording');

    ok('a waste DIMENSION containing 429 does not retry',
      isRL({ message: 'Waste piece 429x120: 2 of 5 not received - dispute raised' }) === false,
      '429x120');
    ok('a QUANTITY containing 429 does not retry',
      isRL({ message: 'Waste piece 40x80: 4.29 of 9 not received - dispute raised' }) === false,
      '4.29');
    ok('a record id containing 429 does not retry',
      isRL({ message: 'Printed piece 3955559000000429001 not found' }) === false, 'an 18-digit id');
  }

  // And the call sites must screen for the DELUGE: prefix, so a routine notice
  // is never even a throttle candidate.
  const sites = src.match(/parsed\.errors\.some\(function \(e\) \{[\s\S]*?\}\)/g) || [];
  ok('every errors[] throttle scan screens for DELUGE:', sites.length > 0 &&
    sites.every(s => s.indexOf('DELUGE:') !== -1),
    'scans=' + sites.length + ' screened=' + sites.filter(s => s.indexOf('DELUGE:') !== -1).length);
}

console.log('\n========================================');
console.log('receive-settle-path: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
