#!/usr/bin/env node
// installApiThrottle, driven by a virtual clock.
//
//   usage: node tools/api-throttle.test.js
//
// What is being protected. The first three are the data-loss argument and are
// the reason the allowlist exists at all:
//
//   - a WRITE is never dropped, however many identical ones are queued
//   - only a WAITING read is dropped, never one in flight - dropping the older
//     for the newer hands the caller fresher data; merging into an in-flight
//     call would hand it data from before a save that landed in between
//   - every caller of a dropped call is still settled, including one that was
//     itself superseded earlier
//   - nothing is PACED: a burst goes straight out, because holding calls back
//     that Creator would have accepted is what hung the screen
//   - a 2955 is retried (it was refused before executing, so it repeats no
//     work); anything else rejects unchanged

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

// ---- load the real function (skip its self-install IIFE) --------------------
const src = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'supervisor', 'js', 'api-throttle.js'), 'utf8');
function grab(decl) {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error('api-throttle.js no longer has: ' + decl);
  let depth = 0, end = src.indexOf('{', i);
  for (let k = end; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  return src.slice(i, end);
}
const listSrc = src.slice(src.indexOf('var COALESCE_SAFE'), src.indexOf('];', src.indexOf('var COALESCE_SAFE')) + 2);
const ctx = { Promise, Date, console: { log() {}, warn() {} }, setTimeout, JSON };
vm.createContext(ctx);
vm.runInContext(listSrc + '\n' + grab('function installApiThrottle('), ctx);
const installApiThrottle = ctx.installApiThrottle;
const COALESCE_SAFE = ctx.COALESCE_SAFE;

// ---- virtual clock ---------------------------------------------------------
function settle() { return new Promise(r => setImmediate(r)); }
function makeClock() {
  let t = 0;
  const pending = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { pending.push({ at: t + ms, fn }); },
    // SETTLES FIRST: a rejection already in the microtask queue has to be
    // handled at the time it happened, or the retry wait is computed from a
    // moment in the future and reads as the retry never firing.
    async advance(ms) {
      await settle();
      const target = t + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        if (!pending.length || pending[0].at > target) break;
        const job = pending.shift();
        t = job.at;
        job.fn();
        await settle();
      }
      t = target;
      await settle();
    }
  };
}

// A fake invokeCustomApi. Calls stay pending until released, so "in flight"
// is something the test controls.
function makeTarget(plan) {
  const seen = [];
  const open = [];
  const t = {
    seen,
    open,
    releaseAll() { while (open.length) open.shift()(); },
    invokeCustomApi(opts) {
      const n = seen.length;
      seen.push(opts.api_name);
      const outcome = plan ? plan(n, opts) : 'ok';
      if (outcome === 'auto') return Promise.resolve({ result: '{"n":' + n + '}' });
      if (outcome === 'ok') return new Promise((res) => open.push(() => res({ result: '{"n":' + n + '}' })));
      return Promise.reject(outcome);
    }
  };
  return t;
}

function run(name, fn) {
  return fn().then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
  );
}

const READ = { api_name: 'getProductionWidgetData', payload: { supervisorId: '1', planId: '9' } };
function read(over) { return Object.assign({}, READ, over || {}); }
function write(name) { return { api_name: name || 'saveStageAssignment', payload: { payloadJson: '{}' } }; }

