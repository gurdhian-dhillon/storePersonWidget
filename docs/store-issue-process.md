# The Store Issue screen — how material is chosen and issued

This document explains, end to end, what happens when the store person opens the
**Issue** tab and presses **Issue** for a supervisor. It covers fabric lot
selection (every case), offcut (waste piece) selection, and printed-fabric
selection, with worked examples. The last section lists cases that are **not**
handled.

The logic lives in `app/js/lot-allocator.js` (the decision) and
`app/js/main.js` (the screen and the payload). The server function
`getStoreMaterialRequirements.dg` supplies the raw data; `issueMaterials.dg`
applies the result. Nothing here re-decides anything server-side.

---

## 1. Vocabulary (plain terms)

| Term | Meaning |
|---|---|
| **Lot** | One dye batch of a fabric. Every lot of the same fabric is a slightly different **shade**. A roll and its label. |
| **Shade / tone** | The colour of one lot. Two lots of "Dusty Gold" are both dusty gold but not *exactly* the same — visible if a customer sees two panels of one product side by side. |
| **Ready cloth** | Cloth on the lot that is **washed and can be cut and handed over today**. (`Wash_Quantity`.) |
| **Unwashed cloth** | Cloth on the lot that must be washed before it can be cut. Does **not** count as available today. (`Unwash_Quantity`.) |
| **Cloth at the wash house** | Cloth that has left for washing and is coming back **in this same shade**. Not issuable now, but the lot is not finished. (`In_Wash_Qty`.) |
| **Cut piece** | One panel cut to a fixed size, e.g. 55 cm × 90 cm. Fabric fulfilment is counted in **cut pieces**, never in metres. |
| **Marker row** | One row of cut pieces laid across the fabric width. If the fabric is 160 cm wide and the cut is 55 cm wide, `floor(160 / 55) = 2` pieces fit per row. Cloth only leaves the roll in **whole rows** — you cannot cut half a row. |
| **Offcut / remnant** | A leftover strip from an earlier cut, put back on the rack to be reused. It carries the **shade of the lot it was cut from**. |
| **Order (the atom)** | One production plan = one sales order. **An order is served whole from one lot, or not served at all.** This is the single most important rule on this screen — it protects the shade match within one customer's goods. |
| **Pin** | Once *any* cloth of an order has been cut from a lot, the rest of that order is **locked to that lot** (`Material_Requirement.Issued_Lot`). A remake for 3 ruined panels must match the 97 already cut. |
| **Requirement row** | One `Material_Requirement` record = one item's need for one material at one cut size. The screen groups many of these into one line per SKU. |

---

## 2. What the screen starts with (per fabric SKU, per supervisor)

The server sends, for each fabric SKU on a supervisor's card:

- **`lots[]`** — every lot of this fabric that has *anything* on it, each with:
  `wash` (ready), `unwash` (unwashed), `inWash` (at the wash house), `blocked`
  (quarantined), `form` (`Roll` or `Pieces`), `pieces[]` (for a Pieces lot),
  and `waste[]` (this lot's own offcuts).
- **`wasteStock[]`** — every reusable offcut of this fabric on the rack, each with
  its `lotId`, dimensions, count, and carton.
- **`cuts[]`** — the piece counts this SKU needs, summed per cut size.
- **`lines[]`** — one entry per requirement row (one per item), each with its
  `planId` (the order), `planItemId`, `cutW` / `cutL`, `reqPieces`, `issPieces`
  (already issued), and `issuedLot` (the pin, blank if nothing issued yet).

The **allocator never invents stock**. It only decides how to spend what is on
these lists.

---

## 3. Step 1 — group the demand by order

Every requirement line that still owes pieces is grouped by `planId`. One order
becomes one bundle of **demands** — one demand per `(planItemId, cutW, cutL)`.

Orders are then processed in **priority order**: highest-priority source first
(Shopify > Faire > Custom > PR > other), oldest plan first within a priority.
This order matters twice:

1. It is the order the supervisor **cards** render in.
2. It is the order **cloth is spent** in — if two supervisors want the same lot,
   the higher-priority one gets it, and the lower-priority one sees what is left.

---

## 4. Step 2 — read the pin

Before any lot is chosen, the allocator reads `issuedLot` from **every** line of
the order, *including lines that owe nothing*.

Why include settled lines: in the ordinary remake, the original 100 pieces are
finished and settled, 3 get ruined, and the remake arrives as a **new**
`Plan_Item` owing 3. The only record of which lot the original 97 came from is
the **settled** line. Miss it and the remake goes to whatever lot is smallest —
3 replacement panels in a different shade to the 97 they sit beside. That is the
exact defect the pin exists to prevent.

- **Pin found** → this order has no lot choice. It goes to that lot and takes
  whatever it can give (see §5, "pinned" cases).
- **No pin** → the order is free to choose a lot (§5, "unpinned" cases).

---

## 5. Step 3 — choose a lot for the order

### 5.0 The rule

> **An order is served whole off ONE lot, or not served at all.**
> A lot that can take half of it is the *wrong* answer, not a weak one — cloth
> burned on an order that then cannot be finished in that shade, while the next
> order (which that lot could have completed whole) goes without.

"Covers it whole" is checked by simulating the whole order against the lot —
every item, every cut size — using `lotFill` (§6). A lot covers the order only
if **every** demand comes out satisfied.

### 5.1 Running example

Fabric: **Dusty Gold Linen**, fabric width **160 cm**.
Cut size **55 × 90 cm** → `floor(160/55) = 2` pieces per marker row, each row
**0.90 m** of cloth.

Lots on the rack:

| Lot | Ready | Unwashed | At wash house | Notes |
|---|---|---|---|---|
| L1 | 40 m | 0 | 0 | |
| L2 | 12 m | 60 m | 0 | mostly unwashed |
| L3 | 200 m | 0 | 0 | |
| L4 | 0 | 0 | 25 m | all at the wash house |
| L5 | 8 m | 0 | 0 | small |
| L6 | 30 m | 0 | 0 | **blocked** (quarantined) |

---

### 5.2 CASE — no lots at all

`lots[]` is empty (nothing of this fabric anywhere).

**Result:** order skipped. Row shows **"Not booked in"** (`nolots`).
Nothing to allocate; no metres, no lot line.

---

### 5.3 CASE — exactly one lot, and it covers the order

Order needs **30 pieces** (55 × 90). That is `ceil(30/2) = 15` rows = **13.5 m**.

Only L1 exists, with 40 m ready. `lotFill(L1)` covers it (13.5 ≤ 40).

**Result:** order served from **L1**, 13.5 m, today. Row's lot line: `L1 · 13.5 m`.

---

### 5.4 CASE — several lots, ALL cover the order → pick the **smallest**

Order needs **13.5 m**. L1 (40), L3 (200) and L5 (8) exist.
L5's 8 m is not enough → not a candidate. L1 and L3 both cover it.

The allocator picks the **smaller** — **L1 (40 m)**.

> Smallest-that-fits, so big lots stay whole for the big orders that will need
> them. Nibbling the 200 m lot would leave a 186.5 m lot where a 200 m lot
> stood, and the next large order becomes likelier to be short.

**Result:** order served from **L1**.

Second order comes along, needs **50 m**. L1 now has `40 − 13.5 = 26.5 m` left →
not enough. L3 (200) covers it. **Order 2 → L3.**

So on the merged SKU row, this supervisor's two Dusty Gold orders show **two
lot sub-lines**: `L1 · 13.5 m` and `L3 · 50 m`. There is **no attempt** to put
both on one lot.

---

### 5.5 CASE — several lots, NONE covers the order alone → **skip, do not split**

Order needs **60 m**. Ready cloth: L1 40, L2 12, L5 8. Total 60 — *exactly
enough* if you added them up. L3 is out (say it is being used by a
higher-priority supervisor and already spent down to 5 m).

The allocator picks **nothing**. The order is **not** cut 40 m from L1 + 12 m
from L2 + 8 m from L5.

> A garment cut half from L1-shade cloth and half from L2-shade cloth is a
> visible defect. The order stays pending. It is never spread over a second lot
> to make the number look better.

**Result:** order skipped. Row shows the **`nofit`** reason:
**"200 m on L3, smallest job needs 60"** — it names the biggest lot on the rack
and the smallest job that was turned away, so "no single lot holds enough" has
numbers on it. (Here L3 would be named if it had the most ready cloth.)

**What the store person does:** nothing on this screen. Either wait for more of
one lot to arrive, or the end-of-page shortfall summary raises a **purchase**
ticket.

---

### 5.6 CASE — no lot covers it today, but one covers it after its **own** unwashed cloth is washed

Order needs **50 m**. L2 has **12 m ready + 60 m unwashed**. No other lot fits.

`lotFill(L2, ready-only)` → 12 m, does **not** cover.
`lotFill(L2, ready + unwashed)` → 72 m, **covers**.

L2 becomes the chosen lot in the **"after wash"** tier. But:

> The order is **committed** to L2 — nothing else may be promised that cloth —
> and **nothing goes out today**. Issuing the 12 ready metres now would pin the
> order to a lot that cannot yet finish it, which is the one thing the atom rule
> exists to prevent.

**Result:**
- L2's ready 12 m, unwashed 60 m and its offcuts are all **spent** (this order
  claimed them — the card's next order is told L2 is gone).
- **No lot line, no metres issued.**
- Row shows the **`wash`** reason: **"L2 · 38 m to wash"** — and this is the one
  short reason with a **button**: it raises a wash ticket **aimed at L2** (not
  at whichever lot holds the most unwashed cloth — washing a different lot
  produces the wrong shade).

When L2's wash lands, the order is covered and issues normally next window.

---

### 5.7 CASE — the chosen lot's cloth is **at the wash house**

Order needs 20 m. L4 has **0 ready, 0 unwashed, 25 m at the wash house**.
It is committed to L4 (a pinned order, say — see §5.9), and L4 is not finished,
its cloth is just in transit.

**Result:** row shows **`atWash`**: **"cloth at wash — 25 m, wait"**. No wash
ticket (the cloth is already being washed); no purchase ticket (it exists). The
answer is simply *wait for it to come back*.

---

### 5.8 CASE — a lot has cloth but it is **blocked** (quarantined)

L6 has 30 m ready but is `blocked`.

Blocked lots are **never** allocated from — but they are **still shown** on the
row. Dropping them entirely once made the screen say "nothing on the rack" while
the store person stood in front of 30 m of the stuff, which reads as the screen
being broken.

**Result:** if nothing else covers the order, row shows **`blocked`**:
**"30 m on L6 — quarantined"**. He knows the cloth is there and why he cannot
have it.

---

### 5.9 CASE — the order is **pinned**, and the pinned lot can still serve it

Order was pinned to **L1** (some pieces cut earlier). It now owes 8 more pieces
= `ceil(8/2) = 4` rows = 3.6 m. L1 has 26.5 m left.

A pinned order has **no choice** and the smallest-lot rule does not apply — it
goes to L1 whatever L1 holds.

**Result:** 3.6 m off **L1**. Normal issue.

---

### 5.10 CASE — the order is pinned, and the pinned lot can only give **part** of it

Order pinned to **L5**. Owes 20 pieces = 10 rows = 9 m. L5 has only **8 m ready**
(≈ 8 rows = 16 pieces).

> A pinned order takes whatever its lot can give, **however little**.
> All-or-nothing protects the shade *decision*, and that decision is already
> behind it — refusing a top-up would protect nothing and strand the order for
> good.

**Result:** 8 m off L5 goes out (covers 16 of the 20 pieces). The row still owes
4 pieces. The `wash` / `nofit` / purchase machinery then covers the rest **off
L5 only** (its unwashed cloth, or a PO) — never off a second lot.

> **This is the only place an unpinned-style "partial within one order" happens.**
> A first issue on an unpinned order is all-or-nothing; a top-up on a pinned
> order is not.

---

### 5.11 CASE — the order is pinned, but the pinned lot has **run dry** (or is now blocked)

Order pinned to **L7**. L7 is not in `lots[]` any more — the server drops a lot
once its ready, unwashed and at-wash figures are all zero. Or L7 is now blocked.

`lotFill` finds nothing usable on the pin. The allocator does **not** silently
move the order to another lot.

**Result:** row shows **`pinnedDry`** (or `pinnedBlocked`):
**"already cut from L7 — that shade is gone"**. Nothing is allocated. The order
cannot move until a human decides.

**The decision:** on the supervisor's screen, a **deliberate tone override** can
point the order at a different lot. It records **both** the original pin and the
new lot on the handover (`Lot_Override_From` + `Lot_Override_Note`), so the
shade change is evidence a person chose it, not a rule slipping. Until an
override exists, the row stays stuck.

---

### 5.12 CASE — one order, several cut sizes, lot covers size A but not size B

Order needs 10 pieces at 55 × 90 **and** 6 pieces at 140 × 200. A lot has enough
ready cloth for the first cut but not the second.

`lotFill` runs per demand and `covers` requires **every** demand satisfied. Size
B fails → the **whole order** fails to be covered → order **skipped**, even
though size A alone would have fitted.

**Result:** `nofit` (or `wash` if the lot could finish both after a wash). The
atom rule spans all of an order's cut sizes, not just one.

---

## 6. Step 4 — inside the chosen lot (`lotFill`)

Once a lot is chosen for an order, `lotFill` decides **how** to serve it. Two
sources, in this order:

### 6.1 Offcuts first, then fresh cloth

> **WASTE BEFORE FRESH, always.** An offcut is already paid for and one left to
> age becomes scrap; cloth on the roll keeps.

### 6.2 Offcut scoring — least waste area per usable cut

For each demand still owing pieces, and each of **this lot's** offcuts:

- `yield = floor(offcut.width / cutW) × floor(offcut.length / cutL)` — how many
  whole cut pieces this offcut can produce. **Grain is fixed** — an offcut
  narrower than the cut width yields **0**, however long it is.
- `score = (offcut area − used area) / pieces obtained` — the wasted cm² per
  piece.
- The **lowest score** wins each round: a snug offcut is spent before a large
  one, protecting big stock.

**Example:** demand needs 2 pieces of 187 × 137. Two offcuts fit:
- 300 × 400 → yields 2, wastes `(120000 − 51238)/2 = 34381` cm²/piece
- 200 × 300 → yields 2, wastes `(60000 − 51238)/2 = 4381` cm²/piece

→ the **200 × 300** offcut is used.

The loop repeats until no offcut fits any owing demand.

### 6.3 Fresh cloth — a **Roll** lot

Per demand, from the lot's ready metres:

```
rows   = min( ceil(owed_pieces / perRow),           // rows the pieces need
              floor(readyMetres / cutLength) )        // rows the lot can give
metres = rows × cutLength
```

Whole rows only. The part-row at the end of the demand is thrown away — that is
the **cut-piece rounding** that makes "To be issued" and the lot line disagree
by a metre or two on a busy fabric (see §9).

### 6.4 Fresh cloth — a **Pieces** lot (printed cloth held as discrete panels)

A Pieces lot has **no continuous cloth**. Its "metres" figure is only a
maintained sum for valuation and ranking; nothing is planned off it.

Each physical piece is treated as a **mini-roll**:

```
per piece:  rows        = ceil(pieces_wanted_from_it / floor(piece.width / cutW))
            length cut   = rows × cutLength
            remainder    = piece.length − length cut   (goes back on the rack)
```

**Example:** three 3.00 m pieces, 55 cm cut. Each piece yields `floor(300/55) = 5`
rows and strands 25 cm. Three pieces = 15 rows — **not** the 16 that 9.00
continuous metres would give. Dividing the metres would credit a row nobody can
cut, and the item would sit at "Awaiting material" for ever.

The payload carries the exact `pieceId` and cut length for each piece, so
`issueMaterials` decrements the right `Fabric_Piece` records and inserts the
remainder as a new available piece.

---

## 7. Step 5 — spend the rack down (across supervisors)

The allocator walks **supervisor cards in priority order**. Within one card it
keeps a ledger of what each lot and offcut has left, so:

- Two orders of one supervisor cannot both be promised the same 5 m.
- An order that commits a lot's unwashed cloth spends it, so the card's next
  order is not told the same pile can finish it too.

**Across** supervisors, the ledger is **not** carried. Every card is shown the
**true** rack figure — the server does not divide stock between supervisors. So:

- Two cards can legitimately offer the same lot and the same offcut.
- Whoever the store person **issues second** gets what is really left —
  `issueMaterials` re-checks live stock and clamps.
- There is **no on-screen "also wanted by Sup A" warning on fabric rows** (it
  was removed — the store person cannot act on it, and the server settles it).

---

## 8. What the row shows

For each fabric SKU on the card, one row with:

| Column | Content |
|---|---|
| **Material** | SKU name + code. |
| **To be issued** | The metres that actually leave the roll = **Σ of the lot sub-lines** (when the row is fully covered). This is the per-item marker-row total, not the planning estimate. On a row waiting on a wash, it falls back to the planning estimate so the shortfall summary still fires. |
| **Lot** | One sub-line per lot: `L1 · 13.5 m` — the roll and the **recommended** metres for it (fixed; does not move when the store person edits the box). For an offcut: `⚁ 300 × 400 · Lot L2 · Carton C9`. |
| **Total stock** | That lot's **ready** metres on the rack. `—` for an offcut sub-line. |
| **Issue now** | An editable metres box + checkbox **per lot sub-line**, and a pcs box + checkbox per offcut sub-line. |

### 8.1 The short-reason ladder

When a row cannot be fully covered, exactly **one** reason line is shown, chosen
by this priority (hardest stop first):

1. **`nodata`** — no cut size, or a cut wider than the cloth. A data fault;
   every figure below would be invented.
2. **`pinnedDry` / `pinnedBlocked`** — order cut in a shade that has run out /
   been quarantined. He must decide (tone override on the supervisor screen).
3. **`wash`** — committed lot has unwashed cloth that would finish it.
   *Has a button* — raises a wash ticket aimed at that lot.
4. **`atWash`** — committed lot's cloth is at the wash house. Wait.
5. **`noPrinted`** — printed SKU with **no printed stock anywhere**, but plain
   cloth exists to print it from (see §10).
6. **`nofit`** — cloth on the rack, but no single lot holds enough for one job.
   Names the biggest lot and the smallest job.
7. **`blocked`** — the only cloth is quarantined.
8. **`nolots`** — this fabric was never booked in.
9. **`empty`** — lots exist, none can help, none of the named cases fit. The
   rack is simply empty of this shade.

---

## 9. "To be issued" vs "Issue now" — the small gap

They are computed from the **same** piece counts but round at different grains:

- **To be issued** (planning estimate): per cut size, `ceil(Σ pieces / perRow) ×
  cutLength`. Rounds up **once**, as if every item sharing that cut were laid on
  one continuous marker.
- **Issue now** (what leaves the roll): per **item**, `Σ ceil(item pieces /
  perRow) × cutLength`. Rounds up **once per item**, because each item is cut on
  its own lay and cannot share a part-row with another item.

**Example:** 4 items, 7 pieces each, one cut, `perRow = 2`.
- Per item: `ceil(7/2) = 4` rows each → **16 rows**.
- Combined: `ceil(28/2) = 14` rows.
- Gap: **2 rows** = 4 items × one part-row.

This is **not a bug** — the 2 extra rows are real cloth the cutter needs, and
they come back later as declared offcuts. Since the screen change, **"To be
issued" shows the per-item total (16 rows)**, so it always equals the sum of the
"Issue now" boxes and the row reconciles. `Pieces_From_Raw` per item is still
exactly 7 — the cut-piece math is untouched.

---

## 10. Printed (print) fabric

A printed SKU (`Print_Base` set) is a plain fabric with a pattern printed on it.
It has its **own** lots, exactly like a plain fabric, and lot selection (§5) and
`lotFill` (§6) work on it identically — including **Pieces lots**, which printed
cloth often is (a stack of printed panels rather than a roll).

The one extra behaviour is the **`noPrinted`** short reason:

- If the printed SKU has **no stock at all** — nothing washed, nothing unwashed,
  nothing at the wash house, no pieces, on **any** lot (quarantined included) —
- **and** there is plain cloth on the rack that this SKU is printed from
  (`printBaseLots[]`, washed or unwashed, not blocked),
- the row shows **`noPrinted`**: *"no printed stock — plain cloth to print from:
  L2 · 120 m"*, naming the plain lot and how much is on it.

Why it is ranked below `pinned` and `wash`: those are about cloth that already
exists in the right shade and is days away (a wash). A **print run** is not. So
"go and print" is only offered when there is genuinely nothing printed to wait
for.

Why **both halves** are required:
- *Any* printed stock anywhere means one of the ordinary reasons is the honest
  one — `noPrinted` would be misleading.
- *No* plain cloth to print from means "print more" is not an action he can
  take, so the row falls through to `nofit` / `empty`.

The plain lots are sent **biggest first**, so the row names the fullest one.

---

## 11. Offcut (waste piece) selection — full detail

### 11.1 An offcut belongs to exactly one lot's shade

Every reusable offcut carries the `lotId` of the lot it was cut from. In
`lotFill`, a lot's offcut pool is **only** the offcuts whose `lotId` matches
that lot. L2's offcuts are part of L2's capacity and of **no other lot's**.

This is why **choosing the lot and choosing the offcuts is one decision** — you
cannot pick offcuts before you know which lot's shade the order is being cut in.

### 11.2 Yield and grain

`yield = floor(width / cutW) × floor(length / cutL)`. Grain is fixed: the cut
width runs across the offcut's width, the cut length along its length, **never
rotated**. An offcut 40 cm wide can never serve a 55 cm cut, however long it is.

### 11.3 Scoring (see §6.2)

Least wasted area per usable piece. Snug offcuts spent first; big offcuts
protected.

### 11.4 What travels to the payload

Per offcut picked: `wasteId`, pieces taken, the **target item** (`planItemId` —
so the server credits the right requirement row), yield-per-piece, and the
offcut's dimensions and this item's cut size (for the `Waste_Movement` record).
`issueMaterials` then:

- moves the offcut count from `Piece_Count` to `In_Transit_Count`
  (`Status = "Issued"` when emptied),
- writes an `Issued` `Waste_Movement` stamped with the item's cut size,
- adds the yielded pieces to that item's `Pieces_From_Waste`.

### 11.5 Cross-supervisor

Offcuts **are** spent down across cards within one allocation pass (unlike
lots), because the widget **pre-selects** specific physical pieces — two cards
offering the same remnant would both promise it. The first (higher-priority)
supervisor's card sees the real pieces; every later card sees what is left.

### 11.6 Declined offcuts

The store person can untick an offcut sub-line or lower its count. The allocator
then **re-runs**: the fresh-metres figure grows to cover the pieces the offcut
was going to cover. The offcut row stays visible at 0 so he can re-tick it.

---

## 12. Store-person overrides

| Override | Status | Effect |
|---|---|---|
| **Edit the metres per lot** | Built. | Push a typed figure onto that lot's lines. Cut-piece credit re-derived as whole rows per line. Short edit → the uncut rows stay owed (requirement re-opens next window). Over-issue → extra metres charged to the lot, come back as declared offcuts. Other lots untouched. |
| **Untick / lower an offcut** | Built. | Fresh metres grow to cover the shortfall; offcut row kept at 0. |
| **Choose a different lot** | **Not built.** | Would need: disable on pinned rows (tone risk), re-run offcut allocation for the new lot, handle Roll vs Pieces, and — for a pinned row — the red-confirmation + `Lot_Override_Note` path. |

---

## 13. Cases that are NOT handled (gaps)

### 13.1 Offcuts with no lot recorded are stranded

An offcut booked in **before** the `lotId` field existed has no lot. It appears
in the rack figure (`wasteStock[]`) so the totals are honest, but `lotFill` only
ever looks at `lot.waste` — offcuts filtered by lot id — so a no-lot offcut
**can never be allocated** by this screen. There is no honest way to place it: it
has a shade, but nobody recorded which. The store person cannot issue it here at
all. (It can still be declared/consumed by hand in Creator.)

### 13.2 Fabric contention has no on-screen warning

Two supervisors' cards can both show the same lot with enough cloth and both
pre-fill the box. The second one to press **Issue** gets clamped by
`issueMaterials` against live stock — but nothing on the screen warned him first.
Deliberate (he cannot act on it and the server settles it), but it is a rough
edge: he can press Issue expecting X and get X − whatever the other supervisor
just took.

### 13.3 An over-edit on one lot can be silently clamped

The per-lot metres box is capped at the **whole-SKU** ready stock
(`issueCeiling`), not the single lot's ready stock. So the store person can type
more into L1's box than L1 actually holds. `applyFabricOverride` distributes it
and `issueMaterials` clamps `Wash_Quantity` at 0 and reports the clamp in the
result — but the box let him type it. A per-lot `max` would stop it at source.

### 13.4 An order whose items disagree on the pinned lot

The pin is read **per order** from the *first* line that carries an `issuedLot`.
If two items of one order were somehow issued from different lots (should not
happen, but data can be inconsistent), the whole order is treated as pinned to
whichever line was walked first, and the other item's cloth comes off the
"wrong" pinned lot with no flag. There is no per-item pin reconciliation.

### 13.5 Splitting one order across two lots is refused, always

This is **by design**, not an oversight (§5.5), but it is worth stating as a
known limit: if a product's shade variation between lots is genuinely invisible
(some solid darks), the app still will not split an order across lots. Allowing
it would be a policy decision touching the pin, the offcut allocation, and the
receive-side reconciliation — not a small change.

### 13.6 "After a wash" only considers the **chosen lot's own** unwashed cloth

If no lot covers an order today, and no single lot covers it even after washing
its *own* unwashed cloth, the order is skipped — even if washing **two** lots'
unwashed cloth would produce enough of one shade. The allocator never plans a
multi-lot wash for one order, because the result would still be two shades.
(Same root as 13.5.)
