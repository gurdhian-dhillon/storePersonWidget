// ---- The lot allocator ----
//
// SHARED BY THE STORE SCREEN AND THE ADMIN AUDIT, and that is the whole point of
// it being its own file. The audit exists to show the working behind the issue
// decision, so it has to be the SAME working — a second implementation that
// agrees today is a second implementation that disagrees the week after next,
// and the screen whose job is to be trusted is the worst place for that.
//
// The admin page reaches it as ../js/lot-allocator.js. The whole app/ tree ships
// as one widget zip, so there is nothing to duplicate and no build step.
//
// PURE. No DOM, no fetch, no rendering — everything here takes the server payload
// and writes its answer back onto the material entries. The two `var` stores are
// the exception and they are deliberate: they hold what the STORE PERSON has
// decided this session (a declined remnant, a recorded tone override), and the
// allocation has to see them or it re-offers what he just refused. The admin page
// never writes them, so there they stay empty and the replay is the clean case.
//
// Loaded BEFORE main.js in both pages. Function declarations hoist, so that only
// matters for the two vars.
//
// ---- THE RULE ----
//
// A REMNANT CARRIES THE TONE OF THE LOT IT WAS CUT FROM. So waste is not a
// separate, fungible pool that offsets the requirement before a lot is chosen —
// it is part of what each lot can offer, and choosing the lot and choosing the
// remnants is ONE decision. That is why none of this is in Deluge: splitting the
// two is what let an order be cut from L3 cloth and an L2 offcut in one breath.
//
// THE ORDER IS THE ATOM. It is served whole off one lot, or not served at all:
//
//   1. an order that already has cloth is PINNED to that lot. No choice left, and
//      it then takes whatever that lot can give — all-or-nothing protects the
//      SHADE DECISION, and that decision is already behind it.
//   2. an unpinned order takes the smallest lot that covers it WHOLE off the rack
//      today — washed cloth plus that lot's own offcuts.
//   3. failing that, the smallest lot that covers it whole once its OWN greige is
//      washed. That lot is committed and NOTHING goes out today; the row asks for
//      the wash.
//   4. no lot covers it → it is skipped, and the next order is tried. Blocking
//      would let one order bigger than any lot freeze the fabric for everybody.
//
// Greige never counts as available today. Counting it is what committed an order
// to a lot with nothing washed while a ready lot sat beside it.
function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
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
// IS THIS LOT HELD AS DISCRETE PIECES? An EMPTY form means Roll — every lot
// that existed before printing has the field blank, and reading blank as
// anything else would send the whole rack down the piece path with no pieces,
// making every roll in the building uncuttable.
function lotIsPieces(lot) {
    return lot && lot.form === 'Pieces';
}

// The pieces of a Pieces lot that can go out TODAY, in the same shape the
// remnant scorer uses.
//
// GREIGE PIECES ARE EXCLUDED EVEN FROM THE "AFTER WASHING" SIMULATION, which is
// deliberately not what a Roll lot does, and it is a phase-2 limitation rather
// than a rule.
//
// A roll's greige counts towards "this lot could cover the order once washed",
// and the row then offers a wash. There is no way to wash a PIECE yet: a
// Wash_Request moves a lot's metres between two columns and would leave
// Fabric_Piece.State saying Unwash while the lot claimed washed metres — the
// header and its pieces disagreeing, which is the fault this whole design is
// built to avoid. Offering a wash the store cannot perform is worse than saying
// the row is short.
//
// So greige pieces are counted by the caller and NAMED on the row instead of
// being silently invisible. When piece washing lands, take the greige flag here.
function lotPieces(lot) {
    return (lot.pieces || []).filter(function (p) {
        return (Number(p.count) || 0) > 0 && p.state === 'Wash';
    }).map(function (p) {
        return { pieceId: p.pieceId, width: p.widthCm, length: p.lengthCm,
                 pieces: Number(p.count) || 0 };
    });
}

// Greige pieces sitting on a lot, in pieces. Not allocatable, but real cloth —
// a row that is short because its printed stock has not been washed has to be
// able to say so.
function lotGreigePieces(lot) {
    var n = 0;
    if (lotIsPieces(lot)) {
        (lot.pieces || []).forEach(function (p) {
            if (p.state === 'Unwash') n += Number(p.count) || 0;
        });
    }
    return n;
}

