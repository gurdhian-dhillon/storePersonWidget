// Admin calculation audit.
//
// The point of this screen is that it SHOWS ITS WORKING. Every figure the
// fabric maths produces is re-derived here, in the browser, from the inputs the
// Deluge function returned - and then compared against what the app actually
// stored. Where the two disagree the screen says so instead of quietly
// preferring one. A screen that just repeated the stored number would confirm
// nothing.
//
// Three calculations, in the order a piece of cloth meets them:
//
//   1 PLAN REQUIREMENT  cut size vs fabric width -> pieces per row -> rows ->
//                       metres. Fixed at plan time, assumes no leftover pieces exist.
//   2 ISSUE ALLOCATION  leftover pieces scored and consumed first, fresh cloth for
//                       whatever is left. Live, so it moves with waste stock.
//   3 WASTE GENERATED   the side strip, the part-filled row and the tail that
//                       the cutting throws off.
//
// (1) and (2) are re-derived from server inputs. (3) is computed here outright,
// because it hangs off a piece count the admin types and a round trip per
// keystroke would make the screen unusable.
//
// THE MIRROR IS CHECKED, NOT TRUSTED. deriveWaste mirrors getExpectedWaste step
// for step, and it once fell behind it — that function learned to split the
// fresh-cloth pass per LOT (a lot is a separate roll, so it ends on a whole
// marker row and the next starts a new one, each with its own side strip) while
// this file went on predicting one combined block. So the real answer per item
// is fetched from getExpectedWaste itself (ensureExpectedWaste, lazily, when a
// fabric line's working is opened) and serverWasteCheck says on screen when the
// two disagree. A comment asking the next person to remember something is not a
// mechanism; that is.
//
// WHAT THIS SCREEN DOES NOT SAY. It used to carry a glossary of the four steps
// in cards above the data, a sentence of subtitle under every step heading, and
// a paragraph explaining the columns under every item's table — text that said
// the same thing on every order, every item, every row, for ever. That is gone.
// Explanation now fires on a condition: a mismatch states its case in full, an
// agreement is a tick, a step with nothing to say is not drawn, and the column
// glossary lives in title attributes on the headings that raise the question.

var DATA = null;
// The audited order's plan ids - filled in load(), read by bucketFor.
var MY_PLAN_IDS = [];

// Expected-waste payloads, one per plan item, fetched LAZILY when an item card
// is first opened. getAdminCalculation used to call thisapp.getExpectedWaste
// once per item inside its own execution - ~110 cross-calls for a Faire order,
// straight into the uncatchable statement limit. Now the widget calls
// getExpectedWaste itself, one item at a time, only for the item being looked
// at. Keyed by planItemId. A value of `null` means "in flight".
var EXP_WASTE = {};

// Fetch (once) the expected-waste payload for an item, then run cb. If it is
// already loaded or in flight, cb is not called again - the render that follows
// the in-flight fetch will pick it up.
function ensureExpectedWaste(item, cb) {
    var key = String(item.planItemId);
    if (EXP_WASTE[key] !== undefined) return; // loaded or in flight
    EXP_WASTE[key] = null;

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getExpectedWaste',
        http_method: 'POST',
        payload: {
            planId: String(item.planId || ''),
            planItemId: key,
            qtyOut: String(item.qtyOrdered || 0)
        }
    }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            parsed = { errors: ['Could not read getExpectedWaste: ' + (e.message || e)], fabrics: [], fabricOptions: [] };
        }
        EXP_WASTE[key] = parsed;
        item.expectedWaste = parsed;
        if (cb) cb();
    }).catch(function (err) {
        console.error('getExpectedWaste error for item ' + key + ':', err);
        var parsed = { errors: ['getExpectedWaste call failed'], fabrics: [], fabricOptions: [] };
        EXP_WASTE[key] = parsed;
        item.expectedWaste = parsed;
        if (cb) cb();
    });
}

// Pieces-cut overrides, keyed by requirement id. Empty until the admin types.
var CUT_QTY = {};
// Whether a line's waste prediction should assume the leftover pieces the allocator
// would pick, for lines that have not been issued any yet.
var ASSUME_PICKS = {};

// ---- formatting ----

function num(v, dp) {
    var n = parseFloat(v);
    if (isNaN(n)) return '0';
    if (dp === undefined) dp = 2;
    var s = n.toFixed(dp);
    // Trailing zeros on a measurement read as false precision — 3.50m is not
    // more certain than 3.5m, it just looks it.
    if (s.indexOf('.') > -1) s = s.replace(/\.?0+$/, '');
    return s;
}

function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Two figures agreeing to the millimetre is agreement. Floating point makes an
// exact comparison lie about once in every few hundred rows.
function same(a, b) {
    return Math.abs(parseFloat(a || 0) - parseFloat(b || 0)) < 0.005;
}

// ---- step 1: the plan-time requirement, re-derived ----

function derivePlan(mat, qtyOrdered) {
    var out = {
        ok: false,
        reason: '',
        perRow: 0,
        rows: 0,
        cm: 0,
        metres: 0,
        pieces: mat.requiredPieces
    };

    var cutW = parseFloat(mat.cutWidth) || 0;
    var cutL = parseFloat(mat.cutLength) || 0;
    var fw = parseFloat(mat.fabricWidthCm) || 0;
    var pcs = parseInt(mat.requiredPieces, 10) || 0;

    if (fw <= 0) { out.reason = 'No fabric width on the raw material, so nothing could be calculated.'; return out; }
    if (cutW <= 0 || cutL <= 0) { out.reason = 'No cut size on the BOM, so nothing could be calculated.'; return out; }
    if (cutW > fw) { out.reason = 'Cut width ' + num(cutW) + 'cm is wider than the fabric (' + num(fw) + 'cm). Grain is never rotated, so this cannot be cut at all.'; return out; }
    if (pcs <= 0) { out.reason = 'No pieces required.'; return out; }

    out.perRow = Math.floor(fw / cutW);
    out.rows = Math.ceil(pcs / out.perRow);
    out.cm = out.rows * cutL;
    out.metres = out.cm / 100;
    out.ok = true;
    return out;
}

// ---- step 3: waste generation, mirroring getExpectedWaste ----

// A remnant row. origin is what makes the list checkable by eye: a side strip
// and a tail come off the same cut for completely different reasons, and
// collapsing them into "waste" hides whether the marker or the length is at
// fault.
function remnant(list, w, l, count, origin, from) {
    if (w > 0 && l > 0 && count > 0) {
        list.push({ width: w, length: l, count: count, origin: origin, from: from });
    }
}

function deriveWaste(mat, pieces, sources) {
    var res = { rows: [], steps: [], fresh: null, uncut: 0 };

    var cutW = parseFloat(mat.cutWidth) || 0;
    var cutL = parseFloat(mat.cutLength) || 0;
    var fw = parseFloat(mat.fabricWidthCm) || 0;
    var remain = parseInt(pieces, 10) || 0;

    if (cutW <= 0 || cutL <= 0 || fw <= 0 || remain <= 0) return res;

    // --- pass 1: the leftover pieces, spent before any fresh cloth is touched ---
    sources.forEach(function (src) {
        var pieceW = parseFloat(src.width) || 0;
        var pieceL = parseFloat(src.length) || 0;
        var avail = parseInt(src.count, 10) || 0;

        if (remain <= 0 || avail <= 0 || pieceW < cutW || pieceL < cutL) return;

        var perRow = Math.floor(pieceW / cutW);
        var maxRows = Math.floor(pieceL / cutL);
        var capacity = perRow * maxRows;
        var sideW = pieceW - (perRow * cutW);
        var label = num(pieceL) + '×' + num(pieceW) + 'cm leftover piece';

        // Pieces spent to their full capacity. Each yields the same two
        // leftover pieces, so they collapse into one row carrying a count.
        var full = Math.floor(remain / capacity);
        if (full > avail) full = avail;

        if (full > 0) {
            var usedLen = maxRows * cutL;
            remnant(res.rows, sideW, usedLen, full, 'side', label);
            remnant(res.rows, pieceW, pieceL - usedLen, full, 'tail', label);
            res.steps.push({
                src: label, kind: 'full',
                perRow: perRow, maxRows: maxRows, capacity: capacity,
                used: full, covered: full * capacity,
                before: remain, after: remain - (full * capacity)
            });
            remain -= full * capacity;
            avail -= full;
        }

        // At most one part-used piece, for the remainder.
        if (remain > 0 && avail > 0) {
            var take = remain;
            var partRows = Math.floor(take / perRow);
            var lastRow = take - (partRows * perRow);
            var rows = partRows + (lastRow > 0 ? 1 : 0);
            var lengthUsed = rows * cutL;

            // Side strip runs down the full rows as one continuous piece, not
            // one strip per row.
            if (partRows > 0) remnant(res.rows, sideW, partRows * cutL, 1, 'side', label);
            // Unused slots in the last row plus that row's side strip are
            // contiguous, so they come off as a single piece.
            if (lastRow > 0) remnant(res.rows, pieceW - (lastRow * cutW), cutL, 1, 'partial_row', label);
            remnant(res.rows, pieceW, pieceL - lengthUsed, 1, 'tail', label);

            res.steps.push({
                src: label, kind: 'part',
                perRow: perRow, maxRows: maxRows, capacity: capacity,
                used: 1, covered: take, rows: rows, lastRow: lastRow,
                before: remain, after: 0
            });
            remain = 0;
        }
    });

    // --- pass 2: whatever the leftover pieces could not cover, off fresh cloth ---
    //
    // ONE BLOCK PER LOT, and this is the half that had fallen behind
    // getExpectedWaste. It used to compute a single side strip and a single part
    // row off the combined piece count, which is what that function did before
    // lots existed — and its own comment now says why that is wrong:
    //
    //   "Each lot's cloth is a separate roll: it gets its own side strip down its
    //    own full rows, and its own part-filled last row. Treating the fresh
    //    metres as one continuous block predicted ONE strip of 50 rows where the
    //    truth is two strips of 30 and 20 — different physical pieces, belonging
    //    to different lots — and it under-predicted the waste whenever the pieces
    //    did not divide evenly."
    //
    // So this screen quietly under-predicted the remnants on every item whose
    // cloth came off more than one lot, while presenting itself as the working
    // behind the real figure.
    //
    // Lots come from the handovers, oldest first, which is the order
    // issueMaterials spent them in. A lot's own metres decide how many pieces its
    // cloth yields, in whole marker rows — a lot never ends mid-row.
    if (remain > 0) {
        var perRowR = Math.floor(fw / cutW);
        if (perRowR > 0) {
            var sideWR = fw - (perRowR * cutW);
            res.fresh = {
                perRow: perRowR, sideW: sideWR,
                rows: 0, cm: 0, metres: 0, pieces: remain, blocks: []
            };

            var cutBlock = function (pcs, label, lot) {
                var fullRows = Math.floor(pcs / perRowR);
                var lastRow = pcs - (fullRows * perRowR);
                var rows = fullRows + (lastRow > 0 ? 1 : 0);
                if (fullRows > 0) remnant(res.rows, sideWR, fullRows * cutL, 1, 'side', label);
                if (lastRow > 0) remnant(res.rows, fw - (lastRow * cutW), cutL, 1, 'partial_row', label);
                res.fresh.rows += rows;
                res.fresh.cm += rows * cutL;
                res.fresh.blocks.push({
                    lot: lot, pieces: pcs, fullRows: fullRows,
                    lastRow: lastRow, rows: rows
                });
                return pcs;
            };

            (lotBlocks(mat) || []).forEach(function (b) {
                if (remain <= 0) return;
                // Whole marker rows off THIS lot's metres, capped by what is left
                // to cut. `getExpectedWaste` computes the same two lines.
                var rowsHere = Math.floor((b.qty * 100) / cutL);
                var pcsHere = perRowR * rowsHere;
                if (pcsHere > remain) pcsHere = remain;
                if (pcsHere <= 0) return;
                remain -= cutBlock(pcsHere, 'fresh cloth · lot ' + b.lot, b.lot);
            });

            // CLOTH THE HANDOVERS DO NOT ACCOUNT FOR — a pre-lot handover in the
            // mix, nothing issued yet, or more cut than the lines can explain. It
            // still produced real waste. Predicted with NO LOT rather than charged
            // to the last one, exactly as the server does: naming a lot here would
            // be a guess about tone.
            if (remain > 0) {
                remain -= cutBlock(remain, 'fresh cloth', '');
            }

            res.fresh.metres = res.fresh.cm / 100;
            remain = 0;
        } else {
            res.uncut = remain;
        }
    }

    return res;
}

// The lots this item's fresh cloth came off, oldest first, one entry per lot.
//
// `issuedLots` is one row per handover LINE, so a lot issued twice appears twice;
// getExpectedWaste aggregates by lot before walking, and predicting two half-lots
// where one lot exists would invent a side strip. Rows with no lot recorded are
// left out on purpose — they are pre-lot handovers, the server has no metres for
// them either, and their pieces fall through to the no-lot block.
function lotBlocks(mat) {
    var order = [];
    var byLot = {};
    (mat.issuedLots || []).forEach(function (li) {
        var lot = String(li.lot || '').trim();
        if (!lot || lot === 'not recorded') return;
        var q = parseFloat(li.qty) || 0;
        if (q <= 0) return;
        if (byLot[lot] === undefined) { byLot[lot] = 0; order.push(lot); }
        byLot[lot] += q;
    });
    return order.map(function (lot) { return { lot: lot, qty: byLot[lot] }; });
}

// ---- rendering ----

var ORIGIN_LABEL = {
    side: 'Side strip',
    tail: 'Tail',
    partial_row: 'Part row'
};

var ORIGIN_WHY = {
    side: 'The width left over beside the last column of cuts.',
    tail: 'The length left below the last row of cuts.',
    partial_row: 'The last row was not filled, so its unused slots and side strip come off as one piece.'
};

// One derived quantity: what it is, what it came from, what it came to.
//
// The middle column used to be the literal expression - floor( 111.76 / 33 ),
// ceil( 100 / 3 ) - which is unreadable to the merchandiser this screen is for
// and makes a four-material item twelve boxes of algebra. It says the same
// thing in words now: "111.76 cm fabric across a 33 cm cut", "100 pieces at
// 3 per row, rounded up". Same three columns, same meaning on every row.
//
// Kept as a function rather than inlined so every derivation on the screen is
// forced through one shape.
function factRow(label, basis, result) {
    return '<div class="calc-row">' +
        '<span class="calc-label">' + esc(label) + '</span>' +
        '<span class="calc-expr">' + basis + '</span>' +
        '<span class="calc-result">' + result + '</span>' +
        '</div>';
}

// WHERE THIS LINE IS IN ITS LIFE, which decides which steps are worth drawing.
//
// The four steps used to render at equal weight on every row regardless of
// whether they had anything to say about it. A fully-issued line got step 2
// explaining that there was nothing left to allocate and step 3 predicting the
// waste from cloth that was cut weeks ago — two paragraphs of hypothesis about
// a line whose story is already told, sitting above the one step (4) that
// actually records what happened.
//
// `live` decides step 2: it is the allocator's outcome for this order, and its
// absence IS the answer that nothing is outstanding. Step 3 is a forecast, so it
// is worth drawing while there is still something to cut and not afterwards.
// Step 4 is a record, so it is worth drawing once there is one.
function lineStage(mat, item, bucket) {
    var issued = parseFloat(mat.issuedQty) || 0;
    var live = bucket ? liveFor(bucket, item.planId) : null;

    // Outstanding pieces is the honest test for "still to come", not metres:
    // fabric is counted in cut pieces, and a row can read fully-issued on
    // metres while still owing pieces. CLAUDE.md's first rule.
    var outstanding = 0;
    if (live) outstanding = parseInt(live.o.pieces, 10) || 0;

    return {
        live: live,
        // Step 2 answers "which lot, and how much goes out today". Only a live
        // allocation can answer it; without one there is no decision being made.
        showAlloc: !!live,
        // Step 3 forecasts the cutting. Still useful while cloth is outstanding,
        // and still useful before anything is issued at all — it is how the
        // admin sees what an order will throw off. Once the line is fully issued
        // the forecast is about the past and getExpectedWaste is the record.
        showWaste: !!live || issued <= 0,
        // Step 4 is the counter's record: worth drawing once anything has been
        // committed to a lot or crossed the counter.
        showIssued: !!mat.pinLot || (mat.issuedLots || []).length > 0 || issued > 0
    };
}

