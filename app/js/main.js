function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function fmt(n) {
    n = Number(n) || 0;
    return (Math.round(n * 100) / 100).toLocaleString();
}

// Number + muted unit suffix. Zero values are de-emphasised so the eye lands
// on the rows that actually need something.
function qty(n, unit, opts) {
    var isZero = (Number(n) || 0) === 0;
    var cls = isZero && !(opts && opts.keepZero) ? ' class="is-zero"' : '';
    return '<span' + cls + '>' + fmt(n) + '<span class="unit">' + escapeHtml(unit) + '</span></span>';
}

// WHAT CAN ACTUALLY BE HANDED OVER — which for fabric is not what is on the shelf.
//
// Cloth leaves only in whole marker rows off ONE lot, so a material holding
// twenty metres as short ends across three lots can yield nothing at all. The
// allocator has already worked that out lot by lot; this is its total, and it is
// the only figure a pill or a checkbox may be decided on.
//
// `remaining` is the FRESH metres still wanted after offcuts are credited, and
// `lotLines` are the fresh metres allocated, so the two compare like with like.
//
// Non-fabric has no lots and no rows: the shelf figure is the whole answer. So
// is a fabric row the allocator has not reached yet.
function issuableTotal(material) {
    if (!material.isFabric || !material.lotLines) {
        return round2(Math.max(0, Number(material.availableStock) || 0));
    }
    var t = 0;
    material.lotLines.forEach(function (ln) { t += Number(ln.qty) || 0; });
    return round2(t);
}

