#!/usr/bin/env node
// postPrintAdjustments - the Zoho Inventory legs of a print job - ported to Node
// and run against a fake Inventory. The port mirrors deluge/postPrintAdjustments.dg
// block for block (same leg order, same guards, same status transitions), so a
// failure here names a real Deluge line.
//
//   OUT  send     source SKU   -Metres_Sent      <JobNo>-OUT
//   IN   receive  printed SKU  +Metres_Returned  <JobNo>-IN
//   RET  cancel   source SKU   +Metres_Sent      <JobNo>-RET
//
// What this pins: Inventory nets to exactly what Creator did, whatever order the
// failures come in - no double post after a crash, no RET for cloth Inventory
// never lost, no IN while the OUT is still owed.
//
//   usage: node tools/print-inventory.test.js

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const LOC = '3955559000000032097';
const ACC = '3955559000000032057';

// ---- fake Inventory ----------------------------------------------------------
function mkInv() {
    return {
        adjustments: [],          // what landed
        down: false,              // POST and GET both fail
        crashAfterPost: false,    // POST lands, then the script dies (uncatchable)
        seq: 900,
        post(body) {
            if (this.down) return { code: 1, message: 'unreachable' };
            this.seq += 1;
            this.adjustments.push(Object.assign({ id: String(this.seq) }, body));
            if (this.crashAfterPost) { this.crashAfterPost = false; throw new CrashError(); }
            return { code: 0, inventory_adjustment: { inventory_adjustment_id: String(this.seq) } };
        },
        get(ref) {
            if (this.down) return { code: 1 };
            return { code: 0, inventory_adjustments: this.adjustments.filter(a => a.reference_number === ref)
                .map(a => ({ reference_number: a.reference_number, inventory_adjustment_id: a.id })) };
        },
        onHand(item) {
            return Math.round(this.adjustments.filter(a => a.item === item)
                .reduce((t, a) => t + a.qty, 0) * 100) / 100;
        }
    };
}
function CrashError() { this.message = 'statement limit'; }

// ---- the world ---------------------------------------------------------------
function mkWorld() {
    return {
        inv: mkInv(),
        mats: {
            plain: { SKU: 'RM-PLAIN', Inventory_Item_ID: 'I-PLAIN' },
            printed: { SKU: 'RM-PRINT', Inventory_Item_ID: 'I-PRINT' }
        },
        jobs: {}
    };
}
function addJob(W, id, o) {
    W.jobs[id] = Object.assign({
        ID: id, Job_No: 'PJ-000' + id, Job_Status: 'At_Printer',
        Source_Material: 'plain', Printed_Material: 'printed',
        Metres_Sent: 20, Metres_Returned: 0,
        Inv_Out_Status: 'Pending', Inv_In_Status: '', Inv_Out_Doc_ID: '', Inv_In_Doc_ID: '', Inv_Last_Error: ''
    }, o);
    return W.jobs[id];
}