(async function () {
  console.log('\nAPI call wrapper\n');

  test('the allowlist holds only functions verified to have no writes', () => {
    // A name creeping onto this list without its .dg being checked is the one
    // way this can lose data, so the list itself is asserted.
    // Copied into this realm first - an array from the vm context has a
    // different Array prototype and deepStrictEqual compares those.
    assert.deepStrictEqual([].concat(COALESCE_SAFE).sort(), [
      'getDamageProposal', 'getExpectedWaste', 'getProductionWidgetData',
      'getReissueDrafts', 'getSupervisorCounts', 'getSupervisorDisputes',
      'getSupervisorMaterials', 'getSupervisorProductionHistory',
      'getSupervisorWasteReturns'
    ]);
    COALESCE_SAFE.forEach(function (n) {
      assert.ok(n.indexOf('get') === 0, n + ' is on the drop list but is not a getter');
    });
  });

  test('it refuses to wrap twice', () => {
    const t = makeTarget();
    assert.strictEqual(installApiThrottle(t, {}), installApiThrottle(t, {}));
  });

  test('it declines a bad target rather than throwing', () => {
    assert.strictEqual(installApiThrottle(null, {}), null);
    assert.strictEqual(installApiThrottle({}, {}), null);
  });

  await run('NO DATA LOSS: identical writes are all sent, never coalesced', async () => {
    const clock = makeClock();
    const t = makeTarget(() => 'auto');
    installApiThrottle(t, { maxInflight: 1, now: clock.now, setTimeout: clock.setTimeout });

    for (let n = 0; n < 4; n++) t.invokeCustomApi(write());
    await clock.advance(0);

    assert.strictEqual(t.seen.length, 4, 'a dropped save is a lost save');
  });

  await run('an unknown api is never dropped - forgetting one costs a call, not a write', async () => {
    const clock = makeClock();
    const t = makeTarget(() => 'auto');
    installApiThrottle(t, { maxInflight: 1, now: clock.now, setTimeout: clock.setTimeout });

    for (let n = 0; n < 3; n++) t.invokeCustomApi({ api_name: 'somethingNew', payload: {} });
    await clock.advance(0);
    assert.strictEqual(t.seen.length, 3);
  });

  await run('THE FIX: four identical queued refetches become one call', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installApiThrottle(t, { maxInflight: 1, now: clock.now, setTimeout: clock.setTimeout });

    // One occupies the single in-flight slot; three more queue behind it.
    const results = [];
    for (let n = 0; n < 4; n++) t.invokeCustomApi(read()).then((r) => results.push(r.result));
    await clock.advance(0);

    assert.strictEqual(t.seen.length, 1, 'only the first should have gone out yet');
    t.releaseAll();
    await settle();
    t.releaseAll();
    await settle();

    assert.strictEqual(t.seen.length, 2, 'the three queued reads should have collapsed into one');
    assert.strictEqual(results.length, 4, 'every caller must still be settled');
  });

  await run('reads with DIFFERENT payloads are not confused for one another', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installApiThrottle(t, { maxInflight: 1, now: clock.now, setTimeout: clock.setTimeout });

    // A write holds the only slot so the four reads all queue and can be seen
    // coalescing against each other rather than being dispatched one by one.
    t.invokeCustomApi(write());
    t.invokeCustomApi(read({ payload: { supervisorId: '1', planId: '9' } }));
    t.invokeCustomApi(read({ payload: { supervisorId: '1', planId: '9' } }));
    t.invokeCustomApi(read({ payload: { supervisorId: '2', planId: '9' } }));
    t.invokeCustomApi(read({ payload: { supervisorId: '2', planId: '9' } }));
    await clock.advance(0);
    assert.strictEqual(t.seen.length, 1, 'only the write should have gone out');

    for (let i = 0; i < 4; i++) { t.releaseAll(); await settle(); }

    assert.strictEqual(t.seen.length, 3,
      'plan 9 for two different supervisors are two questions, not one');
  });

  await run('a caller superseded twice over is still settled', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installApiThrottle(t, { maxInflight: 1, now: clock.now, setTimeout: clock.setTimeout });

    const settled = [];
    t.invokeCustomApi(write()).then(() => settled.push('w'));   // occupies the slot
    t.invokeCustomApi(read()).then(() => settled.push('r1'));
    t.invokeCustomApi(read()).then(() => settled.push('r2'));
    t.invokeCustomApi(read()).then(() => settled.push('r3'));
    await clock.advance(0);

    t.releaseAll();
    await settle();
    t.releaseAll();
    await settle();

    assert.deepStrictEqual(settled.sort(), ['r1', 'r2', 'r3', 'w'],
      'a chain of supersessions must not strand the earliest caller');
  });

  await run('an IN-FLIGHT read is never merged into - that would serve pre-save data', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installApiThrottle(t, { maxInflight: 4, now: clock.now, setTimeout: clock.setTimeout });

    t.invokeCustomApi(read());          // goes out immediately, stays open
    await clock.advance(0);
    assert.strictEqual(t.seen.length, 1);

    // A save lands, then the screen asks again. The second read must be its
    // own call, or it is answered with data from before the save.
    t.invokeCustomApi(read());
    await clock.advance(0);
    assert.strictEqual(t.seen.length, 2, 'the second read was merged into one already in flight');
  });

  await run('NOTHING IS PACED: a burst goes straight out', async () => {
    const clock = makeClock();
    const t = makeTarget(() => 'auto');
    installApiThrottle(t, { maxInflight: 4, now: clock.now, setTimeout: clock.setTimeout });

    for (let n = 0; n < 30; n++) t.invokeCustomApi(write('save' + n));
    await clock.advance(0);

    assert.strictEqual(t.seen.length, 30,
      'holding back calls Creator would have accepted is what hung the screen');
  });

  await run('concurrency is capped', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installApiThrottle(t, { maxInflight: 4, now: clock.now, setTimeout: clock.setTimeout });

    for (let n = 0; n < 10; n++) t.invokeCustomApi(write('save' + n));
    await clock.advance(0);
    assert.strictEqual(t.seen.length, 4, 'in flight at once: ' + t.seen.length);

    t.releaseAll();
    await settle();
    assert.ok(t.seen.length > 4, 'the queue never drained');
  });

  await run('a 2955 is retried - it was refused before executing, so nothing repeats', async () => {
    const clock = makeClock();
    let once = false;
    const t = makeTarget(() => {
      if (!once) { once = true; return { code: 2955, description: 'You have reached your API call limit for a minute.' }; }
      return 'auto';
    });
    installApiThrottle(t, { maxInflight: 1, retryWaitMs: 5000, now: clock.now, setTimeout: clock.setTimeout });

    let ok = false;
    t.invokeCustomApi(write()).then(() => { ok = true; });
    await clock.advance(6000);

    assert.strictEqual(t.seen.length, 2);
    assert.strictEqual(ok, true, 'the caller never saw its result');
  });

  await run('a bare 429 counts as the same condition', async () => {
    const clock = makeClock();
    let once = false;
    const t = makeTarget(() => { if (!once) { once = true; return { status: 429 }; } return 'auto'; });
    installApiThrottle(t, { maxInflight: 1, retryWaitMs: 1000, now: clock.now, setTimeout: clock.setTimeout });

    let ok = false;
    t.invokeCustomApi(read()).then(() => { ok = true; });
    await clock.advance(2000);
    assert.strictEqual(ok, true);
  });

  await run('ANY OTHER ERROR IS NOT RETRIED - a repeated save may happen twice', async () => {
    const clock = makeClock();
    const t = makeTarget(() => ({ code: 9430, description: 'something threw' }));
    installApiThrottle(t, { maxInflight: 1, retryWaitMs: 1000, now: clock.now, setTimeout: clock.setTimeout });

    let err = null;
    t.invokeCustomApi(write()).catch((e) => { err = e; });
    await clock.advance(5000);

    assert.strictEqual(t.seen.length, 1);
    assert.ok(err && err.code === 9430, 'the real error must reach the caller unchanged');
  });

  await run('a call rate-limited past its retries gives up rather than hanging', async () => {
    const clock = makeClock();
    const t = makeTarget(() => ({ code: 2955 }));
    installApiThrottle(t, { maxInflight: 1, maxRetries: 2, retryWaitMs: 1000, now: clock.now, setTimeout: clock.setTimeout });

    let err = null;
    t.invokeCustomApi(write()).catch((e) => { err = e; });
    await clock.advance(10000);

    assert.strictEqual(t.seen.length, 3, 'first try plus 2 retries');
    assert.ok(err && String(err.code) === '2955', 'the caller must be told, not left waiting');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    for (const f of failures) console.log('  - ' + f.name + ': ' + f.msg);
    process.exit(1);
  }
}());
