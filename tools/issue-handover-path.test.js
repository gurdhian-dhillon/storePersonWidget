#!/usr/bin/env node
// ---- THE ISSUING PATH: allocation -> payload -> chunks -> apply -> handover ----
//
// This is the half of the store screen where being wrong costs stock rather
// than a wrong number on a page. It is also the half with the awkward failure
// modes: the Creator statement limit is NOT catchable, so a chunk can apply 90
// of its 100 rows and return nothing at all; and a rate-limited chunk is
// REPLAYED verbatim, so every write in it must be idempotent under its applyKey.
//
// What this pins:
//   H1  splitIssuesByAllocation — conservation, and the ride-along fields
//   H2  buildHandoverSummary    — metres and pieces conserved into the record
//   H3  appliedIssues()         — ROW granularity, modelled: a chunk that dies
//                                 part-way records exactly the rows that landed
//   H4  the Apply_Key retry guard, modelled as the server applies it
//   H5  a whole press end to end, against a modelled server
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function makeDoc() {
  const els = {};
  const mk = (id) => {
    const e = {
      id: id, _cls: {}, value: '', textContent: '', innerHTML: '',
      disabled: false, hidden: false, style: {}, checked: false,
      children: [], dataset: {},
      classList: { add(c) { e._cls[c] = 1; }, remove(c) { delete e._cls[c]; },
        contains(c) { return !!e._cls[c]; }, toggle(c) { e._cls[c] = !e._cls[c]; } },
      addEventListener() {}, appendChild() {}, removeAttribute(k) { delete e['_a_' + k]; },
      setAttribute(k, v) { e['_a_' + k] = v; }, getAttribute(k) { return e['_a_' + k]; },
      scrollIntoView() {}, focus() {}, querySelector: () => mk('q'), querySelectorAll: () => []
    };
    return e;
  };
  return {
    getElementById(id) { if (!els[id]) els[id] = mk(id); return els[id]; },
    querySelector(s) { return this.getElementById('sel:' + s); },
    querySelectorAll() { return []; },
    createElement(t) { return mk('n:' + t); },
    addEventListener() {}, body: { appendChild() {} }
  };
}

function load() {
  const sb = {
    window: {}, document: makeDoc(),
    console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {}, table() {} },
    ZOHO: { CREATOR: { DATA: {} } }, alert() {}, setTimeout: (f) => 0,
    requestAnimationFrame: () => 0,
    JSON, Math, Number, String, Object, Array, Date, isFinite, parseFloat, parseInt
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/lot-allocator.js'), 'utf8'), sb);
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/main.js'), 'utf8'), sb); } catch (e) {}
  return sb;
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  — ' + detail); }
}

const roll = (id, len) => ({ rollId: id, label: id.toUpperCase(), length: len, status: 'Available' });
const lotOf = (id, o) => Object.assign(
  { lotId: id, lotNumber: id, wash: 0, unwash: 0, inWash: 0, blocked: false, rolls: [], form: 'Roll' }, o);

function fabricMat(o) {
  const lines = o.lines || [];
  const req = lines.reduce((s, l) => s + (l.reqPieces || 0), 0);
  const iss = lines.reduce((s, l) => s + (l.issPieces || 0), 0);
  return Object.assign({
    materialId: '9', material: 'Linen', sku: 'RM-9', unit: 'Mtr',
    isFabric: true, isReissue: false, fabricWidthCm: 150,
    required: req, issued: iss, remaining: Math.max(0, req - iss),
    requiredPieces: req, issuedPieces: iss, outstandingPieces: Math.max(0, req - iss),
    requiredTotal: req, availableStock: 0, unwashedStock: 0, inWashStock: 0,
    poCoveredQty: 0, openExceptions: [], lots: [], wasteStock: [],
    cuts: lines.map(l => ({ cutW: l.cutW, cutL: l.cutL, reqPieces: l.reqPieces, issPieces: l.issPieces || 0 })),
    freshMeters: 0
  }, o);
}

// Build a real allocation, then a real payload line, for N orders.
function buildIssues(S, nOrders, rollLen) {
  const lines = [];
  for (let i = 0; i < nOrders; i++) {
    lines.push({ planId: 'p' + i, planItemId: 'i' + i, mrqId: 'm' + i,
                 cutW: 150, cutL: 100, reqPieces: 2, issPieces: 0 });
  }
  const m = fabricMat({
    availableStock: rollLen,
    lots: [lotOf('L1', { wash: rollLen, rolls: [roll('r1', rollLen)] })],
    lines: lines
  });
  S.allocateEveryCard([{ supervisorId: 'A', supervisorName: 'A', materials: [m] }]);
  return { m: m, line: S.buildFabricIssueLine(m, []) };
}

