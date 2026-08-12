// Sending an item out to a third party, and taking it back.
//
// Loaded after production.js — reads `parties`, `plans`, `qtyInFor`, `nowHHMM`
// and `fetchAllData` from it, and production.js looks these functions up by name
// when it renders an item card.
//
// ONE ITEM, A CONTIGUOUS BLOCK OF STAGES, ONE TRIP. He hands over panels once
// and the vendor runs several operations before handing them back — one van, one
// gate, one return. Recording that as three separate sends would invent three
// physical movements that never happened.
//
// NO PARTIAL RETURNS. A partial return is only worth anything if he can carry on
// producing with what came back, and he cannot — the next stage would take its
// Qty_In from a figure still due to change. So the return is all-or-nothing, and
// closing short is what tells the system the rest are lost.

var outsourceCtx = null;

function osModalEl() {
    var el = document.getElementById('os-modal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'os-modal';
        el.className = 'exc-modal hidden';
        document.body.appendChild(el);
    }
    return el;
}

function closeOsDialog() {
    osModalEl().classList.add('hidden');
    outsourceCtx = null;
}

// ---- Which parties can run a stage ----
//
// EXACT string equality, never a substring test — the stage names collide.
// "Machine Embroidery" is inside "Manual Machine Embroidery". Same reason the
// server sends every party and filters none: a Deluge query on a multi-select
// can only use "contains", which is exactly the substring test that gets this
// wrong.
function partiesForStage(stageName) {
    var want = String(stageName || '').trim();
    if (!want) return [];
    return (typeof parties === 'undefined' ? [] : parties).filter(function (p) {
        return (p.stages || []).some(function (s) { return String(s).trim() === want; }) &&
            String(p.status) !== 'Inactive';
    });
}

function partyById(id) {
    if (!id) return null;
    var list = (typeof parties === 'undefined' ? [] : parties);
    return list.find(function (p) { return String(p.id) === String(id); }) || null;
}

// ---- The block currently out, if any ----
//
// Grouped on Outsource_Ref rather than inferred from item + party + date, which
// would have merged two sends of the same item to the same party on one day into
// a single apparent trip.
function openOsBlock(item) {
    var out = (item.logs || []).filter(function (l) {
        return l.outsourced === true && !l.returnedOn;
    });
    if (out.length === 0) return null;

    var ref = out[0].outsourceRef || '';
    var rows = out.filter(function (l) { return (l.outsourceRef || '') === ref; });

    var phases = (item.phases || []).slice().sort(function (a, b) { return a.sequence - b.sequence; });
    // Ordered by the BOM sequence, not by whatever order the logs arrived in —
    // the last stage of the block is the one that carries any loss.
    rows.sort(function (a, b) {
        return phases.findIndex(function (p) { return p.operation === a.phase; }) -
               phases.findIndex(function (p) { return p.operation === b.phase; });
    });

    return {
        ref: ref,
        rows: rows,
        partyId: rows[0].party || '',
        sentOn: rows[0].sentOn || '',
        qtySent: Number(rows[0].qtyIn) || 0
    };
}

// Used by production.js to lock a stage card. The server refuses too — this is
// only so he never gets as far as pressing the button.
function stageIsOut(item, phaseName) {
    var b = openOsBlock(item);
    if (!b) return false;
    return b.rows.some(function (r) { return r.phase === phaseName; });
}

// ---- Send ----

