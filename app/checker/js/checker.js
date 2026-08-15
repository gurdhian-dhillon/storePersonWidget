// Quality Inspector's screen. One job: take a batch that has finished
// production and split it three ways — approved, rejected, alteration.
//
// Creator JS API v2 (ZOHO.CREATOR.DATA.invokeCustomApi, no init()), ES5-flavoured
// var/function to match main.js and the other widgets.
//
// WHY AN ACCORDION BY SUPERVISOR rather than one flat list. He collects a
// trolley from one man at a time. Forty items across six supervisors in one flat
// list is not the order he works in, and the supervisor is also who he goes back
// to when the count on the trolley disagrees with the screen.
//
// THE THREE NUMBERS MUST TOTAL WHAT PRODUCTION MADE, and that is enforced here
// as well as on the server. A garment in none of the three has silently vanished
// between the supervisor and this screen, and the server refuses it — but being
// told so after typing five check rows is a bad way to find out.

var QUEUE = { inspectors: [], supervisors: [] };
var openSupId = null;
var saving = false;

// EXACTLY the five values on Item_Check.Check_Lines.Check_Type. These are
// matched by string on the way in, so a typo here writes a row Creator will not
// accept — and that field follows the spaces convention, not underscores.
var CHECK_TYPES = ['Stain', 'Measurement', 'Thread', 'Stitching', 'Fabric Softness'];

function el(id) { return document.getElementById(id); }

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
}

function setTodayLabel() {
    var e = el('app-date');
    if (!e) return;
    var d = new Date();
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    e.textContent = days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function loadQueue() {
    var btn = el('refresh-btn');
    if (btn) btn.disabled = true;
    el('queue-root').innerHTML = '<p class="empty-note">Loading…</p>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getCheckingQueue',
        http_method: 'POST',
        payload: { inspectorId: currentInspectorId() || '' }
    }).then(function (response) {
        console.log('getCheckingQueue raw:', response);
        if (btn) btn.disabled = false;

        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            // A bare 500 with no error card usually means the statement-execution
            // limit, which is NOT catchable server-side — so there is nothing in
            // the payload to report and this is the only place it can be said.
            console.error('getCheckingQueue did not return JSON:', e);
            el('queue-root').innerHTML =
                '<p class="empty-note error-note">The server did not answer. ' +
                'If this keeps happening the function is probably hitting Creator\'s ' +
                'statement limit — check the Custom API in Creator with Execute.</p>';
            return;
        }

        console.log('getCheckingQueue parsed:', parsed);

        if (parsed.errors && parsed.errors.length) {
            el('queue-root').innerHTML =
                '<p class="empty-note error-note">' + escapeHtml(parsed.errors.join(' · ')) + '</p>';
            return;
        }

        QUEUE = {
            inspectors: parsed.inspectors || [],
            supervisors: parsed.supervisors || []
        };
        fillInspectors();
        renderQueue();
    }).catch(function (err) {
        console.error('getCheckingQueue failed:', err);
        if (btn) btn.disabled = false;
        el('queue-root').innerHTML =
            '<p class="empty-note error-note">Could not reach the server. ' + escapeHtml(String(err)) + '</p>';
    });
}

function currentInspectorId() {
    var sel = el('insp-select');
    return sel ? sel.value : '';
}

