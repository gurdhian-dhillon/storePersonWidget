#!/usr/bin/env node
// The store widget's PRINT TAB, exercised in a stub DOM via vm.
//
// docs/printing.md:745 claims this file exists and carries 42 assertions. It did
// not. This is it.
//
// The Print tab region of app/js/main.js is loaded VERBATIM - the real
// printJobsHtml / printReceiveFormHtml / patternsFor / printSkuNoteHtml /
// sendAvailable / submitSendToPrint / submitReceivePrint - so a failure here
// names a real line of the widget. Only escapeHtml and fmt are pulled in beside
// it; the region is otherwise self-contained.
//
// Extracted by MARKER rather than loaded whole, for two reasons: main.js boots
// itself at the bottom (setTodayLabel / loadRequirements / loadCounts, which
// need the whole Issue tab's DOM), and the Issue-tab half of the file is edited
// far more often than this one. Same technique as tools/store-ui.test.js.
//
//   usage: node tools/print-tab-ui.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
// The Print tab runs inside a vm, so everything IT builds carries THAT realm's
// Array/Object prototypes and deepStrictEqual refuses them on identity alone.
// Round-tripping through JSON compares the values, which is what is under test.
// Convention: tools/print-shortreason.test.js:28.
function plain(v) { return JSON.parse(JSON.stringify(v)); }
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push({ name, msg: e.message }); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---- load the real Print tab ---------------------------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'main.js'), 'utf8');

function extractFn(name) {
  const i = mainSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('main.js no longer has function ' + name +
    ' - the Print tab UI test contract changed; update tools/print-tab-ui.test.js');
  let depth = 0, j = mainSrc.indexOf('{', i);
  for (let k = j; k < mainSrc.length; k++) {
    if (mainSrc[k] === '{') depth++;
    else if (mainSrc[k] === '}') { depth--; if (depth === 0) { j = k + 1; break; } }
  }
  return mainSrc.slice(i, j);
}
function extractRegion(startMark, endMark) {
  const a = mainSrc.indexOf(startMark);
  const b = mainSrc.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error('main.js no longer contains the Print tab markers ' +
    JSON.stringify(startMark) + ' .. ' + JSON.stringify(endMark) +
    ' - update tools/print-tab-ui.test.js');
  return mainSrc.slice(a, b);
}
const HELPERS = [extractFn('escapeHtml'), extractFn('fmt')].join('\n');
const PRINT_SRC = extractRegion('// ---- Print tab ----', '// Boot. Issue is the home tab');

// ---- stub DOM + world ----------------------------------------------------------
function thenable(value) {
  return {
    then: function (cb) { cb(value); return { catch: function () {} }; },
    catch: function () {}
  };
}

function makeWorld(data, opts) {
  opts = opts || {};
  const els = {};
  // calls is EVERY invokeCustomApi; posts is POSTs only. The distinction is
  // load-bearing: every successful submit ends in loadPrint(), whose getPrintData
  // GET is a call but never a post - and the submit tests count posts.
  const log = { alerts: [], confirms: [], prompts: [], calls: [], posts: [] };
  let confirmAnswer = opts.confirmAnswer === undefined ? true : opts.confirmAnswer;

  const sandbox = {
    console: { log() {}, error() {}, info() {}, warn() {} },
    Math, Number, String, Object, Array, JSON, parseInt, parseFloat, isNaN, Date,
    document: {
      getElementById: function (id) { return els[id] || null; },
      querySelectorAll: function () { return { forEach: function () {} }; },
    },
    requestAnimationFrame: function () {},
    alert: function (m) { log.alerts.push(String(m)); },
    confirm: function (m) { log.confirms.push(String(m)); return confirmAnswer; },
    prompt: function () { log.prompts.push(1); return opts.promptAnswer === undefined ? 'a reason' : opts.promptAnswer; },
    ZOHO: { CREATOR: { DATA: { invokeCustomApi: function (o) {
      log.calls.push(o);
      if (o.http_method === 'POST') log.posts.push(o);
      // A successful submit REFETCHES (loadPrint), so the stub's answer to that
      // GET has to be a payload the tab can render, not a bare {success:true}.
      // The world's own data is exactly that; an explicit apiResult wins.
      const body = opts.apiResult !== undefined ? opts.apiResult
                 : (data !== undefined ? data : { success: true });
      return thenable({ result: JSON.stringify(body) });
    } } } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + PRINT_SRC, sandbox);
  if (data !== undefined) sandbox.PRINT_DATA = data;

  function el(id, props) {
    els[id] = Object.assign({ value: '', checked: false, disabled: false, textContent: '',
      innerHTML: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; },
      toggle() {} } }, props || {});
    return els[id];
  }
  // Every successful submit repaints #panel-print through loadPrint(). The real
  // page always has it (widget.html); without it here the redraw throws on null
  // and reads as a widget fault when it is only a missing stub element.
  el('panel-print', {});
  return { sandbox, els, el, log, get: n => sandbox[n],
           setConfirm: v => { confirmAnswer = v; } };
}