function renderPlanStep(mat, item) {
    var d = derivePlan(mat, item.qtyOrdered);
    var h = '<div class="step step-plan"><div class="step-head"><span class="step-tag tag-plan">1</span>' +
        '<h4>Planned requirement</h4></div>';

    h += '<div class="inputs">' +
        '<div class="input-chip"><span>Fabric width</span><b>' +
        (mat.fabricWidthInches ? esc(mat.fabricWidthInches) + '&Prime; = ' : '') +
        num(mat.fabricWidthCm) + ' cm</b></div>' +
        '<div class="input-chip"><span>Cut size (L × W)</span><b>' + num(mat.cutLength) + ' × ' + num(mat.cutWidth) + ' cm</b></div>' +
        '<div class="input-chip"><span>Pieces needed</span><b>' + esc(mat.requiredPieces) + '</b></div>' +
        '</div>';

    if (!d.ok) {
        h += '<div class="warn">' + esc(d.reason) + '</div>';
        h += '</div>';
        return h;
    }

    h += '<div class="calc">' +
        factRow('Pieces per row',
            num(mat.fabricWidthCm) + ' cm of fabric width across a ' + num(mat.cutWidth) + ' cm cut',
            '<b>' + d.perRow + '</b> per row') +
        factRow('Rows needed',
            esc(mat.requiredPieces) + ' pieces at ' + d.perRow + ' per row, rounded up',
            '<b>' + d.rows + '</b> rows') +
        factRow('Cloth needed',
            d.rows + ' rows of ' + num(mat.cutLength) + ' cm',
            '<b>' + num(d.metres, 3) + ' m</b> <span class="muted">(' + num(d.cm) + ' cm)</span>') +
        '</div>';

    // One row of the marker is bought whole whether or not it is filled. This
    // is where that cost becomes visible, and it is the single most-questioned
    // number in the whole flow.
    var slack = (d.rows * d.perRow) - mat.requiredPieces;
    if (slack > 0) {
        h += '<div class="aside">The last row has room for <b>' + slack + '</b> more piece' + (slack === 1 ? '' : 's') +
            '. Cloth is cut in whole rows, so that space is paid for either way — this is the cutting allowance, not a loss.</div>';
    }

    // A REISSUE IS NOT MEASURED AGAINST THE ORDER. Its Required_Qty was worked
    // out from the pieces the supervisor ruined, not from the item's quantity —
    // so the derivation above, which is the order's own requirement, can never
    // match it. Reported as bad it would flag every reissue row as a BOM
    // discrepancy and bury the real ones.
    if (mat.isReissue === true) {
        h += '<div class="check note">Stored on the requirement: <b>' + num(mat.storedRequiredQty, 3) + ' m</b> — ' +
            'this is a <b>reissue</b>, replacing material damaged in production. It is costed from the pieces reported ' +
            'spoiled, not from the order, so it is not expected to match the figure above.</div>';
    } else if (same(d.metres, mat.storedRequiredQty)) {
        // AGREEMENT IS A TICK, NOT A SENTENCE. This is the overwhelmingly common
        // outcome, so a full line of prose saying "— matches" was the single
        // most-repeated text on the screen while carrying the least. The
        // disagreement below keeps every word of its explanation: that is the
        // one an admin has to act on and the one that needs the why.
        h += '<div class="check ok"><b>&#10003;</b> Stored: <b>' + num(mat.storedRequiredQty, 3) + ' m</b></div>';
    } else {
        h += '<div class="check bad">Stored on the requirement: <b>' + num(mat.storedRequiredQty, 3) + ' m</b>, but the inputs above give <b>' +
            num(d.metres, 3) + ' m</b>. The requirement was written at plan time and is never recomputed, so a cut size or fabric width changed after this plan was created.</div>';
    }

    h += '</div>';
    return h;
}

// WHICH SHADE, AND WHY — the decision, before any of the arithmetic behind it.
//
// This leads the step because it is the decision everything else follows from: a
// remnant carries the tone of the lot it was cut from, so which offcuts are even
// usable depends on which lot the fresh cloth comes off. Reading the offcut
// scoring first and the shade afterwards is reading it backwards.
//
// Straight from the allocator's own per-order record, so this cannot disagree
// with the store screen.
function renderLotDecision(bucket, item) {
    var live = liveFor(bucket, item.planId);

    if (!LIVE) {
        return '<div class="warn">The live allocation could not be read, so the lot decision below is unknown. ' +
            'Check the console — the plan-time working above is unaffected.</div>';
    }
    if (!live) {
        return '<div class="aside">This order has nothing outstanding on this fabric, so no lot decision is ' +
            'being made for it today. What it was cut from is in <b>What actually went out</b> below.</div>';
    }

    var o = live.o;
    var unit = bucket.unit || 'Mtr';

    // One sentence per outcome, and each one names the shade and the number. The
    // four are exhaustive by construction — the allocator emits nothing else.
    var why, cls;
    if (o.why === 'pinned') {
        why = 'Cloth has already been cut for this order from <b>' + esc(o.pin || o.lotNumber) +
              '</b>, so there was no choice: the rest has to match it.';
        cls = 'chk-note';
    } else if (o.why === 'ready') {
        why = '<b>' + esc(o.lotNumber) + '</b> is the smallest lot that covers this whole order off the rack ' +
              'today — washed cloth plus its own offcuts.';
        cls = 'chk-ok';
    } else if (o.why === 'afterWash') {
        why = '<b>' + esc(o.lotNumber) + '</b> is the smallest lot that can cover this whole order once its own ' +
              'greige is washed. Nothing goes out today — an order is served whole or not at all, so issuing ' +
              'the washed part would commit it to a lot that cannot yet finish it.';
        cls = 'chk-note';
    } else {
        why = 'No lot can cover this order whole, so <b>nothing was allocated to it</b> and the next order in the ' +
              'queue was tried instead. It needs ' + num(o.needMetres, 3) + ' ' + esc(unit) +
              ' from one lot.';
        cls = 'chk-bad';
    }

    var h = '<h5 class="sub">Which lot, and why</h5>' +
        '<div class="check ' + cls + '">' + why + '</div>';

    h += '<div class="inputs">' +
        '<div class="input-chip"><span>Order still owes</span><b>' + o.pieces + ' pcs</b></div>' +
        (o.lotNumber
            ? '<div class="input-chip strong"><span>Lot</span><b>' + esc(o.lotNumber) + '</b></div>'
            : '') +
        '<div class="input-chip"><span>Going out today</span><b>' + num(o.metres, 3) + ' ' + esc(unit) + '</b></div>' +
        (o.wastePieces > 0
            ? '<div class="input-chip"><span>Off that lot\'s offcuts</span><b>' + o.wastePieces + ' pcs</b></div>'
            : '') +
        (o.greige > 0
            ? '<div class="input-chip"><span>Waiting on the wash</span><b>' + num(o.greige, 3) + ' ' + esc(unit) + '</b></div>'
            : '') +
        '</div>';

    // A recorded override is the only place a deliberate shade change survives,
    // and it is the first thing to look for on an order that went out mixed.
    if (o.override) {
        h += '<div class="check chk-bad">The original lot was overridden by hand. Reason given: <b>' +
            esc(o.override) + '</b></div>';
    }

    // What the row on the store screen says, quoted, so the audit and the counter
    // can be checked against each other in one glance.
    var sr = live.m.shortReason;
    if (sr) {
        var said = '';
        if (sr.kind === 'wash') {
            said = sr.lots.map(function (w) {
                return w.lotNumber + ' · ' + num(w.qty, 3) + ' ' + unit + ' to wash';
            }).join(', ');
        } else if (sr.kind === 'atWash') {
            said = sr.lot + ' · ' + num(sr.qty, 3) + ' ' + unit + ' at the wash house';
        } else if (sr.kind === 'nofit') {
            said = num(sr.have, 3) + ' ' + unit + ' on ' + sr.lot + ', smallest job needs ' + num(sr.need, 3);
        } else if (sr.kind === 'pinnedDry') {
            said = sr.lot + ' is empty';
        } else if (sr.kind === 'pinnedBlocked') {
            said = 'cut from ' + sr.lot + ', which is blocked';
        } else if (sr.kind === 'blocked') {
            said = num(sr.qty, 3) + ' ' + unit + ' on ' + sr.lot + ' is blocked';
        } else if (sr.kind === 'nolots') {
            said = 'not booked in';
        } else if (sr.kind === 'nodata') {
            said = 'no cut size on the material';
        } else {
            said = 'none of this lot left';
        }
        h += '<div class="aside">The store screen shows this row as: <b>' + esc(said) + '</b>. ' +
            'That line belongs to the whole row, which may carry more than this one order.</div>';
    }

    return h;
}

function renderAllocStep(mat, bucket, item) {
    var h = '<div class="step step-issue"><div class="step-head"><span class="step-tag tag-issue">2</span>' +
        '<h4>Allocated right now</h4></div>';

    // A line with no bucket has nothing outstanding, and lineStage no longer
    // draws this step for one. Kept as a guard rather than deleted: the step is
    // also reached from rerenderWaste and redrawWorkRow, and a renderer that
    // assumes its caller filtered is one refactor away from a blank card.
    if (!bucket) {
        h += '<div class="aside">Nothing outstanding on this line, so no allocation is being made for it today.</div></div>';
        return h;
    }

    h += renderLotDecision(bucket, item);

    // WHOSE DEMAND IS IN THE POT. The bucket is one supervisor's demand for this
    // fabric at this cut size across every open plan, and it is what the offcut
    // stock is measured against — but it is NOT what the shade is decided on. That
    // is per order, above.
    var others = (bucket.lines || []).filter(function (l) { return !l.isThisOrder; });
    h += '<div class="inputs">' +
        '<div class="input-chip"><span>Supervisor</span><b>' + esc(bucket.supervisor) + '</b></div>' +
        '<div class="input-chip"><span>Demand in this bucket</span><b>' + bucket.requiredPieces + ' pcs</b></div>' +
        '<div class="input-chip"><span>Already issued</span><b>' + bucket.issuedPieces + ' pcs</b></div>' +
        '<div class="input-chip strong"><span>Still to allocate</span><b>' + bucket.outstandingPieces + ' pcs</b></div>' +
        '</div>';

    if (others.length) {
        h += '<div class="aside">This supervisor also has ' + others.length + ' line' +
            (others.length === 1 ? '' : 's') + ' of this fabric from other orders (' +
            esc(others.map(function (l) { return l.salesOrder + ' / ' + l.planNo; }).join(', ')) +
            '). They are served in priority order off the same rack, so what is left for ' +
            'this one depends on them — but each keeps its own lot.</div>';
        h += '<div class="table-wrapper"><table><thead><tr><th>Plan</th><th>Sales order</th><th class="r">Pieces</th><th class="r">Issued</th></tr></thead><tbody>';
        (bucket.lines || []).forEach(function (l) {
            h += '<tr class="' + (l.isThisOrder ? 'mine' : '') + '"><td>' + esc(l.planNo) + '</td><td>' + esc(l.salesOrder) +
                (l.isThisOrder ? ' <span class="pill pill-mine">this order</span>' : '') +
                '</td><td class="r">' + l.reqPieces + '</td><td class="r">' + l.issuedPieces + '</td></tr>';
        });
        h += '</tbody></table></div>';
    }

    var live = liveFor(bucket, item.planId);

    // THE OFFCUTS THIS ORDER IS ACTUALLY GETTING, from the allocator's own picks.
    //
    // This replaced a pass-by-pass scoring table. That table was read back from
    // getStoreMaterialRequirements' `wastePicks`, which the server stopped filling
    // when the allocation moved to the widget — so it rendered empty, and the
    // section above it said "no leftover piece was picked" on rows that were
    // getting several.
    //
    // It is also the wrong question now. Scoring only ever ran within ONE lot,
    // because a remnant carries its lot's shade — so "which piece scored best
    // across the rack" is a comparison the allocator never makes. What matters is
    // which pieces of the chosen shade this order takes.
    h += '<h5 class="sub">Offcuts this order takes</h5>';
    var mine = [];
    if (live) {
        var myItems = (bucket.lines || []).filter(function (l) { return l.isThisOrder; })
                                          .map(function (l) { return String(l.planItemId); });
        mine = (live.m.wastePicks || []).filter(function (pk) {
            return pk.pieces > 0 && myItems.indexOf(String(pk.planItemId)) > -1;
        });
    }
    if (!live) {
        h += '<div class="aside">Nothing outstanding for this order, so no offcuts are being allocated to it.</div>';
    } else if (!mine.length) {
        h += '<div class="aside">None. Either this lot has no usable offcuts on the rack, or the pieces it has ' +
            'do not fit a ' + num(bucket.cutLength) + '×' + num(bucket.cutWidth) + ' cm cut — grain is never rotated.</div>';
    } else {
        h += '<div class="table-wrapper"><table><thead><tr><th>Piece</th><th>Lot</th><th>Carton</th>' +
            '<th class="r">Pieces</th><th class="r">Cuts each</th></tr></thead><tbody>';
        mine.forEach(function (pk) {
            var perRow = Math.floor((parseFloat(pk.width) || 0) / (bucket.cutWidth || 1));
            var rows = Math.floor((parseFloat(pk.length) || 0) / (bucket.cutLength || 1));
            h += '<tr><td>' + num(pk.length) + ' × ' + num(pk.width) + ' cm</td>' +
                '<td><b>' + esc(pk.lot || '—') + '</b></td>' +
                '<td>' + (pk.carton ? esc(pk.carton) : '<span class="muted">not recorded</span>') + '</td>' +
                '<td class="r">' + pk.pieces + '</td>' +
                '<td class="r">' + (perRow * rows) + '</td></tr>';
        });
        h += '</tbody></table></div>';
    }

    // THE WHOLE RACK FOR THIS FABRIC, including what was not offered. A remnant
    // sitting in the store that nobody was offered is the thing an admin arrives
    // here to explain, and it can only be explained by showing it.
    //
    // The "unclaimed" column is gone. It was accumulated from the picks the server
    // reported, and the server reports none — so it read as unclaimed on every
    // row, including pieces another supervisor had already taken. A column that is
    // always the same number answers nothing.
    var pool = bucket.pool || [];
    if (pool.length) {
        h += '<h5 class="sub">Every offcut of this fabric on the rack</h5>' +
            '<div class="aside">Fit is judged on the cut alone. Whether a fitting piece is <b>offered</b> ' +
            'also depends on its lot — only offcuts of the one this order is committed to can be used, ' +
            'which is why a piece can be big enough and still not appear above.</div>';
        h += '<div class="table-wrapper"><table><thead><tr><th>Piece</th><th class="r">In stock</th>' +
            '<th class="r">Per row</th><th class="r">Rows</th><th class="r">Cuts each</th><th>Fits this cut</th></tr></thead><tbody>';
        pool.forEach(function (pp) {
            h += '<tr class="' + (pp.fits ? '' : 'dim') + '">' +
                '<td>' + num(pp.length) + ' × ' + num(pp.width) + ' cm</td>' +
                '<td class="r">' + pp.opening + '</td>' +
                '<td class="r">' + (pp.fits ? pp.perRow : '—') + '</td>' +
                '<td class="r">' + (pp.fits ? pp.maxRows : '—') + '</td>' +
                '<td class="r">' + (pp.fits ? pp.capacity : '—') + '</td>' +
                '<td>' + (pp.fits
                    ? '<span class="yes">yes</span>'
                    : '<span class="no">too small</span> <span class="muted">— needs ' +
                      num(bucket.cutLength) + '×' + num(bucket.cutWidth) + ' cm, grain never rotated</span>') +
                '</td></tr>';
        });
        h += '</tbody></table></div>';
    }

    // FRESH CLOTH, DERIVED AND THEN CHECKED against what the allocator decided.
    //
    // Both figures now come from the same run — the derivation from the piece
    // count, the answer from the allocator — so agreement is a real check on the
    // marker-row arithmetic rather than a number compared with itself.
    h += '<h5 class="sub">Fresh cloth off that lot</h5>';
    if (!live) {
        h += '<div class="aside">Nothing outstanding for this order.</div>';
    } else if (live.o.why === 'skipped') {
        h += '<div class="check chk-bad">None. No lot covers this order whole, so it was passed over — ' +
            'it needs <b>' + num(live.o.needMetres, 3) + ' ' + esc(bucket.unit || 'Mtr') +
            '</b> off one lot, and no single lot has that.</div>';
    } else {
        var mineFresh = Math.max(0, live.o.pieces - live.o.wastePieces);
        var perRowF = bucket.freshPerRow > 0
            ? bucket.freshPerRow
            : Math.floor((bucket.fabricWidthCm || 0) / (bucket.cutWidth || 1));
        var rowsF = perRowF > 0 ? Math.ceil(mineFresh / perRowF) : 0;
        var derived = (rowsF * (bucket.cutLength || 0)) / 100;

        h += '<div class="calc">' +
            factRow('Still to cut from fresh cloth',
                live.o.pieces + ' owed by this order, ' + live.o.wastePieces + ' of them off its own offcuts',
                '<b>' + mineFresh + '</b> pieces') +
            factRow('Pieces per row',
                num(bucket.fabricWidthCm) + ' cm of fabric width across a ' + num(bucket.cutWidth) + ' cm cut',
                '<b>' + perRowF + '</b> per row') +
            factRow('Rows needed',
                mineFresh + ' pieces at ' + perRowF + ' per row, rounded up',
                '<b>' + rowsF + '</b> rows') +
            factRow('Cloth that needs',
                rowsF + ' rows of ' + num(bucket.cutLength) + ' cm',
                '<b>' + num(derived, 3) + ' m</b>') +
            '</div>';

        // NOTHING OUT TODAY IS NOT A DISCREPANCY, and it reaches here by two roads
        // — an unpinned order committed to a shade only its greige can finish, and
        // a PINNED order whose shade has no washed cloth left. Tested on the
        // metres rather than on the reason, because the second road is the common
        // one and gating on `afterWash` alone sent it to the mismatch branch below,
        // where it reported the whole requirement as a 3.85 m disagreement.
        if (live.o.metres <= 0 && live.o.greige > 0) {
            h += '<div class="check chk-note">None of it goes out today: <b>' + esc(live.o.lotNumber) +
                '</b> has no washed cloth left, so this order waits on <b>' + num(live.o.greige, 3) +
                ' m</b> of its own greige coming back from the wash. It is not topped up from another ' +
                'lot — that would put the order in two shades.</div>';
        } else if (live.o.metres <= 0) {
            h += '<div class="check chk-note">Nothing goes out today. <b>' + esc(live.o.lotNumber) +
                '</b> has neither washed cloth nor greige left to wash.</div>';
        } else if (same(derived, live.o.metres)) {
            h += '<div class="check chk-ok">Matches the allocator: <b>' + num(live.o.metres, 3) +
                ' m</b> off <b>' + esc(live.o.lotNumber) + '</b>.</div>';
        } else {
            h += '<div class="check chk-bad">Does not match. This screen derives <b>' + num(derived, 3) +
                ' m</b>; the allocator is issuing <b>' + num(live.o.metres, 3) + ' m</b> off <b>' +
                esc(live.o.lotNumber) + '</b> — a difference of ' + num(Math.abs(derived - live.o.metres), 3) +
                ' m. The allocator figure is the one being acted on. A lot that cannot give the full ' +
                'length is the usual cause, and it will be short by whole rows.</div>';
        }

        if (live.o.shortPieces > 0) {
            h += '<div class="check chk-bad">Even off <b>' + esc(live.o.lotNumber) + '</b> this order stays <b>' +
                live.o.shortPieces + ' pieces</b> short. It is never topped up from a second lot to close ' +
                'that — short is a delay, mixed shade is a defect.</div>';
        }
    }

    h += '<div class="stock-line">Stock of this fabric, every lot together: <b>' +
        num(bucket.washStock, 3) + ' m</b> washed' +
        (bucket.unwashStock > 0 ? ', <b>' + num(bucket.unwashStock, 3) + ' m</b> unwashed' : '') +
        '. <span class="muted">A total, and deliberately not a test — cloth in the wrong shade cannot serve ' +
        'this order however much of it there is.</span></div>';

    h += '</div>';
    return h;
}


