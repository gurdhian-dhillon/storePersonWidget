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

// Number + muted unit suffix. Zero values are de-emphasised so the eye lands
// on the rows that actually need something.
function qty(n, unit, opts) {
    var isZero = (Number(n) || 0) === 0;
    var cls = isZero && !(opts && opts.keepZero) ? ' class="is-zero"' : '';
    return '<span' + cls + '>' + fmt(n) + '<span class="unit">' + escapeHtml(unit) + '</span></span>';
}

function stockStatus(material) {
    if (material.availableStock >= material.remaining) {
        return { cls: 'status-sufficient', label: 'In stock' };
    }
    if (material.availableStock > 0) {
        return { cls: 'status-partial', label: 'Partial' };
    }
    return { cls: 'status-shortfall', label: 'No stock' };
}

function maxIssuable(material) {
    return round2(Math.max(0, Math.min(material.remaining, material.availableStock)));
}

// What to pre-fill the input with. For fabric the server has already worked out
// how many pieces the waste stock covers, so freshMeters is less than the full
// requirement - pre-filling the old maximum would hand out fabric the store
// person does not need to cut. maxIssuable stays the validation ceiling.
function suggestedIssue(material) {
    if (material.isFabric && material.freshMeters !== undefined && material.freshMeters !== null) {
        return round2(Math.max(0, Math.min(Number(material.freshMeters) || 0, material.availableStock)));
    }
    return maxIssuable(material);
}

function wastePicks(material) {
    return (material.isFabric && material.wastePicks) ? material.wastePicks : [];
}

// ---- Lots ----
//
// Fabric leaves the shelf from a named lot, because a lot is a TONE. The store
// person picks; the screen only advises. He can see the rack — no rule we write
// knows that one lot is nearly finished or that another is behind a pallet.
//
// Non-fabric has no lots and none of this runs.
function lotsFor(material) {
    return (material.isFabric && material.lots) ? material.lots : [];
}

function lotInputId(supIdx, matIdx, lotIdx) {
    return 'lot-input-' + supIdx + '-' + matIdx + '-' + lotIdx;
}

// What has been typed across this row's lots.
function lotSum(supIdx, matIdx, material) {
    var total = 0;
    lotsFor(material).forEach(function (l, lotIdx) {
        var el = document.getElementById(lotInputId(supIdx, matIdx, lotIdx));
        if (el) total += parseFloat(el.value) || 0;
    });
    return round2(total);
}

// THE CEILING THE TYPED TOTAL IS CHECKED AGAINST, and for fabric issued from
// lots it is availableStock — NOT `remaining`.
//
// `remaining` is the metres the pieces would need as ONE continuous piece.
// Split across lots, each lot is cut on its own and loses its part-row, so a
// correct split legitimately needs a little more: 100 pieces at 2 per row is
// 27.50m in one piece but 20 + 7.70 across two lots. Validating against
// `remaining` would mark that invalid and refuse to issue the last two pieces —
// the same stranded-piece failure the per-lot budget on the server exists to
// prevent, re-introduced in the UI.
//
// Each lot's own input is still capped at that lot's washed stock, which is the
// guard that actually matters, and the server trims anything surplus per pass.
function issueCeiling(material) {
    if (material.isFabric && lotsFor(material).length > 0) {
        return round2(Math.max(0, Number(material.availableStock) || 0));
    }
    return maxIssuable(material);
}

// Waste pieces now live in their own section with their own rows, so a fabric
// metres row is issuable on metres alone again.
function rowIssuable(material) {
    return maxIssuable(material) > 0;
}

// Every waste pick across the card, flattened to one entry per pick so each can
// be its own row with its own checkbox.
function wasteRowsFor(sup) {
    var rows = [];
    sup.materials.forEach(function (m, matIdx) {
        wastePicks(m).forEach(function (p, pickIdx) {
            rows.push({ m: m, matIdx: matIdx, pick: p, pickIdx: pickIdx });
        });
    });
    return rows;
}

function wasteCheckboxId(supIdx, matIdx, pickIdx) {
    return 'waste-check-' + supIdx + '-' + matIdx + '-' + pickIdx;
}
function wasteInputId(supIdx, matIdx, pickIdx) {
    return 'waste-input-' + supIdx + '-' + matIdx + '-' + pickIdx;
}
function wasteRowId(supIdx, matIdx, pickIdx) {
    return 'waste-row-' + supIdx + '-' + matIdx + '-' + pickIdx;
}
// ---- Soft allocation (UI-level, first-come-first-served) ----
//
// Stock is shared, so a material contested by two supervisors would let the
// store person issue it twice over and only discover the shortfall afterwards.
// Walking supervisors in card order and subtracting what earlier ones still
// need gives the first supervisor the real stock figure and every later one
// what is genuinely left for them.
//
// This is advisory only - nothing is reserved in Creator, and the Deluge
// function still validates against true live stock at issue time.
function applyStockAllocation(data) {
    // Stock is shared. Rather than hiding stock from later supervisors, we show
    // the true stock to everyone and attach a warning about who else needs it.
    
    // 1. Gather all demand across all supervisors
    var demand = {};
    data.forEach(function (sup) {
        sup.materials.forEach(function (m) {
            var req = Number(m.remaining) || 0;
            if (req <= 0) return;
            var key = String(m.materialId);
            if (!demand[key]) demand[key] = [];
            demand[key].push({
                name: sup.supervisorName,
                needed: req
            });
        });
    });

    // 2. Attach contention info without altering available stock
    data.forEach(function (sup) {
        sup.materials.forEach(function (m) {
            var key = String(m.materialId);
            var others = (demand[key] || []).filter(function (d) {
                return d.name !== sup.supervisorName;
            });

            m.totalStock = Number(m.availableStock) || 0;
            m.contestedBy = others;
            // heldByOthers is used for the card header 'X contested' badge
            m.heldByOthers = others.reduce(function (sum, d) { return sum + d.needed; }, 0);
        });
    });
}

// ---- Row-level issue input handling ----

function rowInputId(supIdx, matIdx) {
    return 'issue-input-' + supIdx + '-' + matIdx;
}
function rowCheckboxId(supIdx, matIdx) {
    return 'issue-check-' + supIdx + '-' + matIdx;
}
function rowId(supIdx, matIdx) {
    return 'issue-row-' + supIdx + '-' + matIdx;
}

function validateRow(supIdx, matIdx, material) {
    var input = document.getElementById(rowInputId(supIdx, matIdx));
    if (!input) return;
    var val = parseFloat(input.value) || 0;
    var maxAllowed = issueCeiling(material);
    if (val < 0 || val > maxAllowed + 0.0001) {
        input.classList.add('invalid');
        input.title = 'Max issuable is ' + fmt(maxAllowed) + ' ' + material.unit;
    } else {
        input.classList.remove('invalid');
        input.title = '';
    }
}

function markRowSelected(supIdx, matIdx) {
    var row = document.getElementById(rowId(supIdx, matIdx));
    var checkbox = document.getElementById(rowCheckboxId(supIdx, matIdx));
    if (!row || !checkbox) return;
    row.classList.toggle('row-selected', checkbox.checked);
}

function onIssueInputChange(supIdx, matIdx) {
    var input = document.getElementById(rowInputId(supIdx, matIdx));
    var checkbox = document.getElementById(rowCheckboxId(supIdx, matIdx));
    var val = parseFloat(input.value);
    var material = window.__reqData[supIdx].materials[matIdx];
    // Typing 0 metres does not clear the row when waste pieces still go with it.
    checkbox.checked = !(isNaN(val) || val <= 0) || wastePicks(material).length > 0;
    validateRow(supIdx, matIdx, material);
    markRowSelected(supIdx, matIdx);
    refreshCardState(supIdx);
}

function onIssueCheckboxChange(supIdx, matIdx) {
    setRowChecked(supIdx, matIdx, document.getElementById(rowCheckboxId(supIdx, matIdx)).checked);
    refreshCardState(supIdx);
}

function setRowChecked(supIdx, matIdx, checked) {
    var input = document.getElementById(rowInputId(supIdx, matIdx));
    var checkbox = document.getElementById(rowCheckboxId(supIdx, matIdx));
    if (!input || !checkbox || checkbox.disabled) return;
    var material = window.__reqData[supIdx].materials[matIdx];

    // Nothing issuable — never let it appear selected.
    if (checked && !rowIssuable(material)) {
        checkbox.checked = false;
        input.value = 0;
    } else if (checked) {
        checkbox.checked = true;
        // The waste-adjusted figure, not the ceiling — select-all must not
        // hand out more fabric than the cutting actually needs.
        input.value = suggestedIssue(material);
    } else {
        checkbox.checked = false;
        input.value = 0;
    }
    validateRow(supIdx, matIdx, material);
    markRowSelected(supIdx, matIdx);
}

// ---- Waste cut-piece rows ----

function setWasteChecked(supIdx, matIdx, pickIdx, checked) {
    var checkbox = document.getElementById(wasteCheckboxId(supIdx, matIdx, pickIdx));
    var input = document.getElementById(wasteInputId(supIdx, matIdx, pickIdx));
    if (!checkbox || !input) return;
    var pick = window.__reqData[supIdx].materials[matIdx].wastePicks[pickIdx];
    checkbox.checked = checked;
    input.value = checked ? pick.pieces : 0;
    var row = document.getElementById(wasteRowId(supIdx, matIdx, pickIdx));
    if (row) row.classList.toggle('row-selected', checked);
}

function onWasteCheckboxChange(supIdx, matIdx, pickIdx) {
    setWasteChecked(supIdx, matIdx, pickIdx,
        document.getElementById(wasteCheckboxId(supIdx, matIdx, pickIdx)).checked);
    refreshCardState(supIdx);
}

function onWasteInputChange(supIdx, matIdx, pickIdx) {
    var input = document.getElementById(wasteInputId(supIdx, matIdx, pickIdx));
    var checkbox = document.getElementById(wasteCheckboxId(supIdx, matIdx, pickIdx));
    var pick = window.__reqData[supIdx].materials[matIdx].wastePicks[pickIdx];
    var val = parseInt(input.value, 10);

    // Pieces are whole things — you cannot hand over 1.5 of a cut piece.
    if (isNaN(val) || val < 0) val = 0;
    if (val > pick.pieces) val = pick.pieces;
    input.value = val;

    checkbox.checked = val > 0;
    var row = document.getElementById(wasteRowId(supIdx, matIdx, pickIdx));
    if (row) row.classList.toggle('row-selected', val > 0);
    refreshCardState(supIdx);
}

// ---- Master (select-all) checkboxes, one per section ----

function selectAllId(supIdx, section) {
    return 'select-all-' + supIdx + '-' + section;
}

function onSelectAllChange(supIdx, section) {
    var master = document.getElementById(selectAllId(supIdx, section));
    var sup = window.__reqData[supIdx];

    // Waste rows now live inside their material's fabric group, so the fabric
    // master toggles both supply lines together.
    sup.materials.forEach(function (m, i) {
        if (sectionOf(m) !== section) return;
        setRowChecked(supIdx, i, master.checked);
        wastePicks(m).forEach(function (p, pickIdx) {
            setWasteChecked(supIdx, i, pickIdx, master.checked);
        });
    });
    refreshCardState(supIdx);
}

// Four sections, not two: a reissue never shares a table with the plan's own
// demand, so it must not share a select-all either. "Issue all fabric" ticking a
// reissue row the store had not yet decided to honour is exactly the merging
// this split exists to prevent.
function sectionOf(m) {
    var re = m && m.isReissue === true;
    if (m.isFabric) return re ? 'refabric' : 'fabric';
    return re ? 'reother' : 'other';
}

// One list, used by both the tally and the master-checkbox sweep, so the two can
// never drift apart.
var ISSUE_SECTIONS = ['fabric', 'other', 'refabric', 'reother'];

// A fabric line whose pieces are entirely covered by waste needs no fresh
// fabric at all, so it has no business in the Fabric table — it would render as
// "0 Mtr", disabled and unissuable, next to the waste rows that actually cover
// it. Fully-issued rows still show, as receipts.
function needsFreshFabric(m) {
    if (!m.isFabric) return true;
    if (isFullyIssued(m)) return true;
    return !(m.freshPieces === 0 && m.piecesCoveredByWaste > 0);
}

// Keeps the master checkbox (checked / indeterminate / unchecked), the selection
// counter and the submit button in sync with the individual rows.
function refreshCardState(supIdx) {
    var sup = window.__reqData[supIdx];
    var materials = sup.materials;
    var tally = {};
    ISSUE_SECTIONS.forEach(function (s) { tally[s] = { sel: 0, can: 0 }; });

    materials.forEach(function (m, i) {
        var t = tally[sectionOf(m)];

        var checkbox = document.getElementById(rowCheckboxId(supIdx, i));
        if (checkbox && !checkbox.disabled) {
            if (rowIssuable(m)) t.can++;
            if (checkbox.checked) t.sel++;
        }

        wastePicks(m).forEach(function (p, pickIdx) {
            var wCheck = document.getElementById(wasteCheckboxId(supIdx, i, pickIdx));
            if (!wCheck || wCheck.disabled) return;
            t.can++;
            if (wCheck.checked) t.sel++;
        });
    });

    ISSUE_SECTIONS.forEach(function (section) {
        var master = document.getElementById(selectAllId(supIdx, section));
        if (!master) return;
        var t = tally[section];
        master.checked = t.can > 0 && t.sel >= t.can;
        master.indeterminate = t.sel > 0 && t.sel < t.can;
        master.disabled = t.can === 0;
    });

    // ACROSS EVERY SECTION, reissue included. These two drive the counter and
    // the Issue button, and while they summed only fabric+other a card holding
    // nothing but reissue rows read "Nothing left to issue" with its rows ticked
    // and its button dead — the tally knew about them, the total did not.
    var selectable = 0;
    var selected = 0;
    ISSUE_SECTIONS.forEach(function (s) {
        selectable += tally[s].can;
        selected += tally[s].sel;
    });

    var counter = document.getElementById('sel-count-' + supIdx);
    if (counter) {
        if (selectable === 0) {
            counter.textContent = 'Nothing left to issue';
        } else if (selected === 0) {
            counter.textContent = 'No materials selected';
        } else {
            counter.textContent = selected + ' of ' + selectable + ' selected';
        }
        counter.classList.toggle('is-empty', selected === 0);
    }

    var btn = document.getElementById('issue-btn-' + supIdx);
    if (btn && !btn.dataset.busy) {
        btn.disabled = selected === 0;
    }
}

// ---- Rendering ----

// A row is done when nothing is left to issue against it. Fully-issued rows
// become a read-only receipt instead of a dead, disabled input.
//
// Fabric is judged on PIECES, not metres. `remaining` carries the waste-adjusted
// metres, so a requirement fully covered by waste sits at 0 metres from the
// start — judging on metres would mark it issued before anything was handed out.
function isFullyIssued(m) {
    if (m.isFabric && m.requiredPieces !== undefined) {
        return m.requiredPieces > 0 && (Number(m.issuedPieces) || 0) >= m.requiredPieces;
    }
    return (Number(m.required) || 0) > 0 && (Number(m.remaining) || 0) <= 0.0001;
}

// ---- Rows ----
//
// The store person is picking things off a shelf. He does not need cut sizes,
// piece counts or how the requirement was worked out — every row is one thing to
// hand over and the quantity to hand over. Everything else was noise on a screen
// used standing at a counter.


// ---- Exception dialog shell ----
//
// Shared with the summary's combined-request dialog, which is now the only
// place an exception is raised from. Reporting was removed from the material
// rows: a row cannot see total demand across supervisors, so a shortage raised
// from one carried a quantity that was wrong by construction.

function exceptionModalEl() {
    var el = document.getElementById('exc-modal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'exc-modal';
        el.className = 'exc-modal hidden';
        document.body.appendChild(el);
    }
    return el;
}

function closeExceptionDialog() {
    exceptionModalEl().classList.add('hidden');
}


// ---- Raising the combined request from the summary ----

function summaryEntry(kind, idx) {
    var s = window.__summary || { toWash: [], toBuy: [] };
    return (kind === 'wash' ? s.toWash : s.toBuy)[idx];
}

