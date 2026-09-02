// Employee report — one day of the production floor, one row per person.
//
// Everything on this screen comes out of Stage_Log, which saveProductionPhase
// writes one row of per Plan_Item x phase. That gives, per person per day:
// stages worked, pieces in, pieces out, the loss between them, the time the
// stages spanned, and which orders they were on. All of it provable.
//
// WHAT IS DELIBERATELY NOT HERE, having been on the previous version of this
// page: "Target", "Efficiency" and "OLE". The server was summing Qty_In into a
// field called Target and dividing Qty_Out by it — so the percentage was yield,
// not productivity, and saveProductionPhase caps Qty_Out at Qty_In, which
// bounds it at 100 by construction. A man who cut 500 pieces cleanly and a man
// who cut 5 cleanly both read 100%. Yield is still shown, because it is a real
// number; it is named yield, and the volume it is computed from sits in the two
// columns beside it so the ratio can never be read on its own.
//
// Also gone: the Active / On Break / Offline badge, which was derived from that
// same ratio and overwrote the real Employee.Status; the 10-second poll of four
// separate APIs; and the Log Production button, which wrote production outside
// saveProductionPhase and so skipped the item, plan and order status roll-up,
// the machine release and the QC-ready flag.

var DATA = null;
var PIPELINE_STATUS = 'In Production';
var IN_PRODUCTION_SUB_FILTER = 'All';
var OPEN_ITEM_DRAWERS = {};
var DRAWER_STAGE_FILTERS = {};
var OPEN_ITEM_BATCH_DRAWERS = {};

// Sales orders still at "Pending" — the ones the CreateProductionPlan batch
// workflow has not turned into a plan yet. Loaded alongside the pipeline counts,
// shown when the Pending card is selected, each with its last reject reason and
// a Convert to plan button. null = not loaded yet.
var PENDING_ORDERS = null;
var PENDING_ERROR = '';
// soId currently being converted, so its button can show a spinner and the rest
// stay clickable.
var CONVERTING = {};

// Which rows are expanded, keyed by employee id. Survives a re-render so
// refreshing does not collapse everything that was open.
var OPEN = {};

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
                   'July', 'August', 'September', 'October', 'November', 'December'];
var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---- dates ----
//
// Held as "yyyy-mm-dd" throughout, which is what <input type="date"> reads and
// writes. Never parsed with new Date(str): that reads a bare date as UTC and
// lands on the previous day in any negative-offset zone.

