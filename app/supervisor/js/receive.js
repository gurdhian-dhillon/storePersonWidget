function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function fmt(n) {
    n = Number(n) || 0;
    return (Math.round(n * 100) / 100).toLocaleString();
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

// ---- Ids ----

function matInputId(i) { return 'mat-input-' + i; }
function matRowId(i) { return 'mat-row-' + i; }
function matNoteId(i) { return 'mat-note-' + i; }
function matShortId(i) { return 'mat-short-' + i; }
function wasteShortId(i) { return 'waste-short-' + i; }
function wasteInputId(i) { return 'waste-input-' + i; }
function wasteRowId(i) { return 'waste-row-' + i; }
function wasteNoteId(i) { return 'waste-note-' + i; }
function printedShortId(i) { return 'printed-short-' + i; }
function printedInputId(i) { return 'printed-input-' + i; }
function printedRowId(i) { return 'printed-row-' + i; }
function printedNoteId(i) { return 'printed-note-' + i; }
// Phase 2 — read-only breakdown expand-in-place under a material row.
function matBdRowId(i) { return 'mat-bd-' + i; }
function matChevId(i) { return 'mat-chev-' + i; }
function ordItemsId(i, j) { return 'ord-bd-' + i + '-' + j; }
function ordChevId(i, j) { return 'ord-chev-' + i + '-' + j; }

// planId|materialId -> { state: 'loading'|'ok'|'error', items: [...] }
var BD_CACHE = {};

// ---- Progress bar (shared look with the store Issue screen) ----
//
// getSupervisorMaterials is paged by Issue_Line row - a big backlog is a
// handful of sequential calls, total unknown until linesConsumed hits 0. So the
// load bar runs INDETERMINATE with a live "Page N". The receipt bar is the same
// bar in a modal, one tick per sweep slice / finalize phase.
var LoadProgress = {
    el: null,

    start: function (contentEl, title, sub) {
        contentEl.innerHTML =
            '<div class="load-progress is-indeterminate" id="rcv-load-progress">' +
            '<div class="lp-head">' +
            '<span class="lp-title" id="rcv-lp-title"></span>' +
            '<span class="lp-count" id="rcv-lp-count"></span>' +
            '</div>' +
            '<div class="lp-track"><div class="lp-fill"></div></div>' +
            '<div class="lp-sub" id="rcv-lp-sub"></div>' +
            '</div>';
        this.el = document.getElementById('rcv-load-progress');
        this.setTitle(title || 'Loading your deliveries…');
        this.setSub(sub || 'This can take a moment on a large order backlog.');
    },
    setTitle: function (t) { var n = document.getElementById('rcv-lp-title'); if (n) n.textContent = t; },
    setSub: function (t) { var n = document.getElementById('rcv-lp-sub'); if (n) n.textContent = t || ''; },
    setPage: function (n) { var c = document.getElementById('rcv-lp-count'); if (c) c.textContent = 'Page ' + n; },
    finish: function () { this.el = null; }
};

// The receipt-time bar, in a modal so it sits over the card while the sweep +
// finalize batches run. `percentage` numeric => a filled bar; omit it for the
// indeterminate crawl (the batch count is not known ahead of time).
function rcvProgressModalEl() {
    var el = document.getElementById('rcv-progress-modal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'rcv-progress-modal';
        el.className = 'exc-modal hidden';
        el.innerHTML = '<div class="exc-panel progress-panel">' +
            '<div class="load-progress" id="rcv-pm-card">' +
            '<div class="lp-head">' +
            '<span class="lp-title" id="rcv-pm-title">Receiving materials</span>' +
            '<span class="lp-count" id="rcv-pm-count"></span>' +
            '</div>' +
            '<div class="lp-track"><div class="lp-fill" id="rcv-pm-fill"></div></div>' +
            '<div class="lp-sub" id="rcv-pm-sub"></div>' +
            '</div>' +
            '</div>';
        document.body.appendChild(el);
    }
    return el;
}

function showRcvProgress(title, sub, percentage) {
    var el = rcvProgressModalEl();
    document.getElementById('rcv-pm-title').textContent = title || 'Receiving materials';
    document.getElementById('rcv-pm-sub').textContent = sub || '';
    var card = document.getElementById('rcv-pm-card');
    var fill = document.getElementById('rcv-pm-fill');
    var count = document.getElementById('rcv-pm-count');
    var hasPct = typeof percentage === 'number' && isFinite(percentage);
    if (hasPct) {
        var pct = Math.max(0, Math.min(100, Math.round(percentage)));
        card.classList.remove('is-indeterminate');
        fill.style.width = pct + '%';
        count.textContent = pct + '%';
    } else {
        card.classList.add('is-indeterminate');
        fill.style.width = '';
        count.textContent = '';
    }
    el.classList.remove('hidden');
}

function closeRcvProgress() {
    var el = document.getElementById('rcv-progress-modal');
    if (el) el.classList.add('hidden');
}

// ---- Mode ----
//
// Two modes, and the whole screen is built around the difference. Confirming a
// correct handover is one click; entering quantities is the exception path and
// stays hidden until he says something is wrong. Making the correct case cost
// one click per line does not create diligence, it creates rubber-stamping.

var EDIT = false;

function setEditMode(on) {
    EDIT = on;
    render(window.__data);
}

// ---- Rendering ----

// WHICH LOT THE CLOTH CAME OFF, so he checks the right roll.
//
// Fabric only, and only when the store actually recorded it — a handover made
// before lots existed carries none, and saying "Not recorded" is honest where
// inventing a lot would not be.
//
// Split handovers show every lot with its own metres. One entry each, because
// they are separate rolls on his bench: he is not signing for "5.5 metres", he
// is signing for 3 off L2 and 2.5 off L3 — and if only one of them is on the
// trolley, that is exactly the discrepancy this screen exists to catch.
function lotColumn(m) {
    var lots = (m.isFabric && m.lots) ? m.lots : [];
    if (lots.length === 0) return '<td class="col-lot">-</td>';

    var parts = lots.map(function (l) {
        if (lots.length > 1) {
            return '<div class="rcv-lot"><b>' + escapeHtml(l.lot) + '</b> <span style="font-size: 0.9em; color: #666;">(' +
                   fmt(l.qty) + ' ' + escapeHtml(m.unit) + ')</span></div>';
        } else {
            return '<div class="rcv-lot"><b>' + escapeHtml(l.lot) + '</b></div>';
        }
    }).join('');

    return '<td class="col-lot">' + parts + '</td>';
}

function rcvCols() { return EDIT ? 5 : 4; }

var CHEV_SVG = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// STATUS words the shop floor uses, not the picklist codes.
function itemStatusLabel(s) {
    return ({
        Awaiting_Material: 'No material yet',
        Ready_For_Production: 'Ready',
        In_Production: 'In production',
        Awaiting_Check: 'Awaiting check',
        Complete: 'Complete'
    })[s] || (s || '').replace(/_/g, ' ');
}

// The read-only breakdown that expands under a material row. "Where this goes":
// one line per order (from m.orders, rolled up per plan by getSupervisorMaterials),
// each expandable to the items on that order that still owe this material -
// fetched lazily via getReceiveItemBreakdown when he opens it.
function matBreakdownHtml(m, i) {
    var orders = m.orders || [];
    if (orders.length === 0) {
        return '<div class="bd-empty">No order detail for this material.</div>';
    }
    var rows = orders.map(function (o, j) {
        var name = escapeHtml(o.salesOrder || o.planNo || 'Order');
        var metaBits = 'needs <b>' + fmt(o.pending) + '</b> ' + escapeHtml(m.unit);
        if (o.lineCount > 1) metaBits += ' &middot; ' + o.lineCount + ' lines';
        return '' +
            '<div class="bd-order">' +
                '<button type="button" class="bd-order-head" ' +
                    'onclick="toggleOrderBreakdown(' + i + ',' + j + ')">' +
                    '<span class="chevron bd-chevron" id="' + ordChevId(i, j) + '">' + CHEV_SVG + '</span>' +
                    '<span class="bd-order-name">' + name + '</span>' +
                    '<span class="bd-order-meta">' + metaBits + '</span>' +
                    (o.isReissue === true ? '<span class="reissue-tag">reissue</span>' : '') +
                '</button>' +
                '<div class="bd-order-items hidden" id="' + ordItemsId(i, j) + '"></div>' +
            '</div>';
    }).join('');
    return '' +
        '<div class="bd-wrap">' +
            '<div class="bd-head">Where this goes &mdash; <b>' + orders.length +
                (orders.length === 1 ? '</b> order' : '</b> orders') + '</div>' +
            rows +
        '</div>';
}

function renderMaterialRow(m, i) {
    var qtyCell = '<span class="qty-big">' + fmt(m.pending) +
        '<span class="unit">' + escapeHtml(m.unit) + '</span></span>';

    var hasBreakdown = m.orders && m.orders.length > 0;
    var nameCell =
        '<td class="material-name-cell">' +
            '<div class="mat-name-row">' +
                (hasBreakdown
                    ? '<button type="button" class="chevron mat-bd-toggle" id="' + matChevId(i) + '" ' +
                          'onclick="toggleMatBreakdown(' + i + ')" aria-label="Show where this goes">' +
                          CHEV_SVG + '</button>'
                    : '') +
                '<div class="mat-name">' + escapeHtml(m.material) +
                    (m.isFabric ? '<span class="fabric-badge">Fabric</span>' : '') +
                    (m.isReissue === true ? '<span class="reissue-tag">incl. reissue</span>' : '') +
                '</div>' +
            '</div>' +
        '</td>';

    var actionCell = EDIT
        ? '<td class="col-issue">' +
              '<span class="issue-input-group">' +
                  '<input type="number" step="0.01" min="0" max="' + round2(m.pending) + '" ' +
                      'class="issue-input" id="' + matInputId(i) + '" value="' + round2(m.pending) + '" ' +
                      'oninput="onMatInput(' + i + ')" onblur="onMatCommit(' + i + ')" />' +
                  '<span class="issue-unit">' + escapeHtml(m.unit) + '</span>' +
              '</span>' +
              '<div class="short-hint" id="' + matShortId(i) + '"></div>' +
          '</td>' +
          '<td class="col-note">' +
              '<input type="text" class="note-input" id="' + matNoteId(i) + '" ' +
                  'placeholder="Why is it short?" disabled />' +
          '</td>'
        : '<td class="col-issue"><span class="status-pill status-partial">Awaiting check</span></td>';

    var mainRow =
        '<tr id="' + matRowId(i) + '">' +
            nameCell +
            lotColumn(m) +
            '<td class="col-num col-strong">' + qtyCell + '</td>' +
            actionCell +
        '</tr>';

    var bdRow = hasBreakdown
        ? '<tr class="mat-breakdown hidden" id="' + matBdRowId(i) + '">' +
              '<td colspan="' + rcvCols() + '">' + matBreakdownHtml(m, i) + '</td>' +
          '</tr>'
        : '';

    return mainRow + bdRow;
}

// ---- Breakdown expand / lazy load ----

function toggleMatBreakdown(i) {
    var row = document.getElementById(matBdRowId(i));
    var chev = document.getElementById(matChevId(i));
    if (!row) return;
    var open = row.classList.toggle('hidden') === false;
    if (chev) chev.classList.toggle('is-open', open);
}

function toggleOrderBreakdown(i, j) {
    var box = document.getElementById(ordItemsId(i, j));
    var chev = document.getElementById(ordChevId(i, j));
    if (!box) return;
    var open = box.classList.toggle('hidden') === false;
    if (chev) chev.classList.toggle('is-open', open);
    if (!open) return;

    var m = (window.__data.materials || [])[i];
    var o = m && (m.orders || [])[j];
    if (!m || !o || !o.planId) { box.innerHTML = '<div class="bd-empty">No order.</div>'; return; }

    var key = String(o.planId) + '|' + String(m.materialId);
    var hit = BD_CACHE[key];
    if (hit && hit.state === 'ok') { box.innerHTML = renderOrderItems(hit.items, m); return; }
    if (hit && hit.state === 'loading') { box.innerHTML = '<div class="bd-loading">Loading…</div>'; return; }

    BD_CACHE[key] = { state: 'loading', items: [] };
    box.innerHTML = '<div class="bd-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getReceiveItemBreakdown',
        http_method: 'POST',
        payload: { planId: String(o.planId), materialId: String(m.materialId) }
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }
        if (!parsed || (parsed.errors && parsed.errors.length)) {
            console.warn('getReceiveItemBreakdown:', parsed && parsed.errors);
            BD_CACHE[key] = { state: 'error', items: [] };
        } else {
            BD_CACHE[key] = { state: 'ok', items: parsed.items || [] };
        }
        // Only paint if the box is still open and still in the DOM.
        var cur = document.getElementById(ordItemsId(i, j));
        if (cur && !cur.classList.contains('hidden')) {
            cur.innerHTML = BD_CACHE[key].state === 'ok'
                ? renderOrderItems(BD_CACHE[key].items, m)
                : '<div class="bd-empty">Could not load the item list.</div>';
        }
    }).catch(function (err) {
        console.error('getReceiveItemBreakdown failed:', err);
        BD_CACHE[key] = { state: 'error', items: [] };
        var cur = document.getElementById(ordItemsId(i, j));
        if (cur && !cur.classList.contains('hidden')) {
            cur.innerHTML = '<div class="bd-empty">Could not load the item list.</div>';
        }
    });
}

