#!/usr/bin/env node
// REGRESSION GUARD for the seven allocator defects found in the store-issue
// audit and fixed in app/js/lot-allocator.js (+ two call sites in main.js).
//
// Each block names the defect it locks down. They are the failure modes that put
// the WRONG CLOTH out of the door or told the store person something untrue
// about a rack he is standing in front of, so none of them may come back
// quietly:
//
//   1  an override pointing at a BLOCKED lot was honoured — quarantined cloth
//      issued, row reading as fully served
//   2  a metres edit-up was capped at the roll's length in the RAW payload, so
//      two cards could each be extended into the same metres
//   3  a hand-typed figure was erased by any re-allocation while its input box
//      went on displaying it
//   4  a roll with Roll_Status "Blocked" was cut like any other
//   5  an edit-down across a multi-line lot lost a whole marker row per line
//   6  a pinned lot that part-covered had no reason of its own and fell through
//      to "None of this shade left"
//   7  an order covered ENTIRELY by offcuts recorded no lot, leaving its remake
//      free to be cut in any shade
//
// Plus the two misleading-sentence fixes (`nofit` capped by what may actually be
// spent; `atWash` reachable for a skipped order) and the waste-loop guard.
//
//   usage: node tools/allocator-audit-fixes.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}
// deepStrictEqual is useless across the vm realm — an array built inside the
// sandbox has a different Array.prototype and fails "reference-equal" on values
// that are identical. Compare the shape as text.
function same(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error((msg || '') + ' expected ' + B + ', got ' + A);
}
function approx(a, b, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + '+/-' + eps + ', got ' + a);
}

// A FRESH ALLOCATOR PER TEST. lotOverrides and wasteDeclined are session stores
// and would otherwise leak between cases — which is the whole reason the metres
// edits were moved OFF a store of that shape and onto the material.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const EXPORTS = '\nthis.A = { round2, remnantYield, perRowFor, rollUsable, lotFill, chooseLotForOrder,' +
  ' orderMetres, applyLotAllocation, applyFabricOverride, shortReasonFor, usableLots,' +
  ' overrideKey: overrideKey, lotOverrides: lotOverrides, wasteDeclined: wasteDeclined };';
function load() {
  const ctx = { console, Math, Number, Object, String, Array, JSON };
  vm.createContext(ctx);
  vm.runInContext(SRC + EXPORTS, ctx);
  return ctx.A;
}

// ---- fixture builders ----------------------------------------------------------
let rollSeq = 0;
function roll(length, label, status) {
  rollSeq += 1;
  return { rollId: 'R' + rollSeq, label: label || ('RL' + rollSeq), length: length,
           status: status || 'Available', origin: 'Purchased' };
}
function lot(o) {
  return { lotId: o.id, lotNumber: o.no || o.id, blocked: !!o.blocked,
           wash: o.wash || 0, unwash: o.unwash || 0, inWash: o.inWash || 0,
           form: 'Roll', pieces: [], rolls: o.rolls || [] };
}
function line(o) {
  return { planId: o.plan, planItemId: o.item || (o.plan + '-i1'),
           mrqId: o.mrq || (o.plan + '-m1'), cutW: o.cutW, cutL: o.cutL,
           reqPieces: o.req, issPieces: o.iss || 0,
           issuedLot: o.pin || '', issuedLotNo: o.pinNo || o.pin || '' };
}
function mat(o) {
  return { materialId: o.id || 'M1', isFabric: true, fabricWidthCm: o.width || 100,
           lots: o.lots || [], wasteStock: o.waste || [], lines: o.lines || [],
           cuts: o.cuts || [], freshMeters: o.freshMeters || 0,
           printBase: '', printBaseName: '', printBaseLots: [] };
}
function sup(id, mats) { return { supervisorId: id, materials: mats }; }
function total(m) { return (m.lotLines || []).reduce((t, l) => t + (Number(l.qty) || 0), 0); }

console.log('\n=== 1. an override to a BLOCKED lot is refused ===');

