// Sending part of a stage out to a third party, and taking it back.
//
// Loaded after production.js — reads `parties`, `plans`, `qtyInFor`,
// `openPartyBlocks`, `nowHHMM` and `fetchAllData` from it, and production.js
// looks these functions up by name when it renders an item card.
//
// A VENDOR IS AN OPERATOR. He takes a SHARE of the stage — a Stage_Assignment
// with a party on it instead of a man — and whatever he does not take stays in
// the pool for the operators. That is the whole difference from the model this
// replaced, which overwrote the stage's Qty_In with the sent quantity: send 40 of
// 100 and the other 60 vanished from every count with nothing to say where.
//
// So this dialog is not the place a stage is chosen or a quantity is decided —
// both arrive from the share picker on the stage card, capped at what is left to
// hand out. What it adds is the two things a van needs and a man does not: the
// date it left, and the stages it is carrying the panels through.
//
// ONE ITEM, A CONTIGUOUS BLOCK OF STAGES, ONE TRIP. He hands over panels once
// and the vendor runs several operations before handing them back — one van, one
// gate, one return. Recording that as three separate sends would invent three
// physical movements that never happened. The block writes one share per stage,
// all under one Outsource_Ref, and they close together.
//
// NO PARTIAL RETURNS. A partial return is only worth anything if he can carry on
// producing with what came back, and he cannot — the share is the stage's output
// and re-opening one after the stage closed has nowhere to put the late pieces.
// So the return is all-or-nothing, and closing short is what tells the system the
// rest are lost.

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

// ---- A block currently out ----
//
// Grouped on Outsource_Ref rather than inferred from item + party + date, which
// would have merged two sends of the same item to the same party on one day into
// a single apparent trip.
//
// TWO SHAPES, and the reference is what tells them apart rather than a flag.
// A block sent as SHARES is found on the assignments (openPartyBlocks, in
// production.js). A block sent under the old whole-stage model is on the stage
// logs, and openOsBlock below still finds it — kept only so a van that was
// already on the road the day this shipped can be received.
function shareBlockFor(item, ref) {
	var blocks =
		typeof openPartyBlocks === 'function' ? openPartyBlocks(item) : [];
	if (blocks.length === 0) return null;

	// A REFERENCE THAT MATCHES NOTHING HERE IS NOT A NEAR MISS — it is a legacy
	// block, and the caller falls through to openOsBlock. Handing back "the only
	// share block" instead would close a different vendor's trip at this one's
	// count, which is the single mistake this dialog must never make.
	if (ref) {
		var hit = blocks.filter(function (b) {
			return String(b.ref) === String(ref);
		});
		return hit.length > 0 ? hit[0] : null;
	}

	// No reference given: only unambiguous when there is exactly one trip out.
	// Two vendors holding batches of the same item is possible now.
	return blocks.length === 1 ? blocks[0] : null;
}

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

// LEGACY. Whether a whole-stage block still covers this stage, which is what
// used to lock the card. Nothing calls it now that a vendor is a share and the
// card stays workable — kept beside openOsBlock so the two legacy readers live
// or die together.
function stageIsOut(item, phaseName) {
    var b = openOsBlock(item);
    if (!b) return false;
    return b.rows.some(function (r) { return r.phase === phaseName; });
}

// ---- Send ----

