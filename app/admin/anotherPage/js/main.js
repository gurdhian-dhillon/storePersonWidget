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
var PIPELINE_STATUS = 'In Progress';

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

function renderPipeline() {
    var el = document.getElementById('pipeline-section');
    if (!el) return;

    var p = (DATA && DATA.pipeline) ? DATA.pipeline : {};
    var hasLiveCounts = p.pending !== undefined || p.inProgress !== undefined ||
        p.completed !== undefined || p.qcPassed !== undefined ||
        p.finishingComplete !== undefined ||
        p.packed !== undefined || p.dispatched !== undefined;
    // One card per Order_Status the picklist offers, in workflow order. A status
    // missing from this list does not show as zero - its orders vanish from the
    // pipeline and the total silently stops matching the number of orders.
    var items = [
        { label: 'Pending', count: p.pending, cls: 'so-pending' },
        { label: 'In Progress', count: p.inProgress, cls: 'so-progress' },
        { label: 'Prod Complete', count: p.completed, cls: 'so-complete' },
        { label: 'Checking Passed', count: p.qcPassed, cls: 'so-qc' },
        { label: 'Finishing Complete', count: p.finishingComplete, cls: 'so-finishing' },
        { label: 'Packed', count: p.packed, cls: 'so-packed' },
        { label: 'Dispatched', count: p.dispatched, cls: 'so-dispatched' }
    ];
    var totalOrders = 0;
    for (var i = 0; i < items.length; i++) {
        totalOrders += n(items[i].count);
    }

    var cardsHtml = items.map(function(x) {
        return '<button type="button" class="pipe-card ' + x.cls + (x.label === PIPELINE_STATUS ? ' is-selected' : '') + '" data-status="' + esc(x.label) + '">' +
            '<span class="pipe-count">' + (hasLiveCounts ? n(x.count) : '—') + '</span>' +
            '<span class="pipe-label">' + esc(x.label) + '</span>' +
            '</button>';
    }).join('');

    el.innerHTML = '<div class="pipeline-header pipeline-toolbar">' +
        '<div><h2>Sales Order Pipeline</h2><span class="pipeline-help">Follow each sales order through the workflow.</span></div>' +
        '<span class="pipe-total">' + (hasLiveCounts ? totalOrders + ' total sales orders' : 'Loading live counts…') + '</span>' +
        '</div>' +
        '<div class="pipeline-grid">' + cardsHtml + '</div>' +
        (DATA && DATA.pipelineError
            ? '<p class="pipeline-error">Could not load live status counts: ' + esc(DATA.pipelineError) + '</p>'
            : '') +
        renderInProgressOrders();

    Array.prototype.forEach.call(el.querySelectorAll('.pipe-card'), function (tab) {
        tab.addEventListener('click', function () {
            PIPELINE_STATUS = tab.getAttribute('data-status');
            renderPipeline();
        });
    });
}

function renderInProgressOrders() {
    var orders = DATA && Array.isArray(DATA.progressOrders) ? DATA.progressOrders : null;
    var h = '<section class="progress-section"><div class="pipeline-header">' +
        '<h2>' + esc(PIPELINE_STATUS) + ' Orders</h2>';

    if (PIPELINE_STATUS !== 'In Progress') {
        return h + '</div><p class="progress-empty">Choose In Progress to see the live production stage, quantities and next step.</p></section>';
    }

    if (orders === null) {
        return h + '<span class="pipe-total">Loading live order progress…</span></div></section>';
    }
    if (!orders.length) {
        return h + '</div><p class="progress-empty">No sales orders are currently In Progress.</p></section>';
    }

    h += '<span class="pipe-total">' + orders.length + ' live orders</span></div>' +
        '<div class="table-wrapper"><table class="progress-table"><thead><tr>' +
        '<th>Sales order</th><th>Plan</th><th>Supervisor</th><th>Current stage</th>' +
        '<th class="r">Produced / ordered</th><th>Next step</th></tr></thead><tbody>';

    orders.forEach(function (order) {
        // WHAT THE STAGE HAS PUT OUT, beside the stage it belongs to.
        //
        // Produced / ordered reads 0 for almost the whole life of an order:
        // Plan_Item.Qty_Produced is written only when the LAST stage closes, so
        // the column sits at zero through every stage and then jumps to the
        // full figure. An order showing "Machine Quilting · Completed" next to
        // "0 / 6" looks stalled when six pieces have just come off that stage.
        //
        // Not merged into the produced column — those are two different
        // questions and a column has to mean the same thing on every row. This
        // is one stage's output; produced is the finished garment count.
        var out = Number(order.stageOut) || 0;
        var stage = order.currentStage
            ? esc(order.currentStage) +
              (order.currentStageStatus ? ' <span class="pill pill-running">' + esc(order.currentStageStatus) + '</span>' : '') +
              (out > 0 ? '<span class="stage-out">' + n(out) + ' out</span>' : '')
            : '<span class="muted">Not started</span>';

        // Rework is not demand, so it is not in the quantities — but "this order
        // has been made twice" is exactly what a dashboard is for, so it is said
        // where it cannot be mistaken for a count of pieces.
        var rem = Number(order.remakeItems) || 0;
        var remTxt = rem > 0
            ? ' <span class="pill pill-remake" title="Rework: replaces a rejected or damaged piece, so it is not counted as extra demand">' +
              rem + ' remake' + (rem === 1 ? '' : 's') + '</span>'
            : '';

        h += '<tr><td><strong>' + esc(order.salesOrder || '—') + '</strong>' + remTxt + '</td>' +
            '<td>' + esc(order.planNo || '—') + '</td>' +
            '<td>' + esc(order.supervisor || '—') + '</td>' +
            '<td>' + stage + '</td>' +
            '<td class="r">' + n(order.producedQty) + ' / ' + n(order.orderedQty) + '</td>' +
            '<td>' + esc(order.nextStep || '—') + '</td></tr>';
    });
    return h + '</tbody></table></div></section>';
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

function loadSalesOrderProgress() {
    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getSalesOrderProgress',
        workspace_name: 'livelinenstore',
        http_method: 'POST',
        content_type: 'application/json',
        payload: { salesOrderId: '' }
    }).then(function (response) {
        try {
            var result = response && response.result !== undefined ? response.result : response;
            var data = typeof result === 'string' ? JSON.parse(result) : result;
            if (data && data.data !== undefined) data = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
            if (!data || !Array.isArray(data.orders)) throw new Error('Response did not contain order progress');
            DATA = DATA || {};
            DATA.progressOrders = data.orders;
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

                return '<tr>' +
                    '<td style="font-weight:600; white-space:nowrap;">' + escapeHtml(rm.sku) + '</td>' +
                    '<td style="font-weight:700;">' + escapeHtml(rm.name) + '</td>' +
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
