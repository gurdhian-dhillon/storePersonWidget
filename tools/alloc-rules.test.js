// BUSINESS-RULE AUDIT of the allocator: the guarantees CLAUDE.md names.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sb = { window: {}, console, JSON, Math, Number, String, Object, Array };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/lot-allocator.js'), 'utf8'), sb);
const { allocateEveryCard, lotFill, round2, chooseLotForOrder, lotOverrides, wasteDeclined } = sb;

let fails = 0;
const check = (n, c, d) => { if (!c) { fails++; console.log('  FAIL ' + n + '  ' + d); } else console.log('  ok   ' + n + (d ? '  ' + d : '')); };

const roll = (id, len, status) => ({ rollId: id, label: id.toUpperCase(), length: len, status: status || 'Available' });
const lot = (id, o) => Object.assign({ lotId: id, lotNumber: id, wash: 0, unwash: 0, inWash: 0, blocked: false, rolls: [], form: 'Roll' }, o);
const card = (sid, mats) => ({ supervisorId: sid, supervisorName: 'S' + sid, materials: mats });
const fabMat = (o) => Object.assign({
  materialId: '9', material: 'Linen', sku: 'RM-9', unit: 'Mtr', isFabric: true,
  fabricWidthCm: 150, lots: [], wasteStock: [], lines: []
}, o);
const line = (o) => Object.assign({ planId: 'p1', planItemId: 'i1', mrqId: 'm1', cutW: 50, cutL: 100, reqPieces: 10, issPieces: 0 }, o);

console.log('=== R1: THE PIN. A remake goes back to the ORIGINAL lot ===');
{
  // Original 100 pieces settled off L2. Remake owes 4. L1 is smaller/readier.
  const m = fabMat({
    lots: [lot('L1', { wash: 500, rolls: [roll('a', 500)] }),
           lot('L2', { wash: 50,  rolls: [roll('b', 50)] })],
    lines: [
      line({ planId: 'p1', planItemId: 'i1', mrqId: 'm1', reqPieces: 100, issPieces: 100, issuedLot: 'L2', issuedLotNo: 'L2' }),
      line({ planId: 'p1', planItemId: 'i2', mrqId: 'm2', reqPieces: 4, issPieces: 0 })
    ]
  });
  allocateEveryCard([card('A', [m])]);
  const lots = (m.lotLines || []).map(l => l.lotId);
  check('remake pinned to L2', lots.length > 0 && lots.every(l => l === 'L2'),
    'lotLines on ' + JSON.stringify(lots) + ' (settled line is the only pin record)');
}

console.log('\n=== R2: pin survives when the lot has ONLY cloth at the wash house ===');
{
  const m = fabMat({
    lots: [lot('L1', { wash: 500, rolls: [roll('a', 500)] }),
           lot('L2', { wash: 0, unwash: 0, inWash: 80, rolls: [] })],
    lines: [line({ reqPieces: 10, issPieces: 2, issuedLot: 'L2', issuedLotNo: 'L2' })]
  });
  allocateEveryCard([card('A', [m])]);
  const usedOther = (m.lotLines || []).some(l => l.lotId !== 'L2');
  check('never silently moved to L1', !usedOther,
    'lotLines=' + JSON.stringify((m.lotLines || []).map(l => l.lotId)) + ' (must wait, not switch tone)');
}

console.log('\n=== R3: a BLOCKED lot is never allocated from ===');
{
  const m = fabMat({
    lots: [lot('L1', { wash: 500, blocked: true, rolls: [roll('a', 500)] })],
    lines: [line({ reqPieces: 10 })]
  });
  allocateEveryCard([card('A', [m])]);
  check('nothing issued off quarantined cloth', (m.lotLines || []).length === 0,
    'lotLines=' + JSON.stringify(m.lotLines));
}

console.log('\n=== R4: a BLOCKED roll inside a good lot is never cut ===');
{
  const m = fabMat({
    lots: [lot('L1', { wash: 500, rolls: [roll('a', 500, 'Blocked'), roll('b', 20)] })],
    lines: [line({ reqPieces: 10, cutW: 50, cutL: 100 })]   // needs 5 rows = 5m
  });
  allocateEveryCard([card('A', [m])]);
  const cut = [].concat.apply([], (m.lotLines || []).map(l => l.rolls || []));
  check('blocked roll untouched', !cut.some(r => r.rollId === 'a'),
    'rolls cut=' + JSON.stringify(cut.map(r => r.rollId)));
}

console.log('\n=== R5: GREIGE NEVER GOES OUT TODAY ===');
{
  // Lot has 0 washed, 500 greige. Order needs 10 pieces.
  const m = fabMat({
    lots: [lot('L1', { wash: 0, unwash: 500, rolls: [roll('a', 500)] })],
    lines: [line({ reqPieces: 10 })]
  });
  allocateEveryCard([card('A', [m])]);
  const issued = (m.lotLines || []).reduce((a, l) => a + (Number(l.qty) || 0), 0);
  check('nothing issued off greige', issued === 0, 'issued=' + issued);
  check('but the lot IS committed (wash asked for)', (m.washLots || []).length > 0 || (m.washQty || 0) > 0,
    'washLots=' + JSON.stringify(m.washLots) + ' washQty=' + m.washQty);
}

