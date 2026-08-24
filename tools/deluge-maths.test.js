#!/usr/bin/env node
// Faithful Node ports of the Deluge arithmetic behind plan creation and material
// issue, plus lifecycle tests over them. The ports mirror the .dg files line for
// line - same guards, same truncation-before-ceil, same clamps - so a failure
// here names a real Deluge line.
//
//   usage: node tools/deluge-maths.test.js
//
// Ports:
//   buildItemRequirements      deluge/buildItemRequirements.dg:74-128
//   screenFreshMeters          deluge/getStoreMaterialRequirements.dg:802-844
//   issueBudget                deluge/issueMaterials.dg:209-313 (pass 1 + raise-only budget)
//   fanPass                    deluge/issueMaterials.dg:1180-1662 (cap, snap-down, credit)
//
// Deluge notes encoded here:
//   - produceQty is toDecimal().toLong() -> integer.
//   - (a / b) on two integers truncates; (a * 1.0 / b).ceil() is the fix.
//   - widthCm = Fabric_Width_Inches.toDecimal() * 2.54.

'use strict';
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}
function approx(a, b, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + ' +/- ' + eps + ', got ' + a);
}

// ---- Deluge semantics helpers -------------------------------------------------

function dFloor(x) { return Math.floor(x + 1e-12); }   // decimal floor, tolerant of fp noise like 137.16/45.72
function dCeil(x) { const v = Math.ceil(x - 1e-12); return v === 0 ? 0 : v; }

// ---- PORT 1: buildItemRequirements (fabric branch + non-fabric branch) --------

function inchesToCm(inchesTxt) {
  // deluge/buildItemRequirements.dg:76-82 — stored as TEXT in inches.
  const s = (inchesTxt === null || inchesTxt === undefined) ? '' : String(inchesTxt).trim();
  return s === '' ? 0.0 : parseFloat(s) * 2.54;
}

function buildItemRequirements(item) {
  // item: {isFabric, fabricWidthInches, cutLen, cutWid, perUnit, produceQty}
  // returns one requirement row as the Deluge would emit it.
  let reqQty = 0.0, piecesPerRow = 0, perUnit = 0;
  const cutLen = item.cutLen || 0, cutWid = item.cutWid || 0;
  const produceQty = Math.trunc(Number(item.produceQty) || 0); // .toLong()
  const piecesNeeded = item.isFabric ? produceQty : 0;
  const widthCm = item.isFabric ? inchesToCm(item.fabricWidthInches) : 0;
  let warn = '', error = '';

  if (item.isFabric) {
    if (!(widthCm > 0) || !(cutWid > 0) || !(cutLen > 0)) {
      reqQty = 0; warn = 'WARN (missing width/cut size)';
    } else if (cutWid > widthCm) {
      reqQty = 0; error = 'ERROR (cut width exceeds fabric width)';
    } else {
      piecesPerRow = dFloor(widthCm / cutWid);
      const totalRows = dCeil((piecesNeeded * 1.0) / piecesPerRow);
      reqQty = (totalRows * cutLen) / 100;
    }
  } else {
    perUnit = item.perUnit || 0;
    reqQty = perUnit * produceQty;
  }
  return { reqQty, cutLen, cutWid, pcs: piecesNeeded, perRow: piecesPerRow, perUnit, warn, error };
}

// ---- PORT 2: getStoreMaterialRequirements fresh-metres block -------------------

function screenFreshMeters(row) {
  // row: {required, issued, reqPieces, issPieces, cutW, cutL, fabricWidthCm}
  // deluge/getStoreMaterialRequirements.dg:708-858
  const req = row.required || 0, iss = row.issued || 0;
  const outstandingPieces = Math.max(0, (row.reqPieces || 0) - (row.issPieces || 0));
  const remainPcs = outstandingPieces;
  let canCount = false, perRowR = 0;
  if ((row.reqPieces || 0) > 0 && row.cutW > 0 && row.cutL > 0 && row.fabricWidthCm > 0) {
    perRowR = dFloor(row.fabricWidthCm / row.cutW);
    if (perRowR > 0) canCount = true;
  }
  let freshMeters = 0.0;
  if (canCount) {
    if (remainPcs > 0) {
      const rowsR = dCeil((remainPcs * 1.0) / perRowR);
      freshMeters = (rowsR * row.cutL) / 100;
    }
  } else {
    freshMeters = Math.max(0, req - iss);
  }
  return { freshMeters, outstandingPieces, canCount };
}

// Widget-side parity formula — app/js/lot-allocator.js write-back block.
function widgetNeed(m) {
  const prNeed = (m.fabricWidthCm > 0 && m.cutWidth > 0 && m.fabricWidthCm >= m.cutWidth)
    ? dFloor(m.fabricWidthCm / m.cutWidth) : 0;
  const cl = m.cutLength || 0;
  const freshPieces = Math.max(0, m.owed - m.fromWaste);
  if ((m.requiredPieces || 0) > 0 && prNeed > 0 && cl > 0) {
    return freshPieces > 0 ? Math.round((Math.ceil(freshPieces / prNeed) * cl) / 100 * 100) / 100 : 0;
  }
  return Math.round(Math.max(0, m.freshMetersServer || 0) * 100) / 100;
}

// ---- PORT 3+4: issueMaterials ledger ------------------------------------------
// Simulates pass 1 + raise-only budget + per-pass caps/snapping/credits/fan for
// ONE material line of one issue press, against requirement rows held in memory.

