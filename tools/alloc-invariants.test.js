// PROPERTY / INVARIANT AUDIT of the real lot-allocator.
//
// Randomised racks and demand sets, checking the invariants the app's
// correctness actually rests on. Anything that fails here is a real bug.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sandbox = { window: {}, console, JSON, Math, Number, String, Object, Array };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/lot-allocator.js'), 'utf8'), sandbox);

const { lotFill, allocateEveryCard, round2, perRowFor, remnantYield, chooseLotForOrder } = sandbox;

// ---- deterministic RNG so a failure is reproducible ----
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }

let fails = 0;
const bad = [];
function check(name, cond, detail) {
  if (!cond) { fails++; bad.push(name + ' :: ' + detail); }
}

// ============================================================
console.log('=== INVARIANT 1: lotFill never cuts more than a roll holds ===');
// ============================================================
for (let t = 0; t < 3000; t++) {
  const fab = { fabricWidthCm: ri(100, 300) };
  const rolls = [];
  const nR = ri(1, 5);
  for (let i = 0; i < nR; i++) {
    rolls.push({ rollId: 'r' + i, label: 'R' + i, length: round2(ri(1, 60) + rnd()), status: 'Available' });
  }
  const waste = [];
  for (let i = 0, n = ri(0, 3); i < n; i++) {
    waste.push({ wasteId: 'w' + i, width: ri(20, 200), length: ri(20, 200), pieces: ri(1, 4) });
  }
  const lot = {
    lotId: 'L1', lotNumber: 'L1',
    wash: round2(ri(0, 200) + rnd()), unwash: round2(ri(0, 100)),
    inWash: 0, rolls, waste
  };
  const demands = [];
  for (let i = 0, n = ri(1, 3); i < n; i++) {
    demands.push({ cutW: ri(20, 200), cutL: ri(20, 200), pieces: ri(1, 40) });
  }
  const greige = rnd() < 0.5;
  const f = lotFill(lot, demands, fab, greige);

  // Per-roll: metres taken must not exceed that roll's original length
  const took = {};
  (f.rollLinesPer || []).forEach(pd => (pd || []).forEach(rl => {
    took[rl.rollId] = round2((took[rl.rollId] || 0) + rl.metres);
  }));
  rolls.forEach(r => {
    const t2 = took[r.rollId] || 0;
    check('roll overcut', t2 <= r.length + 0.0001,
      `roll ${r.rollId} len=${r.length} took=${t2} seedTrial=${t}`);
  });

  // Total fresh metres must equal the sum of the roll lines
  const sumLines = round2(Object.keys(took).reduce((a, k) => a + took[k], 0));
  check('freshMetres != sum(rollLines)', Math.abs(sumLines - f.freshMetres) < 0.02,
    `fresh=${f.freshMetres} sumLines=${sumLines} trial=${t}`);

  // The wash gate must bound total fresh metres
  const gate = greige ? round2(lot.wash + lot.unwash) : lot.wash;
  check('wash gate exceeded', f.freshMetres <= gate + 0.0001,
    `fresh=${f.freshMetres} gate=${gate} trial=${t}`);

  // Never place more pieces than demanded
  demands.forEach((d, i) => {
    const placed = f.fromWaste[i] + f.fromFresh[i];
    check('over-placed pieces', placed <= d.pieces,
      `demand ${i} wanted ${d.pieces} placed ${placed} trial=${t}`);
  });

  // covers === nothing owing
  const owing = demands.reduce((a, d, i) => a + (d.pieces - f.fromWaste[i] - f.fromFresh[i]), 0);
  check('covers disagrees with owing', f.covers === (owing <= 0),
    `covers=${f.covers} owing=${owing} trial=${t}`);
  check('shortBy wrong', f.shortBy === Math.max(0, owing) || owing < 0,
    `shortBy=${f.shortBy} owing=${owing} trial=${t}`);

  // Remnant picks must not exceed what is on the rack
  Object.keys(f.picks).forEach(wid => {
    const src = waste.filter(w => w.wasteId === wid)[0];
    check('remnant overdrawn', src && f.picks[wid] <= src.pieces,
      `waste ${wid} rack=${src && src.pieces} took=${f.picks[wid]} trial=${t}`);
  });

  // Pieces credited from waste must be physically yieldable
  demands.forEach((d, i) => {
    let cap = 0;
    Object.keys(f.picksPer[i] || {}).forEach(wid => {
      const src = waste.filter(w => w.wasteId === wid)[0];
      if (src) cap += remnantYield(src, d.cutW, d.cutL) * f.picksPer[i][wid];
    });
    check('waste credit exceeds yield', f.fromWaste[i] <= cap,
      `demand ${i} fromWaste=${f.fromWaste[i]} yieldCap=${cap} trial=${t}`);
  });

  // Fresh pieces must be justified by the marker rows actually cut
  demands.forEach((d, i) => {
    const pr = perRowFor(fab, d.cutW);
    const metres = f.metresPer[i];
    if (pr <= 0 || !(d.cutL > 0)) {
      check('fresh with no geometry', f.fromFresh[i] === 0,
        `demand ${i} fromFresh=${f.fromFresh[i]} pr=${pr} trial=${t}`);
      return;
    }
    const rowsCut = Math.floor((metres * 100 + 0.01) / d.cutL);
    check('fresh pieces exceed rows cut', f.fromFresh[i] <= rowsCut * pr,
      `demand ${i} fromFresh=${f.fromFresh[i]} rows=${rowsCut} perRow=${pr} m=${metres} trial=${t}`);
  });

  // rollsAfter must reconcile: original - took === after
  (f.rollsAfter || []).forEach(ra => {
    const orig = rolls.filter(r => String(r.rollId) === String(ra.rollId))[0];
    if (!orig) return;
    const expect = round2(orig.length - (took[ra.rollId] || 0));
    check('rollsAfter mismatch', Math.abs(expect - ra.length) < 0.02,
      `roll ${ra.rollId} expect=${expect} got=${ra.length} trial=${t}`);
  });

  // PURITY: the input lot must not be mutated
  rolls.forEach((r, i) => {
    check('lotFill mutated input roll', true, ''); // placeholder, checked below
  });
}
console.log(fails === 0 ? '   all invariants held' : '   ' + fails + ' violations');

