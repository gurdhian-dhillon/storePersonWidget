// Disputes and Waste returns for the supervisor dashboard.
//
// Loaded after receive.js, so escapeHtml/fmt/round2 are already defined.

// ---- Shared modal shell ----

function supModalEl() {
    var el = document.getElementById('sup-modal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'sup-modal';
        el.className = 'exc-modal hidden';
        document.body.appendChild(el);
    }
    return el;
}

function closeSupModal() {
    supModalEl().classList.add('hidden');
}

// ---- Disputes ----
//
// Two directions. OUTBOUND is raised when he confirmed less than the store
// issued, and his one answer is "I had it after all". INBOUND is raised when the
// store found fewer offcuts on the rack than he declared after cutting, and his
// one answer is the opposite — "I declared more than I actually sent back".
//
// Either way he only answers for his own side. What the store did with its own
// shelf, and Lost, are not his to say — so the widget does not offer them rather
// than offering them and having the server refuse later.

var supDisputes = [];

function supDisputeIsInbound(d) {
    // Empty means outbound: every dispute raised before the field existed was
    // one, and the server applies the same default.
    return d && d.direction === 'Inbound';
}

// The answer that settles a quantity, which is a different claim each way round.
// Outbound he is the receiver, so it is "I have it". Inbound he is the sender,
// so it is "I never sent that many".
function supOwnResolution(d) {
    return supDisputeIsInbound(d) ? 'Supervisor_Correction' : 'Found';
}

