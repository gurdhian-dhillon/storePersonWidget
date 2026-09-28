/* ==========================================================================
 * SALES ORDER PIPELINE — the admin's view of every order, from the moment it
 * arrives until it is packed. Data comes from pipeline-data.js (getRecords
 * joins) and three Custom APIs: getOrderPipelineCounts (the strip),
 * getPendingSalesOrders + convertSalesOrderToPlan (Pending), and
 * getPackingHistory (what went into the boxes).
 *
 * WHAT IT ANSWERS, in the order an admin asks it:
 *   1. Where is the work?            the strip: one count per stage of the flow
 *   2. What needs me?                "needs attention": overdue, waiting for
 *                                    material (and whose move it is), stalled
 *   3. Where are THIS order's pieces?  one expand per order: every piece placed
 *                                    — waiting for material, in production (by
 *                                    stage), waiting for checking, finishing,
 *                                    finished — and the same per line
 *   4. What went out in the boxes?   Packed: boxes, pieces, weights, invoice
 *
 * WHAT IT REPLACED. A "View progress" pop-up whose numbers were guessed from
 * one stage name per order (an order with every piece through checking read
 * "5 in QC queue, 0 passed"), counted remake BATCHES as "alteration pieces",
 * and sat beside an "Inspect items" drawer that said something different. And
 * an "In Production" card that, once clicked, loaded only In Progress orders
 * — an overdue order at Checking Passed simply left the list. There is one
 * expand per order now, and every number in it is placed from a record.
 *
 * Dispatch is not built yet (nothing writes Dispatched); that view is kept
 * exactly as it was.
 * ========================================================================== */

// ---- state -----------------------------------------------------------------
//
// Its own object, NOT the shared DATA the employee report owns: that report
// replaces DATA wholesale on every day change, which is how this tab used to
// lose its error messages.
var PIPE = {
    view: 'active',          // 'pending' | 'active' | 'packed' | 'dispatched'
    status: '',              // active only: '' = every active status, or one Order_Status
    risk: '',                // active only: 'late' | 'risk' | 'blocked' | 'stuck'
    sup: '',                 // active only: supervisor id, '' = everyone
    search: '',
    page: 1,
    pageSize: 25,
    open: {},                // soId -> true when its detail is expanded
    detailBusy: {},          // soId -> true while its full records load
    counts: null, countsError: '',
    orders: { active: null, packed: null, dispatched: null },
    errors: { active: '', packed: '', dispatched: '' },
    notes: { active: '', packed: '', dispatched: '' },
    // Packed / Dispatched show what reached the status in this many days
    // (0 = all) — nothing writes Dispatched yet, so Packed only ever grows.
    windowDays: { packed: 30, dispatched: 30 },
    older: { packed: 0, dispatched: 0 },
    loadedAt: { active: null, packed: null, dispatched: null, pending: null },
    flash: null,             // { text, bad } — the result of Convert, on the page
    landed: false,           // the first-load "open where the work is" has run
    packings: null, packingError: '',
    loadSeq: { active: 0, packed: 0, dispatched: 0 }
};

// main.js's Refresh button reads these two names.
var PIPELINE_STATUS = 'In Production';
var PENDING_ORDERS = null;
var PENDING_ERROR = '';
var PENDING_SEARCH_TERM = '';
var CONVERTING = {};

// The four statuses between "planned" and "packed", in the order they run,
// with the words an admin uses for them. Order_Status values are stored with
// spaces (CLAUDE.md) and printed nowhere raw on this screen.
var ACTIVE_STEPS = [
    { status: 'In Progress',         key: 'inProgress',        label: 'In production', sub: 'cutting, stitching…' },
    { status: 'Production Complete', key: 'completed',         label: 'Checking',      sub: 'with the checker' },
    { status: 'Checking Passed',     key: 'qcPassed',          label: 'Finishing',     sub: 'folding, pressing' },
    { status: 'Finishing Complete',  key: 'finishingComplete', label: 'Ready to pack', sub: 'waiting for packing' }
];

function plStepOf(status) {
    for (var i = 0; i < ACTIVE_STEPS.length; i++) if (ACTIVE_STEPS[i].status === status) return ACTIVE_STEPS[i];
    return null;
}

// Where a piece can be, in the order it moves. `cls` drives colour everywhere
// (bar segment, legend dot, chip) so a colour means one thing on the screen.
var PL_PLACES = [
    { key: 'waitingMaterial',  cls: 'pk-material', label: 'Waiting for material' },
    { key: 'readyToStart',     cls: 'pk-ready',    label: 'Ready to start' },
    { key: 'inProduction',     cls: 'pk-prod',     label: 'In production' },
    { key: 'awaitingCheck',    cls: 'pk-check',    label: 'Waiting for checking' },
    { key: 'waitingFinishing', cls: 'pk-passed',   label: 'Passed, waiting for finishing' },
    { key: 'inFinishing',      cls: 'pk-finishing', label: 'In finishing' },
    { key: 'finished',         cls: 'pk-done',     label: 'Finished' }
];

var PL_FLOW_LABEL = {
    check_remake: 'Remake — rejected at checking',
    production_loss: 'Remake — lost in production',
    alteration: 'Alteration'
};

// ---- small helpers ---------------------------------------------------------

