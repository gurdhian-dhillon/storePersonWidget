#!/usr/bin/env node
// Front-half pipeline verification: order sync -> planning -> the store issue
// screen -> what the issue ledger accepts.
//
//   usage: node tools/pipeline.test.js
//
// Ports the DECISION LOGIC of deluge/createProductionPlans.dg and
// deluge/syncSingleSalesOrder.dg faithfully (same guards, same order, same
// failure shapes) over an in-memory form model, then drives the REAL widget
// allocator and the issue-ledger port from tools/deluge-maths.test.js through
// an end-to-end parity pass. Line references cite the .dg files.

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

// ---- shared: load the issueMaterialLine ledger port ---------------------------
{
  const dm = fs.readFileSync(path.join(__dirname, 'deluge-maths.test.js'), 'utf8');
  // Extract everything from the semantics helpers through issueMaterialLine,
  // WITHOUT executing its test suite.
  const start = dm.indexOf('function dFloor');
  const end = dm.indexOf("test('A1");
  if (start < 0 || end < 0) throw new Error('could not locate ledger port in deluge-maths.test.js');
  const sandbox = { console: { log() {}, info() {} } };
  vm.createContext(sandbox);
  vm.runInContext(dm.slice(start, end) + '\nthis.__ledger = { issueMaterialLine, screenFreshMeters, buildItemRequirements, dFloor, dCeil };', sandbox);
  var ledger = sandbox.__ledger;
}
const dCeil = ledger.dCeil, dFloor = ledger.dFloor;

// ---- shared: load the REAL widget allocator -----------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'lot-allocator.js'), 'utf8');
  const ctx = { console: { log() {} }, Math, Number, Object, String, Array, JSON };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.A = { round2, remnantYield, perRowFor, lotFill, chooseLotForOrder, orderMetres, applyLotAllocation };', ctx);
  var A = ctx.A;
}