// ---- the fixture payload, in getPrintData's exact shape ------------------------
// docs/printing.md:616. Ids are strings in both directions - 18-digit ids break
// JSON.parse on this side.
function payload(over) {
  return Object.assign({
    errors: [],
    patterns: ['Plain', 'Block Print'],
    plain: [
      { id: '10', name: 'Grey Sheeting / Plain / Grey', sku: 'RM-00112', pattern: 'Plain',
        widthCm: 152.4, lots: [
          { lotId: '901', lotNumber: 'L1', label: '', wash: 42.6, unwash: 8, inPrint: 0, blocked: false },
          { lotId: '902', lotNumber: 'L2', label: '', wash: 100, unwash: 0, inPrint: 0, blocked: true },
        ] },
      { id: '11', name: 'Linen / Plain / Ecru', sku: 'RM-00120', pattern: 'Plain',
        widthCm: 137.2, lots: [] },                       // no lots - nothing can be sent
    ],
    printed: [
      { id: '20', name: 'Grey Sheeting / Plain / Grey / Block Print', sku: 'RM-00113',
        baseId: '10', pattern: 'Block Print', widthCm: 152.4, lots: [
          { lotId: '950', lotNumber: 'P1', label: '', wash: 9, unwash: 0, inPrint: 0, blocked: false },
          { lotId: '951', lotNumber: 'P9', label: '', wash: 4, unwash: 0, inPrint: 0, blocked: true },
        ] },
    ],
    printers: [{ id: '77', name: 'Ace Printers' }],
    jobs: [
      { jobId: '555', plainName: 'Grey Sheeting / Plain / Grey', plainSku: 'RM-00112',
        plainLotNumber: 'L1', printedMaterialId: '20',
        printedName: 'Grey Sheeting / Plain / Grey / Block Print', printedSku: 'RM-00113',
        printerName: 'Ace Printers', sourceState: 'Wash', metresSent: 20,
        sentOn: '19-Aug-2026', status: 'At_Printer',
        lines: [{ lengthCm: 300, count: 3 }, { lengthCm: 275, count: 4 }] },
    ],
  }, over || {});
}

// ===============================================================================
console.log('\nthe job card - what is at the printer');
// ===============================================================================

test('J1 the card totals the PIECES over the send lines, beside the metres', () => {
  const w = makeWorld(payload());
  const html = w.get('printJobsHtml')();
  assert.ok(/7 pieces/.test(html), 'three 300s and four 275s is 7 pieces: ' + html.slice(0, 400));
  assert.ok(/20 Mtr/.test(html));
});

test('J2 the card names the SOURCE LOT, the plain material and the state that went out', () => {
  const w = makeWorld(payload());
  const html = w.get('printJobsHtml')();
  assert.ok(/lot L1/.test(html), 'the tone that went out is the whole reason one lot per job exists');
  assert.ok(/from Grey Sheeting/.test(html));
  assert.ok(/washed/.test(html));
  assert.ok(/Ace Printers/.test(html));
  assert.ok(/RM-00113|Block Print/.test(html), 'and which SKU it is coming back as');
});

test('J3 one piece reads "1 piece", not "1 pieces"', () => {
  const p = payload();
  p.jobs[0].lines = [{ lengthCm: 300, count: 1 }];
  const w = makeWorld(p);
  assert.ok(/1 piece &middot;/.test(w.get('printJobsHtml')()));
});

test('J4 an empty printer queue says so rather than drawing an empty list', () => {
  const w = makeWorld(payload({ jobs: [] }));
  assert.ok(/Nothing is at the printer/.test(w.get('printJobsHtml')()));
});

// ===============================================================================
console.log('\nthe receive form');
// ===============================================================================

