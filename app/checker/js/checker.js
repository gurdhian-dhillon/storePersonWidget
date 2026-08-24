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
// Which card is expanded. One at a time — see scrollCardIntoView.
var openItemId = null;
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
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
    }
    el('queue-root').innerHTML = '<p class="empty-note">Loading…</p>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getCheckingQueue',
        http_method: 'POST',
        payload: { supervisorId: currentSupervisorId() || '' }
    }).then(function (response) {
        console.log('getCheckingQueue raw:', response);
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Refresh';
        }

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
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Refresh';
        }
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

    // An open card whose item has left the queue — just checked, or checked
    // by somebody else since — cannot stay open over nothing.
    if (openItemId !== null && !items.some(function (i) { return String(i.id) === String(openItemId); })) {
        openItemId = null;
    }

    var openItem = null;
    var openCard = null;

    items.forEach(function (item, idx) {
        var card = renderItemCard(item, idx);
        root.appendChild(card);
        if (String(item.id) === String(openItemId)) {
            openItem = item;
            openCard = card;
        }
    });

    // AFTER every card is in the document. The form reads its own fields through
    // document.getElementById, which cannot find an element that has been built
    // but not yet appended.
    if (openCard) wireCheckForm(openCard, openItem, num(openItem.produced));
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

// The coloured badge on the card header, inline-styled exactly as the packing
// card does it so the two lists read as one product. What it carries is the
// BATCH, because that is the only thing that differs between two cards sitting
// in this queue — everything here is waiting to be checked, so an original batch
// says just that.
//
// batchTag() is deliberately left alone: the History tab still draws its own
// pill with it, and that card is a different shape.
function batchBadge(item) {
    var colour = '#059669';
    var text = 'Ready to check';

    if (item.batch === 'Alteration') {
        // Teal, not amber — the garment is being saved rather than scrapped,
        // the same reason an offcut is green throughout the app.
        colour = '#0d9488';
        text = 'Alteration batch';
    } else if (item.batch === 'Remake') {
        colour = '#d97706';
        text = 'Remake — failed checking';
    } else if (item.batch === 'Replacement') {
        // Muted. Nothing failed a check, so it must not wear a quality colour.
        colour = '#64748b';
        text = 'Replacement — spoiled in production';
    }

    return '<span class="item-status-badge" style="color:' + colour +
        '; font-weight:600; font-size:0.8rem; background:' + colour +
        '15; padding:0.1rem 0.5rem; border-radius:1rem;">' + escapeHtml(text) + '</span>';
}

// Same card as the packing and store screens: numbered circle, title, one meta
// line, chevron. Nothing here decides anything — it is the identical set of
// facts the two stacked meta lines used to carry, laid out the way every other
// list in the app lays them out.
function renderItemCard(item, index) {
    var isOpen = String(item.id) === String(openItemId);
    var produced = num(item.produced);

    var card = document.createElement('div');
    card.className = 'item-card' + (isOpen ? ' is-open' : '');
    card.setAttribute('data-item-id', item.id);

    var header =
        '<div class="item-header">' +
        '<div class="item-title-row">' +
        '<div class="item-serial">' + (num(index) + 1) + '</div>' +
        '<div class="item-header-info">' +
        '<h2><span class="mat-name">' + escapeHtml(item.name) + '</span></h2>' +
        '<div class="item-meta-line" style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">' +
        (item.sku ? '<span class="mat-sku">' + escapeHtml(item.sku) + '</span>' : '') +
        '<span class="item-qty">' + produced + ' pcs to inspect</span>' +
        batchBadge(item) +
        // The round stays, as a quiet chip. It is the difference between a first
        // look and a fourth attempt at the same line.
        '<span class="round-tag">Round ' + num(item.round) + '</span>' +
        // True, needed, but not what he is deciding — so it trails the badge
        // rather than owning a line of its own.
        '<span class="chk-secondary">' +
        '<span class="so-ref">' + escapeHtml(item.salesOrder || '—') + ' · ' +
        escapeHtml(item.planNo || '') + '</span>' +
        linePosition(item) +
        '</span>' +
        '</div>' +
        '</div>' +
        '</div>' +
        // The chevron alone, exactly as the production screen does it. A Check
        // button beside it was a second control doing the same job — the whole
        // header already toggles, so the button could only ever agree with it.
        '<div class="item-header-right">' +
        '<span class="chevron">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>' +
        '</span>' +
        '</div>' +
        '</div>';

    card.innerHTML = header + (isOpen ? checkFormHtml(item, produced) : '');

    // The whole header toggles, not just the button — the production screen
    // behaves that way, and a card that only opens from one small target is a
    // different interaction for no reason.
    card.querySelector('.item-header').addEventListener('click', function () {
        openItemId = isOpen ? null : item.id;
        renderQueue();
        if (!isOpen) scrollCardIntoView(item.id);
    });

    // NOT wired here. The form is wired by renderQueue AFTER the card is in the
    // document, because refreshTotals reads #disp-total through
    // document.getElementById — and an element that has been built but not yet
    // appended is not findable that way. Wiring here threw, renderQueue died
    // mid-loop, and the whole list vanished the moment a card was clicked.
    return card;
}