function issueMaterialLine(state, payload) {
  // state: rows[] each {reqQty, issuedQty, reqPieces, fromWaste, fromRaw, cutW, cutL,
  //                     source, planItemId, issuedLot}
  //        env {fabricWidthCm, matId, srcWanted, cutW, cutL, isFab, lotWash}
  // payload: {metres, picks:[{wasteId, physicalPcs, yieldPer, pinnedItem}],
  //           passes:[{lotId, qty, pin, pieces:[{len, wid, count}]}]}
  // Returns {rows, movedMetres, errors[], lotMoved, events[]}
  const env = state.env, isFab = env.isFab;
  const errors = [];
  const ev = [];

  // ---- Pass 1: aggregate outstanding (issueMaterials.dg:209-264)
  let outstanding = 0.0, outPieces = 0;
  for (const r of state.rows) {
    if (r.source !== env.srcWanted) continue;
    const rem = r.reqQty - r.issuedQty;
    if (rem > 0) outstanding += rem;
    if (isFab) {
      const pRem = r.reqPieces - (r.fromWaste + r.fromRaw);
      if (pRem > 0) outPieces += pRem;
    }
  }
  // Raise-only piece budget (:299-313)
  let perRowB = 0;
  if (isFab && outPieces > 0 && env.cutW > 0 && env.cutL > 0 && env.fabricWidthCm >= env.cutW) {
    perRowB = dFloor(env.fabricWidthCm / env.cutW);
    if (perRowB > 0) {
      const rowsB = dCeil((outPieces * 1.0) / perRowB);
      const pieceBudget = (rowsB * env.cutL) / 100;
      if (pieceBudget > outstanding) outstanding = pieceBudget;
    }
  }

  // ---- Pass 2: waste picks (:320-480)
  let piecesFromWaste = 0, wFree = 0;
  const wPinTot = {};
  for (const pk of payload.picks) {
    if (!pk.ok) continue; // validation failures are modelled by the caller
    const credited = pk.physicalPcs * pk.yieldPer;
    piecesFromWaste += credited;
    if (!pk.pinnedItem) wFree += credited;
    else wPinTot[pk.pinnedItem] = (wPinTot[pk.pinnedItem] || 0) + credited;
  }
  if (piecesFromWaste > outPieces) piecesFromWaste = outPieces; // :477-480

  // ---- Pass 2b: lot validation sums (:535-725)
  const lotSum = {}, orderLot = {};
  let lotTotal = 0.0;
  for (const la of payload.passes) {
    if (la.qty <= 0) continue;
    if (env.lotBlocked[la.lotId]) { errors.push('lot blocked'); continue; }
    lotSum[la.lotId] = (lotSum[la.lotId] || 0) + la.qty;
    if (la.planId) {
      if (orderLot[la.planId] && orderLot[la.planId] !== la.lotId)
        errors.push('one order cannot be cut from two lots');
      orderLot[la.planId] = la.lotId;
    }
    lotTotal += la.qty;
  }
  for (const lid of Object.keys(lotSum)) {
    const have = env.lotWash[lid] || 0;
    if (lotSum[lid] > have + 1e-9) errors.push('lot has ' + have + ' washed, asked ' + lotSum[lid]);
  }
  // ---- Pass 2c: PIECE VALIDATION, hoisted BEFORE the gate (:768-848)
  //
  // These four tests used to live at :1137-1152, inside the WRITE branch and
  // ~370 lines past the gate that reads lotErr — so they refused nothing. The
  // port did not model them at all, which is why 69 passing tests never caught
  // it: the port covered the arithmetic, and this was a control-flow defect.
  //
  // A piece carrying no status fields is treated as valid, so every test that
  // does not model piece identity behaves exactly as before.
  for (const la of payload.passes) {
    if (!la.pieces || !la.pieces.length) continue;
    if (!(env.cutW > 0 && env.cutL > 0)) continue;
    for (const pc of la.pieces) {
      if (pc.missing) { errors.push('a piece in this handover no longer exists'); continue; }
      if (pc.lot !== undefined && pc.lot !== la.lotId) { errors.push('a piece in this handover is not on the lot it names'); continue; }
      if (pc.status !== undefined && pc.status !== 'Available') { errors.push('a piece in this handover is no longer available'); continue; }
      if (pc.state !== undefined && pc.state !== 'Wash') { errors.push('a greige piece cannot be issued - it has to be washed first'); continue; }
      if (pc.onRack !== undefined && pc.count > pc.onRack) { errors.push('only ' + pc.onRack + ' of that piece are on the rack'); continue; }
    }
  }

  if (errors.length) return { rows: state.rows, errors, movedMetres: 0 };

  if (isFab && lotTotal <= 0 && payload.picks.length === 0) {
    errors.push('choose which lot the cloth comes from');
    return { rows: state.rows, errors, movedMetres: 0 };
  }

  // issueQty = min(askQty, outstanding) — issueMaterials.dg:800-804
  const askQty = isFab ? lotTotal : (payload.qty || 0);
  let issueQty = Math.min(askQty, outstanding);

  // ---- Pass list construction (:860-890)
  const passList = [];
  if (isFab) {
    const pinSeen = [];
    for (const p of payload.passes) if (p.qty > 0) {
      passList.push(p);
      const pp = p.pin || '';
      if (pinSeen.indexOf(pp) < 0) pinSeen.push(pp);
    }
    // F1 FIX (:1045-1100). Every pin holding waste credit gets a pass of its own
    // when it has none, so the fan reaches its rows.
    //
    // The old guard was `passList.length === 0`, which is false the moment ANOTHER
    // item on the same card contributes a lot line — so an offcut-complete order
    // sharing a lot with a cloth-taking order was never fanned, its
    // Pieces_From_Waste never landed, and its remnants left the rack booking
    // nothing. The synthetic pass moves no cloth (qty 0, no lot); it exists only
    // so those rows are visited.
    for (const pin of Object.keys(wPinTot)) {
      if (pin && wPinTot[pin] > 0 && pinSeen.indexOf(pin) < 0) {
        passList.push({ lotId: '', qty: 0, pin: pin, pieces: [] });
        pinSeen.push(pin);
      }
    }
    // Unpinned credit needs an unpinned pass — only one with no pin visits every row.
    if (wFree > 0 && pinSeen.indexOf('') < 0) {
      passList.push({ lotId: '', qty: 0, pin: '', pieces: [] });
      pinSeen.push('');
    }
  } else {
    passList.push({ lotId: '', qty: issueQty, pin: '', pieces: [] }); // :887-890
  }

  // ---- Per-pass execution (:930-1662)
  const perRowP = isFab ? dFloor(env.fabricWidthCm / env.cutW) : 0;
  // canPiece mirrors :911-920 EXACTLY — cut/width data only; it does NOT test
  // whether any row actually carries Required_Pieces.
  const canPiece = isFab && env.cutW > 0 && env.cutL > 0 &&
                   env.fabricWidthCm >= env.cutW && perRowP > 0;
  let fanWaste = piecesFromWaste, fanRawTotal = 0, issuedTotal = 0.0;

  function livePinLefts(pin) {
    // :961-1023 — read off the ROWS, so earlier passes' writes are seen.
    let pinPcsLeft = 0, pinQtyLeft = 0.0;
    for (const r of state.rows) {
      if (r.source !== env.srcWanted || r.planItemId !== pin) continue;
      const rem = r.reqQty - r.issuedQty;
      if (rem > 0) pinQtyLeft += rem;
      const pcs = r.reqPieces - (r.fromWaste + r.fromRaw);
      if (pcs > 0) pinPcsLeft += pcs;
    }
    return { pinPcsLeft, pinQtyLeft };
  }

  let lotMovedTotal = 0.0;
  for (const pass of passList) {
    if (pass.qty <= 0 && !(isFab && pass.lotId === '' && payload.picks.length > 0)) continue;
    let thisQty = pass.qty;
    let pcYield = 0, pcMetres = 0.0, passIsPieces = false;
    if (isFab && pass.pieces && pass.pieces.length && env.cutW > 0 && env.cutL > 0) {
      for (const pc of pass.pieces) {
        const across = dFloor(pc.wid / env.cutW), along = dFloor(pc.len / env.cutL);
        if (across > 0 && along > 0) pcYield += across * along * pc.count;
        pcMetres += (pc.len * pc.count) / 100; // whole pieces only
        passIsPieces = true;
      }
    }

    let capQty = 0.0;
    let wAvail = 0;
    if (canPiece) {
      let pinPcsLeft = 0;
      if (pass.pin) {
        const L = livePinLefts(pass.pin);
        pinPcsLeft = L.pinPcsLeft;
        wAvail = wFree + (wPinTot[pass.pin] || 0);
        if (wAvail > fanWaste) wAvail = fanWaste;
      }
      const pcsLeft = pass.pin ? (pinPcsLeft - wAvail)
                               : (outPieces - piecesFromWaste - fanRawTotal);
      if (pcsLeft > 0) {
        const rowsCap = dCeil((pcsLeft * 1.0) / perRowP);
        capQty = (rowsCap * env.cutL) / 100;
      }
    } else {
      capQty = outstanding - issuedTotal;
    }
    if (thisQty > capQty) thisQty = capQty;

    // Whole marker rows only (:1247-1251), then pieces-pass override.
    if (isFab && env.cutL > 0 && !passIsPieces) {
      const rowsFit = dFloor((thisQty * 100) / env.cutL);
      thisQty = (rowsFit * env.cutL) / 100;
    }
    if (passIsPieces) thisQty = pcMetres;
    if (thisQty < 0) thisQty = 0.0;
    if (!(thisQty > 0 || fanWaste > 0)) continue;

    // Pieces THIS lot's cloth covers (:1295-1330)
    let piecesFromRaw = 0;
    if (canPiece) {
      const rowsIssued = dFloor((thisQty * 100) / env.cutL);
      piecesFromRaw = perRowP * rowsIssued;
      if (passIsPieces) piecesFromRaw = pcYield;
      let stillNeeded = outPieces - piecesFromWaste - fanRawTotal;
      if (pass.pin) stillNeeded = livePinLefts(pass.pin).pinPcsLeft - wAvail;
      if (piecesFromRaw > stillNeeded) piecesFromRaw = stillNeeded;
      if (piecesFromRaw < 0) piecesFromRaw = 0;
    }
    let fanRaw = piecesFromRaw;
    fanRawTotal += piecesFromRaw;
    issuedTotal += thisQty;

    // ---- Fan (:1343-1662)
    let toFan = thisQty;
    for (const r of state.rows) {
      if (r.source !== env.srcWanted) continue;
      if (pass.pin && r.planItemId !== pass.pin) continue;
      if (toFan > 0) {
        let rowRem = r.reqQty - r.issuedQty;
        if (isFab && env.cutW > 0 && env.cutL > 0 && env.fabricWidthCm >= env.cutW) {
          const perRowF = dFloor(env.fabricWidthCm / env.cutW);
          const rowPcsReq = r.reqPieces;
          const rowPcsRem = rowPcsReq - (r.fromWaste + r.fromRaw);
          if (perRowF > 0 && rowPcsReq > 0) {
            rowRem = 0.0;
            if (rowPcsRem > 0) {
              const rowsF = dCeil((rowPcsRem * 1.0) / perRowF);
              rowRem = (rowsF * env.cutL) / 100;
            }
          }
        }
        if (rowRem > 0) {
          const give = Math.min(toFan, rowRem);
          r.issuedQty += give;
          toFan -= give;
          if (give > 0) {
            ev.push({ kind: 'line', row: r, qty: give, lot: pass.lotId });
            if (pass.lotId && !r.issuedLot) r.issuedLot = pass.lotId; // stamp once
          }
        }
      }
      if (isFab && (fanWaste > 0 || fanRaw > 0)) {
        let pRem2 = r.reqPieces - (r.fromWaste + r.fromRaw);
        if (pRem2 > 0) {
          let giveW = wFree + (wPinTot[r.planItemId] || 0);
          if (giveW > fanWaste) giveW = fanWaste;
          if (giveW > pRem2) giveW = pRem2;
          if (giveW > 0) {
            r.fromWaste += giveW; fanWaste -= giveW; pRem2 -= giveW;
            const useP = Math.min(giveW, wPinTot[r.planItemId] || 0);
            if (useP > 0) wPinTot[r.planItemId] -= useP;
            wFree = Math.max(0, wFree - (giveW - useP));
            ev.push({ kind: 'waste', row: r, pcs: giveW });
          }
          let giveR = fanRaw;
          if (giveR > pRem2) giveR = pRem2;
          if (giveR > 0) { r.fromRaw += giveR; fanRaw -= giveR; ev.push({ kind: 'raw', row: r, pcs: giveR }); }
        }
      }
    }
    if (pass.lotId) {
      const moved = passIsPieces ? pcMetres : thisQty;
      env.lotWash[pass.lotId] = (env.lotWash[pass.lotId] || 0) - moved;
      lotMovedTotal += moved;
    }
  }

  return { rows: state.rows, errors, movedMetres: issuedTotal, lotMoved: lotMovedTotal, events: ev, outPieces, outstandingBeforeRaise: undefined };
}