test('F1 the receive rows PREFILL from the send lines - one row per size, count seeded to what went out', () => {
  const w = makeWorld(payload());
  w.get('printJobsHtml')();                       // seeding happens here
  const rows = w.get('printRecvLines')['555'];
  assert.strictEqual(rows.length, 2, 'one row per SENT size, no more and no fewer');
  assert.deepStrictEqual(rows.map(r => [r.len, r.sent, r.count]), [[300, 3, 3], [275, 4, 4]]);
});

test('F2 the rows DEFAULT to the state that went out', () => {
  const w = makeWorld(payload());
  w.get('printJobsHtml')();
  w.get('printRecvLines')['555'].forEach(r => assert.strictEqual(r.state, 'Wash'));

  const p = payload();
  p.jobs[0].sourceState = 'Unwash';
  const g = makeWorld(p);
  g.get('printJobsHtml')();
  g.get('printRecvLines')['555'].forEach(r => assert.strictEqual(r.state, 'Unwash',
    'greige cloth defaults to coming back greige'));
});

test('F3 length and width are DISABLED, and there is no way to add or remove a size', () => {
  const w = makeWorld(payload());
  w.get('printJobsHtml')();
  const html = w.get('printReceiveFormHtml')(w.get('printJobById')('555'));
  const disabled = (html.match(/disabled/g) || []).length;
  assert.ok(disabled >= 4, 'two rows x (length + width) at least: got ' + disabled);
  assert.ok(!/Another size/.test(html), 'nothing can come back that did not go out');
  assert.ok(!/removeRecvLine/.test(html));
  assert.ok(/152\.4/.test(html), 'the stamped width is shown so a narrow return is catchable');
});

test('F4 the form offers the printed material\'s EXISTING lots so a second run tops one up', () => {
  const w = makeWorld(payload());
  w.get('printJobsHtml')();
  const html = w.get('printReceiveFormHtml')(w.get('printJobById')('555'));
  assert.ok(/\+ New lot/.test(html));
  assert.ok(/>P1</.test(html), 'the existing printed lot is offered');
});

test('F5 A BLOCKED PRINTED LOT IS NEVER OFFERED as a receive target', () => {
  const w = makeWorld(payload());
  w.get('printJobsHtml')();
  const html = w.get('printReceiveFormHtml')(w.get('printJobById')('555'));
  assert.ok(!/>P9</.test(html), 'blocked cloth cannot take stock');
});

test('F6 THE LOSS IS SAID IN PIECES FIRST, then the metres', () => {
  const w = makeWorld(payload());
  w.get('printJobsHtml')();
  const rows = w.get('printRecvLines')['555'];
  rows[1].count = 3;                              // one 275 cm piece never came back
  assert.strictEqual(w.get('recvPiecesLost')('555'), 1);
  assert.strictEqual(w.get('recvMetres')('555'), 17.25);
  const foot = w.get('recvFooterHtml')(w.get('printJobById')('555'));
  assert.ok(/<b>1 piece short<\/b>/.test(foot), '"one piece" is what he can take to the vendor: ' + foot);
  assert.ok(/2\.75 Mtr written off/.test(foot));
  assert.ok(/is-short/.test(foot));
});

test('F7 nothing missing reads as all back, with no write-off language', () => {
  const w = makeWorld(payload());
  w.get('printJobsHtml')();
  const foot = w.get('recvFooterHtml')(w.get('printJobById')('555'));
  assert.ok(/All 7 pieces back/.test(foot), foot);
  assert.ok(!/written off/.test(foot));
  assert.ok(!/is-short/.test(foot));
});

test('F8 recvMetres uses the FIXED send length - the screen cannot inflate what came back', () => {
  const w = makeWorld(payload());
  w.get('printJobsHtml')();
  const rows = w.get('printRecvLines')['555'];
  assert.strictEqual(w.get('recvMetres')('555'), 20);
  rows[0].len = 900;                              // a tampered length is still not read back
  const read = w.get('readRecvLines')('555');
  assert.strictEqual(read[0].len, 900, 'readRecvLines carries the STATE length, never a DOM input');
  assert.ok(!/id="pr-len/.test(w.get('printReceiveFormHtml')(w.get('printJobById')('555'))),
    'there is no length input to type into in the first place');
});

// ===============================================================================
console.log('\nthe pattern list and the SKU note');
// ===============================================================================

