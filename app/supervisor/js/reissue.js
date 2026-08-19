// Material damage reporting, and the Reissue tab it feeds.
//
// Loaded after receive.js (escapeHtml/fmt/round2) and after production.js, whose
// item card looks up openDamageDialog by name.
//
// TWO SCREENS, ONE IDEA:
//
//   Report damage  — he says what he ruined and what he wants replaced. Writes a
//                    DRAFT. Nothing reaches the store.
//   Reissue tab    — every draft still waiting, grouped by item. He ticks what
//                    he wants now and raises it. THAT is what creates demand.
//
// The split is the whole point. Damage is recorded the moment it happens, while
// he remembers what went wrong; asking the store is a separate decision he makes
// when it suits him. Raising on report would have flooded the store with
// one-line requests all day.
//
// THE TAB HAS A SECOND SOURCE and it is the same idea from the other end. When
// the checker rejects garments, saveItemCheck opens a remake batch and asks the
// store for nothing; the batch turns up here as a card. It used to raise the
// material itself, which meant an inspector three rooms away could commit the
// supervisor to a handover he had not asked for and could not see coming.
// Nothing reaches the store on this tab until he presses the button.

var reissueItems = [];
var damageCtx = null;

// ---- Damage reason options ----
//
// Shown in the Report damage modal as a mandatory dropdown. High-level
// reason — the detail goes into the "What happened?" note.
var DAMAGE_REASONS = [
    'Store person sent damaged material',
    'Store person sent wrong material',
    'Cutting mistake',
    'Stitching / sewing mistake',
    'Printing / embroidery mistake',
    'Pressing / ironing damage',
    'Handling damage',
    'Machine malfunction',
    'Other'
];

// ---- Shared modal shell ----
//
// Its own element rather than supModalEl(): the damage dialog can be opened from
// the Production tab while the Reissue tab already has a modal of its own, and
// two screens sharing one node means whichever closes last wins.

function damageModalEl() {
    var el = document.getElementById('damage-modal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'damage-modal';
        el.className = 'exc-modal hidden';
        document.body.appendChild(el);
    }
    return el;
}

function closeDamageDialog() {
    damageModalEl().classList.add('hidden');
    damageCtx = null;
}

// ---- Report damage ----