function renderWasteStep(mat, item, bucket) {
    var key = mat.reqId;

    // THE OFFCUTS THE ALLOCATOR WOULD PICK, for the forecast below.
    //
    // Came from getStoreMaterialRequirements' `wastePicks` until now, which the
    // server stopped filling when the allocation moved to the widget - so the
    // checkbox that offers this forecast never appeared and the option was
    // silently dead. Taken from the live allocation instead, filtered to this
    // order's items, so it is the same pieces step 2 names.
    var liveW = liveFor(bucket, item.planId);
    var wouldPick = [];
    if (liveW) {
        var myIt = (bucket.lines || []).filter(function (l) { return l.isThisOrder; })
                                       .map(function (l) { return String(l.planItemId); });
        wouldPick = (liveW.m.wastePicks || []).filter(function (pk) {
            return pk.pieces > 0 && myIt.indexOf(String(pk.planItemId)) > -1;
        });
    }
    var dflt = parseInt(item.qtyProduced, 10) || parseInt(item.qtyOrdered, 10) || 0;
    var pieces = CUT_QTY[key] === undefined ? dflt : CUT_QTY[key];

    // What the supervisor was actually handed for this item. Only what came
    // back received counts — a piece that never arrived cannot throw off a
    // leftover piece.
    var issued = (item.wasteIssued || []).filter(function (w) {
        return String(w.materialId) === String(mat.materialId) && w.received > 0;
    }).map(function (w) {
        return { width: w.width, length: w.length, count: w.received };
    });

    var assume = !!ASSUME_PICKS[key];
    var sources = issued;
    var hypothetical = false;
    if (!issued.length && assume && wouldPick.length) {
        sources = wouldPick.map(function (pk) {
            return { width: pk.width, length: pk.length, count: pk.pieces };
        });
        hypothetical = true;
    }

    var w = deriveWaste(mat, pieces, sources);

    // "Predicted" stays in the heading itself. It is the one word that has to
    // survive: everything in this step is a forecast, and an admin reading a
    // remnant table without knowing that would go looking for the pieces.
    var h = '<div class="step step-waste"><div class="step-head"><span class="step-tag tag-waste">3</span>' +
        '<h4>Waste this will throw off <span class="step-qual">predicted</span></h4></div>';

    h += '<div class="qty-box">' +
        '<label for="q-' + esc(key) + '">Pieces cut</label>' +
        '<input type="number" min="0" id="q-' + esc(key) + '" data-req="' + esc(key) + '" class="qty-input" value="' + pieces + '">' +
        '<span class="muted">defaults to ' + (item.qtyProduced > 0 ? 'the quantity produced' : 'the quantity ordered') + ' (' + dflt + '). Change it to test the maths.</span>' +
        '</div>';

    if (!issued.length) {
        if (wouldPick.length) {
            h += '<div class="qty-box">' +
                '<label class="chk"><input type="checkbox" data-assume="' + esc(key) + '"' + (assume ? ' checked' : '') + '> ' +
                'Assume the leftover pieces the allocator would pick</label>' +
                '<span class="muted">Nothing has been issued to this item yet. Ticking this predicts against the leftover pieces step 2 chose — a forecast, not a record.</span>' +
                '</div>';
        } else {
            h += '<div class="aside">No leftover pieces were issued to this item, so everything below comes off fresh cloth.</div>';
        }
    } else {
        h += '<div class="aside">Cut against the <b>' + issued.length + '</b> leftover piece row' + (issued.length === 1 ? '' : 's') +
            ' actually received for this item, then fresh cloth for the rest. That is the order the cutting is done in.</div>';
    }

    if (hypothetical) {
        h += '<div class="warn">Forecast only — these leftover pieces have not been issued yet.</div>';
    }

    if (!pieces) {
        h += '<div class="aside">Nothing cut, so nothing generated.</div></div>';
        return h;
    }

    if (w.steps.length) {
        h += '<h5 class="sub">Leftover pieces consumed first</h5><div class="calc">';
        w.steps.forEach(function (s) {
            if (s.kind === 'full') {
                h += factRow(s.src + ' — used to capacity',
                    s.used + ' piece' + (s.used === 1 ? '' : 's') + ' yielding ' + s.capacity + ' cuts each (' + s.perRow + ' per row, ' + s.maxRows + ' rows)',
                    '<b>' + s.covered + '</b> cut, ' + s.after + ' left');
            } else {
                h += factRow(s.src + ' — part used',
                    s.covered + ' cuts over ' + s.rows + ' row' + (s.rows === 1 ? '' : 's') +
                    (s.lastRow > 0 ? ', last row only ' + s.lastRow + ' of ' + s.perRow : ''),
                    '<b>' + s.covered + '</b> cut, 0 left');
            }
        });
        h += '</div>';
    }

    if (w.fresh) {
        h += '<h5 class="sub">Then fresh cloth</h5><div class="calc">' +
            factRow('Pieces off fresh cloth', 'left after leftover pieces', '<b>' + w.fresh.pieces + '</b> pieces') +
            factRow('Pieces per row',
                num(mat.fabricWidthCm) + ' cm of fabric width across a ' + num(mat.cutWidth) + ' cm cut',
                '<b>' + w.fresh.perRow + '</b> per row');

        // ONE ROW LINE PER LOT, because that is the shape of the cutting. A lot
        // is a separate roll: it ends on a whole marker row and the next lot
        // starts a new one, so two lots means two side strips and — where the
        // pieces do not divide evenly — two part rows. Showing a single combined
        // row count would hide the very split that makes the remnant list longer
        // than the arithmetic looks.
        var blocks = w.fresh.blocks || [];
        var multi = blocks.length > 1;
        blocks.forEach(function (b) {
            h += factRow(
                multi ? 'Rows off ' + (b.lot ? 'lot ' + esc(b.lot) : 'cloth with no lot recorded') : 'Rows',
                b.pieces + ' piece' + (b.pieces === 1 ? '' : 's') + ' — ' + b.fullRows + ' full' +
                    (b.lastRow > 0 ? ' + 1 part row (' + b.lastRow + ' of ' + w.fresh.perRow + ')' : ''),
                '<b>' + b.rows + '</b> row' + (b.rows === 1 ? '' : 's'));
        });
        if (multi) {
            h += factRow('Rows in total',
                blocks.length + ' separate blocks of cloth, each ending on a whole row',
                '<b>' + w.fresh.rows + '</b> rows');
        }

        h += factRow('Fresh cloth consumed',
                w.fresh.rows + ' rows of ' + num(mat.cutLength) + ' cm',
                '<b>' + num(w.fresh.metres, 3) + ' m</b> <span class="muted">(' + num(w.fresh.cm) + ' cm)</span>') +
            factRow('Side strip left beside the cuts',
                w.fresh.perRow + ' cuts of ' + num(mat.cutWidth) + ' cm leave the rest of the ' + num(mat.fabricWidthCm) + ' cm width',
                '<b>' + num(w.fresh.sideW) + ' cm</b> wide' + (multi ? ', one down each block' : '')) +
            '</div>';
    }

    if (w.uncut > 0) {
        h += '<div class="warn">' + w.uncut + ' piece' + (w.uncut === 1 ? '' : 's') +
            ' cannot be cut at all — the cut is wider than the fabric.</div>';
    }

    h += '<h5 class="sub">Remnants produced</h5>';
    if (!w.rows.length) {
        h += '<div class="aside">Nothing left over — every row filled exactly and no length remained.</div>';
    } else {
        var totalArea = 0, totalPieces = 0;
        w.rows.forEach(function (r) { totalArea += r.width * r.length * r.count; totalPieces += r.count; });

        h += '<div class="table-wrapper"><table><thead><tr><th>Type</th><th>Size</th><th class="r">Count</th><th>Cut from</th><th>Why it exists</th></tr></thead><tbody>';
        w.rows.forEach(function (r) {
            h += '<tr><td><span class="pill pill-' + r.origin + '">' + esc(ORIGIN_LABEL[r.origin]) + '</span></td>' +
                '<td><b>' + num(r.length) + ' × ' + num(r.width) + ' cm</b></td>' +
                '<td class="r">' + r.count + '</td>' +
                '<td class="muted">' + esc(r.from) + '</td>' +
                '<td class="muted">' + esc(ORIGIN_WHY[r.origin]) + '</td></tr>';
        });
        h += '</tbody></table></div>';

        // Yield, against fresh cloth only. Leftover piece area is already sunk cost —
        // counting it here would make a run that reused leftover pieces well look
        // wasteful, which is exactly backwards.
        if (w.fresh) {
            var freshArea = parseFloat(mat.fabricWidthCm) * w.fresh.cm;
            var cutArea = w.fresh.pieces * mat.cutWidth * mat.cutLength;
            var pct = freshArea > 0 ? (cutArea / freshArea) * 100 : 0;
            h += '<div class="yield"><b>' + totalPieces + '</b> remnant' + (totalPieces === 1 ? '' : 's') +
                ', <b>' + num(totalArea / 10000, 2) + ' m&sup2;</b> in total. ' +
                'Of the fresh cloth cut, <b>' + num(pct, 1) + '%</b> of the area became finished pieces ' +
                '(' + num(cutArea / 10000, 2) + ' m&sup2; of ' + num(freshArea / 10000, 2) + ' m&sup2;) — the rest returns as the remnants above.</div>';
        } else {
            h += '<div class="yield"><b>' + totalPieces + '</b> remnant' + (totalPieces === 1 ? '' : 's') +
                ', <b>' + num(totalArea / 10000, 2) + ' m&sup2;</b> in total, all off leftover pieces already in stock — no fresh cloth was cut.</div>';
        }
    }

    h += serverWasteCheck(mat, item, w, pieces);

    h += '</div>';
    return h;
}

// ---- the same question, answered by the function that actually runs ----
//
// `item.expectedWaste` is the getExpectedWaste payload for this item. It is
// fetched LAZILY (ensureExpectedWaste) the first time a fabric line's working is
// opened - one call, for the item being looked at.
//
// getAdminCalculation used to make this call itself, through thisapp, once per
// item inside its own execution. A Faire order is one plan with ~110 items, so
// that was ~110 cross-function calls in a single script - straight into the
// uncatchable statement limit (a bare 500, no error card). Moving the call into
// the widget, per item, on demand, is the same fix production.js's "Preview
// expected waste" button uses for the same reason.
//
// The JS mirror of the maths (deriveWaste, above) is still shown; this is the
// "measured against" half - the authoritative answer for the ordered quantity,
// beside the derivation, so a disagreement is visible.
function serverWaste(item, mat) {
    var ew = item && item.expectedWaste;
    if (!ew || !ew.fabrics) return null;
    var hit = null;
    ew.fabrics.forEach(function (f) {
        if (String(f.materialId) === String(mat.materialId)) hit = f;
    });
    return hit;
}

function serverWasteCheck(mat, item, w, pieces) {
    var ew = item && item.expectedWaste;

    // The payload is fetched lazily when this working is first opened. While
    // that call is in flight EXP_WASTE holds null; the row redraws itself when
    // it lands (redrawWorkRow).
    if (!ew && EXP_WASTE[String(item.planItemId)] === null) {
        return '<div class="check note">Checking against <b>getExpectedWaste</b>, the function that ' +
            'really runs…</div>';
    }

    if (ew && ew.errors && ew.errors.length) {
        return '<div class="check bad">getExpectedWaste could not answer for this item: ' +
            esc(ew.errors.join('; ')) + '</div>';
    }

    var srv = serverWaste(item, mat);
    if (!srv) {
        return '<div class="check note">The real function returned nothing for this fabric, ' +
            'so there is only the derivation above. That is expected before anything is issued ' +
            'against the item.</div>';
    }

    // THE COMPARISON IS ONLY MEANINGFUL AT THE SAME PIECE COUNT. The server
    // answered for the quantity on the item; the box above is a what-if the admin
    // can type anything into. Comparing across two different piece counts would
    // manufacture a disagreement out of the admin's own keystrokes — and this
    // screen crying wolf is worse than it staying quiet.
    var srvPieces = parseInt(srv.piecesCut, 10) || 0;
    if (srvPieces !== (parseInt(pieces, 10) || 0)) {
        return '<div class="check note">Not compared: the figures above are for <b>' + pieces +
            '</b> pieces, and the real function answered for the <b>' + srvPieces +
            '</b> on the item. Set the box back to ' + srvPieces + ' to check the two against each other.</div>';
    }

    var mine = w.fresh ? w.fresh.metres : 0;
    var theirs = parseFloat(srv.freshMetres) || 0;
    var myCount = 0;
    w.rows.forEach(function (r) { myCount += r.count; });
    var theirCount = 0;
    (srv.waste || []).forEach(function (r) { theirCount += (parseInt(r.count, 10) || 0); });

    // Offcuts are the one input the two halves can legitimately disagree about:
    // the derivation above spends whatever was RECEIVED against this item, while
    // getExpectedWaste spends the Issued movements it can see. Say so rather than
    // flagging a fault, otherwise a short waste receipt reads as broken maths.
    var offcutNote = w.steps.length
        ? ' Leftover pieces were spent first here, so a difference can also mean the two disagree about which offcuts this item got.'
        : '';

    if (same(mine, theirs) && myCount === theirCount) {
        return '<div class="check ok">Matches <b>getExpectedWaste</b>, the function that really runs: ' +
            '<b>' + num(theirs, 3) + ' m</b> of fresh cloth and <b>' + theirCount + '</b> remnant' +
            (theirCount === 1 ? '' : 's') + '.</div>';
    }

    return '<div class="check bad">Does not match <b>getExpectedWaste</b>, the function that really runs. ' +
        'It says <b>' + num(theirs, 3) + ' m</b> of fresh cloth and <b>' + theirCount + '</b> remnant' +
        (theirCount === 1 ? '' : 's') + '; the derivation above says <b>' + num(mine, 3) + ' m</b> and <b>' +
        myCount + '</b>. The derivation is a mirror of that function and one of the two has drifted.' +
        offcutNote + '</div>';
}

function renderNonFabric(mat, item) {
    var derived = (parseFloat(mat.perUnit) || 0) * (parseInt(item.qtyOrdered, 10) || 0);
    var h = '<div class="line line-plain"><div class="line-head">' +
        '<div><h3>' + esc(mat.material) + '</h3>' +
        (mat.sku ? '<span class="sku">' + esc(mat.sku) + '</span>' : '') + '</div>' +
        '<span class="pill pill-plain">Not fabric — no cutting</span></div>';

    h += '<div class="calc">' +
        factRow('Required',
            item.qtyOrdered + ' units at ' + num(mat.perUnit, 4) + ' ' + esc(mat.unit) + ' each',
            '<b>' + num(derived, 3) + ' ' + esc(mat.unit) + '</b>') +
        '</div>';

    // Same rule as the fabric block above.
    if (mat.isReissue === true) {
        h += '<div class="check note">Stored on the requirement: <b>' + num(mat.storedRequiredQty, 3) + ' ' + esc(mat.unit) + '</b> — ' +
            'this is a <b>reissue</b>, costed from the pieces reported spoiled rather than from the order.</div>';
    } else if (mat.perUnit > 0 && !same(derived, mat.storedRequiredQty)) {
        h += '<div class="check bad">Stored on the requirement: <b>' + num(mat.storedRequiredQty, 3) + '</b>. The BOM per-unit quantity has changed since this plan was created.</div>';
    } else {
        h += '<div class="check ok">Stored on the requirement: <b>' + num(mat.storedRequiredQty, 3) + ' ' + esc(mat.unit) + '</b>' +
            (mat.perUnit > 0 ? ' — matches.' : '. The BOM line is gone, so there is nothing left to check it against.') + '</div>';
    }

    h += '<div class="stock-line">Issued <b>' + num(mat.issuedQty, 3) + '</b>, received <b>' + num(mat.receivedQty, 3) + '</b>.</div>';
    h += '</div>';
    return h;
}