test('P1 patternsFor picks up an IN-USE pattern off the server payload', () => {
  const w = makeWorld(payload());
  const pats = w.get('patternsFor')({ id: '10', pattern: 'Plain' });
  assert.ok(pats.indexOf('Block Print') >= 0, 'a pattern sitting on a real material: ' + pats);
});

test('P2 it EXCLUDES the material\'s own pattern - printing Plain in Plain is a nonsense SKU', () => {
  const w = makeWorld(payload());
  const pats = w.get('patternsFor')({ id: '10', pattern: 'Plain' });
  assert.strictEqual(pats.indexOf('Plain'), -1, pats.join(','));
});

test('P3 the own-pattern exclusion is CASE-FOLDED', () => {
  const w = makeWorld(payload());
  const pats = w.get('patternsFor')({ id: '10', pattern: 'plain' });
  assert.strictEqual(pats.indexOf('Plain'), -1, '"plain" must still drop "Plain": ' + pats.join(','));
});

test('P4 a printed SKU\'s own pattern comes through even if `patterns` were trimmed', () => {
  const p = payload({ patterns: [] });
  const w = makeWorld(p);
  assert.ok(w.get('patternsFor')({ id: '10', pattern: 'Plain' }).indexOf('Block Print') >= 0);
});

test('P5 PRINT_PATTERNS tops up a choice no material carries yet', () => {
  const w = makeWorld(payload());
  w.sandbox.PRINT_PATTERNS = ['BP Flower'];
  const pats = w.get('patternsFor')({ id: '10', pattern: 'Plain' });
  assert.ok(pats.indexOf('BP Flower') >= 0, 'the only case the server cannot see: ' + pats.join(','));
});

test('P6 the list is deduped case-insensitively and sorted', () => {
  const p = payload({ patterns: ['Block Print', 'block print', 'Ajrakh'] });
  const w = makeWorld(p);
  w.sandbox.PRINT_PATTERNS = ['Ajrakh'];
  // plain(): the list was built inside the vm, so its Array is from THAT realm
  // and deepStrictEqual would refuse it on identity alone.
  assert.deepStrictEqual(plain(w.get('patternsFor')({ id: '10', pattern: 'Plain' })),
    ['Ajrakh', 'Block Print']);
});

test('P7 the SKU note names an EXISTING pair rather than promising a mint', () => {
  const w = makeWorld(payload());
  w.el('ps-pat-10', { value: 'Block Print' });
  const note = w.get('printSkuNoteHtml')(w.get('PRINT_DATA').plain[0]);
  assert.ok(/Goes into <b>RM-00113<\/b>/.test(note), note);
  assert.ok(!/creates a new material/.test(note));
});

test('P8 the SKU note WARNS when the pair has never been printed, and states the inherited width', () => {
  const w = makeWorld(payload());
  w.el('ps-pat-10', { value: 'Ajrakh' });
  const note = w.get('printSkuNoteHtml')(w.get('PRINT_DATA').plain[0]);
  assert.ok(/has never been printed in Ajrakh/.test(note), note);
  assert.ok(/creates a new material/.test(note), 'a printed SKU is never minted silently');
  assert.ok(/152\.4 cm wide like the plain cloth/.test(note), 'the width invariant, said on screen');
  assert.ok(/is-short/.test(note));
});

test('P9 no pattern chosen means no note at all', () => {
  const w = makeWorld(payload());
  w.el('ps-pat-10', { value: '' });
  assert.strictEqual(w.get('printSkuNoteHtml')(w.get('PRINT_DATA').plain[0]), '');
});

test('P10 the pair is matched on baseId AND pattern - another base\'s SKU never resolves', () => {
  const w = makeWorld(payload());
  assert.ok(w.get('printedFor')('10', 'Block Print'), 'the real pair');
  assert.strictEqual(w.get('printedFor')('11', 'Block Print'), null, 'a different base');
  assert.strictEqual(w.get('printedFor')('10', 'Ajrakh'), null, 'a different pattern');
  assert.ok(w.get('printedFor')('10', 'block print'), 'matched case-insensitively on this side');
});

// ===============================================================================
console.log('\nthe send form - lots, availability, over-draw');
// ===============================================================================