function todayIso() {
    var d = new Date();
    return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function isoOf(y, m, d) {
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

function partsOf(iso) {
    var b = String(iso || '').split('-');
    return { y: parseInt(b[0], 10), m: parseInt(b[1], 10), d: parseInt(b[2], 10) };
}

function shiftDays(iso, n) {
    var p = partsOf(iso);
    var dt = new Date(p.y, p.m - 1, p.d);
    dt.setDate(dt.getDate() + n);
    return isoOf(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

// Deluge parses "dd-MMM-yyyy" the same way whatever the org's locale is set to,
// where "08-11-2026" is a different day in the US than it is here.
function toApiDate(iso) {
    var p = partsOf(iso);
    if (!p.y || !p.m || !p.d) return '';
    return (p.d < 10 ? '0' : '') + p.d + '-' + MONTHS[p.m - 1] + '-' + p.y;
}

function longDate(iso) {
    var p = partsOf(iso);
    if (!p.y) return '';
    var dt = new Date(p.y, p.m - 1, p.d);
    return DAYS[dt.getDay()] + ', ' + p.d + ' ' + MONTHS_LONG[p.m - 1] + ' ' + p.y;
}

// ---- times ----
//
// Start_Time and End_Time are Creator Time fields and the string they render as
// is not guaranteed — "09:00", "09:00:00" and "09:00 AM" are all possible. So
// they are parsed here rather than subtracted in Deluge, and anything that does
// not match is shown as a dash. A missing duration is honest; a confident wrong
// one on a report about how much work someone did is not.

function toMinutes(t) {
    var s = String(t === null || t === undefined ? '' : t).trim();
    if (s === '' || s === 'N/A') return null;

    var m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(s);
    if (!m) return null;

    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    if (isNaN(h) || isNaN(min) || min > 59) return null;

    var ap = m[3] ? m[3].toLowerCase() : '';
    if (ap === 'am') { if (h === 12) h = 0; }
    else if (ap === 'pm') { if (h < 12) h += 12; }
    if (h > 23) return null;

    return h * 60 + min;
}

function spanMinutes(start, end) {
    var a = toMinutes(start);
    var b = toMinutes(end);
    if (a === null || b === null) return null;

    var d = b - a;
    // A stage that ran past midnight is real on a night shift, so a negative
    // span is wrapped. Beyond about 16 hours it is far likelier that the two
    // times were typed the wrong way round, and a made-up 23-hour stage would
    // quietly dominate somebody's day — so that case gives no figure at all.
    if (d < 0) d += 1440;
    if (d > 960) return null;
    return d;
}

// A ZERO SPAN AND A MISSING ONE ARE DIFFERENT ANSWERS, and only the second is
// a dash. Start and End are stamped to the minute — nowHHMM() in the supervisor
// widget writes HH:MM — so a stage finished inside a minute records identical
// times and genuinely spans zero. Rendering that as "—" claimed no times were
// recorded, which is not true and makes a working screen look broken.
function fmtMins(mins) {
    if (mins === null || mins === undefined) return '—';
    if (mins < 1) return '<span class="muted">&lt;1m</span>';
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h === 0) return m + 'm';
    if (m === 0) return h + 'h';
    return h + 'h ' + m + 'm';
}

// ---- formatting ----

function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function n(v) {
    var x = parseInt(v, 10);
    return isNaN(x) ? 0 : x;
}

function dash(v) {
    return n(v) > 0 ? String(n(v)) : '<span class="lost-none">—</span>';
}

// Bands, not a gradient. The point of the colour is to make a bad row findable
// while scrolling, and three states do that where a continuous ramp does not.
function yieldBand(pct) {
    if (pct >= 98) return 'good';
    if (pct >= 90) return 'fair';
    return 'poor';
}

// One decimal, but never a trailing ".0" — the same rule the audit page applies
// to measurements. "98.0%" reads as more precisely measured than "98%" when it
// is the identical number.
function pct1(x) {
    var s = x.toFixed(1);
    return s.indexOf('.0', s.length - 2) > -1 ? s.slice(0, -2) : s;
}

function yieldCell(pIn, pOut) {
    if (n(pIn) <= 0) return '<span class="muted">—</span>';
    var pct = (n(pOut) / n(pIn)) * 100;
    var band = yieldBand(pct);
    var shown = pct1(pct);
    return '<span class="yield-num y-' + band + '-t">' + shown + '%</span>' +
        '<div class="yield-bar"><div class="yield-fill y-' + band + '" style="width:' +
        Math.max(0, Math.min(100, pct)).toFixed(1) + '%"></div></div>';
}

function chevronSvg() {
    return '<span class="chevron" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>';
}

// ---- the day in five numbers ----

function renderTiles() {
    var el = document.getElementById('tiles');
    if (!DATA) { el.innerHTML = ''; return; }

    var t = DATA.totals || {};
    var pIn = n(t.piecesIn);
    var pOut = n(t.piecesOut);
    var lost = pIn - pOut;
    var noLogs = (DATA.noLogs || []).length;

    // The table can hold one more row than this tile counts — work whose
    // operator was never recorded gets a row so the columns still add up, but
    // it is not a person and must not be counted as one. Saying so here is what
    // stops the tile and the table looking like they disagree.
    var unatt = (DATA.worked || []).some(function (w) { return w.unattributed; });

    var peopleSub = 'everyone active logged work';
    if (unatt) peopleSub = 'plus stages with no operator recorded';
    else if (noLogs > 0) peopleSub = noLogs + ' active with nothing logged';

    var tiles = [
        {
            cls: 'tile-people', label: 'People who worked', value: n(t.people),
            sub: peopleSub
        },
        {
            cls: 'tile-stages', label: 'Stages completed', value: n(t.stagesDone),
            sub: n(t.stagesOpen) > 0
                ? n(t.stagesOpen) + ' still running · ' + n(t.piecesInHand) + ' pcs in hand'
                : 'nothing left running'
        },
        {
            cls: 'tile-out', label: 'Pieces out', value: pOut,
            sub: 'from ' + pIn + ' handed in'
        },
        {
            cls: 'tile-lost', label: 'Pieces lost', value: lost,
            sub: lost > 0 ? 'went in but did not come out' : 'nothing lost today'
        },
        {
            cls: 'tile-yield', label: 'Floor yield',
            value: pIn > 0 ? pct1((pOut / pIn) * 100) + '%' : '—',
            sub: 'pieces out ÷ pieces in'
        }
    ];

    el.innerHTML = tiles.map(function (x) {
        return '<div class="tile ' + x.cls + '">' +
            '<span class="tile-label">' + esc(x.label) + '</span>' +
            '<span class="tile-value">' + esc(String(x.value)) + '</span>' +
            '<span class="tile-sub">' + esc(x.sub) + '</span></div>';
    }).join('');
}

// ---- sales order pipeline summary ----

function soStatusClass(status) {
    var s = String(status || '').toLowerCase().trim();
    if (s === 'pending') return 'so-pending';
    if (s === 'in progress') return 'so-progress';
    if (s === 'production complete') return 'so-complete';
    if (s === 'checking passed') return 'so-qc';
    if (s === 'finishing complete') return 'so-finishing';
    if (s === 'packed') return 'so-packed';
    if (s === 'dispatched') return 'so-dispatched';
    return 'so-default';
}

function soStatusPill(status) {
    if (!status) return '';
    var cls = soStatusClass(status);
    return '<span class="pill pill-so-status ' + cls + '">' + esc(status) + '</span>';
}

function getEffectiveBreakdown(order) {
    if (order && order.itemBreakdown && (order.itemBreakdown.inProgress || order.itemBreakdown.prodComplete || order.itemBreakdown.checkingPassed || order.itemBreakdown.finishingComplete || order.itemBreakdown.alteration)) {
        return order.itemBreakdown;
    }
    var prod = Number(order.producedQty) || 0;
    var ord = Number(order.orderedQty) || 0;
    var rem = Number(order.remakeItems) || 0;
    var st = String(order.currentStage || '').toLowerCase();
    var stStatus = String(order.currentStageStatus || '').toLowerCase();

    var bd = { inProgress: 0, prodComplete: 0, checkingPassed: 0, finishingComplete: 0, alteration: rem };

    if (stStatus === 'passed' || st.indexOf('qc') !== -1 || st.indexOf('checking') !== -1 || st.indexOf('quality') !== -1) {
        bd.checkingPassed = prod;
        bd.inProgress = Math.max(0, ord - prod);
    } else if (st.indexOf('finishing') !== -1) {
        // Only the finishing stage itself routes to finishingComplete \u2014
        // stStatus=completed alone means a production stage finished, not that
        // finishing is done.
        bd.finishingComplete = prod;
        bd.inProgress = Math.max(0, ord - prod);
    } else if (st.indexOf('complete') !== -1 || (prod >= ord && ord > 0)) {
        bd.prodComplete = prod;
    } else {
        bd.inProgress = Math.max(prod, ord);
    }
    return bd;
}

function renderItemProgressBar(order) {
    if (!order) return '';
    var bd = getEffectiveBreakdown(order);

    var inProd = Number(bd.inProgress) || 0;
    var prodComp = Number(bd.prodComplete) || 0;
    var qcPass = Number(bd.checkingPassed) || 0;
    var finComp = Number(bd.finishingComplete) || 0;
    var alt = Number(bd.alteration) || 0;
    var rej = Number(bd.rejected || order.totalRejected) || 0;

    if (Array.isArray(order.items) && order.items.length) {
        var altSum = 0;
        var rejSum = 0;
        order.items.forEach(function (it) {
            altSum += (Number(it.qtyAltered) || 0);
            rejSum += (Number(it.qtyRejected) || Number(it.qtyRemake) || 0);
        });
        if (altSum > alt) alt = altSum;
        if (rejSum > rej) rej = rejSum;
    }

    var badges = [];
    if (inProd > 0) badges.push('<span class="pill pill-running">' + inProd + ' In Progress</span>');
    if (prodComp > 0) badges.push('<span class="pill pill-qc">' + prodComp + ' QC Queue</span>');
    if (qcPass > 0) badges.push('<span class="pill pill-done">' + qcPass + ' Checking Passed</span>');
    if (finComp > 0) badges.push('<span class="pill pill-ok">' + finComp + ' Finishing Complete</span>');
    if (alt > 0) badges.push('<span class="pill pill-running" style="background:#f3e8ff; color:#6b21a8; font-weight:600;">' + alt + ' Altered</span>');
    if (rej > 0) badges.push('<span class="pill pill-remake">' + rej + ' Rejected / Remake</span>');

    if (!badges.length) return '<span class="muted">No stage data</span>';

    return '<div class="item-legend" style="gap:4px; flex-wrap:wrap;">' + badges.join('') + '</div>';
}

function renderItemDrawer(order) {
    var items = Array.isArray(order.items) && order.items.length ? order.items : null;
    var soId = String(order.id || order.salesOrder);
    var activeSub = DRAWER_STAGE_FILTERS[soId] || 'All';

    if (!items) {
        var ord = Number(order.orderedQty) || 0;
        var prod = Number(order.producedQty) || 0;
        var st = String(order.currentStage || '').trim() || 'In Production';
        var stStatus = String(order.currentStageStatus || '').trim();
        var pill = '<span class="pill pill-running">' + esc(st + (stStatus ? ' (' + stStatus + ')' : '')) + '</span>';
        if (stStatus === 'Passed' || stStatus === 'Completed') pill = '<span class="pill pill-done">' + esc(st + ' Passed') + '</span>';

        var displayName = order.itemName || order.firstItemName || (order.salesOrder ? ('Item for ' + order.salesOrder) : 'Main Line Item');

        return '<div class="item-drawer-wrap">' +
            '<div class="item-drawer-title">Order Item Summary (1 item line)</div>' +
            '<div class="item-drawer-scroll">' +
            '<table class="item-drawer-table"><thead><tr>' +
            '<th>Item Name</th><th class="r">Ordered</th><th class="r">Produced</th><th>Current Stage</th>' +
            '</tr></thead><tbody>' +
            '<tr><td><strong>' + esc(displayName) + '</strong></td>' +
            '<td class="r">' + ord + '</td>' +
            '<td class="r">' + prod + '</td>' +
            '<td>' + pill + '</td></tr>' +
            '</tbody></table></div></div>';
    }

    function getItemCategory(it) {
        var st = String(it.status || '').trim();
        var stgState = String(it.currentStageStatus || '').trim();
        var ordSt = String(order.status || order.orderStatus || order.currentStage || '').trim();

        var isFinComplete = (
            ordSt === 'Finishing Complete' || ordSt === 'Packed' || ordSt === 'Dispatched' ||
            st === 'Finishing Complete' || st === 'Packed' || st === 'Dispatched' ||
            it.isFinishingComplete === true || it.finishingStatus === 'Completed'
        );
        if (isFinComplete) return 'Finishing Complete';

        var isQc = (st === 'Awaiting_Check' || it.remakeStatus === 'Awaiting_Check');
        if (isQc) return 'Prod Complete';

        var isPass = (stgState === 'Passed' || st === 'Complete');
        if (isPass) return 'Checking Passed';

        return 'In Progress';
    }

    // Count items per stage
    var cAll = items.length;
    var cInProg = 0, cProdComp = 0, cQcPass = 0, cFinComp = 0;

    items.forEach(function (it) {
        var cat = getItemCategory(it);
        if (cat === 'Finishing Complete') cFinComp++;
        else if (cat === 'Checking Passed') cQcPass++;
        else if (cat === 'Prod Complete') cProdComp++;
        else cInProg++;
    });

    var stageOptions = [
        { id: 'All', label: 'All In Production (' + cAll + ')' },
        { id: 'In Progress', label: 'In Progress (' + cInProg + ')' },
        { id: 'Prod Complete', label: 'Prod Complete (QC Queue) (' + cProdComp + ')' },
        { id: 'Checking Passed', label: 'Checking Passed (' + cQcPass + ')' },
        { id: 'Finishing Complete', label: 'Finishing Complete (' + cFinComp + ')' }
    ];

    var toolbarHtml = '<div class="sub-stage-toolbar drawer-stage-toolbar" style="margin: 8px 0 12px; background: #ffffff;">' +
        '<span class="sub-toolbar-title">PRODUCTION STAGES:</span>' +
        '<div class="sub-chip-group">' +
        stageOptions.map(function(s) {
            var active = (activeSub === s.id);
            return '<button type="button" class="sub-chip' + (active ? ' is-active' : '') + '" data-drawer-so="' + esc(soId) + '" data-drawer-sub="' + esc(s.id) + '">' +
                esc(s.label) + '</button>';
        }).join('') +
        '</div></div>';

    // Filter items based on activeSub inside this drawer
    var filteredItems = items.filter(function (it) {
        if (activeSub === 'All') return true;
        return getItemCategory(it) === activeSub;
    });

    var showStageCol = (activeSub === 'All' || activeSub === 'In Progress' || activeSub === 'Finishing Complete' || activeSub === 'Checking Passed');
    var colSpanVal = showStageCol ? 7 : 6;

    var rows = filteredItems.map(function (it) {
        var st = String(it.status || '').trim();
        var stgName = String(it.currentStage || '').trim();
        var stgState = String(it.currentStageStatus || '').trim();
        var ordSt = String(order.status || order.orderStatus || order.currentStage || '').trim();
        var isItemFinComplete = (ordSt === 'Finishing Complete' || ordSt === 'Packed' || ordSt === 'Dispatched' || st === 'Finishing Complete' || st === 'Packed' || st === 'Dispatched' || it.isFinishingComplete === true || it.finishingStatus === 'Completed');
        var qAltered = Number(it.qtyAltered) || 0;
        var isAlt = (it.isRemake || qAltered > 0 || !!it.hasRemake);

        var stageLabel = stgName ? (stgName + (stgState ? ' ' + stgState : '')) : (st === 'Complete' ? 'Checking Passed' : (st === 'Awaiting_Check' ? 'Prod Complete (QC Queue)' : 'In Production'));

        var pillCls = 'pill-running';
        if (st === 'Awaiting_Check' || it.remakeStatus === 'Awaiting_Check') {
            pillCls = 'pill-qc';
            stageLabel = 'Prod Complete (QC Queue)';
        } else if (isItemFinComplete) {
            pillCls = 'pill-ok';
            stageLabel = (st === 'Finishing Complete' || stgName === 'Finishing Complete' || stgName === 'Finishing Complete (Awaiting Packing)') ? 'Finishing Complete (Awaiting Packing)' : (stgName ? stgName + ' (Awaiting Packing)' : 'Finishing Complete (Awaiting Packing)');
        } else if (stgState === 'Passed' || stgState === 'Completed' || st === 'Complete') {
            pillCls = 'pill-done';
        } else if (isAlt) {
            pillCls = 'pill-remake';
            stageLabel = (it.remakeStage || stgName || 'Production') + ' (Remake Running)';
        }

        var pill = '<span class="pill ' + pillCls + '">' + esc(stageLabel) + '</span>';
        var nameStr = it.itemName || it.name || it.item || ('Item #' + it.id);
        var itemKey = soId + '_' + nameStr;
        var hasBatches = Number(it.qtyRejected) > 0 || qAltered > 0 || (Array.isArray(it.batches) && it.batches.length > 1);
        var isBatchOpen = !!OPEN_ITEM_BATCH_DRAWERS[itemKey];

        var batchBtn = hasBatches
            ? ' <button type="button" class="sub-chip btn-toggle-batch' + (isBatchOpen ? ' is-active' : '') + '" data-batch-key="' + esc(itemKey) + '" style="font-size:11px; padding:2px 8px; margin-left:6px; cursor:pointer;">' +
              (isBatchOpen ? '▼ Hide Details' : '▶ Rejection / Alteration Details') + '</button>'
            : '';

        var tdStage = showStageCol ? ('<td>' + pill + '</td>') : '';

        var rowHtml = '<tr>' +
            '<td><strong>' + esc(nameStr) + '</strong>' + batchBtn + '</td>' +
            '<td class="r">' + n(it.qtyOrdered) + '</td>' +
            '<td class="r">' + n(it.qtyProduced) + '</td>' +
            '<td class="r">' + n(it.qtyAccepted) + '</td>' +
            '<td class="r">' + (it.qtyRejected > 0 ? '<span class="lost-some">' + n(it.qtyRejected) + '</span>' : '0') + '</td>' +
            '<td class="r">' + (qAltered > 0 ? '<span class="lost-some">' + qAltered + '</span>' : '0') + '</td>' +
            tdStage +
            '</tr>';

        if (isBatchOpen && hasBatches) {
            var totalRej = Number(it.qtyRejected) || 0;
            // qtyAltered on the grouped item comes from the deluge Alteration batch.
            var totalAlt = Number(it.qtyAltered) || 0;
            var totalRmk = Number(it.qtyRemake) || 0;

            // Stage info for each type — shown separately in the detail card.
            var rmkStageInfo = it.remakeStatus === 'Awaiting_Check'
                ? 'Waiting in QC Queue'
                : (it.remakeStage
                    ? (it.remakeStage + (it.remakeStageStatus === 'Completed' ? ' (Completed)' : ' (Running)'))
                    : 'Remake Production');
            var altStageInfo = it.altStatus === 'Awaiting_Check'
                ? 'Waiting in QC Queue'
                : (it.altStage
                    ? (it.altStage + (it.altStageStatus === 'Completed' ? ' (Completed)' : ' (Running)'))
                    : 'Alteration Production');

            // Walk the raw batches list for any extra detail the group-level
            // fields don't yet carry (e.g. multiple remake batches on one item).
            if (Array.isArray(it.batches)) {
                it.batches.forEach(function (b) {
                    var bReason = String(b.remakeReason || '').trim();
                    if (bReason === 'Alteration') {
                        // Alteration batch — garments sent back to fix a stage.
                        var bAltQty = Number(b.qtyOrdered) || Number(b.qtyAltered) || 0;
                        if (bAltQty > totalAlt) totalAlt = bAltQty;
                        if (b.currentStage) {
                            var bAltSuffix = b.status === 'Awaiting_Check'
                                ? ' (QC Queue)'
                                : (b.currentStageStatus === 'Completed' ? ' (Completed)' : ' (Running)');
                            altStageInfo = b.currentStage + bAltSuffix;
                        }
                    } else if (b.isRemake) {
                        // Check_Reject batch — needs fresh cloth.
                        var bRmkQty = Number(b.qtyOrdered) || Number(b.qtyRemake) || 0;
                        if (bRmkQty > totalRmk) totalRmk = bRmkQty;
                        if (Number(b.qtyRejected) > totalRej) totalRej = Number(b.qtyRejected);
                        if (b.currentStage) {
                            var bSuffix = b.status === 'Awaiting_Check'
                                ? ' (QC Queue)'
                                : (b.currentStageStatus === 'Completed' ? ' (Completed)' : ' (Running)');
                            rmkStageInfo = b.currentStage + bSuffix;
                        }
                    } else {
                        // Original (non-remake) batch — read its rejection count.
                        if (Number(b.qtyRejected) > totalRej) totalRej = Number(b.qtyRejected);
                    }
                });
            }

            var cardDetails = '';

            // Rejected / Remake row — only when there were actual rejections.
            var rejCount = Math.max(totalRej, totalRmk);
            if (rejCount > 0) {
                cardDetails += '<div style="display:flex; align-items:center; gap:8px;">' +
                    '<span style="font-size:12px; font-weight:600; color:#64748b;">Rejected / Remake:</span>' +
                    '<span class="pill pill-remake" style="font-size:12px; font-weight:700;">' + rejCount + ' Pcs</span>' +
                    '<span style="font-size:11px; color:#94a3b8;">(' + esc(rmkStageInfo) + ')</span>' +
                    '</div>';
            }

            // Alteration row — separate from rejection; shows the stage the garments went back to.
            if (totalAlt > 0) {
                cardDetails += '<div style="display:flex; align-items:center; gap:8px;">' +
                    '<span style="font-size:12px; font-weight:600; color:#64748b;">Altered:</span>' +
                    '<span class="pill pill-running" style="font-size:12px; font-weight:700;">' + totalAlt + ' Pcs</span>' +
                    '<span style="font-size:11px; color:#94a3b8;">(' + esc(altStageInfo) + ')</span>' +
                    '</div>';
            }

            if (!cardDetails) {
                cardDetails = '<span style="font-size:12px; color:#64748b;">No rejected or altered pieces recorded.</span>';
            }

            rowHtml += '<tr class="item-batch-drawer-row"><td colspan="' + colSpanVal + '" style="background:#f8fafc; padding:12px 16px; border-left:3px solid #3b82f6;">' +
                '<div style="font-size:11px; font-weight:700; color:#475569; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">REJECTION &amp; ALTERATION SUMMARY FOR ' + esc(nameStr) + '</div>' +
                '<div style="display:flex; align-items:center; gap:32px; flex-wrap:wrap;">' + cardDetails + '</div></td></tr>';
        }

        return rowHtml;
    }).join('');

    if (!rows) {
        rows = '<tr><td colspan="' + colSpanVal + '" class="muted" style="text-align:center; padding:16px;">No items match the selected stage filter (' + esc(activeSub) + ').</td></tr>';
    }

    var thStage = showStageCol ? '<th>Current Stage</th>' : '';

    return '<div class="item-drawer-wrap">' +
        '<div class="item-drawer-title">Item-Level Tracking Breakdown (' + items.length + ' item types)</div>' +
        toolbarHtml +
        '<div class="item-drawer-scroll">' +
        '<table class="item-drawer-table"><thead><tr>' +
        '<th>Item Name</th><th class="r">Ordered</th><th class="r">Produced</th><th class="r">Accepted</th><th class="r">Rejected</th><th class="r">Altered</th>' + thStage +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

function renderPipeline(targetSoId) {
    var el = document.getElementById('pipeline-section');
    if (!el) return;

    var currentScroll = window.scrollY || document.documentElement.scrollTop;
    var currentHeight = el.offsetHeight;
    if (currentHeight > 0) {
        el.style.minHeight = currentHeight + 'px';
    }

    var p = (DATA && DATA.pipeline) ? DATA.pipeline : {};
    var hasLiveCounts = p.pending !== undefined || p.inProgress !== undefined ||
        p.completed !== undefined || p.qcPassed !== undefined ||
        p.finishingComplete !== undefined ||
        p.packed !== undefined || p.dispatched !== undefined;

    // Macro Cards: 1. Pending, 2. In Production, 3. Packed, 4. Dispatched
    var inProdCount = n(p.inProgress) + n(p.completed) + n(p.qcPassed) + n(p.finishingComplete);
    var macroItems = [
        { label: 'Pending', count: p.pending, cls: 'so-pending' },
        { label: 'In Production', count: inProdCount, cls: 'so-progress' },
        { label: 'Packed', count: p.packed, cls: 'so-packed' },
        { label: 'Dispatched', count: p.dispatched, cls: 'so-dispatched' }
    ];

    var isProdActive = PIPELINE_STATUS === 'In Production' || PIPELINE_STATUS === 'In Progress' ||
        PIPELINE_STATUS === 'Prod Complete' || PIPELINE_STATUS === 'Checking Passed' ||
        PIPELINE_STATUS === 'Finishing Complete';

    var totalOrders = n(p.pending) + inProdCount + n(p.packed) + n(p.dispatched);

    var cardsHtml = macroItems.map(function(x) {
        var isSelected = (x.label === PIPELINE_STATUS) || (x.label === 'In Production' && isProdActive);
        return '<button type="button" class="pipe-card ' + x.cls + (isSelected ? ' is-selected' : '') + '" data-status="' + esc(x.label) + '">' +
            '<span class="pipe-count">' + (hasLiveCounts ? n(x.count) : '—') + '</span>' +
            '<span class="pipe-label">' + esc(x.label) + '</span>' +
            '</button>';
    }).join('');

    el.innerHTML = '<div class="pipeline-header pipeline-toolbar">' +
        '<div><h2>Sales Order Pipeline</h2><span class="pipeline-help">Follow each sales order and item breakdown through the workflow.</span></div>' +
        '<span class="pipe-total">' + (hasLiveCounts ? totalOrders + ' total sales orders' : 'Loading live counts…') + '</span>' +
        '</div>' +
        '<div class="pipeline-grid">' + cardsHtml + '</div>' +
        (DATA && DATA.pipelineError
            ? '<p class="pipeline-error">Could not load live status counts: ' + esc(DATA.pipelineError) + '</p>'
            : '') +
        renderInProgressOrders();

    // Bind macro cards
    Array.prototype.forEach.call(el.querySelectorAll('.pipe-card'), function (tab) {
        tab.addEventListener('click', function (e) {
            e.preventDefault();
            var st = tab.getAttribute('data-status');
            PIPELINE_STATUS = st;
            if (st === 'In Production') IN_PRODUCTION_SUB_FILTER = 'All';
            renderPipeline();
            if (PIPELINE_STATUS === 'Pending') {
                if (PENDING_ORDERS === null && !PENDING_ERROR) {
                    loadPendingOrders();
                }
            } else {
                loadSalesOrderProgress(PIPELINE_STATUS === 'In Production' ? 'In Progress' : PIPELINE_STATUS);
            }
        });
    });

    // Bind drawer stage filter chips inside expanded order drawers
    Array.prototype.forEach.call(el.querySelectorAll('.drawer-stage-toolbar .sub-chip'), function (chip) {
        chip.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var soId = chip.getAttribute('data-drawer-so');
            var sub = chip.getAttribute('data-drawer-sub');
            DRAWER_STAGE_FILTERS[soId] = sub;
            renderPipeline(soId);
        });
    });

    // Bind batch toggle buttons inside drawers
    Array.prototype.forEach.call(el.querySelectorAll('.btn-toggle-batch'), function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var bKey = btn.getAttribute('data-batch-key');
            OPEN_ITEM_BATCH_DRAWERS[bKey] = !OPEN_ITEM_BATCH_DRAWERS[bKey];
            var parts = String(bKey || '').split('_');
            renderPipeline(parts[0]);
        });
    });

    // Bind drawer toggles cleanly without popups or triggering convertOrderToPlan
    Array.prototype.forEach.call(el.querySelectorAll('.btn-toggle-drawer'), function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var soId = btn.getAttribute('data-so-id');
            OPEN_ITEM_DRAWERS[soId] = !OPEN_ITEM_DRAWERS[soId];
            renderPipeline(soId);
        });
    });

    // Bind progress modal popup buttons
    Array.prototype.forEach.call(el.querySelectorAll('.btn-open-progress-modal'), function (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var soId = btn.getAttribute('data-so-id');
            openProgressModal(soId);
        });
    });

    bindPendingButtons();

    // Restore viewport scroll position or keep target drawer anchored
    if (targetSoId) {
        var targetChip = el.querySelector('.sub-chip[data-drawer-so="' + esc(targetSoId) + '"]') ||
                         el.querySelector('.btn-toggle-drawer[data-so-id="' + esc(targetSoId) + '"]');
        if (targetChip && targetChip.scrollIntoView) {
            targetChip.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        } else {
            window.scrollTo(0, currentScroll);
        }
    } else {
        window.scrollTo(0, currentScroll);
    }

    setTimeout(function () {
        if (el) el.style.minHeight = '';
    }, 200);
}