function stockStatus(material) {
    // NOT availableStock. Judged on the shelf total, this said "In stock" over a
    // row that could not be issued at all, and the card header above it said
    // "All in stock" while every row under it sat at zero.
    var have = issuableTotal(material);
    if (have >= material.remaining) {
        return { cls: 'status-sufficient', label: 'In stock' };
    }
    if (have > 0) {
        return { cls: 'status-partial', label: 'Partial' };
    }
    // Cloth on the rack that cannot yield a single piece of this cut. "No stock"
    // is a lie he disproves by turning round and looking at it, and a store
    // person who catches the screen lying once stops believing the rest of it.
    if (material.isFabric && (Number(material.availableStock) || 0) > 0) {
        return { cls: 'status-shortfall', label: 'Cannot cut' };
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

// WHETHER THE CHECKBOX TICKS for this pick, derived — never hardcoded. A
// declined remnant must render UNTICKED: the tick IS the feedback for the
// decline, and a box that stays ticked over a 0-pcs input contradicts the
// state the allocator is acting on.
function wasteCheckedFor(pick) {
    var cap = wasteDeclined[String(pick.wasteId)];
    return cap === undefined || cap > 0;
}

// WHAT THE RACK HOLDS for this remnant — the full figure from wasteStock, not
// the pick's post-allocation count. The pcs input clamps against THIS: a
// declined pick carries 0, and clamping typed values against 0 makes the box
// unusable exactly when he is trying to bring pieces back.
function rackCountFor(m, pick) {
    var r = (m.wasteStock || []).filter(function (x) {
        return String(x.wasteId) === String(pick.wasteId);
    })[0];
    return r ? (Number(r.pieces) || 0) : (Number(pick.pieces) || 0);
}

// ---- Lots ----
//
// THE ALLOCATOR LIVES IN app/js/lot-allocator.js AND NOWHERE ELSE.
//
// A copy of it used to sit here too. widget.html loads lot-allocator.js first
// and this file second, and function declarations hoist - so the copy in THIS
// file silently won, and every edit to the extracted one changed nothing on the
// store screen while the admin audit, which has no duplicate, ran the other.
// Two pages, two allocators, which is the exact failure the extraction was done
// to prevent.
//
// It was harmless only by luck: the two were the same code reflowed by a
// formatter, differing in one block (the per-order `outcomes` the audit reads).
// Verified identical on a payload exercising pins, blocked lots, the order
// atom, skip-don't-block and the per-card ledger before the copy was removed.
//
// What stays here is the UI half - the override DIALOG below - because that is
// this screen's, not the allocator's. lotOverrides and wasteDeclined are
// declared in lot-allocator.js and written from here on purpose: the allocation
// has to see what he has just declined or overridden.
function openLotOverride(supIdx, matIdx) {
    var sup = window.__reqData && window.__reqData[supIdx];
    if (!sup) return;
    var m = sup.materials[matIdx];
    if (!m || !m.pinnedDry) return;

    // Anything with cloth on it, greige behind it or cloth at the washer, and not
    // quarantined. The dry lot itself is not on the list — that is the whole
    // reason he is here.
    var opts = usableLots(m).filter(function (l) {
        return String(l.lotNumber) !== String(m.pinnedDry);
    });

    var el = exceptionModalEl();
    el.classList.remove('hidden');

    if (opts.length === 0) {
        el.innerHTML =
            '<div class="exc-panel">' +
            '<h3>No other lot to use</h3>' +
            '<p class="exc-sub">' + escapeHtml(m.material) + '</p>' +
            '<div class="exc-nolot">Nothing else of this fabric has stock or ' +
            'greige. This one has to be bought before the order can finish.</div>' +
            '<div class="exc-foot">' +
            '<button type="button" class="ghost-btn" onclick="closeExceptionDialog()">Close</button>' +
            '</div>' +
            '</div>';
        return;
    }

    el.innerHTML =
        '<div class="exc-panel">' +
        '<h3>Finish this order from another lot</h3>' +
        '<p class="exc-sub">' + escapeHtml(m.material) + ' &middot; ' + escapeHtml(m.sku) + '</p>' +
        '<div class="lot-dry">' +
        ((m.pinnedDryOrders || []).length > 1
            ? 'These ' + m.pinnedDryOrders.length + ' orders were cut from <b>'
            : 'This order was cut from <b>') +
        escapeHtml(m.pinnedDry) +
        '</b>. Finishing from a different lot means the new pieces will ' +
        'not match the ones already made. Only do this if you have compared ' +
        'the cloth and accept the difference.</div>' +
        '<label class="exc-label">Which lot instead</label>' +
        '<select id="ov-lot" class="note-input">' +
        opts.map(function (l) {
            return '<option value="' + l.lotId + '">' +
                escapeHtml(l.lotNumber || '—') + ' &mdash; ' +
                fmt(l.wash) + ' ' + escapeHtml(m.unit) + ' washed' +
                ((Number(l.unwash) || 0) > 0
                    ? ', ' + fmt(l.unwash) + ' unwashed' : '') +
                '</option>';
        }).join('') +
        '</select>' +
        '<label class="exc-label">Why this is acceptable</label>' +
        '<textarea id="ov-note" rows="2" ' +
        'placeholder="e.g. checked against a finished cover, difference not visible"></textarea>' +
        '<div class="exc-lot-short" id="ov-err"></div>' +
        '<div class="exc-foot">' +
        '<button type="button" class="ghost-btn" onclick="closeExceptionDialog()">Cancel</button>' +
        '<button type="button" class="primary-btn" ' +
        'onclick="confirmLotOverride(' + supIdx + ',' + matIdx + ')">' +
        'Use this lot</button>' +
        '</div>' +
        '</div>';
}

function confirmLotOverride(supIdx, matIdx) {
    var sup = window.__reqData && window.__reqData[supIdx];
    if (!sup) return;
    var m = sup.materials[matIdx];
    var sel = document.getElementById('ov-lot');
    var note = document.getElementById('ov-note');
    var err = document.getElementById('ov-err');

    var lotId = sel ? String(sel.value || '') : '';
    var why = note ? String(note.value || '').trim() : '';

    // REQUIRED. An override with no reason is indistinguishable from a mistake
    // once everyone has forgotten the week it happened.
    if (!why) {
        if (err) err.innerHTML = 'Say why the difference is acceptable &mdash; ' +
            'this is the only record of the decision.';
        if (note && note.focus) note.focus();
        return;
    }
    if (!lotId) return;

    (m.pinnedDryOrders || []).forEach(function (oid) {
        lotOverrides[overrideKey(sup.supervisorId, m.materialId, oid)] =
            { lotId: lotId, note: why };
    });

    closeExceptionDialog();
    // Re-render rather than patch this row. The override frees the dry lot's
    // claim and takes cloth off another, and every later card is measured
    // against what is left — render() re-runs both allocation passes, and they
    // read only the untouched server fields, so running them again is safe.
    render(window.__rawData || window.__reqData);
}

// ---- The allocation pass ----
//
// Runs ONCE on fetched data, before anything renders, and writes its results
// back onto the material entries. Everything downstream — the issue rows, the
// shortfall summary, the wash sizing, the payload — reads the same fields it
// always did; only where those numbers come from has changed.
//
// Supervisors are walked in CARD ORDER, which is priority order, so cloth or a
// remnant wanted by two supervisors goes to the higher-priority one and every
// later card sees what is genuinely left. That contention rule used to live in
// getStoreMaterialRequirements. It moved here with the allocation itself,
// because whether a remnant is usable depends on which lot the fresh cloth is
// coming off, and only this side knows that.

// One row's share of it. The allocation is no longer a suggestion he edits — it
// is computed, because every figure it produces is a whole number of rows and a
// hand-typed one is not.
function recommendLots(m, supIdx, matIdx) {
    // Decided in applyLotAllocation, per ORDER, with that order's own remnants
    // counted as part of the lot. Summed to lot-index here because that is what
    // the row's table and its hidden inputs are keyed on; the per-item split
    // travels separately in `lotLines` so the server never has to guess it.
    var lots = lotsFor(m);
    var out = {};
    (m.lotLines || []).forEach(function (ln) {
        var idx = -1;
        lots.forEach(function (l, i) { if (String(l.lotId) === String(ln.lotId)) idx = i; });
        if (idx < 0) return;
        out[idx] = round2((out[idx] || 0) + (Number(ln.qty) || 0));
    });
    return out;
}


function lotInputId(supIdx, matIdx, lotIdx) {
    return 'lot-input-' + supIdx + '-' + matIdx + '-' + lotIdx;
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

// WHERE A SUGGESTED OFFCUT PHYSICALLY IS: its carton, and the lot it was cut
// from. One line under the piece, on the issue screen and on the waste rows.
//
// The carton is the actionable half — it is the box he walks to. The lot is what
// tells two identically-sized remnants apart when they are different tones.
//
// A piece booked in before the carton field existed has none, and says so rather
// than showing a blank: "not recorded" is a fact he can act on, an empty space
// looks like a rendering fault.
function wasteWhereHtml(p) {
    var bits = [];
    if (p.lot) bits.push('Lot <b>' + escapeHtml(p.lot) + '</b>');
    if (p.carton) {
        bits.push('Carton <b>' + escapeHtml(p.carton) + '</b>');
    } else {
        bits.push('<span class="waste-nocarton">Carton not recorded</span>');
    }
    return '<div class="qty-sub waste-where">' + bits.join(' &middot; ') + '</div>';
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
        //
        // For fabric that is what the LOTS grant, which is not the same number:
        // suggestedIssue is capped by the material's whole washed stock, while
        // the row can only have what its own lot can give. Re-ticking a row
        // pinned to a small lot would otherwise put a figure in the box that no
        // lot line backs, and the two would disagree at submit time.
        input.value = material.isFabric
            ? recommendedTotal(material, supIdx, matIdx)
            : suggestedIssue(material);
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
    var m = window.__reqData[supIdx].materials[matIdx];
    var pick = m.wastePicks[pickIdx];
    // STATE, not just paint — the master checkbox reaches this path too, and a
    // decline that lives only in the DOM would be lost on the next render.
    if (checked) delete wasteDeclined[String(pick.wasteId)];
    else wasteDeclined[String(pick.wasteId)] = 0;
    checkbox.checked = checked;
    input.value = checked ? pick.pieces : 0;
    var row = document.getElementById(wasteRowId(supIdx, matIdx, pickIdx));
    if (row) row.classList.toggle('row-selected', checked);
}

function onWasteCheckboxChange(supIdx, matIdx, pickIdx) {
    var on = document.getElementById(wasteCheckboxId(supIdx, matIdx, pickIdx)).checked;
    setWasteChecked(supIdx, matIdx, pickIdx, on);

    // RE-ALLOCATE, do not just repaint. Fresh metres are sized from the pieces
    // offcuts do not cover, so a declined remnant changes how much cloth this
    // row needs — leaving the old figure sends cloth for fewer pieces than the
    // order wants and nothing says so.
    var m = window.__reqData[supIdx].materials[matIdx];
    var pick = wastePicks(m)[pickIdx];
    if (pick) {
        if (on) delete wasteDeclined[String(pick.wasteId)];
        else wasteDeclined[String(pick.wasteId)] = 0;
        render(window.__rawData || window.__reqData);
        return;
    }
    refreshCardState(supIdx);
}

function onWasteInputChange(supIdx, matIdx, pickIdx) {
    var m = window.__reqData[supIdx].materials[matIdx];
    var input = document.getElementById(wasteInputId(supIdx, matIdx, pickIdx));
    var checkbox = document.getElementById(wasteCheckboxId(supIdx, matIdx, pickIdx));
    var pick = m.wastePicks[pickIdx];
    var rack = rackCountFor(m, pick);
    var val = parseInt(input.value, 10);

    // Pieces are whole things — you cannot hand over 1.5 of a cut piece.
    // Clamped against the RACK, never against pick.pieces: a declined pick
    // carries 0, and clamping against it made the box refuse every keystroke.
    if (isNaN(val) || val < 0) val = 0;
    if (val > rack) val = rack;
    input.value = val;

    checkbox.checked = val > 0;
    var row = document.getElementById(wasteRowId(supIdx, matIdx, pickIdx));
    if (row) row.classList.toggle('row-selected', val > 0);

    // Taking FEWER pieces off a remnant is the same question as taking none:
    // the cloth has to cover what they would have. Compared against the CURRENT
    // effective take — the decline when there is one, the pick otherwise — so
    // re-typing the same figure never falls through to a silent un-decline.
    // The full rack count IS no decline: same thing wasteAllowed does.
    var currentTake = wasteDeclined[String(pick.wasteId)] !== undefined
        ? wasteDeclined[String(pick.wasteId)] : pick.pieces;
    if (val !== currentTake) {
        if (val >= rack) delete wasteDeclined[String(pick.wasteId)];
        else wasteDeclined[String(pick.wasteId)] = val;
        render(window.__rawData || window.__reqData);
        return;
    }
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
    // The sweep above changed DECLINES, and declines re-size the fresh metres.
    // A full re-render, same as the single-checkbox path — refreshCardState
    // alone would leave the metres box holding a figure the offcuts no longer
    // cover.
    render(window.__rawData || window.__reqData);
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

// CAN THIS FABRIC ROW BE COUNTED IN PIECES AT ALL?
//
// THE FOURTH COPY OF ONE TEST, and the three that already existed all agree:
// getStoreMaterialRequirements (`canCount`), issueMaterials (`canPiece`) and
// applyLotAllocation all ask for a piece count, a cut length and a cut that fits
// across the cloth — and all three fall back to the METRES balance when they
// cannot get one. A row planned before Required_Pieces existed, a cut wider than
// the cloth, or a fabric whose width was never recorded.
//
// applyLotAllocation has already decided this and left the answer on the row, so
// prefer its flag. The recompute is for callers that run before allocation.
function isPieceTracked(m) {
    if (!m.isFabric) return false;
    if (m.noPieceData === true) return false;
    if (m.noPieceData === false) return true;
    var width = Number(m.fabricWidthCm) || 0;
    var cutW = Number(m.cutWidth) || 0;
    var perRow = (width > 0 && cutW > 0) ? Math.floor(width / cutW) : 0;
    return (Number(m.requiredPieces) || 0) > 0 && perRow > 0 && (Number(m.cutLength) || 0) > 0;
}

// A row is done when nothing is left to issue against it. Fully-issued rows
// become a read-only receipt instead of a dead, disabled input.
//
// Fabric is judged on PIECES, not metres. `remaining` carries the waste-adjusted
// metres, so a requirement fully covered by waste sits at 0 metres from the
// start — judging on metres would mark it issued before anything was handed out.
//
// UNLESS THE ROW HAS NO PIECES TO JUDGE ON, and that was a real bug: the test
// was `m.requiredPieces !== undefined`, which is true of EVERY fabric row
// because the server always sends the field. So the pieces branch always won and
// the metres line below was unreachable for fabric — while issueMaterials, for
// exactly these rows, advances Issued_Qty and leaves Pieces_From_Raw at 0
// because it has nothing to count with. issuedPieces could never reach
// requiredPieces, the row could never be settled, and the Issue badge kept
// counting it after the cloth had gone out. It only dropped later, when the
// supervisor received and the plan left this screen's query at Material Ready —
// which read as the count waiting on receipt.
//
// The metres side uses requiredTotal, not required. For fabric the server
// overwrites `required` with the OUTSTANDING fresh metres, so a settled row
// carries required = 0 and `required > 0` would reject the very rows this
// branch exists to catch. requiredTotal is the plan's Required_Qty and is sent
// for fabric only; non-fabric keeps using `required`, which is its real total.
function isFullyIssued(m) {
    if (m.isFabric && isPieceTracked(m)) {
        return m.requiredPieces > 0 && (Number(m.issuedPieces) || 0) >= m.requiredPieces;
    }
    var reqTotal = Number(m.requiredTotal !== undefined ? m.requiredTotal : m.required) || 0;
    return reqTotal > 0 && (Number(m.remaining) || 0) <= 0.0001;
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

function progressModalEl() {
    var el = document.getElementById('progress-modal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'progress-modal';
        el.className = 'exc-modal hidden';
        el.innerHTML = '<div class="exc-panel" style="max-width: 380px; text-align: center;">' +
            '<h3 id="progress-modal-title" style="margin-bottom: 0.5rem;">Issuing Materials...</h3>' +
            '<div class="progress-text" id="progress-modal-text">0 of 0 batches</div>' +
            '<div class="progress-container"><div class="progress-bar" id="progress-modal-bar"></div></div>' +
            '</div>';
        document.body.appendChild(el);
    }
    return el;
}

function showProgressModal(title, text, percentage) {
    var el = progressModalEl();
    document.getElementById('progress-modal-title').textContent = title;
    document.getElementById('progress-modal-text').textContent = text;
    document.getElementById('progress-modal-bar').style.width = percentage + '%';
    el.classList.remove('hidden');
}

function closeProgressModal() {
    progressModalEl().classList.add('hidden');
}

// ---- Vendor Modal for Bulk PO ----

function vendorModalEl() {
    var el = document.getElementById('vendor-modal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'vendor-modal';
        el.className = 'exc-modal hidden';
        el.innerHTML =
            '<div class="exc-panel">' +
                '<h3 id="vendor-modal-title">Raise purchase order</h3>' +
                '<p class="exc-sub">A draft PO is created in Zoho Inventory for the quantities below. ' +
                    'Each material is also logged as a shortage so it drops off this list until the goods arrive.</p>' +
                '<label class="exc-label" for="vendor-select">Vendor</label>' +
                '<p id="vendor-modal-text" class="exc-sub">Fetching vendors from Zoho Inventory…</p>' +
                '<select id="vendor-select"></select>' +
                '<label class="exc-label">Ordering</label>' +
                '<div class="table-wrapper po-preview-wrap">' +
                    '<table class="po-preview-table">' +
                        '<thead><tr>' +
                            '<th>Material</th>' +
                            '<th class="col-num">Order qty</th>' +
                        '</tr></thead>' +
                        '<tbody id="vendor-po-lines"></tbody>' +
                    '</table>' +
                '</div>' +
                '<div class="exc-foot">' +
                    '<button type="button" class="ghost-btn" onclick="closeVendorModal()">Cancel</button>' +
                    '<button type="button" class="primary-btn" id="vendor-submit-btn" disabled onclick="submitBulkPO()">Raise PO</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(el);
    }
    return el;
}

// The line items about to be ordered, drawn from the same s.toBuy the submit
// reads. Shown so the store person confirms WHAT and HOW MUCH before a draft PO
// is committed against a real vendor. No rate/cost column — the store screen
// carries no catalogue rate; raiseBulkPurchaseOrder fills it from Raw_Material.
function renderVendorPoLines() {
    var body = document.getElementById('vendor-po-lines');
    var title = document.getElementById('vendor-modal-title');
    if (!body) return;
    var s = window.__summary || { toBuy: [] };
    var rows = s.toBuy || [];

    if (title) {
        title.textContent = 'Raise purchase order' +
            (rows.length ? ' · ' + rows.length + ' item' + (rows.length === 1 ? '' : 's') : '');
    }

    body.innerHTML = rows.map(function (item) {
        var e = item.e;
        return '<tr>' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(e.material) + '</div>' +
                (e.sku ? '<div class="mat-sku">' + escapeHtml(e.sku) + '</div>' : '') +
            '</td>' +
            '<td class="col-num col-strong">' + fmt(item.qty) +
                ' <span class="unit">' + escapeHtml(e.unit || '') + '</span></td>' +
        '</tr>';
    }).join('');
}

function closeVendorModal() {
    vendorModalEl().classList.add('hidden');
}

function openVendorModal() {
    var el = vendorModalEl();
    var select = document.getElementById('vendor-select');
    var p = document.getElementById('vendor-modal-text');
    var btn = document.getElementById('vendor-submit-btn');

    renderVendorPoLines();

    select.style.display = 'none';
    btn.disabled = true;
    p.textContent = 'Fetching vendors from Zoho Inventory…';
    p.style.display = 'block';
    el.classList.remove('hidden');

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getInventoryVendors',
        http_method: 'GET'
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch(e) {}
        if (parsed && (!parsed.errors || parsed.errors.length === 0) && parsed.vendors) {
            select.innerHTML = '';
            var hasVendors = false;
            parsed.vendors.forEach(function(v) {
                if (v.type === 'Job Work') {
                    var opt = document.createElement('option');
                    opt.value = v.vendor_id;
                    opt.textContent = v.vendor_name;
                    select.appendChild(opt);
                    hasVendors = true;
                }
            });

            if (hasVendors) {
                p.style.display = 'none';
                select.style.display = 'block';
                btn.disabled = false;
            } else {
                p.textContent = 'No "Job Work" vendors found in Inventory.';
            }
        } else {
            p.textContent = 'Failed to load vendors: ' + (parsed && parsed.errors ? parsed.errors.join(', ') : 'Unknown error');
        }
    }).catch(function(err) {
        p.textContent = 'Network error fetching vendors.';
    });
}

function submitBulkPO() {
    var vendorId = document.getElementById('vendor-select').value;
    if (!vendorId) return;

    closeVendorModal();
    if (typeof showProgressModal === 'function') {
        showProgressModal('Creating Purchase Order', 'Connecting to Zoho Inventory...', 50);
    }

    // Lock the summary's Raise buttons for the duration - the PO covers every
    // row in it, so a second click while this is in flight would double-order.
    Array.prototype.forEach.call(
        document.querySelectorAll('#sum-raise-all-po, .summary-card .raise-btn'),
        function (b) { b.disabled = true; }
    );

    var s = window.__summary || { toBuy: [] };
    var payload = s.toBuy.map(function(item) {
        // NO per-order lines. A common trim is on dozens of open plans, so
        // item.e.lines has dozens/hundreds of entries — and a PO is not split
        // per order anyway, so they only made the "N orders waiting" figure on
        // the My requests tab read as "212". The exception still records
        // Required_Qty / Shortfall_Qty / PO_Number, which is what procurement
        // acts on. No rate: this screen has none, so raiseBulkPurchaseOrder
        // falls back to the catalogue Rate; the third-party / print screens
        // pass a UI rate here instead.
        return {
            materialId: item.e.materialId,
            quantity: item.qty
        };
    });

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'raiseBulkPurchaseOrder',
        http_method: 'POST',
        payload: {
            vendorId: vendorId,
            shortItemsJsonTxt: JSON.stringify(payload)
        }
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch(e) {}
        
        if (typeof closeProgressModal === 'function') closeProgressModal();
        
        if (parsed && (!parsed.errors || parsed.errors.length === 0) && parsed.purchaseorder_number) {
            var msg = 'Draft PO ' + parsed.purchaseorder_number + ' created in Zoho Inventory.';
            if (Number(parsed.exceptionsFailed) > 0) {
                msg += '\n\n' + parsed.exceptionsFailed + ' material(s) could not be logged as a shortage — ' +
                    'they may reappear in this list. Check the console.';
            } else {
                msg += '\nThese materials will drop off "What is missing" until the goods arrive.';
            }
            alert(msg);
            // Reload the Issue tab so the raised materials drop off "What is
            // missing" (the server now nets their PO qty into `owned`). This
            // was calling a non-existent fetchWidgetData(), so the stale
            // section stayed on screen with live buttons until a manual Refresh.
            loadRequirements();
        } else {
            var errStr = parsed && parsed.errors ? parsed.errors.join(', ') : 'Unknown error';
            alert('Failed to create PO: ' + errStr);
            // Re-enable the buttons - the PO did not go through, so the rows
            // are still actionable.
            Array.prototype.forEach.call(
                document.querySelectorAll('#sum-raise-all-po, .summary-card .raise-btn'),
                function (b) { b.disabled = false; }
            );
        }
    }).catch(function(err) {
        if (typeof closeProgressModal === 'function') closeProgressModal();
        Array.prototype.forEach.call(
            document.querySelectorAll('#sum-raise-all-po, .summary-card .raise-btn'),
            function (b) { b.disabled = false; }
        );
        alert('Network error creating PO.');
    });
}


// ---- Raising the combined request from the summary ----

function summaryEntry(kind, idx) {
    var s = window.__summary || { toWash: [], toBuy: [] };
    return (kind === 'wash' ? s.toWash : s.toBuy)[idx];
}

// WHICH LOT'S GREIGE GOES TO THE WASH.
//
// Washing does not change the lot — it converts that lot's unwashed cloth into
// that lot's washed cloth. So the ticket has to name one, and the choice is
// worth making well rather than taking whatever comes first.
//
// PREFER A LOT THAT ALREADY HAS WASHED CLOTH. Washing its greige adds to a tone
// that is already on the shelf, so washed stock GATHERS in one lot instead of
// spreading thin across several — and thin-spread washed stock is precisely what
// forces an order to be split across two tones later. Washing the wrong lot
// today is what creates the split next week.
//
// Failing that, the lot with the most greige, so the wash is one trip.
//
// COVERING THE WHOLE NEED COMES FIRST though. A lot that already has washed
// cloth but not enough greige leaves the order still short after the wash — one
// wash that finishes the job beats a tidier tone that does not. So the order is:
//   1. enough greige AND already has washed cloth
//   2. enough greige
//   3. most greige, washed cloth as the tie-break
// A PRINTED LOT CANNOT BE WASHED YET, so it is never a candidate.
//
// Its metres are the maintained sum of its Fabric_Piece rows, and a wash request
// moves a metres figure between two columns on the header without touching a
// single piece — so washing one leaves the header claiming washed metres while
// every piece behind it still says Unwash. The allocator reads the pieces and
// takes only State === 'Wash', and lotFill zeroes a Pieces lot's metres budget,
// so the cloth ends up real, on the rack, and permanently unissuable.
//
// The allocator already excludes greige pieces from the after-washing simulation
// for exactly this reason (see lotPieces), so a Pieces lot never reaches
// `washLots`. This picker read `e.lots` directly instead — every lot the server
// sent — which is how a printed one could still be chosen by hand.
//
// Refused here AND in raiseMaterialException. This is the courtesy; that is the
// guard.
function washableLots(e) {
    // Blocked lots excluded too: washing quarantined greige converts it into
    // quarantined washed cloth, which still cannot be issued. The wash team would
    // do the work for nothing.
    return (e.lots || []).filter(function (l) {
        return !l.blocked && l.form !== 'Pieces' && (Number(l.unwash) || 0) > 0;
    });
}

function recommendWashLot(e, need) {
    var lots = washableLots(e);
    if (lots.length === 0) return null;

    var want = Number(need) || 0;
    var score = function (l) {
        var covers = (Number(l.unwash) || 0) + 0.0001 >= want;
        var hasWash = (Number(l.wash) || 0) > 0;
        if (covers && hasWash) return 3;
        if (covers) return 2;
        if (hasWash) return 1;
        return 0;
    };

    var best = null;
    lots.forEach(function (l) {
        if (best === null) { best = l; return; }
        var a = score(l), b = score(best);
        if (a !== b) {
            if (a > b) best = l;
            return;
        }
        if ((Number(l.unwash) || 0) > (Number(best.unwash) || 0)) best = l;
    });
    return best;
}

function washLotPickerHtml(e, entry) {
    var lots = washableLots(e);
    if (lots.length === 0) {
        // A material whose only greige is PRINTED pieces reads as "unwashed
        // stock exists" everywhere else on this card, because the parent's
        // Unwash_Quantity includes it. Saying "buy more" there would be wrong
        // and he would go and buy it, so the two cases are named apart.
        var greigePieces = (e.lots || []).some(function (l) {
            return l.form === 'Pieces' && (Number(l.unwash) || 0) > 0;
        });
        if (greigePieces) {
            return '<div class="exc-nolot">The only unwashed cloth here is ' +
                '<b>printed, held as pieces</b>, and washing pieces is not built ' +
                'yet &mdash; a wash ticket moves metres, not pieces. Nothing to ' +
                'send from this screen.</div>';
        }
        return '<div class="exc-nolot">No lot has unwashed cloth &mdash; there is ' +
            'nothing to send. This one needs buying, not washing.</div>';
    }

    // The same lot the row chose, so the dialog cannot disagree with the table
    // he pressed the button on.
    var rec = (entry && entry.lot) ? entry.lot : recommendWashLot(e, entry ? entry.qty : 0);
    var recId = rec ? String(rec.lotId) : '';

    // Greige per lot, keyed by id, so the change handler can answer "can this one
    // actually give what the ticket asks for" without re-deriving the summary.
    window.__excLots = {};
    lots.forEach(function (l) {
        window.__excLots[String(l.lotId)] = Number(l.unwash) || 0;
    });

    var opts = lots.map(function (l) {
        var wash = Number(l.wash) || 0;
        return '<option value="' + l.lotId + '"' +
            (String(l.lotId) === recId ? ' selected' : '') + '>' +
            escapeHtml(l.lotNumber || '—') + ' — ' + fmt(l.unwash) + ' ' +
            escapeHtml(e.unit) + ' unwashed' +
            (wash > 0 ? ', ' + fmt(wash) + ' already washed' : '') +
            '</option>';
    }).join('');

    return '' +
        '<label class="exc-label">Which lot goes to the wash</label>' +
        '<select id="exc-lot" class="note-input" onchange="onWashLotChange(' +
        (Number(entry && entry.qty) || 0) + ')">' + opts + '</select>' +
        '<div class="exc-lot-short" id="exc-lot-short"></div>' +
        (lots.length > 1 && rec && (Number(rec.wash) || 0) > 0
            ? '<div class="exc-lot-why">Suggested because this lot already has washed ' +
            'cloth &mdash; washing it keeps the tone together instead of spreading ' +
            'washed stock across lots.</div>'
            : '');
}

// A LOT THAT CANNOT GIVE WHAT THE TICKET ASKS FOR.
//
// raiseMaterialException caps the wash at the chosen lot's greige and says
// nothing, so overriding to a smaller lot quietly turns a 116.45 ticket into a
// 15.69 one — and the store then waits on metres that were never coming. Washing
// more than needed only parks cloth; washing less cannot be recovered from, so
// it is the direction worth warning about.
//
// Warned, not blocked: he can see the rack and may have a reason.
function onWashLotChange(want) {
    var box = document.getElementById('exc-lot-short');
    if (!box) return;
    var sel = document.getElementById('exc-lot');
    if (!sel) { box.innerHTML = ''; return; }

    var entry = window.__excLots || {};
    var have = Number(entry[String(sel.value)]);
    if (!(have >= 0) || !(want > 0) || have + 0.0001 >= want) {
        box.innerHTML = '';
        return;
    }
    box.innerHTML = '&#9888; This lot only has <b>' + fmt(have) +
        '</b> unwashed, so only that much will be washed &mdash; not the ' +
        fmt(want) + ' asked for. The rest stays short.';
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
    // ONE ROW PER SUPERVISOR, summed.
    //
    // The server sends one line per Material_Requirement ROW, so a supervisor
    // with three orders for the same fabric arrived as three lines — and since
    // this table showed only his name and the item, and two orders for the same
    // product carry the same item name, they rendered as identical rows that
    // looked like a duplication bug. They were not: Suraj's 20.55 + 20.55 + 13.7
    // is the 54.8 on his card.
    //
    // Summed rather than labelled with the order, because the store person deals
    // in supervisor requirements — he hands cloth to a person, not to an order,
    // and the order number is not a thing he can act on here.
    var bySupName = {};
    var supSeq = [];
    (e.lines || []).forEach(function (l) {
        var who = l.supervisor || '—';
        if (!bySupName[who]) {
            bySupName[who] = { req: 0, iss: 0, remake: false };
            supSeq.push(who);
        }
        bySupName[who].req += Number(l.required) || 0;
        bySupName[who].iss += Number(l.issued) || 0;
        // Kept because it changes what the request MEANS — cloth to replace
        // work already ruined, not cloth for a new order.
        if (l.isRemake) bySupName[who].remake = true;
    });

    var lineRows = supSeq.map(function (who) {
        var agg = bySupName[who];
        var req = round2(agg.req);
        var iss = round2(agg.iss);
        var out = Math.max(0, round2(req - iss));
        return '<tr' + (out === 0 ? ' class="is-settled"' : '') + '>' +
            '<td>' +
            '<div class="exc-who">' + escapeHtml(who) +
            (agg.remake
                ? ' <span class="exc-remake">incl. QC remake</span>'
                : '') +
            '</div>' +
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
        // Said out loud, because the figure is deliberately MORE than the
        // shortfall and would otherwise read as an arithmetic fault.
        (isWash && entry.qty > round2(e.needed - e.stock) + 0.0001
            ? '<div class="exc-why-more">Washing the whole requirement, not just the ' +
            fmt(round2(e.needed - e.stock)) + ' ' + escapeHtml(e.unit) +
            ' short, so it can all be issued off one lot &mdash; one tone. ' +
            'The washed stock on the other lots keeps for a later order.</div>'
            : '') +
        '<label class="exc-label">Who is waiting on it</label>' +
        '<div class="table-wrapper exc-lines">' +
        '<table><thead><tr>' +
        '<th>Supervisor</th>' +
        '<th class="col-num">Required</th>' +
        '<th class="col-num">Issued</th>' +
        '<th class="col-num">Outstanding</th>' +
        '</tr></thead><tbody>' + lineRows + '</tbody></table>' +
        '</div>' +
        // Wash only. A purchase ticket has no lot — the cloth does not
        // exist yet, so there is nothing to name.
        (isWash ? washLotPickerHtml(e, entry) : '') +
        '<label class="exc-label">Note</label>' +
        '<textarea id="exc-note" rows="2" placeholder="Anything the next person needs to know"></textarea>' +
        '<div class="exc-foot">' +
        '<button type="button" class="ghost-btn" onclick="closeExceptionDialog()">Cancel</button>' +
        '<button type="button" class="primary-btn" id="exc-send" ' +
        'onclick="submitSummaryException(\'' + kind + '\',' + idx + ')">Raise it</button>' +
        '</div>' +
        '</div>';
}

// The chosen lot, or '' for a purchase ticket or a material with no greige lot.
function washLotChoice(kind) {
    if (kind !== 'wash') return '';
    var sel = document.getElementById('exc-lot');
    return sel ? String(sel.value || '') : '';
}

function submitSummaryException(kind, idx) {
    var entry = summaryEntry(kind, idx);
    if (!entry) return;
    var e = entry.e;
    var btn = document.getElementById('exc-send');

    btn.disabled = true;
    btn.textContent = 'Raising…';
    if (typeof showProgressModal === 'function') {
        showProgressModal('Raising Request', 'Notifying team and queuing the job...');
    }

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
                // Wash only, and only when a lot was offered. completeWashRequest
                // moves the cloth inside this lot; without it the parent total
                // moves on its own and the lots underneath drift short of it.
                lotId: washLotChoice(kind),
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
            if (typeof closeProgressModal === 'function') {
                closeProgressModal();
            }
            closeExceptionDialog();

            // Record what the ticket now covers, not just that one exists — the
            // plan list is what decides whether tomorrow's order re-arms this.
            var exType = exTypeFor(kind);
            var lotNow = washLotChoice(kind);
            var coveredNow = (e.lines || []).map(function (l) { return String(l.planId); });
            var existing = openRequestFor(e, exType, lotNow);
            if (existing) {
                existing.planIds = coveredNow;
            } else {
                // The lot goes on the local record too, or the sibling wash row
                // for the other lot would read as already requested until the
                // next refresh.
                e.openExceptions = (e.openExceptions || []).concat([
                    { type: exType, lot: lotNow, planIds: coveredNow }
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
            if (typeof closeProgressModal === 'function') {
                closeProgressModal();
            }
            alert('Could not raise it: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
            btn.textContent = 'Raise it';
        }
    }).catch(function (err) {
        if (typeof closeProgressModal === 'function') {
            closeProgressModal();
        }
        console.error('raiseMaterialException error:', err);
        alert('Failed to reach the server. Check the console.');
        btn.disabled = false;
        btn.textContent = 'Raise it';
    });
}

// RAISE EVERY OUTSTANDING WASH TICKET IN ONE PRESS.
//
// Walks window.__summary.toWash and fires raiseMaterialException for each row
// that does not already have an open Wash_Needed ticket for its lot. Sequential,
// so a rate limit on one call does not lose the rest, and so the alert at the
// end can report a true count. Same payload the per-row Send to wash builds -
// the only difference is the lot comes from entry.lot (the allocator's choice)
// instead of a dialog dropdown, and there is no free-text note.
function raiseAllWashRequests() {
    var s = window.__summary || { toWash: [] };
    var btn = document.getElementById('sum-raise-all-wash');

    var todo = [];
    (s.toWash || []).forEach(function (entry, idx) {
        var lotId = entry.lot ? String(entry.lot.lotId || '') : '';
        if (requestState(entry.e, 'wash', lotId) === 'open') return;
        todo.push({ entry: entry, idx: idx, lotId: lotId });
    });

    if (todo.length === 0) {
        alert('Every wash request is already raised.');
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Raising 0/' + todo.length + '…'; }
    if (typeof showProgressModal === 'function') {
        showProgressModal('Raising Wash Requests', 'Queuing ' + todo.length + ' job' + (todo.length === 1 ? '' : 's') + '…');
    }

    var done = 0, ok = 0, failed = 0;

    function next() {
        if (done >= todo.length) {
            if (typeof closeProgressModal === 'function') closeProgressModal();
            if (ok > 0 && typeof loadRequirements === 'function') {
                // Re-render so the raised rows flip to Requested and the button
                // recount is correct.
                loadRequirements();
            } else if (btn) {
                btn.disabled = false;
                btn.textContent = 'Raise all ' + todo.length + ' wash request' + (todo.length === 1 ? '' : 's');
            }
            alert(failed === 0
                ? ok + ' wash request' + (ok === 1 ? '' : 's') + ' raised.'
                : ok + ' raised, ' + failed + ' failed. Check the console and retry.');
            return;
        }

        var job = todo[done];
        var e = job.entry.e;
        if (btn) btn.textContent = 'Raising ' + (done + 1) + '/' + todo.length + '…';

        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'raiseMaterialException',
            http_method: 'POST',
            payload: {
                payloadJson: JSON.stringify({
                    materialId: e.materialId,
                    type: 'Wash_Needed',
                    required: e.needed,
                    available: e.stock,
                    unwashed: e.unwashed,
                    shortfall: job.entry.qty,
                    unit: e.unit,
                    note: '',
                    lotId: job.lotId,
                    lines: e.lines || []
                })
            }
        }).then(function (response) {
            var parsed;
            try { parsed = JSON.parse(response.result); } catch (err) { parsed = null; }
            if (parsed && parsed.success) {
                ok++;
                // Mirror submitSummaryException's local bookkeeping so a
                // re-render (or no re-render) shows the row as covered.
                var coveredNow = (e.lines || []).map(function (l) { return String(l.planId); });
                var existing = openRequestFor(e, 'Wash_Needed', job.lotId);
                if (existing) {
                    existing.planIds = coveredNow;
                } else {
                    e.openExceptions = (e.openExceptions || []).concat([
                        { type: 'Wash_Needed', lot: job.lotId, planIds: coveredNow }
                    ]);
                }
                var rowBtn = document.getElementById(summaryBtnId('wash', job.idx));
                if (rowBtn) {
                    rowBtn.disabled = true;
                    rowBtn.classList.remove('is-stale');
                    rowBtn.textContent = 'Requested';
                }
            } else {
                failed++;
                console.error('raiseAllWashRequests: ' + e.material + ' failed:', parsed && parsed.error);
            }
            done++;
            next();
        }).catch(function (err) {
            failed++;
            console.error('raiseAllWashRequests: ' + e.material + ' error:', err);
            done++;
            next();
        });
    }

    next();
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

// This row's share of the allocation, totalled — what its metres box shows.
function recommendedTotal(m, supIdx, matIdx) {
    var rec = recommendLots(m, supIdx, matIdx);
    var t = 0;
    Object.keys(rec).forEach(function (k) { t += rec[k]; });
    return round2(t);
}

// WHICH LOT THE CLOTH COMES OFF, said on the row itself.
//
// Almost always ONE lot — that is what the allocator is for — and then this is a
// single line: "from L3". A four-column table carrying one row of data is what
// made this screen read as clutter, and its washed/unwashed columns answered a
// question the store person had not asked.
//
// When a split is forced it becomes one line per lot, in the same shape the
// waste picks already use on these rows.
//
// The hidden inputs ride along here, one per lot taken, so the submit path reads
// them exactly as it always did — nothing about the payload changes.
function lotLinesHtml(m, supIdx, matIdx) {
    var rec = recommendLots(m, supIdx, matIdx);
    var lots = lotsFor(m);
    var used = Object.keys(rec).filter(function (k) { return rec[k] > 0; });

    var hidden = '';
    used.forEach(function (k) {
        hidden += '<input type="hidden" class="lot-input" ' +
            'id="' + lotInputId(supIdx, matIdx, k) + '" value="' + rec[k] + '" />';
    });
    if (used.length === 0) return hidden;

    var lotName = function (k) {
        var l = lots[Number(k)];
        return escapeHtml((l && l.lotNumber) || '—');
    };

    // THE METRES GO ON EVERY LINE, INCLUDING A SINGLE ONE.
    //
    // They used to be printed only when a row took cloth off two lots, on the
    // argument that against one lot they merely restate the box beside them. That
    // argument died with the typed box: the box is computed and read-only now, it
    // sits at the far right of the row, and this column is where he reads what to
    // fetch off which roll. A bare "L1" made him pair the name with a figure three
    // columns away — and when a row went from one lot to two, a number appeared
    // out of nowhere and read as the wash having changed something it had not.
    //
    // One line, one instruction: which roll, how much.
    //
    // TWO LOTS IS TWO JOBS, and it is not labelled as anything. It used to say
    // "More than one order on this row", which named something he cannot see and
    // cannot act on — he does not deal in orders, and the allocator splitting
    // them is it working, not a condition to report.
    //
    // NO ROW COUNT either. Marker rows are how the allocation is worked out; he
    // measures and cuts metres.
    //
    // No "from" — the column heading already says Lot, and the word only pushed
    // the number away from the edge it should be read down.
    // WHICH PHYSICAL PIECES TO FETCH, on a lot held as pieces.
    //
    // "9 Mtr off P1" is not an instruction he can follow — printed cloth is not
    // on a roll he can measure off, it is a stack of pieces and he has to pick
    // the right ones. Merged on length and carton because that is what makes two
    // rows the same physical thing to fetch.
    //
    // Carton first-class, the same way the offcut lines already quote it: it is
    // the actionable half, and a piece nobody can find is worth the same as one
    // that never came back.
    var piecesByLot = {};
    (m.lotLines || []).forEach(function (ln) {
        (ln.pieces || []).forEach(function (p) {
            var lk = String(ln.lotId);
            if (!piecesByLot[lk]) piecesByLot[lk] = {};
            var pk = (Number(p.lengthCm) || 0) + '|' + (p.carton || '') + '|' + (Number(p.cutLengthCm) || 0);
            piecesByLot[lk][pk] = (piecesByLot[lk][pk] || 0) + (Number(p.count) || 0);
        });
    });

    var pieceLineHtml = function (k) {
        var l = lots[Number(k)];
        var byKey = l ? piecesByLot[String(l.lotId)] : null;
        if (!byKey) return '';
        return Object.keys(byKey).map(function (pk) {
            var parts = pk.split('|');
            var lenM = (Number(parts[0]) || 0) / 100;
            var cutLenM = (Number(parts[2]) || 0) / 100;
            var n = byKey[pk];
            
            var desc = '';
            if (cutLenM > 0) {
                desc = 'Cut ' + fmt(cutLenM) + ' m from ' + fmt(lenM) + ' m piece' + (n === 1 ? '' : ' &times; ' + n);
            } else {
                desc = n + (n === 1 ? ' piece' : ' pieces') + ' of ' + fmt(lenM) + ' m';
            }
            
            return '<div class="lot-pieces">' + desc +
                (parts[1] ? ' &middot; carton ' + escapeHtml(parts[1])
                          : ' &middot; <span class="w-lot-none">carton not recorded</span>') +
                '</div>';
        }).join('');
    };

    return used.map(function (k) {
        return '<div class="lot-from"><b>' + lotName(k) + '</b> &middot; ' +
            fmt(rec[k]) + ' ' + escapeHtml(m.unit) + '</div>' + pieceLineHtml(k);
    }).join('') + hidden;
}

// WHY THE FIGURE IS SHORT, and only when it is.
//
// Unwashed cloth, and cloth away at the wash house, are the answer to "there is
// stock on the rack, why am I being given less than the row asks for". On a row
// that is fully covered it is pure noise — which is what it was on every fabric
// row while the strip printed it unconditionally.
function lotShortHtml(m, supIdx, matIdx) {
    var why = m.shortReason;
    if (!why) return '';
    var u = escapeHtml(m.unit);

    // ONE LINE, AND IT IS THE NEXT THING TO DO. No reasoning, no other lots, no
    // material totals — every figure quoted here is one he can act on, and the
    // kinds are already ranked in shortReasonFor so only one arrives.
    if (why.kind === 'wash') {
        // One line per committed lot, quoting WHAT THIS ROW NEEDS OFF IT — never
        // the lot's own pile, most of which is spoken for by another
        // supervisor's job, and never the material's greige, which is other
        // shades and can never serve this job at all.
        return why.lots.map(function (w) {
            return '<div class="lot-short"><b>' + escapeHtml(w.lotNumber || '') +
                '</b> &middot; ' + fmt(w.qty) + ' ' + u + ' to wash</div>';
        }).join('');
    }
    if (why.kind === 'atWash') {
        return '<div class="lot-short"><b>' + escapeHtml(why.lot || '') + '</b> &middot; ' +
            fmt(why.qty) + ' ' + u + ' at the wash house</div>';
    }

    // NO PRINTED STOCK, AND PLAIN CLOTH TO PRINT IT FROM.
    //
    // ONE LINE AND ONE BUTTON, the same shape as the wash line above it and the
    // override button on a dry pin. The lot is what he walks to; the base
    // material sits in the title because the row already names this cloth and the
    // base is that name minus the pattern.
    //
    // The metres are washed and greige together — a print run goes out in either
    // state — so this is plain cloth in the building, not plain cloth ready to
    // cut, and the Print tab splits the two the moment he lands on it.
    if (why.kind === 'noPrinted') {
        var plain = (why.lots || []).map(function (w, i) {
            return fmt(w.qty) + (i === 0 ? ' ' + u + ' of plain' : '') +
                   ' on <b>' + escapeHtml(w.lotNumber || '') + '</b>';
        });
        return '<div class="lot-dry">No printed stock &mdash; ' + plain.join(', ') +
            '</div>' +
            '<button type="button" class="lot-override-btn" ' +
            'title="Print more from ' + escapeHtml(why.base || 'the plain cloth') + '" ' +
            'onclick="openPrintForBase(\'' + escapeHtml(String(why.baseId || '')) + '\')">' +
            'Print&hellip;</button>';
    }
    if (why.kind === 'pinnedDry' || why.kind === 'pinnedBlocked') {
        return '<div class="lot-dry">' +
            (why.kind === 'pinnedBlocked'
                ? 'Cut from <b>' + escapeHtml(why.lot) + '</b>, which is blocked'
                : '<b>' + escapeHtml(why.lot) + '</b> is empty &mdash; this was cut from ' +
                escapeHtml(why.lot)) +
            '</div>' +
            '<button type="button" class="lot-override-btn" ' +
            'onclick="openLotOverride(' + supIdx + ',' + matIdx + ')">' +
            'Use another lot&hellip;</button>';
    }
    if (why.kind === 'nofit') {
        return '<div class="lot-dry">' + fmt(why.have) + ' ' + u + ' on <b>' +
            escapeHtml(why.lot) + '</b>, smallest job needs ' + fmt(why.need) +
            '</div>';
    }
    if (why.kind === 'blocked') {
        return '<div class="lot-dry">' + fmt(why.qty) + ' ' + u + ' on <b>' +
            escapeHtml(why.lot) + '</b> is blocked</div>';
    }
    if (why.kind === 'nodata') {
        return '<div class="lot-dry">No cut size on the material</div>';
    }
    if (why.kind === 'nolots') {
        return '<div class="lot-short">Not booked in</div>';
    }
    return '<div class="lot-short">None of this shade left</div>';
}




function renderQtyIssueRow(m, supIdx, matIdx, labelBadge) {
    var done = isFullyIssued(m);
    var lots = lotsFor(m);
    // Fabric is typed into its lots, so the row's own box is a running total.
    //
    // Today every fabric row goes through renderFabricRows and this function is
    // only ever called with non-fabric, so byLot is always false here. Kept so
    // the two renderers cannot disagree if fabric is ever routed back through
    // this one — which is exactly how the lot strip came to be missing from the
    // issue screen the first time.
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
        var names = m.contestedBy.map(function (c) { return escapeHtml(c.name); }).join(', ');
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
        '</tr>';
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

    // Fresh cloth has to come off a named lot. A row covered entirely by waste
    // needs none, so it gets no lot strip — there is no fresh fabric to source.
    var byLot = !done && wantsFresh;

    // ---- "To be issued": fresh metres as the headline, waste beneath it ----
    // NO STATUS PILL ON A FABRIC ROW.
    //
    // The lot column beside it now says the one thing he can act on, and the pill
    // could only categorise it — badly. A row waiting on a wash got "Cannot cut",
    // which is false: the cloth is there, it is greige, and the line next to it
    // already says how much to send. Two labels for one condition, and the shorter
    // one was the wrong one.
    var toIssue = '';
    if (wantsFresh) {
        toIssue =
            '<span class="qty-big">' + fmt(m.remaining) +
            '<span class="unit">' + escapeHtml(m.unit) + '</span></span>';
    }
    picks.forEach(function (p) {
        toIssue +=
            '<div class="qty-sub qty-sub-waste">' +
            '<div>&#9851; ' + p.pieces + ' pc' + (p.pieces === 1 ? '' : 's') + ' waste</div>' +
            '<div class="waste-dim">' + fmt(p.length) + ' &times; ' + fmt(p.width) + ' cm</div>' +
            '</div>';
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
        // NOTHING ALLOCATED MEANS NOTHING TO ISSUE, whatever the shelf total
        // says — no lot at all, or lots holding only ends too short to cut.
        //
        // maxIssuable is the shelf figure, so on a fragmented material it left
        // this box live at zero: he could tick it, press Issue, and be handed
        // nothing with no error. The lot strip beside it explains why.
        if (byLot && recommendedTotal(m, supIdx, matIdx) <= 0) disabled = 'disabled';
        issueCell = '<div class="issue-stack">';

        if (wantsFresh) {
            // Pre-filled from the recommendation, so the common case is one
            // glance and one press. He can still change any of it.
            var startQty = byLot ? recommendedTotal(m, supIdx, matIdx) : suggestedIssue(m);

            issueCell +=
                '<div class="issue-cell">' +
                '<input type="checkbox" class="issue-checkbox" id="' + rowCheckboxId(supIdx, matIdx) + '" ' +
                (rowIssuable(m) && startQty > 0 ? 'checked' : '') + ' ' + disabled + ' ' +
                'aria-label="Issue ' + escapeHtml(m.material) + '" ' +
                'onchange="onIssueCheckboxChange(' + supIdx + ',' + matIdx + ')" />' +
                '<span class="issue-input-group">' +
                // Read-only when it comes off lots: this box is the
                // running total of what he typed against each lot, not
                // somewhere to type. Keeping it means the checkbox,
                // validation and card footer all work unchanged.
                '<input type="number" step="0.01" min="0" max="' + issueCeiling(m) + '" ' +
                'class="issue-input" id="' + rowInputId(supIdx, matIdx) + '" ' + disabled + ' ' +
                (byLot ? 'readonly ' : '') +
                'value="' + startQty + '" ' +
                'oninput="onIssueInputChange(' + supIdx + ',' + matIdx + ')" />' +
                '<span class="issue-unit">' + escapeHtml(m.unit) + '</span>' +
                '</span>' +
                '</div>';
        }

        // Each piece size keeps its own checkbox — a remnant can be declined
        // without giving up the fresh length that goes with it.
        picks.forEach(function (p, pickIdx) {
            issueCell +=
                '<div class="issue-cell issue-cell-waste" id="' + wasteRowId(supIdx, matIdx, pickIdx) + '">' +
                '<input type="checkbox" class="issue-checkbox" id="' + wasteCheckboxId(supIdx, matIdx, pickIdx) + '" ' +
                (wasteCheckedFor(p) ? 'checked ' : '') +
                'aria-label="Issue waste pieces of ' + escapeHtml(m.material) + '" ' +
                'onchange="onWasteCheckboxChange(' + supIdx + ',' + matIdx + ',' + pickIdx + ')" />' +
                '<span class="issue-input-group">' +
                '<input type="number" step="1" min="0" max="' + rackCountFor(m, p) + '" ' +
                'class="issue-input" id="' + wasteInputId(supIdx, matIdx, pickIdx) + '" value="' + p.pieces + '" ' +
                'oninput="onWasteInputChange(' + supIdx + ',' + matIdx + ',' + pickIdx + ')" />' +
                '<span class="issue-unit">pcs</span>' +
                '</span>' +
                '</div>';
        });

        issueCell += '</div>';
    }

    // NO "ALSO NEEDED BY" ON A FABRIC ROW.
    //
    // It named something he cannot act on. Under the old screen he could favour
    // one supervisor by typing a smaller number; the allocation is computed now,
    // there is no per-order control, and the row he would type into is read-only.
    // Contention is settled where it can actually be settled — issueMaterials
    // re-checks every lot, and whoever presses second gets what is really left.
    //
    // It stays on ACCESSORY rows, where he still types the quantity and the
    // warning is therefore something he can do something about.
    return '' +
        '<tr id="' + rowId(supIdx, matIdx) + '" class="' + (done ? 'row-issued' : 'row-selected') + '">' +
        '<td class="material-name-cell">' +
        '<div class="mat-name">' + escapeHtml(m.material) +
        (picks.length > 0 ? '<span class="waste-badge">&#9851; incl. waste</span>' : '') +
        '</div>' +
        '<div class="mat-sku">' + escapeHtml(m.sku) + '</div>' +
        reissueWhy(m) +
        '</td>' +
        '<td class="col-num col-strong">' + toIssue + '</td>' +
        // The hidden inputs live in here now. They are keyed by id, not by
        // position, so the submit path reads them exactly as before.
        '<td class="col-lot-issue">' +
        (byLot ? lotLinesHtml(m, supIdx, matIdx) + lotShortHtml(m, supIdx, matIdx) : '') +
        // WHERE TO FETCH EACH WASTE PIECE FROM — carton and lot, now
        // shown in the LOT column so all location info is grouped.
        picks.map(function (p) { return wasteWhereHtml(p); }).join('') +
        '</td>' +
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

function renderSection(title, note, headCells, rowsHtml, actionHtml) {
    if (!rowsHtml) return '';
    return '' +
        '<div class="mat-section">' +
        '<div class="section-title">' + escapeHtml(title) +
        (note ? '<span class="section-note">' + escapeHtml(note) + '</span>' : '') +
        (actionHtml || '') +
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
        // ONE CARD'S WASH NEED, PER LOT, TAKEN ONCE.
        //
        // `m.washLots[].qty` is already this card's total for that lot across
        // every row of the material, so adding the rows up would count a Plan
        // row and its Reissue row twice over. Collected here and folded into the
        // material AFTER the card, which is also the only place the boundary
        // between "same card" and "another supervisor" is still visible.
        var cardWash = {};
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
                    // Same reasoning as stock: one live list, taken from the
                    // first row that mentions the material rather than merged.
                    // The wash ticket has to name which lot's greige is going.
                    lots: (m.lots || []).slice(),
                    // Which lot the allocation is actually waiting on, if any.
                    washLotId: m.washLotId || '',
                    washQty: Number(m.washQty) || 0,
                    // …and EVERY lot, with what each is owed. A material can be
                    // waiting on two lots at once — one supervisor's order
                    // committed to L2 and another's to L3 — and it needs a wash
                    // ticket for each. `washLotId` alone took whichever card was
                    // read first, so the other tone was silently never queued.
                    washByLot: {},
                    // Already at the wash house. Not greige, not washed — and the
                    // reason a shortfall can look unfixable when it is simply
                    // already being fixed.
                    inWash: Number(m.inWashStock) || 0,
                    // Cloth already on a raised draft PO — an open Shortage
                    // ticket with a PO_Number, summed server-side. Counts as
                    // owned in the buy calc below, so a material with a PO out
                    // drops off "Short — needs purchase" and its Raise PO button
                    // disappears until the goods land and the ticket resolves.
                    poCovered: Number(m.poCoveredQty) || 0,
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

            (m.washLots || []).forEach(function (w) {
                var ck2 = key + '|' + w.lotId;
                // Assigned, not added — the card's figure, taken once.
                cardWash[ck2] = {
                    matKey: key, lotId: String(w.lotId),
                    lotNumber: w.lotNumber, qty: Number(w.qty) || 0
                };
            });
        });

        // Now across supervisors it IS a sum: two men's orders committed to the
        // same lot both want its greige, and both are real requirements.
        // Capping happens later, at what the lot actually holds.
        Object.keys(cardWash).forEach(function (ck2) {
            var w = cardWash[ck2];
            var e = byMat[w.matKey];
            if (!e) return;
            if (!e.washByLot[w.lotId]) {
                e.washByLot[w.lotId] = { lotId: w.lotId, lotNumber: w.lotNumber, qty: 0 };
            }
            e.washByLot[w.lotId].qty = round2(e.washByLot[w.lotId].qty + w.qty);
        });
    });

    var toWash = [];
    var toBuy = [];

    // TWO INDEPENDENT QUESTIONS, and gating one on the other is what broke this.
    //
    //   WASH — which lot's greige has jobs waiting on it. Read off the rows'
    //          commitments and nothing else.
    //   BUY  — is there enough cloth of this fabric AT ALL, in any state.
    //
    // It used to ask "is the material short?" first and skip everything if not.
    // A material with thirty metres washed in the wrong shade is not short by
    // that test, so a row reading "L2 · 13.2 Mtr to wash" got no wash row here
    // and no buy row either: he could neither issue nor raise the wash, and
    // nothing on the screen said why.
    Object.keys(byMat).forEach(function (k) {
        var e = byMat[k];

        // ---- WASH: one ticket per lot a job is actually waiting on ----
        //
        // Straight off `washByLot`, which the rows built from their own
        // commitments — no re-derivation, so the row and this list cannot
        // disagree. Capped at what the lot holds, because the wash converts ONE
        // lot's greige and raiseMaterialException trims a larger ask silently,
        // which leaves the store waiting on metres that were never coming.
        //
        // No material-level test in front of it. A material can hold plenty of
        // washed cloth and still have a job stuck, because that cloth is another
        // shade — which is the whole reason lots exist.
        var byLotId = {};
        (e.lots || []).forEach(function (l) { byLotId[String(l.lotId)] = l; });

        if (e.isFabric) {
            Object.keys(e.washByLot || {})
                .map(function (id) { return e.washByLot[id]; })
                .filter(function (w) { return w.qty > 0; })
                .sort(function (a, b) { return b.qty - a.qty; })
                .forEach(function (w) {
                    var l = byLotId[String(w.lotId)];
                    if (!l) return;
                    var q = round2(Math.min(w.qty, Number(l.unwash) || 0));
                    if (q <= 0) return;
                    toWash.push({ e: e, qty: q, kind: 'wash', lot: l });
                });
        }

        // ---- BUY: cloth that does not exist in ANY state ----
        //
        // Washed, greige and at-the-wash-house all count as owned. Leaving the
        // last one out is what had the screen asking him to purchase cloth that
        // was sitting at the washer — raised the day after he sent it, because
        // sending moves the metres off the greige pile.
        //
        // Deliberately NOT "the wash could not cover it". A shade that cannot be
        // made up by washing is a purchase question only if the fabric is short
        // overall; otherwise it is the tone override's business, and that lives
        // on the row where the decision is.
        //
        // poCovered — cloth already on a raised draft PO — counts as owned. Once
        // a PO is raised for the gap, the material leaves this list and its
        // Raise PO button disappears; if demand later outgrows the PO before the
        // goods land, the residual gap re-appears here on its own.
        var owned = round2((Number(e.stock) || 0) +
            (Number(e.unwashed) || 0) +
            (Number(e.inWash) || 0) +
            (Number(e.poCovered) || 0));
        var buyQty = round2(e.needed - owned);
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

// A WASH TICKET BELONGS TO A LOT, NOT TO A MATERIAL.
//
// A material can be waiting on two lots at once, and each needs its own ticket —
// washing L3 produces cloth the L2 job cannot use. Matched material-level, the
// first raise greyed out the second lot's button and that shade was never queued
// at all, with nothing anywhere saying why.
//
// A purchase ticket has no lot: the cloth does not exist yet, so there is nothing
// to name and one per material is right.
function openRequestFor(e, exType, lotId) {
    var want = String(lotId || '');
    var found = (e.openExceptions || []).filter(function (x) {
        if (!x || x.type !== exType) return false;
        if (exType !== 'Wash_Needed') return true;
        // A ticket raised before the field existed carries no lot. Treated as
        // covering the lot in hand rather than none, so an older open ticket
        // still reads as open instead of inviting a duplicate.
        return String(x.lot || '') === '' || String(x.lot || '') === want;
    });
    return found.length > 0 ? found[0] : null;
}

// An open ticket only speaks for the orders that were on it when it was raised.
// A plan that has appeared since is demand nobody has been told about, so the
// button has to come back to life — otherwise today's order silently inherits
// yesterday's request and nobody orders enough.
function requestState(e, kind, lotId) {
    var open = openRequestFor(e, exTypeFor(kind), lotId);
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
    var state = requestState(e, kind, entry.lot ? entry.lot.lotId : '');

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
        // WASHED AND UNWASHED ARE THE LOT'S, not the material's, on any row
        // that names a lot. A ticket capped at what L2 holds beside a greige
        // figure totalling every lot of the SKU is the same "two figures on
        // one row" fault the issue screen had: 706.09 unwashed next to
        // "wash 50, all it has" reads as an arithmetic error.
        '<td class="col-num">' +
        qty((kind === 'wash' && entry.lot) ? (Number(entry.lot.wash) || 0) : e.stock, e.unit) +
        '</td>' +
        // Wash rows only — the greige pile and the lot it comes off. A
        // purchase row has neither: the cloth does not exist yet.
        (kind === 'wash'
            ? '<td class="col-num">' +
            qty(entry.lot ? (Number(entry.lot.unwash) || 0) : e.unwashed, e.unit) +
            (((entry.lot ? Number(entry.lot.inWash) : Number(e.inWash)) || 0) > 0
                ? '<div class="sum-inwash">+' +
                fmt(entry.lot ? entry.lot.inWash : e.inWash) + ' at wash</div>'
                : '') +
            '</td>'
            : '') +
        '<td class="col-num col-strong">' +
        '<span class="qty-big">' + fmt(entry.qty) +
        '<span class="unit">' + escapeHtml(e.unit) + '</span></span>' +
        '</td>' +
        (kind === 'wash'
            ? '<td class="sum-lot">' +
            (entry.lot
                ? '<span class="lot-id">' + escapeHtml(entry.lot.lotNumber || '—') + '</span>' +
                // Only worth saying when the ticket has taken the
                // lot's whole pile — that is when the figure is
                // capped rather than chosen, and when washing it
                // still will not clear the block.
                (round2(entry.qty) + 0.0001 >= (Number(entry.lot.unwash) || 0)
                    ? '<div class="sum-lot-note">all it has</div>'
                    : '')
                : '<span class="is-zero">&mdash;</span>') +
            '</td>'
            : '') +
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

    // Reads as the chain it is: you need this much, you have this much washed
    // and this much greige, so wash this much, off this lot.
    var washHead =
        '<th>Material</th>' +
        '<th class="col-num">Needed</th>' +
        '<th class="col-num">Washed</th>' +
        '<th class="col-num">Unwashed</th>' +
        '<th class="col-num">To wash</th>' +
        '<th>From lot</th>' +
        '<th class="col-action"></th>';

    var buyHead =
        '<th>Material</th>' +
        '<th class="col-num">Needed</th>' +
        '<th class="col-num">In stock</th>' +
        '<th class="col-num">Short by</th>' +
        '<th class="col-action"></th>';

    // ONE BUTTON, EVERY WASH TICKET. Raises a Wash_Needed request for each row
    // in the list that does not already have an open one, using the lot the
    // allocator picked for that row — same payload as the per-row Send to wash,
    // just without opening the dialog for each. Only shown when at least one row
    // still needs raising.
    var washPending = s.toWash.filter(function (entry) {
        return requestState(entry.e, 'wash', entry.lot ? entry.lot.lotId : '') !== 'open';
    }).length;
    var washAllBtn = washPending > 0
        ? '<button type="button" class="raise-btn section-action" id="sum-raise-all-wash" ' +
          'onclick="raiseAllWashRequests()">Raise all ' + washPending +
          ' wash request' + (washPending === 1 ? '' : 's') + '</button>'
        : '';

    var poPending = s.toBuy.length;
    var poAllBtn = poPending > 0
        ? '<button type="button" class="raise-btn section-action" id="sum-raise-all-po" ' +
          'onclick="openVendorModal()">Raise PO for ' + poPending +
          ' short item' + (poPending === 1 ? '' : 's') + '</button>'
        : '';

    var sections =
        renderSection(
            'Needs washing',
            '',
            washHead,
            s.toWash.map(summaryRow).join(''),
            washAllBtn
        ) +
        renderSection(
            'Short — needs purchase',
            '',
            buyHead,
            s.toBuy.map(summaryRow).join(''),
            poAllBtn
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

    // A SETTLED ROW IS NOT DRAWN — IT BELONGS TO HISTORY.
    //
    // The same rule the card filter above applies, applied at the row it was
    // always about. A card survives while ANY line still owes something, so
    // every settled line of that supervisor's plans used to ride along under it
    // as a read-only green receipt — and a plan stays in this screen's query
    // right through production, because In Progress can still owe material.
    // Nine green rows and three live ones, with the master checkbox the only
    // thing saying which was which.
    //
    // It was also inconsistent three ways for no reason the store person could
    // see: a card with nothing pending disappears, a plan reaching Material
    // Ready disappears, but a settled row next to an unsettled one stayed.
    //
    // History is the better record of it anyway — getStoreIssueHistory reads
    // Material_Issue, so it has the date and the person, where the green tag
    // only ever showed a cumulative Issued_Qty that matches no single handover.
    // The header meta below still counts them, so the card says they exist.
    //
    // FILTERED HERE AND NOWHERE ELSE. `sup.materials` must keep every row:
    //   - applyLotAllocation's pin pass reads `issuedLot` from EVERY line,
    //     settled ones included — in the ordinary remake the settled original is
    //     the only record of which lot the order was cut from.
    //   - every element id and handler is supIdx/matIdx into that array, so the
    //     index passed below has to stay the real one. `.map` keeps it; only the
    //     markup is dropped.
    var live = function (m) { return !isFullyIssued(m); };

    var fabricHtml = sup.materials.map(function (m, matIdx) {
        return (m.isFabric && !isRe(m) && live(m)) ? renderFabricRows(m, idx, matIdx) : '';
    }).join('');

    var otherHtml = sup.materials.map(function (m, matIdx) {
        return (!m.isFabric && !isRe(m) && live(m)) ? renderQtyIssueRow(m, idx, matIdx, '') : '';
    }).join('');

    var reFabricHtml = sup.materials.map(function (m, matIdx) {
        return (m.isFabric && isRe(m) && live(m)) ? renderFabricRows(m, idx, matIdx) : '';
    }).join('');

    var reOtherHtml = sup.materials.map(function (m, matIdx) {
        return (!m.isFabric && isRe(m) && live(m)) ? renderQtyIssueRow(m, idx, matIdx, '') : '';
    }).join('');

    // NO STOCK COLUMNS ON FABRIC. The store person issues from a LOT, and the
    // lot strip underneath already shows what each one holds. A shelf total
    // beside it answers a question he is no longer asking, and 373.1 washed
    // across three lots is actively misleading when only one of them can fill
    // the order without mixing tones. The total still exists on Raw_Material and
    // still drives the shortage pill and the contested warning - it just is not
    // a column any more.
    // Lot is its own column, not a line tucked under the metres box. It is a
    // fact about the row — which tone is leaving the shelf — and reading down a
    // column is how he checks a card's worth of them at a glance.
    var fabricHead =
        '<th>Material</th>' +
        '<th class="col-num">To be issued</th>' +
        '<th class="col-lot-issue">Lot</th>';

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

    // THE ONLY TRACE OF THE SETTLED ROWS ON THIS SCREEN, now that they are not
    // drawn — so it says where they went rather than just how many there were.
    // Without that the count reads as a number he cannot open.
    var metaText = pending.length + ' pending';
    if (doneCount > 0) {
        metaText += ' &middot; ' + doneCount + ' issued &mdash; see History';
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

    // No contested count here. A number in the header only says "something below
    // is a problem", and on fabric there is nothing he could do with it anyway —
    // the allocation is computed and the metres box is read-only, so contention is
    // settled at issue time by issueMaterials rather than announced here. Accessory
    // rows still carry "Also needed by …" on themselves, because there he types the
    // quantity and can act on it.

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
    // FIRST, because it rewrites the numbers everything else reads. Which lot
    // each order comes off decides which remnants are usable, and that decides
    // how much fresh cloth is still needed — so `remaining`, `freshPieces` and
    // `wastePicks` are all produced here rather than by the server.
    // Kept so an in-place redraw can re-run allocation over EVERY supervisor.
    // __reqData below is the filtered, actionable list; feeding that back through
    // here would quietly drop the filtered-out cards out of contention and hand
    // their cloth to someone else.
    window.__rawData = data;

    applyLotAllocation(data);
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

// BUILD THE FABRIC ISSUE LINE FROM THE ALLOCATOR'S OWN OUTPUT.
//
// applyLotAllocation (lot-allocator.js) has already decided everything: which
// lot every order is cut from, how many fresh metres come off it, which
// remnants, which physical pieces and cut lengths. It left the answer on
// `m.lotLines[]` and `m.wastePicks[]`. This just reshapes that into the payload
// issueMaterials applies with point lookups — the server no longer re-derives
// any of it by fanning across open plans.
//
//   allocations  — one per plan item the allocator served: giveQty (metres to
//                  add to Issued_Qty), giveRaw / giveWaste (cut pieces to add
//                  to Pieces_From_Raw / Pieces_From_Waste), issuedLot (stamped
//                  only when the mrq has none). mrqId resolved from m.lines.
//   lotMoves     — m.lotLines grouped by lot: metres to move Wash_Quantity ->
//                  In_Transit_Qty, plus the physical pieces on a Pieces lot.
//   wastePicks   — the ticked remnants, each enriched with its cut-piece yield
//                  and dimensions for the Waste_Movement record.
//   issueLines   — one per allocation, expanded one-per-physical-piece for a
//                  PRINTED_PIECE line so the supervisor can receive each piece.
//
// `picks` is the array of { wasteId, pieces, planItemId } gathered from the
// ticked waste checkboxes.
function buildFabricIssueLine(m, picks) {
    var cutW = Number(m.cutWidth) || 0;
    var cutL = Number(m.cutLength) || 0;
    var src = m.isReissue === true ? 'Reissue' : 'Plan';

    var lotLines = (m.lotLines || []).filter(function (ln) {
        return (Number(ln.qty) || 0) > 0;
    });

    // planItemId -> the mrq it belongs to, and how many cut pieces it still
    // owes — from the server's per-row lines. The owed figure is the ceiling on
    // giveRaw + giveWaste: the allocator caps at it too, and adding more than
    // the row owes to Pieces_From_Raw / Pieces_From_Waste over-closes it.
    var mrqByItem = {};
    var planByItem = {};
    var owedByItem = {};
    (m.lines || []).forEach(function (ln) {
        var it = String(ln.planItemId || '');
        if (it && mrqByItem[it] === undefined) {
            mrqByItem[it] = ln.mrqId;
            planByItem[it] = ln.planId;
            owedByItem[it] = Math.max(0, (Number(ln.reqPieces) || 0) - (Number(ln.issPieces) || 0));
        }
    });

    // ---- lotMoves: m.lotLines grouped by lot ----
    var moveByLot = {};
    var moveOrder = [];
    lotLines.forEach(function (ln) {
        var k = String(ln.lotId);
        if (!moveByLot[k]) {
            moveByLot[k] = { lotId: ln.lotId, qty: 0, isPieces: false, pieces: [] };
            moveOrder.push(k);
        }
        moveByLot[k].qty = round2(moveByLot[k].qty + (Number(ln.qty) || 0));
        (ln.pieces || []).forEach(function (p) {
            moveByLot[k].isPieces = true;
            moveByLot[k].pieces.push({
                pieceId: p.pieceId,
                count: Number(p.count) || 0,
                cutLengthCm: Number(p.cutLengthCm) || 0
            });
        });
    });
    var lotMoves = moveOrder.map(function (k) { return moveByLot[k]; });

    // ---- allocations: one per plan item the allocator served ----
    // giveQty / giveRaw / giveWaste come STRAIGHT off the allocator's lotLines
    // (fromRaw / fromWaste added in spend()) — never recomputed here. A demand
    // covered entirely by offcuts has no lotLine, so its waste credit is
    // recovered from the physical picks instead.
    var qtyByItem = {};
    var rawByItem = {};
    var wasteByItem = {};
    var lotByItem = {};
    var itemOrder = [];
    var seenItem = {};
    lotLines.forEach(function (ln) {
        var it = String(ln.planItemId || '');
        if (!seenItem[it]) {
            seenItem[it] = true; itemOrder.push(it);
            qtyByItem[it] = 0; rawByItem[it] = 0; wasteByItem[it] = 0;
        }
        qtyByItem[it] = round2(qtyByItem[it] + (Number(ln.qty) || 0));
        rawByItem[it] += Number(ln.fromRaw) || 0;
        wasteByItem[it] += Number(ln.fromWaste) || 0;
        if (!lotByItem[it]) lotByItem[it] = ln.lotId;
    });

    // ---- wastePicks payload, and the offcut-only credit fallback ----
    // Total remnant yield per item from the ticked picks. Used ONLY for a plan
    // item with no lotLine at all (offcut-complete) — otherwise the allocator's
    // per-line fromWaste above is authoritative.
    var wasteYieldByItem = {};
    var wastePicksOut = [];
    picks.forEach(function (pk) {
        var src2 = (m.wastePicks || []).filter(function (x) {
            return String(x.wasteId) === String(pk.wasteId);
        })[0] || {};
        var w = Number(src2.width) || 0;
        var l = Number(src2.length) || 0;
        var yieldPer = remnantYield({ width: w, length: l }, cutW, cutL);
        var it = String(pk.planItemId || src2.planItemId || '');
        wasteYieldByItem[it] = (wasteYieldByItem[it] || 0) + pk.pieces * yieldPer;
        wastePicksOut.push({
            wasteId: pk.wasteId,
            pieces: pk.pieces,
            planId: planByItem[it] || '',
            planItemId: it,
            yieldPer: yieldPer,
            pieceWidth: w,
            pieceLength: l
        });
    });
    Object.keys(wasteYieldByItem).forEach(function (it) {
        if (it === '') return;
        if (!seenItem[it]) {
            // Offcut-complete: no fresh cloth, no lotLine. Credit from the picks.
            seenItem[it] = true; itemOrder.push(it);
            qtyByItem[it] = 0; rawByItem[it] = 0;
            wasteByItem[it] = wasteYieldByItem[it];
        }
    });

    var allocations = itemOrder.filter(function (it) {
        return it !== '' && mrqByItem[it] !== undefined;
    }).map(function (it) {
        var owed = owedByItem[it] === undefined ? Infinity : owedByItem[it];
        var raw = rawByItem[it] || 0;
        var wst = wasteByItem[it] || 0;
        // Never credit more pieces than the row still owes — the allocator caps
        // at this too. Waste first (scarcer, already paid for), then fresh.
        if (wst > owed) { wst = owed; }
        if (raw > owed - wst) { raw = Math.max(0, owed - wst); }
        return {
            mrqId: mrqByItem[it],
            planId: planByItem[it] || '',
            planItemId: it,
            giveQty: round2(qtyByItem[it] || 0),
            giveRaw: raw,
            giveWaste: wst,
            issuedLot: String(lotByItem[it] || '')
        };
    });

    // ---- issueLines: one per allocation, PRINTED_PIECE expanded per piece ----
    var issueLinesOut = [];
    allocations.forEach(function (a) {
        var ln = lotLines.filter(function (x) {
            return String(x.planItemId || '') === a.planItemId;
        })[0] || {};
        if (ln.pieces && ln.pieces.length && ln.cutSummary) {
            var baseNote = ln.note ? ln.note + ' | ' : '';
            ln.pieces.forEach(function (p) {
                issueLinesOut.push({
                    mrqId: a.mrqId, planItemId: a.planItemId, lotId: a.issuedLot,
                    qty: round2(((Number(p.cutLengthCm) || 0) * (Number(p.count) || 0)) / 100),
                    unit: m.unit, cutW: cutW, cutL: cutL,
                    note: baseNote + 'PRINTED_PIECE | ' + ln.cutSummary,
                    overrideFrom: ln.overrideFrom || ''
                });
            });
        } else {
            issueLinesOut.push({
                mrqId: a.mrqId, planItemId: a.planItemId, lotId: a.issuedLot,
                qty: a.giveQty, unit: m.unit, cutW: cutW, cutL: cutL,
                note: ln.note || '', overrideFrom: ln.overrideFrom || ''
            });
        }
    });

    return {
        materialId: m.materialId,
        source: src,
        isFabric: true,
        cutWidth: cutW,
        cutLength: cutL,
        allocations: allocations,
        lotMoves: lotMoves,
        wastePicks: wastePicksOut,
        issueLines: issueLinesOut
    };
}

// SPLIT THE ISSUE LINES INTO PAYLOADS OF AT MOST maxAllocs ALLOCATIONS.
//
// A payload with hundreds of allocations is too large for one invokeCustomApi —
// Creator trims it — so pack whole material lines until the next one would
// overflow, and if a single material line has more than maxAllocs allocations
// on its own, break IT across payloads too.
//
// When a material line is split: its `allocations` and `issueLines` are sliced
// in lockstep (issueLines has one entry per allocation, except PRINTED_PIECE
// lines which have several — those keep their whole material line together
// because they are always well under maxAllocs). `lotMoves` and `wastePicks`
// ride the FIRST slice only: the lot-metre move and the remnant consumption are
// each applied once, and issueMaterials re-reads stock per call so the parent
// Raw_Material move stays correct across the slices.
function splitIssuesByAllocation(issues, maxAllocs) {
    var chunks = [];
    var cur = [];
    var curCount = 0;

    function flush() {
        if (cur.length) { chunks.push(cur); cur = []; curCount = 0; }
    }

    issues.forEach(function (line) {
        var allocs = line.allocations || [];
        var hasPrinted = (line.issueLines || []).length !== allocs.length;

        // Fits whole, or is a PRINTED_PIECE line we never slice.
        if (allocs.length <= maxAllocs || hasPrinted) {
            if (curCount + allocs.length > maxAllocs) flush();
            cur.push(line);
            curCount += allocs.length;
            return;
        }

        // Break this one line across payloads.
        flush();
        for (var start = 0; start < allocs.length; start += maxAllocs) {
            var slice = allocs.slice(start, start + maxAllocs);
            var part = {
                materialId: line.materialId,
                source: line.source,
                isFabric: line.isFabric,
                cutWidth: line.cutWidth,
                cutLength: line.cutLength,
                allocations: slice,
                issueLines: (line.issueLines || []).slice(start, start + maxAllocs),
                lotMoves: start === 0 ? (line.lotMoves || []) : [],
                wastePicks: start === 0 ? (line.wastePicks || []) : []
            };
            chunks.push([part]);
        }
    });
    flush();
    return chunks.length ? chunks : [issues];
}

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
            // planItemId travels with the pick so the server credits the item
            // this remnant was actually allocated to, rather than the oldest row
            // that happens to match on material and cut size.
            if (pieces > 0) picks.push({
                wasteId: p.wasteId, pieces: pieces,
                planItemId: p.planItemId || ''
            });
        });

        var hasLots = (m.lotLines || []).some(function (ln) {
            return (Number(ln.qty) || 0) > 0;
        });

        // A fabric row can be worth issuing at 0 metres when waste covers it
        // entirely, so the metres value alone cannot decide this.
        if (val > 0 || picks.length > 0) {
            var line;
            if (m.isFabric) {
                if (val > 0 && !hasLots) {
                    alert('Choose which lot the ' + m.material + ' comes from.');
                    hasInvalid = true;
                    return;
                }
                // Everything — allocations, lotMoves, wastePicks, issueLines —
                // comes straight from what applyLotAllocation already decided.
                line = buildFabricIssueLine(m, picks);
            } else {
                // ACCESSORIES: fan the typed metres across the owed rows here,
                // exactly as fabric now does via the allocator. giveRaw /
                // giveWaste are 0 — pieces are not the unit for a non-fabric mrq.
                line = {
                    materialId: m.materialId,
                    source: m.isReissue === true ? 'Reissue' : 'Plan',
                    isFabric: false,
                    cutWidth: 0, cutLength: 0,
                    allocations: [], lotMoves: [], wastePicks: [], issueLines: []
                };
                var remainingToGive = val;
                for (var i = 0; i < m.lines.length; i++) {
                    if (remainingToGive <= 0) break;
                    var aln = m.lines[i];
                    var rowOwes = (Number(aln.required) || 0) - (Number(aln.issued) || 0);
                    if (rowOwes > 0) {
                        var give = Math.min(rowOwes, remainingToGive);
                        give = Math.round(give * 1000) / 1000; // avoid float drift
                        line.allocations.push({
                            mrqId: aln.mrqId, planId: aln.planId,
                            planItemId: aln.planItemId,
                            giveQty: give, giveRaw: 0, giveWaste: 0, issuedLot: ''
                        });
                        remainingToGive -= give;
                    }
                }
                // Over-issuing beyond every requirement: dump the remainder on
                // the last row (or the first, if nothing owed) so the qty still
                // goes out — matches the previous backend behaviour.
                if (remainingToGive > 0 && line.allocations.length > 0) {
                    line.allocations[line.allocations.length - 1].giveQty =
                        Math.round((line.allocations[line.allocations.length - 1].giveQty + remainingToGive) * 1000) / 1000;
                } else if (remainingToGive > 0 && m.lines.length > 0) {
                    line.allocations.push({
                        mrqId: m.lines[0].mrqId, planId: m.lines[0].planId,
                        planItemId: m.lines[0].planItemId,
                        giveQty: remainingToGive, giveRaw: 0, giveWaste: 0, issuedLot: ''
                    });
                }
                line.issueLines = line.allocations.map(function (a) {
                    return {
                        mrqId: a.mrqId, planItemId: a.planItemId, lotId: '',
                        qty: a.giveQty, unit: m.unit, cutW: 0, cutL: 0,
                        note: '', overrideFrom: ''
                    };
                });
            }

            // Nothing resolved to an allocation — no owed row matched. Skip
            // rather than post an empty line the server would just no-op.
            if (line.allocations.length > 0 || line.wastePicks.length > 0) {
                issues.push(line);
            }
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

    // CHUNK BY ALLOCATION COUNT, not by material. issueMaterials applies an
    // explicit per-requirement allocation with point lookups, so its cost is
    // O(allocations in the call) — but one press against a supervisor holding a
    // big backlog can be thousands of allocations, and that payload is too large
    // for a single invokeCustomApi (Creator trims the issuesJson string). So
    // split into chunks of at most MAX_ALLOCS allocations, splitting a fat
    // material line across chunks when it alone exceeds that.
    //
    // SEQUENTIAL, not parallel. Every chunk of one press shares ONE voucher:
    // chunk 1 sends voucherIn:"" and gets the SIV number back, every later chunk
    // sends it in and issueMaterials APPENDS its Issue_Lines to that same
    // Material_Issue. Zoho does not serialise writes to one record, so two
    // chunks appending to the same subform in parallel can lose rows — the
    // calls therefore run one after another. Speed comes from MAX_ALLOCS being
    // large (fewer, fatter calls), not from concurrency.
    var MAX_ALLOCS = 100;
    var issueChunks = splitIssuesByAllocation(issues, MAX_ALLOCS);

    var allErrors = [];
    var chunkIndex = 0;

    // RATE-LIMIT RECOVERY. Zoho caps API calls per minute. A big handover is
    // many sequential chunks and can trip that cap partway through — which used
    // to abort the whole run and leave a partial voucher. Now a throttled chunk
    // is RETRIED with exponential backoff instead of failing: the run pauses,
    // waits, and picks up exactly where it left off (same chunkIndex). Only a
    // non-retryable error, or too many retries, aborts.
    //
    // Each chunk is now its OWN Material_Issue (SIV-NNNNN) — no shared voucher
    // threaded across chunks — so a partial run is just fewer vouchers, not a
    // broken one. issueMaterials still takes a 3rd arg (Creator can't drop it);
    // we send "".
    //
    // isRateLimited: Zoho surfaces throttling inconsistently — an HTTP 429, a
    // body code (4834 / "too many requests" / "rate limit"), or a plain
    // network-ish failure. Match broadly; a false positive just costs one wait.
    var RETRY_WAITS_MS = [3000, 8000, 20000, 45000, 60000]; // then give up
    var retryCount = 0;

    function isRateLimited(err) {
        var s = '';
        try { s = JSON.stringify(err); } catch (e) { s = String(err); }
        s = (s + ' ' + (err && err.message ? err.message : '')).toLowerCase();
        return err && (
            err.status === 429 || err.statusCode === 429 || err.code === 429 ||
            s.indexOf('429') >= 0 ||
            s.indexOf('too many request') >= 0 ||
            s.indexOf('rate limit') >= 0 ||
            s.indexOf('rate-limit') >= 0 ||
            s.indexOf('4834') >= 0 ||
            s.indexOf('throttl') >= 0 ||
            s.indexOf('limit exceeded') >= 0
        );
    }

    function processNextChunk() {
        if (chunkIndex >= issueChunks.length) {
            closeProgressModal();

            if (allErrors.length > 0) {
                alert('Some materials could not be issued:\n' + allErrors.join('\n'));
            }

            // Lock the inputs for this card, then refresh from server so
            // remaining/stock reflect the real post-issue state.
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
            return;
        }

        var displayTotal = issueChunks.length;
        btn.textContent = displayTotal > 1
            ? 'Issuing… (' + (chunkIndex + 1) + '/' + displayTotal + ')' : 'Issuing…';

        var pct = (chunkIndex / displayTotal) * 100;
        showProgressModal('Issuing to ' + sup.supervisorName,
            'Batch ' + (chunkIndex + 1) + ' of ' + displayTotal, pct);

        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'issueMaterials',
            http_method: 'POST',
            payload: {
                supervisorId: sup.supervisorId,
                issuesJson: JSON.stringify(issueChunks[chunkIndex]),
                // Vestigial 3rd arg — issueMaterials mints a fresh SIV-NNNNN per
                // chunk now. Creator Custom API args can't be removed, so send "".
                voucherIn: ''
            }
        }).then(function (response) {
            console.log('issue response chunk ' + chunkIndex + ':', response);
            var parsed;
            try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }

            // A Deluge-side rate-limit can also come back INSIDE the payload as
            // a DELUGE: error rather than a rejected promise. Treat that the
            // same — retry the chunk, don't record it as a permanent failure.
            var delugeThrottled = parsed && parsed.errors &&
                parsed.errors.some(function (e) { return isRateLimited({ message: e }); });
            if (delugeThrottled) {
                scheduleRetry({ message: parsed.errors.join(' ') });
                return;
            }

            if (parsed && parsed.errors && parsed.errors.length > 0) {
                allErrors = allErrors.concat(parsed.errors);
            }

            retryCount = 0;      // this chunk landed — reset for the next one
            chunkIndex++;
            // Small gap between chunks so a long run approaches the per-minute
            // API cap gradually instead of sprinting into it. Cheap insurance —
            // the retry path above is still the real safety net.
            setTimeout(processNextChunk, 400);

        }).catch(function (err) {
            if (isRateLimited(err)) {
                scheduleRetry(err);
                return;
            }
            abortRun(err);
        });
    }

    // Wait, then re-run the SAME chunk — chunkIndex is untouched, so the
    // handover resumes exactly where it stalled.
    function scheduleRetry(err) {
        if (retryCount >= RETRY_WAITS_MS.length) {
            abortRun(err);
            return;
        }
        var waitMs = RETRY_WAITS_MS[retryCount];
        retryCount++;
        console.warn('issueMaterials rate-limited on chunk ' + chunkIndex +
            '; retry ' + retryCount + '/' + RETRY_WAITS_MS.length +
            ' in ' + (waitMs / 1000) + 's', err);
        var displayTotal = issueChunks.length;
        btn.textContent = 'Rate-limited — retrying in ' + Math.round(waitMs / 1000) + 's…';
        showProgressModal('Issuing to ' + sup.supervisorName,
            'Batch ' + (chunkIndex + 1) + ' of ' + displayTotal +
            ' — paused (rate limit), retrying in ' + Math.round(waitMs / 1000) + 's',
            (chunkIndex / displayTotal) * 100);
        setTimeout(processNextChunk, waitMs);
    }

    function abortRun(err) {
        closeProgressModal();
        console.error('issueMaterials error on chunk ' + chunkIndex + ':', err);
        var batchNum = chunkIndex + 1;
        alert('Issue stopped at batch ' + batchNum + ' of ' + issueChunks.length + '.\n\n' +
            'Batches before this one went through. Press Issue again to send the rest — ' +
            'it will pick up where it stopped.');
        delete btn.dataset.busy;
        btn.disabled = false;
        btn.textContent = 'Issue to ' + sup.supervisorName;
        loadRequirements();
    }

    processNextChunk();
}

// ---- Load ----

// getStoreMaterialRequirements is now PAGED, and paged by MATERIAL
// REQUIREMENT ROW COUNT, not by plan count. A fixed plan-count page (tried
// first, at 30, then 20, then 10) was proven wrong by Execute, not merely
// suboptimal: statement cost tracks Material_Requirement rows, and rows per
// plan are arbitrary, so a fixed number of PLANS is not a fixed amount of
// WORK - two same-size pages differed by roughly 10x in real cost depending
// on which plans landed where, and pages that had worked at one size failed
// again at that same size once the order mix changed.
//
// So the function now walks plans one at a time (in small internal fetch
// batches) and stops itself once accumulated requirement rows cross its own
// budget - see getStoreMaterialRequirements.dg's header comment for the
// full reasoning. Because pages are variable-length, this widget can no
// longer compute "page N" on its own; the function returns
// {"plans":[...],"plansConsumed":N} and the cursor for the next call is
// simply skipCount + plansConsumed from the call just made.
// plansConsumed === 0 is the "no more pages" signal.
//
// The store person still needs to see EVERYONE they're owed at once - there
// is no supervisor picker on this screen and, per how this org actually
// assigns orders, one supervisor can hold the whole queue, so filtering by
// supervisor would not even bound the problem. So pages are fetched in the
// background and MERGED before render() ever runs, and the screen looks
// exactly as it did before paging existed - just assembled from several
// cheap calls instead of one that no longer completes.
//
// Merging is by supervisorId, not concatenation: two pages can both carry a
// block for the same supervisor (their plans just landed on different
// pages), and concatenating would draw two cards for one person and silently
// drop half his materials off whichever card the allocator runs on first.
function mergeRequirementPages(target, page) {
    for (var i = 0; i < page.length; i++) {
        var block = page[i];
        var existing = null;
        for (var j = 0; j < target.length; j++) {
            if (target[j].supervisorId === block.supervisorId) {
                existing = target[j];
                break;
            }
        }
        if (existing) {
            for (var m = 0; m < block.materials.length; m++) {
                var bm = block.materials[m];
                var existingMat = null;
                for (var n = 0; n < existing.materials.length; n++) {
                    var em = existing.materials[n];
                    if (em.materialId === bm.materialId &&
                        em.cutWidth === bm.cutWidth &&
                        em.cutLength === bm.cutLength &&
                        em.isReissue === bm.isReissue) {
                        existingMat = em;
                        break;
                    }
                }
                if (existingMat) {
                    existingMat.required = (existingMat.required || 0) + (bm.required || 0);
                    existingMat.issued = (existingMat.issued || 0) + (bm.issued || 0);
                    existingMat.remaining = (existingMat.remaining || 0) + (bm.remaining || 0);
                    
                    if (bm.lines) {
                        existingMat.lines = (existingMat.lines || []).concat(bm.lines);
                    }
                    if (existingMat.isFabric) {
                        existingMat.requiredPieces = (existingMat.requiredPieces || 0) + (bm.requiredPieces || 0);
                        existingMat.issuedPieces = (existingMat.issuedPieces || 0) + (bm.issuedPieces || 0);
                        existingMat.wasteIssuedPieces = (existingMat.wasteIssuedPieces || 0) + (bm.wasteIssuedPieces || 0);
                        existingMat.outstandingPieces = (existingMat.outstandingPieces || 0) + (bm.outstandingPieces || 0);
                        existingMat.freshMeters = (existingMat.freshMeters || 0) + (bm.freshMeters || 0);
                        existingMat.piecesCoveredByWaste = (existingMat.piecesCoveredByWaste || 0) + (bm.piecesCoveredByWaste || 0);
                        existingMat.freshPieces = (existingMat.freshPieces || 0) + (bm.freshPieces || 0);
                        existingMat.requiredTotal = (existingMat.requiredTotal || 0) + (bm.requiredTotal || 0);
                        if (bm.wastePicks && bm.wastePicks.length > 0) {
                            existingMat.wastePicks = (existingMat.wastePicks || []).concat(bm.wastePicks);
                        }
                    }
                } else {
                    existing.materials.push(bm);
                }
            }
        } else {
            target.push(block);
        }
    }
}

// PARALLEL PAGING. The old flow chained: each getStoreMaterialRequirements call
// needed the previous call's plansConsumed to know its own skipCount, so a
// supervisor holding a big backlog meant ~10 sequential round-trips.
//
// Now: one cheap getOpenPlanCount() up front, then fire ceil(count / PAGE_PLANS)
// windows AT ONCE, each with a fixed skipCount it can compute without waiting on
// anyone. getStoreMaterialRequirements gets a second arg (pagePlans) telling it
// to process exactly that window and not stop early. Wall time drops from N
// round-trips to ~2 (count, then all pages in flight together).
//
// mergeRequirementPages already reassembles overlapping supervisor blocks, so
// the render is identical to before — just assembled from parallel responses.
//
// FALLBACK: if getOpenPlanCount fails, or returns 0/garbage, fall straight back
// to the sequential chained walk (loadRequirementsSequential) — the proven path,
// still there, unchanged.
var REQ_PAGE_PLANS = 25;

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

    function done(merged) {
        console.log('merged requirements:', merged);
        refreshBtn.disabled = false;
        try {
            render(merged);
        } catch (e) {
            console.error('render failed:', e, merged);
            content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Could not read requirements</h2><p>Check the browser console for details.</p></div>';
        }
    }
    function fail(err) {
        console.error('loadRequirements error:', err);
        refreshBtn.disabled = false;
        content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Failed to load requirements</h2><p>Check the browser console for details.</p></div>';
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getOpenPlanCount',
        http_method: 'POST',
        payload: {}
    }).then(function (response) {
        var count = 0;
        try { count = (JSON.parse(response.result) || {}).count || 0; } catch (e) { count = 0; }

        if (!count || count < 0) {
            // Nothing open, or the count call gave us nothing usable — the
            // sequential walk handles both (it returns [] fast when empty).
            return loadRequirementsSequential(content, done, fail);
        }

        var pages = Math.ceil(count / REQ_PAGE_PLANS);
        var merged = [];
        var pending = pages;
        var failed = false;

        for (var p = 0; p < pages; p++) {
            (function (skip) {
                ZOHO.CREATOR.DATA.invokeCustomApi({
                    api_name: 'getStoreMaterialRequirements',
                    http_method: 'POST',
                    payload: {
                        skipCountTxt: String(skip),
                        pagePlansTxt: String(REQ_PAGE_PLANS)
                    }
                }).then(function (resp) {
                    if (failed) return;
                    var parsed = JSON.parse(resp.result);
                    mergeRequirementPages(merged, parsed.plans || []);
                    pending--;
                    if (pending === 0) done(merged);
                }).catch(function (err) {
                    if (failed) return;
                    failed = true;
                    // One window failed — fall back to the sequential walk from
                    // scratch rather than render a half-loaded screen.
                    console.warn('parallel page at skip ' + skip + ' failed, falling back to sequential', err);
                    loadRequirementsSequential(content, done, fail);
                });
            })(p * REQ_PAGE_PLANS);
        }
    }).catch(function (err) {
        console.warn('getOpenPlanCount failed, falling back to sequential paging', err);
        loadRequirementsSequential(content, done, fail);
    });
}

// THE ORIGINAL CHAINED WALK, kept as the fallback path. Each call's cursor is
// the previous call's skipCount + plansConsumed; plansConsumed === 0 ends it.
// Slower (sequential) but proven.
//
// pagePlansTxt is sent as "" — Creator Custom API arguments are all MANDATORY
// (no optional args), so every call must pass it; the empty string is what puts
// getStoreMaterialRequirements into its legacy chained mode.
function loadRequirementsSequential(content, done, fail) {
    var merged = [];
    var MAX_CALLS = 40; // safety cap - real stop is plansConsumed===0; this only guards a server bug looping forever

    function fetchPage(skipCount, callsSoFar) {
        if (callsSoFar >= MAX_CALLS) {
            console.error('loadRequirements: hit MAX_CALLS safety cap, stopping - server may not be advancing plansConsumed correctly');
            return;
        }
        return ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'getStoreMaterialRequirements',
            http_method: 'POST',
            payload: {
                skipCountTxt: String(skipCount),
                pagePlansTxt: ''
            }
        }).then(function (response) {
            var parsed = JSON.parse(response.result);
            mergeRequirementPages(merged, parsed.plans || []);

            var consumed = parsed.plansConsumed || 0;
            if (consumed > 0) {
                return fetchPage(skipCount + consumed, callsSoFar + 1);
            }
        });
    }

    fetchPage(0, 0).then(function () { done(merged); }).catch(fail);
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
// Listed in TAB-STRIP ORDER. A map, so this is readability only — nothing here
// decides where a tab appears; widget.html does, and the two are easier to keep
// honest when they read the same way down the page.
var TAB_LOADERS = {
    history: loadHistory,
    waste: loadWasteReceipt,
    disputes: loadDisputes,
    requests: loadRequests,
    materials: loadMaterials,
    stockin: loadStockIn,
    print: loadPrint
};

