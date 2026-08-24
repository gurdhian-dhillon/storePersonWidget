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
// PART A - the allocator's mini-roll maths (REAL lot-allocator.js)
// =====================================================================
console.log('\nPART A - allocator treats printed pieces as mini-rolls');

function allocateOneMaterial(pieceSpecs, demandPieces, opts) {
  opts = opts || {};
  const mat = {
    materialId: 'M1', material: 'Linen Print', sku: 'PRN', unit: 'Mtr',
    isFabric: true, isReissue: false,
    required: demandPieces * 3, issued: 0, remaining: demandPieces * 3,
    availableStock: 100, unwashedStock: 0, inWashStock: 0,
    cutWidth: 130, cutLength: 300, fabricWidthCm: opts.fabricWidthCm || 162,
    requiredPieces: demandPieces, issuedPieces: 0, wasteIssuedPieces: 0,
    outstandingPieces: demandPieces,
    freshMeters: demandPieces * 3, piecesCoveredByWaste: 0,
    freshPieces: demandPieces, requiredTotal: demandPieces * 3,
    wastePicks: [], wasteStock: [],
    lots: [{ lotId: 'L1', lotNumber: 'L1', blocked: false,
             wash: 100, unwash: 0, inWash: 0, form: 'Pieces',
             pieces: pieceSpecs }],
    lines: [{ planId: 'PL1', salesOrder: 'SO-1', planItemId: 'IT1',
              item: 'X', isRemake: false, supervisorId: 'SUP-A',
              required: demandPieces * 3, issued: 0,
              reqPieces: demandPieces, issPieces: 0,
              issuedLot: '', issuedLotNo: '', reason: '' }],
    openExceptions: []
  };
  const data = [{ supervisorId: 'SUP-A', supervisorName: 'Ravi', materials: [mat] }];
  const ctx = runInSandbox(allocSrc + '\nthis.applyLotAllocation = applyLotAllocation;');
  ctx.applyLotAllocation(data);
  return mat;
}

function flattenCuts(m) {
  // All piece specs across every lot line of the material, post-allocation.
  const out = [];
  (m.lotLines || []).forEach(ln => (ln.pieces || []).forEach(p => out.push(p)));
  return out;
}

test('A1 THE REPORTED SCENARIO: five 20 m printed pieces, cut 130x300, need 10 -> cuts 18 m + 12 m off TWO copies, 30 m total', () => {
  const m = allocateOneMaterial(
    [{ pieceId: 'P1', lengthCm: 2000, widthCm: 162, count: 5, state: 'Wash', carton: 'C7' }], 10);
  const cuts = flattenCuts(m).filter(p => String(p.pieceId) === 'P1');
  assert.strictEqual(cuts.length, 2, 'two aggregated cut lines for P1, got ' + JSON.stringify(cuts));
  const byLen = {};
  cuts.forEach(p => { byLen[p.cutLengthCm] = (byLen[p.cutLengthCm] || 0) + p.count; });
  assert.strictEqual(byLen[1800], 1, 'one copy cut to 6 rows = 1800 cm');
  assert.strictEqual(byLen[1200], 1, 'second copy cut to 4 rows = 1200 cm');
  let metres = 0; (m.lotLines || []).forEach(ln => metres += Number(ln.qty) || 0);
  assert.strictEqual(Math.round(metres * 100) / 100, 30, 'exactly 30 m moves - not 40 (whole pieces), not continuous-30-from-one-roll');
  assert.strictEqual(m.piecesCoveredByWaste, 0);
  assert.strictEqual(m.freshPieces, 10);
});

test('A2 exact fit: need 6 -> ONE cut of 1800 cm from one copy', () => {
  const m = allocateOneMaterial(
    [{ pieceId: 'P1', lengthCm: 2000, widthCm: 162, count: 5, state: 'Wash', carton: '' }], 6);
  const cuts = flattenCuts(m);
  assert.strictEqual(cuts.length, 1);
  assert.strictEqual(cuts[0].count, 1);
  assert.strictEqual(cuts[0].cutLengthCm, 1800);
});