// ---- shared: seeded PRNG -------------------------------------------------------
function mkRnd(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

// =====================================================================
// PORT: createProductionPlans decision core
// (deluge/createProductionPlans.dg — queue, numbering seed, rules map,
//  budget guard, resume path, rejection paths, priority key, inserts)
// =====================================================================

function padPlanNo(n) {
  // :389-409 — the five padding branches
  let padded;
  if (n < 10) padded = '0000' + n;
  else if (n < 100) padded = '000' + n;
  else if (n < 1000) padded = '00' + n;
  else if (n < 10000) padded = '0' + n;
  else padded = '' + n;
  return 'PLAN-' + padded;
}

function plannerRun(world, opts) {
  opts = opts || {};
  const maxPerRun = opts.maxPerRun !== undefined ? opts.maxPerRun : 25;
  const scanLimit = opts.scanLimit !== undefined ? opts.scanLimit : 100;
  const stats = { queries: 0, writes: 0 };
  const logs = [];
  const created = [], skipped = [], failed = [], deferred = [], errored = [];

  // :102 pendingTotal BEFORE the cap
  stats.queries++;
  const pendingAll = world.salesOrders.filter(so => so.orderStatus === 'Pending')
    .sort((a, b) => a.addedTime - b.addedTime);
  const pendingTotal = pendingAll.length;
  // :104 scan window
  const pendingOrders = pendingAll.slice(0, scanLimit);
  logs.push('Sales Orders waiting to be planned: ' + pendingTotal);

  // :112-142 numbering seed — the TEN NEWEST plans, MAX parsed suffix wins
  stats.queries++;
  const seedPlans = world.plans.slice().sort((a, b) => b.addedTime - a.addedTime).slice(0, 10);
  let maxNum = 0;
  for (const lp of seedPlans) {
    const lastNo = (lp.planNo || '').trim();
    if (lastNo !== '' && lastNo.indexOf('-') >= 0) {
      const suf = lastNo.substring(lastNo.lastIndexOf('-') + 1);
      if (/^\d+$/.test(suf)) {                       // Deluge isNumber()
        const thisNum = parseInt(suf, 10);
        if (thisNum > maxNum) maxNum = thisNum;
      }
    }
  }
  const numSeedSnapshot = maxNum;

  // :162-172 supervisor rules read ONCE — first row per source wins
  stats.queries++;
  const assignBySource = {};
  for (const oa of world.rules.slice().sort((a, b) => a.id - b.id)) {
    const oaSrc = (oa.source || '').trim();
    if (oaSrc !== '' && oa.employee != null && assignBySource[oaSrc] === undefined) {
      assignBySource[oaSrc] = oa.employee;
    }
  }

  for (const so of pendingOrders) {
  try {
    // :176-186 budget guard - deferred is NOT failed
    if (created.length >= maxPerRun) { deferred.push(so.id); continue; }
    if (so.failWith === 'pre') throw new Error('simulated pre-insert failure for ' + so.id);
    stats.queries++;
    // :188-209 resume path
    const existing = world.plans.filter(p => p.salesOrderId === so.id);
    if (existing.length > 0) {
      if (existing[0].assignedTo != null) so.assignedTo = existing[0].assignedTo;
      so.orderStatus = 'In Progress';
      skipped.push(so.id);
      logs.push('SKIP (plan exists, order moved to In Progress) -> SO ' + so.orderNo);
      continue;
    }
    // :211-244 rejection gathering — EVERY reason, collected before rejecting
    let rejReasons = '';
    const orderSource = so.source;
    let assignedEmpId = null;
    if (orderSource != null && orderSource !== '') {
      assignedEmpId = assignBySource[orderSource.toString().trim()];
    }
    if (assignedEmpId == null) {
      let srcTxt = '(no order source)';
      if (orderSource != null && orderSource !== '') srcTxt = orderSource;
      rejReasons = "No supervisor assigned for order source '" + srcTxt + "' - add a rule in Order Assignment";
    }
    let itemLineCount = 0, totalProduceQty = 0, noBomTxt = '', multiBomTxt = '';
    for (const row of so.items) {
      totalProduceQty += row.qty;
      let nameTxt = (row.name || '').trim(); if (nameTxt === '') nameTxt = '(unnamed item)';
      const bomCount = world.bomCounts[row.sku] || 0;
      if (bomCount === 0) { if (noBomTxt !== '') noBomTxt += ', '; noBomTxt += nameTxt; }
      else if (bomCount > 1) { if (multiBomTxt !== '') multiBomTxt += ', '; multiBomTxt += nameTxt + ' (' + bomCount + ' BOMs)'; }
      itemLineCount++;
    }
    if (itemLineCount === 0) { if (rejReasons !== '') rejReasons += '; '; rejReasons += 'No items on the order'; }
    if (noBomTxt !== '') { if (rejReasons !== '') rejReasons += '; '; rejReasons += 'No BOM for: ' + noBomTxt; }
    if (multiBomTxt !== '') { if (rejReasons !== '') rejReasons += '; '; rejReasons += 'More than one BOM for: ' + multiBomTxt; }
    if (rejReasons !== '') {
      // :376-384 the order KEEPS "Pending" — the whole retry mechanism
      failed.push({ id: so.id, reason: rejReasons });
      logs.push('REJECT -> SO ' + so.orderNo + ' | ' + rejReasons);
      continue;
    }
    // :388-409 take the number ONLY now — a rejected order consumes none
    maxNum += 1;
    const planNo = padPlanNo(maxNum);
    // :442-467 priority rank
    let srcRank = 5;
    const srcTxt = (orderSource || '').toString().trim().toLowerCase();
    if (srcTxt === 'shopify') srcRank = 1;
    else if (srcTxt === 'faire') srcRank = 2;
    else if (srcTxt === 'custom') srcRank = 3;
    else if (srcTxt === 'pr') srcRank = 4;
    else logs.push("WARN (unranked order source '" + orderSource + "', ranked last) -> SO " + so.orderNo);
    const priorityKey = (srcRank * 1000000) + maxNum;
    // :475-486 header insert; :559-567 LAST, the order leaves the queue
    stats.writes += 1 + so.items.length;             // header + plan_items
    world.plans.push({ id: 'PL' + planNo, planNo, salesOrderId: so.id, addedTime: 999999999,
                       assignedTo: assignedEmpId, status: 'Pending', priorityKey });
    if (so.failWith === 'post') {
      // Throw lands BETWEEN the header insert and the queue-exit write - Deluge
      // has no transaction, so this is exactly the state the resume path exists
      // to recover: plan exists, order still Pending.
      throw new Error('simulated post-insert failure for ' + so.id);
    }
    so.assignedTo = assignedEmpId;
    so.orderStatus = 'In Progress';
    created.push({ planNo, soId: so.id, priorityKey, rank: srcRank });
  } catch (eOrder) {
    // :634-660 ERROR -> logged apart from REJECT, counted in failedCount,
    // the order keeps Pending. A post-insert plan is NOT rolled back (Deluge
    // has no transaction) - the resume path IS the recovery.
    errored.push({ id: so.id, message: eOrder.message });
  }
  }

  const mailSent = created.length > 0 || failed.length > 0 || errored.length > 0;   // :641
  return { created, skipped, failed, deferred, errored, logs, mailSent, numSeedSnapshot,
           pendingTotal, stats, finalMaxNum: maxNum };
}


// =====================================================================
// PORT: syncSingleSalesOrder decision core (deluge/syncSingleSalesOrder.dg)
// =====================================================================

function syncOrder(world, salesOrderId, resp) {
  const stats = { queries: 0, writes: 0 };
  const soIdTxt = salesOrderId == null ? '' : String(salesOrderId).trim();
  if (soIdTxt === '') return { status: 'error', message: 'salesOrderId is missing', stats };

  // :10-14 duplicate check — BEFORE any API call
  stats.queries++;
  const dup = world.salesOrders.find(r => r.inventoryId === soIdTxt);
  if (dup) return { status: 'skipped', message: 'Already synced', recordId: dup.id, stats };

  // :29-38 API result handling (resp is the mocked invokeurl output)
  const respCode = resp && resp.code != null ? String(resp.code).trim() : '0';
  if (respCode !== '0') return { status: 'error', message: 'Inventory API returned an error', code: respCode, stats };
  const so = resp ? resp.salesorder : null;
  if (!so) return { status: 'error', message: 'Sales order not found in Inventory', stats };

  const soNumber = (so.salesorder_number || '').toString().trim();
  const invStatus = (so.status || '').toString().trim().toLowerCase();
  if (invStatus === 'draft' || invStatus === 'void') {
    return { status: 'skipped', message: 'Inventory order is ' + invStatus + ' - not synced', stats };
  }

  // :45-63 customer
  let custId = null; let custMissTxt = '';
  const custName = (so.customer_name || '').toString().trim();
  if (custName === '') custMissTxt = '(no customer name on the Inventory order)';
  else {
    stats.queries++;
    const hit = world.customers[custName];
    if (hit != null) custId = hit; else custMissTxt = custName;
  }

  // :64-95 order source — custom field label wins, then the source field
  let srcRaw = '';
  for (const cf of (so.custom_fields || [])) {
    const lbl = (cf.label || '').toString().trim().toLowerCase();
    if (lbl === 'order source' || lbl === 'source') srcRaw = (cf.value || '').toString().trim();
  }
  if (srcRaw === '') srcRaw = (so.source || '').toString().trim();
  const srcCmp = srcRaw.toLowerCase();
  let srcNorm = '';
  if (srcCmp === 'shopify') srcNorm = 'Shopify';
  else if (srcCmp === 'faire') srcNorm = 'Faire';
  else if (srcCmp === 'custom') srcNorm = 'Custom';
  else if (srcCmp === 'pr') srcNorm = 'PR';

  // :96-156 line items — SKU resolution + advisory BOM checks
  let noItemTxt = '', noBomTxt = '', multiBomTxt = '', lineCount = 0;
  const savedRows = [];
  for (const li of (so.line_items || [])) {
    lineCount++;
    const liSku = (li.sku || '').toString().trim();
    let nameTxt = (li.name || '').toString().trim(); if (nameTxt === '') nameTxt = '(unnamed item)';
    let imId = null;
    if (liSku !== '') {
      stats.queries++;
      imId = world.itemMaster[liSku] != null ? world.itemMaster[liSku] : null;
    }
    if (imId == null) {
      noItemTxt = noItemTxt === '' ? '' : noItemTxt + ', ';
      noItemTxt += nameTxt + " (SKU '" + liSku + "')";
    } else {
      stats.queries++;
      const bomN = world.bomCounts[imId] || 0;
      if (bomN === 0) { if (noBomTxt !== '') noBomTxt += ', '; noBomTxt += nameTxt; }
      else if (bomN > 1) { if (multiBomTxt !== '') multiBomTxt += ', '; multiBomTxt += nameTxt + ' (' + bomN + ' BOMs)'; }
    }
    savedRows.push({ name: li.name, qty: li.quantity, sku: imId });   // row kept either way (:155)
  }

  // :157-182 insert — Order_Status "Pending" ALWAYS
  stats.writes++;
  const rec = { id: 'SO' + (world.seq = (world.seq || 0) + 1), inventoryId: soIdTxt,
                orderNo: soNumber, source: srcNorm, orderStatus: 'Pending',
                customer: custId, items: savedRows };
  world.salesOrders.push(rec);

  let issueCount = 0;
  if (srcNorm === '') issueCount++;
  if (noItemTxt !== '') issueCount++;
  if (noBomTxt !== '') issueCount++;
  if (multiBomTxt !== '') issueCount++;
  const mailSent = issueCount > 0;                                    // :211

  return { status: 'success', recordId: rec.id, orderSource: srcNorm, orderStatus: 'Pending',
           issues: issueCount, noBom: noBomTxt, multiBom: multiBomTxt,
           notInItemMaster: noItemTxt, customerUnmatched: custMissTxt, mailSent, stats };
}

// =====================================================================
console.log('\nPART P - createProductionPlans');

function mkWorld() {
  return {
    salesOrders: [], plans: [],
    rules: [{ id: 1, source: 'Shopify', employee: 'EMP-SHOP' },
            { id: 2, source: 'Faire', employee: 'EMP-FAIRE' }],
    bomCounts: { ITM1: 1 },
  };
}
function pendingOrder(id, addedTime, over) {
  return Object.assign({ id, orderNo: 'SO-' + id, orderStatus: 'Pending', source: 'Shopify',
    assignedTo: null, addedTime,
    items: [{ sku: 'ITM1', name: 'Item ' + id, qty: 10 }] }, over || {});
}
// failWith models a Deluge runtime throw inside the per-order body:
//   'pre'  - throws during gathering (before any write)
//   'post' - throws AFTER the plan header was inserted, BEFORE the order left
//            the queue - the shape the resume path exists to recover

test('P1 numbering starts at PLAN-00001 on an empty form', () => {
  const w = mkWorld(); w.salesOrders.push(pendingOrder('A1', 1));
  assert.strictEqual(plannerRun(w).created[0].planNo, 'PLAN-00001');
});

test('P2 numbering continues from the MAX suffix of the newest 10 plans', () => {
  const w = mkWorld();
  // Numbers DESCEND with recency except one: 36 is older-but-higher than 37.
  // FIRST-of-window would say 38; MAX says 39.
  w.plans.push({ id: 'p1', planNo: 'PLAN-00039', salesOrderId: 'x', addedTime: 91 });
  for (let i = 0; i < 9; i++) w.plans.push({ id: 'q' + i, planNo: 'PLAN-000' + (38 - i), salesOrderId: 'x', addedTime: 100 - i });
  // ^ q0=38(t100, newest), q1=37(t99), ..., p1=39 sits INSIDE the window at t91
  w.salesOrders.push(pendingOrder('A1', 1));
  assert.strictEqual(plannerRun(w).created[0].planNo, 'PLAN-00040');
});

test('P2b a higher number OUTSIDE the newest-10 time window does not seed (documented)', () => {
  const w = mkWorld();
  for (let i = 0; i < 12; i++) w.plans.push({ id: 'p' + i, planNo: 'PLAN-000' + (30 + i), salesOrderId: 'x', addedTime: 100 - i });
  // Newest ten are PLAN-00030..PLAN-00039 (t100..t91); 41 and 40 are older still
  // and outside it. Only reachable with hand-edited numbering; recorded here
  // so the behaviour is pinned, not assumed.
  w.salesOrders.push(pendingOrder('A1', 1));
  assert.strictEqual(plannerRun(w).created[0].planNo, 'PLAN-00040');
});

test('P3 empty Plan_No rows in the seed are skipped, not fatal', () => {
  const w = mkWorld();
  for (let i = 0; i < 9; i++) w.plans.push({ id: 'p' + i, planNo: '', salesOrderId: 'x', addedTime: 100 - i });
  w.plans.push({ id: 'pz', planNo: 'PLAN-00077', salesOrderId: 'x', addedTime: 50 });
  w.salesOrders.push(pendingOrder('A1', 1));
  assert.strictEqual(plannerRun(w).created[0].planNo, 'PLAN-00078');
});

test('P4 non-numeric / dashless / null Plan_No never crash the run', () => {
  const w = mkWorld();
  w.plans.push({ id: 'p1', planNo: 'weird', salesOrderId: 'x', addedTime: 200 });
  w.plans.push({ id: 'p2', planNo: 'PLAN-ABC', salesOrderId: 'x', addedTime: 190 });
  w.plans.push({ id: 'p3', planNo: null, salesOrderId: 'x', addedTime: 180 });
  w.salesOrders.push(pendingOrder('A1', 1));
  const r = plannerRun(w);
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(r.created[0].planNo, 'PLAN-00001');
});

test('P5 width rollover: 99999 -> 100000 unpadded', () => {
  const w = mkWorld();
  w.plans.push({ id: 'p1', planNo: 'PLAN-99999', salesOrderId: 'x', addedTime: 100 });
  w.salesOrders.push(pendingOrder('A1', 1));
  assert.strictEqual(plannerRun(w).created[0].planNo, 'PLAN-100000');
});

test('P6 resume path: planned order moves to In Progress, mirrors supervisor, costs no budget', () => {
  const w = mkWorld();
  w.plans.push({ id: 'p1', planNo: 'PLAN-00007', salesOrderId: 'OLD', addedTime: 90, assignedTo: 'EMP-FAIRE', status: 'Pending' });
  w.salesOrders.push(pendingOrder('OLD', 1));
  w.salesOrders.push(pendingOrder('NEW', 2));
  const r = plannerRun(w, { maxPerRun: 1 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.skipped)), ['OLD']);
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(r.created[0].soId, 'NEW');
  assert.strictEqual(w.salesOrders[0].orderStatus, 'In Progress');
  assert.strictEqual(w.salesOrders[0].assignedTo, 'EMP-FAIRE');
});