// =====================================================================
// PART A — plan-time maths (buildItemRequirements)
// =====================================================================

console.log('\nPART A — buildItemRequirements (plan-time)');

test('A1 exact fit: 66" cloth (167.64cm) at 55cm cut gives 3/row', () => {
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 99 });
  assert.strictEqual(r.perRow, 3);
});
test('A2 documented example: 100 pcs @3/row, 55cm -> 18.70 Mtr', () => {
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 100 });
  approx(r.reqQty, 18.70); assert.strictEqual(r.perRow, 3); assert.strictEqual(r.pcs, 100);
});
test('A3 ceil boundary: exactly divisible needs no extra row', () => {
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 99 });
  approx(r.reqQty, 99 / 3 * 0.55);
});
test('A4 ceil boundary +1 forces the extra row', () => {
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 100 });
  approx(r.reqQty, 34 * 0.55);
});
test('A5 one row when pieces <= perRow', () => {
  const a = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 3 });
  const b = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 1 });
  approx(a.reqQty, 0.55); approx(b.reqQty, 0.55);
});
test('A6 zero pieces plans zero metres but keeps the row shape', () => {
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 0 });
  assert.strictEqual(r.reqQty, 0); assert.strictEqual(r.pcs, 0); assert.strictEqual(r.perRow, 3);
});
test('A7 cut width == fabric width -> 1 per row, never 0', () => {
  // width exactly equal: floor(x/x)=1
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '21.654', cutLen: 200, cutWid: 55, produceQty: 10 });
  // 21.654*2.54=55.00116 -> perRow 1
  assert.strictEqual(r.perRow, 1); approx(r.reqQty, 10 * 2.00);
});
test('A8 cut wider than cloth is refused with 0 and an error, NOT 1-per-row', () => {
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '40', cutLen: 55, cutWid: 110, produceQty: 10 });
  assert.strictEqual(r.reqQty, 0); assert.ok(r.error.includes('ERROR'));
});
test('A9 missing width text -> 0 + WARN, not a throw', () => {
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '', cutLen: 55, cutWid: 55, produceQty: 10 });
  assert.strictEqual(r.reqQty, 0); assert.ok(r.warn.length > 0);
});
test('A10 zero cut length or width -> 0 + WARN', () => {
  assert.strictEqual(buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 0, cutWid: 55, produceQty: 10 }).reqQty, 0);
  assert.strictEqual(buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 0, produceQty: 10 }).reqQty, 0);
});
test('A11 fractional inches handled (44.5")', () => {
  // 44.5*2.54=113.03 ; cut 55 -> perRow 2 ; 101 pcs -> 51 rows
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '44.5', cutLen: 55, cutWid: 55, produceQty: 101 });
  assert.strictEqual(r.perRow, 2); approx(r.reqQty, 51 * 0.55);
});
test('A12 large quantity stays exact (2500 pcs)', () => {
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 137, cutWid: 55, produceQty: 2500 });
  assert.strictEqual(r.perRow, 3); approx(r.reqQty, Math.ceil(2500 / 3) * 1.37);
});
test('A13 non-fabric: perUnit x qty, fractions kept', () => {
  const r = buildItemRequirements({ isFabric: false, perUnit: 0.35, produceQty: 7 });
  approx(r.reqQty, 2.45);
});
test('A14 non-fabric ignores cut size entirely', () => {
  const r = buildItemRequirements({ isFabric: false, perUnit: 2, produceQty: 5, cutLen: 55, cutWid: 55 });
  approx(r.reqQty, 10); assert.strictEqual(r.pcs, 0);
});
test('A15 THE regression: *1.0 before ceil (old code stranded a piece at 100@3)', () => {
  // Old: 100/3 truncated to 33 -> ceil 33 -> 18.15m lays 99. New: 34 rows.
  const r = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 100 });
  assert.notStrictEqual(Math.round(r.reqQty * 100) / 100, 18.15);
  approx(r.reqQty, 18.70);
});

