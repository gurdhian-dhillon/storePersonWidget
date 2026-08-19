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

// Lots that could take an order, for the override dialog: something in them, and
// not quarantined. Greige counts — a lot with cloth at the wash house is a real
// candidate, it simply cannot go out today.
function usableLots(material) {
    return lotsFor(material).filter(function (l) {
        return !l.blocked &&
            ((Number(l.wash) || 0) + (Number(l.unwash) || 0) +
                (Number(l.inWash) || 0)) > 0;
    });
}

// ---- Lot allocation: waste and fresh cloth together ----
//
// A REMNANT CARRIES THE TONE OF THE LOT IT WAS CUT FROM. So waste is not a
// separate, fungible pool that offsets the requirement before a lot is chosen —
// it is part of what each lot can offer, and choosing the lot and choosing the
// remnants is ONE decision. That is why this lives here and not in Deluge: the
// fresh allocator is here, and splitting the two is what let an order be cut
// from L3 cloth and an L2 offcut in the same breath.
//
// THE RULE, per supervisor and material:
//   1. an order that already has cloth is PINNED to that lot — no choice left
//   2. otherwise the smallest lot that can FINISH the order
//   3. failing that, the fewest lots, and the order is flagged as multi-tone
//
// "Finish" counts waste + washed + greige. Greige because it can be washed, and
// a lot picked on today's washed stock alone gets pinned to an order it can only
// half-complete — which is the failure the pin exists to prevent, arriving by a
// different road.

// How many cut pieces one remnant yields. Grain is fixed: the cut width runs
// across the piece width and the length along its length, never rotated, so a
// remnant narrower than the cut is useless however long it is.
function remnantYield(r, cutW, cutL) {
    var w = Number(r.width) || 0;
    var l = Number(r.length) || 0;
    if (!(cutW > 0 && cutL > 0) || w < cutW || l < cutL) return 0;
    return Math.floor(w / cutW) * Math.floor(l / cutL);
}

// Marker rows across the cloth for one cut size.
function perRowFor(fab, cutW) {
    var w = Number(fab.fabricWidthCm) || 0;
    var cw = Number(cutW) || 0;
    if (!(w > 0 && cw > 0 && w >= cw)) return 0;
    return Math.floor(w / cw);
}

// WHAT ONE LOT CAN DO against a set of demands, simulated rather than compared.
//
// Simulated for the same reason the fresh allocator simulates: a lot's usable
// yield is not its metres. Its remnants fit only some cut sizes, and its cloth
// comes off only in whole marker rows.
//
// `greige` selects which question is being asked:
//   false — what this lot can give TODAY (waste + washed)
//   true  — what it could give with its greige washed, which is what "can this
//           lot finish the order" has to mean
//
// WASTE BEFORE FRESH, always. A remnant is already paid for and one left to age
// becomes scrap; cloth on the roll keeps.
//
// Demands are {cutW, cutL, pieces}. Nothing passed in is mutated.
function lotFill(lot, demands, fab, greige) {
    var rem = (lot.waste || []).map(function (r) {
        return {
            wasteId: r.wasteId, width: r.width, length: r.length,
            pieces: Number(r.pieces) || 0
        };
    });
    var metres = round2(Number(lot.wash) || 0);
    if (greige) metres = round2(metres + (Number(lot.unwash) || 0));

    var owed = demands.map(function (d) { return Math.max(0, Number(d.pieces) || 0); });
    var fromWaste = demands.map(function () { return 0; });
    var fromFresh = demands.map(function () { return 0; });
    var picks = {};
    var freshMetres = 0;
    // Per demand as well as in total. The payload names the plan item each lot
    // line and each remnant serves, so the server no longer has to guess the
    // mapping from fan order — which is how an order came to straddle two lots.
    var metresPer = demands.map(function () { return 0; });
    var picksPer = demands.map(function () { return {}; });

    // ---- 1. remnants, least waste per cut obtained ----
    //
    // Least-waste-area rather than first-fit, so a snug remnant is spent before
    // a large one and big stock is protected: a 300x400 cut into 187x137 throws
    // away 68,762 cm2 for two pieces where a 200x300 throws away 8,762.
    var guard = 0;
    while (guard++ < 400) {
        var bi = -1, br = -1, bScore = 0, bCap = 0;
        demands.forEach(function (d, i) {
            if (owed[i] <= 0) return;
            rem.forEach(function (r, ri) {
                if (r.pieces <= 0) return;
                var cap = remnantYield(r, d.cutW, d.cutL);
                if (cap <= 0) return;
                var take = Math.min(cap, owed[i]);
                var score = ((r.width * r.length) - (take * d.cutW * d.cutL)) / take;
                if (bi < 0 || score < bScore) { bi = i; br = ri; bScore = score; bCap = cap; }
            });
        });
        if (bi < 0) break;

        var use = Math.min(Math.ceil(owed[bi] / bCap), rem[br].pieces);
        var got = Math.min(use * bCap, owed[bi]);
        rem[br].pieces -= use;
        owed[bi] -= got;
        fromWaste[bi] += got;
        picks[rem[br].wasteId] = (picks[rem[br].wasteId] || 0) + use;
        picksPer[bi][rem[br].wasteId] = (picksPer[bi][rem[br].wasteId] || 0) + use;
    }

    // ---- 2. fresh cloth, in whole marker rows ----
    demands.forEach(function (d, i) {
        if (owed[i] <= 0) return;
        var pr = perRowFor(fab, d.cutW);
        var cl = Number(d.cutL) || 0;
        if (pr <= 0 || cl <= 0) return;
        var rows = Math.min(Math.ceil(owed[i] / pr),
            Math.floor((metres * 100 + 0.0001) / cl));
        if (rows <= 0) return;
        var m = round2((rows * cl) / 100);
        metres = round2(metres - m);
        freshMetres = round2(freshMetres + m);
        metresPer[i] = round2(metresPer[i] + m);
        var got2 = Math.min(rows * pr, owed[i]);
        owed[i] -= got2;
        fromFresh[i] += got2;
    });

    return {
        picks: picks,
        fromWaste: fromWaste,
        fromFresh: fromFresh,
        freshMetres: freshMetres,
        metresPer: metresPer,
        picksPer: picksPer,
        // Nothing still owing means this lot could serve the whole set alone.
        covers: owed.every(function (n) { return n <= 0; }),
        shortBy: owed.reduce(function (a, b) { return a + Math.max(0, b); }, 0)
    };
}