function openSendDialog(plan, item) {
    var phases = (item.phases || []).slice().sort(function (a, b) { return a.sequence - b.sequence; });
    var logs = item.logs || [];

    // A stage can go out if it is not finished, not already out, and not
    // running in-house. Kept in BOM order so contiguity is a question about
    // adjacent list positions.
    var rows = phases.map(function (p, i) {
        var lg = logs.find(function (l) { return l.phase === p.operation; });
        var done = lg && lg.end;
        var running = lg && lg.start && !lg.end && lg.outsourced !== true;
        var out = lg && lg.outsourced === true && !lg.returnedOn;
        var covered = partiesForStage(p.operation).length > 0;
        return {
            seq: p.sequence, name: p.operation, idx: i,
            done: !!done, running: !!running, out: !!out, covered: covered,
            eligible: !done && !running && !out
        };
    });

    outsourceCtx = { plan: plan, item: item, phases: phases, rows: rows };

    var el = osModalEl();
    el.classList.remove('hidden');
    el.innerHTML =
        '<div class="exc-panel exc-panel-wide">' +
            '<h3>Send to a third party</h3>' +
            '<p class="exc-sub">' + escapeHtml(item.name || '') +
                (item.sku ? ' &middot; ' + escapeHtml(item.sku) : '') + '</p>' +

            // STAGES FIRST, then the party.
            //
            // The party list is DERIVED from the stages — only vendors who do
            // every one of them are offered — so asking "who is it going to?"
            // first put an empty dropdown above the thing that fills it, and the
            // only sensible answer to it was "pick the stages first".
            '<div class="os-step-head">Which stages are they doing?</div>' +
            '<p class="exc-hint">Start at the next stage and work forward. A stage kept ' +
                'in-house in the middle means two separate trips, so only the one after ' +
                'your last tick can be added.</p>' +
            '<div class="os-stages">' +
                rows.map(function (r) {
                    var why = r.done ? 'finished' : r.running ? 'running in-house' : r.out ? 'already out' : '';
                    // STEP NUMBER, not Sequence_No. The sequences are 10/20/30 —
                    // spaced so a stage can be inserted between two others later
                    // — and "30." reads as a step number when this is step 3 of
                    // 5. Every other screen numbers stages by position for the
                    // same reason; the raw value only ever goes to the server.
                    //
                    // A <label> so the whole row is a hit target, not just the
                    // 13px box — he is ticking these on a shop floor.
                    return '<label class="os-stage-row' + (r.eligible ? '' : ' is-off') +
                        '" data-row="' + r.idx + '">' +
                        '<input type="checkbox" class="os-stage" data-i="' + r.idx + '" disabled>' +
                        '<span class="os-step-no">' + (r.idx + 1) + '</span>' +
                        '<span class="os-stage-name">' + escapeHtml(r.name) + '</span>' +
                        (why ? '<span class="os-stage-why">' + escapeHtml(why) + '</span>' : '') +
                    '</label>';
                }).join('') +
            '</div>' +

            '<div id="os-warn"></div>' +

            // Its own block with a rule above it. The two questions were running
            // straight into each other — one list of rows, then a heading, then a
            // dropdown, with nothing saying where the first step ended and the
            // second began.
            '<div class="os-party-block">' +
                '<div class="os-step-head">Who is it going to?</div>' +
                '<select id="os-party"><option value="">&mdash; Pick a party &mdash;</option></select>' +
                '<p class="exc-hint" id="os-party-hint">Pick the stages first &mdash; the list ' +
                    'shows only parties that do all of them.</p>' +
            '</div>' +

            '<div class="os-grid">' +
                '<div><label for="os-qty">Pieces going out</label>' +
                    '<input type="number" id="os-qty" min="0" step="1" value="0"></div>' +
                '<div><label for="os-date">Sent on</label>' +
                    '<input type="date" id="os-date"></div>' +
                '<div><label for="os-time">Time</label>' +
                    '<input type="time" id="os-time"></div>' +
            '</div>' +

            '<div class="dmg-step">' +
                '<label for="os-remarks">Note</label>' +
                '<textarea id="os-remarks" rows="2" placeholder="anything the next person needs to know"></textarea>' +
            '</div>' +

            '<div class="exc-foot">' +
                '<button type="button" class="ghost-btn" onclick="closeOsDialog()">Cancel</button>' +
                '<button type="button" class="primary-btn" id="os-send" disabled>Send out</button>' +
            '</div>' +
        '</div>';

    var d = new Date();
    document.getElementById('os-date').value =
        d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    document.getElementById('os-time').value = nowHHMM();

    document.querySelectorAll('#os-modal .os-stage').forEach(function (cb) {
        cb.addEventListener('change', syncSendDialog);
    });
    document.getElementById('os-send').addEventListener('click', doSend);
    syncSendDialog();
}

