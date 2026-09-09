// Material accounting + the reason trail behind extra demand.
//
// Two things under test:
//   1. materialAccount / renderAccount — that an order's quantities BALANCE, and
//      that the screen says so instead of leaving it to be worked out by
//      subtracting cells.
//   2. ConsumptionDetail — that the four causes of extra demand stay separate,
//      and that the checker's own remarks reach the material they explain.
//
// ConsumptionDetail is exercised against a stubbed ZOHO.CREATOR.DATA.getRecords,
// so the shape of what it asks for and what it does with the answer are both
// asserted without an org.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}

// ---------------------------------------------------------------------------
// Fake getRecords. Returns rows per report name, and records what it was asked
// for so the criteria can be asserted.
// ---------------------------------------------------------------------------
const ASKED = [];
function makeZoho(tables) {
    return {
        CREATOR: {
            DATA: {
                getRecords: function (cfg) {
                    ASKED.push({ report: cfg.report_name, criteria: cfg.criteria || '' });
                    const rows = tables[cfg.report_name];
                    if (rows === undefined) {
                        // Creator signals "no such data" as an HTTP 400, which
                        // the module must treat as empty rather than fatal.
                        return Promise.reject({ code: 9280, message: 'No records found' });
                    }
                    return Promise.resolve({ data: rows });
                }
            }
        }
    };
}

function loadDetail(tables) {
    const code = fs.readFileSync(path.join(ROOT, 'app', 'admin', 'js', 'consumption-detail.js'), 'utf8');
    const ctx = { console: console, Promise: Promise, ZOHO: makeZoho(tables), JSON: JSON, Object: Object, Number: Number, String: String, isNaN: isNaN };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx.ConsumptionDetail;
}

function loadMain() {
    let code = fs.readFileSync(path.join(ROOT, 'app', 'admin', 'js', 'main.js'), 'utf8');
    const lines = code.split('\n');
    const cut = lines.findIndex(function (l) {
        return l.indexOf("document.querySelectorAll('.tab-btn')") === 0;
    });
    code = lines.slice(0, cut).join('\n');

    const noop = function () {};
    const el = {
        classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } },
        querySelector: function () { return el; }, querySelectorAll: function () { return []; },
        addEventListener: noop, textContent: '', innerHTML: '', dataset: {}, hidden: false
    };
    const ctx = {
        document: {
            getElementById: function () { return el; }, querySelector: function () { return el; },
            querySelectorAll: function () { return []; }, createElement: function () { return el; }
        },
        window: {}, console: console,
        ZOHO: { CREATOR: { DATA: { invokeCustomApi: function () { return { then: function () { return { catch: noop }; } }; } } } },
        ApiExperiment: { run: function () { return { then: function () { return { catch: noop }; } }; } },
        ConsumptionDetail: { CAUSE: {
            Reissue: { label: 'Material damaged', hint: '' },
            Check_Remake: { label: 'Rejected at checking', hint: '' },
            Production_Remake: { label: 'Lost in production', hint: '' },
            Alteration: { label: 'Alteration', hint: '' }
        } },
        applyLotAllocation: noop
    };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx;
}

// ===========================================================================
console.log('\nTHE ACCOUNT — do the quantities close?');
// ===========================================================================
const M = loadMain();

function mat(over) {
    const base = {
        materialId: 'M1', material: 'Linen', unit: 'Mtr', isFabric: true,
        planned: 10, reissued: 0, issued: 10, received: 10, lost: 0,
        spent: 10, variance: 0, cuttingAllowance: 0,
        damagedQty: 0, damagedPieces: 0, wasteKeptPieces: 0, wasteScrapPieces: 0,
        wasteAreaM2: 0, requiredPieces: 0, piecesFromRaw: 0, piecesFromWaste: 0,
        lostPieces: 0, reasons: []
    };
    Object.keys(over || {}).forEach(function (k) { base[k] = over[k]; });
    return base;
}

let a = M.materialAccount(mat());
check('a clean line balances', a.balanced === true);
check('spent agrees with issued + lost', a.spentAgrees === true);
check('demand is planned + extra', a.demand === 10);

a = M.materialAccount(mat({ issued: 14.6, received: 9, spent: 14.6 }));
check('in-transit detected', Math.abs(a.transit - 5.6) < 0.001, 'transit=' + a.transit);
check('does not balance while in transit', a.balanced === false);