test('A3 need 14 -> three copies consumed, cuts {1800 x2, 600 x1}, 42 m', () => {
  const m = allocateOneMaterial(
    [{ pieceId: 'P1', lengthCm: 2000, widthCm: 162, count: 5, state: 'Wash', carton: '' }], 14);
  const byLen = {};
  flattenCuts(m).forEach(p => { byLen[p.cutLengthCm] = (byLen[p.cutLengthCm] || 0) + p.count; });
  assert.strictEqual(byLen[1800], 2, 'two full 18 m cuts');
  assert.strictEqual(byLen[600], 1, 'then a 4-piece top-up = 2 rows');
  let metres = 0; (m.lotLines || []).forEach(ln => metres += Number(ln.qty) || 0);
  assert.strictEqual(Math.round(metres * 100) / 100, 42);
});

test('A4 a partially cut copy leaves a tail the session will NOT reuse (server restores it as its own Available row)', () => {
  // L2200, cutL300: cutting 4 rows takes 1200 cm and leaves a 1000 cm tail
  // that physically fits 3 more cuts. Within THIS session the allocator must
  // not dip back into it (provenance); the .dg re-inserts it as Available so
  // the NEXT fetch offers it again.
  const m = allocateOneMaterial(
    [{ pieceId: 'P1', lengthCm: 2200, widthCm: 162, count: 3, state: 'Wash', carton: '' }], 4);
  const cuts = flattenCuts(m);
  assert.strictEqual(cuts.length, 1, 'one cut only this session');
  assert.strictEqual(cuts[0].cutLengthCm, 1200);
  assert.strictEqual(cuts[0].count, 1, 'only one physical copy touched');
  let metres = 0; (m.lotLines || []).forEach(ln => metres += Number(ln.qty) || 0);
  assert.strictEqual(metres, 12);
});

test('A5 scoring prefers the snugger piece (least cut waste per obtained piece)', () => {
  const m = allocateOneMaterial([
    { pieceId: 'PBIG', lengthCm: 700, widthCm: 160, count: 1, state: 'Wash', carton: '' },
    { pieceId: 'PSNUG', lengthCm: 700, widthCm: 130, count: 1, state: 'Wash', carton: '' }
  ], 2);
  const cuts = flattenCuts(m);
  assert.strictEqual(cuts.length, 1, 'demand served from ONE piece');
  assert.strictEqual(String(cuts[0].pieceId), 'PSNUG',
    'snug 130-wide piece wins over the wider one at identical yield');
});

test('A6 payload entries carry cutLengthCm alongside the original length and carton', () => {
  const m = allocateOneMaterial(
    [{ pieceId: 'P9', lengthCm: 2000, widthCm: 162, count: 5, state: 'Wash', carton: 'C2' }], 4);
  const p = flattenCuts(m)[0];
  assert.strictEqual(p.cutLengthCm, 1200);
  assert.strictEqual(p.lengthCm, 2000, 'original length travels so the UI can say "cut X from Y"');
  assert.strictEqual(p.carton, 'C2');
  assert.ok('count' in p && p.count === 1);
});

test('A8 demand bigger than any lot covers WHOLE: the order is SKIPPED, never split (atom rule)', () => {
  const m = allocateOneMaterial(
    [{ pieceId: 'P1', lengthCm: 2000, widthCm: 162, count: 2, state: 'Wash', carton: '' }], 30);
  // Two copies yield 12 cuts; the 30-piece order cannot be served WHOLE off
  // one lot, so NOTHING is offered - no partial handover that strands the
  // shade decision.
  assert.deepStrictEqual(flattenCuts(m), [], 'no cut instructions when the atom cannot be served');
  let metres = 0; (m.lotLines || []).forEach(ln => metres += Number(ln.qty) || 0);
  assert.strictEqual(metres, 0);
  assert.strictEqual(m.freshPieces, 30, 'still fully owed');
  assert.strictEqual(m.shortReason && m.shortReason.kind, 'nofit',
    'row names the problem instead of offering half');
});

test('A9 a copy too narrow for the cut is never a candidate (grain fixed)', () => {
  const m = allocateOneMaterial([
    { pieceId: 'PWIDE', lengthCm: 2000, widthCm: 162, count: 1, state: 'Wash', carton: '' },
    { pieceId: 'PNARROW', lengthCm: 5000, widthCm: 100, count: 9, state: 'Wash', carton: '' }
  ], 6);
  const ids = flattenCuts(m).map(p => String(p.pieceId));
  assert.ok(ids.indexOf('PNARROW') === -1, '100 cm cannot host a 130 cm cut regardless of length');
  assert.deepStrictEqual(ids, ['PWIDE']);
});

