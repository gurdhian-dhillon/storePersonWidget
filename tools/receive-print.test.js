#!/usr/bin/env node
// Faithful Node ports of the printed-fabric changes under review:
//
//   screenAgg      deluge/getSupervisorMaterials.dg:444-664
//                  (printedPendByMat deduction, lockstep note join, lot note merge)
//   printedRecv    deluge/receiveMaterials.dg:932-1106
//                  (printed-piece settlement, transit/disputed moves, dispute insert)
//   bulkFan        deluge/receiveMaterials.dg:285-382
//                  (requirement fan, shortBy, parent In_Transit drain)
//   emitOnce       deluge/issueMaterials.dg:1770-1815
//                  (passEmitted guard, PRINTED_PIECE marker into the note)
//
// The ports mirror the .dg files line for line - same guards, same caps, same
// field-for-field dispute shape - so a failure here names a real Deluge line.
// Tests marked GAP-DOC pin down CURRENT behaviour that this review flagged as a
// residual bug, so the suite stays green while the gap is open and flips the
// moment the fix lands.
//
//   usage: node tools/receive-print.test.js

'use strict';
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- Deluge semantics helpers -------------------------------------------------

function ifnullStr(v, dflt) {
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  return s === '' ? dflt : s;
}
function dec(v) { return parseFloat(ifnullStr(v, '0')); }

// ---- PORT: getSupervisorMaterials aggregation ---------------------------------
// mats:   { [materialId]: { pending, name, unit } }   (the `agg` map)
// issues: [{ lines: [{ id, material, qty, settled, note, lot }] }]  newest first
function screenAgg(mats, issues) {
  const printedPendByMat = {};
  const printedCards = [];
  const lineLotByMat = {}, lineQtyByMat = {}, lineNoteByMat = {};
  const lotNotes = {};

  for (const voucher of issues) {
    for (const ln of voucher.lines) {
      const lnMat = String(ln.material == null ? '' : ln.material).trim();
      if (!(lnMat !== '' && mats[lnMat])) continue;
      const lqS = ifnullStr(ln.qty, '0');
      if (!(dec(lqS) > 0)) continue;
      const lnNote = ifnullStr(ln.note, '');
      if (lnNote.indexOf('PRINTED_PIECE') >= 0) {
        const pcPend = dec(lqS) - dec(ifnullStr(ln.settled, '0'));
        printedPendByMat[lnMat] = (printedPendByMat[lnMat] || 0) + pcPend;
        if (pcPend > 0) printedCards.push({ materialId: lnMat, qty: dec(lqS), pending: pcPend });
      } else {
        let prevL = lineLotByMat[lnMat] || '';
        let prevQ = lineQtyByMat[lnMat] || '';
        let prevN = lineNoteByMat[lnMat] || '';
        if (prevL !== '') { prevL += '~'; prevQ += '~'; prevN += '~'; }
        lineLotByMat[lnMat] = prevL + String(ln.lot == null ? '' : ln.lot).trim();
        lineQtyByMat[lnMat] = prevQ + lqS;
        lineNoteByMat[lnMat] = prevN + lnNote;
      }
    }
  }

  const out = [];
  for (const k of Object.keys(mats)) {
    const e = mats[k];
    const adjPending = e.pending - (printedPendByMat[k] || 0);
    if (adjPending <= 0) continue;

    let leftToName = adjPending;
    const lotSeen = [];
    const lotQty = {};
    const lotTxt = lineLotByMat[k] || '';
    const qtyTxt = lineQtyByMat[k] || '';
    const noteTxt = lineNoteByMat[k] || '';
    if (lotTxt !== '') {
      const lotParts = lotTxt.split('~');
      const qtyParts = qtyTxt.split('~');
      const noteParts = noteTxt.split('~');
      qtyParts.forEach((qPart, idxN) => {
        if (leftToName > 0) {
          let takeHere = dec(qPart);
          if (takeHere > leftToName) takeHere = leftToName;
          if (takeHere > 0) {
            let thisLot = String(lotParts[idxN]);
            if (thisLot === '') thisLot = 'none';
            if (lotSeen.indexOf(thisLot) < 0) { lotSeen.push(thisLot); lotQty[thisLot] = 0; lotNotes[thisLot] = ''; }
            lotQty[thisLot] += takeHere;
            const thisNote = ifnullStr(noteParts[idxN], '');
            if (thisNote !== '') {
              let haveNote = lotNotes[thisLot] || '';
              if (haveNote !== '' && haveNote.indexOf(thisNote) < 0) haveNote += ', ';
              if (haveNote.indexOf(thisNote) < 0) lotNotes[thisLot] = haveNote + thisNote;
            }
            leftToName -= takeHere;
          }
        }
      });
    }
    const lotsJson = lotSeen.map(lotKey => {
      let label = lotKey;
      const nTxt = lotNotes[lotKey] || '';
      if (nTxt !== '') label = label + ' (' + nTxt + ')';
      return JSON.parse('{"lot":"' + label.replaceAll('"', "'") + '","qty":' + lotQty[lotKey] + '}');
    });
    // Line 663 prints the GROSS pending, not adjPending - load-bearing for GAP A2.
    out.push({ materialId: k, pending: e.pending, lots: lotsJson });
  }
  return { materials: out, printedPieces: printedCards };
}