test('P7 rejection paths all fire and KEEP Pending (the retry mechanism)', () => {
  const w = mkWorld();
  w.salesOrders.push(pendingOrder('NORULE', 1, { source: 'PR' }));
  w.salesOrders.push(pendingOrder('NOITEMS', 2, { items: [] }));
  w.salesOrders.push(pendingOrder('NOBOM', 3, { items: [{ sku: 'ITMX', name: 'Ghost', qty: 1 }] }));
  w.bomCounts.ITMY = 2;
  w.salesOrders.push(pendingOrder('MULTIBOM', 4, { items: [{ sku: 'ITMY', name: 'Twin', qty: 1 }] }));
  const r = plannerRun(w);
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.failed.length, 4);
  r.failed.forEach(f => assert.strictEqual(
    w.salesOrders.find(x => x.id === f.id).orderStatus, 'Pending', f.id));
  assert.ok(r.failed.find(f => f.id === 'MULTIBOM').reason.includes('(2 BOMs)'));
  assert.ok(r.failed.find(f => f.id === 'NORULE').reason.includes("source 'PR'"));
});

test('P8 mixed reasons join with "; " in collection order', () => {
  const w = mkWorld();
  w.salesOrders.push(pendingOrder('X', 1, { source: 'Mystery', items: [] }));
  const reason = plannerRun(w).failed[0].reason;
  assert.ok(reason.indexOf('No supervisor') < reason.indexOf('No items'));
  assert.ok(reason.indexOf('; ') > 0);
});