// Escapes quotes too — values land in title="" attributes, where main.js's
// esc() (which leaves quotes alone) would break the markup.
function plH(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function plN(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
function plPcs(v) { v = plN(v); return v + (v === 1 ? ' pc' : ' pcs'); }
function plKg(v) {
    v = plN(v);
    if (v <= 0) return '—';
    return (Math.round(v * 100) / 100).toFixed(2) + ' kg';
}
function plDate(v) {
    if (typeof PipelineData === 'undefined') return String(v || '');
    var d = PipelineData.parseDate(v);
    if (!d) return String(v || '');
    var mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var s = d.getDate() + ' ' + mons[d.getMonth()];
    if (d.getFullYear() !== new Date().getFullYear()) s += ' ' + d.getFullYear();
    return s;
}
function plMark(text, q) {
    var s = String(text === null || text === undefined ? '' : text);
    q = (q || '').trim();
    if (!q) return plH(s);
    var i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return plH(s);
    return plH(s.slice(0, i)) + '<mark class="search-highlight">' + plH(s.slice(i, i + q.length)) + '</mark>' +
        plMark(s.slice(i + q.length), q);
}
function plChev(open) {
    return '<span class="pl-chev' + (open ? ' is-open' : '') + '" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></span>';
}

// The API may hand the payload back as response.result, response itself, or
// wrapped once more in .data (Creator's "Standard" response) — accept all.
function plParse(response) {
    var result = response && response.result !== undefined ? response.result : response;
    var data = typeof result === 'string' ? JSON.parse(result) : result;
    if (data && data.data !== undefined) data = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
    return data;
}

// ---- counts ----------------------------------------------------------------

function plCount(key) {
    return PIPE.counts ? plN(PIPE.counts[key]) : null;
}
function plActiveTotal() {
    if (!PIPE.counts) return null;
    return ACTIVE_STEPS.reduce(function (a, s) { return a + plN(PIPE.counts[s.key]); }, 0);
}

// Once a list is loaded its length IS the count, and it is exact — the counts
// API may be the Order Audit fallback, which only sees the newest 200 orders.
// So a loaded list always wins over the strip's first guess.
function plSyncCounts() {
    if (!PIPE.counts) PIPE.counts = {};
    if (Array.isArray(PIPE.orders.active)) {
        ACTIVE_STEPS.forEach(function (s) {
            PIPE.counts[s.key] = PIPE.orders.active.filter(function (o) { return o.status === s.status; }).length;
        });
    }
    if (Array.isArray(PENDING_ORDERS) && !PENDING_ERROR) PIPE.counts.pending = PENDING_ORDERS.length;
    ['packed', 'dispatched'].forEach(function (v) {
        if (Array.isArray(PIPE.orders[v]) && !PIPE.errors[v]) PIPE.counts[v] = PIPE.orders[v].length + plN(PIPE.older[v]);
    });
}

// Only red news goes on a tile: how many are late, how many pending orders
// could not be planned. Everything softer waits in the attention bar, so the
// strip stays a strip of numbers.
function plLateIn(status) {
    if (!Array.isArray(PIPE.orders.active) || typeof PipelineData === 'undefined') return 0;
    return PIPE.orders.active.filter(function (o) {
        return o.status === status && PipelineData.risk(o).some(function (r) { return r.level === 'late'; });
    }).length;
}
function plRejectedPending() {
    if (!Array.isArray(PENDING_ORDERS)) return 0;
    return PENDING_ORDERS.filter(function (o) {
        return String(o.lastOutcome || '').trim() === 'Rejected' || String(o.rejectReason || '').trim();
    }).length;
}
function plBadge(n, word) {
    return n ? '<span class="pl-badge">' + n + ' ' + plH(word) + '</span>' : '';
}

// ---- the strip ---------------------------------------------------------------
//
// The whole flow in one row, in the order it runs. The four factory steps sit
// inside one group whose header is itself a button — "everything in the
// factory" is the view an admin lands on and comes back to, and each step
// inside narrows it to one stage.
function plStripHtml() {
    var num = function (v) { return v === null ? '—' : String(v); };
    var on = function (view, status) {
        return PIPE.view === view && (status === undefined || PIPE.status === status) ? ' is-on' : '';
    };

    var steps = ACTIVE_STEPS.map(function (s) {
        return '<button type="button" class="pl-step pl-step-' + s.key + on('active', s.status) + '" ' +
            'data-act="view" data-view="active" data-status="' + plH(s.status) + '">' +
            plBadge(plLateIn(s.status), 'late') +
            '<span class="pl-step-num">' + num(plCount(s.key)) + '</span>' +
            '<span class="pl-step-label">' + plH(s.label) + '</span>' +
            '<span class="pl-step-sub">' + plH(s.sub) + '</span></button>';
    }).join('<span class="pl-arrow" aria-hidden="true">›</span>');

    return '<div class="pl-strip">' +
        '<button type="button" class="pl-step pl-step-pending' + on('pending') + '" data-act="view" data-view="pending">' +
            plBadge(plRejectedPending(), 'rejected') +
            '<span class="pl-step-num">' + num(plCount('pending')) + '</span>' +
            '<span class="pl-step-label">Pending</span><span class="pl-step-sub">not planned yet</span></button>' +
        '<span class="pl-arrow" aria-hidden="true">›</span>' +
        '<div class="pl-group' + (PIPE.view === 'active' ? ' is-on' : '') + '">' +
            '<button type="button" class="pl-group-head' + (PIPE.view === 'active' && !PIPE.status ? ' is-on' : '') +
                '" data-act="view" data-view="active" data-status="">' +
                '<span>In the factory</span><b>' + num(plActiveTotal()) + '</b>' +
                '<span class="pl-group-all">' + (PIPE.view === 'active' && !PIPE.status ? 'showing all' : 'show all') + '</span></button>' +
            '<div class="pl-group-steps">' + steps + '</div>' +
        '</div>' +
        '<span class="pl-arrow" aria-hidden="true">›</span>' +
        '<button type="button" class="pl-step pl-step-packed' + on('packed') + '" data-act="view" data-view="packed">' +
            '<span class="pl-step-num">' + num(plCount('packed')) + '</span>' +
            '<span class="pl-step-label">Packed</span><span class="pl-step-sub">ready to dispatch</span></button>' +
        '<span class="pl-arrow" aria-hidden="true">›</span>' +
        '<button type="button" class="pl-step pl-step-dispatched' + on('dispatched') + '" data-act="view" data-view="dispatched">' +
            '<span class="pl-step-num">' + num(plCount('dispatched')) + '</span>' +
            '<span class="pl-step-label">Dispatched</span><span class="pl-step-sub">shipped</span></button>' +
    '</div>';
}

// ---- pieces: bar, legend, chips ----------------------------------------------

// The segments of one order or line, in flow order, plus the two leftovers:
// short-closed (deliberately not made) and not accounted for (a data gap).
function plSegments(pos, extra) {
    var segs = [];
    PL_PLACES.forEach(function (p) {
        var v = pos ? plN(pos[p.key]) : 0;
        if (v > 0) segs.push({ key: p.key, cls: p.cls, label: p.label, qty: v });
    });
    if (extra && extra.shortClosed > 0) segs.push({ key: 'short', cls: 'pk-short', label: 'Short-closed — not being made', qty: extra.shortClosed });
    if (extra && extra.unplaced > 0) segs.push({ key: 'unplaced', cls: 'pk-unknown', label: 'Not accounted for', qty: extra.unplaced });
    return segs;
}

function plBarHtml(segs, big) {
    var total = segs.reduce(function (a, s) { return a + s.qty; }, 0);
    if (!total) return '<div class="pl-bar' + (big ? ' is-big' : '') + ' is-empty"></div>';
    return '<div class="pl-bar' + (big ? ' is-big' : '') + '">' + segs.map(function (s) {
        return '<span class="' + s.cls + '" style="width:' + ((s.qty / total) * 100).toFixed(2) + '%" ' +
            'title="' + plH(s.qty + ' — ' + s.label) + '"></span>';
    }).join('') + '</div>';
}

// "In production" is split by stage in the legend — "22 · Stitching 22" says
// where, which is the question the old pop-up could never answer.
function plStageText(pos) {
    if (!pos || !pos.stageOrder || !pos.stageOrder.length) return '';
    return pos.stageOrder.map(function (ph) { return ph + ' ' + pos.stages[ph].qty; }).join(' · ');
}

function plLegendHtml(segs, pos) {
    return '<div class="pl-legend">' + segs.map(function (s) {
        var sub = '';
        if (s.key === 'inProduction') sub = plStageText(pos);
        if (s.key === 'waitingMaterial' && pos) {
            var bits = [];
            if (pos.waitingStore) bits.push(pos.waitingStore + ' for the store to issue');
            if (pos.waitingRequest) bits.push(pos.waitingRequest + ' not requested by the supervisor');
            sub = bits.join(' · ');
        }
        return '<span class="pl-key"><i class="' + s.cls + '"></i><b>' + s.qty + '</b> ' + plH(s.label) +
            (sub ? ' <small>' + plH(sub) + '</small>' : '') + '</span>';
    }).join('') + '</div>';
}

// One line's pieces as chips, one per (flow, place). Rework batches carry
// their own label so "2 at Stitching" on a remake is not read as the order
// line's own progress.
function plLineChips(line) {
    var chips = [];
    (line.flows || []).forEach(function (f) {
        var pos = f.pos || {};
        var tag = f.flowType !== 'original'
            ? '<em>' + plH(f.flowType === 'alteration' ? 'Alteration' : (f.flowType === 'production_loss' ? 'Loss remake' : 'Remake')) + '</em>'
            : '';
        PL_PLACES.forEach(function (p) {
            var v = plN(pos[p.key]);
            if (!v) return;
            var txt = p.label;
            if (p.key === 'inProduction') {
                txt = pos.stageOrder && pos.stageOrder.length
                    ? 'at ' + pos.stageOrder.join(' / ') : 'in production';
            } else if (p.key === 'waitingMaterial') {
                txt = pos.waitingRequest >= v ? 'waiting — supervisor to request material'
                    : 'waiting for material from store';
            } else {
                txt = txt.charAt(0).toLowerCase() + txt.slice(1);
            }
            chips.push('<span class="pl-chip ' + p.cls + (f.flowType !== 'original' ? ' is-rework' : '') + '">' +
                tag + '<b>' + v + '</b> ' + plH(txt) + '</span>');
        });
        if (pos.cancelled) {
            chips.push('<span class="pl-chip pk-short is-rework">' + tag + '<b>' + pos.cancelled + '</b> not being made (short-closed)</span>');
        }
    });
    if (line.unplaced > 0) {
        chips.push('<span class="pl-chip pk-unknown"><b>' + line.unplaced + '</b> not accounted for</span>');
    }
    return chips.join('') || '<span class="muted">—</span>';
}

// ---- search / filter ---------------------------------------------------------

function plMatches(o, q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return true;
    var hay = [o.salesOrder, o.customerName, o.planNo, o.supervisor, o.source];
    (o.items || []).forEach(function (it) { hay.push(it.name); hay.push(it.sku); });
    return hay.some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
}

function plBucket(view) {
    var all = PIPE.orders[view];
    if (!Array.isArray(all)) return all;
    if (view === 'active' && PIPE.status) {
        all = all.filter(function (o) { return o.status === PIPE.status; });
    }
    return all;
}

function plVisible(view) {
    var list = plBucket(view);
    if (!Array.isArray(list)) return list;
    if (view === 'active' && PIPE.sup) list = list.filter(function (o) { return (o.supervisorId || o.supervisor) === PIPE.sup; });
    if (PIPE.search.trim()) list = list.filter(function (o) { return plMatches(o, PIPE.search); });
    if (view === 'active' && PIPE.risk && typeof PipelineData !== 'undefined') {
        list = list.filter(function (o) {
            return PipelineData.risk(o).some(function (r) { return r.level === PIPE.risk; });
        });
    }
    return list;
}

// ---- toolbar -----------------------------------------------------------------

// One option per supervisor holding work in this bucket, with how many orders
// and how many of them are late — the load on each floor at a glance.
function plSupSelectHtml() {
    var base = plBucket('active');
    if (!Array.isArray(base) || !base.length) return '';
    var sups = {}, keys = [];
    base.forEach(function (o) {
        var k = o.supervisorId || o.supervisor;
        if (!k) return;
        if (!sups[k]) { sups[k] = { name: o.supervisor || 'Unassigned', n: 0, late: 0 }; keys.push(k); }
        sups[k].n++;
        if (typeof PipelineData !== 'undefined' &&
            PipelineData.risk(o).some(function (r) { return r.level === 'late'; })) sups[k].late++;
    });
    if (keys.length < 2 && !PIPE.sup) return '';
    keys.sort(function (a, b) { return sups[a].name.localeCompare(sups[b].name); });
    return '<select class="pl-sup" id="pl-sup" aria-label="Supervisor">' +
        '<option value="">All supervisors</option>' + keys.map(function (k) {
            var s = sups[k];
            return '<option value="' + plH(k) + '"' + (PIPE.sup === k ? ' selected' : '') + '>' +
                plH(s.name) + ' — ' + s.n + ' order' + (s.n === 1 ? '' : 's') + (s.late ? ', ' + s.late + ' late' : '') +
                '</option>';
        }).join('') + '</select>';
}

function plUpdatedHtml(key) {
    var t = PIPE.loadedAt[key];
    if (!t) return '';
    var h = t.getHours(), m = t.getMinutes();
    return '<span class="pl-updated" title="Refresh to read again">Updated ' + ((h % 12) || 12) + ':' +
        (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM') + '</span>';
}

function plToolbarHtml(title, sub, view) {
    var list = plVisible(view);
    var base = plBucket(view);
    var count = '';
    if (Array.isArray(base)) {
        count = (list.length !== base.length)
            ? '<b>' + list.length + '</b> of ' + base.length
            : '<b>' + base.length + '</b> order' + (base.length === 1 ? '' : 's');
    }
    return '<div class="pl-toolbar">' +
        '<div class="pl-title"><h3>' + plH(title) + '</h3>' + (sub ? '<span>' + plH(sub) + '</span>' : '') + '</div>' +
        '<div class="pl-tools">' +
            plUpdatedHtml(PIPE.view === 'pending' ? 'pending' : view) +
            (PIPE.view === 'active' ? plSupSelectHtml() : '') +
            '<label class="pl-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
                'stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>' +
                '<input type="search" id="pl-search" placeholder="Order, customer, item or SKU" value="' + plH(PIPE.search) + '" ' +
                'aria-label="Search orders"></label>' +
            '<span class="pl-count" id="pl-count">' + count + '</span>' +
        '</div></div>';
}

// ---- needs attention -----------------------------------------------------------

function plAttentionHtml(orders) {
    if (typeof PipelineData === 'undefined' || !orders || !orders.length) return '';
    var tally = { late: 0, risk: 0, blocked: 0, stuck: 0 };
    orders.forEach(function (o) {
        var seen = {};
        PipelineData.risk(o).forEach(function (r) {
            if (tally[r.level] === undefined || seen[r.level]) return;
            seen[r.level] = true;
            tally[r.level]++;
        });
    });
    var defs = [
        { key: 'late', label: 'overdue', why: 'past the expected delivery date and not yet packed' },
        { key: 'risk', label: 'at risk', why: 'due within a week, and some pieces have not started production' },
        { key: 'blocked', label: 'waiting for material', why: 'pieces that cannot start until material is issued — or requested' },
        { key: 'stuck', label: 'idle 14+ days', why: 'nothing recorded in a fortnight — no stage, check, finishing step or material receipt' }
    ];
    // Pending orders the plan-builder rejected are the admin's to fix (a
    // missing BOM, usually), and nothing else on this screen says so.
    var rej = plRejectedPending();
    var link = rej
        ? '<button type="button" class="pl-risk-link" data-act="view" data-view="pending"><b>' + rej + '</b> pending order' +
          (rej === 1 ? '' : 's') + ' could not be planned →</button>'
        : '';
    if (!defs.some(function (d) { return tally[d.key]; })) {
        return '<div class="pl-attn is-clear">✓ Nothing here is overdue, at risk, waiting for material or idle.' + link + '</div>';
    }
    var h = '<div class="pl-attn"><span class="pl-attn-label">Needs attention</span>';
    defs.forEach(function (d) {
        if (!tally[d.key]) return;
        h += '<button type="button" class="pl-risk pl-risk-' + d.key + (PIPE.risk === d.key ? ' is-on' : '') + '" ' +
            'data-act="risk" data-risk="' + d.key + '" title="' + plH(d.why) + '"><b>' + tally[d.key] + '</b> ' +
            plH(d.label) + '</button>';
    });
    if (PIPE.risk) h += '<button type="button" class="pl-risk-clear" data-act="risk" data-risk="">Show all</button>';
    return h + link + '</div>';
}

// ---- the active list -----------------------------------------------------------

function plDueHtml(o) {
    if (!o.dueDate) return '<span class="muted">—</span>';
    var d = o.daysToDue;
    var note = '', cls = '';
    if (d !== null && o.status !== 'Dispatched') {
        if (d < 0) { cls = ' is-late'; note = Math.abs(d) + 'd late'; }
        else if (d === 0) { cls = ' is-today'; note = 'today'; }
        else note = 'in ' + d + 'd';
    }
    return '<span class="pl-due' + cls + '">' + plH(plDate(o.dueDate)) +
        (note ? '<small>' + plH(note) + '</small>' : '') + '</span>';
}

// The list says which stage the ORDER is at and nothing finer. Which
// production stage its pieces are in is one click down, in the expand.
function plStatusHtml(o) {
    var st = plStepOf(o.status);
    var label = st ? st.label : o.status;
    return '<span class="pl-status pl-status-' + (st ? st.key : 'other') + '">' + plH(label) + '</span>';
}

function plPiecesCellHtml(o) {
    var segs = plSegments(o.pos, { shortClosed: o.shortPieces, unplaced: o.shortClosed ? 0 : o.unplaced });
    return '<div class="pl-pieces">' + plBarHtml(segs, false) +
        '<span class="pl-pieces-txt"><b>' + plN(o.finishedQty) + '</b> of ' + plN(o.orderedQty) + ' finished</span></div>';
}

// Size · colour under a line's name, once the expand has read Item_Master —
// two sizes of one product are two lines, and this is what tells them apart.
function plVariant(line) {
    var bits = [line.size, line.color].filter(function (s) { return String(s || '').trim(); });
    return bits.length ? '<span class="pl-variant">' + plH(bits.join(' · ')) + '</span>' : '';
}

function plActiveRowHtml(o) {
    var q = PIPE.search;
    var soId = String(o.id);
    var open = !!PIPE.open[soId];
    var rk = (typeof PipelineData !== 'undefined') ? PipelineData.worstRisk(o) : null;
    var flag = rk ? '<span class="pl-flag pl-flag-' + rk.level + '" title="' + plH(rk.why) + '">' + plH(rk.label) + '</span>' : '';

    var h = '<tr class="pl-row' + (open ? ' is-open' : '') + (rk ? ' has-flag flag-' + rk.level : '') + '" ' +
        'data-act="toggle" data-so="' + plH(soId) + '" tabindex="0" aria-expanded="' + open + '">' +
        '<td class="pl-c-order">' + plChev(open) +
            '<div class="pl-order"><div class="pl-order-top"><b>' + plMark(o.salesOrder || '—', q) + '</b>' + flag + '</div>' +
            '<div class="pl-order-sub">' + plMark(o.customerName || '—', q) +
                (o.items && o.items.length ? ' · ' + o.items.length + ' line' + (o.items.length === 1 ? '' : 's') : '') +
            '</div></div></td>' +
        '<td class="pl-c-due">' + plDueHtml(o) + '</td>' +
        '<td class="pl-c-sup">' + plMark(o.supervisor || '—', q) + '</td>' +
        '<td class="pl-c-status">' + plStatusHtml(o) + '</td>' +
        '<td class="pl-c-pieces">' + plPiecesCellHtml(o) + '</td>' +
        '</tr>';
    if (open) h += '<tr class="pl-detail-row"><td colspan="5">' + plDetailHtml(o) + '</td></tr>';
    return h;
}

// THE ONE EXPAND. Replaces both "View progress" and "Inspect items": the whole
// order's pieces placed, then the same line by line. Facts first, so the order
// is identified before its numbers are read.
function plDetailHtml(o) {
    // Customer, due date and supervisor are already on the row above — the
    // expand adds only what the row does not say.
    var facts = [
        ['Plan', o.planNo], ['Ordered on', plDate(o.orderDate)],
        ['Last activity', o.lastMovement ? plDate(o.lastMovement) + (o.daysSinceMovement ? ' (' + o.daysSinceMovement + 'd ago)' : ' (today)') : '']
    ].filter(function (f) { return f[1]; }).map(function (f) {
        return '<span><small>' + plH(f[0]) + '</small>' + plH(f[1]) + '</span>';
    }).join('');

    var banner = o.shortClosed
        ? '<div class="pl-short">Short-closed' + (o.shortCloseReason ? ' — ' + plH(o.shortCloseReason) : '') +
          '. ' + plPcs(o.shortPieces) + ' of the ' + o.orderedQty + ' ordered will not be made.</div>'
        : '';

    var segs = plSegments(o.pos, { shortClosed: o.shortPieces, unplaced: o.shortClosed ? 0 : o.unplaced });
    var rw = o.pos ? o.pos.rework : null;
    var rework = [];
    if (rw && rw.check_remake) rework.push(plPcs(rw.check_remake) + ' being remade after checking rejected them');
    if (rw && rw.production_loss) rework.push(plPcs(rw.production_loss) + ' being remade after being lost in production');
    if (rw && rw.alteration) rework.push(plPcs(rw.alteration) + ' in alteration');

    var lines = (o.items || []).map(function (line) {
        return '<tr><td class="pl-i-name"><b>' + plMark(line.name, PIPE.search) + '</b>' +
                (line.sku ? '<span class="pl-sku">' + plMark(line.sku, PIPE.search) + '</span>' : '') +
                plVariant(line) + '</td>' +
            '<td class="pl-i-num">' + plN(line.ordered) + '</td>' +
            '<td><div class="pl-i-where">' + plLineChips(line) + '</div></td>' +
            '<td class="pl-i-num' + (line.pos.rejected ? ' is-bad' : '') + '">' + (line.pos.rejected || '—') + '</td>' +
            '<td class="pl-i-num' + (line.pos.lost ? ' is-bad' : '') + '">' + (line.pos.lost || '—') + '</td>' +
            '</tr>';
    }).join('');

    var busy = !!PIPE.detailBusy[String(o.id)];
    var status = busy ? '<p class="pl-d-loading">Reading this order\'s stage history…</p>'
        : (o.detailNote ? '<p class="pl-note">' + plH(o.detailNote) + '</p>' : '');

    return '<div class="pl-detail">' + banner +
        '<div class="pl-facts">' + facts + '</div>' + status +
        '<div class="pl-d-head"><h4>Where the ' + plN(o.orderedQty) + ' pieces are</h4>' +
            '<span><b>' + plN(o.finishedQty) + '</b> finished · ' + o.pct + '%</span></div>' +
        plBarHtml(segs, true) +
        plLegendHtml(segs, o.pos) +
        (rework.length ? '<div class="pl-rework">Rework: ' + plH(rework.join(' · ')) + '. These are included above.</div>' : '') +
        (lines
            ? '<div class="pl-items-wrap"><table class="pl-items"><thead><tr>' +
              '<th>Order line</th><th class="pl-i-num">Ordered</th><th>Where the pieces are</th>' +
              '<th class="pl-i-num" title="Pieces the checker rejected (they are being remade)">Rejected</th>' +
              '<th class="pl-i-num" title="Pieces a production stage lost (they are being remade)">Lost</th>' +
              '</tr></thead><tbody>' + lines + '</tbody></table></div>'
            : '<p class="muted">No items could be read for this order.</p>') +
        '</div>';
}

function plPagerHtml(total) {
    var pages = Math.max(1, Math.ceil(total / PIPE.pageSize));
    if (pages <= 1) return '';
    var from = (PIPE.page - 1) * PIPE.pageSize + 1;
    var to = Math.min(total, PIPE.page * PIPE.pageSize);
    var btns = '';
    var start = Math.max(1, Math.min(PIPE.page - 2, pages - 4));
    for (var p = start; p <= Math.min(pages, start + 4); p++) {
        btns += '<button type="button" class="pl-page' + (p === PIPE.page ? ' is-on' : '') + '" data-act="page" data-page="' + p + '">' + p + '</button>';
    }
    return '<div class="pl-pager"><span>Showing <b>' + from + '–' + to + '</b> of <b>' + total + '</b></span><div>' +
        '<button type="button" class="pl-page" data-act="page" data-page="' + (PIPE.page - 1) + '"' + (PIPE.page <= 1 ? ' disabled' : '') + '>‹ Prev</button>' +
        btns +
        '<button type="button" class="pl-page" data-act="page" data-page="' + (PIPE.page + 1) + '"' + (PIPE.page >= pages ? ' disabled' : '') + '>Next ›</button>' +
        '</div></div>';
}

function plPaged(list) {
    var pages = Math.max(1, Math.ceil(list.length / PIPE.pageSize));
    if (PIPE.page > pages) PIPE.page = pages;
    if (PIPE.page < 1) PIPE.page = 1;
    var from = (PIPE.page - 1) * PIPE.pageSize;
    return list.slice(from, from + PIPE.pageSize);
}

function plLoadStateHtml(view, what) {
    if (PIPE.errors[view]) return '<p class="pipeline-error">Could not load ' + plH(what) + ': ' + plH(PIPE.errors[view]) + '</p>';
    if (PIPE.orders[view] === null) return '<p class="progress-empty">Loading ' + plH(what) + '…</p>';
    return '';
}

function plActiveBodyHtml() {
    var wait = plLoadStateHtml('active', 'orders');
    if (wait) return wait;
    var base = plBucket('active');
    var step = plStepOf(PIPE.status);
    if (!base.length) {
        return '<p class="progress-empty">' + (step ? 'No orders are at ' + plH(step.label.toLowerCase()) + ' right now.'
            : 'No orders are in the factory right now.') + '</p>';
    }
    var list = plVisible('active');
    var h = plFlashHtml() + plAttentionHtml(base);
    if (PIPE.notes.active) h += '<p class="pl-note">' + plH(PIPE.notes.active) + '</p>';
    if (!list.length) {
        return h + '<p class="progress-empty">Nothing matches' + (PIPE.search.trim() ? ' "' + plH(PIPE.search.trim()) + '"' : ' that filter') + '.</p>';
    }
    var rows = plPaged(list).map(plActiveRowHtml).join('');
    return h +
        '<div class="pl-table-wrap"><table class="pl-table"><thead><tr>' +
        '<th class="pl-c-order">Order</th><th class="pl-c-due">Due</th><th class="pl-c-sup">Supervisor</th>' +
        '<th class="pl-c-status">Stage</th><th class="pl-c-pieces">Pieces</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        plPagerHtml(list.length);
}

// ---- packed ----------------------------------------------------------------------
//
// What an admin needs about a packed order before it leaves: how many boxes,
// how many pieces against what was ordered, what it weighs for the courier
// (chargeable = the greater of gross and volumetric), whether the invoice went
// through, and — one click down — what is in each box.

function plPackFor(o) {
    var bySo = PIPE.packings && PIPE.packings.bySo;
    return bySo ? bySo[String(o.salesOrder || '').trim()] || null : null;
}

function plInvoiceHtml(pk) {
    if (!pk) return '<span class="muted">—</span>';
    var st = String(pk.gadInvoiceStatus || '').trim();
    if (!st) return '<span class="muted">not sent</span>';
    var cls = /done|posted|created|success/i.test(st) ? 'is-ok' : (/fail|error/i.test(st) ? 'is-bad' : '');
    return '<span class="pl-inv ' + cls + '" title="' + plH(pk.gadInvoiceError || '') + '">' + plH(st) +
        (pk.gadInvoiceNo ? '<small>' + plH(pk.gadInvoiceNo) + '</small>' : '') + '</span>';
}


// How long ago, in words a person says: "today", "1 day ago", "9 days ago".
function plAgo(v) {
    if (typeof PipelineData === 'undefined') return '';
    var d = PipelineData.daysFromToday(v);
    if (d === null) return '';
    d = -d;
    return d <= 0 ? 'today' : d + ' day' + (d === 1 ? '' : 's') + ' ago';
}

function plPackedRowHtml(o) {
    var q = PIPE.search;
    var soId = String(o.id);
    var open = !!PIPE.open[soId];
    var pk = plPackFor(o);
    var rk = (typeof PipelineData !== 'undefined') ? PipelineData.worstRisk(o) : null;
    var flag = rk ? '<span class="pl-flag pl-flag-' + rk.level + '" title="' + plH(rk.why) + '">' + plH(rk.label) + '</span>' : '';
    var pcs = pk ? plN(pk.pieces) : null;
    var short = pcs !== null && pcs < plN(o.orderedQty);
    // How long it has sat packed, not whether its delivery date passed:
    // dispatch is not built, so a packed order past its date may well be gone.
    var ago = pk ? plAgo(pk.packedOn) : '';
    var old = pk && PipelineData.daysFromToday(pk.packedOn) !== null && -PipelineData.daysFromToday(pk.packedOn) > 14;

    var h = '<tr class="pl-row' + (open ? ' is-open' : '') + (rk ? ' has-flag flag-' + rk.level : '') + '" ' +
        'data-act="toggle" data-so="' + plH(soId) + '" tabindex="0" aria-expanded="' + open + '">' +
        '<td class="pl-c-order">' + plChev(open) +
            '<div class="pl-order"><div class="pl-order-top"><b>' + plMark(o.salesOrder || '—', q) + '</b>' + flag + '</div>' +
            '<div class="pl-order-sub">' + plMark(o.customerName || '—', q) +
                (o.source && o.source !== o.customerName ? ' · ' + plH(o.source) : '') + '</div></div></td>' +
        '<td class="pl-c-packed">' + (pk ? plH(plDate(pk.packedOn)) + (pk.packedBy ? '<small>' + plH(pk.packedBy) + '</small>' : '') +
            (ago ? '<span class="pl-ago' + (old ? ' is-old' : '') + '">' + plH(ago) + '</span>' : '') : '<span class="muted">—</span>') + '</td>' +
        '<td class="pl-c-num">' + (pk ? plN(pk.boxCount) : '—') + '</td>' +
        '<td class="pl-c-num">' + (pk ? '<span class="' + (short ? 'is-bad' : '') + '">' + pcs + '</span> / ' + plN(o.orderedQty) : '— / ' + plN(o.orderedQty)) + '</td>' +
        '<td class="pl-c-num">' + (pk ? '<b>' + plKg(pk.chargeableWeight) + '</b>' : '—') + '</td>' +
        '<td class="pl-c-inv">' + plInvoiceHtml(pk) + '</td>' +
        '</tr>';
    if (open) h += '<tr class="pl-detail-row"><td colspan="6">' + plPackedDetailHtml(o, pk) + '</td></tr>';
    return h;
}

function plPackedDetailHtml(o, pk) {
    if (!pk) {
        return '<div class="pl-detail"><p class="muted">No packing record found for ' + plH(o.salesOrder) +
            ' among the 50 most recent. Open it on the packing screen\'s History tab.</p></div>';
    }
    var facts = [
        ['Due', o.dueDate ? plDate(o.dueDate) : ''], ['Supervisor', pk.supervisor || o.supervisor],
        ['Gross', plKg(pk.grossWeight)], ['Volumetric', plKg(pk.volumetricWeight)],
        ['Photos', pk.imageCount ? String(pk.imageCount) : '']
    ].filter(function (f) { return f[1] && f[1] !== '—'; }).map(function (f) {
        return '<span><small>' + plH(f[0]) + '</small>' + plH(f[1]) + '</span>';
    }).join('');

    var short = plN(pk.pieces) < plN(o.orderedQty)
        ? '<div class="pl-short">' + plPcs(plN(o.orderedQty) - plN(pk.pieces)) + ' fewer packed than ordered' +
          (o.shortClosed ? ' — the order was short-closed' + (o.shortCloseReason ? ': ' + plH(o.shortCloseReason) : '') : '') + '.</div>'
        : '';

    var boxes = (pk.boxes || []).map(function (b) {
        var dims = (plN(b.outerLength) || plN(b.outerWidth) || plN(b.outerHeight))
            ? plN(b.outerLength) + ' × ' + plN(b.outerWidth) + ' × ' + plN(b.outerHeight) + ' cm' : '';
        var items = (b.items || []).map(function (it) {
            return '<li><span>' + plH(it.itemName || it.sku || 'Item') + (it.sku ? ' <small>' + plH(it.sku) + '</small>' : '') +
                '</span><b>× ' + plN(it.qty) + '</b></li>';
        }).join('');
        return '<div class="pl-box"><div class="pl-box-head"><b>Box ' + plN(b.boxNo) + '</b>' +
            '<span>' + plH(b.carton || '') + (dims ? ' · ' + plH(dims) : '') + '</span></div>' +
            '<ul>' + (items || '<li class="muted">No items recorded</li>') + '</ul>' +
            '<div class="pl-box-foot">' + plKg(b.grossWeight) + ' gross · ' + plKg(b.volumetricWeight) + ' vol.</div></div>';
    }).join('');

    return '<div class="pl-detail">' + short + '<div class="pl-facts">' + facts + '</div>' +
        '<div class="pl-d-head"><h4>' + plN(pk.boxCount) + ' box' + (plN(pk.boxCount) === 1 ? '' : 'es') + ' · ' +
        plPcs(pk.pieces) + '</h4></div>' +
        '<div class="pl-boxes">' + (boxes || '<p class="muted">No boxes on the record.</p>') + '</div></div>';
}

// "Showing orders packed in the last 30 days · 12 older · Show older". Nothing
// writes Dispatched yet, so without it Packed would list — and join — every
// order the company has ever shipped.
function plWindowHtml(view, verb) {
    var days = PIPE.windowDays[view];
    var older = plN(PIPE.older[view]);
    if (days > 0 && !older) return '';
    if (days > 0) {
        return '<p class="pl-window">Showing orders ' + verb + ' in the <b>last ' + days + ' days</b> · ' + older +
            ' older · <button type="button" data-act="window" data-view="' + view + '" data-days="0">Show older</button></p>';
    }
    return '<p class="pl-window">Showing every order ' + verb + ' · <button type="button" data-act="window" data-view="' +
        view + '" data-days="30">Last 30 days only</button></p>';
}

function plPackedBodyHtml() {
    var wait = plLoadStateHtml('packed', 'packed orders');
    if (wait) return wait;
    var base = plBucket('packed');
    var win = plWindowHtml('packed', 'packed');
    if (!base.length) return win + '<p class="progress-empty">No orders were packed in this period.</p>';
    var list = plVisible('packed');
    var h = win;
    if (PIPE.packingError) h += '<p class="pl-note">Box details could not be read — ' + plH(PIPE.packingError) + '</p>';
    if (PIPE.notes.packed) h += '<p class="pl-note">' + plH(PIPE.notes.packed) + '</p>';
    if (!list.length) return h + '<p class="progress-empty">Nothing matches "' + plH(PIPE.search.trim()) + '".</p>';
    return h + '<div class="pl-table-wrap"><table class="pl-table"><thead><tr>' +
        '<th class="pl-c-order">Order</th><th class="pl-c-packed">Packed</th>' +
        '<th class="pl-c-num">Boxes</th><th class="pl-c-num">Pieces packed / ordered</th>' +
        '<th class="pl-c-num" title="The greater of gross and volumetric weight — what the courier bills">Chargeable wt</th>' +
        '<th class="pl-c-inv">Invoice</th>' +
        '</tr></thead><tbody>' + plPaged(list).map(plPackedRowHtml).join('') + '</tbody></table></div>' +
        plPagerHtml(list.length);
}

// ---- dispatched — unchanged until dispatch is built ------------------------------

function plDispatchedBodyHtml() {
    var wait = plLoadStateHtml('dispatched', 'dispatched orders');
    if (wait) return wait;
    var base = plBucket('dispatched');
    var win = plWindowHtml('dispatched', 'dispatched');
    if (!base.length) return win + '<p class="progress-empty">No sales orders are currently in Dispatched status.</p>';
    var list = plVisible('dispatched');
    if (!list.length) return win + '<p class="progress-empty">Nothing matches "' + plH(PIPE.search.trim()) + '".</p>';
    var h = win + '<div class="table-wrapper"><table class="progress-table"><thead><tr>' +
        '<th>Sales order</th><th>Customer</th><th>Plan</th><th>Order date</th><th class="r">Dispatched / ordered</th><th>Next step</th></tr></thead><tbody>';
    plPaged(list).forEach(function (order) {
        h += '<tr class="so-card-row">' +
            '<td class="td-so-header"><div class="so-title-line"><div class="so-num-wrap"><strong>' + plMark(order.salesOrder || '—', PIPE.search) + '</strong></div></div></td>' +
            '<td class="td-cust">' + plH(order.customer || '—') + '</td>' +
            '<td class="td-plan">' + plH(order.planNo || '—') + '</td>' +
            '<td class="td-date">' + plH(order.orderDate || '—') + '</td>' +
            '<td class="td-qty r">' + plN(order.producedQty) + ' / ' + plN(order.orderedQty) + '</td>' +
            '<td class="td-status"><span class="pill pill-so-status so-dispatched">Order Fulfilled &amp; Shipped</span></td></tr>';
    });
    return h + '</tbody></table></div>' + plPagerHtml(list.length);
}

// ---- pending — not yet planned ------------------------------------------------------

function plPendingItems(o) {
    if (o.itemsSummary && typeof o.itemsSummary === 'string') {
        return o.itemsSummary.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    var m = String(o.rejectReason || '').match(/No BOM for:\s*([^,|]+)/i);
    return m && m[1] ? [m[1].trim()] : [];
}

function plIsRejected(o) {
    return String(o.lastOutcome || '').trim() === 'Rejected' || !!String(o.rejectReason || '').trim();
}

// Soonest due first, undated last — the same urgency the factory list uses.
// A rejected order due in five days is the one to fix first.
function plPendingVisible() {
    if (!Array.isArray(PENDING_ORDERS)) return PENDING_ORDERS;
    var q = PIPE.search.trim().toLowerCase();
    var list = !q ? PENDING_ORDERS.slice() : PENDING_ORDERS.filter(function (o) {
        var hay = [o.salesOrder, o.customer, o.source].concat(plPendingItems(o));
        return hay.some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
    });
    list.sort(function (a, b) {
        var av = (a.daysToDue === undefined || a.daysToDue === null) ? null : a.daysToDue;
        var bv = (b.daysToDue === undefined || b.daysToDue === null) ? null : b.daysToDue;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return av - bv;
    });
    return list;
}

function plPendingBodyHtml() {
    if (PENDING_ERROR) return '<p class="pipeline-error">Could not load pending orders: ' + plH(PENDING_ERROR) + '</p>';
    if (PENDING_ORDERS === null) return '<p class="progress-empty">Loading pending sales orders…</p>';
    if (!PENDING_ORDERS.length) return plFlashHtml() + '<p class="progress-empty">No sales orders are waiting. Every pending order has been turned into a plan.</p>';
    var list = plPendingVisible();
    if (!list.length) return '<p class="progress-empty">Nothing matches "' + plH(PIPE.search.trim()) + '".</p>';

    var rows = plPaged(list).map(function (o) {
        var outcome = String(o.lastOutcome || '').trim();
        var reason = String(o.rejectReason || '').trim();
        var rejected = plIsRejected(o);
        var status;
        if (rejected) {
            status = '<span class="pl-status pl-status-bad">Could not plan</span>' + (reason ? '<small class="pl-reject">' + plH(reason) + '</small>' : '');
        } else if (outcome === 'Skipped') status = '<span class="pl-status">Plan exists</span>';
        else if (outcome === 'Created') status = '<span class="pl-status pl-status-finishingComplete">Planned</span>';
        else status = '<span class="muted">Not tried yet</span>';
        var busy = CONVERTING[String(o.id)];
        // Three names and a count — a Faire order can carry a hundred lines.
        var items = plPendingItems(o);
        var shown = items.slice(0, 3).join(', ') + (items.length > 3 ? ' +' + (items.length - 3) + ' more' : '');
        var lines = (o.itemCount === null || o.itemCount === undefined) ? '' : plN(o.itemCount) + ' line' + (plN(o.itemCount) === 1 ? '' : 's');
        return '<tr class="pl-row is-static' + (rejected ? ' has-flag flag-late' : '') + '">' +
            '<td class="pl-c-order"><div class="pl-order"><div class="pl-order-top"><b>' + plMark(o.salesOrder || '—', PIPE.search) + '</b></div>' +
                '<div class="pl-order-sub">' + plMark(o.customer || '—', PIPE.search) + (lines ? ' · ' + lines : '') + '</div>' +
                (shown ? '<div class="pl-order-items">' + plMark(shown, PIPE.search) + '</div>' : '') + '</div></td>' +
            '<td class="pl-c-due">' + (o.dueDate ? plDueHtml(o) : '<span class="muted">—</span>') + '</td>' +
            '<td class="pl-c-due">' + plH(plDate(o.orderDate) || '—') + '</td>' +
            '<td class="pl-c-attempt">' + status + '</td>' +
            '<td class="pl-c-act"><button type="button" class="pl-convert" data-act="convert" data-so="' + plH(String(o.id)) + '"' +
                (busy ? ' disabled' : '') + '>' + (busy ? 'Converting…' : 'Convert to plan') + '</button></td>' +
            '</tr>';
    }).join('');

    return plFlashHtml() +
        '<p class="pl-hint">Retried automatically. Red ones need a fix first.</p>' +
        '<div class="pl-table-wrap"><table class="pl-table"><thead><tr>' +
        '<th class="pl-c-order">Order</th><th class="pl-c-due">Due</th><th class="pl-c-due">Ordered</th>' +
        '<th class="pl-c-attempt">Last attempt</th><th class="pl-c-act"></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' + plPagerHtml(list.length);
}

// The result of Convert, on the page — a browser alert blocks the whole
// window and is gone the moment it is dismissed.
function plFlashHtml() {
    if (!PIPE.flash) return '';
    return '<div class="pl-flash' + (PIPE.flash.bad ? ' is-bad' : '') + '" role="status">' +
        '<span>' + plH(PIPE.flash.text) + '</span>' +
        '<button type="button" data-act="flash-x" aria-label="Dismiss">×</button></div>';
}

// ---- render --------------------------------------------------------------------------

function plViewMeta() {
    if (PIPE.view === 'pending') return { title: 'Pending orders', sub: 'not yet turned into a production plan · soonest due first', view: null };
    if (PIPE.view === 'packed') return { title: 'Packed — ready to dispatch', sub: 'boxes, weights and invoice', view: 'packed' };
    if (PIPE.view === 'dispatched') return { title: 'Dispatched', sub: '', view: 'dispatched' };
    var st = plStepOf(PIPE.status);
    return st
        ? { title: st.label, sub: st.sub + ' · most urgent first · click an order to see where its pieces are', view: 'active' }
        : { title: 'In the factory', sub: 'every order from production to ready-to-pack · most urgent first · click one to see where its pieces are', view: 'active' };
}

function plBodyHtml() {
    if (PIPE.view === 'pending') return plPendingBodyHtml();
    if (PIPE.view === 'packed') return plPackedBodyHtml();
    if (PIPE.view === 'dispatched') return plDispatchedBodyHtml();
    return plActiveBodyHtml();
}

function plPendingCountHtml() {
    if (!Array.isArray(PENDING_ORDERS)) return '';
    var list = plPendingVisible();
    return list.length !== PENDING_ORDERS.length
        ? '<b>' + list.length + '</b> of ' + PENDING_ORDERS.length
        : '<b>' + PENDING_ORDERS.length + '</b> order' + (PENDING_ORDERS.length === 1 ? '' : 's');
}

function renderPipeline() {
    var el = document.getElementById('pipeline-section');
    if (!el) return;
    plBind(el);
    plSyncCounts();
    var meta = plViewMeta();
    var toolbar = plToolbarHtml(meta.title, meta.sub, meta.view || 'active');
    if (PIPE.view === 'pending') toolbar = toolbar.replace(/<span class="pl-count" id="pl-count">[\s\S]*?<\/span>/, '<span class="pl-count" id="pl-count">' + plPendingCountHtml() + '</span>');
    var y = window.scrollY || document.documentElement.scrollTop;
    el.innerHTML = '<div class="pl">' + plStripHtml() +
        (PIPE.countsError ? '<p class="pipeline-error">Could not load the status counts: ' + plH(PIPE.countsError) + '</p>' : '') +
        '<section class="pl-panel">' + toolbar + '<div id="pl-body">' + plBodyHtml() + '</div></section></div>';
    window.scrollTo(0, y);
}

// Search redraws the list only, so the input keeps focus and caret.
function plRenderBody() {
    var body = document.getElementById('pl-body');
    var count = document.getElementById('pl-count');
    if (!body) { renderPipeline(); return; }
    body.innerHTML = plBodyHtml();
    if (count) {
        if (PIPE.view === 'pending') count.innerHTML = plPendingCountHtml();
        else {
            var tmp = document.createElement('div');
            tmp.innerHTML = plToolbarHtml('', '', PIPE.view === 'packed' || PIPE.view === 'dispatched' ? PIPE.view : 'active');
            var c = tmp.querySelector('#pl-count');
            count.innerHTML = c ? c.innerHTML : '';
        }
    }
}

// Opening an order reads its full stage history, finishing jobs and item
// sizes — one plan's worth, once. The row shows the list's figures meanwhile.
function plOpenDetail(soId) {
    if (PIPE.view !== 'active' || typeof PipelineData === 'undefined' || !PipelineData.detail) return;
    var o = (PIPE.orders.active || []).filter(function (x) { return String(x.id) === soId; })[0];
    if (!o || o.exact || PIPE.detailBusy[soId]) return;
    PIPE.detailBusy[soId] = true;
    PipelineData.detail(o).then(function () {
        delete PIPE.detailBusy[soId];
        plRenderBody();
    }).catch(function (err) {
        delete PIPE.detailBusy[soId];
        o.detailNote = 'Stage detail could not be read: ' + ((err && err.message) || String(err));
        plRenderBody();
    });
}

// ---- events — delegated once on the section ------------------------------------------

function plBind(root) {
    if (root._plBound) return;
    root._plBound = true;

    root.addEventListener('click', function (e) {
        var t = e.target.closest('[data-act]');
        if (!t || !root.contains(t)) return;
        var act = t.getAttribute('data-act');

        if (act === 'view') {
            var view = t.getAttribute('data-view');
            var status = t.getAttribute('data-status') || '';
            var changed = view !== PIPE.view;
            PIPE.landed = true;   // he has chosen; never move him again
            PIPE.view = view;
            PIPE.status = view === 'active' ? status : '';
            PIPE.risk = '';
            PIPE.page = 1;
            PIPELINE_STATUS = view === 'pending' ? 'Pending' : 'In Production';
            if (changed) { PIPE.search = ''; PIPE.open = {}; PIPE.flash = null; }
            renderPipeline();
            if (view === 'pending') { if (PENDING_ORDERS === null) loadPendingOrders(true); }
            else if (PIPE.orders[view] === null && !PIPE.errors[view]) loadSalesOrderProgress();
            return;
        }
        if (act === 'risk') {
            var r = t.getAttribute('data-risk') || '';
            PIPE.risk = PIPE.risk === r ? '' : r;
            PIPE.page = 1;
            plRenderBody();
            return;
        }
        if (act === 'page') {
            if (t.disabled) return;
            PIPE.page = Number(t.getAttribute('data-page')) || 1;
            plRenderBody();
            var sec = document.querySelector('.pl-panel');
            if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (act === 'toggle') {
            // A click on a highlighted word or the chevron still toggles; a
            // click on a link or button inside the row does not.
            if (e.target.closest('button, a') && e.target.closest('button, a') !== t) return;
            var so = t.getAttribute('data-so');
            PIPE.open[so] = !PIPE.open[so];
            if (PIPE.open[so]) plOpenDetail(so);
            plRenderBody();
            return;
        }
        if (act === 'window') {
            var wv = t.getAttribute('data-view');
            PIPE.windowDays[wv] = Number(t.getAttribute('data-days')) || 0;
            PIPE.page = 1;
            loadSalesOrderProgress();
            return;
        }
        if (act === 'flash-x') {
            PIPE.flash = null;
            plRenderBody();
            return;
        }
        if (act === 'convert') {
            e.stopPropagation();
            convertOrderToPlan(t.getAttribute('data-so'));
        }
    });

    root.addEventListener('change', function (e) {
        if (e.target.id !== 'pl-sup') return;
        PIPE.sup = e.target.value;
        PIPE.page = 1;
        renderPipeline();
    });

    root.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('pl-row') &&
            e.target.getAttribute('data-act') === 'toggle') {
            e.preventDefault();
            e.target.click();
        }
    });

    var timer = null;
    root.addEventListener('input', function (e) {
        if (e.target.id !== 'pl-search') return;
        PIPE.search = e.target.value;
        PIPE.page = 1;
        if (timer) clearTimeout(timer);
        timer = setTimeout(plRenderBody, 120);
    });
}

// ---- loading ---------------------------------------------------------------------

// The strip's counts, off getOrderPipelineCounts — and NOT only off it.
//
// "Improper Configuration" is Creator refusing the call before any Deluge runs:
// almost always the Custom API's configured method (GET / POST) not matching
// the one sent. It is a setting in Creator, not a code bug, and the strip must
// not go blank over it. So: POST, then GET, then the Order Audit's order list
// (getAdminCalculation), counted here. That last one reads only the newest 200
// orders, so every count is replaced by the exact one as soon as its list has
// loaded (plSyncCounts).
var PL_COUNT_KEYS = { 'pending': 'pending', 'in progress': 'inProgress', 'production complete': 'completed',
    'checking passed': 'qcPassed', 'finishing complete': 'finishingComplete', 'packed': 'packed',
    'dispatched': 'dispatched' };

function plCountsCall(method) {
    return ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getOrderPipelineCounts',
        workspace_name: 'livelinenstore',
        http_method: method,
        payload: {}
    }).then(function (response) {
        var c = plParse(response);
        // Its own try/catch reports a failed count here; zeros would read as
        // an empty factory, so fall through to the next source instead.
        if (c && c.errors && c.errors.length) throw new Error(c.errors.join(', '));
        if (!c || typeof c !== 'object' || (c.pending === undefined && c.inProgress === undefined)) {
            throw new Error('Response did not contain status counts');
        }
        return c;
    });
}

