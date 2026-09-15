#!/usr/bin/env node
// installDataThrottle, driven by a virtual clock. Mirrors
// tools/api-throttle.test.js's technique and virtual clock, for the
// getRecords counterpart in app/js/data-throttle.js.
//
//   usage: node tools/data-throttle.test.js
//
// What is being protected:
//   - a burst of getRecords calls beyond maxInflight queues rather than all
//     going out at once (that burst is exactly what trips Creator's 2955
//     "maximum number of API calls that can be simultaneously initiated")
//   - a 2955 (or 429, or the stringified-body equivalent) is retried, because
//     it was refused before executing and a read-only retry repeats no work
//   - a non-rate-limit rejection is never retried, and is never confused for
//     one
//   - every caller is eventually settled - nothing queued is silently dropped
//     (unlike api-throttle.js, this file does no coalescing at all)
//   - a call whose promise never settles does not wedge the queue forever -
//     the timeout frees its slot and rejects only that caller

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
  path.join(__dirname, '..', 'app', 'js', 'data-throttle.js'), 'utf8');
function grab(decl) {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error('data-throttle.js no longer has: ' + decl);
  let depth = 0, end = src.indexOf('{', i);
  for (let k = end; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  return src.slice(i, end);
}
const ctx = { Promise, Date, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, JSON, Array };
vm.createContext(ctx);
vm.runInContext(grab('function installDataThrottle('), ctx);
const installDataThrottle = ctx.installDataThrottle;

// ---- virtual clock (identical shape to api-throttle.test.js) ---------------
function settle() { return new Promise(r => setImmediate(r)); }
function makeClock() {
  let t = 0;
  const pending = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const rec = { at: t + ms, fn, alive: true }; pending.push(rec); return rec; },
    clearTimeout: (rec) => { if (rec) rec.alive = false; },
    async advance(ms) {
      await settle();
      const target = t + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending.find(p => p.alive);
        if (!next || next.at > target) break;
        pending.splice(pending.indexOf(next), 1);
        t = next.at;
        next.fn();
        await settle();
      }
      t = target;
      await settle();
    }
  };
}