test('P9 a rejected order consumes NO plan number', () => {
  const w = mkWorld();
  w.salesOrders.push(pendingOrder('BAD', 1, { source: 'PR' }));
  w.salesOrders.push(pendingOrder('GOOD', 2));
  const r = plannerRun(w);
  assert.strictEqual(r.finalMaxNum, 1, 'only the created plan took a number');
  assert.strictEqual(r.created[0].planNo, 'PLAN-00001');
});

test('P10 priority key: rank dominates; unknown source sorts LAST with rank 5', () => {
  const w = mkWorld();
  w.rules.push({ id: 3, source: 'Weird', employee: 'EMP-W' });
  w.salesOrders.push(pendingOrder('W1', 3, { source: 'Weird' }));
  w.salesOrders.push(pendingOrder('F1', 2, { source: 'Faire' }));
  w.salesOrders.push(pendingOrder('S1', 1, { source: 'Shopify' }));
  const r = plannerRun(w);
  const keys = {}; r.created.forEach(c => { keys[c.soId] = c.priorityKey; });
  assert.ok(keys.S1 < keys.F1 && keys.F1 < keys.W1);
  assert.strictEqual(r.created.find(c => c.soId === 'W1').rank, 5);
});

test('P11 assignment is EXACT-match (trimmed); ranking lowercases - documented asymmetry', () => {
  const w = mkWorld();
  w.salesOrders.push(pendingOrder('LC', 1, { source: 'shopify' }));
  const r = plannerRun(w);
  // Ranked as shopify, but the rules map holds only 'Shopify' -> no supervisor.
  // The OLD criteria query behaved identically; not a regression. Pinned here.
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.failed[0].id, 'LC');
  assert.strictEqual(w.salesOrders[0].orderStatus, 'Pending');
});

test('P12 rules with empty source or no employee are skipped by the index build', () => {
  const w = mkWorld();
  w.rules.push({ id: 9, source: '', employee: 'EMP-X' });
  w.rules.push({ id: 4, source: 'Faire', employee: null });   // must NOT shadow the good row
  w.salesOrders.push(pendingOrder('F1', 1, { source: 'Faire' }));
  const r = plannerRun(w);
  assert.strictEqual(r.created.length, 1);
  assert.strictEqual(w.salesOrders[0].assignedTo, 'EMP-FAIRE');
});

// ---- THE TWO-LIMIT CAP -------------------------------------------------------

test('P13 budget cap: 30 plannable -> 25 created, 5 deferred and still Pending', () => {
  const w = mkWorld();
  for (let i = 0; i < 30; i++) w.salesOrders.push(pendingOrder('O' + i, i));
  const r = plannerRun(w, { maxPerRun: 25, scanLimit: 100 });
  assert.strictEqual(r.created.length, 25);
  assert.strictEqual(r.deferred.length, 5);
  r.deferred.forEach(id => assert.strictEqual(
    w.salesOrders.find(x => x.id === id).orderStatus, 'Pending'));
});

test('P14 STARVATION REGRESSION: stuck orders at the front cannot starve plannable ones behind', () => {
  // The single-window design this replaces scanned exactly maxPerRun orders,
  // so 25 permanently-unplannable orders at the front of an oldest-first queue
  // consumed every scan for ever. Two limits: rejections cost NO budget.
  const w = mkWorld();
  for (let i = 0; i < 40; i++) w.salesOrders.push(pendingOrder('STUCK' + i, i, { source: 'PR' }));
  for (let i = 0; i < 20; i++) w.salesOrders.push(pendingOrder('GOOD' + i, 1000 + i));
  const r = plannerRun(w, { maxPerRun: 25, scanLimit: 100 });
  assert.strictEqual(r.failed.length, 40);
  assert.strictEqual(r.created.length, 20, 'every plannable order was served');
  assert.strictEqual(r.deferred.length, 0);
});