// ---- PORT: receiveMaterials bulk fan + printed settlement ---------------------
function makeWorld() {
  return {
    reqs: {},          // id -> {id, plan, material, issued, received}
    parent: {},        // materialId -> {inTransit, disputed}
    lots: {},          // lotId -> {inTransit, disputed}
    disputes: [],
    errors: [],
  };
}
function addReq(w, r) { w.reqs[r.id] = r; return w.reqs[r.id]; }
function addParent(w, id, inTransit) { w.parent[id] = { inTransit: inTransit, disputed: 0 }; }
function addLot(w, id, inTransit) { w.lots[id] = { inTransit: inTransit, disputed: 0 }; }

// deluge/receiveMaterials.dg:285-382 - one mats[] line against all requirement rows.
function bulkReceive(w, matId, gotQty, plansInOrder, reqsByPlan) {
  let toFan = gotQty, pendingTotal = 0;
  const shortPerPlan = {};
  for (const planId of plansInOrder) {
    for (const row of reqsByPlan[planId] || []) {
      if (String(row.material) !== String(matId)) continue;
      const rowPend = row.issued - row.received;
      if (rowPend <= 0) continue;
      pendingTotal += rowPend;
      let give = 0;
      if (toFan > 0) { give = Math.min(toFan, rowPend); row.received += give; toFan -= give; }
      if (rowPend - give > 0) shortPerPlan[planId] = (shortPerPlan[planId] || 0) + (rowPend - give);
    }
  }
  let shortBy = pendingTotal - gotQty;
  if (shortBy < 0) shortBy = 0;
  const p = w.parent[matId];
  if (pendingTotal > 0 && p) {
    let settleQty = Math.min(pendingTotal, p.inTransit);
    p.inTransit -= settleQty;
    if (shortBy > 0) p.disputed += shortBy;
  }
  for (const planId of Object.keys(shortPerPlan)) {
    w.disputes.push({ src: 'bulk', plan: planId, disputed: shortPerPlan[planId] });
  }
  return { pendingTotal, shortBy };
}