// ONE CARD OPEN AT A TIME, and not merely for tidiness: the form uses fixed
// element ids, so two open cards would put two #disp-approved in the page and
// every read would find whichever came first.
function scrollCardIntoView(id) {
    var c = document.querySelector('[data-item-id="' + id + '"]');
    if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// The check form, rendered inside the card
// ---------------------------------------------------------------------------

// Rebuilt each time a card opens rather than held in the DOM, so a Refresh that
// changes the roster cannot leave a stale name selectable.
function inspectorOptions() {
    return (QUEUE.inspectors || []).map(function (i) {
        return '<option value="' + escapeHtml(i.id) + '">' + escapeHtml(i.name) + '</option>';
    }).join('');
}

function checkFormHtml(item, produced) {
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

    return '' +
        '<div class="item-body">' +

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
        // not add up to the decision below and nothing derives from them — they
        // exist so "what is actually going wrong" is answerable later.
        '<div class="section-title">Checks</div>' +
        '<p class="hint">A record of what was found. A piece can fail more than one check, so these need not add up to the decision.</p>' +
        '<div class="table-wrapper">' +
        '<table class="chk-table"><thead><tr>' +
        '<th>Check</th><th class="col-num">Failed</th><th class="col-num">Passed</th><th>Note</th>' +
        '</tr></thead><tbody>' + checkRows + '</tbody></table>' +
        '</div>' +

        '<div class="section-title">Decision</div>' +
        '<div class="decision-section">' +
        '  <div class="decision-left">' +
        '    <div class="disp-row-vertical">' +
        '      <label>Approved<input type="number" min="0" step="1" id="disp-approved" value="' + produced + '"></label>' +
        '      <label>Rejected<input type="number" min="0" step="1" id="disp-rejected" value="0"></label>' +
        '      <label>Alteration<input type="number" min="0" step="1" id="disp-alteration" value="0"></label>' +
        '    </div>' +
        '  </div>' +
        '  <div class="decision-right">' +
        '    <div id="remarks-container">' +
        '      <label id="lbl-remarks-rejected" class="rem-label">Rejection Remarks<textarea id="chk-remarks-rejected" rows="3" placeholder="Why were these rejected?" disabled></textarea></label>' +
        '      <label id="lbl-remarks-alteration" class="rem-label">Alteration Remarks<textarea id="chk-remarks-alteration" rows="3" placeholder="What needs to be altered?" disabled></textarea></label>' +
        '    </div>' +
        '  </div>' +
        '</div>' +
        '<p class="disp-total" id="disp-total"></p>' +

        '<div id="alt-block" class="hidden">' +
        '<div class="section-title">Which stages need the work?</div>' +
        '<p class="hint">A garment can need two stages fixed, so these may total more than the alteration count &mdash; never less.</p>' +
        '<div class="table-wrapper">' +
        '<table class="chk-table alt-table"><thead><tr>' +
        '<th>Stage</th><th class="col-num">Pieces</th>' +
        '</tr></thead><tbody>' + stageRows + '</tbody></table>' +
        '</div>' +
        '</div>' +

        '<label id="lbl-remarks-common" class="rem-label">Remarks<textarea id="chk-remarks-common" rows="2" placeholder="General remarks..."></textarea></label>' +

        '<p class="chk-error hidden" id="chk-error"></p>' +

        '<div class="chk-actions">' +
        '<button type="button" class="ghost-btn" id="chk-cancel">Cancel</button>' +
        '<button type="button" class="primary-btn" id="chk-save">Save check</button>' +
        '</div>' +

        '</div>';
}

function wireCheckForm(card, item, produced) {
    // Clicks inside the form must not reach the header handler, which would
    // close the card mid-typing.
    card.querySelector('.item-body').addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
    });

    // Passed follows Failed, because within ONE check every piece either passed
    // or failed — the counts only stop reconciling ACROSS checks. Still editable
    // in case he inspected a subset.
    card.querySelectorAll('.chk-failed').forEach(function (inp) {
        inp.addEventListener('input', function () {
            var i = inp.getAttribute('data-i');
            var pass = card.querySelector('.chk-passed[data-i="' + i + '"]');
            var left = produced - num(inp.value);
            pass.value = left < 0 ? 0 : left;
        });
    });

    var prevA = produced;
    var prevR = 0;
    var prevX = 0;

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

        var hasRej = r > 0;
        var hasAlt = x > 0;

        var txtRejected = el('chk-remarks-rejected');
        var txtAlteration = el('chk-remarks-alteration');

        if (txtRejected) {
            txtRejected.disabled = !hasRej;
            if (!hasRej) {
                txtRejected.value = '';
            }
        }
        if (txtAlteration) {
            txtAlteration.disabled = !hasAlt;
            if (!hasAlt) {
                txtAlteration.value = '';
            }
        }
    }

    el('disp-approved').addEventListener('input', function () {
        var valStr = el('disp-approved').value;
        var a = num(valStr);
        if (a < 0) {
            a = 0;
            el('disp-approved').value = a;
        }
        if (a > produced) {
            a = produced;
            el('disp-approved').value = a;
        }

        var diff = a - prevA;
        if (diff > 0) {
            // Approved increased: decrease Rejected and/or Alteration to balance.
            var r = prevR;
            var x = prevX;

            var decR = Math.min(r, diff);
            r -= decR;
            diff -= decR;

            if (diff > 0) {
                var decX = Math.min(x, diff);
                x -= decX;
                diff -= decX;
            }

            el('disp-rejected').value = r;
            el('disp-alteration').value = x;
            prevR = r;
            prevX = x;
            prevA = a;
        } else if (diff < 0) {
            // Approved decreased: increase Rejected to balance.
            var r = prevR;
            var toIncrease = -diff;
            r += toIncrease;

            el('disp-rejected').value = r;
            prevR = r;
            prevA = a;
        } else {
            prevA = a;
        }
        refreshTotals();
    });

    el('disp-rejected').addEventListener('input', function () {
        var valStr = el('disp-rejected').value;
        var r = num(valStr);
        if (r < 0) {
            r = 0;
            el('disp-rejected').value = r;
        }

        // Rejected only connects with Approved.
        var a = prevA - (r - prevR);
        if (a < 0) {
            r = prevA + prevR;
            a = 0;
            el('disp-rejected').value = r;
        }
        el('disp-approved').value = a;

        prevR = r;
        prevA = a;
        refreshTotals();
    });

    el('disp-alteration').addEventListener('input', function () {
        var valStr = el('disp-alteration').value;
        var x = num(valStr);
        if (x < 0) {
            x = 0;
            el('disp-alteration').value = x;
        }

        // Alteration only connects with Approved.
        var a = prevA - (x - prevX);
        if (a < 0) {
            x = prevA + prevX;
            a = 0;
            el('disp-alteration').value = x;
        }
        el('disp-approved').value = a;

        prevX = x;
        prevA = a;
        refreshTotals();
    });

    refreshTotals();

    el('chk-cancel').addEventListener('click', function () {
        openItemId = null;
        renderQueue();
    });
    el('chk-save').addEventListener('click', function () { saveCheck(item, produced); });
}