test('P15 budget still binds across the wider scan', () => {
  const w = mkWorld();
  for (let i = 0; i < 10; i++) w.salesOrders.push(pendingOrder('BAD' + i, i, { source: 'PR' }));
  for (let i = 0; i < 50; i++) w.salesOrders.push(pendingOrder('G' + i, 100 + i));
  const r = plannerRun(w, { maxPerRun: 25, scanLimit: 100 });
  assert.strictEqual(r.failed.length, 10);
  assert.strictEqual(r.created.length, 25);
  assert.strictEqual(r.deferred.length, 25);   // 50 goods - 25 created; rejects spent nothing
});

test('P16 starvation BEYOND the scan window is possible and surfaced by the log', () => {
  // Documented limitation: 150 stuck orders push every plannable one outside
  // the oldest-100 scan. Only a human fix unblocks them - the BACKLOG line
  // exists so the condition is visible instead of silent.
  const w = mkWorld();
  for (let i = 0; i < 150; i++) w.salesOrders.push(pendingOrder('STUCK' + i, i, { source: 'PR' }));
  for (let i = 0; i < 5; i++) w.salesOrders.push(pendingOrder('GOOD' + i, 5000 + i));
  const r = plannerRun(w, { maxPerRun: 25, scanLimit: 100 });
  assert.strictEqual(r.created.length, 0);
  assert.strictEqual(r.pendingTotal, 155);
  assert.ok(r.logs.some(l => l.indexOf('waiting to be planned: 155') >= 0));
});

test('P17 mail guard: quiet run sends nothing; created-only or failed-only sends', () => {
  let w = mkWorld();
  assert.strictEqual(plannerRun(w).mailSent, false);
  w = mkWorld(); w.salesOrders.push(pendingOrder('OK', 1));
  assert.strictEqual(plannerRun(w).mailSent, true);
  w = mkWorld(); w.salesOrders.push(pendingOrder('BAD', 1, { source: 'PR' }));
  assert.strictEqual(plannerRun(w).mailSent, true);
});

// =====================================================================
console.log('\nPART Y - syncSingleSalesOrder');

function syncWorld() {
  return { salesOrders: [], customers: { 'Acme Ltd': 'CUST1' },
           itemMaster: { 'SKU-A': 'ITMA', 'SKU-B': 'ITMB' },
           bomCounts: { ITMA: 1, ITMB: 1 } };
}
function invResp(over) {
  return Object.assign({ code: 0, salesorder: {
    salesorder_number: 'SO-100', status: 'confirmed',
    customer_name: 'Acme Ltd', source: 'shopify',
    custom_fields: [], line_items: [{ name: 'Widget', sku: 'SKU-A', quantity: 5 }],
  } }, over || {});
}

test('Y1 missing id errors; nothing queried', () => {
  assert.strictEqual(syncOrder(syncWorld(), '  ', invResp()).status, 'error');
});
test('Y2 duplicate Inventory_sales_order_Id skips BEFORE the API call', () => {
  const w = syncWorld(); w.salesOrders.push({ id: 'R1', inventoryId: '900' });
  const r = syncOrder(w, '900', null);   // resp null would crash if the call happened
  assert.strictEqual(r.status, 'skipped');
});
test('Y3 draft and void are skipped after lookup, before any write', () => {
  for (const st of ['draft', 'void']) {
    const r = syncOrder(syncWorld(), '901', invResp({ salesorder: { status: st, salesorder_number: 'X', customer_name: '', line_items: [] } }));
    assert.strictEqual(r.status, 'skipped');
  }
});
test('Y4 item resolution by SKU sets the lookup; misses keep the row and name the SKU', () => {
  const w = syncWorld();
  const r = syncOrder(w, '902', invResp({ salesorder: Object.assign(invResp().salesorder, {
    line_items: [
      { name: 'Known', sku: 'SKU-B', quantity: 1 },
      { name: 'Ghost', sku: 'NOPE', quantity: 2 },
      { name: 'NoSku', sku: '', quantity: 3 },
    ] }) }));
  assert.strictEqual(r.status, 'success');
  const rec = w.salesOrders[0];
  assert.strictEqual(rec.items.filter(i => i.sku != null).length, 1);
  assert.strictEqual(rec.items.length, 3, 'unresolved rows are still saved');
  assert.ok(r.notInItemMaster.includes("Ghost (SKU 'NOPE')"));
  assert.ok(r.notInItemMaster.includes('NoSku'));
});

test('Y5 exactly-one-BOM is advisory: 0 and >1 both recorded, order still saved Pending', () => {
  const w = syncWorld(); w.bomCounts.ITMB = 0; w.bomCounts.ITMA = 3;
  const r = syncOrder(w, '903', invResp({ salesorder: Object.assign(invResp().salesorder, {
    line_items: [{ name: 'A', sku: 'SKU-A', quantity: 1 }, { name: 'B', sku: 'SKU-B', quantity: 1 }] }) }));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.orderStatus, 'Pending');
  assert.strictEqual(w.salesOrders[0].orderStatus, 'Pending', 'saved at Pending so the planner retries');
  assert.ok(r.noBom.includes('B') && r.multiBom.includes('A (3 BOMs)'));
  assert.strictEqual(r.issues, 2);
});

test('Y6 source resolution: custom-field label wins case-insensitively, then falls back', () => {
  let w = syncWorld();
  let resp = invResp({ salesorder: Object.assign(invResp().salesorder, { source: 'faire',
    custom_fields: [{ label: 'Order Source', value: 'custom' }] }) });
  assert.strictEqual(syncOrder(w, '910', resp).orderSource, 'Custom');   // label beats field
  w = syncWorld();
  resp = invResp({ salesorder: Object.assign(invResp().salesorder, { source: 'PR', custom_fields: [] }) });
  assert.strictEqual(syncOrder(w, '911', resp).orderSource, 'PR');       // canonical casing from lowercase
});