test('1a blocked override issues nothing and keeps the override button', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'LD', no: 'LD' }),
           lot({ id: 'LB', no: 'LB', blocked: true, wash: 50, rolls: [roll(50)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 5, pin: 'LD' })] })])];
  A.lotOverrides[A.overrideKey('S1', 'M1', 'P1')] = { lotId: 'LB', note: 'go' };
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  assert.strictEqual(m.lotLines.length, 0, 'quarantined cloth must not be issued');
  assert.strictEqual(m.shortReason.kind, 'pinnedDry');
  assert.strictEqual(m.shortReason.refused, 'LB', 'the row must name the lot it refused');
  same(m.pinnedDryOrders, ['P1'], 'the dialog must still be offered:');
});

test('1b an override to a lot that is merely DRY is refused the same way', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'LD', no: 'LD' }), lot({ id: 'LE', no: 'LE' })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 5, pin: 'LD' })] })])];
  A.lotOverrides[A.overrideKey('S1', 'M1', 'P1')] = { lotId: 'LE', note: 'go' };
  A.applyLotAllocation(d);
  assert.strictEqual(d[0].materials[0].shortReason.refused, 'LE');
});

test('1c a GOOD override still rescues the order, and stops saying pinnedDry', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'LD', no: 'LD' }),
           lot({ id: 'LN', no: 'LN', wash: 3, rolls: [roll(3)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10, pin: 'LD' })] })])];
  A.lotOverrides[A.overrideKey('S1', 'M1', 'P1')] = { lotId: 'LN', note: 'ok' };
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  approx(total(m), 3);
  assert.strictEqual(m.lotLines[0].lotNumber, 'LN');
  assert.strictEqual(m.pinnedDry, '', 'the dead lot must not be named once the substitute took');
  assert.strictEqual(m.shortReason.kind, 'pinnedShort');
  assert.strictEqual(m.shortReason.canOverride, true,
    'he must still be able to revise a substitute that only part-covers');
  same(m.pinnedDryOrders, ['P1'], 'the dialog needs the orders to write against:');
});

console.log('\n=== 2. a metres edit cannot re-promise another card\'s cloth ===');

test('2a two cards on one roll: the edit-up stops at what is free', () => {
  const A = load();
  const mk = () => [lot({ id: 'L1', wash: 20,
    rolls: [{ rollId: 'R1', label: 'A', length: 20, status: 'Available' }] })];
  const d = [
    sup('S1', [mat({ id: 'M1', lots: mk(), lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 5 })] })]),
    sup('S2', [mat({ id: 'M1', lots: mk(), lines: [line({ plan: 'P2', cutW: 100, cutL: 100, req: 5 })] })])
  ];
  A.applyLotAllocation(d);
  const a = d[0].materials[0], b = d[1].materials[0];
  approx(total(a), 5); approx(total(b), 5);
  A.applyFabricOverride(b, 'L1', 20);            // S2 asks for the whole roll
  approx(total(b), 15, 0.005);                   // 20 minus the 5 S1 holds
  assert.ok(total(a) + total(b) <= 20.005,
    'two cards issued ' + (total(a) + total(b)) + ' m off a 20 m roll');
});