// Step 1. How many pieces' worth. The material list cannot be proposed until he
// says this, because fabric is issued in whole marker rows — 3 pieces at 2 per
// row is 2 rows, not three twenty-firsts of eleven. Only the server knows that,
// which is why the list is fetched rather than scaled here.
//
// TWO WAYS IN, and they are not the same conversation:
//
//   opts absent  — he pressed Report damage on the item. Nothing is known yet,
//                  so the count starts at 1 and he types what happened.
//   opts present — a stage just ended with fewer pieces out than in. The count
//                  is already known, the stage is already known, and the screen
//                  says so instead of asking him to re-enter what the system
//                  watched him do.
//
// opts: { pieces, phaseName, stageLogId }
function openDamageDialog(plan, item, opts) {
    var o = opts || {};
    var fromStage = Number(o.pieces) > 0;

    damageCtx = {
        plan: plan,
        item: item,
        materials: [],
        phaseName: o.phaseName || '',
        stageLogId: o.stageLogId || ''
    };

    var el = damageModalEl();
    el.classList.remove('hidden');
    el.innerHTML =
        '<div class="exc-panel exc-panel-wide">' +
        '<h3>' + (fromStage ? 'Pieces did not come through' : 'Report damage') + '</h3>' +
        '<p class="exc-sub">' + escapeHtml(item.name || '') +
        (item.sku ? ' &middot; ' + escapeHtml(item.sku) : '') +
        (o.phaseName ? ' &middot; ' + escapeHtml(o.phaseName) : '') + '</p>' +

        (fromStage
            // Says what it already knows rather than asking. He can still
            // change the number — the stage figure is what came out, and how
            // many were RUINED is a different question: some may simply be
            // sitting unfinished on the bench.
            ? '<div class="dmg-lead">' +
            '<b>' + o.pieces + '</b> fewer piece' + (o.pieces === 1 ? '' : 's') +
            ' came out of ' + escapeHtml(o.phaseName || 'this stage') +
            ' than went in. What material went with them?' +
            '</div>'
            : '') +

        '<div class="dmg-step">' +
        '<label for="dmg-pieces">How many pieces were spoiled?</label>' +
        '<input type="number" id="dmg-pieces" min="0" step="1" value="' +
        (fromStage ? o.pieces : 1) + '">' +
        // A label torn while being attached ruins no garment. Saying so
        // here stops him typing 1 to get past the box and inventing a
        // piece loss that never happened.
        '<p class="exc-hint">Put <b>0</b> if no garment was spoiled &mdash; ' +
        'a torn label or a snapped thread still costs material.</p>' +
        '</div>' +

        // THE REMAKE DECISION, separate from the material one.
        //
        // He cannot wait for the cloth — a reissue takes days — so the good
        // pieces carry on and finish, and ticking this opens a second batch
        // for the replacements that runs whenever the material turns up.
        // Without it the order simply ends short.
        //
        // Only meaningful when a garment was actually spoiled: a torn label
        // ruins no piece, so there is nothing to make again.
        '<div class="dmg-step" id="dmg-remake-wrap">' +
        '<label class="dmg-check">' +
        '<input type="checkbox" id="dmg-remake" checked>' +
        '<span>These pieces need making again</span>' +
        '</label>' +
        '<p class="exc-hint">A second batch is opened for them straight away. ' +
        'The pieces you already have carry on and finish without waiting.</p>' +
        '</div>' +

        '<div id="dmg-mats"></div>' +

        '<div class="exc-foot">' +
        '<button type="button" class="primary-btn" id="dmg-next">Choose materials</button>' +
        '</div>' +
        '</div>';

    document.getElementById('dmg-next').addEventListener('click', function () {
        loadDamageProposal();
    });

    var pcsEl = document.getElementById('dmg-pieces');
    var syncRemake = function () {
        var wrap = document.getElementById('dmg-remake-wrap');
        var box = document.getElementById('dmg-remake');
        if (!wrap || !box) return;
        var n = Number(pcsEl ? pcsEl.value : 0) || 0;
        // Hidden rather than disabled at zero: there is nothing to decide, and a
        // greyed-out tick invites him to wonder what he is missing.
        wrap.style.display = n > 0 ? '' : 'none';
        if (n <= 0) box.checked = false;
    };
    if (pcsEl) pcsEl.addEventListener('input', syncRemake);
    syncRemake();
}

function loadDamageProposal() {
    if (!damageCtx) return;

    var elP = document.getElementById('dmg-pieces');
    var pieces = elP ? Number(elP.value) : 0;
    if (isNaN(pieces) || pieces < 0) {
        alert('Pieces spoiled must be zero or more.');
        return;
    }

    // Zero pieces still needs a quantity to cost the proposal from, so it is
    // worked out for one. He edits every figure anyway.
    var forQty = pieces > 0 ? pieces : 1;

    var box = document.getElementById('dmg-mats');
    box.innerHTML = '<div class="panel-loading">Working out the material…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getDamageProposal',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                planItemId: String(damageCtx.item.id),
                qty: String(forQty)
            })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getDamageProposal parse failed:', e, response.result);
            box.innerHTML = '<p class="exc-error">Could not read the reply from Creator.</p>';
            return;
        }
        if (parsed.errors && parsed.errors.length > 0) {
            box.innerHTML = '<p class="exc-error">' + escapeHtml(parsed.errors.join(' · ')) + '</p>';
            return;
        }
        damageCtx.materials = parsed.materials || [];
        damageCtx.pieces = pieces;
        renderDamageProposal();
    }).catch(function (err) {
        console.error('getDamageProposal error:', err);
        box.innerHTML = '<p class="exc-error">Could not reach Creator.</p>';
    });
}

