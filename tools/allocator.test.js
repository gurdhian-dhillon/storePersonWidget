#!/usr/bin/env node
// Executes the REAL app/js/lot-allocator.js (no port, no copy) inside a VM
// sandbox and tests the automatic allocation decision: lot choice, offcut
// picks, pins, greige tiers, ledgers, and the write-back the issue payload
// is built from.
//
//   usage: node tools/allocator.test.js

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
function approx(a, b, eps) {
  eps = eps === undefined ? 1e-9 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + '+/-' + eps + ', got ' + a);
}

// ---- load the real allocator --------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const ctx = { console, Math, Number, Object, String, Array, JSON };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.A = { round2, remnantYield, perRowFor, lotFill, chooseLotForOrder, orderMetres,\n  lotIsPieces, lotPieces, lotGreigePieces, applyLotAllocation,\n  setOverride: function (k, v) { lotOverrides[k] = v; },\n  clearOverrides: function () { for (var k in lotOverrides) delete lotOverrides[k]; },\n  setDeclined: function (k, v) { wasteDeclined[k] = v; },\n  clearDeclined: function () { for (var k in wasteDeclined) delete wasteDeclined[k]; } };', ctx);
const A = ctx.A;

// ---- builders -----------------------------------------------------------------
function line(planItemId, reqPcs, issPcs, planId, issuedLot) {
  return { planId: planId || 'PLAN1', planItemId, reqPieces: reqPcs, issPieces: issPcs || 0,
           issuedLot: issuedLot || '', issuedLotNo: issuedLot || '', item: 'X', isRemake: false };
}
function roll(lotId, wash, opts) {
  opts = opts || {};
  return { lotId, lotNumber: opts.no || lotId, blocked: !!opts.blocked,
           wash: wash, unwash: opts.unwash || 0, inWash: opts.inWash || 0,
           form: 'Roll', pieces: [] };
}
function pieceLot(lotId, pieces, opts) {
  opts = opts || {};
  return { lotId, lotNumber: opts.no || lotId, blocked: !!opts.blocked,
           wash: opts.wash || 0, unwash: opts.unwash || 0, inWash: opts.inWash || 0,
           form: 'Pieces', pieces: pieces };
}
function fpiece(pieceId, lenCm, widCm, count, state) {
  return { pieceId, lengthCm: lenCm, widthCm: widCm, count: count || 1, state: state || 'Wash', carton: '' };
}
function remnant(wasteId, w, l, pcs, lotId) {
  return { wasteId, width: w, length: l, pieces: pcs, lotId: lotId || '', lot: '', carton: '' };
}
function material(materialId, m) {
  return Object.assign({
    materialId, isFabric: true, sku: 'FAB', unit: 'Mtr',
    fabricWidthCm: 137.16, cutWidth: 55, cutLength: 55,
    requiredPieces: 0, issuedPieces: 0, outstandingPieces: 0,
    freshMeters: 0, remaining: 0, availableStock: 0,
    lines: [], wasteStock: [], lots: [], openExceptions: [],
  }, m);
}
function sup(supervisorId, mats) { return { supervisorId, supervisorName: 'S', materials: mats }; }

// =====================================================================
console.log('\nPART C - pure helpers');

test('C1 remnantYield: floor-across x floor-along', () => {
  assert.strictEqual(A.remnantYield({ width: 300, length: 400 }, 187, 137), 2);
});
test('C2 grain fixed: narrower than cut is ZERO however long', () => {
  assert.strictEqual(A.remnantYield({ width: 100, length: 900 }, 187, 137), 0);
});
test('C3 exact fit = 1; just-short length = 0', () => {
  assert.strictEqual(A.remnantYield({ width: 55, length: 55 }, 55, 55), 1);
  assert.strictEqual(A.remnantYield({ width: 55, length: 54.9 }, 55, 55), 0);
});
test('C4 perRowFor boundaries incl. cut-wider-than-cloth refusal', () => {
  assert.strictEqual(A.perRowFor({ fabricWidthCm: 167.64 }, 55), 3);
  assert.strictEqual(A.perRowFor({ fabricWidthCm: 110 }, 110), 1);
  assert.strictEqual(A.perRowFor({ fabricWidthCm: 109.99 }, 110), 0);
  assert.strictEqual(A.perRowFor({ fabricWidthCm: 0 }, 55), 0);
});

console.log('\nPART D - lotFill simulation');