// Property sweep A: plan-time oracle
test('A16 sweep: rows*perRow >= pcs AND rows*perRow - perRow < pcs (no strand, no waste row)', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 3000; i++) {
    const inches = (30 + rnd() * 60).toFixed(1);
    const cutW = 20 + Math.floor(rnd() * 60);
    const cutL = 20 + Math.floor(rnd() * 150);
    const qty = 1 + Math.floor(rnd() * 500);
    const widthCm = parseFloat(inches) * 2.54;
    if (cutW > widthCm) continue;
    const perRow = dFloor(widthCm / cutW);
    if (perRow < 1) continue;
    const rows = dCeil((qty * 1.0) / perRow);
    if (!(rows * perRow >= qty)) throw new Error('strand: ' + [inches, cutW, cutL, qty]);
    if (!(qty === 0 || (rows - 1) * perRow < qty)) throw new Error('wasted row: ' + [inches, cutW, qty]);
  }
});

// =====================================================================
// PART B — cross-layer consistency + issue ledger lifecycle
// =====================================================================

console.log('\nPART B — screen/budget/ledger consistency');

test('B1 parity: server freshMeters == plan-time reqQty when nothing issued', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2000; i++) {
    const inches = (30 + rnd() * 60).toFixed(1);
    const cutW = 20 + Math.floor(rnd() * 60), cutL = 20 + Math.floor(rnd() * 150);
    const qty = 1 + Math.floor(rnd() * 400);
    const widthCm = parseFloat(inches) * 2.54;
    if (cutW > widthCm) continue;
    const plan = buildItemRequirements({ isFabric: true, fabricWidthInches: inches, cutLen: cutL, cutWid: cutW, produceQty: qty });
    const scr = screenFreshMeters({ required: plan.reqQty, issued: 0, reqPieces: qty, issPieces: 0, cutW, cutL, fabricWidthCm: widthCm });
    approx(scr.freshMeters, plan.reqQty, 1e-9);
  }
});

