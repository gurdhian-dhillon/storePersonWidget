// The checking screen. One job: take a batch that has finished production and
// split it three ways — approved, rejected, alteration.
//
// Creator JS API v2 (ZOHO.CREATOR.DATA.invokeCustomApi, no init()), ES5-flavoured
// var/function to match main.js and the other widgets.
//
// DRIVEN BY THE SUPERVISOR, NOT THE INSPECTOR. Quality inspectors have no login;
// supervisors do. So the picker at the top is a supervisor, the cards below are
// his own batches waiting to be checked — the same shape as the production
// screen he already knows — and WHICH INSPECTOR judged each batch is chosen
// inside the check dialog.
//
// That is not just where the control sits. Who inspected a batch is a fact about
// that inspection, not about who happens to be looking at the screen, so it
// belongs on the record per check. Two batches on one trolley can honestly have
// been judged by two different people.
//
// THE THREE NUMBERS MUST TOTAL WHAT PRODUCTION MADE, and that is enforced here
// as well as on the server. A garment in none of the three has silently vanished
// between the supervisor and this screen, and the server refuses it — but being
// told so after typing five check rows is a bad way to find out.

var QUEUE = { inspectors: [], supervisors: [], items: [] };
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
        payload: { supervisorId: currentSupervisorId() || '' }
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
            supervisors: parsed.supervisors || [],
            items: parsed.items || []
        };
        // The server decides the default when nothing was chosen — the oldest
        // waiting item's supervisor. Adopting its answer rather than picking our
        // own is what stops the dropdown and the list disagreeing about whose
        // work is on screen.
        fillSupervisors(parsed.selectedSupervisor || '');
        renderQueue();
    }).catch(function (err) {
        console.error('getCheckingQueue failed:', err);
        if (btn) btn.disabled = false;
        el('queue-root').innerHTML =
            '<p class="empty-note error-note">Could not reach the server. ' + escapeHtml(String(err)) + '</p>';
    });
}

function currentSupervisorId() {
    var sel = el('sup-select');
    return sel ? sel.value : '';
}

// Only supervisors who actually have something waiting, each with its count.
// Listing every supervisor means picking a name and landing on an empty screen
// with nothing to say why — the same rule the production filter follows.
//
// Rebuilt on every load, keeping whoever was already chosen. Losing the
// selection on Refresh would send him back to the picker every time.
function fillSupervisors(serverChoice) {
    var sel = el('sup-select');
    if (!sel) return;

    var keep = sel.value;
    sel.innerHTML = '<option value="">Choose supervisor…</option>';

    // Just the name. The count belongs on the "To check" tab badge, which
    // already carries it for whoever is selected — repeating it here said the
    // same thing twice, and a number beside a person's name reads as an
    // employee id anyway. The server still sends `count`; nothing renders it.
    QUEUE.supervisors.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;
        sel.appendChild(o);
    });

    var have = function (v) {
        return v && QUEUE.supervisors.some(function (s) { return String(s.id) === String(v); });
    };

    if (have(keep)) {
        sel.value = keep;
    } else if (have(serverChoice)) {
        sel.value = String(serverChoice);
    }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

function renderQueue() {
    var root = el('queue-root');
    root.innerHTML = '';

    var items = QUEUE.items || [];

    // The badge counts THIS supervisor's waiting batches, because that is whose
    // screen it is. The dropdown carries every other supervisor's count beside
    // his name, so nothing is hidden — it is just not summed into one number
    // that would belong to nobody.
    setQueueCount(items.length);

    if (!currentSupervisorId()) {
        root.innerHTML = QUEUE.supervisors.length
            ? '<p class="empty-note">Choose a supervisor to see what is waiting.</p>'
            : '<p class="empty-note">Nothing is waiting to be checked.</p>';
        return;
    }

    if (!items.length) {
        root.innerHTML = '<p class="empty-note">Nothing from this supervisor is waiting to be checked.</p>';
        return;
    }

    items.forEach(function (item) {
        root.appendChild(renderItemCard(item));
    });
}

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

function renderItemCard(item) {
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
        openCheckDialog(item);
    });

    return card;
}

// ---------------------------------------------------------------------------
// The check dialog
// ---------------------------------------------------------------------------

// Rebuilt per dialog rather than held in the DOM, so a Refresh that changes the
// roster cannot leave a stale name selectable.
function inspectorOptions() {
    return (QUEUE.inspectors || []).map(function (i) {
        return '<option value="' + escapeHtml(i.id) + '">' + escapeHtml(i.name) + '</option>';
    }).join('');
}