// Opens a card by item. Kept under this name because the harness and the save
// path both call it.
function openCheckDialog(item) {
    openItemId = item.id;
    renderQueue();
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

    // The form lives in the item's own card now, not in the overlay. Scoped to
    // that card rather than searched page-wide: only one card is open at a time,
    // but a page-wide query would silently start reading a second one the moment
    // that ever changed.
    var m = document.querySelector('[data-item-id="' + item.id + '"]');
    if (!m) return;

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
        remarks: el('chk-remarks-common') ? el('chk-remarks-common').value.trim() : '',
        rejectionRemarks: (rejected > 0 && el('chk-remarks-rejected')) ? el('chk-remarks-rejected').value.trim() : '',
        alterationRemarks: (alteration > 0 && el('chk-remarks-alteration')) ? el('chk-remarks-alteration').value.trim() : ''
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

        openItemId = null;
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
// The ONE thing still shown as an overlay. The check form moved into the card,
// but this is not a form — it is the answer to "what did that just set in
// motion", and the card it would sit in has by then left the queue.
function closeModal() {
    var m = el('check-modal');
    m.classList.add('hidden');
    m.innerHTML = '';
}

function showOutcome(item, approved, rejected, alteration, res) {
    var bits = [];
    if (approved > 0) bits.push('<li><b>' + approved + '</b> approved</li>');
    if (rejected > 0) {
        // NOT "the store has been asked for material", which is what this said
        // while the check raised the requirements itself. It does not any more:
        // the batch lands on the supervisor's Reissue tab and he decides when to
        // ask. Saying otherwise here would have him waiting on cloth nobody has
        // requested.
        bits.push('<li><b>' + rejected + '</b> rejected — a remake batch has been raised. ' +
            'The supervisor asks the store for the material when he is ready</li>');
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

    var btn = el('refresh-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
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
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Refresh';
        }
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
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Refresh';
        }
        el('history-root').innerHTML =
            '<p class="empty-note error-note">Could not reach the server. ' + escapeHtml(String(err)) + '</p>';
    });
}