var tabsLoaded = {};

function showTab(name) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.toggle('is-active', p.id === 'panel-' + name);
    });

    if (name === 'materials') {
        EXPANDED_PATTERNS = {};
        if (MATERIALS_DATA) {
            renderMaterials();
        }
    }

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

function wasteRecvCartonId(i) {
    return 'wr-carton-' + i;
}

// WHICH CARTON HE HAS JUST PUT THEM IN.
//
// Captured here because this is the only moment anyone physically handles the
// pieces, and quoted back on the issue screen so the next person can walk to a
// box instead of searching a rack. A remnant whose carton nobody recorded is,
// for practical purposes, lost.
function wasteRecvCarton(i) {
    var box = document.getElementById(wasteRecvCartonId(i));
    return box ? String(box.value).trim() : '';
}

// Typing a carton fills the EMPTY ones below it. A rack of returns usually goes
// into one or two boxes, so typing it once and having the rest follow is the
// common case — and it only ever touches blanks, so nothing he has already
// written is overwritten.
function onWasteCartonInput(i) {
    var val = wasteRecvCarton(i);
    if (val === '') return;
    for (var j = i + 1; j < wastePending.length; j++) {
        var box = document.getElementById(wasteRecvCartonId(j));
        if (box && String(box.value).trim() === '') box.value = val;
    }
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
            // The lot it was cut from. It goes back to that lot, so the store
            // person is checking in a tone, not just a size — two identical
            // remnants of different lots must not read as the same thing.
            '<td class="col-lot">' +
            (p.lot
                ? '<span class="lot-id">' + escapeHtml(p.lot) + '</span>'
                : '<span class="w-lot-none">not recorded</span>') +
            '</td>' +
            // Always shown, in BOTH modes. The usual path is "all received as
            // declared" and it still has to say where they went — putting the
            // carton behind the edit toggle would mean it was only ever
            // recorded on the rows that went wrong.
            '<td class="col-carton">' +
            '<input type="text" class="carton-input" id="' + wasteRecvCartonId(i) + '" ' +
            'value="' + escapeHtml(p.carton || '') + '" ' +
            'placeholder="Carton" ' +
            'oninput="onWasteCartonInput(' + i + ')" />' +
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
        '<th class="col-lot">Lot</th>' +
        '<th class="col-carton">Carton</th>' +
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
            '<td class="col-num col-nowrap">' + fmt(p.length) + ' &times; ' + fmt(p.width) +
            '<span class="unit"> cm</span></td>' +
            '<td class="col-num col-strong">' + p.count +
            '<span class="unit"> pcs</span></td>' +
            '<td>' + (p.lot ? escapeHtml(p.lot) : '<span class="is-muted">&mdash;</span>') + '</td>' +
            '<td>' + (p.carton ? escapeHtml(p.carton) : '<span class="is-muted">&mdash;</span>') + '</td>' +
            '<td>' + escapeHtml(p.supervisor || '—') + '</td>' +
            '<td><span class="status-pill ' + st.cls + '">' +
            escapeHtml(st.text) + '</span></td>' +
            '<td class="col-nowrap">' + escapeHtml(p.declaredOn || '') + '</td>' +
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
        '<th class="col-num col-nowrap">Cut size (L &times; W)</th>' +
        '<th class="col-num">Pieces</th>' +
        '<th>Lot</th>' +
        '<th>Carton</th>' +
        '<th>From</th>' +
        '<th>Status</th>' +
        '<th class="col-nowrap">Declared</th>' +
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

    // Pieces going onto the rack have to say WHICH BOX. Required rather than
    // suggested, because a remnant nobody can find is worth the same as one that
    // was never returned — and the issue screen has nothing to quote without it.
    // Rows where nothing turned up are exempt: they go nowhere.
    var homeless = rows.filter(function (r) {
        return r.got > 0 && wasteRecvCarton(r.index) === '';
    });
    if (homeless.length > 0) {
        alert('Give a carton number for ' +
            (homeless.length === 1 ? 'the line' : 'all ' + homeless.length + ' lines') +
            ' you are taking in — it is how anyone finds these pieces again.');
        var first = document.getElementById(wasteRecvCartonId(homeless[0].index));
        if (first && first.focus) first.focus();
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
                    carton: wasteRecvCarton(r.index),
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
            '<td class="col-supervisor">' + escapeHtml(d.supervisor || '—') + '</td>' +
            '<td class="col-num">' + fmt(d.issued) + '<span class="unit">' + escapeHtml(d.unit || '') + '</span></td>' +
            '<td class="col-num">' + fmt(d.received) + '<span class="unit">' + escapeHtml(d.unit || '') + '</span></td>' +
            '<td class="col-num col-strong">' +
            '<span class="qty-big">' + fmt(d.remaining) +
            '<span class="unit">' + escapeHtml(d.unit || '') + '</span></span>' +
            (d.resolved > 0
                ? '<div class="qty-sub">' + fmt(d.resolved) + ' already settled</div>'
                : '') +
            '</td>' +
            '<td class="col-raised">' + escapeHtml(d.raisedOn || '—') + '</td>' +
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
        '<th class="col-supervisor">Supervisor</th>' +
        // Not "Issued"/"Received": on an inbound row the
        // supervisor is the one who handed over and the store
        // is the one who confirmed. A column has to mean the
        // same thing on every row of the table.
        '<th class="col-num">Handed over</th>' +
        '<th class="col-num">Confirmed</th>' +
        '<th class="col-num">Outstanding</th>' +
        '<th class="col-raised">Raised</th>' +
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
                // WHICH SHADE WENT OUT. Stamped on Issue_Lines as the cloth
                // crossed the counter — the requirement row holds metres and has
                // never held a lot, so this line is the only record of it.
                //
                // Beside the quantity, the same place the issue screen puts it,
                // because it qualifies the metres rather than the material.
                //
                // A dash on every non-fabric row and on any handover written
                // before lots existed. Lots exist for fabric alone, so an empty
                // cell here is the ordinary case for thread and labels, not a
                // gap — which is why it reads as a dash and not as blank.
                '<td>' + (l.lot
                    ? '<span class="hist-lot">' + escapeHtml(l.lot) + '</span>'
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
            '<th>Material</th><th>Cut piece size</th><th>Lot</th><th class="col-num">Qty issued</th>' +
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
        // The store person is standing at the rack with the cloth in their
        // hands when they want this — waiting on a webhook they cannot see is
        // the wrong shape. Pressing it is the same call the webhook makes.
        '<button type="button" class="ghost-btn" id="stockin-check" ' +
        'onclick="checkForArrivals()">Check for arrivals</button>' +
        '<span id="stockin-check-msg" class="stockin-check-msg"></span>' +
        '</div>' +
        '<div id="stockin-list">' + stockInListHtml() + '</div>';
}

// Asks Inventory for purchase receives it has not seen yet, then reloads the
// list so anything that landed is on screen without a manual refresh.
//
// It calls runPurchaseInflow, NOT syncPurchaseInflow — the wrapper takes the
// lock. Pressing this at the moment material arrives is exactly when the
// purchase-order webhook is also firing, and two runs applying the same receive
// line would credit the cloth twice.
function checkForArrivals() {
    var btn = document.getElementById('stockin-check');
    var msg = document.getElementById('stockin-check-msg');
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = 'Checking…';
    if (msg) {
        msg.textContent = '';
        msg.className = 'stockin-check-msg';
    }

    function done(text, cls) {
        btn.disabled = false;
        btn.textContent = 'Check for arrivals';
        if (msg) {
            msg.textContent = text;
            msg.className = 'stockin-check-msg' + (cls ? ' ' + cls : '');
        }
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'runPurchaseInflow',
        http_method: 'POST'
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('runPurchaseInflow parse failed:', e, response.result);
            done('Could not read the reply — check the console.', 'is-bad');
            return;
        }
        console.log('runPurchaseInflow:', parsed);

        if (!parsed.ran) {
            // runPurchaseInflow only reports this when it could not run the
            // sync at all, so it is a failure and not news. Nothing was
            // written, so there is nothing to redraw.
            done(parsed.reason || 'Did not run.', 'is-bad');
            return;
        }

        var r = parsed.result || {};
        if ((r.errors || []).length) {
            console.error('syncPurchaseInflow:', r.errors);
            done(r.errors[0], 'is-bad');
            return;
        }

        // The number that answers "did anything arrive" is what went to
        // Unallocated. Everything else is diagnostics and belongs in the
        // console, not on the counter.
        var landed = Number(r.netToUnallocated || 0);
        var other = Number(r.netToQuantity || 0);
        var parts = [];
        if (landed) parts.push(fmt(landed) + ' to unallocated');
        if (other) parts.push(fmt(other) + ' to accessory stock');

        if (parts.length) {
            done(parts.join(' · '), 'is-good');
        } else if (Number(r.unmappedLines || 0) > 0) {
            done(Number(r.unmappedLines) + ' arrived on an item that is not set up yet — see the console.', 'is-bad');
        } else {
            done('Nothing new.', 'is-muted');
        }

        loadStockIn();
    }).catch(function (err) {
        console.error('runPurchaseInflow error:', err);
        done('Failed to reach the server — check the console.', 'is-bad');
    });
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
    var allocMats = stockMats.filter(function (m) { return m.unallocated > 0; });
    if (!stockFilter) return allocMats;
    return allocMats.filter(function (m) {
        return (m.sku || '').toLowerCase().indexOf(stockFilter) !== -1 ||
            (m.material || '').toLowerCase().indexOf(stockFilter) !== -1;
    });
}

