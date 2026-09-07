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

// IS THIS ROLL CLOTH THIS SCREEN MAY CUT?
//
// `Consumed` is a roll that has been used up and is off the shelf. `Blocked` is
// quarantined cloth on a roll — the lot-level `blocked` flag's twin, one roll at
// a time, and it is a real `Roll_Status` value (docs/lot-rolls-model.md Step 0).
// Only `Consumed` was ever excluded, so a blocked roll was cut like any other and
// named on the issue line.
//
// EVERY reader of a roll goes through here — lotFill, the ledger seeding, the
// per-card working copy and the `nofit` scanner. A roll excluded from the
// allocation but still counted by the scanner is worse than either alone: the row
// quotes cloth back at him that the allocation has already refused.
function rollUsable(rr) {
    var s = String((rr && rr.status) || 'Available');
    return s !== 'Consumed' && s !== 'Blocked' &&
           (Number(rr && rr.length) || 0) > 0;
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
//
// RETIRED: lotIsPieces / lotPieces / lotGreigePieces. Printed cloth was once a
// discrete-pieces special case (Fabric_Piece rows, a `form === 'Pieces'`
// branch) with its own least-waste-area cut scorer and its own greige
// exclusion. Under the rolls model a printed lot is just a lot whose rolls are
// short — same `lot.rolls[]`, same shortest-first drain in lotFill, no branch.
// The functions and the Pieces-only code paths in lotFill/spend/allocateMaterial
// were removed in Pieces 1-2 of the rolls migration (docs/lot-rolls-model.md).

// ---- Printed cloth, and the plain cloth behind it ----
//
// A printed SKU carries Print_Base: the plain SKU it is printed from. The
// server sends the id, the base's name and the base's LOTS in the same shape as
// this material's own, so a row with no printed stock can say what there IS.

// IS THERE ANY PRINTED STOCK AT ALL of this material?
//
// Read off the SERVER's lots (m.lots), never the allocator's spent-down copies.
// The copies are what this pass has left after serving the card's orders, so a
// lot emptied by an allocation that still fell short would read as "there was
// never any" — and the row would tell him to go and print more of cloth he has
// just been handed some of.
//
// Anything counts: washed, greige, at the wash house, or pieces on the rack.
// Blocked cloth counts too, deliberately — quarantined printed stock is still
// printed stock, and the `blocked` reason below is the one that says something
// he can act on.
function hasOwnStock(m) {
    return (m.lots || []).some(function (l) {
        if ((Number(l.wash) || 0) > 0) return true;
        if ((Number(l.unwash) || 0) > 0) return true;
        if ((Number(l.inWash) || 0) > 0) return true;
        return false;
    });
}

// THE PLAIN CLOTH THIS ROW COULD BE PRINTED FROM, biggest lot first.
//
// Washed AND greige, because a print run may go out in either state — the send
// form picks which counter it comes off. Quoting only the washed pile would say
// "nothing to print" over a rack full of greige.
//
// Blocked lots are excluded: quarantined plain cloth cannot be sent anywhere,
// so offering it would send him to the printer with cloth he cannot take.
//
// Returns null when there is nothing to print, which is what makes the row fall
// through to the ordinary reasons instead of naming an action he cannot take.
function plainBaseStock(m) {
    if (!m || !m.printBase) return null;
    var lots = (m.printBaseLots || []).filter(function (l) {
        return !l.blocked &&
               round2((Number(l.wash) || 0) + (Number(l.unwash) || 0)) > 0;
    }).map(function (l) {
        return { lotNumber: l.lotNumber,
                 qty: round2((Number(l.wash) || 0) + (Number(l.unwash) || 0)) };
    });
    if (lots.length === 0) return null;
    lots.sort(function (a, b) { return b.qty - a.qty; });
    return { id: String(m.printBase), name: String(m.printBaseName || ''),
             lots: lots };
}

function lotFill(lot, demands, fab, greige, withInWash) {
    var rem = (lot.waste || []).map(function (r) {
        return { wasteId: r.wasteId, width: r.width, length: r.length,
                 pieces: Number(r.pieces) || 0 };
    });

    // WHETHER THIS LOT CAN COVER THE ORDER ONCE ITS GREIGE IS WASHED is a
    // LOT-LEVEL question — washing moves a metres figure between the lot's wash
    // columns and never changes a roll's length. So `greige` here only widens
    // the wash-state gate below; it does NOT add cloth to any roll.
    //
    // `inWash` IS NOT PART OF THIS GATE, and adding it was a real regression.
    // The greige gate answers "could this lot cover the order if somebody went
    // and washed its greige" - an action the store person can take, and the one
    // the `wash` shortReason offers a button for. Cloth already AT the wash house
    // is not that: nobody can send it again, it simply has to come back. Counting
    // it here made a committed lot report `wash` - "send N metres to wash" - over
    // cloth that was already there, burying the `atWash` reason ("it is at the
    // washer, wait") which exists precisely to say so. The frozen e000519
    // baseline adds `unwash` only; this now matches it again.
    //
    // `withInWash` is the THIRD question, and it is never asked by an allocation.
    // It answers only "would this lot cover the order once the cloth at the wash
    // house comes back", which the skip path needs so a row can say `atWash`
    // instead of quoting a roll it is not allowed to cut. Nothing that spends a
    // ledger passes it.
    var washMetres = round2(Number(lot.wash) || 0);
    var gateMetres = greige
        ? round2(washMetres + (Number(lot.unwash) || 0))
        : washMetres;
    if (withInWash) gateMetres = round2(gateMetres + (Number(lot.inWash) || 0));

    // THE PHYSICAL ROLLS — a working copy, drained as this fill places rows so
    // `covers` can be tested without touching the lot. Shortest first, tie on
    // length broken by Roll_Label, so short rolls are cleared before a long one
    // is nibbled (the store consolidates stock into fewer, longer rolls). A
    // roll below one marker row of the cut contributes nothing and is skipped.
    //
    // Printed cloth is not a special case: its lot simply has short rolls, and
    // they drain shortest-first like any other.
    var rollWork = (lot.rolls || [])
        .filter(rollUsable)
        .map(function (rr) {
            return { rollId: String(rr.rollId), label: String(rr.label || ''),
                     length: round2(Number(rr.length) || 0) };
        });
    rollWork.sort(function (a, b) {
        if (a.length !== b.length) return a.length - b.length;
        return String(a.label) < String(b.label) ? -1 : (String(a.label) > String(b.label) ? 1 : 0);
    });

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
    // THE GUARD CANNOT BE A CONSTANT, because it is not a safety net — it is a
    // bound, and 400 was below the real one. Every pass through this loop either
    // exhausts a remnant row or finishes a demand, so the loop cannot run more
    // than (remnants + demands) times. A lot carrying more than 400 remnant rows
    // hit the old cap mid-allocation, and the damage was not "some offcuts went
    // unused": the demand left owing made `covers` false, so chooseLotForOrder
    // rejected the lot and the ORDER WAS SKIPPED ENTIRELY — 450 remnants on the
    // rack against a 450-piece job allocated nothing at all.
    var guard = 0;
    var guardMax = rem.length + demands.length + 2;
    while (guard++ < guardMax) {
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

    // ---- 2. fresh cloth, ONE ROLL AT A TIME ----
    //
    // A lot is a set of physical rolls, not a continuous metres pool. Each roll
    // yields floor(rollLen / cutL) whole marker rows and the tail below one cut
    // length is stranded — ON EVERY ROLL. Ten metres in one roll yields more
    // than ten metres split 8 + 2 against a 10 m marker: the 2 m roll yields
    // nothing. Treating the lot's metres as one pool credits rows nobody can
    // cut, closes a requirement early, and strands the item at
    // Awaiting_Material with Issue doing nothing — the silent-loss family
    // CLAUDE.md records. This is the whole reason the model went to rolls.
    //
    // SHORTEST ROLL FIRST (rollWork is pre-sorted), drained in whole marker
    // rows until it can give no more, then the next-shortest. Short rolls clear
    // before a long one is touched, which consolidates the rack into fewer,
    // longer rolls over time.
    //
    // THE WASH GATE BOUNDS THE LOOP, not just the result. `gateBudget` starts
    // at the lot's washed metres (or wash+greige if `greige`) and every row
    // placed draws it down. When it runs out, no more cloth is cut — exactly as
    // the old scalar `metres` pool did. So a lot with 50 m of rolls but 0 m
    // washed places NOTHING today (greige false) and `covers` is false, rather
    // than cutting metres it cannot wash.
    //
    // `rollLinesPer` records, per demand, which rolls it cut and how many
    // metres off each — this is what the issue line carries so the fan
    // decrements the right roll.
    var rollLinesPer = demands.map(function () { return []; });
    var gateBudget = round2(gateMetres);

    demands.forEach(function (d, i) {
        if (owed[i] <= 0) return;
        var pr = perRowFor(fab, d.cutW);
        var cl = Number(d.cutL) || 0;
        if (pr <= 0 || cl <= 0) return;

        for (var ri = 0; ri < rollWork.length && owed[i] > 0 && gateBudget > 0.0001; ri++) {
            var roll = rollWork[ri];
            if (roll.length <= 0) continue;
            // Rows this roll can physically give, AND rows the wash gate still
            // allows — whichever is smaller.
            var rowsRoll = Math.floor((roll.length * 100 + 0.0001) / cl);
            var rowsGate = Math.floor((gateBudget * 100 + 0.0001) / cl);
            var rowsAvail = Math.min(rowsRoll, rowsGate);
            if (rowsAvail <= 0) continue;         // roll too short, or gate spent
            var rowsWant = Math.ceil(owed[i] / pr);
            var rows = Math.min(rowsWant, rowsAvail);
            if (rows <= 0) continue;
            var m = round2((rows * cl) / 100);

            roll.length = round2(roll.length - m);
            gateBudget = round2(gateBudget - m);
            freshMetres = round2(freshMetres + m);
            metresPer[i] = round2(metresPer[i] + m);
            var got2 = Math.min(rows * pr, owed[i]);
            owed[i] -= got2;
            fromFresh[i] += got2;

            rollLinesPer[i].push({ rollId: roll.rollId, label: roll.label, metres: m });
        }
    });

    var rollsCovered = owed.every(function (n) { return n <= 0; });
    // The loop already respected the gate, so anything placed is within it.
    var washGateOk = true;

    return {
        picks: picks,
        fromWaste: fromWaste,
        fromFresh: fromFresh,
        freshMetres: freshMetres,
        metresPer: metresPer,
        picksPer: picksPer,
        // Which ROLLS this fill would cut, and how many metres off each — per
        // demand. Empty when there is no fresh cloth to take. The issue line
        // carries these so the fan decrements the right roll.
        rollLinesPer: rollLinesPer,
        // The drained working copy — spend() reads it to mirror the cut onto
        // the real lot.rolls so the next order sees what is left.
        rollsAfter: rollWork,
        // Legacy fields, kept so nothing downstream throws on a missing key.
        // Printed cloth is now short rolls, not Fabric_Piece — these are always
        // empty.
        pieceTaken: {},
        piecesPer: demands.map(function () { return {}; }),
        // Nothing still owing (the loop already stayed inside the wash gate).
        covers: rollsCovered && washGateOk,
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

    // OPEN QUESTION, DELIBERATELY LEFT AS IT IS — see the note below before
    // changing it, because it is a POLICY and not a defect.
    //
    // "Size" is wash + unwash in BOTH tiers, so a lot is ranked by how much of
    // this shade exists, washed or not. On the today tier that means a lot with
    // 12 m washed behind 200 m of greige reads as a 212 m lot and is protected
    // as the big one: the order goes to a 60 m fully-washed lot instead,
    // nibbling the ready cloth and leaving intact the lot that cannot serve
    // anybody until somebody washes it. Ranking the today tier by washed metres
    // alone reverses that, and on the sequences tried it serves more orders.
    //
    // It was NOT changed, for two reasons. It is not wrong — protecting the lot
    // with the most cloth behind it is a coherent rule, and greige does get
    // washed. And tools/allocator-rolls-parity.test.js pins every decision this
    // function makes to the frozen pre-rolls baseline (e000519); changing which
    // lot an order is cut from is the most consequential change this file can
    // make, and it is not one to slip in behind a bug fix. Decide it on purpose,
    // then re-baseline that test in the same pass.
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

// ---- METRES HE HAS TYPED INTO A LOT BOX ----
//
// Kept on `m.metresEditByLot` (lotId -> metres) and NOT in a module-level store
// beside lotOverrides and wasteDeclined, and the difference in where it lives is
// the difference in what it means.
//
// It has to be kept SOMEWHERE, because the allocation is a pure function of
// (raw payload, declines, overrides) that rebuilds every line from scratch on
// each call — so a figure that is not an input to it is erased the next time
// anything on the screen moves. That is what happened: `reallocateInPlace` re-runs
// the WHOLE screen when a remnant is ticked, so an edit typed on any row reverted
// to the auto figure with `metresEdited` cleared, and because that repaint only
// ever touched the material he had just touched, the input box on the reverted
// row went on displaying the number he typed. The screen said 6 and the handover
// sent 10 — the submit path reads `m.lotLines` and never the boxes.
//
// But it must NOT outlive the allocation it answers, which is exactly what a
// module-level store would have done. A decline and a tone override are decisions
// about a THING — this remnant, this shade — and the thing survives a refresh, so
// those two rightly do. A metres figure answers an allocation, and a refetch
// replaces the allocation: the lot may have been restocked, another store person
// may have cut the same roll, the order may have been part-covered since.
// Re-applying "6" to a row that now recommends 22 is the same silent override
// this store exists to stop, pointing the other way.
//
// Living on the material gives that lifetime for free. Every re-render reuses the
// same objects, so an edit survives them all; a refetch builds new ones from the
// server payload, so it takes nothing with it. No reset call to remember, and no
// way for one screen's figure to land on another's row.
//
// ONLY DIVERGENCES ARE KEPT. Putting a lot back to its auto figure — by typing
// it, by the checkbox, or by select-all — deletes the entry rather than storing
// the auto number, so a screen nobody has edited re-applies nothing.

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
// THE CEILING ON A WASTE BOX IS THE ALLOCATOR'S OWN PICK, NOT THE RACK.
//
// The rack figure is how many remnants EXIST; the pick is how many this job
// needs. They are usually different, and offering the rack lets the store person
// hand over remnants nothing asked for: a demand of 4 cuts takes ONE remnant of
// a 3-remnant row, and a box capped at 3 invites him to send the other two out
// against a requirement that cannot credit them. Once issued they are gone from
// the rack and off the screen, with no row anywhere saying why.
//
// SO THE CEILING IS THE UNDECLINED PICK — what the allocator offered before he
// touched anything. It cannot be the CURRENT pick: typing 1 would drop the
// ceiling to 1 and trap him there, unable to go back up to the 3 he was offered.
//
// This runs the allocation once with declines suspended and records the result
// per pick as `autoPieces`. That is only safe because applyLotAllocation is a
// pure function of (raw payload, declines, overrides) and rebuilds every ledger
// from scratch on each call — the same property that lets the priority reorder
// re-run it with no reset step. It never mutates the payload's lots.
//
// It is the exact mirror of `m.autoMetres` on the lot side, and exists for the
// same reason: an edit needs a fixed baseline to be measured against, and the
// live figure moves as he edits.
function applyLotAllocation(data) {
    var declineBackup = {};
    var hadDecline = false;
    for (var dk in wasteDeclined) {
        if (Object.prototype.hasOwnProperty.call(wasteDeclined, dk)) {
            declineBackup[dk] = wasteDeclined[dk];
            hadDecline = true;
        }
    }
    if (hadDecline) {
        for (var ck in declineBackup) delete wasteDeclined[ck];
        allocateEveryCard(data);
        var autoByMat = {};
        (data || []).forEach(function (sup) {
            (sup.materials || []).forEach(function (m, mi) {
                var key = String(sup.supervisorId) + '|' + mi;
                var byId = {};
                (m.wastePicks || []).forEach(function (p) {
                    byId[String(p.wasteId)] = Number(p.pieces) || 0;
                });
                autoByMat[key] = byId;
            });
        });
        for (var rk in declineBackup) wasteDeclined[rk] = declineBackup[rk];
        allocateEveryCard(data);
        (data || []).forEach(function (sup) {
            (sup.materials || []).forEach(function (m, mi) {
                var byId = autoByMat[String(sup.supervisorId) + '|' + mi] || {};
                (m.wastePicks || []).forEach(function (p) {
                    var a = byId[String(p.wasteId)];
                    p.autoPieces = a === undefined ? (Number(p.pieces) || 0) : a;
                });
            });
        });
        return;
    }

    // No declines in force, so the pass below IS the undeclined pass.
    allocateEveryCard(data);
    (data || []).forEach(function (sup) {
        (sup.materials || []).forEach(function (m) {
            (m.wastePicks || []).forEach(function (p) {
                p.autoPieces = Number(p.pieces) || 0;
            });
        });
    });
}

function allocateEveryCard(data) {
    // ONE LEDGER ACROSS EVERY CARD — a real reservation, walked in priority
    // order. This REVERSES a previous decision, deliberately, and the reversal
    // is the whole feature. What the old comment said, and why it no longer
    // holds:
    //
    //   "ONE LEDGER PER SUPERVISOR — NEVER ONE SHARED BETWEEN THEM. Shared,
    //    these stopped being a working total and became a RESERVATION… the
    //    first supervisor spent the rack and the last was measured against what
    //    he left: his rows read 'no lot holds enough' while twenty metres sat on
    //    the shelf with nobody's name on it… The store person could not issue to
    //    him at all. A hard reservation ledger was considered for this app and
    //    rejected; this was it, rebuilt by accident inside the allocator."
    //
    // Every word of that was true of the version it described. It failed for one
    // reason: the store person could see a card go short and had NO WAY TO SEE
    // WHY OR ACT ON IT. Priority was an invisible server-side sort key, so a low
    // card was simply short, over cloth he was looking at.
    //
    // Two things make it work now, and neither existed then:
    //
    //   1. HE SETS THE ORDER, on this screen. A card is short because he put
    //      someone else first — and he can move them up.
    //   2. IT RE-RUNS LIVE. Reordering recomputes the whole screen; there is no
    //      stale reservation to argue with.
    //
    // Priority stopped being a hint and became the control. That is the trade:
    // the screen may now say a card cannot be served, but only ever as the
    // direct consequence of an order the store person chose and can change.
    //
    // NOTHING IS RESERVED SERVER-SIDE. This is a view: a pure function of (raw
    // rack, order). issueMaterials still re-checks every lot when Issue is
    // actually pressed, so a stale plan can never over-issue.
    //
    // Within one card they still do their original job too: one Issue press
    // serves the whole card, so two orders or two cut sizes of the same
    // supervisor must not promise the same cloth twice.
    var wasteLeft = {};    // wasteId -> pieces unclaimed, ACROSS ALL CARDS
    var lotLeft = {};      // materialId|lotId -> washed metres left
    // GREIGE IS SPENT TOO, and forgetting it was a real hole: an order that
    // picks a lot because its greige can finish it has spoken for that
    // greige at the wash house. Track only the washed metres and the next
    // order is told the same pile will finish it as well.
    var greigeLeft = {};   // materialId|lotId -> unwashed metres left
    // pieceId -> printed pieces unclaimed. Legacy: no lot carries `pieces`
    // any more (printed cloth is short rolls), kept so the seeding below and
    // spend() stay shape-compatible.
    var pieceLeft = {};
    // materialId|lotId|rollId -> metres left on that physical roll. lotLeft is
    // the WASH-STATE budget; rollLeft is the PHYSICAL length. Both bound a fill
    // — a lot can be washed enough yet have no single roll long enough, or have
    // the roll but not the wash.
    var rollLeft = {};

    // SEEDED ONCE, FROM THE WHOLE SCREEN, BEFORE ANY CARD IS SERVED.
    //
    // The server sends the true rack figure to EVERY card — it does not divide
    // stock between them — so any card that mentions a material carries the same
    // full figure for it. Seeding on first sight is therefore seeding from the
    // rack, and the `=== undefined` guards mean a second card mentioning the
    // same lot cannot re-inflate a ledger the first card is about to spend.
    //
    // This pass is SEPARATE from the allocation pass below, and that separation
    // is the reservation: every ledger holds the full rack before supervisor 1
    // takes anything, and each card afterwards is measured against the running
    // remainder.
    (data || []).forEach(function (sup) {
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
                // ROLL LEDGER — the remaining length of each physical roll,
                // keyed material|lot|rollId. Drained by spend() as orders are
                // served so the next order — on this card OR any later one —
                // sees the shortened roll.
                (l.rolls || []).forEach(function (rr) {
                    if (!rollUsable(rr)) return;
                    var rk = String(m.materialId) + '|' + String(l.lotId) + '|' + String(rr.rollId);
                    if (rollLeft[rk] === undefined) {
                        rollLeft[rk] = round2(Number(rr.length) || 0);
                    }
                });
            });
        });
    });

    // THE ALLOCATION PASS — cards in priority order, spending the shared
    // ledgers. `data`'s array order IS the priority order; the caller
    // (render()) arranges it before calling.
    var DEBUG_TOP = (typeof window !== 'undefined' && window.DEBUG_ALLOCATOR);
    (data || []).forEach(function (sup) {
        var done = {};
        (sup.materials || []).forEach(function (m) {
            if (!m.isFabric) return;
            var key = String(m.materialId);
            if (done[key]) return;
            done[key] = true;

            // WHAT IS LEFT FOR THIS CARD, BEFORE IT TAKES ANY OF IT — the same
            // reservation the LOT recommendation is about to be measured
            // against, stamped onto every row of this material on this card so
            // TOTAL WASH STOCK shows that number instead of the raw rack figure
            // every card carries (the server sends the full rack to everybody;
            // it does not divide it up).
            //
            // Taken BEFORE allocateMaterial spends this card's own share, or a
            // card would appear to eat its own total — only what HIGHER-priority
            // cards already claimed should show as gone. Priority 1 therefore
            // still reads the full rack; priority 2 reads whatever priority 1
            // left; and so on down the order the store person set on this
            // screen, which he can always reshuffle to unlock stock for
            // whoever he decides should have it first.
            //
            // WRITTEN ONTO `m2` (THE MATERIAL), NEVER ONTO `l` (THE LOT). A lot
            // is shared by reference across every supervisor's copy of the same
            // material — the payload hands the same lot record to everyone who
            // mentions it, harmless as long as nothing writes to it. Stamping
            // `l.washLeft` directly did exactly that: Suraj's card and Aniket's
            // card were pointing at the SAME lot object, so Aniket's stamp
            // (processed second) silently overwrote the figure Suraj's card was
            // about to render, and Suraj's own "Total Wash Stock" ended up
            // showing what was left for Aniket instead. `m2.lotWashLeft` is a
            // fresh map on the material, and `m2` is per-card and per-row —
            // never shared — so this cannot leak between cards the same way.
            (sup.materials || []).forEach(function (m2) {
                if (!m2.isFabric || String(m2.materialId) !== key) return;
                var wl = {};
                (m2.lots || []).forEach(function (l) {
                    var lk = key + '|' + String(l.lotId);
                    wl[String(l.lotId)] = lotLeft[lk] !== undefined
                        ? round2(lotLeft[lk]) : round2(Number(l.wash) || 0);
                });
                m2.lotWashLeft = wl;
                if (DEBUG_TOP) {
                    console.log('[reserve] card=' + (sup.supervisorName || sup.supervisorId) +
                        ' material=' + (m2.material || key) + ' lotWashLeft=' + JSON.stringify(wl));
                }
            });

            allocateMaterial(sup, key, wasteLeft, lotLeft, greigeLeft, pieceLeft, rollLeft);
        });
    });

    // ---- WHAT IS LEFT ON EACH PHYSICAL ROLL WHEN EVERY CARD HAS BEEN SERVED ----
    //
    // The ONLY honest ceiling for a hand-typed metres figure, and the reason it
    // has to be computed HERE rather than inside a card: `applyFabricOverride`
    // clamped an edit-up at the roll's length **from the raw server payload**,
    // which the allocator deliberately never mutates. That figure is the roll
    // before anybody cut it. One 20 m roll serving two supervisors 5 m each,
    // supervisor 2 types 20, and 25 m goes out against a 20 m roll — both issue
    // lines naming it. Within one card it never showed, because a lot's lines all
    // share one aggregated roll breakdown; across cards there was nothing
    // stopping it, and the store screen shows every card at once.
    //
    // Written after the whole pass, not per card, or card 1's ceiling would still
    // include the metres cards 2 and 3 are about to take. `rollFree` is what
    // nobody has claimed; the editable ceiling is that plus what THIS row already
    // holds on the roll, which applyFabricOverride adds back.
    // KEYED lotId|rollId, AND SHARED BY EVERY ROW OF THE MATERIAL.
    //
    // Two things went wrong with a bare `rollId` key and one object per row, and
    // they are the same mistake at two grains:
    //
    //   - TWO LOTS CAN CARRY THE SAME rollId. Creator ids are unique, but the
    //     label-derived ids the seed writer and every fixture use are not, and a
    //     collision silently collapsed both rolls into one entry. Whichever lot
    //     was written last won — so a lot drained to 6 m read as 10 and the cap
    //     UNDER-clamped, which is the unsafe direction: an edit-up was allowed
    //     into metres that were not there.
    //
    //   - ONE MATERIAL HAS SEVERAL ROWS (a Plan row and a Reissue row, and the
    //     same material on another supervisor's card), and each got its own copy
    //     of the free figure. Each row's cap was then `free + its own auto`,
    //     measured against a `free` nobody was decrementing — so two rows could
    //     each be extended into the same unclaimed metres. 20 m + 20 m off one
    //     20 m roll, which is the very hole the `rollFree` ceiling was added to
    //     close, one level down.
    //
    // So there is ONE object per material, held by reference on every row of it
    // across every card, and applyFabricOverride charges its edits against it —
    // see `rollDelta` there for how that stays re-entrant under a keystroke.
    var freeByMat = {};
    (data || []).forEach(function (sup) {
        (sup.materials || []).forEach(function (m) {
            if (!m.isFabric) return;
            var mid = String(m.materialId);
            var free = freeByMat[mid] || (freeByMat[mid] = {});
            (m.lots || []).forEach(function (l) {
                (l.rolls || []).forEach(function (rr) {
                    var fk = String(l.lotId) + '|' + String(rr.rollId);
                    if (free[fk] !== undefined) return;
                    var rk = mid + '|' + String(l.lotId) + '|' + String(rr.rollId);
                    free[fk] = rollLeft[rk] !== undefined ? round2(rollLeft[rk]) : 0;
                });
            });
            m.rollFree = free;
            // What THIS row has taken off each roll beyond its auto figure,
            // signed. Reset with the ledger it is measured against.
            m.rollDelta = {};
        });
    });

    // ---- AND PUT BACK WHAT HE TYPED ----
    //
    // The allocator rebuilds every ledger from scratch on each call, which is
    // what makes it safe to re-run — and is exactly why a hand-typed metres
    // figure did not survive one. `reallocateInPlace` re-runs the WHOLE screen
    // whenever a remnant is ticked, so an edit typed on any row was silently
    // reverted to the auto figure, `metresEdited` cleared with it, and — because
    // that repaint only ever touched the material he had just touched — the input
    // box on the reverted row went on displaying the number he typed. The screen
    // said 6 and the handover sent 10, with the submit path reading `m.lotLines`
    // and never the boxes.
    //
    // So the edits live in a session store, exactly like `lotOverrides` and
    // `wasteDeclined`, and are re-applied after every pass. The store holds only
    // DIVERGENCES: applyFabricOverride deletes the entry the moment a lot is put
    // back to its auto figure, so an untouched screen re-applies nothing and the
    // clean case is unchanged.
    (data || []).forEach(function (sup) {
        (sup.materials || []).forEach(function (m) {
            if (!m.isFabric || !m.metresEditByLot) return;
            // Snapshot the keys: applyFabricOverride writes back into this same
            // object, and one that restores a lot to its auto figure deletes from
            // it.
            var keys = [];
            for (var lk in m.metresEditByLot) {
                if (Object.prototype.hasOwnProperty.call(m.metresEditByLot, lk)) keys.push(lk);
            }
            keys.forEach(function (lk) {
                var e = m.metresEditByLot[lk];
                if (e !== undefined) applyFabricOverride(m, lk, e);
            });
        });
    });
}