// THE BLOCK CAN ONLY START AT THE NEXT STAGE, AND ONLY GROW BY ONE.
//
// He was able to tick stage 5 while standing at stage 2. The server refuses that
// - the stage before a block has to be finished - but by then he has picked a
// party, typed a quantity and pressed Send, and gets an error for a selection
// the screen let him build.
//
// So the selection is NORMALISED on every change rather than validated at the
// end: whatever he clicks, the result is always a contiguous run beginning at
// the first stage that can actually go out. Only two boxes are ever enabled -
// the ones already in the block, so he can shrink it, and the single next one,
// so he can grow it.
//
// Untick something in the middle and everything after it clears with it. The run
// is truncated at the first gap, which is the only reading that stays contiguous.
//
// Returns the normalised selection so the caller does not re-derive it.
function syncStagePicker() {
    var rows = outsourceCtx.rows;
    var boxes = {};
    document.querySelectorAll('#os-modal .os-stage').forEach(function (cb) {
        boxes[cb.getAttribute('data-i')] = cb;
    });

    // Where a block has to begin: the first stage not finished, not running
    // in-house and not already out.
    var firstIdx = -1;
    rows.forEach(function (r, i) {
        if (firstIdx < 0 && r.eligible) firstIdx = i;
    });

    var wanted = [];
    Object.keys(boxes).forEach(function (k) {
        if (boxes[k].checked) wanted.push(Number(k));
    });
    wanted.sort(function (a, b) { return a - b; });

    // Longest contiguous run that starts at firstIdx. Anything else is dropped.
    var end = -1;
    if (firstIdx >= 0 && wanted.length > 0 && wanted[0] === firstIdx) {
        end = firstIdx;
        for (var k = 1; k < wanted.length; k++) {
            if (wanted[k] === end + 1 && rows[wanted[k]].eligible) end = wanted[k];
            else break;
        }
    }

    var picked = [];
    rows.forEach(function (r, i) {
        var cb = boxes[String(i)];
        if (!cb) return;
        var inBlock = end >= 0 && i >= firstIdx && i <= end;
        var isNext = end < 0 ? i === firstIdx : i === end + 1;

        cb.checked = inBlock;
        cb.disabled = !r.eligible || !(inBlock || isNext);

        var row = document.querySelector('#os-modal .os-stage-row[data-row="' + i + '"]');
        if (row) {
            // Locked by POSITION, not by state. Kept visually distinct from a
            // finished stage: that one carries a reason, this one is simply not
            // its turn yet.
            if (r.eligible && cb.disabled) row.classList.add('is-locked');
            else row.classList.remove('is-locked');
        }
        if (inBlock) picked.push(i);
    });

    return picked;
}

// Everything that depends on which stages are ticked: how many pieces go out,
// and which parties can do the whole block.
function syncSendDialog() {
    if (!outsourceCtx) return;
    var picked = syncStagePicker();

    var warn = document.getElementById('os-warn');
    var btn = document.getElementById('os-send');
    var sel = document.getElementById('os-party');
    var hint = document.getElementById('os-party-hint');

    if (picked.length === 0) {
        warn.innerHTML = '';

        btn.disabled = true;
        sel.innerHTML = '<option value="">&mdash; Pick a party &mdash;</option>';
        hint.textContent = 'Pick the stages first — the list shows only parties that do all of them.';
        return;
    }

    // No contiguity check here any more - syncStagePicker makes a non-contiguous
    // selection impossible to build rather than catching it afterwards.
    warn.innerHTML = '';

    // How many pieces exist to send: whatever the stage before the block
    // produced. Never typed from nothing — but left editable, because he is the
    // one counting them onto the van.
    var qtyEl = document.getElementById('os-qty');
    if (!qtyEl.dataset.touched) {
        qtyEl.value = qtyInFor(outsourceCtx.item, outsourceCtx.phases, picked[0]);
        qtyEl.addEventListener('input', function () { qtyEl.dataset.touched = '1'; }, { once: true });
    }

    // Only parties that cover EVERY stage in the block. One trip, one vendor —
    // offering someone who does two of the three would guarantee a return trip
    // nobody planned for.
    //
    // Built by INTERSECTING partiesForStage rather than re-implementing the
    // match here. An earlier version inlined it and trimmed only one side of the
    // comparison, so a BOM operation with a stray space matched in one place and
    // not the other — two matchers for one rule is exactly how that happens.
    var names = picked.map(function (i) { return outsourceCtx.rows[i].name; });
    var able = (typeof parties === 'undefined' ? [] : parties).filter(function (p) {
        return names.every(function (n) {
            return partiesForStage(n).some(function (q) { return String(q.id) === String(p.id); });
        });
    });

    var keep = sel.value;
    sel.innerHTML = '<option value="">&mdash; Pick a party &mdash;</option>' +
        able.map(function (p) {
            return '<option value="' + p.id + '">' + escapeHtml(p.name) +
                (p.contact ? ' &middot; ' + escapeHtml(p.contact) : '') + '</option>';
        }).join('');
    if (able.some(function (p) { return String(p.id) === String(keep); })) sel.value = keep;

    if (able.length > 0) {
        hint.textContent = able.length + ' part' + (able.length === 1 ? 'y does' : 'ies do') +
            ' all ' + picked.length + ' stage' + (picked.length === 1 ? '' : 's');
    } else if ((typeof parties === 'undefined' ? [] : parties).length === 0) {
        // Nothing arrived from the server at all. A completely different problem
        // from "no party covers this stage", and telling him to edit a party he
        // may already have set up correctly sends him the wrong way.
        hint.innerHTML = '<b>No third parties loaded.</b> Either none are set up, ' +
            'or <code>getProductionWidgetData</code> has not been re-saved in Creator.';
    } else {
        // Name the stage nobody covers. "Nobody does all 2 of those" leaves him
        // checking both when only one is the problem.
        var gaps = names.filter(function (n) { return partiesForStage(n).length === 0; });
        hint.innerHTML = gaps.length > 0
            ? '<b>No active party is listed for ' + escapeHtml(gaps.join(', ')) + '.</b> ' +
              'Add that stage to a party under Masters &rarr; Third Party.'
            : '<b>No single party does all of ' + escapeHtml(names.join(' + ')) + '.</b> ' +
              'Send a smaller block, or add the missing stages to one party.';
    }

    sel.onchange = function () { btn.disabled = !sel.value; };
    btn.disabled = !sel.value;
}