// Keyed on materialId, NEVER on list index. The index moves the moment the
// filter changes, so an open card would silently become a different material's.
function toggleStockCard(matId) {
    var card = document.getElementById('si-card-' + matId);
    if (card) {
        card.classList.toggle('open');
        stockOpenId = card.classList.contains('open') ? matId : null;
    }
}

function onStockLotChange(matId) {
    var sel = document.getElementById('si-lot-' + matId);
    var numWrap = document.getElementById('si-num-wrap-' + matId);
    if (!sel) return;
    // The number only means anything on a lot being CREATED. Topping up an
    // existing lot must not offer to renumber it from a screen that is about
    // incoming cloth — that is a different action with different rules.
    if (numWrap) numWrap.style.display = (sel.value === '') ? '' : 'none';
}

function stockInListHtml() {
    var list = stockInMatches();
    if (list.length === 0) {
        return '<div class="waste-none">No fabric matches that search.</div>';
    }

    return list.map(function (m) {
        var open = stockOpenId === m.materialId;

        var unallocBadge = '<div class="unalloc-badge">' + 
            '<span class="unalloc-val">' + fmt(m.unallocated) + '</span>' + 
            '<span class="unalloc-lbl">Unallocated</span>' +
            '</div>';

        return '' +
            '<div class="item-card' + (open ? ' open' : '') + '" id="si-card-' + m.materialId + '">' +
            '<div class="item-header" onclick="toggleStockCard(\'' + m.materialId + '\')">' +
            '<div class="item-header-info">' +
            '<h2>' + escapeHtml(m.material || m.sku || '—') + '</h2>' +
            '<div class="item-meta-line">' +
            '<span>' + escapeHtml(m.sku || '') + '</span>' +
            '<span>' + m.lotCount + (m.lotCount === 1 ? ' lot' : ' lots') + '</span>' +
            '<span>' + fmt(m.wash) + ' washed &middot; ' + fmt(m.unwash) + ' unwashed' +
            ((Number(m.inWash) || 0) > 0
                ? ' &middot; ' + fmt(m.inWash) + ' at wash' : '') + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="item-header-right">' +
            unallocBadge +
            '<span class="chevron" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
            'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
            '</span>' +
            '</div>' +
            '</div>' +
            stockCardBodyHtml(m) +
            '</div>';
    }).join('');
}