// WHICH LOT AN UNPINNED ORDER SHOULD COME OFF.
//
// THE ORDER IS THE ATOM: only a lot that covers it WHOLE is a candidate. A lot
// that could take half of it is not a weaker version of a good answer, it is the
// wrong answer — cloth burned on an order that then cannot be finished in that
// shade, while the next order, which that lot could have completed, goes
// without. An order nothing covers is skipped, not split and not part-served.
//
// TWO TIERS, and greige never counts as available today:
//
//   1. lots that cover it off the rack NOW — washed cloth plus that lot's own
//      offcuts. Ranking these below a smaller greige-only lot is what had the
//      screen asking for a wash while ready cloth sat beside it.
//   2. failing that, lots that cover it once their OWN greige is washed. Nothing
//      goes out today; the wash line says what to send.
//
// Smallest within each tier, so big lots stay whole for the big orders that will
// need them — nibbling the largest leaves a medium lot where a large one stood
// and makes the next order likelier to be short.
//
// A blocked lot is quarantined cloth and is never a candidate, though it is
// still named on the row so "nothing on the rack" cannot be said over cloth he
// is looking at.
//
// Returns null when no lot covers the order, `{lot, ready}` otherwise.
function chooseLotForOrder(lots, demands, fab) {
    var today = [], afterWash = [];
    lots.forEach(function (l) {
        if (l.blocked) return;
        if (lotFill(l, demands, fab, false).covers) { today.push(l); return; }
        if (lotFill(l, demands, fab, true).covers) afterWash.push(l);
    });

    var smallest = function (list) {
        var best = null, bestSize = 0;
        list.forEach(function (l) {
            var size = round2((Number(l.wash) || 0) + (Number(l.unwash) || 0));
            if (best === null || size < bestSize) { best = l; bestSize = size; }
        });
        return best;
    };

    if (today.length > 0) return { lot: smallest(today), ready: true };
    if (afterWash.length > 0) return { lot: smallest(afterWash), ready: false };
    return null;
}

// WHAT ONE ORDER ASKS FOR IN METRES, ignoring what is on the rack.
//
// Used only to say "the smallest job here needs 22" on a row where nothing
// fits. Offcut-blind and lot-blind on purpose: it is the size of the job, not an
// allocation, and quoting a figure that moved with the rack would not answer the
// question he is asking.
function orderMetres(demands, fab) {
    var t = 0;
    demands.forEach(function (d) {
        var pr = perRowFor(fab, d.cutW);
        var cl = Number(d.cutL) || 0;
        if (pr <= 0 || cl <= 0) return;
        t += (Math.ceil(d.pieces / pr) * cl) / 100;
    });
    return round2(t);
}

// DELIBERATE TONE OVERRIDES.
//
// An order pinned to a lot that has run dry cannot be finished in its original
// tone, and no rule can decide what to do about it — only someone holding a
// finished piece against the new cloth can. So the screen offers him the choice,
// and this is where his answer is kept.
//
// Keyed on the SUPERVISOR id and not the card index: a refresh re-orders the
// cards, and an override that moved to another supervisor's row would be worse
// than none at all.
//
// Offered ONLY when the pinned lot is dry. On any pinned row it would erode the
// guarantee by being easier than asking why — the whole value of the pin is that
// breaking it is a decision somebody made and can be asked about.
var lotOverrides = {};

// REMNANTS HE HAS DECLINED, or reduced the count on. wasteId -> pieces he will
// take (0 = none).
//
// This has to feed the ALLOCATION, not just the payload. The fresh metres are
// sized from the pieces offcuts do not cover, so declining a remnant after the
// fact left the row sending cloth for 16 pieces against a demand of 20 — four
// short, silently, because the metres box still held the figure that assumed the
// offcut. Untick it and the cloth has to make up the difference.
var wasteDeclined = {};

function wasteAllowed(wasteId, onRack) {
    var cap = wasteDeclined[String(wasteId)];
    if (cap === undefined) return onRack;
    return Math.max(0, Math.min(onRack, cap));
}

function overrideKey(supId, materialId, orderId) {
    return String(supId) + '|' + String(materialId) + '|' + String(orderId);
}

function lotOverrideFor(supId, materialId, orderId) {
    return lotOverrides[overrideKey(supId, materialId, orderId)] || null;
}

// ---- Tone override: issuing an order off a lot it did not start on ----
//
// Reached only from a row whose pinned lot has run dry. He is being asked to
// accept a visible mismatch, so the dialog states what it costs, makes him pick
// the replacement himself, and requires a reason — the next person to look at
// this order should not have to reconstruct the judgement.

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
function applyLotAllocation(data) {
    (data || []).forEach(function (sup) {
        // ONE LEDGER PER SUPERVISOR — NEVER ONE SHARED BETWEEN THEM.
        //
        // Shared, these three stopped being a working total and became a
        // RESERVATION. Cards are walked in priority order, so the first
        // supervisor spent the rack and the last was measured against what he
        // left: his rows read "no lot holds enough" while twenty metres sat on
        // the shelf with nobody's name on it, under a header still saying "All
        // in stock". The store person could not issue to him at all.
        //
        // Priority is the order to SERVE people in. It is not permission to be
        // served, and the screen must never refuse a handover the store person
        // wants to make — he can see the rack and we cannot. A hard reservation
        // ledger was considered for this app and rejected; this was it, rebuilt
        // by accident inside the allocator.
        //
        // Contested stock is SAID instead of enforced ("Also needed by …"), and
        // settled where it can actually be settled: issueMaterials re-checks
        // every lot server-side. Two cards may therefore offer the same metres
        // and the same offcut, and whoever is issued second gets what is really
        // left. That is honest; pre-emptying him was not.
        //
        // Within one card they still do their real job, and it is not optional:
        // one Issue press serves the whole card, so two orders or two cut sizes
        // of the same supervisor must not promise the same cloth twice.
        var wasteLeft = {};    // wasteId -> pieces unclaimed ON THIS CARD
        var lotLeft = {};      // materialId|lotId -> washed metres, this card
        // GREIGE IS SPENT TOO, and forgetting it was a real hole: an order that
        // picks a lot because its greige can finish it has spoken for that
        // greige at the wash house. Track only the washed metres and the card's
        // next order is told the same pile will finish it as well.
        var greigeLeft = {};   // materialId|lotId -> unwashed metres, this card

        // The server sends the true rack figure to EVERY card — it does not
        // divide stock between them — so seeding from the card in hand is the
        // whole rack, which is exactly what this supervisor could be given if
        // the store person served him first.
        (sup.materials || []).forEach(function (m) {
            if (!m.isFabric) return;
            (m.wasteStock || []).forEach(function (r) {
                if (wasteLeft[r.wasteId] === undefined) {
                    wasteLeft[r.wasteId] = wasteAllowed(r.wasteId, Number(r.pieces) || 0);
                }
            });
            (m.lots || []).forEach(function (l) {
                var k = String(m.materialId) + '|' + l.lotId;
                if (lotLeft[k] === undefined) lotLeft[k] = round2(Number(l.wash) || 0);
                if (greigeLeft[k] === undefined) greigeLeft[k] = round2(Number(l.unwash) || 0);
            });
        });

        var done = {};
        (sup.materials || []).forEach(function (m) {
            if (!m.isFabric) return;
            var key = String(m.materialId);
            if (done[key]) return;
            done[key] = true;
            allocateMaterial(sup, key, wasteLeft, lotLeft, greigeLeft);
        });
    });
}