// One supervisor, one material: every cut size and both Plan and Reissue rows,
// allocated together so two rows cannot promise the same cloth.
function allocateMaterial(sup, materialId, wasteLeft, lotLeft, greigeLeft, pieceLeft, rollLeft) {
    rollLeft = rollLeft || {};
    var rows = [];
    (sup.materials || []).forEach(function (m, i) {
        if (m.isFabric && String(m.materialId) === materialId) rows.push({ m: m, idx: i });
    });
    if (rows.length === 0) return;

    var m0 = rows[0].m;
    var fab = { fabricWidthCm: m0.fabricWidthCm };

    // DEBUG AID, OFF BY DEFAULT. Set window.DEBUG_ALLOCATOR = true in the
    // console and reload to see, per material, every order that could not be
    // served and why — the exact question "which of the 100+ orders are still
    // waiting, and how much does each one need" that the screen has no room to
    // answer. Guarded so normal use pays nothing for it.
    var DEBUG = (typeof window !== 'undefined' && window.DEBUG_ALLOCATOR);
    var debugSkips = [];

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
            // ROLL UNLESS IT SAYS OTHERWISE. Legacy Form value, no longer used
            // to branch — every lot is rolls now — kept only so nothing
            // downstream that still reads `.form` gets undefined.
            form: l.form === 'Pieces' ? 'Pieces' : 'Roll',
            // THE PHYSICAL ROLLS, with the card's remaining length per roll —
            // the same treatment `waste` and `pieces` get, and for the same
            // reason: spend() drains rollLeft as the card's orders are served,
            // and mutating the server's payload would leak one supervisor's
            // spending into the next card. A roll drained to <= 0 is dropped.
            rolls: (l.rolls || []).map(function (rr) {
                var rk = materialId + '|' + l.lotId + '|' + rr.rollId;
                var left = rollLeft[rk] !== undefined
                    ? rollLeft[rk] : round2(Number(rr.length) || 0);
                return { rollId: String(rr.rollId), label: String(rr.label || ''),
                         length: left, status: rr.status || 'Available',
                         origin: rr.origin || 'Purchased' };
            }).filter(rollUsable),
            // Legacy Fabric_Piece copy — no lot has these any more (printed
            // cloth is short rolls), kept empty so old readers don't throw.
            pieces: [],
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
    //
    // CUT SIZE COMES OFF THE LINE, not the entry. One SKU row now spans every
    // cut its fabric is used at, so the marker layout for a demand is whatever
    // THIS plan item's line recorded — grain is fixed, one width across the
    // cloth, one length along it. lotFill already scores every demand by its own
    // d.cutW / d.cutL, so a mixed-cut set allocates correctly in one pass.
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
                // THE REQUIREMENT ROW. One Plan_Item can need this fabric at TWO
                // cut sizes (a body panel and a facing off the same cloth) — two
                // Material_Requirement rows, one planItemId. The payload must fan
                // back to each row, so the demand and every lot line it produces
                // carry the mrqId, not just the item id.
                mrqId: String(ln.mrqId || ''),
                // Cut size off the LINE. Fall back to a cut on the entry only for
                // a payload that predates the per-line field (older tests, a
                // stale server) — the live server always sends it per line.
                cutW: Number(ln.cutW) || Number(rw.m.cutWidth) || 0,
                cutL: Number(ln.cutL) || Number(rw.m.cutLength) || 0,
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
                        // PER CUT SIZE, keyed "cutWxcutL". A SKU row spans many
                        // cuts and the "still needs" metres figure is only
                        // meaningful per cut length, so the write-back walks
                        // these instead of one cut on the entry. owedByCut is
                        // seeded from the demands; wasteByCut is filled by spend().
                        owedByCut: {}, wasteByCut: {},
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
                        // THE PINNED LOT IS THERE, IT IS SIMPLY NOT ENOUGH.
                        //
                        // Distinct from pinnedDry, which means the tone is gone
                        // and he has a decision to make. This one has no decision
                        // in it — the order is cut in this shade, the shade is on
                        // the rack, there is not enough of it — and it had no
                        // reason of its own, so it fell all the way through
                        // shortReasonFor to `empty`: "none of this shade left",
                        // printed over the hundred metres of another shade he is
                        // looking at. Everything below `empty` assumed a row
                        // reached it with no lot at all.
                        pinnedShortLots: [],
                        // A LOT WHOSE CLOTH IS AT THE WASH HOUSE, on an order that
                        // was SKIPPED rather than committed. `lotsUsed` cannot
                        // carry these — nothing was committed to — but `atWash`
                        // ("it is at the washer, wait") is still the only true
                        // sentence about the row, and it was unreachable for an
                        // unpinned order because the wash gate rightly excludes
                        // inWash and the order never reached a lot at all.
                        atWashLots: [],
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
                // WHICH PHYSICAL ROLLS THIS LINE CUT, and how many metres off
                // each. The server must not re-derive these from the total: a
                // lot's metres are spread across rolls of different length, and
                // the fan has to decrement the exact roll the cutter used. Empty
                // when this fill placed no fresh cloth on this demand.
                var lnRolls = (fill.rollLinesPer[i] || []).map(function (rl) {
                    return { rollId: String(rl.rollId), label: String(rl.label || ''),
                             metres: round2(Number(rl.metres) || 0) };
                });

                var cSumm = '';
                if (lnRolls.length > 1) {
                    cSumm = 'Rolls: ' + lnRolls.map(function (rl) {
                        return rl.label + ' ' + round2(rl.metres) + 'm';
                    }).join(', ');
                }

                // fromRaw / fromWaste ARE THE CREDIT, carried so the payload
                // builder never recomputes them. The server adds these straight
                // to Pieces_From_Raw / Pieces_From_Waste — a widget recompute
                // that rounded differently, or missed lotFill's cap at `owed`,
                // would over-close the requirement. fromWaste per line is the
                // remnant yield the SAME fill() assigned to this demand; the
                // physical remnant picks travel separately in `picks`.
                r.lotLines.push({ lotId: lot.lotId, lotNumber: lot.lotNumber,
                                  qty: fill.metresPer[i], planItemId: d.planItemId,
                                  planId: d.planId,
                                  // THE REQUIREMENT ROW this line serves. One
                                  // Plan_Item can have two Material_Requirement
                                  // rows for this fabric (two cut sizes), so the
                                  // payload must fan back to the mrqId, not the
                                  // item id — planItemId alone would merge the
                                  // two rows into one allocation and leave the
                                  // second requirement uncredited for ever.
                                  mrqId: String(d.mrqId || ''),
                                  // THE CUT SIZE FOR THIS LINE, carried through
                                  // to the payload so issueMaterials stamps
                                  // Cut_Size_* per Issue_Line. The SKU entry has
                                  // no single cut any more, so every consumer of
                                  // a lot line reads it from here.
                                  cutW: Number(d.cutW) || 0, cutL: Number(d.cutL) || 0,
                                  // Which rolls this line cut, metres off each —
                                  // the fan decrements these. `pieces` kept as an
                                  // empty array so older readers don't throw.
                                  rolls: lnRolls, pieces: [], cutSummary: cSumm,
                                  fromRaw: fill.fromFresh[i], fromWaste: fill.fromWaste[i],
                                  note: noteOn, overrideFrom: fromOn });
            }
            // CREDIT THE OFFCUT PIECES TO THIS DEMAND'S CUT. The write-back
            // needs the remnant coverage per cut size to work out how much
            // fresh cloth each cut still needs.
            if (fill.fromWaste[i] > 0) {
                var wk = (Number(d.cutW) || 0) + 'x' + (Number(d.cutL) || 0);
                r.wasteByCut[wk] = (r.wasteByCut[wk] || 0) + fill.fromWaste[i];
            }
            // KEYED BY REMNANT **AND** REQUIREMENT ROW.
            //
            // One remnant can yield cuts for two requirement rows — two items of
            // an order, OR one item at two cut sizes — and keying on the remnant
            // alone stamped the whole yield with whichever row reached it first.
            // The server then credits that row only, the other silently draws
            // fresh cloth instead, and the offcut it was supposed to use sits on
            // the rack marked spent. Keyed on mrqId (not planItemId) so the two
            // cut sizes of one item stay apart and each is stamped with its own
            // cut for the Waste_Movement record.
            //
            // Two claims off one remnant therefore show as two rows. They are not
            // the duplicate rows the cutting dialog merges away — those were the
            // same piece described twice, these are genuinely different claims.
            Object.keys(fill.picksPer[i]).forEach(function (wid) {
                var k = wid + '|' + (d.mrqId || d.planItemId);
                if (!r.picks[k]) {
                    var src = lot.waste.filter(function (x) { return String(x.wasteId) === String(wid); })[0] || {};
                    // THE LOT ID, NOT JUST ITS NUMBER. A remnant carries the tone
                    // of the lot it was cut from, so a pick IS a tone decision —
                    // and on an order covered ENTIRELY by offcuts it is the only
                    // record of one, because no fresh metres means no lotLine and
                    // the payload's `issuedLot` came only from lotLines. That
                    // order shipped with no pin at all, and its remake was then
                    // free to be cut off any lot on the rack: the exact defect the
                    // pin exists to prevent, reached by the one path where the
                    // tone was never written down. `lot` (the NUMBER) stays for
                    // display; the id is what the payload stamps.
                    r.picks[k] = { wasteId: wid, pieces: 0, width: src.width, length: src.length,
                                   lotId: String(lot.lotId), lot: lot.lotNumber, carton: src.carton,
                                   planItemId: d.planItemId, mrqId: String(d.mrqId || ''),
                                   cutW: Number(d.cutW) || 0, cutL: Number(d.cutL) || 0 };
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

        // THE ROLLS COME OFF THE RACK TOO, in BOTH the ledger and the working
        // `lot.rolls`, for exactly the reason the metres and remnants do: the
        // working lot is what the NEXT order on this card is measured against.
        // Without this, two orders both see a roll at full length and each is
        // offered its metres — the double-promise. The per-roll metres are what
        // THIS fill placed (`rollLinesPer`), summed across every demand it
        // served.
        //
        // On a COMMITMENT (`emit` false) the rolls still drain: the order has
        // spoken for that physical cloth even though nothing goes out today.
        // Rolls drain even on commitment — the order has spoken for that cloth.
        var rollTook = {};
        (fill.rollLinesPer || []).forEach(function (perDemand) {
            (perDemand || []).forEach(function (rl) {
                var fk = String(materialId) + '|' + String(lot.lotId) + '|' + String(rl.rollId);
                rollTook[fk] = round2((rollTook[fk] || 0) + (Number(rl.metres) || 0));
            });
        });
        Object.keys(rollTook).forEach(function (fk) {
            rollLeft[fk] = round2(Math.max(0, (rollLeft[fk] !== undefined ? rollLeft[fk] : 0) - rollTook[fk]));
            var rid = fk.split('|').pop();
            (lot.rolls || []).forEach(function (rr) {
                if (String(rr.rollId) === String(rid)) {
                    rr.length = round2(Math.max(0, (Number(rr.length) || 0) - rollTook[fk]));
                }
            });
        });
    };

    orderSeq.forEach(function (oid) {
        var ord = byOrder[oid];
        ord.demands.forEach(function (d) {
            res[d.rowIdx].owed += d.pieces;
            // Per cut size too, so the write-back can size fresh cloth per cut.
            var ok = (Number(d.cutW) || 0) + 'x' + (Number(d.cutL) || 0);
            res[d.rowIdx].owedByCut[ok] = (res[d.rowIdx].owedByCut[ok] || 0) + d.pieces;
        });

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
        var canServe = function (l) {
            if (!l || l.blocked) return false;
            var trial = lotFill(l, ord.demands, fab, true);
            return trial.freshMetres > 0 || Object.keys(trial.picks).length > 0 ||
                   (Number(l.inWash) || 0) > 0;
        };
        var pinUsable = !!(ord.pin && pinnedLot) && canServe(pinnedLot);

        if (ord.pin && !pinUsable) {
            // AN OVERRIDE APPLIES ONLY HERE, and it is HELD TO THE SAME TEST THE
            // PIN JUST FAILED. Checked against the live rack every time rather
            // than remembered as a decision: if the original lot has since been
            // restocked the order belongs back on it, and a remembered override
            // would quietly keep it on the substitute.
            //
            // IT MUST BE RE-VALIDATED, and this is where quarantined cloth went
            // out. The pin path refuses a blocked lot (`pinBlocked` above) and the
            // dialog only ever offers `usableLots`, which excludes them — but the
            // override is remembered across fetches, and a lot BLOCKED AFTER he
            // chose it went straight through: `ord.pin` was overwritten with no
            // check and the lookup below has none either, so the row read as fully
            // served off quarantined cloth with no reason line at all.
            //
            // An override naming a lot that is missing, blocked or itself dry is
            // REFUSED rather than half-applied, and the row falls back to
            // pinnedDry — which is what keeps the "Use another lot…" button on
            // screen so he can choose again. Silently accepting a dry substitute
            // would take the button away and leave him with a row that cannot
            // move and no way to say so.
            var ov = lotOverrideFor(sup.supervisorId, materialId, ord.oid);
            var ovLot = null, ovNamed = '';
            if (ov && ov.lotId) {
                lots.forEach(function (l) {
                    if (String(l.lotId) !== String(ov.lotId)) return;
                    ovNamed = String(l.lotNumber || l.lotId);
                    if (canServe(l)) ovLot = l;
                });
            }

            if (ovLot) {
                ord.pin = String(ovLot.lotId);
                ord.note = String(ov.note || '');
                // AND HE CAN STILL CHANGE HIS MIND. The order is being served off
                // the substitute, so it is no longer `pinnedDry` and the reason
                // line has rightly stopped saying it is — but that line was also
                // the only way back into the dialog. Without this, accepting an
                // override that only part-covers is a one-way door: the row shows
                // how short it is and offers nothing to do about it.
                //
                // The orders are what the dialog writes overrides for, so they
                // have to be carried whether or not the pin is dry.
                ord.demands.forEach(function (d) {
                    var rr = res[d.rowIdx];
                    if (rr.pinnedDryOrders.indexOf(ord.oid) === -1) {
                        rr.pinnedDryOrders.push(ord.oid);
                    }
                    rr.overrideOn = true;
                });
            } else {
                // ONE ROW CAN CARRY TWO DEAD ORDERS, each pinned to a different
                // spent lot. Collected rather than assigned, because the last
                // write used to win: the row named one lot while the other order
                // had been cut from a different one, and the override then
                // rescued only the order that happened to be processed last.
                //
                // Recorded HERE and not before the override is read, or a
                // substitute that was accepted but only part-covers the order
                // still printed "L D is empty — this was cut from L D" and
                // offered the override button again. He is told to make a
                // decision he has already made, about a lot the order is no
                // longer on.
                ord.demands.forEach(function (d) {
                    var rr = res[d.rowIdx];
                    var name = ord.pinNo || ord.pin;
                    if (rr.pinnedDryLots.indexOf(name) === -1) rr.pinnedDryLots.push(name);
                    if (rr.pinnedDryOrders.indexOf(ord.oid) === -1) rr.pinnedDryOrders.push(ord.oid);
                    // "L2 is empty" over a full but quarantined lot sends him to
                    // the rack to check, and he finds cloth. Different sentence,
                    // same override.
                    if (pinBlocked) rr.pinnedBlocked = true;
                    // HIS OWN CHOICE WAS REFUSED, and saying nothing about it is
                    // how the same lot gets picked again. Named so the row can
                    // say which, instead of re-offering the dialog as if he had
                    // never opened it.
                    if (ovNamed) rr.overrideRefused = ovNamed;
                });
                // Allocate NOTHING — the row shows what it needs and why it
                // cannot have it, and he decides.
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

            // CLOTH AT THE WASH HOUSE THAT WOULD FINISH THIS ORDER.
            //
            // The only fact about a skipped order that shortReasonFor cannot work
            // out for itself, because it needs the DEMANDS to ask whether the
            // returning wash would actually cover the job — and it is handed the
            // row, not the orders on it. Everything else about a refusal is
            // readable off the lots, and is read there, so there is one place
            // that decides what the row says rather than two that must agree.
            //
            // Without this the `atWash` reason ("it is at the washer, wait") was
            // unreachable for an unpinned order however plainly true it was: the
            // wash gate rightly excludes inWash, so the order never reached a lot
            // at all, `lotsUsed` stayed empty, and the row quoted a roll instead.
            var wait = [];
            lots.forEach(function (l) {
                if (l.blocked) return;
                if ((Number(l.inWash) || 0) > 0 &&
                    lotFill(l, ord.demands, fab, true, true).covers) {
                    wait.push({ lotId: String(l.lotId), lotNumber: l.lotNumber,
                                qty: round2(Number(l.inWash) || 0) });
                }
            });

            ord.demands.forEach(function (d) {
                var rr = res[d.rowIdx];
                if (rr.noFitSmallest === 0 || want < rr.noFitSmallest) {
                    rr.noFitSmallest = want;
                }
                wait.forEach(function (w) {
                    var had = false;
                    rr.atWashLots.forEach(function (x) {
                        if (String(x.lotId) === String(w.lotId)) had = true;
                    });
                    if (!had) rr.atWashLots.push(w);
                });
            });
            outcomes.push({
                planId: ord.oid, why: 'skipped', lotId: '', lotNumber: '',
                pieces: ord.demands.reduce(function (a, d) { return a + d.pieces; }, 0),
                needMetres: want, metres: 0, wastePieces: 0, greige: 0,
                pin: ord.pin ? String(ord.pinNo || ord.pin) : '', override: '',
                // PER CUT SIZE. An order spans as many marker layouts as it has
                // distinct cut sizes — a bulk order can carry a hundred of
                // them, from tiny trims to large panels — and the shortfall
                // summary's metres conversion needs each one's own width/length
                // to round up to whole marker rows correctly. Reducing to one
                // aggregate piece count and guessing a single cut size for all
                // of them (the plan's first line) understated how many marker
                // rows small cuts actually need and overstated it for large
                // ones, whichever cut happened to be read first.
                cuts: ord.demands.map(function (d) {
                    return { cutW: Number(d.cutW) || 0, cutL: Number(d.cutL) || 0,
                             pieces: Number(d.pieces) || 0 };
                })
            });
            if (DEBUG) {
                debugSkips.push({
                    order: ord.oid,
                    neededMetres: round2(want),
                    pin: ord.pin ? String(ord.pinNo || ord.pin) : '',
                    cuts: ord.demands.map(function (d) {
                        return { cutW: Number(d.cutW) || 0, cutL: Number(d.cutL) || 0,
                                 pieces: Number(d.pieces) || 0 };
                    })
                });
            }
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

            // THE LOT IS THERE AND IT IS NOT ENOUGH.
            //
            // Only a PINNED order can reach this: an unpinned one is served by a
            // lot that covers it whole or is skipped, so its fill is never short.
            // A pinned order takes whatever its lot can give, and when that is
            // less than the job there was no reason for it at all — the row fell
            // past every named case to `empty`, "none of this shade left",
            // printed while a hundred metres of ANOTHER shade sat on the rack.
            //
            // Ranked below `wash` and `atWash` in shortReasonFor, so when the
            // same lot has greige or cloth at the washer he is told the thing he
            // can act on instead of a number he cannot.
            //
            // PER DEMAND, NOT PER ROW. `shortBy` is the ORDER's total, and one
            // order can span two rows of the same material — a Plan row and a
            // Reissue row for the same plan. Stamping the order total on each of
            // them reported a 38-piece shortfall twice, so the screen said 76 over
            // an order that is 38 short. Each demand carries its own share, and a
            // row holding two cut sizes of the order rightly sums both of them.
            // PER-DEMAND SHORTFALL, captured regardless of shortBy so the
            // outcome pushed below can carry each cut size's own remaining
            // pieces — same reasoning as the skipped-order cuts[] above: one
            // aggregate figure and a single guessed cut size understates small
            // cuts and overstates large ones when an order spans several.
            var shortByDemand = ord.demands.map(function (d, i) {
                return Math.max(0, (Number(d.pieces) || 0) -
                    (Number(useFill.fromWaste[i]) || 0) -
                    (Number(useFill.fromFresh[i]) || 0));
            });
            if (useFill.shortBy > 0) {
                ord.demands.forEach(function (d, i) {
                    var shortHere = shortByDemand[i];
                    if (shortHere <= 0) return;
                    var rs = res[d.rowIdx];
                    var hit = null;
                    rs.pinnedShortLots.forEach(function (x) {
                        if (String(x.lotId) === String(lot.lotId)) hit = x;
                    });
                    if (hit) hit.pieces += shortHere;
                    else rs.pinnedShortLots.push({ lotId: String(lot.lotId),
                                                   lotNumber: lot.lotNumber,
                                                   pieces: shortHere });
                });
            }

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
                    ? ord.note : '',
                // PER CUT SIZE, each with its own remaining shortfall — see the
                // comment on the skipped-order push above for why one
                // aggregate figure and a single cut size is not enough.
                cuts: ord.demands.map(function (d, i) {
                    return { cutW: Number(d.cutW) || 0, cutL: Number(d.cutL) || 0,
                             shortPieces: shortByDemand[i] };
                })
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

    if (DEBUG && debugSkips.length) {
        console.group('[allocator] ' + (m0.material || materialId) +
            ' (' + (m0.sku || '') + ') — ' + debugSkips.length +
            ' order(s) could not be served');
        console.log('Rolls left (after this pass):');
        console.table(lots.reduce(function (out, l) {
            (l.rolls || []).forEach(function (rr) {
                out.push({ lot: l.lotNumber, roll: rr.label,
                           metresLeft: rr.length, status: rr.status });
            });
            if (!(l.rolls || []).length) {
                out.push({ lot: l.lotNumber, roll: '(none)', metresLeft: 0,
                           status: l.blocked ? 'Blocked' : '—' });
            }
            return out;
        }, []));
        console.log('Orders still waiting on this material:');
        console.table(debugSkips.map(function (s) {
            return { order: s.order, neededMetres: s.neededMetres,
                     pin: s.pin || '(unpinned)',
                     cuts: s.cuts.map(function (c) {
                         return c.cutW + 'x' + c.cutL + ' × ' + c.pieces + 'pc';
                     }).join(', ') };
        }));
        console.groupEnd();
    }

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
                                length: rk.length, lotId: String(rk.lotId || ''),
                                lot: rk.lot, carton: rk.carton,
                                planItemId: '', mrqId: '' });
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
        // WHAT THE ROW STILL NEEDS, SUMMED OVER EVERY CUT SIZE. A SKU row is one
        // line but its cloth is cut to several sizes, and metres are only
        // meaningful per cut length — so this walks m.cuts (the per-cut piece
        // counts the server sent) and adds each cut's whole-marker-row metres for
        // the pieces its offcuts did not cover.
        //
        // SAME TEST getStoreMaterialRequirements USES, per cut: reqPieces > 0 AND
        // a countable cut. A cut planned before Required_Pieces existed has a
        // good size and no pieces, so testing the size alone would read
        // "countable" and produce 0 — the row goes to "0 Mtr" and drops off the
        // shortfall summary. When NO cut is countable, fall back to the server's
        // whole-SKU metres estimate rather than quoting 0, which would make the
        // row vanish from the screen entirely.
        // THE UNION of every cut size this row knows about: the demands built
        // from m.lines (always complete, even when the SKU spans several server
        // pages) PLUS anything on m.cuts. m.cuts alone is NOT trusted — when a
        // supervisor's demand for this fabric is split across parallel pages,
        // mergeRequirementPages sums the lines but keeps only the first page's
        // m.cuts, so a cut size that first appeared on page 2 would be missing
        // and the headline would under-report. owedByCut is keyed off the merged
        // lines, so it always has every cut with outstanding pieces; m.cuts adds
        // the countability signal for a cut that is fully issued (owed 0).
        var cutMap = {};
        Object.keys(r.owedByCut).forEach(function (k) {
            var parts = k.split('x');
            cutMap[k] = { cutW: Number(parts[0]) || 0, cutL: Number(parts[1]) || 0,
                          reqPieces: r.owedByCut[k] || 0 };
        });
        (m.cuts || []).forEach(function (ck) {
            var key = (Number(ck.cutW) || 0) + 'x' + (Number(ck.cutL) || 0);
            if (!cutMap[key]) {
                cutMap[key] = { cutW: Number(ck.cutW) || 0, cutL: Number(ck.cutL) || 0,
                                reqPieces: Number(ck.reqPieces) || 0 };
            }
        });
        var cutList = Object.keys(cutMap).map(function (k) { return cutMap[k]; });
        var need = 0;
        var anyCountable = false;
        cutList.forEach(function (ck) {
            var cutW = Number(ck.cutW) || 0;
            var cl = Number(ck.cutL) || 0;
            var pr = perRowFor({ fabricWidthCm: m.fabricWidthCm }, cutW);
            if (!((Number(ck.reqPieces) || 0) > 0 && pr > 0 && cl > 0)) return;
            anyCountable = true;
            var key = cutW + 'x' + cl;
            var owedCut = r.owedByCut[key] || 0;
            var wasteCut = r.wasteByCut[key] || 0;
            var freshCut = Math.max(0, owedCut - wasteCut);
            if (freshCut > 0) {
                need = round2(need + (Math.ceil(freshCut / pr) * cl) / 100);
            }
        });
        if (!anyCountable) {
            // NO PIECE DATA TO COUNT WITH on any cut — rows planned before
            // Required_Pieces existed, a cut wider than the cloth, or a fabric
            // whose width was never recorded. Keep the server's metres estimate;
            // quoting 0 would make the row vanish from the screen.
            need = round2(Math.max(0, Number(m.freshMeters) || 0));
            r.noPieceData = true;
        }
        m.freshMeters = need;
        m.noPieceData = !!r.noPieceData;
        m.lotLines = r.lotLines;

        // "TO BE ISSUED" = WHAT ACTUALLY LEAVES THE ROLL: the sum of the per-lot
        // lines, which is exactly what the ISSUE NOW boxes total to.
        //
        // `need` above is the PLANNING estimate — it rounds each cut size up to
        // whole marker rows ONCE, as if every item sharing that cut were laid on
        // one continuous marker. The lot lines round up PER Plan_Item, because
        // each item is cut on its own lay and cannot share a part-row with
        // another. That difference is a handful of real part-rows and IS the
        // cloth he hands over — so on a fully-covered row the headline shows the
        // lot total, or "To be issued" and "Issue now" disagree for no reason he
        // can see.
        //
        // BUT the lot total is ONLY safe as the headline when it actually covers
        // the requirement. On a row committed to a lot that is mostly greige /
        // at the wash, `lotFill` emits only the washed metres — a fraction of
        // what is needed. Showing that fraction makes the gap read as zero and
        // the shortfall summary then raises no wash ticket at all (this exact
        // trap is why the old code always used `need` here). So: use the lot
        // total only when it is >= `need` (nothing is waiting on a wash);
        // otherwise keep `need`, which still drives the wash / purchase ticket.
        var lotTotal = round2((r.lotLines || []).reduce(function (t, ln) {
            return t + (Number(ln.qty) || 0);
        }, 0));
        m.remaining = (r.lotLines && r.lotLines.length && lotTotal + 0.0001 >= need)
            ? lotTotal
            : need;
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
        // THE PRINTED/PLAIN LINK, NORMALISED ONTO EVERY ROW OF THE MATERIAL.
        //
        // It arrives on the payload rather than being worked out here — only the
        // server can follow Raw_Material.Print_Base — but every row of a material
        // has to carry it, and a server that predates the field has to read as
        // "not printed" rather than as undefined. shortReasonFor and the render
        // both go through these three and nothing else.
        m.printBase = String(m0.printBase || '');
        m.printBaseName = String(m0.printBaseName || '');
        m.printBaseLots = m0.printBaseLots || [];
        m.shortReason = shortReasonFor(m, r, lots);
        // The auto figure, kept so the store screen can show "auto: X" beside a
        // box he has hand-edited and applyFabricOverride can be undone back to it.
        // Set here, once, from the allocation — never touched again.
        m.autoMetres = round2((m.lotLines || []).reduce(function (t, ln) {
            return t + (Number(ln.qty) || 0);
        }, 0));
        m.autoLotLines = JSON.parse(JSON.stringify(m.lotLines || []));
        m.autoRemaining = round2(Number(m.remaining) || 0);
        m.metresEdited = false;
    });
}

// ---- Hand-edited fabric metres, PER LOT ----
//
// The store person is allowed to cut MORE or LESS than the allocator worked out
// (a ruined marker row, an order he knows changed, cloth he wants to send spare).
// Each lot sub-line on the SKU row has its own box; the submit path reads ONLY
// `m.lotLines` — never the boxes — so an edit has to be pushed back onto the
// lines for THAT lot here or it does nothing.
//
// SCOPE IS ONE LOT. He is changing how much comes off one roll; every other lot
// on the row is untouched. The tone decision (which lot serves which order) is
// the allocator's and the pin's and a metres edit must never move it.
//
// FULFILMENT IS STILL COUNTED IN WHOLE CUT ROWS, and this is the load-bearing
// part. `giveRaw` / `Pieces_From_Raw` is what receiveMaterials and the store
// screen read to decide a fabric row is done — NOT the metres. Per line, using
// THAT LINE'S OWN cut size (a SKU row spans several):
//
//   rows      = floor(lineMetres / cutLength_line)  -- a part-cut row is 0, it is
//                                                      the damaged one
//   fromRaw   = min(rows * perRow_line, owed - fromWaste)
//
// A short edit therefore leaves the requirement OPEN for the rows he did not
// cut — next Issue re-covers them off the same lot. It is never
// `required - issued` metres.
//
// OVER-ISSUE rides the handover. Surplus metres above the recommendation are
// added to the largest line on that lot (so lotMoves charges the roll for the
// cloth that physically leaves) but `fromRaw` is still capped at `owed` — the
// extra comes back as an offcut the supervisor declares through the normal waste
// flow, not something issueMaterials records.
//
// Metres he types that are not a whole number of rows are sent AS TYPED (the lot
// is charged the real figure) and the stray part-row counts 0 pieces.
//
// PURE, like the rest of this file: mutates `m` and returns nothing. Called only
// from the store screen's oninput — the admin audit never runs it.
function applyFabricOverride(m, lotId, editedMetres) {
    if (!m || !m.isFabric) return;
    var base = m.autoLotLines || [];
    if (base.length === 0) return;
    var lotKey = String(lotId);

    var thisLotBase = base.filter(function (ln) { return String(ln.lotId) === lotKey; });
    if (thisLotBase.length === 0) return;

    var otherLines = (m.lotLines || []).filter(function (ln) {
        return String(ln.lotId) !== lotKey;
    });

    var autoThisLot = round2(thisLotBase.reduce(function (t, ln) {
        return t + (Number(ln.qty) || 0);
    }, 0));

    m.metresEditByLot = m.metresEditByLot || {};
    if (m.lotEditShort) delete m.lotEditShort[lotKey];

    // GIVE BACK WHAT THIS ROW IS CURRENTLY HOLDING BEYOND ITS AUTO FIGURE, on
    // this lot's rolls, before a single ceiling is worked out.
    //
    // `rollFree` is shared by every row of the material and is the live count of
    // what nobody has claimed. This function runs on EVERY KEYSTROKE, so charging
    // the new figure without first releasing the old one would ratchet the
    // ledger down as he types — 20, then 19, then 18 would each take metres
    // again and the roll would read as spent after four digits.
    //
    // Releasing first also makes the row's own cap come out right: the ceiling is
    // (what nobody else has claimed) + (this row's own auto), and this row's own
    // extra must not be counted in the first term as well as the second.
    var freeById = m.rollFree || null;
    var deltaById = m.rollDelta || null;
    if (freeById && deltaById) {
        Object.keys(deltaById).forEach(function (dk) {
            if (dk.indexOf(lotKey + '|') !== 0) return;
            freeById[dk] = round2((freeById[dk] || 0) + deltaById[dk]);
            delete deltaById[dk];
        });
    }

    // Back to exactly what the allocator decided for this lot — and FORGET the
    // edit, so re-running the allocation puts nothing back. The checkbox and
    // select-all both come through here with the auto figure, so "untouched"
    // and "put back" end in the same state, which is the point.
    var want = Math.max(0, Number(editedMetres) || 0);
    if (Math.abs(want - autoThisLot) < 0.005) {
        delete m.metresEditByLot[lotKey];
        var restored = JSON.parse(JSON.stringify(thisLotBase));
        m.lotLines = otherLines.concat(restored);
        recomputeMetresEdited(m);
        setOverrideRemaining(m);
        return;
    }
    m.metresEditByLot[lotKey] = want;

    // ---- THE ROLL BREAKDOWN THE ALLOCATOR PRODUCED, in DRAIN ORDER ----
    //
    // The allocation drained shortest-roll-first. `autoRolls` is that sequence
    // for this lot — { rollId, label, autoMetres (what the fill took),
    // cap (the roll's physical length from the payload) } — first entry is the
    // roll drained first, last is the most recently used.
    // THE CEILING IS WHAT IS STILL FREE ON THE ROLL, NOT ITS PRINTED LENGTH.
    //
    // `m.lots` is the raw server payload and the allocator never mutates it, so a
    // roll reads there at the length it had before ANY card cut it. Clamping an
    // edit-up against that let two supervisors' rows each be extended into the
    // same metres — 5 m + 20 m off one 20 m roll, both lines naming it, and
    // nothing on either screen saying so.
    //
    // `m.rollFree` is what no card has claimed once the whole pass has run
    // (allocateEveryCard writes it). The ceiling for THIS row is that plus what
    // this row's own lines already hold on the roll, which is added below — it is
    // his cloth to re-spread, and subtracting it would forbid him his own metres.
    //
    // Falls back to the printed length when `rollFree` is absent, which is the
    // old behaviour, for the admin audit and any payload that predates the field.
    var capById = {};
    (m.lots || []).forEach(function (l) {
        if (String(l.lotId) !== lotKey) return;
        (l.rolls || []).forEach(function (rr) {
            capById[String(rr.rollId)] = round2(Number(rr.length) || 0);
        });
    });
    var autoRolls = [];
    var seenRoll = {};
    thisLotBase.forEach(function (ln) {
        (ln.rolls || []).forEach(function (rl) {
            var rid = String(rl.rollId);
            if (seenRoll[rid]) {
                // Two lines of this lot cutting the same roll. Both halves are
                // his, so both count towards what he may re-spread.
                seenRoll[rid].autoMetres = round2(seenRoll[rid].autoMetres + (Number(rl.metres) || 0));
                if (freeById && freeById[lotKey + '|' + rid] !== undefined) {
                    seenRoll[rid].cap = round2(seenRoll[rid].cap + (Number(rl.metres) || 0));
                }
            } else {
                var mine = round2(Number(rl.metres) || 0);
                var fk = lotKey + '|' + rid;
                var cap = (freeById && freeById[fk] !== undefined)
                    ? round2(freeById[fk] + mine)
                    : (capById[rid] !== undefined ? capById[rid] : mine);
                var e = { rollId: rid, label: String(rl.label || ''),
                          autoMetres: mine, cap: cap };
                seenRoll[rid] = e;
                autoRolls.push(e);
            }
        });
    });

    // ---- RE-SPREAD `want` ACROSS THE ROLLS ----
    //
    // EDIT DOWN: unwind the drain newest-roll-first. Keep the earlier rolls at
    //   their auto figure and take the shortfall off the last, then the
    //   second-last, and so on. A roll driven to 0 drops out of the breakdown.
    // EDIT UP: extend ONLY the last used roll, clamped at its physical cap. No
    //   spill onto a fresh, previously-unused roll — a hand-edit does not open a
    //   new roll.
    var rollAlloc = [];   // { rollId, label, metres } in drain order, >0 only
    if (autoRolls.length === 0) {
        // No roll breakdown on the auto lines (shouldn't happen post-migration).
        // Fall back to a single synthetic line carrying just the metres.
        rollAlloc = [];
    } else if (want >= autoThisLot) {
        // extend the last roll only
        var extra = round2(want - autoThisLot);
        autoRolls.forEach(function (e, i) {
            var mtr = e.autoMetres;
            if (i === autoRolls.length - 1) {
                mtr = round2(Math.min(e.cap, e.autoMetres + extra));
            }
            if (mtr > 0) rollAlloc.push({ rollId: e.rollId, label: e.label, metres: mtr });
        });
    } else {
        // EDIT DOWN — unwind the drain NEWEST-roll-first. The rolls drained
        // earliest keep their auto figure; the shortfall comes off the LAST
        // roll used, then the second-last. So fill FORWARD through drain order,
        // each roll taking min(its auto, what is left of `want`) — the early
        // rolls fill up first and the last roll absorbs the reduction. A roll
        // that ends at 0 drops out of the breakdown.
        var need = round2(want);
        autoRolls.forEach(function (e) {
            if (need <= 0.0001) return;
            var g = round2(Math.min(e.autoMetres, need));
            need = round2(need - g);
            if (g > 0) rollAlloc.push({ rollId: e.rollId, label: e.label, metres: g });
        });
    }

    var placedMetres = round2(rollAlloc.reduce(function (t, r) { return t + r.metres; }, 0));

    // CHARGE THE NEW CLAIM TO THE SHARED LEDGER, so the NEXT row of this material
    // — on this card or another — is measured against what is genuinely left.
    // Signed, so an edit DOWN hands metres back and another row can use them.
    if (freeById && deltaById) {
        var placedBy = {};
        rollAlloc.forEach(function (r) {
            placedBy[String(r.rollId)] = round2((placedBy[String(r.rollId)] || 0) + r.metres);
        });
        autoRolls.forEach(function (e) {
            var fk2 = lotKey + '|' + e.rollId;
            var dlt = round2((placedBy[e.rollId] || 0) - e.autoMetres);
            if (dlt !== 0) deltaById[fk2] = dlt;
            freeById[fk2] = round2(Math.max(0, (freeById[fk2] || 0) - dlt));
        });
    }

    // WHAT HE ASKED FOR AND COULD NOT HAVE, RECORDED RATHER THAN SWALLOWED.
    //
    // An edit-up beyond the free length of the last roll used is clamped, and the
    // clamp was invisible: the keystroke path deliberately does not repaint the
    // box he is typing in (it would eat the caret), so he typed 50 against an
    // 11 m ceiling, the payload carried 5 and the box went on reading 50. The
    // screen has to say so somewhere, and the LOT column is repainted on every
    // keystroke — so the note goes there, beside the roll it could not come off.
    if (placedMetres + 0.005 < want) {
        m.lotEditShort = m.lotEditShort || {};
        m.lotEditShort[lotKey] = { typed: round2(want), placed: placedMetres };
    }

    // ---- REBUILD THIS LOT'S LINES ----
    //
    // A SKU row can take two cut sizes off one lot, so `placedMetres` has to be
    // split between that lot's lines — and the split is IN WHOLE MARKER ROWS,
    // because a part-row is not a cut piece.
    //
    // Splitting by metres alone and flooring each line afterwards LOSES A ROW PER
    // LINE to the remainder. Two 5 m lines of a 1 m cut, typed down to 9 m,
    // became 4.5 + 4.5 -> floor -> four rows each: EIGHT pieces credited for NINE
    // metres of cloth. The ninth metre went out with nothing booking it and the
    // requirement stayed open for a piece that had physically been cut — the
    // silent-loss shape CLAUDE.md records, one lay at a time.
    //
    // So the proportional split is the STARTING POINT only. Each line takes as
    // many whole rows as its share affords; the metres left over are then handed
    // out A WHOLE ROW AT A TIME, largest share first, to lines that still have
    // pieces owing. Only what remains after that — genuinely less than one row of
    // any line — rides on the biggest line, which is the rule this function has
    // always applied: metres that are not a whole number of rows are sent as
    // typed and the stray part-row counts 0 pieces.
    var owedBy = {}, wasteBy = {};
    (m.lines || []).forEach(function (ln) {
        var q = String(ln.mrqId || ln.planItemId || '');
        if (q && owedBy[q] === undefined) {
            owedBy[q] = Math.max(0, (Number(ln.reqPieces) || 0) - (Number(ln.issPieces) || 0));
        }
    });
    (base || []).forEach(function (ln) {
        var q = String(ln.mrqId || ln.planItemId || '');
        wasteBy[q] = (wasteBy[q] || 0) + (Number(ln.fromWaste) || 0);
    });

    var rawTaken = {};
    otherLines.forEach(function (ln) {
        var q = String(ln.mrqId || ln.planItemId || '');
        rawTaken[q] = (rawTaken[q] || 0) + (Number(ln.fromRaw) || 0);
    });

    var lines = JSON.parse(JSON.stringify(thisLotBase));
    var autoSum = lines.reduce(function (t, ln) { return t + (Number(ln.qty) || 0); }, 0);
    if (autoSum <= 0) { autoSum = lines.length; lines.forEach(function (ln) { ln.qty = 1; }); }

    // Per line: the geometry, and how many whole rows it could still WANT. Rows
    // beyond that are surplus and are never handed out preferentially — surplus
    // rides on one line, as it always has.
    var geo = lines.map(function (ln) {
        var q = String(ln.mrqId || ln.planItemId || '');
        var cl = Number(ln.cutL) || 0;
        var perRow = perRowFor({ fabricWidthCm: m.fabricWidthCm }, Number(ln.cutW) || 0);
        var room = Math.max(0, (owedBy[q] === undefined ? 0 : owedBy[q]) -
                               (wasteBy[q] || 0) - (rawTaken[q] || 0));
        return { auto: Number(ln.qty) || 0, cutL: cl, perRow: perRow,
                 rowM: cl > 0 ? round2(cl / 100) : 0,
                 maxRows: (perRow > 0 && cl > 0) ? Math.ceil(room / perRow) : 0,
                 rows: 0 };
    });

    var left = placedMetres;
    geo.forEach(function (g) {
        if (g.rowM <= 0 || g.maxRows <= 0) return;
        var share = placedMetres * (g.auto / autoSum);
        var rws = Math.floor((share * 100 + 0.0001) / g.cutL);
        if (rws > g.maxRows) rws = g.maxRows;
        if (rws < 0) rws = 0;
        g.rows = rws;
        left = round2(left - rws * g.rowM);
    });

    // The remainder, a whole row at a time. Largest share first so the split
    // stays as close to proportional as whole rows allow, and round-robin rather
    // than filling one line to the top — an edit-down must not empty the smaller
    // cut entirely to keep the larger one whole.
    var byShare = geo.map(function (g, i) { return i; }).sort(function (a, b) {
        return geo[b].auto - geo[a].auto;
    });
    var moved = true;
    while (moved && left > 0.0001) {
        moved = false;
        for (var bi = 0; bi < byShare.length; bi++) {
            var g2 = geo[byShare[bi]];
            if (g2.rowM <= 0 || g2.rows >= g2.maxRows) continue;
            if (g2.rowM <= left + 0.0001) {
                g2.rows += 1;
                left = round2(left - g2.rowM);
                moved = true;
            }
        }
    }

    var biggest = 0;
    lines.forEach(function (ln, i) {
        ln.qty = round2(geo[i].rows * geo[i].rowM);
        if ((Number(ln.qty) || 0) > (Number(lines[biggest].qty) || 0)) biggest = i;
    });
    // NOTHING COULD TAKE A WHOLE ROW — a lot whose lines have no countable cut,
    // or an edit smaller than one row. Fall back to the old proportional spread
    // so the metres are still charged to the roll rather than silently dropped:
    // he is telling the screen how much cloth leaves the shelf, and that is true
    // whether or not it makes a cut piece.
    var spread = round2(lines.reduce(function (t, ln) { return t + (Number(ln.qty) || 0); }, 0));
    if (spread <= 0 && placedMetres > 0) {
        lines.forEach(function (ln, i) {
            ln.qty = round2(placedMetres * (geo[i].auto / autoSum));
            if ((Number(ln.qty) || 0) > (Number(lines[biggest].qty) || 0)) biggest = i;
        });
        spread = round2(lines.reduce(function (t, ln) { return t + (Number(ln.qty) || 0); }, 0));
    }
    lines[biggest].qty = round2((Number(lines[biggest].qty) || 0) + round2(placedMetres - spread));
    if ((Number(lines[biggest].qty) || 0) < 0) lines[biggest].qty = 0;

    lines.forEach(function (ln) {
        var q = String(ln.mrqId || ln.planItemId || '');
        var perRow = perRowFor({ fabricWidthCm: m.fabricWidthCm }, Number(ln.cutW) || 0);
        var rows = (Number(ln.cutL) || 0) > 0 ? Math.floor((Number(ln.qty) * 100 + 0.0001) / Number(ln.cutL)) : 0;
        var gross = rows * perRow;
        var owed = owedBy[q] === undefined ? gross : owedBy[q];
        var wasteCredit = wasteBy[q] || 0;
        var already = rawTaken[q] || 0;
        var room = Math.max(0, owed - wasteCredit - already);
        var give = Math.min(gross, room);
        rawTaken[q] = already + give;
        ln.fromRaw = give;
        // fromWaste is the physical-pick credit and is not a function of metres.
        // The roll breakdown is the LOT's — every line of this lot carries it,
        // so the handover payload's qty and rolls[] cannot disagree.
        //
        // `rollsShared` marks that: EVERY line of this lot now carries the
        // SAME array, byte for byte. A display reading `.rolls` across several
        // lines of one lot has to know that — the ordinary (unedited) case has
        // each line carry only the rolls IT cut, and several lines of one lot
        // genuinely sharing a roll (a big roll serving many separate orders)
        // must be SUMMED to get the roll's true total draw. Once this stamp is
        // in force that sum would be wrong: it would count the same breakdown
        // once per line instead of once for the lot. See `rollsByLot` in
        // main.js, which reads this flag to tell the two cases apart.
        ln.rollsShared = true;
        ln.rolls = rollAlloc.map(function (r) {
            return { rollId: r.rollId, label: r.label, metres: r.metres };
        });
        ln.cutSummary = rollAlloc.length > 1
            ? 'Rolls: ' + rollAlloc.map(function (r) {
                  return r.label + ' ' + round2(r.metres) + 'm';
              }).join(', ')
            : '';
    });

    m.lotLines = otherLines.concat(lines);
    recomputeMetresEdited(m);
    setOverrideRemaining(m);
}

// `remaining` STAYS the true outstanding need — it caps the box max, feeds
// maxIssuable and drives the shortfall summary. A short edit must not shrink it
// (the uncut rows are still owed) and an over-edit must not raise it (surplus is
// spare cloth, not a bigger requirement). So it is pinned to the auto figure.
function setOverrideRemaining(m) {
    var v = m.autoRemaining !== undefined
        ? m.autoRemaining
        : round2(Number(m.autoMetres) || 0);
    m.remaining = m.freshMeters = v;
}

// m.metresEdited is true when ANY lot line diverges from its auto value.
function recomputeMetresEdited(m) {
    var auto = {};
    (m.autoLotLines || []).forEach(function (ln, i) { auto[i] = ln; });
    var edited = false;
    var byKey = function (ln) {
        return String(ln.lotId) + '|' + String(ln.planItemId) + '|' +
               (ln.cutW || 0) + 'x' + (ln.cutL || 0);
    };
    var autoQ = {};
    (m.autoLotLines || []).forEach(function (ln) {
        autoQ[byKey(ln)] = (autoQ[byKey(ln)] || 0) + (Number(ln.qty) || 0);
    });
    var curQ = {};
    (m.lotLines || []).forEach(function (ln) {
        curQ[byKey(ln)] = (curQ[byKey(ln)] || 0) + (Number(ln.qty) || 0);
    });
    Object.keys(autoQ).forEach(function (k) {
        if (Math.abs((autoQ[k] || 0) - (curQ[k] || 0)) > 0.005) edited = true;
    });
    Object.keys(curQ).forEach(function (k) {
        if (autoQ[k] === undefined && (curQ[k] || 0) > 0.005) edited = true;
    });
    m.metresEdited = edited;
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
                 lot: r.pinnedDryLots.join(' and '),
                 // The substitute he already picked, when it was refused —
                 // missing, quarantined or dry itself. Without it the dialog
                 // reopens looking exactly as it did the first time and he has no
                 // way to know his answer did not take.
                 refused: r.overrideRefused || '' };
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
    // …AND THE ORDERS THAT WERE SKIPPED WAITING ON THE SAME CLOTH. Nothing was
    // committed, so they are not in `lotsUsed`; the skip path records them
    // separately, and only when that lot's returning wash would cover the job.
    (r.atWashLots || []).forEach(function (w) {
        if (!atWash) {
            atWash = { kind: 'atWash', lot: w.lotNumber, qty: round2(Number(w.qty) || 0) };
        }
    });
    if (atWash) return atWash;

    // NO PRINTED STOCK, AND PLAIN CLOTH SITTING THERE TO PRINT IT FROM.
    //
    // Ranked below the pinned and wash cases on purpose. Those are about cloth
    // that already exists in this shade and is about to become available — a
    // wash comes back in days, a print run does not — so telling him to go and
    // print when the answer is "wash L2" would send him the long way round.
    //
    // Ranked ABOVE nofit / blocked / nolots / empty because those all describe a
    // rack that has this material on it, and this one describes a rack that has
    // none: "None of this shade left" over a hundred metres of the plain cloth it
    // is printed from is true, useless, and the exact silent state the row exists
    // to kill.
    //
    // BOTH HALVES ARE REQUIRED. No printed stock at all — anything on any lot,
    // greige and quarantined included, means there IS printed stock and one of
    // the reasons below is the honest one. And plain cloth actually there to
    // print: a printed row with nothing behind it falls straight through to the
    // generic reasons, because "print more" is not an action he can take.
    if (!hasOwnStock(m)) {
        var base = plainBaseStock(m);
        if (base) {
            return { kind: 'noPrinted', baseId: base.id, base: base.name,
                     lots: base.lots };
        }
    }

    // Cloth on the rack that no single job fits inside. SAY THE NUMBERS: he is
    // looking at a rack with cloth on it, and "no lot holds enough" is true and
    // unusable. What he can act on is the LONGEST SINGLE ROLL — a lot with two
    // 10 m rolls holds 20 m but cannot cut a 12 m marker, and "L2 has 20 m"
    // reads as a bug. Report the longest roll of the lot with the longest roll,
    // against the smallest job.
    // THE SHADE IS ON THE RACK AND THERE IS NOT ENOUGH OF IT. Nothing to wash,
    // nothing at the washer, no substitute to offer — the order is cut in this
    // tone and the tone has run low, so the only honest next step is more cloth.
    // Ranked here because everything above it is an action he can take today.
    if ((r.pinnedShortLots || []).length > 0) {
        return { kind: 'pinnedShort',
                 lots: r.pinnedShortLots.map(function (x) {
                     return { lotNumber: x.lotNumber, pieces: x.pieces };
                 }),
                 // OFFERED ONLY WHERE ONE IS ALREADY IN FORCE. On an ordinary
                 // pinned row it would erode the pin by being easier than asking
                 // why — the whole value of the pin is that breaking it is a
                 // decision somebody made and can be asked about. Here the
                 // decision has already been made, and this only lets him revise
                 // it.
                 canOverride: !!r.overrideOn };
    }

    // Cloth on the rack that no single job fits inside. SAY THE NUMBERS: he is
    // looking at a rack with cloth on it, and "no lot holds enough" is true and
    // unusable.
    //
    // `noFitBest` is recorded WHERE THE ORDER WAS REFUSED and is the longest
    // CUTTABLE length — the longest single roll capped by that lot's washed
    // metres. The scan that used to live here read the rolls alone, so it quoted
    // physical cloth the wash gate had already refused: 100 m on a lot with 5 m
    // washed, "smallest job needs 10". When nothing was cuttable there is no
    // honest sentence of this shape and the row falls through instead.
    // What he can act on is the LONGEST SINGLE ROLL — a lot with two 10 m rolls
    // holds 20 m but cannot cut a 12 m marker, and "L2 has 20 m" reads as a bug.
    //
    // CAPPED BY WHAT THE LOT MAY ACTUALLY SPEND, which the old scan did not do.
    // `covers` is false for two quite different reasons and reading the rolls
    // alone could only see one of them: a roll too short to take the marker, or
    // the WASH GATE. A lot holding 5 washed metres on a 100 m roll printed
    // "100 Mtr on L1, smallest job needs 10" — and that state is ROUTINE, not an
    // edge, because issuing moves Wash_Quantity while nothing yet decrements
    // Roll_Length, so the two drift apart on every handover.
    //
    // The cap is wash + unwash, the widest gate any allocation tried, so a lot
    // left holding only greige still gets a truthful sentence. Cloth at the WASH
    // HOUSE is excluded: it has its own reason, ranked above this one, and that
    // is the true answer whenever it applies. When nothing is cuttable there is
    // no honest sentence of this shape and the row falls through instead.
    if (r.noFitSmallest > 0) {
        var big = null;
        lots.forEach(function (l) {
            if (l.blocked) return;
            var longest = 0;
            (l.rolls || []).forEach(function (rr) {
                if (!rollUsable(rr)) return;
                var len = round2(Number(rr.length) || 0);
                if (len > longest) longest = len;
            });
            var cuttable = round2(Math.min(longest,
                round2((Number(l.wash) || 0) + (Number(l.unwash) || 0))));
            if (cuttable > 0 && (big === null || cuttable > big.qty)) {
                big = { lotNumber: l.lotNumber, qty: cuttable };
            }
        });
        if (big) {
            // `short` is what THIS ROW is still missing, the same figure the
            // top of this function used to decide the row is short at all —
            // carried through so the screen can say "issuing most of it today,
            // still short N" instead of leaving him to read a lot box showing
            // real progress right next to a warning and work out for himself
            // that they are both true at once.
            return { kind: 'nofit', lot: big.lotNumber, have: big.qty,
                     need: round2(r.noFitSmallest), short: round2(want - got) };
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