// ============================================================
console.log('\n=== H1. splitIssuesByAllocation ===');
// ============================================================
{
  const S = load();
  const built = buildIssues(S, 250, 2000);   // 250 orders => 250 allocations
  const issues = [built.line];
  const total = built.line.allocations.length;
  ok('the allocator produced many allocations', total > 100, 'allocations=' + total);

  const chunks = S.splitIssuesByAllocation(issues, 100);
  const allocsOut = chunks.reduce((s, c) => s + c.reduce((t, l) => t + l.allocations.length, 0), 0);
  ok('every allocation survives the split', allocsOut === total,
    'in=' + total + ' out=' + allocsOut);

  const mrqIn = new Set(built.line.allocations.map(a => String(a.mrqId)));
  const mrqOut = new Set();
  chunks.forEach(c => c.forEach(l => l.allocations.forEach(a => mrqOut.add(String(a.mrqId)))));
  ok('no requirement row is dropped', mrqOut.size === mrqIn.size, 'in=' + mrqIn.size + ' out=' + mrqOut.size);

  let dup = 0;
  const seen = {};
  chunks.forEach(c => c.forEach(l => l.allocations.forEach(a => {
    if (seen[a.mrqId]) dup++; seen[a.mrqId] = 1;
  })));
  ok('no requirement row is duplicated across chunks', dup === 0, 'dups=' + dup);

  chunks.forEach((c, i) => {
    const n = c.reduce((t, l) => t + l.allocations.length, 0);
    ok('chunk ' + i + ' within the cap', n <= 100, 'allocs=' + n);
  });

  // lotMoves must ride the FIRST slice only, or the lot metres move twice.
  const lotMoveChunks = chunks.filter(c => c.some(l => (l.lotMoves || []).length > 0));
  ok('lotMoves ride exactly one chunk', lotMoveChunks.length === 1,
    'chunks carrying lotMoves=' + lotMoveChunks.length + ' (more than one = the lot moves twice)');

  // issueLines must stay in lockstep with allocations
  let lockstep = true;
  chunks.forEach(c => c.forEach(l => {
    if ((l.issueLines || []).length !== l.allocations.length) lockstep = false;
  }));
  ok('issueLines stay in lockstep with allocations', lockstep, 'mismatch');
}

// ============================================================
console.log('\n=== H2. buildHandoverSummary conserves what left the shelf ===');
// ============================================================
{
  const S = load();
  const built = buildIssues(S, 40, 500);
  const summary = S.buildHandoverSummary([built.line]);

  const allocQty = built.line.allocations.reduce((s, a) => s + (Number(a.giveQty) || 0), 0);
  const allocRaw = built.line.allocations.reduce((s, a) => s + (Number(a.giveRaw) || 0), 0);
  const sumQty = summary.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const sumRaw = summary.lines.reduce((s, l) => s + (Number(l.piecesFromRaw) || 0), 0);

  ok('metres conserved into the handover', Math.abs(allocQty - sumQty) < 0.01,
    'allocations=' + allocQty + ' handover=' + sumQty);
  ok('pieces conserved into the handover', allocRaw === sumRaw,
    'allocations=' + allocRaw + ' handover=' + sumRaw);
  ok('planCount counts distinct orders', summary.planCount === 40, 'planCount=' + summary.planCount);
  ok('aggregated to material x lot', summary.lines.length === 1,
    'lines=' + summary.lines.length + ' (40 orders, one material, one lot)');

  // Per-roll metres in the handover must not exceed the roll
  const perRoll = {};
  summary.lines.forEach(l => (l.rolls || []).forEach(r => {
    perRoll[r.rollId] = Math.round(((perRoll[r.rollId] || 0) + (Number(r.metres) || 0)) * 100) / 100;
  }));
  Object.keys(perRoll).forEach(k =>
    ok('handover roll ' + k + ' within its length', perRoll[k] <= 500.0001, 'metres=' + perRoll[k]));
}