function renderOrderItems(items, m) {
    if (!items || items.length === 0) {
        return '<div class="bd-empty">No item still owes this material.</div>';
    }
    var rows = items.map(function (it) {
        var owed = it.isFabric
            ? (Number(it.owedPieces) || 0) + (Number(it.owedPieces) === 1 ? ' pc' : ' pcs')
            : fmt(it.owedQty) + ' ' + escapeHtml(m.unit);
        var label = escapeHtml(it.sku || '') + (it.name ? ' &middot; ' + escapeHtml(it.name) : '');
        return '<tr>' +
            '<td>' + label +
                (it.isRemake === true
                    ? ' <span class="reissue-tag">' + escapeHtml((it.remakeReason || 'remake').replace(/_/g, ' ')) + '</span>'
                    : '') +
            '</td>' +
            '<td class="bd-owed">' + owed + '</td>' +
            '<td><span class="status-pill status-partial">' + escapeHtml(itemStatusLabel(it.status)) + '</span></td>' +
            '</tr>';
    }).join('');
    return '<table class="bd-item-table"><thead><tr>' +
        '<th>Item</th><th class="bd-owed">Still owed</th><th>Status</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// Waste pieces are NOT merged the way metres and cones are. He is holding one
// specific remnant, cut for one specific item, so it gets its own line.
function renderWasteRow(w, i) {
    var actionCell;
    if (EDIT) {
        actionCell =
            '<span class="issue-input-group">' +
                '<input type="number" step="1" min="0" max="' + w.pending + '" ' +
                    'class="issue-input" id="' + wasteInputId(i) + '" value="' + w.pending + '" ' +
                    'oninput="onWasteInput(' + i + ')" ' +
                    'onblur="onWasteCommit(' + i + ')" />' +
                '<span class="issue-unit">pcs</span>' +
            '</span>' +
            '<div class="short-hint" id="' + wasteShortId(i) + '"></div>';
    } else {
        actionCell = '<span class="status-pill status-partial">Awaiting check</span>';
    }

    return '' +
        '<tr id="' + wasteRowId(i) + '">' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">&#9851; ' + escapeHtml(w.material) +
                    '<span class="fabric-badge">Waste</span>' +
                '</div>' +
                '<div class="mat-sku">' + escapeHtml(w.salesOrder || w.planNo) +
                    ' &middot; cut into ' + fmt(w.cutLength) + '&times;' + fmt(w.cutWidth) +
                    ' cm &middot; yields ' + w.yields + ' pcs</div>' +
            '</td>' +
            '<td class="col-lot">-</td>' +
            '<td class="col-num col-strong">' +
                '<span class="qty-big">' + w.pending + '<span class="unit">pcs</span></span>' +
                '<div class="qty-sub">' + fmt(w.length) + ' &times; ' + fmt(w.width) + ' cm</div>' +
            '</td>' +
            '<td class="col-issue">' + actionCell + '</td>' +
            // Same note as a material line. A short remnant raises exactly the
            // same Outbound Stock_Dispute a short metre does, and the store
            // reads it on the same screen - so leaving the cell empty under a
            // "Note" heading was the one thing that made the two look different.
            (EDIT
                ? '<td class="col-note">' +
                      '<input type="text" class="note-input" id="' + wasteNoteId(i) + '" ' +
                          'placeholder="Why is it short?" disabled />' +
                  '</td>'
                : '') +
        '</tr>';
}

// Printed fabric pieces — one physical piece per line, same shape as waste but
// measured in metres, not piece count. Each row is one Issue_Line.
function renderPrintedRow(p, i) {
    var actionCell;
    if (EDIT) {
        actionCell =
            '<span class="issue-input-group">' +
                '<input type="number" step="0.01" min="0" max="' + p.pending + '" ' +
                    'class="issue-input" id="' + printedInputId(i) + '" value="' + p.pending + '" ' +
                    'oninput="onPrintedInput(' + i + ')" ' +
                    'onblur="onPrintedCommit(' + i + ')" />' +
                '<span class="issue-unit">Mtr</span>' +
            '</span>' +
            '<div class="short-hint" id="' + printedShortId(i) + '"></div>';
    } else {
        actionCell = '<span class="status-pill status-partial">Awaiting check</span>';
    }

    return '' +
        '<tr id="' + printedRowId(i) + '">' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">&#9851; ' + escapeHtml(p.material) +
                    '<span class="fabric-badge">Printed</span>' +
                '</div>' +
                '<div class="mat-sku">' + escapeHtml(p.salesOrder || p.planNo) +
                    ' &middot; piece ' + fmt(p.qty * 100) + ' cm</div>' +
            '</td>' +
            '<td class="col-lot">' + escapeHtml(p.lot || '-') + '</td>' +
            '<td class="col-num col-strong">' +
                '<span class="qty-big">' + fmt(p.pending) + '<span class="unit">Mtr</span></span>' +
                '<div class="qty-sub">' + fmt(p.qty) + ' Mtr issued</div>' +
            '</td>' +
            '<td class="col-issue">' + actionCell + '</td>' +
            (EDIT
                ? '<td class="col-note">' +
                      '<input type="text" class="note-input" id="' + printedNoteId(i) + '" ' +
                          'placeholder="Why is it short?" disabled />' +
                  '</td>'
                : '') +
        '</tr>';
}

function renderTable(title, note, rowsHtml) {
    if (!rowsHtml) return '';
    return '' +
        '<div class="mat-section">' +
            '<div class="section-title">' + escapeHtml(title) +
                (note ? '<span class="section-note">' + escapeHtml(note) + '</span>' : '') +
            '</div>' +
            '<div class="table-wrapper">' +
                '<table>' +
                    '<thead><tr>' +
                        '<th>Item</th>' +
                        '<th class="col-lot">Lot no.</th>' +
                        '<th class="col-num">Issued to you</th>' +
                        '<th class="col-issue">' + (EDIT ? 'Actually received' : 'Status') + '</th>' +
                        (EDIT ? '<th class="col-note">Note</th>' : '') +
                    '</tr></thead>' +
                    '<tbody>' + rowsHtml + '</tbody>' +
                '</table>' +
            '</div>' +
        '</div>';
}

// A supervisor with orders but no deliveries yet used to land on a blank
// screen. The receipt list can only ever show material already issued, so it
// cannot say "you have three orders coming" - that has to be stated.
function assignmentNote(data) {
    var assigned = Number(data && data.plansAssigned) || 0;
    var awaiting = Number(data && data.plansAwaiting) || 0;

    if (assigned === 0) {
        return '<div class="assign-note is-quiet">' +
            'No orders assigned to you at the moment.' +
        '</div>';
    }

    var msg = '<b>' + assigned + ' order' + (assigned === 1 ? '' : 's') + '</b> assigned to you';

    if (awaiting > 0 && awaiting === assigned) {
        msg += ' — nothing issued against ' + (assigned === 1 ? 'it' : 'them') +
            ' yet. Material shows up here when the store sends it.';
    } else if (awaiting > 0) {
        msg += ' — <b>' + awaiting + '</b> with no material issued yet. ' +
            'It shows up here when the store sends it.';
    } else {
        msg += '. The store has issued against all of them.';
    }

    return '<div class="assign-note">' + msg + '</div>';
}

function render(data) {
    window.__data = data;
    var emptyState = document.getElementById('rcv-empty');
    var content = document.getElementById('rcv-content');

    var mats = (data && data.materials) || [];
    var waste = (data && data.waste) || [];
    var printed = (data && data.printedPieces) || [];
    var total = mats.length + waste.length + printed.length;

    // The Receive tab has carried a count badge since the tabs were built, and
    // nothing ever filled it — the one tab where something is genuinely waiting
    // was the only one not saying so.
    setTabCount('count-receive', total);

    // The picker is filled by this call, so this is the first moment the shell
    // knows who it is drawing badges for. Boot cannot ask any earlier.
    if (typeof loadSupCounts === 'function') loadSupCounts();

    if (total === 0) {
        // Hide the generic empty state — the note says something more useful
        // than "nothing to receive" when orders are in fact on their way.
        emptyState.classList.add('hidden');
        content.innerHTML = assignmentNote(data) +
            '<div class="panel-placeholder">' +
                '<h2>Nothing to receive right now</h2>' +
                '<p>Material the store issues to you shows up here to be checked.</p>' +
            '</div>';
        return;
    }
    emptyState.classList.add('hidden');

    var note = assignmentNote(data);

    var matHtml = mats.map(renderMaterialRow).join('');
    var wasteHtml = waste.map(renderWasteRow).join('');
    var printedHtml = printed.map(renderPrintedRow).join('');

    var footer;
    if (EDIT) {
        footer =
            '<div class="card-footer">' +
                '<span class="sel-count" id="short-summary">' +
                    'Everything as issued — change only what is actually short.' +
                '</span>' +
                '<button type="button" class="ghost-btn" onclick="setEditMode(false)">Cancel</button>' +
                '<button type="button" class="primary-btn" id="confirm-btn" onclick="submitReceipt()">' +
                    'Confirm what I received' +
                '</button>' +
            '</div>';
    } else {
        footer =
            '<div class="card-footer">' +
                '<span class="sel-count">' + total + (total === 1 ? ' line' : ' lines') + ' to check</span>' +
                '<button type="button" class="ghost-btn" onclick="setEditMode(true)">Something&rsquo;s wrong</button>' +
                '<button type="button" class="primary-btn" id="confirm-btn" onclick="submitReceipt()">All received as listed</button>' +
            '</div>';
    }

    content.innerHTML =
        note +
        '<div class="item-card open">' +
            '<div class="item-body">' +
                '<div class="tables-container">' +
                    renderTable('Materials', 'one line per physical thing, not per order', matHtml) +
                    renderTable('Waste cut pieces', 'each piece is for a specific cut', wasteHtml) +
                    renderTable('Printed fabric pieces', 'each piece is received individually', printedHtml) +
                '</div>' +
                footer +
            '</div>' +
        '</div>';

}

// ---- Input handling ----

function onMatInput(i) {
    var input = document.getElementById(matInputId(i));
    var m = window.__data.materials[i];

    // Nothing is written back to the field here. Rewriting input.value on every
    // keystroke made a decimal impossible to type: "14." parses as 14 and gets
    // put straight back, so the dot vanishes as soon as it is pressed. The
    // value is left exactly as typed and tidied up on blur instead.
    var raw = String(input.value).trim();
    var val = parseFloat(raw);
    var typed = raw !== '' && !isNaN(val);
    if (!typed || val < 0) val = 0;

    var over = typed && val > m.pending;
    var short = over ? 0 : round2(m.pending - val);

    input.classList.toggle('invalid', short > 0 || over);

    var hint = document.getElementById(matShortId(i));
    if (hint) {
        if (over) {
            hint.textContent = 'more than was issued';
        } else {
            hint.textContent = short > 0 ? 'short by ' + fmt(short) + ' ' + m.unit : '';
        }
    }

    // The note is only stored when there is a shortfall, so it only opens when
    // there is one. Typing an explanation the server discards is worse than
    // having nowhere to type it.
    var note = document.getElementById(matNoteId(i));
    if (note) {
        note.disabled = short <= 0;
        if (short <= 0) note.value = '';
    }

    updateShortSummary();
}

// Blur, not keystroke. This is where a half-typed or out-of-range entry is
// settled — clamped to what was actually issued and rounded — so that the
// figure submitted is never whatever the field happened to contain mid-edit.
function onMatCommit(i) {
    var input = document.getElementById(matInputId(i));
    var m = window.__data.materials[i];

    var val = parseFloat(input.value);
    if (isNaN(val) || val < 0) val = 0;
    if (val > m.pending) val = m.pending;
    input.value = round2(val);

    onMatInput(i);
}

function onWasteInput(i) {
    var input = document.getElementById(wasteInputId(i));
    var w = window.__data.waste[i];

    // Same rule as above: read, never write, while he is still typing.
    var raw = String(input.value).trim();
    var val = parseInt(raw, 10);
    var typed = raw !== '' && !isNaN(val);
    if (!typed || val < 0) val = 0;

    var over = typed && val > w.pending;
    var short = over ? 0 : w.pending - val;

    input.classList.toggle('invalid', short > 0 || over);

    var hint = document.getElementById(wasteShortId(i));
    if (hint) {
        if (over) {
            hint.textContent = 'more than was issued';
        } else {
            hint.textContent = short > 0
                ? 'short by ' + short + (short === 1 ? ' pc' : ' pcs')
                : '';
        }
    }

    // Same rule as a material line: the note is only stored when there is a
    // shortfall, so it only opens when there is one.
    var note = document.getElementById(wasteNoteId(i));
    if (note) {
        note.disabled = short <= 0;
        if (short <= 0) note.value = '';
    }

    updateShortSummary();
}

function onWasteCommit(i) {
    var input = document.getElementById(wasteInputId(i));
    var w = window.__data.waste[i];

    // Pieces are whole things — you cannot receive half a cut piece.
    var val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    if (val > w.pending) val = w.pending;
    input.value = val;

    onWasteInput(i);
}

function onPrintedInput(i) {
    var input = document.getElementById(printedInputId(i));
    var p = window.__data.printedPieces[i];

    var raw = String(input.value).trim();
    var val = parseFloat(raw);
    var typed = raw !== '' && !isNaN(val);
    if (!typed || val < 0) val = 0;

    var over = typed && val > p.pending;
    var short = over ? 0 : round2(p.pending - val);

    input.classList.toggle('invalid', short > 0 || over);

    var hint = document.getElementById(printedShortId(i));
    if (hint) {
        if (over) {
            hint.textContent = 'more than was issued';
        } else {
            hint.textContent = short > 0
                ? 'short by ' + fmt(short) + ' Mtr'
                : '';
        }
    }

    var note = document.getElementById(printedNoteId(i));
    if (note) {
        note.disabled = short <= 0;
        if (short <= 0) note.value = '';
    }

    updateShortSummary();
}

function onPrintedCommit(i) {
    var input = document.getElementById(printedInputId(i));
    var p = window.__data.printedPieces[i];

    var val = parseFloat(input.value);
    if (isNaN(val) || val < 0) val = 0;
    if (val > p.pending) val = p.pending;
    input.value = round2(val);

    onPrintedInput(i);
}

// How many lines he is reporting short, restated in the footer beside the
// button he is about to press. Each one becomes a dispute for someone else to
// chase, so it should not be possible to raise five of them by accident.
function updateShortSummary() {
    var el = document.getElementById('short-summary');
    if (!el) return;

    var data = window.__data || {};
    var n = 0;

    (data.materials || []).forEach(function (m, i) {
        var input = document.getElementById(matInputId(i));
        if (input && (parseFloat(input.value) || 0) < m.pending) n++;
    });
    (data.waste || []).forEach(function (w, i) {
        var input = document.getElementById(wasteInputId(i));
        if (input && (parseInt(input.value, 10) || 0) < w.pending) n++;
    });
    (data.printedPieces || []).forEach(function (p, i) {
        var input = document.getElementById(printedInputId(i));
        if (input && (parseFloat(input.value) || 0) < p.pending) n++;
    });

    if (n === 0) {
        el.className = 'sel-count';
        el.textContent = 'Everything as issued — change only what is actually short.';
    } else {
        el.className = 'sel-count is-short';
        el.textContent = n + (n === 1 ? ' line' : ' lines') +
            ' short · ' + (n === 1 ? 'a dispute will be raised' : 'a dispute will be raised for each');
    }
}

// ---- Submit ----
//
// The widget no longer distributes settlements per line. It names the vouchers
// it is confirming and, only for a material he marked short, how much arrived.
// receiveMaterials walks each voucher's Issue_Lines itself, in budgeted
// resumable SWEEP slices, then a phased FINALIZE (voucher status -> readiness
// sweep -> warehouse transfer -> dispute digest). Two loops here, one cursor
// each, mirroring that.

function submitReceipt() {
    var data = window.__data;
    var supId = document.getElementById('sup-select').value;
    if (!supId) return;

    // ---- gather the sweep scope + short flags ----
    var voucherSet = {};
    var voucherOrder = [];          // newest-first (voucherIds are emitted desc)
    var plansTouched = {};
    var shortMaterials = [];

    (data.materials || []).forEach(function (m, i) {
        (m.voucherIds || []).forEach(function (v) {
            v = String(v);
            if (!voucherSet[v]) { voucherSet[v] = 1; voucherOrder.push(v); }
        });
        (m.orders || []).forEach(function (o) {
            if (o.planId) plansTouched[String(o.planId)] = 1;
        });

        // Not in EDIT mode means "all as listed" - never short. In EDIT mode a
        // material is short only when he typed LESS than the pending figure.
        if (EDIT) {
            var input = document.getElementById(matInputId(i));
            var note = document.getElementById(matNoteId(i));
            if (input) {
                var typed = parseFloat(input.value);
                if (isNaN(typed) || typed < 0) typed = 0;
                if (typed > m.pending) typed = m.pending;
                if (round2(typed) < round2(m.pending)) {
                    shortMaterials.push({
                        materialId: m.materialId,
                        owed: round2(m.pending),
                        received: round2(typed),
                        remark: note ? note.value : ''
                    });
                }
            }
        }
    });

    // Waste + printed rows stay explicit (one per physical piece, bounded).
    var wasteRows = [];
    (data.waste || []).forEach(function (w, i) {
        var input = document.getElementById(wasteInputId(i));
        var note = document.getElementById(wasteNoteId(i));
        var val = (EDIT && input) ? (parseInt(input.value, 10) || 0) : w.pending;
        if (val < 0) val = 0;
        if (val > w.pending) val = w.pending;
        wasteRows.push({ rowId: w.rowId, received: val, remark: note ? note.value : '' });
        if (w.planId) plansTouched[String(w.planId)] = 1;
    });

    var printedRows = [];
    (data.printedPieces || []).forEach(function (p, i) {
        var input = document.getElementById(printedInputId(i));
        var note = document.getElementById(printedNoteId(i));
        var val = (EDIT && input) ? (parseFloat(input.value) || 0) : p.pending;
        if (val < 0) val = 0;
        if (val > p.pending) val = p.pending;
        printedRows.push({
            issueLineId: p.issueLineId, voucherId: p.voucherId,
            received: round2(val), remark: note ? note.value : ''
        });
        if (p.planId) plansTouched[String(p.planId)] = 1;
        var pv = String(p.voucherId || '');
        if (pv && !voucherSet[pv]) { voucherSet[pv] = 1; voucherOrder.push(pv); }
    });

    // The server sweeps in list order; oldest-first keeps shortfall attribution
    // on the newest orders (older orders ship sooner). voucherIds arrive
    // newest-first, so reverse the union.
    var vouchers = voucherOrder.slice().reverse();
    var plansTouchedArr = Object.keys(plansTouched);

    var btn = document.getElementById('confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    showRcvProgress('Receiving materials', 'Confirming your handover…');

    var RETRY_WAITS_MS = [3000, 8000, 20000, 45000, 60000];
    var retryCount = 0;
    var collectedErrors = [];
    var disputeIds = {};

    var sweepCursor = {};
    var firstSweep = true;
    var sweepN = 0;
    var finalizeN = 0;
    var finalizeCursor = {};
    var stage = 'sweep';

    var FINALIZE_PHASE_LABEL = {
        '': 'Updating handover status…',
        fan: 'Updating your orders…',
        vouchers: 'Updating handover status…',
        items: 'Updating your orders…',
        transfer: 'Moving stock to production…',
        notify: 'Wrapping up…'
    };

    function isRateLimited(err) {
        var msg = ((err && (err.message || err.error || err.toString())) || '')
            .toString().toLowerCase();
        return msg.indexOf('429') >= 0 || msg.indexOf('too many request') >= 0 ||
            msg.indexOf('rate limit') >= 0 || msg.indexOf('4834') >= 0 ||
            msg.indexOf('throttl') >= 0 || msg.indexOf('limit exceeded') >= 0;
    }

    function post(receiptsJson, onOk) {
        // Cursors go over as JSON STRINGS, not nested objects - the Deluge side
        // reads them with .toString().toMap(), and a hand-built Deluge Map's
        // toString() is not valid JSON, so never make the server round-trip one.
        if (receiptsJson.sweepCursor !== undefined) receiptsJson.sweepCursor = JSON.stringify(receiptsJson.sweepCursor || {});
        if (receiptsJson.finalizeCursor !== undefined) receiptsJson.finalizeCursor = JSON.stringify(receiptsJson.finalizeCursor || {});
        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'receiveMaterials',
            http_method: 'POST',
            payload: { supervisorId: supId, receiptsJson: JSON.stringify(receiptsJson) }
        }).then(function (response) {
            var parsed;
            try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }
            if (parsed && parsed.errors && parsed.errors.length > 0) {
                if (parsed.errors.some(function (e) { return isRateLimited({ message: e }); })) {
                    scheduleRetry({ message: parsed.errors.join(' ') });
                    return;
                }
                collectedErrors = collectedErrors.concat(parsed.errors);
            }
            retryCount = 0;
            onOk(parsed || {});
        }).catch(function (err) {
            if (isRateLimited(err)) { scheduleRetry(err); return; }
            abortRun(err);
        });
    }

    // ---- SPLIT RECEIVE PATH ----
    // receiveHandover (one call — settle the material×lot Issue_Lines + waste +
    // printed, drain stock, return perMaterial {arrived,short}) then loop
    // receiveFanOut (fan to Material_Requirement, dispute, readiness, transfer,
    // notify). The legacy receiveMaterials sweep/finalize below is the fallback.
    var USE_SPLIT_RECEIVE = true;
    var perMaterial = [];

    function splitInvoke(apiName, payloadObj, onOk) {
        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: apiName,
            http_method: 'POST',
            payload: { supervisorId: supId, payloadJson: JSON.stringify(payloadObj) }
        }).then(function (response) {
            var parsed;
            try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }
            if (parsed && parsed.errors && parsed.errors.length > 0) {
                if (parsed.errors.some(function (e) { return isRateLimited({ message: e }); })) {
                    scheduleRetry({ message: parsed.errors.join(' ') });
                    return;
                }
                collectedErrors = collectedErrors.concat(parsed.errors);
            }
            retryCount = 0;
            onOk(parsed || {});
        }).catch(function (err) {
            if (isRateLimited(err)) { scheduleRetry(err); return; }
            abortRun(err);
        });
    }

    function handoverStep() {
        stage = 'sweep';
        btn.textContent = 'Saving…';
        showRcvProgress('Receiving materials', 'Confirming your handover…');
        splitInvoke('receiveHandover', {
            vouchers: vouchers,
            shortMaterials: shortMaterials,
            waste: wasteRows,
            printedPieces: printedRows
        }, function (parsed) {
            perMaterial = parsed.perMaterial || [];
            (parsed.wasteDisputeIds || []).forEach(function (d) { disputeIds[String(d)] = 1; });
            finalizeCursor = {};
            fanStep();
        });
    }

    function fanStep() {
        stage = 'finalize';
        finalizeN++;
        var ph = (finalizeCursor && finalizeCursor.ph) || 'fan';
        btn.textContent = 'Finishing…';
        showRcvProgress('Finishing', FINALIZE_PHASE_LABEL[ph] || 'Finishing up…');
        splitInvoke('receiveFanOut', {
            perMaterial: perMaterial,
            vouchers: vouchers,
            plansTouched: plansTouchedArr,
            disputeIds: Object.keys(disputeIds),
            finalizeCursor: finalizeCursor
        }, function (parsed) {
            (parsed.disputeIds || []).forEach(function (d) { disputeIds[String(d)] = 1; });
            if (parsed.finalizeDone === true) {
                finishOk();
            } else {
                finalizeCursor = parsed.finalizeCursor || {};
                setTimeout(fanStep, 250);
            }
        });
    }

    function scheduleRetry(err) {
        if (retryCount >= RETRY_WAITS_MS.length) { abortRun(err); return; }
        var waitMs = RETRY_WAITS_MS[retryCount];
        retryCount++;
        console.warn('receiveMaterials rate-limited; retry ' + retryCount + '/' +
            RETRY_WAITS_MS.length + ' in ' + waitMs + 'ms');
        btn.textContent = 'Rate limited — retrying…';
        showRcvProgress(stage === 'sweep' ? 'Receiving materials' : 'Finishing',
            'Store is busy — retrying in ' + Math.round(waitMs / 1000) + 's…');
        var resume;
        if (USE_SPLIT_RECEIVE) {
            resume = stage === 'sweep' ? handoverStep : fanStep;
        } else {
            resume = stage === 'sweep' ? sweepStep : finalizeStep;
        }
        setTimeout(resume, waitMs);
    }

    function abortRun(err) {
        console.error('receiveMaterials aborted', err);
        closeRcvProgress();
        alert(stage === 'finalize'
            ? 'Receipt recorded. The status update did not finish — press Confirm again to complete it.'
            : 'Receipt saved so far. Press Confirm again to finish — it picks up where it stopped.');
        btn.disabled = false;
        btn.textContent = EDIT ? 'Confirm' : 'All received as listed';
    }

    function sweepStep() {
        stage = 'sweep';
        sweepN++;
        btn.textContent = 'Saving…';
        showRcvProgress('Receiving materials',
            sweepN === 1 ? 'Confirming your handover…' : 'Batch ' + sweepN + '…');
        var payload = {
            vouchers: vouchers,
            shortMaterials: shortMaterials,
            waste: firstSweep ? wasteRows : [],
            printedPieces: firstSweep ? printedRows : [],
            sweepCursor: sweepCursor,
            finalize: false
        };
        firstSweep = false;
        post(payload, function (parsed) {
            (parsed.disputeIds || []).forEach(function (d) { disputeIds[String(d)] = 1; });
            if (parsed.sweepDone === true || !parsed.sweepCursor) {
                finalizeCursor = {};
                finalizeStep();
            } else {
                sweepCursor = parsed.sweepCursor;
                setTimeout(sweepStep, 250);
            }
        });
    }

    function finalizeStep() {
        stage = 'finalize';
        finalizeN++;
        btn.textContent = 'Finishing…';
        var ph = (finalizeCursor && finalizeCursor.ph) || '';
        showRcvProgress('Finishing', FINALIZE_PHASE_LABEL[ph] || 'Finishing up…');
        var payload = {
            vouchers: vouchers,
            plansTouched: plansTouchedArr,
            disputeIds: Object.keys(disputeIds),
            finalize: true,
            finalizeCursor: finalizeCursor
        };
        post(payload, function (parsed) {
            if (parsed.finalizeDone === true) {
                finishOk();
            } else {
                finalizeCursor = parsed.finalizeCursor || {};
                setTimeout(finalizeStep, 250);
            }
        });
    }

    function finishOk() {
        showRcvProgress('Done', 'Receipt recorded', 100);
        setTimeout(closeRcvProgress, 400);
        if (collectedErrors.length > 0) {
            alert('Recorded, with discrepancies:\n' + collectedErrors.join('\n'));
        }
        // Push the consumption to Inventory now rather than waiting for the
        // nightly drain. Not awaited - the receipt is already recorded.
        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'postInventoryQueue',
            http_method: 'POST',
            payload: { dryRun: 'false' }
        }).then(function (drainRes) {
            console.log('inventory drain:', drainRes && drainRes.result);
        }).catch(function (drainErr) {
            console.warn('inventory drain failed, scheduled run will retry:', drainErr);
        });

        // receiveMaterials already ran postTransferOrders('auto') once (finalize
        // transfer phase), but that posts at most maxOrders per execution and a
        // receipt can span many SIV vouchers. Keep draining until nothing is
        // left waiting or no progress is made. Not awaited by the UI.
        drainTransferOrders(0);

        EDIT = false;
        loadMaterials();
    }

    function drainTransferOrders(callsSoFar) {
        var MAX_TO_CALLS = 12;
        if (callsSoFar >= MAX_TO_CALLS) {
            console.warn('drainTransferOrders: hit call cap, leaving the rest for the next run');
            return;
        }
        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'postTransferOrders',
            http_method: 'POST',
            payload: { dryRun: 'false' }
        }).then(function (resp) {
            var parsed = null;
            try {
                var r = resp && resp.result !== undefined ? resp.result : resp;
                parsed = typeof r === 'string' ? JSON.parse(r) : r;
                if (parsed && parsed.data !== undefined) parsed = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data;
            } catch (e) { parsed = null; }

            if (!parsed || (parsed.errors && parsed.errors.length)) {
                console.warn('postTransferOrders reported an error, stopping the drain:', parsed && parsed.errors);
                return;
            }
            var pending = Number(parsed.stillPending) || 0;
            var progressed = (Number(parsed.posted) || 0) + (Number(parsed.failed) || 0);
            console.log('transfer orders:', 'posted', parsed.posted, 'failed', parsed.failed,
                'stillPending', pending, 'needsHuman', parsed.needsHuman);

            if (pending > 0 && progressed > 0) {
                setTimeout(function () { drainTransferOrders(callsSoFar + 1); }, 400);
            }
        }).catch(function (err) {
            console.warn('postTransferOrders call failed, scheduled run will retry:', err);
        });
    }

    if (USE_SPLIT_RECEIVE) {
        handoverStep();
    } else {
        sweepStep();
    }
}

