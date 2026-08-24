#!/usr/bin/env node
// installApiThrottle, driven by a virtual clock so a rolling-minute window can
// be tested without waiting a minute.
//
//   usage: node tools/api-throttle.test.js
//
// What is being protected:
//
//   - a burst is PACED, not refused (the bug: code 2955 on fast working)
//   - a 2955 is retried; ANYTHING ELSE is not, because a retried save is a
//     save that might happen twice
//   - order is preserved, including across a retry
//   - the window ROLLS - calls are not blocked for ever after one burst

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
const i = src.indexOf('function installApiThrottle(');
if (i < 0) throw new Error('api-throttle.js no longer defines installApiThrottle');
let depth = 0, end = src.indexOf('{', i);
for (let k = end; k < src.length; k++) {
  if (src[k] === '{') depth++;
  else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
}
const ctx = { Promise: Promise, Date: Date, console: { log() {}, warn() {} }, setTimeout: setTimeout };
vm.createContext(ctx);
vm.runInContext(src.slice(i, end), ctx);
const installApiThrottle = ctx.installApiThrottle;

// ---- virtual clock ---------------------------------------------------------
function makeClock() {
  let t = 0;
  const pending = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { pending.push({ at: t + ms, fn }); },
    // Advance time, firing timers, then let the microtask queue drain.
    //
    // SETTLES FIRST, and that is not a detail: a rejection already sitting in
    // the microtask queue has to be handled at the time it happened. Moving the
    // clock before draining it made the throttle compute its retry wait from a
    // moment in the future, and the test read that as the retry never firing.
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
function settle() { return new Promise(r => setImmediate(r)); }

// A fake invokeCustomApi. `plan` maps call index -> 'ok' | rate-limit | error.
function makeTarget(plan) {
  const seen = [];
  return {
    seen,
    invokeCustomApi(opts) {
      const n = seen.length;
      seen.push(opts.api_name);
      const outcome = plan ? plan(n, opts) : 'ok';
      if (outcome === 'ok') return Promise.resolve({ result: '{}' });
      return Promise.reject(outcome);
    }
  };
}

function run(name, fn) {
  // Each async test is run to completion before the next starts.
  return fn().then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
  );
}

// ---- tests -----------------------------------------------------------------