function openProgressModal(soId) {
    var orders = (DATA && Array.isArray(DATA.progressOrders)) ? DATA.progressOrders : [];
    var order = null;
    for (var i = 0; i < orders.length; i++) {
        if (String(orders[i].id || orders[i].salesOrder) === String(soId)) {
            order = orders[i];
            break;
        }
    }
    if (!order) return;

    var bd = getEffectiveBreakdown(order);
    var inProd = Number(bd.inProgress) || 0;
    var prodComp = Number(bd.prodComplete) || 0;
    var qcPass = Number(bd.checkingPassed) || 0;
    var finComp = Number(bd.finishingComplete) || 0;
    var alt = Number(bd.alteration) || 0;
    var rej = Number(bd.rejected || order.totalRejected || order.remakeItems) || 0;

    if (Array.isArray(order.items) && order.items.length) {
        var altSum = 0;
        var rejSum = 0;
        order.items.forEach(function (it) {
            altSum += (Number(it.qtyAltered) || 0);
            rejSum += (Number(it.qtyRejected) || Number(it.qtyRemake) || 0);
        });
        if (altSum > alt) alt = altSum;
        if (rejSum > rej) rej = rejSum;
    }

    var badgesHtml = renderItemProgressBar(order);

    var existingModal = document.getElementById('progress-modal-overlay');
    if (existingModal) existingModal.remove();

    var modalHtml = '<div id="progress-modal-overlay" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,23,42,0.65); backdrop-filter:blur(3px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px;">' +
        '<div style="background:#ffffff; border-radius:12px; max-width:560px; width:100%; box-shadow:0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04); overflow:hidden; border:1px solid #e2e8f0; font-family:Inter, sans-serif;">' +
        '<div style="padding:16px 20px; background:#f8fafc; border-bottom:1px solid #e2e8f0; display:flex; align-items:center; justify-content:space-between;">' +
        '<div>' +
        '<h3 style="margin:0; font-size:16px; font-weight:700; color:#0f172a;">Item-Level Progress Breakdown</h3>' +
        '<span style="font-size:12px; color:#64748b;">Sales Order: <strong>' + esc(order.salesOrder || '—') + '</strong> · Plan: <strong>' + esc(order.planNo || '—') + '</strong></span>' +
        '</div>' +
        '<button type="button" id="close-progress-modal" style="background:none; border:none; font-size:20px; font-weight:700; color:#64748b; cursor:pointer; line-height:1;">&times;</button>' +
        '</div>' +
        '<div style="padding:20px; display:flex; flex-direction:column; gap:16px;">' +
        '<div>' +
        '<div style="font-size:11px; font-weight:700; text-transform:uppercase; color:#64748b; letter-spacing:0.5px; margin-bottom:8px;">STAGE PROGRESS BADGES:</div>' +
        badgesHtml +
        '</div>' +
        '<div style="background:#f1f5f9; border-radius:8px; padding:14px; display:grid; grid-template-columns:1fr 1fr; gap:12px; font-size:13px;">' +
        '<div><span style="color:#64748b;">Total Ordered:</span> <strong style="color:#0f172a;">' + n(order.orderedQty) + ' Pcs</strong></div>' +
        '<div><span style="color:#64748b;">Total Produced:</span> <strong style="color:#0f172a;">' + n(order.producedQty) + ' Pcs</strong></div>' +
        '<div><span style="color:#64748b;">Finishing Complete:</span> <strong style="color:#16a34a;">' + finComp + ' Pcs</strong></div>' +
        '<div><span style="color:#64748b;">Checking Passed:</span> <strong style="color:#2563eb;">' + qcPass + ' Pcs</strong></div>' +
        '<div><span style="color:#64748b;">QC Queue:</span> <strong style="color:#d97706;">' + prodComp + ' Pcs</strong></div>' +
        '<div><span style="color:#64748b;">In Progress:</span> <strong style="color:#0284c7;">' + inProd + ' Pcs</strong></div>' +
        '<div><span style="color:#64748b;">Altered:</span> <strong style="color:#7c3aed;">' + alt + ' Pcs</strong></div>' +
        '<div><span style="color:#64748b;">Rejected / Remake:</span> <strong style="color:#dc2626;">' + rej + ' Pcs</strong></div>' +
        '</div>' +
        '<p style="margin:0; font-size:11px; color:#94a3b8; font-style:italic;">* Piece counts update in real time as remake and alteration batches finish through QC and Finishing.</p>' +
        '</div>' +
        '<div style="padding:12px 20px; background:#f8fafc; border-top:1px solid #e2e8f0; text-align:right;">' +
        '<button type="button" id="close-progress-modal-btn" class="ghost-btn" style="padding:6px 16px; font-size:13px; font-weight:600;">Close</button>' +
        '</div>' +
        '</div></div>';

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    var closeFn = function () {
        var modalEl = document.getElementById('progress-modal-overlay');
        if (modalEl) modalEl.remove();
        document.removeEventListener('keydown', keyFn);
    };
    var keyFn = function (e) {
        if (e.key === 'Escape') closeFn();
    };
    document.addEventListener('keydown', keyFn);

    var cBtn1 = document.getElementById('close-progress-modal');
    var cBtn2 = document.getElementById('close-progress-modal-btn');
    var overlay = document.getElementById('progress-modal-overlay');

    if (cBtn1) cBtn1.addEventListener('click', closeFn);
    if (cBtn2) cBtn2.addEventListener('click', closeFn);
    if (overlay) overlay.addEventListener('click', function (e) {
        if (e.target.id === 'progress-modal-overlay') closeFn();
    });
}

