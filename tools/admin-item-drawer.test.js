// Item-level breakdown drawer (Production & Stock Dashboard).
//
// `order.items[]` is one PARENT per product name carrying `flows[]` (original /
// check_remake / production_loss / alteration), each at its own stage. The
// drawer renders the ORDER LINE as the parent row and each BATCH flow as a
// child row under a chevron. No stage-filter chips — kept deliberately lean.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'app', 'admin', 'anotherPage', 'js', 'main.js');
let code = fs.readFileSync(SRC, 'utf8');
const lines = code.split('\n');
const cut = lines.findIndex(function (l) {
    return l.indexOf("document.addEventListener('DOMContentLoaded'") === 0;
});
if (cut === -1) throw new Error('DOMContentLoaded anchor not found — file shape changed');
code = lines.slice(0, cut).join('\n');

const noop = function () {};
const ctx = {
    console: console, Math: Math, Number: Number, String: String, Boolean: Boolean,
    Array: Array, Object: Object, JSON: JSON, Date: Date, isNaN: isNaN,
    parseInt: parseInt, parseFloat: parseFloat, setTimeout: noop, clearTimeout: noop,
    document: {
        getElementById: function () { return null; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        createElement: function () { return { style: {} }; },
        addEventListener: noop
    },
    window: { location: { hostname: 'x' }, addEventListener: noop, scrollTo: noop },
    ZOHO: { CREATOR: { DATA: {} } },
    PipelineData: { parseDate: function () { return null; }, risk: function () { return []; } }
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

function flow(over) {
    return Object.assign({
        id: 'x', name: 'Fern Duvet Cover', sku: 'SKU-042', flowType: 'original', lineNo: 1,
        status: 'In_Production', qtyOrdered: 0, qtyProduced: 0, qtyAccepted: 0,
        qtyRejected: 0, qtyAltered: 0, stage: 'Stitching', stageStatus: 'Running',
        finishingComplete: false, checked: false, awaitingMaterial: false
    }, over || {});
}

// One name, four concurrent flows.
const order = {
    id: '900', salesOrder: 'SO-0900', status: 'In Progress', shortClosed: false,
    orderedQty: 12, producedQty: 10, rejectedQty: 3, remakeItems: 3,
    currentStage: 'Stitching', currentStageStatus: 'In_Progress',
    items: [{
        name: 'Fern Duvet Cover', itemName: 'Fern Duvet Cover', sku: 'SKU-042', lineNo: 1,
        qtyOrdered: 12, qtyProduced: 10, qtyAccepted: 8, qtyRejected: 3, qtyAltered: 1,
        hasRemake: true, hasLoss: true, hasAlteration: true,
        flows: [
            flow({ id: 'I6', flowType: 'original', qtyOrdered: 12, qtyProduced: 10,
                   qtyAccepted: 8, qtyRejected: 3, status: 'Complete', stage: 'Stitching', stageStatus: 'Done' }),
            flow({ id: 'I7', flowType: 'check_remake', qtyOrdered: 3, stage: 'Stitching', stageStatus: 'Running' }),
            flow({ id: 'I9', flowType: 'production_loss', qtyOrdered: 2, stage: '', stageStatus: 'Awaiting material',
                   status: 'Awaiting_Material', awaitingMaterial: true }),
            flow({ id: 'I8', flowType: 'alteration', qtyOrdered: 1, qtyAltered: 1, stage: 'Cutting', stageStatus: 'Running' })
        ]
    }]
};

console.log('\nCLEAN LAYOUT — no chips, SKU shown, chevron toggle:');
const html = ctx.renderItemDrawer(order, '');
check('NO stage-filter chips', html.indexOf('sub-stage-toolbar') === -1 && html.indexOf('drawer-stage-toolbar') === -1);
check('the item SKU is shown on the parent row',
    /drawer-sku">SKU-042</.test(html), html);
check('the toggle is a chevron, not "+" text',
    html.indexOf('drawer-chevron') !== -1 && html.indexOf('M9 5l7 7-7 7') !== -1);
check('no "+" / "-" glyph toggle', html.indexOf('drawer-batch-toggle') === -1);

console.log('\nPARENT = ORDER LINE, CHILDREN = BATCHES:');
check('parent headline numbers are the order line (ordered 12, produced 10)',
    /class="r">12</.test(html) && /class="r">10</.test(html));
check('parent accepted (8)', /class="r">8</.test(html));
check('parent rejected (3) highlighted', /lost-some">3</.test(html));
check('one child row PER BATCH — 3 (remake + loss + alteration), NOT the order line',
    (html.match(/drawer-flow-row/g) || []).length === 3,
    (html.match(/drawer-flow-row/g) || []).length + '');
check('remake batch labelled', html.indexOf('Remake (rejected)') !== -1);
check('production-loss batch labelled', html.indexOf('Lost in production') !== -1);
check('alteration batch labelled', html.indexOf('Alteration') !== -1);
check('no "Order line" child row (it is the parent)',
    (html.match(/Order line/g) || []).length === 0);

console.log('\nEACH FLOW ITS OWN STAGE:');
check('parent pill = the ORIGINAL flow ("checking passed")', /checking passed/i.test(html));
check('remake child at Stitching, running', /Stitching.*running/i.test(html));
check('alteration child at Cutting', /Cutting.*running/i.test(html));
check('production-loss child reads "awaiting material" (store not asked)',
    /awaiting material.*store not asked/i.test(html), html);

console.log('\nPRODUCTION LOSS FLAGGED ON THE PARENT NAME CELL:');
check('parent row has the has-loss class', /drawer-parent-row[^>]*has-loss/.test(html));

console.log('\nSHORT-CLOSED ORDER:');
const sc = JSON.parse(JSON.stringify(order));
sc.shortClosed = true;
sc.shortCloseReason = 'customer accepted 10 of 12';
const scHtml = ctx.renderItemDrawer(sc, '');
check('short-close banner shown', scHtml.indexOf('drawer-shortclose') !== -1);
check('reason shown', scHtml.indexOf('customer accepted 10 of 12') !== -1);
check('the loss flow now reads "not remade", not a stage',
    /short-closed.*not remade/i.test(scHtml));

console.log('\nA PLAIN LINE — one flow, no chevron, no children:');
const plain = {
    id: '1', salesOrder: 'SO-1', status: 'In Progress', orderedQty: 5, producedQty: 4,
    items: [{
        name: 'Napkin', itemName: 'Napkin', sku: 'SKU-011', lineNo: 1,
        qtyOrdered: 5, qtyProduced: 4, qtyAccepted: 0, qtyRejected: 0, qtyAltered: 0,
        hasRemake: false, hasLoss: false, hasAlteration: false,
        flows: [flow({ id: 'A', flowType: 'original', name: 'Napkin', sku: 'SKU-011',
                       qtyOrdered: 5, qtyProduced: 4, stage: 'Cutting', stageStatus: 'Running', status: 'In_Production' })]
    }]
};
const plainHtml = ctx.renderItemDrawer(plain, '');
check('a single-flow line has no chevron button', plainHtml.indexOf('drawer-chevron"') === -1 && plainHtml.indexOf('drawer-chevron ') === -1);
check('and no child flow rows', plainHtml.indexOf('drawer-flow-row') === -1);
check('its SKU still shows', /drawer-sku">SKU-011</.test(plainHtml));
check('its stage pill is on the parent row', plainHtml.indexOf('class="pill') !== -1);

console.log('\nNO ITEMS JOINED — the fallback summary:');
const bare = { id: '2', salesOrder: 'SO-2', status: 'In Progress', orderedQty: 8, producedQty: 3,
    currentStage: 'Cutting', itemName: 'Runner' };
const bareHtml = ctx.renderItemDrawer(bare, '');
check('shows order-level ordered/produced', bareHtml.indexOf('>8<') !== -1 && bareHtml.indexOf('>3<') !== -1);
check('names the line', bareHtml.indexOf('Runner') !== -1);

console.log('\nCOLLAPSED SALES-ORDER ROW — no batch pills:');
// renderInProgressOrdersBody builds those rows; check the row template through
// a light stub is heavy, so assert the source no longer emits the pills.
check('main.js no longer builds "lost in production" / "remake" / "alteration" pills on the SO row',
    code.indexOf("' lost in production</span>'") === -1 &&
    code.indexOf("nAlt + ' alteration'") === -1,
    'still present');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