function lotFill(lot, demands, fab, greige) {
    var rem = (lot.waste || []).map(function (r) {
        return { wasteId: r.wasteId, width: r.width, length: r.length,
                 pieces: Number(r.pieces) || 0 };
    });
    var metres = round2(Number(lot.wash) || 0);
    if (greige) metres = round2(metres + (Number(lot.unwash) || 0));

    // A PIECES LOT HAS NO CONTINUOUS CLOTH. Its metres are a maintained sum kept
    // for valuation and for ranking one lot against another — nothing plans a
    // cut off them, because five 3.00 m pieces are not 15 m of usable cloth.
    // Fresh yield comes from the pieces below instead, so the metres budget is
    // taken out of play here to make it impossible to spend twice.
    var pcs = lotIsPieces(lot) ? lotPieces(lot) : [];
    if (lotIsPieces(lot)) metres = 0;

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
    // Which physical pieces each demand takes. Per demand for exactly the reason
    // picksPer is: one piece can yield cuts for two items of an order, and
    // keying on the piece alone would stamp the whole yield with whichever item
    // reached it first.
    var piecesPer = demands.map(function () { return {}; });

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

    // ---- 2. fresh cloth ----
    //
    // TWO SHAPES, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS FILE.
    //
    // A Roll lot is continuous: its metres divide into whole marker rows and any
    // row can start where the last one ended.
    //
    // A Pieces lot is not. Each piece is cut on its own, so its yield is
    // floor(len/cutL) rows and the tail below one cut length is stranded — on
    // EVERY piece. Three 3.00 m pieces are 9.00 m and yield 15 rows of a 55 cm
    // cut, not the 16 that 9.00 continuous metres would. Dividing the metres
    // would credit a row nobody can cut, the requirement would close a piece
    // early, and the item would sit at Awaiting_Material for ever with Issue
    // doing nothing — the exact family of silent-loss bugs CLAUDE.md records.
    var pieceTaken = {};

    if (pcs.length) {
        // Scored the same way remnants are — least waste per cut obtained.
        // A PIECE IS TREATED AS A MINI-ROLL: we cut exactly what we need
        // from it, and the remainder goes back on the rack (though not
        // available for the rest of this session to keep piece provenance clean).
        var pguard = 0;
        while (pguard++ < 400) {
            var pi = -1, pp = -1, pScore = 0, pCap = 0;
            demands.forEach(function (d, i) {
                if (owed[i] <= 0) return;
                pcs.forEach(function (p, ri) {
                    if (p.pieces <= 0) return;
                    var cap = remnantYield(p, d.cutW, d.cutL);
                    if (cap <= 0) return;
                    var take = Math.min(cap, owed[i]);
                    // Score based on taking exactly what we need from ONE piece
                    var pr = Math.floor(p.width / d.cutW);
                    var rows = Math.ceil(take / pr);
                    var lengthCut = rows * d.cutL;
                    // Score = waste area per usable cut
                    var score = ((p.width * lengthCut) - (take * d.cutW * d.cutL)) / take;
                    if (pi < 0 || score < pScore) { pi = i; pp = ri; pScore = score; pCap = cap; }
                });
            });
            if (pi < 0) break;

            var d = demands[pi];
            var p = pcs[pp];
            var pr = Math.floor(p.width / d.cutW);

            // We only process ONE piece count at a time to keep cut sizes exact
            var take = Math.min(pCap, owed[pi]);
            var rows = Math.ceil(take / pr);
            var lengthCut = rows * d.cutL;
            var got = Math.min(rows * pr, owed[pi]);

            p.pieces -= 1; // Take one count of this piece
            var pM = round2(lengthCut / 100);

            owed[pi] -= got;
            // fromFRESH, not fromWaste: this is raw material
            fromFresh[pi] += got;
            freshMetres = round2(freshMetres + pM);
            metresPer[pi] = round2(metresPer[pi] + pM);
            
            pieceTaken[p.pieceId] = (pieceTaken[p.pieceId] || 0) + 1;
            
            // Record the cut length for this pieceId
            if (!piecesPer[pi][p.pieceId]) piecesPer[pi][p.pieceId] = [];
            piecesPer[pi][p.pieceId].push(lengthCut);
        }
    } else {
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
    }

    return {
        picks: picks,
        fromWaste: fromWaste,
        fromFresh: fromFresh,
        freshMetres: freshMetres,
        metresPer: metresPer,
        picksPer: picksPer,
        // Which physical pieces this fill would take, and how many of each — in
        // total and per demand. Both empty for a Roll lot, so nothing downstream
        // has to branch on the form.
        pieceTaken: pieceTaken,
        piecesPer: piecesPer,
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
        // pieceId -> printed pieces unclaimed ON THIS CARD. A Pieces lot holds
        // no continuous cloth, so lotLeft alone cannot stop two orders on one
        // card being offered the same physical piece.
        var pieceLeft = {};

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
                (l.pieces || []).forEach(function (p) {
                    if (pieceLeft[p.pieceId] === undefined) {
                        pieceLeft[p.pieceId] = Number(p.count) || 0;
                    }
                });
            });
        });

        var done = {};
        (sup.materials || []).forEach(function (m) {
            if (!m.isFabric) return;
            var key = String(m.materialId);
            if (done[key]) return;
            done[key] = true;
            allocateMaterial(sup, key, wasteLeft, lotLeft, greigeLeft, pieceLeft);
        });
    });
}

