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
// keystroke would make the screen unusable. It mirrors getExpectedWaste step for
// step; if that function changes, this has to change with it.

var DATA = null;

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
    if (remain > 0) {
        var perRowR = Math.floor(fw / cutW);
        if (perRowR > 0) {
            var sideWR = fw - (perRowR * cutW);
            var fullRowsR = Math.floor(remain / perRowR);
            var lastRowR = remain - (fullRowsR * perRowR);
            var rawRows = fullRowsR + (lastRowR > 0 ? 1 : 0);
            var lbl = 'fresh cloth';

            if (fullRowsR > 0) remnant(res.rows, sideWR, fullRowsR * cutL, 1, 'side', lbl);
            if (lastRowR > 0) remnant(res.rows, fw - (lastRowR * cutW), cutL, 1, 'partial_row', lbl);

            res.fresh = {
                perRow: perRowR, sideW: sideWR, fullRows: fullRowsR,
                lastRow: lastRowR, rows: rawRows,
                cm: rawRows * cutL, metres: (rawRows * cutL) / 100,
                pieces: remain
            };
            remain = 0;
        } else {
            res.uncut = remain;
        }
    }

    return res;
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

function renderPlanStep(mat, item) {
    var d = derivePlan(mat, item.qtyOrdered);
    var h = '<div class="step step-plan"><div class="step-head"><span class="step-tag tag-plan">1</span>' +
        '<h4>Planned requirement</h4>' +
        '<span class="step-note">Settled when the plan was made and never recomputed — assumes no offcuts exist</span></div>';

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
        h += '<div class="check ok">Stored on the requirement: <b>' + num(mat.storedRequiredQty, 3) + ' m</b> — matches.</div>';
    } else {
        h += '<div class="check bad">Stored on the requirement: <b>' + num(mat.storedRequiredQty, 3) + ' m</b>, but the inputs above give <b>' +
            num(d.metres, 3) + ' m</b>. The requirement was written at plan time and is never recomputed, so a cut size or fabric width changed after this plan was created.</div>';
    }

    h += '</div>';
    return h;
}

