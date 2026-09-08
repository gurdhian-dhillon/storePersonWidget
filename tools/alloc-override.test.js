// AUDIT of applyFabricOverride — the hand-typed metres path.
// This is the most stateful code in the allocator: it runs on every keystroke,
// mutates shared ledgers, and its output is what the handover actually sends.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sb = { window: {}, console, JSON, Math, Number, String, Object, Array };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/lot-allocator.js'), 'utf8'), sb);
const { allocateEveryCard, applyFabricOverride, round2 } = sb;

let fails = 0;
const check = (n, c, d) => { if (!c) { fails++; console.log('  FAIL ' + n + '  ' + d); } else console.log('  ok   ' + n + (d ? '  ' + d : '')); };

const roll = (id, len) => ({ rollId: id, label: id.toUpperCase(), length: len, status: 'Available' });
const build = (rollLen, req, cutW, cutL, width) => {
  const m = {
    materialId: '9', material: 'Linen', sku: 'RM-9', unit: 'Mtr', isFabric: true,
    fabricWidthCm: width || 150,
    lots: [{ lotId: 'L1', lotNumber: 'L1', wash: 1000, unwash: 0, inWash: 0, blocked: false,
             rolls: [roll('r1', rollLen)], form: 'Roll' }],
    wasteStock: [],
    lines: [{ planId: 'p1', planItemId: 'i1', mrqId: 'm1',
              cutW: cutW || 150, cutL: cutL || 100, reqPieces: req, issPieces: 0 }]
  };
  const data = [{ supervisorId: 'A', supervisorName: 'A', materials: [m] }];
  allocateEveryCard(data);
  return m;
};

console.log('=== O1: typing the auto figure changes nothing ===');
{
  const m = build(100, 10);          // 10 pieces, 1 per row, 1m each => 10m
  const before = JSON.stringify(m.lotLines);
  applyFabricOverride(m, 'L1', m.autoMetres);
  check('lot lines unchanged', JSON.stringify(m.lotLines) === before,
    'auto=' + m.autoMetres + '\n     before=' + before + '\n     after =' + JSON.stringify(m.lotLines));
}

console.log('\n=== O2: a SHORT edit leaves the requirement open (pieces, not metres) ===');
{
  const m = build(100, 10);          // auto 10m for 10 pieces
  applyFabricOverride(m, 'L1', 6);   // he cuts only 6m => 6 whole rows => 6 pieces
  const q = m.lotLines.reduce((s, l) => s + l.qty, 0);
  const raw = m.lotLines.reduce((s, l) => s + (Number(l.fromRaw) || 0), 0);
  check('metres follow the edit', Math.abs(q - 6) < 0.01, 'metres=' + q);
  check('pieces credited = whole rows only', raw === 6, 'fromRaw=' + raw + ' (must be 6, not 10)');
}

console.log('\n=== O3: a PART row credits 0 pieces for the stray metres ===');
{
  const m = build(100, 10);
  applyFabricOverride(m, 'L1', 6.5);  // 6 whole rows + 0.5 stray
  const q = m.lotLines.reduce((s, l) => s + l.qty, 0);
  const raw = m.lotLines.reduce((s, l) => s + (Number(l.fromRaw) || 0), 0);
  check('metres sent as typed', Math.abs(q - 6.5) < 0.01, 'metres=' + q);
  check('stray part-row credits nothing', raw === 6, 'fromRaw=' + raw);
}

console.log('\n=== O4: OVER-ISSUE — fromRaw is still capped at what is owed ===');
{
  const m = build(100, 10);
  applyFabricOverride(m, 'L1', 25);   // way more than the 10m needed
  const raw = m.lotLines.reduce((s, l) => s + (Number(l.fromRaw) || 0), 0);
  const q = m.lotLines.reduce((s, l) => s + l.qty, 0);
  check('metres follow him', q > 10, 'metres=' + q);
  check('pieces capped at owed', raw <= 10, 'fromRaw=' + raw + ' owed=10');
}

console.log('\n=== O5: THE ROLL CEILING — cannot be edited past the physical roll ===');
{
  const m = build(12, 10);            // roll only 12m long
  applyFabricOverride(m, 'L1', 999);
  const q = m.lotLines.reduce((s, l) => s + l.qty, 0);
  check('clamped to the roll', q <= 12.0001, 'metres=' + q + ' rollLen=12');
}

console.log('\n=== O6: RE-ENTRANCY — typing 20,19,18 must not ratchet the ledger ===');
{
  const m = build(100, 10);
  applyFabricOverride(m, 'L1', 20);
  applyFabricOverride(m, 'L1', 19);
  applyFabricOverride(m, 'L1', 18);
  const after3 = m.lotLines.reduce((s, l) => s + l.qty, 0);

  const m2 = build(100, 10);
  applyFabricOverride(m2, 'L1', 18);   // straight to 18
  const direct = m2.lotLines.reduce((s, l) => s + l.qty, 0);

  check('keystrokes converge to the same answer', Math.abs(after3 - direct) < 0.01,
    'typed 20,19,18 => ' + after3 + '   typed 18 => ' + direct);
}

console.log('\n=== O7: back to auto restores exactly ===');
{
  const m = build(100, 10);
  const auto = JSON.stringify(m.autoLotLines);
  applyFabricOverride(m, 'L1', 3);
  applyFabricOverride(m, 'L1', m.autoMetres);
  const now = JSON.stringify(m.lotLines.map(l => {
    const c = Object.assign({}, l); return c;
  }));
  const q = m.lotLines.reduce((s, l) => s + l.qty, 0);
  check('metres back to auto', Math.abs(q - m.autoMetres) < 0.01,
    'now=' + q + ' auto=' + m.autoMetres);
}