test('Y7 unknown/empty source still saves, with an issue raised and empty source on the record', () => {
  for (const bad of ['etsy', '']) {
    const w = syncWorld();
    const so = invResp().salesorder;
    if (bad === '') delete so.source; else so.source = bad;
    const r = syncOrder(w, '912', invResp({ salesorder: so }));
    assert.strictEqual(r.status, 'success');
    assert.strictEqual(r.orderSource, '');
    assert.strictEqual(w.salesOrders[0].source, '', 'saved with an empty source - sorts LAST later');
    assert.strictEqual(r.issues, 1);
  }
});

test('Y8 customer matched by display name; miss is advisory only', () => {
  let w = syncWorld();
  assert.strictEqual(syncOrder(w, '913', invResp()).customerUnmatched, '');
  w = syncWorld();
  const r = syncOrder(w, '914', invResp({ salesorder: Object.assign(invResp().salesorder, { customer_name: 'Nobody Inc' }) }));
  assert.strictEqual(r.customerUnmatched, 'Nobody Inc');
  assert.strictEqual(r.status, 'success');   // saved anyway
});

test('Y9 quiet order sends no mail; any issue sends exactly one', () => {
  let r = syncOrder(syncWorld(), '915', invResp());
  assert.strictEqual(r.mailSent, false);
  r = syncOrder(syncWorld(), '916', invResp({ salesorder: Object.assign(invResp().salesorder, {
    line_items: [{ name: 'G', sku: 'MISSING', quantity: 1 }] }) }));
  assert.strictEqual(r.mailSent, true);
});

// =====================================================================
console.log('\nPART Z - screen offers == ledger accepts (end-to-end parity)');
//
// getStoreMaterialRequirements builds the offer; applyLotAllocation decides
// it; the widget submits lotLines + wastePicks; issueMaterials must ACCEPT
// exactly that - no refusal, no stranding, pieces closed. Any divergence here
// is the "press Issue and nothing happens" bug class.

function buildScreenPayload(world) {
  // One supervisor card, one fabric, N lines (one per order item). Mirrors
  // deluge/getStoreMaterialRequirements.dg output shape for the fabric branch.
  const sup = (id, mats) => ({ supervisorId: id, supervisorName: 'S', materials: mats });
  const material = (materialId, m) => Object.assign({
    materialId, isFabric: true, sku: 'FAB', unit: 'Mtr',
    lines: [], wasteStock: [], lots: [], openExceptions: [],
    requiredPieces: 0, issuedPieces: 0, freshMeters: 0, remaining: 0,
  }, m);
  const lines = world.demands.map(d => ({
    planId: d.orderId, salesOrder: d.orderId, planItemId: d.itemId,
    item: d.itemId, isRemake: false,
    required: d.reqQty, issued: 0,
    reqPieces: d.pieces, issPieces: d.fromWaste || 0,
    issuedLot: '', issuedLotNo: '', reason: '',
  }));
  return [sup('S1', [material('M1', {
    fabricWidthCm: world.widthCm, cutWidth: world.cutW, cutLength: world.cutL,
    requiredPieces: world.demands.reduce((a, d) => a + d.pieces, 0),
    issuedPieces: 0,
    freshMeters: 0, remaining: 0,
    lines,
    wasteStock: world.remnants.slice(),
    lots: world.lots.map(l => ({ lotId: l.lotId, lotNumber: l.no, blocked: !!l.blocked,
      wash: l.wash, unwash: l.unwash || 0, inWash: l.inWash || 0, form: 'Roll', pieces: [] })),
  })])];
}

function runParityCase(world) {
  const data = buildScreenPayload(world);
  A.applyLotAllocation(data);
  const m = data[0].materials[0];

  const lotLines = JSON.parse(JSON.stringify(m.lotLines));
  const picks = [];
  for (const pk of m.wastePicks) {
    if (!(pk.pieces > 0)) continue;
    const src = world.remnants.find(r => r.wasteId === pk.wasteId);
    picks.push({ ok: true, wasteId: pk.wasteId, physicalPcs: pk.pieces,
      yieldPer: Math.floor(src.width / world.cutW) * Math.floor(src.length / world.cutL),
      pinnedItem: pk.planItemId });
  }
  const rows = world.demands.map(d => ({
    reqQty: d.reqQty, issuedQty: 0, reqPieces: d.pieces,
    fromWaste: d.fromWaste || 0, fromRaw: 0,
    source: 'Plan', planItemId: d.itemId, issuedLot: '',
  }));
  const st = { rows, env: {
    isFab: true, srcWanted: 'Plan', cutW: world.cutW, cutL: world.cutL,
    fabricWidthCm: world.widthCm,
    lotWash: Object.assign({}, ...world.lots.map(l => ({ [l.lotId]: l.wash }))),
    lotBlocked: Object.assign({}, ...world.lots.filter(l => l.blocked).map(l => ({ [l.lotId]: true }))) } };
  const passes = lotLines.map(lt => ({ lotId: String(lt.lotId), qty: lt.qty, pin: lt.planItemId, pieces: [] }));
  const res = ledger.issueMaterialLine(st, { passes, picks });

  const servedOrders = {};
  for (const oc of m.orderOutcomes) servedOrders[oc.planId] = oc.why;
  return { res, st, m, lotLines, picks, servedOrders };
}

test('Z1 fixed scenario: two orders, one covering lot, one remnant - offer is accepted exactly', () => {
  const world = {
    widthCm: 137.16, cutW: 55, cutL: 55,
    lots: [{ lotId: 'L1', no: 'L1', wash: 12.00 }],
    remnants: [{ wasteId: 'W1', width: 120, length: 115, pieces: 2, lotId: 'L1', lot: 'L1', carton: '' }],
    demands: [
      { orderId: 'PLA', itemId: 'ITA', pieces: 10 },
      { orderId: 'PLB', itemId: 'ITB', pieces: 14 },
    ],
  };
  world.demands.forEach(d => { d.reqQty = Math.ceil(d.pieces / 2) * 0.55; });
  const { res, st, m } = runParityCase(world);
  assert.strictEqual(res.errors.length, 0, JSON.stringify(res.errors));
  // Ledger credited per item what the widget promised per item:
  for (const d of world.demands) {
    const row = st.rows.find(r => r.planItemId === d.itemId);
    const covered = m.demandsCovered ? 0 : null;
    const widgetWaste = m.wastePicks.filter(p => p.planItemId === d.itemId && p.pieces > 0)
      .reduce((a, p) => a + p.pieces * Math.floor(120 / 55) * Math.floor(115 / 55), 0);
    assert.strictEqual(row.fromWaste, Math.min(widgetWaste, d.pieces));
    assert.strictEqual(row.fromWaste + row.fromRaw, d.pieces, 'order closed in full');
    assert.strictEqual(row.issuedLot, 'L1');
  }
  approx(st.env.lotWash.L1, 12.00 - res.lotMoved, 0.005);
});