test('B2 parity: widget need-formula == server formula incl. degenerate inputs', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 3000; i++) {
    const widthCm = [0, 50, 113.03, 137.16, 167.64][Math.floor(rnd() * 5)];
    const cutW = [0, 40, 55, 110][Math.floor(rnd() * 4)];
    const cutL = [0, 45, 55][Math.floor(rnd() * 3)];
    const rp = [0, 1, 7, 40][Math.floor(rnd() * 4)];
    const ip = Math.min(rp, Math.floor(rnd() * 41));
    const fromW = Math.min(ip, Math.floor(rnd() * (ip + 1))); // waste credit is part of issued
    const owed = rp - ip;
    const srv = screenFreshMeters({ required: 10, issued: 2, reqPieces: rp, issPieces: ip, cutW, cutL, fabricWidthCm: widthCm });
    const need = widgetNeed({
      fabricWidthCm: widthCm, cutWidth: cutW, cutLength: cutL,
      requiredPieces: rp, owed, fromWaste: fromW,
      freshMetersServer: srv.freshMeters
    });
    // Server: canCount iff rp>0 && cutW>0 && cutL>0 && width>0 && floor(w/cutW)>0.
    // Widget need sizes FRESH cloth only: pieces beyond what offcuts cover.
    const perRow = dFloor(widthCm / cutW);
    const canCount = rp > 0 && cutW > 0 && cutL > 0 && widthCm > 0 && perRow > 0;
    const freshPcs = Math.max(0, owed - fromW);
    const expect = canCount
      ? (freshPcs > 0 ? Math.round(dCeil((freshPcs * 1.0) / perRow) * cutL / 100 * 100) / 100 : 0)
      : Math.max(0, 10 - 2);
    approx(need, expect, 0.011);
  }
});

test('B3 documented split-handover case: 100pcs@3/row 55cm — second ask RAISES to 8.80 over the 8.70 balance', () => {
  const widthCm = 66 * 2.54;
  const plan = buildItemRequirements({ isFabric: true, fabricWidthInches: '66', cutLen: 55, cutWid: 55, produceQty: 100 });
  approx(plan.reqQty, 18.70);
  // Handover 1: 10.00m asked, one row, no offcuts, no pins.
  const rows = [{ reqQty: plan.reqQty, issuedQty: 0, reqPieces: 100, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'ITEM', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 40 }, lotBlocked: {} } };
  let res = issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 10.00, pin: '', pieces: [] }], picks: [] });
  assert.deepStrictEqual(res.errors, []);
  const r1 = st.rows[0];
  approx(r1.issuedQty, 9.90);            // snapped to 18 whole rows
  assert.strictEqual(r1.fromRaw, 54);    // 18 rows x 3
  approx(res.lotMoved, 9.90);
  // Handover 2: balance says 18.70-9.90=8.80... but the PIECE truth: 46 left -> 16 rows -> 8.80.
  res = issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 8.80, pin: '', pieces: [] }], picks: [] });
  assert.deepStrictEqual(res.errors, []);
  const r2 = st.rows[0];
  approx(r2.issuedQty, 18.70);           // 16 more rows exactly close it
  assert.strictEqual(r2.fromRaw, 100);
  // Issued_Qty == Required_Qty here because both rounds were whole-row aligned.
});

test('B4 THE STRANDED-PIECE regression: odd first handover must not strand the last piece', () => {
  const widthCm = 66 * 2.54;
  const rows = [{ reqQty: 18.70, issuedQty: 0, reqPieces: 100, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 100 }, lotBlocked: {} } };
  issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 10.00, pin: '', pieces: [] }], picks: [] });
  // 54 done, 46 left. Balance 8.70 < needed 8.80 — budget must RAISE.
  const res2 = issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 8.80, pin: '', pieces: [] }], picks: [] });
  assert.deepStrictEqual(res2.errors, []);
  assert.strictEqual(st.rows[0].fromRaw, 100, 'last piece stranded!');
});

test('B5 whole-row snap DOWN leaves the remainder on the roll', () => {
  const widthCm = 66 * 2.54;
  const rows = [{ reqQty: 27.50, issuedQty: 0, reqPieces: 150, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 5.00 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 5.00, pin: '', pieces: [] }], picks: [] });
  const r = st.rows[0];
  approx(r.issuedQty, 4.95);   // 9 rows
  assert.strictEqual(r.fromRaw, 27);
  approx(res.lotMoved, 4.95);
  approx(st.env.lotWash.L1, 0.05, 1e-9); // 5cm stays on the shelf
});

test('B6 offcuts cover first; surplus cuts are NOT booked against the requirement', () => {
  const widthCm = 66 * 2.54;
  // One pick: 2 physical remnants each yielding 2 cuts of the 55x55 size -> 4 credits.
  // Row owes 3. Total credits clamp to 3.
  const rows = [{ reqQty: 0.55, issuedQty: 0, reqPieces: 3, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 5 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, {
    picks: [{ ok: true, wasteId: 'W1', physicalPcs: 2, yieldPer: 2, pinnedItem: '' }],
    passes: []
  });
  assert.strictEqual(st.rows[0].fromWaste, 3, 'surplus must be clamped to owed');
  assert.strictEqual(st.rows[0].fromRaw, 0);
  assert.deepStrictEqual(res.errors, []);
});

test('B7 too-small remnant yields ZERO cuts even though physically handed over', () => {
  // yieldPer computed as floor(w/cutW)*floor(l/cutL) with min-dims guard -> 0.
  const widthCm = 66 * 2.54;
  const rows = [{ reqQty: 0.55, issuedQty: 0, reqPieces: 2, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 5 }, lotBlocked: {} } };
  issueMaterialLine(st, {
    picks: [{ ok: true, wasteId: 'W9', physicalPcs: 1, yieldPer: 0, pinnedItem: '' }],
    passes: [{ lotId: 'L1', qty: 1.10, pin: '', pieces: [] }]
  });
  assert.strictEqual(st.rows[0].fromWaste, 0, 'zero-yield pick must not close the requirement');
  assert.strictEqual(st.rows[0].fromRaw, 2); // fresh cloth covered it instead
});