function renderInProgressOrders() {
    if (PIPELINE_STATUS === 'Pending') {
        return renderPendingOrders();
    }

    var orders = DATA && Array.isArray(DATA.progressOrders) ? DATA.progressOrders : null;

    if (orders && PIPELINE_STATUS === 'In Production' && IN_PRODUCTION_SUB_FILTER !== 'All') {
        orders = orders.filter(function (o) {
            var bd = getEffectiveBreakdown(o);
            if (IN_PRODUCTION_SUB_FILTER === 'In Progress') return bd.inProgress > 0;
            if (IN_PRODUCTION_SUB_FILTER === 'Prod Complete') return bd.prodComplete > 0;
            if (IN_PRODUCTION_SUB_FILTER === 'Checking Passed') return bd.checkingPassed > 0;
            if (IN_PRODUCTION_SUB_FILTER === 'Finishing Complete') return bd.finishingComplete > 0;
            if (IN_PRODUCTION_SUB_FILTER === 'In Alteration') return (bd.alteration > 0 || Number(o.remakeItems) > 0);
            return true;
        });
    }

    var displayStatus = (PIPELINE_STATUS === 'In Production' && IN_PRODUCTION_SUB_FILTER !== 'All') ? IN_PRODUCTION_SUB_FILTER : PIPELINE_STATUS;
    var h = '<section class="progress-section"><div class="pipeline-header">' +
        '<h2>' + esc(displayStatus) + ' orders</h2>';

    if (orders === null) {
        return h + '</div><p class="progress-empty">Loading live order progress…</p></section>';
    }
    if (!orders.length) {
        return h + '</div><p class="progress-empty">No sales orders are currently in ' + esc(displayStatus) + ' status.</p></section>';
    }

    h += '<span class="pipe-total">' + orders.length + ' order' + (orders.length === 1 ? '' : 's') + '</span></div>' +
        '<div class="table-wrapper"><table class="progress-table"><thead><tr>';

    if (PIPELINE_STATUS === 'Dispatched') {
        h += '<th>Sales order</th><th>Customer</th><th>Plan</th><th>Order date</th><th class="r">Dispatched / ordered</th><th>Next step</th></tr></thead><tbody>';
        orders.forEach(function (order) {
            h += '<tr><td><strong>' + esc(order.salesOrder || '—') + '</strong></td>' +
                '<td>' + esc(order.customer || '—') + '</td>' +
                '<td>' + esc(order.planNo || '—') + '</td>' +
                '<td>' + esc(order.orderDate || '—') + '</td>' +
                '<td class="r">' + n(order.producedQty) + ' / ' + n(order.orderedQty) + '</td>' +
                '<td>' + esc(order.nextStep || 'Order Fulfilled & Shipped') + '</td></tr>';
        });
    } else {
        h += '<th>Sales order</th><th>Plan</th><th>Supervisor</th><th>Item Level Progress</th>' +
            '<th class="r">Produced / ordered</th><th>Items</th></tr></thead><tbody>';

        orders.forEach(function (order) {
            var soId = String(order.id || order.salesOrder);
            var isOpen = !!OPEN_ITEM_DRAWERS[soId];
            var rem = Number(order.remakeItems) || 0;
            var remTxt = rem > 0
                ? ' <span class="pill pill-remake" title="Rework: replaces a rejected or damaged piece">' +
                  rem + ' remake' + (rem === 1 ? '' : 's') + '</span>'
                : '';

            var itemProgHtml = '<button type="button" class="sub-chip btn-open-progress-modal" data-so-id="' + esc(soId) + '" style="font-size:12px; font-weight:600; padding:4px 12px; cursor:pointer; background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; color:#334155; display:inline-flex; align-items:center; gap:6px;">' +
                '<span>📊 View Progress</span></button>';

            var itemCount = Array.isArray(order.items) ? order.items.length : (order.itemCount || 0);

            var itemSub = (order.itemName || order.firstItemName) ? '<div class="emp-sub">' + esc(order.itemName || order.firstItemName) + '</div>' : '';

            h += '<tr><td><strong>' + esc(order.salesOrder || '—') + '</strong>' + itemSub + remTxt + '</td>' +
                '<td>' + esc(order.planNo || '—') + '</td>' +
                '<td>' + esc(order.supervisor || '—') + '</td>' +
                '<td>' + itemProgHtml + '</td>' +
                '<td class="r">' + n(order.producedQty) + ' / ' + n(order.orderedQty) + '</td>' +
                '<td><button type="button" class="ghost-btn btn-toggle-drawer" data-so-id="' + esc(soId) + '">' +
                (isOpen ? 'Hide Items ▲' : 'Inspect Items (' + itemCount + ') ▼') + '</button></td></tr>';

            if (isOpen) {
                h += '<tr class="item-drawer-row"><td colspan="6">' + renderItemDrawer(order) + '</td></tr>';
            }
        });
    }
    return h + '</tbody></table></div></section>';
}

// ---- pending sales orders + manual convert ----

function renderPendingOrders() {
    var h = '<section class="progress-section"><div class="pipeline-header">' +
        '<h2>Pending sales orders</h2>';

    if (PENDING_ERROR) {
        return h + '</div><p class="pipeline-error">Could not load pending orders: ' + esc(PENDING_ERROR) + '</p></section>';
    }
    if (PENDING_ORDERS === null) {
        return h + '</div><p class="progress-empty">Loading pending sales orders…</p></section>';
    }
    if (!PENDING_ORDERS.length) {
        return h + '</div><p class="progress-empty">No sales orders are waiting. Every pending order has been turned into a plan.</p></section>';
    }

    h += '<span class="pipe-total">' + PENDING_ORDERS.length + ' waiting</span></div>' +
        '<p class="progress-hint">These have not been turned into production plans yet. ' +
        'The scheduled run retries them automatically; use <strong>Convert to plan</strong> to do one now. ' +
        'A rejected order stays here with its reason until the blocker is fixed.</p>' +
        '<div class="table-wrapper"><table class="progress-table"><thead><tr>' +
        '<th>Sales order</th><th>Customer</th><th>Order date</th><th>Source</th>' +
        '<th class="r">Items</th><th>Last attempt</th><th class="r">Action</th>' +
        '</tr></thead><tbody>';

    PENDING_ORDERS.forEach(function (o) {
        var outcome = String(o.lastOutcome || '').trim();
        var reason = String(o.rejectReason || '').trim();

        var statusCell;
        if (outcome === 'Rejected' || reason) {
            statusCell = '<span class="pill pill-rejected">Rejected</span>' +
                (reason ? '<div class="reject-reason">' + esc(reason) + '</div>' : '');
        } else if (outcome === 'Skipped') {
            statusCell = '<span class="pill pill-running">Plan exists</span>';
        } else if (outcome === 'Created') {
            statusCell = '<span class="pill pill-ok">Planned</span>';
        } else {
            statusCell = '<span class="muted">Not tried yet</span>';
        }

        var busy = CONVERTING[String(o.id)];
        var btn = '<button type="button" class="btn-convert-plan convert-btn" data-so-id="' + esc(String(o.id)) + '"' +
            (busy ? ' disabled' : '') + '>' +
            (busy ? 'Converting…' : 'Convert to plan') + '</button>';

        h += '<tr>' +
            '<td><strong>' + esc(o.salesOrder || '—') + '</strong></td>' +
            '<td>' + esc(o.customer || '—') + '</td>' +
            '<td>' + esc(o.orderDate || '—') + '</td>' +
            '<td>' + esc(o.source || '—') + '</td>' +
            '<td class="r">' + n(o.itemCount) + '</td>' +
            '<td>' + statusCell + '</td>' +
            '<td class="r">' + btn + '</td>' +
            '</tr>';
    });

    h += '</tbody></table></div></section>';
    return h;
}

function bindPendingButtons() {
    var el = document.getElementById('pipeline-section');
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.btn-convert-plan'), function (b) {
        b.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var id = b.getAttribute('data-so-id');
            if (id) convertOrderToPlan(id);
        });
    });
}

function loadPendingOrders() {
    PENDING_ERROR = '';
    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getPendingSalesOrders',
        http_method: 'GET'
    }).then(function (response) {
        try {
            var result = response && response.result !== undefined ? response.result : response;
            var data = typeof result === 'string' ? JSON.parse(result) : result;
            if (data && data.data !== undefined) data = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
            if (!data || !Array.isArray(data.orders)) throw new Error('Response did not contain a pending order list');
            PENDING_ORDERS = data.orders;
            DATA = DATA || {};
            DATA.pipeline = DATA.pipeline || {};
            DATA.pipeline.pending = data.orders.length;
            if (data.errors && data.errors.length) {
                console.warn('getPendingSalesOrders returned errors:', data.errors);
            }
            renderPipeline();
        } catch (e) {
            console.error('getPendingSalesOrders parse failed:', e, response);
            PENDING_ORDERS = [];
            PENDING_ERROR = e.message || String(e);
            renderPipeline();
        }
    }).catch(function (err) {
        console.error('getPendingSalesOrders error:', err);
        PENDING_ORDERS = [];
        PENDING_ERROR = (err && (err.message || err.toString())) || 'Request failed';
        renderPipeline();
    });
}

function convertOrderToPlan(soId) {
    if (CONVERTING[String(soId)]) return;
    CONVERTING[String(soId)] = true;
    renderPipeline();

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'convertSalesOrderToPlan',
        http_method: 'POST',
        payload: { soIdTxt: String(soId) }
    }).then(function (response) {
        var parsed = null;
        try {
            var result = response && response.result !== undefined ? response.result : response;
            parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed && parsed.data !== undefined) parsed = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
        } catch (e) {
            parsed = null;
        }

        delete CONVERTING[String(soId)];

        if (parsed && parsed.success) {
            alert(parsed.outcome === 'Skipped'
                ? (parsed.reason || 'A plan already existed — the order has been moved on.')
                : 'Plan ' + (parsed.planNo || '') + ' created.');
        } else {
            alert('Could not convert this order: ' +
                ((parsed && parsed.reason) || 'unknown error') +
                (parsed && parsed.outcome === 'Rejected'
                    ? '\n\nFix the blocker on the sales order, then try again.'
                    : ''));
        }

        // Reload both the counts and the pending list so the row leaves (or
        // shows its new reject reason) and the pipeline totals move.
        loadPipeline();
        loadPendingOrders();
    }).catch(function (err) {
        console.error('convertSalesOrderToPlan error:', err);
        delete CONVERTING[String(soId)];
        alert('Failed to reach the server. Check the browser console.');
        renderPipeline();
    });
}

function activateTab(name) {
    var employeeTab = document.getElementById('employee-tab');
    var pipelineTab = document.getElementById('pipeline-tab');
    var materialsTab = document.getElementById('materials-tab');
    var disputesTab = document.getElementById('disputes-tab');
    
    var employeePanel = document.getElementById('employee-panel');
    var pipelinePanel = document.getElementById('pipeline-panel');
    var materialsPanel = document.getElementById('materials-panel');
    var disputesPanel = document.getElementById('disputes-panel');

    if (employeeTab) {
        employeeTab.classList.toggle('is-active', name === 'employee');
        employeeTab.setAttribute('aria-selected', String(name === 'employee'));
    }
    if (pipelineTab) {
        pipelineTab.classList.toggle('is-active', name === 'pipeline');
        pipelineTab.setAttribute('aria-selected', String(name === 'pipeline'));
    }
    if (materialsTab) {
        materialsTab.classList.toggle('is-active', name === 'materials');
        materialsTab.setAttribute('aria-selected', String(name === 'materials'));
    }
    if (disputesTab) {
        disputesTab.classList.toggle('is-active', name === 'disputes');
        disputesTab.setAttribute('aria-selected', String(name === 'disputes'));
    }

    if (employeePanel) employeePanel.classList.toggle('is-active', name === 'employee');
    if (pipelinePanel) pipelinePanel.classList.toggle('is-active', name === 'pipeline');
    if (materialsPanel) materialsPanel.classList.toggle('is-active', name === 'materials');
    if (disputesPanel) disputesPanel.classList.toggle('is-active', name === 'disputes');

    if (name === 'materials') {
        EXPANDED_PATTERNS = {};
        if (MATERIALS_DATA) {
            renderMaterials();
        }
    }

    var appDate = document.getElementById('app-date');
    var dayControls = document.getElementById('day-controls');
    if (appDate) appDate.classList.toggle('hidden', name !== 'employee');
    if (dayControls) dayControls.classList.toggle('hidden', name !== 'employee');
}