function stockCardBodyHtml(m) {
    var lots = m.lots || [];

    // The lot NUMBER is what is written on the roll and what he recognises it
    // by. The label is still on the form and still written by the migration; it
    // just does not earn a place on screen.
    var rows = lots.map(function (l) {
        return '' +
            '<tr>' +
            '<td class="material-name-cell">' +
            '<div class="mat-name">' + escapeHtml(l.lotNumber) + '</div>' +
            '</td>' +
            '<td class="col-num">' + fmt(l.wash) + '</td>' +
            '<td class="col-num">' + fmt(l.unwash) + '</td>' +
            '<td class="col-num">' + fmt(l.inWash) + '</td>' +
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
        '<th class="col-num">In wash</th>' +
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
                return '<option value="' + l.lotId + '">' + escapeHtml(l.lotNumber) + '</option>';
            }).join('');

    return '' +
        '<div class="item-body">' +
        '<div class="tables-container">' +
        lotTable +
        '<div class="stockin-form alloc-form">' +
        '<h3 class="alloc-title">Allocate Unallocated Quantity</h3>' +
        '<label class="si-field"><span>Select Existing Lot</span>' +
        '<select id="si-lot-' + m.materialId + '" class="note-input" ' +
        'onchange="onStockLotChange(\'' + m.materialId + '\')">' + opts + '</select>' +
        '</label>' +
        '<label class="si-field" id="si-num-wrap-' + m.materialId + '"><span>Or New Lot Number</span>' +
        '<input type="text" id="si-num-' + m.materialId + '" class="note-input" ' +
        'placeholder="Enter new lot number..." />' +
        '</label>' +
        '<label class="si-field"><span>Quantity to Allocate</span>' +
        '<input type="number" step="0.01" min="0" value="' + m.unallocated + '" id="si-qty-' + m.materialId + '" class="issue-input" readonly />' +
        '</label>' +
        '</div>' +
        '<div class="card-footer">' +
        '<span class="sel-count">Goes in as <b>unwashed</b>. Match it against the rack first &mdash; a new lot cannot be merged back later.</span>' +
        '<button type="button" class="primary-btn" id="si-btn-' + m.materialId + '" ' +
        'onclick="submitStockIn(\'' + m.materialId + '\')">Add to stock</button>' +
        '</div>' +
        '</div>' +
        '</div>';
}

