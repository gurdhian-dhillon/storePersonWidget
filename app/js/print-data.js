/* =============================================================================
 * PRINT TAB — read side, via the Creator JS Data API (getRecords) instead of a
 * custom function. Replaces getPrintData.dg.
 *
 * Same technique as app/js/api-experiment.js: getRecords with cursor paging, a
 * "no records" HTTP 400 folded into an empty result, and every value coerced
 * before it is trusted. Self-contained — it does not depend on api-experiment.js
 * being loaded first.
 *
 * PrintData.load() -> Promise of:
 *
 *   { source:  [ { id, name, sku, type, widthCm,
 *                  lots: [ { lotId, lotNumber, wash, unwash, inPrint, blocked,
 *                            rolls: [ { rollId, label, length, status, origin } ] } ] } ],
 *     target:  [ same shape ],        // Type_field ~ "printed fabric"
 *     printers:[ { id, name } ],
 *     jobs:    [ { jobId, sourceMaterialId, sourceName, sourceSku,
 *                  sourceLotId, sourceLotNumber,
 *                  printedMaterialId, printedName, printedSku,
 *                  printerName, sourceState, metresSent, sentOn, jobStatus,
 *                  sendLines: [ { lineIndex, lengthCm, count } ] } ] }
 *
 * NO minting, NO Print_Base, NO pattern, NO Fabric_Piece — printed stock is
 * ordinary short rolls (Lot_Rolls, Origin "Printed"). See docs/printing-v2-plan.md.
 * ========================================================================== */