// THE LIVE ALLOCATION BUCKET, SYNTHESISED FROM `LIVE`.
//
// This used to be a row in `DATA.buckets`, which getAdminCalculation built by
// calling getStoreMaterialRequirements through thisapp and walking its output.
// That cross-call is gone - the Deluge function no longer touches the store
// function at all - so the bucket is now assembled here from `LIVE`
// (ApiExperiment.run() + applyLotAllocation), the SAME data the store screen
// runs on. Every field the renderers read is either already on the LIVE material
// entry or is pure geometry derived from the cut size, so nothing is lost.
//
// `key` is `supId|matId|<cutW*100>x<cutL*100>|Plan|Reissue`, still built
// server-side on the Material_Requirement line (getAdminCalculation PART 2) and
// carried on `mat.bucketKey`. Parsed here to find the matching LIVE material.
function bucketFor(key) {
    if (!key || !LIVE) return null;

    var parts = String(key).split('|');
    if (parts.length < 4) return null;
    var supId = parts[0];
    var matId = parts[1];
    var srcWanted = parts[3]; // "Plan" or "Reissue"

    var m = null;
    (LIVE || []).forEach(function (sup) {
        if (String(sup.supervisorId) !== String(supId)) return;
        (sup.materials || []).forEach(function (mm) {
            if (!mm.isFabric || String(mm.materialId) !== String(matId)) return;
            var mmSrc = (mm.isReissue === true) ? 'Reissue' : 'Plan';
            if (mmSrc !== srcWanted) return;
            if (!m) m = { sup: sup, mat: mm };
        });
    });
    if (!m) return null;

    var mat = m.mat;
    var cutW = Number(mat.cutWidth) || 0;
    var cutL = Number(mat.cutLength) || 0;

    // Competing lines: every order of this supervisor for this fabric. The
    // widget wants planNo / salesOrder / reqPieces / issuedPieces / planItemId
    // per line, plus which ones belong to the order being audited - and that
    // last flag is the caller's (it knows myPlanIds), so it is left to the
    // renderers, which already filter `bucket.lines` by `l.isThisOrder`.
    var lines = (mat.lines || []).map(function (l) {
        return {
            planId: String(l.planId || ''),
            planNo: l.planNo || '',
            salesOrder: l.salesOrder || '',
            planItemId: String(l.planItemId || ''),
            reqPieces: Number(l.reqPieces) || 0,
            issuedPieces: Number(l.issPieces) || 0,
            isThisOrder: MY_PLAN_IDS.indexOf(String(l.planId || '')) > -1
        };
    });

    // The whole rack for this fabric, with fit geometry. `wasteStock` is every
    // remnant of the material (raw, lot-tagged); "fits" is judged on the cut
    // alone, exactly as the Deluge did.
    var pool = (mat.wasteStock || []).map(function (w) {
        var pw = Number(w.width) || 0;
        var pl = Number(w.length) || 0;
        var pc = Number(w.pieces) || 0;
        var fits = false, perRow = 0, maxRows = 0;
        if (cutW > 0 && cutL > 0 && pw >= cutW && pl >= cutL) {
            fits = true;
            perRow = Math.floor(pw / cutW);
            maxRows = Math.floor(pl / cutL);
        }
        return {
            wasteId: String(w.wasteId || ''),
            width: pw, length: pl,
            opening: pc, left: pc,
            fits: fits, perRow: perRow, maxRows: maxRows,
            capacity: perRow * maxRows
        };
    });

    var freshPerRow = 0;
    var fabWcm = Number(mat.fabricWidthCm) || 0;
    if (fabWcm > 0 && cutW > 0) freshPerRow = Math.floor(fabWcm / cutW);

    return {
        key: key,
        supervisorId: String(supId),
        supervisor: mat.supervisorName || m.sup.supervisorName || '',
        materialId: String(matId),
        unit: mat.unit || 'Mtr',
        cutWidth: cutW,
        cutLength: cutL,
        fabricWidthCm: fabWcm,
        freshPerRow: freshPerRow,
        washStock: Number(mat.availableStock) || 0,
        unwashStock: Number(mat.unwashedStock) || 0,
        requiredPieces: Number(mat.requiredPieces) || 0,
        issuedPieces: Number(mat.issuedPieces) || 0,
        outstandingPieces: Number(mat.outstandingPieces) || 0,
        lines: lines,
        pool: pool
    };
}

// ---- the answer table: one row per material, working behind a chevron ----
//
// This is the screen. Everything below it is evidence, opened when a row looks
// wrong, and the tick in the CHECK column is what says which row that is.
//
// PLANNED and STORED are the only two compared. They are the SAME calculation -
// the plan-time requirement, derived here versus what was written on the
// Material_Requirement - so they must agree, and a mismatch means a cut size or
// fabric width changed after the plan was made.
//
// A "Now needed" column used to sit here, showing the live allocator's metres
// for this material+cut. It was removed: that figure is pooled per order across
// every plan item sharing the material+cut (not per item, despite the row being
// per item), and on a lot with fragmented rolls it can cost more whole rows than
// either item's own PLANNED figure implies - a real number, but not one this
// per-item row can present without misleading. See git history if this needs
// to come back with a proper cross-item breakdown.
function matAnswerRow(mat, item, idx) {
    var unit = mat.isFabric ? 'Mtr' : (mat.unit || '');
    var planned, cls, mark, note;

    if (mat.isFabric) {
        var d = derivePlan(mat, item.qtyOrdered);
        planned = d.ok ? num(d.metres, 3) : '—';
    } else {
        planned = num((parseFloat(mat.perUnit) || 0) * (parseInt(item.qtyOrdered, 10) || 0), 3);
    }

    // A reissue is costed from the pieces reported spoiled, not from the order,
    // so the order's own derivation can never match it. Flagged as bad it would
    // mark every reissue row and bury the real discrepancies.
    if (mat.isReissue === true) {
        cls = 'chk-note'; mark = 'reissue'; note = 'Costed from spoiled pieces, not from the order';
    } else if (planned !== '—' && same(parseFloat(planned), mat.storedRequiredQty)) {
        cls = 'chk-ok'; mark = '&#10003;'; note = 'Derived figure matches what is stored';
    } else if (planned === '—') {
        cls = 'chk-note'; mark = '—'; note = 'Not enough information to derive it';
    } else {
        cls = 'chk-bad'; mark = '&#9888;'; note = 'Stored figure does not match the derivation';
    }

    var bucket = mat.isFabric ? bucketFor(mat.bucketKey) : null;

    // PLANNED OFFCUT REUSE, before anybody issues anything.
    //
    // This is not a forecast this screen invents. It comes from LIVE - the store
    // screen's own allocator (applyLotAllocation) run over ApiExperiment.run() -
    // so these are the very picks the store person is about to be offered, and
    // the admin can see which remnants a sales order is going to consume while
    // the cloth is still on the rack.
    //
    // Pulled up into the answer table rather than left in the working, because
    // "what are we reusing" is a question asked of the whole order at once, and
    // a chevron per material is the wrong shape for it.
    //
    // ADVISORY, and it moves. The allocation re-runs on every load and claims
    // pieces in priority order, so another supervisor's card taking the same
    // remnant first will change it. That is why the cell is muted rather than
    // presented as a commitment.
    // FROM THE LIVE ALLOCATION, not from the server's digest of it. The three
    // fields this used to read - coveredByWaste, passes, freshMetres - stopped
    // being the allocation when lots arrived, so the column read "none" on every
    // row and "now needed" repeated the plan figure it exists to differ from.
    var liveA = mat.isFabric ? liveFor(bucket, item.planId) : null;

    var offcuts = '—';
    var lot = '<span class="muted">—</span>';

    if (mat.isFabric) {
        if (!bucket) {
            // Nothing outstanding, so no lot is being decided. What it WAS cut
            // from is recorded and worth showing in its place.
            if (mat.pinLot) lot = '<b>' + esc(mat.pinLot) + '</b>';
        } else if (!liveA) {
            offcuts = '<span class="muted">none</span>';
            if (mat.pinLot) lot = '<b>' + esc(mat.pinLot) + '</b>';
        } else {
            offcuts = liveA.o.wastePieces > 0
                ? '<b>' + liveA.o.wastePieces + '</b> pcs'
                : '<span class="muted">none</span>';

            if (liveA.o.why === 'skipped') {
                lot = '<span class="no">none fits</span>';
            } else {
                lot = '<b>' + esc(liveA.o.lotNumber) + '</b>';
                if (liveA.o.why === 'pinned') {
                    lot += ' <span class="muted">pinned</span>';
                } else if (liveA.o.why === 'afterWash') {
                    lot += ' <span class="muted">after wash</span>';
                }
                if (liveA.o.override) lot += ' <span class="no">overridden</span>';
            }
        }
    }

    // LOT and FROM OFFCUTS CANNOT APPLY TO A TRIM. Thread has no shade to match
    // and no offcut to reuse — the columns exist for cloth. They printed "—" on
    // every trim row, which reads as "we looked and there is none" rather than
    // "the question does not arise", and on the screenshot's item three of the
    // four rows were trims. Muted so the eye skips them instead of checking them.
    var naCell = '<span class="cell-na" title="Does not apply to a non-fabric material">—</span>';

    return '<tr class="ans-row' + (mat.isFabric ? '' : ' is-trim') + '" data-ans="' + esc(mat.reqId) + '">' +
        '<td class="ans-mat">' +
            '<div class="ans-name">' + esc(mat.material) + '</div>' +
            '<div class="ans-sub">' + (mat.sku ? esc(mat.sku) : '') +
                (mat.isFabric
                    ? (mat.sku ? ' · ' : '') + num(mat.cutLength) + ' × ' + num(mat.cutWidth) + ' cm cut (L × W)'
                    : (mat.sku ? ' · ' : '') + 'not fabric') +
            '</div></td>' +
        '<td class="r">' + esc(unit) + '</td>' +
        '<td class="r">' + planned + '</td>' +
        '<td class="r">' + num(mat.storedRequiredQty, 3) + '</td>' +
        '<td class="r ' + cls + '" title="' + esc(note) + '">' + mark + '</td>' +
        '<td class="lot-cell">' + (mat.isFabric ? lot : naCell) + '</td>' +
        '<td class="r offcut-cell">' + (mat.isFabric ? offcuts : naCell) + '</td>' +
        '<td class="r">' + num(mat.issuedQty, 3) + '</td>' +
        '<td class="r">' + num(mat.receivedQty, 3) + '</td>' +
        '<td class="r"><button type="button" class="ans-toggle" title="Show the working" ' +
            'aria-label="Show the working" data-ans-toggle="' + esc(mat.reqId) + '">' +
            // Inline SVG, not a text triangle. U+25BE renders at whatever size
            // the font feels like and vanishes in some of them; this is the same
            // chevron the store widget uses, so the two screens agree.
            '<span class="chevron" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
                'stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
            '</span></button></td>' +
        '</tr>' +
        '<tr class="work-row" id="work-' + esc(mat.reqId) + '" hidden>' +
        '<td colspan="10">' + (mat.isFabric ? renderFabricLine(mat, item) : renderNonFabric(mat, item)) + '</td>' +
        '</tr>';
}

function renderItemMaterials(item) {
    if (!item.materials.length) {
        return '<div class="aside">No materials on this item' +
            (item.hasBom ? '' : ' — it has no BOM, so nothing was ever required') + '.</div>';
    }
    // THE GLOSSARY MOVED ONTO THE COLUMNS. Each `title` is the sentence that
    // used to sit in the paragraph below the table, attached to the heading that
    // raises the question — so it is read when it is asked rather than once,
    // above, before it has occurred to anybody.
    var h = '<div class="table-wrapper"><table class="ans-table"><thead><tr>' +
        '<th>Material</th><th class="r">Unit</th>' +
        '<th class="r" title="The requirement fixed when the plan was made. Derived here from the cut size and fabric width.">Planned</th>' +
        '<th class="r" title="What was actually written on the requirement at plan time. Must agree with Planned.">Stored</th>' +
        '<th class="r" title="Whether Planned and Stored agree. They are the same calculation, so a cross means a cut size or fabric width changed after the plan was made.">Check</th>' +
        // LOT, not "Shade". Every other screen in the app calls this a lot — the
        // store's issue column, the Lot_Number field, the L1/L2 the store person
        // reads off the rack — and one screen using a private word for it made
        // the audit harder to check against the thing it audits. The shade is WHY
        // the lot matters, not another name for it, so the word survives where it
        // is doing that job and nowhere else.
        '<th title="The roll this order is committed to. One order is cut from one lot so its pieces match in colour; the reason it was chosen is in the working.">Lot</th>' +
        '<th class="r" title="What the store is about to be offered off that same lot, read live from the store screen. Advisory — a higher-priority supervisor can claim the same remnant first.">From offcuts</th>' +
        '<th class="r">Issued</th><th class="r">Received</th><th></th>' +
        '</tr></thead><tbody>';
    item.materials.forEach(function (mat, i) { h += matAnswerRow(mat, item, i); });
    h += '</tbody></table></div>';

    // THE COLUMN GLOSSARY THAT USED TO SIT HERE IS GONE. It was a five-sentence
    // paragraph explaining Planned / Stored / Now needed / Lot / From offcuts,
    // and it printed once PER ITEM — so a ten-item order carried ten identical
    // copies of it and a Faire order carried a hundred and ten. Each remaining
    // column's explanation now lives on its own `title` attribute instead.
    return h;
}

// ---- step 4: what actually went out, shade by shade ----
//
// The three steps above are what the machine WOULD do — re-derived, live, and
// they move with the rack. This is the only record of what a person actually did,
// and it is the one that can answer the question the audit exists for: which
// shade was this order cut in, and if it went out in two, who decided that and
// why.
//
// Read from Material_Issue.Issue_Lines, where the lot is stamped as the cloth
// crosses the counter. The requirement records metres and has never recorded
// which cloth they were.
//
// THE PIN IS THE CLAIM AND THE LINES ARE THE EVIDENCE. Material_Requirement
// .Issued_Lot holds the shade this order started in and is never overwritten, so
// a line disagreeing with it is not a bug — it is a recorded human decision, and
// the note beside it is the only place the reason survives.
// Every distinct lot this ORDER has taken of one material, across all its items.
//
// The plan is the order — createProductionPlans inserts one plan per order — so
// walking the plan that owns this requirement row answers the order-level
// question. "not recorded" is left out: a pre-lot handover is not a second
// colour, it is an unknown one, and counting it would report mixing on orders
// that predate lots entirely.
function orderLots(mat) {
    var seen = {};
    var order = [];
    (DATA && DATA.plans ? DATA.plans : []).forEach(function (p) {
        var ownsIt = (p.items || []).some(function (i) {
            return (i.materials || []).some(function (m) {
                return String(m.reqId) === String(mat.reqId);
            });
        });
        if (!ownsIt) return;
        (p.items || []).forEach(function (i) {
            (i.materials || []).forEach(function (m) {
                if (String(m.materialId) !== String(mat.materialId)) return;
                (m.issuedLots || []).forEach(function (li) {
                    var lot = String(li.lot || '').trim();
                    if (!lot || lot === 'not recorded' || seen[lot]) return;
                    seen[lot] = true;
                    order.push(lot);
                });
            });
        });
    });
    return order;
}

function renderIssuedStep(mat) {
    // "Recorded" is the counterpart of step 3's "predicted", and the pair is the
    // whole distinction this screen turns on. Two words, kept.
    var h = '<div class="step step-issued"><div class="step-head"><span class="step-tag tag-issued">4</span>' +
        '<h4>What actually went out <span class="step-qual">recorded</span></h4></div>';

    var rows = mat.issuedLots || [];
    var unit = mat.isFabric ? 'Mtr' : (mat.unit || '');

    if (!mat.pinLot && !rows.length) {
        h += '<div class="aside">Nothing has been handed over for this line yet, so no lot has been ' +
            'committed to. The decision above is still free to change with the rack.</div></div>';
        return h;
    }

    if (mat.pinLot) {
        h += '<div class="check chk-note">This order is committed to lot <b>' + esc(mat.pinLot) +
            '</b>. Every later handover on it — a second issue, a remake, a reissue — has to come off ' +
            'that same lot, or the finished pieces will not match.</div>';
    } else {
        h += '<div class="check chk-bad">Cloth has gone out but no lot is recorded against the requirement. ' +
            'This is a handover from before lots existed, or the pin was never stamped — nothing can hold a ' +
            'later remake to the right lot.</div>';
    }

    if (!rows.length) {
        h += '<div class="aside">No handover lines carry a lot for this material. The metres were issued ' +
            'before lots existed, so which cloth they were is not recoverable.</div></div>';
        return h;
    }

    h += '<div class="table-wrapper"><table><thead><tr><th>Lot</th><th class="r">Issued</th>' +
        '<th class="r">Confirmed</th><th>When</th><th>Against the pin</th></tr></thead><tbody>';

    rows.forEach(function (r) {
        var verdict;
        if (r.overrideFrom) {
            // The one case that is a decision rather than a discrepancy.
            verdict = '<span class="no">overridden</span> <span class="muted">— should have been ' +
                esc(r.overrideFrom) + (r.note ? ': ' + esc(r.note) : '') + '</span>';
        } else if (!mat.pinLot || r.lot === 'not recorded') {
            verdict = '<span class="muted">nothing to compare</span>';
        } else if (String(r.lot) === String(mat.pinLot)) {
            verdict = '<span class="yes">matches</span>';
        } else {
            // No override note and a different lot: nobody recorded a decision, so
            // this is the shape a silent shade switch would take.
            verdict = '<span class="no">does not match</span> <span class="muted">— pin says ' +
                esc(mat.pinLot) + ', and no reason was recorded</span>';
        }

        var short = (parseFloat(r.qty) || 0) - (parseFloat(r.settled) || 0);
        h += '<tr><td><b>' + esc(r.lot) + '</b></td>' +
            '<td class="r">' + num(r.qty, 3) + ' ' + esc(unit) + '</td>' +
            '<td class="r">' + num(r.settled, 3) +
                (short > 0.005 ? ' <span class="muted">(' + num(short, 3) + ' still in transit)</span>' : '') +
            '</td>' +
            '<td>' + esc(r.on || '—') + '</td>' +
            '<td>' + verdict + '</td></tr>';
    });
    h += '</tbody></table></div>';

    // The finding this whole step exists to surface, stated rather than left to be
    // spotted by reading a column.
    //
    // ASKED ACROSS THE WHOLE ORDER, NOT THIS LINE. `issuedLots` is keyed by
    // Plan_Item, so the table above is one ITEM's handovers — but "one lot per
    // order" is an ORDER-level rule: the allocator pins per plan, and the pin is
    // then copied onto each item's requirement row. An order whose bag came off
    // L1 and whose basket came off L2 therefore had every line reading "matches"
    // against its own pin and "one lot throughout" underneath it, while the order
    // it belongs to was cut in two colours — the one finding this step exists for,
    // invisible precisely when it had happened.
    var lotsUsed = orderLots(mat);
    if (lotsUsed.length > 1) {
        h += '<div class="check chk-bad">This order has been cut from <b>' + lotsUsed.length +
            ' different lots</b> (' + esc(lotsUsed.join(', ')) + ') across its items. The finished pieces ' +
            'will not match each other, and that cannot be undone.</div>';
    } else if (lotsUsed.length === 1) {
        h += '<div class="check chk-ok">One lot throughout, so every piece matches.</div>';
    }

    h += '</div>';
    return h;
}