function submitStockIn(matId) {
    var lotSel = document.getElementById('si-lot-' + matId);
    var numEl = document.getElementById('si-num-' + matId);
    var qtyEl = document.getElementById('si-qty-' + matId);
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
                // No label from this screen any more. The field still exists on
                // the form and the migration still writes it; nothing here does.
                lotLabel: '',
                qty: qty,
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

var MATERIALS_DATA = null;
var RAW_MATERIAL_FILTER = 'fabric'; // 'fabric' or 'other'
var EXPANDED_PATTERNS = {}; // grpName -> boolean
var EXPANDED_MATERIALS = {}; // materialId -> boolean
var MATERIAL_SEARCH_TERM = '';

// Helper to get base group name
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
    var panel = document.getElementById('panel-materials');
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
    var panel = document.getElementById('panel-materials');
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
                        '<td colspan="10" style="padding:10px 16px 16px 16px; border-bottom:1px solid var(--border);">' +
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
                '<th style="width:10%">SKU</th>' +
                '<th style="width:20%">Item Name</th>' +
                '<th style="width:10%">Type</th>' +
                '<th style="width:10%">Pattern</th>' +
                '<th style="width:8%">Color</th>' +
                '<th style="width:8%">Quality</th>' +
                '<th style="width:7%">Width</th>' +
                '<th style="width:7%">GSM</th>' +
                '<th class="r" style="width:7%">Wash Qty</th>' +
                '<th class="r" style="width:7%">Unwash Qty</th>' +
                '<th class="r" style="width:8%">Total Qty</th>' +
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
            if (matId) {
                EXPANDED_MATERIALS[matId] = !EXPANDED_MATERIALS[matId];
                renderMaterials();
            }
        });
    });
}

// ---- Print tab ----
//
// Plain cloth is cut into full-width pieces, sent to an outside printer, and
// comes back as a different SKU. This screen is the whole loop: send, receive,
// cancel.
//
// PRINTED STOCK IS PIECES, AND PIECES ARE NOT METRES. Five 3.00 m pieces are not
// 15 m: at a 55 cm cut each yields floor(300/55) = 5 rows and strands 25 cm, so
// 25 pieces against the 27 a continuous roll would give. That is why the send
// lines are typed as length x count and why this screen scores the tail — see
// docs/printing.md.
//
// The lot holds the truth and Raw_Material holds a maintained total; both move
// server-side in one pass, so nothing here computes a stock balance of its own.

// MIRRORS THE `Pattern` DROPDOWN ON Raw_Material IN CREATOR, and must be updated
// in the same pass as it — the same rule CLAUDE.md gives for adding a status to
// a function. Deluge cannot read a picklist's choices, so there is no way to
// fetch this.
//
// A pattern name is HALF OF A PRINTED SKU'S IDENTITY (the pair is Print_Base +
// Pattern), so choices are ADDED and never renamed. Renaming one orphans every
// printed SKU created under the old name.
//
// The select is built from the union of this list and every pattern already in
// use, so a pattern somebody added in Creator and forgot to add here still
// appears rather than silently vanishing from the screen.
var PRINT_PATTERNS = [];

var PRINT_DATA = null;
var printFilter = '';
var printOpenId = null;
var printJobOpenId = null;
var printLines = {};      // materialId -> [{len, count}]
var printRecvLines = {};  // jobId      -> [{len, count, state, carton}]