// One supervisor, one material: every cut size and both Plan and Reissue rows,
// allocated together so two rows cannot promise the same cloth.
function allocateMaterial(sup, materialId, wasteLeft, lotLeft, greigeLeft, pieceLeft) {
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
            // ROLL UNLESS IT SAYS OTHERWISE. Every lot that existed before
            // printing has Form blank, and reading blank as Pieces would send
            // the whole rack down the piece path with no pieces to pick.
            form: l.form === 'Pieces' ? 'Pieces' : 'Roll',
            // Copied into fresh objects, with the card's remaining count — the
            // same treatment `waste` gets one field down, and for the same
            // reason: the allocator spends these down as it walks the card's
            // orders, and mutating the server's payload would leak one
            // supervisor's spending into the next card.
            pieces: (l.pieces || []).filter(function (p) {
                return (pieceLeft[p.pieceId] || 0) > 0;
            }).map(function (p) {
                return { pieceId: String(p.pieceId), lengthCm: p.lengthCm,
                         widthCm: p.widthCm, count: pieceLeft[p.pieceId],
                         state: p.state, carton: p.carton };
            }),
            // Carried but never allocatable. Cloth at the wash house cannot be
            // issued today, yet the lot is plainly NOT finished — it comes back
            // washed, in this tone. A pin must survive it.
            inWash: round2(Number(l.inWash) || 0),
            waste: (m0.wasteStock || []).filter(function (r) {
                return r.lotId && String(r.lotId) === String(l.lotId) &&
                       (wasteLeft[r.wasteId] || 0) > 0;
            }).map(function (r) {
                return { wasteId: r.wasteId, width: r.width, length: r.length,
                         pieces: wasteLeft[r.wasteId], carton: r.carton, lot: r.lot };
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
                byOrder[oid] = { demands: [], pin: pinOf[oid] || '',
                                 pinNo: pinNoOf[oid] || '',
                                 origPin: origPin[oid] || '', note: '',
                                 oid: oid };
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

    // WHAT WAS DECIDED, PER ORDER — the audit's copy.
    //
    // The store screen only ever needs the row: one line per lot, one reason. The
    // admin audit needs the decision itself, because the question it exists to
    // answer is "why THIS shade for THIS order", and a row carrying two orders
    // cannot answer it. Same run, same numbers — recorded rather than re-derived,
    // so the audit cannot drift from the screen.
    //
    // Written onto every row of the material; the reader filters by planId.
    var outcomes = [];
    rows.forEach(function (rw) {
        res[rw.idx] = { picks: {}, lotLines: [], fromWaste: 0, fromFresh: 0,
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
                        overrideFrom: '', overrideNote: '', noPieceData: false };
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
                // WHICH PHYSICAL PIECES THIS LINE IS, for a Pieces lot. The
                // server must not re-derive them from the metres: three 3.00 m
                // pieces are 9.00 m, and 9.00 m divided by a 55 cm cut reads as
                // 16 rows where the pieces only yield 15. Naming them is what
                // stops a row nobody can cut being credited.
                //
                // Empty on a Roll lot, so the line is the same shape either way
                // and an older server simply ignores the field.
                var lnPieces = [];
                Object.keys(fill.piecesPer[i] || {}).forEach(function (pid) {
                    var cuts = fill.piecesPer[i][pid]; // Array of cut lengths
                    var srcP = (lot.pieces || []).filter(function (x) {
                        return String(x.pieceId) === String(pid);
                    })[0] || {};
                    
                    var cutCounts = {};
                    cuts.forEach(function(c) {
                        cutCounts[c] = (cutCounts[c] || 0) + 1;
                    });
                    
                    Object.keys(cutCounts).forEach(function(cutLen) {
                        lnPieces.push({ pieceId: pid, count: cutCounts[cutLen],
                                        cutLengthCm: Number(cutLen),
                                        lengthCm: srcP.lengthCm, carton: srcP.carton });
                    });
                });

                r.lotLines.push({ lotId: lot.lotId, lotNumber: lot.lotNumber,
                                  qty: fill.metresPer[i], planItemId: d.planItemId,
                                  planId: d.planId, pieces: lnPieces,
                                  note: noteOn, overrideFrom: fromOn });
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
                    r.picks[k] = { wasteId: wid, pieces: 0, width: src.width, length: src.length,
                                   lot: lot.lotNumber, carton: src.carton, planItemId: d.planItemId };
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

        // THE PIECES COME OFF THE RACK TOO, in both places, for exactly the
        // reason the metres and the remnants do: `lot.pieces` is what the NEXT
        // order on this card is measured against, and without this two orders
        // would each be offered the same physical piece.
        //
        // The metres above already moved — a Pieces lot's `wash` is the
        // maintained sum of its washed pieces, so taking N pieces lowers it by
        // exactly their metres and the two stay in step.
        Object.keys(fill.pieceTaken || {}).forEach(function (pid) {
            pieceLeft[pid] = Math.max(0, (pieceLeft[pid] || 0) - fill.pieceTaken[pid]);
            (lot.pieces || []).forEach(function (p) {
                if (String(p.pieceId) === String(pid)) {
                    p.count = Math.max(0, (Number(p.count) || 0) - fill.pieceTaken[pid]);
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
            outcomes.push({
                planId: ord.oid, why: 'skipped', lotId: '', lotNumber: '',
                pieces: ord.demands.reduce(function (a, d) { return a + d.pieces; }, 0),
                needMetres: want, metres: 0, wastePieces: 0, greige: 0,
                pin: ord.pin ? String(ord.pinNo || ord.pin) : '', override: ''
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

            // WHY THIS LOT, in one word, for the audit:
            //   pinned    — cloth is already cut in this shade, no choice existed
            //   ready     — smallest lot that covers the order off the rack today
            //   afterWash — smallest lot that covers it once its own greige is
            //               washed; committed, and nothing goes out today
            var wpTaken = 0;
            Object.keys(useFill.picks).forEach(function (wid) {
                wpTaken += useFill.picks[wid];
            });
            outcomes.push({
                planId: ord.oid,
                why: ord.pin ? 'pinned' : (ready ? 'ready' : 'afterWash'),
                lotId: String(lot.lotId), lotNumber: lot.lotNumber,
                pieces: ord.demands.reduce(function (a, d) { return a + d.pieces; }, 0),
                needMetres: orderMetres(ord.demands, fab),
                metres: ready ? useFill.freshMetres : 0,
                wastePieces: ready ? wpTaken : 0,
                greige: greigeUse,
                shortPieces: useFill.shortBy,
                pin: ord.pin ? String(ord.pinNo || ord.pin) : '',
                // The disagreement between these two IS the evidence a person
                // chose the shade rather than a rule slipping.
                override: (ord.note && ord.origPin && ord.origPin !== ord.pin)
                    ? ord.note : ''
            });

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
                        r.washLots.push({ lotId: String(lot.lotId),
                                          lotNumber: lot.lotNumber });
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
            m.wastePicks.push({ wasteId: rk.wasteId, pieces: 0, width: rk.width,
                                length: rk.length, lot: rk.lot, carton: rk.carton,
                                planItemId: '' });
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
            return { lotId: w.lotId, lotNumber: w.lotNumber,
                     qty: round2(waitingWash[w.lotId] || 0),
                     // THIS ROW's share — what the row itself is waiting on, and
                     // the only figure that belongs on the row. `qty` above is
                     // the card's total for the lot and is for the summary.
                     rowQty: round2(r.washNeed[w.lotId] || 0) };
        });
        m.committedLots = r.lotsUsed;
        // The per-order decisions for the whole material, on every row of it. The
        // audit filters by planId; the store screen ignores it.
        m.orderOutcomes = outcomes;
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
        return { kind: r.pinnedBlocked ? 'pinnedBlocked' : 'pinnedDry',
                 lot: r.pinnedDryLots.join(' and ') };
    }

    var byId = {};
    lots.forEach(function (l) { byId[String(l.lotId)] = l; });

    // Greige on the committed lot. The one case with a button on it, so it beats
    // everything below.
    var wash = (m.washLots || []).filter(function (w) {
        return byId[String(w.lotId)] && round2(Number(w.rowQty) || 0) > 0;
    });
    if (wash.length > 0) {
        return { kind: 'wash',
                 lots: wash.map(function (w) {
                     return { lotNumber: w.lotNumber, qty: round2(Number(w.rowQty) || 0) };
                 }) };
    }

    // Committed, nothing left to wash, but cloth already at the washer. Not a
    // finished lot — it comes back in this shade, so the answer is wait.
    var atWash = null;
    (r.lotsUsed || []).forEach(function (u) {
        var l = byId[String(u.lotId)];
        if (!atWash && l && (Number(l.inWash) || 0) > 0) {
            atWash = { kind: 'atWash', lot: l.lotNumber,
                       qty: round2(Number(l.inWash) || 0) };
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
            return { kind: 'nofit', lot: big.lotNumber, have: big.qty,
                     need: round2(r.noFitSmallest) };
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