// ---- the port ----------------------------------------------------------------
function postPrintAdjustments(W, jobIdTxt, dryRun) {
    const writeAllowed = !['true', 'yes', '1'].includes(String(dryRun || '').trim().toLowerCase());
    let jobIds = [];
    if (jobIdTxt) jobIds.push(jobIdTxt);
    else {
        jobIds = Object.keys(W.jobs).filter(k => {
            const j = W.jobs[k];
            return ['Pending', 'Posting'].includes(j.Inv_Out_Status) || ['Pending', 'Posting'].includes(j.Inv_In_Status);
        }).sort((a, b) => Number(a) - Number(b)).slice(0, 20);
    }
    const out = [];
    for (const jid of jobIds) {
        const pj = W.jobs[jid];
        let jobErr = '';
        const found = !!pj;
        if (!found) jobErr = 'Print job not found';
        let jobNo = found ? String(pj.Job_No || '').trim() : '';
        if (jobNo === '') jobNo = 'PJ-' + jid;
        const jobStat = found ? pj.Job_Status : '';
        const mSent = found ? Number(pj.Metres_Sent) || 0 : 0;
        const mBack = found ? Number(pj.Metres_Returned) || 0 : 0;
        let outSt = found ? String(pj.Inv_Out_Status || '').trim() : '';
        let inSt = found ? String(pj.Inv_In_Status || '').trim() : '';
        if (outSt === '') outSt = 'Pending';
        const src = found ? W.mats[pj.Source_Material] || {} : {};
        const pr = found ? W.mats[pj.Printed_Material] || {} : {};
        let outDoc = '', inDoc = '';

        for (const legKey of ['OUT', 'IN']) {
            if (jobErr !== '') continue;
            let legSt = legKey === 'OUT' ? outSt : inSt;
            let legRef = jobNo + '-OUT', legItem = src.Inventory_Item_ID || '', legSku = src.SKU || '';
            let legQty = 0 - mSent, legRun = true;
            if (legKey === 'IN') {
                if (jobStat === 'Received') { legRef = jobNo + '-IN'; legItem = pr.Inventory_Item_ID || ''; legSku = pr.SKU || ''; legQty = mBack; }
                else if (jobStat === 'Cancelled') { legRef = jobNo + '-RET'; legQty = mSent; }
                else legRun = false;
            }
            if (legSt !== 'Pending' && legSt !== 'Posting') legRun = false;

            if (legRun && legSt === 'Posting') {
                const r = W.inv.get(legRef);
                if (r.code === 0) {
                    const hit = r.inventory_adjustments.filter(a => a.reference_number === legRef);
                    if (hit.length) { legSt = 'Posted'; if (legKey === 'OUT') outDoc = hit[0].inventory_adjustment_id; else inDoc = hit[0].inventory_adjustment_id; }
                    else legSt = 'Pending';
                } else {
                    jobErr = legRef + ' left at Posting and Inventory could not be asked whether it landed - try again later';
                    legRun = false;
                }
            }
            if (legRun && legKey === 'OUT' && legSt === 'Pending' && jobStat === 'Cancelled') { legSt = 'Not_Needed'; legRun = false; }
            if (legRun && legKey === 'IN' && outSt === 'Not_Needed') { legSt = 'Not_Needed'; legRun = false; }
            if (legRun && legKey === 'IN' && outSt !== 'Posted') legRun = false;

            if (legRun && legSt === 'Pending') {
                if (legQty === 0) legSt = 'Not_Needed';
                else if (legItem === '') jobErr = legSku + ' has no Zoho Inventory item mapped - ' + legRef + ' not posted';
                else if (writeAllowed) {
                    if (legKey === 'OUT') pj.Inv_Out_Status = 'Posting'; else pj.Inv_In_Status = 'Posting';
                    let postErr = '', postId = '';
                    let resp;
                    try {
                        resp = W.inv.post({ reference_number: legRef, item: legItem, qty: legQty,
                                            location_id: LOC, account_id: ACC });
                    } catch (e) {
                        if (e instanceof CrashError) throw e;       // NOT catchable in Deluge
                        postErr = 'invokeurl threw: ' + e.message;
                    }
                    if (!postErr) {
                        if (resp.code !== 0) postErr = 'code ' + resp.code + ': ' + resp.message;
                        else postId = resp.inventory_adjustment.inventory_adjustment_id;
                    }
                    if (!postErr) { legSt = 'Posted'; if (legKey === 'OUT') outDoc = postId; else inDoc = postId; }
                    else { legSt = 'Pending'; jobErr = legRef + ' refused by Inventory - ' + postErr; }
                }
            }
            if (legKey === 'OUT') outSt = legSt; else inSt = legSt;
        }

        if (writeAllowed && found) {
            pj.Inv_Out_Status = outSt;
            if (outDoc) pj.Inv_Out_Doc_ID = outDoc;
            if (inSt !== '') pj.Inv_In_Status = inSt;
            if (inDoc) pj.Inv_In_Doc_ID = inDoc;
            pj.Inv_Last_Error = jobErr;
        }
        out.push({ jobId: jid, out: outSt, in: inSt, error: jobErr });
    }
    return out;
}

// The writers' side, reduced to what they do to the job's Inventory fields.
function send(W, id, o) { addJob(W, id, o); return run(W, id); }
function receive(W, id, back) { Object.assign(W.jobs[id], { Job_Status: 'Received', Metres_Returned: back, Inv_In_Status: 'Pending' }); return run(W, id); }
function cancel(W, id) { Object.assign(W.jobs[id], { Job_Status: 'Cancelled', Inv_In_Status: 'Pending' }); return run(W, id); }
// The writers wrap the call in try/catch; a crash kills only the post.
function run(W, id) { try { return postPrintAdjustments(W, id, 'false'); } catch (e) { if (e instanceof CrashError) return 'crashed'; throw e; } }

// ---- tests -------------------------------------------------------------------
console.log('print inventory legs');

test('send posts -Metres_Sent on the SOURCE item at the store location, ref <JobNo>-OUT', () => {
    const W = mkWorld();
    send(W, '1', { Metres_Sent: 20 });
    assert.strictEqual(W.inv.adjustments.length, 1);
    const a = W.inv.adjustments[0];
    assert.deepStrictEqual([a.reference_number, a.item, a.qty, a.location_id, a.account_id],
        ['PJ-0001-OUT', 'I-PLAIN', -20, LOC, ACC]);
    assert.strictEqual(W.jobs['1'].Inv_Out_Status, 'Posted');
    assert.strictEqual(W.jobs['1'].Inv_Out_Doc_ID, a.id);
    assert.strictEqual(W.jobs['1'].Inv_In_Status, '', 'IN leg untouched while at the printer');
});