function renderAllocStep(mat, bucket) {
    var h = '<div class="step step-issue"><div class="step-head"><span class="step-tag tag-issue">2</span>' +
        '<h4>Allocated right now</h4>' +
        '<span class="step-note">Re-decided on every load, before anything is issued — offcuts first, fresh cloth for the rest</span></div>';

    if (!bucket) {
        h += '<div class="aside">This line is not in the live allocation. Either its plan is closed, or every piece on it has already been issued — there is nothing left to allocate.</div></div>';
        return h;
    }

    // The allocation runs per supervisor + material + cut size across EVERY open
    // plan, so this line's fresh metres are not its own. Saying whose demand is
    // in the pot is what stops the fresh figure looking arbitrary.
    var others = (bucket.lines || []).filter(function (l) { return !l.isThisOrder; });
    h += '<div class="inputs">' +
        '<div class="input-chip"><span>Supervisor</span><b>' + esc(bucket.supervisor) + '</b></div>' +
        '<div class="input-chip"><span>Demand in this bucket</span><b>' + bucket.requiredPieces + ' pcs</b></div>' +
        '<div class="input-chip"><span>Already issued</span><b>' + bucket.issuedPieces + ' pcs</b></div>' +
        '<div class="input-chip strong"><span>Still to allocate</span><b>' + bucket.outstandingPieces + ' pcs</b></div>' +
        '</div>';

    if (others.length) {
        h += '<div class="aside">Leftover pieces are allocated per supervisor + material + cut size across <b>every open plan</b>, oldest first — not per order. ' +
            'This bucket also carries ' + others.length + ' line' + (others.length === 1 ? '' : 's') + ' from other orders (' +
            esc(others.map(function (l) { return l.salesOrder + ' / ' + l.planNo; }).join(', ')) +
            '), so what this order is offered depends on them.</div>';
        h += '<div class="table-wrapper"><table><thead><tr><th>Plan</th><th>Sales order</th><th class="r">Pieces</th><th class="r">Issued</th></tr></thead><tbody>';
        (bucket.lines || []).forEach(function (l) {
            h += '<tr class="' + (l.isThisOrder ? 'mine' : '') + '"><td>' + esc(l.planNo) + '</td><td>' + esc(l.salesOrder) +
                (l.isThisOrder ? ' <span class="pill pill-mine">this order</span>' : '') +
                '</td><td class="r">' + l.reqPieces + '</td><td class="r">' + l.issuedPieces + '</td></tr>';
        });
        h += '</tbody></table></div>';
    }

    // The pool, including the pieces that did NOT qualify. A leftover piece sitting in
    // the store that was never offered is the thing an admin comes here to
    // explain, and it can only be explained by showing it and why.
    var pool = bucket.pool || [];
    h += '<h5 class="sub">Leftover pieces on hand for this fabric</h5>';
    if (!pool.length) {
        h += '<div class="aside">No leftover pieces of this fabric in stock, so the whole requirement comes off fresh cloth.</div>';
    } else {
        h += '<div class="table-wrapper"><table><thead><tr><th>Piece</th><th class="r">In stock</th><th class="r">Unclaimed</th>' +
            '<th class="r">Per row</th><th class="r">Rows</th><th class="r">Cuts each</th><th>Usable here</th></tr></thead><tbody>';
        pool.forEach(function (p) {
            var why = '<span class="yes">yes</span>';
            if (!p.fits) {
                why = '<span class="no">too small</span> <span class="muted">— needs ' + num(bucket.cutLength) + '×' + num(bucket.cutWidth) + 'cm, grain never rotated</span>';
            } else if (p.left <= 0) {
                why = '<span class="no">claimed</span> <span class="muted">— taken by an earlier plan in this same run</span>';
            }
            h += '<tr class="' + (p.fits && p.left > 0 ? '' : 'dim') + '">' +
                '<td>' + num(p.length) + ' × ' + num(p.width) + ' cm</td>' +
                '<td class="r">' + p.opening + '</td><td class="r">' + p.left + '</td>' +
                '<td class="r">' + (p.fits ? p.perRow : '—') + '</td>' +
                '<td class="r">' + (p.fits ? p.maxRows : '—') + '</td>' +
                '<td class="r">' + (p.fits ? p.capacity : '—') + '</td>' +
                '<td>' + why + '</td></tr>';
        });
        h += '</tbody></table></div>';
    }

    var passes = bucket.passes || [];
    if (passes.length) {
        h += '<h5 class="sub">Which leftover pieces were picked, and why</h5>' +
            '<div class="aside">These are the picks the store screen actually made — read back from ' +
            '<code>getStoreMaterialRequirements</code>, not recalculated here. The scoring beside each one is ' +
            'derived from the piece size and the cut size so the choice can be checked: each pass scores every ' +
            'usable leftover piece by <b>area thrown away per cut obtained</b> and takes from the lowest. ' +
            'That prefers a snug remnant over a large one, so big stock is protected. Equal scores keep the oldest piece.</div>';
        h += '<div class="table-wrapper"><table><thead><tr><th>Pass</th><th>Piece chosen</th><th>Score — waste area per cut</th>' +
            '<th class="r">Take</th><th class="r">Covers</th><th class="r">Left to cover</th></tr></thead><tbody>';
        passes.forEach(function (p) {
            var area = p.width * p.length;
            var used = p.cutsScored * bucket.cutWidth * bucket.cutLength;
            h += '<tr><td>' + p.pass + '</td>' +
                '<td>' + num(p.length) + ' × ' + num(p.width) + ' cm <span class="muted">(' + p.perRow + ' per row × ' + p.maxRows + ' rows = ' + p.capacity + ' cuts)</span></td>' +
                '<td class="expr"><b>' + num(p.score, 0) + '</b> cm&sup2; <span class="muted">per cut &mdash; ' +
                    num(area, 0) + ' cm&sup2; piece, ' + num(used, 0) + ' cm&sup2; used by ' + p.cutsScored + ' cut' + (p.cutsScored === 1 ? '' : 's') + '</span></td>' +
                '<td class="r">' + p.take + ' pc' + (p.take === 1 ? '' : 's') + '</td>' +
                '<td class="r">' + p.covered + '</td>' +
                '<td class="r">' + p.remainAfter + '</td></tr>';
        });
        h += '</tbody></table></div>';
    } else if (bucket.outstandingPieces > 0) {
        h += '<div class="aside">No leftover piece was picked — nothing in stock was both big enough and unclaimed.</div>';
    }

    h += '<h5 class="sub">Fresh cloth still required</h5>';
    if (bucket.freshPieces > 0 && bucket.freshPerRow > 0) {
        h += '<div class="calc">' +
            factRow('Still to cut from fresh cloth',
                bucket.outstandingPieces + ' outstanding, ' + bucket.coveredByWaste + ' of them covered by offcuts',
                '<b>' + bucket.freshPieces + '</b> pieces') +
            factRow('Pieces per row',
                num(bucket.fabricWidthCm) + ' cm of fabric width across a ' + num(bucket.cutWidth) + ' cm cut',
                '<b>' + bucket.freshPerRow + '</b> per row') +
            factRow('Rows needed',
                bucket.freshPieces + ' pieces at ' + bucket.freshPerRow + ' per row, rounded up',
                '<b>' + bucket.freshRows + '</b> rows') +
            factRow('Fresh cloth to issue',
                bucket.freshRows + ' rows of ' + num(bucket.cutLength) + ' cm',
                '<b>' + num(bucket.freshMetres, 3) + ' m</b> <span class="muted">(' + num(bucket.freshRows * bucket.cutLength) + ' cm)</span>') +
            '</div>';

        // The derivation above is worked here; freshMetres came back from the
        // live function. Agreement is the assurance this screen exists to give,
        // so it is stated rather than left to be inferred from two numbers
        // happening to look alike.
        if (bucket.freshMetresCheck !== undefined) {
            var drift = Math.abs((bucket.freshMetresCheck || 0) - (bucket.freshMetres || 0));
            h += drift < 0.005
                ? '<div class="check ok">Matches the live store figure of <b>' +
                      num(bucket.freshMetres, 3) + ' m</b>.</div>'
                : '<div class="check bad">Does not match. This screen derives <b>' +
                      num(bucket.freshMetresCheck, 3) + ' m</b>, the store is issuing <b>' +
                      num(bucket.freshMetres, 3) + ' m</b> — a difference of ' +
                      num(drift, 3) + ' m. The store figure is the one being acted on.</div>';
        }
    } else if (bucket.outstandingPieces > 0 && bucket.freshPieces <= 0) {
        h += '<div class="check ok">Leftover pieces cover all ' + bucket.outstandingPieces + ' outstanding pieces. <b>No fresh cloth is needed.</b></div>';
    } else {
        h += '<div class="aside">Nothing outstanding, so no fresh cloth is asked for.</div>';
    }

    h += '<div class="stock-line">Stock of this fabric: <b>' + num(bucket.washStock, 3) + ' m</b> washed' +
        (bucket.unwashStock > 0 ? ', <b>' + num(bucket.unwashStock, 3) + ' m</b> unwashed' : '') +
        '. ' + (bucket.freshMetres > bucket.washStock
            ? '<span class="no">Short by ' + num(bucket.freshMetres - bucket.washStock, 3) + ' m</span> — only washed fabric can be issued.'
            : '<span class="yes">Enough on hand.</span>') + '</div>';

    h += '</div>';
    return h;
}

