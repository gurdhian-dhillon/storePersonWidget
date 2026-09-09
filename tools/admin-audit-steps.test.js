// Exercises lineStage + renderFabricLine from app/admin/js/main.js in a stub
// DOM, per CLAUDE.md's "render functions can be exercised in a stub DOM with vm
// to assert real output".
//
// The case that matters is the one from the screenshot: a fabric line that is
// fully issued and received, with a pin lot but no handover lines carrying a
// lot. That rendered all four steps, two of them saying nothing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(
    'c:', 'Users', 'gurdh', 'OneDrive', 'Desktop', 'getStoreMaterial',
    'storePersonWidget', 'app', 'admin', 'js', 'main.js');

let code = fs.readFileSync(SRC, 'utf8');

// The file ends with top-level DOM wiring + an immediate load(''). Cut from the
// first TOP-LEVEL statement onwards; we only want the pure render/derive
// functions. Matched at column 0 — the same call appears indented inside wire(),
// and slicing there cuts mid-function.
const lines = code.split('\n');
const cutLine = lines.findIndex(l => l.startsWith("document.querySelectorAll('.tab-btn')"));
if (cutLine === -1) throw new Error('anchor not found - file shape changed');
code = lines.slice(0, cutLine).join('\n');

const noop = () => {};
const stubEl = {
    classList: { add: noop, remove: noop, toggle: noop },
    querySelector: () => stubEl,
    querySelectorAll: () => [],
    addEventListener: noop,
    textContent: '', innerHTML: '', dataset: {}, hidden: false
};