var PrintData = (function () {
    'use strict';

    // Report link names. Adjust here if getRecords throws "<name>: ...".
    var RPT = {
        rawMat: 'All_items_Report',
        lots: 'All_Material_Lots',
        printers: 'Third_Party_Report',
        jobs: 'Print_Job_Report'
    };

    // Type_field value that marks a fabric as printed. Compared
    // case-insensitively, so "printed fabric" and "Printed Fabric" both match.
    var PRINTED_TYPE = 'printed fabric';

    function have() {
        return typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
            typeof ZOHO.CREATOR.DATA.getRecords === 'function';
    }

    // ---- getRecords with cursor paging (mirrors api-experiment.js) --------
    function getAll(reportName, criteria) {
        return new Promise(function (resolve, reject) {
            var rows = [];

            function isNoRecords(err) {
                if (!err) return false;
                var s = '';
                try { s = JSON.stringify(err); } catch (e) { s = String(err); }
                s = (s + ' ' + (err.message || '') + ' ' + (err.responseText || '') +
                    ' ' + (err.responseJSON ? JSON.stringify(err.responseJSON) : '')).toLowerCase();
                var code = err.code;
                if (code == null && err.responseJSON) code = err.responseJSON.code;
                return code === 9280 || code === 9220 || code === 3100 ||
                    s.indexOf('9280') !== -1 || s.indexOf('9220') !== -1 ||
                    s.indexOf('no records found') !== -1 ||
                    s.indexOf('no records exist') !== -1 ||
                    s.indexOf('no data available') !== -1;
            }

            function page(cursor) {
                var cfg = { report_name: reportName, field_config: 'all', max_records: 1000 };
                if (criteria) cfg.criteria = criteria;
                if (cursor) cfg.record_cursor = cursor;
                ZOHO.CREATOR.DATA.getRecords(cfg).then(function (resp) {
                    var data = (resp && (resp.data || resp.records)) || [];
                    for (var i = 0; i < data.length; i++) rows.push(data[i]);
                    var next = resp && (resp.record_cursor || resp.cursor);
                    if (next && data.length > 0) page(next);
                    else resolve(rows);
                }).catch(function (err) {
                    if (isNoRecords(err)) { resolve(rows); return; }
                    reject(new Error(reportName + ': ' +
                        (err && err.message ? err.message : JSON.stringify(err))));
                });
            }
            page(null);
        });
    }

    // ---- value coercion (mirrors api-experiment.js) ----------------------
    // A subform field can come back wrapped ({value:x} / {display_value:x}),
    // so unwrap before coercing — otherwise Number({value:"500"}) is NaN -> 0.
    function unwrap(v) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if ('value' in v) return v.value;
            if ('display_value' in v) return v.display_value;
        }
        return v;
    }
    function num(v) { var n = Number(unwrap(v)); return isNaN(n) ? 0 : n; }
    function str(v) { var u = unwrap(v); return u == null ? '' : String(u); }
    function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

    function lookupId(v) {
        if (v == null) return '';
        if (typeof v === 'object') return String(v.ID || v.id || '');
        return String(v);
    }
    function lookupText(v, field) {
        if (v == null) return '';
        if (typeof v === 'object') return String(v[field] || v.zc_display_value || '');
        return String(v);
    }
    function truthy(v) {
        var s = String(v == null ? '' : v).trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'yes' || s === 'y';
    }

    // Creator returns a subform nested in the parent record ONLY when the
    // subform is a column in the report layout (field_config:'all'). It may come
    // back as a bare array, or wrapped ({value:[...]} / {display_value:[...]}),
    // and occasionally under a near-miss key. Probe all of it so a layout quirk
    // does not silently empty the list — api-experiment.js does the same.
    function subform(rec, name) {
        var alts = [name, name.replace(/s$/, ''), name.replace(/_/g, ''), name + 's'];
        for (var i = 0; i < alts.length; i++) {
            var v = rec[alts[i]];
            if (Array.isArray(v)) return v;
            if (v && Array.isArray(v.value)) return v.value;
            if (v && Array.isArray(v.display_value)) return v.display_value;
        }
        return [];
    }

    // A lot column that was never written comes back empty, not 0.
    function qty(v) { return r2(num(v)); }

    // ---- assembly -------------------------------------------------------
    function assemble(rawMats, lots, printers, jobs) {
        // Roll rows of a lot — the Lot_Rolls subform, nested in the parent
        // record (field_config 'all'). Blocked / Consumed / zero-length rolls
        // are dropped from what the cut planner can use, but ALL rolls are
        // returned for display so the screen can show a blocked one.
        function readRolls(l) {
            var raw = subform(l, 'Lot_Rolls');
            var out = [];
            raw.forEach(function (rr) {
                var status = str(rr.Roll_Status).trim() || 'Available';
                out.push({
                    rollId: String(rr.ID),
                    label: str(rr.Roll_Label).trim(),
                    length: qty(rr.Roll_Length),
                    status: status,
                    origin: str(rr.Origin).trim() || 'Purchased'
                });
            });
            return out;
        }

        // Raw_Material_Lot grouped by material id, and a lotId -> lotNumber map
        // (built over EVERY lot, before any filter, so a job can still name a
        // lot that has since left the rack).
        var lotsByMat = {};
        var lotNumById = {};
        lots.forEach(function (l) {
            var matId = lookupId(l.Material);
            lotNumById[String(l.ID)] = str(l.Lot_Number).trim();
            if (!matId) return;
            (lotsByMat[matId] = lotsByMat[matId] || []).push({
                lotId: String(l.ID),
                lotNumber: str(l.Lot_Number).trim(),
                wash: qty(l.Wash_Quantity),
                unwash: qty(l.Unwash_Quantity),
                inPrint: qty(l.In_Print_Qty),
                blocked: str(l.Status).trim() === 'Blocked',
                rolls: readRolls(l)
            });
        });

        // Raw_Material — every fabric with at least one lot. type carries the
        // raw Type_field; the widget splits source vs target on it.
        var matNameById = {};
        var matSkuById = {};
        var source = [];
        var target = [];
        rawMats.forEach(function (rm) {
            var id = String(rm.ID);
            var name = str(rm.Material_Display_Name).trim() || str(rm.Name).trim();
            var sku = str(rm.SKU).trim();
            matNameById[id] = name;
            matSkuById[id] = sku;

            if (!truthy(rm.Is_Fabric)) return;
            var lotsHere = lotsByMat[id] || [];
            var typeRaw = str(rm.Type_field).trim();
            var entry = {
                id: id,
                name: name,
                sku: sku,
                type: typeRaw,
                widthCm: r2(num(rm.Fabric_Width_Inches) * 2.54),
                lots: lotsHere
            };
            // Source list: any fabric that has cloth in a lot. Target list:
            // printed fabric (by Type_field), regardless of whether it has
            // stock yet — a fresh printed SKU is a valid receive target.
            if (lotsHere.length > 0) source.push(entry);
            if (typeRaw.toLowerCase() === PRINTED_TYPE) target.push(entry);
        });

        source.sort(function (a, b) { return a.name.localeCompare(b.name); });
        target.sort(function (a, b) { return a.name.localeCompare(b.name); });

        // Printers.
        var partyNameById = {};
        var printerList = [];
        printers.forEach(function (tp) {
            var id = String(tp.ID);
            var nm = str(tp.Party_Name).trim();
            partyNameById[id] = nm;
            printerList.push({ id: id, name: nm });
        });
        printerList.sort(function (a, b) { return a.name.localeCompare(b.name); });

        // Jobs still at the printer. Send_Lines nested in the record.
        var jobList = [];
        jobs.forEach(function (pj) {
            if (str(pj.Job_Status).trim() !== 'At_Printer') return;

            var srcMatId = lookupId(pj.Source_Material);
            var srcLotId = lookupId(pj.Source_Lot);
            var prMatId = lookupId(pj.Printed_Material);
            var prnId = lookupId(pj.Printer);

            var slRaw = subform(pj, 'Send_Lines');
            if (!slRaw.length) {
                console.warn('[print-data] job ' + pj.ID + ' has no Send_Lines subform in the ' +
                    'report payload. Keys present:', Object.keys(pj).sort().join(', '));
            }
            var sendLines = [];
            slRaw.forEach(function (sl, i) {
                sendLines.push({
                    lineIndex: i,
                    lengthCm: qty(sl.Piece_Length_Cm),
                    count: num(sl.Piece_Count)
                });
            });

            jobList.push({
                jobId: String(pj.ID),
                sourceMaterialId: srcMatId,
                sourceName: matNameById[srcMatId] || lookupText(pj.Source_Material, 'Material_Display_Name'),
                sourceSku: matSkuById[srcMatId] || '',
                sourceLotId: srcLotId,
                sourceLotNumber: lotNumById[srcLotId] || lookupText(pj.Source_Lot, 'Lot_Number'),
                printedMaterialId: prMatId,
                printedName: matNameById[prMatId] || lookupText(pj.Printed_Material, 'Material_Display_Name'),
                printedSku: matSkuById[prMatId] || '',
                printerName: partyNameById[prnId] || lookupText(pj.Printer, 'Party_Name'),
                sourceState: str(pj.Source_State).trim(),
                metresSent: qty(pj.Metres_Sent),
                sentOn: pj.Sent_On ? String(pj.Sent_On) : '',
                jobStatus: str(pj.Job_Status).trim(),
                sendLines: sendLines
            });
        });

        return {
            source: source,
            target: target,
            printers: printerList,
            jobs: jobList
        };
    }

    function load() {
        if (!have()) {
            return Promise.reject(new Error('ZOHO.CREATOR.DATA.getRecords is not available'));
        }
        return Promise.all([
            getAll(RPT.rawMat),
            getAll(RPT.lots),
            getAll(RPT.printers),
            getAll(RPT.jobs)
        ]).then(function (r) {
            return assemble(r[0], r[1], r[2], r[3]);
        });
    }

    return {
        load: load,
        // exposed for tests
        _assemble: assemble,
        PRINTED_TYPE: PRINTED_TYPE
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PrintData;
}
