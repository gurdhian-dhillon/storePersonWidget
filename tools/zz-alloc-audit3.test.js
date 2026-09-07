'use strict';
// Audit harness part 3 — probes for the FIX code itself (kept as regression cover).
//   usage: node tools/zz-alloc-audit3.test.js
// Covers: whole-row split on edit-down, >400 remnant guard, atWash-on-skip,
// rollFree ceilings, pinnedShort per-row accounting.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
const ctx = { console, Math, Number, Object, String, Array, JSON };
vm.createContext(ctx);
vm.runInContext(src + `
this.A = { round2, remnantYield, perRowFor, lotFill, chooseLotForOrder, orderMetres,
  applyLotAllocation, applyFabricOverride, shortReasonFor,
  _clearAll: function(){ for (var k in lotOverrides) delete lotOverrides[k]; for (var k2 in wasteDeclined) delete wasteDeclined[k2]; },
  _setOverride: function(k,v){ lotOverrides[k]=v; },
  _setDeclined: function(k,v){ wasteDeclined[k]=v; }
};`, ctx);
const A = ctx.A;
let PASS = 0, FAIL = 0;
function ok(name, fn) {
  A._clearAll();
  try { fn(); PASS++; console.log('  ok  ' + name); }
  catch (e) { FAIL++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
}
function approx(a, b, eps) {
  eps = eps === undefined ? 1e-6 : eps;
  if (!(Math.abs(a - b) <= eps)) throw new Error('expected ' + b + ' got ' + a);
}
function L(lotId, o) {
  o = o || {};
  const rolls = (o.rolls || []).map((r, i) => ({
    rollId: r.rollId || (lotId + '-R' + (i + 1)),
    label: r.label || (lotId + '-R' + (i + 1)),
    length: Number(r.length !== undefined ? r.length : r) || 0,
    status: r.status || 'Available', origin: r.origin || 'Purchased'
  }));
  const tot = rolls.filter(r => r.status === 'Available').reduce((s, r) => s + r.length, 0);
  return { lotId, lotNumber: o.no || lotId, blocked: !!o.blocked,
    wash: o.wash !== undefined ? o.wash : Math.round(tot * 100) / 100,
    unwash: o.unwash || 0, inWash: o.inWash || 0, form: 'Roll', pieces: [], rolls };
}
function W(wasteId, w, l, pcs, lotId) {
  return { wasteId, width: w, length: l, pieces: pcs, lotId: lotId || '', lot: lotId || '', carton: 'C-1' };
}
function LN(id, req, iss, planId, cutW, cutL, extra) {
  return Object.assign({ planId: planId || 'P1', planItemId: id, reqPieces: req, issPieces: iss || 0,
    cutW: cutW || 55, cutL: cutL || 55, mrqId: 'MRQ-' + id, issuedLot: '', issuedLotNo: '' }, extra || {});
}
function M(mid, o) {
  return Object.assign({ materialId: mid, isFabric: true, sku: 'FAB', unit: 'Mtr', fabricWidthCm: 150,
    cutWidth: 55, cutLength: 55, freshMeters: 0, remaining: 0, availableStock: 0,
    lines: [], wasteStock: [], lots: [], cuts: [] }, o || {});
}
function S(sid, mats) { return { supervisorId: sid, supervisorName: sid, materials: mats }; }

console.log('\n=== AUDIT P: whole-row split on edit-down ===');
ok('P1 two 5m lines of a 1m cut typed to 9m credit NINE rows, not eight', () => {
  // fabric 150, cut 55x100: perRow 2, 1m/row. Two demands 10pcs each = 5m each.
  const l1 = L('L1', { rolls: [{ length: 20 }], wash: 20 });
  const a = LN('A', 10, 0, 'PA', 55, 100);
  const b = LN('B', 10, 0, 'PB', 55, 100);
  const m = M('M1', { fabricWidthCm: 150, lines: [a, b], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  approx(out.autoMetres, 10);
  A.applyFabricOverride(out, 'L1', 9);
  const tot = out.lotLines.reduce((s, l) => s + l.qty, 0);
  const raw = out.lotLines.reduce((s, l) => s + (Number(l.fromRaw) || 0), 0);
  console.log('      typed 9 -> lines=' + JSON.stringify(out.lotLines.map(l => l.qty)) + ' raw=' + raw);
  approx(tot, 9);
  assert.strictEqual(raw, 18, '9 whole rows x 2 per row must credit 18 pieces, got ' + raw);
});
ok('P2 edit-down never credits a piece for a part-row', () => {
  const l1 = L('L1', { rolls: [{ length: 20 }], wash: 20 });
  const a = LN('A', 10, 0, 'PA', 55, 100); // perRow 2, 1m/row
  const m = M('M1', { fabricWidthCm: 150, lines: [a], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  A.applyFabricOverride(out, 'L1', 4.5); // 4 rows + 0.5 stray
  const ln = out.lotLines.filter(l => l.lotId === 'L1');
  const tot = ln.reduce((s, l) => s + l.qty, 0);
  const raw = ln.reduce((s, l) => s + (Number(l.fromRaw) || 0), 0);
  console.log('      typed 4.5 -> tot=' + tot + ' raw=' + raw);
  approx(tot, 4.5, 0.02);
  assert.strictEqual(raw, 8, 'stray 0.5m counts 0 pieces');
});

console.log('\n=== AUDIT Q: remnant guard bound ===');
ok('Q1 450 remnant rows against a 450-piece job allocate it all', () => {
  const fab = { fabricWidthCm: 150 };
  const waste = [];
  for (let i = 0; i < 450; i++) waste.push({ wasteId: 'W' + i, width: 60, length: 110, pieces: 1 });
  // 60x110 remnant for 55x100 cut: 1x1 = 1 piece each -> 450 capacity
  const lot = { wash: 0, unwash: 0, inWash: 0, blocked: false, rolls: [], waste };
  const f = A.lotFill(lot, [{ cutW: 55, cutL: 100, pieces: 450 }], fab, false);
  console.log('      covers=' + f.covers + ' fromWaste=' + f.fromWaste[0] + ' shortBy=' + f.shortBy);
  assert.strictEqual(f.covers, true, 'old constant guard (400) skipped this job entirely');
  assert.strictEqual(f.fromWaste[0], 450);
});

console.log('\n=== AUDIT R: atWash on skipped order ===');
ok('R1 unpinned order skipped while its lot washes in reports atWash, not nofit', () => {
  // L1: 1m washed on a 1m roll + 20m at washer. Order needs 10m.
  // wash gate excludes inWash -> no cover -> skip; but returning wash covers.
  const l1 = L('L1', { rolls: [{ length: 1 }, { length: 25 }], wash: 1, unwash: 0, inWash: 20 });
  const ln = LN('A', 20, 0, 'P1', 55, 100); // 10m
  const m = M('M1', { fabricWidthCm: 150, lines: [ln], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      lotLines=' + out.lotLines.length + ' reason=' + JSON.stringify(out.shortReason));
  assert.strictEqual(out.lotLines.length, 0);
  assert.strictEqual(out.shortReason.kind, 'atWash');
});

console.log('\n=== AUDIT S: rollFree ceilings ===');
ok('S1 second card cannot extend into metres the first card holds', () => {
  // One 20m roll, wash 20. S1 auto ~5m, S2 auto ~5m. S2 typing 20 must clamp
  // at free + own, not at the printed 20.
  const mkLot = () => L('L1', { rolls: [{ label: 'L1-R1', rollId: 'R1', length: 20 }], wash: 20 });
  const m1 = M('M1', { fabricWidthCm: 150, lines: [LN('A', 10, 0, 'PA', 55, 100)], lots: [mkLot()] });
  const m2 = M('M1', { fabricWidthCm: 150, lines: [LN('B', 10, 0, 'PB', 55, 100)], lots: [mkLot()] });
  const data = [S('S1', [m1]), S('S2', [m2])];
  A.applyLotAllocation(data);
  const o2 = data[1].materials[0];
  console.log('      S1 auto=' + data[0].materials[0].autoMetres + ' S2 auto=' + o2.autoMetres + ' rollFree=' + JSON.stringify(o2.rollFree));
  A.applyFabricOverride(o2, 'L1', 20);
  const tot = o2.lotLines.reduce((s, l) => s + l.qty, 0);
  console.log('      S2 typed 20 -> got ' + tot);
  assert.ok(tot < 20 - 0.01, 'must clamp below the printed roll length, got ' + tot);
  assert.ok(o2.lotEditShort && o2.lotEditShort.L1, 'clamp must be recorded');
});
ok('S2 FIXED: rollFree keyed lot|roll, no cross-lot collision', () => {
  // Residual 1, now fixed: the free map is keyed lotId|rollId AND shared by
  // reference across every row of the material, with per-row rollDelta tracking
  // beyond-auto takes — so two rows can no longer each extend into the same
  // unclaimed metres either.
  const l1 = L('L1', { rolls: [{ label: 'L1-R1', rollId: 'R1', length: 10 }], wash: 10 });
  const l2 = L('L2', { rolls: [{ label: 'L2-R1', rollId: 'R1', length: 10 }], wash: 10 });
  const a = LN('A', 8, 0, 'PA', 55, 100, { issuedLot: 'L1', issuedLotNo: 'L1' });
  const b = LN('B', 8, 0, 'PB', 55, 100, { issuedLot: 'L2', issuedLotNo: 'L2' });
  const m = M('M1', { fabricWidthCm: 150, lines: [a, b], lots: [l1, l2] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  console.log('      rollFree=' + JSON.stringify(out.rollFree));
  assert.ok(out.rollFree['L1|R1'] !== undefined && out.rollFree['L2|R1'] !== undefined,
    'one entry per lot|roll, got ' + JSON.stringify(out.rollFree));
});
ok('S3 keystroke re-entrancy: up then down releases, no ratchet', () => {
  // One 20m roll, one row auto 5m. Type 12 (extends +7, charges free), then 8
  // (must release 12's delta first, charge +3), then back to auto (delta gone,
  // free whole again).
  const l1 = L('L1', { rolls: [{ label: 'L1-R1', rollId: 'R1', length: 20 }], wash: 20 });
  const m = M('M1', { fabricWidthCm: 150, lines: [LN('A', 10, 0, 'PA', 55, 100)], lots: [l1] });
  const data = [S('S1', [m])];
  A.applyLotAllocation(data);
  const out = data[0].materials[0];
  const free0 = out.rollFree['L1|R1'];
  A.applyFabricOverride(out, 'L1', 12);
  approx(out.rollFree['L1|R1'], free0 - 7, 0.02);
  A.applyFabricOverride(out, 'L1', 8);
  approx(out.rollFree['L1|R1'], free0 - 3, 0.02);
  const tot = out.lotLines.reduce((s, l) => s + l.qty, 0);
  approx(tot, 8, 0.02);
  A.applyFabricOverride(out, 'L1', out.autoMetres);
  approx(out.rollFree['L1|R1'], free0, 0.02);
  // rollDelta lives in the vm realm, so compare by keys, not deepStrictEqual.
  assert.strictEqual(Object.keys(out.rollDelta).length, 0);
  assert.strictEqual(out.metresEdited, false);
});
ok('S4 cross-row charging: row A extends, row B ceiling shrinks', () => {
  // Plan row + Reissue row, same material/lot/roll. A takes +4 of the free pile;
  // B typing big must clamp 4 lower than before.
  const mkLot = () => L('L1', { rolls: [{ label: 'L1-R1', rollId: 'R1', length: 40 }], wash: 40 });
  const m1 = M('M1', { fabricWidthCm: 150, lines: [LN('A', 8, 0, 'PA', 55, 100)], lots: [mkLot()] });
  const m2 = M('M1', { fabricWidthCm: 150, lines: [LN('B', 8, 0, 'PB', 55, 100)], lots: [mkLot()], isReissue: true });
  const data = [S('S1', [m1, m2])];
  A.applyLotAllocation(data);
  const o1 = data[0].materials[0], o2 = data[0].materials[1];
  assert.strictEqual(o1.rollFree, o2.rollFree, 'one shared object per material');
  // B claims big first to measure the uncontended ceiling, then releases it;
  // A extends +4; B claims big again and must clamp exactly 4 lower.
  A.applyFabricOverride(o2, 'L1', 50);
  const before = o2.lotLines.reduce((s, l) => s + l.qty, 0);
  A.applyFabricOverride(o2, 'L1', o2.autoMetres);
  A.applyFabricOverride(o1, 'L1', o1.autoMetres + 4);
  A.applyFabricOverride(o2, 'L1', 50);
  const after = o2.lotLines.reduce((s, l) => s + l.qty, 0);
  console.log('      B clamp before A extends: ' + before + ', after: ' + after);
  approx(before - after, 4, 0.05);
});

console.log('\n=== AUDIT T: pinnedShort per-row accounting ===');
ok('T1 FIXED: pinnedShort accounted per demand share, not order total', () => {
  // Residual 2, now fixed: each demand contributes owed - waste - fresh on its
  // own row. Row0 (20 owed, 2 covered off L1) reports 18; row1 (20 owed, 0
  // covered) reports 20 — summing to the true 38 instead of 38 + 38.
  const mk = () => M('M1', { fabricWidthCm: 150, lines: [LN('A', 20, 0, 'P1', 55, 100, { issuedLot: 'L1', issuedLotNo: 'L1' })],
    lots: [L('L1', { rolls: [{ length: 1 }], wash: 1 }), L('L2', { rolls: [{ length: 50 }], wash: 50 })] });
  const mm = mk();
  mm.isReissue = true;
  const m1 = mk();
  const data = [S('S1', [m1, mm])];
  A.applyLotAllocation(data);
  console.log('      row0 reason=' + JSON.stringify(data[0].materials[0].shortReason));
  console.log('      row1 reason=' + JSON.stringify(data[0].materials[1].shortReason));
  assert.strictEqual(data[0].materials[0].shortReason.kind, 'pinnedShort');
  assert.strictEqual(data[0].materials[1].shortReason.kind, 'pinnedShort');
  assert.strictEqual(data[0].materials[0].shortReason.lots[0].pieces, 18);
  assert.strictEqual(data[0].materials[1].shortReason.lots[0].pieces, 20);
});

console.log('\n========================================');
console.log('AUDIT3 DONE: ' + PASS + ' passed, ' + FAIL + ' failed');
if (FAIL) process.exit(1);