// ============================================================
console.log('\n=== INVARIANT 2: lotFill is PURE (input payload untouched) ===');
// ============================================================
{
  const before = {
    lotId: 'L1', lotNumber: 'L1', wash: 100, unwash: 50, inWash: 0,
    rolls: [{ rollId: 'r1', label: 'R1', length: 40, status: 'Available' },
            { rollId: 'r2', label: 'R2', length: 30, status: 'Available' }],
    waste: [{ wasteId: 'w1', width: 150, length: 150, pieces: 3 }]
  };
  const snap = JSON.stringify(before);
  lotFill(before, [{ cutW: 50, cutL: 50, pieces: 30 }], { fabricWidthCm: 150 }, true);
  check('lotFill mutated its lot', JSON.stringify(before) === snap,
    'lot changed:\n  before=' + snap + '\n  after =' + JSON.stringify(before));
  console.log(JSON.stringify(before) === snap ? '   pure' : '   *** MUTATED ***');
}

// ============================================================
console.log('\n=== INVARIANT 3: conservation across cards (nothing issued twice) ===');
// ============================================================
for (let t = 0; t < 800; t++) {
  const matId = '9';
  const width = ri(120, 200);
  const nLots = ri(1, 3);
  const lots = [];
  for (let i = 0; i < nLots; i++) {
    const rolls = [];
    for (let r = 0, n = ri(1, 3); r < n; r++) {
      rolls.push({ rollId: 'L' + i + 'r' + r, label: 'R' + r, length: round2(ri(5, 50)), status: 'Available' });
    }
    lots.push({ lotId: 'L' + i, lotNumber: 'L' + i,
      wash: round2(ri(0, 120)), unwash: round2(ri(0, 60)), inWash: 0, rolls, blocked: false });
  }
  const wasteStock = [];
  for (let i = 0, n = ri(0, 3); i < n; i++) {
    wasteStock.push({ wasteId: 'w' + i, lotId: 'L' + ri(0, nLots - 1),
      width: ri(40, 160), length: ri(40, 160), pieces: ri(1, 3) });
  }

  const mkCard = (sid, nOrders) => {
    const lines = [];
    for (let o = 0; o < nOrders; o++) {
      lines.push({ planId: sid + '-p' + o, planItemId: sid + '-i' + o, mrqId: sid + '-m' + o,
        cutW: ri(30, 150), cutL: ri(30, 150),
        reqPieces: ri(1, 25), issPieces: 0 });
    }
    return { supervisorId: sid, supervisorName: 'S' + sid, materials: [{
      materialId: matId, material: 'Linen', sku: 'RM-9', unit: 'Mtr', isFabric: true,
      fabricWidthCm: width,
      lots: JSON.parse(JSON.stringify(lots)),
      wasteStock: JSON.parse(JSON.stringify(wasteStock)),
      lines
    }] };
  };
  const data = [mkCard('A', ri(1, 3)), mkCard('B', ri(1, 3)), mkCard('C', ri(1, 2))];
  const rackSnapshot = JSON.stringify({ lots, wasteStock });

  allocateEveryCard(data);

  // Total metres allocated per (lot, roll) must not exceed the roll's length
  const perRoll = {};
  const perWaste = {};
  data.forEach(sup => sup.materials.forEach(m => {
    (m.lotLines || []).forEach(ln => {
      (ln.rolls || []).forEach(rl => {
        const k = ln.lotId + '|' + rl.rollId;
        perRoll[k] = round2((perRoll[k] || 0) + rl.metres);
      });
    });
    (m.wastePicks || []).forEach(p => {
      perWaste[p.wasteId] = (perWaste[p.wasteId] || 0) + (Number(p.pieces) || 0);
    });
  }));
  lots.forEach(l => (l.rolls || []).forEach(r => {
    const k = l.lotId + '|' + r.rollId;
    check('CROSS-CARD roll over-issued', (perRoll[k] || 0) <= r.length + 0.0001,
      `roll ${k} len=${r.length} allocated=${perRoll[k]} trial=${t}`);
  }));
  wasteStock.forEach(w => {
    check('CROSS-CARD remnant over-issued', (perWaste[w.wasteId] || 0) <= w.pieces,
      `waste ${w.wasteId} rack=${w.pieces} allocated=${perWaste[w.wasteId]} trial=${t}`);
  });

  // Per-lot washed metres must not be over-spent
  const perLot = {};
  data.forEach(sup => sup.materials.forEach(m => (m.lotLines || []).forEach(ln => {
    perLot[ln.lotId] = round2((perLot[ln.lotId] || 0) + (Number(ln.qty) || 0));
  })));
  lots.forEach(l => {
    check('CROSS-CARD lot washed over-spent', (perLot[l.lotId] || 0) <= l.wash + 0.0001,
      `lot ${l.lotId} wash=${l.wash} issued=${perLot[l.lotId]} trial=${t}`);
  });

  // The server payload must be untouched
  check('allocateEveryCard mutated the rack', JSON.stringify({ lots, wasteStock }) === rackSnapshot,
    'rack changed on trial ' + t);

  // ONE LOT PER ORDER — the tone guarantee
  const lotByOrder = {};
  data.forEach(sup => sup.materials.forEach(m => (m.lotLines || []).forEach(ln => {
    const o = String(ln.planId || '');
    if (!o) return;
    if (lotByOrder[o] === undefined) lotByOrder[o] = String(ln.lotId);
    check('ORDER SPLIT ACROSS TWO LOTS', lotByOrder[o] === String(ln.lotId),
      `order ${o} on ${lotByOrder[o]} and ${ln.lotId} trial=${t}`);
  })));
}
console.log('   done');