// The quantity a given number of spoiled pieces costs, for ONE material.
//
// MIRRORS buildItemRequirements EXACTLY, deliberately — same floor, same ceil,
// same divide by 100:
//
//   fabric      rows  = ceil(pieces / piecesPerRow)
//               qty   = rows * cutLength / 100
//   everything  qty   = perUnit * pieces
//   else
//
// Fabric is NOT linear, which is why the rate alone is not enough to send: 3
// pieces at 2 per row is 2 rows, not 1.5. Scaling the metres instead of the rows
// is the single easiest way to get this wrong.
//
// A mirrored copy is justified here and nowhere else in this flow, because this
// number is a DEFAULT he sees and may overwrite. What gets stored is whatever is
// in the box when he saves, so a drift between the two shows up as a slightly
// odd starting figure — never as a wrong record. The server stays the only
// writer of real requirements.
function damageQtyFor(m, pieces) {
    var p = Number(pieces) || 0;
    if (p <= 0) return 0;

    if (m.isFab === true) {
        var perRow = Number(m.perRow) || 0;
        var cutLen = Number(m.cutLen) || 0;
        // Left at zero deliberately: a visibly empty quantity gets questioned, a
        // silently wrong one does not. Same rule the server applies when a cut
        // size or fabric width is missing.
        if (perRow <= 0 || cutLen <= 0) return 0;
        return round2((Math.ceil(p / perRow) * cutLen) / 100);
    }

    return round2((Number(m.perUnit) || 0) * p);
}

// Recompute one row's quantity from its own spoiled count.
function syncDamageRow(i) {
    if (!damageCtx) return;
    var m = damageCtx.materials[i];
    var pcsEl = document.querySelector('#damage-modal .dmg-pcs[data-i="' + i + '"]');
    var qtyEl = document.querySelector('#damage-modal .dmg-qty[data-i="' + i + '"]');
    if (!m || !pcsEl || !qtyEl) return;
    qtyEl.value = damageQtyFor(m, pcsEl.value);
}

// Step 2. The proposal, fully editable.
//
// EVERY row carries its own spoiled count, including non-fabric. He may ruin one
// cushion cover and three labels in the same incident — one count for the whole
// screen would force him to pick which of those to under-report.
//
// Every line arrives TICKED with the computed quantity, because the common case
// is "these pieces are gone, I need them again". Untick is a real answer, not a
// cancel — "3 were ruined, I have spares" is recorded as damage with no reissue,
// which is what keeps the consumption figure honest. Setting a quantity to 0
// drops the line entirely.
function renderDamageProposal() {
    var box = document.getElementById('dmg-mats');
    if (!box || !damageCtx) return;

    if (damageCtx.materials.length === 0) {
        box.innerHTML = '<p class="exc-hint">This item has no material on its BOM, ' +
            'so there is nothing to reissue. The pieces will still be recorded.</p>' +
            noteFieldHtml();
        wireDamageSave();
        return;
    }

    // The count each row starts on: what he said at the top. Per-row from here
    // on — the header only seeds them.
    var seed = damageCtx.pieces > 0 ? damageCtx.pieces : 1;

    var rows = damageCtx.materials.map(function (m, i) {
        return '<tr>' +
            '<td class="col-tick">' +
            '<input type="checkbox" class="dmg-use" data-i="' + i + '" checked>' +
            '</td>' +
            '<td class="material-name-cell">' +
            '<div class="mat-name">' + escapeHtml(m.name || '') + '</div>' +
            (m.sku ? '<div class="mat-sku">' + escapeHtml(m.sku) + '</div>' : '') +
            '</td>' +
            '<td class="col-num">' +
            '<input type="number" class="dmg-pcs" data-i="' + i + '" min="0" step="1" value="' + seed + '">' +
            '</td>' +
            // Still editable. The spoiled count is the quick way to fill this
            // in, not a replacement for it — a part-used cone or a length he
            // measured himself is a number only he knows.
            '<td class="col-num">' +
            '<input type="number" class="dmg-qty" data-i="' + i + '" min="0" step="0.01" value="' +
            damageQtyFor(m, seed) + '">' +
            '<span class="dmg-unit">' + escapeHtml(m.unit || '') + '</span>' +
            '</td>' +
            '</tr>';
    }).join('');

    box.innerHTML =
        '<div class="section-title">What was used up</div>' +
        '<p class="exc-hint">Type how many pieces of each material were spoiled and the ' +
        'quantity works itself out &mdash; overwrite it if you need to. ' +
        'Untick anything you already have spares of; it is still recorded as damaged.</p>' +
        '<div class="table-wrapper dmg-lines">' +
        '<table>' +
        '<thead><tr>' +
        '<th class="col-tick">Reissue</th>' +
        '<th>Material</th>' +
        '<th class="col-num">Pieces spoiled</th>' +
        '<th class="col-num">Quantity</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '</div>' +
        noteFieldHtml();

    // 'input' rather than 'change' so the quantity moves as he types, which is
    // the whole point — 'change' waits for the field to lose focus and he would
    // be looking at a stale figure while deciding whether to correct it.
    document.querySelectorAll('#damage-modal .dmg-pcs').forEach(function (el) {
        el.addEventListener('input', function () {
            syncDamageRow(Number(el.getAttribute('data-i')));
        });
    });

    // Changing the headline count re-seeds every row. Rows he has already
    // adjusted are overwritten, which is the right way round: he is restating
    // the size of the incident, and the per-row numbers were derived from the
    // old figure.
    var headEl = document.getElementById('dmg-pieces');
    if (headEl) {
        headEl.addEventListener('input', function () {
            var n = Number(headEl.value);
            if (isNaN(n) || n < 0) return;
            damageCtx.pieces = n;
            var v = n > 0 ? n : 1;
            document.querySelectorAll('#damage-modal .dmg-pcs').forEach(function (el) {
                el.value = v;
                syncDamageRow(Number(el.getAttribute('data-i')));
            });
        });
    }

    wireDamageSave();
}

