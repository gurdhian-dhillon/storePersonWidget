# Lots — form design and flow

Agreed 2026-08-13. Built in Creator first, against existing data. The Zoho Inventory sync comes
afterwards and is designed for here but not built yet — see `inventory-integration.md`.

## Decisions this is built on

- **A lot is a tone, not a delivery.** Same SKU, same width, same everything recorded — the only
  difference is visible to the eye. When new cloth arrives the store person compares it against
  the lots already on the rack: exact match goes into that lot, anything else becomes a new one.
- **This reverses `waste-master.md`'s opening decision** — *"SKU is unique per distinct material,
  so no dye lot / shade / batch fields."* That held while nothing could tell two deliveries apart.
  It no longer does.
- **Fabric only.** Accessories have no lots. Their `Quantity` is their stock exactly as today, and
  none of the code below runs on them.
- **The store person chooses the lot. The system never chooses for him.** He can see the rack; no
  rule we write knows that lot 3 is nearly finished or that lot 2 is behind a pallet. The screen
  advises and warns, and blocks nothing.
- **Lots are invisible to Zoho Inventory.** Inventory will hold one total per SKU. The split into
  lots is a Creator concept and stays one.

## Scope: what a lot does and does not touch

| Touched | Not touched |
|---|---|
| fabric stock balances | accessories, in any form |
| issue, receipt, dispute, wash | the cutting calculation itself |
| offcut provenance | `Required_Pieces` and the piece budget |
| the new inward screen | plan creation — a plan never names a lot |

**A plan never names a lot.** Plans are made days before anyone walks to the rack, and a lot
chosen at plan time would be stale by the time it mattered — the same reason waste is not
allocated at plan time.

## `Raw_Material_Lot`

One record per lot per material.

| Field link name | Type | Notes |
|---|---|---|
| `Material` | Lookup → Raw_Material | |
| `Lot_Number` | Text | **typed by the store person**, unique within the material |
| `Label` | Text | free text — "slightly darker", "left roll". Optional, for recognition |
| `Unwash_Quantity` | Decimal | greige, on the rack |
| `In_Wash_Qty` | Decimal | greige at the wash house — off the rack, still ours |
| `Wash_Quantity` | Decimal | |
| `In_Transit_Qty` | Decimal | issued, not yet confirmed |
| `Disputed_Qty` | Decimal | |
| `Status` | Dropdown | `Active` / `Blocked` |
| `Remarks` | Multi Line | |

**FIFO comes from `Added_Time`**, Creator's own field — same as `Waste_Master`, and the same
reason: no `Created_On` needed and identical lots stay distinguishable.

**There is no `Exhausted` status.** A lot with all four numbers at zero is exhausted by
definition, and a dispute resolution can put stock back into it — a stored status would go stale
the moment that happened. `Blocked` is different and does need storing: it means *"this cloth is
quarantined, do not offer it"*, and without it the only way to hide a lot is to zero it, which
falsifies stock.

**`Lot_Number` is TYPED, not generated.** It is the store person's own label for a tone he can
see, and it has to match what is written on the roll — no rule we invent would.

**Unique within the material, not globally.** Two different fabrics may both sensibly have a lot
`1`; forbidding that would force him to invent numbers to dodge collisions with cloth he is not
even looking at. Within one material it must be unique, or every later reference is ambiguous —
which lot did that offcut come from.

Compared **upper-cased and trimmed**, so `l1` cannot slip in beside `L1` and read on screen as a
different lot when it is not. A `Blocked` lot still occupies its number: it is real cloth, just
quarantined.

Checked in the widget *and* in `saveStockInward`. The widget check is only so the collision is
reported while he is still looking at the list it clashed with; the server one is the one that
counts, because a Custom API is callable from anywhere. Two store people typing the same number in
the same second would still collide — there is one store person, so that is accepted rather than
solved.

## Changes to existing forms

| Form | Field | Why |
|---|---|---|
| `Raw_Material` | `Unallocated_Qty` | Decimal. **Always 0 today.** The Inventory seam — see below |
| `Raw_Material` | `In_Wash_Qty` | Decimal. The parent mirror of the lot's wash-house counter |
| `Stock_Dispute` | `Lot` | Lookup. Which lot the cloth left on, so a correction returns it there |
| `Waste_Master` | `Lot` | Lookup → Raw_Material_Lot. An offcut belongs to the lot it was cut from |
| `Waste_Master` | `Carton_Number` | Single line. Which box the store put it in, set at receipt |
| `Material_Issue.Issue_Lines` | `Lot` | Lookup. Which lot crossed the counter on this line |
| `Material_Issue.Issue_Lines` | `Settled_Qty` | Decimal. How much of this line the supervisor has confirmed |
| `Material_Issue.Issue_Lines` | `Lot_Override_From` | Lookup. On a tone override, the lot it should have been |
| `Material_Issue.Issue_Lines` | `Lot_Override_Note` | Multi line. Why he accepted the difference |
| `Material_Requirement` | `Issued_Lot` | Lookup. **The pin** — the lot this row was first cut from |
| `Wash_Request` | `Lot` | Lookup. Washing is per lot |

## The parent total stays maintained

`Raw_Material.Wash_Quantity` and friends **do not become derived roll-ups.** They stay real
fields, updated by the same function that updates the lot, in the same pass.

