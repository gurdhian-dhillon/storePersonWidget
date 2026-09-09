/* ==========================================================================
 * MATERIAL ACCOUNTING DETAIL — the reasons behind extra consumption.
 *
 * A PURE READ, over the JS Data API, and that is why it is here rather than in
 * getOrderConsumption. Everything below is a criteria query on an indexed
 * lookup; nothing is written. Deluge would have needed a paste, a Custom API
 * argument change and an Execute against a big order to prove it stays under
 * the uncatchable statement limit — a getRecords walk has no statement limit at
 * all, and it reaches Item_Check.Rejection_Remarks in one hop.
 *
 * WHAT THE CONSUMPTION REPORT COULD NOT SAY, and this answers:
 *
 *   1. WHY there was extra demand. getOrderConsumption separates plan demand
 *      from later demand correctly, but collapses FOUR different causes into
 *      one "Reissued" figure — Reissue (somebody ruined cloth), Check_Remake
 *      (the checker rejected garments), Production_Remake (a stage lost
 *      pieces) and Alteration. An admin saw "3.2 m reissued" and could not
 *      tell which, and those are three quite different conversations.
 *
 *   2. Material_Requirement.Reason. Written richly by raiseReissueRequest —
 *      "12-Aug-2026 - Checking - rejected in round 2, remake", "Lost in
 *      production - Stitching 2, Cutting 1, remake" — and read by nothing on
 *      this screen.
 *
 *   3. The checker's own words. Item_Check carries Rejection_Remarks and
 *      Alteration_Remarks, which are the mandatory fields somebody fills in at
 *      the moment of rejection. getOrderConsumption never touches Item_Check,
 *      so the reason an order needed more cloth was invisible on the screen
 *      that reports the cloth.
 *
 * REPORT LINK NAMES ARE THE ONE THING THAT CANNOT BE VERIFIED FROM THE REPO,
 * AND THEY ARE NOT CONSISTENT IN THIS ORG. The convention is <Form>_Report, but
 * api-experiment.js already carries two live exceptions to it —
 * `All_items_Report` and `All_Material_Lots` — so a name that looks obvious is a
 * guess, and the first guess at Item_Check was wrong.
 *
 * So the names are DISCOVERED rather than assumed. Each form carries a list of
 * candidates, tried in order, and the first that resolves wins and is cached for
 * the session. This is only safe because getAll already separates the two ways a
 * fetch can come back empty:
 *
 *   9280 / 9220 / 3100  the report EXISTS and matched nothing -> right name
 *   anything else       the report could not be read          -> wrong name
 *
 * Without that distinction a probe could not tell "no damage on this order" from
 * "no such report", and would happily settle on a name that does not exist.
 *
 * A probe costs one getRecords per candidate, once per session, and only until
 * one works — the two names already proven by api-experiment.js are listed first
 * so the common case is a single call. If every candidate fails the tab still
 * renders every quantity and says which form it could not read, because the
 * quantities come from getOrderConsumption and do not depend on this at all.
 * ========================================================================== */