function doSend() {
    if (!outsourceCtx) return;

    var picked = [];
    document.querySelectorAll('#os-modal .os-stage').forEach(function (cb) {
        if (cb.checked) picked.push(outsourceCtx.rows[Number(cb.getAttribute('data-i'))].seq);
    });

    var partyId = document.getElementById('os-party').value;
    var qty = Number(document.getElementById('os-qty').value) || 0;
    if (qty <= 0) {
        alert('How many pieces are going out?');
        return;
    }

    var btn = document.getElementById('os-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: API.sendToThirdParty,
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                planId: String(outsourceCtx.plan.id),
                planItemId: String(outsourceCtx.item.id),
                partyId: String(partyId),
                qty: String(qty),
                sentOn: document.getElementById('os-date').value,
                sentTime: document.getElementById('os-time').value,
                sequences: picked,
                remarks: document.getElementById('os-remarks').value
            })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('sendToThirdParty parse failed:', e, response.result);
            alert('Could not read the reply from Creator.');
            btn.disabled = false; btn.textContent = 'Send out';
            return;
        }
        if (!parsed.success) {
            alert(parsed.error || 'Could not send.');
            btn.disabled = false; btn.textContent = 'Send out';
            return;
        }
        closeOsDialog();
        fetchAllData(null);
    }).catch(function (err) {
        console.error('sendToThirdParty error:', err);
        alert('Could not reach Creator.');
        btn.disabled = false; btn.textContent = 'Send out';
    });
}

// ---- Receive ----

function openReceiveDialog(plan, item) {
    var block = openOsBlock(item);
    if (!block) return;

    outsourceCtx = { plan: plan, item: item, block: block };

    var party = partyById(block.partyId);
    var names = block.rows.map(function (r) { return r.phase; });

    var el = osModalEl();
    el.classList.remove('hidden');
    el.innerHTML =
        '<div class="exc-panel exc-panel-wide">' +
            '<h3>Take it back</h3>' +
            '<p class="exc-sub">' + escapeHtml(item.name || '') + ' &middot; ' +
                escapeHtml(party ? party.name : 'third party') + '</p>' +

            '<div class="dmg-lead">' +
                'Sent <b>' + block.qtySent + '</b> piece' + (block.qtySent === 1 ? '' : 's') +
                ' on <b>' + escapeHtml(block.sentOn || '—') + '</b> for ' +
                escapeHtml(names.join(' → ')) + '.' +
            '</div>' +

            '<div class="os-grid">' +
                '<div><label for="os-back">Pieces returned</label>' +
                    '<input type="number" id="os-back" min="0" max="' + block.qtySent +
                        '" step="1" value="' + block.qtySent + '"></div>' +
                '<div><label for="os-rdate">Returned on</label>' +
                    '<input type="date" id="os-rdate"></div>' +
                '<div><label for="os-rtime">Time</label>' +
                    '<input type="time" id="os-rtime"></div>' +
            '</div>' +

            '<div id="os-short"></div>' +

            '<div class="dmg-step">' +
                '<label for="os-rremarks">Note</label>' +
                '<textarea id="os-rremarks" rows="2" placeholder="anything worth recording"></textarea>' +
            '</div>' +

            '<div class="exc-foot">' +
                '<button type="button" class="ghost-btn" onclick="closeOsDialog()">Cancel</button>' +
                '<button type="button" class="primary-btn" id="os-receive">Take it back</button>' +
            '</div>' +
        '</div>';

    var d = new Date();
    document.getElementById('os-rdate').value =
        d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    document.getElementById('os-rtime').value = nowHHMM();

    document.getElementById('os-back').addEventListener('input', syncReceiveDialog);
    document.getElementById('os-receive').addEventListener('click', doReceive);
    syncReceiveDialog();
}