// ---- Load ----

// Returns true if it picked a supervisor for the user, so the caller knows the
// data it is holding was fetched for nobody and has to be re-fetched.
function fillSupervisors(list) {
    var sel = document.getElementById('sup-select');
    var current = sel.value;
    if (sel.dataset.filled === '1') return false;

    (list || []).forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        sel.appendChild(opt);
    });
    sel.dataset.filled = '1';
    if (current) {
        sel.value = current;
        return false;
    }

    // Nobody chosen yet, so choose the first one. This picker stands in for a
    // login, and a login does not open on "Choose supervisor…" — landing on an
    // empty screen that needs a dropdown touched before it shows anything reads
    // as a broken page rather than an unmade choice.
    //
    // Index 1 skips the placeholder option in the HTML.
    if (sel.options.length > 1) {
        sel.selectedIndex = 1;
        return true;
    }
    return false;
}

// getSupervisorMaterials is PAGED BY Issue_Line ROW. A supervisor with a huge
// old chunked handover has 1800+ lines on one voucher, and one call cannot walk
// them all without blowing Zoho's statement limit. So each call processes a
// slice of his Issue_Lines and returns linesConsumed; we call again with
// skipLines += linesConsumed until linesConsumed === 0, merging the slices.
//
// Merge rules mirror the payload contract:
//   materials  - keyed by materialId; pending sums, isFabric/isReissue OR.
//                orders merge by planId (a plan can be split across pages);
//                lots merge by lot label (qty sums); voucherIds union.
//   waste      - per Waste_Movement row, no overlap between pages: concat.
//   printedPieces - per issueLineId, no overlap: concat.
//   planFed    - union of plan ids; plansAwaiting = plansAssigned - |union|.
function mergeReceiptPages(target, page) {
    if (target.materials === undefined) {
        target.materials = [];
        target.waste = [];
        target.printedPieces = [];
        target.supervisors = page.supervisors || [];
        target.plansAssigned = Number(page.plansAssigned) || 0;
        target._planFed = {};
        target.errors = [];
    }
    (page.errors || []).forEach(function (e) { target.errors.push(e); });

    (page.materials || []).forEach(function (bm) {
        var em = null;
        for (var i = 0; i < target.materials.length; i++) {
            if (target.materials[i].materialId === bm.materialId) { em = target.materials[i]; break; }
        }
        if (!em) {
            target.materials.push(JSON.parse(JSON.stringify(bm)));
            return;
        }
        em.pending = round2((Number(em.pending) || 0) + (Number(bm.pending) || 0));
        if (bm.isFabric) em.isFabric = true;
        if (bm.isReissue) em.isReissue = true;

        // orders: one entry per plan; a plan whose lines span two pages appears
        // on both, so merge by planId rather than concat.
        em.orders = em.orders || [];
        (bm.orders || []).forEach(function (bo) {
            var eo = null;
            for (var j = 0; j < em.orders.length; j++) {
                if (String(em.orders[j].planId) === String(bo.planId)) { eo = em.orders[j]; break; }
            }
            if (eo) {
                eo.pending = round2((Number(eo.pending) || 0) + (Number(bo.pending) || 0));
                eo.lineCount = (Number(eo.lineCount) || 0) + (Number(bo.lineCount) || 0);
                if (bo.isReissue) eo.isReissue = true;
                if (!eo.reason && bo.reason) eo.reason = bo.reason;
            } else {
                em.orders.push(JSON.parse(JSON.stringify(bo)));
            }
        });

        // voucherIds: the sweep scope. Union, order does not matter here (the
        // widget reverses the whole set before sending).
        em.voucherIds = em.voucherIds || [];
        (bm.voucherIds || []).forEach(function (v) {
            if (em.voucherIds.indexOf(String(v)) < 0) em.voucherIds.push(String(v));
        });

        em.lots = em.lots || [];
        (bm.lots || []).forEach(function (bl) {
            var el = null;
            for (var k = 0; k < em.lots.length; k++) {
                if (em.lots[k].lot === bl.lot) { el = em.lots[k]; break; }
            }
            if (el) el.qty = round2((Number(el.qty) || 0) + (Number(bl.qty) || 0));
            else em.lots.push(JSON.parse(JSON.stringify(bl)));
        });
    });

    (page.waste || []).forEach(function (w) { target.waste.push(w); });
    (page.printedPieces || []).forEach(function (p) { target.printedPieces.push(p); });
    (page.planFed || []).forEach(function (pid) { target._planFed[String(pid)] = 1; });
}

