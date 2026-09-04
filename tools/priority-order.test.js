#!/usr/bin/env node
// Phase B, Piece 2 — the DEFAULT supervisor priority order.
//
// The order stock is reserved down. Four rungs, each one only reached when the
// one above ties:
//   1. best source RANK the supervisor holds (Priority_Key / 1000000)
//   2. tie -> MORE plans at that best rank wins
//   3. tie -> EARLIEST Plan_Start_Date among plans AT THAT RANK
//      (falls back to the key's sequence half when a plan has no date)
//   4. tie -> supervisor name, so two loads never disagree
//
// Every case below is hand-worked in its comment before the assertion.
//
//   usage: node tools/priority-order.test.js

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

// ---- extract the two functions from main.js -----------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');
function extract(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has function ' + name +
    ' — update tools/priority-order.test.js');
  let depth = 0, j = mainSrc.indexOf('{', i);
  for (let k = j; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i, j);
}
const sandbox = { console, Math, Number, String, Object, Array, isFinite, Infinity };
vm.createContext(sandbox);
vm.runInContext(
  extract('priorityRankOf') + '\n' + extract('defaultPriorityOrder') +
  '\nthis.defaultPriorityOrder = defaultPriorityOrder;' +
  '\nthis.priorityRankOf = priorityRankOf;',
  sandbox);
const defaultPriorityOrder = sandbox.defaultPriorityOrder;
const priorityRankOf = sandbox.priorityRankOf;

// ---- fixture builders ----------------------------------------------------------
// Priority_Key = rank * 1000000 + sequence. Ranks (from the app's order sources):
const SHOPIFY = 1, FAIRE = 2, CUSTOM = 3, PR = 4;
function key(rank, seq) { return rank * 1000000 + seq; }

// A supervisor block. `plans` is [{ planId, rank, seq, start }]; each plan is
// spread across TWO materials so the dedupe-by-plan path is always exercised —
// counting lines instead of plans would double every count.
function sup(id, name, plans) {
  const lineFor = (p) => ({
    planId: p.planId,
    priorityKey: p.rank === null ? '' : key(p.rank, p.seq === undefined ? 1 : p.seq),
    planStartDate: p.start || ''
  });
  return {
    supervisorId: id,
    supervisorName: name,
    materials: [
      { materialId: 'M1', lines: plans.map(lineFor) },
      { materialId: 'M2', lines: plans.map(lineFor) }
    ]
  };
}

// =====================================================================
console.log('\nRUNG 0 — priorityRankOf');

test('R0a rank is the top half of the key', () => {
  assert.strictEqual(priorityRankOf(key(SHOPIFY, 7)), 1);
  assert.strictEqual(priorityRankOf(key(FAIRE, 999999)), 2);
  assert.strictEqual(priorityRankOf(key(PR, 1)), 4);
});
test('R0b empty / zero / junk key sorts LAST, never first', () => {
  assert.strictEqual(priorityRankOf(''), Infinity);
  assert.strictEqual(priorityRankOf(0), Infinity);
  assert.strictEqual(priorityRankOf(undefined), Infinity);
  assert.strictEqual(priorityRankOf('abc'), Infinity);
  // A plan created before Priority_Key existed must not outrank a real Shopify
  // order by accident — this is the "backfill or it sorts to one end" trap.
  assert.ok(priorityRankOf('') > priorityRankOf(key(PR, 1)));
});

// =====================================================================
console.log('\nRUNG 1 — best source rank');

