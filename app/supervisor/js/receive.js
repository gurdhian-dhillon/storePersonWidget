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

function renderMaterialRow(m, i) {
    var qtyCell = '<span class="qty-big">' + fmt(m.pending) +
        '<span class="unit">' + escapeHtml(m.unit) + '</span></span>';

    // The per-order split only matters when he is short and has to decide who
    // goes without, so it stays folded away until then. Each chip spells out
    // what that order is expecting — "SO-00003 · 14.6" alone left him guessing
    // whether the number was ordered, issued or outstanding.
    var orders = '';
    if (EDIT && m.orders && m.orders.length > 0) {
        orders = '<div class="order-split">' + m.orders.map(function (o) {
            // WHICH of the orders behind the figure is the reissue, and why. The
            // header badge only says one of them is; when he is short and has to
            // decide who goes without, "this 1.2m replaces panels I cut through"
            // is a different call from "this order is still owed 14.6m".
            return '<span class="order-chip' + (o.isReissue === true ? ' is-reissue' : '') + '"' +
                (o.reason ? ' title="' + escapeHtml(o.reason) + '"' : '') + '>' +
                escapeHtml(o.salesOrder || o.planNo) +
                (o.isReissue === true ? ' <b>reissue</b>' : '') +
                ' needs <b>' + fmt(o.pending) + '</b> ' + escapeHtml(m.unit) + '</span>';
        }).join('') + '</div>';
    }

    if (!EDIT) {
        return '' +
            '<tr id="' + matRowId(i) + '">' +
                '<td class="material-name-cell">' +
                    '<div class="mat-name">' + escapeHtml(m.material) +
                        (m.isFabric ? '<span class="fabric-badge">Fabric</span>' : '') +
                        // Part of this delivery replaces material he ruined. The
                        // pending figure merges every plan and requirement behind
                        // it into one number, so without this he signs for a
                        // quantity with no idea that some of it is the cloth he
                        // asked for himself — the one thing about the delivery he
                        // already has context for.
                        (m.isReissue === true
                            ? '<span class="reissue-tag">incl. reissue</span>'
                            : '') +
                    '</div>' +
                '</td>' +
                lotColumn(m) +
                '<td class="col-num col-strong">' + qtyCell + '</td>' +
                '<td class="col-issue">' +
                    '<span class="status-pill status-partial">Awaiting check</span>' +
                '</td>' +
            '</tr>';
    }

    // The note gets its own column rather than sitting under the quantity. In
    // one cell it doubled every row's height and pushed the figures out of line
    // with their own column headings.
    return '' +
        '<tr id="' + matRowId(i) + '">' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(m.material) +
                    (m.isFabric ? '<span class="fabric-badge">Fabric</span>' : '') +
                    // Part of this delivery replaces material he ruined. The
                    // pending figure merges every plan and requirement behind it
                    // into one number, so without this he signs for a quantity
                    // with no idea that some of it is the cloth he asked for
                    // himself — the one thing about the delivery he already has
                    // context for.
                    (m.isReissue === true
                        ? '<span class="reissue-tag">incl. reissue</span>'
                        : '') +
                '</div>' +
                orders +
            '</td>' +
            lotColumn(m) +
            '<td class="col-num col-strong">' + qtyCell + '</td>' +
            '<td class="col-issue">' +
                '<span class="issue-input-group">' +
                    '<input type="number" step="0.01" min="0" max="' + round2(m.pending) + '" ' +
                        'class="issue-input" ' +
                        'id="' + matInputId(i) + '" value="' + round2(m.pending) + '" ' +
                        'oninput="onMatInput(' + i + ')" ' +
                        'onblur="onMatCommit(' + i + ')" />' +
                    '<span class="issue-unit">' + escapeHtml(m.unit) + '</span>' +
                '</span>' +
                // Says the shortfall out loud instead of leaving him to subtract
                // two numbers in his head — and it is the shortfall, not the
                // typed figure, that becomes a dispute.
                '<div class="short-hint" id="' + matShortId(i) + '"></div>' +
            '</td>' +
            '<td class="col-note">' +
                '<input type="text" class="note-input" id="' + matNoteId(i) + '" ' +
                    'placeholder="Why is it short?" disabled />' +
            '</td>' +
        '</tr>';
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

function submitReceipt() {
    var data = window.__data;
    var supId = document.getElementById('sup-select').value;
    if (!supId) return;

    var payload = { materials: [], waste: [], printedPieces: [], plansTouched: [] };

    // Plans this receipt touches - receiveMaterials runs its readiness sweep on
    // exactly these instead of walking every open plan (the old statement-limit
    // path). Union of every settlement line's planId plus every waste/printed
    // row's plan, deduped.
    var plansTouched = {};

    (data.materials || []).forEach(function (m, i) {
        var input = document.getElementById(matInputId(i));
        var note = document.getElementById(matNoteId(i));
        // Not in edit mode means "all as listed", so the full pending amount.
        var val = input ? (parseFloat(input.value) || 0) : m.pending;
        // Clamped again here rather than trusting the field. Blur normally
        // settles it, but pressing Enter submits without one, and receiving
        // more than was issued would settle stock that never moved.
        if (val < 0) val = 0;
        if (val > m.pending) val = m.pending;

        // DISTRIBUTE the confirmed quantity across the still-owed Issue_Lines,
        // OLDEST FIRST - the same rule receiveMaterials used to run server-side.
        // getSupervisorMaterials emits m.lines newest-first (voucher loop is
        // Added_Time desc), so reverse. Each line owes `pending`; the whole of
        // that is settled off In_Transit either way, and `confirmed` is how much
        // of it he actually got - the rest becomes the shortfall / dispute.
        var lines = (m.lines || []).slice().reverse();
        var confirmLeft = round2(val);
        var settlements = [];
        lines.forEach(function (ln) {
            var owe = Number(ln.pending) || 0;
            if (owe <= 0) return;
            var conf = confirmLeft;
            if (conf > owe) conf = owe;
            confirmLeft = round2(confirmLeft - conf);
            settlements.push({
                issueLineId: ln.issueLineId,
                voucherId: ln.voucherId,
                lot: ln.lot || '',
                requirementId: ln.requirementId || '',
                planId: ln.planId || '',
                settle: round2(owe),
                confirmed: round2(conf)
            });
            if (ln.planId) plansTouched[String(ln.planId)] = 1;
        });

        payload.materials.push({
            materialId: m.materialId,
            received: round2(val),
            remark: note ? note.value : '',
            settlements: settlements
        });
    });

    (data.waste || []).forEach(function (w, i) {
        var input = document.getElementById(wasteInputId(i));
        var note = document.getElementById(wasteNoteId(i));
        var val = input ? (parseInt(input.value, 10) || 0) : w.pending;
        if (val < 0) val = 0;
        if (val > w.pending) val = w.pending;
        payload.waste.push({
            rowId: w.rowId,
            received: val,
            remark: note ? note.value : ''
        });
        if (w.planId) plansTouched[String(w.planId)] = 1;
    });

    (data.printedPieces || []).forEach(function (p, i) {
        var input = document.getElementById(printedInputId(i));
        var note = document.getElementById(printedNoteId(i));
        var val = input ? (parseFloat(input.value) || 0) : p.pending;
        if (val < 0) val = 0;
        if (val > p.pending) val = p.pending;
        payload.printedPieces.push({
            issueLineId: p.issueLineId,
            voucherId: p.voucherId,
            received: round2(val),
            remark: note ? note.value : ''
        });
        if (p.planId) plansTouched[String(p.planId)] = 1;
    });

    var allPlansTouched = Object.keys(plansTouched);

    var btn = document.getElementById('confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    // ---- CHUNKING ----
    //
    // A big receipt has hundreds of settlement lines - one invokeCustomApi
    // payload cannot carry them and one execution cannot apply them (the
    // statement-execution limit, which is not catchable). Same shape as
    // issueForSupervisor: split into chunks of at most MAX_ROWS settlement /
    // waste / printed rows, send them sequentially, recover from rate limiting.
    //
    // Every chunk but the last carries finalize:false - it only applies its
    // rows. The last carries finalize:true and the FULL plansTouched list, and
    // does the readiness sweep + warehouse transfer once for the whole receipt.
    var MAX_ROWS = 120;

    // Flatten every settlement into a work list, tagged with its parent material
    // so a chunk can rebuild the materials[] wrapper. Waste + printed rows ride
    // along in the same budget.
    var work = [];
    payload.materials.forEach(function (m) {
        (m.settlements || []).forEach(function (s) {
            work.push({ kind: 'mat', materialId: m.materialId, received: m.received,
                remark: m.remark, s: s });
        });
        if (!m.settlements || m.settlements.length === 0) {
            // A material with nothing still owed (received === 0 lines) - keep it
            // so its okJson row is still emitted. Rare; costs one slot.
            work.push({ kind: 'mat', materialId: m.materialId, received: m.received,
                remark: m.remark, s: null });
        }
    });
    payload.waste.forEach(function (w) { work.push({ kind: 'waste', w: w }); });
    payload.printedPieces.forEach(function (p) { work.push({ kind: 'printed', p: p }); });

    // Build the chunk payloads.
    var chunks = [];
    for (var off = 0; off < work.length; off += MAX_ROWS) {
        var slice = work.slice(off, off + MAX_ROWS);
        var matMap = {};
        var order = [];
        var cp = { materials: [], waste: [], printedPieces: [], plansTouched: [],
            finalize: false };
        slice.forEach(function (item) {
            if (item.kind === 'mat') {
                var mw = matMap[item.materialId];
                if (!mw) {
                    mw = { materialId: item.materialId, received: item.received,
                        remark: item.remark, settlements: [] };
                    matMap[item.materialId] = mw;
                    order.push(item.materialId);
                }
                if (item.s) mw.settlements.push(item.s);
            } else if (item.kind === 'waste') {
                cp.waste.push(item.w);
            } else {
                cp.printedPieces.push(item.p);
            }
        });
        order.forEach(function (id) { cp.materials.push(matMap[id]); });
        chunks.push(cp);
    }
    // Every settlement chunk carries finalize:false - it only applies its rows.
    // The readiness sweep + warehouse transfer run afterwards, in finalizeLoop,
    // which is itself resumable (receiveMaterials caps the sweep per call and
    // hands back the plan ids it did not reach).
    chunks.forEach(function (cp) { cp.finalize = false; });

    var chunkIndex = 0;
    var retryCount = 0;
    var RETRY_WAITS_MS = [3000, 8000, 20000, 45000, 60000];
    var collectedErrors = [];

    // Plan ids still to sweep. Seeded with the whole set; each finalize call
    // returns sweepRemaining and we go again until sweepDone.
    var sweepQueue = allPlansTouched.slice();
    var finalizePass = 0;

    function isRateLimited(err) {
        var msg = ((err && (err.message || err.error || err.toString())) || '')
            .toString().toLowerCase();
        return msg.indexOf('429') >= 0 || msg.indexOf('too many request') >= 0 ||
            msg.indexOf('rate limit') >= 0 || msg.indexOf('4834') >= 0 ||
            msg.indexOf('throttl') >= 0 || msg.indexOf('limit exceeded') >= 0;
    }

    function finishOk() {
        if (collectedErrors.length > 0) {
            alert('Recorded, with discrepancies:\n' + collectedErrors.join('\n'));
        }
        // Push the consumption straight to Inventory rather than waiting for the
        // nightly drain. Not awaited, never surfaced - the receipt is recorded;
        // a failed post is retried by the scheduled run.
        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'postInventoryQueue',
            http_method: 'POST',
            payload: { dryRun: 'false' }
        }).then(function (drainRes) {
            console.log('inventory drain:', drainRes && drainRes.result);
        }).catch(function (drainErr) {
            console.warn('inventory drain failed, scheduled run will retry:', drainErr);
        });

        // WAREHOUSE TRANSFER ORDERS - drain the rest.
        //
        // receiveMaterials already called postTransferOrders('auto') once on its
        // finalize pass, but that posts at most maxOrders (10) transfer orders
        // per execution - and a chunked handover is now MANY small SIV vouchers
        // (one per issue chunk), so one receipt can leave 15-25 vouchers still
        // Pending. Each is its own transfer order keyed to its own SIV number;
        // nothing merges. So keep calling 'auto' - each call its own unmetered
        // execution - until it reports nothing left waiting, no progress was
        // made, or a safety cap is hit. Not awaited by the UI: the receipt is
        // already saved and a leftover Pending voucher is picked up by the next
        // receipt or a scheduled run.
        drainTransferOrders(0);

        EDIT = false;
        loadMaterials();
    }

    function drainTransferOrders(callsSoFar) {
        var MAX_TO_CALLS = 12; // 12 * maxOrders(10) = 120 vouchers, well past any real receipt
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
            // pending>0 but progressed==0 -> the rest are Failed/needsHuman; stop.
        }).catch(function (err) {
            console.warn('postTransferOrders call failed, scheduled run will retry:', err);
        });
    }

    // `stage` is which loop the retry timer should resume - 'chunk' or 'final'.
    var retryStage = 'chunk';

    function abortRun(err) {
        console.error('receiveMaterials aborted', err);
        var where = retryStage === 'final'
            ? 'Settlements saved. Status update did not finish — press Confirm again to complete it.'
            : 'Receipt saved up to batch ' + chunkIndex + ' of ' + chunks.length +
              '. Batches before this went through. Press Confirm again to finish the rest.';
        alert(where);
        btn.disabled = false;
        btn.textContent = EDIT ? 'Confirm' : 'All received as listed';
    }

    function scheduleRetry(err) {
        if (retryCount >= RETRY_WAITS_MS.length) { abortRun(err); return; }
        var waitMs = RETRY_WAITS_MS[retryCount];
        retryCount++;
        console.warn('receiveMaterials rate-limited; retry ' + retryCount + '/' +
            RETRY_WAITS_MS.length + ' in ' + waitMs + 'ms');
        btn.textContent = 'Rate limited — retrying in ' + Math.round(waitMs / 1000) + 's…';
        setTimeout(retryStage === 'final' ? finalizeLoop : processNextChunk, waitMs);
    }

    function processNextChunk() {
        retryStage = 'chunk';
        if (chunkIndex >= chunks.length) { finalizeLoop(); return; }

        var cp = chunks[chunkIndex];
        btn.textContent = 'Saving… (' + (chunkIndex + 1) + '/' + chunks.length + ')';

        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'receiveMaterials',
            http_method: 'POST',
            payload: {
                supervisorId: supId,
                receiptsJson: JSON.stringify(cp)
            }
        }).then(function (response) {
            var parsed;
            try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }

            if (parsed && parsed.errors && parsed.errors.length > 0) {
                // A Deluge-side throttle surfaces here, not in .catch.
                if (parsed.errors.some(function (e) { return isRateLimited({ message: e }); })) {
                    scheduleRetry({ message: parsed.errors.join(' ') });
                    return;
                }
                collectedErrors = collectedErrors.concat(parsed.errors);
            }

            chunkIndex++;
            retryCount = 0;
            setTimeout(processNextChunk, 400); // pace between chunks
        }).catch(function (err) {
            if (isRateLimited(err)) { scheduleRetry(err); return; }
            abortRun(err);
        });
    }

    // Readiness sweep + warehouse transfer, resumable. Each call sweeps a
    // budgeted slice of sweepQueue and returns the rest in sweepRemaining; we
    // keep calling until sweepDone. A receipt with no plansTouched still makes
    // one pass so postTransferOrders runs.
    function finalizeLoop() {
        retryStage = 'final';
        finalizePass++;
        btn.textContent = 'Finishing… (' + finalizePass + ')';

        var cp = {
            materials: [], waste: [], printedPieces: [],
            finalize: true,
            plansTouched: sweepQueue
        };

        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'receiveMaterials',
            http_method: 'POST',
            payload: {
                supervisorId: supId,
                receiptsJson: JSON.stringify(cp)
            }
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

            var remaining = (parsed && parsed.sweepRemaining) || [];
            var done = !parsed || parsed.sweepDone === true || remaining.length === 0;

            if (!done && remaining.length > 0 && remaining.length < sweepQueue.length) {
                // Progress made - go again with what's left.
                sweepQueue = remaining;
                retryCount = 0;
                setTimeout(finalizeLoop, 400);
                return;
            }
            if (!done && remaining.length >= sweepQueue.length) {
                // No progress - stop rather than loop forever.
                console.error('finalize made no progress; remaining plans:', remaining);
                collectedErrors.push('Status update did not finish for ' +
                    remaining.length + ' order(s). Press Confirm again.');
            }
            finishOk();
        }).catch(function (err) {
            if (isRateLimited(err)) { scheduleRetry(err); return; }
            abortRun(err);
        });
    }

    processNextChunk();
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
//   materials  - keyed by materialId; pending sums, orders concat, lots merge
//                by lot label (qty sums). isFabric/isReissue OR together.
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
        em.pending = (Number(em.pending) || 0) + (Number(bm.pending) || 0);
        if (bm.isFabric) em.isFabric = true;
        if (bm.isReissue) em.isReissue = true;
        em.orders = (em.orders || []).concat(bm.orders || []);
        // The per-Issue_Line detail receiveMaterials settles against. Pages never
        // overlap on a line (the cursor steps each line exactly once), so concat.
        em.lines = (em.lines || []).concat(bm.lines || []);
        (bm.lots || []).forEach(function (bl) {
            var el = null;
            for (var j = 0; j < (em.lots || []).length; j++) {
                if (em.lots[j].lot === bl.lot) { el = em.lots[j]; break; }
            }
            if (el) el.qty = (Number(el.qty) || 0) + (Number(bl.qty) || 0);
            else { em.lots = em.lots || []; em.lots.push(JSON.parse(JSON.stringify(bl))); }
        });
    });

    (page.waste || []).forEach(function (w) { target.waste.push(w); });
    (page.printedPieces || []).forEach(function (p) { target.printedPieces.push(p); });
    (page.planFed || []).forEach(function (pid) { target._planFed[String(pid)] = 1; });
}

function loadMaterials() {
    var content = document.getElementById('rcv-content');
    var emptyState = document.getElementById('rcv-empty');
    var refreshBtn = document.getElementById('refresh-btn');
    var supId = document.getElementById('sup-select').value;

    emptyState.classList.add('hidden');
    refreshBtn.disabled = true;
    content.innerHTML =
        '<div class="skeleton-card"><div class="skeleton-line w-40"></div>' +
        '<div class="skeleton-line"></div><div class="skeleton-line"></div>' +
        '<div class="skeleton-line w-70"></div></div>';

    var merged = {};
    var MAX_CALLS = 60; // safety cap - real stop is linesConsumed===0

    function fetchPage(skipLines, callsSoFar) {
        if (callsSoFar >= MAX_CALLS) {
            console.error('loadMaterials: hit MAX_CALLS safety cap, stopping');
            return Promise.resolve();
        }
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
                return fetchPage(skipLines + consumed, callsSoFar + 1);
            }
        });
    }

    fetchPage(0, 0).then(function (restart) {
        refreshBtn.disabled = false;
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