function loadPrint() {
    var panel = document.getElementById('panel-print');
    panel.innerHTML = '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getPrintData',
        http_method: 'GET'
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getPrintData parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the print data</h2><p>Check the browser console.</p></div>';
            return;
        }
        // Deluge returns its real message inside the payload — Creator would
        // otherwise surface every failure as a bare "code 9430".
        if (parsed.errors && parsed.errors.length) console.error('getPrintData:', parsed.errors);
        PRINT_DATA = parsed;
        renderPrint();
    }).catch(function (err) {
        console.error('getPrintData error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

// TWO BLOCKS, redrawn separately, and the search box is the reason. Rebuilding
// the input on every keystroke destroys the element the browser is focused on,
// so the caret jumps out after the first character. Only the list redraws.
function renderPrint() {
    var panel = document.getElementById('panel-print');
    panel.innerHTML =
        '<div id="print-jobs">' + printJobsHtml() + '</div>' +
        '<div class="search-bar-container">' +
            '<div class="search-input-wrapper">' +
                '<svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>' +
                '<input type="text" id="print-filter" class="professional-search" ' +
                    'placeholder="Search plain fabric by SKU or name…" oninput="onPrintFilter()" />' +
            '</div>' +
        '</div>' +
        '<div id="print-list">' + printListHtml() + '</div>';
}

function renderPrintList() {
    var box = document.getElementById('print-list');
    if (box) box.innerHTML = printListHtml();
}

function renderPrintJobs() {
    var box = document.getElementById('print-jobs');
    if (box) box.innerHTML = printJobsHtml();
}

// ARRIVING FROM A SHORT ISSUE ROW.
//
// The Issue tab prints a **Print…** button on a printed fabric row that has no
// printed stock while plain cloth sits on the rack (shortReasonFor, kind
// 'noPrinted'). PRINTING IS TO STOCK — no print job carries a plan — so the
// button cannot raise anything and does not try to. Its whole job is to put him
// in front of the send form for the right plain material, which is the one thing
// the row knows and the Print tab would otherwise make him search for.
//
// It goes through showTab and printOpenId, which is the tab's OWN idea of which
// card is open, rather than a second selection path. A card opened any other way
// is one printListHtml closes again the next time it redraws.
function openPrintForBase(baseId) {
    printOpenId = String(baseId || '');
    // The search box filters the same list. A stale filter left in place would
    // hide the card that was just asked for, and an empty tab reads as the button
    // being broken.
    printFilter = '';
    showTab('print');
    // First open: showTab loads the tab and renderPrint draws the card open on
    // its own, because printOpenId is already set. Already open: showTab
    // re-fetches nothing, so nothing would redraw and the card would stay shut.
    if (PRINT_DATA) renderPrint();
    var card = document.getElementById('print-list-card-' + printOpenId);
    if (card) {
        card.classList.add('open');
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    }
}

function onPrintFilter() {
    var el = document.getElementById('print-filter');
    printFilter = el ? el.value.trim().toLowerCase() : '';
    renderPrintList();
}

// Keyed on id, NEVER on list index. The index moves the moment the filter
// changes, so an open card would silently become a different material's.
function togglePrintCard(matId) {
    var card = document.getElementById('print-list-card-' + matId);
    if (!card) return;
    var opening = !card.classList.contains('open');

    document.querySelectorAll('#print-list .item-card.open').forEach(function (c) {
        c.classList.remove('open');
    });

    if (opening) {
        card.classList.add('open');
        requestAnimationFrame(function () {
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
}

function togglePrintJob(jobId) {
    var card = document.getElementById('print-job-card-' + jobId);
    if (!card) return;
    var opening = !card.classList.contains('open');

    document.querySelectorAll('#print-jobs .item-card.open').forEach(function (c) {
        c.classList.remove('open');
    });

    if (opening) {
        card.classList.add('open');
        requestAnimationFrame(function () {
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
}

function printJobById(jobId) {
    var found = null;
    ((PRINT_DATA && PRINT_DATA.jobs) || []).forEach(function (j) {
        if (String(j.jobId) === String(jobId)) found = j;
    });
    return found;
}

function printMaterialById(matId) {
    var found = null;
    ((PRINT_DATA && PRINT_DATA.printed) || []).forEach(function (m) {
        if (String(m.id) === String(matId)) found = m;
    });
    return found;
}

// ---- At the printer ----

function printJobsHtml() {
    var jobs = (PRINT_DATA && PRINT_DATA.jobs) || [];
    if (!jobs.length) {
        return '<div class="waste-none">Nothing is at the printer.</div>';
    }

    // Initialize all receive lines so we can safely render their bodies
    jobs.forEach(function (j) {
        if (!printRecvLines[j.jobId]) {
            printRecvLines[j.jobId] = (j.lines || []).map(function (l) {
                return {
                    len: l.lengthCm,
                    sent: Number(l.count) || 0,
                    count: l.count,
                    state: (j.sourceState) || 'Wash',
                    carton: ''
                };
            });
        }
    });

    return jobs.map(function (j) {
        var open = String(printJobOpenId) === String(j.jobId);
        var pieces = (j.lines || []).reduce(function (a, l) { return a + (Number(l.count) || 0); }, 0);

        return '' +
            '<div class="item-card' + (open ? ' open' : '') + '" id="print-job-card-' + j.jobId + '">' +
                '<div class="item-header" onclick="togglePrintJob(\'' + j.jobId + '\')">' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(j.printedName || j.printedSku || '—') + '</h2>' +
                        '<div class="item-meta-line">' +
                            '<span>' + escapeHtml(j.printerName || 'printer not named') + '</span>' +
                            '<span>' + pieces + (pieces === 1 ? ' piece' : ' pieces') +
                                ' &middot; ' + fmt(j.metresSent) + ' Mtr</span>' +
                            '<span>from ' + escapeHtml(j.plainName || j.plainSku || '—') +
                                ' &middot; lot ' + escapeHtml(j.plainLotNumber || '—') +
                                ' &middot; ' + escapeHtml(j.sourceState === 'Unwash' ? 'unwashed' : 'washed') + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="item-header-right">' +
                        '<span class="status-pill status-warning">Sent ' + escapeHtml(j.sentOn || '') + '</span>' +
                        '<span class="chevron" aria-hidden="true">' +
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
                        '</span>' +
                    '</div>' +
                '</div>' +
                printReceiveFormHtml(j) +
            '</div>';
    }).join('');
}

function printReceiveFormHtml(job) {
    var mat = printMaterialById(job.printedMaterialId);
    var lots = (mat && mat.lots || []).filter(function (l) { return !l.blocked; });

    // The lot NUMBER is what is written on the cloth and what he recognises it
    // by. TYPED, never derived from the job — no rule we invent would match what
    // is on the roll.
    var opts = '<option value="">+ New lot</option>' +
        lots.map(function (l) {
            return '<option value="' + l.lotId + '">' + escapeHtml(l.lotNumber) + '</option>';
        }).join('');

    // The width the pieces are stamped with, disabled. This is the figure
    // receiveFromPrint writes into Fabric_Piece.Piece_Width_Cm, copied from the
    // printed SKU — which itself copied it from the plain cloth when the material
    // was minted. Showing it is what lets him catch a printer who returned
    // something narrower, which is the one thing that breaks the full-width
    // premise and cannot be detected later.
    var rWidth = mat ? Number(mat.widthCm) || 0 : 0;
    var rwCell = '<td><input type="number" class="issue-input" disabled ' +
                 'value="' + escapeHtml(fmt(rWidth)) + '" /></td>';

    // THE ROWS ARE THE SEND LINES, FIXED. Length and width are both disabled —
    // a piece comes back the length it left, so the only decision is how many of
    // each size arrived. The gap is whole pieces the printer lost or ruined, and
    // it is stated on the row rather than left to be worked out from two numbers.
    var rows = (printRecvLines[job.jobId] || []).map(function (r, i) {
        var sent = Number(r.sent) || 0;
        var got = Number(r.count) || 0;
        var short = sent - got;

        return '' +
            '<tr>' +
                '<td><input type="number" class="issue-input" disabled ' +
                    'value="' + escapeHtml(r.len) + '" /></td>' +
                rwCell +
                '<td class="col-num print-derived">' + sent + '</td>' +
                '<td><input type="number" step="1" min="0" max="' + sent + '" class="issue-input" ' +
                    'id="pr-cnt-' + job.jobId + '-' + i + '" value="' + escapeHtml(r.count) + '" ' +
                    'oninput="onRecvLineChange(\'' + job.jobId + '\')" /></td>' +
                '<td class="col-num' + (short > 0 ? ' recv-short' : ' print-derived') + '">' +
                    (short > 0 ? short : '—') + '</td>' +
                '<td><select class="note-input" id="pr-st-' + job.jobId + '-' + i + '" ' +
                        'onchange="onRecvLineChange(\'' + job.jobId + '\')">' +
                        '<option value="Wash"' + (r.state === 'Wash' ? ' selected' : '') + '>Washed</option>' +
                        '<option value="Unwash"' + (r.state === 'Unwash' ? ' selected' : '') + '>Unwashed</option>' +
                    '</select></td>' +
                '<td><input type="text" class="note-input" id="pr-car-' + job.jobId + '-' + i + '" ' +
                    'value="' + escapeHtml(r.carton) + '" placeholder="C-12" ' +
                    'oninput="onRecvLineChange(\'' + job.jobId + '\')" /></td>' +
            '</tr>';
    }).join('');

    return '' +
        '<div class="item-body">' +
            '<div class="print-form">' +
                '<label class="si-field"><span>Lot</span>' +
                    '<select id="pr-lot-' + job.jobId + '" class="note-input" ' +
                        'onchange="onRecvLotChange(\'' + job.jobId + '\')">' + opts + '</select>' +
                '</label>' +
                '<label class="si-field" id="pr-num-wrap-' + job.jobId + '"><span>Lot number</span>' +
                    '<input type="text" id="pr-num-' + job.jobId + '" class="note-input" ' +
                        'placeholder="as written on the cloth" />' +
                '</label>' +
            '</div>' +
            '<div class="table-wrapper"><table>' +
                '<thead><tr>' +
                    '<th class="col-num">Piece length (cm)</th>' +
                    '<th class="col-num">Width (cm)</th>' +
                    '<th class="col-num">Sent</th>' +
                    '<th class="col-num">Came back</th>' +
                    '<th class="col-num">Lost</th>' +
                    '<th>State</th>' +
                    '<th>Carton</th>' +
                '</tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
            '</table></div>' +
            // No "+ Another size" and no Remove. The sizes are whatever went to
            // the printer; nothing can come back that did not go out.
            '<div class="card-footer" id="pr-foot-' + job.jobId + '">' + recvFooterHtml(job) + '</div>' +
        '</div>';
}

// THE LOSS IS WHOLE PIECES, and it is said in pieces first. The length cannot
// change — it is not an input — so every missing metre is a piece that did not
// come back, and "3 pieces short" is what he can take to the printer. The metres
// follow as the consequence.
function recvFooterHtml(job) {
    var returned = recvMetres(job.jobId);
    var loss = Math.round(((Number(job.metresSent) || 0) - returned) * 100) / 100;
    var lost = recvPiecesLost(job.jobId);

    return '' +
        '<span class="sel-count' + (lost > 0 ? ' is-short' : '') + '">' +
            (lost > 0
                ? '<b>' + lost + (lost === 1 ? ' piece' : ' pieces') + ' short</b> &mdash; ' +
                  fmt(loss) + ' Mtr written off'
                : 'All ' + recvPiecesBack(job.jobId) + ' pieces back &middot; ' + fmt(returned) + ' Mtr') +
        '</span>' +
        '<button type="button" class="primary-btn is-danger" id="pr-cancel-' + job.jobId + '" ' +
            'onclick="submitCancelJob(\'' + job.jobId + '\')">Came back unprinted</button>' +
        '<button type="button" class="primary-btn" id="pr-btn-' + job.jobId + '" ' +
            'onclick="submitReceivePrint(\'' + job.jobId + '\')">Receive</button>';
}

// The length is no longer read back from the DOM — it is not an input. It stays
// on the state object exactly as the job sent it, which is what makes the
// returned metres impossible to inflate from this screen.
function readRecvLines(jobId) {
    var out = [];
    (printRecvLines[jobId] || []).forEach(function (r, i) {
        var c = document.getElementById('pr-cnt-' + jobId + '-' + i);
        var s = document.getElementById('pr-st-' + jobId + '-' + i);
        var k = document.getElementById('pr-car-' + jobId + '-' + i);
        out.push({
            len: r.len,
            sent: r.sent,
            count: c ? c.value : r.count,
            state: s ? s.value : r.state,
            carton: k ? k.value : r.carton
        });
    });
    return out;
}

function recvPiecesBack(jobId) {
    var t = 0;
    (printRecvLines[jobId] || []).forEach(function (r) { t += Number(r.count) || 0; });
    return t;
}

function recvPiecesLost(jobId) {
    var t = 0;
    (printRecvLines[jobId] || []).forEach(function (r) {
        t += Math.max(0, (Number(r.sent) || 0) - (Number(r.count) || 0));
    });
    return t;
}

// Same trap as the send form: re-rendering the job cards on every keystroke
// destroys the input being typed in, and the caret leaves after one character.
// Only the footer is rewritten, and it holds no input.
function onRecvLineChange(jobId) {
    printRecvLines[jobId] = readRecvLines(jobId);

    var job = printJobById(jobId);
    if (!job) return;
    var foot = document.getElementById('pr-foot-' + jobId);
    if (foot) foot.innerHTML = recvFooterHtml(job);
}

// addRecvLine and removeRecvLine are gone. The rows ARE the send lines and
// nothing can come back that did not go out — adding a size would be claiming
// cloth the printer was never given.

function onRecvLotChange(jobId) {
    var sel = document.getElementById('pr-lot-' + jobId);
    var wrap = document.getElementById('pr-num-wrap-' + jobId);
    // The number only means anything on a lot being CREATED. Topping up an
    // existing one must not offer to renumber it.
    if (sel && wrap) wrap.style.display = (sel.value === '') ? '' : 'none';
}

function recvMetres(jobId) {
    var t = 0;
    (printRecvLines[jobId] || []).forEach(function (r) {
        var len = Number(r.len) || 0, c = Number(r.count) || 0;
        if (len > 0 && c > 0) t += (len * c) / 100;
    });
    return Math.round(t * 100) / 100;
}

// ---- Send to print ----

// ONLY FABRIC THAT IS ACTUALLY IN A LOT. Cloth with no lot has no tone, and
// cloth with no tone cannot be sent anywhere — the send form would have an empty
// lot select and the Send button would refuse. A row he can never act on is
// noise on a screen whose whole job is "what can go to the printer today".
//
// Filtered here rather than in getPrintData so the payload stays a plain
// statement of what exists; this screen decides what is worth showing.
function printPlainMatches() {
    var list = ((PRINT_DATA && PRINT_DATA.plain) || []).filter(function (m) {
        return (m.lots || []).length > 0;
    });
    if (!printFilter) return list;
    return list.filter(function (m) {
        return (m.sku || '').toLowerCase().indexOf(printFilter) !== -1 ||
               (m.name || '').toLowerCase().indexOf(printFilter) !== -1;
    });
}

function printListHtml() {
    var list = printPlainMatches();
    if (!list.length) {
        return '<div class="waste-none">No plain fabric matches that search.</div>';
    }

    // Initialize all lines so we can safely render their bodies
    list.forEach(function (m) {
        if (!printLines[m.id]) printLines[m.id] = [{ len: '', count: '' }];
    });

    return list.map(function (m) {
        var open = String(printOpenId) === String(m.id);
        var lots = m.lots || [];
        var wash = lots.reduce(function (a, l) { return a + (Number(l.wash) || 0); }, 0);
        var unwash = lots.reduce(function (a, l) { return a + (Number(l.unwash) || 0); }, 0);
        var inPrint = lots.reduce(function (a, l) { return a + (Number(l.inPrint) || 0); }, 0);

        var pillHtml = (inPrint > 0) ? '<span class="status-pill status-warning">' + fmt(inPrint) + ' at the printer</span>' : '';

        return '' +
            '<div class="item-card' + (open ? ' open' : '') + '" id="print-list-card-' + m.id + '">' +
                '<div class="item-header" onclick="togglePrintCard(\'' + m.id + '\')">' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(m.name || m.sku || '—') + '</h2>' +
                        '<div class="item-meta-line">' +
                            '<span>' + escapeHtml(m.sku || '') + '</span>' +
                            '<span>' + fmt(m.widthCm) + ' cm wide</span>' +
                            '<span>' + fmt(wash) + ' washed &middot; ' + fmt(unwash) + ' unwashed</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="item-header-right">' +
                        pillHtml +
                        '<span class="chevron" aria-hidden="true">' +
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
                        '</span>' +
                    '</div>' +
                '</div>' +
                printSendFormHtml(m) +
            '</div>';
    }).join('');
}

// Every pattern this material could be printed in, from three sources unioned:
//
//   1. `patterns` off the server — every Pattern value actually sitting on a
//      material. This is the one that works on day one, and it is why the select
//      is not empty before anybody has maintained anything.
//   2. the printed SKUs' own patterns, which are a subset of (1) but cost
//      nothing and keep working if the server payload is ever trimmed.
//   3. PRINT_PATTERNS, for a choice that exists in the Creator dropdown but no
//      material carries yet — the only case the server cannot see.
//
// MINUS THE MATERIAL'S OWN PATTERN. Grey Sheeting / Plain / Grey is already
// "Plain"; offering to print it in Plain would mint a nonsense SKU.
function patternsFor(m) {
    var seen = {};
    var out = [];
    var own = String((m && m.pattern) || '').trim().toLowerCase();
    if (own) seen[own] = true;

    function take(p) {
        var k = String(p || '').trim();
        if (k && !seen[k.toLowerCase()]) { seen[k.toLowerCase()] = true; out.push(k); }
    }

    ((PRINT_DATA && PRINT_DATA.patterns) || []).forEach(take);
    ((PRINT_DATA && PRINT_DATA.printed) || []).forEach(function (p) { take(p.pattern); });
    PRINT_PATTERNS.forEach(take);

    out.sort();
    return out;
}

// The printed SKU is identified by the PAIR (Print_Base, Pattern). Resolving it
// here is what lets the screen say "this goes into RM-00112" rather than
// "something will happen" — and say so BEFORE he sends, because minting a
// material is permanent master data.
function printedFor(baseId, pattern) {
    var found = null;
    var want = String(pattern || '').trim().toLowerCase();
    ((PRINT_DATA && PRINT_DATA.printed) || []).forEach(function (m) {
        if (String(m.baseId) === String(baseId) &&
            String(m.pattern || '').trim().toLowerCase() === want) found = m;
    });
    return found;
}

function printSendFormHtml(m) {
    var lots = (m.lots || []);

    var lotRows = lots.map(function (l) {
        return '' +
            '<tr>' +
                '<td class="material-name-cell"><div class="mat-name">' + escapeHtml(l.lotNumber) + '</div></td>' +
                '<td class="col-num">' + fmt(l.wash) + '</td>' +
                '<td class="col-num">' + fmt(l.unwash) + '</td>' +
                '<td class="col-num">' + fmt(l.inPrint) + '</td>' +
                '<td>' + (l.blocked
                    ? '<span class="status-pill status-danger">Blocked</span>'
                    : '<span class="status-pill status-sufficient">Active</span>') + '</td>' +
            '</tr>';
    }).join('');

    var lotTable = lots.length === 0
        ? '<div class="waste-none">No lots on this fabric yet &mdash; nothing to send.</div>'
        : '<div class="table-wrapper"><table>' +
              '<thead><tr><th>Lot</th><th class="col-num">Washed</th><th class="col-num">Unwashed</th>' +
              '<th class="col-num">At printer</th><th>Status</th></tr></thead>' +
              '<tbody>' + lotRows + '</tbody></table></div>';

    // A blocked lot is quarantined cloth. sendToPrint refuses one anyway; this
    // keeps the screen and the server saying the same thing.
    var lotOpts = lots.filter(function (l) { return !l.blocked; })
        .map(function (l) {
            return '<option value="' + l.lotId + '">' + escapeHtml(l.lotNumber) + '</option>';
        }).join('');

    var pats = patternsFor(m);
    var patOpts = pats.length
        ? '<option value="">Choose a pattern…</option>' +
          pats.map(function (p) {
              return '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>';
          }).join('')
        // An empty select reads as a broken screen and he presses Send and gets
        // nothing. Say which of the two things is wrong instead.
        : '<option value="">No patterns on record</option>';

    var printerOpts = '<option value="">Choose a printer…</option>' +
        ((PRINT_DATA && PRINT_DATA.printers) || []).map(function (p) {
            return '<option value="' + p.id + '">' + escapeHtml(p.name) + '</option>';
        }).join('');

    return '' +
        '<div class="item-body">' +
            lotTable +
            '<div class="print-form">' +
                '<label class="si-field"><span>Lot</span>' +
                    '<select id="ps-lot-' + m.id + '" class="note-input" onchange="refreshSendTotals(\'' + m.id + '\')">' +
                        lotOpts + '</select></label>' +
                '<label class="si-field"><span>Send</span>' +
                    '<select id="ps-state-' + m.id + '" class="note-input" onchange="refreshSendTotals(\'' + m.id + '\')">' +
                        '<option value="Wash">Washed</option>' +
                        '<option value="Unwash">Unwashed</option>' +
                    '</select></label>' +
                '<label class="si-field"><span>Pattern</span>' +
                    '<select id="ps-pat-' + m.id + '" class="note-input" onchange="onSendPatternChange(\'' + m.id + '\')">' +
                        patOpts + '</select></label>' +
                '<label class="si-field"><span>Printer</span>' +
                    '<select id="ps-printer-' + m.id + '" class="note-input">' + printerOpts + '</select></label>' +
                // WHAT LEAVES THE LOT, computed, never typed. He is cutting
                // pieces, not measuring metres, so the figure that actually
                // moves stock is a consequence of the lines below and he must be
                // able to read it before he presses Send.
                '<label class="si-field"><span>Fabric used (Mtr)</span>' +
                    '<input type="number" class="issue-input" disabled ' +
                        'id="ps-total-' + m.id + '" value="' + fmt(sendMetres(m.id)) + '" /></label>' +
            '</div>' +
            '<div id="ps-sku-' + m.id + '">' + printSkuNoteHtml(m) + '</div>' +
            '<div id="ps-lines-' + m.id + '">' + printLinesHtml(m) + '</div>' +
        '</div>';
}

// WHICH SKU THIS BECOMES, said before he sends. A pattern that has never been
// printed on this fabric mints a new material, and that is permanent master
// data — it is never done silently.
function printSkuNoteHtml(m) {
    var patEl = document.getElementById('ps-pat-' + m.id);
    var pat = patEl ? patEl.value : '';
    if (!pat) return '';

    var hit = printedFor(m.id, pat);
    if (hit) {
        return '<div class="sel-count">Goes into <b>' + escapeHtml(hit.sku) + '</b> &mdash; ' +
               escapeHtml(hit.name) + '.</div>';
    }
    return '<div class="sel-count is-short">' + escapeHtml(m.name) + ' has never been printed in ' +
           escapeHtml(pat) + '. Sending this <b>creates a new material</b> with the next free ' +
           'RM- number, ' + fmt(m.widthCm) + ' cm wide like the plain cloth.</div>';
}

// ONE ROW PER PIECE SIZE. He is cutting full-width pieces off the roll and the
// only thing that varies is how long each one is, so the line is a length and a
// count — nothing else is his to decide here.
//
// NO CUT-LENGTH SCORING. An earlier version asked for the cut length the printed
// cloth would eventually be panelled at and scored each line's marker rows and
// leftover tail against it. It was wrong twice over: printing is TO STOCK, so at
// send time there is no cut length — that cloth may serve several garments at
// different panel sizes — and the piece length is fixed by the printer's table
// anyway, so the number it was advising on was not a choice. The real yield is
// computed at ISSUE, per piece, where it is a fact instead of a guess. Do not
// put it back.
function printLinesHtml(m) {
    var lines = printLines[m.id] || [];

    // WIDTH IS SHOWN AND DISABLED, on every line. Every piece is the full width
    // of the roll — that is the premise the whole design rests on, and a figure
    // he can read is what makes it checkable against the cloth in front of him.
    // Disabled rather than absent because a missing column reads as a thing the
    // screen forgot; disabled reads as a thing that is not his to change.
    //
    // Length before width, per the app's display rule: sizes are always shown
    // L x W however the fields are named underneath.
    var wCell = '<td><input type="number" class="issue-input" disabled ' +
                'value="' + escapeHtml(fmt(m.widthCm)) + '" /></td>';

    var rows = lines.map(function (r, i) {
        var len = Number(r.len) || 0, cnt = Number(r.count) || 0;

        return '' +
            '<tr>' +
                '<td><input type="number" step="1" min="1" class="issue-input" ' +
                    'id="ps-len-' + m.id + '-' + i + '" value="' + escapeHtml(r.len) + '" ' +
                    'oninput="refreshSendTotals(\'' + m.id + '\')" /></td>' +
                wCell +
                '<td><input type="number" step="1" min="0" class="issue-input" ' +
                    'id="ps-cnt-' + m.id + '-' + i + '" value="' + escapeHtml(r.count) + '" ' +
                    'oninput="refreshSendTotals(\'' + m.id + '\')" /></td>' +
                '<td class="col-num print-derived" id="ps-mtr-' + m.id + '-' + i + '">' +
                    lineMetresText(r) + '</td>' +
                '<td><button type="button" class="raise-btn is-stale" ' +
                    'onclick="removeSendLine(\'' + m.id + '\',' + i + ')">Remove</button></td>' +
            '</tr>';
    }).join('');

    var total = sendMetres(m.id);
    var avail = sendAvailable(m);
    var over = total > avail + 0.0001;

    return '' +
        '<div class="table-wrapper"><table>' +
            '<thead><tr>' +
                '<th class="col-num">Piece length (cm)</th>' +
                '<th class="col-num">Width (cm)</th>' +
                '<th class="col-num">How many</th>' +
                '<th class="col-num">Metres</th>' +
                '<th></th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
        '<button type="button" class="raise-btn" onclick="addSendLine(\'' + m.id + '\')">+ Another size</button>' +
        '<div class="card-footer" id="ps-foot-' + m.id + '">' + sendFooterHtml(m) + '</div>';
}

function lineMetresText(r) {
    var len = Number(r.len) || 0, cnt = Number(r.count) || 0;
    return (len > 0 && cnt > 0) ? fmt((len * cnt) / 100) + ' Mtr' : '—';
}

// The lot's side of the sum, and the over-draw check. The metres THIS send uses
// live in the "Fabric used" box up in the form — printing the same figure twice
// on one card is the fault this project has already recorded twice.
function sendFooterHtml(m) {
    var over = sendMetres(m.id) > sendAvailable(m) + 0.0001;
    return '' +
        '<span class="sel-count' + (over ? ' is-short' : '') + '">' +
            fmt(sendAvailable(m)) + ' Mtr available on that lot' +
            (over ? ' &mdash; <b>this is more than it holds</b>' : '') +
        '</span>' +
        '<button type="button" class="primary-btn" id="ps-btn-' + m.id + '" ' +
            'onclick="submitSendToPrint(\'' + m.id + '\')">Send to print</button>';
}

function readSendLines(matId) {
    var out = [];
    (printLines[matId] || []).forEach(function (r, i) {
        var l = document.getElementById('ps-len-' + matId + '-' + i);
        var c = document.getElementById('ps-cnt-' + matId + '-' + i);
        out.push({ len: l ? l.value : r.len, count: c ? c.value : r.count });
    });
    return out;
}

// TYPING MUST NOT REBUILD THE INPUT BEING TYPED IN.
//
// This used to re-render the whole lines block on every keystroke, which
// destroys the element the browser is focused on — the caret jumps out after
// one character and he cannot type a two-digit number. The Stock In tab carries
// the same warning above its search box; the same trap, one screen over.
//
// So nothing here touches innerHTML on anything containing an input. Only the
// three derived things are written, and each is addressed by id: the per-line
// metres cell, the "Fabric used" box, and the footer.
function refreshSendTotals(matId) {
    printLines[matId] = readSendLines(matId);

    var mat = null;
    ((PRINT_DATA && PRINT_DATA.plain) || []).forEach(function (m) {
        if (String(m.id) === String(matId)) mat = m;
    });
    if (!mat) return;

    printLines[matId].forEach(function (r, i) {
        var cell = document.getElementById('ps-mtr-' + matId + '-' + i);
        if (cell) cell.textContent = lineMetresText(r);
    });

    var totalBox = document.getElementById('ps-total-' + matId);
    if (totalBox) totalBox.value = fmt(sendMetres(matId));

    // The footer holds no input, so replacing it cannot steal focus.
    var foot = document.getElementById('ps-foot-' + matId);
    if (foot) foot.innerHTML = sendFooterHtml(mat);
}

// The pattern select is the one control that changes something other than the
// arithmetic — which SKU this becomes, or whether it mints a new one.
function onSendPatternChange(matId) {
    var mat = null;
    ((PRINT_DATA && PRINT_DATA.plain) || []).forEach(function (m) {
        if (String(m.id) === String(matId)) mat = m;
    });
    if (!mat) return;
    var skuBox = document.getElementById('ps-sku-' + matId);
    if (skuBox) skuBox.innerHTML = printSkuNoteHtml(mat);
}

// Adding or removing a line genuinely changes the structure, so the table is
// rebuilt — and that is safe, because a button press is not a caret in a field.
function onSendChange(matId) {
    printLines[matId] = readSendLines(matId);

    var mat = null;
    ((PRINT_DATA && PRINT_DATA.plain) || []).forEach(function (m) {
        if (String(m.id) === String(matId)) mat = m;
    });
    if (!mat) return;

    var skuBox = document.getElementById('ps-sku-' + matId);
    if (skuBox) skuBox.innerHTML = printSkuNoteHtml(mat);
    var linesBox = document.getElementById('ps-lines-' + matId);
    if (linesBox) linesBox.innerHTML = printLinesHtml(mat);

    var totalBox = document.getElementById('ps-total-' + matId);
    if (totalBox) totalBox.value = fmt(sendMetres(matId));
}

function addSendLine(matId) {
    printLines[matId] = readSendLines(matId);
    printLines[matId].push({ len: '', count: '' });
    onSendChange(matId);
}

function removeSendLine(matId, idx) {
    var rows = readSendLines(matId);
    rows.splice(idx, 1);
    if (!rows.length) rows.push({ len: '', count: '' });
    printLines[matId] = rows;
    onSendChange(matId);
}

function sendMetres(matId) {
    var t = 0;
    (printLines[matId] || []).forEach(function (r) {
        var len = Number(r.len) || 0, c = Number(r.count) || 0;
        if (len > 0 && c > 0) t += (len * c) / 100;
    });
    return Math.round(t * 100) / 100;
}

// What the CHOSEN counter of the CHOSEN lot holds. Not the material's total:
// cloth in the other state, or on another lot, cannot serve this send.
function sendAvailable(m) {
    var lotEl = document.getElementById('ps-lot-' + m.id);
    var stEl = document.getElementById('ps-state-' + m.id);
    if (!lotEl) return 0;
    var lot = null;
    (m.lots || []).forEach(function (l) {
        if (String(l.lotId) === String(lotEl.value)) lot = l;
    });
    if (!lot) return 0;
    var st = stEl ? stEl.value : 'Wash';
    return Number(st === 'Unwash' ? lot.unwash : lot.wash) || 0;
}

function submitSendToPrint(matId) {
    var mat = null;
    ((PRINT_DATA && PRINT_DATA.plain) || []).forEach(function (m) {
        if (String(m.id) === String(matId)) mat = m;
    });
    if (!mat) return;

    var lotEl = document.getElementById('ps-lot-' + matId);
    var stEl = document.getElementById('ps-state-' + matId);
    var patEl = document.getElementById('ps-pat-' + matId);
    var prEl = document.getElementById('ps-printer-' + matId);
    var btn = document.getElementById('ps-btn-' + matId);
    if (!btn) return;

    if (!lotEl || !lotEl.value) { alert('Choose which lot the cloth comes off.'); return; }
    if (!patEl || !patEl.value) { alert('Choose the pattern it is being printed in.'); return; }
    if (!prEl || !prEl.value) { alert('Choose which printer it is going to.'); return; }

    var lines = [];
    var bad = '';
    readSendLines(matId).forEach(function (r) {
        var len = Number(r.len) || 0, c = Number(r.count) || 0;
        if (!r.len && !r.count) return;
        if (len <= 0) { bad = 'Every line needs a piece length in cm.'; return; }
        if (c <= 0 || c !== Math.floor(c)) { bad = 'Every line needs a whole number of pieces.'; return; }
        lines.push({ lengthCm: len, count: c });
    });
    if (bad) { alert(bad); return; }
    if (!lines.length) { alert('Add at least one line — how long the pieces are and how many.'); return; }

    // Checked here as well as on the server. The server is the one that counts —
    // a Custom API is callable from anywhere — but catching it before the round
    // trip tells him while he is looking at the lot it overdrew.
    if (sendMetres(matId) > sendAvailable(mat) + 0.0001) {
        alert('That is more cloth than the lot holds in that state.');
        return;
    }

    var hit = printedFor(matId, patEl.value);
    if (!hit && !confirm(mat.name + ' has never been printed in ' + patEl.value +
                         '.\n\nSending this creates a new material with a new SKU. Continue?')) {
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Sending…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'sendToPrint',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                plainMaterialId: matId,
                plainLotId: lotEl.value,
                sourceState: stEl ? stEl.value : 'Wash',
                pattern: patEl.value,
                printedMaterialId: hit ? hit.id : '',
                printerId: prEl.value,
                lines: lines,
                remarks: ''
            })
        }
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }

        if (!parsed || !parsed.success) {
            alert('Could not send it: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
            btn.textContent = 'Send to print';
            return;
        }

        if (parsed.minted) {
            alert('Created ' + parsed.printedSku + ' — ' + parsed.printedName + '.');
        }

        // Refetched rather than patched by hand. The lot balance and the parent
        // total both moved, and a card patched from the response would be a
        // second opinion about stock.
        printLines[matId] = [{ len: '', count: '' }];
        printOpenId = null;
        loadPrint();
    }).catch(function (err) {
        console.error('sendToPrint error:', err);
        alert('Failed to send it. Check the browser console.');
        btn.disabled = false;
        btn.textContent = 'Send to print';
    });
}

function submitReceivePrint(jobId) {
    var job = printJobById(jobId);
    if (!job) return;

    var lotSel = document.getElementById('pr-lot-' + jobId);
    var numEl = document.getElementById('pr-num-' + jobId);
    var btn = document.getElementById('pr-btn-' + jobId);
    if (!btn) return;

    var creating = !lotSel || lotSel.value === '';
    var lotNum = numEl ? numEl.value.trim() : '';
    if (creating && lotNum === '') {
        alert('Give the new lot a number — whatever is written on the cloth.');
        return;
    }

    // Upper-cased, so "p1" cannot slip in beside "P1" and read on screen as a
    // different lot when it is not.
    if (creating) {
        var mat = printMaterialById(job.printedMaterialId);
        var taken = (mat && mat.lots || []).some(function (l) {
            return String(l.lotNumber || '').trim().toUpperCase() === lotNum.toUpperCase();
        });
        if (taken) { alert('That material already has a lot ' + lotNum + '.'); return; }
    }

    // EVERY SENT LINE IS SENT BACK, including the ones that came back as
    // nothing — a zero is the record that the size was checked and none of it
    // arrived. `lineIndex` is what the server matches on; it takes the LENGTH
    // from its own Send_Lines, so nothing this screen sends can inflate the
    // metres received.
    var lines = [];
    var bad = '';
    readRecvLines(jobId).forEach(function (r, i) {
        var sent = Number(r.sent) || 0;
        var c = Number(r.count) || 0;

        if (c !== Math.floor(c) || c < 0) {
            bad = 'Pieces back must be a whole number, or zero.';
            return;
        }
        if (c > sent) {
            bad = 'Only ' + sent + ' pieces of ' + r.len + ' cm went out — ' + c + ' cannot come back.';
            return;
        }
        // The carton is required only where pieces actually arrived. A size that
        // came back as nothing sits on no shelf, and stamping it with a box would
        // send the next person to an empty one — the same rule the waste receipt
        // applies to a row the store found none of.
        if (c > 0 && !String(r.carton || '').trim()) {
            bad = 'Every size that came back needs a carton — which box it went into.';
            return;
        }
        lines.push({
            lineIndex: i,
            lengthCm: Number(r.len) || 0,
            count: c,
            state: r.state,
            carton: String(r.carton || '').trim()
        });
    });
    if (bad) { alert(bad); return; }
    if (!lines.length) {
        alert('Nothing to receive. If it came back unprinted, use "Came back unprinted".');
        return;
    }

    var lostPieces = recvPiecesLost(jobId);
    if (lostPieces > 0 &&
        !confirm(lostPieces + (lostPieces === 1 ? ' piece' : ' pieces') +
                 ' did not come back.\n\nThat cloth is written off against ' +
                 (job.plainName || 'the plain material') + ' and cannot be put back. Continue?')) {
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Receiving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'receiveFromPrint',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                jobId: jobId,
                lotId: creating ? '' : lotSel.value,
                lotNumber: lotNum,
                lotLabel: '',
                lines: lines,
                remarks: ''
            })
        }
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }

        if (!parsed || !parsed.success) {
            alert('Could not receive it: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
            btn.textContent = 'Receive';
            return;
        }

        if ((Number(parsed.piecesLost) || 0) > 0) {
            alert(parsed.piecesLost + ' of ' + parsed.piecesSent + ' pieces did not come back — ' +
                  fmt(parsed.loss) + ' Mtr. Recorded on the job.');
        }

        delete printRecvLines[jobId];
        printJobOpenId = null;
        loadPrint();
    }).catch(function (err) {
        console.error('receiveFromPrint error:', err);
        alert('Failed to receive it. Check the browser console.');
        btn.disabled = false;
        btn.textContent = 'Receive';
    });
}

function submitCancelJob(jobId) {
    var job = printJobById(jobId);
    if (!job) return;

    if (!confirm('Put ' + fmt(job.metresSent) + ' Mtr back on lot ' + (job.plainLotNumber || '') +
                 ' as ' + (job.sourceState === 'Unwash' ? 'unwashed' : 'washed') +
                 ' cloth?\n\nUse this only if it came back unprinted.')) {
        return;
    }
    var reason = prompt('Why did it come back unprinted?', '');
    if (reason === null) return;

    var btn = document.getElementById('pr-cancel-' + jobId);
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'cancelPrintJob',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({ jobId: jobId, reason: reason })
        }
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }

        if (!parsed || !parsed.success) {
            alert('Could not cancel it: ' + ((parsed && parsed.error) || 'unknown error'));
            if (btn) { btn.disabled = false; btn.textContent = 'Came back unprinted'; }
            return;
        }
        delete printRecvLines[jobId];
        printJobOpenId = null;
        loadPrint();
    }).catch(function (err) {
        console.error('cancelPrintJob error:', err);
        alert('Failed to cancel it. Check the browser console.');
        if (btn) { btn.disabled = false; btn.textContent = 'Came back unprinted'; }
    });
}

// Boot. Issue is the home tab, so it is loaded here rather than lazily.
setTodayLabel();
loadRequirements();
loadCounts();