// deluge/receiveMaterials.dg:932-1106 - one printedPieces[] entry.
function printedReceive(w, issues, p) {
  for (const voucher of issues) {
    for (const ln of voucher.lines) {
      if (String(ln.id) !== String(p.issueLineId)) continue;
      const lnRemain = dec(ln.qty) - dec(ifnullStr(ln.settled, '0'));
      let takeP = p.received;
      if (takeP > lnRemain) takeP = lnRemain;
      ln.settled = dec(ln.settled) + takeP;
      const stillOutP = lnRemain - takeP;

      if (ln.req != null) w.reqs[ln.req].received += takeP;

      const mat = w.parent[String(ln.material)];
      if (mat) {
        mat.inTransit -= lnRemain;                       // uncapped, faithful to :986
        if (stillOutP > 0) mat.disputed += stillOutP;
      }
      const lot = w.lots[String(ln.lot)];
      if (lot) {
        lot.inTransit -= lnRemain;                       // uncapped, faithful to :1010
        if (stillOutP > 0) lot.disputed += stillOutP;
      }
      if (stillOutP > 0) {
        // Field-for-field what :1054-1067 inserts; both dispute screens read
        // exactly these (getStoreDisputes.dg:226 / getSupervisorDisputes.dg:222).
        w.disputes.push({
          src: 'printed', line: ln.id,
          materialName: '(resolved from Raw_Material)', unit: 'Mtr',
          direction: 'Outbound', issued: lnRemain, received: takeP,
          disputed: stillOutP, status: 'Open',
        });
      }
      return { found: true, stillOutP };
    }
  }
  return { found: false };
}

// ---- PORT: issueMaterials emit-once -------------------------------------------
// rows:   [{id, passId}] in fan order (Issued_Qty credit happens before emission)
// passes: { [passId]: {tokens:"p:n:cm,...", cutSumm, note, lot} }
function emitOnce(rows, passes) {
  const emitted = {};
  const lines = [];
  for (const row of rows) {
    const p = passes[row.passId];
    if (!p) continue;
    if (p.cutSumm !== '' && p.tokens !== '') {
      if (emitted[row.passId] == null) {
        emitted[row.passId] = true;
        for (const tok of p.tokens.split(',')) {
          const bits = tok.trim().split(':');
          if (bits.length >= 3) {
            const mtr = (parseFloat(bits[2]) * parseFloat(bits[1])) / 100;
            let baseNote = p.note || '';
            if (baseNote !== '') baseNote += ' | ';
            lines.push({ req: row.id, lot: p.lot, qty: mtr, note: baseNote + 'PRINTED_PIECE | ' + p.cutSumm });
          }
        }
      }
    } else {
      lines.push({ req: row.id, lot: p.lot, qty: row.give, note: p.note });
    }
  }
  return lines;
}

// ---- fixtures ------------------------------------------------------------------

function fixtureMixed() {
  // Material M across two plans: plan P1 was issued as printed pieces (4 m on
  // line L1), plan P2 as an ordinary roll handover (6 m on line L2). Newest
  // voucher first, matching `sort by Added_Time desc`.
  const w = makeWorld();
  const r1 = addReq(w, { id: 'R1', plan: 'P1', material: 'M', issued: 4, received: 0 });
  const r2 = addReq(w, { id: 'R2', plan: 'P2', material: 'M', issued: 6, received: 0 });
  addParent(w, 'M', 10);
  addLot(w, 'LOT9', 10);
  const issues = [
    { lines: [
      { id: 'L1', material: 'M', qty: 4, settled: 0, note: 'PRINTED_PIECE | 4 pcs x 100 cm', lot: 'LOT9', req: 'R1' },
      { id: 'L2', material: 'M', qty: 6, settled: 0, note: '', lot: 'LOT9', req: 'R2' },
    ] },
  ];
  return { w, r1, r2, issues };
}

// ---- tests ---------------------------------------------------------------------

console.log('receive-print\n');

// Screen: the deduction the fix introduced.

test('S1 pure-printed material drops out of materials[] and shows once per piece line', () => {
  const r = screenAgg(
    { M: { pending: 5, name: 'Printed twill', unit: 'Mtr' } },
    [{ lines: [
      { id: 'A', material: 'M', qty: 3, settled: 0, note: 'PRINTED_PIECE | x', lot: '9', req: 'R1' },
      { id: 'B', material: 'M', qty: 2, settled: 0, note: 'PRINTED_PIECE | y', lot: '9', req: 'R1' },
    ] }]);
  assert.strictEqual(r.materials.length, 0);
  assert.strictEqual(r.printedPieces.length, 2);
});