function openSummaryException(kind, idx) {
    var entry = summaryEntry(kind, idx);
    if (!entry) return;
    var e = entry.e;
    var el = exceptionModalEl();

    var isWash = kind === 'wash';
    var title = isWash ? 'Send for washing' : 'Request a purchase';
    var actionLabel = isWash ? 'To wash' : 'Short by';

    // One row per contributing order, so the ticket shows where the demand came
    // from. No shortfall column — which order goes short is decided later, by
    // priority rules that do not exist yet.
    // WHO wants it, not which order. The store person hands cloth to a person;
    // the sales order is the office's business and means nothing at the counter.
    //
    // It is only hidden, never dropped — the payload still carries salesOrder
    // and raiseMaterialException still writes it onto the ticket line, because
    // procurement genuinely does need to know which orders are held up.
    //
    // The ITEM stays, because one supervisor legitimately produces two rows
    // here: a line per requirement, and a QC remake repeats its original's
    // material AND its supervisor. Without the item and the remake tag they
    // arrive as two identical rows and nobody can tell which is which.
    //
    // A settled line — everything issued, nothing outstanding — is dimmed
    // rather than filtered out. It is what says "he has already had 28.35",
    // which is the context that makes the outstanding figure mean something.
    var lineRows = (e.lines || []).map(function (l) {
        var req = Number(l.required) || 0;
        var iss = Number(l.issued) || 0;
        var out = Math.max(0, round2(req - iss));
        return '<tr' + (out === 0 ? ' class="is-settled"' : '') + '>' +
            '<td>' +
                '<div class="exc-who">' + escapeHtml(l.supervisor || '—') +
                    (l.isRemake
                        ? ' <span class="exc-remake">QC remake</span>'
                        : '') +
                '</div>' +
                (l.item ? '<div class="exc-item">' + escapeHtml(l.item) + '</div>' : '') +
            '</td>' +
            '<td class="col-num">' + fmt(req) + '</td>' +
            '<td class="col-num">' + fmt(iss) + '</td>' +
            '<td class="col-num col-strong">' + fmt(out) + '</td>' +
        '</tr>';
    }).join('');

    el.classList.remove('hidden');
    el.innerHTML =
        '<div class="exc-panel exc-panel-wide">' +
            '<h3>' + title + '</h3>' +
            '<p class="exc-sub">' + escapeHtml(e.material) + ' &middot; ' + escapeHtml(e.sku) + '</p>' +
            '<div class="exc-facts">' +
                // "Still needed", not "Needed in total". This figure is what is
                // OUTSTANDING across every line; the Required column below is
                // the gross requirement. Both were called some form of "needed",
                // so a row reading 28.35 under a header reading 5.4 looked like
                // one of the two was wrong.
                '<span>Still needed <b>' + fmt(e.needed) + ' ' + escapeHtml(e.unit) + '</b></span>' +
                '<span>In stock <b>' + fmt(e.stock) + ' ' + escapeHtml(e.unit) + '</b></span>' +
                (isWash
                    ? '<span class="exc-unwashed">Unwashed <b>' + fmt(e.unwashed) + ' ' + escapeHtml(e.unit) + '</b></span>'
                    : '') +
                '<span class="exc-strong">' + actionLabel + ' <b>' + fmt(entry.qty) + ' ' + escapeHtml(e.unit) + '</b></span>' +
            '</div>' +
            '<label class="exc-label">Who is waiting on it</label>' +
            '<div class="table-wrapper exc-lines">' +
                '<table><thead><tr>' +
                    '<th>Supervisor</th>' +
                    '<th class="col-num">Required</th>' +
                    '<th class="col-num">Issued</th>' +
                    '<th class="col-num">Outstanding</th>' +
                '</tr></thead><tbody>' + lineRows + '</tbody></table>' +
            '</div>' +
            '<label class="exc-label">Note</label>' +
            '<textarea id="exc-note" rows="2" placeholder="Anything the next person needs to know"></textarea>' +
            '<div class="exc-foot">' +
                '<button type="button" class="ghost-btn" onclick="closeExceptionDialog()">Cancel</button>' +
                '<button type="button" class="primary-btn" id="exc-send" ' +
                    'onclick="submitSummaryException(\'' + kind + '\',' + idx + ')">Raise it</button>' +
            '</div>' +
        '</div>';
}

function submitSummaryException(kind, idx) {
    var entry = summaryEntry(kind, idx);
    if (!entry) return;
    var e = entry.e;
    var btn = document.getElementById('exc-send');

    btn.disabled = true;
    btn.textContent = 'Raising…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'raiseMaterialException',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                materialId: e.materialId,
                type: kind === 'wash' ? 'Wash_Needed' : 'Shortage',
                // The total, not one supervisor's slice — this is the whole
                // point of raising it from here.
                required: e.needed,
                available: e.stock,
                unwashed: e.unwashed,
                shortfall: entry.qty,
                unit: e.unit,
                note: document.getElementById('exc-note').value,
                lines: e.lines || []
            })
        }
    }).then(function (response) {
        console.log('exception response:', response);
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (err) {
            parsed = null;
        }
        if (parsed && parsed.success) {
            closeExceptionDialog();

            // Record what the ticket now covers, not just that one exists — the
            // plan list is what decides whether tomorrow's order re-arms this.
            var exType = exTypeFor(kind);
            var coveredNow = (e.lines || []).map(function (l) { return String(l.planId); });
            var existing = openRequestFor(e, exType);
            if (existing) {
                existing.planIds = coveredNow;
            } else {
                e.openExceptions = (e.openExceptions || []).concat([
                    { type: exType, planIds: coveredNow }
                ]);
            }

            var rowBtn = document.getElementById(summaryBtnId(kind, idx));
            if (rowBtn) {
                rowBtn.disabled = true;
                rowBtn.classList.remove('is-stale');
                rowBtn.textContent = 'Requested';
            }

            alert(parsed.appended
                ? 'Updated the open request already raised for this material.'
                : 'Request raised.');
        } else {
            alert('Could not raise it: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
            btn.textContent = 'Raise it';
        }
    }).catch(function (err) {
        console.error('raiseMaterialException error:', err);
        alert('Failed to reach the server. Check the console.');
        btn.disabled = false;
        btn.textContent = 'Raise it';
    });
}

// Contention only matters when the stock cannot cover everyone. Two supervisors
// wanting the same cone out of 300 in the rack is not a problem, and warning
// about it on every such row teaches people to ignore the warning for the rows
// where it IS a problem.
//
// The test is total demand against what is actually on the shelf. For fabric
// that means WASHED stock, matching the shortfall summary: if the gap is only
// coverable by washing, the row is genuinely contested until the wash lands.
function isContested(m) {
    if (!m.contestedBy || m.contestedBy.length === 0) return false;
    var totalWanted = (Number(m.remaining) || 0) + (Number(m.heldByOthers) || 0);
    return totalWanted > (Number(m.availableStock) || 0) + 0.0001;
}

function shortPill(m) {
    var s = stockStatus(m);
    return s.cls === 'status-sufficient'
        ? ''
        : '<span class="status-pill ' + s.cls + '">' + s.label + '</span>';
}

// One waste piece size to fetch off the rack.
// Length to cut off the roll. Used for fabric and for every other material —
// they are the same job: hand over this much of this thing.
// The lot strip under a fabric row: one line per lot with washed stock.
//
// THE SCREEN THINKS, IT DOES NOT DECIDE. Nothing is pre-filled — pre-filling
// would be choosing the tone for him. What it does do is mark the lots that
// could cover the whole ask on their own, call out a lot this order already has
// cloth from, and warn (never block) when he splits where one lot would have
// done. He can override all of it; he just cannot do it by accident.
function lotStripHtml(m, supIdx, matIdx) {
    var lots = lotsFor(m);
    var cols = m.isFabric ? 5 : 4;

    if (lots.length === 0) {
        return '<tr class="lot-row"><td colspan="' + cols + '">' +
            '<div class="lot-none">No lot has washed cloth &mdash; book it in on ' +
            '<b>Stock in</b>, or send a lot for washing. Fabric cannot be issued ' +
            'without saying which lot it came from.</div></td></tr>';
    }

    var need = suggestedIssue(m);

    var rows = lots.map(function (l, lotIdx) {
        var wash = Number(l.wash) || 0;
        var covers = need > 0 && wash + 0.0001 >= need;

        return '' +
            '<div class="lot-line">' +
                '<span class="lot-id">' + escapeHtml(l.lotNumber || '—') +
                    (l.label ? ' <span class="lot-label">' + escapeHtml(l.label) + '</span>' : '') +
                '</span>' +
                '<span class="lot-avail">' + fmt(wash) + '<span class="unit">' +
                    escapeHtml(m.unit) + ' washed</span></span>' +
                (covers ? '<span class="status-pill status-sufficient">covers it all</span>' : '') +
                ((Number(l.unwash) || 0) > 0
                    ? '<span class="lot-unwash">' + fmt(l.unwash) + ' unwashed</span>' : '') +
                '<span class="issue-input-group">' +
                    '<input type="number" step="0.01" min="0" max="' + wash + '" ' +
                        'class="issue-input lot-input" id="' + lotInputId(supIdx, matIdx, lotIdx) + '" ' +
                        'placeholder="0" ' +
                        'oninput="onLotInput(' + supIdx + ',' + matIdx + ')" />' +
                '</span>' +
                '<button type="button" class="ghost-btn lot-fill" ' +
                    'onclick="fillLot(' + supIdx + ',' + matIdx + ',' + lotIdx + ')">Fill</button>' +
            '</div>';
    }).join('');

    return '<tr class="lot-row"><td colspan="' + cols + '">' +
        '<div class="lot-strip-head">Take from which lot?</div>' +
        rows +
        '<div class="lot-warn" id="lot-warn-' + supIdx + '-' + matIdx + '"></div>' +
        '</td></tr>';
}

// Sets one lot to whatever is still needed, capped at what that lot holds.
// A convenience, not a decision — he still chose the lot.
function fillLot(supIdx, matIdx, lotIdx) {
    var m = window.__reqData[supIdx].materials[matIdx];
    var lots = lotsFor(m);
    var el = document.getElementById(lotInputId(supIdx, matIdx, lotIdx));
    if (!el || !lots[lotIdx]) return;

    var others = 0;
    lots.forEach(function (l, i) {
        if (i === lotIdx) return;
        var o = document.getElementById(lotInputId(supIdx, matIdx, i));
        if (o) others += parseFloat(o.value) || 0;
    });

    var stillNeeded = round2(Math.max(0, suggestedIssue(m) - others));
    var canGive = Number(lots[lotIdx].wash) || 0;
    el.value = round2(Math.min(stillNeeded, canGive));
    onLotInput(supIdx, matIdx);
}

// The lot inputs are what he types; the row's metres box is their sum and is
// read-only. Feeding the existing handler keeps checkbox state, validation and
// the card footer working exactly as they did before lots existed.
function onLotInput(supIdx, matIdx) {
    var m = window.__reqData[supIdx].materials[matIdx];
    var input = document.getElementById(rowInputId(supIdx, matIdx));
    var total = lotSum(supIdx, matIdx, m);
    if (input) input.value = total;

    var warnBox = document.getElementById('lot-warn-' + supIdx + '-' + matIdx);
    if (warnBox) {
        var used = 0;
        lotsFor(m).forEach(function (l, i) {
            var el = document.getElementById(lotInputId(supIdx, matIdx, i));
            if (el && (parseFloat(el.value) || 0) > 0) used++;
        });

        // Warned, never blocked. Mixing tones inside one order is the mistake
        // lots exist to prevent, but he may have a reason we cannot see.
        var avoidable = used > 1 && lotsFor(m).some(function (l) {
            return (Number(l.wash) || 0) + 0.0001 >= total;
        });
        warnBox.innerHTML = avoidable
            ? '&#9888; Two lots for one order means two tones. One lot on its own could cover this.'
            : '';
    }

    onIssueInputChange(supIdx, matIdx);
}

function renderQtyIssueRow(m, supIdx, matIdx, labelBadge) {
    var done = isFullyIssued(m);
    var lots = lotsFor(m);
    // Fabric is typed into its lots, so the row's own box is a running total.
    var byLot = m.isFabric && !done;
    var defaultIssue = byLot ? 0 : suggestedIssue(m);
    var disabled = maxIssuable(m) > 0 ? '' : 'disabled';
    if (byLot && lots.length === 0) disabled = 'disabled';

    var issueCell;
    if (done) {
        issueCell = '<span class="issued-tag">&#10003; ' + fmt(m.issued) +
            '<span class="unit">' + escapeHtml(m.unit) + '</span></span>';
        if (m.wasteIssuedPieces > 0) {
            issueCell += ' <span class="issued-tag">&#10003; ' + fmt(m.wasteIssuedPieces) +
                '<span class="unit">pcs from waste</span></span>';
        }
    } else {
        issueCell =
            '<div class="issue-cell">' +
                '<input type="checkbox" class="issue-checkbox" id="' + rowCheckboxId(supIdx, matIdx) + '" ' +
                    (rowIssuable(m) && !byLot ? 'checked' : '') + ' ' + disabled + ' ' +
                    'aria-label="Issue ' + escapeHtml(m.material) + '" ' +
                    'onchange="onIssueCheckboxChange(' + supIdx + ',' + matIdx + ')" />' +
                '<span class="issue-input-group">' +
                    '<input type="number" step="0.01" min="0" max="' + issueCeiling(m) + '" ' +
                        'class="issue-input" id="' + rowInputId(supIdx, matIdx) + '" ' + disabled + ' ' +
                        (byLot ? 'readonly ' : '') +
                        'value="' + defaultIssue + '" oninput="onIssueInputChange(' + supIdx + ',' + matIdx + ')" />' +
                    '<span class="issue-unit">' + escapeHtml(m.unit) + '</span>' +
                '</span>' +
            '</div>';
    }

    var stockCells;
    if (m.isFabric) {
        stockCells =
            '<td class="col-num">' + qty(m.availableStock, m.unit) + '</td>' +
            '<td class="col-num">' + qty(Number(m.unwashedStock) || 0, m.unit) + '</td>';
    } else {
        stockCells = '<td class="col-num">' + qty(m.availableStock, m.unit) + '</td>';
    }

    var warning = '';
    if (!done && isContested(m)) {
        var names = m.contestedBy.map(function(c) { return escapeHtml(c.name); }).join(', ');
        warning = '<div class="contested-warn">&#9888; Also needed by ' + names + '</div>';
    }

    return '' +
        '<tr id="' + rowId(supIdx, matIdx) + '" class="' + (done ? 'row-issued' : 'row-selected') + '">' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(m.material) + (labelBadge || '') + '</div>' +
                '<div class="mat-sku">' + escapeHtml(m.sku) + '</div>' +
                reissueWhy(m) +
                warning +
            '</td>' +
            '<td class="col-num col-strong">' +
                '<span class="qty-big">' + fmt(m.remaining) +
                    '<span class="unit">' + escapeHtml(m.unit) + '</span></span>' +
                (done ? '' : shortPill(m)) +
            '</td>' +
            stockCells +
            '<td class="col-issue">' + issueCell + '</td>' +
        '</tr>' +
        // Fabric only, and only while there is still something to issue. A
        // fully-issued row is a receipt and has no lot to choose.
        (byLot ? lotStripHtml(m, supIdx, matIdx) : '');
}