// A fake getRecords. Calls stay pending until released or left to hang.
function makeTarget(plan) {
  const seen = [];
  const open = [];
  const t = {
    seen,
    open,
    releaseAll() { while (open.length) open.shift()(); },
    getRecords(cfg) {
      const n = seen.length;
      seen.push(cfg.report_name);
      const outcome = plan ? plan(n, cfg) : 'ok';
      if (outcome === 'auto') return Promise.resolve({ data: [] });
      if (outcome === 'hang') return new Promise(() => {}); // never settles
      if (outcome === 'ok') return new Promise((res) => open.push(() => res({ data: [] })));
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

function cfg(name) { return { report_name: name, field_config: 'all', max_records: 1000 }; }

(async function () {
  console.log('\ngetRecords throttle\n');

  test('it refuses to wrap twice', () => {
    const t = makeTarget();
    assert.strictEqual(installDataThrottle(t, {}), installDataThrottle(t, {}));
  });

  test('it declines a bad target rather than throwing', () => {
    assert.strictEqual(installDataThrottle(null, {}), null);
    assert.strictEqual(installDataThrottle({}, {}), null);
  });

  await run('a burst beyond maxInflight queues instead of all going out at once', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installDataThrottle(t, { maxInflight: 4, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    // The store screen's real burst: 8 simultaneous report fetches.
    const names = ['plans', 'reqs', 'emps', 'planItems', 'rawMat', 'lots', 'waste', 'exceptions'];
    names.forEach(n => t.getRecords(cfg(n)));
    await clock.advance(0);

    assert.strictEqual(t.seen.length, 4, 'only maxInflight should be dispatched up front');
    t.releaseAll();
    await settle();
    assert.strictEqual(t.seen.length, 8, 'the rest should follow once slots free up');
  });

  await run('every queued call is eventually settled, none dropped', async () => {
    const clock = makeClock();
    const t = makeTarget(() => 'auto');
    installDataThrottle(t, { maxInflight: 2, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    const results = [];
    for (let n = 0; n < 6; n++) t.getRecords(cfg('r' + n)).then(r => results.push(r));
    await clock.advance(0);
    assert.strictEqual(results.length, 6, 'no getRecords call may vanish');
  });

  await run('a 2955 is retried after the wait, and the call eventually succeeds', async () => {
    const clock = makeClock();
    const t = makeTarget((n) => n === 0 ? { code: 2955, description: 'You have reached the maximum number of API calls that can be simultaneously initiated at a time.' } : 'auto');
    installDataThrottle(t, { maxInflight: 1, retryWaitMs: 6000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    let resolved = null;
    t.getRecords(cfg('waste')).then(r => resolved = r);
    await clock.advance(0);
    assert.strictEqual(resolved, null, 'must not resolve on the first, rejected attempt');

    await clock.advance(6000);
    assert.ok(resolved, 'must resolve once the retry goes through');
  });

  await run('a 429 status is treated the same as a 2955 code', async () => {
    const clock = makeClock();
    const t = makeTarget((n) => n === 0 ? { status: 429, message: 'Too Many Requests' } : 'auto');
    installDataThrottle(t, { maxInflight: 1, retryWaitMs: 1000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    let resolved = null;
    t.getRecords(cfg('lots')).then(r => resolved = r);
    await clock.advance(0);
    await clock.advance(1000);
    assert.ok(resolved, 'a bare 429 must retry exactly like code 2955');
  });

  await run('a non-rate-limit error is never retried', async () => {
    const clock = makeClock();
    const t = makeTarget(() => ({ code: 500, message: 'boom' }));
    installDataThrottle(t, { maxInflight: 1, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    let rejected = null;
    t.getRecords(cfg('emps')).catch(e => rejected = e);
    await clock.advance(0);
    assert.ok(rejected, 'a genuine error must reject, not hang waiting for a retry that will never help');
    assert.strictEqual(t.seen.length, 1, 'must not have been retried');
  });

  await run('retries stop after maxRetries and the caller is rejected', async () => {
    const clock = makeClock();
    const t = makeTarget(() => ({ code: 2955 }));
    installDataThrottle(t, { maxInflight: 1, maxRetries: 2, retryWaitMs: 1000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    let rejected = null;
    t.getRecords(cfg('plans')).catch(e => rejected = e);
    await clock.advance(0);
    await clock.advance(1000);
    await clock.advance(1000);
    await clock.advance(1000);
    assert.ok(rejected, 'must give up and reject once maxRetries is exhausted');
    assert.strictEqual(t.seen.length, 3, 'the original attempt plus exactly maxRetries retries');
  });

  await run('THE FIX: a hung call times out and frees its slot instead of wedging the queue', async () => {
    const clock = makeClock();
    const t = makeTarget((n) => n === 0 ? 'hang' : 'auto');
    installDataThrottle(t, { maxInflight: 1, callTimeoutMs: 25000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    let hungRejected = null;
    let secondResolved = null;
    t.getRecords(cfg('hangs-forever')).catch(e => hungRejected = e);
    t.getRecords(cfg('waiting-behind-it')).then(r => secondResolved = r);
    await clock.advance(0);
    assert.strictEqual(t.seen.length, 1, 'the second call must be queued behind the hung one, not dispatched yet');
    assert.strictEqual(hungRejected, null, 'must not time out before callTimeoutMs has elapsed');

    await clock.advance(25000);
    assert.ok(hungRejected, 'the hung call must be rejected once its timeout fires');
    assert.ok(secondResolved, 'the freed slot must let the queued call go out and complete');
  });

  await run('a timed-out call cannot double-resolve if it settles late', async () => {
    const clock = makeClock();
    let releaseHung;
    const t = {
      seen: [],
      getRecords(c) {
        t.seen.push(c.report_name);
        return new Promise((res) => { releaseHung = () => res({ data: ['late'] }); });
      }
    };
    installDataThrottle(t, { maxInflight: 1, callTimeoutMs: 1000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    let settledValue = 'unset';
    let settledAs = null;
    t.getRecords(cfg('slow')).then(
      (v) => { settledValue = v; settledAs = 'resolved'; },
      (e) => { settledValue = e; settledAs = 'rejected'; }
    );
    await clock.advance(1000); // timeout fires, job rejected
    assert.strictEqual(settledAs, 'rejected');

    releaseHung(); // the real call finally answers, after the timeout already gave up on it
    await settle();
    assert.strictEqual(settledAs, 'rejected', 'the late real answer must not override the timeout rejection');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  if (failed) process.exit(1);
}());