function renderHistory(data) {
    var checks = data.checks || [];
    var t = data.totals || {};

    if (!checks.length) {
        el('hist-totals').innerHTML = '';
        el('history-root').innerHTML = '<p class="empty-note">Nothing was checked that day.</p>';
        return;
    }

    // The day in one line. Inspected is the anchor everything else is a share of,
    // so it leads; a zero outcome is left out rather than printed as "0 rejected",
    // which reads as a finding.
    el('hist-totals').innerHTML =
        '<span class="day-stat"><b>' + num(t.checks) + '</b> ' +
        (num(t.checks) === 1 ? 'batch' : 'batches') + '</span>' +
        '<span class="day-stat"><b>' + num(t.inspected) + '</b> inspected</span>' +
        (num(t.approved) > 0
            ? '<span class="day-stat is-ok"><b>' + num(t.approved) + '</b> approved</span>' : '') +
        (num(t.rejected) > 0
            ? '<span class="day-stat is-rej"><b>' + num(t.rejected) + '</b> rejected</span>' : '') +
        (num(t.alteration) > 0
            ? '<span class="day-stat is-alt"><b>' + num(t.alteration) + '</b> to alter</span>' : '');

    var html = checks.map(function (c) {
        var inspected = num(c.inspected);

        // ONE TILE PER OUTCOME, and a zero outcome is omitted. Printing "0
        // rejected" beside "3 approved" gives a clean batch the same shape as a
        // bad one and makes the row something to read rather than something to
        // scan.
        var tiles = '';
        if (num(c.approved) > 0) {
            tiles += '<span class="out-tile is-ok"><b>' + num(c.approved) + '</b>approved</span>';
        }
        if (num(c.rejected) > 0) {
            tiles += '<span class="out-tile is-rej"><b>' + num(c.rejected) + '</b>rejected</span>';
        }
        if (num(c.alteration) > 0) {
            tiles += '<span class="out-tile is-alt"><b>' + num(c.alteration) + '</b>to alter</span>';
        }
        tiles += '<span class="out-tile is-tot"><b>' + inspected + '</b>inspected</span>';

        // Only checks that actually found something. The five never reconcile
        // with the decision — one garment can fail two — so listing all five
        // every time would bury the one that matters among four zeroes.
        var failed = (c.lines || []).filter(function (l) { return num(l.failed) > 0; });
        var failHtml = failed.length
            ? '<div class="hist-row">' +
                '<span class="hist-row-label">Found</span>' +
                '<span class="hist-row-body">' + failed.map(function (l) {
                    return '<span class="fail-pill">' + escapeHtml(l.type) +
                        ' <b>' + num(l.failed) + '</b>' +
                        (l.note ? '<i>' + escapeHtml(l.note) + '</i>' : '') + '</span>';
                }).join('') + '</span>' +
              '</div>'
            : '';

        var alt = (c.alterationLines || []);
        var altHtml = alt.length
            ? '<div class="hist-row">' +
                '<span class="hist-row-label">Back to</span>' +
                '<span class="hist-row-body">' + alt.map(function (a) {
                    return '<span class="stage-pill">' + escapeHtml(a.stage) +
                        ' <b>' + num(a.qty) + '</b></span>';
                }).join('') + '</span>' +
              '</div>'
            : '';

        var remHtml = c.remarks
            ? '<div class="hist-row">' +
                '<span class="hist-row-label">Note</span>' +
                '<span class="hist-row-body hist-remark">' + escapeHtml(c.remarks) + '</span>' +
              '</div>'
            : '';

        // A batch where nothing failed and nothing was sent back says so once,
        // quietly. Left blank it reads as a card that failed to load.
        var detail = failHtml + altHtml + remHtml;
        if (!detail) {
            detail = '<div class="hist-row"><span class="hist-row-label"></span>' +
                '<span class="hist-row-body hist-clean">Every check clean</span></div>';
        }

        return '' +
            '<div class="hist-card">' +
            '<div class="hist-head">' +
            '<div class="hist-title">' +
            '<h3>' + escapeHtml(c.item) +
            (c.sku ? '<span class="mat-sku">' + escapeHtml(c.sku) + '</span>' : '') + '</h3>' +
            '<div class="hist-meta">' +
            '<span class="so-ref">' + escapeHtml(c.salesOrder || '—') +
            (c.planNo ? ' · ' + escapeHtml(c.planNo) : '') + '</span>' +
            batchTag(c) +
            '<span class="round-tag">Round ' + num(c.round) + '</span>' +
            '</div>' +
            '<div class="hist-who">' + escapeHtml(c.inspector || 'Unknown inspector') +
            (c.checkedOn ? ' · ' + escapeHtml(c.checkedOn) : '') + '</div>' +
            '</div>' +
            '<div class="out-tiles">' + tiles + '</div>' +
            '</div>' +
            '<div class="hist-detail">' + detail + '</div>' +
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
        openItemId = null; // Reset expanded card on refresh
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