// `seed` comes from the stage card's share picker: {qty, max, qtyIn, phaseName}.
// It is always present in normal use — this dialog is no longer reachable any
// other way — but it is read defensively so a direct call still opens something
// sensible.
//
// NO PARTY COMES IN THE SEED. The picker offers "Send to a third party…" and
// nothing more, because WHICH vendor may take the work is decided by the stages,
// and the stages are chosen here. Naming one on the card would be answering that
// a step early: he picks a vendor for Stitching, ticks Embroidery too, and finds
// his choice was never valid for the block he built.
function openSendDialog(plan, item, seed) {
    seed = seed || {};
    var phases = (item.phases || []).slice().sort(function (a, b) { return a.sequence - b.sequence; });
    var logs = item.logs || [];

    // A stage can go out if it is not finished and not already out under the old
    // whole-stage model. Kept in BOM order so contiguity is a question about
    // adjacent list positions.
    //
    // "RUNNING IN-HOUSE" IS NO LONGER A REASON TO REFUSE THE FIRST STAGE — it is
    // the ordinary case now. Two men cutting and a vendor embroidering are three
    // shares of one stage, and the block simply starts where the work is.
    //
    // It stays a refusal further along the block: a stage after the first has not
    // received anything yet, so anything recorded as running on it is work on
    // pieces that do not exist.
    var rows = phases.map(function (p, i) {
        var lg = logs.find(function (l) { return l.phase === p.operation; });
        var done = lg && lg.end;
        var out = lg && lg.outsourced === true && !lg.returnedOn;
        var running = lg && lg.start && !lg.end && !out;
        var covered = partiesForStage(p.operation).length > 0;
        return {
            seq: p.sequence, name: p.operation, idx: i,
            done: !!done, running: !!running, out: !!out, covered: covered,
            eligible: false
        };
    });

    // Where a block has to begin, and eligibility measured from it.
    var firstIdx = -1;
    rows.forEach(function (r, i) {
        if (firstIdx < 0 && !r.done && !r.out) firstIdx = i;
    });
    rows.forEach(function (r, i) {
        r.eligible = !r.done && !r.out && (i === firstIdx || !r.running);
    });

    outsourceCtx = { plan: plan, item: item, phases: phases, rows: rows, seed: seed };

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
                    // The first stage may well be running in-house — that is the
                    // point — so the reason is only shown where it is actually a
                    // reason the stage cannot go.
                    var why = r.done ? 'finished'
                        : r.out ? 'already out'
                        : (r.running && !r.eligible) ? 'running in-house'
                        : '';
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
                '<div id="os-party-comparison" class="os-party-comparison hidden"></div>' +
                '<select id="os-party" class="hidden"><option value="">&mdash; Pick a party &mdash;</option></select>' +
                '<p class="exc-hint" id="os-party-hint">Pick the stages first &mdash; the list ' +
                    'shows only parties that do all of them.</p>' +
                '<div id="os-party-details" class="os-party-details hidden"></div>' +
            '</div>' +

            '<div class="os-grid" style="grid-template-columns: repeat(4, 1fr);">' +
                // CAPPED AT WHAT IS LEFT TO HAND OUT, not at what the stage
                // received. Pieces already with a cutter are not his to send, and
                // the server refuses it — this is only so he finds out before the
                // round trip.
                '<div><label for="os-qty">Pieces going out</label>' +
                    '<input type="number" id="os-qty" min="1" step="1"' +
                    (seed.max > 0 ? ' max="' + seed.max + '"' : '') +
                    ' value="' + (Number(seed.qty) || 0) + '">' +
                    (seed.max > 0 ? '<p class="exc-hint">' + seed.max + ' left to hand out</p>' : '') +
                '</div>' +
                '<div><label for="os-rate">Rate / Piece (₹)</label>' +
                    '<input type="number" id="os-rate" min="0" step="0.01" placeholder="₹0.00"></div>' +
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

    // The quantity arrived from the share picker, so syncSendDialog must not
    // overwrite it with the stage's full input — which is the number this whole
    // change exists to stop being assumed.
    document.getElementById('os-qty').dataset.touched = '1';

    // The block opens on the stage he pressed from, already ticked. He came here
    // to send THAT stage; making him tick it again is a step that can only be
    // got wrong.
    document.querySelectorAll('#os-modal .os-stage').forEach(function (cb) {
        if (Number(cb.getAttribute('data-i')) === firstIdx) cb.checked = true;
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

    // How many pieces go out came from the share picker, capped there at what is
    // left to hand out. Left editable, because he is the one counting them onto
    // the van — but never re-derived here from the stage's own input, which is
    // the assumption that used to swallow everything he kept back.
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

    // What he has already chosen here survives a change to the ticked stages —
    // unless growing the block onto a stage that vendor does not do drops him out
    // of the list, and the hint below then says which stage is the problem.
    var keep = sel.value;
    sel.innerHTML = '<option value="">&mdash; Pick a party &mdash;</option>' +
        able.map(function (p) {
            return '<option value="' + p.id + '">' + escapeHtml(p.name) +
                (p.contact ? ' &middot; ' + escapeHtml(p.contact) : '') + '</option>';
        }).join('');
    if (able.some(function (p) { return String(p.id) === String(keep); })) {
        sel.value = keep;
    } else {
        sel.value = '';
    }

    if (able.length > 0) {
        hint.textContent = able.length + ' part' + (able.length === 1 ? 'y does' : 'ies do') +
            ' all ' + picked.length + ' stage' + (picked.length === 1 ? '' : 's');
        hint.classList.add('hidden');
    } else if ((typeof parties === 'undefined' ? [] : parties).length === 0) {
        hint.innerHTML = '<b>No third parties loaded.</b> Either none are set up, ' +
            'or <code>getProductionWidgetData</code> has not been re-saved in Creator.';
        hint.classList.remove('hidden');
        document.getElementById('os-party-comparison').classList.add('hidden');
        document.getElementById('os-party-details').classList.add('hidden');
    } else {
        var gaps = names.filter(function (n) { return partiesForStage(n).length === 0; });
        hint.innerHTML = gaps.length > 0
            ? '<b>No active party is listed for ' + escapeHtml(gaps.join(', ')) + '.</b> ' +
              'Add that stage to a party under Masters &rarr; Third Party.'
            : '<b>No single party does all of ' + escapeHtml(names.join(' + ')) + '.</b> ' +
              'Send a smaller block, or add the missing stages to one party.';
        hint.classList.remove('hidden');
        document.getElementById('os-party-comparison').classList.add('hidden');
        document.getElementById('os-party-details').classList.add('hidden');
    }

    sel.onchange = function () {
        btn.disabled = !sel.value;
        chooseComparisonVendor(sel.value);
    };
    btn.disabled = !sel.value;
    
    if (sel.value) {
        chooseComparisonVendor(sel.value);
    } else {
        if (able.length > 0) {
            loadAllPartiesHistory(able);
        } else {
            var comp = document.getElementById('os-party-comparison');
            var details = document.getElementById('os-party-details');
            if (comp) comp.classList.add('hidden');
            if (details) details.classList.add('hidden');
        }
    }
}

function doSend() {
    if (!outsourceCtx) return;

    var picked = [];
    document.querySelectorAll('#os-modal .os-stage').forEach(function (cb) {
        if (cb.checked) picked.push(outsourceCtx.rows[Number(cb.getAttribute('data-i'))].seq);
    });

    var partyId = document.getElementById('os-party').value;
    var qty = Number(document.getElementById('os-qty').value) || 0;
    var seed = outsourceCtx.seed || {};
    if (qty <= 0) {
        alert('How many pieces are going out?');
        return;
    }
    // The server refuses this too. Here only so he finds out before the round
    // trip, and so the number he is told is the one the stage card showed him.
    if (seed.max > 0 && qty > seed.max) {
        alert('Only ' + seed.max + ' piece(s) are left to hand out on this stage.');
        return;
    }

    var btn = document.getElementById('os-send');
    var rate = Number(document.getElementById('os-rate').value) || 0;
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
                rate: String(rate),
                // What the FIRST stage of the block received. Used only when its
                // Stage_Log has no figure yet — a stage nobody has been put on
                // has not been opened, so the server has nothing to measure the
                // send against and would otherwise refuse it.
                qtyIn: String(seed.qtyIn || 0),
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

// `ref` names which trip is coming back. It is passed from the vendor's own row
// in the stage's share table — an item can have two vendors holding batches at
// once now, and guessing between them would close the wrong one at the wrong
// count. Omitted only by the legacy card, which can only ever have one.
function openReceiveDialog(plan, item, ref) {
    var block = shareBlockFor(item, ref) || openOsBlock(item);
    if (!block) return;

    outsourceCtx = { plan: plan, item: item, block: block };

    var party = partyById(block.partyId);
    // A share block carries its stage names; the legacy one carries stage rows.
    var names = block.names || (block.rows || []).map(function (r) { return r.phase; });

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

function loadPartyDetails(partyId) {
    var container = document.getElementById('os-party-details');
    if (!container) return;

    if (!partyId) {
        container.innerHTML = '';
        container.classList.add('hidden');
        if (outsourceCtx) outsourceCtx.partyDetails = null;
        return;
    }

    container.classList.remove('hidden');

    // Use cached details if available
    if (outsourceCtx && outsourceCtx.allPartiesCache) {
        var cachedParty = outsourceCtx.allPartiesCache.data.find(function(p) { return String(p.partyId) === String(partyId); });
        if (cachedParty) {
            renderPartyDetails(cachedParty);
            return;
        }
    }

    container.innerHTML = '<div class="os-loading"><span class="os-spinner"></span> Loading party details...</div>';
    
    // Fallback: If not cached, fetch single party history
    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: API.getThirdPartyHistory,
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                partyIds: [String(partyId)]
            })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getThirdPartyHistory parse failed:', e, response.result);
            container.innerHTML = '<div class="exc-error">Could not read party details.</div>';
            return;
        }

        if (!parsed.success || !parsed.parties || parsed.parties.length === 0) {
            container.innerHTML = '<div class="exc-error">' + escapeHtml(parsed.error || 'Failed to load details.') + '</div>';
            return;
        }

        var partyData = parsed.parties[0];
        renderPartyDetails(partyData);
    }).catch(function (err) {
        console.error('getThirdPartyHistory error:', err);
        container.innerHTML = '<div class="exc-error">Could not connect to fetch party details.</div>';
    });
}