// The pipeline is intentionally loaded from its own small custom function.
// It remains available even when the day-specific employee report is slow or
// when that report function has not yet been deployed in Creator.
function loadPipeline() {
    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getOrderPipelineCounts',
        // Required for this externally hosted widget: it tells the SDK which
        // Creator workspace owns the custom API endpoint shown in Creator.
        workspace_name: 'livelinenstore',
        http_method: 'POST',
        payload: {}
    }).then(function (response) {
        try {
            // Creator SDK versions return custom-API payloads either in
            // response.result or directly on response. External widgets can
            // use either shape, so accept both.
            var result = response && response.result !== undefined ? response.result : response;
            var pipeline = typeof result === 'string' ? JSON.parse(result) : result;
            // Custom APIs configured with Creator's "Standard" response put
            // a map returned by Deluge inside `data`.
            if (pipeline && pipeline.data !== undefined) {
                pipeline = typeof pipeline.data === 'string' ? JSON.parse(pipeline.data) : pipeline.data;
            }
            if (!pipeline || typeof pipeline !== 'object') throw new Error('No pipeline data returned');
            if (pipeline.pending === undefined && pipeline.inProgress === undefined &&
                pipeline.completed === undefined && pipeline.qcPassed === undefined &&
                pipeline.packed === undefined && pipeline.dispatched === undefined) {
                throw new Error('Response did not contain status counts');
            }
            DATA = DATA || {};
            DATA.pipeline = pipeline;
            DATA.pipelineError = '';
            renderPipeline();
        } catch (e) {
            console.error('getOrderPipelineCounts parse failed:', e, response);
            DATA = DATA || {};
            DATA.pipelineError = e.message || String(e);
            renderPipeline();
        }
    }).catch(function (err) {
        console.error('getOrderPipelineCounts error:', err);
        // Order Audit already uses this endpoint in the same Creator app. If
        // a newly configured pipeline endpoint is unavailable, derive the
        // exact same live totals from its current Sales_Order list instead.
        loadPipelineFromOrderAudit(err);
    });
}

function loadPipelineFromOrderAudit(originalError) {
    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getAdminCalculation',
        http_method: 'POST',
        payload: { salesOrderId: '' }
    }).then(function (response) {
        try {
            var result = response && response.result !== undefined ? response.result : response;
            var data = typeof result === 'string' ? JSON.parse(result) : result;
            if (data && data.data) data = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
            var orders = data && data.orders;
            if (!Array.isArray(orders)) throw new Error('Order Audit did not return an order list');

            var counts = { pending: 0, inProgress: 0, completed: 0, qcPassed: 0, packed: 0, dispatched: 0 };
            orders.forEach(function (order) {
                var status = String(order.status || '').trim().toLowerCase();
                if (status === 'pending') counts.pending++;
                else if (status === 'in progress') counts.inProgress++;
                else if (status === 'production complete') counts.completed++;
                else if (status === 'checking passed') counts.qcPassed++;
                else if (status === 'packed') counts.packed++;
                else if (status === 'dispatched') counts.dispatched++;
            });
            DATA = DATA || {};
            DATA.pipeline = counts;
            DATA.pipelineError = '';
            renderPipeline();
        } catch (e) {
            console.error('getAdminCalculation pipeline fallback failed:', e, response);
            DATA = DATA || {};
            DATA.pipelineError = 'Status API: ' + ((originalError && (originalError.message || originalError.toString())) || 'failed') +
                '. Order Audit fallback: ' + (e.message || String(e));
            renderPipeline();
        }
    }).catch(function (fallbackError) {
        console.error('getAdminCalculation pipeline fallback error:', fallbackError);
        DATA = DATA || {};
        DATA.pipelineError = 'Could not reach the status or Order Audit API.';
        renderPipeline();
    });
}

function loadSalesOrderProgress(statusFilter) {
    var targetStatus = statusFilter || PIPELINE_STATUS || 'In Progress';
    DATA = DATA || {};
    DATA.progressOrders = null;

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getSalesOrderProgress',
        workspace_name: 'livelinenstore',
        http_method: 'POST',
        content_type: 'application/json',
        payload: { salesOrderId: '', statusFilter: targetStatus }
    }).then(function (response) {
        try {
            var result = response && response.result !== undefined ? response.result : response;
            var data = typeof result === 'string' ? JSON.parse(result) : result;
            if (data && data.data !== undefined) data = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
            if (!data || !Array.isArray(data.orders)) throw new Error('Response did not contain order progress');
            DATA = DATA || {};
            DATA.progressOrders = data.orders;
            DATA.pipeline = DATA.pipeline || {};
            var count = data.orders.length;
            if (targetStatus === 'Pending') DATA.pipeline.pending = count;
            else if (targetStatus === 'In Progress') DATA.pipeline.inProgress = count;
            else if (targetStatus === 'Production Complete' || targetStatus === 'Prod Complete') DATA.pipeline.completed = count;
            else if (targetStatus === 'Checking Passed') DATA.pipeline.qcPassed = count;
            else if (targetStatus === 'Finishing Complete') DATA.pipeline.finishingComplete = count;
            else if (targetStatus === 'Packed') DATA.pipeline.packed = count;
            else if (targetStatus === 'Dispatched') DATA.pipeline.dispatched = count;
            renderPipeline();
        } catch (e) {
            console.error('getSalesOrderProgress parse failed:', e, response);
            DATA = DATA || {};
            DATA.progressOrders = [];
            DATA.progressError = e.message || String(e);
            renderPipeline();
        }
    }).catch(function (err) {
        console.error('getSalesOrderProgress error:', err);
        DATA = DATA || {};
        DATA.progressOrders = [];
        DATA.progressError = (err && (err.message || err.toString())) || 'Request failed';
        renderPipeline();
    });
}

// ---- the stage breakdown behind the chevron ----

function renderStages(emp) {
    var stages = emp.stages || [];
    if (!stages.length) return '<div class="muted">No stages on this day.</div>';

    var rows = stages.map(function (s) {
        var sIn = n(s.qtyIn);
        var sOut = n(s.qtyOut);
        var done = s.status === 'Done';
        var lost = done ? sIn - sOut : 0;
        var mins = spanMinutes(s.start, s.end);

        var when = '<span class="muted">—</span>';
        if (s.start || s.end) {
            when = '<span class="stage-when">' + esc(s.start || '?') + ' – ' +
                esc(s.end || (done ? '?' : 'running')) + '</span>';
        }

        var status = done
            ? '<span class="pill pill-done">Done</span>'
            : '<span class="pill pill-running">Running</span>';
        if (s.outsourced) status += ' <span class="pill pill-outsourced">Out</span>';

        var soPill = s.salesOrderStatus ? ' ' + soStatusPill(s.salesOrderStatus) : '';
        var order = s.salesOrder
            ? esc(s.salesOrder) + soPill + (s.planNo ? '<div class="emp-sub">' + esc(s.planNo) + '</div>' : '')
            : '<span class="muted">—</span>';

        return '<tr>' +
            '<td class="stage-phase">' + esc(s.phase || '—') + '</td>' +
            '<td>' + (s.item ? esc(s.item) : '<span class="muted">—</span>') + '</td>' +
            '<td>' + order + '</td>' +
            '<td class="r">' + sIn + '</td>' +
            // A running stage has no output yet — Qty_Out is only written at
            // End — so it gets a dash rather than a 0 that reads as failure.
            '<td class="r">' + (done ? String(sOut) : '<span class="muted">—</span>') + '</td>' +
            '<td class="r">' + (done ? dash(lost) : '<span class="muted">—</span>') + '</td>' +
            '<td class="r">' + when + '</td>' +
            '<td class="r">' + fmtMins(mins) + '</td>' +
            '<td>' + status + '</td>' +
            '</tr>';
    }).join('');

    // Machines are no longer recorded — each operator works a fixed one, so the
    // column asked a question the operator's own name already answers.
    //
    // A row here is one person's SHARE of a stage, not the whole stage: three
    // men splitting a cutting stage give three rows, each with what he was
    // handed and what he finished.
    return '<div class="table-wrapper"><table class="stage-table"><thead><tr>' +
        '<th>Stage</th><th>Item</th><th>Order</th>' +
        '<th class="r">In</th><th class="r">Out</th><th class="r">Lost</th>' +
        '<th class="r">Start – End</th><th class="r">Time</th><th>Status</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ---- one row per person ----

function renderRow(emp) {
    var pIn = n(emp.piecesIn);
    var pOut = n(emp.piecesOut);
    var lost = pIn - pOut;
    var open = !!OPEN[emp.id];

    // Summed over the stages that carry a readable start AND end. A stage still
    // running contributes nothing, which is correct — it has no span yet.
    var mins = 0;
    var timed = 0;
    (emp.stages || []).forEach(function (s) {
        var m = spanMinutes(s.start, s.end);
        if (m !== null) { mins += m; timed++; }
    });

    var sub = emp.unattributed
        ? 'no operator was recorded on these stages'
        : [emp.role, emp.status && emp.status !== 'Active' ? emp.status : ''].filter(Boolean).join(' · ');

    var stagesCell = '<b>' + n(emp.stagesDone) + '</b>';
    if (n(emp.stagesOpen) > 0) {
        stagesCell += '<div class="stage-sub">+' + n(emp.stagesOpen) + ' running · ' +
            n(emp.piecesInHand) + ' pcs in hand</div>';
    }

    var orders = (emp.orders || []).length;

    var row = '<tr class="rep-row' + (emp.unattributed ? ' unattributed' : '') + '">' +
        '<td class="emp-cell">' +
            '<div class="emp-name">' + esc(emp.name) + '</div>' +
            (sub ? '<div class="emp-sub">' + esc(sub) + '</div>' : '') + '</td>' +
        '<td class="r">' + stagesCell + '</td>' +
        '<td class="r">' + pIn + '</td>' +
        '<td class="r"><b>' + pOut + '</b></td>' +
        '<td class="r">' + (lost > 0 ? '<span class="lost-some">' + lost + '</span>' : dash(0)) + '</td>' +
        '<td class="r yield-cell">' + yieldCell(pIn, pOut) + '</td>' +
        '<td class="r">' + (timed > 0 ? fmtMins(mins) : '<span class="muted">—</span>') + '</td>' +
        '<td class="r">' + (orders > 0 ? orders : dash(0)) + '</td>' +
        '<td class="r"><button type="button" class="ans-toggle' + (open ? ' is-open' : '') + '" ' +
            'title="Stage by stage" aria-label="Stage by stage" ' +
            'data-emp="' + esc(emp.id) + '">' + chevronSvg() + '</button></td>' +
        '</tr>';

    return row + '<tr class="work-row" id="stages-' + esc(emp.id) + '"' + (open ? '' : ' hidden') +
        '><td colspan="9">' + renderStages(emp) + '</td></tr>';
}

// Most output first — the question is "how much did they get through". Ties
// break on stages, then on name so the order is stable between refreshes.
// Unattributed work sorts last whatever its size: it is a gap in the data, not
// a person, and it must not head a report about people.
function sortWorked(a, b) {
    if (!!a.unattributed !== !!b.unattributed) return a.unattributed ? 1 : -1;
    if (n(b.piecesOut) !== n(a.piecesOut)) return n(b.piecesOut) - n(a.piecesOut);
    if (n(b.stagesDone) !== n(a.stagesDone)) return n(b.stagesDone) - n(a.stagesDone);
    return String(a.name).localeCompare(String(b.name));
}

function renderTable() {
    var el = document.getElementById('content');
    if (!DATA) { el.innerHTML = ''; return; }

    var h = '';
    if (DATA.errors && DATA.errors.length) {
        h += '<div class="warn top">' + DATA.errors.map(esc).join('<br>') + '</div>';
    }

    var worked = (DATA.worked || []).slice().sort(sortWorked);

    if (!worked.length) {
        el.innerHTML = h + '<div class="empty-state"><div class="icon">🧵</div>' +
            '<h2>No stage work logged on this day</h2>' +
            '<p>Nothing was started or finished. Pick another date, or check that the ' +
            'supervisors recorded their stages.</p></div>';
        return;
    }

    h += '<div class="table-wrapper"><table class="rep-table"><thead><tr>' +
        '<th>Employee</th>' +
        '<th class="r">Stages</th>' +
        '<th class="r">Pieces in</th>' +
        '<th class="r">Pieces out</th>' +
        '<th class="r">Lost</th>' +
        '<th class="r">Yield</th>' +
        '<th class="r">Time logged</th>' +
        '<th class="r">Orders</th>' +
        '<th></th>' +
        '</tr></thead><tbody>' + worked.map(renderRow).join('') + '</tbody></table></div>';

    // Said once, on the screen, because every one of these has been asked
    // before and the answers are not guessable from the column headings.
    h += '<div class="aside">' +
        '<b>Pieces in</b> and <b>pieces out</b> count finished stages only, so <b>lost</b> is ' +
        'what went into a stage and did not come out of it. Pieces still on the machine are ' +
        'shown separately as <em>in hand</em> — counting them as lost would make anyone ' +
        'mid-cut look like the worst performer on the floor.' +
        '<br><b>Yield is not productivity.</b> It is output over input, so someone who worked ' +
        'one clean stage and someone who worked twenty both read 100%. Read it beside the ' +
        'pieces-out column, never on its own.' +
        '<br><b>Time logged</b> is the span from Start to End on each stage, added up — not a ' +
        'shift length. Times are stamped to the minute, so a stage started and finished inside ' +
        'one reads <em>&lt;1m</em>; a dash means the times were never recorded, or the stage is ' +
        'still running.' +
        '</div>';

    el.innerHTML = h;

    el.querySelectorAll('[data-emp]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-emp');
            var row = document.getElementById('stages-' + id);
            if (!row) return;
            row.hidden = !row.hidden;
            OPEN[id] = !row.hidden;
            btn.classList.toggle('is-open', !row.hidden);
        });
    });
}