test('S2 mixed material keeps its aggregate at gross minus printed pending', () => {
  const { issues } = fixtureMixed();
  const r = screenAgg({ M: { pending: 10, name: 'M', unit: 'Mtr' } }, issues);
  assert.strictEqual(r.materials.length, 1);
  assert.strictEqual(r.printedPieces.length, 1);
  assert.strictEqual(r.printedPieces[0].pending, 4);
  // Header prints GROSS (dg line 663) while the lots only cover the roll part.
  assert.strictEqual(r.materials[0].pending, 10);
  const lotSum = r.materials[0].lots.reduce((a, l) => a + l.qty, 0);
  assert.strictEqual(lotSum, 6);
});

test('S3 a fully-settled piece line deducts nothing further from the aggregate', () => {
  const r = screenAgg(
    { M: { pending: 6, name: 'M', unit: 'Mtr' } },
    [{ lines: [
      { id: 'A', material: 'M', qty: 4, settled: 4, note: 'PRINTED_PIECE | x', lot: '9', req: 'R1' },
      { id: 'B', material: 'M', qty: 6, settled: 0, note: '', lot: '9', req: 'R2' },
    ] }]);
  assert.strictEqual(r.materials.length, 1);
  assert.strictEqual(r.printedPieces.length, 0);
  assert.strictEqual(r.materials[0].lots[0].qty, 6);
});

test('S4 a partially-settled piece line deducts only its remainder', () => {
  const r = screenAgg(
    { M: { pending: 8, name: 'M', unit: 'Mtr' } },
    [{ lines: [
      { id: 'A', material: 'M', qty: 4, settled: 1.5, note: 'PRINTED_PIECE | x', lot: '9', req: 'R1' },
      { id: 'B', material: 'M', qty: 6, settled: 0, note: '', lot: '9', req: 'R2' },
    ] }]);
  assert.strictEqual(r.materials.length, 1);
  assert.strictEqual(r.printedPieces[0].pending, 2.5);
  const lotSum = r.materials[0].lots.reduce((a, l) => a + l.qty, 0);
  assert.ok(Math.abs(lotSum - 5.5) < 1e-9);
});

// Screen: the new lot-note plumbing.

test('S5 regular-line notes ride in lockstep and land on their own lot', () => {
  const r = screenAgg(
    { M: { pending: 12, name: 'M', unit: 'Mtr' } },
    [{ lines: [
      { id: 'B', material: 'M', qty: 7, settled: 0, note: 'shade check ok', lot: '22', req: 'R2' },
      { id: 'A', material: 'M', qty: 5, settled: 0, note: 'from override', lot: '11', req: 'R1' },
    ] }]);
  const lots = r.materials[0].lots;
  const big = lots.find(l => l.qty === 7);
  const small = lots.find(l => l.qty === 5);
  assert.strictEqual(big.lot, '22 (shade check ok)');
  assert.strictEqual(small.lot, '11 (from override)');
});

test('S6 same note twice merges once, distinct notes join with a comma', () => {
  const r = screenAgg(
    { M: { pending: 10, name: 'M', unit: 'Mtr' } },
    [{ lines: [
      { id: 'B', material: 'M', qty: 5, settled: 0, note: 'tail piece', lot: '22', req: 'R1' },
      { id: 'C', material: 'M', qty: 5, settled: 0, note: 'tail piece', lot: '22', req: 'R2' },
    ] }]);
  assert.strictEqual(r.materials[0].lots[0].lot, '22 (tail piece)');

  const r2 = screenAgg(
    { M: { pending: 10, name: 'M', unit: 'Mtr' } },
    [{ lines: [
      { id: 'B', material: 'M', qty: 5, settled: 0, note: 'tail piece', lot: '22', req: 'R1' },
      { id: 'C', material: 'M', qty: 5, settled: 0, note: 'override L1 to L2', lot: '22', req: 'R2' },
    ] }]);
  assert.strictEqual(r2.materials[0].lots[0].lot, '22 (tail piece, override L1 to L2)');
});