// Rebuilt on every load, keeping whoever was already chosen. Losing the
// selection on Refresh would send him back to the picker every time.
function fillInspectors() {
    var sel = el('insp-select');
    if (!sel) return;

    var keep = sel.value;
    sel.innerHTML = '<option value="">Choose inspector…</option>';

    QUEUE.inspectors.forEach(function (i) {
        var o = document.createElement('option');
        o.value = i.id;
        o.textContent = i.name;
        sel.appendChild(o);
    });

    if (keep && QUEUE.inspectors.some(function (i) { return i.id === keep; })) {
        sel.value = keep;
    } else if (QUEUE.inspectors.length === 1) {
        // One inspector is the common case on this floor. Making him pick his
        // own name out of a list of one is friction for nothing.
        sel.value = QUEUE.inspectors[0].id;
    }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

function renderQueue() {
    var root = el('queue-root');
    root.innerHTML = '';

    var withWork = QUEUE.supervisors.filter(function (s) {
        return (s.items || []).length > 0;
    });

    if (!withWork.length) {
        root.innerHTML = '<p class="empty-note">Nothing is waiting to be checked.</p>';
        return;
    }

    // Auto-open when there is only one supervisor with work — an accordion of
    // one closed row is a click that answers no question.
    if (openSupId === null && withWork.length === 1) {
        openSupId = withWork[0].id;
    }

    withWork.forEach(function (sup) {
        var isOpen = String(sup.id) === String(openSupId);
        var items = sup.items || [];

        var block = document.createElement('div');
        block.className = 'sup-block' + (isOpen ? ' is-open' : '');

        var head = document.createElement('button');
        head.type = 'button';
        head.className = 'sup-head';
        head.innerHTML =
            '<span class="sup-caret">' + (isOpen ? '▾' : '▸') + '</span>' +
            '<span class="sup-name">' + escapeHtml(sup.name) + '</span>' +
            '<span class="sup-count">' + items.length +
            (items.length === 1 ? ' batch' : ' batches') + '</span>';
        head.addEventListener('click', function () {
            openSupId = isOpen ? null : sup.id;
            renderQueue();
        });
        block.appendChild(head);

        if (isOpen) {
            var body = document.createElement('div');
            body.className = 'sup-body';
            items.forEach(function (item) {
                body.appendChild(renderItemCard(item, sup));
            });
            block.appendChild(body);
        }

        root.appendChild(block);
    });
}

// FOUR KINDS, and the last two must not be drawn the same. A Remake replaces a
// garment that failed HIS check; a Replacement replaces one spoiled on the floor
// that he never saw. Labelling the second as a rejection tells him it came back
// from his own last round, which is both wrong and an accusation.
function batchTag(item) {
    if (item.batch === 'Alteration') {
        return '<span class="batch-tag is-alt">Alteration batch</span>';
    }
    if (item.batch === 'Remake') {
        return '<span class="batch-tag is-remake">Remake — failed checking</span>';
    }
    if (item.batch === 'Replacement') {
        return '<span class="batch-tag is-replace">Replacement — spoiled in production</span>';
    }
    return '';
}

// The order position, spelled out. Without it he approves 85 with no idea
// whether that finishes the order or leaves it fifteen short — and that is
// exactly the moment the decision matters, because a rejection here is what
// opens the next batch.
function linePosition(item) {
    var ordered = num(item.lineOrdered);
    var accepted = num(item.lineAccepted);
    var out = num(item.lineOutstanding);

    if (out <= 0) {
        return '<span class="line-pos is-done">' + accepted + ' of ' + ordered +
            ' accepted · line complete</span>';
    }
    return '<span class="line-pos">' + accepted + ' of ' + ordered +
        ' accepted · <b>' + out + ' still to come</b></span>';
}

function renderItemCard(item, sup) {
    var card = document.createElement('div');
    card.className = 'item-card';

    card.innerHTML =
        '<div class="item-header">' +
        '<div class="item-header-info">' +
        '<h2><span class="mat-name">' + escapeHtml(item.name) + '</span>' +
        (item.sku ? '<span class="mat-sku">' + escapeHtml(item.sku) + '</span>' : '') + '</h2>' +
        '<div class="item-meta-line">' +
        '<span class="item-qty">' + num(item.produced) + ' pcs to inspect</span>' +
        batchTag(item) +
        '<span class="round-tag">Round ' + num(item.round) + '</span>' +
        '</div>' +
        '<div class="item-meta-line">' +
        '<span class="so-ref">' + escapeHtml(item.salesOrder || '—') + ' · ' +
        escapeHtml(item.planNo || '') + '</span>' +
        linePosition(item) +
        '</div>' +
        '</div>' +
        '<button type="button" class="primary-btn check-btn">Check</button>' +
        '</div>';

    card.querySelector('.check-btn').addEventListener('click', function () {
        openCheckDialog(item, sup);
    });

    return card;
}

// ---------------------------------------------------------------------------
// The check dialog
// ---------------------------------------------------------------------------

function closeModal() {
    var m = el('check-modal');
    m.classList.add('hidden');
    m.innerHTML = '';
}

function openCheckDialog(item, sup) {
    var produced = num(item.produced);
    var stages = (item.stages || []).slice().sort(function (a, b) {
        return num(a.sequence) - num(b.sequence);
    });

    var checkRows = CHECK_TYPES.map(function (t, i) {
        return '' +
            '<tr>' +
            '<td class="chk-label">' + escapeHtml(t) + '</td>' +
            '<td class="col-num"><input type="number" min="0" step="1" class="chk-failed" ' +
            'data-i="' + i + '" value="0"></td>' +
            '<td class="col-num"><input type="number" min="0" step="1" class="chk-passed" ' +
            'data-i="' + i + '" value="' + produced + '"></td>' +
            '<td><input type="text" class="chk-note" data-i="' + i + '" placeholder="optional"></td>' +
            '</tr>';
    }).join('');

    var stageRows = stages.map(function (s) {
        return '' +
            '<tr>' +
            '<td>' + escapeHtml(s.operation) + '</td>' +
            '<td class="col-num"><input type="number" min="0" step="1" class="alt-qty" ' +
            'data-stage="' + escapeHtml(s.operation) + '" value="0"></td>' +
            '</tr>';
    }).join('');

    var m = el('check-modal');
    m.classList.remove('hidden');
    m.innerHTML =
        '<div class="modal-panel">' +

        '<h3>' + escapeHtml(item.name) +
        (item.sku ? ' <span class="mat-sku">' + escapeHtml(item.sku) + '</span>' : '') + '</h3>' +
        '<p class="modal-sub">' + escapeHtml(sup.name) + ' · ' +
        escapeHtml(item.salesOrder || '') + ' · ' + produced + ' pcs from production</p>' +

        // Recorded, not calculated. A garment can fail two checks, so these do
        // not add up to the disposition below and nothing derives from them —
        // they exist so "what is actually going wrong" is answerable later.
        '<h4>Checks</h4>' +
        '<p class="hint">A record of what was found. A piece can fail more than one check, ' +
        'so these do not have to add up to the decision below.</p>' +
        '<div class="table-wrapper">' +
        '<table class="chk-table"><thead><tr>' +
        '<th>Check</th><th class="col-num">Failed</th><th class="col-num">Passed</th><th>Note</th>' +
        '</tr></thead><tbody>' + checkRows + '</tbody></table>' +
        '</div>' +

        '<h4>Decision</h4>' +
        '<div class="disp-row">' +
        '<label>Approved<input type="number" min="0" step="1" id="disp-approved" value="' + produced + '"></label>' +
        '<label>Rejected<input type="number" min="0" step="1" id="disp-rejected" value="0"></label>' +
        '<label>Alteration<input type="number" min="0" step="1" id="disp-alteration" value="0"></label>' +
        '</div>' +
        '<p class="disp-total" id="disp-total"></p>' +

        '<div id="alt-block" class="hidden">' +
        '<h4>Which stages need the work?</h4>' +
        '<p class="hint">One garment can need two stages fixed, so these may add up to more ' +
        'than the alteration count. They may not add up to less.</p>' +
        '<div class="table-wrapper">' +
        '<table class="chk-table"><thead><tr>' +
        '<th>Stage</th><th class="col-num">Pieces</th>' +
        '</tr></thead><tbody>' + stageRows + '</tbody></table>' +
        '</div>' +
        '</div>' +

        '<label class="rem-label">Remarks<textarea id="chk-remarks" rows="2"></textarea></label>' +

        '<p class="modal-error hidden" id="chk-error"></p>' +

        '<div class="modal-actions">' +
        '<button type="button" class="ghost-btn" id="chk-cancel">Cancel</button>' +
        '<button type="button" class="primary-btn" id="chk-save">Save check</button>' +
        '</div>' +

        '</div>';

    // Passed follows Failed, because within ONE check every piece either passed
    // or failed — the counts only stop reconciling ACROSS checks. Still editable
    // in case he inspected a subset.
    m.querySelectorAll('.chk-failed').forEach(function (inp) {
        inp.addEventListener('input', function () {
            var i = inp.getAttribute('data-i');
            var pass = m.querySelector('.chk-passed[data-i="' + i + '"]');
            var left = produced - num(inp.value);
            pass.value = left < 0 ? 0 : left;
        });
    });

    function refreshTotals() {
        var a = num(el('disp-approved').value);
        var r = num(el('disp-rejected').value);
        var x = num(el('disp-alteration').value);
        var sum = a + r + x;

        var t = el('disp-total');
        if (sum === produced) {
            t.className = 'disp-total is-ok';
            t.textContent = sum + ' of ' + produced + ' accounted for';
        } else {
            t.className = 'disp-total is-bad';
            t.textContent = sum + ' of ' + produced + ' accounted for — ' +
                (sum < produced ? (produced - sum) + ' unaccounted' : 'over by ' + (sum - produced));
        }

        el('alt-block').classList.toggle('hidden', x <= 0);
    }

    ['disp-approved', 'disp-rejected', 'disp-alteration'].forEach(function (id) {
        el(id).addEventListener('input', refreshTotals);
    });
    refreshTotals();

    el('chk-cancel').addEventListener('click', closeModal);
    el('chk-save').addEventListener('click', function () { saveCheck(item, produced); });
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function showDialogError(msg) {
    var e = el('chk-error');
    e.textContent = msg;
    e.classList.remove('hidden');
}

function saveCheck(item, produced) {
    if (saving) return;

    var m = el('check-modal');
    el('chk-error').classList.add('hidden');

    var approved = num(el('disp-approved').value);
    var rejected = num(el('disp-rejected').value);
    var alteration = num(el('disp-alteration').value);

    if (approved < 0 || rejected < 0 || alteration < 0) {
        showDialogError('Quantities cannot be negative.');
        return;
    }
    if (approved + rejected + alteration !== produced) {
        showDialogError('Approved, rejected and alteration must total ' + produced +
            ' — production made that many and every piece has to be in one of the three.');
        return;
    }

    var lines = [];
    if (alteration > 0) {
        m.querySelectorAll('.alt-qty').forEach(function (inp) {
            var q = num(inp.value);
            if (q > 0) {
                lines.push({ stage: inp.getAttribute('data-stage'), qty: q });
            }
        });

        if (!lines.length) {
            showDialogError('Say which stages the ' + alteration + ' pieces need work at.');
            return;
        }
        var over = lines.filter(function (l) { return l.qty > alteration; });
        if (over.length) {
            showDialogError('No single stage can have more than ' + alteration +
                ' pieces — that is the whole batch. ' + over[0].stage + ' has ' + over[0].qty + '.');
            return;
        }
        var sum = lines.reduce(function (s, l) { return s + l.qty; }, 0);
        if (sum < alteration) {
            showDialogError('The stages account for ' + sum + ' pieces but ' + alteration +
                ' are going for alteration. Every piece needs at least one stage.');
            return;
        }
    }

    var checks = CHECK_TYPES.map(function (t, i) {
        return {
            type: t,
            passed: num(m.querySelector('.chk-passed[data-i="' + i + '"]').value),
            failed: num(m.querySelector('.chk-failed[data-i="' + i + '"]').value),
            note: m.querySelector('.chk-note[data-i="' + i + '"]').value || ''
        };
    });

    var payload = {
        planItemId: String(item.id),
        inspectorId: String(currentInspectorId() || ''),
        checks: checks,
        approved: approved,
        rejected: rejected,
        alteration: alteration,
        alterationLines: lines,
        remarks: el('chk-remarks').value || ''
    };

    saving = true;
    el('chk-save').disabled = true;
    el('chk-save').textContent = 'Saving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'saveItemCheck',
        http_method: 'POST',
        payload: { payloadJson: JSON.stringify(payload) }
    }).then(function (response) {
        console.log('saveItemCheck raw:', response);
        saving = false;

        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            parsed = null;
        }

        if (!parsed || !parsed.success) {
            el('chk-save').disabled = false;
            el('chk-save').textContent = 'Save check';
            showDialogError(parsed && parsed.error ? parsed.error : 'The server did not accept it.');
            return;
        }

        closeModal();
        showOutcome(item, approved, rejected, alteration, parsed);
        loadQueue();
    }).catch(function (err) {
        console.error('saveItemCheck failed:', err);
        saving = false;
        el('chk-save').disabled = false;
        el('chk-save').textContent = 'Save check';
        showDialogError('Could not reach the server. ' + String(err));
    });
}