test('Z2 randomized parity sweep: whatever the allocator offers, the ledger accepts and closes', () => {
  const rnd = mkRnd(777);
  let served = 0, bugShapes = 0;
  for (let iter = 0; iter < 200; iter++) {
    const widthCm = [113.03, 120.015, 137.16][Math.floor(rnd() * 3)];
    const cutW = [40, 55][Math.floor(rnd() * 2)];
    const cutL = [45, 55][Math.floor(rnd() * 2)];
    const perRow = Math.floor(widthCm / cutW);
    if (perRow < 1) continue;
    const nLots = 1 + Math.floor(rnd() * 2);
    const lots = [];
    for (let i = 0; i < nLots; i++) {
      lots.push({ lotId: 'L' + i, no: 'L' + i,
        wash: Math.round(rnd() * 15 * 100) / 100,
        unwash: rnd() < 0.3 ? Math.round(rnd() * 8 * 100) / 100 : 0 });
    }
    const remnants = [];
    if (rnd() < 0.6) {
      remnants.push({ wasteId: 'W0', width: cutW + Math.floor(rnd() * 70),
        length: cutL + Math.floor(rnd() * 150), pieces: 1 + Math.floor(rnd() * 2),
        lotId: lots[0].lotId, lot: lots[0].lotId, carton: '' });
    }
    const demands = [];
    const nOrd = 1 + Math.floor(rnd() * 3);
    for (let o = 0; o < nOrd; o++) {
      const pcs = 1 + Math.floor(rnd() * 25);
      demands.push({ orderId: 'PL' + o, itemId: 'IT' + o, pieces: pcs,
        reqQty: dCeil((pcs * 1.0) / perRow) * cutL / 100 });
    }
    const world = { widthCm, cutW, cutL, lots, remnants, demands };
    const { res, st, m, lotLines, picks } = runParityCase(world);

    if (lotLines.length === 0 && picks.length === 0) {
      // Nothing was offered - every order must be skipped or pinned-dry, and
      // there is no submission to verify.
      assert.ok(m.orderOutcomes.every(oc => oc.why !== 'ready'),
        'no offer yet some order claims ready');
      continue;
    }
    if (res.errors.length > 0) {
      throw new Error('screen offered something the ledger refused: ' +
        JSON.stringify({ errors: res.errors, world }));
    }

    // Every order the screen SERVED must close completely in the ledger.
    for (const oc of m.orderOutcomes) {
      if (oc.why !== 'ready') continue;
      const d = demands.find(x => x.orderId === oc.planId);
      const row = st.rows.find(r => r.planItemId === d.itemId);
      // KNOWN BUG SHAPE (finding F1 in docs/front-half-verification.md): an
      // order served by OFFCUTS ALONE on a card where another order took fresh
      // cloth from the same lot produces picks pinned to an item that owns no
      // lot line. Every executed pass is pinned elsewhere, so the fan never
      // visits the orphan's rows and the waste credit never lands. Count these
      // instead of failing; the closing assertion proves the shape recurs.
      // F1 IS FIXED — the escape hatch that used to skip these is gone, and this
      // shape is now asserted like any other. bugShapes counts how often the
      // sweep still GENERATES it, so the number stays visible as coverage rather
      // than as a defect: it should be > 0 (the shape is common) while every one
      // of them closes.
      const hasOwnPass = lotLines.some(lt => lt.planItemId === d.itemId);
      if (!hasOwnPass && picks.length > 0 &&
          picks.every(pk => pk.pinnedItem !== d.itemId || !lotLines.some(lt => lt.planItemId === pk.pinnedItem))) {
        bugShapes++;
      }
      assert.strictEqual(row.fromWaste + row.fromRaw, d.pieces,
        'served order did not close: ' + JSON.stringify({ row, oc,
          lotLines: JSON.parse(JSON.stringify(lotLines)), picks: JSON.parse(JSON.stringify(picks)),
          world }));
      served++;
    }
    // Skipped orders moved nothing.
    for (const oc of m.orderOutcomes) {
      if (oc.why !== 'skipped') continue;
      const d = demands.find(x => x.orderId === oc.planId);
      const row = st.rows.find(r => r.planItemId === d.itemId);
      assert.strictEqual(row.fromWaste + row.fromRaw, 0);
      assert.strictEqual(lotLines.filter(lt => lt.planId === oc.planId).length, 0);
    }
    // Lot stock moved by exactly the accepted lot lines (+ piece metres: none here).
    const taken = {};
    for (const lt of lotLines) taken[lt.lotId] = (taken[lt.lotId] || 0) + lt.qty;
    for (const lt of Object.keys(taken)) {
      approx(st.env.lotWash[lt], (world.lots.find(l => l.lotId === lt).wash) - taken[lt], 0.006);
    }
  }
  assert.ok(served > 50, 'sweep exercised ' + served + ' served orders - too few to trust');
  // F1 fixed: this shape is now asserted, not excused. The count stays as
  // COVERAGE - it must remain > 0, or the sweep has stopped generating the
  // orphaned-pin case and this regression is no longer being tested at all.
  assert.ok(bugShapes > 0, 'sweep no longer generates the F1 shape - regression coverage lost');
  console.log('      note: ' + bugShapes + '/200 racks hit the orphaned-offcut-pin shape (F1, now closing correctly)');
});