test('2b the clamp is recorded so the screen can say so', () => {
  const A = load();
  const d = [sup('S1', [mat({ lots: [lot({ id: 'L1', wash: 11, rolls: [roll(11)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 5 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  A.applyFabricOverride(m, 'L1', 50);
  approx(total(m), 11);
  assert.ok(m.lotEditShort && m.lotEditShort.L1, 'the clamp must be reported');
  approx(m.lotEditShort.L1.typed, 50);
  approx(m.lotEditShort.L1.placed, 11);
});

console.log('\n=== 3. a hand-typed figure survives a re-allocation ===');

test('2c rollFree is keyed lot|roll, so two lots cannot collapse into one entry', () => {
  const A = load();
  // Creator ids are unique, but the label-derived ids the seed writer and these
  // fixtures use are not. A collision made a drained lot read at full length,
  // which UNDER-clamps the ceiling: the unsafe direction.
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'L1', no: 'L1', wash: 10,
      rolls: [{ rollId: 'R1', label: 'L1-R1', length: 10, status: 'Available' }] }),
           lot({ id: 'L2', no: 'L2', wash: 10,
      rolls: [{ rollId: 'R1', label: 'L2-R1', length: 10, status: 'Available' }] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 4 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  assert.strictEqual(Object.keys(m.rollFree).length, 2, 'two rolls, two entries');
  approx(m.rollFree['L1|R1'], 6);   // 10 less the 4 this order took
  approx(m.rollFree['L2|R1'], 10);
});

// A Plan row and a Reissue row are TWO entries of ONE material, and they share
// the rack. Every case below is about that pair.
function twoRowMaterial(A) {
  const mk = () => [lot({ id: 'L1', wash: 20,
    rolls: [{ rollId: 'R1', label: 'A', length: 20, status: 'Available' }] })];
  const a = mat({ id: 'M1', lots: mk(),
    lines: [line({ plan: 'P1', mrq: 'Q1', cutW: 100, cutL: 100, req: 4 })] });
  const b = mat({ id: 'M1', lots: mk(),
    lines: [line({ plan: 'P2', mrq: 'Q2', cutW: 100, cutL: 100, req: 4 })] });
  const d = [sup('S1', [a, b])];
  A.applyLotAllocation(d);
  return { d, a, b };
}

test('2d two rows of one material cannot both extend into the same free metres', () => {
  const A = load();
  const { a, b } = twoRowMaterial(A);
  A.applyFabricOverride(a, 'L1', 20);
  A.applyFabricOverride(b, 'L1', 20);
  approx(total(a), 16, 0.005);      // its own 4 plus the 12 nobody held
  approx(total(b), 4, 0.005);       // only its own
  assert.ok(total(a) + total(b) <= 20.005,
    'two rows issued ' + (total(a) + total(b)) + ' m off a 20 m roll');
});

test('2e a burst of keystrokes does not ratchet the shared ledger down', () => {
  const A = load();
  const { a, b } = twoRowMaterial(A);
  [2, 20, 2, 15, 1, 12].forEach((v) => A.applyFabricOverride(a, 'L1', v));
  A.applyFabricOverride(a, 'L1', 20);
  approx(total(a), 16, 0.005);
  approx(total(a) + total(b), 20, 0.005);
});

test('2f an edit DOWN hands the metres back to the other row', () => {
  const A = load();
  const { a, b } = twoRowMaterial(A);
  A.applyFabricOverride(a, 'L1', 16);
  A.applyFabricOverride(b, 'L1', 20);
  approx(total(b), 4, 0.005);
  A.applyFabricOverride(a, 'L1', 4);
  A.applyFabricOverride(b, 'L1', 20);
  approx(total(b), 16, 0.005);
  assert.ok(total(a) + total(b) <= 20.005);
});

test('2g re-allocating twice re-applies each edit once, not twice', () => {
  const A = load();
  const { d, a, b } = twoRowMaterial(A);
  A.applyFabricOverride(a, 'L1', 16);
  A.applyLotAllocation(d);
  A.applyLotAllocation(d);
  approx(total(a), 16, 0.005);
  approx(total(b), 4, 0.005);
});

test('3a re-running the allocation keeps the edit and the edited flag', () => {
  const A = load();
  const d = [sup('S1', [mat({ lots: [lot({ id: 'L1', wash: 100, rolls: [roll(100)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  A.applyFabricOverride(m, 'L1', 6);
  approx(total(m), 6);
  A.applyLotAllocation(d);                       // e.g. a remnant ticked elsewhere
  approx(total(m), 6, 0.005);
  assert.strictEqual(m.metresEdited, true);
});

test('3b putting the lot back to auto forgets the edit for good', () => {
  const A = load();
  const d = [sup('S1', [mat({ lots: [lot({ id: 'L1', wash: 100, rolls: [roll(100)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  A.applyFabricOverride(m, 'L1', 6);
  A.applyFabricOverride(m, 'L1', m.autoMetres);
  A.applyLotAllocation(d);
  approx(total(m), 10, 0.005);
  assert.strictEqual(m.metresEdited, false);
});

test('3c a fresh payload carries no edit — the store lives on the material', () => {
  const A = load();
  const build = () => [sup('S1', [mat({ lots: [lot({ id: 'L1', wash: 100, rolls: [roll(100)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10 })] })])];
  const d1 = build();
  A.applyLotAllocation(d1);
  A.applyFabricOverride(d1[0].materials[0], 'L1', 6);
  const d2 = build();                            // what a Refresh produces
  A.applyLotAllocation(d2);
  approx(total(d2[0].materials[0]), 10, 0.005);
});

console.log('\n=== 4. a Blocked roll is not cloth ===');

test('4a lotFill yields nothing off a Blocked roll', () => {
  const A = load();
  const f = A.lotFill({ wash: 10, unwash: 0, inWash: 0, waste: [],
    rolls: [{ rollId: 'R1', label: 'A', length: 10, status: 'Blocked' }] },
    [{ cutW: 100, cutL: 100, pieces: 4 }], { fabricWidthCm: 100 }, false);
  assert.strictEqual(f.covers, false);
  approx(f.freshMetres, 0);
  assert.strictEqual(A.rollUsable({ length: 10, status: 'Blocked' }), false);
  assert.strictEqual(A.rollUsable({ length: 10, status: 'Consumed' }), false);
  assert.strictEqual(A.rollUsable({ length: 10 }), true);
});

test('4b the whole allocation refuses it too, and does not quote it back', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'L1', no: 'L1', wash: 10,
      rolls: [{ rollId: 'RB', label: 'RB', length: 10, status: 'Blocked' }] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 4 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  assert.strictEqual(m.lotLines.length, 0, 'a Blocked roll was cut');
  assert.notStrictEqual(m.shortReason.kind, 'nofit',
    'a roll the allocation refuses must not be quoted as cloth he could have');
});

console.log('\n=== 5. an edit-down keeps whole marker rows ===');

test('5a 9 m of a 1 m cut across two lines credits 9 pieces, not 8', () => {
  const A = load();
  const d = [sup('S1', [mat({ lots: [lot({ id: 'L1', wash: 100, rolls: [roll(100)] })],
    lines: [line({ plan: 'P1', item: 'I1', mrq: 'Q1', cutW: 100, cutL: 100, req: 5 }),
            line({ plan: 'P1', item: 'I2', mrq: 'Q2', cutW: 100, cutL: 100, req: 5 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  A.applyFabricOverride(m, 'L1', 9);
  approx(total(m), 9, 0.005);
  assert.strictEqual(m.lotLines.reduce((t, l) => t + l.fromRaw, 0), 9);
});

test('5b no line is credited past its own outstanding pieces', () => {
  const A = load();
  const d = [sup('S1', [mat({ lots: [lot({ id: 'L1', wash: 100, rolls: [roll(100)] })],
    lines: [line({ plan: 'P1', item: 'I1', mrq: 'Q1', cutW: 100, cutL: 100, req: 3 }),
            line({ plan: 'P1', item: 'I2', mrq: 'Q2', cutW: 100, cutL: 100, req: 7 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  A.applyFabricOverride(m, 'L1', 20);            // deliberate over-issue
  const byQ = {};
  m.lotLines.forEach((l) => { byQ[l.mrqId] = l.fromRaw; });
  assert.ok(byQ.Q1 <= 3, 'Q1 credited ' + byQ.Q1 + ' of 3 owed');
  assert.ok(byQ.Q2 <= 7, 'Q2 credited ' + byQ.Q2 + ' of 7 owed');
});

test('5c a stray part-row is still charged to the lot and credits nothing', () => {
  const A = load();
  const d = [sup('S1', [mat({ lots: [lot({ id: 'L1', wash: 100, rolls: [roll(100)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  A.applyFabricOverride(m, 'L1', 6.4);
  approx(total(m), 6.4, 0.005);
  assert.strictEqual(m.lotLines[0].fromRaw, 6, 'the 0.4 is cloth, not a piece');
});

console.log('\n=== 6. a pinned lot that part-covers says so ===');

test('6a pinnedShort, not "none of this shade left"', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'L1', no: 'L1', wash: 1, rolls: [roll(1)] }),
           lot({ id: 'L2', no: 'L2', wash: 100, rolls: [roll(100)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10, pin: 'L1' })] })])];
  A.applyLotAllocation(d);
  const r = d[0].materials[0].shortReason;
  assert.strictEqual(r.kind, 'pinnedShort');
  same(r.lots, [{ lotNumber: 'L1', pieces: 9 }]);
  assert.strictEqual(r.canOverride, false,
    'an ordinary pinned row must NOT be offered a tone switch');
});

test('6b greige on the pinned lot still wins — that one has a button', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'L1', no: 'L1', wash: 1, unwash: 20, rolls: [roll(21)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10, pin: 'L1' })] })])];
  A.applyLotAllocation(d);
  assert.strictEqual(d[0].materials[0].shortReason.kind, 'wash');
});

console.log('\n=== 7. an offcut-only order still records its tone ===');

test('6c an order spanning two rows splits its shortfall between them', () => {
  const A = load();
  // A Plan row and a Reissue row of one material, both serving plan P1.
  // useFill.shortBy is the ORDER total, so stamping it on each row said 38
  // short twice over an order that is 38 short once.
  const mk = () => [lot({ id: 'L1', no: 'L1', wash: 2, rolls: [roll(2)] })];
  const a = mat({ id: 'M1', lots: mk(),
    lines: [line({ plan: 'P1', item: 'I1', mrq: 'Q1', cutW: 100, cutL: 100, req: 20, pin: 'L1' })] });
  const b = mat({ id: 'M1', lots: mk(),
    lines: [line({ plan: 'P1', item: 'I2', mrq: 'Q2', cutW: 100, cutL: 100, req: 20, pin: 'L1' })] });
  A.applyLotAllocation([sup('S1', [a, b])]);
  const pa = a.shortReason.lots[0].pieces, pb = b.shortReason.lots[0].pieces;
  assert.strictEqual(pa + pb, 38, 'the rows reported ' + pa + ' + ' + pb + ' of a 38-piece shortfall');
  assert.strictEqual(pa, 18);   // this row took the 2 pieces off the 2 m roll
  assert.strictEqual(pb, 20);
});

test('7a the pick carries the lot id the remnant was cut from', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'L2', no: 'L2', wash: 50, rolls: [roll(50)] })],
    waste: [{ wasteId: 'W1', width: 100, length: 400, pieces: 1, lotId: 'L2', lot: 'L2' }],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 4 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  assert.strictEqual(m.lotLines.length, 0, 'covered by offcuts, so no lot line');
  assert.strictEqual(m.wastePicks[0].lotId, 'L2',
    'nothing else on this path records which shade the order was made in');
});

console.log('\n=== 8. the sentences the row prints are true ===');

test('8a nofit quotes cloth that could actually have been cut', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'L1', no: 'L1', wash: 5, rolls: [roll(100)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10 })] })])];
  A.applyLotAllocation(d);
  const r = d[0].materials[0].shortReason;
  assert.strictEqual(r.kind, 'nofit');
  approx(r.have, 5, 0.005);                      // not the 100 m roll
  approx(r.need, 10, 0.005);
});

test('8b a skipped order waiting on the wash house says atWash', () => {
  const A = load();
  const d = [sup('S1', [mat({
    lots: [lot({ id: 'L1', no: 'L1', inWash: 20, rolls: [roll(20)] })],
    lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 10 })] })])];
  A.applyLotAllocation(d);
  const r = d[0].materials[0].shortReason;
  assert.strictEqual(r.kind, 'atWash');
  assert.strictEqual(r.lot, 'L1');
  approx(r.qty, 20);
});

test('8c cloth at the wash house is never counted as available', () => {
  const A = load();
  const f = A.lotFill({ wash: 0, unwash: 0, inWash: 20, waste: [], rolls: [roll(20)] },
    [{ cutW: 100, cutL: 100, pieces: 10 }], { fabricWidthCm: 100 }, true);
  assert.strictEqual(f.covers, false, 'the greige gate must not include inWash');
  approx(f.freshMetres, 0);
});

console.log('\n=== 9. the waste loop is bounded by the work, not by 400 ===');

test('9a 450 one-piece remnants cover a 450-piece job', () => {
  const A = load();
  const waste = [];
  for (let i = 0; i < 450; i++) {
    waste.push({ wasteId: 'W' + i, width: 100, length: 100, pieces: 1, lotId: 'L1', lot: 'L1' });
  }
  const d = [sup('S1', [mat({ lots: [lot({ id: 'L1', wash: 1, rolls: [roll(1)] })],
    waste: waste, lines: [line({ plan: 'P1', cutW: 100, cutL: 100, req: 450 })] })])];
  A.applyLotAllocation(d);
  const m = d[0].materials[0];
  assert.strictEqual(m.piecesCoveredByWaste, 450,
    'the guard stranded ' + (450 - m.piecesCoveredByWaste) + ' pieces and skipped the order');
  assert.strictEqual(m.shortReason, null);
});

console.log('\n========================================');
console.log('allocator-audit-fixes: ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach((f) => console.log('  FAIL ' + f.name + '\n       ' + f.msg));
  process.exitCode = 1;
}