// ---- who logged nothing ----
//
// Not "idle". Most of this list is store, wash and packing staff who never
// write a Stage_Log at all. It answers one question: is somebody's work missing
// from the report above?

function renderNoLogs() {
    var el = document.getElementById('nolog-wrap');
    if (!DATA) { el.innerHTML = ''; return; }

    var list = DATA.noLogs || [];
    if (!list.length) { el.innerHTML = ''; return; }

    var byRole = {};
    var roleOrder = [];
    list.forEach(function (p) {
        var r = p.role || 'No designation';
        if (!byRole[r]) { byRole[r] = []; roleOrder.push(r); }
        byRole[r].push(p);
    });
    roleOrder.sort();

    var body = roleOrder.map(function (r) {
        return '<div class="sub">' + esc(r) + ' <span class="muted">(' + byRole[r].length + ')</span></div>' +
            '<div class="nolog-list">' + byRole[r].map(function (p) {
                return '<span class="nolog-chip">' + esc(p.name) + '</span>';
            }).join('') + '</div>';
    }).join('');

    el.innerHTML = '<div class="nolog" id="nolog">' +
        '<button type="button" class="nolog-head" id="nolog-toggle">' +
            '<div><h2>No stage work logged — ' + list.length + ' active ' +
            (list.length === 1 ? 'employee' : 'employees') + '</h2>' +
            '<span class="muted">Store, wash, packing and dispatch staff never write stage logs, ' +
            'so most of this list is expected.</span></div>' +
            chevronSvg() + '</button>' +
        '<div class="nolog-body">' + body + '</div></div>';

    document.getElementById('nolog-toggle').addEventListener('click', function () {
        document.getElementById('nolog').classList.toggle('open');
    });
}

// ---- loading ----

function currentIso() {
    return document.getElementById('day-input').value || todayIso();
}

function setBusy(busy) {
    ['refresh-btn', 'day-prev', 'day-next', 'day-today'].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) b.disabled = busy;
    });
    if (!busy) syncDayButtons();
}

function syncDayButtons() {
    var iso = currentIso();
    // There is no work in the future. Letting the arrow run past today would
    // only ever produce an empty report and look like a fault.
    document.getElementById('day-next').disabled = iso >= todayIso();
    document.getElementById('day-today').disabled = iso === todayIso();
}

function load() {
    var iso = currentIso();
    document.getElementById('app-date').textContent = longDate(iso);
    syncDayButtons();

    document.getElementById('tiles').innerHTML = '';
    document.getElementById('nolog-wrap').innerHTML = '';
    document.getElementById('content').innerHTML =
        '<div class="skeleton-card"><div class="skeleton-line w-40"></div>' +
        '<div class="skeleton-line"></div><div class="skeleton-line w-70"></div>' +
        '<div class="skeleton-line"></div></div>';

    setBusy(true);

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getEmployeeReport',
        http_method: 'POST',
        payload: { dateTxt: toApiDate(iso) }
    }).then(function (response) {
        try {
            var result = response && response.result !== undefined ? response.result : response;
            var payload = typeof result === 'string' ? JSON.parse(result) : result;
            if (payload && payload.data !== undefined) {
                payload = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data;
            }
            var existingPipeline = DATA && DATA.pipeline;
            var existingProgress = DATA && DATA.progressOrders;
            DATA = payload;
            if (!DATA.pipeline && existingPipeline) DATA.pipeline = existingPipeline;
            if (!DATA.progressOrders && existingProgress) DATA.progressOrders = existingProgress;
        } catch (e) {
            console.error('getEmployeeReport parse failed:', e, response);
            DATA = { errors: ['Could not read the response — see the browser console.'], worked: [], noLogs: [], totals: {} };
        }
        setBusy(false);
        renderPipeline();
        renderTiles();
        renderTable();
        renderNoLogs();
    }).catch(function (err) {
        // Creator collapses every Deluge runtime failure into "code 9430", and a
        // bare 500 with no message at all is usually the statement-execution
        // limit, which cannot be caught server-side.
        console.error('getEmployeeReport error:', err);
        DATA = { errors: ['Could not load: ' + err], worked: [], noLogs: [], totals: {}, pipeline: (DATA && DATA.pipeline) || {} };
        setBusy(false);
        renderPipeline();
        renderTiles();
        renderTable();
        renderNoLogs();
    });
}

var MATERIALS_DATA = null;
var RAW_MATERIAL_FILTER = 'fabric'; // 'fabric' or 'other'
var EXPANDED_PATTERNS = {}; // grpName -> boolean
var EXPANDED_MATERIALS = {}; // materialId -> boolean
var MATERIAL_SEARCH_TERM = '';
var tabsLoaded = {};

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function fmt(n) {
    n = Number(n) || 0;
    return (Math.round(n * 100) / 100).toLocaleString();
}

function getBaseGroupName(rm) {
    var name = rm.name || '';
    var parts = name.split('/').map(function (s) { return s.trim(); });
    if (rm.isFabric) {
        var pattern = String(rm.pattern || (parts.length >= 2 ? parts[1] : '') || 'Unspecified').trim();
        return pattern;
    } else {
        var type = String(rm.type || (parts.length >= 1 ? parts[0] : '') || 'Other').trim();
        return type;
    }
}

