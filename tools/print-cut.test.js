#!/usr/bin/env node
// Printed fabric "cut at issue" (Option B) verification.
//
// The chain under test:
//   allocator mini-roll maths -> payload pieces[] with cutLengthCm
//   -> store UI cut instruction
//   -> issueMaterials.dg token pipeline ("id:count:len")
//   -> Fabric_Piece decrement + remainder insert + supervisor metres.
//
//   usage: node tools/print-cut.test.js

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

const allocSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');

function runInSandbox(code) {
  const ctx = { console: { log() {}, info() {} }, Math, Number, String, Object,
                Array, JSON, parseInt, parseFloat, isNaN };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

// =====================================================================
// PARTS A, B and E REMOVED - the widget half of "cut at issue" is retired
// =====================================================================
//
// This suite tested one chain end to end:
//
//   allocator mini-roll maths  ->  payload pieces[] with cutLengthCm
//   ->  store UI "Cut 18 m from 20 m piece"
//   ->  issueMaterials.dg token pipeline  ->  Fabric_Piece decrement
//
// PHASE A OF THE ROLLS MIGRATION CUT THAT CHAIN IN HALF, and the halves are in
// different states - which is why this suite sat at 13 passing and 15 failing
// rather than simply broken:
//
//   WIDGET SIDE - RETIRED. A lot is a set of rolls now and printed cloth is
//     just a lot with short rolls, so lot.pieces[] is always empty, the
//     allocator has no mini-roll branch left (Piece 4 deleted lotIsPieces /
//     lotPieces / lotGreigePieces), and lotLines[].pieces is hard-coded [].
//     Parts A (allocator), B (the UI instruction text) and E (end-to-end) were
//     testing code that no longer exists, so they are DELETED rather than left
//     failing - a test of a deleted branch proves nothing about the branch that
//     replaced it. tools/roll-display.test.js covers what the row says now.
//
//   SERVER SIDE - STILL LIVE. Fabric_Piece is referenced by ten .dg files and
//     issueMaterials / issueMaterialsApply still parse "pieces":[{ ...
//     "cutLengthCm" }] off the payload. Nothing sends it any more, so those
//     parsers are unreachable in practice, but they are REAL CODE and retiring
//     them is a Deluge change that has to be Executed against Creator. Parts C
//     and D below still exercise them and still pass, so they stay exactly as
//     they are until that step lands.
//
// The guard below pins that asymmetry, so the day somebody removes the server
// half this suite says so instead of quietly passing over nothing.

test('PC-SPLIT the widget no longer emits cut pieces, while the server still parses them', () => {
  // Widget side: the allocator hard-codes an empty pieces[] on every lot line.
  assert.ok(/pieces:\s*\[\]/.test(allocSrc),
    'lot-allocator no longer hard-codes lotLines[].pieces = [] - if the mini-roll ' +
    'path is back, restore Parts A/B/E from git rather than rewriting them');
  // Matched as a DEFINITION, not a mention: lot-allocator.js carries a "RETIRED:
  // lotIsPieces / lotPieces / lotGreigePieces" comment recording why they went,
  // and a bare name match reads its own documentation as the code coming back.
  assert.ok(!/function\s+(lotIsPieces|lotGreigePieces)\s*\(/.test(allocSrc),
    'the retired mini-roll helpers are back in lot-allocator.js');

  // Server side: still parsing what nothing sends.
  const issue = fs.readFileSync(path.join(__dirname, '..', 'deluge', 'issueMaterials.dg'), 'utf8');
  const apply = fs.readFileSync(path.join(__dirname, '..', 'deluge', 'issueMaterialsApply.dg'), 'utf8');
  assert.ok(issue.includes('cutLengthCm') && apply.includes('cutLengthCm'),
    'the Deluge cut-piece parsers are gone - Parts C and D below now test nothing; ' +
    'delete them in the same pass and note it in docs/lot-rolls-model.md');
});

//          from issueMaterials.dg AS IT NOW STANDS (:740-765 builder,
//          :1337-1420 validation parser, :1954-2020 movement parser)
// =====================================================================
console.log('\nPART C - issueMaterials.dg token pipeline (fixed builder vs parsers)');

// Builder, verbatim logic of the FIXED :740-765: reads pieceId, count AND
// cutLengthCm; emits id:n:len when a length is present, legacy id:n when not.
function dgBuildTokens(piecesJsonObjs) {
  let prevPc = '';
  (piecesJsonObjs || []).forEach(pcOne => {
    const pcIdTxt = String(pcOne.pieceId == null ? '' : pcOne.pieceId).trim();
    let pcCntS = String(pcOne.count == null ? '0' : pcOne.count).trim();
    if (pcCntS === '') pcCntS = '0';
    const pcLenS = String(pcOne.cutLengthCm == null ? '' : pcOne.cutLengthCm).trim();
    if (pcIdTxt !== '' && Number(pcCntS) > 0) {
      if (prevPc !== '') prevPc = prevPc + ',';
      if (pcLenS !== '') prevPc = prevPc + pcIdTxt + ':' + Number(pcCntS) + ':' + Number(pcLenS);
      else prevPc = prevPc + pcIdTxt + ':' + Number(pcCntS);
    }
  });
  return prevPc;
}

// Validation parser, :1337-1420. piecesById values:
// {count,lengthCm,widthCm,status:'Available',state:'Wash',lot}
function dgValidatePass(tokens, piecesById, cutW, cutL) {
  let passIsPieces = false, pcYield = 0, pcMetres = 0;
  const refusals = [];
  tokens.split(',').filter(t => t.trim() !== '').forEach(tok => {
    const bits = tok.trim().split(':');
    if (bits.length >= 2) {
      const id = bits[0].trim();
      const n = Number(bits[1]);
      let cutLen = bits.length >= 3 ? Number(bits[2]) : 0;
      const fp = piecesById[id];
      if (!fp) { refusals.push('missing'); return; }
      if (cutLen <= 0) cutLen = fp.lengthCm;            // legacy -> whole piece
      if (fp.status !== 'Available') { refusals.push('unavailable'); return; }
      if (fp.state !== 'Wash') { refusals.push('greige'); return; }
      if (n > fp.count) { refusals.push('count'); return; }
      if (cutLen > fp.lengthCm) { refusals.push('too long'); return; }
      const across = Math.floor(fp.widthCm / cutW);
      const along = Math.floor(cutLen / cutL);
      if (across > 0 && along > 0) pcYield += across * along * n;
      pcMetres += (cutLen * n) / 100;
      passIsPieces = true;
    }
  });
  return { passIsPieces, pcYield, pcMetres, refusals };
}

test('C1 THE WIRE IS CLOSED: Option B payload builds 3-part tokens that validate as mini-roll cuts', () => {
  const payloadPieces = [
    { pieceId: 'P1', count: 1, cutLengthCm: 1800, lengthCm: 2000, carton: 'C7' },
    { pieceId: 'P1', count: 1, cutLengthCm: 1200, lengthCm: 2000, carton: 'C7' }
  ];
  const tokens = dgBuildTokens(payloadPieces);
  assert.strictEqual(tokens, 'P1:1:1800,P1:1:1200');
  const r = dgValidatePass(tokens, { P1: { count: 5, lengthCm: 2000, widthCm: 162, status: 'Available', state: 'Wash' } }, 130, 300);
  assert.strictEqual(r.refusals.length, 0);
  assert.strictEqual(r.passIsPieces, true, 'the pass arms as PIECES');
  assert.strictEqual(r.pcYield, 10, '6 rows + 4 rows');
  assert.strictEqual(r.pcMetres, 30, 'cut metres, not whole-piece metres');
});

test('C2 backward compatibility RESTORED: a legacy id:count payload validates as WHOLE pieces again', () => {
  const tokens = dgBuildTokens([{ pieceId: 'P1', count: 2 }]);   // old widget shape
  assert.strictEqual(tokens, 'P1:2');
  const r = dgValidatePass(tokens, { P1: { count: 5, lengthCm: 300, widthCm: 137, status: 'Available', state: 'Wash' } }, 55, 55);
  assert.strictEqual(r.refusals.length, 0);
  assert.strictEqual(r.passIsPieces, true);
  assert.strictEqual(r.pcYield, 20, 'floor(300/55)=5 x floor(137/55)=2, two copies');
  assert.strictEqual(r.pcMetres, 6, 'two WHOLE pieces leave: 2 x 3.00 m');
});

test('C3 refusal chain still armed through the new gate', () => {
  const world = {
    PLONG: { count: 2, lengthCm: 500, widthCm: 162, status: 'Available', state: 'Wash' },
    PGREY: { count: 2, lengthCm: 2000, widthCm: 162, status: 'Available', state: 'Unwash' },
    PGONE: { count: 2, lengthCm: 2000, widthCm: 162, status: 'Issued', state: 'Wash' },
    PSHORT: { count: 1, lengthCm: 2000, widthCm: 162, status: 'Available', state: 'Wash' }
  };
  const tokens = dgBuildTokens([
    { pieceId: 'PLONG', count: 1, cutLengthCm: 900 },
    { pieceId: 'PGREY', count: 1, cutLengthCm: 300 },
    { pieceId: 'PGONE', count: 1, cutLengthCm: 300 },
    { pieceId: 'PSHORT', count: 2, cutLengthCm: 300 }
  ]);
  const r = dgValidatePass(tokens, world, 130, 300);
  assert.deepStrictEqual(r.refusals.sort(), ['count', 'greige', 'too long', 'unavailable']);
  assert.strictEqual(r.pcMetres, 0);
});

test('C4 zero-count and blank-id specs are dropped by the builder, not passed on', () => {
  const tokens = dgBuildTokens([
    { pieceId: '', count: 2, cutLengthCm: 300 },
    { pieceId: 'P0', count: 0, cutLengthCm: 300 },
    { pieceId: 'P1', count: 1, cutLengthCm: 1800 }
  ]);
  assert.strictEqual(tokens, 'P1:1:1800');
});

// =====================================================================
// PART D - the ledger ONCE TOKENS CARRY THE LENGTH (the intended
//          semantics of :1381-1397 validation + :1947-1988 movement),
//          so the fix itself can be judged before it is wired up
// =====================================================================
console.log('\nPART D - intended ledger semantics (post-wiring behaviour)');

function dgLedgerIssue(specs, world, cutW, cutL) {
  // Faithful port of the NEW code paths: validation (:1337-1420) then
  // movement (:1954-2020) with its isClamped guard and legacy default.
  const res = { errors: [], pcYield: 0, pcMetres: 0, moved: [], remainders: [],
                lotWashDelta: 0, clamped: [] };
  specs.forEach(s => {
    const fp = world.pieces[s.pieceId];
    if (!fp) { res.errors.push('missing'); return; }
    if (fp.status !== 'Available') { res.errors.push('unavailable'); return; }
    if (fp.state !== 'Wash') { res.errors.push('greige'); return; }
    if (s.n > fp.count) { res.errors.push('count'); return; }
    const cutLen = s.cutLen > 0 ? s.cutLen : fp.lengthCm;   // legacy whole piece
    if (cutLen > fp.lengthCm) { res.errors.push('too long'); return; }
    const across = Math.floor(fp.widthCm / cutW);
    const along = Math.floor(cutLen / cutL);
    if (across > 0 && along > 0) res.pcYield += across * along * s.n;
    res.pcMetres += (cutLen * s.n) / 100;
    res.moved.push({ id: s.pieceId, n: s.n, cutLen });
  });
  // Movement pass, :1954-2020, sequential like the .dg loop. The original
  // row's Piece_Length_Cm NEVER changes - only its count steps down - so each
  // spec's tail is measured off the full original length.
  res.moved.forEach(mv => {
    const fp = world.pieces[mv.id];
    let left = fp.count - mv.n;
    let isClamped = false;
    if (left < 0) { left = 0; isClamped = true; res.clamped.push(mv.id); }
    fp.count = left;
    const remainder = fp.lengthCm - mv.cutLen;
    if (remainder > 0 && isClamped === false) {
      res.remainders.push({ lengthCm: remainder, count: mv.n,
                            lot: fp.lot, state: fp.state, carton: fp.carton,
                            widthCm: fp.widthCm });
    }
  });
  res.lotWashDelta = res.pcMetres;
  return res;
}

test('D1 user scenario through the INTENDED ledger: yields 10, moves 30 m, leaves 200 cm and 800 cm tails', () => {
  const world = { pieces: { P1: { count: 5, lengthCm: 2000, widthCm: 162,
                                  status: 'Available', state: 'Wash',
                                  lot: 'L1', carton: 'C7' } } };
  const r = dgLedgerIssue([
    { pieceId: 'P1', n: 1, cutLen: 1800 },
    { pieceId: 'P1', n: 1, cutLen: 1200 }
  ], world, 130, 300);
  assert.strictEqual(r.pcYield, 10, 'floor(1800/300)=6 plus floor(1200/300)=4');
  assert.strictEqual(r.pcMetres, 30);
  assert.strictEqual(world.pieces.P1.count, 3, 'five copies minus two cut');
  assert.strictEqual(r.remainders.length, 2);
  assert.deepStrictEqual(r.remainders.map(x => x.lengthCm).sort((a, b) => a - b), [200, 800]);
  r.remainders.forEach(x => {
    assert.strictEqual(x.state, 'Wash', 'tail of washed cloth stays washed');
    assert.strictEqual(x.widthCm, 162);
    assert.strictEqual(x.carton, 'C7');
  });
  assert.strictEqual(r.lotWashDelta, 30, 'lot Wash_Quantity drops by the CUT metres only');
});

test('D2 refusal paths survive the change: too long, greige, unavailable, over-count', () => {
  const world = { pieces: {
    PLONG: { count: 2, lengthCm: 500, widthCm: 162, status: 'Available', state: 'Wash', lot: 'L1' },
    PGREY: { count: 2, lengthCm: 2000, widthCm: 162, status: 'Available', state: 'Unwash', lot: 'L1' },
    PGONE: { count: 2, lengthCm: 2000, widthCm: 162, status: 'Issued', state: 'Wash', lot: 'L1' },
    PSHORT:{ count: 1, lengthCm: 2000, widthCm: 162, status: 'Available', state: 'Wash', lot: 'L1' }
  } };
  const r = dgLedgerIssue([
    { pieceId: 'PLONG', n: 1, cutLen: 900 },
    { pieceId: 'PGREY', n: 1, cutLen: 300 },
    { pieceId: 'PGONE', n: 1, cutLen: 300 },
    { pieceId: 'PSHORT', n: 2, cutLen: 300 }
  ], world, 130, 300);
  assert.deepStrictEqual(r.errors.sort(), ['count', 'greige', 'too long', 'unavailable']);
  assert.strictEqual(r.pcMetres, 0, 'a refused handover moves nothing');
});

test('D3 two sequential cuts of the SAME piece row inside one handover: counts step down, two tails appear', () => {
  const world = { pieces: { P1: { count: 3, lengthCm: 2000, widthCm: 162,
                                  status: 'Available', state: 'Wash', lot: 'L1' } } };
  const r = dgLedgerIssue([
    { pieceId: 'P1', n: 1, cutLen: 1800 },
    { pieceId: 'P1', n: 1, cutLen: 1800 }
  ], world, 130, 300);
  assert.strictEqual(world.pieces.P1.count, 1);
  assert.strictEqual(r.remainders.length, 2);
  assert.deepStrictEqual(r.remainders.map(x => x.lengthCm), [200, 200],
    'each cut leaves its own tail row - they are distinct physical strips');
});

test('D4 THE CLAMP GUARD: an over-request that slips past validation inserts NO phantom tails', () => {
  // Before the guard, movement (:1996-2010) would clamp count 1 -> 0 and then
  // STILL insert THREE 1700 cm tail rows - stock invented. The isClamped flag
  // now gates the insert, asserted here against the movement block verbatim:
  const fp = { count: 1, lengthCm: 2000 };
  const n = 3, cutLen = 300;
  let left = fp.count - n;
  let isClamped = false;
  if (left < 0) { left = 0; isClamped = true; }
  fp.count = left;
  const remainder = fp.lengthCm - cutLen;
  const inserted = remainder > 0 && isClamped === false;
  assert.strictEqual(isClamped, true);
  assert.strictEqual(inserted, false, 'no phantom tail rows');
});

test('D5 legacy whole-piece spec through movement: full length leaves, NO tail row', () => {
  const world = { pieces: { P1: { count: 3, lengthCm: 300, widthCm: 137,
                                  status: 'Available', state: 'Wash', lot: 'L1' } } };
  const r = dgLedgerIssue([{ pieceId: 'P1', n: 2, cutLen: 0 }], world, 55, 55);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.pcMetres, 6, 'two whole 3 m pieces');
  assert.strictEqual(r.pcYield, 20);
  assert.strictEqual(world.pieces.P1.count, 1);
  assert.strictEqual(r.remainders.length, 0, 'nothing left over when the WHOLE piece goes');
});

test('D6 cut equal to the exact piece length consumes the copy cleanly', () => {
  const world = { pieces: { P1: { count: 2, lengthCm: 1800, widthCm: 162,
                                  status: 'Available', state: 'Wash', lot: 'L1' } } };
  const r = dgLedgerIssue([{ pieceId: 'P1', n: 1, cutLen: 1800 }], world, 130, 300);
  assert.strictEqual(world.pieces.P1.count, 1);
  assert.strictEqual(r.remainders.length, 0, 'remainder 0 -> no row inserted');
  assert.strictEqual(r.pcYield, 6);
});

test('D7 mixed handover: one mini-roll cut and one whole-piece copy in the SAME pass', () => {
  const world = { pieces: { P1: { count: 4, lengthCm: 2000, widthCm: 162,
                                  status: 'Available', state: 'Wash', lot: 'L1' } } };
  const r = dgLedgerIssue([
    { pieceId: 'P1', n: 1, cutLen: 1200 },   // Option B cut -> 800 tail
    { pieceId: 'P1', n: 1, cutLen: 0 }       // legacy whole piece -> no tail
  ], world, 130, 300);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(world.pieces.P1.count, 2);
  assert.deepStrictEqual(r.remainders.map(x => x.lengthCm), [800],
    'only the CUT copy leaves a tail; metres 12 + 20 = 32');
  assert.strictEqual(r.pcMetres, 32);
});

test('D8 LATENT (pre-existing shape): a piece too NARROW for the cut moves metres but credits zero pieces', () => {
  // pcAcross == 0 skips only the yield term (:1412-1416); pcMetres still
  // adds (:1420) and passIsPieces arms. The allocator can never produce this
  // (remnantYield gates on width), but a hand-crafted payload would burn
  // cloth with nothing booked. Documented so it is a decision, not a surprise.
  const world = { pieces: { PNARROW: { count: 5, lengthCm: 2000, widthCm: 100,
                                       status: 'Available', state: 'Wash', lot: 'L1' } } };
  const r = dgLedgerIssue([{ pieceId: 'PNARROW', n: 1, cutLen: 1500 }], world, 130, 300);
  assert.strictEqual(r.errors.length, 0, 'no refusal exists for across==0');
  assert.strictEqual(r.pcYield, 0, 'zero pieces credited');
  assert.strictEqual(r.pcMetres, 15, 'yet 15 m leave the shelf');
});

console.log('\n========================================');
console.log('print-cut: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) process.exitCode = 1;