// JS-Data-API receive read. When on, the list is assembled from flat
// getRecords (ReceiveRead.run) instead of the paged getSupervisorMaterials
// walk. Same output shape, so render()/submitReceipt() are unchanged. The
// Deluge path stays below as the fallback.
var USE_JS_RECEIVE_READ = true;

function loadMaterials() {
    var content = document.getElementById('rcv-content');
    var emptyState = document.getElementById('rcv-empty');
    var refreshBtn = document.getElementById('refresh-btn');
    var supId = document.getElementById('sup-select').value;

    emptyState.classList.add('hidden');
    refreshBtn.disabled = true;
    LoadProgress.start(content, 'Loading your deliveries…',
        'Reading the handovers the store has made to you.');

    if (USE_JS_RECEIVE_READ && typeof ReceiveRead !== 'undefined') {
        ReceiveRead.run(supId || '').then(function (data) {
            refreshBtn.disabled = false;
            LoadProgress.finish();
            // Empty supId: only the picker was populated. Default one in, restart.
            if ((!supId || supId === '') && fillSupervisors(data.supervisors)) {
                loadMaterials();
                return;
            }
            console.log('receive list (js):', data);
            if (data.errors && data.errors.length) {
                console.warn('ReceiveRead errors:', data.errors);
            }
            try {
                render(data);
            } catch (e) {
                console.error('render failed:', e, data);
                content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Could not read the list</h2><p>Check the browser console for details.</p></div>';
            }
        }).catch(function (err) {
            console.error('ReceiveRead failed, falling back to getSupervisorMaterials:', err);
            LoadProgress.finish();
            loadMaterialsDeluge();
        });
        return;
    }

    loadMaterialsDeluge();
}