function loadAllPartiesHistory(ableParties) {
    var container = document.getElementById('os-party-comparison');
    if (!container) return;

    container.classList.remove('hidden');

    var partyIds = ableParties.map(function (p) { return String(p.id); });
    
    // Use cached comparison details if available
    if (outsourceCtx && outsourceCtx.allPartiesCache && 
        outsourceCtx.allPartiesCache.key === partyIds.join(',')) {
        renderPartiesComparison(outsourceCtx.allPartiesCache.data);
        return;
    }

    container.innerHTML = '<div class="os-loading"><span class="os-spinner"></span> Loading contractor details & rate comparison...</div>';

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: API.getThirdPartyHistory,
        http_method: 'POST',
        payload: {
            payloadJson: JSON.stringify({
                partyIds: partyIds
            })
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('getThirdPartyHistory parse failed:', e, response.result);
            container.innerHTML = '<div class="exc-error">Could not read contractor histories from Creator.</div>';
            return;
        }

        if (!parsed.success) {
            container.innerHTML = '<div class="exc-error">' + escapeHtml(parsed.error || 'Failed to load contractor comparison.') + '</div>';
            return;
        }

        if (outsourceCtx) {
            outsourceCtx.allPartiesCache = {
                key: partyIds.join(','),
                data: parsed.parties || []
            };
        }
        renderPartiesComparison(parsed.parties || []);
    }).catch(function (err) {
        console.error('getThirdPartyHistory error:', err);
        container.innerHTML = '<div class="exc-error">Could not connect to fetch contractor histories.</div>';
    });
}