test('GAP-DOC S7 quote-only escaping: a typed quote survives, a typed newline breaks JSON.parse', () => {
  const mk = note => screenAgg(
    { M: { pending: 6, name: 'M', unit: 'Mtr' } },
    [{ lines: [{ id: 'B', material: 'M', qty: 6, settled: 0, note, lot: '22', req: 'R1' }] }]
  ).materials[0].lots[0].lot;
  // Quotes are handled - the store typed one and the tab lived.
  assert.doesNotThrow(() => JSON.parse('{"lot":"' + mk('checked "against" cover') + '"}'));
  // Lot_Override_Note comes from a <textarea> (app/js/main.js:174), so Enter is
  // realistic; dg line 656 escapes quotes only, so this is invalid JSON.
  assert.throws(() => JSON.parse('{"lot":"' + mk('line one\nline two') + '"}'));
});

// Receive: the printed-piece settlement.

test('R1 exact receipt zeroes transit on BOTH parent and lot, no dispute', () => {
  const { w, issues } = fixtureMixed();
  printedReceive(w, issues, { issueLineId: 'L1', received: 4 });
  assert.strictEqual(w.parent.M.inTransit, 6);
  assert.strictEqual(w.lots.LOT9.inTransit, 6);
  assert.strictEqual(w.parent.M.disputed, 0);
  assert.strictEqual(w.disputes.length, 0);
  assert.strictEqual(w.reqs.R1.received, 4);
});

test('R2 partial receipt disputes only the remainder, with the field set both screens read', () => {
  const { w, issues } = fixtureMixed();
  printedReceive(w, issues, { issueLineId: 'L1', received: 2.5 });
  const d = w.disputes[0];
  assert.strictEqual(d.direction, 'Outbound');
  assert.strictEqual(d.status, 'Open');
  assert.strictEqual(d.issued, 4);
  assert.strictEqual(d.received, 2.5);
  assert.strictEqual(d.disputed, 1.5);
  assert.strictEqual(w.parent.M.disputed, 1.5);
  assert.strictEqual(w.lots.LOT9.disputed, 1.5);
  assert.strictEqual(w.reqs.R1.received, 2.5);
});

test('R3 resubmitting a fully-received piece is a no-op (Settled_Qty is the idempotency)', () => {
  const { w, issues } = fixtureMixed();
  printedReceive(w, issues, { issueLineId: 'L1', received: 4 });
  const before = { t: w.parent.M.inTransit, d: w.parent.M.disputed, n: w.disputes.length };
  printedReceive(w, issues, { issueLineId: 'L1', received: 4 });
  assert.strictEqual(w.parent.M.inTransit, before.t);
  assert.strictEqual(w.parent.M.disputed, before.d);
  assert.strictEqual(w.disputes.length, before.n);
});

test('R4 over-receipt caps at the outstanding metres and never invents stock', () => {
  const { w, issues } = fixtureMixed();
  printedReceive(w, issues, { issueLineId: 'L1', received: 99 });
  assert.strictEqual(w.parent.M.inTransit, 6);
  assert.strictEqual(w.parent.M.disputed, 0);
  assert.strictEqual(w.disputes.length, 0);
});