test('D1 roll: rows capped by cloth; shortfall reported in PIECES', () => {
  const f = A.lotFill(roll('L1', 5.00), [{ cutW: 55, cutL: 55, pieces: 20 }], { fabricWidthCm: 137.16 }, false);
  // perRow=2 -> need ceil(20/2)=10 rows=5.50m; only floor(500/55)=9 rows fit -> 18 pieces
  approx(f.freshMetres, 4.95); assert.strictEqual(f.fromFresh[0], 18); approx(f.shortBy, 2);
});
test('D2 waste before fresh; least-waste-per-cut scoring picks the snug remnant', () => {
  const lot = roll('L1', 100);
  lot.waste = [remnant('BIG', 200, 300, 1, 'L1'), remnant('SNUG', 120, 115, 1, 'L1')];
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 4 }], { fabricWidthCm: 137.16 }, false);
  // SNUG: floor(120/55)*floor(115/55)=4 cuts from ONE piece; BIG wastes far more area per cut
  assert.strictEqual(f.picks.SNUG, 1); assert.strictEqual(f.picks.BIG, undefined);
  assert.strictEqual(f.fromWaste[0], 4); approx(f.freshMetres, 0);
});
test('D3 pieces lot: yield simulated per piece; metres follow the WHOLE pieces', () => {
  const lot = pieceLot('LP', [fpiece('p1', 300, 140), fpiece('p2', 300, 140), fpiece('p3', 300, 140)], { wash: 9.00 });
  const f = A.lotFill(lot, [{ cutW: 60, cutL: 55, pieces: 25 }], { fabricWidthCm: 140 }, false);
  // per piece floor(140/60)=2 x floor(300/55)=5 =10 -> three whole pieces cover 25 of 30
  assert.strictEqual(f.fromFresh[0], 25); approx(f.freshMetres, 9.00);
  assert.notStrictEqual(f.fromFresh[0], 32, 'metres division would lie (floor(900/55)*2=32)');
});
test('D4 roll greige never serves TODAY, covers once washed', () => {
  const lot = roll('L1', 0, { unwash: 50 });
  assert.strictEqual(A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 10 }], { fabricWidthCm: 137.16 }, false).covers, false);
  assert.strictEqual(A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 10 }], { fabricWidthCm: 137.16 }, true).covers, true);
});
test('D5 greige PIECES excluded even from after-wash simulation (documented phase-2 gap)', () => {
  const lot = pieceLot('LP', [fpiece('p1', 300, 140, 5, 'Unwash')], { wash: 0 });
  assert.strictEqual(A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 5 }], { fabricWidthCm: 140 }, true).covers, false);
  assert.strictEqual(A.lotGreigePieces(lot), 5);
});
test('D7 EMPTY form means Roll - legacy lots stay cuttable', () => {
  const lot = roll('L1', 6.00); lot.form = '';
  assert.strictEqual(A.lotFill(lot, [{ cutW: 55, cutL: 55, pieces: 20 }], { fabricWidthCm: 137.16 }, false).covers, true);
});

console.log('\nPART E - chooseLotForOrder');

test('E1 smallest covering lot wins among ready ones', () => {
  const c = A.chooseLotForOrder([roll('BIG', 50), roll('SMALL', 6)],
    [{ cutW: 55, cutL: 55, pieces: 20 }], { fabricWidthCm: 137.16 });
  assert.strictEqual(c.lot.lotId, 'SMALL'); assert.strictEqual(c.ready, true);
});
test('E2 an order nothing covers WHOLE is skipped, never split', () => {
  const c = A.chooseLotForOrder([roll('A', 3), roll('B', 4)],
    [{ cutW: 55, cutL: 55, pieces: 30 }], { fabricWidthCm: 137.16 });
  assert.strictEqual(c, null);
});
test('E3 ready tier beats after-wash tier', () => {
  const c = A.chooseLotForOrder([roll('GREIGE', 0, { unwash: 50 }), roll('READY', 10)],
    [{ cutW: 55, cutL: 55, pieces: 20 }], { fabricWidthCm: 137.16 });
  assert.strictEqual(c.lot.lotId, 'READY'); assert.strictEqual(c.ready, true);
});
test('E4 blocked lots are never candidates', () => {
  assert.strictEqual(A.chooseLotForOrder([roll('QUAR', 50, { blocked: true })],
    [{ cutW: 55, cutL: 55, pieces: 2 }], { fabricWidthCm: 137.16 }), null);
});

console.log('\nPART F - applyLotAllocation end-to-end');