function renderFabricLine(mat, item) {
    var bucket = bucketFor(mat.bucketKey);
    var stage = lineStage(mat, item, bucket);
    var h = '<div class="line">';

    // Step 1 always draws: the plan-time requirement exists for every line from
    // the moment the plan does, and it is the half of the Planned/Stored pair
    // the CHECK column reports on.
    h += renderPlanStep(mat, item);

    if (stage.showAlloc) h += renderAllocStep(mat, bucket, item);
    if (stage.showWaste) h += renderWasteStep(mat, item, bucket);

    // Last, deliberately. The steps above are what the machine WOULD do; this is
    // the only record of what a person actually did, and it is what the others
    // are checked against.
    if (stage.showIssued) h += renderIssuedStep(mat);

    // A STEP THAT IS ABSENT MUST SAY IT WAS SKIPPED, NOT JUST VANISH. The four
    // are numbered, so a working that jumps 1 → 4 reads as a rendering fault to
    // anyone who has seen the full set — and "why is there no step 2 on this
    // row" is exactly the question the numbering was meant to stop.
    //
    // One muted line, naming what was skipped and why, is cheaper than either
    // the paragraphs it replaced or the doubt it prevents.
    var skipped = [];
    if (!stage.showAlloc) skipped.push('<b>2 Allocated right now</b> — nothing outstanding, so no lot is being decided today');
    if (!stage.showWaste) skipped.push('<b>3 Waste this will throw off</b> — a forecast, and this line is already cut');
    if (!stage.showIssued) skipped.push('<b>4 What actually went out</b> — nothing has crossed the counter yet');
    if (skipped.length) {
        h += '<div class="steps-skipped">Not shown: ' + skipped.join(' · ') + '</div>';
    }

    h += '</div>';
    return h;
}

// =====================================================================
// THE VERDICT — every check this screen can make, run over the whole order
// at once, stated before any of the working.
//
// WHY THIS EXISTS. The screen could already detect nine distinct kinds of
// problem, and exactly two of them (stored-vs-derived, on fabric and on trims)
// reached the answer table's CHECK column. The other seven — an order cut from
// two lots, a handover that disagrees with its pin, a lot overridden by hand,
// cloth issued with no lot recorded at all — were each rendered inside a step,
// behind a chevron, on one material of one item. So the admin could only find
// them by already suspecting them, on the right order out of a hundred and
// seven, and the most expensive finding on the list (mixed shade, which cannot
// be undone once it has happened) was the most deeply buried.
//
// This is a pure pass over DATA. It deliberately does NOT read LIVE: the
// allocator's own disagreements are a different class of thing — they move with
// the rack, they resolve themselves, and a banner that changed between two loads
// of the same order would teach the admin to distrust it. Everything reported
// here is settled fact that will still be true tomorrow. It also means the
// verdict renders immediately, without waiting on ApiExperiment.run().
//
// Severity is two levels and no more. `bad` is something that is wrong and needs
// a person; `note` is a recorded human decision worth seeing but not a fault. A
// third level would need a rule for telling them apart that nobody would apply
// consistently.
// One finding, built from the location it was found at plus what was found.
// Written out longhand rather than with Object.assign: this widget is
// ES5-flavoured throughout (var/function, no arrow, no spread) and the one rule
// CLAUDE.md gives about widget style is to match the file you are in.
function finding(where, level, kind, what, detail) {
    return {
        planItemId: where.planItemId,
        reqId: where.reqId,
        item: where.item,
        material: where.material,
        level: level,
        kind: kind,
        what: what,
        detail: detail
    };
}

function collectFindings() {
    var out = [];
    var plans = (DATA && DATA.plans) ? DATA.plans : [];

    // Mixed shade is asked ONCE PER MATERIAL for the whole order, not per line.
    // orderLots already answers the order-level question, but it is called from
    // inside step 4 — so on a four-material item it ran up to four times and
    // reported the same defect four times. Keyed here so it is stated once.
    var lotsReported = {};

    plans.forEach(function (plan) {
        (plan.items || []).forEach(function (item) {
            item.planId = plan.planId;

            (item.materials || []).forEach(function (mat) {
                var where = {
                    planItemId: String(item.planItemId),
                    reqId: String(mat.reqId),
                    item: item.itemName || '',
                    material: mat.material || ''
                };

                // ---- 1. stored vs derived, the CHECK column's own test ----
                // A reissue is exempt: it is costed from the pieces reported
                // spoiled, not from the order, so the order's derivation can
                // never match it. Same rule the renderers apply.
                if (mat.isReissue !== true) {
                    if (mat.isFabric) {
                        var d = derivePlan(mat, item.qtyOrdered);
                        if (d.ok && !same(d.metres, mat.storedRequiredQty)) {
                            out.push(finding(where, 'bad', 'stored',
                                'Stored requirement disagrees with the derivation',
                                'stored ' + num(mat.storedRequiredQty, 3) + ' m, derived ' +
                                num(d.metres, 3) + ' m — a cut size or fabric width changed after the plan was made'));
                        }
                    } else if ((parseFloat(mat.perUnit) || 0) > 0) {
                        var derived = (parseFloat(mat.perUnit) || 0) * (parseInt(item.qtyOrdered, 10) || 0);
                        if (!same(derived, mat.storedRequiredQty)) {
                            out.push(finding(where, 'bad', 'stored',
                                'Stored requirement disagrees with the BOM',
                                'stored ' + num(mat.storedRequiredQty, 3) + ', BOM gives ' +
                                num(derived, 3) + ' — the per-unit quantity changed since this plan was created'));
                        }
                    }
                }

                if (!mat.isFabric) return;

                // ---- 2. MIXED SHADE. The one that cannot be undone. ----
                var lotKey = String(mat.materialId);
                if (!lotsReported[lotKey]) {
                    var used = orderLots(mat);
                    if (used.length > 1) {
                        lotsReported[lotKey] = true;
                        out.push(finding(where, 'bad', 'mixedlot',
                            'Cut from ' + used.length + ' different lots',
                            used.join(', ') + ' — the finished pieces will not match each other, ' +
                            'and that cannot be undone'));
                    }
                }

                // ---- 3. cloth out with no pin to hold a remake to ----
                var anyIssued = (parseFloat(mat.issuedQty) || 0) > 0 || (mat.issuedLots || []).length > 0;
                if (anyIssued && !mat.pinLot) {
                    out.push(finding(where, 'bad', 'nopin',
                        'Cloth went out with no lot recorded',
                        'nothing can hold a later remake or reissue to the right lot'));
                }

                // ---- 4. per-handover: overrides and silent disagreements ----
                (mat.issuedLots || []).forEach(function (r) {
                    if (r.overrideFrom) {
                        // A DECISION, not a fault — somebody chose this and said
                        // why. Worth surfacing precisely because the note is the
                        // only place the reason survives.
                        out.push(finding(where, 'note', 'override',
                            'Lot overridden by hand',
                            'issued off ' + r.lot + ' instead of ' + r.overrideFrom +
                            (r.note ? ' — ' + r.note : ' — no reason recorded')));
                    } else if (mat.pinLot && r.lot && r.lot !== 'not recorded' &&
                               String(r.lot) !== String(mat.pinLot)) {
                        // No override note and a different lot: this is the shape
                        // a silent shade switch takes.
                        out.push(finding(where, 'bad', 'pin',
                            'A handover disagrees with the pinned lot',
                            'went out on ' + r.lot + ', pin says ' + mat.pinLot +
                            ', and no reason was recorded'));
                    }
                });
            });
        });
    });

    return out;
}

// How many material lines the verdict actually examined, so "all agree" can say
// what it checked. A claim of correctness that does not say over what is not
// worth much more than silence.
function countLines() {
    var n = 0;
    ((DATA && DATA.plans) ? DATA.plans : []).forEach(function (p) {
        (p.items || []).forEach(function (i) { n += (i.materials || []).length; });
    });
    return n;
}

function renderVerdict(findings) {
    var lines = countLines();
    var bad = findings.filter(function (f) { return f.level === 'bad'; });
    var notes = findings.filter(function (f) { return f.level === 'note'; });

    if (!findings.length) {
        return '<div class="verdict verdict-ok">' +
            '<span class="verdict-mark">&#10003;</span>' +
            '<div><b>' + lines + ' material line' + (lines === 1 ? '' : 's') + ' checked, all agree.</b>' +
            '<span>Every stored requirement matches its derivation, and every handover went out on the ' +
            'lot the order is pinned to. Nothing on this order needs attention.</span></div></div>';
    }

    var head;
    if (bad.length && notes.length) {
        head = bad.length + ' finding' + (bad.length === 1 ? '' : 's') + ' and ' +
            notes.length + ' recorded decision' + (notes.length === 1 ? '' : 's');
    } else if (bad.length) {
        head = bad.length + ' finding' + (bad.length === 1 ? '' : 's');
    } else {
        head = notes.length + ' recorded decision' + (notes.length === 1 ? '' : 's') + ', nothing wrong';
    }

    var h = '<div class="verdict ' + (bad.length ? 'verdict-bad' : 'verdict-note') + '">' +
        '<span class="verdict-mark">' + (bad.length ? '&#9888;' : 'i') + '</span>' +
        '<div><b>' + head + ' on this order.</b>' +
        '<span>Checked ' + lines + ' material line' + (lines === 1 ? '' : 's') + '. ' +
        'Each one below opens the working it came from.</span>' +
        '<ul class="verdict-list">';

    // Worst first: an order cut in two shades is not the same size of problem as
    // a note somebody left deliberately, and the order they are listed in is the
    // only thing saying so.
    findings.slice().sort(function (a, b) {
        if (a.level !== b.level) return a.level === 'bad' ? -1 : 1;
        return 0;
    }).forEach(function (f) {
        h += '<li class="vf vf-' + f.level + '" data-goto="' + esc(f.reqId) + '">' +
            '<b>' + esc(f.what) + '</b>' +
            '<span class="vf-where">' + esc(f.item) +
                (f.material ? ' · ' + esc(f.material) : '') + '</span>' +
            '<span class="vf-detail">' + esc(f.detail) + '</span>' +
            '</li>';
    });

    h += '</ul></div></div>';
    return h;
}

// Which items carry a finding — used to decide what stays open. An item with
// something wrong on it opens; a clean one collapses, so on a mixed order the
// eye lands on the problem and on a clean order the verdict line is the whole
// answer. Collapsing everything on a clean order was the other option and it is
// worse: this is an audit screen, and hiding the work that proves the order
// clean is the wrong instinct.
function itemsWithFindings(findings) {
    var set = {};
    findings.forEach(function (f) { set[f.planItemId] = true; });
    return set;
}

function render() {
    var content = document.getElementById('content');
    var empty = document.getElementById('empty');

    if (!DATA || !DATA.plans || !DATA.plans.length) {
        content.innerHTML = '';
        empty.classList.remove('hidden');
        empty.querySelector('h2').textContent = DATA ? 'No plans on this order' : 'Pick a sales order';
        empty.querySelector('p').textContent = DATA
            ? 'Nothing has been planned against it yet, so there is nothing to calculate.'
            : 'Every fabric line on it will be broken down step by step.';
        return;
    }
    empty.classList.add('hidden');

    var h = '';
    if (DATA.errors && DATA.errors.length) {
        h += '<div class="warn top">' + DATA.errors.map(esc).join('<br>') + '</div>';
    }

    // THE VERDICT FIRST. The working below is evidence; this is the conclusion,
    // and an audit screen that makes you derive the conclusion yourself from a
    // hundred and seven orders is only half a tool.
    var findings = collectFindings();
    var flagged = itemsWithFindings(findings);
    h += renderVerdict(findings);

    DATA.plans.forEach(function (plan) {
        h += '<section class="plan-card"><div class="plan-head">' +
            '<h2>' + esc(plan.planNo) + '</h2>' +
            '<span class="pill pill-status">' + esc(plan.status) + '</span>' +
            '<span class="muted">' + esc(plan.supervisor) + '</span></div>';

        if (!plan.items.length) {
            h += '<div class="aside">This plan has no items.</div>';
        }

        plan.items.forEach(function (item, idx) {
            // WHAT OPENS. An item carrying a finding opens; a clean one is shut.
            //
            // It used to be "the first item, always", which on a clean order
            // opened a screenful of working nobody needed and on a bad order
            // opened item 1 while the problem sat in item 7. Now the layout
            // itself points at the thing to look at.
            //
            // The fallback matters: an order with NO findings and no flagged
            // item would otherwise render entirely collapsed, and a screen that
            // shows nothing on arrival reads as a failure to load. So a clean
            // order still opens its first item — the verdict says everything
            // agrees, and the open item is what that claim is made of.
            var hasFinding = !!flagged[String(item.planItemId)];
            var open = hasFinding || (!findings.length && idx === 0);
            // The item carries its plan from here down. The lot decision is made
            // PER ORDER, and a supervisor's row in the live allocation holds every
            // order of his for that fabric — so without this the audit would show
            // another order's shade beside this one's numbers. Stamped rather than
            // threaded through five signatures; DATA is re-fetched on every load.
            item.planId = plan.planId;

            // How many findings on THIS item, for the header badge. A collapsed
            // list has to say which cards are worth opening, or collapsing them
            // has just hidden the findings the verdict promised.
            var mine = findings.filter(function (f) {
                return String(f.planItemId) === String(item.planItemId);
            });
            var anyBad = mine.some(function (f) { return f.level === 'bad'; });

            h += '<div class="item-card' + (open ? ' open' : '') +
                (mine.length ? (anyBad ? ' has-bad' : ' has-note') : '') +
                '" data-item="' + esc(item.planItemId) + '">' +
                '<div class="item-header" data-toggle="' + esc(item.planItemId) + '">' +
                '<div class="item-title-row"><span class="item-serial">' + (item.lineNo || idx + 1) + '</span>' +
                '<div class="item-header-info"><h2>' + esc(item.itemName) + '</h2>' +
                ((item.itemSku || item.itemSize || item.itemColor)
                    ? '<div class="item-sku-line">' +
                        [
                            item.itemSku ? esc(item.itemSku) : '',
                            item.itemSize ? 'size ' + esc(item.itemSize) : '',
                            item.itemColor ? esc(item.itemColor) : ''
                        ].filter(Boolean).join(' · ') +
                      '</div>'
                    : '') +
                '<div class="item-meta-line">' +
                '<span class="item-qty">Ordered ' + item.qtyOrdered + ' · produced ' + item.qtyProduced + '</span>' +
                (item.status ? '<span class="item-status-badge">' + esc(String(item.status).replace(/_/g, ' ')) + '</span>' : '') +
                (mine.length
                    ? '<span class="item-finding-badge ' + (anyBad ? 'is-bad' : 'is-note') + '">' +
                      (anyBad ? '&#9888; ' : '') + mine.length +
                      (anyBad ? ' finding' : ' note') + (mine.length === 1 ? '' : 's') + '</span>'
                    : '') +
                (item.hasBom ? '' : '<span class="no">no BOM</span>') + '</div></div></div>' +
                '<span class="chevron" aria-hidden="true">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>' +
                '</span></div>' +
                '<div class="item-body">';

            h += renderItemMaterials(item);

            h += '</div></div>';
        });

        h += '</section>';
    });

    content.innerHTML = h;
    wire();
}

// Re-rendering the whole screen on every keystroke would lose the caret, so the
// waste step is the only thing redrawn when a quantity changes.
function rerenderWaste(reqId) {
    var mat = null, item = null;
    (DATA.plans || []).forEach(function (p) {
        p.items.forEach(function (i) {
            i.materials.forEach(function (m) {
                if (String(m.reqId) === String(reqId)) { mat = m; item = i; }
            });
        });
    });
    if (!mat) return;

    var input = document.querySelector('[data-req="' + reqId + '"]');
    if (!input) return;
    var step = input.closest('.step-waste');
    if (!step) return;

    var wrap = document.createElement('div');
    wrap.innerHTML = renderWasteStep(mat, item, bucketFor(mat.bucketKey));
    step.replaceWith(wrap.firstChild);

    var fresh = document.querySelector('[data-req="' + reqId + '"]');
    if (fresh) {
        fresh.focus();
        var v = fresh.value;
        fresh.value = '';
        fresh.value = v;
    }
    wireWaste();
}

function wireWaste() {
    document.querySelectorAll('.qty-input').forEach(function (inp) {
        if (inp.dataset.wired) return;
        inp.dataset.wired = '1';
        inp.addEventListener('input', function () {
            var n = parseInt(inp.value, 10);
            if (isNaN(n) || n < 0) n = 0;
            CUT_QTY[inp.dataset.req] = n;
            rerenderWaste(inp.dataset.req);
        });
    });
    document.querySelectorAll('[data-assume]').forEach(function (cb) {
        if (cb.dataset.wired) return;
        cb.dataset.wired = '1';
        cb.addEventListener('change', function () {
            ASSUME_PICKS[cb.dataset.assume] = cb.checked;
            rerenderWaste(cb.dataset.assume);
        });
    });
}