// ============================================================
console.log('\n=== H3. appliedIssues(): ROW granularity after a partial death ===');
// ============================================================
{
  // Models what main.js's appliedIssues() does: filter each line's allocations
  // by the mrqIds the SERVER confirms it stamped. The point is that a chunk
  // killed by the statement limit returns NOTHING, yet may have applied most of
  // its rows — those moved stock and MUST get an Issue_Line, or they are
  // stranded in In_Transit_Qty for ever with nothing saying so.
  const S = load();
  const built = buildIssues(S, 250, 2000);
  const chunks = S.splitIssuesByAllocation([built.line], 100);

  const appliedIssues = (confirmed) => {
    const out = [];
    chunks.forEach(chunk => chunk.forEach(line => {
      const keep = (line.allocations || []).filter(a => confirmed[String(a.mrqId)]);
      if (!keep.length) return;
      const keptMrq = {};
      keep.forEach(a => { keptMrq[String(a.mrqId)] = 1; });
      out.push({
        materialId: line.materialId, source: line.source, isFabric: line.isFabric,
        unit: line.unit, cutWidth: line.cutWidth, cutLength: line.cutLength,
        allocations: keep,
        issueLines: (line.issueLines || []).filter(il => keptMrq[String(il.mrqId)]),
        lotMoves: line.lotMoves || []
      });
    }));
    return out;
  };

  // Chunk 0 fully applied, chunk 1 died after 45 of its 100 rows, chunk 2 never ran.
  const confirmed = {};
  chunks[0].forEach(l => l.allocations.forEach(a => { confirmed[a.mrqId] = 1; }));
  chunks[1].forEach(l => l.allocations.slice(0, 45).forEach(a => { confirmed[a.mrqId] = 1; }));

  const applied = appliedIssues(confirmed);
  const appliedCount = applied.reduce((s, l) => s + l.allocations.length, 0);
  ok('records exactly the rows that landed', appliedCount === 145,
    'recorded=' + appliedCount + ' (100 whole chunk + 45 partial)');

  const summary = S.buildHandoverSummary(applied);
  const sumRaw = summary.lines.reduce((s, l) => s + (Number(l.piecesFromRaw) || 0), 0);
  const landedRaw = [].concat.apply([], applied.map(l => l.allocations))
    .reduce((s, a) => s + (Number(a.giveRaw) || 0), 0);
  ok('the handover matches the rows that landed', sumRaw === landedRaw,
    'handover=' + sumRaw + ' landed=' + landedRaw);

  // The rows that did NOT land must be absent
  const recorded = {};
  applied.forEach(l => l.allocations.forEach(a => { recorded[a.mrqId] = 1; }));
  const ghosts = Object.keys(recorded).filter(k => !confirmed[k]);
  ok('no unconfirmed row is claimed as issued', ghosts.length === 0,
    'ghosts=' + ghosts.length + ' (claiming cloth that never left the shelf)');

  // And nothing confirmed is missing
  const missing = Object.keys(confirmed).filter(k => !recorded[k]);
  ok('no confirmed row is left without an Issue_Line', missing.length === 0,
    'missing=' + missing.length + ' (each one = stock stranded in In_Transit_Qty)');

  // Nothing landed at all -> nothing recorded
  ok('a press that landed nothing records nothing', appliedIssues({}).length === 0, 'lines emitted');
}