test('L1 A BLOCKED LOT IS NAMED BUT NEVER OFFERED', () => {
  const w = makeWorld(payload());
  const html = w.get('printSendFormHtml')(w.get('PRINT_DATA').plain[0]);
  assert.ok(/L2/.test(html), 'the balance table still shows it - a row he can see is not a mystery');
  assert.ok(/status-danger">Blocked/.test(html));
  assert.ok(!/<option value="902"/.test(html), 'but the select does not offer it');
  assert.ok(/<option value="901"/.test(html), 'the active lot is offered');
});

test('L2 fabric with no lots at all is dropped from the list - it can never be acted on', () => {
  const w = makeWorld(payload());
  const ids = w.get('printPlainMatches')().map(m => m.id);
  assert.deepStrictEqual(ids, ['10'], 'RM-00120 has no lot, so no tone, so nowhere to send from');
});

test('L3 the search matches SKU and name', () => {
  const p = payload();
  p.plain[1].lots = [{ lotId: '903', lotNumber: 'X1', wash: 5, unwash: 0, inPrint: 0, blocked: false }];
  const w = makeWorld(p);
  w.sandbox.printFilter = 'rm-00120';
  assert.deepStrictEqual(w.get('printPlainMatches')().map(m => m.id), ['11']);
  w.sandbox.printFilter = 'sheeting';
  assert.deepStrictEqual(w.get('printPlainMatches')().map(m => m.id), ['10']);
  w.sandbox.printFilter = 'nothing at all';
  assert.strictEqual(w.get('printPlainMatches')().length, 0);
  assert.ok(/No plain fabric matches/.test(w.get('printListHtml')()));
});

test('A1 AVAILABILITY FOLLOWS THE STATE SELECTOR, not the material total', () => {
  const w = makeWorld(payload());
  const mat = w.get('PRINT_DATA').plain[0];
  w.el('ps-lot-10', { value: '901' });
  const st = w.el('ps-state-10', { value: 'Wash' });
  assert.strictEqual(w.get('sendAvailable')(mat), 42.6);
  st.value = 'Unwash';
  assert.strictEqual(w.get('sendAvailable')(mat), 8, 'cloth in the other state cannot serve this send');
});

test('A2 availability follows the LOT selector too - another lot\'s cloth is not this lot\'s', () => {
  const w = makeWorld(payload());
  const mat = w.get('PRINT_DATA').plain[0];
  const lot = w.el('ps-lot-10', { value: '901' });
  w.el('ps-state-10', { value: 'Wash' });
  assert.strictEqual(w.get('sendAvailable')(mat), 42.6);
  lot.value = '902';
  assert.strictEqual(w.get('sendAvailable')(mat), 100);
  lot.value = '';
  assert.strictEqual(w.get('sendAvailable')(mat), 0, 'no lot chosen is not "all of it"');
});

test('A3 THE OVER-DRAW GUARD lights the footer when the lines exceed the chosen counter', () => {
  const w = makeWorld(payload());
  const mat = w.get('PRINT_DATA').plain[0];
  w.el('ps-lot-10', { value: '901' });
  w.el('ps-state-10', { value: 'Unwash' });        // only 8.00 Mtr
  w.sandbox.printLines['10'] = [{ len: 300, count: 3 }];   // 9.00 Mtr
  assert.strictEqual(w.get('sendMetres')('10'), 9);
  const foot = w.get('sendFooterHtml')(mat);
  assert.ok(/is-short/.test(foot), foot);
  assert.ok(/more than it holds/.test(foot));
});

test('A4 exactly the balance is NOT flagged', () => {
  const w = makeWorld(payload());
  const mat = w.get('PRINT_DATA').plain[0];
  w.el('ps-lot-10', { value: '901' });
  w.el('ps-state-10', { value: 'Unwash' });
  w.sandbox.printLines['10'] = [{ len: 400, count: 2 }];   // exactly 8.00
  assert.ok(!/is-short/.test(w.get('sendFooterHtml')(mat)), 'the epsilon exists for exactly this');
});

test('A5 sendMetres ignores a half-typed row rather than counting it as zero-length cloth', () => {
  const w = makeWorld(payload());
  w.sandbox.printLines['10'] = [{ len: 300, count: 3 }, { len: '', count: '' }, { len: 275, count: 0 }];
  assert.strictEqual(w.get('sendMetres')('10'), 9);
});

// ===============================================================================
console.log('\nsubmitting a send');
// ===============================================================================

function sendWorld(lines, opts) {
  const w = makeWorld(payload(), opts);
  w.el('ps-lot-10', { value: '901' });
  w.el('ps-state-10', { value: 'Wash' });
  w.el('ps-pat-10', { value: 'Block Print' });
  w.el('ps-printer-10', { value: '77' });
  w.el('ps-btn-10', {});
  w.sandbox.printLines['10'] = lines;
  return w;
}

test('SB1 a FRACTIONAL count is refused before the round trip and nothing is posted', () => {
  const w = sendWorld([{ len: 300, count: 2.5 }]);
  w.get('submitSendToPrint')('10');
  assert.strictEqual(w.log.posts.length, 0);
  assert.ok(/whole number of pieces/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

test('SB2 a ZERO or NEGATIVE length is refused', () => {
  const a = sendWorld([{ len: 0, count: 3 }]);
  a.get('submitSendToPrint')('10');
  assert.strictEqual(a.log.posts.length, 0);
  assert.ok(/piece length in cm/.test(a.log.alerts.join(' ')), a.log.alerts.join(' '));

  const b = sendWorld([{ len: -300, count: 3 }]);
  b.get('submitSendToPrint')('10');
  assert.strictEqual(b.log.posts.length, 0);
  assert.ok(/piece length in cm/.test(b.log.alerts.join(' ')));
});

test('SB3 a zero COUNT is refused', () => {
  const w = sendWorld([{ len: 300, count: 0 }]);
  w.get('submitSendToPrint')('10');
  assert.strictEqual(w.log.posts.length, 0);
  assert.ok(/whole number of pieces/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

test('SB4 a wholly blank row is SKIPPED, not treated as a fault - it is just an unused line', () => {
  const w = sendWorld([{ len: 300, count: 3 }, { len: '', count: '' }]);
  w.get('submitSendToPrint')('10');
  assert.strictEqual(w.log.posts.length, 1, w.log.alerts.join(' '));
  const sentLines = JSON.parse(w.log.posts[0].payload.payloadJson).lines;
  assert.deepStrictEqual(sentLines, [{ lengthCm: 300, count: 3 }]);
});

test('SB5 nothing but blank rows is refused with its own message', () => {
  const w = sendWorld([{ len: '', count: '' }]);
  w.get('submitSendToPrint')('10');
  assert.strictEqual(w.log.posts.length, 0);
  assert.ok(/Add at least one line/.test(w.log.alerts.join(' ')));
});

test('SB6 the OVER-DRAW guard blocks the send client-side too', () => {
  const w = sendWorld([{ len: 300, count: 20 }]);          // 60.00 off 42.60
  w.get('submitSendToPrint')('10');
  assert.strictEqual(w.log.posts.length, 0);
  assert.ok(/more cloth than the lot holds/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

test('SB7 a missing lot, pattern or printer each stops the send with its own message', () => {
  const a = sendWorld([{ len: 300, count: 3 }]); a.els['ps-lot-10'].value = '';
  a.get('submitSendToPrint')('10');
  assert.ok(/Choose which lot/.test(a.log.alerts.join(' ')));
  const b = sendWorld([{ len: 300, count: 3 }]); b.els['ps-pat-10'].value = '';
  b.get('submitSendToPrint')('10');
  assert.ok(/Choose the pattern/.test(b.log.alerts.join(' ')));
  const c = sendWorld([{ len: 300, count: 3 }]); c.els['ps-printer-10'].value = '';
  c.get('submitSendToPrint')('10');
  assert.ok(/Choose which printer/.test(c.log.alerts.join(' ')));
  [a, b, c].forEach(w => assert.strictEqual(w.log.posts.length, 0));
});

test('SB8 an EXISTING pair posts its printedMaterialId and asks no question', () => {
  const w = sendWorld([{ len: 300, count: 3 }, { len: 275, count: 4 }]);
  w.get('submitSendToPrint')('10');
  assert.strictEqual(w.log.confirms.length, 0, 'nothing is being minted, so nothing to confirm');
  assert.strictEqual(w.log.posts.length, 1);
  const body = JSON.parse(w.log.posts[0].payload.payloadJson);
  assert.strictEqual(w.log.posts[0].api_name, 'sendToPrint');
  assert.strictEqual(body.printedMaterialId, '20');
  assert.strictEqual(body.plainLotId, '901');
  assert.strictEqual(body.sourceState, 'Wash');
  assert.strictEqual(body.pattern, 'Block Print');
  assert.strictEqual(body.printerId, '77');
  assert.deepStrictEqual(body.lines, [{ lengthCm: 300, count: 3 }, { lengthCm: 275, count: 4 }]);
});

test('SB9 A MINT IS CONFIRMED FIRST, and declining it posts nothing', () => {
  const w = sendWorld([{ len: 300, count: 3 }], { confirmAnswer: false });
  w.els['ps-pat-10'].value = 'Ajrakh';                     // never printed on this base
  w.get('submitSendToPrint')('10');
  assert.strictEqual(w.log.confirms.length, 1);
  assert.ok(/creates a new material with a new SKU/.test(w.log.confirms[0]), w.log.confirms[0]);
  assert.strictEqual(w.log.posts.length, 0, 'permanent master data is never written silently');
});

test('SB10 accepting the mint posts with an EMPTY printedMaterialId - the server resolves the pair', () => {
  const w = sendWorld([{ len: 300, count: 3 }], { confirmAnswer: true });
  w.els['ps-pat-10'].value = 'Ajrakh';
  w.get('submitSendToPrint')('10');
  assert.strictEqual(w.log.posts.length, 1);
  assert.strictEqual(JSON.parse(w.log.posts[0].payload.payloadJson).printedMaterialId, '');
});

// ===============================================================================
console.log('\nsubmitting a receipt');
// ===============================================================================

function recvWorld(counts, opts) {
  const w = makeWorld(payload(), opts);
  w.get('printJobsHtml')();                         // seeds printRecvLines
  const rows = w.get('printRecvLines')['555'];
  (counts || []).forEach((c, i) => { if (rows[i]) Object.assign(rows[i], c); });
  w.el('pr-lot-555', { value: '' });
  w.el('pr-num-555', { value: 'P2' });
  w.el('pr-btn-555', {});
  return w;
}

test('RB1 THE CARTON IS REQUIRED wherever pieces actually arrived', () => {
  const w = recvWorld([{ count: 3, carton: '' }, { count: 4, carton: 'C-7' }]);
  w.get('submitReceivePrint')('555');
  assert.strictEqual(w.log.posts.length, 0);
  assert.ok(/needs a carton/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

test('RB2 a ZERO row needs NO carton - it sits on no shelf', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }, { count: 0, carton: '' }]);
  w.get('submitReceivePrint')('555');
  assert.strictEqual(w.log.posts.length, 1, w.log.alerts.join(' '));
});

test('RB3 EVERY sent size is sent back, zeros included, each carrying its lineIndex', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }, { count: 0, carton: '' }]);
  w.get('submitReceivePrint')('555');
  const body = JSON.parse(w.log.posts[0].payload.payloadJson);
  assert.strictEqual(body.lines.length, 2, 'the two subforms have to line up');
  assert.deepStrictEqual(body.lines.map(l => l.lineIndex), [0, 1]);
  assert.deepStrictEqual(body.lines.map(l => l.count), [3, 0]);
  assert.deepStrictEqual(body.lines.map(l => l.lengthCm), [300, 275],
    'the length is echoed for the server to COMPARE, never for it to trust');
});

test('RB4 over-return is stopped here as well as server-side', () => {
  const w = recvWorld([{ count: 5, carton: 'C-7' }]);
  w.get('submitReceivePrint')('555');
  assert.strictEqual(w.log.posts.length, 0);
  assert.ok(/Only 3 pieces of 300 cm went out/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

test('RB5 a fractional or negative returned count is refused', () => {
  const a = recvWorld([{ count: 1.5, carton: 'C-7' }]);
  a.get('submitReceivePrint')('555');
  assert.ok(/whole number, or zero/.test(a.log.alerts.join(' ')), a.log.alerts.join(' '));
  const b = recvWorld([{ count: -1, carton: 'C-7' }]);
  b.get('submitReceivePrint')('555');
  assert.ok(/whole number, or zero/.test(b.log.alerts.join(' ')));
  assert.strictEqual(a.log.posts.length + b.log.posts.length, 0);
});

test('RB6 THE CASE-FOLDED LOT-NUMBER CLASH is caught before the round trip', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }, { count: 4, carton: 'C-7' }]);
  w.els['pr-num-555'].value = 'p1';                 // the printed SKU already has P1
  w.get('submitReceivePrint')('555');
  assert.strictEqual(w.log.posts.length, 0);
  assert.ok(/already has a lot p1/.test(w.log.alerts.join(' ')), w.log.alerts.join(' '));
});

test('RB7 the clash check only applies to a lot being CREATED, not to topping one up', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }, { count: 4, carton: 'C-7' }]);
  w.els['pr-lot-555'].value = '950';                // top up P1
  w.els['pr-num-555'].value = 'P1';
  w.get('submitReceivePrint')('555');
  assert.strictEqual(w.log.posts.length, 1, w.log.alerts.join(' '));
  assert.strictEqual(JSON.parse(w.log.posts[0].payload.payloadJson).lotId, '950');
});