test('B8 pinned pass budgets against ITS ITEM ONLY (the A/B bleed bug)', () => {
  const widthCm = 66 * 2.54; // 2/row at 55? no: 167.64/55=3. Use cut that gives 2/row: width 120cm ~ 47.24"
  const w2 = 47.25 * 2.54;   // 120.01cm -> floor/55 = 2
  // Items A and B on ONE order, same material & cut size, each owing 10 @2/row, cut 110 long.
  const mk = () => ([
    { reqQty: 5.50, issuedQty: 0, reqPieces: 10, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'A', issuedLot: '' },
    { reqQty: 5.50, issuedQty: 0, reqPieces: 10, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'B', issuedLot: '' },
  ]);
  const st = { rows: mk(), env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 110, fabricWidthCm: w2, lotWash: { L1: 20 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, {
    passes: [
      { lotId: 'L1', qty: 5.50, pin: 'A', pieces: [] },
      { lotId: 'L1', qty: 5.50, pin: 'B', pieces: [] },
    ], picks: []
  });
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(st.rows[0].fromRaw, 10, 'A covered fully');
  assert.strictEqual(st.rows[1].fromRaw, 10, 'B covered fully — no bleed');
  approx(st.rows[0].issuedQty, 5.50); approx(st.rows[1].issuedQty, 5.50);
  approx(res.lotMoved, 11.00);
});

test('B9 residue DOWN: offcut-covered row does not swallow the next lot\'s cloth', () => {
  const w2 = 47.25 * 2.54; // 2/row
  // One item owes 10 @2/row cut 110 -> 5.50m. Offcuts already cover 6 -> 4 left -> 2.20m.
  // Required_Qty still says 5.50, Issued_Qty 0. Two passes: L1 unpinned 3.30 then L2 2.20.
  // The rowCap must cap this row at 2.20 so L2's metres land on... nothing else exists ->
  // L2's pass gets capped to 0 for THIS row; nothing books. That is correct: only 2.20 needed.
  const rows = [{ reqQty: 5.50, issuedQty: 0, reqPieces: 10, fromWaste: 6, fromRaw: 0, source: 'Plan', planItemId: 'A', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 110, fabricWidthCm: w2, lotWash: { L1: 10, L2: 10 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, {
    passes: [
      { lotId: 'L1', qty: 3.30, pin: 'A', pieces: [] },
      { lotId: 'L2', qty: 2.20, pin: 'A', pieces: [] },
    ], picks: []
  });
  // First pass: cap = ceil((10-6)/2)=2 rows -> 2.20; snapped 2.20; credits 4. Row closes.
  approx(st.rows[0].issuedQty, 2.20);
  assert.strictEqual(st.rows[0].fromRaw, 4);
  assert.strictEqual(st.rows[0].issuedLot, 'L1'); // tone stamped once, by the FIRST lot
  // Second pass finds 0 left: moves nothing.
  approx(res.lotMoved, 2.20, 0.005);
});

test('B10 Issued_Lot stamped ONCE — later issues never rewrite history', () => {
  const widthCm = 66 * 2.54;
  const rows = [{ reqQty: 18.70, issuedQty: 0, reqPieces: 100, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 50, L2: 50 }, lotBlocked: {} } };
  issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 9.90, pin: '', pieces: [] }], picks: [] });
  issueMaterialLine(st, { passes: [{ lotId: 'L2', qty: 8.80, pin: '', pieces: [] }], picks: [] });
  assert.strictEqual(st.rows[0].issuedLot, 'L1');
});

test('B11 one order cannot straddle two lots', () => {
  const widthCm = 66 * 2.54;
  const rows = [{ reqQty: 18.70, issuedQty: 0, reqPieces: 100, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 50, L2: 50 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, {
    passes: [
      { lotId: 'L1', qty: 5.00, planId: 'SO1', pin: '', pieces: [] },
      { lotId: 'L2', qty: 5.00, planId: 'SO1', pin: '', pieces: [] },
    ], picks: []
  });
  assert.ok(res.errors.some(e => e.includes('two lots')));
  assert.strictEqual(res.movedMetres, 0, 'refusal must be total, not partial');
});

test('B12 blocked lot refused outright', () => {
  const widthCm = 66 * 2.54;
  const rows = [{ reqQty: 18.70, issuedQty: 0, reqPieces: 100, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { LB: 50 }, lotBlocked: { LB: true } } };
  const res = issueMaterialLine(st, { passes: [{ lotId: 'LB', qty: 5.00, pin: '', pieces: [] }], picks: [] });
  assert.ok(res.errors.some(e => e.toLowerCase().includes('blocked')));
  assert.strictEqual(st.rows[0].issuedQty, 0);
});

test('B13 lot stock check uses the SUMMED want, not per-line', () => {
  const widthCm = 66 * 2.54;
  const rows = [{ reqQty: 27.50, issuedQty: 0, reqPieces: 150, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 6.00 }, lotBlocked: {} } };
  // Two lines of 5.00 against the SAME lot: individually fine, summed 10.00 > 6.00.
  const res = issueMaterialLine(st, {
    passes: [
      { lotId: 'L1', qty: 5.00, pin: '', pieces: [] },
      { lotId: 'L1', qty: 5.00, pin: '', pieces: [] },
    ], picks: []
  });
  assert.ok(res.errors.some(e => e.includes('asked')), JSON.stringify(res.errors));
  assert.strictEqual(st.rows[0].issuedQty, 0, 'half-applied issue forbidden');
});

