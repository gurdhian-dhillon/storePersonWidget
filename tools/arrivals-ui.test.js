#!/usr/bin/env node
// The "Check for arrivals" button, exercised in a stub DOM via vm.
//
//   usage: node tools/arrivals-ui.test.js
//
// What is being protected. The button is the store person's only visible
// evidence that the Inventory sync did anything, so every branch has to say
// something true:
//
//   - it calls runPurchaseInflow, the no-argument wrapper, never
//     syncPurchaseInflow - whose dryRun argument a caller can get wrong
//   - a real error does NOT get reported as "nothing new"
//   - the list reloads when something landed, and not when nothing did

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

// ---- pull the real functions out of main.js ---------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');
function extract(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has function ' + name +
    ' - the UI test contract changed; update tools/arrivals-ui.test.js');
  let depth = 0, j = mainSrc.indexOf('{', i);
  for (let k = j; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i, j);
}
const fns = ['renderStockIn', 'checkForArrivals', 'fmt'].map(extract).join('\n');

// ---- stub DOM ---------------------------------------------------------------
//
// The promise is resolved SYNCHRONOUSLY so the assertions can run straight
// after the call. A real microtask queue would need the whole harness to be
// async for no extra coverage - what is under test is the branching, not the
// scheduling.
function syncPromise(value, shouldReject) {
  return {
    then: function (onOk) {
      let threw = null;
      if (!shouldReject) {
        try { onOk(value); } catch (e) { threw = e; }
      }
      return {
        catch: function (onErr) {
          if (shouldReject) onErr(value);
          else if (threw) onErr(threw);
        }
      };
    }
  };
}

function makeWorld(apiResult, shouldReject) {
  const els = {};
  function el(id) {
    if (!els[id]) els[id] = { id: id, textContent: '', className: '', disabled: false, innerHTML: '' };
    return els[id];
  }
  el('panel-stockin');
  el('stockin-check');
  el('stockin-check-msg');

  const calls = [];
  const world = {
    els: els,
    calls: calls,
    reloads: 0,
    console: { log: function () {}, error: function () {} },
    document: {
      getElementById: function (id) { return els[id] || null; }
    },
    ZOHO: {
      CREATOR: {
        DATA: {
          invokeCustomApi: function (opts) {
            calls.push(opts);
            return syncPromise(
              shouldReject ? new Error('network') : { result: JSON.stringify(apiResult) },
              shouldReject
            );
          }
        }
      }
    },
    stockMats: [],
    stockFilter: '',
    stockInListHtml: function () { return '<!--list-->'; },
    loadStockIn: function () { world.reloads++; }
  };
  world.window = world;
  vm.createContext(world);
  vm.runInContext(fns, world);
  return world;
}

function msg(w) { return w.els['stockin-check-msg'].textContent; }
function cls(w) { return w.els['stockin-check-msg'].className; }

// ---- tests ------------------------------------------------------------------

console.log('\nCheck for arrivals\n');

test('the tab renders the button and its message slot', () => {
  const w = makeWorld({});
  w.renderStockIn();
  const html = w.els['panel-stockin'].innerHTML;
  assert.ok(html.indexOf('id="stockin-check"') !== -1, 'button missing');
  assert.ok(html.indexOf('checkForArrivals()') !== -1, 'handler not wired');
  assert.ok(html.indexOf('id="stockin-check-msg"') !== -1, 'message slot missing');
});

test('THE ONE THAT MATTERS: it calls runPurchaseInflow, not syncPurchaseInflow', () => {
  const w = makeWorld({ ran: true, result: { errors: [], netToUnallocated: 0, netToQuantity: 0 } });
  w.checkForArrivals();
  assert.strictEqual(w.calls.length, 1);
  assert.strictEqual(w.calls[0].api_name, 'runPurchaseInflow',
    'syncPurchaseInflow takes a dryRun argument - calling it from here is how the button ends up silently running as a dry run');
});