function loadMaterials() {
    var panel = document.getElementById('materials-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="panel-loading">Loading raw materials…</div>';

    // Clear expanded states so everything collapses by default on refresh or initial load
    EXPANDED_PATTERNS = {};
    EXPANDED_MATERIALS = {};

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getRawMaterialsList',
        http_method: 'GET'
    }).then(function (response) {
        try {
            var result = response && response.result !== undefined ? response.result : response;
            var data = typeof result === 'string' ? JSON.parse(result) : result;
            if (data && data.data !== undefined) {
                data = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
            }
            MATERIALS_DATA = data.materials || [];
            renderMaterials();
        } catch (e) {
            console.error('getRawMaterialsList parse failed:', e, response);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read materials</h2><p>Check the browser console.</p></div>';
        }
    }).catch(function (err) {
        console.error('getRawMaterialsList error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

function renderMaterials() {
    var panel = document.getElementById('materials-panel');
    if (!panel) return;
    if (!MATERIALS_DATA) {
        panel.innerHTML = '<div class="panel-placeholder"><h2>No data loaded</h2></div>';
        return;
    }

    // 1. Filter by search term and isFabric
    var filtered = MATERIALS_DATA.filter(function (rm) {
        var isFabricTab = RAW_MATERIAL_FILTER === 'fabric';
        if (rm.isFabric !== isFabricTab) return false;

        if (MATERIAL_SEARCH_TERM.trim() !== '') {
            var term = MATERIAL_SEARCH_TERM.toLowerCase();
            var name = (rm.name || '').toLowerCase();
            var sku = (rm.sku || '').toLowerCase();
            return name.indexOf(term) > -1 || sku.indexOf(term) > -1;
        }
        return true;
    });

    // 2. Group by Base Name
    var grouped = {};
    var groupOrder = [];
    filtered.forEach(function (rm) {
        var grp = getBaseGroupName(rm);
        if (!grouped[grp]) {
            grouped[grp] = [];
            groupOrder.push(grp);
        }
        grouped[grp].push(rm);
    });
    groupOrder.sort();

    // 3. Ensure header and list container exist
    var listContainer = document.getElementById('materials-list-container');
    if (!listContainer) {
        var activeClassFabric = RAW_MATERIAL_FILTER === 'fabric' ? ' is-active' : '';
        var activeClassOther = RAW_MATERIAL_FILTER === 'other' ? ' is-active' : '';
        
        var headerHtml = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; flex-wrap:wrap; gap:10px;">' +
            '<nav class="tab-strip" style="margin-bottom:0; box-shadow:none; border:none; background:none; padding:0;">' +
            '<button type="button" class="tab-btn' + activeClassFabric + '" id="subtab-fabric">Fabric</button>' +
            '<button type="button" class="tab-btn' + activeClassOther + '" id="subtab-other">Other Materials</button>' +
            '</nav>' +
            '<div style="display:flex; align-items:center; gap:8px;">' +
            '<input type="search" id="mat-search" class="so-filter" placeholder="Search by name or SKU…" value="' + escapeHtml(MATERIAL_SEARCH_TERM) + '" style="margin:0; width:220px; font-size:13px; padding:6px 10px;">' +
            '</div>' +
            '</div>' +
            '<div id="materials-list-container"></div>';
        
        panel.innerHTML = headerHtml;
        listContainer = document.getElementById('materials-list-container');
        setupMaterialsHeaderListeners();
    }

    // 4. Render list inside container
    if (filtered.length === 0) {
        listContainer.innerHTML = '<div class="panel-placeholder" style="padding:40px 20px;">' +
            '<h2>No materials found</h2>' +
            '<p>Try adjusting your search filter or category selection.</p>' +
            '</div>';
        return;
    }

    var html = '<div class="materials-accordion">';
    groupOrder.forEach(function (grp) {
        var list = grouped[grp];
        var isExpanded = !!EXPANDED_PATTERNS[grp];
        var tableHtml = '';

        if (isExpanded) {
            var rows = list.map(function (rm) {
                // Stock styling
                var stockClass = rm.stock > 0 ? 'yes' : 'no';
                var stockLabel = rm.stock > 0 ? fmt(rm.stock) : 'Out';
                var unitLabel = rm.stock > 0 ? ' <span class="unit" style="color:var(--text-muted); font-size:11px;">' + escapeHtml(rm.unit) + '</span>' : '';
                
                var washLabel = rm.isFabric ? (rm.washQty > 0 ? (fmt(rm.washQty) + ' <span class="unit" style="color:var(--text-muted); font-size:11px;">' + escapeHtml(rm.unit) + '</span>') : '0') : '<span class="muted">—</span>';
                var unwashLabel = rm.isFabric ? (rm.unwashQty > 0 ? (fmt(rm.unwashQty) + ' <span class="unit" style="color:var(--text-muted); font-size:11px;">' + escapeHtml(rm.unit) + '</span>') : '0') : '<span class="muted">—</span>';
                var widthLabel = rm.isFabric ? (rm.width ? (escapeHtml(rm.width) + '"') : '<span class="muted">—</span>') : '<span class="muted">—</span>';
                var gsmLabel = rm.isFabric ? (rm.gsm ? escapeHtml(rm.gsm) : '<span class="muted">—</span>') : '<span class="muted">—</span>';
                var qualityLabel = rm.quality ? escapeHtml(rm.quality) : '<span class="muted">—</span>';

                var priceLabel = (rm.price !== undefined && rm.price !== null) ? ('₹' + fmt(rm.price)) : '<span class="muted">—</span>';
                var lastPurchaseLabel = rm.lastPurchaseDate ? escapeHtml(rm.lastPurchaseDate) : '<span class="muted">—</span>';

                var hasLots = rm.lots && rm.lots.length > 0;
                var isExpanded = hasLots && !!EXPANDED_MATERIALS[rm.id];
                var nameCell = '<td style="font-weight:700;">' +
                    '<div style="display:flex; align-items:center; gap:6px;">' +
                    (hasLots ? '<span class="mat-chevron ' + (isExpanded ? 'expanded' : '') + '">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="12" height="12" style="color:var(--text-muted);"><path d="M9 5l7 7-7 7"/></svg>' +
                    '</span>' : '') +
                    '<span>' + escapeHtml(rm.name) + '</span>' +
                    '</div>';
                if (hasLots) {
                    var lotsTextList = rm.lots.map(function (l) {
                        var lotQty = (Number(l.wash) || 0) + (Number(l.unwash) || 0);
                        var statusText = l.status === 'Blocked' ? ' (Blocked)' : '';
                        return escapeHtml(l.lotNumber) + ' - qty=' + fmt(lotQty) + (rm.unit ? ' ' + escapeHtml(rm.unit) : '') + statusText;
                    }).join(', ');
                    nameCell += '<div style="font-weight:normal; font-size:11px; color:var(--text-muted); margin-top:4px; padding-left:18px;">Lots: ' + lotsTextList + '</div>';
                }
                nameCell += '</td>';

                var rowClass = hasLots ? ('mat-row-clickable' + (isExpanded ? ' is-expanded' : '')) : '';
                var dataAttr = hasLots ? (' data-material-id="' + rm.id + '"') : '';

                var mainRowHtml = '<tr class="' + rowClass + '"' + dataAttr + '>' +
                    '<td style="font-weight:600; white-space:nowrap;">' + escapeHtml(rm.sku) + '</td>' +
                    nameCell +
                    '<td>' + (escapeHtml(rm.type) || '<span class="muted">—</span>') + '</td>' +
                    '<td>' + (escapeHtml(rm.pattern) || '<span class="muted">—</span>') + '</td>' +
                    '<td>' + (escapeHtml(rm.color) || '<span class="muted">—</span>') + '</td>' +
                    '<td>' + qualityLabel + '</td>' +
                    '<td>' + widthLabel + '</td>' +
                    '<td>' + gsmLabel + '</td>' +
                    '<td class="r" style="font-variant-numeric:tabular-nums; font-weight:600;">' + washLabel + '</td>' +
                    '<td class="r" style="font-variant-numeric:tabular-nums; font-weight:600;">' + unwashLabel + '</td>' +
                    '<td class="r ' + stockClass + '" style="font-variant-numeric:tabular-nums; font-weight:600;">' + stockLabel + unitLabel + '</td>' +
                    '<td class="r" style="font-variant-numeric:tabular-nums; font-weight:600;">' + priceLabel + '</td>' +
                    '<td style="white-space:nowrap;">' + lastPurchaseLabel + '</td>' +
                    '</tr>';

                var detailRowHtml = '';
                if (isExpanded) {
                    var lotRows = '';
                    var totalWash = 0;
                    var totalUnwash = 0;
                    var totalCombined = 0;

                    if (rm.lots && rm.lots.length > 0) {
                        lotRows = rm.lots.map(function (l) {
                            var w = Number(l.wash) || 0;
                            var u = Number(l.unwash) || 0;
                            var tot = w + u;

                            totalWash += w;
                            totalUnwash += u;
                            totalCombined += tot;

                            var statusPill = l.status === 'Blocked'
                                ? '<span class="status-pill status-danger" style="padding:2px 6px; font-size:10px; font-weight:700; border-radius:4px; background:#fee2e2; color:#991b1b;">Blocked</span>'
                                : '<span class="status-pill status-sufficient" style="padding:2px 6px; font-size:10px; font-weight:700; border-radius:4px; background:#d1fae5; color:#065f46;">Active</span>';

                            return '<tr>' +
                                '<td style="font-weight:600; padding:6px 12px;">' + escapeHtml(l.lotNumber) + '</td>' +
                                '<td class="r" style="font-variant-numeric:tabular-nums; text-align:right; padding:6px 12px;">' + fmt(w) + (rm.unit ? ' ' + escapeHtml(rm.unit) : '') + '</td>' +
                                '<td class="r" style="font-variant-numeric:tabular-nums; text-align:right; padding:6px 12px;">' + fmt(u) + (rm.unit ? ' ' + escapeHtml(rm.unit) : '') + '</td>' +
                                '<td class="r" style="font-variant-numeric:tabular-nums; font-weight:600; text-align:right; padding:6px 12px;">' + fmt(tot) + (rm.unit ? ' ' + escapeHtml(rm.unit) : '') + '</td>' +
                                '<td style="padding:6px 12px;">' + statusPill + '</td>' +
                                '</tr>';
                        }).join('');

                        lotRows += '<tr style="font-weight:700; background-color:#f1f5f9; border-top:2px solid #cbd5e1;">' +
                            '<td style="padding:8px 12px;">Total for all lots</td>' +
                            '<td class="r" style="font-variant-numeric:tabular-nums; text-align:right; padding:8px 12px;">' + fmt(totalWash) + (rm.unit ? ' ' + escapeHtml(rm.unit) : '') + '</td>' +
                            '<td class="r" style="font-variant-numeric:tabular-nums; text-align:right; padding:8px 12px;">' + fmt(totalUnwash) + (rm.unit ? ' ' + escapeHtml(rm.unit) : '') + '</td>' +
                            '<td class="r" style="font-variant-numeric:tabular-nums; text-align:right; padding:8px 12px;">' + fmt(totalCombined) + (rm.unit ? ' ' + escapeHtml(rm.unit) : '') + '</td>' +
                            '<td style="padding:8px 12px;"></td>' +
                            '</tr>';
                    } else {
                        lotRows = '<tr><td colspan="5" style="text-align:center; padding:12px; color:var(--text-muted);">No lots found for this material.</td></tr>';
                    }

                    detailRowHtml = '<tr class="lots-detail-row" style="background:#f8fafc;">' +
                        '<td></td>' +
                        '<td colspan="12" style="padding:10px 16px 16px 16px; border-bottom:1px solid var(--border);">' +
                        '<div style="font-weight:700; font-size:12px; color:var(--text-main); margin-bottom:8px;">Lot breakdown details</div>' +
                        '<div class="table-wrapper" style="box-shadow:none; border:1px solid #e2e8f0; border-radius:6px; background:#ffffff; max-width:800px; overflow:hidden; margin-top:0;">' +
                        '<table class="rep-table" style="margin-bottom:0; width:100%;">' +
                        '<thead><tr>' +
                        '<th style="background:#f1f5f9; font-weight:600; padding:6px 12px; font-size:11px;">Lot Number</th>' +
                        '<th class="r" style="background:#f1f5f9; font-weight:600; padding:6px 12px; font-size:11px; text-align:right; width:22%;">Wash Qty</th>' +
                        '<th class="r" style="background:#f1f5f9; font-weight:600; padding:6px 12px; font-size:11px; text-align:right; width:22%;">Unwash Qty</th>' +
                        '<th class="r" style="background:#f1f5f9; font-weight:600; padding:6px 12px; font-size:11px; text-align:right; width:22%;">Total Qty</th>' +
                        '<th style="background:#f1f5f9; font-weight:600; padding:6px 12px; font-size:11px; width:15%;">Status</th>' +
                        '</tr></thead>' +
                        '<tbody>' + lotRows + '</tbody>' +
                        '</table>' +
                        '</div>' +
                        '</td>' +
                        '</tr>';
                }

                return mainRowHtml + detailRowHtml;
            }).join('');

            tableHtml = '<div class="item-body">' +
                '<div class="table-wrapper" style="margin-top:0; border-top:none; border-top-left-radius:0; border-top-right-radius:0;">' +
                '<table class="rep-table" style="margin-bottom:0;">' +
                '<thead><tr>' +
                '<th style="width:9%">SKU</th>' +
                '<th style="width:16%">Item Name</th>' +
                '<th style="width:8%">Type</th>' +
                '<th style="width:8%">Pattern</th>' +
                '<th style="width:7%">Color</th>' +
                '<th style="width:7%">Quality</th>' +
                '<th style="width:6%">Width</th>' +
                '<th style="width:6%">GSM</th>' +
                '<th class="r" style="width:6%">Wash Qty</th>' +
                '<th class="r" style="width:6%">Unwash Qty</th>' +
                '<th class="r" style="width:7%">Total Qty</th>' +
                '<th class="r" style="width:7%">Item Price</th>' +
                '<th style="width:7%">Last Purchase</th>' +
                '</tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
                '</table>' +
                '</div>' +
                '</div>';
        }

        // Card header style matching disputes or issues
        var expandedHeaderStyle = isExpanded ? 'border-bottom-left-radius:0; border-bottom-right-radius:0;' : '';
        html += '<div class="item-card' + (isExpanded ? ' open' : '') + '" style="margin-bottom:12px; border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow-sm);">' +
            '<button type="button" class="group-header-btn" data-pattern="' + escapeHtml(grp) + '" style="display:flex; width:100%; align-items:center; justify-content:space-between; padding:12px 16px; background:#f8fafc; border:none; text-align:left; font:inherit; font-weight:700; color:var(--text-main); cursor:pointer; ' + expandedHeaderStyle + '">' +
            '<span>' + escapeHtml(grp) + ' <span style="font-weight:400; color:var(--text-muted); font-size:12px; margin-left:6px;">(' + list.length + ')</span></span>' +
            '<span class="chevron" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
                    'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
            '</span>' +
            '</button>' +
            tableHtml +
            '</div>';
    });
    html += '</div>';

    listContainer.innerHTML = html;
    setupAccordionListeners();
}

function setupMaterialsHeaderListeners() {
    var subFabric = document.getElementById('subtab-fabric');
    if (subFabric) {
        subFabric.addEventListener('click', function () {
            RAW_MATERIAL_FILTER = 'fabric';
            subFabric.classList.add('is-active');
            var subOther = document.getElementById('subtab-other');
            if (subOther) subOther.classList.remove('is-active');
            renderMaterials();
        });
    }

    var subOther = document.getElementById('subtab-other');
    if (subOther) {
        subOther.addEventListener('click', function () {
            RAW_MATERIAL_FILTER = 'other';
            subOther.classList.add('is-active');
            var subFabric = document.getElementById('subtab-fabric');
            if (subFabric) subFabric.classList.remove('is-active');
            renderMaterials();
        });
    }

    var search = document.getElementById('mat-search');
    if (search) {
        search.addEventListener('input', function () {
            MATERIAL_SEARCH_TERM = search.value;
            renderMaterials();
        });
        search.addEventListener('search', function () {
            MATERIAL_SEARCH_TERM = search.value;
            renderMaterials();
        });
    }
}

function setupAccordionListeners() {
    var container = document.getElementById('materials-list-container');
    if (!container) return;
    container.querySelectorAll('.group-header-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var pat = btn.getAttribute('data-pattern');
            var isCurrentlyExpanded = !!EXPANDED_PATTERNS[pat];
            EXPANDED_PATTERNS = {};
            if (!isCurrentlyExpanded) {
                EXPANDED_PATTERNS[pat] = true;
            }
            renderMaterials();
        });
    });

    container.querySelectorAll('.mat-row-clickable').forEach(function (row) {
        row.addEventListener('click', function () {
            var matId = row.getAttribute('data-material-id');
            EXPANDED_MATERIALS[matId] = !EXPANDED_MATERIALS[matId];
            renderMaterials();
        });
    });
}