function plCountsFromOrderAudit() {
    return ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getAdminCalculation',
        http_method: 'POST',
        payload: { salesOrderId: '' }
    }).then(function (response) {
        var data = plParse(response);
        var orders = data && data.orders;
        if (!Array.isArray(orders)) throw new Error('Order Audit did not return an order list');
        var c = { pending: 0, inProgress: 0, completed: 0, qcPassed: 0, finishingComplete: 0, packed: 0, dispatched: 0 };
        orders.forEach(function (o) {
            var k = PL_COUNT_KEYS[String(o.status || '').trim().toLowerCase()];
            if (k) c[k]++;
        });
        return c;
    });
}

function loadPipeline() {
    var why = [];
    function note(label) {
        return function (err) {
            why.push(label + ': ' + ((err && (err.message || err.toString())) || 'failed'));
            throw err;
        };
    }
    plCountsCall('POST').catch(note('POST'))
        .catch(function () { return plCountsCall('GET').catch(note('GET')); })
        .catch(function () {
            console.warn('getOrderPipelineCounts unavailable (' + why.join('; ') + ') — counting from the Order Audit list. ' +
                'Check the Custom API\'s method in Creator.');
            return plCountsFromOrderAudit().catch(note('Order Audit fallback'));
        })
        .then(function (c) {
            PIPE.counts = c;
            PIPE.countsError = '';
            renderPipeline();
        })
        .catch(function () {
            console.error('Pipeline counts failed:', why);
            PIPE.countsError = why.join(' · ');
            renderPipeline();
        });
}