(async function () {
  console.log('\nAPI throttle\n');

  test('it refuses to wrap twice - double wrapping would halve the rate', () => {
    const t = makeTarget();
    const first = installApiThrottle(t, {});
    const second = installApiThrottle(t, {});
    assert.strictEqual(first, second);
  });

  test('it declines a target with no invokeCustomApi rather than throwing', () => {
    assert.strictEqual(installApiThrottle(null, {}), null);
    assert.strictEqual(installApiThrottle({}, {}), null);
  });

  await run('THE BUG: a burst past the limit is paced, not refused', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installApiThrottle(t, { maxPerMin: 10, maxInflight: 3, now: clock.now, setTimeout: clock.setTimeout });

    const done = [];
    for (let n = 0; n < 16; n++) {
      t.invokeCustomApi({ api_name: 'call' + n }).then(() => done.push(n));
    }
    await clock.advance(0);

    assert.strictEqual(t.seen.length, 10, 'expected the first 10 through, got ' + t.seen.length);
    assert.strictEqual(done.length, 10);

    // The window has not rolled yet, so nothing more may go.
    await clock.advance(30000);
    assert.strictEqual(t.seen.length, 10, 'went early - the window had not rolled');

    // Past 60s from the first call, the rest follow.
    await clock.advance(31000);
    assert.strictEqual(t.seen.length, 16, 'the queue never drained');
    assert.strictEqual(done.length, 16, 'callers were left hanging');
  });

  await run('the queue drains in order', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installApiThrottle(t, { maxPerMin: 3, maxInflight: 3, now: clock.now, setTimeout: clock.setTimeout });

    for (let n = 0; n < 6; n++) t.invokeCustomApi({ api_name: 'c' + n });
    await clock.advance(0);
    await clock.advance(61000);

    assert.deepStrictEqual(t.seen, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
      'two saves fired in sequence must reach the server in that sequence');
  });

  await run('a 2955 is retried, and keeps its place at the front', async () => {
    const clock = makeClock();
    // First attempt at c0 is rate limited; everything after succeeds.
    let limited = false;
    const t = makeTarget((n, opts) => {
      if (opts.api_name === 'c0' && !limited) { limited = true; return { code: 2955, description: 'You have reached your API call limit for a minute.' }; }
      return 'ok';
    });
    installApiThrottle(t, { maxPerMin: 50, maxInflight: 1, retryWaitMs: 5000, now: clock.now, setTimeout: clock.setTimeout });

    let ok = false;
    t.invokeCustomApi({ api_name: 'c0' }).then(() => { ok = true; });
    t.invokeCustomApi({ api_name: 'c1' });
    await clock.advance(0);
    await clock.advance(6000);

    assert.deepStrictEqual(t.seen, ['c0', 'c0', 'c1'],
      'the retry must go before the call queued behind it');
    assert.strictEqual(ok, true, 'the caller never saw its result');
  });

  await run('a bare 429 counts as the same condition', async () => {
    const clock = makeClock();
    let once = false;
    const t = makeTarget(() => { if (!once) { once = true; return { status: 429 }; } return 'ok'; });
    installApiThrottle(t, { maxPerMin: 50, maxInflight: 1, retryWaitMs: 1000, now: clock.now, setTimeout: clock.setTimeout });

    let ok = false;
    t.invokeCustomApi({ api_name: 'c0' }).then(() => { ok = true; });
    await clock.advance(2000);
    assert.strictEqual(ok, true);
    assert.strictEqual(t.seen.length, 2);
  });

  await run('ANY OTHER ERROR IS NOT RETRIED - a retried save may happen twice', async () => {
    const clock = makeClock();
    const t = makeTarget(() => ({ code: 9430, description: 'something threw' }));
    installApiThrottle(t, { maxPerMin: 50, maxInflight: 1, retryWaitMs: 1000, now: clock.now, setTimeout: clock.setTimeout });

    let err = null;
    t.invokeCustomApi({ api_name: 'save' }).catch((e) => { err = e; });
    await clock.advance(5000);

    assert.strictEqual(t.seen.length, 1, 'a failed save must not be repeated');
    assert.ok(err && err.code === 9430, 'the real error must reach the caller unchanged');
  });

  await run('a call that keeps being rate limited eventually gives up', async () => {
    const clock = makeClock();
    const t = makeTarget(() => ({ code: 2955 }));
    installApiThrottle(t, { maxPerMin: 50, maxInflight: 1, maxRetries: 2, retryWaitMs: 1000, now: clock.now, setTimeout: clock.setTimeout });

    let err = null;
    t.invokeCustomApi({ api_name: 'c0' }).catch((e) => { err = e; });
    await clock.advance(10000);

    assert.strictEqual(t.seen.length, 3, 'expected the first try plus 2 retries');
    assert.ok(err && String(err.code) === '2955', 'the caller must be told, not left hanging');
  });

  await run('concurrency is capped', async () => {
    const clock = makeClock();
    let peak = 0, live = 0;
    const resolvers = [];
    const t = {
      seen: [],
      invokeCustomApi(opts) {
        t.seen.push(opts.api_name);
        live++; peak = Math.max(peak, live);
        return new Promise((res) => resolvers.push(() => { live--; res({ result: '{}' }); }));
      }
    };
    installApiThrottle(t, { maxPerMin: 50, maxInflight: 3, now: clock.now, setTimeout: clock.setTimeout });

    for (let n = 0; n < 9; n++) t.invokeCustomApi({ api_name: 'c' + n });
    await clock.advance(0);
    assert.strictEqual(peak, 3, 'peak in flight was ' + peak);

    while (resolvers.length) { resolvers.shift()(); await settle(); }
    assert.strictEqual(t.seen.length, 9, 'the rest never went');
  });

  await run('the window rolls - a second burst a minute later is not blocked', async () => {
    const clock = makeClock();
    const t = makeTarget();
    installApiThrottle(t, { maxPerMin: 5, maxInflight: 5, now: clock.now, setTimeout: clock.setTimeout });

    for (let n = 0; n < 5; n++) t.invokeCustomApi({ api_name: 'a' + n });
    await clock.advance(0);
    assert.strictEqual(t.seen.length, 5);

    await clock.advance(61000);
    for (let n = 0; n < 5; n++) t.invokeCustomApi({ api_name: 'b' + n });
    await clock.advance(0);
    assert.strictEqual(t.seen.length, 10, 'the second burst was held although the window had rolled');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    for (const f of failures) console.log('  - ' + f.name + ': ' + f.msg);
    process.exit(1);
  }
}());