a = M.materialAccount(mat({ planned: 10, reissued: 3, issued: 13, received: 13, spent: 13 }));
check('extra demand raises the total asked for', a.demand === 13);
check('issuing exactly the total is not an over-issue', Math.abs(a.overIssue) < 0.001);

a = M.materialAccount(mat({ issued: 11.5, received: 11.5, spent: 11.5 }));
check('over-issue measured against demand, not plan alone',
    Math.abs(a.overIssue - 1.5) < 0.001, 'overIssue=' + a.overIssue);

// The server defines spent = issued + lost. If the two ever diverge, one is
// wrong and the screen must say so rather than print both.
a = M.materialAccount(mat({ issued: 10, lost: 2, spent: 10 }));
check('a spent figure that contradicts issued+lost is caught', a.spentAgrees === false);

console.log('\nTHE ACCOUNT — what it renders:');
let html = M.renderAccount(mat());
check('says fully accounted for', html.indexOf('Fully accounted for') > -1);
check('is-ok verdict', html.indexOf('is-ok') > -1);

html = M.renderAccount(mat({ issued: 14.6, received: 9, spent: 14.6 }));
check('names the unconfirmed quantity', html.indexOf('5.6') > -1);
check('is-warn, not is-bad — nothing is wrong yet, it is on a trolley',
    html.indexOf('is-warn') > -1 && html.indexOf('is-bad') === -1);

html = M.renderAccount(mat({ planned: 10, reissued: 3, issued: 13, received: 13, spent: 13 }));
check('shows the raised-later line', html.indexOf('Raised later') > -1);
check('shows a total asked for', html.indexOf('Total asked for') > -1);

html = M.renderAccount(mat({ issued: 11.5, received: 11.5, spent: 11.5, cuttingAllowance: 1.5 }));
check('explains an over-issue as cutting allowance',
    html.indexOf('cutting allowance') > -1);

html = M.renderAccount(mat({ issued: 8, received: 8, spent: 8 }));
check('an under-issue says the order may run short',
    html.indexOf('run short') > -1);

// ===========================================================================
console.log('\nCONSUMPTION DETAIL — the four causes stay separate:');
// ===========================================================================
const REQS = 'Material_Requirement_Report';
const ITEMS = 'Plan_Item_Report';
// Item_Check is reported as `All_Items` in this org — confirmed, and not
// guessable: the name contains no "Check" at all, and it is one character off
// `All_items_Report`, which api-experiment.js uses for Raw_Material.
const CHECKS = 'All_Items';
const DAMAGE = 'Material_Damage_Report';

const tables = {};
tables[REQS] = [
    { ID: '1', Material: { ID: 'M1' }, Material_Name: 'Linen', Unit: 'Mtr',
      Source: 'Check_Remake', Required_Qty: 2.4, Plan_Item: { ID: 'PI-R1' },
      Reason: '12-Aug-2026 - Checking - rejected in round 2, remake' },
    { ID: '2', Material: { ID: 'M1' }, Material_Name: 'Linen', Unit: 'Mtr',
      Source: 'Production_Remake', Required_Qty: 1.1, Plan_Item: { ID: 'PI-R2' },
      Reason: 'Lost in production - Stitching 2, remake' },
    { ID: '3', Material: { ID: 'M2' }, Material_Name: 'Thread', Unit: 'Cone',
      Source: 'Alteration', Required_Qty: 3, Plan_Item: { ID: 'PI-R3' }, Reason: '' }
];
tables[ITEMS] = [
    { ID: 'PI-R1', Item_Name: 'Throw (remake)', Is_Remake: true,
      Remake_Reason: 'Check_Reject', Remake_Of: { ID: 'PI-ROOT' }, Item_Status: 'Awaiting_Material' },
    { ID: 'PI-R2', Item_Name: 'Throw (loss)', Is_Remake: true,
      Remake_Reason: 'Production_Loss', Remake_Of: { ID: 'PI-ROOT' }, Item_Status: 'Awaiting_Material' },
    { ID: 'PI-R3', Item_Name: 'Throw (alt)', Is_Remake: true,
      Remake_Reason: 'Alteration', Remake_Of: { ID: 'PI-ROOT' }, Item_Status: 'Ready_For_Production' },
    { ID: 'PI-ROOT', Item_Name: 'Linen Hamlet Throw', Is_Remake: false, Remake_Reason: '' }
];
tables[CHECKS] = [
    { ID: 'C1', Plan_Item: { ID: 'PI-ROOT' }, Round: 2, Check_Date: '12-Aug-2026',
      Qty_Inspected: 10, Qty_Approved: 7, Qty_Rejected: 2, Qty_Alteration: 1,
      Remarks: 'general note',
      Rejection_Remarks: 'Stitching puckered along the hem on two pieces',
      Alteration_Remarks: 'One piece needs the label re-set' }
];
tables[DAMAGE] = [
    { ID: 'D1', Plan_Item: { ID: 'PI-ROOT' }, Phase_Name: 'Cutting',
      Damage_Reason: 'Fabric flaw', Note: 'oil mark across the width',
      Supervisor: { display_value: 'Sanket' }, Reported_On: '10-Aug-2026' }
];