function noteFieldHtml() {
    var opts = DAMAGE_REASONS.map(function (r) {
        return '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>';
    }).join('');

    return '<div class="dmg-step">' +
        '<label for="dmg-reason">Reason for damage <span class="dmg-req">*</span></label>' +
        '<select id="dmg-reason" class="sup-select">' +
        '<option value="">-- Select a reason --</option>' +
        opts +
        '</select>' +
        '</div>' +
        '<div class="dmg-step">' +
        '<label for="dmg-note">What happened? <span class="dmg-req">*</span></label>' +
        '<textarea id="dmg-note" rows="2" placeholder="printer smudged, unreadable"></textarea>' +
        '</div>';
}

function wireDamageSave() {
    var foot = document.querySelector('#damage-modal .exc-foot');
    if (!foot) return;
    foot.innerHTML =
        '<button type="button" class="primary-btn" id="dmg-save">Save to Reissue</button>';
    document.getElementById('dmg-save').addEventListener('click', saveDamage);
}

function saveDamage() {
    if (!damageCtx) return;

    var lines = [];
    document.querySelectorAll('#damage-modal .dmg-qty').forEach(function (inp) {
        var i = Number(inp.getAttribute('data-i'));
        var m = damageCtx.materials[i];
        if (!m) return;

        var qty = Number(inp.value) || 0;
        var pcsEl = document.querySelector('#damage-modal .dmg-pcs[data-i="' + i + '"]');
        var pcs = pcsEl ? Number(pcsEl.value) || 0 : 0;
        var useEl = document.querySelector('#damage-modal .dmg-use[data-i="' + i + '"]');

        // Pieces are only meaningful on fabric — that is what Required_Pieces
        // means on the requirement this becomes, and it is what the offcut
        // allocator counts in. A cone of thread has a quantity, not a piece
        // count, so its spoiled figure has done its job once the quantity is
        // worked out and must not be stored as pieces.
        if (m.isFab !== true) pcs = 0;

        // Zeroed out means "none of this was damaged" — a true statement, and a
        // different one from unticking, which means "damaged but I have spares".
        if (qty <= 0 && pcs <= 0) return;

        lines.push({
            matId: String(m.matId),
            name: m.name || '',
            unit: m.unit || '',
            isFab: m.isFab === true,
            qty: qty,
            pieces: pcs,
            cutLen: Number(m.cutLen) || 0,
            cutWid: Number(m.cutWid) || 0,
            reissue: useEl ? useEl.checked : false
        });
    });

    var pieces = damageCtx.pieces || 0;
    if (lines.length === 0 && pieces <= 0) {
        alert('Nothing to record \u2014 set a quantity, or say how many pieces were spoiled.');
        return;
    }

    var reasonEl = document.getElementById('dmg-reason');
    var reason = reasonEl ? reasonEl.value.trim() : '';
    if (!reason) {
        alert('Please select a reason for the damage.');
        if (reasonEl) reasonEl.focus();
        return;
    }

    var noteEl = document.getElementById('dmg-note');
    var noteText = noteEl ? noteEl.value.trim() : '';
    if (!noteText) {
        alert('Please describe what happened.');
        if (noteEl) noteEl.focus();
        return;
    }

    var btn = document.getElementById('dmg-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'saveMaterialDamage',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                planId: String(damageCtx.plan.id),
                planItemId: String(damageCtx.item.id),
                supervisorId: String(currentSupervisorId()),
                // Both empty when he opened this from the item card rather than
                // from a stage that ended short — which is honest: there is no
                // stage to blame for a label he tore at the bench.
                stageLogId: String(damageCtx.stageLogId || ''),
                phaseName: String(damageCtx.phaseName || ''),
                damagedPieces: String(pieces),
                needsRemake: (function () {
                    var b = document.getElementById('dmg-remake');
                    return pieces > 0 && b ? b.checked : false;
                })(),
                reason: reason,
                note: noteText,
                lines: lines
            })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('saveMaterialDamage parse failed:', e, response.result);
            alert('Could not read the reply from Creator.');
            if (btn) { btn.disabled = false; btn.textContent = 'Save to Reissue'; }
            return;
        }
        // What the server actually received and did. The remake batch is created
        // server-side, so when one fails to appear this is the only place that
        // can say whether the flag arrived, whether the pieces arrived, and
        // whether a batch came back.
        console.log('saveMaterialDamage ->', parsed);

        if (!parsed.success) {
            alert(parsed.error || 'Could not save.');
            if (btn) { btn.disabled = false; btn.textContent = 'Save to Reissue'; }
            return;
        }
        closeDamageDialog();
        // The tab is reloaded rather than patched — it may not have been opened
        // yet, and a stale flag would show him yesterday's list when it is.
        tabsLoaded.reissue = false;
        if (typeof loadSupCounts === 'function') loadSupCounts();
        if (activeTab() === 'reissue') {
            tabsLoaded.reissue = true;
            loadReissue();
        }
    }).catch(function (err) {
        console.error('saveMaterialDamage error:', err);
        alert('Could not reach Creator.');
        if (btn) { btn.disabled = false; btn.textContent = 'Save to Reissue'; }
    });
}