function renderWasteStep(mat, item, bucket) {
    var key = mat.reqId;
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
    if (!issued.length && assume && bucket && (bucket.passes || []).length) {
        sources = bucket.passes.map(function (p) {
            return { width: p.width, length: p.length, count: p.take };
        });
        hypothetical = true;
    }

    var w = deriveWaste(mat, pieces, sources);

    var h = '<div class="step step-waste"><div class="step-head"><span class="step-tag tag-waste">3</span>' +
        '<h4>Waste this will throw off</h4>' +
        '<span class="step-note">Predicted from the pieces cut, not recorded — nothing here has happened yet</span></div>';

    h += '<div class="qty-box">' +
        '<label for="q-' + esc(key) + '">Pieces cut</label>' +
        '<input type="number" min="0" id="q-' + esc(key) + '" data-req="' + esc(key) + '" class="qty-input" value="' + pieces + '">' +
        '<span class="muted">defaults to ' + (item.qtyProduced > 0 ? 'the quantity produced' : 'the quantity ordered') + ' (' + dflt + '). Change it to test the maths.</span>' +
        '</div>';

    if (!issued.length) {
        if (bucket && (bucket.passes || []).length) {
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
                '<b>' + w.fresh.perRow + '</b> per row') +
            factRow('Rows',
                w.fresh.fullRows + ' full' + (w.fresh.lastRow > 0 ? ' + 1 part row (' + w.fresh.lastRow + ' of ' + w.fresh.perRow + ')' : ''),
                '<b>' + w.fresh.rows + '</b> rows') +
            factRow('Fresh cloth consumed',
                w.fresh.rows + ' rows of ' + num(mat.cutLength) + ' cm',
                '<b>' + num(w.fresh.metres, 3) + ' m</b> <span class="muted">(' + num(w.fresh.cm) + ' cm)</span>') +
            factRow('Side strip left beside the cuts',
                w.fresh.perRow + ' cuts of ' + num(mat.cutWidth) + ' cm leave the rest of the ' + num(mat.fabricWidthCm) + ' cm width',
                '<b>' + num(w.fresh.sideW) + ' cm</b> wide') +
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

    h += '</div>';
    return h;
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

function bucketFor(key) {
    if (!key || !DATA) return null;
    var found = null;
    (DATA.buckets || []).forEach(function (b) { if (b.key === key) found = b; });
    return found;
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
// NOW NEEDED is deliberately not compared to either. It is the live allocation,
// a different calculation that re-decides how much offcuts cover and is SUPPOSED
// to differ. Putting it in a column next to STORED under a shared tick would
// invite exactly the subtraction CLAUDE.md calls the most common way to
// conclude the maths is broken when it is not.
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
    // This is not a forecast this screen invents. getAdminCalculation calls
    // getStoreMaterialRequirements through thisapp and reads its output, so
    // these are the very picks the store person is about to be offered — the
    // admin can see which remnants a sales order is going to consume while the
    // cloth is still on the rack.
    //
    // Pulled up into the answer table rather than left in the working, because
    // "what are we reusing" is a question asked of the whole order at once, and
    // a chevron per material is the wrong shape for it.
    //
    // ADVISORY, and it moves. The allocation re-runs on every load and claims
    // pieces in priority order, so another supervisor's card taking the same
    // remnant first will change it. That is why the cell is muted rather than
    // presented as a commitment.
    var offcuts = '—';
    if (mat.isFabric && bucket) {
        var cov = parseInt(bucket.coveredByWaste, 10) || 0;
        var picks = (bucket.passes || []).length;
        offcuts = cov > 0
            ? '<b>' + cov + '</b> pcs <span class="muted">from ' + picks + ' offcut' + (picks === 1 ? '' : 's') + '</span>'
            : '<span class="muted">none</span>';
    }

    var nowNeeded = '—';
    if (mat.isFabric) {
        if (bucket) { nowNeeded = num(bucket.freshMetres, 3); }
    } else {
        var rem = (parseFloat(mat.storedRequiredQty) || 0) - (parseFloat(mat.issuedQty) || 0);
        nowNeeded = num(rem > 0 ? rem : 0, 3);
    }

    return '<tr class="ans-row" data-ans="' + esc(mat.reqId) + '">' +
        '<td class="ans-mat">' +
            '<div class="ans-name">' + esc(mat.material) + '</div>' +
            '<div class="ans-sub">' + (mat.sku ? esc(mat.sku) : '') +
                (mat.isFabric
                    ? (mat.sku ? ' · ' : '') + num(mat.cutLength) + ' × ' + num(mat.cutWidth) + ' cm cut'
                    : (mat.sku ? ' · ' : '') + 'not fabric') +
            '</div></td>' +
        '<td class="r">' + esc(unit) + '</td>' +
        '<td class="r">' + planned + '</td>' +
        '<td class="r">' + num(mat.storedRequiredQty, 3) + '</td>' +
        '<td class="r ' + cls + '" title="' + esc(note) + '">' + mark + '</td>' +
        '<td class="r offcut-cell">' + offcuts + '</td>' +
        '<td class="r strong">' + nowNeeded + '</td>' +
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
    var h = '<div class="table-wrapper"><table class="ans-table"><thead><tr>' +
        '<th>Material</th><th class="r">Unit</th>' +
        '<th class="r">Planned</th><th class="r">Stored</th><th class="r">Check</th>' +
        '<th class="r">From offcuts</th>' +
        '<th class="r">Now needed</th><th class="r">Issued</th><th class="r">Received</th><th></th>' +
        '</tr></thead><tbody>';
    item.materials.forEach(function (mat, i) { h += matAnswerRow(mat, item, i); });
    h += '</tbody></table></div>' +
        '<div class="aside ans-legend"><b>Planned</b> and <b>Stored</b> are the same calculation — the requirement fixed ' +
        'when the plan was made — so they are the pair that must agree. <b>Now needed</b> is the live allocation, ' +
        'recalculated whenever offcut stock moves; it is meant to be lower and is not a discrepancy. ' +
        '<b>From offcuts</b> is what the store is about to be offered from the waste rack — read live from the ' +
        'store screen itself, so it is visible before anything is issued. It is advisory: the same remnant can ' +
        'be claimed by a higher-priority supervisor first. Open a row for the working behind any of it.</div>';
    return h;
}

function renderFabricLine(mat, item) {
    var bucket = bucketFor(mat.bucketKey);
    var h = '<div class="line">';

    h += renderPlanStep(mat, item);
    h += renderAllocStep(mat, bucket);
    h += renderWasteStep(mat, item, bucket);
    h += '</div>';
    return h;
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

    DATA.plans.forEach(function (plan) {
        h += '<section class="plan-card"><div class="plan-head">' +
            '<h2>' + esc(plan.planNo) + '</h2>' +
            '<span class="pill pill-status">' + esc(plan.status) + '</span>' +
            '<span class="muted">' + esc(plan.supervisor) + '</span></div>';

        if (!plan.items.length) {
            h += '<div class="aside">This plan has no items.</div>';
        }

        plan.items.forEach(function (item, idx) {
            var open = idx === 0;
            h += '<div class="item-card' + (open ? ' open' : '') + '" data-item="' + esc(item.planItemId) + '">' +
                '<div class="item-header" data-toggle="' + esc(item.planItemId) + '">' +
                '<div class="item-title-row"><span class="item-serial">' + (item.lineNo || idx + 1) + '</span>' +
                '<div class="item-header-info"><h2>' + esc(item.itemName) + '</h2>' +
                '<div class="item-meta-line">Ordered ' + item.qtyOrdered + ' · produced ' + item.qtyProduced +
                ' · ' + esc(String(item.status).replace(/_/g, ' ')) +
                (item.hasBom ? '' : ' · <span class="no">no BOM</span>') + '</div></div></div>' +
                '<span class="chevron" aria-hidden="true">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
                'stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
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

    // The working, one material at a time. Collapsed on arrival - this screen
    // is read to find out WHETHER a number is wrong, and only then why, so the
    // derivation is evidence rather than the page.
    document.querySelectorAll('[data-ans-toggle]').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var row = document.getElementById('work-' + btn.getAttribute('data-ans-toggle'));
            if (!row) return;
            row.hidden = !row.hidden;
            btn.classList.toggle('is-open', !row.hidden);
        });
    });

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
// Custom API, fetched the first time the tab is opened - getAdminCalculation
// already calls getStoreMaterialRequirements once and getExpectedWaste per item
// through thisapp, and folding a second report into it is how the statement
// limit gets hit. That limit is not catchable: it kills the script and the
// widget gets a bare 500 with no error card at all.
// =====================================================================

var USED = null;
var usedLoadedFor = '';
var usedOpen = {};

function usedFacts(m) {
    // Everything that did not earn a column, shown when a row is opened.
    var bits = [];
    if (Number(m.requiredPieces) > 0) {
        bits.push(m.requiredPieces + ' pieces required · ' +
            (Number(m.piecesFromRaw) || 0) + ' cut from fresh cloth · ' +
            (Number(m.piecesFromWaste) || 0) + ' from offcuts');
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

function renderUsedRow(m) {
    var unit = esc(m.unit || '');
    var v = Number(m.variance) || 0;
    var vCls = v > 0.001 ? 'var-over' : (v < -0.001 ? 'var-under' : 'var-none');
    var vTxt = Math.abs(v) < 0.001 ? '—' : (v > 0 ? '+' : '−') + num(Math.abs(v), 3);

    var reasons = m.reasons || [];
    var facts = usedFacts(m);
    var canOpen = reasons.length > 0 || facts.length > 0;
    var open = !!usedOpen[m.materialId];

    var dmg = num(m.damagedQty, 3) +
        (Number(m.damagedPieces) > 0
            ? ' <span class="muted">(' + m.damagedPieces + ' pc' + (Number(m.damagedPieces) === 1 ? '' : 's') + ')</span>'
            : '');

    var row = '<tr class="used-row">' +
        '<td class="ans-mat">' +
            '<div class="ans-name">' + esc(m.material || '—') + '</div>' +
            '<div class="ans-sub">' + (m.isFabric ? 'fabric' : 'not fabric') + '</div></td>' +
        '<td class="r">' + unit + '</td>' +
        '<td class="r">' + num(m.planned, 3) + '</td>' +
        '<td class="r">' + orDash(m.reissued, num(m.reissued, 3)) + '</td>' +
        '<td class="r">' + num(m.issued, 3) + '</td>' +
        '<td class="r">' + orDash(m.lost, '<b class="is-lost">' + num(m.lost, 3) + '</b>') + '</td>' +
        '<td class="r strong">' + num(m.spent, 3) + '</td>' +
        '<td class="r ' + vCls + '">' + vTxt + '</td>' +
        // Reported, never netted into the figures on their left - see the damage
        // and waste passes in getOrderConsumption for why.
        '<td class="r used-sep">' + orDash(m.damagedQty, dmg) + '</td>' +
        '<td class="r">' + orDash(m.wasteKeptPieces,
            '<b class="is-reuse">' + m.wasteKeptPieces + '</b> ' + pcs(m.wasteKeptPieces)) + '</td>' +
        '<td class="r">' + orDash(m.wasteScrapPieces, m.wasteScrapPieces + ' ' + pcs(m.wasteScrapPieces)) + '</td>' +
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
        var tag = r.type === 'Lost' ? 'is-lost' : (r.type === 'Offcut reuse' ? 'is-reuse' : 'is-cutting');
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

    return row + '<tr class="work-row" id="used-' + esc(m.materialId) + '"' + (open ? '' : ' hidden') +
        '><td colspan="12">' + detail + '</td></tr>';
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

    h += '<div class="table-wrapper"><table class="ans-table used-table"><thead><tr>' +
        '<th>Material</th><th class="r">Unit</th>' +
        '<th class="r">Planned</th><th class="r">Reissued</th><th class="r">Issued</th>' +
        '<th class="r">Lost</th><th class="r">Spent</th><th class="r">vs plan</th>' +
        '<th class="r used-sep">Damaged</th><th class="r">Waste back</th><th class="r">Scrapped</th><th></th>' +
        '</tr></thead><tbody>' +
        mats.map(renderUsedRow).join('') +
        '</tbody></table></div>';

    // THE TWO HALVES OF THIS TABLE DO NOT ADD UP, ON PURPOSE. Saying so on the
    // screen is cheaper than being asked, and it stops somebody "fixing" it.
    h += '<div class="aside ans-legend">' +
        '<b>Spent</b> is issued plus written off — what actually left the building. ' +
        '<b>vs plan</b> is spent against planned; a surplus is usually the cutting allowance, because ' +
        'cloth is issued in whole marker rows whether or not the last one is filled. Open a row for the reasons.' +
        '<br><b>Damaged</b>, <b>Waste back</b> and <b>Scrapped</b> sit beside those figures and are ' +
        'deliberately not added into them. At cutting a ruined panel is often part-salvaged into the waste box ' +
        '<em>and</em> reported for reissue — both are true, both are already counted on the left, and netting ' +
        'them without knowing which remnant came from which incident would drive the loss negative.' +
        '</div>';

    panel.innerHTML = h;

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

function loadUsed() {
    var sel = document.getElementById('so-select');
    var soId = sel ? sel.value : '';
    if (!soId) { USED = null; usedLoadedFor = ''; renderUsed(); return; }

    // usedLoadedFor is what makes the tab lazy: coming back to an order already
    // fetched redraws from memory instead of calling again.
    if (usedLoadedFor === soId) { renderUsed(); return; }

    var panel = document.getElementById('panel-used');
    panel.innerHTML = '<div class="empty-state"><h2>Loading…</h2></div>';

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
        renderUsed();
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
        console.log('raw response:', response);
        btn.disabled = false;
        var parsed;
        try {
            parsed = JSON.parse(response.result);
        } catch (e) {
            console.error('JSON.parse failed:', e, response.result);
            content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Could not read the response</h2><p>Check the browser console for details.</p></div>';
            return;
        }
        console.log('parsed:', parsed);
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
        render();
    }).catch(function (err) {
        console.error('invokeCustomApi error:', err);
        btn.disabled = false;
        content.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Failed to load</h2><p>Check the browser console for details.</p></div>';
    });
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
