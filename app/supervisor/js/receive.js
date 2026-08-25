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
                    ' &middot; cut ' + fmt(p.cutLength) + '&times;' + fmt(p.cutWidth) + ' cm</div>' +
            '</td>' +
            '<td class="col-lot">-</td>' +
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

    var payload = { materials: [], waste: [], printedPieces: [] };

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
        payload.materials.push({
            materialId: m.materialId,
            received: round2(val),
            remark: note ? note.value : ''
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
    });

    (data.printedPieces || []).forEach(function (p, i) {
        var input = document.getElementById(printedInputId(i));
        var note = document.getElementById(printedNoteId(i));
        var val = input ? (parseFloat(input.value) || 0) : p.pending;
        if (val < 0) val = 0;
        if (val > p.pending) val = p.pending;
        payload.printedPieces.push({
            issueLineId: p.issueLineId,
            received: round2(val),
            remark: note ? note.value : ''
        });
    });

    var btn = document.getElementById('confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'receiveMaterials',
        http_method: 'POST',
        payload: {
            supervisorId: supId,
            receiptsJson: JSON.stringify(payload)
        }
    }).then(function (response) {
        console.log('receive response:', response);
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            parsed = null;
        }
        if (parsed && parsed.errors && parsed.errors.length > 0) {
            alert('Recorded, with discrepancies:\n' + parsed.errors.join('\n'));
        }

        // Push the consumption receiveMaterials just queued straight to
        // Inventory, rather than waiting for the nightly drain.
        //
        // Fired from here, not from inside receiveMaterials, for two reasons:
        // it is a separate execution so it cannot spend that function's
        // statement budget, and a widget -> Custom API call is unmetered.
        //
        // Deliberately not awaited and never surfaced to the supervisor. The
        // receipt has already been recorded; if this fails the rows stay
        // Pending and the scheduled drain retries them. Telling him a stock
        // post failed would be asking him to act on something he cannot fix.
        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'postInventoryQueue',
            http_method: 'POST',
            payload: { dryRun: 'false' }
        }).then(function (drainRes) {
            console.log('inventory drain:', drainRes && drainRes.result);
        }).catch(function (drainErr) {
            console.warn('inventory drain failed, scheduled run will retry:', drainErr);
        });

        EDIT = false;
        loadMaterials();
    }).catch(function (err) {
        console.error('receiveMaterials error:', err);
        alert('Failed to save. Check the browser console for details.');
        btn.disabled = false;
        btn.textContent = EDIT ? 'Confirm' : 'All received as listed';
    });
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

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getSupervisorMaterials',
        http_method: 'POST',
        payload: { supervisorId: supId || '' }
    }).then(function (response) {
        console.log('raw response:', response);
        refreshBtn.disabled = false;
        try {
            var parsed = JSON.parse(response.result);
            console.log('parsed:', parsed);
            // This response was fetched with an empty supervisorId, so its
            // materials are empty by construction. Fetch again for whoever was
            // just defaulted in rather than rendering "nothing to receive".
            if (fillSupervisors(parsed.supervisors)) {
                loadMaterials();
                return;
            }
            render(parsed);
        } catch (e) {
            console.error('JSON.parse failed:', e, response.result);
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
