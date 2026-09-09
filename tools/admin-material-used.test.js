// Material used tab — the verdict, the columns that hide themselves, and the two
// fields getOrderConsumption computed but the screen threw away.
//
// The important assertions here are the NEGATIVE ones. A column that appears
// when it has nothing to put in it is the problem being fixed, and a colspan
// that does not match the columns actually drawn breaks the table silently.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'app', 'admin', 'js', 'main.js');
let code = fs.readFileSync(SRC, 'utf8');
const lines = code.split('\n');
const cutLine = lines.findIndex(function (l) {
    return l.indexOf("document.querySelectorAll('.tab-btn')") === 0;
});
if (cutLine === -1) throw new Error('anchor not found - file shape changed');
code = lines.slice(0, cutLine).join('\n');

const noop = function () {};
const stubEl = {
    classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } },
    querySelector: function () { return stubEl; },
    querySelectorAll: function () { return []; },
    addEventListener: noop,
    textContent: '', innerHTML: '', dataset: {}, hidden: false
};
const ctx = {
    document: {
        getElementById: function () { return stubEl; },
        querySelector: function () { return stubEl; },
        querySelectorAll: function () { return []; },
        createElement: function () { return stubEl; }
    },
    window: {}, console: console,
    ZOHO: { CREATOR: { DATA: { invokeCustomApi: function () { return { then: function () { return { catch: noop }; } }; } } } },
    ApiExperiment: { run: function () { return { then: function () { return { catch: noop }; } }; } },
    applyLotAllocation: noop
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

function merge(base, over) {
    const out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(over || {}).forEach(function (k) { out[k] = over[k]; });
    return out;
}

// A healthy fabric line: planned, issued, all confirmed received, no trouble.
const FAB = {
    materialId: 'M1', material: 'Linen Fabric / Solid / Dusty Gold', unit: 'Mtr',
    isFabric: true, planned: 14.6, reissued: 0, issued: 14.6, received: 14.6,
    lost: 0, lostPieces: 0, spent: 14.6, variance: 0, cuttingAllowance: 0,
    requiredPieces: 5, piecesFromRaw: 5, piecesFromWaste: 0,
    damagedQty: 0, damagedPieces: 0, wasteKeptPieces: 0, wasteScrapPieces: 0,
    wasteAreaM2: 0, reasons: []
};
const TRIM = merge(FAB, {
    materialId: 'M2', material: 'Stitching Thread / Dusty Gold', unit: 'Cone',
    isFabric: false, planned: 15, issued: 15, received: 15, spent: 15,
    requiredPieces: 0, piecesFromRaw: 0
});
function fab(over) { return merge(FAB, over); }
function trim(over) { return merge(TRIM, over); }

// ---------------------------------------------------------------
console.log('\nA clean order (the screenshot case):');
let mats = [fab(), trim()];
let f = ctx.collectUsedFindings(mats);
check('raises nothing', f.length === 0, JSON.stringify(f.map(function (x) { return x.kind; })));

let cols = ctx.usedColumns(mats);
check('Reissued column hidden', cols.reissued === false);
check('In transit column hidden', cols.transit === false);
check('Lost column hidden', cols.lost === false);
check('vs plan column hidden', cols.variance === false);
check('Damaged column hidden', cols.damaged === false);
check('Waste back column hidden', cols.wasteKept === false);
check('Scrapped column hidden', cols.wasteScrap === false);
check('only the 6 always-on columns remain', ctx.usedColCount(cols) === 6,
    'got ' + ctx.usedColCount(cols));

let v = ctx.renderUsedVerdict(mats, f);
check('green verdict', v.indexOf('verdict-ok') > -1);
check('says consumed as planned', v.indexOf('consumed as planned') > -1);
check('names the shape of the order',
    v.indexOf('1 fabric line') > -1 && v.indexOf('1 trim') > -1);

// ---------------------------------------------------------------
console.log('\nMATERIAL IN TRANSIT — the gap the screen could not show at all:');
// Stock is consumed at RECEIPT (CLAUDE.md), but spent = issued + lost. So cloth
// that has been issued and not confirmed is already counted as eaten by this
// report while nobody has confirmed holding it. getOrderConsumption returned
// `received` from the start; nothing rendered it and nothing compared it.
mats = [fab({ issued: 14.6, received: 9.0 })];
f = ctx.collectUsedFindings(mats);
const tf = f.filter(function (x) { return x.kind === 'transit'; });
check('raised', tf.length === 1, JSON.stringify(f.map(function (x) { return x.kind; })));
check('level is bad', tf[0] && tf[0].level === 'bad');
check('names the outstanding amount', tf[0] && tf[0].what.indexOf('5.6') > -1,
    tf[0] && tf[0].what);
check('explains why it matters', tf[0] && tf[0].detail.indexOf('consumed at receipt') > -1);

cols = ctx.usedColumns(mats);
check('In transit column now appears', cols.transit === true);
check('the row renders the gap', ctx.renderUsedRow(mats[0], cols).indexOf('is-transit') > -1);
check('a fully-received row shows a dash in that column',
    ctx.renderUsedRow(fab(), cols).indexOf('is-muted') > -1);

// ---------------------------------------------------------------
console.log('\nReceipt is stated in the detail, either way:');
const facts = ctx.usedFacts(fab());
check('a fully received line confirms it',
    facts.some(function (s) { return s.indexOf('confirmed received') > -1; }),
    JSON.stringify(facts));
const partFacts = ctx.usedFacts(fab({ issued: 14.6, received: 9 }));
check('a partial receipt says how much is outstanding',
    partFacts.some(function (s) { return s.indexOf('still in transit') > -1; }),
    JSON.stringify(partFacts));

// ---------------------------------------------------------------
console.log('\nCUTTING ALLOWANCE — computed by the server, previously discarded:');
// The single most-questioned figure in the app. The old legend spent two
// sentences explaining the surplus it causes while the number itself appeared
// only inside the reasons list.
const ca = ctx.usedFacts(fab({ variance: 1.2, cuttingAllowance: 1.2 }));
check('now stated', ca.some(function (s) { return s.indexOf('cutting allowance') > -1; }),
    JSON.stringify(ca));
check('names the figure', ca.some(function (s) { return s.indexOf('1.2') > -1; }));

// ---------------------------------------------------------------
console.log('\nWritten off, damaged, and under plan:');
f = ctx.collectUsedFindings([fab({ lost: 2.5, spent: 17.1 })]);
check('lost raised as bad',
    f.some(function (x) { return x.kind === 'lost' && x.level === 'bad'; }));

f = ctx.collectUsedFindings([fab({ damagedQty: 3, damagedPieces: 2 })]);
const df = f.filter(function (x) { return x.kind === 'damaged'; });
check('damage raised as a NOTE, not a fault', df.length === 1 && df[0].level === 'note');
check('damage says it is not netted', df[0] && df[0].detail.indexOf('not netted') > -1);

// A surplus IS the cutting allowance and is normal.
f = ctx.collectUsedFindings([fab({ variance: 1.2 })]);
check('a surplus raises nothing', f.length === 0,
    JSON.stringify(f.map(function (x) { return x.kind; })));

// ---------------------------------------------------------------
console.log('\nSHORTFALL ONLY COUNTS ONCE NOTHING MORE IS COMING:');
// A real order (SO-01001) that had not started issuing reported EVERY one of
// its 14 materials as "less than planned" — fourteen findings saying one
// ordinary thing, which is exactly the crying-wolf failure that makes a verdict
// worth scrolling past. Three states were collapsed into one; only the last is
// a fault.
//
// orderIsClosed() reads the selected order's status out of ALL_ORDERS, so these
// cases drive it through that.
function setOrder(status) {
    ctx.ALL_ORDERS = [{ id: 'SO1', name: 'SO-01001', status: status }];
    ctx.document.getElementById = function (id) {
        if (id === 'so-select') return { value: 'SO1' };
        return stubEl;
    };
}

// 1. Nothing issued at all — the screenshot case.
setOrder('In Progress');
const unissued = [fab({ issued: 0, received: 0, spent: 0, variance: -14.6 }),
                  trim({ issued: 0, received: 0, spent: 0, variance: -15 })];
f = ctx.collectUsedFindings(unissued);
check('an order that has not started issuing raises NOTHING', f.length === 0,
    JSON.stringify(f.map(function (x) { return x.kind + ':' + x.what; })));
check('nothingIssuedYet recognises it', ctx.nothingIssuedYet(unissued) === true);
v = ctx.renderUsedVerdict(unissued, f);
check('the verdict says nothing issued yet', v.indexOf('Nothing issued yet') > -1);
check('it does NOT claim material was consumed as planned',
    v.indexOf('consumed as planned') === -1);
check('it says the table is what the order will need',
    v.indexOf('what it will need') > -1);

// 2. Part-issued while still In Progress — normal mid-flight, not a shortfall.
setOrder('In Progress');
f = ctx.collectUsedFindings([fab({ issued: 8, received: 8, spent: 8, variance: -6.6 })]);
check('part-issued on an OPEN order raises no shortfall',
    !f.some(function (x) { return x.kind === 'under'; }),
    JSON.stringify(f.map(function (x) { return x.kind; })));

// 3. Short once production is finished — a real finding.
setOrder('Production Complete');
f = ctx.collectUsedFindings([fab({ issued: 8, received: 8, spent: 8, variance: -6.6 })]);
const uf = f.filter(function (x) { return x.kind === 'under'; });
check('short on a FINISHED order IS raised', uf.length === 1);
check('and it is a fault, not a note', uf[0] && uf[0].level === 'bad');
check('it says production is finished', uf[0] && uf[0].detail.indexOf('finished') > -1);

// 4. Finished but nothing ever issued — still not a shortfall finding per line.
setOrder('Production Complete');
f = ctx.collectUsedFindings([fab({ issued: 0, received: 0, spent: 0, variance: -14.6 })]);
check('a finished order with nothing issued still raises no per-line shortfall',
    !f.some(function (x) { return x.kind === 'under'; }));

// 5. Unknown status — stay silent rather than guess.
ctx.ALL_ORDERS = [];
f = ctx.collectUsedFindings([fab({ issued: 8, received: 8, spent: 8, variance: -6.6 })]);
check('an unreadable order status raises no shortfall (never guess)',
    !f.some(function (x) { return x.kind === 'under'; }));

// Restore for the tests that follow.
ctx.ALL_ORDERS = [];
ctx.document.getElementById = function () { return stubEl; };

// ---------------------------------------------------------------
console.log('\ncolspan follows the columns actually drawn:');
// It was hardcoded to 12, which is wrong on every order that does not light up
// every optional column. A mismatch breaks the table layout silently.
const sets = [
    [fab(), trim()],
    [fab({ lost: 1 })],
    [fab({ lost: 1, damagedQty: 2, variance: 3, reissued: 1, received: 1,
           wasteKeptPieces: 2, wasteScrapPieces: 1 })]
];
sets.forEach(function (set, i) {
    const c = ctx.usedColumns(set);
    const n = ctx.usedColCount(c);
    const withDetail = merge(set[0], { reasons: [{ type: 'Lost', qty: 1, isWaste: false }] });
    const html = ctx.renderUsedRow(withDetail, c);
    const declared = (html.match(/colspan="(\d+)"/) || [])[1];
    check('set ' + i + ': detail colspan (' + declared + ') matches column count (' + n + ')',
        String(declared) === String(n));

    // Cells in the data row itself must equal the header count too.
    const dataRow = html.split('</tr>')[0];
    const cells = (dataRow.match(/<td/g) || []).length;
    check('set ' + i + ': data row has ' + n + ' cells', cells === n,
        'got ' + cells);
});

// ---------------------------------------------------------------
console.log('\nEvery finding can be clicked through to its row:');
mats = [fab({ issued: 14.6, received: 9.0 }), trim({ damagedQty: 2 })];
f = ctx.collectUsedFindings(mats);
v = ctx.renderUsedVerdict(mats, f);
check('one data-used-goto per finding',
    (v.match(/data-used-goto="/g) || []).length === f.length,
    'findings ' + f.length + ', links ' + (v.match(/data-used-goto="/g) || []).length);
check('each names a material id present in the table',
    f.every(function (x) {
        return mats.some(function (m) { return String(m.materialId) === String(x.materialId); });
    }));
check('the row it points at carries the matching marker',
    ctx.renderUsedRow(mats[0], ctx.usedColumns(mats)).indexOf('data-used-row="M1"') > -1);
check('bad findings sort above notes',
    v.indexOf('vf-bad') > -1 && v.indexOf('vf-bad') < v.indexOf('vf-note'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