const CD = loadDetail(tables);

CD.run(['PLAN1']).then(function (out) {
    console.log('  (fetch complete)');

    // --- what it asked the server for ---
    const reqAsk = ASKED.filter(function (x) { return x.report === REQS; })[0];
    check('bounds the requirement query by plan', reqAsk && reqAsk.criteria.indexOf('Plan == PLAN1') > -1,
        reqAsk && reqAsk.criteria);
    check('asks ONLY for extra demand, not the plan rows',
        reqAsk && reqAsk.criteria.indexOf('Source != "Plan"') > -1, reqAsk && reqAsk.criteria);
    const chkAsk = ASKED.filter(function (x) { return x.report === CHECKS; })[0];
    check('bounds the check query by plan too', chkAsk && chkAsk.criteria.indexOf('Plan == PLAN1') > -1);

    // --- the causes ---
    const linen = out.byMaterial['M1'];
    check('linen bucket exists', !!linen);
    check('check-remake and production-remake kept SEPARATE',
        linen && Math.abs(linen.causes.Check_Remake - 2.4) < 0.001 &&
                 Math.abs(linen.causes.Production_Remake - 1.1) < 0.001,
        linen && JSON.stringify(linen.causes));
    check('they are not merged into one Reissue figure',
        linen && linen.causes.Reissue === undefined, linen && JSON.stringify(linen.causes));
    check('a second material keeps its own cause',
        out.byMaterial['M2'] && Math.abs(out.byMaterial['M2'].causes.Alteration - 3) < 0.001);
    check('order-level cause totals add up',
        Math.abs(out.causeTotals.Check_Remake - 2.4) < 0.001 &&
        Math.abs(out.causeTotals.Alteration - 3) < 0.001);

    // --- Material_Requirement.Reason, which nothing read before ---
    const cr = linen.events.filter(function (e) { return e.cause === 'Check_Remake'; })[0];
    check('carries the reason raiseReissueRequest wrote',
        cr && cr.reason.indexOf('rejected in round 2') > -1, cr && cr.reason);

    // --- THE CHECKER'S OWN WORDS, the thing that was unreachable ---
    check('the checker remark reaches the material it explains',
        cr && cr.checks.length === 1 &&
        cr.checks[0].remarks.indexOf('puckered') > -1,
        cr && JSON.stringify(cr.checks));
    check('it is found via Remake_Of — the remarks live on the ROOT item, not the remake',
        cr && cr.checks[0].round === 2);

    // A rejection remark must not be quoted against an alteration, or the screen
    // puts words in somebody's mouth about a different decision.
    const alt = out.byMaterial['M2'].events[0];
    check('an alteration quotes the ALTERATION remark, not the rejection one',
        alt && alt.checks.length === 1 &&
        alt.checks[0].remarks.indexOf('label re-set') > -1,
        alt && JSON.stringify(alt.checks));

    // --- damage ---
    check('the damage incident is attached', (out.damage || []).length === 1);
    check('damage carries stage, reason, note and who',
        out.damage[0].stage === 'Cutting' &&
        out.damage[0].reason === 'Fabric flaw' &&
        out.damage[0].note.indexOf('oil mark') > -1 &&
        out.damage[0].who === 'Sanket');

    check('no notes when every report resolved', (out.notes || []).length === 0,
        JSON.stringify(out.notes));

    // =======================================================================
    console.log('\nA WRONG REPORT NAME MUST NOT TAKE THE TAB DOWN:');
    // =======================================================================
    // Report link names cannot be verified from the repo — the convention is
    // <Form>_Report but api-experiment.js already carries two exceptions. So a
    // miss has to degrade to "quantities only", named, not to an error page.
    const broken = {};
    broken[REQS] = tables[REQS];
    broken[ITEMS] = tables[ITEMS];
    // CHECKS and DAMAGE deliberately absent -> the stub rejects them.
    const CD2 = loadDetail(broken);
    return CD2.run(['PLAN1']).then(function (o2) {
        check('still returns the causes it could read',
            o2.byMaterial['M1'] && Math.abs(o2.byMaterial['M1'].causes.Check_Remake - 2.4) < 0.001);
        check('a 9280 (no records) is NOT reported as an error',
            (o2.notes || []).length === 0,
            JSON.stringify(o2.notes));

        // A genuine failure (not 9280) must be named, not swallowed.
        const CD3 = (function () {
            const code = fs.readFileSync(path.join(ROOT, 'app', 'admin', 'js', 'consumption-detail.js'), 'utf8');
            const ctx = {
                console: console, Promise: Promise, JSON: JSON, Object: Object,
                Number: Number, String: String, isNaN: isNaN,
                ZOHO: { CREATOR: { DATA: { getRecords: function () {
                    return Promise.reject({ code: 4890, message: 'Report not found' });
                } } } }
            };
            vm.createContext(ctx);
            vm.runInContext(code, ctx);
            return ctx.ConsumptionDetail;
        })();
        return CD3.run(['PLAN1']).then(function (o3) {
            check('a real failure is reported as a note', (o3.notes || []).length > 0);
            check('the note names the FORM so it can be corrected',
                (o3.notes || []).join(' ').indexOf('reqs') > -1,
                JSON.stringify(o3.notes));
            check('and it still returns a usable empty result, not a throw',
                o3.byMaterial && Object.keys(o3.byMaterial).length === 0);

            // ===================================================================
            console.log('\nREPORT-NAME DISCOVERY:');
            // ===================================================================
            // The first guess at Item_Check was wrong in the real org, so the
            // names are probed rather than assumed. Two things must hold: a
            // wrong name moves on, and a RIGHT name that simply has no rows
            // must STOP the probe — otherwise a quiet order would send it
            // wandering down the candidate list and settle on a wrong name.
            ASKED.length = 0;
            const late = {};
            late[REQS] = tables[REQS];
            late[ITEMS] = tables[ITEMS];
            late[CHECKS] = tables[CHECKS];      // All_Items — 3rd-ish candidate
            late[DAMAGE] = tables[DAMAGE];
            const CD4 = loadDetail(late);

            return CD4.run(['PLAN1']).then(function (o4) {
                const checkAsks = ASKED.filter(function (x) {
                    return CD4.CANDIDATES.checks.indexOf(x.report) > -1;
                });
                check('probed until it found the real Item_Check report',
                    checkAsks.length >= 1 &&
                    checkAsks[checkAsks.length - 1].report === CHECKS,
                    JSON.stringify(checkAsks.map(function (x) { return x.report; })));
                check('resolved name is cached on RPT', CD4.RPT.checks === CHECKS,
                    JSON.stringify(CD4.RPT));
                check('the checker remarks came through after discovery',
                    o4.byMaterial['M1'] &&
                    o4.byMaterial['M1'].events.some(function (e) {
                        return (e.checks || []).some(function (c) {
                            return c.remarks.indexOf('puckered') > -1;
                        });
                    }));
                check('no notes once every form resolved', (o4.notes || []).length === 0,
                    JSON.stringify(o4.notes));

                // A report that EXISTS but matched nothing (9280) is the right
                // name. If the probe treated that as a miss it would walk past
                // the correct report on any quiet order.
                ASKED.length = 0;
                const quiet = {};
                quiet[REQS] = tables[REQS];
                quiet[ITEMS] = tables[ITEMS];
                quiet[CD4.CANDIDATES.checks[0]] = [];   // exists, zero rows
                quiet[DAMAGE] = [];
                const CD5 = loadDetail(quiet);

                return CD5.run(['PLAN1']).then(function (o5) {
                    check('an EMPTY-but-real report ends the probe on the first candidate',
                        CD5.RPT.checks === CD5.CANDIDATES.checks[0],
                        'settled on ' + CD5.RPT.checks);
                    const tries = ASKED.filter(function (x) {
                        return CD5.CANDIDATES.checks.indexOf(x.report) > -1;
                    });
                    check('and does not keep probing past it', tries.length === 1,
                        JSON.stringify(tries.map(function (x) { return x.report; })));
                    check('no spurious note for a genuinely quiet order',
                        (o5.notes || []).length === 0, JSON.stringify(o5.notes));

                    console.log('\n' + pass + ' passed, ' + fail + ' failed');
                    process.exit(fail ? 1 : 0);
                });
            });
        });
    });
}).catch(function (err) {
    console.log('  FAIL harness threw: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