// ---- Reissue tab ----

function loadReissue() {
    var panel = document.getElementById('panel-reissue');
    var supId = currentSupervisorId();

    if (!supId) {
        panel.innerHTML = '<div class="panel-placeholder"><h2>Choose a supervisor</h2>' +
            '<p>Pick who you are from the header to see what is waiting to be reissued.</p></div>';
        return;
    }

    panel.innerHTML = '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getReissueDrafts',
        http_method: 'POST',
        payload: { supervisorId: String(supId) }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getReissueDrafts parse failed:', e, response.result);
            panel.innerHTML = '<p class="exc-error">Could not read the reply from Creator.</p>';
            return;
        }
        if (parsed.errors && parsed.errors.length > 0) {
            panel.innerHTML = '<p class="exc-error">' + escapeHtml(parsed.errors.join(' · ')) + '</p>';
            return;
        }
        reissueItems = parsed.items || [];
        renderReissue();
    }).catch(function (err) {
        console.error('getReissueDrafts error:', err);
        panel.innerHTML = '<p class="exc-error">Could not reach Creator.</p>';
    });
}

// TWO KINDS OF CARD, and the difference is whether there is anything to decide.
//
//   damage — one card per ITEM, not per damage report. He decides per item —
//            "for this order and this item, what do I want back" — and a single
//            item can collect damage from several stages on several days. Three
//            cards for one item would make him raise three requests the store
//            then has to reconcile. Every line has a tick, because "3 were
//            ruined but I have spares" is a real answer.
//
//   remake — the checker rejected garments and a batch was opened for them.
//            The batch needs its whole BOM again; there is no per-material
//            decision to make, so there are no ticks and no per-line "why" —
//            one reason covers the card and it sits in the header. The
//            quantities are the server's, worked out from the BOM, and are shown
//            rather than offered for editing.
function renderReissue() {
    var panel = document.getElementById('panel-reissue');

    setTabCount('count-reissue', reissueItems.length);

    if (reissueItems.length === 0) {
        panel.innerHTML = '<div class="empty-state">' +
            '<h2>Nothing waiting</h2>' +
            '<p>Damage you report on the Production tab, and batches the checker sends back ' +
            'for remaking, collect here until you ask the store for the material.</p>' +
            '</div>';
        return;
    }

    panel.innerHTML = reissueItems.map(function (it, idx) {
        return it.kind === 'remake' ? remakeCardHtml(it, idx) : damageCardHtml(it, idx);
    }).join('');

    panel.querySelectorAll('.ri-raise').forEach(function (btn) {
        btn.addEventListener('click', function () {
            raiseReissue(Number(btn.getAttribute('data-item')), btn);
        });
    });
}

