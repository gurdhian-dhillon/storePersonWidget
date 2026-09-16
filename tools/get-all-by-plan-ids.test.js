#!/usr/bin/env node
// ApiExperiment._getAllByPlanIds — the plan-id-chunked fetch that replaced
// getAll(RPT.reqs, null) / getAll(RPT.planItems, null) so the store screen's
// read stays bounded by open plans (current WIP) instead of a form's entire
// history. See app/js/api-experiment.js's comment above getAllByPlanIds for
// the full reasoning.
//
//   usage: node tools/get-all-by-plan-ids.test.js
//
// What is being protected:
//   - ids are chunked at exactly PLAN_CHUNK (25), not off-by-one either side
//   - an id count under one chunk makes exactly one underlying call
//   - rows from every chunk are merged into one flat array, none dropped
//   - calls are summed across chunks, so _stats stays accurate
//   - an empty planIds list short-circuits to {rows:[], calls:0} WITHOUT
//     calling getRecords at all — the critical guard, since an empty
//     criteria on getRecords means "fetch everything", the exact bug this
//     function exists to avoid
//   - a hard error in ANY chunk rejects the WHOLE merged fetch (fails loud),
//     documented here as deliberate — not something a future reader should
//     "fix" into a per-chunk try/catch, since silently dropping a chunk of
//     real material-requirement rows would hide demand from the store screen

'use strict';
const assert = require('assert');
const ApiExperiment = require('../app/js/api-experiment.js');

let passed = 0, failed = 0;
const failures = [];
function run(name, fn) {
  return fn().then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); }
  );
}

// Stub ZOHO.CREATOR.DATA.getRecords so _getAllByPlanIds' internal getAll()
// calls resolve from fixtures instead of hitting a real Creator instance.
// Records the criteria string of every call made, so chunk boundaries and
// call counts can be asserted directly.
function installStub(plan) {
  global.ZOHO = {
    CREATOR: {
      DATA: {
        getRecords: function (cfg) {
          const n = seen.length;
          seen.push(cfg.criteria);
          const outcome = plan ? plan(n, cfg) : 'empty';
          if (outcome === 'empty') return Promise.resolve({ data: [] });
          if (outcome && outcome.rows) return Promise.resolve({ data: outcome.rows });
          return Promise.reject(outcome); // an error object
        }
      }
    }
  };
  var seen = [];
  global.ZOHO.CREATOR.DATA.getRecords.seen = seen;
  return seen;
}

function ids(n, offset) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(String(3955559000000000000 + (offset || 0) + i));
  return out;
}

(async function () {
  console.log('\ngetAllByPlanIds (plan-scoped, chunked reads)\n');

  await run('an empty id list never calls getRecords at all', async () => {
    const seen = installStub();
    const result = await ApiExperiment._getAllByPlanIds('Material_Requirement_Report', []);
    assert.strictEqual(seen.length, 0, 'an empty criteria on getRecords means fetch-everything — must never be reached');
    assert.deepStrictEqual(result, { rows: [], calls: 0 });
  });

  await run('under one chunk makes exactly one call', async () => {
    const seen = installStub(() => ({ rows: [{ ID: 'r1' }, { ID: 'r2' }] }));
    const result = await ApiExperiment._getAllByPlanIds('Material_Requirement_Report', ids(10));
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(result.rows.length, 2);
    assert.strictEqual(result.calls, 1);
  });

  await run('exactly PLAN_CHUNK (25) ids still makes one call', async () => {
    const seen = installStub(() => ({ rows: [{ ID: 'r1' }] }));
    await ApiExperiment._getAllByPlanIds('Material_Requirement_Report', ids(25));
    assert.strictEqual(seen.length, 1, '25 ids must not spill into a second chunk');
  });

  await run('26 ids splits into two chunks (25 + 1)', async () => {
    const seen = installStub(() => ({ rows: [{ ID: 'r1' }] }));
    await ApiExperiment._getAllByPlanIds('Material_Requirement_Report', ids(26));
    assert.strictEqual(seen.length, 2);
    assert.strictEqual((seen[0].match(/Plan ==/g) || []).length, 25);
    assert.strictEqual((seen[1].match(/Plan ==/g) || []).length, 1);
  });

  await run('60 ids splits into three chunks of 25/25/10', async () => {
    const seen = installStub(() => ({ rows: [{ ID: 'r1' }] }));
    await ApiExperiment._getAllByPlanIds('Material_Requirement_Report', ids(60));
    assert.strictEqual(seen.length, 3);
    assert.strictEqual((seen[0].match(/Plan ==/g) || []).length, 25);
    assert.strictEqual((seen[1].match(/Plan ==/g) || []).length, 25);
    assert.strictEqual((seen[2].match(/Plan ==/g) || []).length, 10);
  });

  await run('rows from every chunk are merged, none dropped', async () => {
    const seen = installStub((n) => ({ rows: [{ ID: 'chunk' + n + '-a' }, { ID: 'chunk' + n + '-b' }] }));
    const result = await ApiExperiment._getAllByPlanIds('Material_Requirement_Report', ids(60));
    assert.strictEqual(seen.length, 3);
    assert.strictEqual(result.rows.length, 6, 'two rows per chunk across three chunks');
    assert.strictEqual(result.calls, 3);
    const gotIds = result.rows.map(r => r.ID).sort();
    assert.deepStrictEqual(gotIds, [
      'chunk0-a', 'chunk0-b', 'chunk1-a', 'chunk1-b', 'chunk2-a', 'chunk2-b'
    ].sort());
  });

  await run('a hard error in one chunk rejects the WHOLE merged fetch (fail loud, not per-chunk)', async () => {
    const seen = installStub((n) => n === 1 ? { code: 500, message: 'boom' } : { rows: [{ ID: 'ok' }] });
    let rejected = null;
    try {
      await ApiExperiment._getAllByPlanIds('Material_Requirement_Report', ids(60));
    } catch (e) {
      rejected = e;
    }
    assert.ok(rejected, 'a genuine criteria/parser error in any chunk must fail the whole call — ' +
      'silently dropping a chunk of requirement rows would hide real material demand');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  if (failed) process.exit(1);
}());
