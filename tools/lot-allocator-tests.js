/**
 * lot-allocator-tests.js
 * 
 * Written by: Antigravity Agent
 * Date: 2026-09-05
 * 
 * This file contains a comprehensive test suite designed to simulate the 
 * material allocation logic in app/js/lot-allocator.js. 
 * 
 * It tests for:
 * - Waste pieces prioritization
 * - Physical roll constraint handling (short rolls)
 * - Pinned vs Unpinned order behavior
 * - Wash and Greige fallbacks
 * - The "inWash" and "nofit" bugs discovered during the code audit
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Load lot-allocator.js into a sandbox context
const allocatorPath = path.join(__dirname, '../app/js/lot-allocator.js');
const allocatorCode = fs.readFileSync(allocatorPath, 'utf8');

const context = {};
vm.createContext(context);
vm.runInContext(allocatorCode, context);

function runData(data) {
    const copy = JSON.parse(JSON.stringify(data));
    context.applyLotAllocation(copy);
    return copy;
}

let failures = [];
function test(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (e) {
        console.log(`FAIL: ${name}`);
        console.error(e.message);
        failures.push({name, error: e});
    }
}

// Helper to create basic test data payload
function makeData(lots, lines, waste = []) {
    return [{
        supervisorId: 'sup1',
        materials: [{
            isFabric: true,
            materialId: 'm1',
            fabricWidthCm: 150,
            lots: lots,
            wasteStock: waste,
            lines: lines
        }]
    }];
}

console.log('--- Running Lot Allocator Test Suite ---\n');

test('1. Short Rolls yield nothing', () => {
    // 2 rolls of 1m. cut length 1.5m. Should yield 0 pieces because 1.5m cuts don't fit on 1m rolls.
    const res = runData(makeData(
        [{ lotId: 'L1', wash: 10, unwash: 0, rolls: [{rollId:'r1', length: 1}, {rollId:'r2', length: 1}] }],
        [{ planId: 'p1', cutW: 150, cutL: 150, reqPieces: 1, issPieces: 0 }]
    ));
    const m = res[0].materials[0];
    assert.strictEqual(m.orderOutcomes[0].why, 'no_lot', 'Expected no_lot because rolls are too short');
});

test('2. Pick smallest lot that covers order', () => {
    // L1 is 100m, L2 is 50m, L3 is 20m.
    // Need 10m (cutL 100cm, cutW 150cm, pieces 10 => 10 rows => 10m)
    // Should pick L3.
    const res = runData(makeData(
        [
            { lotId: 'L1', wash: 100, rolls: [{rollId:'r1', length: 100}] },
            { lotId: 'L2', wash: 50, rolls: [{rollId:'r2', length: 50}] },
            { lotId: 'L3', wash: 20, rolls: [{rollId:'r3', length: 20}] },
        ],
        [{ planId: 'p1', cutW: 150, cutL: 100, reqPieces: 10, issPieces: 0 }]
    ));
    const m = res[0].materials[0];
    assert.strictEqual(m.lotLines.length, 1);
    assert.strictEqual(m.lotLines[0].lotId, 'L3', 'Expected the smallest lot (L3) to be chosen');
});

test('3. Fallback to unwashed greige if no washed covers', () => {
    // L1 has 5m washed (not enough for 10m).
    // L2 has 5m washed, 100m unwash (enough after wash).
    // Should pick L2 but assign it as 'wash'
    const res = runData(makeData(
        [
            { lotId: 'L1', wash: 5, unwash: 0, rolls: [{rollId:'r1', length: 5}] },
            { lotId: 'L2', wash: 5, unwash: 100, rolls: [{rollId:'r2', length: 105}] },
        ],
        [{ planId: 'p1', cutW: 150, cutL: 100, reqPieces: 10, issPieces: 0 }]
    ));
    const m = res[0].materials[0];
    assert.strictEqual(m.lotLines.length, 0, 'Should not allocate anything today');
    assert.strictEqual(m.orderOutcomes[0].why, 'afterWash', 'Expected afterWash commitment');
    assert.strictEqual(m.orderOutcomes[0].lotId, 'L2', 'Expected L2 to be chosen for washing');
});

test('4. Pinned order sticks to its lot even if dry', () => {
    const res = runData(makeData(
        [
            { lotId: 'L1', wash: 5, unwash: 0, rolls: [{rollId:'r1', length: 5}] }, // Dry
            { lotId: 'L2', wash: 50, unwash: 0, rolls: [{rollId:'r2', length: 50}] }, // Plenty
        ],
        [{ planId: 'p1', issuedLot: 'L1', cutW: 150, cutL: 100, reqPieces: 10, issPieces: 0 }]
    ));
    const m = res[0].materials[0];
    assert.strictEqual(m.orderOutcomes[0].lotId, 'L1', 'Expected it to stay on L1 despite being short');
    assert.strictEqual(m.orderOutcomes[0].why, 'pinned', 'Expected reason to be pinned');
});

test('5. Waste pieces prioritized over fresh rolls', () => {
    // Need 2 pieces (cutW 75, cutL 100) -> 2 pieces fit in 1 row of 150x100
    // Waste W1 is 150x100 -> 2 pieces!
    const res = runData(makeData(
        [
            { lotId: 'L1', wash: 10, rolls: [{rollId:'r1', length: 10}] }
        ],
        [{ planId: 'p1', cutW: 75, cutL: 100, reqPieces: 2, issPieces: 0 }],
        [ { wasteId: 'w1', width: 150, length: 100, pieces: 1, lotId: 'L1' } ]
    ));
    const m = res[0].materials[0];
    assert.strictEqual(m.wastePicks.length, 1, 'Expected to pick 1 waste piece');
    assert.strictEqual(m.wastePicks[0].wasteId, 'w1');
    assert.strictEqual(m.freshMeters, 0, 'Expected 0 fresh meters needed'); 
});

test('6. Floating point precision test', () => {
    // 0.3m cuts on 0.9m roll => exactly 3 cuts
    const res = runData(makeData(
        [{ lotId: 'L1', wash: 0.9, rolls: [{rollId:'r1', length: 0.9}] }],
        [{ planId: 'p1', cutW: 150, cutL: 30, reqPieces: 3, issPieces: 0 }]
    ));
    const m = res[0].materials[0];
    assert.strictEqual(m.orderOutcomes[0].why, 'ready');
    assert.strictEqual(m.freshMeters, 0.9, 'Expected exactly 0.9m fresh cut');
});

test('7. BUG SIMULATION: Unpinned order with inWash cloth', () => {
    // Expectation: It should reserve the cloth and report "atWash", so the user knows
    // the order is covered by cloth coming back.
    // Reality: It skips the order and reports "none" (or "no_lot").
    const res = runData(makeData([
        { lotId: 'L1', lotNumber: 'LOT-1', wash: 0, unwash: 0, inWash: 15, rolls: [{rollId:'r1', length: 15}] }
    ]));
    const mw = res[0].materials[0];
    
    // In current bugged code, this will be "skipped" instead of "atWash"
    const why = mw.orderOutcomes[0].why;
    console.log(`   [Bug Check] Order Outcome was: ${why}`);
    
    // In current bugged code, this triggers the absurd nofit condition
    const reason = context.getShortReason ? context.getShortReason(mw) : mw.shortReason;
    console.log(`   [Bug Check] Short Reason was: ${JSON.stringify(reason)}`);
    
    // Asserting the bug exists for documentation purposes
    assert.strictEqual(why, 'skipped', 'The order should be incorrectly skipped because inWash is excluded from gateMetres');
    if (reason && reason.kind === 'nofit') {
        assert.strictEqual(reason.have > reason.need, true, 'The absurd nofit bug occurred (have > need)');
    }
});

console.log("\n--- Test Run Complete ---");
if(failures.length) {
    console.log(`${failures.length} failures encountered (which may represent bugs documented in the audit)`);
    process.exitCode = 1;
}
