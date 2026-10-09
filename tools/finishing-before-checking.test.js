#!/usr/bin/env node
// Finishing now runs BEFORE checking, and folding / branding moved to packing.
//
//   usage: node tools/finishing-before-checking.test.js
//
// Three things are exercised, and the first needs saying plainly:
//
//   1. THE ORDER-STATUS DECISION is a MIRROR of recheckOrderComplete.dg, ported
//      to JS so the lifecycle can be walked scenario by scenario. Deluge cannot
//      run here, so this proves the DESIGN is consistent - the same way
//      deluge-maths.test.js proves the arithmetic. It does NOT prove the Deluge;
//      that needs an Execute in Creator. The source-shape checks at the end
//      are there so the mirror and the file cannot drift apart unnoticed.
//   2. The packing widget really gates its save on Start packing + the two
//      ticks, and sends them (real app/packing/js/main.js in a stub DOM).
//   3. The finishing widget really has two stages, thread cutting then pressing,
//      and starts a job from the batch id.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '\n         ' + detail : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ===========================================================================
console.log('\nORDER STATUS — mirror of recheckOrderComplete.dg:');
// ===========================================================================
// items: [{ status, finished, ordered, accepted, remake, root }]
function decide(order, items) {
  const out = { status: order.status, verdict: '' };
  let stillMaking = false, inProduction = false, awaitingFinish = false;
  const orderedByRoot = {}, acceptedByRoot = {}, roots = [];
  items.forEach(function (it, i) {
    const key = it.remake ? String(it.root) : String(i);
    if (it.status !== 'Complete') stillMaking = true;
    if (it.status === 'Awaiting_Check') { if (!it.finished) awaitingFinish = true; }
    else if (it.status !== 'Complete') inProduction = true;
    acceptedByRoot[key] = (acceptedByRoot[key] || 0) + (it.accepted || 0);
    if (!it.remake) { orderedByRoot[key] = it.ordered; roots.push(key); }
  });
  let whole = true;
  roots.forEach(function (k) {
    if ((acceptedByRoot[k] || 0) < orderedByRoot[k] && !order.shortClosed) whole = false;
  });
  if (!items.length) { out.verdict = 'SKIP'; return out; }

  out.verdict = 'NO MOVE';
  if (inProduction) out.verdict = 'NOT YET: in production';
  else if (awaitingFinish) out.verdict = 'NOT YET: waiting for finishing';
  else if (out.status === 'Production Complete' || out.status === 'In Progress') {
    out.status = 'Finishing Complete';
    out.verdict = 'FINISHING COMPLETE';
  }

  if (stillMaking) out.verdict += ' | CHECKING: still open';
  else if (!whole) out.verdict += ' | CHECKING: short';
  else if (['Finishing Complete', 'Production Complete', 'In Progress'].indexOf(out.status) > -1) {
    out.status = 'Checking Passed';
    out.verdict += ' | PASSED';
  }
  return out;
}
const O = (status, extra) => Object.assign({ status: status, shortClosed: false }, extra || {});

let r = decide(O('In Progress'), [{ status: 'In_Production', ordered: 10 }, { status: 'Awaiting_Check', finished: false, ordered: 5 }]);
check('batches still being cut: nothing moves', r.status === 'In Progress' && /in production/.test(r.verdict), r.verdict);

r = decide(O('Production Complete'), [{ status: 'Awaiting_Check', finished: true, ordered: 5 }, { status: 'Awaiting_Check', finished: false, ordered: 5 }]);
check('one batch not yet finished: order stays Production Complete', r.status === 'Production Complete' && /waiting for finishing/.test(r.verdict), r.verdict);

r = decide(O('Production Complete'), [{ status: 'Awaiting_Check', finished: true, ordered: 5 }, { status: 'Awaiting_Check', finished: true, ordered: 5 }]);
check('every batch finished: Finishing Complete, but NOT Checking Passed', r.status === 'Finishing Complete', r.verdict);

r = decide(O('Finishing Complete'), [{ status: 'Complete', accepted: 5, ordered: 5 }, { status: 'Awaiting_Check', finished: true, ordered: 5 }]);
check('half checked: still Finishing Complete', r.status === 'Finishing Complete' && /CHECKING: still open/.test(r.verdict), r.verdict);