function closeModal() {
    var m = el('check-modal');
    m.classList.add('hidden');
    m.innerHTML = '';
}

function openCheckDialog(item) {
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
        '<p class="modal-sub">' +
        escapeHtml(item.salesOrder || '') +
        (item.planNo ? ' · ' + escapeHtml(item.planNo) : '') +
        ' · ' + produced + ' pcs from production</p>' +

        // WHO JUDGED THIS, chosen per check rather than once at the top of the
        // screen. It is a fact about the inspection, not about who is looking —
        // two batches on one trolley can honestly have been judged by two
        // different people. And it is the first thing anyone asks when a
        // rejection is disputed, so the save is refused without it.
        '<div class="insp-row">' +
        '<label for="chk-inspector">Checked by</label>' +
        '<select id="chk-inspector">' +
        '<option value="">Choose inspector…</option>' +
        inspectorOptions() +
        '</select>' +
        '</div>' +

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

    var inspectorId = el('chk-inspector') ? el('chk-inspector').value : '';
    if (!inspectorId) {
        showDialogError('Say who checked these. A rejection opens a remake batch, and the first question anyone asks is who judged it.');
        return;
    }

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
        inspectorId: String(inspectorId),
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
// Tabs
//
// History loads lazily and only once, the same way the supervisor widget's tabs
// do. The queue loads on open because that is the screen's reason to exist.
// ---------------------------------------------------------------------------

var histLoaded = false;

function showTab(name) {
    var btns = document.querySelectorAll('.tab-btn');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('is-active', btns[i].getAttribute('data-tab') === name);
    }
    var panels = document.querySelectorAll('.tab-panel');
    for (var j = 0; j < panels.length; j++) {
        panels[j].classList.toggle('is-active', panels[j].id === 'panel-' + name);
    }

    if (name === 'history' && !histLoaded) {
        histLoaded = true;
        loadHistory();
    }
}

function activeTab() {
    var b = document.querySelector('.tab-btn.is-active');
    return b ? b.getAttribute('data-tab') : 'queue';
}

// Hidden at zero rather than shown as "0". A badge should mean "there is
// something here", and a row of zeroes trains people to ignore them — which is
// the one thing this badge cannot afford, since it is the only signal an
// inspector gets that work has arrived.
function setQueueCount(n) {
    var e = el('count-queue');
    if (!e) return;
    if (!n || n <= 0) {
        e.textContent = '';
        e.classList.add('hidden');
    } else {
        e.textContent = n;
        e.classList.remove('hidden');
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function isoToDdMmmYyyy(iso) {
    if (!iso) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = String(iso).split('-');
    if (p.length !== 3) return '';
    // Deluge parses "dd-MMM-yyyy" the same way whatever the org's locale is,
    // while "01-08-2026" is a different day in the US than it is here.
    return p[2] + '-' + months[Number(p[1]) - 1] + '-' + p[0];
}

function todayIso() {
    var d = new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (m.length === 1) m = '0' + m;
    if (day.length === 1) day = '0' + day;
    return d.getFullYear() + '-' + m + '-' + day;
}

function loadHistory() {
    var dateInput = el('hist-date');
    if (!dateInput.value) dateInput.value = todayIso();

    var dayTxt = isoToDdMmmYyyy(dateInput.value);
    if (!dayTxt) {
        el('history-root').innerHTML = '<p class="empty-note">Pick a day.</p>';
        return;
    }

    el('history-root').innerHTML = '<p class="empty-note">Loading…</p>';
    el('hist-totals').textContent = '';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getCheckerHistory',
        http_method: 'POST',
        // Scoped to the SUPERVISOR whose screen this is — his batches, whoever
        // inspected them. The inspector is a column here, never a filter: "who
        // checked this" is exactly the question a disputed rejection turns into.
        payload: { supervisorId: currentSupervisorId() || '', dateTxt: dayTxt }
    }).then(function (response) {
        console.log('getCheckerHistory raw:', response);
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            el('history-root').innerHTML =
                '<p class="empty-note error-note">The server did not answer. ' +
                'If this keeps happening, run the function with Execute in Creator.</p>';
            return;
        }

        if (parsed.errors && parsed.errors.length) {
            el('history-root').innerHTML =
                '<p class="empty-note error-note">' + escapeHtml(parsed.errors.join(' · ')) + '</p>';
            return;
        }

        renderHistory(parsed);
    }).catch(function (err) {
        console.error('getCheckerHistory failed:', err);
        el('history-root').innerHTML =
            '<p class="empty-note error-note">Could not reach the server. ' + escapeHtml(String(err)) + '</p>';
    });
}