test('RB8 a new lot with no number is refused', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }, { count: 4, carton: 'C-7' }]);
  w.els['pr-num-555'].value = '   ';
  w.get('submitReceivePrint')('555');
  assert.strictEqual(w.log.posts.length, 0);
  assert.ok(/Give the new lot a number/.test(w.log.alerts.join(' ')));
});

test('RB9 A SHORT RETURN IS CONFIRMED, naming the pieces and the plain material it is written off against', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }, { count: 3, carton: 'C-7' }], { confirmAnswer: false });
  w.get('submitReceivePrint')('555');
  assert.strictEqual(w.log.confirms.length, 1);
  assert.ok(/1 piece did not come back/.test(w.log.confirms[0]), w.log.confirms[0]);
  assert.ok(/Grey Sheeting/.test(w.log.confirms[0]), 'it says whose cloth is being written off');
  assert.strictEqual(w.log.posts.length, 0, 'declining it saves nothing');
});

test('RB10 a full return asks nothing', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }, { count: 4, carton: 'C-7' }]);
  w.get('submitReceivePrint')('555');
  assert.strictEqual(w.log.confirms.length, 0);
  assert.strictEqual(w.log.posts.length, 1);
  assert.strictEqual(w.log.posts[0].api_name, 'receiveFromPrint');
});