function wire() {
    document.querySelectorAll('[data-toggle]').forEach(function (hd) {
        hd.addEventListener('click', function () {
            hd.parentNode.classList.toggle('open');
        });
    });

    // A FINDING JUMPS TO ITS OWN EVIDENCE. The verdict says "each one below opens
    // the working it came from", and this is what makes that true rather than a
    // claim — clicking a finding opens the item, opens the material's working
    // row, fetches the lazy expected-waste payload if that row needs it, and
    // scrolls it into view.
    //
    // Without it the verdict names a material on an item and leaves the admin to
    // find it by hand, which on a 110-item order is most of the work the banner
    // was supposed to remove.
    document.querySelectorAll('[data-goto]').forEach(function (li) {
        li.addEventListener('click', function () {
            var reqId = li.getAttribute('data-goto');
            var work = document.getElementById('work-' + reqId);
            if (!work) return;

            var card = work.closest('.item-card');
            if (card) card.classList.add('open');

            work.hidden = false;
            var btn = document.querySelector('[data-ans-toggle="' + reqId + '"]');
            if (btn) btn.classList.add('is-open');

            // Same lazy fetch the chevron does, for the same reason — step 3
            // checks the derivation against getExpectedWaste and that payload is
            // only fetched when a working is actually opened.
            var found = matItemByReqId(reqId);
            if (found && found.mat && found.mat.isFabric &&
                EXP_WASTE[String(found.item.planItemId)] === undefined) {
                ensureExpectedWaste(found.item, function () { redrawWorkRow(reqId); });
            }

            var row = document.querySelector('[data-ans="' + reqId + '"]');
            if (row && row.scrollIntoView) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    });

    // The working, one material at a time. Collapsed on arrival - this screen
    // is read to find out WHETHER a number is wrong, and only then why, so the
    // derivation is evidence rather than the page.
    document.querySelectorAll('[data-ans-toggle]').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var reqId = btn.getAttribute('data-ans-toggle');
            var row = document.getElementById('work-' + reqId);
            if (!row) return;
            row.hidden = !row.hidden;
            btn.classList.toggle('is-open', !row.hidden);

            // Step 3 of the working checks the JS mirror against getExpectedWaste,
            // the function that really runs. That payload is fetched lazily, the
            // first time a fabric line's working is opened - one call, for this
            // item alone. When it lands the work row is redrawn in place.
            if (!row.hidden) {
                var found = matItemByReqId(reqId);
                if (found && found.mat && found.mat.isFabric &&
                    EXP_WASTE[String(found.item.planItemId)] === undefined) {
                    ensureExpectedWaste(found.item, function () {
                        redrawWorkRow(reqId);
                    });
                }
            }
        });
    });

    wireWaste();
}

// Locate the { mat, item } pair for a requirement id across the loaded order.
function matItemByReqId(reqId) {
    var hit = null;
    (DATA && DATA.plans ? DATA.plans : []).forEach(function (p) {
        (p.items || []).forEach(function (i) {
            i.planId = p.planId; // same stamp render() applies
            (i.materials || []).forEach(function (m) {
                if (String(m.reqId) === String(reqId)) hit = { mat: m, item: i };
            });
        });
    });
    return hit;
}

// Redraw one requirement's working <tr> in place, keeping it open.
function redrawWorkRow(reqId) {
    var row = document.getElementById('work-' + reqId);
    if (!row) return;
    var found = matItemByReqId(reqId);
    if (!found) return;
    var cell = row.querySelector('td');
    if (!cell) return;
    cell.innerHTML = found.mat.isFabric
        ? renderFabricLine(found.mat, found.item)
        : renderNonFabric(found.mat, found.item);
    wireWaste();
}

// ---- order picker ----
//
// ALL_ORDERS is kept whole and the <select> is rebuilt from it, rather than
// options being hidden. A hidden <option> is still selectable by keyboard in
// some browsers, and a picker that can land on an entry it is not showing is
// worse than no filter at all.
var ALL_ORDERS = [];

function orderMatches(o, q) {
    if (!q) return true;
    return (String(o.name || '') + ' ' + String(o.source || '') + ' ' + String(o.status || ''))
        .toLowerCase().indexOf(q) !== -1;
}

function applyOrderFilter() {
    var sel = document.getElementById('so-select');
    var box = document.getElementById('so-filter');
    if (!sel) return;

    var q = box ? String(box.value || '').trim().toLowerCase() : '';
    var keep = sel.value;

    // An order with no plan is not part of this screen's world at all. Selecting
    // one could only ever produce "nothing has been planned against it", and the
    // question behind that - why was it not planned? - is answered by
    // createProductionPlans' run summary, not here. So they are filtered out
    // once, and nothing on the screen mentions them again: no toggle, no count,
    // no footnote. The picker simply lists what can be audited.
    var planned = ALL_ORDERS.filter(function (o) { return o.hasPlans !== false; });
    var list = planned.filter(function (o) { return orderMatches(o, q); });

    sel.innerHTML = '<option value="">Choose sales order…</option>' +
        list.map(function (o) {
            var bits = [];
            if (o.source) bits.push(o.source);
            if (o.status) bits.push(o.status);
            return '<option value="' + esc(o.id) + '">' + esc(o.name) +
                (bits.length ? ' — ' + esc(bits.join(' · ')) : '') + '</option>';
        }).join('');

    // The order being looked at must not vanish because of a keystroke. If the
    // filter excludes it, it is put back rather than the screen resetting.
    if (keep) {
        if (!list.some(function (o) { return String(o.id) === String(keep); })) {
            var cur = ALL_ORDERS.filter(function (o) { return String(o.id) === String(keep); })[0];
            if (cur) {
                sel.insertAdjacentHTML('beforeend',
                    '<option value="' + esc(cur.id) + '">' + esc(cur.name) + ' — (filtered out)</option>');
            }
        }
        sel.value = keep;
    }

    // Counted against the auditable orders, never against every order that
    // exists - the difference between the two is the thing this screen does not
    // talk about.
    var cnt = document.getElementById('so-count');
    if (cnt) {
        cnt.textContent = q
            ? list.length + ' of ' + planned.length
            : planned.length + (planned.length === 1 ? ' order' : ' orders');
    }
}


// =====================================================================
// TAB: MATERIAL USED
//
// What the order actually ate, against what it was planned to eat. Its own
// Custom API, fetched the first time the tab is opened - kept separate from
// getAdminCalculation because folding a second report into one script is how the
// statement limit gets hit. That limit is not catchable: it kills the script and
// the widget gets a bare 500 with no error card at all.
// =====================================================================

var USED = null;
var usedLoadedFor = '';
var usedOpen = {};

// The reason trail behind extra demand, from ConsumptionDetail (JS Data API).
// A pure read, fetched beside getOrderConsumption and rendered inside the
// expanded rows. Null until it lands or if it fails — every renderer that
// touches it degrades to "quantities only", because the quantities come from
// getOrderConsumption and do not depend on this at all.
var USED_DETAIL = null;

function usedFacts(m) {
    // Everything that did not earn a column, shown when a row is opened.
    var bits = [];
    if (Number(m.requiredPieces) > 0) {
        bits.push(m.requiredPieces + ' pieces required · ' +
            (Number(m.piecesFromRaw) || 0) + ' cut from fresh cloth · ' +
            (Number(m.piecesFromWaste) || 0) + ' from offcuts');
    }

    // RECEIPT, stated as a fact rather than left to be inferred from a column
    // that only appears when something is outstanding. `received` was returned
    // by getOrderConsumption from the start and rendered nowhere at all.
    var issued = parseFloat(m.issued) || 0;
    var received = parseFloat(m.received) || 0;
    if (issued > 0.005) {
        if (received + 0.005 >= issued) {
            bits.push('all ' + num(issued, 3) + ' ' + (m.unit || '') + ' issued was confirmed received');
        } else {
            bits.push(num(received, 3) + ' of ' + num(issued, 3) + ' ' + (m.unit || '') +
                ' confirmed received — ' + num(issued - received, 3) + ' still in transit');
        }
    }

    // THE CUTTING ALLOWANCE, which getOrderConsumption has always computed and
    // this screen threw away. It is the single most-questioned figure in the app
    // — the legend spent two sentences explaining the surplus it causes — and
    // the number itself only ever appeared inside the reasons list.
    if (Number(m.cuttingAllowance) > 0.005) {
        bits.push(num(m.cuttingAllowance, 3) + ' ' + (m.unit || '') +
            ' of the surplus is cutting allowance — whole marker rows paid for either way');
    }

    if (Number(m.wasteAreaM2) > 0) {
        bits.push(num(m.wasteAreaM2, 2) + ' m2 of remnant came off this order');
    }
    if (Number(m.lostPieces) > 0) {
        bits.push(m.lostPieces + ' offcut piece' + (Number(m.lostPieces) === 1 ? '' : 's') + ' written off');
    }
    return bits;
}

function pcs(n) { return Number(n) === 1 ? 'pc' : 'pcs'; }

// A dash, not a zero. Nothing damaged and nothing thrown off is the normal case,
// and a column of 0.000 down the right of the table reads as data when it is
// really absence.
function orDash(val, txt) {
    return Number(val) > 0 ? txt : '<span class="is-muted">—</span>';
}

// WHICH OPTIONAL COLUMNS ARE WORTH DRAWING for this set of materials.
//
// The table had eleven columns and on a healthy order SEVEN of them were dashes
// on every single row — Reissued, Lost, vs plan, Damaged, Waste back, Scrapped,
// and the in-transit gap that was not there at all. Half the table width spent
// saying "nothing happened", while the question the admin actually has (did
// anything go wrong?) needed all eleven read to answer.
//
// A column that is empty on every row is not information, it is furniture. Each
// one now appears only when at least one row has something to put in it, and the
// verdict above says what the absent ones would have said.
function usedColumns(mats) {
    var c = { reissued: false, transit: false, lost: false, variance: false,
              damaged: false, wasteKept: false, wasteScrap: false };
    (mats || []).forEach(function (m) {
        if ((parseFloat(m.reissued) || 0) > 0.005) c.reissued = true;
        if (((parseFloat(m.issued) || 0) - (parseFloat(m.received) || 0)) > 0.005) c.transit = true;
        if ((parseFloat(m.lost) || 0) > 0.005) c.lost = true;
        if (Math.abs(parseFloat(m.variance) || 0) > 0.005) c.variance = true;
        if ((parseFloat(m.damagedQty) || 0) > 0.005) c.damaged = true;
        if ((Number(m.wasteKeptPieces) || 0) > 0) c.wasteKept = true;
        if ((Number(m.wasteScrapPieces) || 0) > 0) c.wasteScrap = true;
    });
    return c;
}

function usedColCount(c) {
    // Material, Unit, Planned, Issued, Spent, chevron = 6 always-on.
    var n = 6;
    ['reissued', 'transit', 'lost', 'variance', 'damaged', 'wasteKept', 'wasteScrap']
        .forEach(function (k) { if (c[k]) n++; });
    return n;
}

// THE ACCOUNT, drawn as a ledger rather than a sentence. One row per movement,
// in the order the material meets them, so the arithmetic can be followed down
// the column instead of reconstructed from seven cells spread across a table.
function renderAccount(m) {
    var a = materialAccount(m);
    var u = esc(m.unit || '');

    function line(label, qty, cls, why) {
        return '<div class="acc-line' + (cls ? ' ' + cls : '') + '">' +
            '<span class="acc-label">' + esc(label) + '</span>' +
            '<span class="acc-qty">' + num(qty, 3) + ' ' + u + '</span>' +
            '<span class="acc-why">' + (why || '') + '</span></div>';
    }

    var h = '<div class="account"><h5 class="sub">The account for this material</h5>';

    h += line('Planned', a.planned, '', 'what the plan asked for');
    if (a.extra > 0.005) {
        h += line('Raised later', a.extra, 'acc-extra', 'demand added after the plan — see below for why');
        h += '<div class="acc-sub">' +
            '<span class="acc-label"><b>Total asked for</b></span>' +
            '<span class="acc-qty"><b>' + num(a.demand, 3) + ' ' + u + '</b></span>' +
            '<span class="acc-why"></span></div>';
    }

    h += line('Issued', a.issued, 'acc-key', 'crossed the store counter');

    // The cutting allowance sits here because this is where it arises: whole
    // marker rows are issued whether or not the last one is filled.
    if (a.overIssue > 0.005) {
        h += '<div class="acc-note">' + num(a.overIssue, 3) + ' ' + u +
            ' more issued than asked for' +
            (Number(m.cuttingAllowance) > 0.005
                ? ' — ' + num(m.cuttingAllowance, 3) + ' ' + u +
                  ' of it is cutting allowance, whole marker rows paid for either way'
                : (m.isFabric
                    ? ' — normally the cutting allowance, since cloth is issued in whole marker rows'
                    : '')) +
            '</div>';
    } else if (a.overIssue < -0.005) {
        h += '<div class="acc-note">' + num(Math.abs(a.overIssue), 3) + ' ' + u +
            ' less issued than asked for — either still being issued, or the order will run short.</div>';
    }

    h += line('Confirmed received', a.received, '', 'the supervisor has it');
    if (a.transit > 0.005) {
        h += line('Still in transit', a.transit, 'acc-bad',
            'left the store, nobody has confirmed holding it');
    }
    if (a.lost > 0.005) {
        h += line('Written off', a.lost, 'acc-bad', 'a dispute both sides denied');
    }

    h += '<div class="acc-total">' +
        '<span class="acc-label"><b>Spent</b></span>' +
        '<span class="acc-qty"><b>' + num(a.spent, 3) + ' ' + u + '</b></span>' +
        '<span class="acc-why">issued plus written off</span></div>';

    // THE BALANCE, stated rather than left to be worked out.
    if (!a.spentAgrees) {
        h += '<div class="acc-verdict is-bad">This does not add up: issued ' + num(a.issued, 3) +
            ' plus written off ' + num(a.lost, 3) + ' is ' + num(a.issued + a.lost, 3) +
            ', but Spent reads ' + num(a.spent, 3) + '.</div>';
    } else if (!a.balanced) {
        h += '<div class="acc-verdict is-warn">Accounted for, except <b>' + num(a.transit, 3) + ' ' + u +
            '</b> that has not been confirmed received. Until it is, this order is counted as ' +
            'having spent material nobody has said they hold.</div>';
    } else {
        h += '<div class="acc-verdict is-ok">Fully accounted for — everything issued was confirmed received.</div>';
    }

    h += '</div>';
    return h;
}

// WHY THERE WAS EXTRA DEMAND — the reason trail, from ConsumptionDetail.
//
// getOrderConsumption reports the QUANTITY of extra demand and collapses its
// four causes into one figure. This says which cause, and quotes the words the
// people involved actually typed: raiseReissueRequest's own one-line why, the
// item's Remake_Reason, and — the thing that was unreachable before — the
// checker's Rejection_Remarks and Alteration_Remarks off Item_Check.
function renderReasonTrail(m) {
    if (!USED_DETAIL || !USED_DETAIL.byMaterial) return '';
    var d = USED_DETAIL.byMaterial[String(m.materialId)];
    var dmg = USED_DETAIL.damage || [];
    if (!d && !dmg.length) return '';
    if (!d) return '';

    var h = '<div class="trail"><h5 class="sub">Why extra material was needed</h5>';

    // The causes, as a one-line summary before the incidents themselves.
    var causeKeys = Object.keys(d.causes || {});
    if (causeKeys.length) {
        h += '<div class="cause-chips">';
        causeKeys.forEach(function (k) {
            var c = ConsumptionDetail.CAUSE[k] || { label: k, hint: '' };
            h += '<span class="cause-chip cause-' + esc(k) + '" title="' + esc(c.hint) + '">' +
                esc(c.label) + ' <b>' + num(d.causes[k], 3) + ' ' + esc(d.unit || m.unit || '') + '</b></span>';
        });
        h += '</div>';
    }

    (d.events || []).forEach(function (ev) {
        h += '<div class="trail-event">' +
            '<div class="trail-head">' +
                '<span class="cause-chip cause-' + esc(ev.cause) + '">' + esc(ev.causeLabel) + '</span>' +
                '<b>' + num(ev.qty, 3) + ' ' + esc(ev.unit || '') + '</b>' +
                (ev.item ? '<span class="trail-item">' + esc(ev.item) + '</span>' : '') +
            '</div>';

        // The one-line why raiseReissueRequest wrote onto the row itself.
        if (ev.reason) {
            h += '<div class="trail-line"><span class="trail-tag">Raised as</span>' +
                esc(ev.reason) + '</div>';
        }

        // The checker's own words. THE POINT OF THIS WHOLE PANEL: these are
        // mandatory fields somebody filled in at the moment of rejection, and
        // no screen reporting material consumption could reach them.
        (ev.checks || []).forEach(function (c) {
            h += '<div class="trail-line"><span class="trail-tag is-check">Checker' +
                (c.round ? ', round ' + c.round : '') + '</span>' +
                esc(c.remarks) +
                '<span class="trail-figs">' +
                    (c.inspected ? 'inspected ' + c.inspected : '') +
                    (c.rejected ? ' · rejected ' + c.rejected : '') +
                    (c.alteration ? ' · alteration ' + c.alteration : '') +
                    (c.on ? ' · ' + esc(c.on) : '') +
                '</span></div>';
        });

        // The damage report behind this item, if there is one.
        dmg.filter(function (x) {
            return String(x.itemId) === String(ev.itemId);
        }).forEach(function (x) {
            h += '<div class="trail-line"><span class="trail-tag is-damage">Damage' +
                (x.stage ? ' at ' + esc(x.stage) : '') + '</span>' +
                esc(x.reason || 'no reason recorded') +
                (x.note ? ' — ' + esc(x.note) : '') +
                '<span class="trail-figs">' + esc(x.who || '') +
                (x.on ? ' · ' + esc(x.on) : '') + '</span></div>';
        });
    });

    h += '</div>';
    return h;
}