This is not laziness — recomputing a sum per material on every screen load is a query per
material, and that is the road to the statement-execution limit, which is the failure that is
**not catchable** and shows as a bare 500.

The payoff is large. Tracing every read and write of stock in the app:

- **One reader** — [getStoreMaterialRequirements.dg:358-369](../deluge/getStoreMaterialRequirements.dg#L358).
  Every screen's stock figure comes through there, and **it does not change at all.**
- **Four writers** — [issueMaterials.dg:162](../deluge/issueMaterials.dg#L162),
  [receiveMaterials.dg:156](../deluge/receiveMaterials.dg#L156),
  [resolveDispute.dg:573](../deluge/resolveDispute.dg#L573),
  [completeWashRequest.dg:69](../deluge/completeWashRequest.dg#L69). Each gains a lot alongside
  the parent.

> The `Disputed_Qty` reads in `getStoreDisputes`, `getSupervisorDisputes` and
> `getSupervisorMaterials` are **`Stock_Dispute.Disputed_Qty`** — a different field on a different
> form, and none of this touches them. Same name, unrelated meaning; check which form a query is
> against before changing anything there.

### The Inventory seam

| | Who moves the parent total | Who splits it into lots |
|---|---|---|
| **Now** | the inward screen, as a side effect of creating or topping up a lot | store person, directly |
| **After the sync** | the Inventory pull | store person, draining `Unallocated_Qty` |

`Unallocated_Qty` exists from day one holding zero. When Inventory becomes the source of the
total, a purchase receipt raises the total before anyone has been to the rack, and the difference

```
Unallocated_Qty = Inventory total − SUM(lots: Unwash + Wash + In_Transit + Disputed)
```

is not drift — it is a **work queue**: cloth that has arrived and has not been assigned a tone.
It shows on the inward screen and **cannot be issued**, because promising cloth of unknown tone to
an order is the exact mistake lots exist to prevent.

## Inward — creating and topping up

New tab on the store widget. Fabric only.

Pick a material → the existing lots are listed with their balances → either **add to an existing
lot** or **create a new one** (number typed, label optional), then enter the quantity.

**Everything booked in is UNWASHED, and there is no choice about it.** Cloth is bought greige and
washed in-house, so booking it in as washed would claim a step that never happened. The only route
into `Wash_Quantity` is the wash flow.

> Because of that, **washing is the only thing that shifts the tone**, which makes it the moment a
> lot most often has to split — and the reason *move between lots* exists.

Later this same screen grows an "arrived, not yet lotted" banner fed by `Unallocated_Qty`. The
screen is built now; only its feeder changes.

## Moving between lots

One action, two uses: **take N from lot X into a new or existing lot Y.**

- The tone difference that only appears **after washing** — which is when it most often appears.
- Undoing a merge that turned out to be wrong.

**It moves on-hand quantity only** — `Unwash_Quantity` or `Wash_Quantity`. It must never move
`In_Transit_Qty` or `Disputed_Qty`: those belong to a specific handover that has already left the
counter, and re-labelling them would leave the receipt unable to find what it is settling.

## Issue — allocated automatically

> **SUPERSEDED from here to the end of *Receipt*.** See
> [lots-issue-redesign.md](lots-issue-redesign.md), agreed 2026-08-17. The rule changed at the
> root: **the order is the atom** and is served whole off one lot or not served at all, so the
> partial-issue machinery below — the per-lot metres budget, the ranking that counts greige as
> available today, the "drain the largest and close from the smallest" spread — no longer applies.
> What survives unchanged: one lot per order, the pin and how it is read back, offcuts belonging to
> their lot's capacity, the recorded override, and the reason capacity is simulated rather than
> compared in metres. Read the redesign first; the sections below are kept for the arguments they
> record, several of which are still the reason the new rule is shaped as it is.

The store person does not type metres. He presses Issue and the screen has already worked out
which lot the cloth comes off, because every figure it produces is a whole number of marker rows
and a hand-typed one is not: 5.00 m against a 55 cm cut is 9 rows and a 5 cm full-width strip that
walks out with the supervisor and is binned.

### The boundary is the ORDER

**One order, one lot.** That is the guarantee, and it is conditional on one thing only: it holds
whenever *some* lot can cover that order. If a single order needs more than any lot holds, it
straddles — physics, not design — and the screen says so before anything is cut.

Supervisor-level was the earlier answer and it was **wrong**. It is not a looser version of
order-level; it is a different guarantee that does not contain the one you need. Two lots of 30 m,
one supervisor, two orders of 25: allocating at supervisor level drains the first lot and the
second order takes 5 from one lot and 20 from the other. Order-level gives each its own. Same
stock, same demand, one works.

The tiers, hardest first:

| unit | strength | why |
|---|---|---|
| **Order** | **the guarantee** | a hundred covers in two shades is a defect the customer sees |
| Supervisor | convenience | nobody outside the building sees it |

### Waste is part of the lot, not a separate pool

**A remnant carries the tone of the lot it was cut from.** So offcuts are not a fungible pool that
offsets the requirement before a lot is chosen — they are part of what each lot can offer, and
choosing the lot and choosing the remnants is **one decision**.

That is why the allocation moved out of `getStoreMaterialRequirements` and into the widget. The
server picked remnants *before* any lot existed, so it could not have matched them; ordering cannot
fix it, because the two decisions became one. The server now sends candidates raw in `wasteStock`
with their lot and carton, and the widget allocates.

> **This corrected an earlier claim in this document.** It said lot-scoping waste "would visibly
> destroy reuse." The opposite is true, and it is now proven in tests: because a lot's capacity is
> *its own waste + its own cloth*, a lot carrying usable remnants and little cloth **is** the
> smallest lot that finishes the order, and beats a big fresh one. Lot-scoping **prefers** reuse.

Within a lot: **waste before fresh**. A remnant is already paid for and one left to age becomes
scrap; cloth on the roll keeps.

Remnants with **no lot recorded** belong to no lot's capacity. They predate the field and there is
no honest way to place them, so they are left alone rather than guessed at.

### The pin — an order returns to the lot it started on

`Material_Requirement.Issued_Lot`, a lookup stamped by `issueMaterials` on the **first** issue and
**never overwritten**. Read back per **order**, from *any* line including settled ones.

That last point is load-bearing and was a real bug. The ordinary remake is: the original hundred
are finished and settled, three are ruined, a replacement batch arrives owing four. Reading the pin
only from lines that still owe something skipped the settled original, left the order unpinned, and
sent the replacement to whichever lot was smallest — four pieces in a different shade to the
ninety-six they sit beside.

The pin covers three cases with one rule:

- **partial issue** — issue some today, the rest next week, same lot
- **remake / reissue** — replacements match what they replace
- **a growing order** — a second issue returns to the same tone

> **Partial issue does not break the tone.** It only breaks if the pinned lot runs dry before the
> order is finished, which is now a visible, nameable event rather than an accident of allocation.

### When the pinned lot runs out

An emptied lot is **dropped from the server's list entirely** — `getStoreMaterialRequirements`
omits any lot whose washed, unwashed and at-the-wash figures are all zero. So the ordinary shape of
"the pin is unusable" is *the lot is absent*, not *the lot is present with zeroes*.

That distinction caused the most dangerous bug in this work: the allocator found no match for the
pin, fell through to choosing freely, and **moved the order onto another tone with nothing on
screen saying so**. A blocked lot is dropped the same way and behaves the same, correctly —
quarantined cloth is not something to finish an order with.

Now the row allocates **nothing** and says why:

> ⚠ Already cut from **L2**, which is now empty. This order cannot be finished in that tone — it
> needs more of that shade, or it goes out in two.

The line carries `issuedLotNo` alongside `issuedLot` for exactly this: the lot is gone from the
list, so the widget has an id it cannot name, and *"already cut from 3819000000141003"* is not
something to put on a screen.

### The override — his call, recorded

Offered **only** when the pinned lot is unusable. On any pinned row it would erode the guarantee by
being easier than asking why.

He picks a replacement lot and **must** give a reason. An override with no reason is
indistinguishable from a mistake once everyone has forgotten the week it happened.

| field | holds |
|---|---|
| `Material_Requirement.Issued_Lot` | the **original** lot — never overwritten |
| `Material_Issue.Issue_Lines.Lot` | the lot that actually left the shelf |
| `Material_Issue.Issue_Lines.Lot_Override_From` | the lot it was supposed to be |
| `Material_Issue.Issue_Lines.Lot_Override_Note` | why he accepted the difference |

**The disagreement between the first two is the evidence a person chose this.** That is what makes
the override different from the two things he would otherwise do: editing `Issued_Lot` directly
erases the original, and booking new cloth into the old lot at Stock In corrupts that lot's meaning
for every future order.

**The override lapses if the original lot is restocked.** It is re-checked against the live rack on
every render rather than remembered as a decision — a remembered one would keep the order on the
substitute for ever.

### Still true, and unchanged

**Plan demand and Reissue demand are allocated together**, even though they render as separate
sections. They are separate requirements deliberately — a remake has to stay visible as a remake —
but they are the same cloth off the same rack, and allocating them apart lets both sections pick
the same lot and promise the same metres twice.

**One lot for the whole supervisor is still preferred where it fits**, as a bonus rather than the
rule: it costs nothing and means even unrelated orders match. It is the order guarantee that is
enforced.

> **Superseded:** an earlier draft made the supervisor the boundary. See *The boundary is the
> ORDER* above for why that is not a weaker version of the same thing.

### Priority is the order to SERVE people in, never permission to be served

**No supervisor's card holds stock back from another.** Every card is worked out against the
whole rack, as if the store person were serving that man first — because he may, and the screen
must not refuse a handover he wants to make. He can see the rack; the allocator cannot.

The consequence is deliberate and has to be understood before anyone "fixes" it: **the cards
add up to more than the rack holds.** Four supervisors wanting one material are each advised
what that material could give them, and the totals overlap. That is what advisory means. Two
things keep it honest:

- **The row says so** — *"⚠ Also needed by Suraj, Vivek, Aniket"*, on the row itself, where he
  can act on it.
- **`issueMaterials` re-checks every lot server-side.** Whoever is issued second gets what is
  really left, and finds out at the moment of issue. The screen never pre-empties anybody.

**Within one card the ledger still applies, and there it is not optional.** One Issue press
serves the whole card, so two orders — or two cut sizes, or a Plan row and a Reissue row — of
the same supervisor must not be promised the same metres, the same greige or the same offcut.
`applyLotAllocation` therefore builds `wasteLeft` / `lotLeft` / `greigeLeft` **per supervisor**,
seeded from the rack figure the server sends to every card.

> **This was live for a while and it was bad.** The three ledgers were built once and spent as
> the cards were walked in priority order, which turned them into the hard reservation this app
> had already considered and rejected. On a material with 20.55 Mtr washed, the first supervisor
> was advised 19.18 of it and the fourth was measured against the 1.37 left over: his rows read
> *"no lot holds enough for a single full row"*, his metres box sat at 0, and **the store person
> could not issue to him at all** — under a card header still reading *All in stock*, because
> that pill was judged on the shelf total while the row was judged on the residue.
>
> Two rules fell out of it, and both are load-bearing:
> **stock is never divided between cards**, and **a pill and the row beneath it are never
> decided on different figures** (see `issuableTotal`, which is what both now read).

### ONE LOT PER ORDER, ALWAYS — short beats mixed

An order takes cloth from **one lot and only one**, and there is no case that overrides this
except the recorded override below. Waste and fresh come off that same lot; a partial issue comes
off that same lot; the wash that finishes it is that same lot's greige.

**When no lot can finish the order, it still takes one.** The chosen lot is the one that covers
most; the order takes what that lot gives and stays short. It is never topped up from a second
lot to get the pieces out today.

> This replaced a spread: when nothing could finish an order, the allocator used to take the
> fewest lots it could and flag the row multi-tone. It bought nothing. The order went out in two
> tones **that day**, which is the exact defect lots exist to prevent and cannot be undone,
> whereas short is recoverable — wash that lot's greige, or buy more of it. **Short is a delay;
> mixed tone is a defect.** `multiTone` is gone, and with it the warning that went with it.

So `chooseLotForOrder` is now a single ranking rather than a filter plus a fallback:

1. **The pin wins outright** if the order has one.
2. Otherwise **fewest pieces left owing**, greige counted — "can finish it" is just the top of
   this ranking, not a separate case.
3. Ties go to the **smaller** lot. Nibbling the biggest leaves a medium lot where a large one
   stood, and makes the next order likelier to be short too.

It returns null only when the material has no lots at all.

**Several lots on one row therefore means several ORDERS**, never a split order — the row says
*"More than one order on this row"*, which is the allocator working, not a warning.

### Switching lot: only when the lot is FINISHED

The override is offered on exactly one condition — the pinned lot has **nothing left at all**:
no washed cloth, no greige, no offcut, and nothing away at the wash house. A lot dropped by the
server counts, since `getStoreMaterialRequirements` stops sending a lot once every figure is zero.

Anything less and the lot can still serve the order, so the tone must not be switched:

| The lot still has | Then |
|---|---|
| washed cloth | issue it |
| greige | wash it — the wash line says how much |
| cloth **at the wash house** | wait; it comes back **in this tone** |
| an offcut | issue it |

> **In-wash was the one that was wrong.** A lot holding nothing but cloth at the wash house read
> as finished, so the screen offered a tone switch over stock that was on its way back. He would
> have mixed tones where waiting a day would have done. The lot list carries `inWash` for this
> reason alone — it is never allocatable, only proof that the lot is not finished.

### The rule

1. Add up everything still owed, **across every cut size**, in whole marker rows —
   `ceil(freshPieces / floor(width / cutWidth)) × cutLength` per row on screen.
2. If any single lot holds that much, use the **smallest** one that does.
3. Otherwise drain the **largest** and go round again, closing the remainder from the **smallest**
   lot that can finish it.

Draining the largest for the bulk is the fewest lots: if the *k* largest are the fewest that reach
the target, nothing reaches it in fewer. Fewest lots is what matters once a split is forced,
because each extra lot is another tone.

Finishing from the smallest that fits is the part that is not plain greedy, and it is what stops
the rack fragmenting. Nibbling the second-biggest leaves a medium lot where a large one stood, so
the *next* order is likelier to need a split too.

**`freshPieces` sizes it, never `Required_Qty`** — the waste-adjusted count of pieces the store
actually has to cut. Sizing from the plan estimate would ask for cloth that offcuts already cover.

### Row damage — why capacity is never checked in metres

A lot's tail that is shorter than the cut length yields nothing, so 5.00 m against a 55 cm cut is
**4.95 m of usable rows**. Two lots of 5.30 m hold 10.60 m between them and still cannot cover
10.45 m of demand: each yields 9 rows, 18 against the 19 needed. Every feasibility test therefore
**simulates the cutting** rather than comparing totals.

Within one lot the cuts are packed **longest first**, because the tail is what is lost. 5.00 m
owing 2.70 m of 90 cm rows and 3.85 m of 55 cm rows gives 2.70 + 2.20 with 0.10 left over;
shortest-first takes 9 × 55 cm and then has no room for a 90 cm row at all.

The tail is **not lost**. It stays on the roll in the store, where a shorter cut can still use it —
it simply cannot serve this issue. This is a capacity question, not cloth walking out of the door.

### Worked

150 cm cloth. Front 55 × 55, 14 pieces owed → 2 per row → 7 rows → 3.85 m.
Sleeve 40 × 90, 9 pieces owed → 3 per row → 3 rows → 2.70 m. **Continuous length 6.55 m.**

| on the rack | outcome |
|---|---|
| L1 7.00, L2 4.00, L3 3.00 | all 6.55 off **L1** — the smallest that covers it. Nothing split |
| L1 30.00, L2 6.60, L3 3.00 | all 6.55 off **L2**. L1 would have been squandered on it |
| L1 5.00, L2 4.00, L3 3.00 | nothing covers it. Drain **L1**: sleeves first (2.70), then 4 front rows (2.20) — 4.90 of its 5.00, and 0.10 stays on the roll. 3 front rows still owed → **L3**, the smallest that can close them. **L2 is left whole** |

### On screen: one line, not a table

Because the allocation is computed, there is nothing to pick, and almost always **one lot** covers
the row. So the row says so in one line under its metres box:

```
Linen Fabric / Block Print / Wiltshire Green     5.5 Mtr    [x] [ 5.5 ] Mtr
RM-00005                                                        from L3
```

When a split is forced it becomes one line per lot, in the same shape the waste picks already use
on these rows:

```
                                                            No single lot could cover this
                                                            L1 · 2.2 Mtr
                                                            L3 · 1.65 Mtr
```

**No row counts.** Marker rows are how the allocation is worked out, not something the store
person deals in — he measures and cuts metres, and "4 rows" is a unit he has to translate before
it means anything.

When **nothing** can be allocated the column must say why, and it must **say the number**:

```
                                                            ⚠ Only 1.37 Mtr washed, across 2
                                                            lots — no single lot has enough to
                                                            cut a piece this size.
```

*"No lot holds enough for a single full row of this cut"* was the earlier wording. It is true and
unusable: he is looking at a rack with cloth on it, a row asking for 20 metres, and nothing on the
screen telling him how little is really there. **1.37** ends the argument in one glance, and it
does not make him think in rows. The same applies to a row pinned to an emptied lot, which names
the lot, and to a material with no cut size on record, which says to fix the material.

An empty Lot column on a row that is asking for metres is never acceptable — it reads as a
rendering fault, and he presses Issue and gets nothing.

**What was removed, and why.** This was a four-column table (Lot / Washed / Unwashed / Issue)
under every fabric row. It carried a single row of data in the usual case, and its washed and
unwashed columns answered a question the store person had not asked — he is not choosing, so the
rack totals are not his decision to make. The unwashed line beneath it (*"700 Mtr unwashed in L1 —
not issuable yet"*) printed unconditionally, including on rows with hundreds of metres of washed
stock available, where it is pure noise.

That line now appears **only when the row is actually short**, which is the one moment it answers
something: *there is cloth on the rack, why am I being given less than the row asks for.*

**One line per committed lot, naming the lot and quoting WHAT THIS ROW NEEDS OFF IT.**

```
                                                            L2 · 8.22 Mtr
                                                            L3 · 10.96 Mtr
                                                            L2 · 13.2 Mtr to wash
                                                            L3 · 23.29 Mtr to wash
```

Three figures were tried here and only the third is any use. Each of the first two was rejected
for a reason worth keeping:

- **The material's total greige.** *"706.09 Mtr unwashed"* on a row committed to L2 when L2 held
  fifty of it. It decides nothing — the wash targets the committed lot and the ticket is capped at
  what **that** lot holds — and nothing on screen answered *"706 of which lot?"*
- **The committed lot's own pile.** *"L2 has 15.69 Mtr unwashed"* on a row 35.62 short. Closer,
  but still not his: most of that pile is spoken for by **another supervisor's** order, so it
  reads as an offer that neither belongs to him nor adds up.
- **This row's share of that lot** — 13.2. What he is actually waiting on, and it reconciles with
  the wash ticket.

The lot's own holding is worth saying in exactly one case: when it cannot cover even this row, and
then the line ends *"— only 4 Mtr there"*.

A per-lot list of **every** lot is the opposite mistake, and it is why the breakdown was dropped in
the first place: *"L1, L2, L3 — not issuable yet"* told him L2 and L3 were unusable on the very row
that was issuing 8.22 and 10.96 metres off them. Only lots this row is **committed to** appear.

When **no** lot could finish the order there is nothing to name, so the material total is right —
and it is then labelled *"across all lots"*, because unlabelled it reads as one lot's holding.

> **The row and the wash ticket are allowed to differ, and both are right.** The row is one
> supervisor's share; the ticket totals every supervisor committed to that lot and is then capped
> at the lot. The summary says which it is — *"Totalled across every supervisor"* — and that note
> is load-bearing, not decoration.

### The wash summary is ONE TICKET PER LOT, not per material

A tone commitment is per lot, so a single material can be waiting on **two lots at once** — one
supervisor's order committed to L2 and another's to L3. Each needs its own ticket, because
washing L3 produces cloth the L2 order cannot use without breaking the tone it is pinned to.

For a while this raised one ticket per material and aimed it at `washLotId`, which the summary
took from **the first supervisor's row it happened to read**. On screen the store person saw
Sanket's row saying *"L2 has 15.69 Mtr unwashed"* and a shortfall list offering to wash **L3** —
and the L2 order was never queued at all, with nothing anywhere to say why.

The aggregation has one trap in it, and it runs in both directions:

- **Within one card, take the figure ONCE.** `washLots[].qty` is already the card's total for
  that lot across every row of the material, so adding a Plan row and its Reissue row doubles it.
- **Across cards, SUM.** Two supervisors committed to the same lot are two real requirements, not
  one seen twice. (Contrast the *stock* figures, which are one live number taken from the first
  row that mentions the material — summing those would invent cloth.)

Then cap each ticket at what that lot actually holds, because the wash converts one lot's greige
and `raiseMaterialException` trims a larger ask silently — which leaves the store waiting on
metres that were never coming.

**`Washed` and `Unwashed` on a wash row are the LOT's, not the SKU's.** A ticket capped at what L2
holds, printed beside a greige figure totalling every lot of the SKU, is the same two-figures-on-
one-row fault as above: *706.09 unwashed* next to *wash 50, all it has* reads as an arithmetic
error. *"All it has"* now means exactly one thing — the ticket took that lot's whole pile.

Note the split between calculation and display. The allocation is still computed across the
**whole material** — every cut size and both Plan and Reissue together — because that is the only
way two rows cannot claim the same lot. Each row then renders **its own share** of that result. One
shared table was an earlier attempt at the same guarantee and was the wrong half of the problem to
solve in markup.

### The payload

```
{ "materialId":"123", "cutWidth":55, "cutLength":55,
  "lots":[ {"lotId":"901","qty":300}, {"lotId":"902","qty":200} ],
  "wastePicks":[ {"wasteId":"456","pieces":3} ] }
```

Non-fabric lines send `qty` and no `lots`, exactly as today, and behave exactly as today.

### One lot = one pass

`issueMaterials` runs its existing logic **once per lot allocation**, not once per material line.
The fan across requirement rows already reads `Issued_Qty` live and updates it, so running it with
300 and then 200 lands in the same place as running it once with 500 — and every issue line comes
out naturally carrying exactly one lot.

Waste picks are applied **once, before the lot passes**, not repeated per pass.

### The trap this closes

`issueMaterials` currently derives pieces from the **total** metres issued:

```
rowsIssued = floor(issueQty * 100 / cutL)        // issueMaterials.dg:492
```

Split across lots that overstates the yield, because each lot's cloth rounds down to whole marker
rows **separately**. 500 m at a 55 cm cut is 909 rows in one piece, but 300 + 200 is 545 + 363 =
**908**. One row vanishes and `Pieces_From_Raw` is credited for a piece nobody cut.

Running one pass per lot fixes this by construction — the arithmetic is per lot because the pass
is per lot. This is the same shape as the four silent-loss bugs already recorded in CLAUDE.md, and
it is the reason the per-pass design was chosen over summing at the end.

### And the trap that closing it opens

**Each lot's share must be budgeted from the pieces still owed at that moment — not carved out of
a budget computed once for the whole issue.** Getting this wrong re-introduces the stranded-piece
failure one level down, and it is not obvious from reading the code.

100 pieces at 2 per row is 50 rows = **27.50 m as one continuous piece**. Split 20 + 7.50 it
yields 36 + 13 = 49 rows — **98 pieces**, because each lot loses its part-row. A budget worked out
once caps the second pass at 7.50 m, so the last two pieces can never be issued: the item stays at
`Awaiting_Material`, the plan never reaches `Material Ready`, and pressing Issue again does
nothing, because the "nothing outstanding" test needs *both* metres and pieces to be spent. The
cloth was sitting on the shelf the whole time.

Budgeting the second pass from the **28 pieces still owed** asks for 7.70 m instead, gets 14 rows,
and closes the requirement.

> **Corrected.** This section used to claim a split spends *more* metres than the plan estimated —
> 27.70 against 27.50. That was true of the 20 + 7.50 payload it assumed, and whole-row snapping
> has since made that payload impossible. 20 m snaps to 36 rows (19.80 m), the second pass budgets
> the 28 pieces still owed at 7.70 m, and the total is **27.50 m — exactly the plan estimate.**
>
> A split costs no extra cloth. What it costs is **rack capacity**: the 0.20 m left on the first
> lot is still in the store and still usable, but it could not serve this issue. Keep the two
> apart — metres consumed and capacity required are different questions, and conflating them is
> what made this paragraph wrong.
>
> `Issued_Qty` may still exceed `Required_Qty` on a fabric row for the reason CLAUDE.md gives —
> offcuts covering pieces the metres estimate assumed would come off fresh cloth — but a split
> across lots is no longer one of the ways it happens.

## Receipt — settling in-transit per lot

This is the one place the existing design genuinely cannot be reused as-is.

[receiveMaterials.dg](../deluge/receiveMaterials.dg) reconstructs what is pending from
`Material_Requirement.Issued_Qty − Received_Qty`, fanned oldest-plan-first, and deliberately
stores **no mapping of issue to plan** — the comment at line 13 says so, and the argument is that
the same rule in the same order gives the same answer.

That argument still holds for `Received_Qty`. It does **not** hold for the lot, because a
requirement row records metres and has never recorded which cloth they were. So:

- **The requirement fan is unchanged.** `Received_Qty` keeps working exactly as it does today.
- **A second pass settles the lot.** Walk the supervisor's `Material_Issue.Issue_Lines` for that
  material where `Qty > Settled_Qty`, oldest first, and take the confirmed quantity off each
  line's lot — decrementing that lot's `In_Transit_Qty` and raising `Settled_Qty` on the line.

Two independent fans over the same quantity, both consuming oldest-first, so they agree by
construction — the same reasoning the file already relies on. The issue line is the only record of
which lot left the counter, which is why it has to be the one that answers.

A short receipt puts the gap in that lot's `Disputed_Qty`, and the `Stock_Dispute` records the lot
so the resolution knows where to put it back.

## Disputes

`Stock_Dispute` gains a `Lot` lookup, written when the dispute is raised.

`resolveDispute`'s `Store_Correction` — the one outbound outcome that puts stock back
([resolveDispute.dg:377](../deluge/resolveDispute.dg#L377)) — restores to **that lot**, not to the
material. A lot that had reached zero can come back to life; that is correct, the cloth was
always that tone.

`Found` and `Lost` drop `Disputed_Qty` on the lot without restoring, as they do today on the
material.

## Waste

An offcut is cut from a specific lot, so `Waste_Master.Lot` is written when it is declared.

**Where the lot comes from:** `Material_Issue.Issue_Lines` carries both `Plan_Item` and `Lot`, so
the lot for a given item's offcuts is derivable. If exactly one lot was issued for that item it is
filled in automatically.

**If two were, nothing is written.** Stamping the larger share — the rule the dispute record uses
— would be wrong here: a dispute's lot only decides where stock returns, and the lots themselves
still carry their own shares, so the guess is recoverable. A lot on an offcut is a claim about
what shade the cloth *is*, and a remnant later offered as the wrong shade is the exact thing lots
exist to prevent. So it is left empty and counted back as `unlotted`, and the payload may carry an
explicit `lotId` for the one person who can actually know.

> The lines are read via the **supervisor**, not the plan. `Material_Issue.Plan` holds the first
> plan a handover touched, so an issue spanning two plans is stamped with one of them and
> filtering on it would miss the other's lines entirely. The line's own `Plan_Item` is exact.

A re-sent piece created by `resolveDispute` (`Supervisor_Resending`) copies the original's lot. It
is the same cloth; a new row that lost its lot would be indistinguishable from an offcut nobody
can place.

**The allocator does not filter by lot.** Every available remnant of the SKU is offered as it is
today, with **its lot shown on each suggested piece**, and the store person deselects what he does
not want. Filtering strictly to the chosen lot would be consistent with the tone rule but would
visibly destroy reuse, and the store person is better placed to judge whether a remnant matches
than a rule is.

`Waste_Movement` needs no lot field — it points at the piece, and the piece knows its lot.

### The cutting dialog shows one row per physical piece

`getExpectedWaste` emits a row **per origin** — the side strip off this lot, the part-filled row off
that one, the tail — and several of those are routinely the *same offcut described twice*. The
supervisor's dialog was showing six identical lines each reading `1` where the rack will hold six
identical pieces, and he had to check every one before saving.

The dialog now merges them on **fabric + lot + length + width** and sums the count. The lot is in
that key deliberately: same size, different tone is not the same piece, and merging those would send
an offcut back to the wrong lot.

Merged in the **widget**, not in `getExpectedWaste`. The prediction's per-origin breakdown is what
the admin audit screen shows as its working, so collapsing it at source would destroy the answer to
*why* that waste was predicted. The dialog is an editor of physical things; the prediction is an
explanation. They want different shapes.

> One exception: a piece the prediction **could not place**, on a material with more than one lot,
> stays its own row. He may know which lot it came off even though the prediction could not, and
> merging would take that choice away — he could only get it back by splitting the row again by hand.
> With a single lot there is nothing to choose, so it merges and takes that lot.

The count column is headed **"How many"**, not *Pieces to cut*. That phrase is the materials table's
heading two clicks away, where it means garment pieces still to be cut; here the row already **is**
one offcut of a given size, so the number is simply how many of them there are.

### Carton — where the offcut physically is

`Waste_Master.Carton_Number`, single line text. The lot says what shade a remnant is; the carton
says **which box to walk to**. Naming a remnant without saying where it is leaves the store person
searching a rack.

**Captured at receipt, and only there.** `receiveWastePieces` is the one moment anyone physically
handles the pieces, so it is the one moment the answer is known. The waste-receipt table carries a
Carton column in **both** modes — the usual path is *All received as declared*, and putting the
field behind the "something's missing" toggle would mean the carton was only ever recorded on the
rows that went wrong.

- **Required** when a row actually takes pieces in. A remnant nobody can find is worth the same as
  one that never came back, so this is a block rather than a nudge.
- **Not required** when nothing turned up. That row ends at `Disputed`, sits on no shelf, and
  stamping it with a carton would send the next person to an empty box. If those pieces are later
  re-sent they arrive as their own row and are checked in on their own.
- Typing a carton **fills the empty rows below it**. A rack of returns usually goes into one or two
  boxes. It only ever touches blanks, so nothing already written is overwritten.
- Written only when given, so an older widget re-running a receipt cannot blank a recorded carton.

**Quoted back at issue.** Each suggested remnant on the store's issue screen carries a line reading
`carton C-12 · lot L3`. Carton first: it is the actionable half. The lot is what tells two
identically-sized remnants of different tones apart.

`getStoreMaterialRequirements` resolves both **at JSON emit time**, from two maps keyed by waste id,
rather than carrying them through the scoring loop — that loop runs once per candidate per pass and
is the hottest thing in the function, while the answer is the same however many times a piece is
scored. Lot is a lookup holding a record id, so the readable number comes from `lotNameById`, filled
in the lot pass **before** its Blocked and empty-lot filters: an offcut cut from a lot that has since
been blocked or run dry must still be able to say which lot it came from.

A piece booked in before this field existed has no carton and says **"carton not recorded"** rather
than showing a blank — a gap that reads as a rendering fault gets ignored, one that states itself
gets fixed.

## Wash

`Wash_Request.Lot` names the lot, and the cloth moves in two steps rather than one:

```
send      Unwash_Quantity −N,  In_Wash_Qty +N
complete  In_Wash_Qty −N,      Wash_Quantity +N
```

**Cloth at the wash house is not cloth on the rack.** Without `In_Wash_Qty` the metres stayed
counted as greige until the wash came back, so the store screen offered cloth that was not in the
building and the "to wash" figure was computed against it.

It also removes a worse failure. The guard used to be *one open job per material and lot*, and on
a second request it **replaced** the open ticket's quantity — 300 m already at the washer silently
became 200 m, and the record of what was actually sent was gone. With the cloth moved off the
rack, a second request is legitimately different cloth, so there is no dedup at all now: the cap
is `Unwash_Quantity`, and every send lowers the greige the next shortfall is measured against.

**Completion takes from `In_Wash_Qty` first and falls back to `Unwash_Quantity`.** That is not
belt-and-braces — a ticket raised before this field existed never moved anything, so its cloth is
still sitting in greige, and the fallback settles both kinds without having to know which it is.

Total holdings for a lot are now `Unwash + In_Wash + Wash + In_Transit + Disputed`, which is also
the figure the Inventory reconciliation needs.

**One existing guard has to change.** [raiseMaterialException.dg:280](../deluge/raiseMaterialException.dg#L280)
refuses to queue a second wash request while one is open **for that material**. With lots that is
wrong — a wash running on lot 2 would block a wash on lot 3. The guard becomes per material **and
lot**.

**There are THREE exits from `In_Wash_Qty`, and for a long time there was one.**
`raiseMaterialException` is the only thing that raises it, and `completeWashRequest` was the only
thing that lowered it — so the sole way out of the wash house was *"it came back washed"*. Set a
request to `Cancelled` by hand and the metres sat there for ever: the SKU total stayed right, the
reconciler balanced, and nothing could be issued off them. **No report shows that**, because every
column still adds up. `cancelWashRequest` is the missing exit and returns the metres to
`Unwash_Quantity` — greige is the only counter they can go back to, because it is washing that
converts greige into washed cloth, and putting them into `Wash_Quantity` would claim a step that
never happened. Printing already had this in `cancelPrintJob`; the two are deliberately the same
shape.

> Shrinkage leaves a residue in `In_Wash_Qty` by design — send 40, get 38 back, and 2 stay there.
> `Cancel wash` is also how that is cleared.

**A `Pieces` lot cannot be washed, and it is REFUSED rather than capped.** On a printed lot the
metres are the maintained sum of its `Fabric_Piece` rows, and this flow moves a metres figure
between two columns on the header without touching a single piece. Wash one and the header claims
washed metres while every piece behind it still says `Unwash` — after which the allocator finds
nothing (`lotPieces` takes only `State == "Wash"`) and the header's metres are unspendable
(`lotFill` zeroes a Pieces lot's budget). The cloth ends up real, on the rack, and permanently
unissuable while every total says it is there.

> Guarded in **three** places, and all three are needed. `raiseMaterialException` refuses to queue
> the ticket; `completeWashRequest` refuses to move the metres, because it is a report action on a
> form anyone can add a row to and a pre-guard ticket may already be sitting in the queue; and the
> store widget's `washableLots` never offers a `Pieces` lot, so he is not shown a choice that would
> be refused. The allocator already excluded greige pieces from the after-washing simulation for
> exactly this reason — the wash **picker** read `e.lots` directly and never got the same rule.
>
> The refusal leaves the request **Open**, not Cancelled. Cancelling it there would be a second
> write on a path that is already refusing to write.
>
> Washing pieces is designed, not forgotten — see [printing.md](printing.md#washing-pieces). It
> names which pieces, flips `Fabric_Piece.State`, and must let him correct the length because
> washing shrinks cloth and the piece list is what the cutting is simulated against.

Washing being where tone most often diverges is exactly why *move between lots* exists.

## Migration

**One opening lot per fabric SKU**, carrying today's four balances off `Raw_Material`, labelled
so it is recognisable as pre-lot stock. Every existing `Waste_Master` row for that SKU points at
it.

`Raw_Material`'s own fields are left exactly as they are — they are already the correct total, and
after migration they equal the sum of the one lot underneath.

Accessories get no lot at all.

## Deliberately not done

- **Lots are not offered per plan item.** When a split is unavoidable the store person types
  metres per lot, which means two garments on one order *can* end up in different tones. Assigning
  a whole lot per item would prevent that, and was rejected as more machinery than the problem
  warrants today. Revisit if it actually happens.
- **No lot on accessories.** Thread shade varies too; when it matters, the same design applies
  with `Is_Fabric` no longer gating it.
- **No cost per lot.** Costing lives in Inventory, which does not know lots exist. If per-lot cost
  is ever wanted, that is the argument for Inventory batch tracking, not for a field here.
- **`Blocked` has no workflow.** It hides a lot from issue and nothing else — no approval, no
  reason codes.

## What has not been verified

Nothing here has been run. The forms do not exist in Creator yet, so no Deluge has been written
against them. The read/write survey above was taken from the current source and is accurate as of
this commit; every conclusion drawn from it still needs a Creator **Execute** to confirm.