function loadSupDisputes() {
    var panel = document.getElementById('panel-disputes');
    var supId = currentSupervisorId();

    if (!supId) {
        panel.innerHTML = '<div class="panel-placeholder"><h2>Choose a supervisor</h2>' +
            '<p>Pick who you are from the header to see disputes raised against you.</p></div>';
        return;
    }

    panel.innerHTML = '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getSupervisorDisputes',
        http_method: 'POST',
        payload: { supervisorId: String(supId) }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getSupervisorDisputes parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the list</h2><p>Check the browser console.</p></div>';
            return;
        }
        supDisputes = parsed.disputes || [];
        var errs = parsed.errors || [];

        // Errors and rows arrive together — the server skips the rows it cannot
        // read and returns the rest. Only a run that produced NOTHING is a dead
        // end; otherwise the readable disputes are shown with the failures noted
        // above them. An empty list on its own reads as "nothing in dispute",
        // the exact opposite of what happened, and it contradicts the tab badge.
        if (errs.length > 0) console.error('getSupervisorDisputes:', errs);

        if (errs.length > 0 && supDisputes.length === 0) {
            panel.innerHTML =
                '<div class="panel-placeholder">' +
                    '<h2>The dispute list could not be built</h2>' +
                    '<p>' + escapeHtml(errs[0]) + '</p>' +
                    '<p>The disputes are still there — this screen cannot read them.</p>' +
                '</div>';
            return;
        }

        renderSupDisputes(parsed.openCount || 0);

        if (errs.length > 0) {
            panel.innerHTML =
                '<div class="exc-warn">' +
                    '<b>' + errs.length + ' dispute(s) could not be read and are missing below.</b>' +
                    '<div class="exc-warn-quote">' + escapeHtml(errs[0]) + '</div>' +
                '</div>' + panel.innerHTML;
        }
    }).catch(function (err) {
        console.error('getSupervisorDisputes error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

function renderSupDisputes(openCount) {
    var panel = document.getElementById('panel-disputes');

    if (supDisputes.length === 0) {
        panel.innerHTML =
            '<div class="panel-placeholder">' +
                '<h2>Nothing in dispute</h2>' +
                '<p>Everything the store issued to you, and everything you sent back, has been accounted for.</p>' +
            '</div>';
        setTabCount('count-disputes', 0);
        return;
    }

    var rows = supDisputes.map(function (d, i) {
        var inbound = supDisputeIsInbound(d);
        return '<tr>' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(d.material || '—') +
                    (d.isWaste ? '<span class="waste-badge">&#9851; waste</span>' : '') +
                    (inbound
                        ? '<span class="dir-badge dir-in">&#8601; you sent back</span>'
                        : '<span class="dir-badge dir-out">&#8599; issued to you</span>') +
                '</div>' +
                // The size is how he remembers which remnant this was — the
                // material name alone matches a dozen rows.
                (d.isWaste && d.length > 0
                    ? '<div class="mat-sku">' + fmt(d.length) + ' × ' + fmt(d.width) + ' cm</div>'
                    : '') +
                '<div class="mat-sku">' + escapeHtml(d.salesOrder || '') +
                    (d.planNo ? ' · ' + escapeHtml(d.planNo) : '') + '</div>' +
            '</td>' +
            '<td class="col-num">' + fmt(d.issued) + '<span class="unit">' + escapeHtml(d.unit || '') + '</span></td>' +
            '<td class="col-num">' + fmt(d.received) + '<span class="unit">' + escapeHtml(d.unit || '') + '</span></td>' +
            '<td class="col-num col-strong"><span class="qty-big">' + fmt(d.remaining) +
                '<span class="unit">' + escapeHtml(d.unit || '') + '</span></span></td>' +
            '<td class="col-raised">' + escapeHtml(d.raisedOn || '—') + '</td>' +
            '<td class="col-action">' +
                // Two answers, because those are the only two he can give. He
                // cannot know what the store did with its own stock, and nobody
                // declares something lost on their own.
                //
                // Worded the way a person would say it: whether the material is
                // in his hands or not. "Over-declared" and "denied" are the
                // system's names for these, not his.
                // Once he has answered, correcting himself stays open — a denial
                // settles nothing, so locking it would leave writing the pieces
                // off as lost as the only way out, even when the truth is that he
                // miscounted. But it stops being the obvious thing to press: it
                // is now a change of answer, and it says so.
                '<div class="row-actions">' +
                    // The likeliest truth on an inbound line: they never left his
                    // table. Without this he has to either deny pieces that exist
                    // or claim they never did, and both end somewhere false.
                    (inbound
                        ? '<button type="button" class="raise-btn" onclick="openFoundDialog(' + i + ',true)">' +
                          'I still have them, sending now</button>'
                        : '') +
                    '<button type="button" class="raise-btn' +
                        (inbound || d.supervisorDenied ? ' is-stale' : '') +
                        '" onclick="openFoundDialog(' + i + ')">' +
                        (d.supervisorDenied ? 'Actually, ' : '') +
                        (inbound ? 'I miscounted, they never existed' : 'I have it') + '</button>' +
                    (d.supervisorDenied
                        ? '<span class="denied-tag" title="You have already answered this one">' +
                          'You answered</span>'
                        : '<button type="button" class="raise-btn is-stale" onclick="openDenyDialog(' + i + ')">' +
                          (inbound ? 'I don&rsquo;t have them, I sent them' : 'I don&rsquo;t have it') + '</button>') +
                '</div>' +
            '</td>' +
        '</tr>';
    }).join('');

    panel.innerHTML =
        '<div class="item-card">' +
            '<div class="item-header static-header">' +
                '<div class="item-header-info">' +
                    '<h2>Material nobody can account for</h2>' +
                    '<div class="item-meta-line is-prose"><span>Either you confirmed less than the ' +
                        'store issued, or the store received fewer leftover pieces back than you ' +
                        'declared. Answer for your own side only: if you have it, or if you ' +
                        'declared more than you sent, say so and it settles. If you stand by ' +
                        'what you said, say that — it only counts as lost once the store has ' +
                        'also looked.</span></div>' +
                '</div>' +
            '</div>' +
            '<div class="item-body is-open">' +
                '<div class="tables-container">' +
                    '<div class="table-wrapper">' +
                        '<table><thead><tr>' +
                            '<th>Material</th>' +
                            // Not "Issued"/"You confirmed": on an inbound row he
                            // is the one who handed over and the store is the one
                            // who confirmed. A column has to mean the same thing
                            // on every row of the table.
                            '<th class="col-num">Handed over</th>' +
                            '<th class="col-num">Confirmed</th>' +
                            '<th class="col-num">Missing</th>' +
                            '<th class="col-raised">Raised</th>' +
                            '<th class="col-action">Your answer</th>' +
                        '</tr></thead><tbody>' + rows + '</tbody></table>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    setTabCount('count-disputes', openCount);
}

// One dialog for his own answer, whichever direction it is. The shape is the
// same — a quantity and a reason — and only the words change, so a second dialog
// would be the same code with different labels and one more place to fix.
function openFoundDialog(idx, resend) {
    var d = supDisputes[idx];
    if (!d) return;
    var el = supModalEl();
    var inbound = supDisputeIsInbound(d);
    // Same shape either way — a quantity and a reason — so the resend answer
    // rides this dialog rather than earning a third copy of it.
    resend = !!resend && inbound;

    el.classList.remove('hidden');
    el.innerHTML =
        '<div class="exc-panel">' +
            '<h3>' + (resend
                ? 'I still have them &mdash; sending them now'
                : (inbound ? 'I miscounted &mdash; these pieces never existed' : 'Found it')) + '</h3>' +
            '<p class="exc-sub">' + escapeHtml(d.material || '') +
                (d.isWaste && d.length > 0
                    ? ' &middot; ' + fmt(d.length) + ' × ' + fmt(d.width) + ' cm'
                    : '') + '</p>' +
            '<div class="exc-facts">' +
                '<span>' + (inbound ? 'You declared' : 'Issued') + ' <b>' + fmt(d.issued) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
                '<span>' + (inbound ? 'Store found' : 'You confirmed') + ' <b>' + fmt(d.received) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
                '<span class="exc-strong">Missing <b>' + fmt(d.remaining) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
            '</div>' +

            // What the store said when it raised this. He is answering a
            // question, and it helps to be able to read it.
            (d.raisedNote
                ? '<div class="exc-quote">Raised as: &ldquo;' + escapeHtml(d.raisedNote) + '&rdquo;</div>'
                : '') +

            // He is contradicting himself, which is allowed — people recount and
            // find they were wrong. But it must not happen by accident, and the
            // store is going to read both answers side by side.
            (d.supervisorDenied && !resend
                ? '<div class="exc-warn">' +
                      '<b>You have already told the store the opposite.</b>' +
                      '<div>You said ' + (inbound
                          ? 'you did send these back'
                          : 'it was not with you') +
                          '. Saving this says the opposite for the amount you enter, ' +
                          'and both answers stay on the record.</div>' +
                  '</div>'
                : '') +

            '<label class="exc-label">' +
                (resend
                    ? 'How many are you sending back now?'
                    : (inbound ? 'How many did you count that were never there?' : 'How much have you found?')) +
            '</label>' +
            '<input type="number" id="found-qty" ' +
                (inbound ? 'step="1"' : 'step="0.01"') +
                ' min="0" max="' + d.remaining + '" value="' + d.remaining + '">' +
            '<p class="exc-hint">' +
                (resend
                    ? 'They go back on the store&rsquo;s check-in list, and the store confirms them the ordinary way.'
                    : (inbound
                        ? 'Only for pieces you never actually cut. If they exist and you still have them, use &ldquo;I still have them&rdquo; instead.'
                        : 'If only part of it turned up, enter that — the rest stays open.')) +
            '</p>' +

            '<label class="exc-label">' +
                (resend ? 'Where were they?' : (inbound ? 'What happened?' : 'Where was it?')) + '</label>' +
            '<textarea id="found-note" rows="2" placeholder="' +
                (resend
                    ? 'e.g. still on my table, going over with the next trolley'
                    : (inbound
                        ? 'e.g. typed 5 by mistake, only 3 came off the roll'
                        : 'e.g. still on the trolley behind the cutting table')) +
                '"></textarea>' +

            '<div class="exc-foot">' +
                '<button type="button" class="ghost-btn" onclick="closeSupModal()">Cancel</button>' +
                '<button type="button" class="primary-btn" id="found-send" ' +
                    'onclick="submitFound(' + idx + ',' + (resend ? 'true' : 'false') + ')">' +
                    (resend ? 'Send them back' : 'Confirm') + '</button>' +
            '</div>' +
        '</div>';
}

function submitFound(idx, resend) {
    var d = supDisputes[idx];
    if (!d) return;

    var inbound = supDisputeIsInbound(d);
    resend = !!resend && inbound;

    var qty = parseFloat(document.getElementById('found-qty').value);
    if (isNaN(qty) || qty <= 0) {
        alert(resend
            ? 'Enter how many you are sending back.'
            : (inbound
                ? 'Enter how many you counted that were never there.'
                : 'Enter how much you have found.'));
        return;
    }

    var note = document.getElementById('found-note').value;
    if (!note.trim()) {
        // The store person is going to read this and decide whether to stop
        // looking. An answer with no reason tells them nothing.
        alert(resend
            ? 'Say where they were — the store is still looking for them.'
            : (inbound
                ? 'Say what happened — the store is still looking for those pieces.'
                : 'Say where you found it — the store is still looking.'));
        return;
    }

    // Reversing his own answer is allowed, but not by a stray click. The store
    // has already acted on what he said the first time.
    if (d.supervisorDenied && !resend) {
        var ok = confirm(
            'You already told the store ' +
            (inbound ? 'you did send these back.' : 'it was not with you.') +
            '\n\nSaving this says the opposite for ' + qty + ' ' + (d.unit || '') +
            '. Both answers stay on the record.'
        );
        if (!ok) return;
    }

    var btn = document.getElementById('found-send');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'resolveDispute',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                disputeId: String(d.id),
                qty: qty,
                // The only outcome he can declare on his own, and which one
                // that is depends on which way the material was going.
                resolution: resend ? 'Supervisor_Resending' : supOwnResolution(d),
                side: 'supervisor',
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
            closeSupModal();
            // The dispute closes but the pieces are not settled — they are on
            // their way. Saying so is the difference between "done" and "the
            // store still has to check these in".
            if (resend) {
                alert('Recorded. Send the ' + qty + ' ' + (d.unit || '') +
                    ' across — they are on the store\'s check-in list now, and ' +
                    'the store confirms them the ordinary way.');
                // His returns tab is the place that tracks them from here.
                if (typeof loadSupWaste === 'function') {
                    tabsLoaded.waste = true;
                    loadSupWaste();
                }
            }
            loadSupDisputes();
        } else {
            alert('Could not save it: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
            btn.textContent = resend ? 'Send them back' : 'Confirm';
        }
    }).catch(function (err) {
        console.error('resolveDispute error:', err);
        alert('Failed to reach the server. Check the console.');
        btn.disabled = false;
        btn.textContent = resend ? 'Send them back' : 'Confirm';
    });
}

// Standing by what he said. Resolves nothing on its own — it records that he has
// looked. Only when the store has also looked and come up empty does the
// material get written off, and then the system does it rather than either of
// them. Outbound that reads "not with me"; inbound it reads "I did send them".
function openDenyDialog(idx) {
    var d = supDisputes[idx];
    if (!d) return;
    var el = supModalEl();
    var inbound = supDisputeIsInbound(d);

    var closes = d.storeDenied;

    el.classList.remove('hidden');
    el.innerHTML =
        '<div class="exc-panel">' +
            '<h3>' + (inbound
                ? 'I don&rsquo;t have them &mdash; I sent them back'
                : 'I don&rsquo;t have it') + '</h3>' +
            '<p class="exc-sub">' + escapeHtml(d.material || '') +
                (d.isWaste && d.length > 0
                    ? ' &middot; ' + fmt(d.length) + ' × ' + fmt(d.width) + ' cm'
                    : '') + '</p>' +
            '<div class="exc-facts">' +
                '<span>' + (inbound ? 'You declared' : 'Issued') + ' <b>' + fmt(d.issued) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
                '<span>' + (inbound ? 'Store found' : 'You confirmed') + ' <b>' + fmt(d.received) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
                '<span class="exc-strong">Missing <b>' + fmt(d.remaining) + ' ' + escapeHtml(d.unit || '') + '</b></span>' +
            '</div>' +

            (d.raisedNote
                ? '<div class="exc-quote">Raised as: &ldquo;' + escapeHtml(d.raisedNote) + '&rdquo;</div>'
                : '') +

            (closes
                ? '<div class="exc-warn">' +
                      '<b>The store has already said it is not with them.</b>' +
                      (d.storeNote
                          ? '<div class="exc-warn-quote">&ldquo;' + escapeHtml(d.storeNote) + '&rdquo;</div>'
                          : '') +
                      '<div>Saying the same means nobody has it: the ' +
                      fmt(d.remaining) + ' ' + escapeHtml(d.unit || '') +
                      (inbound
                          // No requirement re-opens on this leg — the offcuts
                          // were never owed to an order, so promising him a
                          // re-issue would be promising work that never comes.
                          ? ' is written off as lost. The store never had those leftover pieces, so nothing will be issued back to you.'
                          : ' is written off as lost, and the store issues it to you again.') +
                      '</div>' +
                  '</div>'
                : '<p class="exc-hint">This does not close the dispute. The store still has to check its own side ' +
                  '— it only counts as lost if neither of you has it.</p>') +

            '<label class="exc-label">' +
                (inbound ? 'What did you send, and when?' : 'Where have you looked?') + '</label>' +
            '<textarea id="deny-note" rows="2" placeholder="' +
                (inbound
                    ? 'e.g. sent all 5 back with the trolley on Monday morning'
                    : 'e.g. checked the cutting table, the trolley and my own shelf') +
                '"></textarea>' +

            '<div class="exc-foot">' +
                '<button type="button" class="ghost-btn" onclick="closeSupModal()">Cancel</button>' +
                '<button type="button" class="primary-btn' + (closes ? ' is-danger' : '') + '" id="deny-send" ' +
                    'onclick="submitDeny(' + idx + ')">' +
                    (closes ? 'Confirm — write it off' : 'Confirm') +
                '</button>' +
            '</div>' +
        '</div>';
}

function submitDeny(idx) {
    var d = supDisputes[idx];
    if (!d) return;

    var inbound = supDisputeIsInbound(d);

    var note = document.getElementById('deny-note').value;
    if (!note.trim()) {
        // The store person reads this to decide where to look next. A bare
        // denial sends them back to the beginning.
        alert(inbound
            ? 'Say what you sent and when — the store has to search from here.'
            : 'Say where you have looked — the store has to search from here.');
        return;
    }

    var btn = document.getElementById('deny-send');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'resolveDispute',
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                disputeId: String(d.id),
                // A denial covers everything still outstanding — he is not
                // saying he has some of it, he is saying he has none.
                qty: d.remaining,
                resolution: 'Denied',
                side: 'supervisor',
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
            closeSupModal();
            if (parsed.waitingOn) {
                alert('Recorded. The store now has to check their side.');
            } else if (parsed.applied === 'Lost') {
                alert(inbound
                    ? 'Neither side has them, so they have been written off. They ' +
                      'store never had them, so nothing comes back to you.'
                    : 'Neither side has it, so it has been written off. The store ' +
                      'will issue the material to you again.');
            }
            loadSupDisputes();
        } else {
            alert('Could not save it: ' + ((parsed && parsed.error) || 'unknown error'));
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

// ---- Waste returns ----
//
// Offcuts he declared after cutting, and whether the store has checked them in.
// Read-only on purpose: confirming his own return would defeat the point of the
// store checking it. This just tells him whether it happened.

// How far back the list looks. The server bounds the query by this, so it is
// not just a display filter — every Declared movement in the window costs a
// plan lookup, and the unbounded version was a statement-limit failure waiting
// to happen.
var wasteDays = 30;

function loadSupWaste() {
    var panel = document.getElementById('panel-waste');
    var supId = currentSupervisorId();

    if (!supId) {
        panel.innerHTML = '<div class="panel-placeholder"><h2>Choose a supervisor</h2>' +
            '<p>Pick who you are from the header to see what you have returned.</p></div>';
        return;
    }

    panel.innerHTML = wasteBar() + '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getSupervisorWasteReturns',
        http_method: 'POST',
        payload: { supervisorId: String(supId), daysTxt: String(wasteDays) }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getSupervisorWasteReturns parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the list</h2><p>Check the browser console.</p></div>';
            return;
        }
        renderSupWaste(parsed.pieces || [], parsed.waitingCount || 0);
    }).catch(function (err) {
        console.error('getSupervisorWasteReturns error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

function setWasteDays(d) {
    wasteDays = d;
    loadSupWaste();
}

// 0 is today only — the server leaves the cutoff at today rather than stepping
// back a day, so the shortest window is a single shift rather than two.
function wasteRangeLabel(d) {
    return d === 0 ? 'Today' : d + ' days';
}

function wasteBar() {
    // 90 dropped deliberately. getSupervisorWasteReturns scans EVERY
    // supervisor's Declared movements in the window and works out whose they are
    // by looking up the plan per row — so his screen pays the whole factory's
    // cost, and this window is the only thing bounding it. The
    // statement-execution limit is not catchable: it kills the script and the
    // widget gets a bare 500 with no error card.
    //
    // 30 days is already more than a shift log needs, and anything older than
    // that is a conversation rather than a screen.
    var opts = [0, 7, 30];
    return '<div class="day-bar">' +
        // The label has to stop saying "in the last" once Today is an option —
        // "Declared in the last Today" is not a sentence.
        '<span class="range-label">Declared</span>' +
        opts.map(function (d) {
            return '<button type="button" class="raise-btn' +
                (d === wasteDays ? '' : ' is-stale') +
                '" onclick="setWasteDays(' + d + ')">' + wasteRangeLabel(d) + '</button>';
        }).join('') +
        '</div>';
}

function wasteStatusLabel(status) {
    if (status === 'Pending_Receipt') return { text: 'Waiting for store', cls: 'status-partial' };
    // "On the rack" described where it sits, which is the store's business. What
    // he needs to know is that his return was accepted and the loop is closed.
    if (status === 'Available') return { text: 'Checked in', cls: 'status-sufficient' };
    if (status === 'Scrapped') return { text: 'Scrapped', cls: 'status-shortfall' };
    if (status === 'Consumed') return { text: 'Used again', cls: 'status-sufficient' };
    if (status === 'Issued') return { text: 'Issued out', cls: 'status-sufficient' };
    return { text: status || '—', cls: 'status-partial' };
}

function renderSupWaste(pieces, waitingCount) {
    var panel = document.getElementById('panel-waste');
    var bar = wasteBar();

    if (pieces.length === 0) {
        panel.innerHTML = bar +
            '<div class="panel-placeholder">' +
                '<h2>' + (wasteDays === 0
                    ? 'Nothing returned today'
                    : 'Nothing returned in this period') + '</h2>' +
                '<p>Leftover pieces you declare at the end of a cutting stage are listed here. ' +
                    'Try a longer period above.</p>' +
            '</div>';
        setTabCount('count-waste', 0);
        return;
    }

    // Anything still waiting on the store goes to the top. Those are the only
    // rows he can act on; the rest are a record, and a record does not need to
    // be read before the open question.
    var sorted = pieces.slice().sort(function (a, b) {
        var aw = a.status === 'Pending_Receipt' ? 0 : 1;
        var bw = b.status === 'Pending_Receipt' ? 0 : 1;
        return aw - bw;
    });

    var rows = sorted.map(function (p) {
        var s = wasteStatusLabel(p.status);
        return '<tr>' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(p.material || '—') + '</div>' +
                '<div class="mat-sku">' + escapeHtml(p.salesOrder || '') +
                    (p.planNo ? ' · ' + escapeHtml(p.planNo) : '') + '</div>' +
            '</td>' +
            '<td><span class="cut-size">' + fmt(p.length) + ' &times; ' + fmt(p.width) +
                '<span class="unit">cm</span></span></td>' +
            '<td class="col-num col-strong">' + p.count + '<span class="unit">pcs</span></td>' +
            '<td><span class="status-pill ' + s.cls + '">' + escapeHtml(s.text) + '</span></td>' +
            '<td>' + escapeHtml(p.declaredOn || '—') + '</td>' +
        '</tr>';
    }).join('');

    panel.innerHTML = bar +
        '<div class="item-card">' +
            '<div class="item-header static-header">' +
                '<div class="item-header-info">' +
                    '<h2>Waste you have returned</h2>' +
                    // The only fact he came for is whether anything is still
                    // outstanding. "Everything here has been checked in" said
                    // that sideways, and repeated what the Status column
                    // already says on every row.
                    '<div class="item-meta-line"><span>' +
                        (waitingCount > 0
                            ? '<b>' + waitingCount + ' waiting on the store</b>'
                            : 'Nothing waiting on the store') +
                        ' · ' + pieces.length +
                        (wasteDays === 0
                            ? ' declared today'
                            : ' declared in the last ' + wasteDays + ' days') +
                    '</span></div>' +
                '</div>' +
            '</div>' +
            '<div class="item-body is-open">' +
                '<div class="tables-container">' +
                    '<div class="table-wrapper">' +
                        '<table><thead><tr>' +
                            '<th>Material</th>' +
                            '<th>Cut piece size <span class="cut-axis">(L &times; W)</span></th>' +
                            '<th class="col-num">Pieces</th>' +
                            '<th>Status</th>' +
                            '<th>Declared</th>' +
                        '</tr></thead><tbody>' + rows + '</tbody></table>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    setTabCount('count-waste', waitingCount);
}

TAB_LOADERS.disputes = loadSupDisputes;
TAB_LOADERS.waste = loadSupWaste;

// ---- Production history ----
//
// What he actually produced between two dates. Driven off Stage_Log, so the
// range means "work done in these days" rather than "orders raised then" —
// different questions, and only the first is a history.
//
// A separate tab rather than a filter on Production: finished work is a
// different thing from work in hand, and mixing them made the order picker
// carry two meanings at once.

// ONE DAY, not a range. This screen is a shift log — "what did I get through
// today" — where the store's History is an audit trail that legitimately spans
// weeks. Prev / next arrows rather than two date boxes, because on a day view
// "yesterday" is the commonest thing to ask for and it should cost one click.
var histDay = null;

function histDeluge(d) {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return String(d.getDate()).padStart(2, '0') + '-' + months[d.getMonth()] + '-' + d.getFullYear();
}

function histInput(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

function histToday() {
    var t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
}

function loadSupHistory() {
    var panel = document.getElementById('panel-history');
    var supId = currentSupervisorId();

    if (!histDay) histDay = histToday();

    if (!supId) {
        panel.innerHTML = '<div class="panel-placeholder"><h2>Choose a supervisor</h2>' +
            '<p>Pick who you are from the header to see what you have produced.</p></div>';
        return;
    }

    panel.innerHTML = histBar(null, 0, 0) + '<div class="panel-loading">Loading…</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getSupervisorProductionHistory',
        http_method: 'POST',
        payload: {
            supervisorId: String(supId),
            dateTxt: histDeluge(histDay)
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getSupervisorProductionHistory parse failed:', e, response.result);
            panel.innerHTML = '<div class="panel-placeholder"><h2>Could not read the history</h2><p>Check the browser console.</p></div>';
            return;
        }
        if (parsed.errors && parsed.errors.length > 0) {
            panel.innerHTML = histBar([], 0, 0) +
                '<div class="panel-placeholder"><h2>Could not load that day</h2><p>' +
                escapeHtml(parsed.errors.join(' ')) + '</p></div>';
            return;
        }
        renderSupHistory(parsed.items || [], parsed.stageCount || 0,
            parsed.producedTotal || 0, parsed.receipts || []);
    }).catch(function (err) {
        console.error('getSupervisorProductionHistory error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2><p>Check the browser console.</p></div>';
    });
}

function onHistDayChange() {
    var v = document.getElementById('hist-day').value;
    if (!v) return;

    // Parsed as local. new Date("2026-08-01") is treated as UTC and lands on
    // the previous day for anyone east of Greenwich.
    var p = v.split('-');
    histDay = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    loadSupHistory();
}

// Forward past today is refused rather than silently clamped — the button is
// already disabled, so anything reaching here is a mis-click and moving him to
// a day he did not ask for would be worse than doing nothing.
function histStep(days) {
    var next = new Date(histDay.getTime());
    next.setDate(next.getDate() + days);
    if (next > histToday()) return;
    histDay = next;
    loadSupHistory();
}

function histGoToday() {
    histDay = histToday();
    loadSupHistory();
}

function isHistToday() {
    return histDay && histDay.getTime() === histToday().getTime();
}

function histBar(items, stageCount, producedTotal) {
    var summary = '';
    if (items !== null) {
        summary = items.length === 0
            ? 'Nothing produced on this day'
            : items.length + ' item' + (items.length === 1 ? '' : 's') +
              ' · ' + stageCount + ' stage' + (stageCount === 1 ? '' : 's') +
              ' · ' + producedTotal + ' pcs finished';
    }

    var onToday = isHistToday();

    return '' +
        '<div class="day-bar">' +
            '<button type="button" class="raise-btn is-ghost" onclick="histStep(-1)" ' +
                'title="Previous day">&larr;</button>' +
            '<input type="date" id="hist-day" value="' + histInput(histDay) +
                '" max="' + histInput(histToday()) + '" onchange="onHistDayChange()">' +
            // Disabled rather than hidden on today — a button that disappears
            // makes people wonder what they did wrong.
            '<button type="button" class="raise-btn is-ghost" onclick="histStep(1)" ' +
                'title="Next day"' + (onToday ? ' disabled' : '') + '>&rarr;</button>' +
            '<button type="button" class="raise-btn is-ghost" onclick="histGoToday()"' +
                (onToday ? ' disabled' : '') + '>Today</button>' +
            '<span class="day-bar-sub">' + escapeHtml(summary) + '</span>' +
        '</div>';
}

// What the store handed him over the same days.
//
// ONE ROW PER MATERIAL, not per handover. Material_Issue carries one Issue_Line
// per plan item, so a single delivery repeats the same material several times —
// the first version of this listed them inline and produced a cell reading
// "DMC Embroidery Thread 30 Cone · DMC Embroidery Thread 30 Cone · DMC…" that
// ran off the side of the table.
//
// He carried that thread once. His own Receive tab already states the rule —
// "one line per physical thing, not per order" — so this follows it rather than
// inventing a third way to lay out the same event.
//
// EACH MATERIAL ROW KEEPS ITS PER-ITEM SPLIT as forItems[], rolled up from the
// same lines by (itemName, itemStatus). This is the "how was this handover
// divided" detail — the store fanned one press of Issue across several of his
// items, and this is which line went where. It is honest per line: Issue_Lines
// carries Plan_Item on every row (getSupervisorProductionHistory now emits it),
// unlike Material_Issue.Plan on the header, which is why the row itself still
// names no single order. Lines with no item fold into one blank-name bucket.
function supReceiptRows(receipts) {
    var rows = [];

    (receipts || []).forEach(function (r) {
        var byMat = {};
        var order = [];

        (r.lines || []).forEach(function (l) {
            // Unit is part of the key: the same name in Mtr and in Pcs is two
            // different things and must never be added together.
            //
            // JSON.stringify, not a separator character. A material name is
            // free text, and any sentinel picked out of it could appear
            // inside it.
            var key = JSON.stringify([l.material || '', l.unit || '']);
            if (!byMat[key]) {
                byMat[key] = {
                    material: l.material || '—', unit: l.unit || '', qty: 0,
                    itemsByKey: {}, itemOrder: []
                };
                order.push(key);
            }
            var g = byMat[key];
            g.qty += Number(l.qty) || 0;

            var iName = l.itemName || '';
            var iStat = l.itemStatus || '';
            var iKey = JSON.stringify([iName, iStat]);
            if (!g.itemsByKey[iKey]) {
                g.itemsByKey[iKey] = { name: iName, status: iStat, qty: 0 };
                g.itemOrder.push(iKey);
            }
            g.itemsByKey[iKey].qty += Number(l.qty) || 0;
        });

        order.forEach(function (k) {
            var g = byMat[k];
            var forItems = g.itemOrder.map(function (ik) { return g.itemsByKey[ik]; });
            // Nothing to show if the whole material went to a single unnamed
            // bucket — that is the old pre-Plan_Item handover, and a one-row
            // breakdown repeating the material name earns nothing.
            var hasSplit = forItems.length > 1 ||
                (forItems.length === 1 && forItems[0].name !== '');
            rows.push({
                time: r.time || '—',
                settled: r.status === 'Received',
                material: g.material,
                unit: g.unit,
                qty: g.qty,
                forItems: hasSplit ? forItems : []
            });
        });
    });

    return rows;
}

function renderSupReceipts(receipts) {
    var rows = supReceiptRows(receipts);
    if (rows.length === 0) return '';

    // No date column — every row on this screen is the same day, and a column
    // that repeats one value is a column that earns nothing. Time stays: two
    // handovers in a morning are worth telling apart.
    //
    // No order column in the MAIN row — a handover is one press of Issue against
    // a SUPERVISOR, and the store fans that quantity across several of his open
    // plans, so the header has no single right answer. But the per-line split
    // IS honest (Issue_Lines.Plan_Item), so it hangs under the material as
    // sub-rows: "→ Napkins  40 Mtr  In production". Shown only when the material
    // actually went to a named item (forItems set by supReceiptRows).
    var html = rows.map(function (r) {
        var mainRow = '<tr>' +
            '<td>' + escapeHtml(r.time) + '</td>' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(r.material) + '</div>' +
            '</td>' +
            '<td class="col-num col-strong">' + fmt(r.qty) +
                '<span class="unit">' + escapeHtml(r.unit) + '</span></td>' +
            // Never the raw Issue_Status. "Issued" is the store's word for its
            // own action and tells him nothing about what he still has to do.
            '<td><span class="status-pill ' + (r.settled ? 'status-sufficient' : 'status-partial') + '">' +
                (r.settled ? 'Received' : 'Awaiting your check') +
            '</span></td>' +
        '</tr>';

        var splitRows = (r.forItems || []).map(function (it) {
            var lbl = itemStatusLabel(it.status);
            return '<tr class="recv-split-row">' +
                '<td></td>' +
                '<td class="recv-split-item">&rarr; ' +
                    escapeHtml(it.name || 'Unassigned') + '</td>' +
                '<td class="col-num">' + fmt(it.qty) +
                    '<span class="unit">' + escapeHtml(r.unit) + '</span></td>' +
                '<td>' + (lbl ? '<span class="recv-split-status">' +
                    escapeHtml(lbl) + '</span>' : '') + '</td>' +
            '</tr>';
        }).join('');

        return mainRow + splitRows;
    }).join('');

    var handovers = (receipts || []).length;

    // Collapsed by default. What he came to this tab for is what he PRODUCED;
    // material in is context, and seventeen lines of it pushed the first item
    // card off the bottom of the screen. The count stays in the header, so the
    // card answers "did anything arrive today" without being opened.
    return '' +
        '<div class="item-card" id="sup-recv-card">' +
            '<div class="item-header" onclick="toggleSupReceipts()">' +
                '<div class="item-header-info">' +
                    '<h2>Material you received</h2>' +
                    '<div class="item-meta-line"><span>' + rows.length +
                        (rows.length === 1 ? ' line' : ' lines') + ' across ' + handovers +
                        (handovers === 1 ? ' handover' : ' handovers') + '</span></div>' +
                '</div>' +
                '<div class="item-header-right">' +
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
                            '<th>Time</th><th>Material</th><th class="col-num">Qty</th>' +
                            '<th>Status</th>' +
                        '</tr></thead><tbody>' + html + '</tbody></table>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
}

function toggleSupReceipts() {
    var card = document.getElementById('sup-recv-card');
    if (card) card.classList.toggle('open');
}

function renderSupHistory(items, stageCount, producedTotal, receipts) {
    var panel = document.getElementById('panel-history');
    var bar = histBar(items, stageCount, producedTotal);
    var recv = renderSupReceipts(receipts);

    if (items.length === 0) {
        // Material in but nothing produced is a real state, not an empty one —
        // it is exactly what a day spent waiting on cloth looks like.
        panel.innerHTML = bar + recv +
            '<div class="panel-placeholder">' +
                '<h2>Nothing produced on this day</h2>' +
                '<p>Only finished stages are listed. Work still in progress is on the Production tab.</p>' +
            '</div>';
        return;
    }

    var cards = items.map(function (it) {
        // No date column — every stage on this screen ran on the day in the
        // picker. Stages stay in the order the work happened even though the
        // cards are newest-first: a production flow printed backwards is
        // unreadable.
        var rows = (it.stages || []).map(function (s) {
            return '<tr>' +
                '<td class="material-name-cell"><div class="mat-name">' + escapeHtml(s.phase || '—') + '</div></td>' +
                '<td>' + escapeHtml(s.operator || '—') + '</td>' +
                '<td>' + escapeHtml(s.start || '—') + ' &ndash; ' + escapeHtml(s.end || '—') + '</td>' +
                '<td class="col-num">' + fmt(s.qtyIn) + '</td>' +
                '<td class="col-num col-strong">' + fmt(s.qtyOut) + '</td>' +
            '</tr>';
        }).join('');

        var done = it.status === 'Complete';
        var waiting = it.status === 'Awaiting_Check';
        var nStages = (it.stages || []).length;

        // qtyOrdered and qtyProduced belong to the WHOLE item, not to this day —
        // an item's stages run across days, so an unlabelled "80 pcs" beside one
        // day's stitching reads as "I made 80 today" when it was earned over
        // three days. Said explicitly rather than dropped: without knowing how
        // far the item has got, a day's stage rows are hard to act on.
        //
        // THREE STATES NOW, not two. Production finishing is Awaiting_Check;
        // Complete means the inspector has signed it off. Reading the old
        // two-way test on the new data called a finished batch "still in
        // production" on the very day it was finished.
        var progress;
        if (done) {
            progress = 'Finished · ' + fmt(it.qtyProduced) + ' of ' + fmt(it.qtyOrdered) + ' pcs (whole item)';
        } else if (waiting) {
            progress = 'With the checker · ' + fmt(it.qtyProduced) + ' of ' + fmt(it.qtyOrdered) + ' pcs made';
        } else {
            progress = 'Still in production · ordered ' + fmt(it.qtyOrdered) + ' pcs';
        }

        // WHAT CAME BACK FROM INSPECTION. Without this his batch vanishes into
        // "Finished" and the rejected pieces reappear days later as a new batch
        // with nothing connecting the two. Only present once a check exists.
        var chk = it.check;
        var chkHtml = '';
        if (chk) {
            var bits = [];
            if (Number(chk.approved) > 0) bits.push('<b>' + fmt(chk.approved) + '</b> approved');
            if (Number(chk.rejected) > 0) bits.push('<b>' + fmt(chk.rejected) + '</b> rejected');
            if (Number(chk.alteration) > 0) bits.push('<b>' + fmt(chk.alteration) + '</b> to alter');
            chkHtml =
                '<div class="check-outcome">' +
                    '<span class="check-outcome-head">Checked' +
                        (chk.checkedOn ? ' ' + escapeHtml(chk.checkedOn) : '') +
                        (chk.inspector ? ' by ' + escapeHtml(chk.inspector) : '') +
                        (Number(chk.round) > 1 ? ' · round ' + fmt(chk.round) : '') +
                    '</span>' +
                    '<span class="check-outcome-nums">' + bits.join(' · ') + '</span>' +
                '</div>';
        }

        return '' +
            '<div class="item-card">' +
                '<div class="item-header static-header">' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(it.item || '—') + '</h2>' +
                        '<div class="item-meta-line"><span>' +
                            escapeHtml(it.salesOrder || '') +
                            (it.planNo ? ' · ' + escapeHtml(it.planNo) : '') +
                            ' · ' + nStages + ' stage' + (nStages === 1 ? '' : 's') + ' today' +
                        '</span></div>' +
                    '</div>' +
                    '<div class="item-header-right">' +
                        '<span class="status-pill ' + (done ? 'status-sufficient' : waiting ? 'status-waiting' : 'status-partial') + '">' +
                            progress +
                        '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="item-body is-open">' +
                    chkHtml +
                    '<div class="tables-container">' +
                        '<div class="table-wrapper">' +
                            '<table><thead><tr>' +
                                '<th>Stage</th><th>Operator</th><th>Time</th>' +
                                '<th class="col-num">In</th><th class="col-num">Out</th>' +
                            '</tr></thead><tbody>' + rows + '</tbody></table>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }).join('');

    panel.innerHTML = bar + recv + cards;
}

TAB_LOADERS.history = loadSupHistory;