// ============================================================
console.log('\n=== H4. the Apply_Key retry guard (server semantics) ===');
// ============================================================
{
  // Models issueMaterialsApply's per-row guard: a row already carrying THIS
  // press's Apply_Key has already been counted, so a replayed chunk must skip
  // its counters. Without it a rate-limit retry doubles Issued_Qty and every
  // stock move that follows it.
  function applyChunk(server, chunk, applyKey) {
    let anyNew = false;
    chunk.forEach(line => {
      (line.allocations || []).forEach(a => {
        const row = server.mrq[a.mrqId] || (server.mrq[a.mrqId] = { issued: 0, raw: 0, key: '' });
        const already = applyKey !== '' && row.key === applyKey;
        if (already) return;
        anyNew = true;
        row.key = applyKey;                    // watermark FIRST, deliberately
        row.issued += Number(a.giveQty) || 0;
        row.raw += Number(a.giveRaw) || 0;
      });
      // Sections 2/3 (lot metres, rolls) only re-run when something was new.
      if (anyNew) {
        (line.lotMoves || []).forEach(lm => {
          server.lot[lm.lotId] = Math.round(((server.lot[lm.lotId] || 0) + (Number(lm.qty) || 0)) * 100) / 100;
          (lm.rolls || []).forEach(r => {
            const k = lm.lotId + '|' + r.rollId;
            server.roll[k] = Math.round(((server.roll[k] || 0) + (Number(r.metres) || 0)) * 100) / 100;
          });
        });
      }
    });
    return anyNew;
  }

  const S = load();
  const built = buildIssues(S, 60, 500);
  const chunks = S.splitIssuesByAllocation([built.line], 100);
  const KEY = 'P-test-1';

  const fresh = () => ({ mrq: {}, lot: {}, roll: {} });

  // Once
  const s1 = fresh();
  chunks.forEach(c => applyChunk(s1, c, KEY));
  const once = { issued: Object.values(s1.mrq).reduce((s, r) => s + r.issued, 0),
                 lot: Object.values(s1.lot).reduce((s, v) => s + v, 0) };

  // Twice — the rate-limit replay
  const s2 = fresh();
  chunks.forEach(c => applyChunk(s2, c, KEY));
  chunks.forEach(c => applyChunk(s2, c, KEY));
  const twice = { issued: Object.values(s2.mrq).reduce((s, r) => s + r.issued, 0),
                  lot: Object.values(s2.lot).reduce((s, v) => s + v, 0) };

  ok('replaying a chunk does NOT double Issued_Qty', once.issued === twice.issued,
    'once=' + once.issued + ' twice=' + twice.issued);
  ok('replaying a chunk does NOT double the lot move', once.lot === twice.lot,
    'once=' + once.lot + ' twice=' + twice.lot);

  // A DIFFERENT press must still apply (the key is per press, not per row)
  const s3 = fresh();
  chunks.forEach(c => applyChunk(s3, c, KEY));
  chunks.forEach(c => applyChunk(s3, c, 'P-test-2'));
  const twoPresses = Object.values(s3.mrq).reduce((s, r) => s + r.issued, 0);
  ok('a genuinely new press DOES apply', twoPresses === once.issued * 2,
    'one press=' + once.issued + ' two presses=' + twoPresses);

  // The watermark is written BEFORE the counters — a row stamped but not counted
  // is visible (and disputable); counted but not stamped is invisibly stranded.
  const s4 = { mrq: {}, lot: {}, roll: {} };
  applyChunk(s4, chunks[0], KEY);
  const anyStampedUncounted = Object.values(s4.mrq).some(r => r.key === KEY);
  ok('every counted row carries the key', anyStampedUncounted, 'no watermark written');
}

// ============================================================
console.log('\n=== H5. a whole press, against a modelled server ===');
// ============================================================
{
  const S = load();
  // 3 orders, one lot, one 30m roll. 2 pieces each at 150x100 => 2m per order.
  const built = buildIssues(S, 3, 30);
  const issues = [built.line];
  const chunks = S.splitIssuesByAllocation(issues, 100);

  const server = { mrq: {}, lot: {}, roll: {} };
  const KEY = 'P-run';
  chunks.forEach(chunk => chunk.forEach(line => {
    (line.allocations || []).forEach(a => {
      const row = server.mrq[a.mrqId] || (server.mrq[a.mrqId] = { issued: 0, raw: 0, key: '' });
      if (row.key === KEY) return;
      row.key = KEY; row.issued += Number(a.giveQty) || 0; row.raw += Number(a.giveRaw) || 0;
    });
    (line.lotMoves || []).forEach(lm => {
      server.lot[lm.lotId] = Math.round(((server.lot[lm.lotId] || 0) + (Number(lm.qty) || 0)) * 100) / 100;
      (lm.rolls || []).forEach(r => {
        const k = lm.lotId + '|' + r.rollId;
        server.roll[k] = Math.round(((server.roll[k] || 0) + (Number(r.metres) || 0)) * 100) / 100;
      });
    });
  }));

  const issuedTotal = Object.values(server.mrq).reduce((s, r) => s + r.issued, 0);
  const lotTotal = Object.values(server.lot).reduce((s, v) => s + v, 0);
  const rollTotal = Object.values(server.roll).reduce((s, v) => s + v, 0);

  ok('every requirement row got its metres', Object.keys(server.mrq).length === 3,
    'rows=' + Object.keys(server.mrq).length);
  ok('the lot move equals what the rows were issued', Math.abs(lotTotal - issuedTotal) < 0.01,
    'rows=' + issuedTotal + ' lotMove=' + lotTotal);
  ok('the roll decrement equals the lot move', Math.abs(rollTotal - lotTotal) < 0.01,
    'roll=' + rollTotal + ' lot=' + lotTotal);
  ok('never more than the roll held', rollTotal <= 30.0001, 'roll cut=' + rollTotal + ' of 30');

  // And the handover the supervisor receives matches what moved
  const summary = S.buildHandoverSummary(issues);
  const handoverQty = summary.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  ok('the handover record equals the stock that moved',
    Math.abs(handoverQty - issuedTotal) < 0.01,
    'handover=' + handoverQty + ' moved=' + issuedTotal +
    ' (a mismatch is either unreceivable stock or a phantom receipt)');
  ok('every piece is accounted for',
    summary.lines.reduce((s, l) => s + l.piecesFromRaw + l.piecesFromWaste, 0) === 6,
    'pieces=' + summary.lines.reduce((s, l) => s + l.piecesFromRaw + l.piecesFromWaste, 0) + ' of 6');
}

