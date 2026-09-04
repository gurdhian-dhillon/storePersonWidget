/* =============================================================================
 * THROWAWAY TEST — does a Material_Issue form workflow fire on a JS-API insert,
 * and if so does it populate Voucher_No before we can read it back?
 *
 * Setup (Creator):
 *   1. Form workflow on Material_Issue, "on create":
 *        - if Voucher_No is empty -> compute next SIV-NNNNN and set it
 *        - ALSO set a marker field so "workflow fired" is provable even if the
 *          numbering logic has a bug. Suggested: Source_System = "WF_RAN".
 *   2. Nothing else. This script only inserts + re-reads.
 *
 * Use: a red "WF test" button, bottom-left. Click it, watch the console.
 *   - It inserts one Material_Issue via ZOHO.CREATOR.DATA.addRecords.
 *   - Then re-reads that row 6 times (0.5s, 1s, 2s, 4s, 7s, 12s) and logs
 *     Voucher_No + the marker each time.
 *   - So you see: did the workflow run at all, and how long until the number
 *     is visible to a getRecords read.
 *
 * The row it creates is junk — delete it in Creator after. It carries
 * Issue_Status "WF_TEST" so it is easy to find.
 *
 * REMOVE AFTER THE TEST: delete this file and its <script> tag in widget.html.
 * ========================================================================== */
(function () {
    'use strict';

    var REPORT = 'Material_Issue_Report';   // adjust if the read fails
    var FORM = 'Material_Issue';             // form link name for addRecords
    var READ_DELAYS_MS = [500, 1000, 2000, 4000, 7000, 12000];

    function have() {
        return typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
            typeof ZOHO.CREATOR.DATA.addRecords === 'function' &&
            typeof ZOHO.CREATOR.DATA.getRecords === 'function';
    }

    function log() {
        var a = ['%c[wf-test]', 'color:#dc2626;font-weight:bold'];
        for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
        console.log.apply(console, a);
    }

    function readBack(recordId, attempt) {
        if (attempt >= READ_DELAYS_MS.length) {
            log('done re-reading. If Voucher_No was still empty above, either the '
                + 'workflow did not fire on a JS-API insert, or its numbering '
                + 'condition did not match. Check the marker field.');
            return;
        }
        setTimeout(function () {
            ZOHO.CREATOR.DATA.getRecords({
                report_name: REPORT,
                field_config: 'all',
                criteria: 'ID == ' + recordId,
                max_records: 200
            }).then(function (resp) {
                var row = (resp && (resp.data || resp.records) || [])[0] || {};
                log('read #' + (attempt + 1)
                    + ' (' + READ_DELAYS_MS[attempt] + 'ms)  '
                    + 'Voucher_No=' + JSON.stringify(row.Voucher_No)
                    + '  Source_System=' + JSON.stringify(row.Source_System)
                    + '  Issue_Status=' + JSON.stringify(row.Issue_Status));
                readBack(recordId, attempt + 1);
            }).catch(function (err) {
                log('read #' + (attempt + 1) + ' FAILED', err);
                readBack(recordId, attempt + 1);
            });
        }, READ_DELAYS_MS[attempt] - (attempt > 0 ? READ_DELAYS_MS[attempt - 1] : 0));
    }

    // Try payloads from richest to barest — the form may reject a Dropdown
    // value or a lookup, and we just want ANY row created so the workflow can
    // be observed. Whatever lands, lands.
    var PAYLOADS = [
        { Issue_Status: 'Issued', Issue_Date: new Date().toISOString().slice(0, 10) },
        { Issue_Date: new Date().toISOString().slice(0, 10) },
        { Issue_Status: 'Issued' },
        {}
    ];

    function digId(resp) {
        // ZOHO.CREATOR.DATA.addRecords response shapes seen in the wild:
        //   { code, data: { ID } }
        //   { code, data: [ { code, data: { ID } } ] }
        //   { result: [ { code, data: { ID } } ] }
        var candidates = [resp];
        if (resp) {
            candidates.push(resp.data, resp.result);
            if (Array.isArray(resp.data)) candidates.push(resp.data[0]);
            if (Array.isArray(resp.result)) candidates.push(resp.result[0]);
            if (resp.data && resp.data.data) candidates.push(resp.data.data);
            if (Array.isArray(resp.data) && resp.data[0]) candidates.push(resp.data[0].data);
        }
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (c && (c.ID || c.id)) return String(c.ID || c.id);
        }
        return '';
    }

    function tryInsert(idx) {
        if (idx >= PAYLOADS.length) {
            log('every payload variant was rejected — see the errors above. '
                + 'Tell me which fields are mandatory on Material_Issue.');
            return;
        }
        log('addRecords attempt ' + (idx + 1) + ' with data =', PAYLOADS[idx]);
        ZOHO.CREATOR.DATA.addRecords({
            form_name: FORM,
            payload: { data: PAYLOADS[idx] }
        }).then(function (resp) {
            log('addRecords response (attempt ' + (idx + 1) + '):', resp);
            if (resp && resp.code && resp.code !== 3000 && resp.code !== 0) {
                log('  -> rejected (code ' + resp.code + '), trying a barer payload');
                tryInsert(idx + 1);
                return;
            }
            var id = digId(resp);
            if (!id) {
                log('  -> no error, but could not find the new record id. '
                    + 'Full response logged above — read the newest Material_Issue '
                    + 'row manually and check its Voucher_No.');
                return;
            }
            log('new Material_Issue id = ' + id + '  — re-reading to watch for Voucher_No');
            readBack(id, 0);
        }).catch(function (err) {
            log('addRecords attempt ' + (idx + 1) + ' FAILED', err);
            tryInsert(idx + 1);
        });
    }

    function runTest() {
        if (!have()) {
            log('ZOHO.CREATOR.DATA.addRecords / getRecords not available');
            return;
        }
        log('inserting one Material_Issue via addRecords (Voucher_No left unset)…');
        tryInsert(0);
    }

    function mountButton() {
        if (document.getElementById('wf-test-btn')) return;
        var b = document.createElement('button');
        b.id = 'wf-test-btn';
        b.type = 'button';
        b.textContent = 'WF test';
        b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;'
            + 'background:#dc2626;color:#fff;border:0;border-radius:6px;'
            + 'padding:8px 12px;font:600 12px/1 Inter,sans-serif;cursor:pointer;'
            + 'box-shadow:0 2px 8px rgba(0,0,0,.25)';
        b.addEventListener('click', function () {
            b.disabled = true;
            b.textContent = 'testing… (see console)';
            runTest();
            setTimeout(function () {
                b.disabled = false;
                b.textContent = 'WF test';
            }, 15000);
        });
        document.body.appendChild(b);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountButton);
    } else {
        mountButton();
    }
})();