// One supervisor, one material: every cut size and both Plan and Reissue rows,
// allocated together so two rows cannot promise the same cloth.
function allocateMaterial(sup, materialId, wasteLeft, lotLeft, greigeLeft) {
    var rows = [];
    (sup.materials || []).forEach(function (m, i) {
        if (m.isFabric && String(m.materialId) === materialId) rows.push({ m: m, idx: i });
    });
    if (rows.length === 0) return;

    var m0 = rows[0].m;
    var fab = { fabricWidthCm: m0.fabricWidthCm };

    // EACH LOT CARRIES ONLY ITS OWN REMNANTS. This is the whole change: an
    // offcut cut from L2 is L2's tone, so it is part of what L2 can offer and of
    // nothing else. Remnants with no lot recorded belong to no lot's capacity —
    // they predate the field and there is no honest way to place them.
    var lots = (m0.lots || []).map(function (l) {
        var lk = materialId + '|' + l.lotId;
        return {
            lotId: String(l.lotId),
            lotNumber: l.lotNumber,
            // QUARANTINED CLOTH IS NOT A CANDIDATE, BUT IT IS STILL CLOTH.
            // Dropping blocked lots entirely is what had a row saying "nothing on
            // the rack" while he stood in front of eighteen metres of it. Carried
            // through so the row can name it, never allocated from.
            blocked: !!l.blocked,
            wash: lotLeft[lk] !== undefined ? lotLeft[lk] : round2(Number(l.wash) || 0),
            unwash: greigeLeft[lk] !== undefined ? greigeLeft[lk] : round2(Number(l.unwash) || 0),
            // Carried but never allocatable. Cloth at the wash house cannot be
            // issued today, yet the lot is plainly NOT finished — it comes back
            // washed, in this tone. A pin must survive it.
            inWash: round2(Number(l.inWash) || 0),
            waste: (m0.wasteStock || []).filter(function (r) {
                return r.lotId && String(r.lotId) === String(l.lotId) &&
                    (wasteLeft[r.wasteId] || 0) > 0;
            }).map(function (r) {
                return {
                    wasteId: r.wasteId, width: r.width, length: r.length,
                    pieces: wasteLeft[r.wasteId], carton: r.carton, lot: r.lot
                };
            })
        };
    });

    // DEMAND, ONE ENTRY PER LINE, GROUPED BY ORDER.
    //
    // The order is the tone boundary: a hundred covers of one product must match,
    // and an order's several items should too. The line is the finest grain we
    // can address on the server, so allocation happens per order and the answer
    // is recorded per line.
    var byOrder = {}, orderSeq = [];

    // PASS 1 — THE PIN, READ FROM EVERY LINE INCLUDING SETTLED ONES.
    //
    // Separate from the demand pass below, and that is the whole point. A line
    // that owes nothing is not demand, but it is still the record of which lot
    // this order was cut from — and in the ORDINARY remake it is the ONLY
    // record. The original hundred are finished and settled, three get ruined,
    // and the remake arrives as a new Plan_Item owing four.
    //
    // Reading the pin inside the demand pass skipped the settled original, left
    // the order unpinned, and sent the remake to whichever lot happened to be
    // smallest. Four replacement pieces in a different shade to the ninety-six
    // they sit beside — the exact defect the pin exists to prevent, reached by
    // the one path that matters most.
    var pinOf = {}, pinNoOf = {};
    var origPin = {};
    rows.forEach(function (rw) {
        (rw.m.lines || []).forEach(function (ln) {
            if (!ln.issuedLot) return;
            var oid = String(ln.planId || '');
            if (!pinOf[oid]) {
                pinOf[oid] = String(ln.issuedLot);
                pinNoOf[oid] = String(ln.issuedLotNo || ln.issuedLot);
            }
        });
    });

    // A deliberate override replaces the pin. The ORIGINAL is kept alongside it:
    // the row still has to say which tone this order started in, and the
    // handover records both so the disagreement is the evidence a human chose.
    Object.keys(pinOf).forEach(function (oid) { origPin[oid] = pinOf[oid]; });

    // PASS 2 — the demand itself, from lines that still owe something.
    rows.forEach(function (rw) {
        (rw.m.lines || []).forEach(function (ln) {
            var owed = (Number(ln.reqPieces) || 0) - (Number(ln.issPieces) || 0);
            if (owed <= 0) return;
            var oid = String(ln.planId || '');
            if (!byOrder[oid]) {
                byOrder[oid] = {
                    demands: [], pin: pinOf[oid] || '',
                    pinNo: pinNoOf[oid] || '',
                    origPin: origPin[oid] || '', note: '',
                    oid: oid
                };
                orderSeq.push(oid);
            }
            byOrder[oid].demands.push({
                rowIdx: rw.idx,
                // THE ORDER, carried through to the payload. The server can then
                // check one-lot-per-order itself instead of trusting that this
                // side got it right — a Custom API is callable from anywhere, and
                // the guarantee is worth exactly as much as its weakest caller.
                planId: oid,
                planItemId: String(ln.planItemId || ''),
                cutW: rw.m.cutWidth,
                cutL: rw.m.cutLength,
                pieces: owed
            });
        });
    });

    // Results per screen row, in the shape the render and submit paths expect.
    var res = {};
    var waitingWash = {};
    rows.forEach(function (rw) {
        res[rw.idx] = {
            picks: {}, lotLines: [], fromWaste: 0, fromFresh: 0,
            freshMetres: 0, owed: 0,
            washLotId: '', washLotNumber: '', washQty: 0,
            // EVERY lot this row is waiting on, not the last one
            // written. One row carries several orders and each picks
            // its own lot, so two of them can be waiting on two
            // different piles of greige — and a single field kept
            // whichever order happened to be processed last. The
            // shortfall summary then raised one wash ticket for the
            // material and aimed it at that lot, so the other order's
            // tone was never queued at all.
            washLots: [],
            // …and how much of each lot's greige THIS ROW's orders
            // are waiting on. Not the lot's pile: "L2 has 15.69 Mtr
            // unwashed" on a row 35.62 short is an offer that does
            // not add up, and it is not even his — most of that pile
            // is spoken for by another supervisor's order.
            washNeed: {},
            // Every lot chosen for an order on this row, whether or
            // not it needs washing. A short row whose lot has no
            // greige left has to say THAT — the greige on other lots
            // is another tone and cannot serve this order, so
            // quoting it would offer cloth that can never be used.
            lotsUsed: [],
            pinnedDryLots: [], pinnedDryOrders: [],
            // NOTHING ON THE RACK COVERS A WHOLE JOB. Kept as the
            // size of the smallest job that was turned away, because
            // that is the number that ends the argument: he is
            // looking at cloth, and "no lot holds enough" does not
            // tell him how much short it is.
            noFitSmallest: 0,
            overrideFrom: '', overrideNote: '', noPieceData: false
        };
    });

    // `greigeUsed` is the cloth this order has COMMITTED a lot's greige to but
    // cannot take yet — it still has to be washed. Spent down like everything
    // else, or a second order would be told the same greige can finish it too.
    //
    // `emit` false is a COMMITMENT WITHOUT A HANDOVER: the order has taken this
    // lot's cloth off the table — nothing else may be promised it — but none of
    // it goes out today, because the order is not covered until the wash lands
    // and an unpinned order is served whole or not at all. The ledgers move; the
    // issue lines and the offcut picks do not.
    //
    // Skipping the ledger here instead would tell the card's next order that the
    // same pile can finish it too, which is the double-promise this whole design
    // exists to prevent.
    //
    // `washUsed` is passed rather than taken from `fill.freshMetres`, because on
    // a commitment the fill was simulated against wash PLUS greige and its metres
    // therefore span both piles. Deriving the washed share from the fill would
    // drive `lot.wash` negative and then charge the same metres to the greige as
    // well — the lot would read as having given twice what it holds.
    var spend = function (lot, demands, fill, washUsed, greigeUsed, noteOn, fromOn, emit) {
        washUsed = Number(washUsed) || 0;
        greigeUsed = Number(greigeUsed) || 0;
        noteOn = noteOn || '';
        fromOn = fromOn || '';
        emit = emit !== false;
        if (emit) demands.forEach(function (d, i) {
            var r = res[d.rowIdx];
            r.fromWaste += fill.fromWaste[i];
            r.fromFresh += fill.fromFresh[i];
            r.freshMetres = round2(r.freshMetres + fill.metresPer[i]);
            if (fill.metresPer[i] > 0) {
                r.lotLines.push({
                    lotId: lot.lotId, lotNumber: lot.lotNumber,
                    qty: fill.metresPer[i], planItemId: d.planItemId,
                    planId: d.planId,
                    note: noteOn, overrideFrom: fromOn
                });
            }
            // KEYED BY REMNANT **AND** ITEM.
            //
            // One remnant can yield cuts for two items of an order, and keying
            // on the remnant alone stamped the whole yield with whichever item
            // happened to reach it first. The server then credits that item's
            // rows only, the second item silently draws fresh cloth instead, and
            // the offcut it was supposed to use sits on the rack marked spent.
            //
            // Two items off one remnant therefore show as two rows. They are not
            // the duplicate rows the cutting dialog merges away — those were the
            // same piece described twice, these are genuinely different claims.
            Object.keys(fill.picksPer[i]).forEach(function (wid) {
                var k = wid + '|' + d.planItemId;
                if (!r.picks[k]) {
                    var src = lot.waste.filter(function (x) { return String(x.wasteId) === String(wid); })[0] || {};
                    r.picks[k] = {
                        wasteId: wid, pieces: 0, width: src.width, length: src.length,
                        lot: lot.lotNumber, carton: src.carton, planItemId: d.planItemId
                    };
                }
                r.picks[k].pieces += fill.picksPer[i][wid];
            });
        });
        // OFF THE RACK, in BOTH ledgers.
        //
        // `lotLeft` and `wasteLeft` carry across supervisors; the `lots` objects
        // are what the NEXT order on this card is measured against. Updating
        // only the first let two orders each take 5.50m from a 6.00m lot — both
        // were tested against the figure the lot had before either was served,
        // which is the double-promise this whole design exists to prevent.
        lotLeft[materialId + '|' + lot.lotId] = round2(Math.max(0,
            (lotLeft[materialId + '|' + lot.lotId] || 0) - washUsed));
        lot.wash = round2(Math.max(0, (Number(lot.wash) || 0) - washUsed));
        lot.unwash = round2(Math.max(0, (Number(lot.unwash) || 0) - greigeUsed));
        greigeLeft[materialId + '|' + lot.lotId] = round2(Math.max(0,
            (greigeLeft[materialId + '|' + lot.lotId] || 0) - greigeUsed));

        Object.keys(fill.picks).forEach(function (wid) {
            wasteLeft[wid] = (wasteLeft[wid] || 0) - fill.picks[wid];
            lot.waste.forEach(function (r) {
                if (String(r.wasteId) === String(wid)) {
                    r.pieces = Math.max(0, r.pieces - fill.picks[wid]);
                }
            });
        });
    };

    orderSeq.forEach(function (oid) {
        var ord = byOrder[oid];
        ord.demands.forEach(function (d) { res[d.rowIdx].owed += d.pieces; });

        // CAN THE PINNED LOT STILL SERVE THIS ORDER AT ALL?
        //
        // Asked BEFORE anything is chosen, and it has to cover two shapes that
        // look different and mean the same thing:
        //
        //   - the lot is in the list but has nothing usable left;
        //   - the lot is NOT IN THE LIST, because getStoreMaterialRequirements
        //     drops a lot once its washed, unwashed and at-the-wash figures are
        //     all zero. This is the ORDINARY case — an emptied lot simply stops
        //     being sent — and it was the dangerous one: chooseLotForOrder found
        //     no match for the pin, fell through to choosing freely, and the
        //     order was silently moved onto another tone with nothing on screen
        //     saying so. Precisely the defect the pin exists to prevent.
        //
        // A blocked lot lands here too, and should: quarantined cloth is not a
        // thing to finish an order with just because the order started on it.
        var pinnedLot = null;
        var pinBlocked = false;
        if (ord.pin) {
            lots.forEach(function (l) {
                if (String(l.lotId) !== String(ord.pin)) return;
                // A BLOCKED PIN IS AN UNUSABLE PIN, however much cloth it holds.
                // Quarantined cloth is not a thing to finish an order with just
                // because the order started on it.
                //
                // This used to be handled for us: the server dropped blocked lots
                // entirely, so the pin simply found nothing. Now they are sent so
                // the row can name them, which means the block has to be honoured
                // here or a pinned order would quietly issue quarantined cloth.
                if (l.blocked) { pinBlocked = true; return; }
                pinnedLot = l;
            });
        }
        // "FINISHED" MEANS FINISHED — no washed cloth, no greige, no offcut and
        // nothing away at the wash house. Anything less and the lot can still
        // serve this order, so the tone must not be switched: greige gets washed
        // and cloth at the wash house comes back, both in this same tone. Offer
        // a switch over either and he mixes tones where waiting would have done.
        var pinUsable = false;
        if (ord.pin && pinnedLot) {
            var trial = lotFill(pinnedLot, ord.demands, fab, true);
            pinUsable = trial.freshMetres > 0 || Object.keys(trial.picks).length > 0 ||
                (Number(pinnedLot.inWash) || 0) > 0;
        }

        if (ord.pin && !pinUsable) {
            // ONE ROW CAN CARRY TWO DEAD ORDERS, each pinned to a different
            // spent lot. Collected rather than assigned, because the last write
            // used to win: the row named one lot while the other order had been
            // cut from a different one, and the override then rescued only the
            // order that happened to be processed last.
            ord.demands.forEach(function (d) {
                var rr = res[d.rowIdx];
                var name = ord.pinNo || ord.pin;
                if (rr.pinnedDryLots.indexOf(name) === -1) rr.pinnedDryLots.push(name);
                if (rr.pinnedDryOrders.indexOf(ord.oid) === -1) rr.pinnedDryOrders.push(ord.oid);
                // "L2 is empty" over a full but quarantined lot sends him to the
                // rack to check, and he finds cloth. Different sentence, same
                // override.
                if (pinBlocked) rr.pinnedBlocked = true;
            });

            // AN OVERRIDE APPLIES ONLY HERE. Checked against the live rack every
            // time rather than remembered as a decision: if the original lot has
            // since been restocked the order belongs back on it, and a
            // remembered override would quietly keep it on the substitute.
            var ov = lotOverrideFor(sup.supervisorId, materialId, ord.oid);
            if (ov && ov.lotId) {
                ord.pin = String(ov.lotId);
                ord.note = String(ov.note || '');
            } else {
                // No override yet. Allocate NOTHING — the row shows what it needs
                // and why it cannot have it, and he decides.
                return;
            }
        }

        // WHICH LOT, AND WHETHER ANYTHING GOES OUT TODAY.
        //
        // A PINNED order has no choice: the shade is already decided by cloth
        // that has been cut, so it takes whatever that lot can give, however
        // little. All-or-nothing protects the shade DECISION, and that decision
        // is behind it — refusing a top-up here would protect nothing and leave
        // the order unfinishable for good. It is also the state every order
        // part-issued under the old rules is already in.
        //
        // An UNPINNED order is served whole or skipped, and "whole" may be after
        // a wash — in which case it commits the lot and issues nothing today.
        var lot = null;
        var ready = true;
        if (ord.pin) {
            lots.forEach(function (l) {
                if (String(l.lotId) === String(ord.pin)) lot = l;
            });
        } else {
            var choice = chooseLotForOrder(lots, ord.demands, fab);
            if (choice) { lot = choice.lot; ready = choice.ready; }
        }

        if (!lot) {
            // NOTHING COVERS THIS JOB. Skip it and carry on down the queue —
            // blocking here would let one order bigger than any lot on the rack
            // freeze the fabric for everybody behind it, permanently.
            //
            // The size of the job is kept so the row can say how far short it is.
            // Smallest, because that is the one nearest to being servable and the
            // only figure that makes "20 on the rack" mean anything.
            var want = orderMetres(ord.demands, fab);
            ord.demands.forEach(function (d) {
                var rr = res[d.rowIdx];
                if (rr.noFitSmallest === 0 || want < rr.noFitSmallest) {
                    rr.noFitSmallest = want;
                }
            });
            return;
        }

        {
            var fill = lotFill(lot, ord.demands, fab, false);
            // What the same lot would give with its greige washed. The gap is
            // what this order has reserved at the wash house.
            var withWash = lotFill(lot, ord.demands, fab, true);
            var greige = round2(Math.max(0, withWash.freshMetres - fill.freshMetres));

            // COMMITTED BUT NOT HANDED OVER. An unpinned order that only its
            // lot's greige can complete takes nothing today: issuing the washed
            // part would pin it to a lot that cannot yet finish it, which is the
            // one thing the atom rule exists to prevent. The lot's cloth, greige
            // and offcuts are still spent — this order has claimed them.
            //
            // The washed/greige split differs between the two cases. Handed over,
            // the washed share is what actually went out and the greige is the
            // rest. Committed, the whole requirement is planned against the lot
            // at once, so the washed share is as much of it as the lot has washed
            // today and the greige covers what is left.
            var useFill = ready ? fill : withWash;
            var washUse = ready
                ? fill.freshMetres
                : round2(Math.min(Number(lot.wash) || 0, withWash.freshMetres));
            var greigeUse = ready
                ? greige
                : round2(Math.max(0, withWash.freshMetres - washUse));

            spend(lot, ord.demands, useFill, washUse, greigeUse,
                ord.note, (ord.note && ord.origPin !== ord.pin) ? ord.origPin : '',
                ready);

            // What the row has to ask the wash for. Handed-over rows want the
            // gap; a committed row wants everything its lot cannot give washed
            // today, which is the same figure by a different route.
            greige = greigeUse;

            var usedSeen = [];
            ord.demands.forEach(function (d) {
                if (usedSeen.indexOf(d.rowIdx) > -1) return;
                usedSeen.push(d.rowIdx);
                var ru = res[d.rowIdx];
                var had = false;
                ru.lotsUsed.forEach(function (u) {
                    if (String(u.lotId) === String(lot.lotId)) had = true;
                });
                if (!had) {
                    ru.lotsUsed.push({ lotId: String(lot.lotId), lotNumber: lot.lotNumber });
                }
            });

            // THE WASH HAS TO TARGET THIS LOT, not whichever holds the most
            // greige. The order is committed to this lot the moment anything is
            // issued from it, so washing a different one produces cloth the
            // order cannot use without breaking the tone the pin protects.
            if (greige > 0) {
                // ONCE PER ROW, not once per demand. An order's greige belongs
                // to the order, and its demands can hit the same row several
                // times — one per cut size — so adding it per demand would
                // multiply the figure by the number of sizes on the row.
                var rowsSeen = [];
                ord.demands.forEach(function (d) {
                    if (rowsSeen.indexOf(d.rowIdx) > -1) return;
                    rowsSeen.push(d.rowIdx);
                    var r = res[d.rowIdx];
                    // Collected, not assigned — see `washLots` above.
                    var seen = false;
                    r.washLots.forEach(function (w) {
                        if (String(w.lotId) === String(lot.lotId)) seen = true;
                    });
                    if (!seen) {
                        r.washLots.push({
                            lotId: String(lot.lotId),
                            lotNumber: lot.lotNumber
                        });
                    }
                    r.washNeed[lot.lotId] = round2((r.washNeed[lot.lotId] || 0) + greige);
                    if (!r.washLotId) {
                        r.washLotId = lot.lotId;
                        r.washLotNumber = lot.lotNumber;
                    }
                });
                waitingWash[lot.lotId] = round2((waitingWash[lot.lotId] || 0) + greige);
            }
            // Covered on paper but not today — its greige has to be washed
            // first. Still one tone, which is the point.
            //
            // And if the lot cannot finish it even washed, the order STAYS HERE
            // and stays short. It takes what this lot gives, the wash line asks
            // for the rest of that lot's greige, and anything still missing goes
            // to the purchase list. It is never spread over a second lot to make
            // the number look better — see chooseLotForOrder.
        }
        // No lots at all on this material: nothing to allocate, and the Lot
        // column says so rather than leaving an empty cell.
    });

    // ---- write back, in the shape the rest of the screen already reads ----
    rows.forEach(function (rw) {
        var r = res[rw.idx];
        var m = rw.m;
        m.wastePicks = Object.keys(r.picks).map(function (k) { return r.picks[k]; });

        // A DECLINED REMNANT KEEPS ITS ROW, at zero.
        //
        // The picks come out of the allocation, and the allocation no longer
        // offers what he declined — so without this the row vanishes the instant
        // he unticks it and there is no way back short of a refresh.
        (m.wasteStock || []).forEach(function (rk) {
            if (wasteDeclined[String(rk.wasteId)] === undefined) return;
            var already = m.wastePicks.some(function (pk) {
                return String(pk.wasteId) === String(rk.wasteId);
            });
            if (already) return;
            m.wastePicks.push({
                wasteId: rk.wasteId, pieces: 0, width: rk.width,
                length: rk.length, lot: rk.lot, carton: rk.carton,
                planItemId: ''
            });
        });
        m.piecesCoveredByWaste = r.fromWaste;
        m.freshPieces = Math.max(0, r.owed - r.fromWaste);

        // WHAT THE ROW STILL NEEDS, not what could be allocated today.
        //
        // These two diverge the moment a lot's cloth is short — it may be able
        // to finish the order once its greige is washed, so it is rightly
        // chosen, but only 1.10 of the 5.50 can leave the shelf now. Setting
        // `remaining` to the 1.10 makes the gap read as zero, and the shortfall
        // summary then raises no wash ticket at all: the screen would quietly
        // stop asking for cloth it is still waiting on.
        //
        // So this stays what it has always been — the waste-adjusted fresh
        // requirement. What can actually go out today is the lot allocation,
        // and that travels separately in `lotLines`.
        var prNeed = perRowFor({ fabricWidthCm: m.fabricWidthCm }, m.cutWidth);
        var cl = Number(m.cutLength) || 0;
        // THE SAME TEST getStoreMaterialRequirements USES, deliberately:
        // reqPieces > 0 AND a countable cut. A row planned before Required_Pieces
        // existed has a perfectly good cut size and no pieces, so testing the cut
        // alone said "countable" and produced 0 — the row read "0 Mtr" and
        // dropped off the shortfall summary as well. Two screens, one silent
        // disappearance, from a condition that was nearly right.
        var need;
        if ((Number(m.requiredPieces) || 0) > 0 && prNeed > 0 && cl > 0) {
            need = m.freshPieces > 0
                ? round2((Math.ceil(m.freshPieces / prNeed) * cl) / 100)
                : 0;
        } else {
            // NO PIECE DATA TO COUNT WITH — a row planned before Required_Pieces
            // existed, a cut wider than the cloth, or a fabric whose width was
            // never recorded. Keep the server's metres estimate.
            //
            // Quoting 0 here does not merely make the row approximate, it makes
            // it VANISH: the row reads "0 Mtr to be issued", and because the
            // shortfall summary skips anything with no gap, the material drops
            // off that screen too. A fabric with a missing width would disappear
            // from the app rather than ask to be fixed.
            need = round2(Math.max(0, Number(m.freshMeters) || 0));
            r.noPieceData = true;
        }
        m.freshMeters = need;
        m.remaining = need;
        m.noPieceData = !!r.noPieceData;
        m.lotLines = r.lotLines;
        // Which lot this row is waiting on, so the shortfall summary sends the
        // right greige to the wash instead of the biggest pile.
        m.washLotId = r.washLotId;
        m.washLotNumber = r.washLotNumber;
        // Joined for display; the orders travel separately so the override can
        // rescue every one of them rather than whichever was written last.
        m.pinnedDry = r.pinnedDryLots.join(' and ');
        m.pinnedDryOrders = r.pinnedDryOrders;
        m.washQty = round2(waitingWash[r.washLotId] || 0);
        // EVERY lot this row waits on, each with the greige THIS MATERIAL'S
        // orders have committed on it. `waitingWash` is already a per-material
        // total for the card, so two rows of the same material carry the same
        // figure for a shared lot — the summary must therefore take it once per
        // card, never add the rows up.
        m.washLots = r.washLots.map(function (w) {
            return {
                lotId: w.lotId, lotNumber: w.lotNumber,
                qty: round2(waitingWash[w.lotId] || 0),
                // THIS ROW's share — what the row itself is waiting on, and
                // the only figure that belongs on the row. `qty` above is
                // the card's total for the lot and is for the summary.
                rowQty: round2(r.washNeed[w.lotId] || 0)
            };
        });
        m.committedLots = r.lotsUsed;
        m.shortReason = shortReasonFor(m, r, lots);
    });
}