const ctx = {
    document: {
        getElementById: () => stubEl,
        querySelector: () => stubEl,
        querySelectorAll: () => [],
        createElement: () => stubEl
    },
    window: {}, console, ZOHO: { CREATOR: { DATA: { invokeCustomApi: () => ({ then: () => ({ catch: noop }) }) } } },
    ApiExperiment: { run: () => ({ then: () => ({ catch: noop }) }) },
    applyLotAllocation: noop
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// ---- the screenshot's line: Linen Fabric / Chambray / Olive, fully issued ----
const doneMat = {
    reqId: 'R1', materialId: 'M1', material: 'Linen Fabric / Chambray / Olive',
    sku: 'RM-00010', isFabric: true, unit: 'Mtr',
    cutWidth: 187, cutLength: 137, fabricWidthCm: 314.96, fabricWidthInches: '124',
    perUnit: 0, requiredPieces: 10, piecesFromRaw: 10, piecesFromWaste: 0,
    isReissue: false, storedRequiredQty: 13.7, issuedQty: 13.7, receivedQty: 13.7,
    bucketKey: '', pinLot: 'L1', issuedLots: []
};
const doneItem = {
    planItemId: 'PI1', planId: 'P1', itemName: 'Linen Hamlet Throw',
    lineNo: 1, qtyOrdered: 10, qtyProduced: 0, status: 'Ready_For_Production',
    hasBom: true, materials: [doneMat], wasteIssued: []
};

ctx.DATA = { plans: [{ planId: 'P1', planNo: 'PLAN-1', items: [doneItem] }] };
ctx.LIVE = null;
ctx.MY_PLAN_IDS = ['P1'];

console.log('\nFully issued + received line (the screenshot case):');
const st1 = ctx.lineStage(doneMat, doneItem, null);
check('step 2 hidden (nothing outstanding)', st1.showAlloc === false);
check('step 3 hidden (already cut)', st1.showWaste === false);
check('step 4 shown (there is a record)', st1.showIssued === true);

const html1 = ctx.renderFabricLine(doneMat, doneItem);
check('renders step 1', html1.includes('Planned requirement'));
check('no step 2 block', !html1.includes('step step-issue"'));
check('no step 3 block', !html1.includes('step step-waste'));
check('renders step 4', html1.includes('What actually went out'));
check('says which steps were skipped', html1.includes('steps-skipped'));
check('names step 2 as skipped', html1.includes('2 Allocated right now'));
check('names step 3 as skipped', html1.includes('3 Waste this will throw off'));
check('agreement is a tick, not a sentence', html1.includes('&#10003;') && !html1.includes('— matches.'));
check('no step-note subtitles anywhere', !html1.includes('step-note'));
check('"predicted"/"recorded" qualifier survives on step 4', html1.includes('step-qual'));

// ---- a brand-new line: planned, nothing issued, no live allocation ----
console.log('\nNothing issued yet, no live allocation:');
const newMat = Object.assign({}, doneMat, {
    reqId: 'R2', issuedQty: 0, receivedQty: 0, pinLot: '', issuedLots: []
});
const newItem = Object.assign({}, doneItem, { planItemId: 'PI2', materials: [newMat] });
const st2 = ctx.lineStage(newMat, newItem, null);
check('step 2 hidden (no bucket)', st2.showAlloc === false);
check('step 3 SHOWN (forecast still useful)', st2.showWaste === true);
check('step 4 hidden (nothing went out)', st2.showIssued === false);

ctx.DATA = { plans: [{ planId: 'P1', planNo: 'PLAN-1', items: [newItem] }] };
const html2 = ctx.renderFabricLine(newMat, newItem);
check('renders step 3', html2.includes('Waste this will throw off'));
check('no step 4 block', !html2.includes('step step-issued'));
check('names step 4 as skipped', html2.includes('4 What actually went out'));

// ---- a partially issued line WITH a live allocation ----
console.log('\nOutstanding, with a live allocation:');
ctx.LIVE = [{
    supervisorId: 'S1', supervisorName: 'Sanket',
    materials: [{
        isFabric: true, materialId: 'M1', supervisorName: 'Sanket', unit: 'Mtr',
        cutWidth: 187, cutLength: 137, fabricWidthCm: 314.96,
        availableStock: 100, unwashedStock: 0,
        requiredPieces: 10, issuedPieces: 4, outstandingPieces: 6,
        isReissue: false, lines: [], wasteStock: [], wastePicks: [],
        orderOutcomes: [{
            planId: 'P1', why: 'ready', lotNumber: 'L1', pin: '',
            pieces: 6, metres: 8.22, wastePieces: 0, greige: 0,
            shortPieces: 0, override: '', needMetres: 8.22
        }]
    }]
}];
const partMat = Object.assign({}, doneMat, {
    reqId: 'R3', issuedQty: 5.48, receivedQty: 5.48,
    bucketKey: 'S1|M1|18700x13700|Plan'
});
const partItem = Object.assign({}, doneItem, { planItemId: 'PI3', materials: [partMat] });
ctx.DATA = { plans: [{ planId: 'P1', planNo: 'PLAN-1', items: [partItem] }] };

const bucket = ctx.bucketFor(partMat.bucketKey);
check('bucket resolves from LIVE', !!bucket, 'bucketFor returned ' + bucket);
const st3 = ctx.lineStage(partMat, partItem, bucket);
check('step 2 shown', st3.showAlloc === true);
check('step 3 shown', st3.showWaste === true);
check('step 4 shown', st3.showIssued === true);

const html3 = ctx.renderFabricLine(partMat, partItem);
check('all four steps render', ['Planned requirement', 'Allocated right now',
    'Waste this will throw off', 'What actually went out'].every(s => html3.includes(s)));
check('nothing reported as skipped', !html3.includes('steps-skipped'));

// ---- the per-lot waste breakdown suppresses itself on a single-lot item ----
//
// This is the one piece of lot/roll prose that reaches the screen, and it was
// reviewed for cutting along with everything else. It stays because it is
// already conditional: on a single-lot item — the common case, and every item in
// the screenshots that prompted this pass — the label is a bare "Rows" and the
// summary line does not render at all. It speaks up only when the order really
// was cut off more than one lot, which is precisely the finding an admin needs.
console.log('\nPer-lot waste breakdown:');

// 3 per row at a 100cm cut. One lot with enough cloth for the whole job.
const oneLotMat = {
    reqId: 'RL1', materialId: 'ML', material: 'Linen', sku: 'RM-1',
    isFabric: true, unit: 'Mtr', cutWidth: 50, cutLength: 100, fabricWidthCm: 150,
    perUnit: 0, requiredPieces: 10, isReissue: false, storedRequiredQty: 10,
    issuedQty: 10, receivedQty: 10, pinLot: 'L1',
    issuedLots: [{ lot: 'L1', qty: 10, settled: 10, on: '', overrideFrom: '', note: '' }]
};
const lotItem = {
    planItemId: 'PIL', planId: 'P1', itemName: 'X', lineNo: 1, qtyOrdered: 10,
    qtyProduced: 0, status: '', hasBom: true, wasteIssued: [], materials: [oneLotMat]
};
ctx.DATA = { plans: [{ planId: 'P1', planNo: 'PL', items: [lotItem] }] };
ctx.LIVE = null;

const hOne = ctx.renderWasteStep(oneLotMat, lotItem, null);
check('single lot: bare "Rows" label', hOne.includes('>Rows<'));
check('single lot: no per-lot label', !hOne.includes('Rows off lot'));
check('single lot: no "Rows in total" summary', !hOne.includes('Rows in total'));

// Two lots that are each genuinely needed: L1 has 1m (1 row = 3 pieces), L2 has
// 2m (2 rows = 6), and the 10th piece has no lot to charge it to. Sizing matters
// here — a first lot big enough to finish the job means there is no second
// block, which is correct behaviour and not the case under test.
const twoLotMat = Object.assign({}, oneLotMat, {
    reqId: 'RL2',
    issuedLots: [
        { lot: 'L1', qty: 1, settled: 1, on: '', overrideFrom: '', note: '' },
        { lot: 'L2', qty: 2, settled: 2, on: '', overrideFrom: '', note: '' }
    ]
});
const twoLotItem = Object.assign({}, lotItem, { planItemId: 'PIL2', materials: [twoLotMat] });
ctx.DATA = { plans: [{ planId: 'P1', planNo: 'PL', items: [twoLotItem] }] };

const blocks = ctx.deriveWaste(twoLotMat, 10, []).fresh.blocks;
check('two lots: three blocks (L1, L2, unaccounted)', blocks.length === 3,
    JSON.stringify(blocks.map(b => b.lot + ':' + b.pieces)));
check('two lots: each block ends on a whole row',
    blocks.every(b => b.rows === b.fullRows + (b.lastRow > 0 ? 1 : 0)));

const hTwo = ctx.renderWasteStep(twoLotMat, twoLotItem, null);
check('two lots: per-lot labels appear', hTwo.includes('Rows off lot'));
check('two lots: names both L1 and L2', hTwo.includes('lot L1') && hTwo.includes('lot L2'));
check('two lots: "Rows in total" summary appears', hTwo.includes('Rows in total'));
check('two lots: unaccounted cloth charged to no lot', hTwo.includes('no lot recorded'));

// ---- the column glossary moved to title attributes ----
console.log('\nColumn glossary:');
const table = ctx.renderItemMaterials(partItem);
check('no repeated ans-legend paragraph', !table.includes('ans-legend'));
check('"Now needed" carries the false-alarm warning',
    /title="[^"]*meant to be lower[^"]*"[^>]*>Now needed/.test(table));
check('Planned/Stored/Check/Lot/From offcuts all carry titles',
    (table.match(/<th[^>]*title="/g) || []).length >= 6,
    'found ' + (table.match(/<th[^>]*title="/g) || []).length);

// =====================================================================
// THE VERDICT — findings collected across the whole order.
//
// The screen could always DETECT these; what it could not do was say so without
// the admin first picking the right order and opening the right chevron. These
// assert both halves: that every finding is raised, and — just as important —
// that a clean order raises none. A banner that cries wolf is worse than no
// banner, because it trains the admin to scroll past it.
// =====================================================================

function orderOf(mats, extra) {
    const item = Object.assign({
        planItemId: 'V1', planId: 'VP', itemName: 'Throw', lineNo: 1,
        qtyOrdered: 10, qtyProduced: 0, status: '', hasBom: true, wasteIssued: []
    }, extra || {});
    item.materials = mats;
    ctx.DATA = { plans: [{ planId: 'VP', planNo: 'PLAN-V', items: [item] }] };
    ctx.LIVE = null;
    ctx.MY_PLAN_IDS = ['VP'];
    return item;
}

// A fabric line where everything agrees: 3 per row, 10 pieces -> 4 rows -> 4m.
const cleanFab = {
    reqId: 'VF', materialId: 'VM', material: 'Linen', sku: 'RM-1', isFabric: true,
    unit: 'Mtr', cutWidth: 50, cutLength: 100, fabricWidthCm: 150, perUnit: 0,
    requiredPieces: 10, isReissue: false, storedRequiredQty: 4,
    issuedQty: 4, receivedQty: 4, pinLot: 'L1',
    issuedLots: [{ lot: 'L1', qty: 4, settled: 4, on: '', overrideFrom: '', note: '' }]
};
const cleanTrim = {
    reqId: 'VT', materialId: 'VMT', material: 'Thread', sku: 'RM-2', isFabric: false,
    unit: 'Cone', perUnit: 1.5, requiredPieces: 0, isReissue: false,
    storedRequiredQty: 15, issuedQty: 15, receivedQty: 15, pinLot: '', issuedLots: []
};

console.log('\nVerdict — a clean order:');
orderOf([JSON.parse(JSON.stringify(cleanFab)), JSON.parse(JSON.stringify(cleanTrim))]);
let f = ctx.collectFindings();
check('raises nothing', f.length === 0, JSON.stringify(f.map(x => x.kind)));
check('counts both lines', ctx.countLines() === 2);
let v = ctx.renderVerdict(f);
check('says all agree', v.includes('all agree'));
check('is the green verdict', v.includes('verdict-ok'));
check('names how many lines it checked', v.includes('2 material lines checked'));

console.log('\nVerdict — stored disagrees with the derivation:');
const badStored = JSON.parse(JSON.stringify(cleanFab));
badStored.storedRequiredQty = 3.2;          // derivation gives 4
orderOf([badStored]);
f = ctx.collectFindings();
check('one finding', f.length === 1, JSON.stringify(f.map(x => x.kind)));
check('kind is "stored"', f[0] && f[0].kind === 'stored');
check('level is bad', f[0] && f[0].level === 'bad');
check('detail carries both figures', f[0] && f[0].detail.includes('3.2') && f[0].detail.includes('4'));

console.log('\nVerdict — a REISSUE is exempt from that test:');
const reissue = JSON.parse(JSON.stringify(cleanFab));
reissue.storedRequiredQty = 3.2;
reissue.isReissue = true;
orderOf([reissue]);
check('raises nothing (costed from spoiled pieces, not the order)',
    ctx.collectFindings().length === 0);

console.log('\nVerdict — the trim BOM changed:');
const badTrim = JSON.parse(JSON.stringify(cleanTrim));
badTrim.storedRequiredQty = 12;             // 10 x 1.5 = 15
orderOf([badTrim]);
f = ctx.collectFindings();
check('one finding', f.length === 1);
check('mentions the BOM', f[0] && f[0].what.includes('BOM'));

console.log('\nVerdict — MIXED SHADE, the one that cannot be undone:');
const mixed = JSON.parse(JSON.stringify(cleanFab));
mixed.issuedLots = [
    { lot: 'L1', qty: 2, settled: 2, on: '', overrideFrom: '', note: '' },
    { lot: 'L2', qty: 2, settled: 2, on: '', overrideFrom: '', note: '' }
];
orderOf([mixed]);
f = ctx.collectFindings();
const mixedF = f.filter(x => x.kind === 'mixedlot');
check('mixed-lot raised', mixedF.length === 1, JSON.stringify(f.map(x => x.kind)));
check('names both lots', mixedF[0] && mixedF[0].detail.includes('L1') && mixedF[0].detail.includes('L2'));
check('says it cannot be undone', mixedF[0] && mixedF[0].detail.includes('cannot be undone'));
check('is bad, not a note', mixedF[0] && mixedF[0].level === 'bad');

console.log('\nVerdict — mixed shade reported ONCE, not once per material line:');
// The same fabric on two items of one order. orderLots answers the ORDER-level
// question, so calling it per line reported the same defect twice.
const m1 = JSON.parse(JSON.stringify(mixed));
const m2 = JSON.parse(JSON.stringify(mixed)); m2.reqId = 'VF2';
const twoItems = {
    plans: [{
        planId: 'VP', planNo: 'PLAN-V', items: [
            { planItemId: 'I1', planId: 'VP', itemName: 'A', lineNo: 1, qtyOrdered: 10,
              qtyProduced: 0, status: '', hasBom: true, wasteIssued: [], materials: [m1] },
            { planItemId: 'I2', planId: 'VP', itemName: 'B', lineNo: 2, qtyOrdered: 10,
              qtyProduced: 0, status: '', hasBom: true, wasteIssued: [], materials: [m2] }
        ]
    }]
};
ctx.DATA = twoItems; ctx.LIVE = null;
check('exactly one mixed-lot finding across both items',
    ctx.collectFindings().filter(x => x.kind === 'mixedlot').length === 1);

console.log('\nVerdict — a handover silently off-pin:');
const offPin = JSON.parse(JSON.stringify(cleanFab));
offPin.pinLot = 'L1';
offPin.issuedLots = [{ lot: 'L7', qty: 4, settled: 4, on: '', overrideFrom: '', note: '' }];
orderOf([offPin]);
f = ctx.collectFindings().filter(x => x.kind === 'pin');
check('raised', f.length === 1);
check('names both the lot used and the pin', f[0] && f[0].detail.includes('L7') && f[0].detail.includes('L1'));

console.log('\nVerdict — a RECORDED override is a note, not a fault:');
const over = JSON.parse(JSON.stringify(cleanFab));
over.issuedLots = [{ lot: 'L7', qty: 4, settled: 4, on: '', overrideFrom: 'L1', note: 'L1 ran out' }];
orderOf([over]);
f = ctx.collectFindings().filter(x => x.kind === 'override');
check('raised as a note', f.length === 1 && f[0].level === 'note');
check('carries the reason somebody gave', f[0] && f[0].detail.includes('L1 ran out'));
check('an override does NOT also raise a pin fault',
    ctx.collectFindings().filter(x => x.kind === 'pin').length === 0);
v = ctx.renderVerdict(ctx.collectFindings());
check('notes-only order says nothing is wrong', v.includes('nothing wrong'));
check('notes-only order is not the red banner', !v.includes('verdict-bad'));

console.log('\nVerdict — cloth out with no pin:');
const noPin = JSON.parse(JSON.stringify(cleanFab));
noPin.pinLot = '';
noPin.issuedLots = [];
noPin.issuedQty = 4;
orderOf([noPin]);
f = ctx.collectFindings().filter(x => x.kind === 'nopin');
check('raised', f.length === 1);
check('explains the consequence', f[0] && f[0].detail.includes('remake'));

console.log('\nVerdict — findings sort worst-first and link to their evidence:');
orderOf([JSON.parse(JSON.stringify(over)), badStored]);
f = ctx.collectFindings();
v = ctx.renderVerdict(f);
const firstBad = v.indexOf('vf-bad'), firstNote = v.indexOf('vf-note');
check('a bad finding is listed above a note', firstBad > -1 && firstBad < firstNote);
check('each finding carries a data-goto', (v.match(/data-goto="/g) || []).length === f.length);
check('data-goto is the requirement id', v.includes('data-goto="VF"') || v.includes('data-goto="' + badStored.reqId + '"'));

console.log('\nTrim rows: columns that cannot apply:');
orderOf([JSON.parse(JSON.stringify(cleanFab)), JSON.parse(JSON.stringify(cleanTrim))]);
const tbl = ctx.renderItemMaterials(ctx.DATA.plans[0].items[0]);
check('trim row is marked', tbl.includes('is-trim'));
check('Lot / From offcuts show "does not apply" on the trim',
    (tbl.match(/cell-na/g) || []).length === 2,
    'found ' + (tbl.match(/cell-na/g) || []).length);
check('fabric row keeps its real lot', tbl.includes('L1'));

console.log('\n"Now needed": nothing outstanding is a dash on BOTH kinds:');
// The bug: a fully-issued fabric row printed "—" while a fully-issued trim
// printed "0.000" in the same column.
const doneTrim = JSON.parse(JSON.stringify(cleanTrim));   // stored 15, issued 15
orderOf([doneTrim]);
const trimRow = ctx.renderItemMaterials(ctx.DATA.plans[0].items[0]);
check('settled trim shows a dash, not 0.000', !trimRow.includes('>0.000<'),
    'still rendering 0.000 in a Now-needed cell');

// =====================================================================
// THE WHOLE RENDER PATH — which items are open, and why.
//
// The pieces above are tested individually; this asserts the behaviour that
// actually reaches the screen. A clean order opens its first item (an entirely
// collapsed screen reads as a failure to load); a flagged order opens the item
// with the problem and leaves the clean ones shut, so the layout itself points
// at the thing to look at.
// =====================================================================
console.log('\nRender path — what opens:');

let renderedHtml = '';
const contentEl = {
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    querySelector: () => stubEl, querySelectorAll: () => [], addEventListener: noop,
    textContent: '', dataset: {}, hidden: false,
    set innerHTML(v) { renderedHtml = v; }, get innerHTML() { return renderedHtml; }
};
ctx.document.getElementById = function (id) { return id === 'content' ? contentEl : stubEl; };

function itemWith(id, name, mats) {
    return {
        planItemId: id, planId: 'P', itemName: name, lineNo: 1, qtyOrdered: 10,
        qtyProduced: 0, status: '', hasBom: true, wasteIssued: [], materials: mats
    };
}
function fabLine(over) {
    return Object.assign(JSON.parse(JSON.stringify(cleanFab)), { reqId: 'F1' }, over || {});
}

ctx.LIVE = null;
ctx.MY_PLAN_IDS = ['P'];

// A clean order of three items.
ctx.DATA = { plans: [{ planId: 'P', planNo: 'PL', status: 'In Progress', supervisor: 'S',
    items: [itemWith('A', 'Item A', [fabLine()]),
            itemWith('B', 'Item B', [fabLine({ reqId: 'F2' })]),
            itemWith('C', 'Item C', [fabLine({ reqId: 'F3' })])] }] };
ctx.render();
check('clean order: green verdict', renderedHtml.includes('verdict-ok'));
check('clean order: exactly one item open',
    (renderedHtml.match(/item-card open/g) || []).length === 1);
check('clean order: no finding badges', !renderedHtml.includes('item-finding-badge'));

// The same order with a finding on the LAST item only.
ctx.DATA = { plans: [{ planId: 'P', planNo: 'PL', status: 'In Progress', supervisor: 'S',
    items: [itemWith('A', 'Item A', [fabLine()]),
            itemWith('B', 'Item B', [fabLine({ reqId: 'F2' })]),
            itemWith('C', 'Item C', [fabLine({ reqId: 'F3', storedRequiredQty: 9.9 })])] }] };
ctx.render();
check('flagged order: red verdict', renderedHtml.includes('verdict-bad'));
check('flagged order: exactly one item open',
    (renderedHtml.match(/item-card open/g) || []).length === 1);
check('flagged order: the OPEN one is the flagged one (item C, not item A)',
    /item-card open has-bad" data-item="C"/.test(renderedHtml));
check('flagged order: clean items A and B stay shut',
    !/item-card open" data-item="A"/.test(renderedHtml) &&
    !/item-card open" data-item="B"/.test(renderedHtml));
check('flagged order: badge on the flagged card',
    renderedHtml.includes('item-finding-badge is-bad'));
check('flagged order: the finding links to the material that caused it',
    renderedHtml.includes('data-goto="F3"'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