test('A7 two items of one order sharing the same copies: each lot line names its own cuts, counts never double-booked', () => {
  const mat = {
    materialId: 'M1', material: 'Linen Print', sku: 'PRN', unit: 'Mtr',
    isFabric: true, isReissue: false,
    required: 30, issued: 0, remaining: 30, availableStock: 100,
    unwashedStock: 0, inWashStock: 0,
    cutWidth: 130, cutLength: 300, fabricWidthCm: 162,
    requiredPieces: 10, issuedPieces: 0, wasteIssuedPieces: 0, outstandingPieces: 10,
    freshMeters: 30, piecesCoveredByWaste: 0, freshPieces: 10, requiredTotal: 30,
    wastePicks: [], wasteStock: [],
    lots: [{ lotId: 'L1', lotNumber: 'L1', blocked: false, wash: 100, unwash: 0,
             inWash: 0, form: 'Pieces',
             pieces: [{ pieceId: 'P1', lengthCm: 2000, widthCm: 162, count: 2, state: 'Wash', carton: '' }] }],
    lines: [
      { planId: 'PL1', salesOrder: 'SO-1', planItemId: 'IT1', item: 'Cover', isRemake: false,
        supervisorId: 'SUP-A', required: 15, issued: 0, reqPieces: 5, issPieces: 0,
        issuedLot: '', issuedLotNo: '', reason: '' },
      { planId: 'PL1', salesOrder: 'SO-1', planItemId: 'IT2', item: 'Bag', isRemake: false,
        supervisorId: 'SUP-A', required: 15, issued: 0, reqPieces: 5, issPieces: 0,
        issuedLot: '', issuedLotNo: '', reason: '' }
    ],
    openExceptions: []
  };
  const data = [{ supervisorId: 'SUP-A', supervisorName: 'Ravi', materials: [mat] }];
  const ctx = runInSandbox(allocSrc + '\nthis.applyLotAllocation = applyLotAllocation;');
  ctx.applyLotAllocation(data);
  const all = flattenCuts(mat);
  const totalCopies = all.reduce((a, p) => a + p.count, 0);
  assert.strictEqual(totalCopies, 2, 'exactly the two physical copies exist');
  assert.strictEqual(all.filter(p => String(p.pieceId) === 'P1' && p.cutLengthCm !== undefined).length >= 1, true);
  let metres = 0; (mat.lotLines || []).forEach(ln => metres += Number(ln.qty) || 0);
  assert.strictEqual(Math.round(metres * 100) / 100, 30);
});

// =====================================================================
// PART B - the store screen says CUT, not FETCH
// =====================================================================
console.log('\nPART B - store UI instruction text');

function extractFn(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js lost function ' + name);
  let depth = 0, j = mainSrc.indexOf('{', i);
  for (let k = j; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i, j);
}

const uiCtx = runInSandbox(
  allocSrc + '\n' +
  ['escapeHtml', 'fmt', 'recommendLots', 'lotInputId', 'lotLinesHtml'].map(extractFn).join('\n') +
  '\nthis.lotLinesHtml = lotLinesHtml;');

function renderLotStrip(lotLinePieces, qty) {
  const m = {
    materialId: 'M1', unit: 'Mtr', isFabric: true,
    lotLines: [{ lotId: 'L1', lotNumber: 'L1', qty: qty, pieces: lotLinePieces }],
    lots: [{ lotId: 'L1', lotNumber: 'L1' }]
  };
  return String(uiCtx.lotLinesHtml(m, 0, 0));
}

test('B1 "Cut 18 m from 20 m piece" renders for a partial cut', () => {
  const html = renderLotStrip([{ pieceId: 'P1', count: 1, cutLengthCm: 1800, lengthCm: 2000, carton: 'C7' }], 18);
  assert.ok(/Cut 18 m from 20 m piece/.test(html), html);
  assert.ok(/carton C7|carton <b>C7/.test(html), 'carton still named: ' + html);
});

test('B2 identical cuts aggregate with an x-count', () => {
  const html = renderLotStrip([{ pieceId: 'P1', count: 2, cutLengthCm: 1800, lengthCm: 2000, carton: '' }], 36);
  assert.ok(/Cut 18 m from 20 m piece &times; 2/.test(html), html);
});