// A fabric material becomes one row per waste size plus, unless waste covers it
// entirely, one row for the fresh length.
// One row per fabric, not one per supply line.
//
// Fresh metres and waste pieces were separate rows, so the same material
// appeared two or three times with the same name and SKU, and the stock columns
// were struck through on all but one of them. They are not separate materials —
// they are two sources for one requirement, and the store person is filling one
// order line either way. Combining them makes the row read as the job it is:
// "cut 2.1m off the roll AND take that one offcut".
//
// Every input keeps the id it had, so all the checkbox, validation and payload
// logic works untouched — only the markup around them moved.
function renderFabricRows(m, supIdx, matIdx) {
    var done = isFullyIssued(m);
    var picks = wastePicks(m);
    var wantsFresh = done || needsFreshFabric(m);

    // ---- "To be issued": fresh metres as the headline, waste beneath it ----
    var toIssue = '';
    if (wantsFresh) {
        toIssue =
            '<span class="qty-big">' + fmt(m.remaining) +
                '<span class="unit">' + escapeHtml(m.unit) + '</span></span>' +
            (done ? '' : shortPill(m));
    }
    picks.forEach(function (p) {
        toIssue +=
            '<div class="qty-sub qty-sub-waste">&#9851; ' + p.pieces + ' pc' + (p.pieces === 1 ? '' : 's') +
                ' waste &middot; ' + fmt(p.length) + ' &times; ' + fmt(p.width) + ' cm</div>';
    });
    if (!toIssue) {
        toIssue = '<span class="is-zero">&mdash;</span>';
    }

    // ---- "Issue now": one control per source, stacked ----
    var issueCell;
    if (done) {
        issueCell = '<span class="issued-tag">&#10003; ' + fmt(m.issued) +
            '<span class="unit">' + escapeHtml(m.unit) + '</span></span>';
        if (m.wasteIssuedPieces > 0) {
            issueCell += ' <span class="issued-tag">&#10003; ' + fmt(m.wasteIssuedPieces) +
                '<span class="unit">pcs from waste</span></span>';
        }
    } else {
        var disabled = maxIssuable(m) > 0 ? '' : 'disabled';
        issueCell = '<div class="issue-stack">';

        if (wantsFresh) {
            issueCell +=
                '<div class="issue-cell">' +
                    '<input type="checkbox" class="issue-checkbox" id="' + rowCheckboxId(supIdx, matIdx) + '" ' +
                        (rowIssuable(m) ? 'checked' : '') + ' ' + disabled + ' ' +
                        'aria-label="Issue ' + escapeHtml(m.material) + '" ' +
                        'onchange="onIssueCheckboxChange(' + supIdx + ',' + matIdx + ')" />' +
                    '<span class="issue-input-group">' +
                        '<input type="number" step="0.01" min="0" max="' + maxIssuable(m) + '" ' +
                            'class="issue-input" id="' + rowInputId(supIdx, matIdx) + '" ' + disabled + ' ' +
                            'value="' + suggestedIssue(m) + '" oninput="onIssueInputChange(' + supIdx + ',' + matIdx + ')" />' +
                        '<span class="issue-unit">' + escapeHtml(m.unit) + '</span>' +
                    '</span>' +
                '</div>';
        }

        // Each piece size keeps its own checkbox — a remnant can be declined
        // without giving up the fresh length that goes with it.
        picks.forEach(function (p, pickIdx) {
            issueCell +=
                '<div class="issue-cell issue-cell-waste" id="' + wasteRowId(supIdx, matIdx, pickIdx) + '">' +
                    '<input type="checkbox" class="issue-checkbox" id="' + wasteCheckboxId(supIdx, matIdx, pickIdx) + '" checked ' +
                        'aria-label="Issue waste pieces of ' + escapeHtml(m.material) + '" ' +
                        'onchange="onWasteCheckboxChange(' + supIdx + ',' + matIdx + ',' + pickIdx + ')" />' +
                    '<span class="issue-input-group">' +
                        '<input type="number" step="1" min="0" max="' + p.pieces + '" ' +
                            'class="issue-input" id="' + wasteInputId(supIdx, matIdx, pickIdx) + '" value="' + p.pieces + '" ' +
                            'oninput="onWasteInputChange(' + supIdx + ',' + matIdx + ',' + pickIdx + ')" />' +
                        '<span class="issue-unit">pcs</span>' +
                    '</span>' +
                '</div>';
        });

        issueCell += '</div>';
    }

    var warning = '';
    if (!done && isContested(m)) {
        var names = m.contestedBy.map(function (c) { return escapeHtml(c.name); }).join(', ');
        warning = '<div class="contested-warn">&#9888; Also needed by ' + names + '</div>';
    }

    return '' +
        '<tr id="' + rowId(supIdx, matIdx) + '" class="' + (done ? 'row-issued' : 'row-selected') + '">' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(m.material) +
                    (picks.length > 0 ? '<span class="waste-badge">&#9851; incl. waste</span>' : '') +
                '</div>' +
                '<div class="mat-sku">' + escapeHtml(m.sku) + '</div>' +
                reissueWhy(m) +
                warning +
            '</td>' +
            '<td class="col-num col-strong">' + toIssue + '</td>' +
            '<td class="col-num">' + qty(m.availableStock, m.unit) + '</td>' +
            '<td class="col-num">' + qty(Number(m.unwashedStock) || 0, m.unit) + '</td>' +
            '<td class="col-issue">' + issueCell + '</td>' +
        '</tr>';
}

function selectAllHeader(supIdx, section, label) {
    return '' +
        '<th class="col-issue">' +
            '<label class="select-all-label" title="Select every issuable row in this section">' +
                '<input type="checkbox" class="issue-checkbox" id="' + selectAllId(supIdx, section) + '" ' +
                    'onchange="onSelectAllChange(' + supIdx + ',\'' + section + '\')" ' +
                    'aria-label="Select all ' + label + '" />' +
                '<span>Issue now</span>' +
            '</label>' +
        '</th>';
}

// Why the store is being asked for a material a second time.
//
// Shown ON THE ROW rather than only in the section heading, because one reissue
// section can hold several unrelated incidents — 3 panels cut through on Monday
// and a smudged label run on Wednesday. A heading can only say "these are
// reissues"; the row has to say which one this is.
//
// The reason is one line per damage report, never merged, so it always describes
// exactly one thing that happened.
function reissueWhy(m) {
    if (!m || !m.isReissue) return '';
    var lines = (m.lines || [])
        .map(function (l) { return (l.reason || '').trim(); })
        .filter(function (r) { return r !== ''; });
    if (lines.length === 0) return '';
    return '<div class="reissue-why">' +
        lines.map(function (r) { return escapeHtml(r); }).join('<br>') +
        '</div>';
}

function renderSection(title, note, headCells, rowsHtml) {
    if (!rowsHtml) return '';
    return '' +
        '<div class="mat-section">' +
            '<div class="section-title">' + escapeHtml(title) +
                (note ? '<span class="section-note">' + escapeHtml(note) + '</span>' : '') +
            '</div>' +
            '<div class="table-wrapper">' +
                '<table>' +
                    '<thead><tr>' + headCells + '</tr></thead>' +
                    '<tbody>' + rowsHtml + '</tbody>' +
                '</table>' +
            '</div>' +
        '</div>';
}

// ---- End-of-page shortfall summary ----
//
// The per-supervisor cards deliberately show every supervisor the TRUE stock
// figure rather than a share of it, so two supervisors each needing 60 of a
// material with 100 on the shelf both read "100 in stock" and neither card is
// wrong on its own. The shortfall only exists in the total, which is why it has
// to be worked out here and nowhere else.
//
// Split into two lists because they go to two different people: washed fabric
// short while unwashed sits on the rack is a job for the wash team, not a
// purchase order.
function buildShortfallSummary(data) {
    var byMat = {};

    data.forEach(function (sup) {
        sup.materials.forEach(function (m) {
            if (isFullyIssued(m)) return;
            var need = Number(m.remaining) || 0;
            if (need <= 0) return;

            var key = String(m.materialId);
            if (!byMat[key]) {
                byMat[key] = {
                    // Carried explicitly — the key is a string map index, and the
                    // raise payload needs the id itself.
                    materialId: m.materialId,
                    material: m.material,
                    sku: m.sku,
                    unit: m.unit,
                    isFabric: !!m.isFabric,
                    // Stock is one live figure, not one per supervisor. Taking it
                    // from the first row that mentions the material is right;
                    // summing it would invent stock that does not exist.
                    stock: Number(m.availableStock) || 0,
                    unwashed: Number(m.unwashedStock) || 0,
                    needed: 0,
                    supervisors: [],
                    // One entry per Material_Requirement row, straight from the
                    // server. No overlap across supervisors — a requirement
                    // belongs to exactly one — so concatenating is safe.
                    lines: [],
                    openExceptions: (m.openExceptions || []).slice()
                };
            }
            byMat[key].needed = round2(byMat[key].needed + need);

            // The supervisor's NAME stamped onto each line, here, because this
            // is the only place it is known — the server sends lines nested
            // under the supervisor they belong to, and the moment they are
            // concatenated across supervisors that context is gone.
            //
            // Copied rather than mutated: the same line objects are still held
            // by the per-supervisor cards, and adding a field to them there
            // would be a side effect nothing else expects.
            (m.lines || []).forEach(function (l) {
                var copy = {};
                for (var k in l) {
                    if (Object.prototype.hasOwnProperty.call(l, k)) copy[k] = l[k];
                }
                copy.supervisor = sup.supervisorName;
                byMat[key].lines.push(copy);
            });

            if (byMat[key].supervisors.indexOf(sup.supervisorName) === -1) {
                byMat[key].supervisors.push(sup.supervisorName);
            }
        });
    });

    var toWash = [];
    var toBuy = [];

    Object.keys(byMat).forEach(function (k) {
        var e = byMat[k];
        var gap = round2(e.needed - e.stock);
        if (gap <= 0) return;

        // Only fabric has an unwashed pile to draw on, and only the part washing
        // cannot cover is a genuine shortage. A material can land in both lists.
        var washQty = e.isFabric ? round2(Math.min(gap, e.unwashed)) : 0;
        if (washQty > 0) {
            toWash.push({ e: e, qty: washQty, kind: 'wash' });
        }

        var buyQty = round2(gap - washQty);
        if (buyQty > 0) {
            toBuy.push({ e: e, qty: buyQty, kind: 'buy' });
        }
    });

    // Biggest gap first — that is the one that holds up the most orders.
    var bySize = function (a, b) { return b.qty - a.qty; };
    toWash.sort(bySize);
    toBuy.sort(bySize);

    return { toWash: toWash, toBuy: toBuy };
}

function summaryBtnId(kind, idx) {
    return 'sum-raise-' + kind + '-' + idx;
}

function exTypeFor(kind) {
    return kind === 'wash' ? 'Wash_Needed' : 'Shortage';
}

function openRequestFor(e, exType) {
    var found = (e.openExceptions || []).filter(function (x) {
        return x && x.type === exType;
    });
    return found.length > 0 ? found[0] : null;
}

// An open ticket only speaks for the orders that were on it when it was raised.
// A plan that has appeared since is demand nobody has been told about, so the
// button has to come back to life — otherwise today's order silently inherits
// yesterday's request and nobody orders enough.
function requestState(e, kind) {
    var open = openRequestFor(e, exTypeFor(kind));
    if (!open) return 'none';

    var covered = (open.planIds || []).map(String);
    var hasNewPlan = (e.lines || []).some(function (l) {
        return covered.indexOf(String(l.planId)) === -1;
    });
    return hasNewPlan ? 'stale' : 'open';
}

function summaryRow(entry, idx) {
    var e = entry.e;
    var kind = entry.kind;
    var state = requestState(e, kind);

    var btnLabel = kind === 'wash' ? 'Send to wash' : 'Raise request';
    if (state === 'open') {
        btnLabel = 'Requested';
    } else if (state === 'stale') {
        // A ticket exists but does not cover every order now waiting.
        btnLabel = 'Update request';
    }

    return '' +
        '<tr>' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(e.material) + '</div>' +
                '<div class="mat-sku">' + escapeHtml(e.sku) + '</div>' +
            '</td>' +
            '<td class="col-num">' + qty(e.needed, e.unit, { keepZero: true }) + '</td>' +
            '<td class="col-num">' + qty(e.stock, e.unit) + '</td>' +
            '<td class="col-num col-strong">' +
                '<span class="qty-big">' + fmt(entry.qty) +
                    '<span class="unit">' + escapeHtml(e.unit) + '</span></span>' +
            '</td>' +
            '<td class="col-action">' +
                '<button type="button" class="raise-btn' + (state === 'stale' ? ' is-stale' : '') + '" ' +
                    'id="' + summaryBtnId(kind, idx) + '" ' +
                    (state === 'open' ? 'disabled' : '') + ' ' +
                    'onclick="openSummaryException(\'' + kind + '\',' + idx + ')">' +
                    btnLabel +
                '</button>' +
            '</td>' +
        '</tr>';
}

function renderShortfallSummary(data) {
    var s = buildShortfallSummary(data);
    // Held for the raise dialog, which needs the totals and the lines behind
    // them — neither of which any single supervisor row can supply.
    window.__summary = s;
    if (s.toWash.length === 0 && s.toBuy.length === 0) return '';

    var washHead =
        '<th>Material</th>' +
        '<th class="col-num">Needed</th>' +
        '<th class="col-num">Washed stock</th>' +
        '<th class="col-num">To wash</th>' +
        '<th class="col-action"></th>';

    var buyHead =
        '<th>Material</th>' +
        '<th class="col-num">Needed</th>' +
        '<th class="col-num">In stock</th>' +
        '<th class="col-num">Short by</th>' +
        '<th class="col-action"></th>';

    var sections =
        renderSection(
            'Needs washing',
            '',
            washHead,
            s.toWash.map(summaryRow).join('')
        ) +
        renderSection(
            'Short — needs purchase',
            '',
            buyHead,
            s.toBuy.map(summaryRow).join('')
        );

    var counts = [];
    if (s.toWash.length > 0) counts.push(s.toWash.length + ' to wash');
    if (s.toBuy.length > 0) counts.push(s.toBuy.length + ' short');

    return '' +
        '<div class="item-card summary-card open">' +
            '<div class="item-header">' +
                '<div class="item-title-row">' +
                    '<div class="item-header-info">' +
                        '<h2>What is missing</h2>' +
                        '<div class="item-meta-line">' +
                            '<span>Totalled across every supervisor, so contested stock counts once</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="item-header-right">' +
                    '<span class="item-qty item-qty-danger">' + counts.join(' &middot; ') + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="item-body">' +
                '<div class="tables-container">' + sections + '</div>' +
            '</div>' +
        '</div>';
}