// OPEN WHERE THE WORK IS. On the very first load only, if the factory is
// empty and orders are waiting to be planned, show those instead of an empty
// list. Once he has clicked anything, the page never moves on its own.
function plMaybeLand() {
    if (PIPE.landed) return;
    if (!Array.isArray(PIPE.orders.active) || !Array.isArray(PENDING_ORDERS)) return;
    PIPE.landed = true;
    if (PIPE.view === 'active' && !PIPE.status && !PIPE.orders.active.length && PENDING_ORDERS.length) {
        PIPE.view = 'pending';
        PIPELINE_STATUS = 'Pending';
    }
}

// Loads the orders for the view on screen (and only that one — each view is
// its own status set). The whole set is enriched in one go; paging, search and
// the attention chips are redraws over it, never refetches.
function loadSalesOrderProgress() {
    var view = PIPE.view === 'pending' ? 'active' : PIPE.view;
    var statusSet = view === 'packed' ? 'Packed' : (view === 'dispatched' ? 'Dispatched' : 'In Production');
    PIPE.orders[view] = null;
    PIPE.errors[view] = '';
    if (view === 'active') PIPE.detailBusy = {};
    if (view === 'packed') { PIPE.packings = null; PIPE.packingError = ''; }
    var seq = ++PIPE.loadSeq[view];
    renderPipeline();

    // The factory list's attention bar and the Pending tile read the pending
    // list too — it is one small read, so it comes along.
    if (view === 'active' && PENDING_ORDERS === null && !PENDING_ERROR) loadPendingOrders(false);

    if (typeof PipelineData === 'undefined') {
        PIPE.orders[view] = [];
        PIPE.errors[view] = 'pipeline-data.js did not load';
        renderPipeline();
        return;
    }

    var jobs = [PipelineData.page({ status: statusSet, windowDays: PIPE.windowDays[view] || 0 })];
    if (view === 'packed') jobs.push(PipelineData.packings());

    Promise.all(jobs).then(function (res) {
        // A second Refresh on the same view supersedes the first.
        if (seq !== PIPE.loadSeq[view]) return;
        var data = res[0];
        PIPE.orders[view] = data.orders || [];
        PIPE.older[view] = plN(data.older);
        PIPE.loadedAt[view] = new Date();
        PIPE.notes[view] = (data.notes && data.notes.length) ? 'Some detail could not be read: ' + data.notes.join('; ') : '';
        if (view === 'packed') {
            PIPE.packings = res[1];
            PIPE.packingError = res[1].error || '';
        }
        plMaybeLand();
        renderPipeline();
    }).catch(function (err) {
        if (seq !== PIPE.loadSeq[view]) return;
        console.error('Pipeline load failed:', err);
        PIPE.orders[view] = [];
        PIPE.errors[view] = (err && (err.message || err.toString())) || 'Request failed';
        renderPipeline();
    });
}