test('cloth that landed is reported in the units he is looking at', () => {
  const w = makeWorld({ ran: true, result: { errors: [], netToUnallocated: 50, netToQuantity: 0 } });
  w.checkForArrivals();
  assert.ok(msg(w).indexOf('50') !== -1, 'expected the quantity, got: ' + msg(w));
  assert.ok(msg(w).indexOf('unallocated') !== -1);
  assert.ok(cls(w).indexOf('is-good') !== -1);
  assert.strictEqual(w.reloads, 1, 'the list must redraw or the figure on screen is stale');
});

test('an accessory arrival is reported separately from fabric', () => {
  const w = makeWorld({ ran: true, result: { errors: [], netToUnallocated: 0, netToQuantity: 12 } });
  w.checkForArrivals();
  assert.ok(msg(w).indexOf('accessory') !== -1, 'got: ' + msg(w));
});

test('both at once are both reported', () => {
  const w = makeWorld({ ran: true, result: { errors: [], netToUnallocated: 50, netToQuantity: 12 } });
  w.checkForArrivals();
  assert.ok(msg(w).indexOf('unallocated') !== -1 && msg(w).indexOf('accessory') !== -1, 'got: ' + msg(w));
});

test('nothing new says so, and is not dressed up as success', () => {
  const w = makeWorld({ ran: true, result: { errors: [], netToUnallocated: 0, netToQuantity: 0 } });
  w.checkForArrivals();
  assert.strictEqual(msg(w), 'Nothing new.');
  assert.ok(cls(w).indexOf('is-good') === -1);
});

test('the wrapper failing outright is reported as a failure', () => {
  const w = makeWorld({ ran: false, reason: "DELUGE: Sync_Lock is not a form" });
  w.checkForArrivals();
  assert.ok(msg(w).indexOf('DELUGE') !== -1, 'got: ' + msg(w));
  assert.ok(cls(w).indexOf('is-bad') !== -1, 'ran:false means the sync never ran');
  assert.strictEqual(w.reloads, 0, 'nothing was written, so nothing to redraw');
});

test('a sync error is shown, and does NOT read as nothing new', () => {
  const w = makeWorld({ ran: true, result: { errors: ['purchasereceives code 57: unauthorised'], netToUnallocated: 0 } });
  w.checkForArrivals();
  assert.ok(msg(w).indexOf('unauthorised') !== -1, 'got: ' + msg(w));
  assert.ok(cls(w).indexOf('is-bad') !== -1);
  assert.strictEqual(w.reloads, 0, 'nothing landed, so nothing to redraw');
});

test('an arrival on an unmapped item is called out rather than read as nothing', () => {
  const w = makeWorld({ ran: true, result: { errors: [], netToUnallocated: 0, netToQuantity: 0, unmappedLines: 1 } });
  w.checkForArrivals();
  assert.ok(msg(w).indexOf('not set up') !== -1, 'got: ' + msg(w));
  assert.ok(cls(w).indexOf('is-bad') !== -1);
});

test('the button is re-enabled on every path, including a dead server', () => {
  const paths = [
    makeWorld({ ran: true, result: { errors: [], netToUnallocated: 50 } }),
    makeWorld({ ran: false, reason: 'DELUGE: boom' }),
    makeWorld({ ran: true, result: { errors: ['boom'] } }),
    makeWorld(null, true)
  ];
  paths.forEach(function (w, i) {
    w.checkForArrivals();
    assert.strictEqual(w.els['stockin-check'].disabled, false, 'stuck disabled on path ' + i);
    assert.strictEqual(w.els['stockin-check'].textContent, 'Check for arrivals', 'stuck label on path ' + i);
  });
});

test('an unreadable reply is reported, never swallowed', () => {
  const w = makeWorld({});
  // Force a parse failure the way a Creator 9430 page would.
  w.ZOHO.CREATOR.DATA.invokeCustomApi = function () {
    w.calls.push({});
    return syncPromise({ result: '<html>code 9430</html>' }, false);
  };
  w.checkForArrivals();
  assert.ok(cls(w).indexOf('is-bad') !== -1, 'got: ' + msg(w));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.msg);
  process.exit(1);
}