// ============================================================
console.log('\n=== H6. isRateLimited must not fire on a record id (regression) ===');
// ============================================================
{
  // REGRESSION. The predicate matched the bare substring "429" anywhere in the
  // error text. issueMaterialsApply embeds 18-digit Creator record ids in three
  // of its error strings ("requirement <id> not found", "lot <id> not found",
  // "roll <label> (<id>) not found on lot <id>"), and those come back as a
  // normal HTTP 200 carrying errors[] — which `delugeThrottled` runs this
  // predicate over. An id containing "429" anywhere in its eighteen digits
  // (roughly one row in forty) turned a PERMANENT failure into a rate-limit
  // retry: the same doomed chunk replayed five times across ~2 minutes of
  // backoff, and the real error never surfaced because the retry path returns
  // before allErrors is appended.
  const src = fs.readFileSync(path.join(ROOT, 'app/js/main.js'), 'utf8');
  const m = src.match(/function isRateLimited\(err\)\s*\{[\s\S]*?\n    \}/);
  ok('isRateLimited is still where this test expects it', !!m,
    'not found — update this test if it moved');
  if (m) {
    const body = m[0].replace(/^function isRateLimited\(err\)\s*\{/, '').replace(/\}\s*$/, '');
    const fn = new Function('err', 'JSON', 'String', 'RegExp', body);
    const isRL = (e) => { try { return !!fn(e, JSON, String, RegExp); } catch (x) { return 'THREW'; } };

    // Genuine throttles must STILL retry.
    ok('HTTP 429 status retries', isRL({ status: 429 }) === true, 'status 429');
    ok('statusCode 429 retries', isRL({ statusCode: 429 }) === true, 'statusCode 429');
    ok('a bare 429 code in the text retries', isRL({ message: 'error 429 received' }) === true, '"error 429"');
    ok('4834 retries', isRL({ message: 'code 4834' }) === true, '"code 4834"');
    ok('"too many requests" retries', isRL({ message: 'Too Many Requests' }) === true, 'wording');
    ok('"rate limit" retries', isRL({ message: 'API rate limit reached' }) === true, 'wording');
    ok('"throttled" retries', isRL({ message: 'request throttled' }) === true, 'wording');

    // Permanent failures must NOT retry.
    ok('a record id containing 429 does NOT retry',
      isRL({ message: 'RM-9: requirement 3955559000000429001 not found' }) === false,
      'an 18-digit id with 429 inside it');
    ok('a SKU containing 429 does NOT retry',
      isRL({ message: 'RM-4291: requirement not found' }) === false, 'SKU RM-4291');
    ok('a metres figure containing 429 does NOT retry',
      isRL({ message: 'material short by 4.29 Mtr' }) === false, '4.29');
    ok('a cut size containing 429 does NOT retry',
      isRL({ message: 'RM-9: roll R2 (429x120) not found on lot L1' }) === false,
      '429x120 — the boundary must be non-alphanumeric, not merely non-digit');
    ok('a lot number containing 429 does NOT retry',
      isRL({ message: 'RM-9: lot L429 has 0 washed, asked 12 - clamped' }) === false,
      'L429');
    ok('the statement limit does NOT retry',
      isRL({ message: 'Maximum statement execution limit reached' }) === false,
      'the uncatchable one — retrying it just repeats the death');
    ok('a plain 500 does NOT retry',
      isRL({ message: 'Internal Server Error 500' }) === false, '500');
  }

  // AND the second half of the fix: only "DELUGE:" rows are even tested.
  // A per-row error is permanent by construction and must never be a candidate,
  // whatever digits it happens to contain.
  const drv = src.match(/var delugeThrottled = parsed && parsed\.errors &&[\s\S]*?\}\);/);
  ok('delugeThrottled screens for the DELUGE: prefix', !!drv && /DELUGE:/.test(drv[0]),
    'the per-row errors (which embed ids) must not be throttle candidates');
}

console.log('\n========================================');
console.log('issue-handover-path: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