test('B14 pieces-lot yield is the pieces\' truth, not the metres\' division', () => {
  // Three 300cm pieces, full width 140cm, cut 55x60: per piece floor(140/60)=2 across,
  // floor(300/55)=5 along -> 10/piece -> 30 total. Metres leave WHOLE: 3x3.00=9.00.
  const rows = [{ reqQty: 9.90, issuedQty: 0, reqPieces: 30, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 60, cutL: 55, fabricWidthCm: 140, lotWash: { LP: 9.00 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, {
    passes: [{
      lotId: 'LP', qty: 9.00, pin: '',
      pieces: [{ len: 300, wid: 140, count: 1 }, { len: 300, wid: 140, count: 1 }, { len: 300, wid: 140, count: 1 }],
    }], picks: []
  });
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(st.rows[0].fromRaw, 30, 'must credit 30, not floor(900/55)*2=32');
  approx(res.lotMoved, 9.00, 0.005);           // whole pieces leave unsnapped
  approx(st.env.lotWash.LP, 0.00, 0.005);
  // Issued_Qty books against the row's marker-row ceiling (ceil(30/2)*0.55=8.25),
  // not the 9.00 that physically left: a piece goes out whole and its tail comes
  // back as an offcut. Completion is counted in PIECES, so this closes.
  approx(st.rows[0].issuedQty, 8.25, 1e-9);
});

// ---- B14b..B14f — the piece-validation refusals (issueMaterials.dg:768-848)
//
// REGRESSION SET for a real defect: the four checks lived at :1137-1152, inside
// the write branch and past the gate that reads lotErr, so they refused nothing.
// Each test below asserts a REFUSAL and, critically, that NOTHING MOVED — the
// old code's failure was not a wrong number, it was cloth leaving the lot while
// the pieces stayed on the rack.

function piecesLotState(lotMetres) {
  const rows = [{ reqQty: 9.90, issuedQty: 0, reqPieces: 30, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  return { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 60, cutL: 55, fabricWidthCm: 140, lotWash: { LP: lotMetres }, lotBlocked: {} } };
}
function goodPiece(over) {
  return Object.assign({ id: 'P1', len: 300, wid: 140, count: 1, lot: 'LP', status: 'Available', state: 'Wash', onRack: 5 }, over || {});
}

test('B14b EVERY piece invalid must REFUSE — not fall through to the roll path', () => {
  // THE BUG. All pieces fail, so passIsPieces stayed false, the pcMetres override
  // never fired, and the pass was issued as a ROLL: Wash_Quantity decremented
  // (:1690 unconditional) while the piece decrement was skipped (:1708 guarded).
  // Metres left the lot, no piece left the rack, and the pieces stayed Available
  // to be offered again on the next render.
  const st = piecesLotState(9.00);
  const res = issueMaterialLine(st, {
    passes: [{ lotId: 'LP', qty: 9.00, pin: '', pieces: [goodPiece({ status: 'Issued' })] }], picks: []
  });
  assert.ok(res.errors.length > 0, 'must refuse');
  approx(st.env.lotWash.LP, 9.00, 1e-9);      // NOT decremented
  approx(st.rows[0].issuedQty, 0, 1e-9);
  assert.strictEqual(st.rows[0].fromRaw, 0);
});

test('B14c SOME pieces invalid must REFUSE — silent trim is the thing forbidden', () => {
  // 2 of 3 valid used to give passIsPieces=true and thisQty=survivors only: the
  // handover recorded less cloth than he handed over, the requirement never
  // closed, and the item sat at Awaiting_Material with nothing saying why.
  const st = piecesLotState(9.00);
  const res = issueMaterialLine(st, {
    passes: [{
      lotId: 'LP', qty: 9.00, pin: '',
      pieces: [goodPiece({ id: 'P1' }), goodPiece({ id: 'P2' }), goodPiece({ id: 'P3', state: 'Unwash' })],
    }], picks: []
  });
  assert.ok(res.errors.some(e => e.indexOf('greige') >= 0), 'greige piece must be named');
  approx(st.env.lotWash.LP, 9.00, 1e-9);
  assert.strictEqual(st.rows[0].fromRaw, 0, 'no partial credit');
});

test('B14d a piece on ANOTHER lot is refused (tone safety)', () => {
  const st = piecesLotState(9.00);
  const res = issueMaterialLine(st, {
    passes: [{ lotId: 'LP', qty: 3.00, pin: '', pieces: [goodPiece({ lot: 'OTHER' })] }], picks: []
  });
  assert.ok(res.errors.some(e => e.indexOf('not on the lot it names') >= 0));
  approx(st.env.lotWash.LP, 9.00, 1e-9);
});

test('B14e asking for more of a piece than is on the rack is refused', () => {
  const st = piecesLotState(9.00);
  const res = issueMaterialLine(st, {
    passes: [{ lotId: 'LP', qty: 3.00, pin: '', pieces: [goodPiece({ count: 6, onRack: 5 })] }], picks: []
  });
  assert.ok(res.errors.some(e => e.indexOf('on the rack') >= 0));
  approx(st.env.lotWash.LP, 9.00, 1e-9);
});

test('B14f a DELETED piece is refused — the write loop could not see this case at all', () => {
  // The write-side for-each over Fabric_Piece[ID == x] simply does not run for a
  // missing record, so a deleted piece took the same roll-path fall as a failing
  // one, with no check even attempting to catch it.
  const st = piecesLotState(9.00);
  const res = issueMaterialLine(st, {
    passes: [{ lotId: 'LP', qty: 3.00, pin: '', pieces: [goodPiece({ missing: true })] }], picks: []
  });
  assert.ok(res.errors.some(e => e.indexOf('no longer exists') >= 0));
  approx(st.env.lotWash.LP, 9.00, 1e-9);
});

test('B14g valid pieces still issue exactly as before (no regression from the guard)', () => {
  const st = piecesLotState(9.00);
  const res = issueMaterialLine(st, {
    passes: [{
      lotId: 'LP', qty: 9.00, pin: '',
      pieces: [goodPiece({ id: 'P1' }), goodPiece({ id: 'P2' }), goodPiece({ id: 'P3' })],
    }], picks: []
  });
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(st.rows[0].fromRaw, 30);
  approx(res.lotMoved, 9.00, 0.005);
  approx(st.rows[0].issuedQty, 8.25, 1e-9);
});

test('B15 documented split-lot example closes exactly (100pcs@2/row: 20m + 7.70m)', () => {
  const widthCm = 47.25 * 2.54; // 2/row at 55
  const rows = [{ reqQty: 27.50, issuedQty: 0, reqPieces: 100, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 20.00, L2: 8.00 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, {
    passes: [
      { lotId: 'L1', qty: 20.00, pin: '', pieces: [] },
      { lotId: 'L2', qty: 7.70, pin: '', pieces: [] },
    ], picks: []
  });
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(st.rows[0].fromRaw, 100);
  // Both splits land exactly on row multiples (36 + 14 = 50 rows), so booking
  // closes at exactly the plan estimate; the 20cm tail of L1 stays on the shelf.
  approx(st.rows[0].issuedQty, 27.50, 0.005);
  approx(st.env.lotWash.L1, 0.20, 0.005);
  approx(st.env.lotWash.L2, 0.30, 0.005);
});

test('B16a legacy row WITHOUT width falls back to the metres balance', () => {
  const rows = [{ reqQty: 5.00, issuedQty: 1.00, reqPieces: 0, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: 0, lotWash: { L1: 50 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 6.00, pin: '', pieces: [] }], picks: [] });
  assert.deepStrictEqual(res.errors, []);
  approx(st.rows[0].issuedQty, 4.85);   // balance 4.00 snapped to 7 whole rows
  approx(res.lotMoved, 3.85, 0.005);
});

test('B16b FINDING: legacy reqPieces==0 row WITH valid width issues NOTHING, silently', () => {
  // canPiece (:911-920) tests only cut/width data, never Required_Pieces. A
  // pre-pieces-era row with a recorded width lands in the piece-cap branch,
  // pcsLeft is 0, capQty stays 0 — and the metres balance is never consulted.
  // The screen still SHOWS the metres fallback for such a row, so he presses
  // Issue on a visible requirement and nothing happens with no error.
  const widthCm = 66 * 2.54;
  const rows = [{ reqQty: 5.00, issuedQty: 1.00, reqPieces: 0, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 50 }, lotBlocked: {} } };
  const res = issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 6.00, pin: '', pieces: [] }], picks: [] });
  assert.deepStrictEqual(res.errors, [], 'no error surfaces either');
  approx(st.rows[0].issuedQty, 1.00, 1e-9);
  approx(res.lotMoved, 0.0, 1e-9);
});