// Pending off getRecords first (PipelineData.pending — no statement limit, and
// it carries the due date); the getPendingSalesOrders Custom API only if that
// read fails.
function loadPendingOrders(showLoading) {
    PENDING_ERROR = '';
    if (showLoading) { PENDING_ORDERS = null; renderPipeline(); }
    var primary = (typeof PipelineData !== 'undefined' && PipelineData.pending)
        ? PipelineData.pending()
        : Promise.reject(new Error('pipeline-data.js did not load'));

    primary.catch(function (err) {
        console.warn('Pending via getRecords failed (' + ((err && err.message) || err) + ') — using getPendingSalesOrders.');
        return ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'getPendingSalesOrders',
            workspace_name: 'livelinenstore',
            http_method: 'GET'
        }).then(function (response) {
            var data = plParse(response);
            if (!data || !Array.isArray(data.orders)) throw new Error('Response did not contain a pending order list');
            if (data.errors && data.errors.length) console.warn('getPendingSalesOrders returned errors:', data.errors);
            return data;
        });
    }).then(function (data) {
        PENDING_ORDERS = data.orders;
        PIPE.loadedAt.pending = new Date();
        plMaybeLand();
        renderPipeline();
    }).catch(function (err) {
        console.error('Pending orders could not be read:', err);
        PENDING_ORDERS = [];
        PENDING_ERROR = (err && (err.message || err.toString())) || 'Request failed';
        renderPipeline();
    });
}