test('Z3 FINDING F1 - offcut-only order on a shared lot never closes its requirement', () => {
  // Minimal deterministic shape: two orders share one material+lot; order A is
  // fully covered by the lot's offcuts (no metres), order B takes fresh cloth.
  const world = {
    widthCm: 137.16, cutW: 40, cutL: 55,
    lots: [{ lotId: 'L1', no: 'L1', wash: 4.00 }],
    remnants: [{ wasteId: 'W0', width: 42, length: 189, pieces: 2, lotId: 'L1', lot: 'L1', carton: '' }],
    demands: [
      { orderId: 'PLA', itemId: 'ITA', pieces: 4 },
      { orderId: 'PLB', itemId: 'ITB', pieces: 15 },
    ],
  };
  world.demands.forEach(d => { d.reqQty = Math.ceil(d.pieces / 3) * 55 / 100; });
  const { res, st, m } = runParityCase(world);
  assert.strictEqual(res.errors.length, 0);
  const ocA = m.orderOutcomes.find(o => o.planId === 'PLA');
  assert.strictEqual(ocA.why, 'ready');
  assert.strictEqual(ocA.metres, 0, 'A was served by offcuts alone');
  assert.strictEqual(ocA.wastePieces > 0, true);

  const rowA = st.rows.find(r => r.planItemId === 'ITA');
  // F1 FIXED (issueMaterials.dg:1045-1100). ITA owns no lot line, so before the
  // fix no executed pass carried its pin and the fan never visited its rows: the
  // remnants were physically handed over while the requirement stayed open for
  // ever, and the next press asked for real cloth to cover pieces the offcuts
  // had already covered. It now gets a synthetic empty-lot pass on its own pin.
  assert.strictEqual(rowA.fromWaste, 4,
    'F1 REGRESSED - the offcut-only order is not being credited again');
  // And nothing moved to pay for it: the credit is offcuts, not cloth.
  assert.strictEqual(rowA.fromRaw, 0, 'A must be closed by offcuts alone');
});

console.log('\n========================================');
console.log('pipeline: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}

// ---- PER-ORDER TRY/CATCH (:199-661) ------------------------------------------

test('P18 a throwing order is reported as ERROR, stays Pending, and blocks NOTHING', () => {
  const w = mkWorld();
  w.salesOrders.push(pendingOrder('G1', 1));
  w.salesOrders.push(pendingOrder('POISON', 2, { failWith: 'pre' }));
  w.salesOrders.push(pendingOrder('G2', 3));
  w.salesOrders.push(pendingOrder('R1', 4, { source: 'PR' }));   // a REJECT for contrast
  const r = plannerRun(w);
  assert.strictEqual(r.created.length, 2, 'both healthy orders planned in the SAME run');
  assert.strictEqual(r.errored.length, 1);
  assert.strictEqual(r.failed.length, 1);
  assert.ok(r.logs.some(l => l.indexOf('ERROR ->') >= 0), 'ERROR logged apart from REJECT');
  assert.ok(!r.logs.some(l => l.startsWith('REJECT -> SO SO-POISON')));
  assert.strictEqual(
    w.salesOrders.find(x => x.id === 'POISON').orderStatus, 'Pending', 'retries like a reject');
});

test('P19 THE POISON-PILL REGRESSION: the same throw on every run never blocks again', () => {
  // Before :634, one bad order killed the WHOLE run - and because failures keep
  // Pending, every later run died in the identical place, costing a full
  // scheduling window each time, silently.
  const w = mkWorld();
  for (let i = 0; i < 10; i++) w.salesOrders.push(pendingOrder('GOOD' + i, 100 + i));
  w.salesOrders.push(pendingOrder('BAD', 50, { failWith: 'pre' }));   // OLDEST - first scanned
  // Run 1: BAD throws at the front; everything behind it is still planned.
  const r1 = plannerRun(w, { maxPerRun: 5 });
  assert.strictEqual(r1.created.length, 5);
  assert.strictEqual(r1.errored.length, 1);
  assert.strictEqual(r1.mailSent, true, 'an error-only or mixed run still reports');
  // Run 2: the five goods are gone from the queue; BAD throws again - and the
  // run must STILL complete (not die), reporting the same error.
  const r2 = plannerRun(w, { maxPerRun: 5 });
  assert.strictEqual(r2.errored.length, 1);
  assert.strictEqual(r2.created.length, 5, 'the remaining goods planned despite BAD');
});

test('P20 post-insert throw: the plan survives and the NEXT run recovers via the resume path', () => {
  const w = mkWorld();
  w.salesOrders.push(pendingOrder('HALF', 1, { failWith: 'post' }));
  w.salesOrders.push(pendingOrder('G1', 2));
  const r1 = plannerRun(w);
  assert.strictEqual(r1.errored.length, 1);
  // Deluge has no transaction: the header is already written.
  const halfPlan = w.plans.find(p => p.salesOrderId === 'HALF');
  assert.ok(halfPlan, 'plan header exists');
  assert.strictEqual(
    w.salesOrders.find(x => x.id === 'HALF').orderStatus, 'Pending', 'never left the queue');
  // Run 2: resume path finds the plan, moves the order on, plans NOTHING twice.
  const r2 = plannerRun(w);
  assert.strictEqual(r2.created.length, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r2.skipped)), ['HALF']);
  assert.strictEqual(w.plans.filter(p => p.salesOrderId === 'HALF').length, 1, 'no duplicate');
  assert.strictEqual(w.salesOrders[0].orderStatus, 'In Progress');
});

test('P21 errors spend NO plan number and share failedCount for the mail guard', () => {
  const w = mkWorld();
  w.salesOrders.push(pendingOrder('BAD', 1, { failWith: 'pre' }));
  w.salesOrders.push(pendingOrder('G1', 2));
  const r = plannerRun(w);
  assert.strictEqual(r.finalMaxNum, 1, 'the error consumed no PLAN-000xx');
  assert.strictEqual(r.mailSent, true, 'failedCount includes errors - error-only run reports');
});