var ConsumptionDetail = (function () {
    'use strict';

    // Candidates per form, best guess first. Add to a list rather than editing
    // one string: a name that stops working is then a fallback away from fixed,
    // and the console says which one actually resolved.
    var CANDIDATES = {
        // These two are already proven against this org by api-experiment.js, so
        // they are single-entry and should never probe past the first try.
        reqs: ['Material_Requirement_Report'],
        planItems: ['Plan_Item_Report'],

        // ITEM_CHECK IS REPORTED AS `All_Items`, confirmed against the org.
        //
        // Nothing about that name could have been guessed: it does not contain
        // "Check", and it is one character off `All_items_Report`, which
        // api-experiment.js uses for a COMPLETELY DIFFERENT FORM (Raw_Material).
        // Two forms whose report names differ only by case and a suffix is
        // exactly the trap this list exists to survive — so the confirmed name
        // leads, and the alternatives stay as a net if the casing is off.
        checks: ['All_Items', 'Item_Check_Report', 'All_Item_Checks',
                 'Item_Check', 'Item_Checks'],
        damage: ['Material_Damage_Report', 'All_Material_Damage', 'Material_Damage',
                 'All_Material_Damages']
    };

    // Resolved names, filled by probing and reused for the rest of the session.
    var RPT = {};

    // Names that failed every candidate, so the UI can say which FORM it could
    // not read rather than quoting one arbitrary guess at its report name.
    var UNRESOLVED = {};

    // Extra demand, by Material_Requirement.Source. Empty and "Plan" are the
    // plan itself and never reach here — the same test getOrderConsumption
    // applies, kept identical on purpose so the two cannot disagree about what
    // counts as extra.
    var CAUSE = {
        Reissue:           { label: 'Material damaged',      hint: 'cloth ruined and replaced' },
        Check_Remake:      { label: 'Rejected at checking',  hint: 'the checker turned garments back' },
        Production_Remake: { label: 'Lost in production',    hint: 'a stage produced fewer than it received' },
        Alteration:        { label: 'Alteration',            hint: 'garments reworked rather than remade' }
    };

    function have() {
        return typeof ZOHO !== 'undefined' && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
            typeof ZOHO.CREATOR.DATA.getRecords === 'function';
    }

    function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
    function str(v) { return v == null ? '' : String(v); }

    // A lookup field arrives either as a bare id or as { ID: ..., display_value }
    // depending on the report's field config. Both shapes appear in this org's
    // payloads, so every id read goes through here.
    function idOf(v) {
        if (v == null) return '';
        if (typeof v === 'object') return str(v.ID || v.id || v.display_value || '');
        return str(v);
    }
    function labelOf(v) {
        if (v == null) return '';
        if (typeof v === 'object') return str(v.display_value || v.zc_display_value || v.ID || '');
        return str(v);
    }

    // ---- fetch, with paging, and "no records" as an empty list ------------
    //
    // Lifted deliberately from api-experiment.js rather than shared: that file
    // is the store screen's hot path and this is a read-only side panel. The
    // 9280/9220/3100 handling is the load-bearing part — Creator signals "no
    // rows" as an HTTP 400, so without it an order with no damage at all would
    // look like a failure.
    function getAll(reportName, criteria) {
        return new Promise(function (resolve) {
            if (!have()) { resolve({ rows: [], error: 'JS Data API unavailable' }); return; }

            var rows = [];

            function isNoRecords(err) {
                if (!err) return false;
                var s = '';
                try { s = JSON.stringify(err); } catch (e) { s = String(err); }
                s = (s + ' ' + (err.message || '') + ' ' +
                     (err.responseJSON ? JSON.stringify(err.responseJSON) : '')).toLowerCase();
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
                    else resolve({ rows: rows, exists: true });
                }).catch(function (err) {
                    // THE DISTINCTION THE PROBE RESTS ON. A 9280 means the
                    // report is real and simply matched nothing — an order with
                    // no damage, a plan with no checks — so the NAME IS RIGHT
                    // and `exists` says so. Anything else means it could not be
                    // read at all, which is what a wrong name looks like.
                    if (isNoRecords(err)) { resolve({ rows: rows, exists: true }); return; }
                    // NOT a rejection. A wrong report link name is the most
                    // likely failure here and it must leave the quantities on
                    // screen, so it comes back as a named note instead.
                    resolve({
                        rows: [],
                        exists: false,
                        error: reportName + ': ' +
                            (err && err.message ? err.message : 'could not be read')
                    });
                });
            }
            page(null);
        });
    }

    /* ----------------------------------------------------------------------
     * fetch(key, criteria) — the same read, against whichever report name for
     * that form actually resolves.
     *
     * Candidates are tried in order and the winner is cached in RPT for the
     * session, so the probe happens at most once per form per page load and the
     * confirmed name (first in each list) normally ends it on the first try.
     *
     * A candidate that returns rows OR a clean "no records" is the right name.
     * Only a genuine read failure moves on to the next one — see the note on
     * `exists` in getAll, which is what makes that difference legible.
     * -------------------------------------------------------------------- */
    function fetch(key, criteria) {
        var names = CANDIDATES[key] || [];

        // Already settled this session.
        if (RPT[key]) return getAll(RPT[key], criteria);
        if (UNRESOLVED[key]) {
            return Promise.resolve({ rows: [], exists: false, error: UNRESOLVED[key] });
        }

        var tried = [];

        function attempt(i) {
            if (i >= names.length) {
                // Every candidate failed. Reported against the FORM, not against
                // one arbitrary guess at its report name, because "Item_Check
                // could not be read" is actionable and "All_Item_Checks: could
                // not be read" sends somebody looking for a report that was
                // never the right one anyway.
                UNRESOLVED[key] = key + ' (tried ' + tried.join(', ') + ')';
                return Promise.resolve({ rows: [], exists: false, error: UNRESOLVED[key] });
            }

            var name = names[i];
            tried.push(name);

            return getAll(name, criteria).then(function (res) {
                if (res.exists) {
                    RPT[key] = name;
                    if (i > 0) {
                        // Worth saying: the first guess was wrong, and the name
                        // that worked is the one to pin at the head of the list.
                        console.log('[consumption-detail] ' + key + ' resolved to "' +
                            name + '" (after ' + i + ' miss' + (i === 1 ? '' : 'es') + ')');
                    }
                    return res;
                }
                return attempt(i + 1);
            });
        }

        return attempt(0);
    }

    /* ----------------------------------------------------------------------
     * run(planIds) -> { byMaterial: {matId: {causes, events}}, notes: [] }
     *
     * planIds are the audited order's plans — one order is one plan by
     * createProductionPlans' design, but it takes the list so a legacy
     * multi-plan order still accounts fully.
     *
     * Bounded by those plans throughout. Nothing here scans a whole form:
     * Material_Requirement and Plan_Item are filtered by plan, Item_Check by
     * plan, and Material_Damage by the plan items actually found.
     * -------------------------------------------------------------------- */
    function run(planIds) {
        var ids = (planIds || []).map(String).filter(Boolean);
        var out = { byMaterial: {}, notes: [], causeTotals: {} };
        if (!ids.length) return Promise.resolve(out);

        // Creator criteria: (Plan == 1 || Plan == 2). Quoted ids — a bare
        // 18-digit number is fine in a criteria string, but the quoted form is
        // what api-experiment.js uses and it survives both shapes.
        var planCrit = '(' + ids.map(function (i) { return 'Plan == ' + i; }).join(' || ') + ')';

        return Promise.all([
            // Only the rows that represent EXTRA demand. The plan's own rows are
            // already fully reported by getOrderConsumption, so fetching them
            // here would double the payload to re-derive a number we have.
            fetch('reqs', planCrit + ' && Source != "Plan" && Source != ""'),
            fetch('planItems', planCrit),
            fetch('checks', planCrit)
        ]).then(function (res) {
            var reqRes = res[0], itemRes = res[1], chkRes = res[2];
            [reqRes, itemRes, chkRes].forEach(function (r) {
                if (r.error) out.notes.push(r.error);
            });

            // ---- plan items, for names and remake lineage ----
            var itemById = {};
            itemRes.rows.forEach(function (pi) {
                itemById[str(pi.ID)] = {
                    id: str(pi.ID),
                    name: str(pi.Item_Name || ''),
                    isRemake: pi.Is_Remake === true || str(pi.Is_Remake) === 'true',
                    remakeReason: str(pi.Remake_Reason || ''),
                    remakeOf: idOf(pi.Remake_Of),
                    status: str(pi.Item_Status || '')
                };
            });

            // ---- the checker's own words, keyed by the item inspected ----
            //
            // Rejection_Remarks and Alteration_Remarks are the mandatory fields
            // filled in at the moment of rejection, and they are the closest
            // thing in this app to a first-hand account of why more material
            // was needed. Kept per item, newest round first.
            var checksByItem = {};
            chkRes.rows.forEach(function (ic) {
                var key = idOf(ic.Plan_Item);
                if (!key) return;
                if (!checksByItem[key]) checksByItem[key] = [];
                checksByItem[key].push({
                    round: num(ic.Round),
                    on: str(ic.Check_Date || ''),
                    inspected: num(ic.Qty_Inspected),
                    approved: num(ic.Qty_Approved),
                    rejected: num(ic.Qty_Rejected),
                    alteration: num(ic.Qty_Alteration),
                    remarks: str(ic.Remarks || ''),
                    rejectionRemarks: str(ic.Rejection_Remarks || ''),
                    alterationRemarks: str(ic.Alteration_Remarks || '')
                });
            });
            Object.keys(checksByItem).forEach(function (k) {
                checksByItem[k].sort(function (a, b) { return b.round - a.round; });
            });

            // ---- the extra-demand rows themselves ----
            var damageItemIds = {};

            reqRes.rows.forEach(function (mr) {
                var matId = idOf(mr.Material);
                if (!matId) return;

                var source = str(mr.Source || '').trim();
                var cause = CAUSE[source] ? source : 'Reissue';
                var piId = idOf(mr.Plan_Item);
                var item = itemById[piId] || null;

                var bucket = out.byMaterial[matId];
                if (!bucket) {
                    bucket = out.byMaterial[matId] = {
                        materialId: matId,
                        materialName: str(mr.Material_Name || ''),
                        unit: str(mr.Unit || ''),
                        causes: {},
                        events: []
                    };
                }

                var qty = num(mr.Required_Qty);
                bucket.causes[cause] = (bucket.causes[cause] || 0) + qty;
                out.causeTotals[cause] = (out.causeTotals[cause] || 0) + qty;

                // The batch this replacement is FOR. A remake item points at the
                // root it is replacing, and the checker's remarks live on the
                // ROOT — the batch that was inspected — not on the new item.
                var lookAt = item && item.remakeOf ? item.remakeOf : piId;
                var checks = checksByItem[lookAt] || [];

                var ev = {
                    cause: cause,
                    causeLabel: CAUSE[cause].label,
                    qty: qty,
                    unit: str(mr.Unit || ''),
                    item: item ? item.name : '',
                    itemId: piId,
                    // Written by raiseReissueRequest and read by nothing until
                    // now: "12-Aug-2026 - Checking - rejected in round 2, remake".
                    reason: str(mr.Reason || ''),
                    remakeReason: item ? item.remakeReason : '',
                    checks: []
                };

                // Attach only the remarks that explain THIS cause. An alteration
                // quoting a rejection remark, or the reverse, would put words in
                // somebody's mouth about a different decision.
                checks.forEach(function (c) {
                    var txt = '';
                    if (cause === 'Check_Remake' && c.rejected > 0) txt = c.rejectionRemarks;
                    else if (cause === 'Alteration' && c.alteration > 0) txt = c.alterationRemarks;
                    if (!txt && c.remarks && (c.rejected > 0 || c.alteration > 0)) txt = c.remarks;
                    if (!txt) return;
                    ev.checks.push({
                        round: c.round, on: c.on, remarks: txt,
                        inspected: c.inspected, approved: c.approved,
                        rejected: c.rejected, alteration: c.alteration
                    });
                });

                bucket.events.push(ev);
                if (piId) damageItemIds[piId] = true;
                if (item && item.remakeOf) damageItemIds[item.remakeOf] = true;
            });

            // ---- damage incidents, for the items involved ----
            //
            // getOrderConsumption already reports damage quantity and its own
            // reason well, so this is not duplicated into the causes above. It
            // is fetched so the EVENT trail is complete: an admin reading "why
            // was there extra cloth" wants the damage report beside the
            // reissue it caused, not on a different row of a different table.
            var itemIds = Object.keys(damageItemIds);
            if (!itemIds.length) return out;

            var dmgCrit = '(' + itemIds.map(function (i) {
                return 'Plan_Item == ' + i;
            }).join(' || ') + ')';

            return fetch('damage', dmgCrit).then(function (dRes) {
                if (dRes.error) { out.notes.push(dRes.error); return out; }
                out.damage = dRes.rows.map(function (dm) {
                    return {
                        itemId: idOf(dm.Plan_Item),
                        stage: str(dm.Phase_Name || ''),
                        reason: str(dm.Damage_Reason || ''),
                        note: str(dm.Note || ''),
                        who: labelOf(dm.Supervisor),
                        on: str(dm.Reported_On || '')
                    };
                });
                return out;
            });
        }).catch(function (err) {
            // Belt and braces: a failure here must never replace the tab, whose
            // quantities come from getOrderConsumption and are unaffected.
            out.notes.push('Consumption detail could not be read: ' +
                (err && err.message ? err.message : String(err)));
            return out;
        });
    }

    // RPT is the RESOLVED names, filled by probing — read it in the console to
    // see what this org actually calls these reports, and pin a winner at the
    // head of its CANDIDATES list to skip the probe next time.
    return { run: run, RPT: RPT, CANDIDATES: CANDIDATES, CAUSE: CAUSE };
})();