function convertOrderToPlan(soId) {
    if (!soId || CONVERTING[String(soId)]) return;
    CONVERTING[String(soId)] = true;
    var o = (PENDING_ORDERS || []).filter(function (x) { return String(x.id) === String(soId); })[0];
    var soNo = (o && o.salesOrder) || 'The order';
    renderPipeline();

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'convertSalesOrderToPlan',
        http_method: 'POST',
        payload: { soIdTxt: String(soId) }
    }).then(function (response) {
        var parsed = null;
        try { parsed = plParse(response); } catch (e) { parsed = null; }
        delete CONVERTING[String(soId)];
        if (parsed && parsed.success) {
            PIPE.flash = { bad: false, text: parsed.outcome === 'Skipped'
                ? soNo + ': ' + (parsed.reason || 'a plan already existed — the order has been moved on.')
                : soNo + ' is planned' + (parsed.planNo ? ' as ' + parsed.planNo : '') + ' and has moved to In production.' };
        } else {
            PIPE.flash = { bad: true, text: soNo + ' could not be planned: ' + ((parsed && parsed.reason) || 'unknown error') +
                (parsed && parsed.outcome === 'Rejected' ? '. Fix that on the sales order, then convert again.' : '') };
        }
        // The order leaves Pending — its new home must reload too.
        PIPE.orders.active = null;
        loadPipeline();
        loadPendingOrders();
    }).catch(function (err) {
        console.error('convertSalesOrderToPlan error:', err);
        delete CONVERTING[String(soId)];
        PIPE.flash = { bad: true, text: 'Could not reach the server to convert ' + soNo + '. Check the connection and try again.' };
        renderPipeline();
    });
}

// The header Refresh: counts, plus whatever view is on screen. Other views'
// cached lists are dropped so they reload when next opened.
function refreshPipeline() {
    loadPipeline();
    ['active', 'packed', 'dispatched'].forEach(function (v) {
        if (v !== PIPE.view) PIPE.orders[v] = null;
    });
    if (PIPE.view === 'pending') loadPendingOrders(true);
    else {
        loadSalesOrderProgress();
        if (PENDING_ORDERS !== null) loadPendingOrders(false);
    }
}