function renderSupervisorCard(sup, idx, arr) {
    // REISSUES ARE NEVER MIXED INTO THE PLAN'S OWN DEMAND. The server already
    // keeps them apart — Source is part of its aggregation key, so a reissue can
    // never be added into the plan row for the same material — and this is the
    // other half of that: they get their own sections rather than sitting
    // between rows the store has been expecting since the order was planned.
    //
    // Added together they would read as one requirement that was always
    // expected, which hides the damage completely and leaves the store unable to
    // explain why the figure moved.
    var isRe = function (m) { return m && m.isReissue === true; };

    var fabricHtml = sup.materials.map(function (m, matIdx) {
        return (m.isFabric && !isRe(m)) ? renderFabricRows(m, idx, matIdx) : '';
    }).join('');

    var otherHtml = sup.materials.map(function (m, matIdx) {
        return (!m.isFabric && !isRe(m)) ? renderQtyIssueRow(m, idx, matIdx, '') : '';
    }).join('');

    var reFabricHtml = sup.materials.map(function (m, matIdx) {
        return (m.isFabric && isRe(m)) ? renderFabricRows(m, idx, matIdx) : '';
    }).join('');

    var reOtherHtml = sup.materials.map(function (m, matIdx) {
        return (!m.isFabric && isRe(m)) ? renderQtyIssueRow(m, idx, matIdx, '') : '';
    }).join('');

    var fabricHead =
        '<th>Material</th>' +
        '<th class="col-num">To be issued</th>' +
        '<th class="col-num">Wash stock</th>' +
        '<th class="col-num">Unwash stock</th>';

    var otherHead =
        '<th>Material</th>' +
        '<th class="col-num">To be issued</th>' +
        '<th class="col-num">In stock</th>';

    // renderSection returns '' for empty rows, so a supervisor with no damage
    // reported sees exactly the two sections he sees today — the reissue
    // headings appear only when there is something under them.
    var rows =
        renderSection('Fabric', '', fabricHead + selectAllHeader(idx, 'fabric', 'fabric'), fabricHtml) +
        renderSection('Other materials', '', otherHead + selectAllHeader(idx, 'other', 'other materials'), otherHtml) +
        renderSection('Reissue — fabric', 'replacing material damaged in production',
            fabricHead + selectAllHeader(idx, 'refabric', 'reissue fabric'), reFabricHtml) +
        renderSection('Reissue — other materials', 'replacing material damaged in production',
            otherHead + selectAllHeader(idx, 'reother', 'reissue materials'), reOtherHtml);

    var pending = sup.materials.filter(function (m) { return !isFullyIssued(m); });
    var doneCount = sup.materials.length - pending.length;

    // Only pending rows can be "short" - an issued row's stock level is history.
    var shortCount = pending.filter(function (m) {
        return stockStatus(m).cls !== 'status-sufficient';
    }).length;

    var metaText = pending.length + ' pending';
    if (doneCount > 0) {
        metaText += ' &middot; ' + doneCount + ' issued';
    }

    // PRIORITY POSITION.
    //
    // Nothing extra is sent for this. The server sorts plans by Priority_Key
    // (order source rank, then plan age) and builds the supervisor order as it
    // walks them, so a card's POSITION already is its priority — index is the
    // whole answer, and arr is only needed to know which card is last.
    //
    // Named rather than left implicit, because the list looked exactly like
    // this before priority existed. Without it the store person cannot tell an
    // ordered list from an arbitrary one, and has no reason to work top-down —
    // which is the entire point of the ranking.
    //
    // THE ORDER SOURCE IS DELIBERATELY NOT SHOWN. One supervisor handles one
    // source, so "Shopify" would only repeat what position 1 already says, and
    // it would go stale the day someone handles two.
    //
    // The same words on every card, extra ones only where they add something.
    // "Priority 2" alone is meaningless without knowing how many there are;
    // highest and lowest are the two that anchor it.
    var supTotal = (arr && arr.length) ? arr.length : 1;
    var prioText = 'Priority ' + (idx + 1);
    var prioClass = 'prio-tag';
    if (supTotal > 1) {
        if (idx === 0) {
            prioText += ' &middot; highest';
            prioClass += ' is-top';
        } else if (idx === supTotal - 1) {
            prioText += ' &middot; lowest';
        }
    }

    // No contested count here. The row that is actually contested says so on
    // itself ("Also needed by …"), which is where the store person can act on
    // it; a number in the header only says "something below is a problem".

    var headerPill;
    if (pending.length === 0) {
        headerPill = '<span class="item-qty item-qty-ok">&#10003; All issued</span>';
    } else if (shortCount > 0) {
        headerPill = '<span class="item-qty item-qty-danger">' + shortCount + ' short</span>';
    } else {
        headerPill = '<span class="item-qty item-qty-ok">All in stock</span>';
    }

    return '' +
        '<div class="item-card" id="sup-card-' + idx + '">' +
            '<div class="item-header" onclick="toggleSupervisor(' + idx + ')">' +
                '<div class="item-title-row">' +
                    '<span class="item-serial">' + (idx + 1) + '</span>' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(sup.supervisorName) + '</h2>' +
                        '<div class="item-meta-line">' +
                            '<span class="' + prioClass + '">' + prioText + '</span>' +
                            '<span>' + metaText + '</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="item-header-right">' +
                    headerPill +
                    '<span class="chevron" aria-hidden="true">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
                            'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
                    '</span>' +
                '</div>' +
            '</div>' +
            '<div class="item-body">' +
                '<div class="tables-container">' + rows + '</div>' +
                '<div class="card-footer" id="sup-footer-' + idx + '">' +
                    '<span class="sel-count" id="sel-count-' + idx + '">No materials selected</span>' +
                    '<button type="button" class="primary-btn" id="issue-btn-' + idx + '" ' +
                        'onclick="issueForSupervisor(' + idx + ')">Issue to ' + escapeHtml(sup.supervisorName) + '</button>' +
                '</div>' +
            '</div>' +
        '</div>';
}

// Accordion: one supervisor open at a time.
//
// He serves one person at the counter, and a screen with three expanded cards
// means scrolling past two people's material to reach the one in front of him.
// Closing the others also removes the main way to tick a row on the wrong card.
//
// The summary is excluded — it is not a supervisor, it has nothing to toggle,
// and collapsing it would hide the shortfall list every time a card is opened.
function toggleSupervisor(idx) {
    var card = document.getElementById('sup-card-' + idx);
    if (!card) return;
    var opening = !card.classList.contains('open');

    document.querySelectorAll('.item-card.open:not(.summary-card)').forEach(function (c) {
        c.classList.remove('open');
    });

    // Re-opening the card that was already open is how it gets closed.
    if (opening) {
        card.classList.add('open');

        // Closing the previous card removes height ABOVE this one, so the page
        // slides up under the cursor and lands you somewhere in the middle of
        // the list you just opened. Put its header back at the top.
        //
        // Deferred a frame so the collapse has been laid out first — measuring
        // before that gives the pre-collapse position, which is the bug.
        requestAnimationFrame(function () {
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
}

// A tab count is hidden at zero rather than shown as "0" — a badge should mean
// "there is something here", and a row of zeroes trains people to ignore them.
function setTabCount(id, n) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!n || n <= 0) {
        el.textContent = '';
        el.classList.add('hidden');
    } else {
        el.textContent = n;
        el.classList.remove('hidden');
    }
}

function render(data) {
    var emptyState = document.getElementById('empty-state');
    var content = document.getElementById('dynamic-content');
    var sub = document.getElementById('header-sub');

    if (!data || data.length === 0) {
        window.__reqData = [];
        emptyState.classList.remove('hidden');
        content.innerHTML = '';
        if (sub) sub.textContent = 'Pending production plans, grouped by supervisor';
        return;
    }

    // Allocation runs across EVERY supervisor, including the finished ones,
    // before anything is filtered. Waste pieces and short stock are contested
    // between supervisors, so dropping a card first would re-decide who gets
    // what — the filter below is about what is worth showing, not about what
    // the numbers are.
    applyStockAllocation(data);

    // Only supervisors with something still to issue.
    //
    // getStoreMaterialRequirements returns every requirement of every plan whose
    // Order_Status is Pending, Partially Received or In Progress, and it never
    // drops a fully-issued row. In Progress is in that list on purpose — a plan
    // can be cutting and still owe material, because resolving a dispute
    // re-opens a requirement — but it means a plan whose issuing finished long
    // ago keeps a card on this screen for as long as production runs.
    //
    // A card with nothing left to hand over is a record, not a task. It belongs
    // to History, and leaving it here also made the screen inconsistent: the
    // same finished work disappeared the moment its plan reached Material Ready,
    // so two identical situations looked different for no reason the store
    // person could see.
    var actionable = data.filter(function (s) {
        return s.materials.some(function (m) { return !isFullyIssued(m); });
    });

    // Cached AFTER filtering, and it must stay that way. Every issue handler
    // reads window.__reqData[supIdx] where supIdx is the CARD's position on
    // screen — caching the unfiltered list here would silently point each card's
    // Issue button at a different supervisor's materials.
    window.__reqData = actionable;

    if (actionable.length === 0) {
        emptyState.classList.remove('hidden');
        content.innerHTML = '';
        if (sub) sub.textContent = 'Everything requested has been issued';
        return;
    }

    emptyState.classList.add('hidden');
    // Summary last: it is a to-do list for after the issuing is done, not
    // something to read before starting.
    content.innerHTML = actionable.map(renderSupervisorCard).join('') +
        renderShortfallSummary(actionable);

    // Pending means STILL TO ISSUE. This was counting every line including the
    // ones already handed over, so a card reading "0 pending · 11 issued" was
    // contributing 11 to a total labelled "pending".
    var pendingLines = actionable.reduce(function (acc, s) {
        return acc + s.materials.filter(function (m) { return !isFullyIssued(m); }).length;
    }, 0);

    // Supervisors with something left to do. Same rule the filter above uses,
    // so the count and the list can never disagree.
    var supsPending = actionable.length;

    if (sub) {
        sub.textContent = supsPending + (supsPending === 1 ? ' supervisor' : ' supervisors') +
            ' · ' + pendingLines + (pendingLines === 1 ? ' line' : ' lines') + ' pending';
    }
    setTabCount('count-issue', pendingLines);

    // Over the RENDERED cards, not the input. refreshCardState looks its
    // supervisor up in __reqData by card index, so walking the unfiltered list
    // here runs it for cards that do not exist and reads past the end.
    actionable.forEach(function (_, idx) { refreshCardState(idx); });

    var firstCard = document.getElementById('sup-card-0');
    if (firstCard) firstCard.classList.add('open');
}

// ---- Issue action ----

function issueForSupervisor(supIdx) {
    var sup = window.__reqData[supIdx];
    var issues = [];
    var hasInvalid = false;

    sup.materials.forEach(function (m, matIdx) {
        // No metres input means either a fully-issued row (a receipt) or a
        // fabric line wholly covered by waste. The second still has pieces to
        // hand over, so this must not bail out — it falls through at 0 metres.
        var input = document.getElementById(rowInputId(supIdx, matIdx));
        var val = 0;
        if (input) {
            val = parseFloat(input.value) || 0;
            validateRow(supIdx, matIdx, m);
            if (input.classList.contains('invalid')) {
                hasInvalid = true;
            }
        }
        // Waste pieces live in their own section, so gather whatever was ticked
        // there and fold it back into this material's line — the server takes
        // metres and pieces together as one issue.
        var picks = [];
        wastePicks(m).forEach(function (p, pickIdx) {
            var wCheck = document.getElementById(wasteCheckboxId(supIdx, matIdx, pickIdx));
            var wInput = document.getElementById(wasteInputId(supIdx, matIdx, pickIdx));
            if (!wCheck || !wCheck.checked || !wInput) return;
            var pieces = parseInt(wInput.value, 10) || 0;
            if (pieces > 0) picks.push({ wasteId: p.wasteId, pieces: pieces });
        });

        // Which cloth is coming off which lot. Only lots he actually typed into
        // travel — a zero line is not a choice, and the server treats it as one
        // to be skipped rather than an error.
        var lotLines = [];
        lotsFor(m).forEach(function (l, lotIdx) {
            var el = document.getElementById(lotInputId(supIdx, matIdx, lotIdx));
            if (!el) return;
            var q = parseFloat(el.value) || 0;
            if (q > 0) lotLines.push({ lotId: l.lotId, qty: q });
        });

        // A fabric row can be worth issuing at 0 metres when waste covers it
        // entirely, so the metres value alone cannot decide this.
        if (val > 0 || picks.length > 0) {
            // WHICH BLOCK THIS ROW CAME FROM. The screen shows the plan's own
            // demand and reissues separately, so the server has to credit the
            // one that was actually ticked — matching on material and cut size
            // alone let 24 cones issued against the Reissue block land on a
            // part-issued Plan row, leaving the reissue still reading as owed.
            var line = {
                materialId: m.materialId,
                qty: val,
                source: m.isReissue === true ? 'Reissue' : 'Plan'
            };
            if (m.isFabric) {
                line.cutWidth = m.cutWidth;
                line.cutLength = m.cutLength;
                line.wastePicks = picks;
                line.lots = lotLines;

                // Metres with no lot behind them cannot be issued: the server
                // would have nothing to take the cloth off, and receipt and
                // disputes would have no lot to settle against. Caught here so
                // he is told which row, rather than getting a server error
                // naming a SKU.
                if (val > 0 && lotLines.length === 0) {
                    alert('Choose which lot the ' + m.material + ' comes from.');
                    hasInvalid = true;
                }
            }
            issues.push(line);
        }
    });

    if (hasInvalid) {
        alert('Some issue quantities exceed remaining or available stock. Fix the highlighted rows first.');
        return;
    }
    if (issues.length === 0) {
        alert('Nothing to issue — all quantities are 0.');
        return;
    }

    var footer = document.getElementById('sup-footer-' + supIdx);
    var btn = document.getElementById('issue-btn-' + supIdx);
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = 'Issuing…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'issueMaterials',
        http_method: 'POST',
        payload: {
            supervisorId: sup.supervisorId,
            issuesJson: JSON.stringify(issues)
        }
    }).then(function (response) {
        console.log('issue response:', response);
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            parsed = null;
        }

        if (parsed && parsed.errors && parsed.errors.length > 0) {
            alert('Some materials could not be issued:\n' + parsed.errors.join('\n'));
        }

        // Lock the inputs for this card regardless, then refresh from server
        // so remaining/stock reflect the real post-issue state.
        sup.materials.forEach(function (m, matIdx) {
            var input = document.getElementById(rowInputId(supIdx, matIdx));
            var checkbox = document.getElementById(rowCheckboxId(supIdx, matIdx));
            if (input) input.disabled = true;
            if (checkbox) checkbox.disabled = true;

            wastePicks(m).forEach(function (p, pickIdx) {
                var wInput = document.getElementById(wasteInputId(supIdx, matIdx, pickIdx));
                var wCheck = document.getElementById(wasteCheckboxId(supIdx, matIdx, pickIdx));
                if (wInput) wInput.disabled = true;
                if (wCheck) wCheck.disabled = true;
            });
        });
        ISSUE_SECTIONS.forEach(function (section) {
            var master = document.getElementById(selectAllId(supIdx, section));
            if (master) master.disabled = true;
        });
        footer.innerHTML = '<span class="issued-locked-pill">&#10003; Issued</span>';

        loadRequirements();
    }).catch(function (err) {
        console.error('issueMaterials error:', err);
        alert('Failed to issue materials. Check the console for details.');
        delete btn.dataset.busy;
        btn.disabled = false;
        btn.textContent = 'Issue to ' + sup.supervisorName;
    });
}

// ---- Load ----

function loadRequirements() {
    var content = document.getElementById('dynamic-content');
    var emptyState = document.getElementById('empty-state');
    var refreshBtn = document.getElementById('refresh-btn');
    emptyState.classList.add('hidden');
    refreshBtn.disabled = true;
    content.innerHTML =
        '<div class="skeleton-card"><div class="skeleton-line w-40"></div>' +
        '<div class="skeleton-line"></div><div class="skeleton-line"></div>' +
        '<div class="skeleton-line w-70"></div></div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreMaterialRequirements',
        http_method: 'GET'
    }).then(function (response) {
        console.log('raw response:', response);
        refreshBtn.disabled = false;
        try {
            var parsed = JSON.parse(response.result);
            console.log('parsed:', parsed);
            render(parsed);
        } catch (e) {
            console.error('JSON.parse failed:', e, response.result);
            content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Could not read requirements</h2><p>Check the browser console for details.</p></div>';
        }
    }).catch(function (err) {
        console.error('invokeCustomApi error:', err);
        refreshBtn.disabled = false;
        content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Failed to load requirements</h2><p>Check the browser console for details.</p></div>';
    });
}

// ---- Tabs ----
//
// Client-side switching, not Creator page navigation. Navigating between pages
// tears the widget down and reboots it, losing every open card and refetching
// everything — unusable for something a store person flips between all day.
//
// Tabs load on first open and then stay loaded. He opens this app to issue
// material twenty times a day; fetching dispute history on each of those would
// be paid for every time and read once a week.

// ONE ENTRY PER TAB THAT FETCHES. This is the whole registry: showTab reads it
// to load a tab the first time it is opened, and Refresh reads it to re-fetch
// the ones already open. An empty entry here is a permanently blank tab — which
// is exactly what happened when this map was introduced without being filled
// in, and the badge counts kept working (they are their own call) so all four
// tabs looked like they were loading and finding nothing.
//
// Safe above the function bodies: these are function DECLARATIONS, which hoist.
//
// "issue" is deliberately absent. It is the home tab, loaded by
// loadRequirements() on boot, and Refresh names it directly.
var TAB_LOADERS = {
    stockin: loadStockIn,
    history: loadHistory,
    waste: loadWasteReceipt,
    disputes: loadDisputes,
    requests: loadRequests
};

var tabsLoaded = {};

function showTab(name) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.toggle('is-active', p.id === 'panel-' + name);
    });

    if (!tabsLoaded[name] && TAB_LOADERS[name]) {
        tabsLoaded[name] = true;
        TAB_LOADERS[name]();
    }
}