function damageCardHtml(it, idx) {
    var rows = (it.lines || []).map(function (l, li) {
        var isFab = l.isFab === true;
        return '<tr>' +
            '<td class="col-tick">' +
            '<input type="checkbox" class="ri-pick" data-item="' + idx + '" data-line="' + li + '" checked>' +
            '</td>' +
            '<td class="material-name-cell">' +
            '<div class="mat-name">' + escapeHtml(l.name || '') + '</div>' +
            (l.sku ? '<div class="mat-sku">' + escapeHtml(l.sku) + '</div>' : '') +
            '</td>' +
            '<td class="col-num">' +
            (isFab && Number(l.pieces) > 0
                ? fmt(l.pieces)
                : '<span class="is-muted">&mdash;</span>') +
            '</td>' +
            '<td class="col-num col-strong">' + fmt(l.qty) + ' ' + escapeHtml(l.unit || '') + '</td>' +
            // The note is the store's only answer to "why am I issuing this
            // again". It travels onto the requirement too, so they see it
            // without opening anything.
            '<td class="ri-why">' +
            (l.phase ? '<span class="ri-phase">' + escapeHtml(l.phase) + '</span> ' : '') +
            escapeHtml(l.note || '') +
            '<div class="ri-when">' + escapeHtml(l.reportedOn || '') + '</div>' +
            '</td>' +
            '</tr>';
    }).join('');

    return '<div class="item-card ri-card">' +
        '<div class="ri-head">' +
        '<div>' +
        '<h2>' + escapeHtml(it.item || 'Item') + '</h2>' +
        '<div class="ri-sub">' + escapeHtml(it.salesOrder || '') + '</div>' +
        '</div>' +
        '<button type="button" class="primary-btn ri-raise" data-item="' + idx + '">' +
        'Ask the store' +
        '</button>' +
        '</div>' +
        '<div class="table-wrapper">' +
        '<table>' +
        '<thead><tr>' +
        '<th class="col-tick">Ask</th>' +
        '<th>Material</th>' +
        '<th class="col-num">Pieces</th>' +
        '<th class="col-num">Quantity</th>' +
        '<th>Why</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '</div>' +
        '</div>';
}