// The warning is the whole point of this dialog. Closing short tells the system
// the missing pieces are gone, fires a reissue, and he cuts replacements — so if
// the vendor is merely delivering in two drops, pressing this button costs real
// cloth. Waiting is the right answer in that case, and it has to say so.
function syncReceiveDialog() {
    if (!outsourceCtx || !outsourceCtx.block) return;
    var sent = outsourceCtx.block.qtySent;
    var back = Number(document.getElementById('os-back').value) || 0;
    var box = document.getElementById('os-short');
    var btn = document.getElementById('os-receive');

    if (back > sent) {
        box.innerHTML = '<p class="exc-error">You cannot get back more than the ' + sent + ' that went out.</p>';
        btn.disabled = true;
        return;
    }
    btn.disabled = false;

    if (back < sent) {
        box.innerHTML = '<div class="exc-warn">' +
            '<b>' + (sent - back) + ' piece' + (sent - back === 1 ? '' : 's') +
            ' will be written off as lost at the third party.</b><br>' +
            'If the rest are simply coming later, <b>wait</b> — taking it back now ' +
            'starts a reissue for pieces that are on their way.' +
            '</div>';
    } else {
        box.innerHTML = '';
    }
}

function doReceive() {
    if (!outsourceCtx || !outsourceCtx.block) return;
    var sent = outsourceCtx.block.qtySent;
    var back = Number(document.getElementById('os-back').value) || 0;

    if (back < sent) {
        if (!confirm(
            (sent - back) + ' piece(s) will be written off as lost.\n\n' +
            'Only do this if you know they are not coming back.'
        )) return;
    }

    var btn = document.getElementById('os-receive');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: API.receiveFromThirdParty,
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                outsourceRef: String(outsourceCtx.block.ref),
                qtyReturned: String(back),
                returnedOn: document.getElementById('os-rdate').value,
                returnedTime: document.getElementById('os-rtime').value,
                remarks: document.getElementById('os-rremarks').value
            })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('receiveFromThirdParty parse failed:', e, response.result);
            alert('Could not read the reply from Creator.');
            btn.disabled = false; btn.textContent = 'Take it back';
            return;
        }
        if (!parsed.success) {
            alert(parsed.error || 'Could not record the return.');
            btn.disabled = false; btn.textContent = 'Take it back';
            return;
        }

        var ctx = outsourceCtx;
        closeOsDialog();

        // saveProductionPhase's own reply, forwarded by the server. If this
        // block closed the last stage of the last item, it carries orderComplete
        // and the finished-order summary — an order that finishes at a third
        // party has to get the same popup as one that finishes in-house, and it
        // was silently skipping it.
        var phase = parsed.phase || {};

        // Both opened AFTER the refetch, so the screen behind them is already
        // showing its real state. The completion popup wins when both are due:
        // it closes the whole order, and the material question can wait for the
        // Report damage button. Same precedence savePhasePayload applies.
        var askDamage = parsed.short > 0 && typeof openDamageDialog === 'function'
            ? function () {
                openDamageDialog(ctx.plan, ctx.item, {
                    pieces: parsed.short,
                    phaseName: parsed.phaseName || '',
                    stageLogId: ''
                });
            }
            : null;

        fetchAllData(function () {
            if (phase.orderComplete && typeof showOrderCompleteDialog === 'function') {
                // Chained behind the completion popup rather than dropped — a
                // vendor losing pieces on the last stage of the last item is
                // exactly when the remake question matters, and it was the one
                // case that never asked it.
                if (typeof afterOrderDone !== 'undefined') afterOrderDone = askDamage;
                showOrderCompleteDialog(phase);
            } else if (askDamage) {
                askDamage();
            }
        });
    }).catch(function (err) {
        console.error('receiveFromThirdParty error:', err);
        alert('Could not reach Creator.');
        btn.disabled = false; btn.textContent = 'Take it back';
    });
}