// What the save actually set in motion. A rejection opens a new batch that needs
// cloth from the store and a fresh run from Cutting; an alteration puts work
// back on the supervisor's screen. Both are consequences he should see named
// rather than infer from the item leaving the list.
function showOutcome(item, approved, rejected, alteration, res) {
    var bits = [];
    if (approved > 0) bits.push('<li><b>' + approved + '</b> approved</li>');
    if (rejected > 0) {
        bits.push('<li><b>' + rejected + '</b> rejected — a remake batch has been raised ' +
            'and the store has been asked for material</li>');
    }
    if (alteration > 0) {
        bits.push('<li><b>' + alteration + '</b> sent for alteration — back on ' +
            'the supervisor\'s screen now</li>');
    }

    var verdict = String(res.orderVerdict || '');
    var orderLine = '';
    if (verdict.indexOf('PASSED') === 0) {
        orderLine = '<p class="outcome-order is-ok">That completes the order — it has passed checking.</p>';
    } else if (verdict.indexOf('NOT YET: short') === 0) {
        orderLine = '<p class="outcome-order">The order is still short. It will not close until ' +
            'the remaining pieces are made and approved.</p>';
    }

    var m = el('check-modal');
    m.classList.remove('hidden');
    m.innerHTML =
        '<div class="modal-panel modal-narrow">' +
        '<h3>' + escapeHtml(item.name) + ' checked</h3>' +
        '<ul class="outcome-list">' + bits.join('') + '</ul>' +
        orderLine +
        '<div class="modal-actions">' +
        '<button type="button" class="primary-btn" id="out-close">Done</button>' +
        '</div>' +
        '</div>';
    el('out-close').addEventListener('click', closeModal);
}

// ---------------------------------------------------------------------------

setTodayLabel();
el('refresh-btn').addEventListener('click', loadQueue);
el('insp-select').addEventListener('change', function () {
    // The queue is the same whoever is looking — the picker only decides who the
    // check is recorded against — so this does not refetch.
});
loadQueue();