r = decide(O('Finishing Complete'), [{ status: 'Complete', accepted: 5, ordered: 5 }, { status: 'Complete', accepted: 5, ordered: 5 }]);
check('all checked and the quantity met: Checking Passed', r.status === 'Checking Passed', r.verdict);

r = decide(O('Finishing Complete'), [{ status: 'Complete', accepted: 3, ordered: 5 }]);
check('all checked but SHORT: stays Finishing Complete', r.status === 'Finishing Complete' && /short/.test(r.verdict), r.verdict);

r = decide(O('Finishing Complete', { shortClosed: true }), [{ status: 'Complete', accepted: 3, ordered: 5 }]);
check('short-closed forgives the quantity: Checking Passed', r.status === 'Checking Passed', r.verdict);

r = decide(O('Production Complete'), [{ status: 'Complete', accepted: 5, ordered: 5 }]);
check('a lost finishing close does not strand the order: both statuses in one pass', r.status === 'Checking Passed', r.verdict);

r = decide(O('Packed'), [{ status: 'Complete', accepted: 5, ordered: 5 }]);
check('FORWARD ONLY: a Packed order is never pulled back', r.status === 'Packed', r.verdict);

r = decide(O('Checking Passed'), [{ status: 'Complete', accepted: 5, ordered: 5 }]);
check('FORWARD ONLY: Checking Passed stays put on a re-run', r.status === 'Checking Passed', r.verdict);

// A rejection: saveItemCheck pulls Finishing Complete back, the remake runs the
// whole line again, and the order walks forward a second time.
r = decide(O('In Progress'), [{ status: 'Complete', accepted: 8, ordered: 10 }, { status: 'In_Production', remake: true, root: 0, ordered: 2 }]);
check('after a rejection the remake holds the order in production', r.status === 'In Progress', r.verdict);
r = decide(O('Production Complete'), [{ status: 'Complete', accepted: 8, ordered: 10 }, { status: 'Awaiting_Check', remake: true, root: 0, finished: true, ordered: 2 }]);
check('remake finished: Finishing Complete again', r.status === 'Finishing Complete', r.verdict);
r = decide(O('Finishing Complete'), [{ status: 'Complete', accepted: 8, ordered: 10 }, { status: 'Complete', remake: true, root: 0, accepted: 2, ordered: 2 }]);
check('remake checked: the line reaches 10 of 10 and the order passes', r.status === 'Checking Passed', r.verdict);

// ===========================================================================
console.log('\nSOURCE SHAPE — the mirror and the .dg cannot drift unnoticed:');
// ===========================================================================
const recheck = read('deluge/recheckOrderComplete.dg');
check('recheckOrderComplete writes Finishing Complete BEFORE Checking Passed',
  recheck.indexOf('soFin.Order_Status = "Finishing Complete"') > -1 &&
  recheck.indexOf('soFin.Order_Status = "Finishing Complete"') < recheck.indexOf('soSet.Order_Status = "Checking Passed"'));