// ---- Waste receipt tab ----
//
// Pieces the supervisor declared after cutting that nobody has checked onto the
// rack. Until that happens they sit at Pending_Receipt and the allocator cannot
// see them, so a remnant left here is a remnant that will never be reused.
//
// The declared count is a claim, not a fact — this is where it gets checked. The
// number typed in Received is what goes on the rack; anything missing raises an
// inbound dispute against the supervisor, the mirror of the one he raises when
// the store issues him short.

var wastePending = [];

function loadWasteReceipt() {
    var panel = document.getElementById('panel-waste');
    panel.innerHTML = '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getWastePendingReceipt',
        http_method: 'GET'
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getWastePendingReceipt parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the list</h2><p>Check the browser console.</p></div>';
            return;
        }
        wastePending = parsed.pieces || [];
        renderWasteReceipt();
        // AFTER the first render, never before — loadWasteHistory draws into
        // #waste-hist-block, which does not exist until the panel has been built
        // once. Back to page one, because a refresh is "show me where things
        // stand", and page 7 of a list that has just changed is nobody's answer.
        loadWasteHistory(0);
    }).catch(function (err) {
        console.error('getWastePendingReceipt error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

// Two modes, exactly like the supervisor's receive screen. Agreeing is one
// button; disagreeing takes a second one. The checkbox-per-row version this
// replaces asked the store person to tick eight boxes to say the ordinary
// thing, and never showed that the count was editable at all.
var wasteRecvEdit = false;

function wasteRecvGotId(i) {
    return 'wr-got-' + i;
}

function wasteRecvShortId(i) {
    return 'wr-short-' + i;
}

function wasteRecvNoteId(i) {
    return 'wr-note-' + i;
}

// How many pieces the store says are actually on the rack. Outside edit mode
// that is always the whole row, which is what the plain confirm button means.
function wasteRecvGot(p, i) {
    if (!wasteRecvEdit) return p.count;
    var box = document.getElementById(wasteRecvGotId(i));
    if (!box || String(box.value).trim() === '') return 0;
    var n = parseInt(box.value, 10);
    if (isNaN(n) || n < 0) return 0;
    if (n > p.count) return p.count;
    return n;
}

function setWasteRecvEdit(on) {
    wasteRecvEdit = on;
    renderWasteReceipt();
}

// TWO BLOCKS, rendered from separate state and redrawn separately.
//
// Paging the history must not redraw the pending card. In edit mode that card
// holds counts the store person has typed but not yet submitted, and rebuilding
// its inputs resets every one of them to the declared figure — silently, and at
// the exact moment he is disagreeing with it.
function renderWasteReceipt() {
    var panel = document.getElementById('panel-waste');

    panel.innerHTML =
        wastePendingHtml() +
        '<div id="waste-hist-block">' + wasteHistHtml() + '</div>';

    // The tab badge counts what needs ACTION. History is a record, not a queue.
    setTabCount('count-waste', wastePending.length);
    if (wastePending.length > 0 && wasteRecvEdit) updateWasteShortSummary();
}

// The history block alone. Paging redraws this and nothing else.
function renderWasteHistory() {
    var box = document.getElementById('waste-hist-block');
    if (box) box.innerHTML = wasteHistHtml();
}

function wastePendingHtml() {
    if (wastePending.length === 0) {
        // A one-liner, not a full-panel placeholder. The placeholder used to
        // take the whole tab and return early, which is precisely why there was
        // nowhere for a history to live. "Nothing to check in" is a small fact.
        return '<div class="waste-none">' +
            'Nothing awaiting receipt &mdash; every declared remnant has been checked in.' +
            '</div>';
    }

    var rows = wastePending.map(function (p, i) {
        var actionCell;
        if (wasteRecvEdit) {
            actionCell =
                '<span class="issue-input-group">' +
                    '<input type="number" step="1" min="0" max="' + p.count + '" ' +
                        'class="issue-input" id="' + wasteRecvGotId(i) + '" value="' + p.count + '" ' +
                        'oninput="onWasteRecvInput(' + i + ')" ' +
                        'onblur="onWasteRecvCommit(' + i + ')" />' +
                    '<span class="issue-unit">pcs</span>' +
                '</span>' +
                // Says the shortfall out loud instead of leaving him to subtract
                // two numbers in his head — and it is the shortfall, not the
                // typed figure, that becomes a dispute.
                '<div class="short-hint" id="' + wasteRecvShortId(i) + '"></div>';
        } else {
            actionCell = '<span class="status-pill status-partial">Awaiting check</span>';
        }

        return '' +
            '<tr>' +
                '<td class="material-name-cell">' +
                    '<div class="mat-name">&#9851; ' + escapeHtml(p.material || '—') + '</div>' +
                    '<div class="mat-sku">' + escapeHtml(p.salesOrder || '') +
                        (p.planNo ? ' · ' + escapeHtml(p.planNo) : '') +
                        ' · from ' + escapeHtml(p.supervisor || '—') +
                        ' · ' + escapeHtml(p.declaredOn || '') + '</div>' +
                '</td>' +
                '<td class="col-num col-strong">' +
                    '<span class="qty-big">' + p.count + '<span class="unit">pcs</span></span>' +
                    '<div class="qty-sub">' + fmt(p.length) + ' &times; ' + fmt(p.width) + ' cm</div>' +
                '</td>' +
                '<td class="col-issue">' + actionCell + '</td>' +
                (wasteRecvEdit
                    ? '<td class="col-note">' +
                          '<input type="text" class="note-input" id="' + wasteRecvNoteId(i) + '" ' +
                              'placeholder="Why is it short?" disabled />' +
                      '</td>'
                    : '') +
            '</tr>';
    }).join('');

    var footer;
    if (wasteRecvEdit) {
        footer =
            '<div class="card-footer">' +
                '<span class="sel-count" id="wr-sel-count">' +
                    'Everything as declared — change only what is actually short.' +
                '</span>' +
                '<button type="button" class="ghost-btn" onclick="setWasteRecvEdit(false)">Cancel</button>' +
                '<button type="button" class="primary-btn" id="wr-receive-btn" ' +
                    'onclick="submitWasteReceipt()">Confirm what I received</button>' +
            '</div>';
    } else {
        footer =
            '<div class="card-footer">' +
                '<span class="sel-count">' + wastePending.length +
                    (wastePending.length === 1 ? ' line' : ' lines') + ' to check</span>' +
                '<button type="button" class="ghost-btn" onclick="setWasteRecvEdit(true)">Something&rsquo;s missing</button>' +
                '<button type="button" class="primary-btn" id="wr-receive-btn" ' +
                    'onclick="submitWasteReceipt()">All received as declared</button>' +
            '</div>';
    }

    return '' +
        '<div class="item-card open">' +
            '<div class="item-header static-header">' +
                '<div class="item-header-info">' +
                    '<h2>Waste awaiting receipt</h2>' +
                    '<div class="item-meta-line"><span>' + wastePending.length +
                        ' piece row(s) he says he sent back, not yet checked in</span></div>' +
                '</div>' +
            '</div>' +
            '<div class="item-body is-open">' +
                '<div class="tables-container">' +
                    '<div class="table-wrapper">' +
                        '<table><thead><tr>' +
                            '<th>Piece</th>' +
                            '<th class="col-num">Declared</th>' +
                            '<th class="col-issue">' +
                                (wasteRecvEdit ? 'Actually received' : 'Status') + '</th>' +
                            (wasteRecvEdit ? '<th class="col-note">Note</th>' : '') +
                        '</tr></thead><tbody>' + rows + '</tbody></table>' +
                    '</div>' +
                '</div>' +
                footer +
            '</div>' +
        '</div>';
}

// ---- Declared history, one page at a time ----
//
// PAGED ON THE SERVER, not sliced here. getStoreWasteHistory uses Creator's
// "range from A to B" so the Deluge loop iterates at most a page's worth however
// many records exist — fetching everything and showing twenty would cap the
// table without capping the cost, and the statement-execution limit is not
// catchable: it kills the script and this widget gets a bare 500 with no error
// card at all.
//
// Custom API calls from a widget are NOT metered, so the extra round trips a
// pager costs are free. That is what makes paging strictly better here than the
// usual trade-off would suggest.

var wasteHist = [];
var wasteHistTotal = 0;
var wasteHistOffset = 0;
var wasteHistState = 'idle';
var wasteHistError = '';
var WASTE_PAGE = 20;

function loadWasteHistory(offset) {
    // Only the first load shows a spinner in place of the table. Paging keeps
    // the old rows on screen until the new ones arrive, so the block does not
    // collapse and bounce the page under the cursor.
    wasteHistState = wasteHist.length === 0 ? 'loading' : 'paging';
    renderWasteHistory();

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreWasteHistory',
        http_method: 'POST',
        payload: {
            offsetTxt: String(offset),
            limitTxt: String(WASTE_PAGE)
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getStoreWasteHistory parse failed:', e, response.result);
            wasteHistError = 'Could not read the reply from Creator.';
            wasteHistState = 'error';
            renderWasteHistory();
            return;
        }
        if (parsed.errors && parsed.errors.length > 0) {
            wasteHistError = parsed.errors.join(' · ');
            wasteHistState = 'error';
            renderWasteHistory();
            return;
        }
        wasteHist = parsed.pieces || [];
        wasteHistTotal = Number(parsed.total) || 0;
        // Taken from the REPLY, not from what was asked for. The server clamps
        // both, so trusting the request would let the pager drift out of step
        // with the rows it is actually showing.
        wasteHistOffset = Number(parsed.offset) || 0;
        wasteHistState = 'ready';
        renderWasteHistory();
    }).catch(function (err) {
        console.error('getStoreWasteHistory error:', err);
        wasteHistError = 'Could not reach Creator.';
        wasteHistState = 'error';
        renderWasteHistory();
    });
}

function wasteHistPages() {
    return Math.max(1, Math.ceil(wasteHistTotal / WASTE_PAGE));
}

function wasteHistCurrent() {
    return Math.floor(wasteHistOffset / WASTE_PAGE) + 1;
}

// ANY page in one hop. Offset paging carries no cursor — page 7 is just
// offset 120 — so jumping to it costs exactly what stepping to it would, and
// there is no reason to make him press Older six times to get there.
function wasteHistGoto(page) {
    if (wasteHistState === 'loading' || wasteHistState === 'paging') return;
    var last = wasteHistPages();
    if (page < 1) page = 1;
    if (page > last) page = last;
    var off = (page - 1) * WASTE_PAGE;
    if (off === wasteHistOffset) return;
    loadWasteHistory(off);
}

function wasteHistPage(dir) {
    wasteHistGoto(wasteHistCurrent() + dir);
}

// ---- Shared pager ----
//
// Drives the waste history and the issue history. Both page on the SERVER, via
// Creator's "range from A to B"; this is only the control.
//
// ONE function for both, because the alternative had already started: the two
// tabs would each grow their own wording and their own disabled rules, and a
// pager that behaves differently on two tabs of one screen is worse than either
// version of it.

// Which page numbers to draw: always the first and last, plus one either side
// of where he is, with a gap marker (null) standing in for the rest. Forty
// pages of buttons is not a control, it is a wall.
function pageListFor(cur, last) {
    var want = {};
    var p;

    want[1] = true;
    want[last] = true;
    for (p = cur - 1; p <= cur + 1; p++) {
        if (p >= 1 && p <= last) want[p] = true;
    }

    var nums = Object.keys(want).map(Number).sort(function (a, b) { return a - b; });
    var out = [];
    var prev = 0;
    nums.forEach(function (n) {
        if (prev > 0 && n - prev > 1) out.push(null);
        out.push(n);
        prev = n;
    });
    return out;
}

// cfg: { offset, total, limit, count, busy, fn, noun }
//   count — rows actually on screen, so the last page can read "41–45" rather
//           than a full page's worth it does not have.
//   fn    — global function name taking a 1-based page number.
function pagerHtml(cfg) {
    var limit = cfg.limit;
    var total = Number(cfg.total) || 0;
    var offset = Number(cfg.offset) || 0;
    var shown = Number(cfg.count) || 0;
    var last = Math.max(1, Math.ceil(total / limit));
    var cur = Math.floor(offset / limit) + 1;
    var from = total === 0 ? 0 : offset + 1;
    var to = offset + shown;
    var busy = cfg.busy === true;
    var noun = cfg.noun ? ' ' + cfg.noun : '';

    var btn = function (page, label, extraCls, off) {
        return '<button type="button" class="pg-btn' + (extraCls || '') + '"' +
            (off || busy ? ' disabled' : '') +
            ' onclick="' + cfg.fn + '(' + page + ')">' + label + '</button>';
    };

    // A single page needs no controls at all — a lone disabled arrow pair is
    // furniture that says nothing the count does not already say.
    var controls = '';
    if (last > 1) {
        controls =
            btn(cur - 1, '&lsaquo;', ' pg-arrow', cur === 1) +
            pageListFor(cur, last).map(function (p) {
                if (p === null) return '<span class="pg-gap">&hellip;</span>';
                return btn(p, p, p === cur ? ' is-current' : '', p === cur);
            }).join('') +
            btn(cur + 1, '&rsaquo;', ' pg-arrow', cur === last);
    }

    return '<div class="card-footer pager">' +
        '<span class="sel-count">Showing ' + from + '&ndash;' + to +
            ' of ' + total + noun + '</span>' +
        controls +
    '</div>';
}

// The STORE's reading of a piece's status, which is not the supervisor's. He
// wants to know his return was accepted; the store wants to know where the
// piece is now, so Available says "on the rack" here and "checked in" there.
function wasteHistStatus(s) {
    if (s === 'Pending_Receipt') return { text: 'Awaiting check', cls: 'status-partial' };
    if (s === 'Available') return { text: 'On the rack', cls: 'status-sufficient' };
    if (s === 'Consumed') return { text: 'Used again', cls: 'status-sufficient' };
    if (s === 'Issued') return { text: 'Issued out', cls: 'status-sufficient' };
    // The two write-offs, kept apart. Scrapped is a real remnant thrown away and
    // belongs in "what did we discard this month"; Miscounted is a piece that
    // never existed and must not inflate that figure.
    if (s === 'Scrapped') return { text: 'Scrapped', cls: 'status-shortfall' };
    if (s === 'Miscounted') return { text: 'Miscounted', cls: 'status-shortfall' };
    if (s === 'Disputed') return { text: 'Disputed', cls: 'status-shortfall' };
    return { text: s || '—', cls: 'status-partial' };
}

function wasteHistHtml() {
    if (wasteHistState === 'loading') {
        return '<div class="panel-loading">Loading the history…</div>';
    }
    if (wasteHistState === 'error') {
        return '<div class="panel-placeholder">' +
            '<h2>Could not load the history</h2>' +
            '<p>' + escapeHtml(wasteHistError) + '</p></div>';
    }
    if (wasteHistState === 'idle' || wasteHistTotal === 0) {
        return '<div class="panel-placeholder">' +
            '<h2>Nothing declared yet</h2>' +
            '<p>Offcuts a supervisor sends back will be listed here.</p></div>';
    }

    var rows = wasteHist.map(function (p) {
        var st = wasteHistStatus(p.status);
        return '' +
            '<tr>' +
                '<td class="material-name-cell">' +
                    '<div class="mat-name">&#9851; ' + escapeHtml(p.material || '—') + '</div>' +
                    '<div class="mat-sku">' + escapeHtml(p.salesOrder || '') +
                        (p.planNo ? ' · ' + escapeHtml(p.planNo) : '') + '</div>' +
                '</td>' +
                '<td class="col-num">' + fmt(p.length) + ' &times; ' + fmt(p.width) +
                    '<span class="unit"> cm</span></td>' +
                '<td class="col-num col-strong">' + p.count +
                    '<span class="unit"> pcs</span></td>' +
                '<td>' + escapeHtml(p.supervisor || '—') + '</td>' +
                '<td><span class="status-pill ' + st.cls + '">' +
                    escapeHtml(st.text) + '</span></td>' +
                '<td>' + escapeHtml(p.declaredOn || '') + '</td>' +
            '</tr>';
    }).join('');

    // NUMBERS, not "Newer" and "Older". Two directional words on a newest-first
    // list read backwards to half the people who see them — "Older" moves you
    // FORWARD through pages — and they can only ever step. The page he is on is
    // the label, so nothing has to be named at all.
    var pager = pagerHtml({
        offset: wasteHistOffset,
        total: wasteHistTotal,
        limit: WASTE_PAGE,
        count: wasteHist.length,
        busy: wasteHistState === 'paging',
        fn: 'wasteHistGoto'
    });

    return '' +
        '<div class="item-card open">' +
            '<div class="item-header static-header">' +
                '<div class="item-header-info">' +
                    '<h2>Declared history</h2>' +
                    '<div class="item-meta-line"><span>Every offcut sent back, ' +
                        'newest first &mdash; including ones still awaiting a check ' +
                        'and ones that ended in a dispute</span></div>' +
                '</div>' +
            '</div>' +
            '<div class="item-body is-open">' +
                '<div class="tables-container">' +
                    '<div class="table-wrapper">' +
                        '<table><thead><tr>' +
                            '<th>Piece</th>' +
                            '<th class="col-num">Cut piece size (L &times; W)</th>' +
                            '<th class="col-num">Pieces</th>' +
                            '<th>From</th>' +
                            '<th>Status</th>' +
                            '<th>Declared</th>' +
                        '</tr></thead><tbody>' + rows + '</tbody></table>' +
                    '</div>' +
                '</div>' +
                pager +
            '</div>' +
        '</div>';
}

// Every row, with what the store says is on the rack against it. Nothing is
// filtered out: the confirm button covers the whole list, the way the
// supervisor's does.
function wasteRecvRows() {
    return wastePending.map(function (p, i) {
        var got = wasteRecvGot(p, i);
        return { piece: p, index: i, got: got, short: p.count - got };
    });
}

// Read, never write, while he is still typing. Rewriting input.value on every
// keystroke makes the field impossible to clear and edit.
function onWasteRecvInput(i) {
    var input = document.getElementById(wasteRecvGotId(i));
    var p = wastePending[i];

    var raw = String(input.value).trim();
    var val = parseInt(raw, 10);
    var typed = raw !== '' && !isNaN(val);
    if (!typed || val < 0) val = 0;

    var over = typed && val > p.count;
    var short = over ? 0 : p.count - val;

    input.classList.toggle('invalid', short > 0 || over);

    var hint = document.getElementById(wasteRecvShortId(i));
    if (hint) {
        if (over) {
            hint.textContent = 'more than he declared';
        } else {
            hint.textContent = short > 0
                ? 'short by ' + short + (short === 1 ? ' pc' : ' pcs')
                : '';
        }
    }

    // The note is only stored against a shortfall, so it only opens when there
    // is one. Typing an explanation the server discards is worse than having
    // nowhere to type it.
    var note = document.getElementById(wasteRecvNoteId(i));
    if (note) {
        note.disabled = short <= 0;
        if (short <= 0) note.value = '';
    }

    updateWasteShortSummary();
}

// Blur, not keystroke. This is where a half-typed or out-of-range entry is
// settled, so the figure submitted is never whatever the field happened to
// contain mid-edit.
function onWasteRecvCommit(i) {
    var input = document.getElementById(wasteRecvGotId(i));
    var p = wastePending[i];

    var val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    if (val > p.count) val = p.count;
    input.value = val;

    onWasteRecvInput(i);
}

// Restates in the footer what the button is about to do. A dispute is a
// consequence of the numbers above, not of the words on the button.
function updateWasteShortSummary() {
    var label = document.getElementById('wr-sel-count');
    if (!label) return;

    var shortRows = wasteRecvRows().filter(function (r) { return r.short > 0; });
    var shortTotal = shortRows.reduce(function (n, r) { return n + r.short; }, 0);

    if (shortRows.length === 0) {
        label.textContent = 'Everything as declared — change only what is actually short.';
        label.classList.remove('is-short');
    } else {
        label.textContent = shortTotal + (shortTotal === 1 ? ' piece' : ' pieces') +
            ' short across ' + shortRows.length +
            (shortRows.length === 1 ? ' line' : ' lines') + ' — ' +
            (shortRows.length === 1 ? 'a dispute' : shortRows.length + ' disputes') +
            ' will be raised.';
        label.classList.add('is-short');
    }
}

function submitWasteReceipt() {
    var rows = wasteRecvRows();
    if (rows.length === 0) return;

    // A short row opens a question for the supervisor. Sending it without saying
    // what was actually on the rack leaves him with nothing to answer.
    var unexplained = rows.filter(function (r) {
        var note = document.getElementById(wasteRecvNoteId(r.index));
        return r.short > 0 && (!note || !note.value.trim());
    });
    if (unexplained.length > 0) {
        alert('Say why the short line' + (unexplained.length > 1 ? 's are' : ' is') +
            ' short — the supervisor has to answer it.');
        return;
    }

    var shortTotal = rows.reduce(function (n, r) { return n + r.short; }, 0);

    // Last stop before a dispute goes out with somebody's name on it.
    if (shortTotal > 0) {
        var ok = confirm(
            shortTotal + (shortTotal === 1 ? ' piece' : ' pieces') +
            ' fewer than declared.\n\n' +
            'The rest are taken into store now, and a dispute is raised against the ' +
            'supervisor for the difference. He has to answer it before it can be ' +
            'written off.'
        );
        if (!ok) return;
    }

    var btn = document.getElementById('wr-receive-btn');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'receiveWastePieces',
        http_method: 'POST',
        payload: {
            piecesJson: JSON.stringify(rows.map(function (r) {
                var note = document.getElementById(wasteRecvNoteId(r.index));
                return {
                    id: String(r.piece.id),
                    count: r.got,
                    note: r.short > 0 && note ? note.value.trim() : ''
                };
            }))
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            parsed = null;
        }
        btn.textContent = label;
        if (parsed && parsed.success) {
            wasteRecvEdit = false;
            // Said plainly, because raising a dispute is not what he pressed the
            // button for — it is a consequence of the number he typed.
            if (parsed.disputed > 0) {
                // A tab is fetched once per session, so a Disputes tab opened
                // earlier holds the list as it was BEFORE this dispute existed —
                // and clicking it just replays that. The badge would update
                // (loadCounts is its own call) and the list would not, which
                // reads as the dispute having vanished.
                // Same shape as production.js does after saving waste: mark it
                // loaded and load it now, rather than leaving the flag false and
                // paying for a second fetch on the next click.
                tabsLoaded.disputes = true;
                loadDisputes();

                alert(parsed.pieces + ' piece(s) taken into store.\n\n' +
                    parsed.disputed + ' dispute(s) opened for the ' + shortTotal +
                    ' that did not turn up — they now sit with the supervisor.');
            }
            // A skipped row is one somebody else already dealt with. Without
            // this it simply reappears with no explanation.
            if (parsed.skipped > 0) {
                alert(parsed.skipped + ' row(s) were skipped — they had already ' +
                    'been received or written off elsewhere.');
            }
            // Re-fetch rather than splicing the list: pieces move to Available
            // server-side, and a stale local copy would offer them again.
            loadWasteReceipt();
            loadCounts();
        } else {
            alert('Could not mark them received: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
        }
    }).catch(function (err) {
        console.error('receiveWastePieces error:', err);
        alert('Failed to reach the server. Check the console.');
        btn.textContent = label;
        btn.disabled = false;
    });
}