var adminDisputes = [];
var adminDisputeCounts = {
    openInbound: 0,
    resolvedInbound: 0,
    openOutbound: 0,
    resolvedOutbound: 0,
    totalOpen: 0,
    totalResolved: 0
};

function isLocalStandalone() {
    return (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') && window.self === window.top;
}

function loadAdminDisputes() {
    var panel = document.getElementById('disputes-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="panel-loading">Loading disputes…</div>';

    if (isLocalStandalone()) {
        setTimeout(function () {
            adminDisputeCounts = {
                totalOpen: 3,
                totalResolved: 8,
                openInbound: 1,
                resolvedInbound: 5,
                openOutbound: 2,
                resolvedOutbound: 3
            };
            adminDisputes = [
                {
                    id: "100000000000000001",
                    material: "Linen / Olive",
                    unit: "m",
                    isWaste: true,
                    direction: "Inbound",
                    width: 150,
                    length: 45,
                    supervisor: "John Doe",
                    salesOrder: "SO-12345",
                    planNo: "PLAN-987",
                    issued: 10,
                    received: 8,
                    remaining: 2,
                    resolved: 0,
                    raisedOn: "12-Aug-2026",
                    raisedNote: "Fewer pieces found on return than declared by supervisor.",
                    supervisorDenied: false,
                    storeDenied: false
                },
                {
                    id: "100000000000000002",
                    material: "Cotton / White",
                    unit: "m",
                    isWaste: false,
                    direction: "Outbound",
                    supervisor: "Jane Smith",
                    salesOrder: "SO-54321",
                    planNo: "PLAN-765",
                    issued: 25,
                    received: 20,
                    remaining: 5,
                    resolved: 0,
                    raisedOn: "10-Aug-2026",
                    raisedNote: "Received less raw material roll length than marked on ticket.",
                    supervisorDenied: true,
                    storeDenied: false
                }
            ];
            renderAdminDisputes();
        }, 600);
        return;
    }

    var p1 = ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreCounts',
        workspace_name: 'livelinenstore',
        http_method: 'GET'
    });

    var p2 = ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreDisputes',
        workspace_name: 'livelinenstore',
        http_method: 'GET'
    });

    Promise.all([p1, p2]).then(function (results) {
        try {
            var r1 = results[0];
            var r2 = results[1];

            var res1 = typeof r1.result === 'string' ? JSON.parse(r1.result) : r1.result;
            if (res1 && res1.data !== undefined) res1 = typeof res1.data === 'string' ? JSON.parse(res1.data) : res1.data;

            var res2 = typeof r2.result === 'string' ? JSON.parse(r2.result) : r2.result;
            if (res2 && res2.data !== undefined) res2 = typeof res2.data === 'string' ? JSON.parse(res2.data) : res2.data;

            adminDisputeCounts.totalOpen = res1.openDisputes || 0;
            adminDisputeCounts.totalResolved = res1.resolvedDisputes || 0;
            adminDisputeCounts.openInbound = res1.openInbound || 0;
            adminDisputeCounts.resolvedInbound = res1.resolvedInbound || 0;
            adminDisputeCounts.openOutbound = res1.openOutbound || 0;
            adminDisputeCounts.resolvedOutbound = res1.resolvedOutbound || 0;

            adminDisputes = res2.disputes || [];
            
            renderAdminDisputes();
        } catch (e) {
            console.error('loadAdminDisputes parse failed:', e, results);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read disputes</h2><p>Check the browser console.</p></div>';
        }
    }).catch(function (err) {
        console.error('loadAdminDisputes API failed:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load disputes</h2><p>Check the browser console.</p></div>';
    });
}

function renderAdminDisputes() {
    var panel = document.getElementById('disputes-panel');
    if (!panel) return;

    var summaryHtml = '' +
        '<div class="tiles">' +
            '<div class="tile tile-people" style="border-left-color: #3b82f6;">' +
                '<span class="tile-label">Store Disputes (Inbound)</span>' +
                '<span class="tile-value" style="font-variant-numeric: tabular-nums;">' + adminDisputeCounts.openInbound + '</span>' +
                '<span class="tile-sub">' + adminDisputeCounts.resolvedInbound + ' resolved · raised by store person</span>' +
            '</div>' +
            '<div class="tile tile-stages" style="border-left-color: #f59e0b;">' +
                '<span class="tile-label">Supervisor Disputes (Outbound)</span>' +
                '<span class="tile-value" style="font-variant-numeric: tabular-nums;">' + adminDisputeCounts.openOutbound + '</span>' +
                '<span class="tile-sub">' + adminDisputeCounts.resolvedOutbound + ' resolved · raised by supervisor</span>' +
            '</div>' +
            '<div class="tile tile-out" style="border-left-color: #10b981;">' +
                '<span class="tile-label">Total Disputes</span>' +
                '<span class="tile-value" style="font-variant-numeric: tabular-nums;">' + adminDisputeCounts.totalOpen + '</span>' +
                '<span class="tile-sub">' + adminDisputeCounts.totalResolved + ' total resolved disputes</span>' +
            '</div>' +
        '</div>';

    var tableHtml = '';
    if (adminDisputes.length === 0) {
        tableHtml = '' +
            '<div class="empty-state" style="margin-top: 20px;">' +
                '<div class="icon">🧵</div>' +
                '<h2>No open disputes</h2>' +
                '<p>All materials and waste returns are fully accounted for.</p>' +
            '</div>';
    } else {
        var rows = adminDisputes.map(function (d) {
            var isIb = d.direction === 'Inbound';
            var dirBadge = isIb
                ? '<span class="pill pill-running" style="background:#eff6ff; color:#1e40af; font-size:10px;">Inbound / Store</span>'
                : '<span class="pill pill-done" style="background:#fffbeb; color:#854d0e; font-size:10px;">Outbound / Supervisor</span>';

            var materialDetails = '<strong>' + escapeHtml(d.material || '—') + '</strong>';
            if (d.isWaste && d.length > 0) {
                materialDetails += '<div class="emp-sub">' + fmt(d.length) + ' &times; ' + fmt(d.width) + ' cm</div>';
            }
            if (d.salesOrder) {
                materialDetails += '<div class="emp-sub">' + escapeHtml(d.salesOrder) + (d.planNo ? ' · ' + escapeHtml(d.planNo) : '') + '</div>';
            }

            var checkState = '';
            if (d.supervisorDenied && d.storeDenied) {
                checkState = '<div class="emp-sub" style="color:var(--status-danger); font-weight:600;">Both denied (Lost)</div>';
            } else if (d.supervisorDenied) {
                checkState = '<div class="emp-sub" style="color:var(--status-warning); font-weight:600;">Supervisor denied</div>';
            } else if (d.storeDenied) {
                checkState = '<div class="emp-sub" style="color:var(--status-warning); font-weight:600;">Store denied</div>';
            }

            return '<tr>' +
                '<td>' + materialDetails + '</td>' +
                '<td>' + escapeHtml(d.supervisor || '—') + '</td>' +
                '<td>' + dirBadge + '</td>' +
                '<td class="r" style="font-variant-numeric: tabular-nums;">' + fmt(d.issued) + ' <span class="unit" style="font-size:11px; color:var(--text-muted);">' + escapeHtml(d.unit || '') + '</span></td>' +
                '<td class="r" style="font-variant-numeric: tabular-nums;">' + fmt(d.received) + ' <span class="unit" style="font-size:11px; color:var(--text-muted);">' + escapeHtml(d.unit || '') + '</span></td>' +
                '<td class="r" style="font-variant-numeric: tabular-nums; font-weight:700; color:var(--status-danger);">' + fmt(d.remaining) + ' <span class="unit" style="font-size:11px; color:var(--text-muted); font-weight:normal;">' + escapeHtml(d.unit || '') + '</span>' + checkState + '</td>' +
                '<td>' + escapeHtml(d.raisedOn || '—') + '</td>' +
                '<td style="white-space:normal; max-width:250px; font-size:12px; color:var(--text-muted);">' + escapeHtml(d.raisedNote || '—') + '</td>' +
                '</tr>';
        }).join('');

        tableHtml = '' +
            '<div class="item-card" style="margin-top: 20px; border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow-sm);">' +
                '<div class="pipeline-header pipeline-toolbar" style="padding:14px 16px; background:#f8fafc; border-bottom:1px solid var(--border);">' +
                    '<div>' +
                        '<h2 style="margin:0; font-size:13px; font-weight:700; letter-spacing:0.03em; text-transform:uppercase; color:var(--text-muted);">Active Disputes Details</h2>' +
                        '<span class="pipeline-help" style="display:block; margin-top:3px; font-size:12px; color:var(--text-muted);">Details of outstanding disputes currently in process</span>' +
                    '</div>' +
                '</div>' +
                '<div class="table-wrapper" style="margin-top:0; border-top:none; border-top-left-radius:0; border-top-right-radius:0;">' +
                    '<table class="rep-table" style="margin-bottom:0; width:100%; border-collapse:collapse;">' +
                        '<thead><tr>' +
                            '<th>Material</th>' +
                            '<th>Supervisor</th>' +
                            '<th>Direction / Raiser</th>' +
                            '<th class="r">Handed Over</th>' +
                            '<th class="r">Confirmed</th>' +
                            '<th class="r">Outstanding</th>' +
                            '<th>Raised On</th>' +
                            '<th>Raiser\'s Note</th>' +
                        '</tr></thead>' +
                        '<tbody>' + rows + '</tbody>' +
                    '</table>' +
                '</div>' +
            '</div>';
    }

    panel.innerHTML = summaryHtml + tableHtml;
}

// ---- wiring ----
//
// Creator JS API v2. No init() — the SDK resolves the app context itself, and
// the previous version of this page carried a three-second timeout fallback to
// work around an init() that was never needed.

document.addEventListener('DOMContentLoaded', function () {
    var input = document.getElementById('day-input');
    input.value = todayIso();
    input.max = todayIso();

    input.addEventListener('change', load);

    document.getElementById('employee-tab').addEventListener('click', function () {
        activateTab('employee');
    });
    document.getElementById('pipeline-tab').addEventListener('click', function () {
        activateTab('pipeline');
        loadPipeline();
        loadSalesOrderProgress();
        if (PIPELINE_STATUS === 'Pending') loadPendingOrders();
    });
    document.getElementById('materials-tab').addEventListener('click', function () {
        activateTab('materials');
        if (!tabsLoaded['materials']) {
            tabsLoaded['materials'] = true;
            loadMaterials();
        }
    });
    document.getElementById('disputes-tab').addEventListener('click', function () {
        activateTab('disputes');
        tabsLoaded['disputes'] = true;
        loadAdminDisputes();
    });

    document.getElementById('day-prev').addEventListener('click', function () {
        input.value = shiftDays(currentIso(), -1);
        load();
    });

    document.getElementById('day-next').addEventListener('click', function () {
        var next = shiftDays(currentIso(), 1);
        if (next > todayIso()) return;
        input.value = next;
        load();
    });

    document.getElementById('day-today').addEventListener('click', function () {
        input.value = todayIso();
        load();
    });

    // Explicit, not polled. The old page re-ran four separate APIs every ten
    // seconds; a report of a day that is mostly already over does not change
    // fast enough to be worth the load, and the operator whose row was open
    // would have had it re-rendered under his name mid-read.
    document.getElementById('refresh-btn').addEventListener('click', function () {
        load();
        loadPipeline();
        loadSalesOrderProgress();
        if (PENDING_ORDERS !== null || PIPELINE_STATUS === 'Pending') {
            loadPendingOrders();
        }
        if (tabsLoaded['materials']) {
            loadMaterials();
        }
        if (tabsLoaded['disputes']) {
            loadAdminDisputes();
        }
    });

    // Render an explicit loading state. Only counts returned by the Creator
    // backend are displayed; zero is shown only when the backend returns zero.
    activateTab('pipeline');
    renderPipeline();
    loadPipeline();
    loadSalesOrderProgress();
    load();
});