// ONE ROW, ONE PROBLEM, ONE LINE.
//
// A row getting everything it asked for says only which lot to walk to. A row
// that is short says exactly one more thing, and it is the next action — not the
// reasoning, not the other lots, not the material's totals. Everything this
// screen used to print alongside was true and none of it was his, and a screen
// that explains itself constantly teaches people to skim the line that mattered.
//
// Ranked by what he has to DO about it, hardest stop first. Where two are true
// the actionable one wins.
//
// Returns null on a row that is fully served — the caller prints nothing at all.
function shortReasonFor(m, r, lots) {
    var want = round2(Math.max(0, Number(m.remaining) || 0));
    if (want <= 0) return null;

    var got = 0;
    (r.lotLines || []).forEach(function (ln) { got += Number(ln.qty) || 0; });
    if (round2(got) + 0.0001 >= want) return null;

    // Nothing can be worked out at all: no cut size, or a cut wider than the
    // cloth. A data fault, and it outranks everything because every figure below
    // it would be invented.
    if (r.noPieceData) return { kind: 'nodata' };

    // An order already cut in a shade that has run out. He has to decide, and
    // until he does the order cannot move at all.
    if (r.pinnedDryLots.length > 0) {
        return {
            kind: r.pinnedBlocked ? 'pinnedBlocked' : 'pinnedDry',
            lot: r.pinnedDryLots.join(' and ')
        };
    }

    var byId = {};
    lots.forEach(function (l) { byId[String(l.lotId)] = l; });

    // Greige on the committed lot. The one case with a button on it, so it beats
    // everything below.
    var wash = (m.washLots || []).filter(function (w) {
        return byId[String(w.lotId)] && round2(Number(w.rowQty) || 0) > 0;
    });
    if (wash.length > 0) {
        return {
            kind: 'wash',
            lots: wash.map(function (w) {
                return { lotNumber: w.lotNumber, qty: round2(Number(w.rowQty) || 0) };
            })
        };
    }

    // Committed, nothing left to wash, but cloth already at the washer. Not a
    // finished lot — it comes back in this shade, so the answer is wait.
    var atWash = null;
    (r.lotsUsed || []).forEach(function (u) {
        var l = byId[String(u.lotId)];
        if (!atWash && l && (Number(l.inWash) || 0) > 0) {
            atWash = {
                kind: 'atWash', lot: l.lotNumber,
                qty: round2(Number(l.inWash) || 0)
            };
        }
    });
    if (atWash) return atWash;

    // Cloth on the rack that no single job fits inside. SAY THE NUMBERS: he is
    // looking at a rack with cloth on it, and "no lot holds enough" is true and
    // unusable. The biggest lot and the smallest job end the argument in a
    // glance, and neither of them is a marker row.
    if (r.noFitSmallest > 0) {
        var big = null;
        lots.forEach(function (l) {
            if (l.blocked) return;
            var have = round2(Number(l.wash) || 0);
            if (have > 0 && (big === null || have > big.qty)) {
                big = { lotNumber: l.lotNumber, qty: have };
            }
        });
        if (big) {
            return {
                kind: 'nofit', lot: big.lotNumber, have: big.qty,
                need: round2(r.noFitSmallest)
            };
        }
    }

    // Stock exists and is quarantined. Only reached when nothing usable was
    // found, which is exactly when a silent row would send him to the rack to
    // check for himself.
    var blocked = null;
    lots.forEach(function (l) {
        if (!l.blocked) return;
        var have = round2((Number(l.wash) || 0) + (Number(l.unwash) || 0));
        if (have > 0 && (blocked === null || have > blocked.qty)) {
            blocked = { kind: 'blocked', lot: l.lotNumber, qty: have };
        }
    });
    if (blocked) return blocked;

    if (lots.length === 0) return { kind: 'nolots' };

    // Lots exist, none of them can help, and none of the named cases fit — the
    // rack is simply empty of this shade. Never leave it blank: a row asking for
    // metres with nothing in its lot column reads as a rendering fault, and he
    // presses Issue and gets nothing.
    return { kind: 'empty' };
}


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
    var pick = window.__reqData[supIdx].materials[matIdx].wastePicks[pickIdx];
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

    // Taking FEWER pieces off a remnant is the same question as taking none:
    // the cloth has to cover what they would have. Re-allocated only when the
    // figure actually changed, so ordinary typing does not redraw the card.
    if (val !== pick.pieces) {
        wasteDeclined[String(pick.wasteId)] = val;
        render(window.__rawData || window.__reqData);
        return;
    }
    delete wasteDeclined[String(pick.wasteId)];
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
function recommendWashLot(e, need) {
    // Blocked lots excluded: washing quarantined greige converts it into
    // quarantined washed cloth, which still cannot be issued. The wash team would
    // do the work for nothing.
    var lots = (e.lots || []).filter(function (l) {
        return !l.blocked && (Number(l.unwash) || 0) > 0;
    });
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
    // Blocked lots excluded: washing quarantined greige converts it into
    // quarantined washed cloth, which still cannot be issued. The wash team would
    // do the work for nothing.
    var lots = (e.lots || []).filter(function (l) {
        return !l.blocked && (Number(l.unwash) || 0) > 0;
    });
    if (lots.length === 0) {
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
    return used.map(function (k) {
        return '<div class="lot-from"><b>' + lotName(k) + '</b> &middot; ' +
            fmt(rec[k]) + ' ' + escapeHtml(m.unit) + '</div>';
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
        var owned = round2((Number(e.stock) || 0) +
            (Number(e.unwashed) || 0) +
            (Number(e.inWash) || 0));
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

        // WHICH CLOTH COMES OFF WHICH LOT, AND FOR WHICH ITEM.
        //
        // Taken from the allocation rather than read back off the hidden inputs,
        // because the inputs are keyed by lot alone and the per-item split is
        // the whole point: without it the server falls back to fanning metres
        // across requirement rows in plan order, and an order that was carefully
        // put on one lot gets its tail cut from the next one.
        //
        // The hidden inputs stay — the row's metres box and its validation are
        // still driven from them — but they are no longer the source of truth
        // for the payload.
        var lotLines = (m.lotLines || []).filter(function (ln) {
            return (Number(ln.qty) || 0) > 0;
        }).map(function (ln) {
            var out = {
                lotId: ln.lotId, qty: round2(ln.qty),
                planItemId: ln.planItemId || '',
                // The order, so issueMaterials can enforce one lot per
                // order rather than infer it from the item.
                planId: ln.planId || ''
            };
            // Only on a deliberate override. The handover records the lot that
            // actually left the shelf while Issued_Lot keeps the original, and
            // this says a person decided that rather than a rule slipping.
            if (ln.note) out.note = ln.note;
            if (ln.overrideFrom) out.overrideFrom = ln.overrideFrom;
            return out;
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
                // ONLY WHEN THE ROW IS ACTUALLY ASKING FOR CLOTH.
                //
                // The lot lines come from the allocation, not from the box, so
                // unticking the row used to leave them in the payload and the
                // cloth went out anyway — his only signal that he did not want
                // it was the zero he had just put in the box. It matters most on
                // a row whose offcuts are still ticked, because then the line is
                // sent regardless and the metres ride along with it.
                line.lots = val > 0 ? lotLines : [];

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
    print: loadPrint,
    history: loadHistory,
    waste: loadWasteReceipt,
    disputes: loadDisputes,
    requests: loadRequests,
    materials: loadMaterials
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

                return '<tr>' +
                    '<td style="font-weight:600; white-space:nowrap;">' + escapeHtml(rm.sku) + '</td>' +
                    '<td style="font-weight:700;">' + escapeHtml(rm.name) + '</td>' +
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
        '<div class="stockin-search">' +
            '<input type="text" id="print-filter" class="note-input" ' +
                'placeholder="Search plain fabric by SKU or name…" oninput="onPrintFilter()" />' +
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

function onPrintFilter() {
    var el = document.getElementById('print-filter');
    printFilter = el ? el.value.trim().toLowerCase() : '';
    renderPrintList();
}

// Keyed on id, NEVER on list index. The index moves the moment the filter
// changes, so an open card would silently become a different material's.
function togglePrintCard(matId) {
    printOpenId = (printOpenId === matId) ? null : matId;
    if (printOpenId && !printLines[matId]) printLines[matId] = [{ len: '', count: '' }];
    renderPrintList();
}

function togglePrintJob(jobId) {
    printJobOpenId = (printJobOpenId === jobId) ? null : jobId;
    if (printJobOpenId && !printRecvLines[jobId]) {
        var job = printJobById(jobId);
        // ONE ROW PER SIZE THAT WENT OUT, and the rows are fixed — he cannot add
        // or remove them. A piece comes back the length it left, so the only
        // thing he decides is HOW MANY of each size arrived; the shortfall is
        // whole pieces the printer lost or ruined.
        //
        // Prefilled with the full sent count, because the usual case is that it
        // all came back. `sent` is carried alongside so the cap can be enforced
        // and the loss shown per row.
        printRecvLines[jobId] = (job && job.lines || []).map(function (l) {
            return {
                len: l.lengthCm,
                sent: Number(l.count) || 0,
                count: l.count,
                state: (job && job.sourceState) || 'Wash',
                carton: ''
            };
        });
    }
    renderPrintJobs();
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

    return jobs.map(function (j) {
        var open = String(printJobOpenId) === String(j.jobId);
        var pieces = (j.lines || []).reduce(function (a, l) { return a + (Number(l.count) || 0); }, 0);

        return '' +
            '<div class="item-card' + (open ? ' open' : '') + '">' +
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
                            '<span class="status-pill status-warning">Sent ' + escapeHtml(j.sentOn || '') + '</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                (open ? printReceiveFormHtml(j) : '') +
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
        '<div class="item-body is-open">' +
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

    return list.map(function (m) {
        var open = String(printOpenId) === String(m.id);
        var lots = m.lots || [];
        var wash = lots.reduce(function (a, l) { return a + (Number(l.wash) || 0); }, 0);
        var unwash = lots.reduce(function (a, l) { return a + (Number(l.unwash) || 0); }, 0);
        var inPrint = lots.reduce(function (a, l) { return a + (Number(l.inPrint) || 0); }, 0);

        return '' +
            '<div class="item-card' + (open ? ' open' : '') + '">' +
                '<div class="item-header" onclick="togglePrintCard(\'' + m.id + '\')">' +
                    '<div class="item-header-info">' +
                        '<h2>' + escapeHtml(m.name || m.sku || '—') + '</h2>' +
                        '<div class="item-meta-line">' +
                            '<span>' + escapeHtml(m.sku || '') + '</span>' +
                            '<span>' + fmt(m.widthCm) + ' cm wide</span>' +
                            '<span>' + fmt(wash) + ' washed &middot; ' + fmt(unwash) + ' unwashed</span>' +
                            (inPrint > 0
                                ? '<span class="status-pill status-warning">' + fmt(inPrint) + ' at the printer</span>'
                                : '') +
                        '</div>' +
                    '</div>' +
                '</div>' +
                (open ? printSendFormHtml(m) : '') +
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
        '<div class="item-body is-open">' +
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