test('receive posts +Metres_Returned on the PRINTED item; the printer loss is the net', () => {
    const W = mkWorld();
    send(W, '1', { Metres_Sent: 20 });
    receive(W, '1', 17);
    assert.strictEqual(W.inv.onHand('I-PLAIN'), -20);
    assert.strictEqual(W.inv.onHand('I-PRINT'), 17);
    assert.strictEqual(W.inv.adjustments[1].reference_number, 'PJ-0001-IN');
    assert.strictEqual(W.jobs['1'].Inv_In_Status, 'Posted');
});

test('cancel after the OUT landed posts RET +Metres_Sent on the source - nets to zero', () => {
    const W = mkWorld();
    send(W, '1', { Metres_Sent: 20 });
    cancel(W, '1');
    assert.strictEqual(W.inv.onHand('I-PLAIN'), 0);
    assert.strictEqual(W.inv.adjustments[1].reference_number, 'PJ-0001-RET');
    assert.strictEqual(W.inv.onHand('I-PRINT'), 0);
});

test('cancel when the OUT never landed posts NOTHING and closes both legs Not_Needed', () => {
    const W = mkWorld();
    W.inv.down = true;
    send(W, '1', { Metres_Sent: 20 });
    assert.strictEqual(W.jobs['1'].Inv_Out_Status, 'Pending');
    W.inv.down = false;
    cancel(W, '1');
    assert.strictEqual(W.inv.adjustments.length, 0);
    assert.strictEqual(W.jobs['1'].Inv_Out_Status, 'Not_Needed');
    assert.strictEqual(W.jobs['1'].Inv_In_Status, 'Not_Needed');
});

test('OUT failed at send, then receive: OUT goes first, then IN - both land', () => {
    const W = mkWorld();
    W.inv.down = true;
    send(W, '1', { Metres_Sent: 20 });
    W.inv.down = false;
    receive(W, '1', 20);
    assert.deepStrictEqual(W.inv.adjustments.map(a => a.reference_number), ['PJ-0001-OUT', 'PJ-0001-IN']);
    assert.strictEqual(W.jobs['1'].Inv_Last_Error, '');
});

test('IN never posts while the OUT is still owed (Inventory down at receipt)', () => {
    const W = mkWorld();
    W.inv.down = true;
    send(W, '1');
    receive(W, '1', 20);
    assert.strictEqual(W.inv.adjustments.length, 0);
    assert.strictEqual(W.jobs['1'].Inv_In_Status, 'Pending');
    assert.ok(/PJ-0001-OUT refused/.test(W.jobs['1'].Inv_Last_Error));
    W.inv.down = false;
    postPrintAdjustments(W, '', 'false');                 // the sweep
    assert.strictEqual(W.inv.onHand('I-PLAIN'), -20);
    assert.strictEqual(W.inv.onHand('I-PRINT'), 20);
});

test('crash AFTER the POST landed: left at Posting, the next run finds it - no double post', () => {
    const W = mkWorld();
    W.inv.crashAfterPost = true;
    assert.strictEqual(send(W, '1', { Metres_Sent: 20 }), 'crashed');
    assert.strictEqual(W.jobs['1'].Inv_Out_Status, 'Posting');
    postPrintAdjustments(W, '', 'false');
    assert.strictEqual(W.inv.adjustments.length, 1, 'exactly one OUT in Inventory');
    assert.strictEqual(W.jobs['1'].Inv_Out_Status, 'Posted');
    assert.strictEqual(W.jobs['1'].Inv_Out_Doc_ID, W.inv.adjustments[0].id);
});

test('left at Posting but nothing landed: re-posted exactly once', () => {
    const W = mkWorld();
    addJob(W, '1', { Inv_Out_Status: 'Posting' });
    postPrintAdjustments(W, '', 'false');
    assert.strictEqual(W.inv.adjustments.length, 1);
    postPrintAdjustments(W, '', 'false');
    assert.strictEqual(W.inv.adjustments.length, 1);
});

test('Posting and Inventory unreachable: stays Posting, nothing posted, says why', () => {
    const W = mkWorld();
    addJob(W, '1', { Inv_Out_Status: 'Posting' });
    W.inv.down = true;
    postPrintAdjustments(W, '1', 'false');
    assert.strictEqual(W.jobs['1'].Inv_Out_Status, 'Posting');
    assert.ok(/could not be asked/.test(W.jobs['1'].Inv_Last_Error));
});

