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

        var order = s.salesOrder
            ? esc(s.salesOrder) + (s.planNo ? '<div class="emp-sub">' + esc(s.planNo) + '</div>' : '')
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
            DATA = JSON.parse(response.result);
        } catch (e) {
            console.error('getEmployeeReport parse failed:', e, response.result);
            DATA = { errors: ['Could not read the response — see the browser console.'], worked: [], noLogs: [], totals: {} };
        }
        setBusy(false);
        renderTiles();
        renderTable();
        renderNoLogs();
    }).catch(function (err) {
        // Creator collapses every Deluge runtime failure into "code 9430", and a
        // bare 500 with no message at all is usually the statement-execution
        // limit, which cannot be caught server-side.
        console.error('getEmployeeReport error:', err);
        DATA = { errors: ['Could not load: ' + err], worked: [], noLogs: [], totals: {} };
        setBusy(false);
        renderTiles();
        renderTable();
        renderNoLogs();
    });
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
    document.getElementById('refresh-btn').addEventListener('click', load);

    load();
});