function remakeCardHtml(it, idx) {
    // The date and the round are the same for every line — they came from one
    // check — so they are said once in the header rather than repeated down a
    // column that would read identically on every row.
    var when = ((it.lines || [])[0] || {}).reportedOn || '';
    var qty = Number(it.qty) || 0;

    var rows = (it.lines || []).map(function (l) {
        var isFab = l.isFab === true;
        return '<tr>' +
            '<td class="material-name-cell">' +
            '<div class="mat-name">' + escapeHtml(l.name || '') + '</div>' +
            (l.sku ? '<div class="mat-sku">' + escapeHtml(l.sku) + '</div>' : '') +
            '</td>' +
            '<td class="col-num">' +
            (isFab && Number(l.pieces) > 0
                ? fmt(l.pieces)
                : '<span class="is-muted">&mdash;</span>') +
            '</td>' +
            '<td class="col-num col-strong">' + fmt(l.qty) + ' ' + escapeHtml(l.unit || '') + '</td>' +
            '</tr>';
    }).join('');

    return '<div class="item-card ri-card ri-remake">' +
        '<div class="ri-head">' +
        '<div>' +
        '<h2>' + escapeHtml(it.item || 'Item') + '</h2>' +
        '<div class="ri-sub">' + escapeHtml(it.salesOrder || '') + '</div>' +
        '</div>' +
        '<button type="button" class="primary-btn ri-raise" data-item="' + idx + '">' +
        'Ask the store' +
        '</button>' +
        '</div>' +

        // Says what happened and what it commits him to. Nothing has reached the
        // store yet and the batch cannot start until it does, which is the one
        // thing he needs to know before pressing the button.
        '<div class="ri-remake-why">' +
        '<b>' + fmt(qty) + '</b> piece' + (qty === 1 ? '' : 's') + ' failed checking' +
        (it.round ? ' in round ' + escapeHtml(String(it.round)) : '') +
        (when ? ' on ' + escapeHtml(when) : '') +
        '. This is the material to make them again &mdash; the store has not been asked for it yet.' +
        '</div>' +

        '<div class="table-wrapper">' +
        '<table>' +
        '<thead><tr>' +
        '<th>Material</th>' +
        '<th class="col-num">Pieces</th>' +
        '<th class="col-num">Quantity</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '</div>' +
        '</div>';
}

function raiseReissue(idx, btn) {
    var it = reissueItems[idx];
    if (!it) return;

    // A remake card is raised whole: the batch needs its whole BOM and the
    // quantities are the server's, so there is nothing to send but which batch.
    var body = {
        planItemId: String(it.planItemId),
        supervisorId: String(currentSupervisorId())
    };

    if (it.kind === 'remake') {
        body.kind = 'remake';
    } else {
        var picked = [];
        document.querySelectorAll('.ri-pick[data-item="' + idx + '"]').forEach(function (cb) {
            if (!cb.checked) return;
            var l = (it.lines || [])[Number(cb.getAttribute('data-line'))];
            if (l) picked.push({ damageId: String(l.damageId), lineId: String(l.lineId) });
        });

        if (picked.length === 0) {
            alert('Tick at least one material to ask for.');
            return;
        }
        body.lines = picked;
    }

    btn.disabled = true;
    btn.textContent = 'Asking…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'raiseReissueRequest',
        http_method: 'POST',
        payload: { payloadJson: JSON.stringify(body) }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('raiseReissueRequest parse failed:', e, response.result);
            alert('Could not read the reply from Creator.');
            btn.disabled = false;
            btn.textContent = 'Ask the store';
            return;
        }
        if (!parsed.success) {
            alert(parsed.error || 'Could not raise the request.');
            btn.disabled = false;
            btn.textContent = 'Ask the store';
            return;
        }
        // Refetched rather than spliced out of the local array: raising half an
        // item's lines leaves the rest waiting, and only the server knows which.
        loadReissue();
        if (typeof loadSupCounts === 'function') loadSupCounts();
    }).catch(function (err) {
        console.error('raiseReissueRequest error:', err);
        alert('Could not reach Creator.');
        btn.disabled = false;
        btn.textContent = 'Ask the store';
    });
}

TAB_LOADERS.reissue = loadReissue;