check('it no longer reads Item_Check or per-check Finishing_Data to decide finishing',
  !/Item_Check\[Sales_Order == orderId/.test(recheck) && !/Finishing_Data\[Item_Check/.test(recheck));
check('it reads finishing ONCE PER PLAN (Done only), not once per batch',
  /Finishing_Data\[Plan == plR\.ID && Finishing_Status == "Done"\]/.test(recheck) && !/Finishing_Data\[Plan_Item ==/.test(recheck) &&
  /doneItemKeys\.contains\(itR\.ID\.toString\(\)\)/.test(recheck));

const saveCheck = read('deluge/saveItemCheck.dg');
check('saveItemCheck refuses a batch whose finishing is not Done',
  /Finishing_Data\[Plan_Item == itemId && Finishing_Status == "Done"\]/.test(saveCheck) && /has not been finished yet/.test(saveCheck));
check('saveItemCheck pulls the order back from Finishing Complete as well',
  /sStNow == "Production Complete" \|\| sStNow == "Finishing Complete"/.test(saveCheck));

const queue = read('deluge/getCheckingQueue.dg');
check('the checker queue only offers a batch whose finishing is Done, read once per plan',
  /Finishing_Data\[Plan == planKey\.toLong\(\) && Finishing_Status == "Done"\]/.test(queue) && !/Finishing_Data\[Plan_Item ==/.test(queue) &&
  /finDoneByPlan\.get\(planKey\)/.test(queue));
check('startFinishingJob stamps the Plan so those reads work',
  /fNew\.Plan = planRef/.test(read('deluge/finishingScripts/startFinishingJob.dg')));

['startFinishingJob', 'completeFinishingJob', 'getFinishingItems'].forEach(function (f) {
  const src = read('deluge/finishingScripts/' + f + '.dg');
  check(f + ' works on the batch (Plan_Item), not an Item_Check',
    /Plan_Item/.test(src) && !/Item_Check\[/.test(src) && !/Finishing_Data\[Item_Check/.test(src));
});
const stage = read('deluge/finishingScripts/saveFinishingStage.dg');
const stageCode = stage.replace(/^\s*\/\/.*$/gm, '');
check('saveFinishingStage knows thread cutting and pressing only',
  /stageTxt != "threadcutting" && stageTxt != "pressing"/.test(stageCode) && !/Folding_|Branding_/.test(stageCode));

const packSave = read('deluge/packingScripts/savePackingRecord.dg');
check('savePackingRecord packs from Checking Passed and writes Packed from it',
  /statusNow != "Checking Passed"/.test(packSave) && /== "Checking Passed"\)\s*\{\s*soSet\.Order_Status = "Packed"/.test(packSave));
check('it requires the start time and both ticks, and stores them',
  /packStartedOn == null/.test(packSave) && /foldedTxt != "true"/.test(packSave) && /brandedTxt != "true"/.test(packSave) &&
  /Is_Folded = true/.test(packSave) && /Is_Branded = true/.test(packSave) &&
  /Packing_Start_Time = packStartedOn/.test(packSave) && /Packing_End_Time = zoho\.currenttime/.test(packSave));
check('packing no longer reads Finishing_Data anywhere',
  ['savePackingRecord', 'getPackingQueue', 'getPackingDetails'].every(f => !/Finishing_Data\[/.test(read('deluge/packingScripts/' + f + '.dg'))));
check('getPackingQueue offers only Checking Passed orders',
  /Sales_Order\[Order_Status == "Checking Passed"\]/.test(read('deluge/packingScripts/getPackingQueue.dg')));
const startPack = read('deluge/packingScripts/startPacking.dg');
check('startPacking is idempotent and stamps the server clock',
  /existingTxt != ""/.test(startPack) && /Packing_Started_On = zoho\.currenttime/.test(startPack));

// ===========================================================================
console.log('\nPACKING WIDGET — Start packing + two ticks gate the save:');
// ===========================================================================
function makeEl() {
  return {
    innerHTML: '', innerText: '', value: '', disabled: false, checked: false, className: '',
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, setAttribute() {}
  };
}
const els = {};
const doc = { getElementById(id) { return els[id] || (els[id] = makeEl()); }, querySelectorAll() { return []; } };
const winObj = { location: { search: '' } };
winObj.self = winObj; winObj.top = winObj;
const packCtx = {
  console: { log() {}, warn() {}, error() {} }, document: doc, window: winObj,
  Promise, JSON, Object, Number, String, Math, Date, isNaN, Array, URLSearchParams, setTimeout, clearTimeout,
  alert() {}, URL: { revokeObjectURL() {} }
};
vm.createContext(packCtx);
vm.runInContext(read('app/packing/js/main.js') + '\nthis.PackingScreen = PackingScreen;', packCtx);
const PS = packCtx.PackingScreen;

PS._setQueue([{ id: '9001', orderNo: 'SO-1', supervisorId: '10', supervisorName: 'S', itemCount: 1, totalPieces: 5, startedAt: '' }]);
PS._setup({ salesOrderId: '9001', orderNo: 'SO-1', items: [{ lineNo: 1, sku: 'A', itemName: 'Sheet', qty: 5, unitWeight: 1 }], boxes: [] });
let probs = PS._problems();
check('a fresh order is blocked until Start packing is pressed', probs.indexOf('Press Start packing first') > -1, JSON.stringify(probs));
check('and until Folded is ticked', probs.some(p => /Folded/.test(p)));
check('and until Branded is ticked', probs.some(p => /Branded/.test(p)));

PS.startPacking();
check('Start packing records a start time on the order', !!PS._state().startedAt, PS._state().startedAt);
check('Start packing no longer blocks', PS._problems().indexOf('Press Start packing first') === -1);

PS.setTick('folded', true);
check('ticking Folded clears only its own problem',
  !PS._problems().some(p => /Folded/.test(p)) && PS._problems().some(p => /Branded/.test(p)));
PS.setTick('branded', true);
check('both ticked: neither blocks', !PS._problems().some(p => /Folded|Branded|Start packing/.test(p)), JSON.stringify(PS._problems()));
PS.setTick('nonsense', true);
check('an unknown tick name is ignored', PS._state().nonsense === undefined);

// An order carrying startedAt from the queue (a refresh, a second tablet) opens
// already started.
PS._setQueue([{ id: '9002', orderNo: 'SO-2', supervisorId: '10', supervisorName: 'S', itemCount: 1, totalPieces: 5, startedAt: '09-Oct-2026 09:15:00' }]);
PS._setup({ salesOrderId: '9002', orderNo: 'SO-2', items: [{ lineNo: 1, sku: 'A', itemName: 'Sheet', qty: 5, unitWeight: 1 }], boxes: [] });
check('an order already started on the server opens started', PS._state().startedAt === '09-Oct-2026 09:15:00');
check('but the ticks are never remembered from anywhere - they start unticked', PS._state().folded === false && PS._state().branded === false);

const packSrc = read('app/packing/js/main.js');
check('the save payload carries both ticks', /folded: !!ACTIVE_ORDER\.folded/.test(packSrc) && /branded: !!ACTIVE_ORDER\.branded/.test(packSrc));
check('the widget calls startPacking', /callApi\('startPacking'/.test(packSrc));

// ===========================================================================
console.log('\nFINISHING WIDGET — two stages, a batch id:');
// ===========================================================================
const finSrc = read('app/finishing/js/main.js');
check('stages are thread cutting then pressing',
  /var STAGE_NAMES = \['threadcutting', 'pressing'\];/.test(finSrc) && /var STAGE_LABELS = \['Thread cutting', 'Pressing'\];/.test(finSrc));
check('a job is started from the batch id (planItemId)', /planItemId: job\.id/.test(finSrc) && !/itemCheckId/.test(finSrc));
check('folding and branding are gone from the screen', !/folding|branding/i.test(finSrc.replace(/\/\/.*$/gm, '')));
const finCtx = { console: { log() {}, warn() {}, error() {} }, document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
  window: {}, Promise, JSON, Object, Number, String, Math, Date, isNaN, Array, setTimeout, alert() {} };
finCtx.window.self = finCtx.window; finCtx.window.top = finCtx.window;
vm.createContext(finCtx);
vm.runInContext(finSrc + '\nthis.hydrate = hydrateStages; this.first = firstOpenStageIndex;', finCtx);
const stages = finCtx.hydrate({ threadcutting: { start: '10:00:00', end: '10:05:00' }, pressing: { start: '', end: '' } });
// A refusal must be a failure, and two batches of one order+SKU must stay two cards.
finCtx.ZOHO = { CREATOR: { DATA: { invokeCustomApi() { return Promise.resolve({ result: JSON.stringify({ success: false, error: 'Batch is not Awaiting_Check' }) }); } } } };
vm.runInContext(finSrc + '\nthis.callApi = callApi; this.setQueue = function (q, id) { JOBS_QUEUE = q; ACTIVE_JOB_ID = id; }; this.group = activeJobGroup;', finCtx);
let refused = null;
finCtx.callApi('startFinishingJob', {}).then(() => { refused = false; }, e => { refused = e.message; });
finCtx.setQueue([{ id: '1', salesOrder: 'SO-1', sku: 'A', itemName: 'Sheet' }, { id: '2', salesOrder: 'SO-1', sku: 'A', itemName: 'Sheet' }], '1');
check('activeJobGroup is the one batch, never merged with the same order + SKU', finCtx.group().length === 1 && finCtx.group()[0].id === '1');
check('hydrated stage 0 is thread cutting and is closed', stages.threadcutting.end === '10:05:00' && stages.threadcutting.duration === 300);
check('the first open stage is then pressing (index 1)', finCtx.first({ stages: stages }) === 1);
check('with nothing stamped, thread cutting comes first', finCtx.first({ stages: finCtx.hydrate(null) }) === 0);

// ===========================================================================
console.log('\nSUPERVISOR LABELS — finishing (his) and checking (another team) are never one label:');
// ===========================================================================
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' is gone - update this test');
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const ovFn = new Function(extractFn(read('app/supervisor/js/order-overview.js'), 'ovItemStatus') + '; return ovItemStatus;')();
const rcFn = new Function(extractFn(read('app/supervisor/js/receive.js'), 'itemStatusLabel') + '; return itemStatusLabel;')();
check('Order Overview: not started -> Waiting for finishing', ovFn('Awaiting_Check', 'None').text === 'Waiting for finishing');
check('Order Overview: open -> In finishing', ovFn('Awaiting_Check', 'Open').text === 'In finishing');
check('Order Overview: done -> With the checking team', ovFn('Awaiting_Check', 'Done').text === 'With the checking team');
check('Order Overview: no finishing info is treated as not started, never as checking', ovFn('Awaiting_Check', undefined).text === 'Waiting for finishing');
check('Receive breakdown: the same three words', rcFn('Awaiting_Check', 'None') === 'Waiting for finishing' &&
  rcFn('Awaiting_Check', 'Open') === 'In finishing' && rcFn('Awaiting_Check', 'Done') === 'With the checking team');
check('other statuses are untouched', ovFn('In_Production').text === 'In production' && rcFn('Complete') === 'Complete');
['getProductionWidgetData', 'getOrderItemList', 'getReceiveItemBreakdown', 'getSupervisorProductionHistory'].forEach(function (f) {
  const src = read('deluge/' + f + '.dg');
  check(f + ' emits finishing, read from Finishing_Data only for an Awaiting_Check batch',
    /\\"finishing\\":\\""/.test(src) && /Finishing_Data\[Plan_Item ==/.test(src) && /Awaiting_Check/.test(src));
});
const histSrc = read('deluge/getSupervisorProductionHistory.dg');
check('the history label words the three states in Deluge',
  /Waiting for finishing/.test(histSrc) && /In finishing/.test(histSrc) && /With the checking team/.test(histSrc) && !/Waiting for checking/.test(histSrc.replace(/^\s*\/\/.*$/gm, '')));
const prodSrc = read('app/supervisor/js/production.js');
check('the production card words the three states',
  /With the checking team/.test(prodSrc) && /"In finishing"/.test(prodSrc) && /"Waiting for finishing"/.test(prodSrc));
check('no combined "Finishing / checking" label remains anywhere',
  !/Finishing \/ checking/.test(read('app/supervisor/js/receive.js') + read('app/supervisor/js/order-overview.js') + prodSrc + read('app/supervisor/js/tabs.js') + read('app/supervisor/js/handover-detail.js')));
const prodGate = /const leftProduction = item\.status === "Awaiting_Check" \|\| item\.status === "Complete";/.test(prodSrc) &&
  /isAlt && !leftProduction/.test(prodSrc) && /canCloseAlteration === true && !leftProduction/.test(prodSrc);
check('the alteration buttons are hidden once the batch has left production', prodGate);
check('closeAlterationBatch refuses a second declaration at Awaiting_Check',
  /statusNow == "Awaiting_Check"\)\s*\{\s*return "\{\\"success\\":false,\\"code\\":\\"ALREADY_SENT\\"/.test(read('deluge/closeAlterationBatch.dg')));

// the refusal promise settles on the next tick
setImmediate(function () {
  check('callApi throws on {success:false} instead of passing it off as success', refused === 'Batch is not Awaiting_Check', String(refused));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