console.log('\n=== O8: TWO ROWS OF ONE MATERIAL cannot both eat the same roll ===');
{
  // A Plan row and a Reissue row on one card, one 20m roll.
  const mk = (isRe) => ({
    materialId: '9', material: 'Linen', sku: 'RM-9', unit: 'Mtr', isFabric: true,
    isReissue: !!isRe, fabricWidthCm: 150,
    lots: [{ lotId: 'L1', lotNumber: 'L1', wash: 1000, unwash: 0, inWash: 0, blocked: false,
             rolls: [roll('r1', 20)], form: 'Roll' }],
    wasteStock: [],
    lines: [{ planId: isRe ? 'p2' : 'p1', planItemId: isRe ? 'i2' : 'i1',
              mrqId: isRe ? 'm2' : 'm1', cutW: 150, cutL: 100, reqPieces: 5, issPieces: 0 }]
  });
  const a = mk(false), b = mk(true);
  const data = [{ supervisorId: 'A', supervisorName: 'A', materials: [a, b] }];
  allocateEveryCard(data);

  // Both rows try to grab the whole roll
  applyFabricOverride(a, 'L1', 20);
  applyFabricOverride(b, 'L1', 20);
  const qa = a.lotLines.reduce((s, l) => s + l.qty, 0);
  const qb = b.lotLines.reduce((s, l) => s + l.qty, 0);
  check('two rows cannot exceed the roll', qa + qb <= 20.0001,
    'rowA=' + qa + ' rowB=' + qb + ' total=' + (qa + qb) + ' roll=20');
}

console.log('\n=== O9: an edit never moves the TONE (lot ids unchanged) ===');
{
  const m = build(100, 10);
  const lotsBefore = m.lotLines.map(l => l.lotId).join(',');
  applyFabricOverride(m, 'L1', 3);
  const lotsAfter = m.lotLines.map(l => l.lotId).join(',');
  check('lot ids unchanged', lotsBefore === lotsAfter, before => 'before=' + lotsBefore + ' after=' + lotsAfter);
}

console.log('\n=== O10: editing 0 issues nothing but keeps the row ===');
{
  const m = build(100, 10);
  applyFabricOverride(m, 'L1', 0);
  const q = m.lotLines.reduce((s, l) => s + l.qty, 0);
  const raw = m.lotLines.reduce((s, l) => s + (Number(l.fromRaw) || 0), 0);
  check('nothing issued', q === 0, 'metres=' + q);
  check('nothing credited', raw === 0, 'fromRaw=' + raw);
}

console.log('\n=== O11: a NEGATIVE edit cannot invent cloth ===');
{
  const m = build(100, 10);
  applyFabricOverride(m, 'L1', -50);
  const q = m.lotLines.reduce((s, l) => s + l.qty, 0);
  const raw = m.lotLines.reduce((s, l) => s + (Number(l.fromRaw) || 0), 0);
  check('metres not negative', q >= 0, 'metres=' + q);
  check('pieces not negative', raw >= 0, 'fromRaw=' + raw);
}

console.log('\n=== O12: MULTI-CUT row — each line keeps its OWN cut geometry ===');
{
  const m = {
    materialId: '9', material: 'Linen', sku: 'RM-9', unit: 'Mtr', isFabric: true,
    fabricWidthCm: 150,
    lots: [{ lotId: 'L1', lotNumber: 'L1', wash: 1000, unwash: 0, inWash: 0, blocked: false,
             rolls: [roll('r1', 500)], form: 'Roll' }],
    wasteStock: [],
    lines: [
      { planId: 'p1', planItemId: 'i1', mrqId: 'm1', cutW: 150, cutL: 100, reqPieces: 4, issPieces: 0 },
      { planId: 'p1', planItemId: 'i1', mrqId: 'm2', cutW: 75,  cutL: 200, reqPieces: 4, issPieces: 0 }
    ]
  };
  allocateEveryCard([{ supervisorId: 'A', supervisorName: 'A', materials: [m] }]);
  const byMrq = {};
  m.lotLines.forEach(l => { byMrq[l.mrqId] = l; });
  check('both requirement rows got their own line', !!byMrq.m1 && !!byMrq.m2,
    'mrqIds=' + JSON.stringify(m.lotLines.map(l => l.mrqId)));
  if (byMrq.m1 && byMrq.m2) {
    check('m1 keeps 150x100', byMrq.m1.cutW === 150 && byMrq.m1.cutL === 100,
      'm1=' + byMrq.m1.cutW + 'x' + byMrq.m1.cutL);
    check('m2 keeps 75x200', byMrq.m2.cutW === 75 && byMrq.m2.cutL === 200,
      'm2=' + byMrq.m2.cutW + 'x' + byMrq.m2.cutL);
    // m1: 4 pieces at 1/row, 1m => 4m. m2: 75 wide => 2/row, 2 rows of 2m => 4m
    check('m1 metres', Math.abs(byMrq.m1.qty - 4) < 0.01, 'm1 qty=' + byMrq.m1.qty);
    check('m2 metres', Math.abs(byMrq.m2.qty - 4) < 0.01, 'm2 qty=' + byMrq.m2.qty);
  }
}

console.log('\n' + (fails === 0 ? 'ALL OVERRIDE CHECKS HELD' : fails + ' FAILURE(S)'));
process.exit(fails === 0 ? 0 : 1);
