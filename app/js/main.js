// ---------------------------------------------------------------------------
// API CALL TRACER — temporary instrumentation.
//
// Wraps ZOHO.CREATOR.DATA.invokeCustomApi so every Custom API call this widget
// makes is logged: a running number, the api_name, ms since the first call, and
// a rolling 60-second count (the per-user, per-minute limit is ~50 — code 2955).
// `window.__apiStats()` in the console prints a summary: total, calls per
// api_name, and the peak calls-in-any-60s window.
//
// Remove this block once the call count is understood.
// ---------------------------------------------------------------------------
(function () {
    try {
        if (!(window.ZOHO && ZOHO.CREATOR && ZOHO.CREATOR.DATA &&
              typeof ZOHO.CREATOR.DATA.invokeCustomApi === 'function')) {
            console.warn('[api-trace] invokeCustomApi not available — tracer not installed');
            return;
        }
        if (ZOHO.CREATOR.DATA.invokeCustomApi.__traced) return;

        var orig = ZOHO.CREATOR.DATA.invokeCustomApi;
        var seq = 0;
        var t0 = 0;
        var times = [];          // epoch ms of every call, for the rolling window
        var byName = {};         // api_name -> count
        var inflight = 0;
        var peakWindow = 0;

        function windowCount(now) {
            var cut = now - 60000;
            var c = 0;
            for (var i = times.length - 1; i >= 0; i--) {
                if (times[i] >= cut) c++; else break;
            }
            return c;
        }

        function trace(cfg) {
            var now = Date.now();
            if (!t0) t0 = now;
            seq++;
            times.push(now);
            var name = (cfg && cfg.api_name) || '(unknown)';
            byName[name] = (byName[name] || 0) + 1;
            inflight++;
            var win = windowCount(now);
            if (win > peakWindow) peakWindow = win;

            var mine = seq;
            console.log(
                '[api #' + mine + '] ' + name +
                '  +' + (now - t0) + 'ms' +
                '  · last60s=' + win +
                (win >= 45 ? '  ⚠️ NEAR LIMIT' : '') +
                '  · inflight=' + inflight
            );

            var started = now;
            var p;
            try {
                p = orig.call(this, cfg);
            } catch (e) {
                inflight--;
                console.error('[api #' + mine + '] ' + name + ' threw synchronously', e);
                throw e;
            }
            if (p && typeof p.then === 'function') {
                return p.then(function (r) {
                    inflight--;
                    console.log('[api #' + mine + '] ' + name + ' ✓ ' + (Date.now() - started) + 'ms');
                    return r;
                }, function (err) {
                    inflight--;
                    var msg = '';
                    try { msg = JSON.stringify(err); } catch (e) { msg = String(err); }
                    var throttled = /2955|too many request|rate.?limit|limit exceeded/i.test(msg);
                    console.error('[api #' + mine + '] ' + name + ' ✗ ' + (Date.now() - started) + 'ms' +
                        (throttled ? '  ← RATE LIMITED (2955)' : ''), err);
                    throw err;
                });
            }
            inflight--;
            return p;
        }
        trace.__traced = true;
        ZOHO.CREATOR.DATA.invokeCustomApi = trace;

        window.__apiStats = function () {
            var names = Object.keys(byName).sort(function (a, b) { return byName[b] - byName[a]; });
            console.log('===== API CALL SUMMARY =====');
            console.log('total calls: ' + seq + '  · span: ' + (times.length ? (times[times.length - 1] - t0) : 0) + 'ms' +
                '  · peak in any 60s window: ' + peakWindow + (peakWindow >= 50 ? '  ⚠️ OVER LIMIT' : ''));
            names.forEach(function (n) { console.log('  ' + byName[n] + '  ' + n); });
            console.log('============================');
            return { total: seq, peakWindow: peakWindow, byName: byName };
        };

        console.log('[api-trace] installed — call window.__apiStats() for a summary');
    } catch (e) {
        console.warn('[api-trace] failed to install', e);
    }
})();

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
// Non-fabric has no lots and no rows, so the figure is a plain metres total —
// but it is the CARD'S share, not the rack. Two supervisors wanting 60 each of
// 100 cones must not both read "In stock": the second cannot be issued in full,
// and a green pill over a row whose ceiling is 40 is the same lie the fabric
// branch of this function was written to stop telling. stockForCard falls back
// to the rack when there is no ledger figure, so a fabric row the allocator has
// not reached yet still behaves as it did.
function issuableTotal(material) {
    if (!material.isFabric || !material.lotLines) {
        return round2(Math.max(0, stockForCard(material)));
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

// THE CEILING IS WHAT IS LEFT FOR THIS CARD, NOT WHAT IS ON THE RACK.
//
// `availableStock` is the whole rack and the server sends it to every card
// unchanged, so using it here let two supervisors each be offered the same
// cones: 100 in stock, 60 wanted apiece, both rows capped at 60, 120 issued.
// applyStockAllocation now drains a shared counter in priority order and leaves
// each card's remainder on the row; stockForCard reads it, and falls back to the
// rack figure when the field is absent (fabric, or a payload from before the
// ledger existed).
function maxIssuable(material) {
    return round2(Math.max(0, Math.min(material.remaining, stockForCard(material))));
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

// THE CEILING ON THE pcs BOX — the allocator's OWN offer, not the rack.
//
// It cannot be the rack. The rack says how many remnants EXIST; the offer says
// how many this job needs, and they are usually different. A demand of 4 cuts
// takes ONE remnant off a row holding three, so a rack ceiling of 3 invites him
// to hand over two more against a requirement that cannot credit them — issued,
// gone from the rack, off the screen, with nothing anywhere saying why.
//
// It cannot be the CURRENT pick either: a declined pick carries 0, and clamping
// at 0 makes the box unusable exactly when he is trying to bring pieces back —
// which is the bug the old rack-based version was written to avoid.
//
// So it is `autoPieces`: what the allocator offered BEFORE he touched anything,
// stamped on every pick by applyLotAllocation (see its header for why that pass
// is safe). It is fixed while he types, so he can go down to 1 and back up to 3
// but never past the offer. Falls back to the rack for a payload that predates
// the field, which is the old behaviour rather than a hard zero.
function rackCountFor(m, pick) {
    if (pick && pick.autoPieces !== undefined) {
        return Math.max(0, Number(pick.autoPieces) || 0);
    }
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
    // `pinnedDry` is empty once an override has been ACCEPTED — the row is being
    // served off the substitute and no longer says the original lot is dry — but
    // the orders are still carried, and revising that choice is exactly what this
    // dialog is for. Gate on having something to write an override FOR.
    if (!m || (!m.pinnedDry && !(m.pinnedDryOrders || []).length)) return;

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

// One editable metres box + one checkbox PER LOT, on the SKU row. matIdx now
// indexes one entry per SKU; lotIdx is the index into lotsFor(m).
function lotLineInputId(supIdx, matIdx, lotIdx) {
    return 'fab-lot-' + supIdx + '-' + matIdx + '-' + lotIdx;
}
function lotLineCheckId(supIdx, matIdx, lotIdx) {
    return 'fab-lot-check-' + supIdx + '-' + matIdx + '-' + lotIdx;
}

// The metres a given lot on this SKU row currently carries — Σ of that lot's
// lotLines, which is what the box shows and what the submit path issues.
function lotLineMetres(m, lotId) {
    return round2((m.lotLines || []).reduce(function (t, ln) {
        return String(ln.lotId) === String(lotId) ? t + (Number(ln.qty) || 0) : t;
    }, 0));
}

// The auto (allocator) metres for a lot, for the LOT column figure — the
// recommendation, which stays fixed while he edits the ISSUE NOW box.
function lotLineAutoMetres(m, lotId) {
    return round2((m.autoLotLines || []).reduce(function (t, ln) {
        return String(ln.lotId) === String(lotId) ? t + (Number(ln.qty) || 0) : t;
    }, 0));
}

// Total WASHED metres left for THIS CARD, for one lot of this material — the
// TOTAL STOCK column. NOT the raw rack figure: `allocateEveryCard` walks every
// card in priority order and spends a shared ledger as it goes, and
// `m.lotWashLeft[lotId]` is that ledger's value at the moment just before THIS
// card took its own share — the same number the LOT recommendation beside it
// was measured against. A higher-priority card can genuinely leave this at 0
// while cloth still sits on the rack; that is the hard reservation the store
// person asked for, and reordering priority on this screen is how he unlocks
// it for whoever should have it first.
//
// READ FROM `m` (THE MATERIAL), NEVER FROM THE LOT ITSELF. A lot is shared by
// reference across every supervisor's copy of the same material — harmless
// for a read-only figure like `wash`, but a live per-card reservation cannot
// live there: card B's stamp would silently overwrite what card A was about
// to render, since they point at the very same object. `m` is per-card and
// per-row, so `lotWashLeft` living there cannot leak between cards.
//
// Falls back to the raw `wash` figure when `lotWashLeft` is absent — a
// payload that predates this field, or a caller (the admin audit) that never
// ran allocateEveryCard's priority pass at all.
function lotWashedStock(m, lotId) {
    var lots = lotsFor(m);
    for (var i = 0; i < lots.length; i++) {
        if (String(lots[i].lotId) === String(lotId)) {
            var l = lots[i];
            var reserved = (m.lotWashLeft || {})[String(lotId)];
            return round2(Number(reserved !== undefined ? reserved : l.wash) || 0);
        }
    }
    return 0;
}

// Distinct lots this SKU row draws fresh cloth from, in lotsFor(m) order, each
// with its lotsFor index so the ids line up with the allocator's lot list.
function fabricLotLineList(m) {
    var lots = lotsFor(m);
    var seen = {};
    var out = [];
    (m.lotLines || []).forEach(function (ln) {
        var lk = String(ln.lotId);
        if (seen[lk]) return;
        seen[lk] = true;
        var idx = -1;
        lots.forEach(function (l, i) { if (String(l.lotId) === lk) idx = i; });
        out.push({ lotId: lk, lotIdx: idx,
                   lotNumber: (lots[idx] && lots[idx].lotNumber) || lk });
    });
    return out;
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
//
// The piece SIZE is shown in the "To be issued" column, on the same sub-line as
// this pick — not here. This line stays the where: which lot, which carton.
// SPLIT ACROSS THE SAME TWO COLUMNS A FRESH LOT USES — LOT gets the bare lot
// number (matching "L1" / "L2" on every fresh-cloth row above it, not a wordy
// "Lot L1" that repeats what the column heading already says), ROLL gets the
// carton, because "which physical thing to walk to" is exactly what the ROLL
// column already answers for fresh cloth. A remnant has no roll, but it does
// have an address on the rack, and that address belongs in the same column a
// roll label would.
function wasteLotOnlyHtml(p) {
    if (!p.lot) return '';
    return '<div class="qty-sub waste-where waste-lot-only"><b>' +
        escapeHtml(p.lot) + '</b></div>';
}
function wasteCartonOnlyHtml(p) {
    if (p.carton) {
        return '<div class="qty-sub waste-where waste-carton-only">Carton <b>' +
            escapeHtml(p.carton) + '</b></div>';
    }
    return '<div class="qty-sub waste-where waste-carton-only">' +
        '<span class="waste-nocarton">Carton not recorded</span></div>';
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
// ---- Non-fabric (trim) allocation ----
//
// THE SAME RESERVATION FABRIC ALREADY HAS, FOR EVERYTHING THAT IS NOT FABRIC.
//
// This used to be advisory only. Its own comment said so: "nothing is reserved
// in Creator, and the Deluge function still validates against true live stock
// at issue time." Both halves were true and neither one closed the hole.
//
// The rack figure is sent to EVERY card — the server does not divide stock up —
// and `maxIssuable` clamped at that figure. So 100 cones wanted 60 apiece by two
// supervisors gave BOTH a ceiling of 60, both rows were issuable, and 120 could
// go out against 100. What the store person got instead was a warning naming the
// other supervisor, which tells him there is a conflict without telling him what
// is left for the card he is looking at, and does not stop him.
//
// "The Deluge function validates at issue time" is not the answer either. It
// re-checks against live stock, so the SECOND handover fails — after the first
// has gone out, at a counter, with the material already picked. The point of a
// ledger is that the screen never offers what is not there.
//
// So trims now walk the same shape fabric walks in allocateEveryCard: seed once
// from the rack, then spend down in priority order. It is much simpler here —
// no lots, no rolls, no marker rows, no wash state — so it is one metres counter
// per material rather than the four the fabric side keeps.
//
// PRIORITY ORDER IS THE CONTROL, exactly as it is for fabric. A card is short
// because the store person put someone else first, and he can move them up; the
// whole screen re-runs when he does. Nothing is reserved server-side — this is a
// pure function of (rack, order), and issueMaterials still re-checks every
// figure when Issue is actually pressed.
function applyStockAllocation(data) {
    // ---- Pass 1: gather demand, for the contested warning ----
    //
    // Kept, and still computed over EVERY card including the ones that will be
    // served in full. The warning answers "who else is waiting on this", which
    // is a fact about the material, not about what happens to be left.
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

    // ---- Pass 2: seed the ledger from the rack, once ----
    //
    // Separate from the spending pass below, and that separation IS the
    // reservation: every counter holds the full rack before the first card takes
    // anything. The `=== undefined` guard means a second card mentioning the
    // same material cannot re-inflate a counter the first is about to spend.
    var stockLeft = {};
    data.forEach(function (sup) {
        sup.materials.forEach(function (m) {
            if (m.isFabric) return;
            var key = String(m.materialId);
            if (stockLeft[key] === undefined) {
                stockLeft[key] = round2(Number(m.availableStock) || 0);
            }
        });
    });

    // ---- Pass 3: spend it, in card order ----
    data.forEach(function (sup) {
        sup.materials.forEach(function (m) {
            var key = String(m.materialId);
            var others = (demand[key] || []).filter(function (d) {
                return d.name !== sup.supervisorName;
            });

            // The true rack figure, kept for the columns that mean "what exists"
            // rather than "what this card may take".
            m.totalStock = Number(m.availableStock) || 0;
            m.contestedBy = others;
            // heldByOthers is used for the card header 'X contested' badge
            m.heldByOthers = others.reduce(function (sum, d) { return sum + d.needed; }, 0);

            if (m.isFabric) return;

            // WHAT IS LEFT FOR THIS CARD, BEFORE IT TAKES ANY OF IT — the same
            // rule allocateEveryCard applies for fabric. Read before spending,
            // so the top-priority card still reads the full rack and each one
            // after it reads what the cards above left.
            var have = stockLeft[key];
            if (have === undefined) have = round2(Number(m.availableStock) || 0);
            m.stockLeftForCard = round2(Math.max(0, have));

            // A ROW THAT IS ALREADY ISSUED SPENDS NOTHING. Its material has left
            // the shelf, so `availableStock` no longer counts it — charging the
            // ledger again would take it off twice and starve the next card of
            // stock that is genuinely there.
            if (isFullyIssued(m)) return;

            var want = Number(m.remaining) || 0;
            if (want <= 0) return;

            var take = Math.min(want, m.stockLeftForCard);
            if (take < 0) take = 0;
            stockLeft[key] = round2(Math.max(0, have - take));
        });
    });
}

// WHAT A NON-FABRIC ROW MAY ACTUALLY BE ISSUED, after the cards above it have
// taken their share. Falls back to the raw rack figure for a payload that
// predates the ledger, which is the old behaviour rather than a hard zero.
//
// Fabric never comes through here — it has its own per-lot ledger and its own
// ceiling (see issueCeiling), and a metres balance over lots would be the wrong
// question anyway.
function stockForCard(m) {
    if (!m || m.isFabric) return Number(m && m.availableStock) || 0;
    return m.stockLeftForCard !== undefined
        ? round2(Number(m.stockLeftForCard) || 0)
        : round2(Number(m.availableStock) || 0);
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
    // FABRIC: validate each lot box against the shelf figure. The whole-SKU
    // ceiling is the material's washed stock; a single lot box exceeding it is
    // the only thing worth flagging (the server re-checks per lot anyway).
    if (material && material.isFabric && !isFullyIssued(material)) {
        var maxSku = issueCeiling(material);
        fabricLotLineList(material).forEach(function (info) {
            var b = document.getElementById(lotLineInputId(supIdx, matIdx, info.lotIdx));
            if (!b) return;
            var v = parseFloat(b.value) || 0;
            if (v < 0 || v > maxSku + 0.0001) {
                b.classList.add('invalid');
                b.title = 'Max issuable is ' + fmt(maxSku) + ' ' + material.unit;
            } else {
                b.classList.remove('invalid');
                b.title = '';
            }
        });
        return;
    }
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
    if (!row) return;
    var material = window.__reqData[supIdx].materials[matIdx];
    if (material && material.isFabric && !isFullyIssued(material)) {
        var anyOn = fabricLotLineList(material).some(function (info) {
            var c = document.getElementById(lotLineCheckId(supIdx, matIdx, info.lotIdx));
            return c && c.checked;
        }) || wastePicks(material).some(function (p, i) {
            var c = document.getElementById(wasteCheckboxId(supIdx, matIdx, i));
            return c && c.checked;
        });
        row.classList.toggle('row-selected', anyOn);
        return;
    }
    var checkbox = document.getElementById(rowCheckboxId(supIdx, matIdx));
    if (!checkbox) return;
    row.classList.toggle('row-selected', checkbox.checked);
}

// NON-FABRIC ONLY. Fabric rows have per-lot boxes now (onLotLineInput); this is
// the accessory metres box in renderQtyIssueRow.
function onIssueInputChange(supIdx, matIdx) {
    var input = document.getElementById(rowInputId(supIdx, matIdx));
    var checkbox = document.getElementById(rowCheckboxId(supIdx, matIdx));
    if (!input || !checkbox) return;
    var val = parseFloat(input.value);
    var material = window.__reqData[supIdx].materials[matIdx];

    checkbox.checked = !(isNaN(val) || val <= 0);
    validateRow(supIdx, matIdx, material);
    markRowSelected(supIdx, matIdx);
    refreshCardState(supIdx);
}

// ---- Per-lot fabric metres boxes ----

// He typed a new metres figure for ONE lot on a SKU row. Push it onto that lot's
// lotLines via applyFabricOverride (keeps the lot split fixed, re-derives the
// cut-piece credit as whole rows per line), repaint the lot cell, resync.
function onLotLineInput(supIdx, matIdx, lotId) {
    var material = window.__reqData[supIdx].materials[matIdx];
    if (!material || !material.isFabric || isFullyIssued(material)) return;
    var lots = lotsFor(material);
    var lotIdx = -1;
    lots.forEach(function (l, i) { if (String(l.lotId) === String(lotId)) lotIdx = i; });
    var box = document.getElementById(lotLineInputId(supIdx, matIdx, lotIdx));
    if (!box) return;
    var val = parseFloat(box.value);
    applyFabricOverride(material, lotId, isNaN(val) ? 0 : val);
    validateRow(supIdx, matIdx, material);
    // Keystroke — do NOT repaint the cell being typed in (loses the cursor).
    refreshFabricRowLots(supIdx, matIdx, false);
    markRowSelected(supIdx, matIdx);
    refreshCardState(supIdx);
}

// The per-lot checkbox toggled. Checked -> restore that lot to its auto metres;
// unchecked -> zero that lot's lines (declines cloth off this roll).
function onLotLineCheck(supIdx, matIdx, lotIdx) {
    var material = window.__reqData[supIdx].materials[matIdx];
    if (!material || !material.isFabric) return;
    var info = fabricLotLineList(material).filter(function (x) { return x.lotIdx === lotIdx; })[0];
    if (!info) return;
    var chk = document.getElementById(lotLineCheckId(supIdx, matIdx, lotIdx));
    if (!chk) return;
    var target = chk.checked ? lotLineAutoMetres(material, info.lotId) : 0;
    applyFabricOverride(material, info.lotId, target);
    // Full repaint — the box value for this lot must be reset to 0 / auto.
    refreshFabricRowLots(supIdx, matIdx, true);
    markRowSelected(supIdx, matIdx);
    refreshCardState(supIdx);
}

// After a KEYSTROKE in a per-lot box: the recommended figure and the washed
// stock do not move, and repainting the cell the user is typing in would eat
// the cursor. So this only syncs the checkbox for that lot and the headline.
// `fullRepaint` (from onLotLineCheck / select-all, where a box value must be
// reset) rebuilds all three sub-line columns.
function refreshFabricRowLots(supIdx, matIdx, fullRepaint) {
    var row = document.getElementById(rowId(supIdx, matIdx));
    if (!row) return;
    var material = window.__reqData[supIdx].materials[matIdx];

    // Computed either way — both branches need it fresh, and the "To be
    // issued" cell below needs `.freshLines` regardless of which branch ran,
    // or its spacer count (built from whichever `cols` is in scope) would
    // silently keep using a stale roll-count from before this edit.
    var colsNow = lotLinesHtml(material, supIdx, matIdx, true);

    if (fullRepaint) {
        var lotCell = row.querySelector('.col-lot-issue');
        var rollCell = row.querySelector('.col-roll');
        var stockCell = row.querySelector('.col-lot-stock');
        var issueCell = row.querySelector('.col-issue');
        if (lotCell) lotCell.innerHTML = colsNow.lot + lotShortHtml(material, supIdx, matIdx);
        if (rollCell) rollCell.innerHTML = colsNow.roll;
        if (stockCell) stockCell.innerHTML = colsNow.stock;
        if (issueCell) issueCell.innerHTML = colsNow.issue ||
            '<span class="is-zero issue-cell-empty">&mdash;</span>';
    } else {
        // Keystroke: keep this lot's checkbox in step with 0 / non-0.
        fabricLotLineList(material).forEach(function (info) {
            var chk = document.getElementById(lotLineCheckId(supIdx, matIdx, info.lotIdx));
            if (chk) chk.checked = lotLineMetres(material, info.lotId) > 0;
        });

        // AND REDRAW THE ROLL COLUMN, because the roll breakdown is exactly what
        // a typed figure changes.
        //
        // applyFabricOverride re-spreads the edited metres across the lot's
        // rolls on every keystroke — unwinding newest-roll-first on the way down,
        // extending the last roll on the way up — so "A-1 · 2.2 Mtr" is stale the
        // moment he types. He is being told to cut a roll and a length; leaving
        // the length behind while the box says something else is the one thing
        // this column must never do.
        //
        // The LOT and ROLL columns only — the box he is typing in lives in the
        // ISSUE column, which is deliberately left alone so the caret survives.
        // The stock column does not move on an edit either.
        var lotOnly = row.querySelector('.col-lot-issue');
        var rollOnly = row.querySelector('.col-roll');
        if (lotOnly) {
            lotOnly.innerHTML = colsNow.lot + lotShortHtml(material, supIdx, matIdx);
        }
        if (rollOnly) rollOnly.innerHTML = colsNow.roll;
    }

    // Headline "To be issued" — the WHOLE cell, not just the figure, so a
    // waste pick's size badge stays lined up against its own row even when
    // this edit just changed how many rolls a lot spans (and so how tall the
    // fresh-lot section above the badges now is).
    var toIssueCell = row.querySelector('.col-num.col-strong');
    if (toIssueCell) {
        toIssueCell.innerHTML = toIssueHtml(material, colsNow);
    }
}

function onIssueCheckboxChange(supIdx, matIdx) {
    var cb = document.getElementById(rowCheckboxId(supIdx, matIdx));
    if (!cb) return;
    setRowChecked(supIdx, matIdx, cb.checked);
    refreshCardState(supIdx);
}

// NON-FABRIC only — fabric uses onLotLineCheck per lot.
function setRowChecked(supIdx, matIdx, checked) {
    var input = document.getElementById(rowInputId(supIdx, matIdx));
    var checkbox = document.getElementById(rowCheckboxId(supIdx, matIdx));
    if (!input || !checkbox || checkbox.disabled) return;
    var material = window.__reqData[supIdx].materials[matIdx];

    if (checked && !rowIssuable(material)) {
        checkbox.checked = false;
        input.value = 0;
    } else if (checked) {
        checkbox.checked = true;
        // The waste-adjusted figure, not the ceiling — select-all must not
        // hand out more than the requirement actually needs.
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

        // FEWER REMNANTS MEANS MORE CLOTH, AND HE MUST SEE IT ON THIS KEYSTROKE.
        //
        // Declining a remnant does not reduce the job — the pieces it would have
        // covered have to come off the roll instead. The allocator already does
        // that arithmetic; what was missing was showing it. This used to call
        // the full `render()`, which recomputed correctly but repainted the
        // whole screen: the box he was typing in was destroyed and rebuilt, so
        // the caret jumped to the end and the page scrolled back to the top on
        // every digit.
        //
        // reallocateInPlace re-runs the same allocation and repaints only this
        // material's three sub-line columns, so the metres and the named roll
        // move under his finger while the box he is in stays where it is.
        reallocateInPlace(supIdx, matIdx, { skipWastePick: pickIdx });
        refreshCardState(supIdx);
        return;
    }
    refreshCardState(supIdx);
}

// RE-RUN THE ALLOCATION AND REPAINT ONE MATERIAL'S SUB-LINES.
//
// The allocator is a pure function of (raw payload, declines, overrides) and
// rebuilds every ledger from scratch, so calling it again is the whole update —
// there is no incremental path to get wrong and no state to reset. That is the
// same property the priority reorder relies on.
//
// IT MUST RUN OVER THE WHOLE SCREEN, not this card alone. The ledgers are shared
// across cards in priority order, so a remnant this supervisor gives back is
// stock the next card down can now be offered. Re-allocating one card would
// leave every card below it quoting figures from before the change.
//
// `skipWastePick` names a box NOT to repaint — the one being typed in. Rewriting
// its value mid-keystroke moves the caret to the end, and its value is already
// exactly what he just typed.
function reallocateInPlace(supIdx, matIdx, opts) {
    opts = opts || {};
    var data = window.__reqData;
    if (!data) return;

    applyLotAllocation(data);

    // EVERY FABRIC ROW ON THE SCREEN, NOT JUST THE ONE HE TOUCHED.
    //
    // The ledgers are shared across cards in priority order, so a remnant given
    // back here is stock the next card down has just been offered — the comment
    // above says exactly that, and then only this material was repainted. Every
    // other row went on displaying figures from before the change while the model
    // underneath it had moved: the screen and the payload disagreed, and the
    // payload wins silently at Issue.
    //
    // Cheap enough to do unconditionally — it is three innerHTML writes per
    // fabric row against an allocation that has already re-run for all of them.
    (data || []).forEach(function (s2, si) {
        (s2.materials || []).forEach(function (m2, mi) {
            if (!m2.isFabric) return;
            if (si === supIdx && mi === matIdx) return;
            var r2 = document.getElementById(rowId(si, mi));
            if (!r2) return;
            var c2 = lotLinesHtml(m2, si, mi, !isFullyIssued(m2));
            var lc = r2.querySelector('.col-lot-issue');
            var rc = r2.querySelector('.col-roll');
            var sc = r2.querySelector('.col-lot-stock');
            var ic = r2.querySelector('.col-issue');
            if (lc) lc.innerHTML = c2.lot + lotShortHtml(m2, si, mi);
            if (rc) rc.innerHTML = c2.roll;
            if (sc) sc.innerHTML = c2.stock;
            if (ic) ic.innerHTML = c2.issue ||
                '<span class="is-zero issue-cell-empty">&mdash;</span>';
            // The WHOLE "To be issued" cell, not just the figure inside it — a
            // waste pick's size badge has to stay aligned with its own row even
            // when this re-allocation just changed how many rolls a lot spans.
            var h2 = r2.querySelector('.col-num.col-strong');
            if (h2) h2.innerHTML = toIssueHtml(m2, c2);
        });
    });

    var material = data[supIdx] && data[supIdx].materials[matIdx];
    if (!material) return;

    var row = document.getElementById(rowId(supIdx, matIdx));
    if (!row) return;

    var cols = lotLinesHtml(material, supIdx, matIdx, true);
    var lotCell = row.querySelector('.col-lot-issue');
    var rollCell = row.querySelector('.col-roll');
    var stockCell = row.querySelector('.col-lot-stock');
    var issueCell = row.querySelector('.col-issue');
    if (lotCell) lotCell.innerHTML = cols.lot + lotShortHtml(material, supIdx, matIdx);
    if (rollCell) rollCell.innerHTML = cols.roll;
    if (stockCell) stockCell.innerHTML = cols.stock;
    if (issueCell) {
        issueCell.innerHTML = cols.issue ||
            '<span class="is-zero issue-cell-empty">&mdash;</span>';
        // Put the caret back where it was. The pcs box he is typing in was just
        // rebuilt with the rest of the column, so restore its value and cursor
        // rather than leaving him at the end of a figure he is mid-way through.
        if (opts.skipWastePick !== undefined) {
            var box = document.getElementById(
                wasteInputId(supIdx, matIdx, opts.skipWastePick));
            if (box) {
                var pk = wastePicks(material)[opts.skipWastePick];
                if (pk) box.value = pk.pieces;
                try { box.focus(); } catch (e) { /* not focusable in a stub DOM */ }
            }
        }
    }

    // The headline "To be issued" moves with the allocation too — the WHOLE
    // cell, so a waste pick's size badge stays aligned with its own row (see
    // toIssueHtml's comment for why the plain figure was not enough).
    var head = row.querySelector('.col-num.col-strong');
    if (head) {
        head.innerHTML = toIssueHtml(material, cols);
    }
}

// ---- Master (select-all) checkboxes, one per section ----

function selectAllId(supIdx, section) {
    return 'select-all-' + supIdx + '-' + section;
}

function onSelectAllChange(supIdx, section) {
    var master = document.getElementById(selectAllId(supIdx, section));
    var sup = window.__reqData[supIdx];

    // Waste rows live inside their material's fabric group, so the fabric master
    // toggles every lot sub-line AND every waste pick of every SKU in the group.
    sup.materials.forEach(function (m, i) {
        if (sectionOf(m) !== section) return;
        if (m.isFabric && !isFullyIssued(m)) {
            fabricLotLineList(m).forEach(function (info) {
                var target = master.checked ? lotLineAutoMetres(m, info.lotId) : 0;
                applyFabricOverride(m, info.lotId, target);
            });
        } else {
            setRowChecked(supIdx, i, master.checked);
        }
        wastePicks(m).forEach(function (p, pickIdx) {
            setWasteChecked(supIdx, i, pickIdx, master.checked);
        });
    });
    // The sweep above changed DECLINES, and declines re-size the fresh metres.
    // A full re-render, same as the single-checkbox path.
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

        if (m.isFabric && !isFullyIssued(m)) {
            // Fabric: one checkbox per lot sub-line.
            fabricLotLineList(m).forEach(function (info) {
                var chk = document.getElementById(lotLineCheckId(supIdx, i, info.lotIdx));
                if (!chk || chk.disabled) return;
                t.can++;
                if (chk.checked) t.sel++;
            });
        } else {
            var checkbox = document.getElementById(rowCheckboxId(supIdx, i));
            if (checkbox && !checkbox.disabled) {
                if (rowIssuable(m)) t.can++;
                if (checkbox.checked) t.sel++;
            }
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

// Same bar the load screen uses (.load-progress / .lp-*), wrapped in a modal so
// it can sit over the issue card while a handover runs. A numeric `percentage`
// fills the bar and shows a "NN%" count; omit it for an indeterminate crawl
// (used by the "raising request" / "raising wash" spinners that have no steps).
function progressModalEl() {
    var el = document.getElementById('progress-modal');
    if (!el) {
        el = document.createElement('div');
        el.id = 'progress-modal';
        el.className = 'exc-modal hidden';
        el.innerHTML = '<div class="exc-panel progress-panel">' +
            '<div class="load-progress" id="progress-modal-card">' +
            '<div class="lp-head">' +
            '<span class="lp-title" id="progress-modal-title">Issuing Materials…</span>' +
            '<span class="lp-count" id="progress-modal-count"></span>' +
            '</div>' +
            '<div class="lp-track"><div class="lp-fill" id="progress-modal-bar"></div></div>' +
            '<div class="lp-sub" id="progress-modal-text"></div>' +
            '</div>' +
            '</div>';
        document.body.appendChild(el);
    }
    return el;
}

function showProgressModal(title, text, percentage) {
    var el = progressModalEl();
    document.getElementById('progress-modal-title').textContent = title;
    document.getElementById('progress-modal-text').textContent = text || '';

    var card = document.getElementById('progress-modal-card');
    var bar = document.getElementById('progress-modal-bar');
    var count = document.getElementById('progress-modal-count');
    var hasPct = typeof percentage === 'number' && isFinite(percentage);
    if (hasPct) {
        var pct = Math.max(0, Math.min(100, Math.round(percentage)));
        card.classList.remove('is-indeterminate');
        bar.style.width = pct + '%';
        count.textContent = pct + '%';
    } else {
        card.classList.add('is-indeterminate');
        bar.style.width = '';
        count.textContent = '';
    }
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

    // EVERY LINE IS EDITABLE, FLOORED AT THE COMPUTED SHORTFALL. Same rule as
    // the single-material dialog: below the computed figure the PO cannot clear
    // the shortage, so the row returns and the ticket already open against it
    // greys out the button. Above it is his call — a round order quantity, a
    // minimum the vendor imposes, or cloth bought ahead.
    //
    // No upper bound. The cloth does not exist yet, so there is nothing to
    // measure a ceiling against.
    body.innerHTML = rows.map(function (item, i) {
        var e = item.e;
        var floorQty = round2(Number(item.qty) || 0);
        return '<tr>' +
            '<td class="material-name-cell">' +
                '<div class="mat-name">' + escapeHtml(e.material) + '</div>' +
                (e.sku ? '<div class="mat-sku">' + escapeHtml(e.sku) + '</div>' : '') +
                '<div class="po-qty-note" id="po-qty-note-' + i + '"></div>' +
            '</td>' +
            '<td class="col-num col-strong">' +
                '<span class="po-qty-cell">' +
                '<input type="number" class="po-qty-input" id="po-qty-' + i + '" ' +
                    'step="0.01" min="' + floorQty + '" value="' + floorQty + '" ' +
                    'data-floor="' + floorQty + '" ' +
                    'oninput="onPoQtyChange(' + i + ')" />' +
                '<span class="unit">' + escapeHtml(e.unit || '') + '</span>' +
                '</span>' +
            '</td>' +
        '</tr>';
    }).join('');
}

// Warn below the floor; submitBulkPO clamps. Same shape as onExcQtyChange.
function onPoQtyChange(i) {
    var inp = document.getElementById('po-qty-' + i);
    var box = document.getElementById('po-qty-note-' + i);
    if (!inp || !box) return;
    var floorQty = round2(Number(inp.getAttribute('data-floor')) || 0);
    var val = Number(inp.value);
    box.innerHTML = (inp.value !== '' && val >= 0 && val + 0.0001 < floorQty)
        ? '&#9888; Below the ' + fmt(floorQty) + ' still short &mdash; the ' +
          'shortage stays open and this comes back.'
        : '';
}

// What to order for line i, floored at the computed shortfall. A blank or
// below-floor box means the computed amount — the safe reading of "he did not
// choose", and the same rule excQtyValue applies.
function poQtyValue(i, item) {
    var inp = document.getElementById('po-qty-' + i);
    var floorQty = round2(Number(item.qty) || 0);
    if (!inp) return floorQty;
    var val = Number(inp.value);
    if (!(val > 0) || val + 0.0001 < floorQty) return floorQty;
    return round2(val);
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

// ONE EXCEPTION LINE PER PLAN, summed across that plan's requirement rows.
//
// `e.lines` is one entry per Material_Requirement row — a plan wanting a trim
// at four cut sizes contributes four, and a FABRIC material with many small
// orders can carry a hundred or more (the exact case that put 105 rows on a
// single Wash_Needed ticket for one lot of Dusty Gold — the whole reason this
// exists is not the PO screen alone). The ticket's question is "which ORDERS
// wanted this and how much", so the grain it needs is the plan, and repeating
// a plan several times over is what made a request read as needed by 105
// orders when a handful of distinct plans actually wanted it.
//
// SHARED by both raise paths — submitSummaryException (wash and single-material
// purchase) and submitBulkPO (the multi-material PO). One shape, one place that
// decides what "which orders wanted this" means, so the wash ticket and the
// purchase ticket for the same shortage cannot disagree about it.
//
// planId is what getStoreMaterialRequirements reads back as `planIds`, so a
// line with no plan is dropped rather than written blank — a blank Plan lookup
// would be silently skipped there anyway and only take up a subform row.
function exceptionLinesFor(e) {
    var byPlan = {};
    var order = [];
    (e.lines || []).forEach(function (l) {
        var pid = String(l.planId || '');
        if (!pid) return;
        if (!byPlan[pid]) {
            byPlan[pid] = {
                planId: pid,
                salesOrder: l.salesOrder || '',
                planItemId: '',
                supervisorId: l.supervisorId || '',
                required: 0,
                issued: 0
            };
            order.push(pid);
        }
        // planItemId is deliberately left empty on a collapsed line. It names ONE
        // Plan_Item, and this line now speaks for every row of the plan — stamping
        // whichever happened to come first would point the ticket at an arbitrary
        // one of them.
        byPlan[pid].required = round2(byPlan[pid].required + (Number(l.required) || 0));
        byPlan[pid].issued = round2(byPlan[pid].issued + (Number(l.issued) || 0));
    });
    return order.map(function (pid) { return byPlan[pid]; });
}

function submitBulkPO() {
    var vendorId = document.getElementById('vendor-select').value;
    if (!vendorId) return;

    // READ THE TYPED QUANTITIES BEFORE THE MODAL GOES. closeVendorModal only
    // adds a `hidden` class today, so the inputs would survive the read either
    // way — but that is an implementation detail of a function three hundred
    // lines away, and the moment it starts emptying the modal this call would
    // silently fall back to every floor value with no error anywhere.
    var s = window.__summary || { toBuy: [] };
    var orderQty = s.toBuy.map(function (item, i) { return poQtyValue(i, item); });

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

    var payload = s.toBuy.map(function(item, i) {
        // ONE LINE PER PLAN, NOT PER REQUIREMENT ROW — and the lines are NOT
        // optional, which is what this call learned the hard way.
        //
        // They were dropped entirely once, on the reasoning that a PO is not
        // split per order so procurement does not act on them, and that a
        // common trim on dozens of plans made the "N orders waiting" figure on
        // the My requests tab read as "212". Both observations were true. The
        // conclusion was not: `Exception_Lines.Plan` is what
        // getStoreMaterialRequirements builds `planIds` from, and `planIds` is
        // what requestState asks "does this ticket already cover every order
        // waiting". An empty list does not mean "covers nothing in
        // particular" — it means EVERY plan reads as uncovered, so the row is
        // permanently 'stale', `poRaisedThisSession` is never true, and the
        // material can never settle. That is the whole "PO raised but an order
        // still shows pending" fault.
        //
        // COLLAPSED PER PLAN, which answers the 212 without dropping anything.
        // A plan wanting a trim on four requirement rows is ONE order waiting,
        // and its quantities are summed rather than repeated — so the ticket
        // reads "which orders wanted this and how much", which is exactly what
        // raiseMaterialException's own header says the lines are for.
        //
        // No rate: this screen has none, so raiseBulkPurchaseOrder falls back
        // to the catalogue Rate; the third-party / print screens pass a UI rate
        // here instead.
        return {
            materialId: item.e.materialId,
            quantity: orderQty[i],
            lines: exceptionLinesFor(item.e)
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
// A PRINTED LOT CANNOT BE WASHED YET, so it is never a candidate. Pre-rolls,
// its metres were the maintained sum of its Fabric_Piece rows, and a wash
// request moved a metres figure between two columns on the header without
// touching a single piece — washing one left the header claiming washed metres
// while every piece behind it still said Unwash. Under the rolls model a
// printed lot is a lot with short `Lot_Rolls`, same as any other, and washing
// is still lot-level-only (see lot-rolls-model.md: "what washing does to a
// roll") — there is still no way to wash a subset of a lot's physical rolls, so
// the same "would leave part of it claiming a state it does not have" problem
// applies and printed lots stay excluded here on the same `l.form !== 'Pieces'`
// guard below (the legacy field, still populated on the lot payload).
//
// This picker read `e.lots` directly instead of going through the allocator —
// every lot the server sent — which is how a printed one could still be chosen
// by hand. Refused here AND in raiseMaterialException. This is the courtesy;
// that is the guard.
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
    var sel = document.getElementById('exc-lot');

    // THE QUANTITY CEILING MOVES WITH THE LOT. The box is capped at the chosen
    // lot's greige, so picking a different lot has to re-cap it — otherwise a
    // ceiling from the previously selected lot stays on the field and either
    // blocks a larger legitimate ask or permits one that will be trimmed.
    //
    // The typed value is left alone when it still fits. Only a value now above
    // the new lot's greige is pulled down, and never below the floor: those two
    // bounds can genuinely conflict (a lot too small to cover the requirement),
    // and when they do the floor wins and the note says the wash will fall
    // short. Silently lowering it under the requirement would hide exactly the
    // shortfall this screen is for.
    if (sel) {
        var inp = document.getElementById('exc-qty');
        var cap = washCapFor();
        if (inp) {
            if (cap > 0) {
                inp.setAttribute('max', cap);
            } else {
                inp.removeAttribute('max');
            }
            var floorQty = round2(Number(inp.getAttribute('data-floor')) || 0);
            var cur = Number(inp.value);
            if (cap > 0 && cur > cap + 0.0001) {
                inp.value = round2(Math.max(cap, floorQty));
            }
        }
        onExcQtyChange('wash');
    }

    if (!box) return;
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

// THE EDITABLE QUANTITY FIELD, and the rules that bound it.
//
// `min` is the computed figure for both kinds — see the call site for why less
// than the requirement is never a useful answer. `max` is only set for a wash,
// at the chosen lot's greige.
//
// Both bounds are re-checked in excQtyValue() as well as on the input, because
// a number input's min/max do not stop a typed value; they only mark it
// invalid. The wash ceiling is additionally enforced server-side by
// raiseMaterialException, which is the one that actually counts — this is the
// courtesy that tells him before he presses, not the guard.
function excQtyFieldHtml(kind, entry, e) {
    var isWash = kind === 'wash';
    var floorQty = round2(Number(entry.qty) || 0);
    var capQty = isWash ? washCapFor(entry) : 0;

    var label = isWash ? 'How much to send' : 'How much to order';

    return '' +
        '<label class="exc-label" for="exc-qty">' + label + '</label>' +
        '<div class="exc-qty-row">' +
        '<input type="number" id="exc-qty" class="note-input exc-qty-input" ' +
        'step="0.01" min="' + floorQty + '" ' +
        (capQty > 0 ? 'max="' + capQty + '" ' : '') +
        'value="' + floorQty + '" ' +
        'data-floor="' + floorQty + '" ' +
        'oninput="onExcQtyChange(\'' + kind + '\')" />' +
        '<span class="exc-qty-unit">' + escapeHtml(e.unit || '') + '</span>' +
        '</div>' +
        '<div class="exc-qty-note" id="exc-qty-note"></div>';
}

// What the CHOSEN lot can actually give. Falls back to the entry's own lot for
// the first render, before the dropdown exists.
function washCapFor(entry) {
    var sel = document.getElementById('exc-lot');
    if (sel && window.__excLots) {
        var v = Number(window.__excLots[String(sel.value)]);
        if (v >= 0) return round2(v);
    }
    return entry && entry.lot ? round2(Number(entry.lot.unwash) || 0) : 0;
}

// Warn, and for the floor also correct. Never silently — the note says what
// happened, because a field that snaps back with no explanation reads as broken.
function onExcQtyChange(kind) {
    var box = document.getElementById('exc-qty-note');
    var inp = document.getElementById('exc-qty');
    if (!box || !inp) return;

    var floorQty = round2(Number(inp.getAttribute('data-floor')) || 0);
    var val = Number(inp.value);
    var msgs = [];

    if (inp.value !== '' && val >= 0 && val + 0.0001 < floorQty) {
        msgs.push('&#9888; Below the ' + fmt(floorQty) +
            ' the orders need. Raising less than this leaves the shortage open ' +
            'and the row comes straight back.');
    }

    if (kind === 'wash') {
        var cap = washCapFor();
        if (cap > 0 && val > cap + 0.0001) {
            msgs.push('&#9888; This lot only has <b>' + fmt(cap) +
                '</b> unwashed, so only that much will be washed.');
        }
    }

    box.innerHTML = msgs.join('<br />');
}

// The figure to send. Clamped to the floor — a blank or below-floor box means
// the computed amount, which is the safe reading of "he did not choose".
// The wash ceiling is NOT clamped here: raiseMaterialException trims it against
// live greige, which may have moved since the page loaded, and a stale
// client-side cap would be the wrong number to argue with.
function excQtyValue(entry) {
    var inp = document.getElementById('exc-qty');
    var floorQty = round2(Number(entry.qty) || 0);
    if (!inp) return floorQty;
    var val = Number(inp.value);
    if (!(val > 0) || val + 0.0001 < floorQty) return floorQty;
    return round2(val);
}

function openSummaryException(kind, idx) {
    var entry = summaryEntry(kind, idx);
    if (!entry) return;
    var e = entry.e;
    var el = exceptionModalEl();

    var isWash = kind === 'wash';
    var title = isWash ? 'Send for washing' : 'Request a purchase';
    var actionLabel = isWash ? 'To wash' : 'Short by';

    // SIMPLIFIED, deliberately. This used to break the shortfall down by
    // supervisor/order — who is waiting, which orders, QC remakes — none of
    // which the store person acts on here. He needs one fact: this material
    // is short by this much, and it either needs washing or buying. The
    // payload behind this dialog is unchanged — raiseMaterialException still
    // gets the full `lines` array with every plan/order/supervisor on it, so
    // procurement's ticket still answers "which orders wanted this" exactly
    // as before. Only this screen's own display dropped the breakdown.
    var plainMsg = isWash
        ? 'This material needs washing.'
        : 'This material needs to be purchased.';

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
        // THE QUANTITY IS EDITABLE, FLOORED AT WHAT THE SCREEN WORKED OUT.
        //
        // The computed figure is what the orders actually need, so going BELOW
        // it can only re-create the fault this whole screen exists to report -
        // he would raise a request that cannot clear the shortage and the row
        // would come straight back, with a ticket already open against it
        // greying out the button. Going ABOVE is a real decision he is entitled
        // to make: buying a round 500 instead of 431.6, or washing a whole lot
        // while it is at the washer anyway.
        //
        // So: default = computed, floor = computed, and the ceiling differs by
        // kind. A PO has none - the cloth does not exist yet and he may order as
        // much as he likes. A wash is capped at the CHOSEN LOT'S greige,
        // because washing converts one lot's cloth and there is no more of it;
        // raiseMaterialException caps there anyway and says nothing, so a
        // figure above it is silently trimmed. The cap moves with the lot
        // dropdown - see onWashLotChange.
        excQtyFieldHtml(kind, entry, e) +
        // Said out loud, because the figure is deliberately MORE than the
        // shortfall and would otherwise read as an arithmetic fault.
        (isWash && entry.qty > round2(e.needed - e.stock) + 0.0001
            ? '<div class="exc-why-more">Washing the whole requirement, not just the ' +
            fmt(round2(e.needed - e.stock)) + ' ' + escapeHtml(e.unit) +
            ' short, so it can all be issued off one lot &mdash; one tone. ' +
            'The washed stock on the other lots keeps for a later order.</div>'
            : '') +
        // NO ORDER IS WAITING ON THIS LOT, and he has to be told, or the wash
        // reads as the thing that unblocks the job. It is not: this lot cannot
        // cover any waiting order whole, so nothing commits to it and nothing
        // will issue off it the moment it comes back. Washing it is still worth
        // doing — it is owned cloth in this shade and it shrinks the purchase —
        // but the order still needs the rest buying.
        (isWash && entry.uncommitted
            ? '<div class="exc-why-more">No order is waiting on this lot &mdash; it ' +
            'cannot cover one on its own, so nothing is committed to it. Washing it ' +
            'still turns owned greige into cloth you can cut and reduces what has to ' +
            'be bought, but it will not finish an order by itself.</div>'
            : '') +
        '<div class="exc-plain">' + plainMsg + '</div>' +
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

    // What he actually asked for, floored at the computed requirement.
    var askQty = excQtyValue(entry);

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
                // point of raising it from here. `required` stays the computed
                // requirement even when he asks for more: it is what the ORDERS
                // want, and resolvePurchaseShortages closes the ticket against
                // it. Rounding a purchase up to a convenient number must not
                // also raise the bar the ticket has to clear before it closes.
                required: e.needed,
                available: e.stock,
                unwashed: e.unwashed,
                // What he chose to ask for — at least the computed figure, and
                // possibly more. This is the number acted on: the metres bought,
                // or the greige sent to the wash.
                shortfall: askQty,
                unit: e.unit,
                note: document.getElementById('exc-note').value,
                // Wash only, and only when a lot was offered. completeWashRequest
                // moves the cloth inside this lot; without it the parent total
                // moves on its own and the lots underneath drift short of it.
                lotId: washLotChoice(kind),
                // COLLAPSED PER PLAN, same as the bulk PO path — see
                // exceptionLinesFor. `e.lines` is one row per requirement, and a
                // fabric material spread over a hundred small orders put a
                // hundred rows on one ticket: 105 lines for one lot of one
                // material, all saying "this order needs this fabric", none of
                // them summarising anything a person reads. One line per plan
                // is the same information at the grain the ticket is actually
                // asked about.
                lines: exceptionLinesFor(e)
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
                    // Collapsed per plan — same reason as submitSummaryException.
                    lines: exceptionLinesFor(e)
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
// WORTH WARNING ABOUT ONLY WHEN THE CLOTH CANNOT GO ROUND. Two supervisors
// wanting 30 each of 100 are not in contention; they both get served.
//
// FOR A TRIM THE LEDGER HAS ALREADY DECIDED THIS, so the test is simply whether
// this card was left short of what it wants. That is the honest question now:
// the ceiling is the card's own remainder, so a warning means "you will not be
// able to issue this row in full", which is exactly the fact he needs. The old
// gross test (total demand > rack) fired on every card of a contested material
// including the ones served in full, which is why the warnings read as
// wallpaper.
//
// Fabric keeps the gross test — its ledger is per lot and per roll, so "is this
// card short" is answered by the allocator's own outcomes rather than by a
// metres balance, and a warning here would double up on the lot-level reasons
// the fabric rows already print.
function isContested(m) {
    if (!m.contestedBy || m.contestedBy.length === 0) return false;
    if (!m.isFabric && m.stockLeftForCard !== undefined) {
        var want = Number(m.remaining) || 0;
        if (want <= 0) return false;
        return round2(stockForCard(m)) + 0.0001 < round2(want);
    }
    var totalWanted = (Number(m.remaining) || 0) + (Number(m.heldByOthers) || 0);
    return totalWanted > (Number(m.availableStock) || 0) + 0.0001;
}

function shortPill(m) {
    var s = stockStatus(m);
    return s.cls === 'status-sufficient'
        ? ''
        : '<span class="status-pill ' + s.cls + '">' + s.label + '</span>';
}


// THREE STACKED COLUMNS for a fabric SKU row, one sub-line per lot (and one per
// waste pick):
//   LOT        — "<roll> · <recommended metres>", read-only. The recommendation
//                stays fixed while he edits ISSUE NOW.
//   TOTAL STOCK — that lot's washed metres on the rack, read-only.
//   ISSUE NOW   — the editable metres box + checkbox for that lot alone.
//
// Returns { lot, roll, stock, issue } — four HTML fragments, each a vertical
// stack aligned sub-line for sub-line. renderFabricRows drops them into four
// <td>s.
//
// editable is false for the read-only receipt (a fully-issued row) and for a
// Pieces lot, where a free metres figure has no physical meaning.
function lotLinesHtml(m, supIdx, matIdx, editable) {
    var lots = lotsFor(m);
    var lotLineList = fabricLotLineList(m);
    var picks = wastePicks(m);
    if (lotLineList.length === 0 && picks.length === 0) {
        // No fresh lot chosen and no waste pick — a row this short of its
        // shade with nothing to name. Every fragment must come back as an
        // empty string, never `undefined`: `renderFabricRows` concatenates
        // these straight into a <td>, and `'<td>' + undefined + '</td>'`
        // prints the literal word "undefined" in the ROLL column.
        return { lot: '', roll: '', stock: '', issue: '' };
    }

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
    // WHICH PHYSICAL ROLL TO CUT, AND HOW MUCH OFF IT.
    //
    // A lot is a set of rolls, not a metres pool. "L2 · 8 m" tells him a number
    // and leaves him standing in front of a rack of four rolls deciding which one
    // to open — which is the decision the allocator already made, on lengths he
    // cannot see from the screen. It drains shortest-roll-first specifically so
    // the short ends get used up rather than accumulating, and that intent is
    // lost entirely if the roll is not named.
    //
    // One line per roll, in DRAIN ORDER — the order the allocator used them,
    // which is the order to cut them in. Shortest first, so the first line is the
    // roll he is meant to finish off.
    //
    // SUMMED ACROSS LINES OF ONE LOT — UNLESS THE LOT WAS HAND-EDITED.
    //
    // The two writers disagree on grain. applyLotAllocation gives each
    // requirement line ONLY the rolls IT cut, so when a lot's roll is big
    // enough to serve several separate orders, several lines legitimately
    // share a rollId with DIFFERENT metres each — a roll draining across many
    // orders, not one order counted twice — and the true total off that roll
    // is their SUM. Taking the largest of them (the old rule) quoted a single
    // order's slice as if it were the whole draw: a lot recommending 1,296 m
    // read as "13.5 m off this roll" because that was the biggest of dozens of
    // per-order slices, off by two orders of magnitude from what was actually
    // being asked for.
    //
    // applyFabricOverride is the one exception: editing a lot's box stamps the
    // SAME breakdown onto EVERY line of that lot (`ln.rollsShared = true` —
    // the comment there says why), so its lines are not independent draws to
    // add up, they are one draw written out several times. Take the first such
    // line for a lot and ignore the rest — summing would multiply an edited
    // lot's figure by the number of lines it serves.
    var rollsByLot = {};
    (m.lotLines || []).forEach(function (ln) {
        var lk = String(ln.lotId);
        if (!rollsByLot[lk]) rollsByLot[lk] = { order: [], by: {}, sharedSeen: false };
        var bucket = rollsByLot[lk];
        if (ln.rollsShared) {
            if (bucket.sharedSeen) return;   // already have the lot's one true copy
            bucket.sharedSeen = true;
        }
        (ln.rolls || []).forEach(function (rl) {
            var rid = String(rl.rollId);
            var mtr = round2(Number(rl.metres) || 0);
            if (bucket.by[rid]) {
                bucket.by[rid].metres = round2(bucket.by[rid].metres + mtr);
            } else {
                bucket.by[rid] = { label: String(rl.label || ''), metres: mtr };
                bucket.order.push(rid);
            }
        });
    });

    // A SINGLE ROLL IS STILL NAMED. The row above it already prints the lot and
    // the metres, so on a one-roll lot this line repeats the figure — and that is
    // the point: the figure he is given and the roll he takes it off are one
    // instruction, and splitting them across two places is what made the old
    // "9 Mtr off L1" unfollowable. It costs one short line and removes the
    // question "which of these is it".
    //
    // Returns an ARRAY, one string per roll — not joined — because the caller
    // needs the COUNT: a lot split across two rolls prints two lines here but
    // only one in LOT / TOTAL STOCK / ISSUE NOW, and those three columns have
    // to pad themselves out to the same height or the next lot down prints
    // against the wrong roll line. See the padding block below.
    var rollLinesFor = function (k) {
        var l = lots[Number(k)];
        var bucket = l ? rollsByLot[String(l.lotId)] : null;
        if (!bucket || !bucket.order.length) return [];
        var out = [];
        bucket.order.forEach(function (rid) {
            var e = bucket.by[rid];
            if (e.metres <= 0) return;
            out.push('<div class="lot-rolls">' +
                '<b>' + escapeHtml(e.label || '—') + '</b> &middot; ' +
                fmt(e.metres) + ' ' + escapeHtml(m.unit) +
                '</div>');
        });
        return out;
    };

    var lotCol = '';
    var rollCol = '';
    var stockCol = '';
    var issueCol = '';
    // TOTAL LINES THE FRESH-LOT SECTION TAKES, summed across every lot's block
    // (1 per lot, or more when a lot spans several rolls — see `lineCount`
    // below). renderFabricRows uses this to size the "To be issued" column's
    // blank spacers ahead of the waste-pick size badges: a spacer count that
    // only knew "one lot = one line" left a waste pick's badge sitting against
    // whichever roll line the fresh section happened to end on, not against
    // its own row.
    var freshBlockLines = 0;

    // ---- one sub-line per lot ----
    lotLineList.forEach(function (info, lotIdx0) {
        var k = info.lotIdx;
        // SEPARATOR ONLY BETWEEN TWO LOTS, never before a following waste
        // pick — that line has no `.lot-block` wrapper and no matching height
        // in the "To be issued" column, so a divider fired against it (via
        // `:not(:last-child)`, which just means "any following sibling") added
        // height nothing else on the row was accounting for. An explicit
        // per-lot check is unambiguous where a CSS structural selector is not.
        var blockClass = 'lot-block' +
            (lotIdx0 < lotLineList.length - 1 ? ' lot-block-divider' : '');
        var cur = lotLineMetres(m, info.lotId);
        var auto = lotLineAutoMetres(m, info.lotId);
        var washed = lotWashedStock(m, info.lotId);
        // EVERY LOT IS EDITABLE NOW. The old `!isPiecesLot(...)` guard locked the
        // box on a printed lot held as Fabric_Piece rows, because a stack of
        // pieces has no metres to type into. Phase A retired that form — printed
        // cloth is a lot with short rolls like any other — so there is nothing
        // left for the guard to exclude.
        var canEdit = editable;

        // LOT: roll name + recommended metres (fixed).
        //
        // AND, WHEN HE HAS ASKED FOR MORE THAN THE ROLL HAS, WHAT HE IS ACTUALLY
        // GETTING. applyFabricOverride clamps an edit-up at the free length of
        // the last roll used and the box he is typing in is deliberately never
        // repainted (it would eat the caret) — so the figure in the box and the
        // figure in the payload disagreed, silently, in the direction that made
        // him think more cloth was going out than was. This column IS repainted
        // on every keystroke, so the correction lands under his finger.
        var clamped = (m.lotEditShort || {})[String(info.lotId)];
        var clampNote = clamped
            ? '<div class="lot-dry">Only ' + fmt(clamped.placed) + ' ' +
              escapeHtml(m.unit) + ' left on this roll</div>'
            : '';

        // ONE LOT IS ONE BLOCK, THE SAME HEIGHT IN ALL FOUR COLUMNS.
        //
        // LOT / TOTAL STOCK / ISSUE NOW each print exactly one line for this
        // lot; ROLL prints one line PER ROLL. A two-roll lot therefore made
        // ROLL two lines taller than the other three — and because every
        // lot's lines are just appended, one after another, down each <td>,
        // the NEXT lot's LOT box ended up sitting beside this lot's second
        // roll line instead of its own. Filler lines below pad the shorter
        // columns out to the roll count, so lot N is always a block of the
        // same height in every column and lot N+1 starts at the same place
        // in all four.
        var rollLines = rollLinesFor(k);
        var lineCount = Math.max(rollLines.length, 1);
        freshBlockLines += lineCount;
        var filler = '';
        for (var fillI = 1; fillI < lineCount; fillI++) {
            filler += '<div class="lot-line-filler"></div>';
        }

        lotCol +=
            '<div class="' + blockClass + '">' +
            '<div class="lot-from lot-line-row">' +
            '<span class="lot-line-name"><b>' + lotName(k) + '</b></span>' +
            '<span class="lot-line-rec">' + fmt(auto) + ' ' + escapeHtml(m.unit) + '</span>' +
            '</div>' + filler +
            '</div>';

        // ROLL: which physical roll(s) to cut off this lot, in drain order.
        rollCol += '<div class="' + blockClass + '">' +
            (rollLines.length ? rollLines.join('') :
                '<div class="lot-rolls roll-empty">&mdash;</div>') +
            clampNote +
            '</div>';

        // TOTAL STOCK: this lot's washed metres.
        stockCol += '<div class="' + blockClass + '">' +
            '<div class="lot-line-cell">' + qty(washed, m.unit) + '</div>' + filler +
            '</div>';

        // ISSUE NOW: editable box + checkbox (or static text when not editable).
        var issueLine;
        if (canEdit) {
            issueLine =
                '<div class="lot-line-cell issue-cell">' +
                '<span class="issue-input-group lot-line-box">' +
                '<input type="number" step="0.01" min="0" ' +
                'class="issue-input" id="' + lotLineInputId(supIdx, matIdx, k) + '" ' +
                'value="' + cur + '" ' +
                'oninput="onLotLineInput(' + supIdx + ',' + matIdx + ',\'' + info.lotId + '\')" />' +
                '<span class="issue-unit">' + escapeHtml(m.unit) + '</span>' +
                '</span>' +
                '<input type="checkbox" class="issue-checkbox" ' +
                'id="' + lotLineCheckId(supIdx, matIdx, k) + '" ' +
                (cur > 0 ? 'checked ' : '') +
                'aria-label="Issue ' + escapeHtml(m.material) + ' from ' + lotName(k) + '" ' +
                'onchange="onLotLineCheck(' + supIdx + ',' + matIdx + ',' + k + ')" />' +
                '</div>';
        } else {
            issueLine = '<div class="lot-line-cell"><span class="lot-line-static">' +
                fmt(cur) + ' ' + escapeHtml(m.unit) + '</span></div>';
        }
        issueCol += '<div class="' + blockClass + '">' + issueLine + filler + '</div>';
    });

    // ---- one sub-line per waste pick ----
    // Lot in the LOT column, carton in the ROLL column — the same split a
    // fresh-cloth row makes between "which tone" and "which physical thing to
    // find", so a remnant reads as one more row of the same table rather than
    // a special case bolted on. No washed-stock figure for a remnant, so TOTAL
    // STOCK is blank. ISSUE NOW is a pcs box + checkbox.
    picks.forEach(function (p, pickIdx) {
        lotCol += wasteLotOnlyHtml(p);
        rollCol += wasteCartonOnlyHtml(p);
        stockCol += '<div class="lot-line-cell"><span class="is-zero">&mdash;</span></div>';
        if (editable) {
            issueCol +=
                '<div class="lot-line-cell issue-cell issue-cell-waste" id="' + wasteRowId(supIdx, matIdx, pickIdx) + '">' +
                '<span class="issue-input-group lot-line-box">' +
                '<input type="number" step="1" min="0" max="' + rackCountFor(m, p) + '" ' +
                'class="issue-input" id="' + wasteInputId(supIdx, matIdx, pickIdx) + '" value="' + p.pieces + '" ' +
                'oninput="onWasteInputChange(' + supIdx + ',' + matIdx + ',' + pickIdx + ')" />' +
                '<span class="issue-unit">pcs</span>' +
                '</span>' +
                '<input type="checkbox" class="issue-checkbox" id="' + wasteCheckboxId(supIdx, matIdx, pickIdx) + '" ' +
                (wasteCheckedFor(p) ? 'checked ' : '') +
                'aria-label="Issue waste pieces of ' + escapeHtml(m.material) + '" ' +
                'onchange="onWasteCheckboxChange(' + supIdx + ',' + matIdx + ',' + pickIdx + ')" />' +
                '</div>';
        } else {
            issueCol += '<div class="lot-line-cell"><span class="lot-line-static">' +
                p.pieces + ' pcs</span></div>';
        }
    });

    return { lot: lotCol, roll: rollCol, stock: stockCol, issue: issueCol,
             freshLines: freshBlockLines };
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
        // HIS LAST ANSWER WAS REFUSED, AND THE DIALOG IS ABOUT TO OPEN LOOKING
        // IDENTICAL. The allocator re-checks an override against the live rack on
        // every pass, so a substitute that has since been quarantined or emptied
        // is dropped — and without this line the row reverts to the original
        // sentence and he picks the same lot again.
        var again = why.refused
            ? '<div class="lot-dry">' + escapeHtml(why.refused) +
              ' cannot take it either</div>'
            : '';
        return '<div class="lot-dry">' +
            (why.kind === 'pinnedBlocked'
                ? 'Cut from <b>' + escapeHtml(why.lot) + '</b>, which is blocked'
                : '<b>' + escapeHtml(why.lot) + '</b> is empty &mdash; this was cut from ' +
                escapeHtml(why.lot)) +
            '</div>' + again +
            '<button type="button" class="lot-override-btn" ' +
            'onclick="openLotOverride(' + supIdx + ',' + matIdx + ')">' +
            'Use another lot&hellip;</button>';
    }
    // THE SHADE IS THERE AND THERE IS NOT ENOUGH OF IT.
    //
    // No button, because there is nothing on this screen to press: the order is
    // already cut in this tone, the tone has nothing left to wash and nothing at
    // the washer, and more of it has to be bought or printed. What this line has
    // to do is stop the row saying "None of this shade left" — which is what it
    // said, over the lot it names, with the pieces it is short sitting in the
    // allocator and never reaching the screen.
    if (why.kind === 'pinnedShort') {
        return (why.lots || []).map(function (w) {
            return '<div class="lot-dry"><b>' + escapeHtml(w.lotNumber || '') +
                '</b> &middot; ' + w.pieces + ' pcs short of this shade</div>';
        }).join('') +
            // Only where a tone override is already in force — see the reason
            // itself for why it is not offered on an ordinary pinned row.
            (why.canOverride
                ? '<button type="button" class="lot-override-btn" ' +
                  'onclick="openLotOverride(' + supIdx + ',' + matIdx + ')">' +
                  'Use another lot&hellip;</button>'
                : '');
    }
    if (why.kind === 'nofit') {
        // ONE FACT, NOT TWO NUMBERS HE CANNOT USE. `have` (the longest piece
        // left) and `need` (the smallest job's length) exist so a developer
        // can audit the allocator's arithmetic — they used to be printed here
        // too, and all they did on the floor was raise a question nobody could
        // answer: "17.3 Mtr" measured against what, "smallest waiting order
        // needs 29.2" waiting for which order? He cannot go measure a roll to
        // check it and would not know which of several pending orders it
        // meant. The one thing he can act on, and the one thing this screen
        // owes him, is the shortfall itself and that the shelf cannot cover
        // it — the actual why (this lot's cloth is in short pieces) belongs on
        // the allocator's audit screen, not here.
        //
        // "NO LOT", NOT "NOT ON L3". `why.lot` is the BEST of every lot this
        // material has — chooseLotForOrder walked all of them and this is
        // whichever held the longest cuttable piece — so naming it as though it
        // were the one lot checked reads as "go look at a different one", which
        // is backwards: every lot was checked and L3 already won. Named
        // separately, as where the closest piece happens to be, not as the
        // subject of the sentence.
        return '<div class="lot-dry">Still short ' + fmt(why.short) + ' ' + u +
            ' of this shade &mdash; no lot has a piece long enough to cover the ' +
            'whole order (closest is <b>' + escapeHtml(why.lot) + '</b>). Needs fresh stock.</div>';
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




// NON-FABRIC ROWS ONLY (trims: thread, labels, cones). Fabric goes through
// renderFabricRows, which now draws one row per SKU with per-lot editable boxes
// — a completely different shape, so there is no shared fallback to keep in step
// any more. If fabric is ever routed here it will render a bare metres box with
// no lot column and issue nothing, which is a visible fault, not a silent one.
function renderQtyIssueRow(m, supIdx, matIdx, labelBadge) {
    var done = isFullyIssued(m);
    var defaultIssue = suggestedIssue(m);
    var disabled = maxIssuable(m) > 0 ? '' : 'disabled';

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
            (rowIssuable(m) ? 'checked' : '') + ' ' + disabled + ' ' +
            'aria-label="Issue ' + escapeHtml(m.material) + '" ' +
            'onchange="onIssueCheckboxChange(' + supIdx + ',' + matIdx + ')" />' +
            '<span class="issue-input-group">' +
            '<input type="number" step="0.01" min="0" max="' + issueCeiling(m) + '" ' +
            'class="issue-input" id="' + rowInputId(supIdx, matIdx) + '" ' + disabled + ' ' +
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
        // WHAT IS LEFT FOR THIS CARD, not the whole rack — the same figure the
        // ceiling is enforced at, so the column and the input agree. Showing the
        // rack total beside a box that will not accept it invites him to type
        // 100 over a row that can only take 40 and be refused.
        //
        // JUST THE NUMBER. A second line underneath naming the rack total
        // ("9,701 on the rack, rest spoken for") was tried and removed: the
        // fabric rows say nothing of the kind, so it made the trim rows look
        // like they were reporting a problem when they are reporting an
        // ordinary share, and it repeated a figure he can see on the shelf
        // anyway. One number per column, the same on every row.
        stockCells = '<td class="col-num">' + qty(stockForCard(m), m.unit) + '</td>';
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
// "TO BE ISSUED" CELL CONTENT — the SKU total fresh metres, then one green
// sub-line per waste pick carrying that remnant's size, aligned with the same
// pick's row in LOT / TOTAL STOCK / ISSUE NOW. Length × Width, the order used
// everywhere in these widgets; a piece with no size recorded falls back to its
// pcs count. A remnant is a specific piece he has to find, its size is how he
// identifies it, and green is the offcut colour used on every screen.
//
// EXTRACTED so every repaint path rebuilds it the SAME way — this used to live
// only inline in renderFabricRows, and the live-update paths (a waste pick's
// pcs box, a lot-line checkbox) only ever repainted the plain figure inside it,
// never the spacer count below. A live edit that changed how many rolls a lot
// spans left the spacers built at the last full render — correct then, stale
// the moment the roll count changed without a full repaint.
//
// `cols.freshLines` is the height lotLinesHtml's LOT/ROLL/TOTAL STOCK/ISSUE NOW
// columns actually take (see its own comment) — one spacer per line, not one
// per lot, or the first waste pick's size badge lands against the fresh
// section's last roll line instead of its own row.
function toIssueHtml(m, cols) {
    var done = isFullyIssued(m);
    var picks = wastePicks(m);
    var wantsFresh = done || needsFreshFabric(m);

    var toIssue = '';
    if (wantsFresh) {
        toIssue =
            '<span class="qty-big">' + fmt(m.remaining) +
            '<span class="unit">' + escapeHtml(m.unit) + '</span></span>';
    }
    if (!toIssue) {
        toIssue = '<span class="is-zero">&mdash;</span>';
    }
    if (!done && picks.length > 0) {
        // `tbi-head` FILLS THE FIRST LINE of the fresh-lot block itself — it is
        // not an extra line stacked in front of it, which is why the spacer
        // count is `freshLines - 1`, not `freshLines`. Using the full count
        // pushed every waste pick's badge one row too low, sitting against the
        // fresh section's LAST line instead of level with its own row — most
        // visible once a lot's roll count made that section more than one line
        // tall, but present even at one lot / one roll.
        var tbi = '<div class="tbi-head">' + toIssue + '</div>';
        var spacerCount = Math.max(0, (cols.freshLines || 0) - 1);
        for (var si = 0; si < spacerCount; si++) {
            tbi += '<div class="tbi-spacer"></div>';
        }
        picks.forEach(function (p) {
            var pw = Number(p.width) || 0;
            var pl = Number(p.length) || 0;
            var pn = Number(p.pieces) || 0;
            var sizeTxt = (pw > 0 && pl > 0)
                ? fmt(pl) + ' &times; ' + fmt(pw) + '<span class="unit">cm</span>'
                : pn + '<span class="unit">pcs</span>';
            tbi += '<div class="tbi-waste-size">&#9851; ' + sizeTxt + '</div>';
        });
        toIssue = tbi;
    }
    return toIssue;
}

// Every input keeps the id it had, so all the checkbox, validation and payload
// logic works untouched — only the markup around them moved.
function renderFabricRows(m, supIdx, matIdx) {
    var done = isFullyIssued(m);
    var picks = wastePicks(m);
    var wantsFresh = done || needsFreshFabric(m);

    // Fresh cloth has to come off a named lot. A row covered entirely by waste
    // needs none, so it gets no lot strip — there is no fresh fabric to source.
    var byLot = !done && wantsFresh;

    // Three stacked columns: LOT (roll · recommended), TOTAL STOCK (lot washed),
    // ISSUE NOW (editable box + checkbox). One sub-line per lot and per waste
    // pick, aligned across the three <td>s. Computed BEFORE "To be issued"
    // below, which needs `cols.freshLines` to size its own spacers to match.
    var cols = done
        ? { lot: '', roll: '', stock: '', issue: '', freshLines: 0 }
        : lotLinesHtml(m, supIdx, matIdx, true);

    var toIssue = toIssueHtml(m, cols);

    var issueCell;
    if (done) {
        issueCell = '<span class="issued-tag">&#10003; ' + fmt(m.issued) +
            '<span class="unit">' + escapeHtml(m.unit) + '</span></span>';
        if (m.wasteIssuedPieces > 0) {
            issueCell += ' <span class="issued-tag">&#10003; ' + fmt(m.wasteIssuedPieces) +
                '<span class="unit">pcs from waste</span></span>';
        }
    } else {
        issueCell = cols.issue || '<span class="is-zero issue-cell-empty">&mdash;</span>';
    }

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
        // LOT: which tone is leaving the shelf, and why it is short (if it is).
        '<td class="col-lot-issue">' +
        (done ? '' : cols.lot + lotShortHtml(m, supIdx, matIdx)) +
        '</td>' +
        // ROLL: which physical roll to cut, and how much off it.
        '<td class="col-roll">' + (done ? '' : cols.roll) + '</td>' +
        // TOTAL STOCK: that lot's washed metres on the rack.
        '<td class="col-num col-lot-stock">' + (done ? '' : cols.stock) + '</td>' +
        // ISSUE NOW: the editable box + checkbox per lot / per waste pick.
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

// ---- Default supervisor priority order ----
//
// THE ORDER STOCK IS RESERVED DOWN. The allocator walks supervisors in array
// order and spends the rack as it goes, so position is not decoration — the
// first card gets the cloth and the last is measured against what is left. This
// function decides the DEFAULT position; the store person can reorder on screen
// and everything re-runs.
//
// One supervisor usually holds one order source, but a manual reassignment can
// give him several, so the rank is worked out over ALL his open plans:
//
//   1. BEST source rank he holds anywhere. Any Shopify plan ranks him at
//      Shopify's level, whatever else he is carrying.
//   2. Tie -> MORE plans at that best rank wins. Two supervisors both on
//      Shopify: the one with three Shopify orders outranks the one with one.
//   3. Tie -> EARLIEST Plan_Start_Date among his plans at that rank. Whoever
//      has been waiting longest goes first.
//   4. Tie -> supervisor name, so the result is fully deterministic and two
//      loads of the same data never disagree.
//
// RANK, NOT THE RAW KEY. Priority_Key is `rank * 1000000 + plan sequence`
// (createProductionPlans), so two plans from one source have DIFFERENT keys —
// counting raw keys would make every plan its own level and rung 2 would always
// count 1. The rank is the top half.
//
// The sequence half carries plan age, so it is the fallback for rung 3 when a
// plan predates Plan_Start_Date and has no date to compare. Preferring the date
// keeps this readable and independent of the key's encoding staying stable.
//
// PURE. Takes the supervisor blocks, returns an array of supervisor ids. Reads
// nothing global, mutates nothing — so it is unit-testable and the caller
// decides whether to use it.
function priorityRankOf(key) {
    var k = Number(key);
    if (!isFinite(k) || k <= 0) return Infinity;   // unranked sorts last
    return Math.floor(k / 1000000);
}

function defaultPriorityOrder(data) {
    var stats = (data || []).map(function (sup, idx) {
        // Dedupe by plan: the same plan appears on a line of every material it
        // needs, and counting lines would rank a supervisor by how many
        // MATERIALS his orders use rather than how many ORDERS he has.
        var planSeen = {};
        (sup.materials || []).forEach(function (m) {
            (m.lines || []).forEach(function (ln) {
                var pid = String(ln.planId || '');
                if (!pid || planSeen[pid]) return;
                planSeen[pid] = {
                    rank: priorityRankOf(ln.priorityKey),
                    seq: (function () {
                        var k = Number(ln.priorityKey);
                        return (isFinite(k) && k > 0) ? (k % 1000000) : Infinity;
                    })(),
                    start: String(ln.planStartDate || '')
                };
            });
        });

        var plans = Object.keys(planSeen).map(function (p) { return planSeen[p]; });
        var bestRank = Infinity;
        plans.forEach(function (p) { if (p.rank < bestRank) bestRank = p.rank; });

        var atBest = plans.filter(function (p) { return p.rank === bestRank; });

        // Earliest start among the plans AT THE BEST RANK — not across all of
        // them. A supervisor's old Custom order must not pull his Shopify
        // ranking forward.
        var earliest = '';
        var earliestSeq = Infinity;
        atBest.forEach(function (p) {
            if (p.start && (earliest === '' || p.start < earliest)) earliest = p.start;
            if (p.seq < earliestSeq) earliestSeq = p.seq;
        });

        return {
            supervisorId: String(sup.supervisorId || ''),
            supervisorName: String(sup.supervisorName || ''),
            idx: idx,
            bestRank: bestRank,
            countAtBest: atBest.length,
            earliest: earliest,
            earliestSeq: earliestSeq
        };
    });

    stats.sort(function (a, b) {
        if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;   // 1
        if (a.countAtBest !== b.countAtBest) return b.countAtBest - a.countAtBest; // 2 (more wins)
        // 3 — earliest date first. A supervisor with no date on any of his
        // best-rank plans falls back to the key's sequence half.
        if (a.earliest && b.earliest && a.earliest !== b.earliest) {
            return a.earliest < b.earliest ? -1 : 1;
        }
        if (a.earliest && !b.earliest) return -1;
        if (!a.earliest && b.earliest) return 1;
        if (a.earliestSeq !== b.earliestSeq) return a.earliestSeq - b.earliestSeq;
        // 4 — deterministic last resort.
        return String(a.supervisorName).localeCompare(String(b.supervisorName));
    });

    return stats.map(function (s) { return s.supervisorId; });
}

// ---- The applied order, and the draft the arrows build ----
//
// TWO PIECES OF STATE, and keeping them apart is the whole design.
//
//   __priorityOrder  the order the numbers on screen were computed against.
//                    Only Apply writes it. null = "use the default".
//   __draftOrder     what the arrows are building. null = "no draft, the
//                    applied order is what you see".
//
// The arrows move cards on the page immediately — he has to see the sequence he
// is assembling — but every stock figure keeps the last applied allocation
// until he presses Apply. Re-allocating on each arrow click would recompute the
// whole screen three or four times while he is still deciding, and the numbers
// would flicker through orders he never chose.
//
// Neither is saved to Creator. The order is a plan for the next few minutes,
// not a fact about the rack: issueMaterials re-checks every lot server-side
// when Issue is actually pressed.
var __priorityOrder = null;
var __draftOrder = null;
// Set while Apply re-renders, so render() does not force the first card
// open mid-reorder. Fresh loads leave it false and keep the auto-open.
var __suppressFirstOpen = false;

// Sort `data` into the order the allocation should walk. Falls back to the
// server's own order for any supervisor the saved order does not name, so a
// card that appears after the order was set (a new plan mid-session) lands at
// the end rather than vanishing.
function orderByPriority(data) {
    var arr = (data || []).slice();
    var order = __priorityOrder || defaultPriorityOrder(arr);
    var rank = {};
    order.forEach(function (sid, i) { rank[String(sid)] = i; });
    return arr.sort(function (a, b) {
        var ra = rank[String(a.supervisorId)];
        var rb = rank[String(b.supervisorId)];
        if (ra === undefined && rb === undefined) return 0;
        if (ra === undefined) return 1;   // unknown -> the end
        if (rb === undefined) return -1;
        return ra - rb;
    });
}

// The sequence the cards are DRAWN in — the draft while one is being built,
// otherwise the applied order.
//
// SORTED FROM THE APPLIED ORDER, NEVER FROM `data`'s CURRENT ORDER. redrawCards
// writes the draft order back into __reqData (it has to — issue handlers index
// into it by card position), so by the time Cancel runs, __reqData is already
// the draft. Falling back to "leave it as it is" would make Cancel a no-op that
// silently kept the order it was meant to throw away. orderByPriority rebuilds
// from __priorityOrder, which Cancel never touched.
function displayOrder(data) {
    if (!__draftOrder) return orderByPriority(data);
    var rank = {};
    __draftOrder.forEach(function (sid, i) { rank[String(sid)] = i; });
    return (data || []).slice().sort(function (a, b) {
        var ra = rank[String(a.supervisorId)];
        var rb = rank[String(b.supervisorId)];
        if (ra === undefined && rb === undefined) return 0;
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
    });
}

function movePriority(supId, delta) {
    var cards = window.__reqData || [];
    // Work out the move BEFORE committing to a draft. A click that cannot move
    // anything — the top card's up-arrow, an id that is not on screen — must
    // leave no trace: seeding first would raise the Apply bar over an order
    // nobody changed, and "Apply" would then be offering to re-run the
    // allocation for nothing.
    var seq = __draftOrder ||
        cards.map(function (s) { return String(s.supervisorId); });
    var i = seq.indexOf(String(supId));
    var j = i + delta;
    if (i < 0 || j < 0 || j >= seq.length) return;

    if (!__draftOrder) __draftOrder = seq.slice();
    var tmp = __draftOrder[i];
    __draftOrder[i] = __draftOrder[j];
    __draftOrder[j] = tmp;
    // Redraw only — the numbers are NOT recomputed. render() would re-allocate,
    // which is exactly what Apply is for.
    redrawCards();
}

function applyPriorityOrder() {
    if (!__draftOrder) return;
    __priorityOrder = __draftOrder.slice();
    __draftOrder = null;
    // Keep whatever is open (during a reorder that is nothing) — do not
    // force the first card open the way a fresh load does.
    __suppressFirstOpen = true;
    render(window.__rawData || window.__reqData);
}

function cancelPriorityOrder() {
    if (!__draftOrder) return;
    __draftOrder = null;
    redrawCards();
}

// THE APPLY BAR — only while a draft is unapplied. Its absence is the signal
// that what is on screen and what the numbers mean are the same thing.
//
// It says the numbers are stale, because that is the one thing that is not
// obvious: the cards have visibly moved but every figure below them still
// belongs to the previous order.
function priorityBarHtml() {
    if (!__draftOrder) return '';
    return '' +
        '<div class="prio-bar">' +
        '<span class="prio-bar-msg">' +
        'Order changed &mdash; the figures below are still for the previous order.' +
        '</span>' +
        '<span class="prio-bar-actions">' +
        '<button type="button" class="ghost-btn" onclick="cancelPriorityOrder()">Cancel</button>' +
        '<button type="button" class="primary-btn" onclick="applyPriorityOrder()">' +
        'Apply order</button>' +
        '</span>' +
        '</div>';
}

// Repaint the card list in the draft order WITHOUT touching the allocation.
// Everything it draws comes from figures already computed by the last render.
//
// Deliberately opens NOTHING: an arrow click rebuilds the DOM, and forcing
// the first card open there yanks the screen away from the card he was
// reordering. He opens what he needs by hand.
function redrawCards() {
    var content = document.getElementById('dynamic-content');
    if (!content) return;
    var ordered = displayOrder(window.__reqData || []);
    // __reqData must follow the drawn order: every issue handler looks its
    // supervisor up by CARD INDEX, so a list drawn in one order and cached in
    // another would point each Issue button at the wrong man.
    window.__reqData = ordered;
    content.innerHTML = priorityBarHtml() +
        ordered.map(renderSupervisorCard).join('') +
        renderShortfallSummary(window.__rawData || ordered);
    ordered.forEach(function (_, idx) { refreshCardState(idx); });
}

// THE ONE TRUE "STILL SHORT" FIGURE FOR A FABRIC MATERIAL, in metres.
//
// Σ over every order that the allocator either SKIPPED or seated only PART of,
// of the marker-row metres for the pieces still owed — per cut size, because
// one order commonly spans several. This used to be computed twice, by two
// different routes that were not the same calculation:
//
//   the BUY figure   — this walk, over `e.orderOutcomes` (why + shortPieces).
//   the WASH top-up  — a second walk, over `e.lines`, of RAW
//                      `reqPieces - issPieces` with no reference to what the
//                      allocator had already committed to a lot.
//
// The second one double-counted. An order the allocator commits to a lot
// under `afterWash` (the atom rule: it covers the order WHOLE once that lot's
// greige is washed) is already spoken for — its pieces are not "still short",
// they are "short until this wash lands", and `washByLot` already carries
// exactly that commitment. Summing raw outstanding pieces on top of it asked
// the wash for MORE than the material actually needed: a lot could receive a
// legitimate 729.20 m committed-wash row from real orders AND a second,
// independent 14.57 m top-up computed from the same orders' raw pieces before
// wash-fill got involved — an order to wash something the committed pass had
// already accounted for, over cloth that was never short by that amount in
// the first place.
//
// So there is one function now, called once per material, and BOTH the wash
// top-up and the buy figure read its answer rather than each deriving their
// own.
function fabricShortMetres(e) {
    var fw = Number(e.fabricWidthCm) || 0;
    var perRowFab = function (cutW) {
        var cw = Number(cutW) || 0;
        return (fw > 0 && cw > 0 && fw >= cw) ? Math.floor(fw / cw) : 0;
    };

    // Cut length per plan — FALLBACK ONLY, for an outcome with no `cuts[]` (an
    // older cached payload from before the allocator started emitting per-cut
    // breakdowns). orderOutcomes carries pieces + planId; the cut geometry is
    // on the lines.
    var cutByPlan = {};
    (e.lines || []).forEach(function (l) {
        var pid = String(l.planId || '');
        if (!pid) return;
        var cw = Number(l.cutW) || 0, cl = Number(l.cutL) || 0;
        if (cw > 0 && cl > 0 && !cutByPlan[pid]) {
            cutByPlan[pid] = { cutW: cw, cutL: cl };
        }
    });

    var outcomes = e.orderOutcomes || [];
    var shortMetres = 0;
    outcomes.forEach(function (o) {
        var pid = String(o.planId || '');

        if (o.cuts && o.cuts.length) {
            o.cuts.forEach(function (c) {
                var owedHere = o.why === 'skipped'
                    ? (Number(c.pieces) || 0)
                    : (Number(c.shortPieces) || 0);
                if (owedHere <= 0) return;
                var pr = perRowFab(c.cutW);
                if (pr > 0) {
                    shortMetres += Math.ceil(owedHere / pr) * (Number(c.cutL) || 0) / 100;
                }
            });
            return;
        }

        // FALLBACK — no per-cut breakdown on this outcome.
        var owedPieces = 0;
        if (o.why === 'skipped') {
            owedPieces = Number(o.pieces) || 0;
        } else {
            owedPieces = Number(o.shortPieces) || 0;
        }
        if (owedPieces <= 0) return;
        var geo = cutByPlan[pid];
        if (geo) {
            var pr2 = perRowFab(geo.cutW);
            if (pr2 > 0) {
                shortMetres += Math.ceil(owedPieces / pr2) * geo.cutL / 100;
            } else if (Number(o.needMetres) > 0) {
                shortMetres += Number(o.needMetres);
            }
        } else if (Number(o.needMetres) > 0) {
            // No cut geometry for this plan — fall back to the allocator's own
            // metres figure for the order.
            shortMetres += Number(o.needMetres);
        }
    });
    return round2(shortMetres);
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
    // (material, supervisor card) -> seen, so each card's orderOutcomes array
    // is concatenated into byMat[key] exactly once even though the allocator
    // stamps the same array reference onto every row of that material within
    // one card (a Plan row and its Reissue row share it).
    var seenOutcomeCards = {};

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
            // NON-FABRIC keeps the old gate: its shortfall is `needed - owned`
            // in metres and a fully-issued row genuinely has nothing to add.
            //
            // FABRIC does NOT skip here. Its shortfall is derived below from the
            // allocator's per-order outcomes (demand vs what could be placed on a
            // lot), which are computed once at load over the WHOLE requirement
            // set and do not move as material is issued this session. Skipping a
            // fabric row the moment `m.remaining` hits 0 is exactly what made the
            // PO figure shrink every time something was handed over — the cloth
            // that could never complete an order stopped being counted as short.
            var isFab = !!m.isFabric;
            if (!isFab) {
                if (isFullyIssued(m)) return;
                var need = Number(m.remaining) || 0;
                if (need <= 0) return;
            }

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
                    // Arrived (billed/received) but not yet put into a lot —
                    // not cuttable, so it never closes a shortfall on its
                    // own. Shown so the row can say WHY buying more would be
                    // wrong when this is sitting right there.
                    unallocated: Number(m.unallocatedQty) || 0,
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
                    openExceptions: (m.openExceptions || []).slice(),
                    // FABRIC-ONLY, for the buy calc. `orderOutcomes` starts
                    // empty here and is filled below, ONCE PER CARD (not once
                    // per row, and not just the first card) — see the
                    // `seenOutcomeCards` guard just below this block.
                    orderOutcomes: [],
                    fabricWidthCm: Number(m.fabricWidthCm) || 0
                };
            }
            // allocateMaterial runs ONCE PER SUPERVISOR CARD, against a shared
            // draining ledger (lot-allocator.js allocateEveryCard) — so a
            // material demanded by several supervisors gets a SEPARATE
            // `orderOutcomes` array per card, each covering only that card's
            // own orders. Taking it from only the first card silently dropped
            // every other supervisor's stranded orders from the PO figure —
            // "Short by" read as though only one card's demand existed. The
            // allocator writes the SAME array reference onto every material
            // ROW within one card (a Plan row and its Reissue row share it),
            // so this is guarded per (material, card) — not per row — to
            // concat each card's outcomes exactly once.
            if (isFab) {
                var outcomeCardKey = key + '|' + String(sup.supervisorId);
                if (!seenOutcomeCards[outcomeCardKey]) {
                    seenOutcomeCards[outcomeCardKey] = true;
                    byMat[key].orderOutcomes =
                        byMat[key].orderOutcomes.concat(m.orderOutcomes || []);
                }
            }
            // `need` only exists for non-fabric (fabric skips the early gate).
            // Fabric's needed total is summed from its lines further down.
            if (!isFab) {
                byMat[key].needed = round2(byMat[key].needed + (Number(need) || 0));
            }

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

        var washedLots = {};
        // Per-lot: how much of THIS lot's ask above came from real committed
        // orders (washByLot), so the top-up below can ask for the REST of that
        // same lot's greige rather than skipping a lot it already touched.
        var committedByLot = {};
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
                    washedLots[String(w.lotId)] = true;
                    committedByLot[String(w.lotId)] = q;
                    toWash.push({ e: e, qty: q, kind: 'wash', lot: l });
                });

            // ---- GREIGE THE COMMITTED PASS DID NOT ASK FOR ----
            //
            // Two separate shapes land here, and both are real:
            //
            //   1. A lot no order could commit to at all. `washByLot` only
            //      carries lots an order was COMMITTED to, and an order is only
            //      committed to a lot that covers it WHOLE (the atom rule — see
            //      chooseLotForOrder). A lot holding 15 m of greige against a
            //      40 m demand is a candidate in NEITHER tier: the order is
            //      skipped, nothing is committed, `washByLot` stays empty, and
            //      this list offered no wash at all. The screen said "buy 40"
            //      over 15 m of the right shade sitting unwashed on the rack.
            //
            //   2. A lot the committed pass PARTLY asked for. A big new lot
            //      (743.77 m greige, one roll) can have some of its orders
            //      committed to it (729.20 m worth) while OTHER orders for the
            //      same material were seated elsewhere or skipped — the
            //      remaining 14.57 m of that same lot's greige is real,
            //      genuinely still needed, and was never asked for at all,
            //      because `washedLots` excluded the lot outright the moment
            //      ANY committed row touched it. Confirmed against a live
            //      case: 743.77 m booked in, first wash request asked for only
            //      729.20 m, and the missing 14.57 m never resurfaced as one
            //      figure — it trickled out as two more small requests (8.14,
            //      6.43) that still did not close it, because each of THOSE
            //      was itself sized off the material-wide remainder rather
            //      than off what this lot specifically still held.
            //
            // Both are "the atom rule working correctly on the ISSUE side" —
            // that cloth genuinely cannot finish an order alone. But "what is
            // missing" is a different question from "what can I hand over
            // today". Washing owned cloth is free of the atom rule: it
            // converts greige this shade into washed cloth this shade, it
            // shrinks the purchase, and it is an action he can take now,
            // whether or not any single order can use the whole lot yet.
            //
            // So every lot with greige LEFT AFTER ITS OWN COMMITTED ASK gets a
            // row, capped at what the lot still holds AND at what the
            // MATERIAL is still short overall — never more than the job
            // needs, and never a second time for greige already offered.
            //
            // THE MATERIAL-WIDE FIGURE IS `fabricShortMetres(e)`, THE SAME ONE
            // THE BUY ROW USES — not a second, independent count of raw
            // outstanding pieces. That second count was the actual bug: it
            // summed every order's raw `reqPieces - issPieces` with no
            // reference to what the committed-wash pass had already resolved,
            // so a lot could receive a legitimate 729.20 m committed row AND
            // an unrelated top-up computed as if none of those orders had a
            // lot yet — asking to wash cloth that had already been accounted
            // for once, while the genuine 14.57 m remainder on that same lot
            // went unmentioned because the lot was already in `washedLots`.
            //
            // Committed rows are subtracted from the material figure before
            // the lot walk starts, so the two halves add up to one number
            // instead of two that can each be short or long on their own.
            var stillShort = fabricShortMetres(e);
            Object.keys(committedByLot).forEach(function (lotId) {
                stillShort = round2(stillShort - committedByLot[lotId]);
            });
            if (stillShort < 0) stillShort = 0;

            if (stillShort > 0) {
                (e.lots || [])
                    .filter(function (l) {
                        var already = committedByLot[String(l.lotId)] || 0;
                        var left = round2((Number(l.unwash) || 0) - already);
                        return !l.blocked && l.form !== 'Pieces' && left > 0;
                    })
                    .sort(function (a, b) {
                        var aLeft = round2((Number(a.unwash) || 0) - (committedByLot[String(a.lotId)] || 0));
                        var bLeft = round2((Number(b.unwash) || 0) - (committedByLot[String(b.lotId)] || 0));
                        return bLeft - aLeft;
                    })
                    .forEach(function (l) {
                        if (stillShort <= 0.0001) return;
                        var already = committedByLot[String(l.lotId)] || 0;
                        var left = round2((Number(l.unwash) || 0) - already);
                        if (left <= 0) return;
                        var q = round2(Math.min(left, stillShort));
                        if (q <= 0) return;
                        stillShort = round2(stillShort - q);
                        // The row's own greige figure is what is LEFT on the
                        // lot, not the lot's raw total — a lot already
                        // carrying a committed row must not show its whole
                        // pile as available a second time in the dialog's
                        // "this lot only has N unwashed" math.
                        var lotForRow = already > 0
                            ? Object.assign({}, l, { unwash: left })
                            : l;
                        toWash.push({ e: e, qty: q, kind: 'wash', lot: lotForRow,
                                      // No ORDER is waiting on this specific
                                      // slice — washing it is an offer, not a
                                      // job already committed to. The dialog
                                      // says so. (A lot can appear once here
                                      // AND once above, as two rows: one
                                      // committed, one uncommitted top-up on
                                      // the same physical lot.)
                                      uncommitted: true });
                    });
            }
        }

        // ---- BUY ----
        //
        // poCovered — cloth already on a raised draft PO — counts as owned. Once
        // a PO is raised for the gap, the material leaves this list and its
        // Raise PO button disappears; if demand later outgrows the PO before the
        // goods land, the residual gap re-appears here on its own. A PO raised in
        // THIS session (openExceptions got a local Shortage entry that covers
        // every plan) also drops the row immediately, before poCovered comes
        // back on the next load.
        var poRaisedThisSession = requestState(e, 'buy', '') === 'open';

        if (e.isFabric) {
            // FABRIC: a PO is raised ONLY for what the ALLOCATOR itself could
            // not seat. Not a metres balance — a metres balance over a printed
            // (Pieces-form) lot is meaningless (five 3 m pieces are not 15 m of
            // cuttable cloth), and that is exactly what raised a false 1.05 m
            // "short" over a rack holding 641 m.
            //
            // `orderOutcomes` is the allocator's per-order verdict, computed
            // once at load over the WHOLE requirement set. Per order:
            //   why 'ready' / 'pinned'  + shortPieces 0  -> fully covered, no PO
            //   why 'afterWash'         + shortPieces 0  -> a wash, not a PO
            //   why 'skipped'                            -> no lot at all
            //   shortPieces > 0 (any why)                -> lot took it, still
            //                                               short by that many
            //
            // So the PO gap is: Σ over orders that were skipped OR left short,
            // of the metres for the pieces still owed — rounded up to whole
            // marker row-sets so the cloth ordered yields complete sets.
            //
            // Issue-invariant: an order handed over leaves `orderOutcomes`
            // covered (its requirement pieces are issued, the allocator seats
            // the rest), so the gap does not move as material goes out.
            //
            // Shared with the wash top-up above — fabricShortMetres(e) — so
            // the two can never derive two different "still short" answers
            // for the same material again. See its own header for why that
            // used to happen.
            var outcomes = e.orderOutcomes || [];
            var shortMetres = fabricShortMetres(e);

            // USABLE STOCK — what the allocator actually could and did place
            // against today's orders, in metres. `o.metres` is only nonzero
            // when an order was seated `ready` (lot-allocator.js outcomes
            // push), so summing it across every order gives the cloth that is
            // genuinely consumable right now — never raw "In stock", which
            // also counts cloth stranded across rolls too short for a marker
            // row, greige waiting on a wash, or metres locked to another
            // pinned order's lot. This is the number that closes
            // grossDemand - usableMetres = shortMetres (modulo the same
            // piece-rounding shortMetres itself already applies), so the
            // store person can see WHY "in stock" does not simply subtract.
            var usableMetres = 0;
            outcomes.forEach(function (o) {
                usableMetres += Number(o.metres) || 0;
            });
            e.usableMetres = round2(usableMetres);

            // TOTAL DEMAND ACROSS EVERY SUPERVISOR, in metres — what the "Short
            // by" figure otherwise leaves the store person to take on faith.
            // "Needed 1,308 / In stock 3,000 / Short 1,308" reads as a
            // contradiction without this: the 3,000 is real, but it is the
            // WHOLE fabric's stock shared across every open plan on every
            // supervisor's card, and shortMetres already nets that sharing out
            // via the allocator's own reservation walk. Summing Σ(required -
            // issued) straight off e.lines (every supervisor's rows, already
            // merged) gives the plain total the allocator started from, so the
            // three numbers can be read as one sentence: demanded − in stock
            // (+ already on order) = short.
            var grossDemand = 0;
            (e.lines || []).forEach(function (l) {
                var lineOwed = (Number(l.required) || 0) - (Number(l.issued) || 0);
                if (lineOwed > 0) grossDemand += lineOwed;
            });
            e.grossDemand = round2(grossDemand);

            // e.needed drives the dialog's "Still needed" line and the raise
            // payload. For fabric it is the metres the PO has to cover.
            e.needed = shortMetres;

            var buyQty = round2(shortMetres - (Number(e.poCovered) || 0));

            if (buyQty > 0.0001 && !poRaisedThisSession) {
                toBuy.push({ e: e, qty: buyQty, kind: 'buy' });
            }
            return;
        }

        // ---- NON-FABRIC BUY: cloth that does not exist in ANY state ----
        //
        // Washed, greige and at-the-wash-house all count as owned. (Fabric took
        // the branch above; a trim has no lots and no marker rows, so the raw
        // metres balance is the whole answer.)
        var owned = round2((Number(e.stock) || 0) +
            (Number(e.unwashed) || 0) +
            (Number(e.inWash) || 0) +
            (Number(e.poCovered) || 0));
        // Already the plain gross total (never overwritten for non-fabric) —
        // stamped as the same field name the fabric branch uses, so the render
        // side asks one question regardless of material type.
        e.grossDemand = e.needed;
        var trimBuyQty = round2(e.needed - owned);
        if (trimBuyQty > 0 && !poRaisedThisSession) {
            toBuy.push({ e: e, qty: trimBuyQty, kind: 'buy' });
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
        // BUY rows show the TRUE GROSS DEMAND (every supervisor's Σ required -
        // issued), not e.needed — for fabric e.needed is the allocator's own
        // short-metres figure (what could not be seated), which is smaller
        // than gross demand whenever the shortfall isn't a straight metres
        // balance (piece-rounding, wash gate). Showing the short-metres number
        // next to "In stock" made the row read as an arithmetic contradiction:
        // "Needed 1,308 / In stock 3,000 / Short 1,308" looks impossible until
        // you know 1,308 was never gross demand. Gross − in stock (+ on order)
        // = short is the sentence this column exists to complete. Wash rows
        // keep e.needed — there the "Needed" heading means the wash-specific
        // ask, not the whole material.
        '<td class="col-num">' +
        qty(kind === 'buy' ? (Number(e.grossDemand) || 0) : e.needed, e.unit, { keepZero: true }) +
        '</td>' +
        // WASHED AND UNWASHED ARE THE LOT'S, not the material's, on any row
        // that names a lot. A ticket capped at what L2 holds beside a greige
        // figure totalling every lot of the SKU is the same "two figures on
        // one row" fault the issue screen had: 706.09 unwashed next to
        // "wash 50, all it has" reads as an arithmetic error.
        '<td class="col-num">' +
        qty((kind === 'wash' && entry.lot) ? (Number(entry.lot.wash) || 0) : e.stock, e.unit) +
        // "In stock" is the raw rack total — real, but not all of it is
        // CUTTABLE today. A roll shorter than the marker it would need,
        // greige waiting on a wash, or metres already locked to another
        // pinned order's lot all count toward "in stock" while contributing
        // nothing to what can actually be issued. Without this note, gross
        // demand minus in-stock looked smaller than "Short by" and read as a
        // second arithmetic fault on top of the first one this row already
        // had to explain.
        (kind === 'buy' && e.isFabric && round2((Number(e.usableMetres) || 0)) + 0.0001 < round2(Number(e.stock) || 0)
            ? '<div class="sum-lot-note">' + fmt(e.usableMetres) + ' usable</div>'
            : '') +
        // Completes the sentence when a PO is already out for part of the
        // gap: gross demand minus in-stock alone would not match "Short by"
        // without also showing what a draft PO already accounts for.
        (kind === 'buy' && (Number(e.poCovered) || 0) > 0
            ? '<div class="sum-inwash">+' + fmt(e.poCovered) + ' on order</div>'
            : '') +
        // Cloth has arrived but is sitting in Unallocated_Qty — not in a lot,
        // so it cannot be cut and does not close this gap. Without this the
        // store person sees stock rise after a bill and cannot tell why the
        // shortfall did not move.
        (kind === 'buy' && e.isFabric && (Number(e.unallocated) || 0) > 0.0001
            ? '<div class="sum-lot-short">' + fmt(e.unallocated) + ' unallocated — allocate to a lot first</div>'
            : '') +
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
            // A PO WAS RAISED, THE BILL LANDED, AND WASHING THIS LOT STILL WILL
            // NOT CLOSE THE GAP — because the bought cloth is not on this lot at
            // all. syncPurchaseInflow deliberately credits an arrived bill to
            // Unallocated_Qty, never straight into a lot: which lot a roll
            // belongs to is a tone decision only a person can make, so the sync
            // cannot guess it. The buy row said so while the row was still on
            // the purchase list, but the moment the PO resolves and the row
            // drops to wash-only, that note had nowhere to render — a wash row
            // never looked at `e.unallocated` at all. Without it, the sequence
            // "raise PO, bill lands, wash the lot, still short" repeats with
            // nothing on screen explaining that a step was skipped.
            (e.isFabric && (Number(e.unallocated) || 0) > 0.0001
                ? '<div class="sum-lot-short">' + fmt(e.unallocated) +
                ' from your last PO is unallocated &mdash; put it into a lot ' +
                'first, or washing will not close this</div>'
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
        '<th class="col-lot-issue">Lot</th>' +
        '<th class="col-roll">Roll</th>' +
        '<th class="col-num col-lot-stock">Total wash stock</th>';

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

    // REORDER ARROWS. They sit ON the priority tag because that is the thing
    // they change. stopPropagation on both: the header's own onclick expands
    // the card, and moving a supervisor must not also open his materials.
    //
    // Disabled at the ends rather than hidden, so the control does not move
    // around under the cursor as cards are shuffled.
    var supIdJs = "'" + String(sup.supervisorId).replace(/'/g, "\\'") + "'";
    var prioArrows = supTotal > 1
        ? '<span class="prio-move">' +
            '<button type="button" class="prio-arrow" title="Serve earlier"' +
              (idx === 0 ? ' disabled' : '') +
              ' onclick="event.stopPropagation();movePriority(' + supIdJs + ',-1)">&#9650;</button>' +
            '<button type="button" class="prio-arrow" title="Serve later"' +
              (idx === supTotal - 1 ? ' disabled' : '') +
              ' onclick="event.stopPropagation();movePriority(' + supIdJs + ',1)">&#9660;</button>' +
          '</span>'
        : '';

    return '' +
        '<div class="item-card" id="sup-card-' + idx + '">' +
        '<div class="item-header" onclick="toggleSupervisor(' + idx + ')">' +
        '<div class="item-title-row">' +
        '<span class="item-serial">' + (idx + 1) + '</span>' +
        '<div class="item-header-info">' +
        '<h2>' + escapeHtml(sup.supervisorName) + '</h2>' +
        '<div class="item-meta-line">' +
        '<span class="' + prioClass + '">' + prioText + '</span>' +
        prioArrows +
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
    // PRIORITY ORDER DECIDES WHO IS SERVED FIRST, and it does that by deciding
    // array order — applyLotAllocation walks `data` in order, spending shared
    // ledgers, so position IS the reservation.
    //
    // The order is session state, not a server field: default computed from
    // Priority_Key, overridden by whatever the store person last applied. It
    // survives a Refresh (loadRequirements re-fetches stock but never touches
    // __priorityOrder) and resets on a page reload, which is the honest
    // lifetime for a plan nobody has written down.
    //
    // Sorted BEFORE __rawData is cached, so every later re-render (a lot
    // override, a declined remnant) re-runs the allocation over the same order
    // rather than silently falling back to the server's.
    data = orderByPriority(data);
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
    //
    // Fed the FULL list (every supervisor, including the fully-issued ones), not
    // `actionable`. The shortfall is a property of total demand vs stock, and a
    // supervisor whose issuing is done is still demand that was met from the
    // same shelf — dropping his card from the input made the fabric shortfall
    // shrink every time a card cleared. buildShortfallSummary keeps the
    // non-fabric fully-issued skip internally; fabric it needs to see.
    content.innerHTML = priorityBarHtml() +
        actionable.map(renderSupervisorCard).join('') +
        renderShortfallSummary(data);

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

    // Fresh loads auto-open the first card. Apply sets
    // __suppressFirstOpen first, so a reorder keeps whatever is open
    // (nothing, mid-reorder) instead of yanking the first card open.
    if (__suppressFirstOpen) {
        __suppressFirstOpen = false;
    } else {
        var firstCard = document.getElementById('sup-card-0');
        if (firstCard) firstCard.classList.add('open');
    }
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
// `picks` is the array of { wasteId, pieces, planItemId, mrqId } gathered from
// the ticked waste checkboxes.
//
// KEYED BY mrqId, NOT planItemId. One Plan_Item can have TWO Material_Requirement
// rows for this fabric — a body panel and a facing off the same cloth, two cut
// sizes, one item id. Keying the payload by planItemId merged the two rows into
// one allocation: the second mrqId was never sent, its requirement stayed open
// for ever, and the first row was over-credited with both cuts' metres. So every
// per-row map below is keyed on the requirement row.
function buildFabricIssueLine(m, picks) {
    var src = m.isReissue === true ? 'Reissue' : 'Plan';

    var lotLines = (m.lotLines || []).filter(function (ln) {
        return (Number(ln.qty) || 0) > 0;
    });

    // The mrqId of a lot line, from the line itself, or resolved from m.lines by
    // (planItemId, cut) for an older allocator run that did not stamp it.
    var lineMrq = function (ln) {
        if (ln.mrqId) return String(ln.mrqId);
        var hit = (m.lines || []).filter(function (x) {
            return String(x.planItemId || '') === String(ln.planItemId || '') &&
                   (Number(x.cutW) || 0) === (Number(ln.cutW) || 0) &&
                   (Number(x.cutL) || 0) === (Number(ln.cutL) || 0);
        })[0];
        return hit ? String(hit.mrqId || '') : '';
    };

    // mrqId -> the item it belongs to, its plan, how many cut pieces it still
    // owes, and its cut size — from the server's per-row lines.
    var itemByMrq = {};
    var planByMrq = {};
    var owedByMrq = {};
    var cutByMrq = {};
    (m.lines || []).forEach(function (ln) {
        var q = String(ln.mrqId || '');
        if (q && owedByMrq[q] === undefined) {
            itemByMrq[q] = String(ln.planItemId || '');
            planByMrq[q] = ln.planId;
            owedByMrq[q] = Math.max(0, (Number(ln.reqPieces) || 0) - (Number(ln.issPieces) || 0));
            cutByMrq[q] = { w: Number(ln.cutW) || 0, l: Number(ln.cutL) || 0 };
        }
    });

    // ---- lotMoves: m.lotLines grouped by lot ----
    // rolls[] is WHICH PHYSICAL ROLLS this lot's cut came off and how many
    // metres off each, summed the same way qty is — several lotLines entries
    // can share a roll (a roll draining across two orders on this card), and
    // the true total off that roll is their SUM, never the largest single line.
    // issueMaterialsApply reads this to decrement Lot_Rolls.Roll_Length; without
    // it the server has only the lot-level total and no roll to charge it to.
    //
    // ROLLSSHARED IS THE SAME EXCEPTION rollLinesFor (above, the display
    // reader) already carries a guard for: applyFabricOverride stamps EVERY
    // line of an edited lot with the SAME rolls[] array, byte for byte
    // (ln.rollsShared = true — see its own comment in lot-allocator.js).
    // Those lines are not independent draws to sum, they are one draw written
    // out several times — summing them here would charge Lot_Rolls that many
    // times over for one edit. Take the first such line's array once per lot,
    // skip the rest, exactly as the display does.
    //
    // ASSUMES ALL-OR-NOTHING PER LOT: every lotLines row of a given lot is
    // EITHER rollsShared or none of them are — applyFabricOverride stamps the
    // WHOLE lot uniformly when it edits it (lot-allocator.js's own comment:
    // "every line of THIS LOT"), and no other writer sets the flag. A mixed
    // lot (some rows shared, some not) is not reachable via the current
    // allocator, and the "first line wins" guard below is order-dependent if
    // it ever were — the first-seen shared line's array would be taken as the
    // lot's answer even if an earlier non-shared line had already contributed
    // its own (correct, per-row) rolls into the same bucket.
    var moveByLot = {};
    var moveOrder = [];
    lotLines.forEach(function (ln) {
        var k = String(ln.lotId);
        if (!moveByLot[k]) {
            moveByLot[k] = { lotId: ln.lotId, qty: 0, isPieces: false, pieces: [], rolls: [], rollsSharedSeen: false };
            moveOrder.push(k);
        }
        var bucket = moveByLot[k];
        bucket.qty = round2(bucket.qty + (Number(ln.qty) || 0));
        (ln.pieces || []).forEach(function (p) {
            bucket.isPieces = true;
            bucket.pieces.push({
                pieceId: p.pieceId,
                count: Number(p.count) || 0,
                cutLengthCm: Number(p.cutLengthCm) || 0
            });
        });
        if (ln.rollsShared) {
            if (bucket.rollsSharedSeen) return;   // already have the lot's one true copy
            bucket.rollsSharedSeen = true;
        }
        var rollById = {};
        bucket.rolls.forEach(function (r) { rollById[String(r.rollId)] = r; });
        (ln.rolls || []).forEach(function (rl) {
            var rid = String(rl.rollId);
            var mtr = round2(Number(rl.metres) || 0);
            if (rollById[rid]) {
                rollById[rid].metres = round2(rollById[rid].metres + mtr);
            } else {
                var r = { rollId: rid, label: String(rl.label || ''), metres: mtr };
                rollById[rid] = r;
                bucket.rolls.push(r);
            }
        });
    });
    var lotMoves = moveOrder.map(function (k) {
        var bucket = moveByLot[k];
        delete bucket.rollsSharedSeen;
        return bucket;
    });

    // ---- allocations: one per REQUIREMENT ROW the allocator served ----
    // giveQty / giveRaw / giveWaste come STRAIGHT off the allocator's lotLines
    // (fromRaw / fromWaste added in spend()) — never recomputed here. A demand
    // covered entirely by offcuts has no lotLine, so its waste credit is
    // recovered from the physical picks instead.
    //
    // rollsByMrq carries the SAME per-roll breakdown lotMoves does, but keyed to
    // this requirement row rather than the whole lot — issueMaterialsHandover
    // stamps Issue_Lines.Roll_Label from it. Summed across every lotLine this
    // mrq drew from, same reasoning as lotMoves: a roll can serve two lines.
    //
    // EXCEPT ON A ROLLSSHARED LOT (applyFabricOverride, the hand-edit path).
    // There, EVERY line of the lot carries the SAME full-lot rolls[] array —
    // it is one draw written out several times, not each row's own share (see
    // the comment on `ln.rollsShared` in lot-allocator.js). Attributing that
    // whole-lot array to a single mrqId would claim every row cut the lot's
    // entire draw, and the handover merge below would then sum it again across
    // every allocation of the lot — a compounding double-count on top of a
    // wrong attribution. So a rollsShared row gets NO per-mrq roll list; the
    // handover merge falls back to the lot-level answer (lotMoves, already
    // deduped above) for those lines instead.
    //
    // sharedLotByMrq[q] IS OVERWRITTEN, NOT FIRST-WINS, unlike lotByMrq[q]
    // beside it — relies on the one-order-one-lot atom rule (see
    // lot-rolls-model.md) holding for a SINGLE mrq: applyFabricOverride edits
    // one lot's box at a time, so a shared line for one mrqId cannot name two
    // different lots in practice. If that rule is ever relaxed, the handover
    // merge below would resolve the label from whichever lot this overwrites
    // to last, not necessarily the lot the line's OWN qty/lot key point at —
    // label-only (the server-side decrement stays correct, keyed per lot in
    // lotMoves independently of this), but worth re-checking here first.
    var qtyByMrq = {};
    var rawByMrq = {};
    var wasteByMrq = {};
    var lotByMrq = {};
    var rollsByMrq = {};
    var sharedLotByMrq = {};
    var mrqOrder = [];
    var seenMrq = {};
    lotLines.forEach(function (ln) {
        var q = lineMrq(ln);
        if (!q) return;
        if (!seenMrq[q]) {
            seenMrq[q] = true; mrqOrder.push(q);
            qtyByMrq[q] = 0; rawByMrq[q] = 0; wasteByMrq[q] = 0; rollsByMrq[q] = [];
        }
        qtyByMrq[q] = round2(qtyByMrq[q] + (Number(ln.qty) || 0));
        rawByMrq[q] += Number(ln.fromRaw) || 0;
        wasteByMrq[q] += Number(ln.fromWaste) || 0;
        if (!lotByMrq[q]) lotByMrq[q] = ln.lotId;
        if (ln.rollsShared) {
            sharedLotByMrq[q] = String(ln.lotId);
            return;   // no per-row attribution — see the note above
        }
        var rollById2 = {};
        rollsByMrq[q].forEach(function (r) { rollById2[String(r.rollId)] = r; });
        (ln.rolls || []).forEach(function (rl) {
            var rid = String(rl.rollId);
            var mtr = round2(Number(rl.metres) || 0);
            if (rollById2[rid]) {
                rollById2[rid].metres = round2(rollById2[rid].metres + mtr);
            } else {
                var r2 = { rollId: rid, label: String(rl.label || ''), metres: mtr };
                rollById2[rid] = r2;
                rollsByMrq[q].push(r2);
            }
        });
    });

    // ---- wastePicks payload, and the offcut-only credit fallback ----
    // Total remnant yield per requirement row from the ticked picks. Used ONLY
    // for a row with no lotLine at all (offcut-complete) — otherwise the
    // allocator's per-line fromWaste above is authoritative.
    var wasteYieldByMrq = {};
    var lotByWasteMrq = {};
    var wastePicksOut = [];
    picks.forEach(function (pk) {
        var src2 = (m.wastePicks || []).filter(function (x) {
            return String(x.wasteId) === String(pk.wasteId) &&
                   (pk.mrqId ? String(x.mrqId || '') === String(pk.mrqId) : true);
        })[0] || (m.wastePicks || []).filter(function (x) {
            return String(x.wasteId) === String(pk.wasteId);
        })[0] || {};
        var w = Number(src2.width) || 0;
        var l = Number(src2.length) || 0;
        var q = String(pk.mrqId || src2.mrqId || '');
        var it = itemByMrq[q] || String(pk.planItemId || src2.planItemId || '');
        // Yield is against THIS requirement row's cut. Prefer the cut recorded on
        // the pick / the row's line; fall back to the pick's own dims.
        var ic = cutByMrq[q] ||
                 (src2.cutW ? { w: Number(src2.cutW) || 0, l: Number(src2.cutL) || 0 } : { w: 0, l: 0 });
        var yieldPer = (ic.w > 0 && ic.l > 0)
            ? remnantYield({ width: w, length: l }, ic.w, ic.l)
            : 0;
        wasteYieldByMrq[q] = (wasteYieldByMrq[q] || 0) + pk.pieces * yieldPer;
        // The lot this remnant was cut from — the allocator stamps it on the pick
        // and the ticked box carries it here.
        var pkLot = String(pk.lotId || src2.lotId || '');
        if (pkLot && !lotByWasteMrq[q]) lotByWasteMrq[q] = pkLot;
        wastePicksOut.push({
            wasteId: pk.wasteId,
            pieces: pk.pieces,
            planId: planByMrq[q] || '',
            planItemId: it,
            yieldPer: yieldPer,
            pieceWidth: w,
            pieceLength: l,
            // This pick's target-row cut, so issueMaterials stamps the
            // Waste_Movement's Cut_Size_* correctly — there is no single cut on
            // the SKU wrapper any more.
            cutW: ic.w || 0,
            cutL: ic.l || 0
        });
    });
    Object.keys(wasteYieldByMrq).forEach(function (q) {
        if (q === '') return;
        if (!seenMrq[q]) {
            // Offcut-complete: no fresh cloth, no lotLine. Credit from the picks.
            seenMrq[q] = true; mrqOrder.push(q);
            qtyByMrq[q] = 0; rawByMrq[q] = 0;
            wasteByMrq[q] = wasteYieldByMrq[q];
        }
        // AND THE PIN COMES OFF THE REMNANT WHEN NOTHING ELSE CARRIES IT.
        //
        // `lotByMrq` is built from the lot lines, and a row served entirely by
        // offcuts has none — so `issuedLot` went out empty on the one path where
        // a real tone decision had just been made and written down nowhere.
        // Only ever FILLS a gap: a row with fresh cloth on it keeps the lot its
        // metres came off, which is the same lot anyway.
        if (!lotByMrq[q] && lotByWasteMrq[q]) lotByMrq[q] = lotByWasteMrq[q];
    });

    var allocations = mrqOrder.filter(function (q) {
        return q !== '' && owedByMrq[q] !== undefined;
    }).map(function (q) {
        var owed = owedByMrq[q] === undefined ? Infinity : owedByMrq[q];
        var raw = rawByMrq[q] || 0;
        var wst = wasteByMrq[q] || 0;
        // Never credit more pieces than the row still owes — the allocator caps
        // at this too. Waste first (scarcer, already paid for), then fresh.
        if (wst > owed) { wst = owed; }
        if (raw > owed - wst) { raw = Math.max(0, owed - wst); }
        // The per-row roll picture as a READY-BUILT STRING, exactly the shape
        // issueMaterialsHandover already gets in its `rollLabel` field:
        // "R1" for one roll, "R1 5m, R2 1.05m" for several. issueMaterialsApply
        // reads THIS to stamp Material_Requirement.Roll_Label - it must not
        // parse the `rolls` array itself, because .toString() on a nested
        // Deluge list-of-maps is not valid JSON and .toJSONList() then yields
        // nothing (which is why Roll_Label was silently never written). `rolls`
        // stays for the fan's per-roll decrement, which needs the metres.
        var rrList = rollsByMrq[q] || [];
        var rollLabelStr = '';
        if (rrList.length === 1) {
            rollLabelStr = String(rrList[0].label || '');
        } else if (rrList.length > 1) {
            rollLabelStr = rrList.map(function (rl) {
                return String(rl.label || '') + ' ' + round2(Number(rl.metres) || 0) + 'm';
            }).join(', ');
        }
        return {
            mrqId: q,
            planId: planByMrq[q] || '',
            planItemId: itemByMrq[q] || '',
            giveQty: round2(qtyByMrq[q] || 0),
            giveRaw: raw,
            giveWaste: wst,
            issuedLot: String(lotByMrq[q] || ''),
            // Which physical roll(s) this row's fresh cloth came off — empty
            // for a row served entirely by offcuts, and ALSO empty on a
            // rollsShared (hand-edited) lot, where no row-level share exists
            // to report. issueMaterialsHandover reads `rollLabel` (the string)
            // to stamp Issue_Lines.Roll_Label; sharedLot tells
            // buildHandoverSummary to fall back to the lot-level answer instead
            // of this row's (empty) one for those lines.
            rolls: rrList,
            rollLabel: rollLabelStr,
            sharedLot: sharedLotByMrq[q] || ''
        };
    });

    // ---- issueLines: one per allocation, PRINTED_PIECE expanded per piece ----
    // Cut_Size_* per line comes from the matching lot line's own cut (matched by
    // mrqId — a Plan_Item at two cut sizes has two lot lines), falling back to
    // the requirement row's line cut, then to zero.
    var issueLinesOut = [];
    allocations.forEach(function (a) {
        var ln = lotLines.filter(function (x) {
            return lineMrq(x) === a.mrqId;
        })[0] || {};
        var ic = cutByMrq[a.mrqId] || { w: 0, l: 0 };
        var lnW = Number(ln.cutW) || ic.w || 0;
        var lnL = Number(ln.cutL) || ic.l || 0;
        if (ln.pieces && ln.pieces.length && ln.cutSummary) {
            var baseNote = ln.note ? ln.note + ' | ' : '';
            ln.pieces.forEach(function (p) {
                issueLinesOut.push({
                    mrqId: a.mrqId, planItemId: a.planItemId, lotId: a.issuedLot,
                    qty: round2(((Number(p.cutLengthCm) || 0) * (Number(p.count) || 0)) / 100),
                    unit: m.unit, cutW: lnW, cutL: lnL,
                    note: baseNote + 'PRINTED_PIECE | ' + ln.cutSummary,
                    overrideFrom: ln.overrideFrom || ''
                });
            });
        } else {
            issueLinesOut.push({
                mrqId: a.mrqId, planItemId: a.planItemId, lotId: a.issuedLot,
                qty: a.giveQty, unit: m.unit, cutW: lnW, cutL: lnL,
                note: ln.note || '', overrideFrom: ln.overrideFrom || ''
            });
        }
    });

    return {
        materialId: m.materialId,
        source: src,
        isFabric: true,
        // NO SINGLE CUT ON THE WRAPPER — a SKU row spans many. issueMaterials
        // reads cutWidth/cutLength only as a fallback for an issue line that
        // omits its own, and every line above carries one, so 0 here is safe.
        cutWidth: 0,
        cutLength: 0,
        allocations: allocations,
        lotMoves: lotMoves,
        wastePicks: wastePicksOut,
        issueLines: issueLinesOut
    };
}

// BUILD THE HANDOVER SUMMARY from the SAME issues[] the apply chunks are built
// from — so the two can never drift. One Material_Issue is written per press
// (issueMaterialsHandover), its Issue_Lines at MATERIAL × LOT grain, except
// PRINTED_PIECE lines which stay per physical piece so the supervisor confirms
// each one.
//
// THE INVARIANT this guarantees, per material:
//   Σ handover line Qty            === Σ allocations.giveQty
//   Σ handover line piecesFromRaw  === Σ allocations.giveRaw
//   Σ handover line piecesFromWaste=== Σ allocations.giveWaste
// It holds because both sides are summed from the SAME allocations array here,
// adding the already-rounded giveQty values with no re-rounding.
//
// Returns { planCount, lines: [ { materialId, lot, qty, piecesFromRaw,
//   piecesFromWaste, unit, cutW, cutL, printed } ] }.
//   lot ""  — a trim, or an offcut-only material (giveWaste>0, no lot). Still
//             gets a row so the receipt screen can confirm the pieces.
//   printed true — do not merge with anything; keyed per physical piece.
function buildHandoverSummary(issues) {
    var byKey = {};
    var order = [];
    var planSet = {};

    (issues || []).forEach(function (line) {
        var matId = String(line.materialId || '');
        var unit = line.unit || '';
        // Match a printed-piece issueLine to its allocation by mrqId so its
        // per-piece Qty (metres equivalent) is used, not the allocation's total.
        var printedLines = (line.issueLines || []).filter(function (il) {
            return (il.note || '').indexOf('PRINTED_PIECE') !== -1;
        });
        var printedByMrq = {};
        printedLines.forEach(function (il) {
            var q = String(il.mrqId || '');
            (printedByMrq[q] = printedByMrq[q] || []).push(il);
        });

        (line.allocations || []).forEach(function (a) {
            var mrq = String(a.mrqId || '');
            var lot = String(a.issuedLot || '');
            var giveQty = Number(a.giveQty) || 0;
            var giveRaw = Number(a.giveRaw) || 0;
            var giveWaste = Number(a.giveWaste) || 0;
            if (a.planId) planSet[String(a.planId)] = 1;

            var pls = printedByMrq[mrq];
            if (pls && pls.length) {
                // One handover row per physical printed piece. giveRaw is spread
                // across them the same way the pieces are; qty comes from each
                // issueLine's own metres-equivalent so it stays per-piece.
                var rawLeft = giveRaw;
                pls.forEach(function (il, i) {
                    var key = matId + '|' + lot + '|P' + mrq + '|' + i;
                    var rawHere = (i === pls.length - 1)
                        ? rawLeft
                        : Math.round(rawLeft / (pls.length - i));
                    rawLeft -= rawHere;
                    byKey[key] = {
                        materialId: matId, lot: lot,
                        qty: round2(Number(il.qty) || 0),
                        piecesFromRaw: rawHere,
                        piecesFromWaste: 0,
                        unit: unit,
                        cutW: Number(il.cutW) || 0,
                        cutL: Number(il.cutL) || 0,
                        printed: true,
                        // Printed cloth is short rolls too, but this widget
                        // does not yet resolve which one a given piece came
                        // off (see lot-rolls-model.md's Fabric_Piece
                        // retirement note) - left blank rather than guessed.
                        rolls: {}, rollOrder: []
                    };
                    order.push(key);
                });
                return;
            }

            // Regular: aggregate by material × lot.
            var k = matId + '|' + lot;
            var cur = byKey[k];
            if (!cur) {
                cur = {
                    materialId: matId, lot: lot,
                    qty: 0, piecesFromRaw: 0, piecesFromWaste: 0,
                    unit: unit, cutW: Number(a.cutW) || 0, cutL: Number(a.cutL) || 0,
                    printed: false, rolls: {}, rollOrder: [], sharedLotSeen: false
                };
                byKey[k] = cur;
                order.push(k);
            }
            // Sum the already-rounded giveQty values — no re-rounding, so the
            // total equals Σ allocations.giveQty exactly.
            cur.qty += giveQty;
            cur.piecesFromRaw += giveRaw;
            cur.piecesFromWaste += giveWaste;
            // Merge this allocation's roll breakdown into the material×lot
            // line's own — a handover line can span several rolls (drained
            // across several allocations of the same material+lot), and the
            // true metres off one roll is the sum across all of them, same
            // reasoning as lotMoves / rollsByMrq above.
            //
            // ON A ROLLSSHARED (hand-edited) LOT, a.rolls is deliberately empty
            // (buildFabricIssueLine skips per-row attribution for exactly the
            // reason lotMoves does — the lot stamps every row with its WHOLE
            // draw, so no row has its own share to report). The true answer
            // lives on this issue's own lotMoves entry for that lot, already
            // deduped once per lot there. Pull it in ONCE per handover line,
            // never once per allocation, or a lot edited and split across
            // several allocations would have its rolls added again for each.
            if (a.sharedLot) {
                if (!cur.sharedLotSeen) {
                    cur.sharedLotSeen = true;
                    var lm = (line.lotMoves || []).filter(function (x) {
                        return String(x.lotId) === String(a.sharedLot);
                    })[0];
                    ((lm && lm.rolls) || []).forEach(function (rl) {
                        var rid = String(rl.rollId);
                        if (!cur.rolls[rid]) {
                            cur.rolls[rid] = { rollId: rid, label: String(rl.label || ''), metres: round2(Number(rl.metres) || 0) };
                            cur.rollOrder.push(rid);
                        }
                    });
                }
            } else {
                (a.rolls || []).forEach(function (rl) {
                    var rid = String(rl.rollId);
                    var mtr = round2(Number(rl.metres) || 0);
                    if (cur.rolls[rid]) {
                        cur.rolls[rid].metres = round2(cur.rolls[rid].metres + mtr);
                    } else {
                        cur.rolls[rid] = { rollId: rid, label: String(rl.label || ''), metres: mtr };
                        cur.rollOrder.push(rid);
                    }
                });
            }
        });
    });

    var lines = order.map(function (k) {
        var r = byKey[k];
        r.qty = round2(r.qty);
        var rollList = (r.rollOrder || []).map(function (rid) { return r.rolls[rid]; });
        delete r.rolls;
        delete r.rollOrder;
        delete r.sharedLotSeen;
        // Roll_Label on the Issue_Line: the single roll's label, or every
        // roll this line drew from joined the same way the allocator's own
        // cutSummary reads on screen — one string a person can read at a
        // glance, not a structure they have to unpack.
        r.rollLabel = rollList.length === 1
            ? rollList[0].label
            : rollList.map(function (rl) { return rl.label + ' ' + round2(rl.metres) + 'm'; }).join(', ');
        return r;
    }).filter(function (r) {
        // Drop a genuinely empty bucket (no qty, no pieces).
        return r.qty > 0 || r.piecesFromRaw > 0 || r.piecesFromWaste > 0;
    });

    return { planCount: Object.keys(planSet).length, lines: lines };
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
        // "val" is the total fresh metres this material is issuing. For fabric it
        // is Σ of the ticked lot boxes; for a non-fabric accessory it is the one
        // metres box. A fabric line wholly covered by waste falls through at 0.
        var val = 0;
        if (m.isFabric && !isFullyIssued(m)) {
            validateRow(supIdx, matIdx, m);
            fabricLotLineList(m).forEach(function (info) {
                var chk = document.getElementById(lotLineCheckId(supIdx, matIdx, info.lotIdx));
                var box = document.getElementById(lotLineInputId(supIdx, matIdx, info.lotIdx));
                if (!box) return;
                if (box.classList.contains('invalid')) hasInvalid = true;
                if (chk && !chk.checked) return;
                val += parseFloat(box.value) || 0;
            });
            val = Math.round(val * 1000) / 1000;
        } else {
            var input = document.getElementById(rowInputId(supIdx, matIdx));
            if (input) {
                val = parseFloat(input.value) || 0;
                validateRow(supIdx, matIdx, m);
                if (input.classList.contains('invalid')) {
                    hasInvalid = true;
                }
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
            // mrqId + planItemId travel with the pick so the server credits the
            // exact requirement row this remnant was allocated to (one item can
            // have two rows for this fabric), not the oldest row that happens to
            // match on material and cut size.
            // lotId travels too. A remnant carries the tone of the lot it was
            // cut from, so on an order covered ENTIRELY by offcuts this is the
            // only record of which shade it was made in — there are no fresh
            // metres, so no lotLine, so `issuedLot` came back empty and the
            // order shipped unpinned. Its remake was then free to be cut off any
            // lot on the rack.
            if (pieces > 0) picks.push({
                wasteId: p.wasteId, pieces: pieces,
                planItemId: p.planItemId || '',
                mrqId: p.mrqId || '',
                lotId: p.lotId || ''
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

    // SPLIT ISSUE PATH. When on: each chunk calls issueMaterialsApply (fan-out
    // only — Material_Requirement + stock, NO handover record), the wasteMvIds
    // it returns are collected, and after the last chunk ONE
    // issueMaterialsHandover call writes a single Material_Issue with its
    // Issue_Lines at material × lot grain. No Batch_Voucher, no per-chunk
    // Material_Issue. The old issueMaterials path stays as the fallback.
    var USE_SPLIT_ISSUE = true;
    var ISSUE_API = USE_SPLIT_ISSUE ? 'issueMaterialsApply' : 'issueMaterials';
    // The handover summary is NOT built here - sendHandover builds it from the
    // requirement rows that actually fanned out, so a press that dies part-way
    // records exactly what left the shelf and no more.
    //
    // ONE ID FOR THIS WHOLE PRESS, AND IT IS STORED SERVER-SIDE NOW.
    // issueMaterialsApply stamps it on every Material_Requirement row and every
    // Waste_Movement it writes, so getIssueApplyStatus can be asked, after the
    // fact, exactly what this press moved. That matters because the statement
    // limit is not catchable: it kills a chunk mid-way and returns NO response,
    // so "the call failed" says nothing about how many of its rows landed.
    var applyKey = 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var collectedWasteMvIds = [];
    // Requirement row ids this press is CONFIRMED to have applied - unioned from
    // each chunk's own reply on the happy path, and re-read from the server by
    // reconcileApplied() when a chunk gave no reply at all.
    var confirmedMrqIds = {};
    var reconcileFailed = false;

    function noteApplied(ids) {
        (ids || []).forEach(function (id) { confirmedMrqIds[String(id)] = 1; });
    }

    var allErrors = [];
    var chunkIndex = 0;

    // Legacy-path only: the batch key threaded through the old issueMaterials'
    // 3rd arg. Unused on the split path.
    var batchVoucher = '';

    // RATE-LIMIT RECOVERY. Zoho caps API calls per minute. A big handover is
    // many sequential chunks and can trip that cap partway through — which used
    // to abort the whole run and leave a partial voucher. Now a throttled chunk
    // is RETRIED with exponential backoff instead of failing: the run pauses,
    // waits, and picks up exactly where it left off (same chunkIndex). Only a
    // non-retryable error, or too many retries, aborts.
    //
    // Each chunk is its OWN Material_Issue (SIV-NNNNN); the 3rd arg carries the
    // BATCH key (chunk 0's SIV) so the chunks group as one handover downstream.
    // A partial run is just fewer chunks in the batch, not a broken voucher.
    //
    // isRateLimited: Zoho surfaces throttling inconsistently — an HTTP 429, a
    // body code (4834 / "too many requests" / "rate limit"), or a plain
    // network-ish failure. Match broadly; a false positive just costs one wait.
    var RETRY_WAITS_MS = [3000, 8000, 20000, 45000, 60000]; // then give up
    var retryCount = 0;

    // IS THIS A THROTTLE, OR A REAL FAILURE WEARING A THROTTLE'S NUMBERS?
    //
    // Zoho surfaces throttling inconsistently — an HTTP 429, a body code
    // (4834 / "too many requests"), or a plain network-ish failure — so the
    // match has to be broad. But it must not match a DIGIT SEQUENCE that
    // happens to appear inside something else, and that is exactly what a bare
    // `indexOf('429')` did.
    //
    // THREE OF issueMaterialsApply's OWN ERROR STRINGS EMBED AN 18-DIGIT
    // CREATOR RECORD ID: "requirement <id> not found", "lot <id> not found",
    // "roll <label> (<id>) not found on lot <id>". Those come back as a normal
    // HTTP 200 carrying errors[], and `delugeThrottled` runs this predicate
    // over that text. An id containing "429" anywhere in its eighteen digits —
    // roughly one row in forty — turned a permanent, non-retryable failure
    // into a rate-limit retry: the same doomed chunk replayed five times over
    // ~2 minutes of backoff, the store person watching "Rate-limited —
    // retrying…" for a material that will never issue, and the real error
    // ("requirement not found") never surfacing because the retry path returns
    // before it is added to allErrors. A metres figure like "4.29" was safe
    // only by luck of the decimal point.
    //
    // So the numeric codes are matched as CODES — a whole token, not a
    // substring — while the word forms stay as plain contains. `\b` is no use
    // against a run of digits (429 inside 3955559000000429001 has no word
    // boundary), so the token test requires a non-digit either side.
    //
    // The status fields are checked first and remain authoritative: a genuine
    // HTTP 429 never depends on this string matching at all.
    function isRateLimited(err) {
        if (!err) return false;
        if (err.status === 429 || err.statusCode === 429 || err.code === 429) return true;
        if (err.status === 4834 || err.statusCode === 4834 || err.code === 4834) return true;

        var s = '';
        try { s = JSON.stringify(err); } catch (e) { s = String(err); }
        s = (s + ' ' + (err && err.message ? err.message : '')).toLowerCase();

        // A bare code, not a digit run inside a longer number or an id. The
        // boundary is NON-ALPHANUMERIC rather than merely non-digit: a size
        // prints as "429x120" and a lot as "L429", where the neighbour is a
        // letter and a digit-only guard would still read 429 as a code. A real
        // throttle code is always delimited by whitespace or punctuation.
        var hasCode = function (code) {
            return new RegExp('(^|[^a-z0-9])' + code + '([^a-z0-9]|$)').test(s);
        };

        return hasCode('429') || hasCode('4834') ||
            s.indexOf('too many request') >= 0 ||
            s.indexOf('rate limit') >= 0 ||
            s.indexOf('rate-limit') >= 0 ||
            s.indexOf('throttl') >= 0 ||
            s.indexOf('limit exceeded') >= 0;
    }

    // THE HANDOVER RECORD FOR WHAT ACTUALLY LANDED.
    //
    // Built from the chunks that were APPLIED, never from the whole press. Two
    // reasons, and the second one strands stock if it is got wrong:
    //
    //  - A press that dies at chunk 3 of 5 has moved chunks 0-2's stock and
    //    written their Material_Requirement counters. Recording all five would
    //    claim cloth that never left the shelf.
    //  - Recording NOTHING is worse. The supervisor's receive screen reads
    //    Issue_Lines, so material with no handover row can never be received,
    //    and postTransferOrders never moves it - it sits in In_Transit_Qty for
    //    ever with nothing anywhere saying so. So abortRun calls this too.
    //
    // The old per-chunk Material_Issue got this for free (a dead press just
    // left fewer vouchers); one-record-per-press has to do it deliberately.
    //
    // ROW GRANULARITY, NOT CHUNK GRANULARITY, and that is the whole point of
    // the apply key. Counting whole chunks answered "which calls came back",
    // which is not the same question: a chunk killed by the statement limit
    // returns nothing at all yet may have applied 90 of its 100 rows. Those 90
    // moved stock, and excluding the whole chunk left every one of them with no
    // Issue_Line - unreceivable, stranded in In_Transit_Qty, silently. Filtering
    // the allocations by the rows the SERVER confirms it stamped records exactly
    // what fanned out, however the press died.
    function appliedIssues() {
        var out = [];
        (issueChunks || []).forEach(function (chunk) {
            (chunk || []).forEach(function (line) {
                var keep = (line.allocations || []).filter(function (a) {
                    return confirmedMrqIds[String(a.mrqId)];
                });
                if (!keep.length) return;
                // Same line, only the confirmed allocations. issueLines is
                // sliced to match so buildHandoverSummary's per-piece printed
                // rows still pair with their allocation.
                var keptMrq = {};
                keep.forEach(function (a) { keptMrq[String(a.mrqId)] = 1; });
                out.push({
                    materialId: line.materialId,
                    source: line.source,
                    isFabric: line.isFabric,
                    unit: line.unit,
                    cutWidth: line.cutWidth,
                    cutLength: line.cutLength,
                    allocations: keep,
                    issueLines: (line.issueLines || []).filter(function (il) {
                        return keptMrq[String(il.mrqId)];
                    }),
                    // buildHandoverSummary's rollsShared fallback reads THIS
                    // line's lotMoves to resolve Roll_Label on a hand-edited
                    // lot (see allocations[].sharedLot). Dropping it here left
                    // that fallback looking at undefined on the one path that
                    // actually matters — every real press runs through
                    // appliedIssues, not the raw issueChunks. On a split line
                    // this rides the FIRST slice only, same as every other
                    // slice-riding field in this object; an edited lot spread
                    // across slices resolves to whichever slice landed first.
                    lotMoves: line.lotMoves || []
                });
            });
        });
        return out;
    }

    // ASK THE SERVER WHAT IT ACTUALLY STAMPED. Only needed when a chunk gave no
    // usable reply - on the happy path every chunk reported its own applied ids
    // and this adds nothing. Failure here is not fatal: we fall back to whatever
    // the chunks did manage to report, and say so.
    function reconcileApplied(done) {
        if (!USE_SPLIT_ISSUE) { done(); return; }
        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'getIssueApplyStatus',
            http_method: 'POST',
            payload: { applyKey: applyKey }
        }).then(function (response) {
            var parsed;
            try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }
            if (parsed && parsed.mrqIds) noteApplied(parsed.mrqIds);
            if (parsed && parsed.wasteMvIds && parsed.wasteMvIds.length) {
                var seen = {};
                collectedWasteMvIds.forEach(function (w) { seen[String(w)] = 1; });
                parsed.wasteMvIds.forEach(function (w) {
                    if (!seen[String(w)]) collectedWasteMvIds.push(String(w));
                });
            }
            done();
        }).catch(function (err) {
            console.error('getIssueApplyStatus failed:', err);
            reconcileFailed = true;
            done();
        });
    }

    var handoverSent = false;

    function sendHandover(done) {
        if (!USE_SPLIT_ISSUE || handoverSent) { done(); return; }
        var applied = appliedIssues();
        if (applied.length === 0) { done(); return; }   // nothing landed, nothing to record
        handoverSent = true;

        var summary = buildHandoverSummary(applied);
        if (!summary.lines.length) { done(); return; }

        showProgressModal('Issuing to ' + sup.supervisorName, 'Recording the handover…');
        var payload = {
            planCount: summary.planCount,
            wasteMvIds: collectedWasteMvIds,
            lines: summary.lines
        };
        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: 'issueMaterialsHandover',
            http_method: 'POST',
            payload: {
                supervisorId: sup.supervisorId,
                handoverJson: JSON.stringify(payload)
            }
        }).then(function (response) {
            console.log('handover response:', response);
            var parsed;
            try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }
            if (parsed && parsed.errors && parsed.errors.length > 0) {
                allErrors = allErrors.concat(parsed.errors.map(function (e) {
                    return 'Handover record: ' + e;
                }));
            }
            done();
        }).catch(function (err) {
            console.error('issueMaterialsHandover failed:', err);
            allErrors.push('The material WAS issued and stock moved, but the handover record '
                + 'was not written — so it will not appear on ' + sup.supervisorName
                + "'s Receive screen. Tell an admin before issuing again.");
            done();
        });
    }

    function processNextChunk() {
        if (chunkIndex >= issueChunks.length) {
            sendHandover(function () {
            showProgressModal('Issued to ' + sup.supervisorName, 'Done', 100);
            setTimeout(closeProgressModal, 350);

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
            }); // end sendHandover callback
            return;
        }

        var displayTotal = issueChunks.length;
        btn.textContent = displayTotal > 1
            ? 'Issuing… (' + (chunkIndex + 1) + '/' + displayTotal + ')' : 'Issuing…';

        if (displayTotal > 1) {
            showProgressModal('Issuing to ' + sup.supervisorName,
                'Batch ' + (chunkIndex + 1) + ' of ' + displayTotal,
                (chunkIndex / displayTotal) * 100);
        } else {
            showProgressModal('Issuing to ' + sup.supervisorName,
                'Sending the handover…');
        }

        var chunkPayload = {
            supervisorId: sup.supervisorId,
            issuesJson: JSON.stringify(issueChunks[chunkIndex])
        };
        if (USE_SPLIT_ISSUE) {
            chunkPayload.applyKey = applyKey;
        } else {
            // Legacy issueMaterials 3rd arg — the batch key thread.
            chunkPayload.voucherIn = batchVoucher;
        }

        ZOHO.CREATOR.DATA.invokeCustomApi({
            api_name: ISSUE_API,
            http_method: 'POST',
            payload: chunkPayload
        }).then(function (response) {
            console.log('issue response chunk ' + chunkIndex + ':', response);
            var parsed;
            try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }

            // A Deluge-side rate-limit can also come back INSIDE the payload as
            // a DELUGE: error rather than a rejected promise. Treat that the
            // same — retry the chunk, don't record it as a permanent failure.
            //
            // ONLY THE THROWN-EXCEPTION ERRORS ARE EVEN CANDIDATES, and that
            // narrowing is what makes this safe to test with a string match at
            // all. issueMaterialsApply emits two shapes into errors[]:
            //
            //   "DELUGE: <message>"  — the outer catch. A real thrown exception,
            //                          and the only shape a Zoho throttle can
            //                          arrive in.
            //   "<sku>: requirement <id> not found" / "lot <id> not found" /
            //   "roll <label> (<id>) not found on lot <id>" /
            //   "lot <n> has <x> washed, asked <y> - clamped"
            //                        — per-row problems it collected and kept
            //                          going. PERMANENT. Retrying replays the
            //                          same doomed chunk.
            //
            // The second group embeds 18-digit record ids and free-form lot
            // numbers, so it is exactly the text a numeric code match trips
            // over — and none of it can ever be a throttle. Testing only the
            // "DELUGE:" rows removes the whole class of false positive rather
            // than trying to out-guess the id space.
            var delugeThrottled = parsed && parsed.errors &&
                parsed.errors.some(function (e) {
                    var t = String(e || '');
                    if (t.indexOf('DELUGE:') !== 0) return false;
                    return isRateLimited({ message: t });
                });
            if (delugeThrottled) {
                scheduleRetry({ message: parsed.errors.join(' ') });
                return;
            }

            if (parsed && parsed.errors && parsed.errors.length > 0) {
                allErrors = allErrors.concat(parsed.errors);
            }

            if (USE_SPLIT_ISSUE) {
                // Collect this chunk's Waste_Movement ids — the handover call
                // stamps the SIV on all of them once the voucher exists.
                if (parsed && parsed.wasteMvIds && parsed.wasteMvIds.length) {
                    collectedWasteMvIds = collectedWasteMvIds.concat(
                        parsed.wasteMvIds.map(String));
                }
                // And the requirement rows it stamped. A chunk that answers is
                // its own reconciliation — getIssueApplyStatus is only needed
                // for the ones that never answer.
                if (parsed && parsed.appliedMrqIds) {
                    noteApplied(parsed.appliedMrqIds);
                }
            } else if (parsed && !batchVoucher) {
                // Legacy: capture the batch key off chunk 0's landed reply.
                batchVoucher = parsed.batchVoucher || parsed.voucher || '';
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

    // RECORD WHAT LANDED BEFORE REPORTING THE FAILURE. The batches that went
    // through already moved stock and wrote their requirement counters; without
    // a Material_Issue for them the supervisor can never receive that material
    // and it is stranded in In_Transit_Qty. sendHandover writes the record for
    // the applied chunks only, then the abort is reported as before.
    //
    // RECONCILE FIRST. The chunk that just died is the one we know least about —
    // it returned no reply, so its own applied ids are lost with it. Asking the
    // server which rows carry this press's apply key is the only way to record
    // the part of it that did land.
    function abortRun(err) {
        console.error('issueMaterials error on chunk ' + chunkIndex + ':', err);
        showProgressModal('Issuing to ' + sup.supervisorName,
            'Checking what was issued before the error…');
        reconcileApplied(function () {
            sendHandover(function () {
                closeProgressModal();
                var batchNum = chunkIndex + 1;
                var msg = 'Issue stopped at batch ' + batchNum + ' of ' + issueChunks.length + '.\n\n' +
                    'Everything that actually left the shelf — including any part of batch ' +
                    batchNum + ' that went through before the error — has been recorded as a ' +
                    'handover. Press Issue again to send the rest; it will only ask for what is ' +
                    'still outstanding.';
                if (reconcileFailed) {
                    msg = 'Issue stopped at batch ' + batchNum + ' of ' + issueChunks.length +
                        ', and the check for what had already been issued ALSO failed.\n\n' +
                        'Some material may have left the shelf without being recorded on a ' +
                        'handover. Do NOT press Issue again — tell an admin to check ' +
                        sup.supervisorName + "'s outstanding quantities first.";
                }
                if (allErrors.length > 0) {
                    msg += '\n\n' + allErrors.join('\n');
                }
                alert(msg);
                delete btn.dataset.busy;
                btn.disabled = false;
                btn.textContent = 'Issue to ' + sup.supervisorName;
                loadRequirements();
            });
        });
    }

    processNextChunk();
}

// ---- Load ----

// The store screen fetches the whole rack in one pass via ApiExperiment.run()
// (Creator JS Data API + client-side allocator). ApiExperiment already returns
// a single, fully-merged `plans` array, so nothing in the live path calls
// mergeRequirementPages any more.
//
// It is kept because it is the correct merge: were the read ever split into
// several concurrent pages again (a real possibility at large scale), two pages
// can each carry a block for the same supervisor whose plans landed on
// different pages. Merging by supervisorId — not concatenation — is what stops
// that drawing two cards for one person and dropping half his materials off
// whichever card the allocator runs first. `tools/alloc-paging.test.js` pins it.
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
                    // ONE ROW PER (materialId, source). Cut size is no longer in
                    // the key — the server merged those — so a supervisor whose
                    // demand for a fabric is split across parallel pages lands on
                    // ONE entry, with lines / cuts / piece counts summed below.
                    if (em.materialId === bm.materialId &&
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
                        // MERGE THE PER-CUT SUMMARY. A supervisor's demand for one
                        // fabric can land on two parallel pages — page 2 may carry
                        // a cut size page 1 did not. The allocator rebuilds the
                        // cut list from the (fully merged) lines anyway, but keep
                        // m.cuts complete for anything else that reads it.
                        if (bm.cuts && bm.cuts.length) {
                            existingMat.cuts = existingMat.cuts || [];
                            var seen = {};
                            existingMat.cuts.forEach(function (c) {
                                seen[(c.cutW || 0) + 'x' + (c.cutL || 0)] = c;
                            });
                            bm.cuts.forEach(function (c) {
                                var k = (c.cutW || 0) + 'x' + (c.cutL || 0);
                                if (seen[k]) {
                                    seen[k].reqPieces = (seen[k].reqPieces || 0) + (c.reqPieces || 0);
                                    seen[k].issPieces = (seen[k].issPieces || 0) + (c.issPieces || 0);
                                } else {
                                    existingMat.cuts.push(c);
                                    seen[k] = c;
                                }
                            });
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

// ---- Load progress bar ----
//
// ApiExperiment.run() fetches the whole rack in a handful of getRecords pages
// and assembles it before returning. The widget cannot see that progress, so
// the bar runs indeterminate with the sub-line explaining the wait.
var LoadProgress = {
    el: null,

    start: function (contentEl, title) {
        contentEl.innerHTML =
            '<div class="load-progress is-indeterminate" id="load-progress">' +
            '<div class="lp-head">' +
            '<span class="lp-title" id="lp-title"></span>' +
            '</div>' +
            '<div class="lp-track"><div class="lp-fill" id="lp-fill"></div></div>' +
            '<div class="lp-sub" id="lp-sub">This can take a moment on a large order backlog.</div>' +
            '</div>';
        this.el = document.getElementById('load-progress');
        var n = document.getElementById('lp-title');
        if (n) n.textContent = title || 'Loading material requirements…';
    },

    finish: function () {
        this.el = null;
    }
};

function loadRequirements() {
    var content = document.getElementById('dynamic-content');
    var emptyState = document.getElementById('empty-state');
    var refreshBtn = document.getElementById('refresh-btn');
    emptyState.classList.add('hidden');
    refreshBtn.disabled = true;

    function done(merged) {
        console.log('merged requirements:', merged);
        LoadProgress.finish();
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
        LoadProgress.finish();
        refreshBtn.disabled = false;
        content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Failed to load requirements</h2><p>Check the browser console for details.</p></div>';
    }

    // Requirements come from the Creator JS Data API (getRecords), assembled and
    // allocated client-side by ApiExperiment.run(). There is no custom-function
    // path any more — getStoreMaterialRequirements is retired.
    LoadProgress.start(content, 'Loading material requirements…');
    if (typeof ApiExperiment === 'undefined' || !ApiExperiment.run) {
        return fail(new Error('ApiExperiment not loaded — check js/api-experiment.js'));
    }
    ApiExperiment.run().then(function (out) {
        done(out.plans || []);
    }).catch(fail);
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

        // Sort so the same fabric's remnants sit together — the store person
        // checks one fabric onto the rack, then the next. The server returns
        // them oldest-first; a STABLE sort by fabric keeps that order within
        // each fabric. Grouping key is materialId (the Raw_Material id), with
        // the display name as a tiebreak so a piece that somehow has no id
        // still lands beside its namesakes. wastePending is reordered in place,
        // so every input's flat index still matches the row it is drawn on.
        wastePending = wastePending
            .map(function (p, i) { return { p: p, i: i }; })
            .sort(function (a, b) {
                var ka = String(a.p.materialId || '') + ' ' + String(a.p.material || '');
                var kb = String(b.p.materialId || '') + ' ' + String(b.p.material || '');
                if (ka < kb) return -1;
                if (ka > kb) return 1;
                return a.i - b.i;
            })
            .map(function (x) { return x.p; });

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

// Typing a carton fills the EMPTY ones below it WITHIN THE SAME FABRIC. One
// fabric's remnants go on the rack together, so typing the box once and having
// that fabric's rows follow is the common case — but the next fabric is a
// separate decision and a separate box, so the fill stops at the group boundary.
// It only ever touches blanks, so nothing already written is overwritten.
function onWasteCartonInput(i) {
    var val = wasteRecvCarton(i);
    if (val === '') return;
    var here = wastePending[i];
    var matKey = here ? String(here.materialId || here.material || '') : '';
    for (var j = i + 1; j < wastePending.length; j++) {
        var q = wastePending[j];
        if (String(q.materialId || q.material || '') !== matKey) break;
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

    // SORTED so the same fabric's remnants sit next to each other — the store
    // person checks one fabric onto the rack, then the next. It is only a sort:
    // no group headers, no accordion. wastePending itself is re-ordered on load
    // (see loadWasteReceipt) so every input's flat index still lines up with the
    // row it is drawn against.
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
            // Just who declared it and when — the order / plan number is not part
            // of checking a remnant onto the rack.
            '<div class="mat-sku">from ' + escapeHtml(p.supervisor || '—') +
            (p.declaredOn ? ' · ' + escapeHtml(p.declaredOn) : '') + '</div>' +
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

// ONE ROW PER MATERIAL in a handover card, laid out like the Issue screen:
// column 1 the SKU + name (never repeated), column 2 a stack of where it came
// from — a line per lot for fresh cloth, then a green line per offcut with its
// size, lot and carton — column 3 the total that went out.
//
// h.lines is one entry per Issue_Line (fresh cloth, fanned per plan-item);
// h.waste is one entry per Waste_Movement "Issued" row (offcuts). Both are
// grouped here by SKU. Fresh entries sharing a (sku, lot) sum together.
function histMaterialGroups(h) {
    var byKey = {};
    var order = [];

    function grp(sku, name, unit) {
        var k = sku || name || '—';
        if (!byKey[k]) {
            byKey[k] = { key: k, sku: sku || '', name: name || '—', unit: unit || '',
                         freshByLot: {}, freshOrder: [], waste: [], total: 0 };
            order.push(k);
        }
        return byKey[k];
    }

    (h.lines || []).forEach(function (l) {
        var g = grp(l.sku, l.material, l.unit);
        if (!g.unit && l.unit) g.unit = l.unit;
        var lot = l.lot || '';
        var lk = lot || '(no lot)';
        if (!g.freshByLot[lk]) {
            // roll: which physical roll(s) this lot's cloth came off, lot-
            // rolls-model.md Step 5 - one label, or several joined "L2-R1
            // 5m, L2-R2 1.05m". Carried as the raw string getStoreIssueHistory
            // emits; a line grouped into an existing lot bucket keeps the
            // FIRST line's roll rather than concatenating several, same as
            // every other per-lot field here is a snapshot, not a merge.
            g.freshByLot[lk] = { lot: lot, roll: l.roll || '', qty: 0 };
            g.freshOrder.push(lk);
        }
        g.freshByLot[lk].qty += Number(l.qty) || 0;
        g.total += Number(l.qty) || 0;
    });

    (h.waste || []).forEach(function (w) {
        var g = grp(w.sku, w.material, w.unit);
        var pcs = Number(w.pieces) || 0;
        g.waste.push({
            lot: w.lot || '', carton: w.carton || '', pieces: pcs,
            cutWidth: Number(w.cutWidth) || 0, cutLength: Number(w.cutLength) || 0
        });
    });

    return order.map(function (k) { return byKey[k]; });
}

function histDistinctMaterialCount(h) {
    return histMaterialGroups(h).length;
}

function histMaterialRows(h) {
    var groups = histMaterialGroups(h);
    if (groups.length === 0) {
        return '<tr><td colspan="3"><span class="is-muted">No lines on this handover.</span></td></tr>';
    }
    return groups.map(function (g) {
        // Column 2 — the stack. Fresh lots first, then offcuts (green).
        var stack = g.freshOrder.map(function (lk) {
            var f = g.freshByLot[lk];
            // Lot only qualifies fabric — thread and labels are issued by count
            // off no roll, so their line is just the quantity, no "no lot" tag.
            // Roll sub-line under it, same convention the issue screen's own
            // rollLinesFor uses — absent for a pre-Step-5 handover, and for
            // non-fabric (no lot means no roll either).
            return '<div class="hist-src-line">' +
                (f.lot ? '<span class="hist-lot">' + escapeHtml(f.lot) + '</span> ' : '') +
                '<span class="hist-src-qty">' + fmt(f.qty) +
                '<span class="unit">' + escapeHtml(g.unit || '') + '</span></span>' +
                (f.roll ? '<div class="hist-roll">' + escapeHtml(f.roll) + '</div>' : '') +
                '</div>';
        });
        g.waste.forEach(function (w) {
            var size = (w.cutWidth > 0 && w.cutLength > 0)
                ? fmt(w.cutLength) + ' &times; ' + fmt(w.cutWidth) + '<span class="unit">cm</span>'
                : w.pieces + '<span class="unit">pcs</span>';
            var tail = [];
            if (w.lot) tail.push(escapeHtml(w.lot));
            if (w.carton) tail.push('Carton ' + escapeHtml(w.carton));
            stack.push('<div class="hist-src-line hist-src-waste">' +
                '&#9851; <span class="hist-waste-size">' + size + '</span>' +
                (tail.length ? ' <span class="hist-waste-where">' + tail.join(' &middot; ') + '</span>' : '') +
                (w.pieces ? ' <span class="hist-src-qty">' + w.pieces + '<span class="unit">pcs</span></span>' : '') +
                '</div>');
        });

        var totalTxt = g.total > 0
            ? fmt(g.total) + '<span class="unit">' + escapeHtml(g.unit || '') + '</span>'
            : (g.waste.length
                ? g.waste.reduce(function (n, w) { return n + w.pieces; }, 0) + '<span class="unit">pcs</span>'
                : '<span class="is-muted">&mdash;</span>');

        return '<tr>' +
            '<td class="material-name-cell">' +
            '<div class="mat-name">' + escapeHtml(g.name) + '</div>' +
            (g.sku ? '<div class="mat-sku">' + escapeHtml(g.sku) + '</div>' : '') +
            '</td>' +
            '<td class="hist-src-cell">' + (stack.join('') || '<span class="is-muted">&mdash;</span>') + '</td>' +
            '<td class="col-num col-strong">' + totalTxt + '</td>' +
            '</tr>';
    }).join('');
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
        var lines = histMaterialRows(h);

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

        // "N materials" — one row per SKU now, not per Issue_Line, so this
        // counts distinct materials in the handover the way the merged table
        // reads.
        var nMats = histDistinctMaterialCount(h);
        when += ' · ' + nMats + ' material' + (nMats === 1 ? '' : 's');

        // ONE PRESS OF ISSUE = ONE CARD, even when the store person's backlog
        // was big enough that the widget chunked it into several Material_Issue
        // records. The SIV list is shown so a transfer-order check in Zoho
        // Inventory (one order per chunk) reconciles against the card. A single
        // -chunk press shows just its one number, as before.
        var sivs = (h.sivNumbers && h.sivNumbers.length)
            ? h.sivNumbers
            : (h.voucher ? [h.voucher] : []);
        var sivLine = '';
        if (sivs.length === 1) {
            sivLine = '<div class="hist-siv">' + escapeHtml(sivs[0]) + '</div>';
        } else if (sivs.length > 1) {
            sivLine = '<div class="hist-siv">' + escapeHtml(sivs[0]) +
                ' <span class="hist-siv-more">+ ' + (sivs.length - 1) +
                ' more: ' + escapeHtml(sivs.slice(1).join(', ')) + '</span></div>';
        }

        return '' +
            '<div class="item-card' + (idx === 0 ? ' open' : '') + '" id="hist-card-' + idx + '">' +
            '<div class="item-header" onclick="toggleHistory(' + idx + ')">' +
            '<div class="item-header-info">' +
            '<h2>' + escapeHtml(h.supervisor || 'Unknown') + '</h2>' +
            sivLine +
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
            '<th>Material</th><th>Issued from</th><th class="col-num">Qty issued</th>' +
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
// materialId -> [{label, length}]. Rolls, not a lump quantity - lot-rolls-
// model.md Step 6. Keyed on materialId like everything else on this screen,
// initialised once when a card opens (toggleStockCard) rather than at render
// time, so a re-render from the search box does not wipe what he has typed.
var stockRolls = {};

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
        // Seed one empty roll row the FIRST time this card opens. Left alone
        // on a later toggle so closing and reopening does not lose what he
        // already typed.
        if (stockOpenId === matId && !stockRolls[matId]) {
            stockRolls[matId] = [{ label: '', length: '' }];
        }
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
        '</div>' +
        '<div id="si-rolls-' + m.materialId + '">' + stockRollLinesHtml(m) + '</div>' +
        '<div class="card-footer" id="si-foot-' + m.materialId + '">' + stockRollFooterHtml(m) + '</div>' +
        '</div>' +
        '</div>';
}

// ONE ROW PER PHYSICAL ROLL, not a lump quantity - lot-rolls-model.md Step 6.
// Cutting instructions are per roll, so cloth with no roll behind it cannot be
// issued at all under the rolls model; AT LEAST ONE ROW IS REQUIRED and the
// submit button stays disabled until the rows sum to EXACTLY the unallocated
// figure (see stockRollFooterHtml) - there is no partial allocation, the
// whole delivery has to be accounted for as rolls in one pass.
//
// SAME SHAPE AS printLinesHtml (the send-to-print form): an array keyed by
// materialId, add/remove mutate it and re-render only this block, typing
// never touches innerHTML of anything holding an input.
function stockRollLinesHtml(m) {
    var rolls = stockRolls[m.materialId] || [{ label: '', length: '' }];

    var rows = rolls.map(function (r, i) {
        return '' +
            '<tr>' +
            '<td><input type="text" class="note-input" ' +
            'id="si-rl-lbl-' + m.materialId + '-' + i + '" value="' + escapeHtml(r.label) + '" ' +
            'placeholder="as written on the roll" ' +
            'onblur="onStockRollLabelBlur(\'' + m.materialId + '\',' + i + ')" ' +
            'oninput="refreshStockRollTotals(\'' + m.materialId + '\')" /></td>' +
            '<td><input type="number" step="0.01" min="0" class="issue-input" ' +
            'id="si-rl-len-' + m.materialId + '-' + i + '" value="' + escapeHtml(r.length) + '" ' +
            'oninput="refreshStockRollTotals(\'' + m.materialId + '\')" /></td>' +
            '<td><button type="button" class="raise-btn is-stale" ' +
            'onclick="removeStockRollLine(\'' + m.materialId + '\',' + i + ')">Remove</button></td>' +
            '</tr>';
    }).join('');

    return '' +
        '<div class="table-wrapper"><table>' +
        '<thead><tr>' +
        '<th>Roll label</th>' +
        '<th class="col-num">Length (Mtr)</th>' +
        '<th></th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
        '<button type="button" class="raise-btn" ' +
        'onclick="addStockRollLine(\'' + m.materialId + '\')">+ Another roll</button>';
}

function readStockRollLines(matId) {
    var out = [];
    (stockRolls[matId] || []).forEach(function (r, i) {
        var l = document.getElementById('si-rl-lbl-' + matId + '-' + i);
        var n = document.getElementById('si-rl-len-' + matId + '-' + i);
        out.push({ label: l ? l.value : r.label, length: n ? n.value : r.length });
    });
    return out;
}

function stockRollTotal(matId) {
    var t = 0;
    (stockRolls[matId] || []).forEach(function (r) {
        var n = Number(r.length) || 0;
        if (n > 0) t += n;
    });
    return Math.round(t * 100) / 100;
}

// THE SUM MUST MATCH EXACTLY. Partial allocation was rejected on purpose —
// there is no "some rolls now, the rest later" state to track, so the button
// stays off until the rolls he has typed account for the WHOLE delivery.
function stockRollFooterHtml(m) {
    var total = stockRollTotal(m.materialId);
    var target = Number(m.unallocated) || 0;
    var matches = Math.abs(total - target) < 0.005;
    return '' +
        '<span class="sel-count' + (matches ? '' : ' is-short') + '">' +
        fmt(total) + ' of ' + fmt(target) + ' Mtr entered as rolls' +
        (matches ? '' : ' &mdash; <b>must total exactly the unallocated figure</b>') +
        '. Goes in as <b>unwashed</b>.' +
        '</span>' +
        '<button type="button" class="primary-btn" id="si-btn-' + m.materialId + '" ' +
        (matches ? '' : 'disabled ') +
        'onclick="submitStockIn(\'' + m.materialId + '\')">Add to stock</button>';
}

function addStockRollLine(matId) {
    stockRolls[matId] = readStockRollLines(matId);
    stockRolls[matId].push({ label: '', length: '' });
    var box = document.getElementById('si-rolls-' + matId);
    if (box) {
        var mat = null;
        stockMats.forEach(function (x) { if (x.materialId === matId) mat = x; });
        if (mat) box.innerHTML = stockRollLinesHtml(mat);
    }
    var foot = document.getElementById('si-foot-' + matId);
    if (foot) {
        var mat2 = null;
        stockMats.forEach(function (x) { if (x.materialId === matId) mat2 = x; });
        if (mat2) foot.innerHTML = stockRollFooterHtml(mat2);
    }
}

function removeStockRollLine(matId, idx) {
    var rows = readStockRollLines(matId);
    rows.splice(idx, 1);
    if (!rows.length) rows.push({ label: '', length: '' });
    stockRolls[matId] = rows;
    var mat = null;
    stockMats.forEach(function (x) { if (x.materialId === matId) mat = x; });
    if (!mat) return;
    var box = document.getElementById('si-rolls-' + matId);
    if (box) box.innerHTML = stockRollLinesHtml(mat);
    var foot = document.getElementById('si-foot-' + matId);
    if (foot) foot.innerHTML = stockRollFooterHtml(mat);
}

// TYPING MUST NOT REBUILD THE INPUT BEING TYPED IN — the same trap the print
// form and the search box both carry their own warning about. Only the
// footer (no inputs of its own) is replaced on every keystroke; the rows
// themselves are only rebuilt by add/remove, which is a deliberate click.
function refreshStockRollTotals(matId) {
    stockRolls[matId] = readStockRollLines(matId);
    var mat = null;
    stockMats.forEach(function (x) { if (x.materialId === matId) mat = x; });
    if (!mat) return;
    var foot = document.getElementById('si-foot-' + matId);
    if (foot) foot.innerHTML = stockRollFooterHtml(mat);
}

// LIVE COLLISION CHECK ON BLUR, against getStoreLots' rollLabels — the same
// data this screen already has loaded, no extra round trip. Checked against
// whichever lot is currently selected (existing lot picks up its own rolls;
// a brand-new lot has none to clash with) AND against every OTHER row typed
// in this same submission, matching saveStockInward.dg's own duplicate-
// within-submission guard.
function onStockRollLabelBlur(matId, idx) {
    stockRolls[matId] = readStockRollLines(matId);
    var input = document.getElementById('si-rl-lbl-' + matId + '-' + idx);
    if (!input) return;
    var typed = (input.value || '').trim().toUpperCase();
    input.classList.remove('invalid');
    if (typed === '') return;

    var mat = null;
    stockMats.forEach(function (x) { if (x.materialId === matId) mat = x; });
    if (!mat) return;

    var lotSel = document.getElementById('si-lot-' + matId);
    var lotId = lotSel ? lotSel.value : '';
    var existing = [];
    (mat.lots || []).forEach(function (l) {
        if (String(l.lotId) === String(lotId)) existing = l.rollLabels || [];
    });
    var clashesExisting = existing.some(function (lbl) {
        return String(lbl || '').trim().toUpperCase() === typed;
    });

    var clashesHere = false;
    (stockRolls[matId] || []).forEach(function (r, i) {
        if (i === idx) return;
        if (String(r.label || '').trim().toUpperCase() === typed) clashesHere = true;
    });

    if (clashesExisting || clashesHere) {
        input.classList.add('invalid');
        alert('Roll ' + input.value.trim() + (clashesExisting
            ? ' already exists on this lot.'
            : ' is entered twice.'));
    }
}

function submitStockIn(matId) {
    var lotSel = document.getElementById('si-lot-' + matId);
    var numEl = document.getElementById('si-num-' + matId);
    var btn = document.getElementById('si-btn-' + matId);
    if (!btn) return;

    var mat = null;
    stockMats.forEach(function (x) { if (x.materialId === matId) mat = x; });
    if (!mat) return;

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
        var taken = (mat.lots || []).some(function (l) {
            return String(l.lotNumber || '').trim().toUpperCase() === lotNum.toUpperCase();
        });
        if (taken) {
            alert('This material already has a lot ' + lotNum + '.');
            return;
        }
    }

    // AT LEAST ONE ROLL, EVERY ROLL LABELLED AND POSITIVE, THE SUM EXACT.
    // The footer button is already disabled unless the sum matches — this is
    // the same check repeated for a client that got here anyway (stale DOM,
    // a fast double-click before the footer redrew).
    var rolls = readStockRollLines(matId);
    var target = Number(mat.unallocated) || 0;
    var total = 0;
    var rollsOut = [];
    var seen = {};
    for (var i = 0; i < rolls.length; i++) {
        var lbl = String(rolls[i].label || '').trim();
        var len = parseFloat(rolls[i].length);
        if (lbl === '') {
            alert('Every roll needs a label.');
            return;
        }
        if (isNaN(len) || len <= 0) {
            alert('Roll ' + lbl + ' needs a length greater than zero.');
            return;
        }
        var key = lbl.toUpperCase();
        if (seen[key]) {
            alert('Roll ' + lbl + ' is entered twice.');
            return;
        }
        seen[key] = true;
        total += len;
        rollsOut.push({ label: lbl, length: len });
    }
    if (rollsOut.length === 0) {
        alert('At least one roll is required.');
        return;
    }
    total = Math.round(total * 100) / 100;
    if (Math.abs(total - target) > 0.005) {
        alert('The rolls total ' + total + ' Mtr, but ' + target + ' Mtr is unallocated. They must match exactly.');
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
                rolls: rollsOut,
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

        // Cleared so a later delivery to this same material starts from one
        // empty row again, not the rolls that were just booked.
        delete stockRolls[matId];

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
// Source cloth is cut into full-width pieces, sent to an outside printer, and
// comes back as a different (already-existing) SKU. This screen is the whole
// loop: send, receive, cancel.
//
// NO MINTING — printed SKUs are created in Zoho Inventory and pushed to Creator.
// He picks a source fabric on the left and an existing printed SKU on the right,
// filtered to Type "printed fabric" at the same width. There is no system link
// between the two (no Print_Base); the pairing is his to make.
//
// PRINTED STOCK IS SHORT ROLLS. Each returned piece becomes one Lot_Rolls row —
// ordinary raw material, issued like any other fabric. No Fabric_Piece, no
// pattern. See docs/printing-v2-plan.md.
//
// The lot holds the truth and Raw_Material holds a maintained total; both move
// server-side in one pass, so nothing here computes a stock balance of its own.

var PRINT_DATA = null;
var printFilter = '';
var printOpenId = null;        // source material id whose card is open
var printJobOpenId = null;
var printSendLines = {};       // sourceMatId -> [{ len, count }]
var printSendPlan = {};        // sourceMatId -> { <rollId>: metresString }  (manual overrides)
var printSendTarget = {};      // sourceMatId -> targetMatId
var printSendLot = {};         // sourceMatId -> sourceLotId
var printSendState = {};       // sourceMatId -> 'Wash' | 'Unwash'
var printRecvPieces = {};     // jobId -> [{ lineIndex, len, label, state }]  one per PIECE

function loadPrint() {
    var panel = document.getElementById('panel-print');
    panel.innerHTML = '<div class="panel-loading">Loading…</div>';

    PrintData.load().then(function (data) {
        PRINT_DATA = data;
        renderPrint();
    }).catch(function (err) {
        console.error('PrintData.load error:', err);
        panel.innerHTML = '<div class="panel-placeholder"><h2>Failed to load</h2>' +
            '<p>Check the browser console.</p></div>';
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
                    'placeholder="Search fabric by SKU or name…" oninput="onPrintFilter()" />' +
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

// Kept as a shim: the Issue tab's short-reason renderer still references it for
// a 'noPrinted' row that the rolls-model allocator no longer produces (print
// base chaining was never ported). If it is ever reached it just opens the tab.
function openPrintForBase() {
    showTab('print');
}

function onPrintFilter() {
    var el = document.getElementById('print-filter');
    printFilter = el ? el.value.trim().toLowerCase() : '';
    renderPrintList();
}

// Keyed on id, NEVER on list index — the index moves the moment the filter
// changes, so an open card would silently become a different material's.
function togglePrintCard(matId) {
    var card = document.getElementById('print-list-card-' + matId);
    if (!card) return;
    var opening = !card.classList.contains('open');
    document.querySelectorAll('#print-list .item-card.open').forEach(function (c) {
        c.classList.remove('open');
    });
    if (opening) {
        printOpenId = String(matId);
        card.classList.add('open');
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    } else {
        printOpenId = null;
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
        printJobOpenId = String(jobId);
        card.classList.add('open');
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    } else {
        printJobOpenId = null;
    }
}

function printJobById(jobId) {
    var found = null;
    ((PRINT_DATA && PRINT_DATA.jobs) || []).forEach(function (j) {
        if (String(j.jobId) === String(jobId)) found = j;
    });
    return found;
}

function printSourceById(matId) {
    var found = null;
    ((PRINT_DATA && PRINT_DATA.source) || []).forEach(function (m) {
        if (String(m.id) === String(matId)) found = m;
    });
    return found;
}

function printTargetById(matId) {
    var found = null;
    var all = ((PRINT_DATA && PRINT_DATA.source) || [])
        .concat((PRINT_DATA && PRINT_DATA.target) || []);
    all.forEach(function (m) {
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

    jobs.forEach(function (j) {
        if (!printRecvPieces[j.jobId]) {
            // ONE ROW PER PHYSICAL PIECE that went out. Each is a sent size with
            // an empty roll label he fills in from the cloth; a piece left blank
            // is one the printer lost. State defaults to what was sent.
            var pieces = [];
            (j.sendLines || []).forEach(function (l) {
                var n = Number(l.count) || 0;
                for (var k = 0; k < n; k++) {
                    pieces.push({
                        lineIndex: l.lineIndex,
                        len: l.lengthCm,
                        label: '',
                        state: j.sourceState || 'Wash'
                    });
                }
            });
            printRecvPieces[j.jobId] = pieces;
        }
    });

    return jobs.map(function (j) {
        var open = String(printJobOpenId) === String(j.jobId);
        var pieces = (j.sendLines || []).reduce(function (a, l) { return a + (Number(l.count) || 0); }, 0);

        return '' +
            '<div class="item-card' + (open ? ' open' : '') + '" id="print-job-card-' + j.jobId + '">' +
                '<div class="item-header" onclick="togglePrintJob(\'' + j.jobId + '\')">' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(j.printedName || j.printedSku || '—') + '</h2>' +
                        '<div class="item-meta-line">' +
                            '<span>' + escapeHtml(j.printerName || 'printer not named') + '</span>' +
                            '<span>' + pieces + (pieces === 1 ? ' piece' : ' pieces') +
                                ' &middot; ' + fmt(j.metresSent) + ' Mtr</span>' +
                            '<span>from ' + escapeHtml(j.sourceName || j.sourceSku || '—') +
                                ' &middot; lot ' + escapeHtml(j.sourceLotNumber || '—') +
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
    var mat = printTargetById(job.printedMaterialId);
    var lots = (mat && mat.lots || []).filter(function (l) { return !l.blocked; });

    // The lot NUMBER is what is written on the cloth. TYPED for a new lot, never
    // derived from the job.
    var opts = '<option value="">+ New lot</option>' +
        lots.map(function (l) {
            return '<option value="' + l.lotId + '">' + escapeHtml(l.lotNumber) + '</option>';
        }).join('');

    // ONE ROW PER PIECE. A piece comes back the length it left, so the only
    // things he decides are the ROLL LABEL (from the cloth) and whether it is
    // washed. A row he leaves with no label is a piece the printer lost — the
    // footer tallies those, the row itself just dims.
    var rows = (printRecvPieces[job.jobId] || []).map(function (p, i) {
        var lost = !String(p.label || '').trim();
        return '' +
            '<tr' + (lost ? ' class="recv-piece-lost"' : '') + '>' +
                '<td class="col-num print-derived">' + escapeHtml(p.len) + '</td>' +
                '<td><input type="text" class="note-input" ' +
                    'id="pr-lbl-' + job.jobId + '-' + i + '" value="' + escapeHtml(p.label) + '" ' +
                    'placeholder="roll label on the cloth" ' +
                    'oninput="onRecvPieceChange(\'' + job.jobId + '\')" /></td>' +
                '<td><select class="note-input" id="pr-st-' + job.jobId + '-' + i + '" ' +
                        'onchange="onRecvPieceChange(\'' + job.jobId + '\')">' +
                        '<option value="Wash"' + (p.state === 'Wash' ? ' selected' : '') + '>Washed</option>' +
                        '<option value="Unwash"' + (p.state === 'Unwash' ? ' selected' : '') + '>Unwashed</option>' +
                    '</select></td>' +
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
                    '<th>Roll label &mdash; leave blank if the printer lost it</th>' +
                    '<th>State</th>' +
                    '<th class="col-num">Back?</th>' +
                '</tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
            '</table></div>' +
            '<div class="card-footer" id="pr-foot-' + job.jobId + '">' + recvFooterHtml(job) + '</div>' +
        '</div>';
}

// THE LOSS IS WHOLE PIECES, said in pieces first. A piece with no label did not
// come back, so "3 pieces short" is what he can take to the printer.
function recvFooterHtml(job) {
    var back = recvPiecesBack(job.jobId);
    var lost = recvPiecesLost(job.jobId);
    var returned = recvMetres(job.jobId);
    var loss = Math.round(((Number(job.metresSent) || 0) - returned) * 100) / 100;

    return '' +
        '<span class="sel-count' + (lost > 0 ? ' is-short' : '') + '">' +
            (lost > 0
                ? '<b>' + lost + (lost === 1 ? ' piece' : ' pieces') + ' short</b> &mdash; ' +
                  fmt(loss) + ' Mtr written off'
                : 'All ' + back + ' pieces back &middot; ' + fmt(returned) + ' Mtr') +
        '</span>' +
        '<button type="button" class="primary-btn is-danger" id="pr-cancel-' + job.jobId + '" ' +
            'onclick="submitCancelJob(\'' + job.jobId + '\')">Came back unprinted</button>' +
        '<button type="button" class="primary-btn" id="pr-btn-' + job.jobId + '" ' +
            'onclick="submitReceivePrint(\'' + job.jobId + '\')">Receive</button>';
}

// Length is NOT read from the DOM — it stays on the piece object exactly as the
// job sent it, so nothing here can inflate the returned metres.
function readRecvPieces(jobId) {
    var out = [];
    (printRecvPieces[jobId] || []).forEach(function (p, i) {
        var l = document.getElementById('pr-lbl-' + jobId + '-' + i);
        var s = document.getElementById('pr-st-' + jobId + '-' + i);
        out.push({
            lineIndex: p.lineIndex,
            len: p.len,
            label: l ? l.value : p.label,
            state: s ? s.value : p.state
        });
    });
    return out;
}

function recvPiecesBack(jobId) {
    var t = 0;
    (printRecvPieces[jobId] || []).forEach(function (p) {
        if (String(p.label || '').trim()) t += 1;
    });
    return t;
}

function recvPiecesLost(jobId) {
    var t = 0;
    (printRecvPieces[jobId] || []).forEach(function (p) {
        if (!String(p.label || '').trim()) t += 1;
    });
    return t;
}

// Same trap as the send form: re-rendering the card on every keystroke destroys
// the input being typed in. Only the footer is rewritten (it holds no input).
function onRecvPieceChange(jobId) {
    printRecvPieces[jobId] = readRecvPieces(jobId);
    var job = printJobById(jobId);
    if (!job) return;
    var foot = document.getElementById('pr-foot-' + jobId);
    if (foot) foot.innerHTML = recvFooterHtml(job);
}

function onRecvLotChange(jobId) {
    var sel = document.getElementById('pr-lot-' + jobId);
    var wrap = document.getElementById('pr-num-wrap-' + jobId);
    if (sel && wrap) wrap.style.display = (sel.value === '') ? '' : 'none';
}

function recvMetres(jobId) {
    var t = 0;
    (printRecvPieces[jobId] || []).forEach(function (p) {
        var len = Number(p.len) || 0;
        if (len > 0 && String(p.label || '').trim()) t += len / 100;
    });
    return Math.round(t * 100) / 100;
}

// ---- Send to print ----

// Every fabric that is actually in a lot. Cloth with no lot has no tone and
// cannot be sent — filtered in print-data.js already, so `source` is exactly
// this set; the search narrows it.
function printSourceMatches() {
    var list = (PRINT_DATA && PRINT_DATA.source) || [];
    if (!printFilter) return list;
    return list.filter(function (m) {
        return (m.sku || '').toLowerCase().indexOf(printFilter) !== -1 ||
               (m.name || '').toLowerCase().indexOf(printFilter) !== -1;
    });
}

function printListHtml() {
    var list = printSourceMatches();
    if (!list.length) {
        return '<div class="waste-none">No fabric matches that search.</div>';
    }

    list.forEach(function (m) {
        if (!printSendLines[m.id]) printSendLines[m.id] = [{ len: '', count: '' }];
    });

    return list.map(function (m) {
        var open = String(printOpenId) === String(m.id);
        var lots = m.lots || [];
        var wash = lots.reduce(function (a, l) { return a + (Number(l.wash) || 0); }, 0);
        var unwash = lots.reduce(function (a, l) { return a + (Number(l.unwash) || 0); }, 0);
        var inPrint = lots.reduce(function (a, l) { return a + (Number(l.inPrint) || 0); }, 0);

        var pillHtml = (inPrint > 0)
            ? '<span class="status-pill status-warning">' + fmt(inPrint) + ' at the printer</span>' : '';

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

// SKUs this source can go into: SAME WIDTH, minus itself. The "printed fabric"
// Type filter is OFF for now (server-side too — sendToPrint.dg) — width is the
// only guard, and the store person makes the pairing. `target` first so a
// printed SKU with no stock yet still shows; `source` fills in the rest.
// Deduped by id.
function targetsFor(m) {
    var w = Number(m.widthCm) || 0;
    var seen = {};
    var all = ((PRINT_DATA && PRINT_DATA.target) || [])
        .concat((PRINT_DATA && PRINT_DATA.source) || []);
    return all.filter(function (t) {
        if (String(t.id) === String(m.id)) return false;
        if (seen[t.id]) return false;
        if (Math.abs((Number(t.widthCm) || 0) - w) >= 0.01) return false;
        seen[t.id] = true;
        return true;
    });
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

    var lotOpts = lots.filter(function (l) { return !l.blocked; })
        .map(function (l) {
            return '<option value="' + l.lotId + '">' + escapeHtml(l.lotNumber) + '</option>';
        }).join('');

    var tgts = targetsFor(m);
    var tgtOpts = tgts.length
        ? '<option value="">Choose the printed SKU…</option>' +
          tgts.map(function (t) {
              return '<option value="' + t.id + '">' + escapeHtml(t.sku + ' — ' + t.name) + '</option>';
          }).join('')
        : '<option value="">No fabric on record at ' + fmt(m.widthCm) + ' cm</option>';

    var printerOpts = '<option value="">Choose a printer…</option>' +
        ((PRINT_DATA && PRINT_DATA.printers) || []).map(function (p) {
            return '<option value="' + p.id + '">' + escapeHtml(p.name) + '</option>';
        }).join('');

    return '' +
        '<div class="item-body">' +
            lotTable +
            '<div class="print-form">' +
                '<label class="si-field"><span>Lot</span>' +
                    '<select id="ps-lot-' + m.id + '" class="note-input" onchange="onSendControlChange(\'' + m.id + '\')">' +
                        lotOpts + '</select></label>' +
                '<label class="si-field"><span>Send</span>' +
                    '<select id="ps-state-' + m.id + '" class="note-input" onchange="onSendControlChange(\'' + m.id + '\')">' +
                        '<option value="Wash">Washed</option>' +
                        '<option value="Unwash">Unwashed</option>' +
                    '</select></label>' +
                '<label class="si-field"><span>Printed SKU</span>' +
                    '<select id="ps-tgt-' + m.id + '" class="note-input">' + tgtOpts + '</select></label>' +
                '<label class="si-field"><span>Printer</span>' +
                    '<select id="ps-printer-' + m.id + '" class="note-input">' + printerOpts + '</select></label>' +
            '</div>' +
            '<div id="ps-lines-' + m.id + '">' + printLinesHtml(m) + '</div>' +
            '<div id="ps-plan-' + m.id + '">' + rollPlanHtml(m) + '</div>' +
            '<div class="card-footer print-send-footer" id="ps-foot-' + m.id + '">' + sendFooterHtml(m) + '</div>' +
        '</div>';
}

// ONE ROW PER PIECE SIZE — a length and a count. He is cutting full-width pieces
// off the roll and the only thing that varies is how long each one is.
//
// NO CUT-LENGTH SCORING. Printing is TO STOCK: at send time there is no cut
// length (that cloth may serve several garments), and the piece length is fixed
// by the printer's table anyway. The real yield is computed at ISSUE. Do not put
// it back.
function printLinesHtml(m) {
    var lines = printSendLines[m.id] || [];

    var rows = lines.map(function (r, i) {
        return '' +
            '<tr>' +
                '<td><input type="number" step="1" min="1" class="issue-input" ' +
                    'id="ps-len-' + m.id + '-' + i + '" value="' + escapeHtml(r.len) + '" ' +
                    'oninput="onSendLineInput(\'' + m.id + '\')" /></td>' +
                '<td><input type="number" step="1" min="0" class="issue-input" ' +
                    'id="ps-cnt-' + m.id + '-' + i + '" value="' + escapeHtml(r.count) + '" ' +
                    'oninput="onSendLineInput(\'' + m.id + '\')" /></td>' +
                '<td class="col-num print-derived" id="ps-mtr-' + m.id + '-' + i + '">' +
                    lineMetresText(r) + '</td>' +
                '<td><button type="button" class="raise-btn is-stale" ' +
                    'onclick="removeSendLine(\'' + m.id + '\',' + i + ')">Remove</button></td>' +
            '</tr>';
    }).join('');

    return '' +
        '<div class="table-wrapper"><table>' +
            '<thead><tr>' +
                '<th class="col-num">Piece length (cm)</th>' +
                '<th class="col-num">How many</th>' +
                '<th class="col-num">Metres</th>' +
                '<th></th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
        '<div class="print-lines-foot">' +
            '<button type="button" class="raise-btn" onclick="addSendLine(\'' + m.id + '\')">+ Another size</button>' +
            '<span class="print-lines-total">Fabric used: <b id="ps-total-' + m.id + '">' +
                fmt(sendMetres(m.id)) + '</b> Mtr</span>' +
        '</div>';
}

function lineMetresText(r) {
    var len = Number(r.len) || 0, cnt = Number(r.count) || 0;
    return (len > 0 && cnt > 0) ? fmt((len * cnt) / 100) + ' Mtr' : '—';
}

// WHICH ROLLS TO CUT — auto-planned shortest-first against the chosen lot, and
// editable. If he leaves it untouched the payload omits rollPlan and the server
// plans it identically. If he edits, the payload carries the plan and the server
// validates Σ == metres.
function rollPlanHtml(m) {
    var lot = sendLot(m);
    if (!lot) return '';
    var total = sendMetres(m.id);
    if (total <= 0) return '';

    var plan = autoRollPlan(m);
    if (!plan.length) {
        return '<div class="lot-dry">Lot ' + escapeHtml(lot.lotNumber) +
            ' has no cuttable rolls — nothing can be sent.</div>';
    }

    var over = m.id in printSendPlan ? manualPlanSum(m.id) : total;
    var mismatch = Math.abs(over - total) > 0.01;

    var rows = plan.map(function (p) {
        var val = (printSendPlan[m.id] && printSendPlan[m.id][p.rollId] != null)
            ? printSendPlan[m.id][p.rollId] : fmt(p.metres);
        var rollName = (p.label || '').indexOf(lot.lotNumber) === 0
            ? p.label : (lot.lotNumber + ' · ' + (p.label || 'roll'));
        return '' +
            '<tr>' +
                '<td class="material-name-cell"><div class="mat-name">' + escapeHtml(rollName) + '</div>' +
                    '<div class="mat-sku">' + fmt(p.rollLength) + ' Mtr on this roll</div></td>' +
                '<td class="col-num"><input type="number" step="0.01" min="0" class="issue-input" ' +
                    'id="ps-roll-' + m.id + '-' + p.rollId + '" value="' + escapeHtml(val) + '" ' +
                    'oninput="onRollPlanInput(\'' + m.id + '\')" /></td>' +
            '</tr>';
    }).join('');

    return '' +
        '<div class="print-plan">' +
            '<div class="print-plan-head">Cut plan &mdash; shortest roll first' +
                (m.id in printSendPlan
                    ? ' <span class="print-plan-tag is-edited">edited</span>'
                    : ' <span class="print-plan-tag">auto</span>') +
            '</div>' +
            '<div class="table-wrapper"><table>' +
                '<thead><tr><th>Roll to cut</th><th class="col-num">Cut (Mtr)</th></tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
            '</table></div>' +
            '<div class="print-plan-foot">' +
                '<span class="sel-count' + (mismatch ? ' is-short' : '') + '">' +
                    'plan totals ' + fmt(over) + ' Mtr of ' + fmt(total) + ' Mtr needed' +
                    (mismatch ? ' &mdash; <b>these must match</b>' : '') +
                '</span>' +
                (m.id in printSendPlan
                    ? '<button type="button" class="raise-btn is-stale" onclick="resetRollPlan(\'' + m.id + '\')">Back to auto</button>'
                    : '') +
            '</div>' +
        '</div>';
}

// The lot's side of the sum and the over-draw check. What THIS send uses is the
// "Fabric used" total under the size lines; this line is what the lot holds.
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
    (printSendLines[matId] || []).forEach(function (r, i) {
        var l = document.getElementById('ps-len-' + matId + '-' + i);
        var c = document.getElementById('ps-cnt-' + matId + '-' + i);
        out.push({ len: l ? l.value : r.len, count: c ? c.value : r.count });
    });
    return out;
}

function sendMetres(matId) {
    var t = 0;
    (printSendLines[matId] || []).forEach(function (r) {
        var len = Number(r.len) || 0, c = Number(r.count) || 0;
        if (len > 0 && c > 0) t += (len * c) / 100;
    });
    return Math.round(t * 100) / 100;
}

// The chosen lot object off the chosen source material.
function sendLot(m) {
    var lotEl = document.getElementById('ps-lot-' + m.id);
    var want = lotEl ? lotEl.value : (printSendLot[m.id] || '');
    // Default to the first NON-BLOCKED lot — the <select> only lists those, so
    // falling back to lots[0] (which may be blocked) would let the availability
    // line and cut plan describe a lot Submit can never send off.
    if (!want) {
        var first = (m.lots || []).filter(function (l) { return !l.blocked; })[0];
        if (first) want = first.lotId;
    }
    var lot = null;
    (m.lots || []).forEach(function (l) { if (String(l.lotId) === String(want)) lot = l; });
    return lot;
}

// What the CHOSEN counter of the CHOSEN lot holds.
function sendAvailable(m) {
    var lot = sendLot(m);
    if (!lot) return 0;
    var stEl = document.getElementById('ps-state-' + m.id);
    var st = stEl ? stEl.value : (printSendState[m.id] || 'Wash');
    return Number(st === 'Unwash' ? lot.unwash : lot.wash) || 0;
}

// Shortest Available roll first, drain each in full toward the metres needed.
// Mirrors sendToPrint.dg's auto path: sort by length ascending, and a tie is
// broken by ORIGINAL POSITION (a stable sort keeps first-seen first) — the .dg
// does the same, deliberately avoiding a string comparison it cannot verify.
function autoRollPlan(m) {
    var lot = sendLot(m);
    if (!lot) return [];
    var avail = (lot.rolls || []).filter(function (r) {
        return r.status === 'Available' && (Number(r.length) || 0) > 0;
    });
    var rolls = avail.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) {
        var d = (Number(a.r.length) || 0) - (Number(b.r.length) || 0);
        return d !== 0 ? d : a.i - b.i;
    }).map(function (x) { return x.r; });

    var need = sendMetres(m.id);
    var out = [];
    rolls.forEach(function (r) {
        if (need <= 0.001) return;
        var take = Math.min(Number(r.length) || 0, need);
        out.push({ rollId: r.rollId, label: r.label, metres: Math.round(take * 100) / 100,
                   rollLength: Number(r.length) || 0 });
        need -= take;
    });
    return out;
}

function manualPlanSum(matId) {
    var t = 0;
    var p = printSendPlan[matId] || {};
    Object.keys(p).forEach(function (k) { t += Number(p[k]) || 0; });
    return Math.round(t * 100) / 100;
}

// TYPING MUST NOT REBUILD THE INPUT BEING TYPED IN. Only derived things are
// written, each addressed by id: the per-line metres cell, the "Fabric used"
// box, the send footer, and the roll-plan block (which holds inputs, so it is
// only rebuilt on structural changes — a line add/remove or a lot/state switch,
// never a keystroke inside it).
function onSendLineInput(matId) {
    printSendLines[matId] = readSendLines(matId);
    var m = printSourceById(matId);
    if (!m) return;

    printSendLines[matId].forEach(function (r, i) {
        var cell = document.getElementById('ps-mtr-' + matId + '-' + i);
        if (cell) cell.textContent = lineMetresText(r);
    });
    var totalBox = document.getElementById('ps-total-' + matId);
    if (totalBox) totalBox.textContent = fmt(sendMetres(matId));
    var foot = document.getElementById('ps-foot-' + matId);
    if (foot) foot.innerHTML = sendFooterHtml(m);

    // The line's metres changed, so the auto plan changed. Rebuilding the plan
    // block is safe here — the caret is in a LINE input, not a plan input.
    // Drop any manual override: it was against a different total.
    delete printSendPlan[matId];
    var planBox = document.getElementById('ps-plan-' + matId);
    if (planBox) planBox.innerHTML = rollPlanHtml(m);
}

function onRollPlanInput(matId) {
    var m = printSourceById(matId);
    if (!m) return;
    var plan = autoRollPlan(m);
    var store = {};
    plan.forEach(function (p) {
        var el = document.getElementById('ps-roll-' + matId + '-' + p.rollId);
        store[p.rollId] = el ? el.value : String(p.metres);
    });
    printSendPlan[matId] = store;

    // Only the total line under the plan is derived; the inputs stay put.
    var planBox = document.getElementById('ps-plan-' + matId);
    if (planBox) {
        var total = sendMetres(matId);
        var sum = manualPlanSum(matId);
        var mismatch = Math.abs(sum - total) > 0.01;
        var note = planBox.querySelector('.sel-count');
        if (note) {
            note.className = 'sel-count' + (mismatch ? ' is-short' : '');
            note.innerHTML = 'plan totals ' + fmt(sum) + ' Mtr of ' + fmt(total) + ' Mtr needed' +
                (mismatch ? ' &mdash; <b>these must match</b>' : '');
        }
    }
}

function resetRollPlan(matId) {
    delete printSendPlan[matId];
    var m = printSourceById(matId);
    var planBox = document.getElementById('ps-plan-' + matId);
    if (m && planBox) planBox.innerHTML = rollPlanHtml(m);
}

// A lot or state switch changes availability AND the roll set the plan is built
// from — rebuild the plan block and clear any override.
function onSendControlChange(matId) {
    var m = printSourceById(matId);
    if (!m) return;
    var lotEl = document.getElementById('ps-lot-' + matId);
    var stEl = document.getElementById('ps-state-' + matId);
    if (lotEl) printSendLot[matId] = lotEl.value;
    if (stEl) printSendState[matId] = stEl.value;
    delete printSendPlan[matId];

    var foot = document.getElementById('ps-foot-' + matId);
    if (foot) foot.innerHTML = sendFooterHtml(m);
    var planBox = document.getElementById('ps-plan-' + matId);
    if (planBox) planBox.innerHTML = rollPlanHtml(m);
}

// Adding or removing a line rebuilds the table — safe, a button press is not a
// caret in a field.
function rerenderSendLines(matId) {
    var m = printSourceById(matId);
    if (!m) return;
    delete printSendPlan[matId];
    var linesBox = document.getElementById('ps-lines-' + matId);
    if (linesBox) linesBox.innerHTML = printLinesHtml(m);
    var planBox = document.getElementById('ps-plan-' + matId);
    if (planBox) planBox.innerHTML = rollPlanHtml(m);
    var foot = document.getElementById('ps-foot-' + matId);
    if (foot) foot.innerHTML = sendFooterHtml(m);
}

function addSendLine(matId) {
    printSendLines[matId] = readSendLines(matId);
    printSendLines[matId].push({ len: '', count: '' });
    rerenderSendLines(matId);
}

function removeSendLine(matId, idx) {
    var rows = readSendLines(matId);
    rows.splice(idx, 1);
    if (!rows.length) rows.push({ len: '', count: '' });
    printSendLines[matId] = rows;
    rerenderSendLines(matId);
}

function submitSendToPrint(matId) {
    var m = printSourceById(matId);
    if (!m) return;

    var lotEl = document.getElementById('ps-lot-' + matId);
    var stEl = document.getElementById('ps-state-' + matId);
    var tgtEl = document.getElementById('ps-tgt-' + matId);
    var prEl = document.getElementById('ps-printer-' + matId);
    var btn = document.getElementById('ps-btn-' + matId);
    if (!btn) return;

    if (!lotEl || !lotEl.value) { alert('Choose which lot the cloth comes off.'); return; }
    if (!tgtEl || !tgtEl.value) { alert('Choose the printed SKU it becomes.'); return; }
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

    if (sendMetres(matId) > sendAvailable(m) + 0.0001) {
        alert('That is more cloth than the lot holds in that state.');
        return;
    }

    // The roll plan: send it only if he edited it. An edited plan must total the
    // metres exactly, or the server rejects it — catch it here first.
    var rollPlan = null;
    if (matId in printSendPlan) {
        var auto = autoRollPlan(m);
        rollPlan = auto.map(function (p) {
            var v = printSendPlan[matId][p.rollId];
            return { rollId: p.rollId, label: p.label, metres: Number(v) || 0 };
        }).filter(function (p) { return p.metres > 0; });
        var sum = rollPlan.reduce(function (a, p) { return a + p.metres; }, 0);
        if (Math.abs(sum - sendMetres(matId)) > 0.01) {
            alert('The cut plan totals ' + fmt(sum) + ' Mtr but the pieces need ' +
                  fmt(sendMetres(matId)) + ' Mtr. Fix the plan or press "Back to auto".');
            return;
        }
    }

    btn.disabled = true;
    btn.textContent = 'Sending…';

    var payload = {
        sourceMaterialId: matId,
        sourceLotId: lotEl.value,
        sourceState: stEl ? stEl.value : 'Wash',
        targetMaterialId: tgtEl.value,
        printerId: prEl.value,
        lines: lines,
        remarks: ''
    };
    if (rollPlan) payload.rollPlan = rollPlan;

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'sendToPrint',
        http_method: 'POST',
        payload: { payloadJson: JSON.stringify(payload) }
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }

        if (!parsed || !parsed.success) {
            alert('Could not send it: ' + ((parsed && parsed.error) || 'unknown error'));
            btn.disabled = false;
            btn.textContent = 'Send to print';
            return;
        }

        printSendLines[matId] = [{ len: '', count: '' }];
        delete printSendPlan[matId];
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

    if (creating) {
        var mat = printTargetById(job.printedMaterialId);
        var taken = (mat && mat.lots || []).some(function (l) {
            return String(l.lotNumber || '').trim().toUpperCase() === lotNum.toUpperCase();
        });
        if (taken) { alert('That material already has a lot ' + lotNum + '.'); return; }
    }

    // ONE PIECE = ONE ROLL. The payload is pieces[] — a returned piece is one
    // that has a roll label. `lineIndex` says which sent size it is; the server
    // takes the LENGTH from its own Send_Lines and caps the count per size at
    // what went out. Labels must be non-empty and distinct within the receipt.
    var pieces = [];
    var seen = {};
    var bad = '';
    readRecvPieces(jobId).forEach(function (p) {
        var label = String(p.label || '').trim();
        if (!label) return;                       // no label = the printer lost it
        if (p.state !== 'Wash' && p.state !== 'Unwash') {
            bad = 'Say whether each returned piece is washed or unwashed.';
            return;
        }
        var key = label.toUpperCase();
        if (seen[key]) { bad = 'Roll label "' + label + '" is used twice.'; return; }
        seen[key] = true;
        pieces.push({ lineIndex: p.lineIndex, label: label, state: p.state });
    });
    if (bad) { alert(bad); return; }
    if (!pieces.length) {
        alert('No roll labels entered. If the whole run is lost, use "Came back unprinted".');
        return;
    }

    var lostPieces = recvPiecesLost(jobId);
    if (lostPieces > 0 &&
        !confirm(lostPieces + (lostPieces === 1 ? ' piece' : ' pieces') +
                 ' did not come back.\n\nThat cloth is written off against ' +
                 (job.sourceName || 'the source material') + ' and cannot be put back. Continue?')) {
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
                pieces: pieces,
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

        delete printRecvPieces[jobId];
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

    if (!confirm(fmt(job.metresSent) + ' Mtr of cut pieces go back onto lot ' +
                 (job.sourceLotNumber || '') + ' as a new roll (' +
                 (job.sourceState === 'Unwash' ? 'unwashed' : 'washed') +
                 ').\n\nUse this only if the printer returned it unprinted.')) {
        return;
    }
    var reason = prompt('Why did it come back unprinted?', '');
    if (reason === null) return;

    var btn = document.getElementById('pr-cancel-' + jobId);
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'cancelPrintJob',
        http_method: 'POST',
        payload: { payloadJson: JSON.stringify({ jobId: jobId, reason: reason }) }
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch (e) { parsed = null; }

        if (!parsed || !parsed.success) {
            alert('Could not cancel it: ' + ((parsed && parsed.error) || 'unknown error'));
            if (btn) { btn.disabled = false; btn.textContent = 'Came back unprinted'; }
            return;
        }
        delete printRecvPieces[jobId];
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