test('B17 non-fabric issues the plain balance via its single synthetic pass', () => {
  const rows = [{ reqQty: 10, issuedQty: 2, reqPieces: 0, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: false, srcWanted: 'Plan', cutW: 0, cutL: 0, fabricWidthCm: 0, lotWash: {}, lotBlocked: {} } };
  const res = issueMaterialLine(st, { qty: 8, passes: [], picks: [] });
  approx(st.rows[0].issuedQty, 10);
  approx(res.movedMetres, 8);
});

test('B18 reissue Source isolation: Plan-source issue cannot land on Reissue rows', () => {
  const widthCm = 66 * 2.54;
  const rows = [
    { reqQty: 5.50, issuedQty: 0, reqPieces: 10, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' },
    { reqQty: 2.75, issuedQty: 0, reqPieces: 5, fromWaste: 0, fromRaw: 0, source: 'Reissue', planItemId: 'R', issuedLot: '' },
  ];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 110, fabricWidthCm: 47.25 * 2.54, lotWash: { L1: 50 }, lotBlocked: {} } };
  issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 5.50, pin: '', pieces: [] }], picks: [] });
  approx(st.rows[0].issuedQty, 5.50);
  assert.strictEqual(st.rows[1].issuedQty, 0, 'reissue row untouched by a Plan-source pass');
});

test('B19 lifecycle: three handovers + offcuts close a 37-piece order with mixed sources', () => {
  const widthCm = 47.25 * 2.54; // 2/row at 55cm cut
  const rows = [{ reqQty: 10.45, issuedQty: 0, reqPieces: 37, fromWaste: 0, fromRaw: 0, source: 'Plan', planItemId: 'I', issuedLot: '' }];
  const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: 55, fabricWidthCm: widthCm, lotWash: { L1: 5.00, L2: 5.00 }, lotBlocked: {} } };
  // H1: 5.00m -> 9 rows -> 18 pcs
  issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 5.00, pin: '', pieces: [] }], picks: [] });
  // H2: offcuts cover 5, lot 2.20m asked -> 4 rows -> 8 pcs raw
  issueMaterialLine(st, {
    picks: [{ ok: true, wasteId: 'W1', physicalPcs: 2, yieldPer: 3, pinnedItem: '' }],
    passes: [{ lotId: 'L2', qty: 2.20, pin: '', pieces: [] }],
  });
  // H3: whatever remains (5 pcs -> ceil(5/2)=3 rows -> 1.65)
  issueMaterialLine(st, { passes: [{ lotId: 'L2', qty: 1.65, pin: '', pieces: [] }], picks: [] });
  const r = st.rows[0];
  const total = r.fromWaste + r.fromRaw;
  assert.strictEqual(total, 37, 'closed exactly, got ' + total);
  // 31 fresh pieces need ceil(31/2)=16 rows = 8.80m; the plan's 19-row estimate
  // was for all 37 fresh. Issued_Qty below Required_Qty is correct here.
  approx(r.issuedQty, 8.80, 0.005);
  assert.ok(r.issuedQty <= r.reqQty + 0.005);
});

test('B20 sweep: fan never leaves toFan unspent while any row has room; credits never exceed owed', () => {
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 800; i++) {
    const nRows = 1 + Math.floor(rnd() * 3);
    const widthCm = [113.03, 137.16, 167.64][Math.floor(rnd() * 3)];
    const rows = [];
    const cutL = [45, 55, 110][Math.floor(rnd() * 3)];
    for (let k = 0; k < nRows; k++) {
      const pcs = 1 + Math.floor(rnd() * 60);
      rows.push({
        reqQty: dCeil((pcs * 1.0) / dFloor(widthCm / 55)) * cutL / 100,
        issuedQty: 0, reqPieces: pcs, fromWaste: 0, fromRaw: 0,
        source: 'Plan', planItemId: 'IT' + k, issuedLot: '',
      });
    }
    const st = { rows, env: { isFab: true, srcWanted: 'Plan', cutW: 55, cutL: cutL, fabricWidthCm: widthCm, lotWash: { L1: 1000000 }, lotBlocked: {} } };
    // Ask for everything in one unpinned pass.
    issueMaterialLine(st, { passes: [{ lotId: 'L1', qty: 999999, pin: '', pieces: [] }], picks: [] });
    for (const r of st.rows) {
      const owed = r.reqPieces;
      if (r.fromWaste + r.fromRaw !== owed) throw new Error('row not closed exactly: ' + JSON.stringify(r));
    }
    const sumIssued = st.rows.reduce((a, r) => a + r.issuedQty, 0);
    if (sumIssued > 999999 + 1e-9) throw new Error('moved more than the lot holds');
  }
});

console.log('\n========================================');
console.log('deluge-maths: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}