// ============================================================
console.log('\n=== INVARIANT 4: idempotence / re-run stability ===');
// ============================================================
for (let t = 0; t < 300; t++) {
  // Draw the randomness ONCE, then build two identical datasets from it —
  // otherwise the two differ by construction and the test proves nothing.
  const cutW = ri(30, 140), cutL = ri(30, 140), req = ri(1, 30);
  const mk = () => ({ supervisorId: 'A', supervisorName: 'A', materials: [{
    materialId: '9', material: 'L', sku: 'RM-9', unit: 'Mtr', isFabric: true,
    fabricWidthCm: 150,
    lots: [{ lotId: 'L1', lotNumber: 'L1', wash: 100, unwash: 40, inWash: 0, blocked: false,
      rolls: [{ rollId: 'r1', label: 'R1', length: 40, status: 'Available' },
              { rollId: 'r2', label: 'R2', length: 25, status: 'Available' }] }],
    wasteStock: [{ wasteId: 'w1', lotId: 'L1', width: 120, length: 120, pieces: 2 }],
    lines: [{ planId: 'p1', planItemId: 'i1', mrqId: 'm1', cutW: cutW, cutL: cutL,
              reqPieces: req, issPieces: 0 }]
  }] });
  const d1 = [mk()], d2 = [mk()];
  allocateEveryCard(d1);
  allocateEveryCard(d2);
  allocateEveryCard(d2);   // twice
  check('not idempotent', JSON.stringify(d1[0].materials[0].lotLines) === JSON.stringify(d2[0].materials[0].lotLines),
    'trial=' + t + '\n  once=' + JSON.stringify(d1[0].materials[0].lotLines) +
    '\n  twice=' + JSON.stringify(d2[0].materials[0].lotLines));
}
console.log('   done');

console.log('\n================ RESULT ================');
if (fails === 0) console.log('ALL INVARIANTS HELD');
else {
  console.log(fails + ' VIOLATIONS. First 15 distinct:');
  const seen = {};
  bad.forEach(b => {
    const k = b.split(' :: ')[0];
    if (seen[k]) return; seen[k] = 1;
    console.log('  * ' + b);
  });
}
process.exit(fails === 0 ? 0 : 1);