// ---- Disputes tab ----
//
// Two directions, one list. Outbound is raised when a supervisor confirms less
// than was issued; inbound when the store finds fewer offcuts on the rack than
// he declared after cutting. Until somebody says what happened, the gap sits in
// Disputed_Qty: owned, off the shelf, and counted nowhere useful.
//
// The three outcomes are the only answers there are — the receiver had it, it
// never left the sender, or it is gone. Which of those the STORE may say flips
// with the direction, because the store is the sender one way and the receiver
// the other, so the dialog reads the direction rather than assuming.

var disputes = [];

function disputeIsInbound(d) {
    // Empty means outbound: every dispute raised before the field existed was
    // one, and the server applies the same default.
    return d && d.direction === 'Inbound';
}

// What the supervisor has already said, in his own terms. A denial means "not
// with me" on the outbound leg and "I did send them" on the inbound one — the
// same record, the opposite sentence.
function disputeSupervisorAnswer(d) {
    if (!d.supervisorDenied) return '';
    return disputeIsInbound(d)
        ? 'I don\'t have them, I sent them back'
        : 'I don\'t have it';
}

// Whose turn it is. A denial resolves nothing on its own — it records that one
// side has looked — so the list has to say which side is still to answer.
// Without this the store sees a bare Resolve button and no sign that anything
// happened, which reads as the supervisor's answer having been lost.
function disputeWaitingOn(d) {
    if (d.supervisorDenied && !d.storeDenied) return 'your turn';
    if (d.storeDenied && !d.supervisorDenied) return 'waiting on the supervisor';
    return '';
}

function loadDisputes() {
    var panel = document.getElementById('panel-disputes');
    panel.innerHTML = '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreDisputes',
        http_method: 'GET'
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getStoreDisputes parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the list</h2><p>Check the browser console.</p></div>';
            return;
        }
        disputes = parsed.disputes || [];
        var errs = parsed.errors || [];

        // Errors and rows arrive together — the server skips the rows it cannot
        // read and returns the rest. Only a run that produced NOTHING is a dead
        // end; otherwise the readable disputes are shown with the failures noted
        // above them. Showing an empty list on its own reads as "nothing in
        // dispute", the exact opposite of what happened, and it contradicts the
        // tab badge, which is counted by a different function that did not fail.
        if (errs.length > 0) console.error('getStoreDisputes:', errs);

        if (errs.length > 0 && disputes.length === 0) {
            panel.innerHTML =
                '<div class="panel-placeholder">' +
                    '<h2>The dispute list could not be built</h2>' +
                    '<p>' + escapeHtml(errs[0]) + '</p>' +
                    '<p>The disputes are still there — this screen cannot read them. ' +
                    'Run the function in Creator with Execute to see the real error.</p>' +
                '</div>';
            return;
        }

        renderDisputes();

        if (errs.length > 0) {
            panel.innerHTML =
                '<div class="exc-warn">' +
                    '<b>' + errs.length + ' dispute(s) could not be read and are missing below.</b>' +
                    '<div class="exc-warn-quote">' + escapeHtml(errs[0]) + '</div>' +
                '</div>' + panel.innerHTML;
        }
    }).catch(function (err) {
        console.error('getStoreDisputes error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

function renderDisputes() {
    var panel = document.getElementById('panel-disputes');

    if (disputes.length === 0) {
        panel.innerHTML =
            '<div class="panel-placeholder">' +
                '<h2>No open disputes</h2>' +
                '<p>Everything issued out, and every leftover piece sent back, has been accounted for.</p>' +
            '</div>';
        setTabCount('count-disputes', 0);
        return;
    }

    var rows = disputes.map(function (d, i) {
        var inbound = disputeIsInbound(d);
        return '' +
            '<tr>' +
                '<td class="material-name-cell">' +
                    '<div class="mat-name">' + escapeHtml(d.material || '—') +
                        (d.isWaste ? '<span class="waste-badge">&#9851; waste</span>' : '') +
                        (inbound
                            ? '<span class="dir-badge dir-in">&#8601; came back</span>'
                            : '<span class="dir-badge dir-out">&#8599; issued out</span>') +
                    '</div>' +
                    // The size is how anybody finds one specific remnant on the
                    // rack — the material name alone matches a dozen rows.
                    (d.isWaste && d.length > 0
                        ? '<div class="mat-sku">' + fmt(d.length) + ' × ' + fmt(d.width) + ' cm</div>'
                        : '') +
                    '<div class="mat-sku">' + escapeHtml(d.salesOrder || '') +
                        (d.planNo ? ' · ' + escapeHtml(d.planNo) : '') + '</div>' +
                '</td>' +
                '<td>' + escapeHtml(d.supervisor || '—') + '</td>' +
                '<td class="col-num">' + fmt(d.issued) + '<span class="unit">' + escapeHtml(d.unit || '') + '</span></td>' +
                '<td class="col-num">' + fmt(d.received) + '<span class="unit">' + escapeHtml(d.unit || '') + '</span></td>' +
                '<td class="col-num col-strong">' +
                    '<span class="qty-big">' + fmt(d.remaining) +
                        '<span class="unit">' + escapeHtml(d.unit || '') + '</span></span>' +
                    (d.resolved > 0
                        ? '<div class="qty-sub">' + fmt(d.resolved) + ' already settled</div>'
                        : '') +
                '</td>' +
                '<td>' + escapeHtml(d.raisedOn || '—') + '</td>' +
                '<td class="col-action">' +
                    // The supervisor's answer belongs on the row, not buried in
                    // the dialog. A denial resolves nothing on its own, so a
                    // bare Resolve button next to an unchanged Outstanding reads
                    // as his answer having gone nowhere.
                    (d.supervisorDenied
                        ? '<div class="answer-tag">He answered: &ldquo;' +
                              escapeHtml(disputeSupervisorAnswer(d)) + '&rdquo;</div>'
                        : '') +
                    '<button type="button" class="raise-btn' +
                        (d.supervisorDenied ? ' is-danger' : '') +
                        '" onclick="openResolveDialog(' + i + ')">Resolve</button>' +
                    (disputeWaitingOn(d)
                        ? '<div class="turn-tag">' + escapeHtml(disputeWaitingOn(d)) + '</div>'
                        : '') +
                '</td>' +
            '</tr>';
    }).join('');

    panel.innerHTML =
        '<div class="item-card">' +
            '<div class="item-header static-header">' +
                '<div class="item-header-info">' +
                    '<h2>Open disputes</h2>' +
                    '<div class="item-meta-line"><span>Material issued but not confirmed, and leftover pieces that did not come back</span></div>' +
                '</div>' +
            '</div>' +
            '<div class="item-body is-open">' +
                '<div class="tables-container">' +
                    '<div class="table-wrapper">' +
                        '<table><thead><tr>' +
                            '<th>Material</th>' +
                            '<th>Supervisor</th>' +
                            // Not "Issued"/"Received": on an inbound row the
                            // supervisor is the one who handed over and the store
                            // is the one who confirmed. A column has to mean the
                            // same thing on every row of the table.
                            '<th class="col-num">Handed over</th>' +
                            '<th class="col-num">Confirmed</th>' +
                            '<th class="col-num">Outstanding</th>' +
                            '<th>Raised</th>' +
                            '<th class="col-action"></th>' +
                        '</tr></thead><tbody>' + rows + '</tbody></table>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    setTabCount('count-disputes', disputes.length);
}

function openResolveDialog(idx) {
    var d = disputes[idx];
    if (!d) return;
    var el = exceptionModalEl();
    var inbound = disputeIsInbound(d);

    // Only what the STORE can answer for, and that swaps with the direction.
    // Outbound the store is the sender, so its answer is "it never left the
    // shelf". Inbound the store is the receiver, so its answer is "they were
    // here after all" — which is also what puts the pieces on the rack.
    // Said the way a person would say it. Every option is a plain sentence about
    // whether the material is in this person's hands, not a name for a state.
    var options = inbound
        ? '<option value="Found">I have the pieces after all</option>' +
          '<option value="Denied">I don\'t have the pieces</option>'
        : '<option value="Store_Correction">I over-recorded, it never left the shelf</option>' +
          '<option value="Denied">I don\'t have it, it left the store</option>';

    el.classList.remove('hidden');
    el.innerHTML =
        '<div class="exc-panel exc-panel-wide">' +
            '<h3>Resolve dispute</h3>' +
            '<p class="exc-sub">' + escapeHtml(d.material || '') + ' &middot; ' +
                escapeHtml(d.supervisor || '') + '</p>' +
            '<div class="exc-facts">' +
                '<span>' + (inbound ? 'Declared' : 'Issued') + ' <b>' + fmt(d.issued) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
                '<span>' + (inbound ? 'Found' : 'Received') + ' <b>' + fmt(d.received) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
                '<span class="exc-strong">Outstanding <b>' + fmt(d.remaining) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
            '</div>' +

            // Lost is nobody's to declare — it is what the system concludes
            // once both sides have said no.
            '<label class="exc-label">What happened?</label>' +
            '<select id="res-type" onchange="onResTypeChange(' + idx + ')">' +
                options +
            '</select>' +

            // What the raiser said at the time. On an outbound dispute this is
            // the supervisor's reason and the store has not seen it before.
            (d.raisedNote
                ? '<div class="exc-quote">Raised as: &ldquo;' + escapeHtml(d.raisedNote) + '&rdquo;</div>'
                : '') +

            (d.supervisorDenied
                ? '<div class="exc-warn" id="res-warn">' +
                      // The same Supervisor_Denied line means the opposite
                      // sentence each way round: outbound he never received it,
                      // inbound he insists he sent it.
                      '<b>' + (inbound
                          ? 'The supervisor says he does not have them — he sent them back.'
                          : 'The supervisor says he does not have it.') + '</b>' +
                      (d.supervisorNote
                          ? '<div class="exc-warn-quote">&ldquo;' + escapeHtml(d.supervisorNote) + '&rdquo;</div>'
                          : '') +
                      '<div>If you also say it is not with you, the ' +
                      fmt(d.remaining) + ' ' + escapeHtml(d.unit || '') +
                      (inbound
                          ? ' is written off as lost. The store never had it, so nothing comes out of stock.'
                          : ' is written off as lost and comes out of stock.') +
                      '</div>' +
                  '</div>'
                : '') +

            '<div id="res-qty-wrap">' +
                '<label class="exc-label">How much</label>' +
                '<input type="number" id="res-qty" ' +
                    (inbound ? 'step="1"' : 'step="0.01"') +
                    ' min="0" max="' + d.remaining + '" value="' + d.remaining + '">' +
                '<p class="exc-hint">' +
                    (inbound
                        ? 'Enter only what the store has actually got in hand — the rest stays open.'
                        : 'Correct part of it if only some was over-recorded — the rest stays open.') +
                '</p>' +
            '</div>' +

            '<label class="exc-label">Note</label>' +
            '<textarea id="res-note" rows="2" placeholder="What did you check, and what did you find"></textarea>' +

            '<div class="exc-foot">' +
                '<button type="button" class="ghost-btn" onclick="closeExceptionDialog()">Cancel</button>' +
                '<button type="button" class="primary-btn" id="res-send" ' +
                    'onclick="submitResolve(' + idx + ')">Save</button>' +
            '</div>' +
        '</div>';

    // Sets the opening state: correction is selected, so the quantity box is
    // showing and the write-off warning is not.
    onResTypeChange(idx);
}

// A denial is about the whole outstanding amount — "I do not have any of it" —
// so the quantity box has nothing to say and is taken away rather than left
// looking like it still means something.
function onResTypeChange(idx) {
    var d = disputes[idx];
    var isDeny = document.getElementById('res-type').value === 'Denied';
    var wrap = document.getElementById('res-qty-wrap');
    var send = document.getElementById('res-send');
    var warn = document.getElementById('res-warn');

    if (wrap) wrap.style.display = isDeny ? 'none' : '';
    if (warn) warn.style.display = isDeny ? '' : 'none';

    if (send) {
        // The button says what it is about to do. "Save" is too quiet for an
        // action that takes stock off the books.
        if (isDeny && d && d.supervisorDenied) {
            send.textContent = 'Write off as lost';
            send.classList.add('is-danger');
        } else {
            send.textContent = 'Save';
            send.classList.remove('is-danger');
        }
    }
}

function submitResolve(idx) {
    var d = disputes[idx];
    if (!d) return;

    var resType = document.getElementById('res-type').value;
    var isDeny = resType === 'Denied';

    var qty = isDeny ? d.remaining : parseFloat(document.getElementById('res-qty').value);
    if (!isDeny && (isNaN(qty) || qty <= 0)) {
        alert('Enter how much is being resolved.');
        return;
    }

    var note = document.getElementById('res-note').value;
    if (!note.trim()) {
        // A dispute is a question about what happened. Closing one without
        // saying why leaves the next person exactly where they started.
        alert('Add a note — what did you check?');
        return;
    }

    // Last stop before stock leaves the books, and the only place the amount
    // and the consequence appear in the same sentence.
    //
    // The consequence is not the same both ways. An inbound offcut was never
    // owed to an order and never reached the rack, so no requirement re-opens.
    // Promising one would send the store looking for work that never appears.
    if (isDeny && d.supervisorDenied) {
        var ok = confirm(
            'Both sides will have said this is not with them.\n\n' +
            fmt(d.remaining) + ' ' + (d.unit || '') + ' of ' + d.material +
            (disputeIsInbound(d)
                ? ' will be written off as lost. The store never had it, so it ' +
                  'will not be offered to any order.'
                : ' will be written off as lost and removed from stock.\n\n' +
                  'The order still needs it, so the requirement re-opens for you to issue again.')
        );
        if (!ok) return;
    }

    var btn = document.getElementById('res-send');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'resolveDispute',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                disputeId: String(d.id),
                qty: qty,
                resolution: resType,
                // The store can only ever answer for the store.
                side: 'store',
                note: note
            })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            parsed = null;
        }
        if (parsed && parsed.success) {
            closeExceptionDialog();
            // A denial that did not close anything leaves the dispute open on
            // the other person's screen — say so, or it looks like nothing
            // happened at all.
            if (parsed.waitingOn) {
                alert('Recorded. This now sits with ' + parsed.waitingOn +
                    ' — it stays open until they answer.');
            } else if (parsed.applied === 'Lost') {
                alert(disputeIsInbound(d)
                    ? 'Written off as lost. The store never had them, so ' +
                      'they will not be offered to any order.'
                    : 'Written off as lost. The requirement has re-opened, so it ' +
                      'will show on your issue list again.');
            }
            loadDisputes();
            loadCounts();
        } else {
            alert('Could not resolve it: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
            btn.textContent = label;
        }
    }).catch(function (err) {
        console.error('resolveDispute error:', err);
        alert('Failed to reach the server. Check the console.');
        btn.disabled = false;
        btn.textContent = label;
    });
}