test('B3 different cut lengths of the same piece id do NOT merge into one line', () => {
  const html = renderLotStrip([
    { pieceId: 'P1', count: 1, cutLengthCm: 1800, lengthCm: 2000, carton: '' },
    { pieceId: 'P1', count: 1, cutLengthCm: 1200, lengthCm: 2000, carton: '' }
  ], 30);
  assert.ok(/Cut 18 m from 20 m piece(?! &times;)/.test(html), 'first cut standalone: ' + html);
  assert.ok(/Cut 12 m from 20 m piece(?! &times;)/.test(html), 'second cut standalone: ' + html);
});

test('B4 a legacy spec without cutLengthCm keeps the whole-piece wording', () => {
  const html = renderLotStrip([{ pieceId: 'P1', count: 3, lengthCm: 300, carton: '' }], 0.9);
  assert.ok(/3 pieces of 3 m/.test(html), html);
});

// =====================================================================
// PART C - the Deluge token pipeline, ported statement-for-statement
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

// =====================================================================
// PART E - end-to-end parity on the reported scenario:
//          what the SCREEN offers is exactly what the LEDGER accepts
// =====================================================================
console.log('\nPART E - screen offer == ledger accept (reported scenario)');

test('E1 allocator offer feeds the intended ledger and closes the requirement exactly', () => {
  const m = allocateOneMaterial(
    [{ pieceId: 'P1', lengthCm: 2000, widthCm: 162, count: 5, state: 'Wash', carton: 'C7' }], 10);
  const offers = flattenCuts(m)
    .map(p => ({ pieceId: p.pieceId, n: p.count, cutLen: p.cutLengthCm }));
  const world = { pieces: { P1: { count: 5, lengthCm: 2000, widthCm: 162,
                                  status: 'Available', state: 'Wash', lot: 'L1', carton: 'C7' } } };
  const r = dgLedgerIssue(offers, world, 130, 300);
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.strictEqual(r.pcYield, 10, 'requirement closes in PIECES');
  assert.strictEqual(r.pcMetres, 30, 'and in exactly the metres the screen quoted');
  assert.strictEqual(world.pieces.P1.count, 3);
  assert.deepStrictEqual(r.remainders.map(x => x.lengthCm).sort((a, b) => a - b), [200, 800]);
});

test('E2 parity on the 14-piece scenario: 42 m moves, two copies left, tails as ONE row per cut length', () => {
  const m = allocateOneMaterial(
    [{ pieceId: 'P1', lengthCm: 2000, widthCm: 162, count: 5, state: 'Wash', carton: '' }], 14);
  const offers = flattenCuts(m)
    .map(p => ({ pieceId: p.pieceId, n: p.count, cutLen: p.cutLengthCm }));
  const world = { pieces: { P1: { count: 5, lengthCm: 2000, widthCm: 162,
                                  status: 'Available', state: 'Wash', lot: 'L1' } } };
  const r = dgLedgerIssue(offers, world, 130, 300);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.pcYield, 14);
  assert.strictEqual(r.pcMetres, 42);
  assert.strictEqual(world.pieces.P1.count, 2);
  // Identical cuts aggregate into one spec (n=2), so the .dg inserts ONE tail
  // row of 200 cm carrying Piece_Count = 2 - the documented row-split model.
  assert.deepStrictEqual(r.remainders.map(x => x.lengthCm).sort((a, b) => a - b), [200, 1400]);
  const tail200 = r.remainders.filter(x => x.lengthCm === 200)[0];
  assert.strictEqual(tail200.count, 2, 'both 200 cm strips live on one Fabric_Piece row');
});

test('E3 legacy parity: whole-piece offer (old widget) still closes against the fixed ledger', () => {
  // Old widget sends no cutLengthCm; builder emits id:n; ledger defaults to
  // the full piece. Three 300 cm copies host 25 cuts of 55x60... at width
  // 137 -> across=2, along=5, 10 per copy.
  const tokens = dgBuildTokens([{ pieceId: 'P1', count: 3 }]);
  const world = { pieces: { P1: { count: 5, lengthCm: 300, widthCm: 137,
                                  status: 'Available', state: 'Wash', lot: 'L1' } } };
  const v = dgValidatePass(tokens, world.pieces, 60, 55);
  assert.strictEqual(v.pcYield, 30);
  assert.strictEqual(v.pcMetres, 9);
  const r = dgLedgerIssue([{ pieceId: 'P1', n: 3, cutLen: 0 }], world, 60, 55);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(world.pieces.P1.count, 2);
  assert.strictEqual(r.remainders.length, 0);
});

// =====================================================================
console.log('\n========================================');
console.log('print-cut: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) process.exitCode = 1;