console.log('\n=== R6: the ROLL TAIL is stranded — 8+2 is not 10 ===');
{
  // 10m marker (cutL=1000cm). Two rolls of 8 and 2 => only 0 whole rows each...
  // use cutL=500 (5m): roll 8 gives 1 row, roll 2 gives 0.
  const l1 = lot('L1', { wash: 10, rolls: [roll('a', 8), roll('b', 2)] });
  const f = lotFill(l1, [{ cutW: 150, cutL: 500, pieces: 2 }], { fabricWidthCm: 150 }, false);
  check('only the 8m roll yields', f.freshMetres === 5,
    'freshMetres=' + f.freshMetres + ' (a 10m pool would have said 10)');
  check('one piece short', f.shortBy === 1, 'shortBy=' + f.shortBy);
}

console.log('\n=== R7: ORDER IS THE ATOM — never split across two lots ===');
{
  // Two lots of 5m each; order needs 10m. Neither covers whole => skipped.
  const m = fabMat({
    lots: [lot('L1', { wash: 5, rolls: [roll('a', 5)] }),
           lot('L2', { wash: 5, rolls: [roll('b', 5)] })],
    lines: [line({ reqPieces: 10, cutW: 150, cutL: 100 })]   // 10 rows x 1m = 10m
  });
  allocateEveryCard([card('A', [m])]);
  const ids = [...new Set((m.lotLines || []).map(l => l.lotId))];
  check('not split', ids.length <= 1, 'lots used=' + JSON.stringify(ids));
  check('skipped entirely', (m.lotLines || []).length === 0, 'lotLines=' + (m.lotLines || []).length);
}

console.log('\n=== R8: a remnant only serves ITS OWN lot ===');
{
  // Remnant belongs to L2, but the order is pinned to L1.
  const m = fabMat({
    lots: [lot('L1', { wash: 100, rolls: [roll('a', 100)] }),
           lot('L2', { wash: 100, rolls: [roll('b', 100)] })],
    wasteStock: [{ wasteId: 'w1', lotId: 'L2', width: 150, length: 200, pieces: 5 }],
    lines: [line({ reqPieces: 4, cutW: 50, cutL: 100, issPieces: 1, issuedLot: 'L1', issuedLotNo: 'L1' })]
  });
  allocateEveryCard([card('A', [m])]);
  const picks = m.wastePicks || [];
  check('L2 remnant not used on an L1 order', picks.every(p => (Number(p.pieces) || 0) === 0),
    'picks=' + JSON.stringify(picks.map(p => p.wasteId + ':' + p.pieces)));
}

console.log('\n=== R9: WASTE BEFORE FRESH ===');
{
  const l1 = lot('L1', { wash: 100, rolls: [roll('a', 100)] });
  l1.waste = [{ wasteId: 'w1', width: 150, length: 200, pieces: 5 }];
  const f = lotFill(l1, [{ cutW: 50, cutL: 100, pieces: 6 }], { fabricWidthCm: 150 }, false);
  check('remnants used first', f.fromWaste[0] > 0, 'fromWaste=' + f.fromWaste[0] + ' fromFresh=' + f.fromFresh[0]);
  check('fresh only covers the rest', f.fromWaste[0] + f.fromFresh[0] === 6,
    'total=' + (f.fromWaste[0] + f.fromFresh[0]));
}

console.log('\n=== R10: grain is fixed — a narrow remnant is useless ===');
{
  const l1 = lot('L1', { wash: 0, rolls: [] });
  // Remnant 40 wide, cut needs 50 wide. Length is enormous. Must yield 0.
  l1.waste = [{ wasteId: 'w1', width: 40, length: 10000, pieces: 5 }];
  const f = lotFill(l1, [{ cutW: 50, cutL: 100, pieces: 5 }], { fabricWidthCm: 150 }, false);
  check('no yield from a too-narrow remnant', f.fromWaste[0] === 0, 'fromWaste=' + f.fromWaste[0]);
}

console.log('\n=== R11: priority — card 1 takes it, card 2 is measured on the rest ===');
{
  const mk = () => fabMat({
    lots: [lot('L1', { wash: 10, rolls: [roll('a', 10)] })],
    lines: [line({ planId: 'x', reqPieces: 10, cutW: 150, cutL: 100 })]  // wants 10m
  });
  const A = card('A', [mk()]), B = card('B', [mk()]);
  allocateEveryCard([A, B]);
  const qa = (A.materials[0].lotLines || []).reduce((s, l) => s + l.qty, 0);
  const qb = (B.materials[0].lotLines || []).reduce((s, l) => s + l.qty, 0);
  check('A served', qa === 10, 'A=' + qa);
  check('B gets nothing (rack spent)', qb === 0, 'B=' + qb);
  check('total <= rack', qa + qb <= 10, 'total=' + (qa + qb));
}