// ---- History tab ----
//
// Handovers over a date range. The balances can say how much has gone out in
// total; only the Material_Issue records can say what crossed the counter on a
// given afternoon and who took it.

var histFrom = null;
var histTo = null;

// Deluge parses "dd-MMM-yyyy" the same way whatever the org's locale is, while
// "01-08-2026" is a different day in the US than it is here.
function toDeluge(d) {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return String(d.getDate()).padStart(2, '0') + '-' + months[d.getMonth()] + '-' + d.getFullYear();
}

function toInputDate(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

// Midnight today, so comparisons are day-granular.
function todayMidnight() {
    var t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
}

// PAGED, and the date filter rides along. The dates live in the Deluge QUERY,
// so "range from A to B" composes with them — narrowing the range narrows what
// is paged rather than fighting it.
var histOffset = 0;
var histTotal = 0;
var histBusy = false;
var HIST_PAGE = 10;

function loadHistory(offset) {
    var panel = document.getElementById('panel-history');

    // Default to the last week — long enough for "what went out this week",
    // short enough that the first load is not a full table scan.
    if (!histTo) histTo = todayMidnight();
    if (!histFrom) {
        histFrom = todayMidnight();
        histFrom.setDate(histFrom.getDate() - 6);
    }

    // Undefined means "start over" — which is what every caller except the pager
    // wants. Changing the dates while sitting on page 6 must not ask for page 6
    // of a range that may only have two.
    var want = typeof offset === 'number' ? offset : 0;

    histBusy = true;
    panel.innerHTML = histBar(null, 0) + '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreIssueHistory',
        http_method: 'POST',
        payload: {
            fromTxt: toDeluge(histFrom),
            toTxt: toDeluge(histTo),
            offsetTxt: String(want),
            limitTxt: String(HIST_PAGE)
        }
    }).then(function (response) {
        histBusy = false;
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getStoreIssueHistory parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the history</h2><p>Check the browser console.</p></div>';
            return;
        }
        if (parsed.errors && parsed.errors.length > 0) {
            panel.innerHTML = histBar([], 0) +
                '<div class="panel-placeholder"><h2>Could not load that range</h2><p>' +
                escapeHtml(parsed.errors.join(' ')) + '</p></div>';
            return;
        }
        // Taken from the REPLY, never from what was asked for. The server clamps
        // both, so trusting the request would let the pager drift out of step
        // with the rows it is actually showing.
        histOffset = Number(parsed.offset) || 0;
        histTotal = Number(parsed.total) || 0;
        renderHistory(parsed.handovers || [], parsed.lineCount || 0);
    }).catch(function (err) {
        histBusy = false;
        console.error('getStoreIssueHistory error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

function histPages() {
    return Math.max(1, Math.ceil(histTotal / HIST_PAGE));
}

function histGoto(page) {
    if (histBusy) return;
    var last = histPages();
    if (page < 1) page = 1;
    if (page > last) page = last;
    var off = (page - 1) * HIST_PAGE;
    if (off === histOffset) return;
    loadHistory(off);
}

function onHistRangeChange() {
    var f = document.getElementById('hist-from').value;
    var t = document.getElementById('hist-to').value;
    if (!f || !t) return;

    // Parsed as local. new Date("2026-08-01") is treated as UTC and lands on
    // the previous day for anyone east of Greenwich.
    var fp = f.split('-');
    var tp = t.split('-');
    histFrom = new Date(Number(fp[0]), Number(fp[1]) - 1, Number(fp[2]));
    histTo = new Date(Number(tp[0]), Number(tp[1]) - 1, Number(tp[2]));

    // Swapped rather than rejected — a reversed range is a slip, not a request.
    if (histFrom > histTo) {
        var tmp = histFrom;
        histFrom = histTo;
        histTo = tmp;
    }
    loadHistory();
}

function histPreset(days) {
    histTo = todayMidnight();
    histFrom = todayMidnight();
    histFrom.setDate(histFrom.getDate() - (days - 1));
    loadHistory();
}

function histBar(handovers, lineCount) {
    var summary = '';
    if (handovers !== null) {
        if (handovers.length === 0) {
            summary = 'Nothing issued in this range';
        } else {
            // The RANGE total, not the page's. "10 handovers" on a range holding
            // 137 reads as a quiet fortnight, which is the opposite of the truth
            // — the count in the bar describes the dates he picked, and the
            // pager below describes where he is in them.
            summary = histTotal + ' handover' + (histTotal === 1 ? '' : 's') +
                ' · showing ' + handovers.length +
                ' · ' + lineCount + ' line' + (lineCount === 1 ? '' : 's') + ' here';
        }
    }

    return '' +
        '<div class="day-bar">' +
            '<label class="range-label">From</label>' +
            '<input type="date" id="hist-from" value="' + toInputDate(histFrom) +
                '" max="' + toInputDate(todayMidnight()) + '" onchange="onHistRangeChange()">' +
            '<label class="range-label">To</label>' +
            '<input type="date" id="hist-to" value="' + toInputDate(histTo) +
                '" max="' + toInputDate(todayMidnight()) + '" onchange="onHistRangeChange()">' +
            '<button type="button" class="raise-btn is-stale" onclick="histPreset(1)">Today</button>' +
            '<button type="button" class="raise-btn is-stale" onclick="histPreset(7)">7 days</button>' +
            '<button type="button" class="raise-btn is-stale" onclick="histPreset(30)">30 days</button>' +
            '<span class="day-bar-sub">' + escapeHtml(summary) + '</span>' +
        '</div>';
}

function renderHistory(handovers, lineCount) {
    var panel = document.getElementById('panel-history');
    var bar = histBar(handovers, lineCount);

    // The "N older ones not shown — narrow the dates to see them" banner is
    // gone with the cap that caused it. Telling someone a history tab is hiding
    // records and the only way through is to look at less was never an answer;
    // the pager is.

    if (handovers.length === 0) {
        panel.innerHTML = bar +
            '<div class="panel-placeholder">' +
                '<h2>Nothing issued in this range</h2>' +
                '<p>Try a wider range, or one of the shortcuts above.</p>' +
            '</div>';
        return;
    }

    // Collapsed by default, newest one open.
    //
    // Fifty expanded cards is not a screen anyone can use — it is one handover
    // per scroll and no way to see the shape of the range. Collapsed, the same
    // fifty are a scannable list: who, when, how many lines. The line count sits
    // in the header precisely so the card does not have to be opened to know
    // whether it is worth opening.
    //
    // The newest is expanded because "what just went out" is the question this
    // tab is nearly always asked, and it should not cost a click.
    var cards = handovers.map(function (h, idx) {
        var lines = (h.lines || []).map(function (l) {
            var hasCut = Number(l.cutWidth) > 0 && Number(l.cutLength) > 0;
            return '<tr>' +
                '<td class="material-name-cell">' +
                    '<div class="mat-name">' + escapeHtml(l.material || '—') + '</div>' +
                    (l.sku ? '<div class="mat-sku">' + escapeHtml(l.sku) + '</div>' : '') +
                '</td>' +
                '<td>' + (hasCut
                    ? '<span class="cut-size">' + fmt(l.cutLength) + ' &times; ' + fmt(l.cutWidth) + '<span class="unit">cm</span></span>'
                    : '<span class="is-muted">&mdash;</span>') + '</td>' +
                '<td class="col-num col-strong">' + fmt(l.qty) + '<span class="unit">' + escapeHtml(l.unit || '') + '</span></td>' +
            '</tr>';
        }).join('');

        // Date on every card now — over a range, "18:05" alone does not say
        // which day it was.
        //
        // No order or plan number here. A handover is one press of Issue against
        // a SUPERVISOR, and issueMaterials fans that quantity across every open
        // plan he has — so a single handover routinely feeds several orders. The
        // header used to name the first plan that happened to take an allocation,
        // which read as "this material went to this order" and was not true. Who
        // took it and when is the whole of what a handover can honestly claim.
        var when = escapeHtml(h.date || '');
        if (h.time) when += (when ? ' · ' : '') + escapeHtml(h.time);

        var nLines = (h.lines || []).length;
        when += ' · ' + nLines + ' line' + (nLines === 1 ? '' : 's');

        return '' +
            '<div class="item-card' + (idx === 0 ? ' open' : '') + '" id="hist-card-' + idx + '">' +
                '<div class="item-header" onclick="toggleHistory(' + idx + ')">' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(h.supervisor || 'Unknown') + '</h2>' +
                        '<div class="item-meta-line"><span>' + when + '</span></div>' +
                    '</div>' +
                    '<div class="item-header-right">' +
                        '<span class="status-pill ' +
                            (h.status === 'Received' ? 'status-sufficient' : 'status-partial') + '">' +
                            escapeHtml((h.status || '').replace('_', ' ')) +
                        '</span>' +
                        '<span class="chevron" aria-hidden="true">' +
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
                                'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
                        '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="item-body">' +
                    '<div class="tables-container">' +
                        '<div class="table-wrapper">' +
                            '<table><thead><tr>' +
                                '<th>Material</th><th>Cut piece size</th><th class="col-num">Qty issued</th>' +
                            '</tr></thead><tbody>' + lines + '</tbody></table>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }).join('');

    // The pager sits in a card of its own rather than inside the last handover,
    // where it would look like part of that handover's contents.
    var pager = '<div class="item-card open pager-card">' +
        pagerHtml({
            offset: histOffset,
            total: histTotal,
            limit: HIST_PAGE,
            count: handovers.length,
            busy: histBusy,
            fn: 'histGoto',
            noun: 'handovers'
        }) +
    '</div>';

    panel.innerHTML = bar + cards + pager;
}

// Each card opens and closes on its own — deliberately NOT the accordion the
// Issue tab uses. There, one supervisor at a time is the task. Here he is
// comparing what went out on Tuesday against what went out on Wednesday, and a
// card that shuts itself when he opens another makes that impossible.
function toggleHistory(idx) {
    var card = document.getElementById('hist-card-' + idx);
    if (card) card.classList.toggle('open');
}

// ---- My requests tab ----
//
// Shortage and wash tickets the store raised, plus the wash jobs those queue.
// Closed ones stay listed: a request that vanishes on completion looks like a
// request that was lost.

function loadRequests() {
    var panel = document.getElementById('panel-requests');
    panel.innerHTML = '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreRequests',
        http_method: 'GET'
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getStoreRequests parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the list</h2><p>Check the browser console.</p></div>';
            return;
        }
        renderRequests(parsed.requests || [], parsed.openCount || 0);
    }).catch(function (err) {
        console.error('getStoreRequests error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

function requestKindLabel(kind) {
    // "Wash" not "Wash requested" — the row now covers the request AND the job
    // behind it, so naming it after one half would be misleading.
    if (kind === 'Wash_Needed') return 'Wash';
    if (kind === 'Wash_Job') return 'Wash';
    if (kind === 'Shortage') return 'Purchase';
    return kind || '—';
}

function requestIsOpen(r) {
    return r.status === 'Open' || r.status === 'Pending' || r.status === 'In_Progress';
}

function renderRequests(requests, openCount) {
    var panel = document.getElementById('panel-requests');

    if (requests.length === 0) {
        panel.innerHTML =
            '<div class="panel-placeholder">' +
                '<h2>No requests raised</h2>' +
                '<p>Shortage and wash requests you raise will be listed here.</p>' +
            '</div>';
        setTabCount('count-requests', 0);
        return;
    }

    // Open first. What is still outstanding is the reason to open this tab;
    // the closed ones are confirmation, and belong underneath.
    var sorted = requests.slice().sort(function (a, b) {
        return (requestIsOpen(b) ? 1 : 0) - (requestIsOpen(a) ? 1 : 0);
    });

    var rows = sorted.map(function (r) {
        var open = requestIsOpen(r);
        return '<tr class="' + (open ? '' : 'row-issued') + '">' +
            '<td><span class="status-pill ' + (open ? 'status-partial' : 'status-sufficient') + '">' +
                escapeHtml(requestKindLabel(r.kind)) + '</span></td>' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(r.material || '—') + '</div>' +
                (r.orders > 0
                    ? '<div class="mat-sku">' + r.orders + ' order' + (r.orders === 1 ? '' : 's') + ' waiting</div>'
                    : '') +
            '</td>' +
            '<td class="col-num">' + fmt(r.qty) + '<span class="unit">' + escapeHtml(r.unit || '') + '</span></td>' +
            '<td class="col-num col-strong">' +
                (Number(r.done) > 0
                    ? fmt(r.done) + '<span class="unit">' + escapeHtml(r.unit || '') + '</span>'
                    : '<span class="is-muted">&mdash;</span>') +
            '</td>' +
            '<td>' + escapeHtml((r.status || '').replace('_', ' ')) + '</td>' +
            '<td>' + escapeHtml(r.raisedOn || '—') + '</td>' +
        '</tr>';
    }).join('');

    panel.innerHTML =
        '<div class="item-card">' +
            '<div class="item-header static-header">' +
                '<div class="item-header-info">' +
                    '<h2>My requests</h2>' +
                    '<div class="item-meta-line"><span>' + openCount + ' still outstanding</span></div>' +
                '</div>' +
            '</div>' +
            '<div class="item-body is-open">' +
                '<div class="tables-container">' +
                    '<div class="table-wrapper">' +
                        '<table><thead><tr>' +
                            '<th>Type</th><th>Material</th>' +
                            '<th class="col-num">Requested</th>' +
                            '<th class="col-num">Received</th>' +
                            '<th>Status</th><th>Raised</th>' +
                        '</tr></thead><tbody>' + rows + '</tbody></table>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    setTabCount('count-requests', openCount);
}

// ---- Material used ----
//
// What an order cost in raw material against what it was planned to cost, and
// where the two differ, why.
//
// The headline is SPENT, not issued. Issued_Qty is what is currently booked as
// having reached production — a store correction pulls it back down and so does
// a write-off. Material that was lost still left the building and still cost
// money, so spent = issued + written off.

var consOrders = [];

document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
        showTab(btn.getAttribute('data-tab'));
    });
});

function setTodayLabel() {
    var el = document.getElementById('app-date');
    if (!el) return;
    var d = new Date();
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    el.textContent = days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

// Badges before the tabs are opened. One small count call rather than fetching
// every tab's list on boot just to draw numbers.
function loadCounts() {
    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreCounts',
        http_method: 'GET'
    }).then(function (response) {
        var c;
        try {
            c = JSON.parse(response.result);
        } catch (e) {
            return;
        }
        setTabCount('count-waste', c.pendingWaste);
        setTabCount('count-disputes', c.openDisputes);
        setTabCount('count-requests', c.openRequests);
    }).catch(function (err) {
        // A missing badge is not worth an error message — the tabs still work.
        console.error('getStoreCounts error:', err);
    });
}

// ---- Stock in tab ----
//
// Where arriving cloth gets a tone. A LOT IS A TONE, NOT A DELIVERY: same SKU,
// same width, every recorded detail identical — the difference is only visible
// to the eye. The store person holds the new cloth against what is on the rack
// and either tops up the lot it matches or starts a new one.
//
// FABRIC ONLY. Accessories have no lots and getStoreLots does not return them.
//
// The lot holds the truth and Raw_Material holds a maintained total; both move
// in one pass inside saveStockInward, so this screen never computes a balance
// of its own. Everything shown here comes back from the server.

var stockMats = [];
var stockFilter = '';
var stockOpenId = null;

function loadStockIn() {
    var panel = document.getElementById('panel-stockin');
    panel.innerHTML = '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getStoreLots',
        http_method: 'GET'
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getStoreLots parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the stock list</h2><p>Check the browser console.</p></div>';
            return;
        }
        // Deluge returns its real message inside the payload — Creator would
        // otherwise surface every failure as a bare "code 9430".
        if (parsed.error) console.error('getStoreLots:', parsed.error);
        stockMats = parsed.materials || [];
        renderStockIn();
    }).catch(function (err) {
        console.error('getStoreLots error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

// TWO BLOCKS, redrawn separately, and the search box is the reason. Rebuilding
// the input on every keystroke destroys the element the browser is focused on,
// so the caret jumps out after the first character. Only the list redraws.
function renderStockIn() {
    var panel = document.getElementById('panel-stockin');
    panel.innerHTML =
        '<div class="stockin-search">' +
            '<input type="text" id="stockin-filter" class="note-input" ' +
                'placeholder="Search SKU or material…" oninput="onStockFilter()" />' +
        '</div>' +
        '<div id="stockin-list">' + stockInListHtml() + '</div>';
}

function renderStockInList() {
    var box = document.getElementById('stockin-list');
    if (box) box.innerHTML = stockInListHtml();
}

function onStockFilter() {
    var el = document.getElementById('stockin-filter');
    stockFilter = el ? el.value.trim().toLowerCase() : '';
    renderStockInList();
}

function stockInMatches() {
    if (!stockFilter) return stockMats;
    return stockMats.filter(function (m) {
        return (m.sku || '').toLowerCase().indexOf(stockFilter) !== -1 ||
               (m.material || '').toLowerCase().indexOf(stockFilter) !== -1;
    });
}

// Keyed on materialId, NEVER on list index. The index moves the moment the
// filter changes, so an open card would silently become a different material's.
function toggleStockCard(matId) {
    stockOpenId = (stockOpenId === matId) ? null : matId;
    renderStockInList();
}

function onStockLotChange(matId) {
    var sel = document.getElementById('si-lot-' + matId);
    var numWrap = document.getElementById('si-num-wrap-' + matId);
    var labWrap = document.getElementById('si-label-wrap-' + matId);
    if (!sel) return;
    // Number and label only mean anything on a lot being CREATED. Topping up an
    // existing lot must not offer to renumber or rename it from a screen that is
    // about incoming cloth — that is a different action with different rules.
    var creating = sel.value === '';
    if (numWrap) numWrap.style.display = creating ? '' : 'none';
    if (labWrap) labWrap.style.display = creating ? '' : 'none';
}

function stockInListHtml() {
    var list = stockInMatches();
    if (list.length === 0) {
        return '<div class="waste-none">No fabric matches that search.</div>';
    }

    return list.map(function (m) {
        var open = stockOpenId === m.materialId;

        // Only shown once the sync exists — cloth Inventory knows about that has
        // not been given a tone yet. Until then it is always zero.
        var unalloc = m.unallocated > 0
            ? '<span class="status-pill status-warning">' + fmt(m.unallocated) + ' awaiting a lot</span>'
            : '';

        return '' +
            '<div class="item-card' + (open ? ' open' : '') + '">' +
                '<div class="item-header" onclick="toggleStockCard(\'' + m.materialId + '\')">' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(m.material || m.sku || '—') + '</h2>' +
                        '<div class="item-meta-line">' +
                            '<span>' + escapeHtml(m.sku || '') + '</span>' +
                            '<span>' + m.lotCount + (m.lotCount === 1 ? ' lot' : ' lots') + '</span>' +
                            '<span>' + fmt(m.wash) + ' washed &middot; ' + fmt(m.unwash) + ' unwashed</span>' +
                            unalloc +
                        '</div>' +
                    '</div>' +
                '</div>' +
                (open ? stockCardBodyHtml(m) : '') +
            '</div>';
    }).join('');
}

function stockCardBodyHtml(m) {
    var lots = m.lots || [];

    var rows = lots.map(function (l) {
        return '' +
            '<tr>' +
                '<td class="material-name-cell">' +
                    '<div class="mat-name">' + escapeHtml(l.lotNumber) + '</div>' +
                    (l.label ? '<div class="mat-sku">' + escapeHtml(l.label) + '</div>' : '') +
                '</td>' +
                '<td class="col-num">' + fmt(l.wash) + '</td>' +
                '<td class="col-num">' + fmt(l.unwash) + '</td>' +
                '<td class="col-num">' + fmt(l.inTransit) + '</td>' +
                '<td class="col-num">' + fmt(l.disputed) + '</td>' +
                '<td>' + (l.status === 'Blocked'
                    ? '<span class="status-pill status-danger">Blocked</span>'
                    : '<span class="status-pill status-sufficient">Active</span>') + '</td>' +
            '</tr>';
    }).join('');

    var lotTable = lots.length === 0
        ? '<div class="waste-none">No lots yet &mdash; the first booking creates one.</div>'
        : '<div class="table-wrapper"><table>' +
              '<thead><tr>' +
                  '<th>Lot</th>' +
                  '<th class="col-num">Washed</th>' +
                  '<th class="col-num">Unwashed</th>' +
                  '<th class="col-num">In transit</th>' +
                  '<th class="col-num">Disputed</th>' +
                  '<th>Status</th>' +
              '</tr></thead>' +
              '<tbody>' + rows + '</tbody></table></div>';

    // A blocked lot is quarantined — it must not be offered somewhere it could
    // quietly grow. saveStockInward refuses one anyway; this keeps the screen
    // and the server saying the same thing.
    var opts = '<option value="">+ New lot</option>' +
        lots.filter(function (l) { return l.status !== 'Blocked'; })
            .map(function (l) {
                return '<option value="' + l.lotId + '">' + escapeHtml(l.lotNumber) +
                    (l.label ? ' &mdash; ' + escapeHtml(l.label) : '') + '</option>';
            }).join('');

    return '' +
        '<div class="item-body is-open">' +
            lotTable +
            '<div class="stockin-form">' +
                '<label class="si-field"><span>Lot</span>' +
                    '<select id="si-lot-' + m.materialId + '" class="note-input" ' +
                        'onchange="onStockLotChange(\'' + m.materialId + '\')">' + opts + '</select>' +
                '</label>' +
                '<label class="si-field" id="si-num-wrap-' + m.materialId + '"><span>Lot number</span>' +
                    '<input type="text" id="si-num-' + m.materialId + '" class="note-input" ' +
                        'placeholder="as written on the roll" />' +
                '</label>' +
                '<label class="si-field" id="si-label-wrap-' + m.materialId + '"><span>Label</span>' +
                    '<input type="text" id="si-label-' + m.materialId + '" class="note-input" ' +
                        'placeholder="e.g. slightly darker" />' +
                '</label>' +
                '<label class="si-field"><span>Quantity</span>' +
                    '<input type="number" step="0.01" min="0" id="si-qty-' + m.materialId + '" class="issue-input" />' +
                '</label>' +
                '<label class="si-field"><span>State</span>' +
                    '<select id="si-state-' + m.materialId + '" class="note-input">' +
                        '<option value="Unwash">Unwashed</option>' +
                        '<option value="Wash">Washed</option>' +
                    '</select>' +
                '</label>' +
            '</div>' +
            '<div class="card-footer">' +
                '<span class="sel-count">Match it against the rack first &mdash; a new lot cannot be merged back later.</span>' +
                '<button type="button" class="primary-btn" id="si-btn-' + m.materialId + '" ' +
                    'onclick="submitStockIn(\'' + m.materialId + '\')">Add to stock</button>' +
            '</div>' +
        '</div>';
}

function submitStockIn(matId) {
    var lotSel = document.getElementById('si-lot-' + matId);
    var numEl = document.getElementById('si-num-' + matId);
    var labelEl = document.getElementById('si-label-' + matId);
    var qtyEl = document.getElementById('si-qty-' + matId);
    var stateEl = document.getElementById('si-state-' + matId);
    var btn = document.getElementById('si-btn-' + matId);
    if (!qtyEl || !btn) return;

    var creating = !lotSel || lotSel.value === '';
    var lotNum = numEl ? numEl.value.trim() : '';

    if (creating && lotNum === '') {
        alert('Give the new lot a number — whatever is written on the roll.');
        return;
    }

    // Checked here as well as on the server. The server is the one that counts —
    // a Custom API is callable from anywhere — but a collision caught before the
    // round trip tells him while he is still looking at the list of lots it
    // clashed with. Upper-cased, so "l1" cannot slip in beside "L1".
    if (creating) {
        var mat = null;
        stockMats.forEach(function (x) { if (x.materialId === matId) mat = x; });
        var taken = (mat && mat.lots || []).some(function (l) {
            return String(l.lotNumber || '').trim().toUpperCase() === lotNum.toUpperCase();
        });
        if (taken) {
            alert('This material already has a lot ' + lotNum + '.');
            return;
        }
    }

    var qty = parseFloat(qtyEl.value);
    if (isNaN(qty) || qty <= 0) {
        alert('Enter how much has arrived.');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'saveStockInward',
        http_method: 'POST',
        payload: {
            inwardJson: JSON.stringify({
                materialId: matId,
                lotId: lotSel ? lotSel.value : '',
                lotNumber: lotNum,
                lotLabel: labelEl ? labelEl.value : '',
                qty: qty,
                state: stateEl ? stateEl.value : 'Unwash',
                remarks: ''
            })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            parsed = null;
        }

        if (!parsed || !parsed.success) {
            alert('Could not book the stock: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
            btn.textContent = 'Add to stock';
            return;
        }

        // Refetched rather than patched by hand. The lot balance, the parent
        // total and the unallocated figure all moved, and a card patched from
        // the response would be a second opinion about stock — which is exactly
        // what this design exists to avoid having.
        loadStockIn();
    }).catch(function (err) {
        console.error('saveStockInward error:', err);
        alert('Failed to book the stock. Check the browser console.');
        btn.disabled = false;
        btn.textContent = 'Add to stock';
    });
}

document.getElementById('refresh-btn').addEventListener('click', function () {
    // Issue is the home tab - loaded on arrival, so it has no TAB_LOADERS entry
    // and has to be named. Counts belong to no tab at all.
    loadRequirements();
    loadCounts();
    // Anything already open re-fetches; anything not yet opened stays lazy.
    //
    // Looped over TAB_LOADERS rather than listed by hand. The list this replaced
    // was complete, but only because someone remembered it five times running -
    // a tab added without a line here would silently stop refreshing, which is
    // exactly how the supervisor widget's Refresh came to do nothing at all.
    Object.keys(tabsLoaded).forEach(function (name) {
        if (tabsLoaded[name] && TAB_LOADERS[name]) {
            TAB_LOADERS[name]();
        }
    });
});
setTodayLabel();
loadRequirements();
loadCounts();