function loadMaterialsDeluge() {
    var content = document.getElementById('rcv-content');
    var emptyState = document.getElementById('rcv-empty');
    var refreshBtn = document.getElementById('refresh-btn');
    var supId = document.getElementById('sup-select').value;

    emptyState.classList.add('hidden');
    refreshBtn.disabled = true;
    LoadProgress.start(content, 'Loading your deliveries…',
        'Reading the handovers the store has made to you.');

    var merged = {};
    var MAX_CALLS = 60; // safety cap - real stop is linesConsumed===0

    function fetchPage(skipLines, callsSoFar) {
        if (callsSoFar >= MAX_CALLS) {
            console.error('loadMaterials: hit MAX_CALLS safety cap, stopping');
            return Promise.resolve();
        }
        LoadProgress.setPage(callsSoFar + 1);
        return ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'getSupervisorMaterials',
            http_method: 'POST',
            payload: {
                supervisorId: supId || '',
                skipLinesTxt: String(skipLines)
            }
        }).then(function (response) {
            var parsed = JSON.parse(response.result);

            // Empty supervisorId fetch: only the picker is populated. Default one
            // in and restart.
            if ((!supId || supId === '') && fillSupervisors(parsed.supervisors)) {
                return null; // signal: restart
            }

            mergeReceiptPages(merged, parsed);
            var consumed = Number(parsed.linesConsumed) || 0;
            if (consumed > 0) {
                LoadProgress.setSub('Loaded ' + (merged.materials || []).length +
                    ' material' + ((merged.materials || []).length === 1 ? '' : 's') + ' so far…');
                return fetchPage(skipLines + consumed, callsSoFar + 1);
            }
        });
    }

    fetchPage(0, 0).then(function (restart) {
        refreshBtn.disabled = false;
        LoadProgress.finish();
        if (restart === null) { loadMaterials(); return; }

        merged.plansAwaiting = Math.max(0,
            (merged.plansAssigned || 0) - Object.keys(merged._planFed || {}).length);

        console.log('merged receipt list:', merged);
        if (merged.errors && merged.errors.length > 0) {
            console.warn('getSupervisorMaterials page errors:', merged.errors);
        }
        try {
            render(merged);
        } catch (e) {
            console.error('render failed:', e, merged);
            content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Could not read the list</h2><p>Check the browser console for details.</p></div>';
        }
    }).catch(function (err) {
        console.error('invokeCustomApi error:', err);
        refreshBtn.disabled = false;
        LoadProgress.finish();
        content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Failed to load</h2><p>Check the browser console for details.</p></div>';
    });
}

// The shell owns the picker and Refresh. Receive only says how to load itself.
TAB_LOADERS.receive = function () {
    EDIT = false;
    loadMaterials();
};

// Home tab, so it loads on arrival rather than waiting to be opened.
tabsLoaded.receive = true;
loadMaterials();