test('F1 unpinned order: pre-selects its lot, sized in whole marker rows', () => {
  const data = [sup('S1', [material('M1', {
    requiredPieces: 20, issuedPieces: 0, freshMeters: 5.50,
    lines: [line('IT1', 20, 0)],
    lots: [roll('L1', 10)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.lotLines.length, 1);
  approx(m.lotLines[0].qty, 5.50);
  assert.strictEqual(m.lotLines[0].planItemId, 'IT1');
  approx(m.remaining, 5.50);
});

test('F2 remnant covers part; fresh need shrinks by covered pieces', () => {
  const data = [sup('S1', [material('M1', {
    requiredPieces: 20, issuedPieces: 0, freshMeters: 5.50,
    lines: [line('IT1', 20, 0)],
    wasteStock: [remnant('W1', 120, 115, 1, 'L1')],
    lots: [roll('L1', 10)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.piecesCoveredByWaste, 4);   // floor(120/55)*floor(115/55)
  assert.strictEqual(m.freshPieces, 16);
  approx(m.freshMeters, Math.ceil(16 / 2) * 55 / 100);
  assert.strictEqual(m.wastePicks[0].planItemId, 'IT1');
});

test('F3 PIN: order stays on its lot however cheap the others are', () => {
  const data = [sup('S1', [material('M1', {
    requiredPieces: 100, issuedPieces: 54,
    lines: [line('IT1', 100, 54, 'PLAN9', 'L1')],
    lots: [roll('L1', 3), roll('CHEAP', 30)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  m.lotLines.forEach(lt => assert.strictEqual(String(lt.lotId), 'L1'));
  assert.strictEqual(m.orderOutcomes[0].why, 'pinned');
});

test('F4 pin read from SETTLED lines too (the remake-shade bug)', () => {
  const data = [sup('S1', [material('M1', {
    requiredPieces: 4, issuedPieces: 0,
    lines: [line('ORIG', 100, 100, 'PLAN9', 'L1'), line('REMAKE', 4, 0, 'PLAN9', '')],
    lots: [roll('L1', 2), roll('OTHER', 30)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  m.lotLines.forEach(lt => assert.strictEqual(String(lt.lotId), 'L1'));
});

test('F5 dry pin (lot emptied off the payload) -> NOTHING moves until a human decides', () => {
  const data = [sup('S1', [material('M1', {
    requiredPieces: 10, issuedPieces: 6,
    lines: [line('IT1', 10, 6, 'PLAN9', 'DEADLOT')],
    lots: [roll('RICH', 30)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.lotLines.length, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.pinnedDryOrders)), ['PLAN9']);
  assert.ok(m.pinnedDry.indexOf('DEADLOT') !== -1);
});

test('F6 an override rescues the dry pin and records BOTH tones', () => {
  A.clearOverrides();
  const data = [sup('S1', [material('M1', {
    requiredPieces: 10, issuedPieces: 6,
    lines: [line('IT1', 10, 6, 'PLAN9', 'DEADLOT')],
    lots: [roll('NEW', 30)],
  })])];
  A.setOverride('S1|M1|PLAN9', { lotId: 'NEW', note: 'ok by eye' });
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.lotLines.length, 1);
  assert.strictEqual(String(m.lotLines[0].lotId), 'NEW');
  assert.strictEqual(m.lotLines[0].overrideFrom, 'DEADLOT');
  A.clearOverrides();
});

test('F7 blocked pin is unusable even though full', () => {
  const data = [sup('S1', [material('M1', {
    requiredPieces: 10, issuedPieces: 6,
    lines: [line('IT1', 10, 6, 'PLAN9', 'QUAR')],
    lots: [roll('QUAR', 40, { blocked: true })],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.lotLines.length, 0);
  // The blocked-pin state surfaces through the row's short REASON:
  assert.ok(m.shortReason, 'a blocked-pinned row must say why');
  assert.strictEqual(m.shortReason.kind, 'pinnedBlocked');
});

test('F8 two orders one card: second sees what is LEFT; never split, never steal', () => {
  const data = [sup('S1', [material('M1', {
    lines: [line('IT1', 20, 0, 'PLANA'), line('IT2', 20, 0, 'PLANB')],
    requiredPieces: 40,
    lots: [roll('L1', 7.70)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  const a = m.orderOutcomes.find(o => o.planId === 'PLANA');
  const b = m.orderOutcomes.find(o => o.planId === 'PLANB');
  assert.strictEqual(a.why, 'ready'); approx(a.metres, 5.50);
  assert.strictEqual(b.why, 'skipped');
  approx(b.needMetres, 5.50);
  m.lotLines.forEach(lt => assert.notStrictEqual(lt.planId, 'PLANB'));
});

test('F9 two SUPERVISORS both offered the rack - no reservation ledger', () => {
  const mk = id => ({ supervisorId: id, supervisorName: 'x', materials: [material('M1', {
    requiredPieces: 20, issuedPieces: 0, freshMeters: 5.50,
    lines: [line('IT1', 20, 0)], lots: [roll('L1', 6.00)],
  })] });
  const data = [mk('S1'), mk('S2')];
  A.applyLotAllocation(data);
  assert.strictEqual(String(data[0].materials[0].lotLines[0].lotId), 'L1');
  assert.strictEqual(String(data[1].materials[0].lotLines[0].lotId), 'L1');
});

test('F10 within ONE card two orders cannot promise the same metres twice', () => {
  const data = [sup('S1', [material('M1', {
    lines: [line('IT1', 20, 0, 'PLANA'), line('IT2', 20, 0, 'PLANB')],
    requiredPieces: 40,
    lots: [roll('L1', 11.00)],
  })])];
  A.applyLotAllocation(data);
  const oc = data[0].materials[0].orderOutcomes;
  assert.ok(oc.every(o => o.why === 'ready'));
  approx(oc.reduce((a, o) => a + o.metres, 0), 11.00, 0.005);
});

test('F11 afterWash commit: nothing issues today; wash aimed at THE lot', () => {
  const data = [sup('S1', [material('M1', {
    requiredPieces: 20, issuedPieces: 0,
    lines: [line('IT1', 20, 0)],
    lots: [roll('G', 1.10, { unwash: 5.50 })],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.lotLines.length, 0);
  assert.strictEqual(m.orderOutcomes[0].why, 'afterWash');
  assert.strictEqual(m.washLots.length, 1);
  assert.strictEqual(String(m.washLots[0].lotId), 'G');
});

test('F12 pinned lot holding ONLY inWash keeps the pin (wait, never switch)', () => {
  const data = [sup('S1', [material('M1', {
    requiredPieces: 10, issuedPieces: 8,
    lines: [line('IT1', 10, 8, 'PLAN9', 'LAWAY')],
    lots: [roll('LAWAY', 0, { inWash: 12 }), roll('FRESH', 30)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  m.lotLines.forEach(lt => assert.strictEqual(String(lt.lotId), 'LAWAY'));
});

test('F13 declined remnant: allocation drops AND fresh need grows; row kept at zero', () => {
  A.clearDeclined();
  const data = [sup('S1', [material('M1', {
    requiredPieces: 20, issuedPieces: 0, freshMeters: 5.50,
    lines: [line('IT1', 20, 0)],
    wasteStock: [remnant('W1', 120, 115, 1, 'L1')],
    lots: [roll('L1', 10)],
  })])];
  A.setDeclined('W1', 0);
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.piecesCoveredByWaste, 0);
  assert.strictEqual(m.freshPieces, 20);
  approx(m.freshMeters, 5.50);
  assert.strictEqual(m.wastePicks.length, 1);
  assert.strictEqual(m.wastePicks[0].pieces, 0);
  A.clearDeclined();
});

test('F14 pieces-lot end-to-end: per-piece naming travels to the payload', () => {
  const data = [sup('S1', [material('M1', {
    fabricWidthCm: 140, cutWidth: 60,
    requiredPieces: 25, issuedPieces: 0,
    lines: [line('IT1', 25, 0)],
    lots: [pieceLot('LP', [fpiece('p1', 300, 140), fpiece('p2', 300, 140), fpiece('p3', 300, 140)], { wash: 9.00 })],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  assert.strictEqual(m.lotLines.length, 1);
  approx(m.lotLines[0].qty, 9.00, 0.005);
  assert.strictEqual(m.freshPieces, 25);
  const lnP = m.lotLines[0].pieces;
  assert.strictEqual(lnP.length, 3);
  approx(lnP.reduce((a, p) => a + p.count, 0), 3);
});

test('F15a TWO-piece remnant splits across two items of one order', () => {
  const data = [sup('S1', [material('M1', {
    lines: [line('ITA', 4, 0), line('ITB', 4, 0)],
    requiredPieces: 8,
    wasteStock: [remnant('W1', 200, 300, 2, 'L1')],
    lots: [roll('L1', 10)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  // Each piece yields 15 cuts of 55x55; one physical piece per item.
  const keys = JSON.parse(JSON.stringify(m.wastePicks.map(p => p.planItemId))).sort();
  assert.deepStrictEqual(keys, ['ITA', 'ITB'], 'each claim recorded separately');
});

test('F15b a SINGLE-piece remnant serves ONE item whole - surplus is not promised away', () => {
  const data = [sup('S1', [material('M1', {
    lines: [line('ITA', 4, 0), line('ITB', 4, 0)],
    requiredPieces: 8,
    wasteStock: [remnant('W1', 200, 300, 1, 'L1')],
    lots: [roll('L1', 10)],
  })])];
  A.applyLotAllocation(data);
  const m = data[0].materials[0];
  // One piece goes out whole to ITA (4 cuts); ITS tail comes back as offcut.
  // ITB draws fresh cloth rather than double-promising the same physical object.
  const claims = JSON.parse(JSON.stringify(m.wastePicks.filter(p => p.pieces > 0).map(p => p.planItemId)));
  assert.deepStrictEqual(claims, ['ITA']);
  assert.strictEqual(m.freshPieces, 4);
});

console.log('\nPART G - randomized property sweep (real allocator)');

// Seeded PRNG
function mkRnd(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

test('G1 sweep invariants hold over 400 random racks/orders', () => {
  const rnd = mkRnd(2026);
  for (let iter = 0; iter < 400; iter++) {
    const widthCm = [113.03, 120.015, 137.16][Math.floor(rnd() * 3)];
    const cutW = [40, 55][Math.floor(rnd() * 2)];
    const perRow = Math.floor(widthCm / cutW);
    if (perRow < 1) continue;
    const nLots = 1 + Math.floor(rnd() * 3);
    const lots = [];
    for (let i = 0; i < nLots; i++) {
      const wash = Math.round(rnd() * 12 * 100) / 100;
      const unwash = rnd() < 0.3 ? Math.round(rnd() * 8 * 100) / 100 : 0;
      lots.push(roll('L' + i, wash, { unwash }));
    }
    if (rnd() < 0.2) lots[Math.floor(rnd() * lots.length)].blocked = true;
    const nRem = Math.floor(rnd() * 4);
    const rem = [];
    for (let i = 0; i < nRem; i++) {
      rem.push(remnant('W' + i + '_' + iter, cutW + Math.floor(rnd() * 80), 55 + Math.floor(rnd() * 200),
        1 + Math.floor(rnd() * 2), lots[0].lotId));
    }
    const nOrd = 1 + Math.floor(rnd() * 3);
    const lines = [];
    let totReq = 0;
    for (let o = 0; o < nOrd; o++) {
      const pcs = 2 + Math.floor(rnd() * 30);
      totReq += pcs;
      lines.push(line('IT' + o, pcs, 0, 'PL' + o));
    }
    const data = [sup('S1', [material('M' + iter % 7, {
      fabricWidthCm: widthCm, cutWidth: cutW, requiredPieces: totReq,
      lines: lines, wasteStock: rem, lots: lots,
    })])];
    A.applyLotAllocation(data);
    const m = data[0].materials[0];

    // INV 1: every order is either fully served by its chosen lot, committed
    // after-wash, skipped, or pinned-dry - and served orders never promise
    // more pieces than they owe.
    for (const oc of m.orderOutcomes) {
      if (oc.why === 'ready') {
        assert.ok(oc.shortPieces === undefined || oc.shortPieces >= 0);
        const demPcs = oc.pieces;
        const got = m.lotLines.filter(lt => lt.planId === oc.planId)
          .reduce((a, lt) => a + lt.qty, 0);
        assert.ok(got <= oc.needMetres + 0.056, 'over-promised metres for ' + oc.planId);
        assert.ok(demPcs > 0);
      }
      if (oc.why === 'afterWash') assert.strictEqual(oc.metres, 0);
    }
    // INV 2: one lot per order across all lotLines.
    const seen = {};
    for (const lt of m.lotLines) {
      const k = lt.planId;
      if (seen[k] && seen[k] !== String(lt.lotId)) throw new Error('order straddles two lots: ' + k);
      seen[k] = String(lt.lotId);
    }
    // INV 3: no pick exceeds the rack count of its remnant.
    for (const pk of m.wastePicks) {
      const src = rem.find(r => r.wasteId === pk.wasteId);
      if (src && pk.pieces > src.pieces) throw new Error('pick exceeds rack: ' + pk.wasteId);
    }
  }
});

console.log('\n========================================');
console.log('allocator: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}