function renderUsedRow(m, cols) {
    var unit = esc(m.unit || '');
    var v = Number(m.variance) || 0;
    var vCls = v > 0.001 ? 'var-over' : (v < -0.001 ? 'var-under' : 'var-none');
    var vTxt = Math.abs(v) < 0.001 ? '—' : (v > 0 ? '+' : '−') + num(Math.abs(v), 3);

    var reasons = m.reasons || [];
    var facts = usedFacts(m);
    // EVERY ROW OPENS NOW. It used to open only when there were reasons or
    // facts to show, so a material that simply went out and came back had no
    // chevron at all — and that is exactly the row whose account an admin
    // checking the arithmetic wants to see. renderAccount answers for every
    // material, including the uneventful ones.
    var canOpen = true;
    var open = !!usedOpen[m.materialId];

    var dmg = num(m.damagedQty, 3) +
        (Number(m.damagedPieces) > 0
            ? ' <span class="muted">(' + m.damagedPieces + ' pc' + (Number(m.damagedPieces) === 1 ? '' : 's') + ')</span>'
            : '');

    // IN TRANSIT: issued, and not yet confirmed by the supervisor. The server has
    // always computed `received`; nothing rendered it and nothing compared it to
    // anything, so cloth on a trolley was reported by this screen as consumed.
    var transit = (parseFloat(m.issued) || 0) - (parseFloat(m.received) || 0);

    var row = '<tr class="used-row" data-used-row="' + esc(m.materialId) + '">' +
        '<td class="ans-mat">' +
            '<div class="ans-name">' + esc(m.material || '—') + '</div>' +
            '<div class="ans-sub">' + (m.isFabric ? 'fabric' : 'not fabric') + '</div></td>' +
        '<td class="r">' + unit + '</td>' +
        '<td class="r">' + num(m.planned, 3) + '</td>' +
        (cols.reissued ? '<td class="r">' + orDash(m.reissued, num(m.reissued, 3)) + '</td>' : '') +
        '<td class="r">' + num(m.issued, 3) + '</td>' +
        (cols.transit
            ? '<td class="r">' + (transit > 0.005
                ? '<b class="is-transit">' + num(transit, 3) + '</b>'
                : '<span class="is-muted">—</span>') + '</td>'
            : '') +
        (cols.lost ? '<td class="r">' + orDash(m.lost, '<b class="is-lost">' + num(m.lost, 3) + '</b>') + '</td>' : '') +
        '<td class="r strong">' + num(m.spent, 3) + '</td>' +
        (cols.variance ? '<td class="r ' + vCls + '">' + vTxt + '</td>' : '') +
        // Reported, never netted into the figures on their left - see the damage
        // and waste passes in getOrderConsumption for why.
        (cols.damaged ? '<td class="r used-sep">' + orDash(m.damagedQty, dmg) + '</td>' : '') +
        (cols.wasteKept ? '<td class="r">' + orDash(m.wasteKeptPieces,
            '<b class="is-reuse">' + m.wasteKeptPieces + '</b> ' + pcs(m.wasteKeptPieces)) + '</td>' : '') +
        (cols.wasteScrap ? '<td class="r">' + orDash(m.wasteScrapPieces,
            m.wasteScrapPieces + ' ' + pcs(m.wasteScrapPieces)) + '</td>' : '') +
        '<td class="r">' + (canOpen
            ? '<button type="button" class="ans-toggle' + (open ? ' is-open' : '') + '" title="Why" aria-label="Why" ' +
                  'data-used-toggle="' + esc(m.materialId) + '">' +
                  '<span class="chevron" aria-hidden="true">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
                  'stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
                  '</span></button>'
            : '') + '</td>' +
        '</tr>';

    if (!canOpen) return row;

    var detail = facts.map(function (f) {
        return '<div class="reason-line"><span class="reason-tag is-fact">Detail</span>' + esc(f) + '</div>';
    }).join('') + reasons.map(function (r) {
        // A damage entry carries the stage in its type — "Damaged at Cutting" —
        // because that is what differs between two incidents on the same
        // material, so it is matched on the prefix rather than the whole string.
        // Without this it fell through to the cutting-allowance amber, which
        // reads as routine and is the one thing damage is not.
        var isDamage = typeof r.type === 'string' && r.type.indexOf('Damaged') === 0;
        var tag = r.type === 'Lost' ? 'is-lost'
            : (r.type === 'Offcut reuse' ? 'is-reuse'
            : (isDamage ? 'is-damage' : 'is-cutting'));
        // The server still calls it "Offcut reuse". Relabelled here rather than
        // in Deluge so the wording can change without a function redeploy.
        var label = r.type === 'Offcut reuse' ? 'Offcuts reused' : r.type;
        return '<div class="reason-line">' +
            '<span class="reason-tag ' + tag + '">' + esc(label) + '</span>' +
            '<b>' + num(r.qty, 3) + ' ' + esc(r.isWaste ? 'pcs' : (m.unit || '')) + '</b>' +
            (r.plan ? '<span>' + esc(r.plan) + '</span>' : '') +
            (r.on ? '<span>' + esc(r.on) + '</span>' : '') +
            (r.looked ? '<span class="reason-looked">' + esc(r.looked) + '</span>' : '') +
            '</div>';
    }).join('');

    // THE ACCOUNT AND THE REASON TRAIL lead the detail; the facts and reason
    // lines that were already here follow as supporting evidence. Order matters:
    // "does this add up" and "why was more needed" are the two questions the
    // row is opened to answer, and they were the two it could not.
    detail = renderAccount(m) + renderReasonTrail(m) + detail;

    // colspan follows the columns actually drawn. It was hardcoded to 12, which
    // is now wrong on every order that does not light up every optional column.
    return row + '<tr class="work-row" id="used-' + esc(m.materialId) + '"' + (open ? '' : ' hidden') +
        '><td colspan="' + usedColCount(cols) + '">' + detail + '</td></tr>';
}

// THE VERDICT, for consumption. Same shape and same reasoning as the one on the
// Calculation check tab: the screen could already surface all of this and made
// the admin read eleven columns across six materials to conclude "nothing is
// wrong", which is the answer on almost every order.
//
// The findings here are about what the order ATE, not about whether a figure was
// derived correctly — a different question from the other tab, so a different
// collector rather than a shared one that would have to know which tab it was
// serving.
// IS THIS ORDER STILL EXPECTING MATERIAL? Read off the sales order's own
// status, which the picker already carries.
//
// Sales_Order.Order_Status runs Pending -> In Progress -> Production Complete ->
// Checking Passed -> Finishing Complete -> Packed -> Dispatched (CLAUDE.md). Up
// to and including In Progress, more cloth can still legitimately go out, so a
// line that is short of its plan is mid-flight, not under-served.
//
// UNKNOWN COUNTS AS OPEN. If the status cannot be read the shortfall rule stays
// quiet: a missed real shortfall is a gap, a false one on every unissued line is
// a screen nobody reads.
var CLOSED_STATUSES = ['Production Complete', 'Checking Passed',
                       'Finishing Complete', 'Packed', 'Dispatched'];

function currentOrder() {
    var sel = document.getElementById('so-select');
    var id = sel ? sel.value : '';
    if (!id) return null;
    var hit = null;
    (ALL_ORDERS || []).forEach(function (o) {
        if (String(o.id) === String(id)) hit = o;
    });
    return hit;
}

function orderIsClosed() {
    var o = currentOrder();
    if (!o || !o.status) return false;
    return CLOSED_STATUSES.indexOf(String(o.status).trim()) > -1;
}

// Nothing has crossed the counter on this order yet. Worth knowing as ONE fact
// about the order, which is what it is — not as a finding per material.
function nothingIssuedYet(mats) {
    if (!mats || !mats.length) return false;
    return mats.every(function (m) {
        return (parseFloat(m.issued) || 0) <= 0.005 &&
               (parseFloat(m.reissued) || 0) <= 0.005;
    });
}

function collectUsedFindings(mats) {
    var out = [];

    (mats || []).forEach(function (m) {
        var unit = m.unit || '';
        var where = {
            materialId: String(m.materialId),
            item: m.material || '',
            material: m.material || ''
        };

        // ---- 1. MATERIAL STILL IN TRANSIT ----
        //
        // The one this screen could not say at all. Stock in this app is consumed
        // at RECEIPT, not at issue (CLAUDE.md) — but `spent` is issued + lost, so
        // cloth that left the store and has NOT been confirmed by the supervisor
        // is already counted here as consumed. The server computes `received` and
        // shipped it; nothing rendered it, and nothing compared it to anything.
        //
        // A gap means metres on a trolley: not on the store's shelf, not
        // confirmed on the supervisor's, and counted by this report as eaten.
        var issued = parseFloat(m.issued) || 0;
        var received = parseFloat(m.received) || 0;
        var transit = issued - received;
        if (transit > 0.005) {
            out.push({
                materialId: where.materialId, material: where.material,
                level: 'bad', kind: 'transit',
                what: num(transit, 3) + ' ' + unit + ' issued but never confirmed',
                detail: 'issued ' + num(issued, 3) + ', received ' + num(received, 3) +
                    ' — stock is consumed at receipt, so this is counted as spent above ' +
                    'while nobody has confirmed holding it'
            });
        }

        // ---- 2. WRITTEN OFF ----
        var lost = parseFloat(m.lost) || 0;
        if (lost > 0.005) {
            out.push({
                materialId: where.materialId, material: where.material,
                level: 'bad', kind: 'lost',
                what: num(lost, 3) + ' ' + unit + ' written off',
                detail: 'a dispute both sides denied — it left the store and reached nobody'
            });
        }

        // ---- 3. DAMAGED AND REPLACED ----
        var dmg = parseFloat(m.damagedQty) || 0;
        if (dmg > 0.005) {
            out.push({
                materialId: where.materialId, material: where.material,
                level: 'note', kind: 'damaged',
                what: num(dmg, 3) + ' ' + unit + ' had to be replaced',
                detail: (Number(m.damagedPieces) > 0
                    ? Number(m.damagedPieces) + ' piece' + (Number(m.damagedPieces) === 1 ? '' : 's') + ' reported damaged — '
                    : '') + 'reported for reissue, and deliberately not netted off the figures on the left'
            });
        }

        // ---- 4. SPENT LESS THAN PLANNED, *ONLY ONCE THAT IS A FAULT* ----
        //
        // THIS RULE USED TO FIRE ON EVERY UNISSUED LINE, and it was worse than
        // useless. An order that had not started issuing reported EVERY material
        // as "less than planned" — fourteen findings on a fourteen-material
        // order, all saying the same thing, none of them wrong exactly, none of
        // them anything. Its own detail text gave the game away: "either the
        // order is not finished issuing, or it will run short" is a finding that
        // does not know whether it is one.
        //
        // A shortfall is only a fault once nothing more is coming. Three states
        // were being collapsed into one:
        //
        //   nothing issued          the order has not started      not a finding
        //   part issued, in flight  normal mid-order               not a finding
        //   short and finished      genuinely under-served         A FINDING
        //
        // `orderIsClosed` is the discriminator, off the sales order's own
        // status. Where the status is unknown the rule stays SILENT rather than
        // guessing — a false alarm here trains the admin to scroll past the
        // verdict, which costs more than the finding is worth.
        var variance = parseFloat(m.variance) || 0;
        var issuedAny = (parseFloat(m.issued) || 0) > 0.005;
        // Against DEMAND (plan + reissue), not the plan alone: a closed order
        // that raised replacement cloth for a rejected batch or an alteration
        // and never issued it IS short, and measuring against the plan alone
        // hid that behind the reissue's own Required_Qty.
        var demand = (parseFloat(m.demand) || (parseFloat(m.planned) || 0) + (parseFloat(m.reissued) || 0));
        if (variance < -0.005 && orderIsClosed() && issuedAny) {
            out.push({
                materialId: where.materialId, material: where.material,
                level: 'bad', kind: 'under',
                what: num(Math.abs(variance), 3) + ' ' + unit + ' short',
                detail: 'asked for ' + num(demand, 3) + ', spent ' + num(m.spent, 3) +
                    ' — production is finished, so this order was served short'
            });
        }
    });

    return out;
}

// THE ACCOUNT FOR ONE MATERIAL — every quantity in, every quantity out, and
// whether the two close.
//
// This is what "the accounting should be perfect for an order" means in
// arithmetic. The screen reported seven figures side by side and never once
// said whether they agreed with each other, so a gap between them was
// something the admin had to spot by subtracting columns by eye.
//
// Two identities, and they are separate on purpose:
//
//   DEMAND    planned + extra demand           should equal what was asked for
//   FLOW      issued = received + in transit   what left vs what arrived
//
// The flow one is the load-bearing test. Stock in this app is consumed at
// RECEIPT (CLAUDE.md), so anything issued and not confirmed is on a trolley —
// counted by `spent` as eaten while nobody has said they hold it.
//
// WHAT IS DELIBERATELY NOT SUMMED: damaged, waste back and scrapped. They are
// reported beside the flow and never netted into it, because a ruined panel is
// often part-salvaged into the waste box AND reported for reissue — both true,
// both already counted on the left, and netting them without knowing which
// remnant came from which incident drives the loss negative. That is a
// documented deliberate gap, not an omission to fix here.
function materialAccount(m) {
    var planned = parseFloat(m.planned) || 0;
    var extra = parseFloat(m.reissued) || 0;
    var issued = parseFloat(m.issued) || 0;
    var received = parseFloat(m.received) || 0;
    var lost = parseFloat(m.lost) || 0;
    var spent = parseFloat(m.spent) || 0;

    var demand = planned + extra;
    var transit = issued - received;
    if (transit < 0.005) transit = 0;

    // Issued against everything it was asked for. A surplus here is the cutting
    // allowance — whole marker rows are bought whether or not the last one is
    // filled — and is expected on fabric, not on a trim.
    var overIssue = issued - demand;

    return {
        planned: planned,
        extra: extra,
        demand: demand,
        issued: issued,
        received: received,
        transit: transit,
        lost: lost,
        spent: spent,
        overIssue: overIssue,
        // `spent` is issued + lost by the server's definition. Restating it here
        // is the check: if these ever diverge, one of the two is wrong.
        spentAgrees: Math.abs((issued + lost) - spent) < 0.005,
        balanced: transit < 0.005
    };
}

// ORDER-LEVEL TOTALS, split by kind. Fabric is metres and trims are cones and
// pieces, so one "total spent" figure across both would be meaningless — they
// are counted separately, and only where every row in the group shares a unit.
function usedTotals(mats) {
    var t = { fabricLines: 0, trimLines: 0, transit: 0, lost: 0, damaged: 0, reissued: 0,
              wasteKept: 0, wasteScrap: 0, wasteArea: 0 };
    (mats || []).forEach(function (m) {
        if (m.isFabric) { t.fabricLines++; } else { t.trimLines++; }
        var tr = (parseFloat(m.issued) || 0) - (parseFloat(m.received) || 0);
        if (tr > 0.005) t.transit += tr;
        t.lost += parseFloat(m.lost) || 0;
        t.damaged += parseFloat(m.damagedQty) || 0;
        t.reissued += parseFloat(m.reissued) || 0;
        t.wasteKept += Number(m.wasteKeptPieces) || 0;
        t.wasteScrap += Number(m.wasteScrapPieces) || 0;
        t.wasteArea += parseFloat(m.wasteAreaM2) || 0;
    });
    return t;
}

// "Extra material was needed" — named by cause where ConsumptionDetail has
// landed, neutral where it has not. Never guesses at a cause: saying "after
// damage" about a checker rejection is a claim about an incident that did not
// happen.
function causeSummary(total) {
    if (!USED_DETAIL || !USED_DETAIL.causeTotals) {
        return 'Extra material was raised after the plan. ';
    }
    var keys = Object.keys(USED_DETAIL.causeTotals).filter(function (k) {
        return USED_DETAIL.causeTotals[k] > 0.005;
    });
    if (!keys.length) return 'Extra material was raised after the plan. ';

    var bits = keys.map(function (k) {
        var c = ConsumptionDetail.CAUSE[k] || { label: k };
        return c.label.toLowerCase();
    });
    var joined = bits.length === 1 ? bits[0]
        : bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1];
    return 'Extra material was needed — ' + joined + '. ';
}

function renderUsedVerdict(mats, findings) {
    var t = usedTotals(mats);
    var bad = findings.filter(function (f) { return f.level === 'bad'; });
    var notes = findings.filter(function (f) { return f.level === 'note'; });
    var lines = (mats || []).length;

    // The one line that answers "what did this order eat", which the table of
    // eleven columns never actually stated.
    var shape = t.fabricLines + ' fabric line' + (t.fabricLines === 1 ? '' : 's') +
        ' and ' + t.trimLines + ' trim' + (t.trimLines === 1 ? '' : 's');

    var h, cls, mark, head;
    var notStarted = nothingIssuedYet(mats);

    if (notStarted) {
        // NOTHING HAS BEEN ISSUED. Stated as the one fact it is, rather than
        // "consumed as planned" — which would claim a consumption that has not
        // happened — and rather than one shortfall finding per material, which
        // is what this screen did before and what made it worth ignoring.
        cls = 'verdict-note'; mark = 'i';
        head = 'Nothing issued yet.';
    } else if (!findings.length) {
        cls = 'verdict-ok'; mark = '&#10003;';
        head = lines + ' material' + (lines === 1 ? '' : 's') + ' consumed as planned.';
    } else {
        cls = bad.length ? 'verdict-bad' : 'verdict-note';
        mark = bad.length ? '&#9888;' : 'i';
        if (bad.length && notes.length) {
            head = bad.length + ' finding' + (bad.length === 1 ? '' : 's') + ' and ' +
                notes.length + ' worth noting.';
        } else if (bad.length) {
            head = bad.length + ' finding' + (bad.length === 1 ? '' : 's') + ' on this order.';
        } else {
            head = notes.length + ' thing' + (notes.length === 1 ? '' : 's') +
                ' worth noting, nothing wrong.';
        }
    }

    h = '<div class="verdict ' + cls + '">' +
        '<span class="verdict-mark">' + mark + '</span>' +
        '<div><b>' + head + '</b>' +
        '<span>' +
        (notStarted
            ? 'This order is planned for ' + shape + ', and none of it has crossed the ' +
              'store counter. The table below is what it will need, not what it has used. '
            : shape + '. ') +
        (t.wasteKept > 0
            ? t.wasteKept + ' offcut piece' + (t.wasteKept === 1 ? '' : 's') + ' went back on the rack' +
              (t.wasteArea > 0 ? ' (' + num(t.wasteArea, 2) + ' m&sup2;)' : '') + '. '
            : '') +
        // NAMES THE CAUSES rather than guessing at one. This said "re-issued
        // after damage" for every kind of extra demand, including a checker
        // rejection and an alteration, which is a specific claim about an
        // incident that may not have happened. ConsumptionDetail knows which of
        // the four it really was; before it lands, the count says so neutrally.
        (t.reissued > 0 ? causeSummary(t.reissued) : '') +
        '</span>';

    if (findings.length) {
        h += '<ul class="verdict-list">';
        findings.slice().sort(function (a, b) {
            if (a.level !== b.level) return a.level === 'bad' ? -1 : 1;
            return 0;
        }).forEach(function (f) {
            h += '<li class="vf vf-' + f.level + '" data-used-goto="' + esc(f.materialId) + '">' +
                '<b>' + esc(f.what) + '</b>' +
                '<span class="vf-where">' + esc(f.material) + '</span>' +
                '<span class="vf-detail">' + esc(f.detail) + '</span>' +
                '</li>';
        });
        h += '</ul>';
    }

    h += '</div></div>';
    return h;
}