test('cancelled with OUT at Posting that DID land: marked Posted and the RET goes out', () => {
    const W = mkWorld();
    W.inv.crashAfterPost = true;
    send(W, '1', { Metres_Sent: 20 });
    cancel(W, '1');
    assert.strictEqual(W.inv.onHand('I-PLAIN'), 0);
    assert.strictEqual(W.inv.adjustments.length, 2);
});

test('unmapped printed SKU at receipt: IN stays Pending with the reason, OUT unaffected', () => {
    const W = mkWorld();
    send(W, '1');
    W.mats.printed.Inventory_Item_ID = '';
    receive(W, '1', 20);
    assert.strictEqual(W.jobs['1'].Inv_Out_Status, 'Posted');
    assert.strictEqual(W.jobs['1'].Inv_In_Status, 'Pending');
    assert.ok(/RM-PRINT has no Zoho Inventory item mapped/.test(W.jobs['1'].Inv_Last_Error));
    W.mats.printed.Inventory_Item_ID = 'I-PRINT';
    postPrintAdjustments(W, '', 'false');
    assert.strictEqual(W.inv.onHand('I-PRINT'), 20);
    assert.strictEqual(W.jobs['1'].Inv_Last_Error, '', 'error cleared once it posts');
});

test('legacy job (blank Inv_Out_Status) named at receipt gets its OUT and its IN', () => {
    const W = mkWorld();
    addJob(W, '1', { Inv_Out_Status: '', Job_No: '' });
    receive(W, '1', 18);
    assert.deepStrictEqual(W.inv.adjustments.map(a => a.reference_number), ['PJ-1-OUT', 'PJ-1-IN']);
});

test('sweep skips blank legs - a legacy job is never replayed by the schedule', () => {
    const W = mkWorld();
    addJob(W, '1', { Inv_Out_Status: '', Job_Status: 'Received', Metres_Returned: 20 });
    postPrintAdjustments(W, '', 'false');
    assert.strictEqual(W.inv.adjustments.length, 0);
});

test('running a finished job again posts nothing', () => {
    const W = mkWorld();
    send(W, '1');
    receive(W, '1', 20);
    run(W, '1'); run(W, '1');
    assert.strictEqual(W.inv.adjustments.length, 2);
});

test('dry run posts nothing and writes nothing', () => {
    const W = mkWorld();
    addJob(W, '1');
    const before = JSON.stringify(W.jobs);
    postPrintAdjustments(W, '1', 'true');
    assert.strictEqual(W.inv.adjustments.length, 0);
    assert.strictEqual(JSON.stringify(W.jobs), before);
});

// ---- the .dg files say what the port says ----------------------------------
const dg = f => fs.readFileSync(path.join(__dirname, '..', 'deluge', f), 'utf8');

test('postPrintAdjustments.dg: store location, one account, the three reference suffixes', () => {
    const s = dg('postPrintAdjustments.dg');
    assert.ok(s.includes('locStore = "' + LOC + '"'));
    assert.ok(s.includes('accId = "' + ACC + '"'));
    ['-OUT"', '-IN"', '-RET"'].forEach(x => assert.ok(s.includes('jobNo + "' + x), x));
    assert.ok(/pjMark\.Inv_Out_Status = "Posting"/.test(s), 'Posting written before the call');
});

test('sendToPrint.dg refuses an unmapped source or target before anything moves', () => {
    const s = dg('sendToPrint.dg');
    const refuse = s.indexOf('srcInvItem == ""');
    assert.ok(refuse > 0 && s.indexOf('tgtInvItem == ""') > 0);
    assert.ok(refuse < s.indexOf('MOVE THE LEDGER. Rolls first'), 'refusal precedes the ledger move');
    assert.ok(s.includes('Inv_Out_Status="Pending"'));
});

test('the three writers call postPrintAdjustments inside their own try, after the job is stamped', () => {
    ['sendToPrint.dg', 'receiveFromPrint.dg', 'cancelPrintJob.dg'].forEach(f => {
        const s = dg(f);
        const call = s.indexOf('thisapp.postPrintAdjustments(');
        assert.ok(call > 0, f);
        assert.ok(s.lastIndexOf('try', call) > s.indexOf('Job_Status') || f === 'sendToPrint.dg', f);
        assert.ok(s.includes('"inventoryError'), f + ' reports the inventory outcome');
    });
    ['receiveFromPrint.dg', 'cancelPrintJob.dg'].forEach(f =>
        assert.ok(dg(f).includes('Inv_In_Status = "Pending"'), f));
});

console.log('\nprint-inventory: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