function renderPartiesComparison(partiesList) {
    var container = document.getElementById('os-party-comparison');
    if (!container) return;

    if (partiesList.length === 0) {
        container.innerHTML = '<p class="os-no-data">No active parties cover the selected stages.</p>';
        return;
    }

    var pickedStages = [];
    document.querySelectorAll('#os-modal .os-stage').forEach(function (cb) {
        if (cb.checked) {
            pickedStages.push(outsourceCtx.rows[Number(cb.getAttribute('data-i'))].name);
        }
    });

    var currentItemSku = (outsourceCtx.item.sku || '').toLowerCase().trim();
    var currentItemName = (outsourceCtx.item.name || '').toLowerCase().trim();

    var html = '<h4>Compare Subcontractors</h4>' +
        '<table class="os-pd-table os-comp-table">' +
        '<thead>' +
            '<tr>' +
                '<th>Subcontractor</th>' +
                '<th>Active Pricing (Ticked Stages)</th>' +
                '<th>Last Job (Creator)</th>' +
                '<th>Action</th>' +
            '</tr>' +
        '</thead>' +
        '<tbody>';

    partiesList.forEach(function (party) {
        var details = party.vendorDetails || {};
        var bills = party.bills || [];
        var localHistory = party.localHistory || [];

        // Determine rate matches for selected stages
        var ratesText = '';
        if (pickedStages.length > 0) {
            var foundRates = {};
            var chronologicalBills = bills.slice().reverse();
            
            // Step 1: Product-specific
            chronologicalBills.forEach(function (b) {
                (b.line_items || []).forEach(function (item) {
                    var itemNameLower = (item.name || '').toLowerCase();
                    var itemDescLower = (item.description || '').toLowerCase();
                    
                    pickedStages.forEach(function (stage) {
                        var stageLower = stage.toLowerCase();
                        var matchesStage = (itemNameLower.indexOf(stageLower) !== -1 || itemDescLower.indexOf(stageLower) !== -1);
                        var matchesProduct = false;
                        
                        if (currentItemSku && (itemNameLower.indexOf(currentItemSku) !== -1 || itemDescLower.indexOf(currentItemSku) !== -1)) {
                            matchesProduct = true;
                        } else if (currentItemName && (itemNameLower.indexOf(currentItemName) !== -1 || itemDescLower.indexOf(currentItemName) !== -1)) {
                            matchesProduct = true;
                        }
                        
                        if (matchesStage && matchesProduct) {
                            foundRates[stage] = { rate: item.rate, isProductSpecific: true };
                        }
                    });
                });
            });

            // Step 2: Generic fallback
            chronologicalBills.forEach(function (b) {
                (b.line_items || []).forEach(function (item) {
                    var itemNameLower = (item.name || '').toLowerCase();
                    var itemDescLower = (item.description || '').toLowerCase();
                    
                    pickedStages.forEach(function (stage) {
                        if (foundRates[stage] && foundRates[stage].isProductSpecific) return;
                        
                        var stageLower = stage.toLowerCase();
                        var matchesStage = (itemNameLower.indexOf(stageLower) !== -1 || itemDescLower.indexOf(stageLower) !== -1);
                        
                        if (matchesStage) {
                            foundRates[stage] = { rate: item.rate, isProductSpecific: false };
                        }
                    });
                });
            });

            var rateLines = [];
            pickedStages.forEach(function (stage) {
                var info = foundRates[stage];
                if (info) {
                    var label = info.isProductSpecific ? ' (Product Specific)' : ' (Generic)';
                    rateLines.push('<b>' + escapeHtml(stage) + ':</b> ₹' + Number(info.rate).toFixed(2) + '<span class="os-pd-remarks">' + label + '</span>');
                } else {
                    rateLines.push('<b>' + escapeHtml(stage) + ':</b> <span class="text-muted italic">No rate</span>');
                }
            });
            ratesText = rateLines.join('<br>');
        } else {
            ratesText = '<span class="text-muted">Select stages above to view rates</span>';
        }

        var invStatusText = party.vendorFound
            ? '<span class="os-badge-comp os-badge-success" title="Vendor mapped in Inventory">✓ Mapped</span>'
            : '<span class="os-badge-comp os-badge-warn" title="Vendor not found in Inventory">⚠ Unmapped</span>';

        var historyText = '';
        var matchHistories = [];
        localHistory.forEach(function (h) {
            var isItemMatch = (h.item_name || '').toLowerCase() === currentItemName;
            var isStageMatch = pickedStages.some(function (stg) {
                return (h.stage || '').toLowerCase() === stg.toLowerCase();
            });
            if (isItemMatch && isStageMatch) {
                var returnedDate = h.returned_on && h.returned_on !== 'null' ? h.returned_on : '—';
                var rateText = h.rate ? ' at ₹' + Number(h.rate).toFixed(2) : '';
                matchHistories.push(
                    '<b>' + escapeHtml(h.stage) + '</b>: ' + h.qty_sent + ' pcs' + rateText + ' on ' + escapeHtml(h.sent_on || '—') +
                    ' <span class="text-muted">(Returned ' + h.qty_returned + ' on ' + escapeHtml(returnedDate) + ')</span>'
                );
            }
        });

        if (matchHistories.length > 0) {
            historyText = matchHistories.slice(0, 2).join('<br>');
        } else {
            if (localHistory.length === 0) {
                historyText = '<span class="text-primary font-semibold">★ New Vendor</span><br><span class="text-muted italic">No Creator history yet</span>';
            } else {
                historyText = '<span class="text-muted italic">No past ' + escapeHtml(pickedStages.join('/') || 'selected') + ' run for this item</span>';
            }
        }

        var isSelected = document.getElementById('os-party').value === String(party.partyId);
        var rowClass = isSelected ? 'class="os-selected-row"' : '';
        var btnText = isSelected ? 'Selected' : 'Choose Vendor';
        var btnClass = isSelected ? 'outsource-btn is-out' : 'outsource-btn';

        html += '<tr ' + rowClass + '>' +
            '<td>' +
                '<strong>' + escapeHtml(details.name || '') + '</strong> ' + invStatusText + '<br>' +
                '<span class="text-muted">Contact: ' + escapeHtml(details.contact || '—') + ' · Ph: ' + escapeHtml(details.phone || '—') + '</span>' +
            '</td>' +
            '<td>' + ratesText + '</td>' +
            '<td>' + historyText + '</td>' +
            '<td>' +
                '<button type="button" class="' + btnClass + '" onclick="chooseComparisonVendor(\'' + party.partyId + '\')">' + btnText + '</button>' +
            '</td>' +
        '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

function chooseComparisonVendor(partyId) {
    var sel = document.getElementById('os-party');
    if (!sel) return;

    sel.value = partyId;

    var btn = document.getElementById('os-send');
    if (btn) btn.disabled = !sel.value;

    if (outsourceCtx && outsourceCtx.allPartiesCache) {
        renderPartiesComparison(outsourceCtx.allPartiesCache.data);
    }

    var partiesList = outsourceCtx.allPartiesCache ? outsourceCtx.allPartiesCache.data : [];
    var chosenParty = partiesList.find(function(p) { return String(p.partyId) === String(partyId); });
    
    var totalRate = 0;
    if (chosenParty) {
        var pickedStages = [];
        document.querySelectorAll('#os-modal .os-stage').forEach(function (cb) {
            if (cb.checked) {
                pickedStages.push(outsourceCtx.rows[Number(cb.getAttribute('data-i'))].name);
            }
        });

        var currentItemSku = (outsourceCtx.item.sku || '').toLowerCase().trim();
        var currentItemName = (outsourceCtx.item.name || '').toLowerCase().trim();
        var bills = chosenParty.bills || [];
        
        var foundRates = {};
        var chronologicalBills = bills.slice().reverse();
        
        // Step 1: Product-specific
        chronologicalBills.forEach(function (b) {
            (b.line_items || []).forEach(function (item) {
                var itemNameLower = (item.name || '').toLowerCase();
                var itemDescLower = (item.description || '').toLowerCase();
                pickedStages.forEach(function (stage) {
                    var stageLower = stage.toLowerCase();
                    var matchesStage = (itemNameLower.indexOf(stageLower) !== -1 || itemDescLower.indexOf(stageLower) !== -1);
                    var matchesProduct = false;
                    if (currentItemSku && (itemNameLower.indexOf(currentItemSku) !== -1 || itemDescLower.indexOf(currentItemSku) !== -1)) {
                        matchesProduct = true;
                    } else if (currentItemName && (itemNameLower.indexOf(currentItemName) !== -1 || itemDescLower.indexOf(currentItemName) !== -1)) {
                        matchesProduct = true;
                    }
                    if (matchesStage && matchesProduct) {
                        foundRates[stage] = item.rate;
                    }
                });
            });
        });

        // Step 2: Generic fallback
        chronologicalBills.forEach(function (b) {
            (b.line_items || []).forEach(function (item) {
                var itemNameLower = (item.name || '').toLowerCase();
                var itemDescLower = (item.description || '').toLowerCase();
                pickedStages.forEach(function (stage) {
                    if (foundRates[stage]) return;
                    var stageLower = stage.toLowerCase();
                    var matchesStage = (itemNameLower.indexOf(stageLower) !== -1 || itemDescLower.indexOf(stageLower) !== -1);
                    if (matchesStage) {
                        foundRates[stage] = item.rate;
                    }
                });
            });
        });

        pickedStages.forEach(function (stage) {
            totalRate += Number(foundRates[stage] || 0);
        });

        var rateInput = document.getElementById('os-rate');
        if (rateInput) {
            rateInput.value = totalRate > 0 ? totalRate.toFixed(2) : '';
        }

        var detailsContainer = document.getElementById('os-party-details');
        if (detailsContainer) {
            detailsContainer.classList.remove('hidden');
            renderPartyDetails(chosenParty);
        }
    }

    if (outsourceCtx) {
        outsourceCtx.selectedRate = totalRate;
    }
}

function renderPartyDetails(data) {
    var container = document.getElementById('os-party-details');
    if (!container) return;

    var details = data.vendorDetails || {};
    var bills = data.bills || [];
    var localHistory = data.localHistory || [];

    // 1. Get the list of currently selected stage names in the modal
    var pickedStages = [];
    document.querySelectorAll('#os-modal .os-stage').forEach(function (cb) {
        if (cb.checked) {
            pickedStages.push(outsourceCtx.rows[Number(cb.getAttribute('data-i'))].name);
        }
    });

    // Header info (Inventory integration status)
    var headerHtml = '<div class="os-pd-header">';
    if (data.vendorFound) {
        headerHtml += '<span class="os-badge os-badge-success">✓ Zoho Inventory Vendor Mapped</span>';
    } else {
        headerHtml += '<span class="os-badge os-badge-warn">⚠ Zoho Inventory Vendor Not Found (Name mismatch?)</span>';
    }
    headerHtml += '</div>';

    // Contact info grid
    var contactHtml = '<div class="os-pd-info-grid">' +
        '<div><strong>Contact Person:</strong> ' + escapeHtml(details.contact || '—') + '</div>' +
        '<div><strong>Phone:</strong> ' + escapeHtml(details.phone || '—') + '</div>' +
        '<div><strong>Email:</strong> ' + escapeHtml(details.email || '—') + '</div>' +
    '</div>';

    // 2. Active Pricing for Selected Stages (Extracted from bills)
    var activeRatesHtml = '';
    if (data.vendorFound && pickedStages.length > 0 && bills.length > 0) {
        var foundRates = {};
        var currentItemSku = (outsourceCtx.item.sku || '').toLowerCase().trim();
        var currentItemName = (outsourceCtx.item.name || '').toLowerCase().trim();

        // Scan bills in reverse chronological order (oldest to newest, so newest overwrites and wins)
        var chronologicalBills = bills.slice().reverse();
        
        // Step 1: Look for product-specific service rates (matching product name/SKU AND stage name)
        chronologicalBills.forEach(function (b) {
            (b.line_items || []).forEach(function (item) {
                var itemNameLower = (item.name || '').toLowerCase();
                var itemDescLower = (item.description || '').toLowerCase();
                
                pickedStages.forEach(function (stage) {
                    var stageLower = stage.toLowerCase();
                    
                    var matchesStage = (itemNameLower.indexOf(stageLower) !== -1 || itemDescLower.indexOf(stageLower) !== -1);
                    var matchesProduct = false;
                    
                    if (currentItemSku && (itemNameLower.indexOf(currentItemSku) !== -1 || itemDescLower.indexOf(currentItemSku) !== -1)) {
                        matchesProduct = true;
                    } else if (currentItemName && (itemNameLower.indexOf(currentItemName) !== -1 || itemDescLower.indexOf(currentItemName) !== -1)) {
                        matchesProduct = true;
                    }
                    
                    if (matchesStage && matchesProduct) {
                        foundRates[stage] = {
                            rate: item.rate,
                            billNumber: b.bill_number,
                            date: b.date,
                            isProductSpecific: true,
                            matchedName: item.name
                        };
                    }
                });
            });
        });

        // Step 2: For any selected stages that didn't find a product-specific rate, check for a generic stage rate
        chronologicalBills.forEach(function (b) {
            (b.line_items || []).forEach(function (item) {
                var itemNameLower = (item.name || '').toLowerCase();
                var itemDescLower = (item.description || '').toLowerCase();
                
                pickedStages.forEach(function (stage) {
                    // Skip if we already found a product-specific rate
                    if (foundRates[stage] && foundRates[stage].isProductSpecific) return;
                    
                    var stageLower = stage.toLowerCase();
                    var matchesStage = (itemNameLower.indexOf(stageLower) !== -1 || itemDescLower.indexOf(stageLower) !== -1);
                    
                    if (matchesStage) {
                        foundRates[stage] = {
                            rate: item.rate,
                            billNumber: b.bill_number,
                            date: b.date,
                            isProductSpecific: false,
                            matchedName: item.name
                        };
                    }
                });
            });
        });

        var rateRows = [];
        pickedStages.forEach(function (stage) {
            var info = foundRates[stage];
            if (info) {
                var rateTypeLabel = info.isProductSpecific ? ' (Product Specific)' : ' (Generic Rate)';
                rateRows.push(
                    '<tr>' +
                        '<td><strong>' + escapeHtml(stage) + '</strong><span class="os-pd-remarks">' + rateTypeLabel + '</span></td>' +
                        '<td class="font-semibold text-primary">₹' + Number(info.rate).toFixed(2) + '</td>' +
                        '<td class="os-bill-ref">from Bill <b>' + escapeHtml(info.billNumber) + '</b> (' + escapeHtml(info.date) + ')</td>' +
                    '</tr>'
                );
            } else {
                rateRows.push(
                    '<tr>' +
                        '<td><strong>' + escapeHtml(stage) + '</strong></td>' +
                        '<td class="text-muted italic">No rate found</td>' +
                        '<td class="os-bill-ref text-muted">Create a bill in Inventory with this product SKU & stage service name</td>' +
                    '</tr>'
                );
            }
        });

        if (rateRows.length > 0) {
            activeRatesHtml = '<h4>Active Pricing for Selected Stages</h4>' +
                '<table class="os-active-rates-table">' +
                    '<tbody>' +
                        rateRows.join('') +
                    '</tbody>' +
                '</table>';
        }
    }

    // Prices & Bills section (Zoho Inventory)
    var billsHtml = '<h4>Zoho Inventory Service Billing & Rates (All History)</h4>';
    if (!data.vendorFound) {
        billsHtml += '<p class="os-no-data">Cannot retrieve bills: Vendor is not mapped in Zoho Inventory. Please ensure the vendor exists with the display name matching "<b>' + escapeHtml(details.name || '') + '</b>".</p>';
    } else if (bills.length === 0) {
        billsHtml += '<p class="os-no-data">No bills found for this vendor in Zoho Inventory.</p>';
    } else {
        billsHtml += '<table class="os-pd-table">' +
            '<thead>' +
                '<tr>' +
                    '<th>Bill #</th>' +
                    '<th>Date</th>' +
                    '<th>Status</th>' +
                    '<th>Service Item & Rates</th>' +
                    '<th class="text-right">Total</th>' +
                '</tr>' +
            '</thead>' +
            '<tbody>' +
                bills.map(function (b) {
                    var itemsText = (b.line_items || []).map(function (item) {
                        return escapeHtml(item.name) + ' (' + item.qty + ' × ₹' + Number(item.rate).toFixed(2) + ')';
                    }).join('<br>');
                    
                    var statusClass = 'os-status-' + String(b.status || '').toLowerCase();
                    var statusLabel = String(b.status || '').toUpperCase();
                    
                    return '<tr>' +
                        '<td><span class="os-bill-no">' + escapeHtml(b.bill_number) + '</span></td>' +
                        '<td>' + escapeHtml(b.date) + '</td>' +
                        '<td><span class="os-status-badge ' + statusClass + '">' + escapeHtml(statusLabel) + '</span></td>' +
                        '<td class="os-bill-items">' + (itemsText || '—') + '</td>' +
                        '<td class="text-right font-semibold">₹' + Number(b.total || 0).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + '</td>' +
                    '</tr>';
                }).join('') +
            '</tbody>' +
        '</table>';
    }

    // Local Creator history section
    var historyHtml = '<h4>Creator Production Job History</h4>';
    if (localHistory.length === 0) {
        historyHtml += '<p class="os-no-data">No previous production outsourcing recorded in Zoho Creator.</p>';
    } else {
        historyHtml += '<table class="os-pd-table">' +
            '<thead>' +
                '<tr>' +
                    '<th>Date Sent</th>' +
                    '<th>Item Name</th>' +
                    '<th>Stage</th>' +
                    '<th>Sent</th>' +
                    '<th>Returned</th>' +
                    '<th>Status</th>' +
                '</tr>' +
            '</thead>' +
            '<tbody>' +
                localHistory.map(function (h) {
                    var statusClass = h.status === 'Done' ? 'os-status-done' : 'os-status-progress';
                    var statusLabel = h.status === 'Done' ? 'Returned' : 'Out';
                    var returnedDate = h.returned_on && h.returned_on !== 'null' ? h.returned_on : '—';
                    var remarksText = h.remarks ? '<div class="os-pd-remarks" title="' + escapeHtml(h.remarks) + '">Note: ' + escapeHtml(h.remarks) + '</div>' : '';

                    return '<tr>' +
                        '<td>' + escapeHtml(h.sent_on || '—') + '</td>' +
                        '<td>' + escapeHtml(h.item_name || '—') + remarksText + '</td>' +
                        '<td>' + escapeHtml(h.stage || '—') + '</td>' +
                        '<td>' + h.qty_sent + '</td>' +
                        '<td>' + h.qty_returned + ' (' + returnedDate + ')</td>' +
                        '<td><span class="os-status-badge ' + statusClass + '">' + statusLabel + '</span></td>' +
                    '</tr>';
                }).join('') +
            '</tbody>' +
        '</table>';
    }

    container.innerHTML = headerHtml + contactHtml + activeRatesHtml + billsHtml + historyHtml;
}