test('R1a straight source order: Shopify > Faire > Custom > PR', () => {
  // Each holds exactly one plan, one source. Pure rung 1.
  const data = [
    sup('S-PR', 'Dave', [{ planId: 'p1', rank: PR }]),
    sup('S-CUS', 'Carol', [{ planId: 'p2', rank: CUSTOM }]),
    sup('S-SHOP', 'Alice', [{ planId: 'p3', rank: SHOPIFY }]),
    sup('S-FAIRE', 'Bob', [{ planId: 'p4', rank: FAIRE }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data),
    ['S-SHOP', 'S-FAIRE', 'S-CUS', 'S-PR']);
});

test('R1b BEST rank wins, not the average or the worst', () => {
  // Alice: one Shopify + three PR   -> best rank 1
  // Bob:   four Faire               -> best rank 2
  // Alice ranks at SHOPIFY however much PR work she is also carrying.
  const data = [
    sup('B', 'Bob', [
      { planId: 'b1', rank: FAIRE }, { planId: 'b2', rank: FAIRE },
      { planId: 'b3', rank: FAIRE }, { planId: 'b4', rank: FAIRE }
    ]),
    sup('A', 'Alice', [
      { planId: 'a1', rank: SHOPIFY },
      { planId: 'a2', rank: PR }, { planId: 'a3', rank: PR }, { planId: 'a4', rank: PR }
    ])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['A', 'B']);
});

test('R1c a supervisor with NO plans at all sorts last, does not crash', () => {
  const data = [
    { supervisorId: 'EMPTY', supervisorName: 'Zoe', materials: [] },
    sup('S1', 'Alice', [{ planId: 'p1', rank: PR }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['S1', 'EMPTY']);
});

// =====================================================================
console.log('\nRUNG 2 — count at the best rank');

test('R2a same best rank -> MORE plans at that rank wins', () => {
  // Both best at Shopify. Alice 3 Shopify, Bob 1 Shopify.
  const data = [
    sup('B', 'Bob', [{ planId: 'b1', rank: SHOPIFY }]),
    sup('A', 'Alice', [
      { planId: 'a1', rank: SHOPIFY }, { planId: 'a2', rank: SHOPIFY },
      { planId: 'a3', rank: SHOPIFY }
    ])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['A', 'B']);
});

test('R2b the count is AT THE BEST RANK ONLY — lower-rank plans do not pad it', () => {
  // Alice: 1 Shopify + 9 PR  -> best rank 1, count AT BEST = 1
  // Bob:   2 Shopify         -> best rank 1, count AT BEST = 2
  // Bob wins. Alice's nine PR orders are irrelevant to the tie-break.
  const alicePlans = [{ planId: 'a1', rank: SHOPIFY }];
  for (let i = 0; i < 9; i++) alicePlans.push({ planId: 'ap' + i, rank: PR });
  const data = [
    sup('A', 'Alice', alicePlans),
    sup('B', 'Bob', [{ planId: 'b1', rank: SHOPIFY }, { planId: 'b2', rank: SHOPIFY }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['B', 'A']);
});

test('R2c count is PLANS not LINES — a plan on many materials counts once', () => {
  // Alice: ONE Shopify plan, but the fixture spreads every plan across two
  // materials, so a line-count would read 2. Bob has TWO real Shopify plans
  // (4 lines). Bob must win; if the dedupe broke, Alice would read 2 v 4 and
  // still lose — so make it sharper: Alice one plan on TEN materials.
  const aliceLine = { planId: 'a1', priorityKey: key(SHOPIFY, 1), planStartDate: '' };
  const alice = {
    supervisorId: 'A', supervisorName: 'Alice',
    materials: []
  };
  for (let i = 0; i < 10; i++) {
    alice.materials.push({ materialId: 'M' + i, lines: [aliceLine] });
  }
  const data = [
    alice,
    sup('B', 'Bob', [{ planId: 'b1', rank: SHOPIFY }, { planId: 'b2', rank: SHOPIFY }])
  ];
  // Alice: 1 plan across 10 materials = 10 lines. Bob: 2 plans = 4 lines.
  // Counting lines -> Alice 10 wins (WRONG). Counting plans -> Bob 2 v 1 wins.
  assert.deepStrictEqual(defaultPriorityOrder(data), ['B', 'A']);
});

// =====================================================================
console.log('\nRUNG 3 — earliest plan start');

test('R3a same rank, same count -> EARLIEST start wins', () => {
  const data = [
    sup('B', 'Bob', [{ planId: 'b1', rank: SHOPIFY, start: '2026-03-01' }]),
    sup('A', 'Alice', [{ planId: 'a1', rank: SHOPIFY, start: '2026-01-15' }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['A', 'B']);
});

test('R3b earliest is taken AT THE BEST RANK ONLY', () => {
  // Both best at Shopify with 1 Shopify plan each.
  //   Alice: Shopify 2026-05-01, plus an ancient PR from 2020
  //   Bob:   Shopify 2026-02-01
  // Bob's Shopify is older than Alice's Shopify, so Bob wins. Alice's 2020 PR
  // must NOT drag her forward.
  const data = [
    sup('A', 'Alice', [
      { planId: 'a1', rank: SHOPIFY, start: '2026-05-01' },
      { planId: 'a2', rank: PR, start: '2020-01-01' }
    ]),
    sup('B', 'Bob', [{ planId: 'b1', rank: SHOPIFY, start: '2026-02-01' }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['B', 'A']);
});

test('R3c a supervisor WITH a date beats one with none, at the same rank+count', () => {
  const data = [
    sup('NODATE', 'Bob', [{ planId: 'b1', rank: SHOPIFY, start: '' }]),
    sup('DATED', 'Alice', [{ planId: 'a1', rank: SHOPIFY, start: '2026-01-01' }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['DATED', 'NODATE']);
});

test('R3d neither has a date -> falls back to the key SEQUENCE (plan age)', () => {
  // No Plan_Start_Date on either (pre-backfill plans). The sequence half of
  // Priority_Key carries age: lower seq = older = first.
  const data = [
    sup('LATER', 'Bob', [{ planId: 'b1', rank: SHOPIFY, seq: 900, start: '' }]),
    sup('OLDER', 'Alice', [{ planId: 'a1', rank: SHOPIFY, seq: 12, start: '' }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['OLDER', 'LATER']);
});

// =====================================================================
console.log('\nRUNG 4 — deterministic last resort');

test('R4a identical on every rung -> supervisor NAME breaks it', () => {
  const data = [
    sup('S-Z', 'Zoe', [{ planId: 'z1', rank: SHOPIFY, seq: 5, start: '2026-01-01' }]),
    sup('S-A', 'Alice', [{ planId: 'a1', rank: SHOPIFY, seq: 5, start: '2026-01-01' }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['S-A', 'S-Z']);
});

test('R4b the order is STABLE — same input, same output, every time', () => {
  const build = () => [
    sup('S-Z', 'Zoe', [{ planId: 'z1', rank: SHOPIFY, seq: 5, start: '2026-01-01' }]),
    sup('S-A', 'Alice', [{ planId: 'a1', rank: SHOPIFY, seq: 5, start: '2026-01-01' }]),
    sup('S-M', 'Mia', [{ planId: 'm1', rank: SHOPIFY, seq: 5, start: '2026-01-01' }])
  ];
  const first = defaultPriorityOrder(build());
  for (let i = 0; i < 20; i++) {
    assert.deepStrictEqual(defaultPriorityOrder(build()), first);
  }
});

// =====================================================================
console.log('\nPURITY + shape');

test('P1 does not mutate the input', () => {
  const data = [
    sup('B', 'Bob', [{ planId: 'b1', rank: FAIRE }]),
    sup('A', 'Alice', [{ planId: 'a1', rank: SHOPIFY }])
  ];
  const before = JSON.stringify(data);
  defaultPriorityOrder(data);
  assert.strictEqual(JSON.stringify(data), before,
    'defaultPriorityOrder must not reorder or edit the array it is given');
});

test('P2 returns every supervisor exactly once', () => {
  const data = [
    sup('A', 'Alice', [{ planId: 'a1', rank: SHOPIFY }]),
    sup('B', 'Bob', [{ planId: 'b1', rank: FAIRE }]),
    sup('C', 'Carol', [{ planId: 'c1', rank: CUSTOM }]),
    { supervisorId: 'D', supervisorName: 'Dave', materials: [] }
  ];
  const out = defaultPriorityOrder(data);
  assert.strictEqual(out.length, 4);
  assert.deepStrictEqual(out.slice().sort(), ['A', 'B', 'C', 'D']);
});

test('P3 empty / missing input does not throw', () => {
  // Length, not deepStrictEqual. The other cases here pass an array built in
  // THIS realm, and `.map()` on it returns one from this realm too — so
  // deepStrictEqual is happy. The null/undefined path is the exception: it hits
  // `(data || [])`, an array literal evaluated INSIDE the vm sandbox, whose
  // Array constructor is a different object. Same structure, different realm,
  // deepStrictEqual refuses it. Nothing is wrong with the function.
  assert.strictEqual(defaultPriorityOrder([]).length, 0);
  assert.strictEqual(defaultPriorityOrder(null).length, 0);
  assert.strictEqual(defaultPriorityOrder(undefined).length, 0);
});

test('P4 a line with no planId is ignored, not counted as a plan', () => {
  // Alice has one real Shopify plan plus a junk line. Bob has two real ones.
  const alice = {
    supervisorId: 'A', supervisorName: 'Alice',
    materials: [{ materialId: 'M1', lines: [
      { planId: 'a1', priorityKey: key(SHOPIFY, 1), planStartDate: '' },
      { planId: '',   priorityKey: key(SHOPIFY, 2), planStartDate: '' }
    ] }]
  };
  const data = [
    alice,
    sup('B', 'Bob', [{ planId: 'b1', rank: SHOPIFY }, { planId: 'b2', rank: SHOPIFY }])
  ];
  // Alice must count 1, not 2 -> Bob wins on rung 2.
  assert.deepStrictEqual(defaultPriorityOrder(data), ['B', 'A']);
});

// =====================================================================
console.log('\nREAL SHAPE — the four-source shop');

test('X1 the shop as described: 4 supervisors, one source each', () => {
  // "shopify > faire > custom > pr is the priority order" — the stated default.
  const data = [
    sup('S3', 'Carol', [{ planId: 'c1', rank: CUSTOM, start: '2026-02-01' }]),
    sup('S1', 'Alice', [{ planId: 'a1', rank: SHOPIFY, start: '2026-02-01' }]),
    sup('S4', 'Dave', [{ planId: 'd1', rank: PR, start: '2026-02-01' }]),
    sup('S2', 'Bob', [{ planId: 'b1', rank: FAIRE, start: '2026-02-01' }])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['S1', 'S2', 'S3', 'S4']);
});

test('X2 after a manual reassignment gives one supervisor two sources', () => {
  // The case that made rungs 2 and 3 necessary. Alice was handed a Faire order
  // on top of her Shopify work; Bob is pure Shopify with more of them.
  //   Alice: 1 Shopify (2026-04-01) + 2 Faire  -> best 1, count 1
  //   Bob:   2 Shopify (2026-06-01)            -> best 1, count 2
  // Rung 2 settles it for Bob before the dates are even looked at.
  const data = [
    sup('A', 'Alice', [
      { planId: 'a1', rank: SHOPIFY, start: '2026-04-01' },
      { planId: 'a2', rank: FAIRE, start: '2026-01-01' },
      { planId: 'a3', rank: FAIRE, start: '2026-01-02' }
    ]),
    sup('B', 'Bob', [
      { planId: 'b1', rank: SHOPIFY, start: '2026-06-01' },
      { planId: 'b2', rank: SHOPIFY, start: '2026-06-02' }
    ])
  ];
  assert.deepStrictEqual(defaultPriorityOrder(data), ['B', 'A']);
});

// ----------------------------------------------------------------------------
console.log('\n========================================');
console.log('priority-order: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { failures.forEach(f => console.log('  - ' + f.name + ': ' + f.msg)); process.exit(1); }