console.log('\n=== R12: a DECLINED remnant forces fresh cloth to make it up ===');
{
  for (const k in wasteDeclined) delete wasteDeclined[k];
  const mk = () => fabMat({
    lots: [lot('L1', { wash: 100, rolls: [roll('a', 100)] })],
    wasteStock: [{ wasteId: 'w1', lotId: 'L1', width: 150, length: 200, pieces: 5 }],
    lines: [line({ reqPieces: 6, cutW: 50, cutL: 100 })]
  });
  const before = mk();
  allocateEveryCard([card('A', [before])]);
  const mBefore = (before.lotLines || []).reduce((s, l) => s + l.qty, 0);

  wasteDeclined['w1'] = 0;
  const after = mk();
  allocateEveryCard([card('A', [after])]);
  const mAfter = (after.lotLines || []).reduce((s, l) => s + l.qty, 0);
  for (const k in wasteDeclined) delete wasteDeclined[k];

  check('declining a remnant raises the fresh metres', mAfter > mBefore,
    'withRemnant=' + mBefore + ' declined=' + mAfter);
}

console.log('\n=== R13: issPieces already covered => no allocation ===');
{
  const m = fabMat({
    lots: [lot('L1', { wash: 100, rolls: [roll('a', 100)] })],
    lines: [line({ reqPieces: 10, issPieces: 10, issuedLot: 'L1', issuedLotNo: 'L1' })]
  });
  allocateEveryCard([card('A', [m])]);
  check('nothing allocated for a settled line', (m.lotLines || []).length === 0,
    'lotLines=' + JSON.stringify(m.lotLines));
}

console.log('\n=== R14: zero / missing cut geometry never invents cloth ===');
{
  const m = fabMat({
    lots: [lot('L1', { wash: 100, rolls: [roll('a', 100)] })],
    lines: [line({ reqPieces: 10, cutW: 0, cutL: 0 })]
  });
  allocateEveryCard([card('A', [m])]);
  const q = (m.lotLines || []).reduce((s, l) => s + l.qty, 0);
  check('no metres with no geometry', q === 0, 'issued=' + q);
}

console.log('\n=== R15: cut WIDER than the fabric yields nothing ===');
{
  const l1 = lot('L1', { wash: 100, rolls: [roll('a', 100)] });
  const f = lotFill(l1, [{ cutW: 200, cutL: 100, pieces: 5 }], { fabricWidthCm: 150 }, false);
  check('perRow 0 => no cloth cut', f.freshMetres === 0, 'freshMetres=' + f.freshMetres);
  check('all still owed', f.shortBy === 5, 'shortBy=' + f.shortBy);
}

console.log('\n=== R16: TWO EQUAL LOTS — the tone must not depend on row order ===');
{
  // REGRESSION. chooseLotForOrder's `smallest()` used `size < bestSize` alone,
  // which keeps whichever lot arrived first — so the same rack cut the order
  // from a DIFFERENT shade purely because the server returned its rows in a
  // different order. The lot is a tone, the remake is pinned to it for ever, and
  // nothing on screen says a coin was flipped. Broken by the row order the
  // server's `sort by Added_Time` happens to produce; now tie-broken on lot id.
  const runWith = (ids) => {
    const m = fabMat({
      lots: ids.map(id => lot(id, { wash: 30, rolls: [roll(id + 'r', 30)] })),
      lines: [line({ reqPieces: 10, cutW: 150, cutL: 100 })]
    });
    allocateEveryCard([card('A', [m])]);
    return [...new Set((m.lotLines || []).map(l => l.lotId))].join(',');
  };
  const forward = runWith(['L1', 'L2']);
  const reversed = runWith(['L2', 'L1']);
  check('same lot whichever order the rows arrive in', forward === reversed,
    '[L1,L2] chose ' + forward + ' but [L2,L1] chose ' + reversed);
  check('and it is deterministic (lowest id)', forward === 'L1',
    'chose ' + forward);
}

console.log('\n=== R17: the smallest-covering rule still stands ===');
{
  // The tie-break must not have disturbed the actual ranking: big lots stay
  // whole for the big orders that will need them.
  const m = fabMat({
    lots: [lot('BIG', { wash: 500, rolls: [roll('br', 500)] }),
           lot('SMALL', { wash: 30, rolls: [roll('sr', 30)] })],
    lines: [line({ reqPieces: 10, cutW: 150, cutL: 100 })]
  });
  allocateEveryCard([card('A', [m])]);
  const used = [...new Set((m.lotLines || []).map(l => l.lotId))].join(',');
  check('smallest lot that covers it wins', used === 'SMALL', 'used=' + used);
}

console.log('\n' + (fails === 0 ? 'ALL RULES HELD' : fails + ' RULE FAILURE(S)'));
process.exit(fails === 0 ? 0 : 1);