test('RB11 "Came back unprinted" confirms, asks why, and posts to cancelPrintJob', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }], { promptAnswer: 'printer machine down' });
  w.el('pr-cancel-555', {});
  w.get('submitCancelJob')('555');
  assert.strictEqual(w.log.confirms.length, 1);
  assert.ok(/Put 20 Mtr back on lot L1 as washed cloth/.test(w.log.confirms[0]), w.log.confirms[0]);
  assert.strictEqual(w.log.posts.length, 1);
  assert.strictEqual(w.log.posts[0].api_name, 'cancelPrintJob');
  assert.strictEqual(JSON.parse(w.log.posts[0].payload.payloadJson).reason, 'printer machine down');
});

test('RB12 cancelling the "why" prompt aborts - a reason is not optional in practice', () => {
  const w = recvWorld([{ count: 3, carton: 'C-7' }], { promptAnswer: null });
  w.el('pr-cancel-555', {});
  w.get('submitCancelJob')('555');
  assert.strictEqual(w.log.posts.length, 0);
});

// ===============================================================================
console.log('\nloading');
// ===============================================================================

test('LD1 loadPrint stores the payload and paints the panel from it', () => {
  const w = makeWorld(undefined, { apiResult: payload() });
  const panel = w.el('panel-print', {});
  w.get('loadPrint')();
  assert.strictEqual(w.log.calls[0].api_name, 'getPrintData');
  assert.strictEqual(w.log.calls[0].http_method, 'GET');
  assert.ok(w.get('PRINT_DATA'), 'the payload is held for every later render');
  assert.ok(/7 pieces/.test(panel.innerHTML), 'the job card is drawn');
  assert.ok(/Grey Sheeting/.test(panel.innerHTML));
  assert.ok(/print-filter/.test(panel.innerHTML), 'and the search box, which must not be redrawn per keystroke');
});

test('LD2 a payload the widget cannot read says so instead of drawing half a screen', () => {
  const w = makeWorld(undefined, {});
  const panel = w.el('panel-print', {});
  // invokeCustomApi is stubbed to return valid JSON, so drive the failure the
  // way the browser would: a result that is not JSON at all.
  w.sandbox.ZOHO.CREATOR.DATA.invokeCustomApi = function () {
    return thenable({ result: '<html>oops</html>' });
  };
  w.get('loadPrint')();
  assert.ok(/Could not read the print data/.test(panel.innerHTML), panel.innerHTML);
});

// ---- summary -------------------------------------------------------------------

console.log('\n========================================');
console.log('print-tab-ui: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f.name + '\n       ' + f.msg.split('\n')[0]));
  process.exit(1);
}