function renderUsed() {
    var panel = document.getElementById('panel-used');
    if (!panel) return;

    if (!USED) {
        panel.innerHTML = '<div class="empty-state"><div class="icon">📦</div>' +
            '<h2>Pick a sales order</h2>' +
            '<p>Every material it consumed, what it was planned to consume, and what happened to the difference.</p></div>';
        return;
    }

    var mats = USED.materials || [];
    if (!mats.length) {
        panel.innerHTML = '<div class="empty-state"><div class="icon">📦</div>' +
            '<h2>Nothing booked against this order yet</h2>' +
            '<p>Material appears here once it has been planned or issued.</p></div>';
        return;
    }

    var h = '';
    if (USED.errors && USED.errors.length) {
        h += '<div class="warn top">' + USED.errors.map(esc).join('<br>') + '</div>';
    }

    // A FORM WHOSE REPORT COULD NOT BE FOUND says so here, quietly, naming the
    // form and every report name that was tried. The quantities on this screen
    // come from getOrderConsumption and are unaffected — only the reason trail
    // is missing — so this is a note, not a warning.
    if (USED_DETAIL && USED_DETAIL.notes && USED_DETAIL.notes.length) {
        h += '<div class="aside detail-note"><b>The reason trail is incomplete.</b> ' +
            'Could not find a report for: ' + esc(USED_DETAIL.notes.join('; ')) +
            '. The quantities below are unaffected — they come from getOrderConsumption. ' +
            'Add the real report link name to <code>ConsumptionDetail.CANDIDATES</code>.</div>';
    }

    // The conclusion first, the table as its evidence — same order as the
    // Calculation check tab.
    var findings = collectUsedFindings(mats);
    h += renderUsedVerdict(mats, findings);

    var cols = usedColumns(mats);

    // FABRIC AND TRIMS ARE TWO DIFFERENT QUESTIONS IN ONE TABLE. Fabric is
    // metres against a marker; a trim is a count per garment. They were
    // interleaved in requirement order, so on the screenshot's order the two
    // linen lines sat at rows 1 and 5 with three cones between them, and the
    // eye had to re-establish which kind of thing each row was on every line.
    //
    // Grouped, not split into two tables: they share every column and the
    // totals below are read across both.
    var fabrics = mats.filter(function (m) { return m.isFabric; });
    var trims = mats.filter(function (m) { return !m.isFabric; });

    var head = '<thead><tr>' +
        '<th>Material</th><th class="r">Unit</th>' +
        '<th class="r" title="What the plan said this order would need.">Planned</th>' +
        (cols.reissued ? '<th class="r" title="Issued again to replace material damaged in production.">Reissued</th>' : '') +
        '<th class="r" title="What crossed the store counter.">Issued</th>' +
        (cols.transit ? '<th class="r" title="Issued but not yet confirmed received by the supervisor. Stock is consumed at receipt, so this is counted in Spent while nobody has confirmed holding it.">In transit</th>' : '') +
        (cols.lost ? '<th class="r" title="A dispute both sides denied — it left the store and reached nobody.">Lost</th>' : '') +
        '<th class="r" title="Issued plus written off — what actually left the building.">Spent</th>' +
        (cols.variance ? '<th class="r" title="Spent against everything this order was asked for — the plan PLUS any reissue for a rejected batch, an alteration or damage. A reissue is real cloth the order needs, so it does not count as an overspend here. A surplus that remains is usually the cutting allowance: cloth is issued in whole marker rows whether or not the last one is filled.">vs asked</th>' : '') +
        (cols.damaged ? '<th class="r used-sep" title="Material that had to be replaced. Reported here and deliberately NOT netted off the figures on the left.">Damaged</th>' : '') +
        (cols.wasteKept ? '<th class="r" title="Offcut pieces that went back on the rack and can be reused.">Waste back</th>' : '') +
        (cols.wasteScrap ? '<th class="r" title="Offcut pieces thrown away.">Scrapped</th>' : '') +
        '<th></th></tr></thead>';

    var span = usedColCount(cols);
    var body = '';
    if (fabrics.length && trims.length) {
        body += '<tr class="grp-row"><td colspan="' + span + '">Fabric</td></tr>' +
            fabrics.map(function (m) { return renderUsedRow(m, cols); }).join('') +
            '<tr class="grp-row"><td colspan="' + span + '">Trims and other materials</td></tr>' +
            trims.map(function (m) { return renderUsedRow(m, cols); }).join('');
    } else {
        body = mats.map(function (m) { return renderUsedRow(m, cols); }).join('');
    }

    h += '<div class="table-wrapper"><table class="ans-table used-table">' +
        head + '<tbody>' + body + '</tbody></table></div>';

    // THE TWO HALVES OF THIS TABLE DO NOT ADD UP, ON PURPOSE. Saying so on the
    // screen is cheaper than being asked, and it stops somebody "fixing" it.
    //
    // Trimmed to the columns actually on screen: the old paragraph explained
    // Damaged / Waste back / Scrapped on every order including the ones where
    // none of those columns existed, which is an explanation of something the
    // reader cannot see. The rest of the glossary moved onto the column titles.
    if (cols.damaged || cols.wasteKept || cols.wasteScrap) {
        h += '<div class="aside ans-legend">' +
            '<b>Damaged</b>, <b>Waste back</b> and <b>Scrapped</b> sit beside the figures on their left and are ' +
            'deliberately not added into them. At cutting a ruined panel is often part-salvaged into the waste box ' +
            '<em>and</em> reported for reissue — both are true, both are already counted on the left, and netting ' +
            'them without knowing which remnant came from which incident would drive the loss negative.' +
            '</div>';
    }

    panel.innerHTML = h;

    // A finding jumps to its row, same as the other tab.
    panel.querySelectorAll('[data-used-goto]').forEach(function (li) {
        li.addEventListener('click', function () {
            var id = li.getAttribute('data-used-goto');
            var row = panel.querySelector('[data-used-row="' + id + '"]');
            var detail = document.getElementById('used-' + id);
            if (detail) {
                detail.hidden = false;
                usedOpen[id] = true;
                var b = panel.querySelector('[data-used-toggle="' + id + '"]');
                if (b) b.classList.add('is-open');
            }
            if (row && row.scrollIntoView) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    });

    panel.querySelectorAll('[data-used-toggle]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-used-toggle');
            var row = document.getElementById('used-' + id);
            if (!row) return;
            row.hidden = !row.hidden;
            // Remembered across a re-render, so refreshing does not collapse
            // everything the admin had opened.
            usedOpen[id] = !row.hidden;
            btn.classList.toggle('is-open', !row.hidden);
        });
    });
}

// THE REASON TRAIL, fetched after the quantities and rendered into them.
//
// Needs the order's plan ids to bound every query. The Calculation check tab
// already has them in MY_PLAN_IDS, but this tab can be opened without that tab
// having loaded — so when they are missing it asks getAdminCalculation for the
// order, which returns the plans among much else. That is one extra call on a
// path the admin took deliberately, and Custom API calls from a widget are not
// metered (CLAUDE.md), so it costs nothing worth optimising.
function loadUsedDetail(soId) {
    if (typeof ConsumptionDetail === 'undefined') return;

    function go(planIds) {
        if (!planIds || !planIds.length) return;
        ConsumptionDetail.run(planIds).then(function (detail) {
            // The order may have been changed while this was in flight. Dropping
            // a late answer is right: rendering it would attach one order's
            // reasons to another order's quantities, which is the worst kind of
            // wrong because every figure on it is real, just about something else.
            if (usedLoadedFor !== String(soId)) return;
            USED_DETAIL = detail;
            renderUsed();
        }).catch(function (err) {
            console.error('ConsumptionDetail failed:', err);
        });
    }

    if (MY_PLAN_IDS && MY_PLAN_IDS.length && DATA && DATA.plans && DATA.plans.length) {
        go(MY_PLAN_IDS);
        return;
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getAdminCalculation',
        http_method: 'POST',
        payload: { salesOrderId: String(soId) }
    }).then(function (response) {
        var parsed;
        try { parsed = JSON.parse(response.result); } catch (e) { return; }
        go((parsed.plans || []).map(function (p) { return String(p.planId); }));
    }).catch(function (err) {
        console.error('could not resolve plans for the consumption detail:', err);
    });
}

function loadUsed() {
    var sel = document.getElementById('so-select');
    var soId = sel ? sel.value : '';
    if (!soId) { USED = null; USED_DETAIL = null; usedLoadedFor = ''; renderUsed(); return; }

    // usedLoadedFor is what makes the tab lazy: coming back to an order already
    // fetched redraws from memory instead of calling again.
    if (usedLoadedFor === soId) { renderUsed(); return; }

    var panel = document.getElementById('panel-used');
    panel.innerHTML = '<div class="empty-state"><h2>Loading…</h2></div>';

    USED_DETAIL = null;

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getOrderConsumption',
        http_method: 'POST',
        payload: { salesOrderId: String(soId) }
    }).then(function (response) {
        try {
            USED = JSON.parse(response.result);
        } catch (e) {
            console.error('getOrderConsumption parse failed:', e, response.result);
            USED = { errors: ['Could not read the response — see the browser console.'], materials: [] };
        }
        usedLoadedFor = soId;

        // Quantities first, reasons second. The table is drawn as soon as
        // getOrderConsumption lands and REDRAWN when the detail arrives — the
        // reason trail is worth waiting for but not worth waiting in front of a
        // blank screen for, and a failed detail fetch must leave a complete
        // quantity report rather than an error page.
        renderUsed();
        loadUsedDetail(soId);
    }).catch(function (err) {
        console.error('getOrderConsumption error:', err);
        USED = { errors: ['Could not load: ' + err], materials: [] };
        usedLoadedFor = '';
        renderUsed();
    });
}

// ---- tabs ----
//
// calc has no loader: it is drawn by the existing load()/render() pair when the
// order changes, and re-running it here would refetch the heavy call on every
// tab switch.
var TAB_LOADERS = { calc: function () {}, used: loadUsed };

function showTab(name) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.toggle('is-active', p.id === 'panel-' + name);
    });
    if (TAB_LOADERS[name]) TAB_LOADERS[name]();
}

function activeTab() {
    var b = document.querySelector('.tab-btn.is-active');
    return b ? b.getAttribute('data-tab') : 'calc';
}

// ---- load ----

function fillOrders(list) {
    var sel = document.getElementById('so-select');
    if (sel.dataset.filled === '1') return;
    ALL_ORDERS = (list || []).slice();
    applyOrderFilter();
    sel.dataset.filled = '1';

    var box = document.getElementById('so-filter');
    if (box) box.addEventListener('input', applyOrderFilter);
}

function load(soId) {
    var content = document.getElementById('content');
    var empty = document.getElementById('empty');
    var btn = document.getElementById('refresh-btn');

    btn.disabled = true;
    if (soId) {
        empty.classList.add('hidden');
        content.innerHTML =
            '<div class="skeleton-card"><div class="skeleton-line w-40"></div>' +
            '<div class="skeleton-line"></div><div class="skeleton-line"></div>' +
            '<div class="skeleton-line w-70"></div></div>';
    }

    ZOHO.CREATOR.DATA.invokeCustomApi({
        api_name: 'getAdminCalculation',
        http_method: 'POST',
        payload: { salesOrderId: soId || '' }
    }).then(function (response) {
        btn.disabled = false;
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            // The FAILURE is still logged with the raw text — that is the one
            // moment the payload is worth having, and a bad control character in
            // a free-text field is invisible without it. The two console.logs
            // that dumped every successful response are gone; no other widget
            // does that, and it buried the errors that matter.
            console.error('JSON.parse failed:', e, response.result);
            content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Could not read the response</h2><p>Check the browser console for details.</p></div>';
            return;
        }
        fillOrders(parsed.orders);
        if (!soId) {
            DATA = null;
            content.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        CUT_QTY = {};
        ASSUME_PICKS = {};
        DATA = parsed;
        // The audited order's own plan ids, for bucketFor's isThisOrder flag -
        // the Deluge used to stamp that server-side off the store function's
        // lines; now bucketFor synthesises the bucket and needs the same list.
        MY_PLAN_IDS = (parsed.plans || []).map(function (p) { return String(p.planId); });
        loadLive(render);
    }).catch(function (err) {
        console.error('invokeCustomApi error:', err);
        btn.disabled = false;
        content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Failed to load</h2><p>Check the browser console for details.</p></div>';
    });
}

// ---- The live allocation, run HERE by the store screen's own allocator ----
//
// THE SAME CODE, NOT A COPY. `../js/lot-allocator.js` is the file the store page
// loads, and this page runs it over the same payload — so what the audit shows is
// what the store person is being offered, by construction. A second
// implementation that agrees today disagrees the week after next, and the screen
// whose entire job is to be trusted is the worst place for that.
//
// It also repairs a real break. getAdminCalculation used to read
// `piecesCoveredByWaste`, `freshPieces`, `freshMeters` and `wastePicks` out of
// getStoreMaterialRequirements and present them as the allocation. They stopped
// being the allocation when lots arrived: the server no longer picks offcuts,
// because a remnant carries its lot's shade and picking remnants and picking the
// lot is one decision, which happens in the widget. So it was showing
// `wastePicks: []` and zero offcut credit under a card promising the opposite —
// column 2 read identical to the plan figure it exists to differ from.
//
// A widget's Custom API calls are not metered, so extra calls cost nothing.
var LIVE = null;

// The live requirements come from ApiExperiment.run() (../js/api-experiment.js) -
// the SAME JS-Data-API port the store screen runs on. It returns the FULL
// unpaged {plans:[...]} in one call, every supervisor, in the exact shape the
// old getStoreMaterialRequirements custom function returned - so applyLotAllocation
// and everything reading LIVE below are unchanged. The audit needs the whole
// picture (it exists to catch discrepancies), which run() gives directly; the
// old row-budget paging walk is gone with the Deluge function.
function loadLive(done) {
    LIVE = [];

    ApiExperiment.run().then(function (out) {
        LIVE = (out && out.plans) || [];
        try {
            // The store screen's own pass, unchanged. Everything the audit
            // reads below is what it writes onto the material entries.
            applyLotAllocation(LIVE);
        } catch (e) {
            console.error('live allocation pass failed:', e);
            LIVE = null;
        }
        done();
    }).catch(function (err) {
        // The plan-time half of this screen is still worth showing, so a failure
        // here is reported in the step rather than replacing the page.
        console.error('ApiExperiment.run error:', err);
        LIVE = null;
        done();
    });
}

// This order's slice of the live allocation: the material entry it sits on, and
// the decision made for THIS plan.
//
// Matched on supervisor + material, then on plan. A row carries every order of
// that supervisor for that fabric, so without the plan filter the audit would
// show another order's shade next to this one's numbers.
function liveFor(bucket, planId) {
    if (!LIVE || !bucket) return null;
    var out = null;
    (LIVE || []).forEach(function (sup) {
        if (String(sup.supervisorId) !== String(bucket.supervisorId)) return;
        (sup.materials || []).forEach(function (m) {
            if (!m.isFabric || String(m.materialId) !== String(bucket.materialId)) return;
            (m.orderOutcomes || []).forEach(function (o) {
                if (String(o.planId) !== String(planId)) return;
                // Several rows of one material carry the same outcome list, so the
                // first match is the answer and later ones are the same answer.
                if (!out) out = { m: m, o: o };
            });
        });
    });
    return out;
}

function setTodayLabel() {
    var el = document.getElementById('app-date');
    if (!el) return;
    var d = new Date();
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    el.textContent = days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
        showTab(btn.getAttribute('data-tab'));
    });
});

// CHANGING THE ORDER INVALIDATES BOTH TABS, not just the visible one.
//
// usedLoadedFor is cleared rather than the data refetched: the calculation call
// is the heavy one and always runs, while Material used is only fetched if that
// tab is the one being looked at. Leaving the flag set would show the PREVIOUS
// order's consumption under the new order's name - the worst kind of wrong,
// because every number on it is real, just about something else.
document.getElementById('so-select').addEventListener('change', function () {
    usedLoadedFor = '';
    USED = null;
    load(this.value);
    if (activeTab() === 'used') loadUsed();
});
document.getElementById('refresh-btn').addEventListener('click', function () {
    // Same rule as the other two widgets: refresh re-reads what is open, and
    // leaves the tab that has not been looked at to fetch when it is.
    usedLoadedFor = '';
    load(document.getElementById('so-select').value);
    if (activeTab() === 'used') loadUsed();
});

setTodayLabel();
load('');