function renderHistory(data) {
    var checks = data.checks || [];
    var t = data.totals || {};

    if (!checks.length) {
        el('hist-totals').textContent = '';
        el('history-root').innerHTML = '<p class="empty-note">Nothing was checked that day.</p>';
        return;
    }

    el('hist-totals').innerHTML =
        '<b>' + num(t.checks) + '</b> ' + (num(t.checks) === 1 ? 'batch' : 'batches') +
        ' · <b>' + num(t.inspected) + '</b> inspected · ' +
        num(t.approved) + ' approved · ' + num(t.rejected) + ' rejected · ' +
        num(t.alteration) + ' to alter';

    var html = checks.map(function (c) {
        // The five checks are carried through untouched. They do not reconcile
        // with the decision and are not meant to — one garment can fail two —
        // so only the ones that actually found something are worth the row.
        var failed = (c.lines || []).filter(function (l) { return num(l.failed) > 0; });
        var failHtml = failed.length
            ? '<div class="hist-fails">' + failed.map(function (l) {
                return '<span class="hist-fail">' + escapeHtml(l.type) + ' ' + num(l.failed) +
                    (l.note ? ' · ' + escapeHtml(l.note) : '') + '</span>';
            }).join('') + '</div>'
            : '<div class="hist-fails"><span class="hist-fail is-clean">No check found anything</span></div>';

        var altHtml = (c.alterationLines || []).length
            ? '<div class="hist-alt">Back to: ' + (c.alterationLines || []).map(function (a) {
                return escapeHtml(a.stage) + ' (' + num(a.qty) + ')';
            }).join(', ') + '</div>'
            : '';

        return '' +
            '<div class="item-card">' +
            '<div class="item-header">' +
            '<div class="item-header-info">' +
            '<h2><span class="mat-name">' + escapeHtml(c.item) + '</span>' +
            (c.sku ? '<span class="mat-sku">' + escapeHtml(c.sku) + '</span>' : '') + '</h2>' +
            '<div class="item-meta-line">' +
            '<span class="so-ref">' + escapeHtml(c.salesOrder || '—') +
            (c.planNo ? ' · ' + escapeHtml(c.planNo) : '') + '</span>' +
            batchTag(c) +
            '<span class="round-tag">Round ' + num(c.round) + '</span>' +
            '</div>' +
            '<div class="item-meta-line">' +
            '<span class="so-ref">' + escapeHtml(c.inspector || 'Unknown inspector') +
            ' · ' + escapeHtml(c.checkedOn || '') + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="hist-nums">' +
            '<span class="hist-num is-ok"><b>' + num(c.approved) + '</b> approved</span>' +
            (num(c.rejected) > 0 ? '<span class="hist-num is-rej"><b>' + num(c.rejected) + '</b> rejected</span>' : '') +
            (num(c.alteration) > 0 ? '<span class="hist-num is-alt"><b>' + num(c.alteration) + '</b> to alter</span>' : '') +
            '<span class="hist-num is-muted">of ' + num(c.inspected) + '</span>' +
            '</div>' +
            '</div>' +
            failHtml + altHtml +
            (c.remarks ? '<div class="hist-remarks">' + escapeHtml(c.remarks) + '</div>' : '') +
            '</div>';
    }).join('');

    el('history-root').innerHTML = html;
}

// ---------------------------------------------------------------------------

setTodayLabel();

var tabBtns = document.querySelectorAll('.tab-btn');
for (var ti = 0; ti < tabBtns.length; ti++) {
    (function (btn) {
        btn.addEventListener('click', function () {
            showTab(btn.getAttribute('data-tab'));
        });
    })(tabBtns[ti]);
}

el('hist-date').value = todayIso();
el('hist-date').addEventListener('change', loadHistory);

// Refresh reloads whichever tab is actually open, rather than always the queue —
// pressing it on History and watching nothing change is worse than no button.
el('refresh-btn').addEventListener('click', function () {
    if (activeTab() === 'history') {
        loadHistory();
    } else {
        loadQueue();
    }
});

// Changing supervisor changes WHAT IS ON SCREEN, so it refetches — unlike the
// old inspector picker, which only decided whose name went on the record.
el('sup-select').addEventListener('change', function () {
    histLoaded = false;
    loadQueue();
    if (activeTab() === 'history') {
        histLoaded = true;
        loadHistory();
    }
});

loadQueue();