test('GAP-DOC R5 mixed material, he types what the rolls show: a spurious dispute fires for cloth his printed receipt is about to bring', () => {
  const { w, r1, r2, issues } = fixtureMixed();
  // Screen shows aggregate 6 (rolls only) plus the printed card 4. He confirms
  // both halves correctly - bulk first, then the printed pieces.
  bulkReceive(w, 'M', 6, ['P1', 'P2'], { P1: [r1], P2: [r2] });
  assert.strictEqual(w.disputes.filter(d => d.src === 'bulk').length, 1);
  assert.strictEqual(w.disputes[0].disputed, 4);   // the printed metres, not missing
  printedReceive(w, issues, { issueLineId: 'L1', received: 4 });   // they arrive
  // ...and the dispute stays Open over cloth that physically arrived, while
  // transit was drained twice: bulk settled the GROSS pendingTotal (10, dg:414)
  // and the piece receipt drained its lnRemain (4) again.
  assert.strictEqual(w.parent.M.inTransit, -4);
  assert.strictEqual(w.reqs.R1.received + w.reqs.R2.received, 10);
});

test('GAP-DOC R6 the default flow instead over-credits the requirement and drives parent transit negative', () => {
  const { w, r1, r2, issues } = fixtureMixed();
  // Widget defaults every input to its shown pending: materials row = GROSS 10
  // (dg line 663), printed card = 4. Pressing "All received as listed" sends both.
  bulkReceive(w, 'M', 10, ['P1', 'P2'], { P1: [r1], P2: [r2] });
  printedReceive(w, issues, { issueLineId: 'L1', received: 4 });
  assert.strictEqual(w.reqs.R1.received, 8);         // credited twice: 4 by fan, 4 by piece
  assert.ok(w.reqs.R1.received > w.reqs.R1.issued);
  assert.ok(w.parent.M.inTransit < 0);               // 10 drained by bulk, 4 again by piece
  assert.strictEqual(w.parent.M.inTransit, -4);
});

// Issue: the emit-once guard.

test('E1 a pass fanned across two rows emits ONE set of piece lines, stamped to the first row', () => {
  const lines = emitOnce(
    [{ id: 'R1', passId: 'K1' }, { id: 'R2', passId: 'K1' }],
    { K1: { tokens: 'P1:1:300,P2:2:300', cutSumm: '2 cuts x 300 cm', note: 'tone L9', lot: '9' } });
  assert.strictEqual(lines.length, 2);
  lines.forEach(l => { assert.strictEqual(l.req, 'R1'); });
  const metres = lines.reduce((a, l) => a + l.qty, 0);
  assert.ok(Math.abs(metres - ((300 * 1 + 300 * 2) / 100)) < 1e-9);
});

test('E2 two distinct passes each emit their own set; every note carries the marker and no cutSummary key remains', () => {
  const lines = emitOnce(
    [{ id: 'R1', passId: 'K1' }, { id: 'R2', passId: 'K2' }, { id: 'R3', passId: 'K1' }],
    {
      K1: { tokens: 'P1:1:300', cutSumm: '1 cut x 300 cm', note: '', lot: '9' },
      K2: { tokens: 'Q1:2:200', cutSumm: '2 cuts x 200 cm', note: 'from remnant', lot: '10' },
    });
  assert.strictEqual(lines.length, 2);
  const k1 = lines.find(l => l.lot === '9');
  const k2 = lines.find(l => l.lot === '10');
  assert.strictEqual(k1.note, 'PRINTED_PIECE | 1 cut x 300 cm');       // marker guaranteed even with no base note
  assert.strictEqual(k2.note, 'from remnant | PRINTED_PIECE | 2 cuts x 200 cm');
  assert.ok(lines.every(l => !Object.prototype.hasOwnProperty.call(l, 'cutSummary')));
});

test('E3 legacy whole-piece spec (no cut length) falls back to the ordinary single line', () => {
  const lines = emitOnce([{ id: 'R1', passId: 'K1', give: 3.5 }],
    { K1: { tokens: '', cutSumm: '', note: '', lot: '9' } });
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].qty, 3.5);
  assert.strictEqual(lines[0].note, '');
});

// ---- summary -------------------------------------------------------------------

console.log('\n========================================');
console.log('receive-print: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}
